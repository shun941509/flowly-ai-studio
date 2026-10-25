"""Bounded, pure JSON contracts for authored research workflows. No I/O or eval."""
import copy
import csv
import hashlib
import io
import json
import math
from datetime import datetime


def obj(v):
    if not isinstance(v, dict):
        raise ValueError("객체 입력이 필요합니다.")
    return v


def seq(v, maximum=400):
    if not isinstance(v, list) or len(v) > maximum:
        raise ValueError("목록 형식 또는 처리 한도를 확인하세요.")
    return v


def txt(v, maximum=40000):
    if not isinstance(v, str) or not v.strip() or len(v) > maximum:
        raise ValueError("비어 있지 않은 제한 길이 문자열이 필요합니다.")
    return v


def number(v):
    if isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v):
        raise ValueError("유한한 숫자가 필요합니다.")
    return v


def integer(v, low=0, high=400):
    number(v)
    if int(v) != v or not low <= v <= high:
        raise ValueError("정수 범위가 올바르지 않습니다.")
    return int(v)


def stamp(v):
    parsed = datetime.fromisoformat(txt(v, 80).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("시점은 시간대가 있는 ISO 날짜여야 합니다.")
    return parsed.timestamp()


def digest(v):
    return hashlib.sha256(json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def frontier(a):
    records = seq(a["records"], 20)
    visited = list(dict.fromkeys(seq(a.get("visited", []), 20)))
    lineage = list(seq(a.get("lineage", []), 20))
    by_id = {}
    for raw in records:
        r = obj(raw)
        rid = txt(r["id"], 100)
        txt(r["text"])
        if rid in by_id and by_id[rid] != r:
            raise ValueError("같은 근거 ID의 내용이 달라졌습니다.")
        by_id[rid] = r
    for rid in by_id:
        if rid not in visited:
            visited.append(rid)
    proposal = a.get("proposal")
    next_query = ""
    if proposal is not None:
        p = obj(proposal)
        source = by_id.get(txt(p["sourceId"], 100))
        target = txt(p["targetId"], 100)
        if not source or target in visited:
            raise ValueError("없는 근거 또는 이미 방문한 근거를 재조사할 수 없습니다.")
        relation = next((r for r in seq(source.get("relations", []), 20) if r.get("targetId") == target), None)
        if not relation or p.get("query") != relation.get("query"):
            raise ValueError("추가 질문은 실제 미해결 참조의 질문과 같아야 합니다.")
        next_query = txt(p["query"], 500)
        lineage.append({"sourceId": source["id"], "targetId": target, "query": next_query})
    return {"records": list(by_id.values()), "visited": visited, "lineage": lineage, "hasNext": bool(next_query), "nextQuery": next_query}


def policy_resolve(a):
    as_of = stamp(a["asOf"])
    scope = txt(a["scope"], 100)
    eligible, excluded = [], []
    for raw in seq(a["documents"], 20):
        d = obj(raw)
        txt(d["id"], 100); txt(d["text"]); txt(d["value"], 500)
        authority = integer(d["authority"], 0, 100)
        begin = stamp(d["effectiveFrom"])
        end = stamp(d["effectiveUntil"]) if d.get("effectiveUntil") else float("inf")
        if begin >= end:
            raise ValueError("문서 적용 기간이 올바르지 않습니다.")
        if scope not in seq(d["scopes"], 20) or not begin <= as_of < end:
            excluded.append({"id": d["id"], "reason": "scope_or_effective_period"})
        else:
            eligible.append({**d, "authority": authority})
    if not eligible:
        return {"state": "missing", "eligible": [], "excluded": excluded, "chosen": None}
    rank = max(d["authority"] for d in eligible)
    top = [d for d in eligible if d["authority"] == rank]
    newest = max(stamp(d["effectiveFrom"]) for d in top)
    top = [d for d in top if stamp(d["effectiveFrom"]) == newest]
    chosen = top[0] if len({d["value"] for d in top}) == 1 else None
    if a.get("selectedId") is not None:
        chosen = next((d for d in top if d["id"] == a["selectedId"]), None)
        if chosen is None:
            raise ValueError("사람의 선택도 현재 적용되는 최상위 문서 안에서 해야 합니다.")
    return {"state": "resolved" if chosen else "needs_review", "eligible": top, "excluded": excluded, "chosen": chosen, "basis": ["scope", "effective_period", "authority", "latest_effective_date"]}


def policy_diff(a):
    def sections(name):
        result = {}
        for raw in seq(a[name], 100):
            d = obj(raw); key = txt(d["id"], 100); txt(d["text"])
            if key in result:
                raise ValueError("문단 ID가 중복됩니다.")
            result[key] = d
        return result
    old, new = sections("old"), sections("new")
    changes = []
    for key in sorted(set(old) | set(new)):
        if old.get(key) != new.get(key):
            changes.append({"sectionId": key, "kind": "added" if key not in old else "removed" if key not in new else "modified", "before": old.get(key), "after": new.get(key)})
    return {"changes": changes, "changedIds": [c["sectionId"] for c in changes], "count": len(changes), "oldHash": digest(a["old"]), "newHash": digest(a["new"])}


def impact_search(a):
    changed = set(seq(a["changedIds"], 100))
    matches, unknown = [], []
    for raw in seq(a["registry"], 100):
        r = obj(raw); txt(r["taskId"], 100)
        refs = seq(r["policyRefs"], 100)
        overlap = sorted(changed.intersection(refs))
        if overlap:
            matches.append({**r, "changedReferences": overlap})
        elif r.get("referencesComplete") is not True:
            unknown.append(r["taskId"])
    return {"affected": matches, "unconfirmedTaskIds": unknown, "count": len(matches)}


def intake(a):
    allowed = set(seq(a["allowedIds"], 20)); permissions = obj(a["permissions"])
    prior = seq(a.get("existing", []), 400)
    existing = {txt(obj(r)["resourceId"], 100): r for r in prior}
    if len(existing) != len(prior):
        raise ValueError("저장된 반입 원장의 자료 ID가 중복됩니다.")
    accepted, rejected, duplicate, seen = [], [], [], set()
    for raw in seq(a["documents"], 20):
        d = obj(raw); rid = txt(d["resourceId"], 100)
        reason = ""
        if rid in seen:
            reason = "duplicate_id"
        elif rid not in allowed or permissions.get(rid) is not True:
            reason = "permission_denied"
        elif not isinstance(d.get("content"), str) or not d["content"].strip() or len(d["content"]) > 40000 or not isinstance(d.get("version"), str) or not d["version"].strip():
            reason = "invalid_document"
        seen.add(rid)
        if reason:
            rejected.append({"resourceId": rid, "reason": reason}); continue
        candidate = {"resourceId": rid, "version": d["version"], "content": d["content"]}
        signature = digest(candidate)
        if existing.get(rid, {}).get("hash") == signature:
            duplicate.append(rid)
        else:
            accepted.append(candidate)
    # Retain earlier imports; a delta must never replace the cumulative ledger.
    manifest = {rid: copy.deepcopy(record) for rid, record in existing.items()}
    for document in accepted:
        manifest[document["resourceId"]] = {**document, "hash": digest(document)}
    if len(manifest) > 400:
        raise ValueError("반입 원장은 최대 400개 자료를 보존합니다.")
    # A new generation contains previous allowed material as well as this delta.
    # Legacy hash-only entries remain deduplicated, but cannot invent source text.
    documents = [{key: record[key] for key in ("resourceId", "version", "content")}
                 for rid, record in manifest.items()
                 if rid in allowed and permissions.get(rid) is True and isinstance(record.get("content"), str)]
    return {"accepted": accepted, "documents": documents, "rejected": rejected, "duplicates": duplicate,
            "ready": bool(accepted), "manifest": list(manifest.values())}


def batch_prepare(a):
    items = seq(a["items"], 400); size = integer(a.get("pageSize", 20), 1, 20)
    ids = [txt(obj(item)["id"], 100) for item in items]
    if len(set(ids)) != len(ids):
        raise ValueError("대량 작업의 항목 ID가 중복됩니다.")
    pages = [{"cursor": i // size, "nextCursor": i // size + 1, "items": items[i:i + size]} for i in range(0, len(items), size)]
    if len(pages) > 20:
        raise ValueError("한 번에 20페이지까지만 처리합니다.")
    return {"pages": pages, "total": len(items), "batchHash": digest(items)}


def batch_item(a):
    item = obj(a["item"]); rid = txt(item["id"], 100)
    try:
        value = number(item["value"])
        if value < 0:
            raise ValueError("음수 작업 수량")
    except (KeyError, ValueError):
        return {"id": rid, "status": "failed", "reason": "nonnegative_number_required"}
    return {"id": rid, "status": "completed", "value": value, "squared": value * value}


def batch_page(a):
    items = seq(a["items"], 20)
    ids = [txt(obj(item)["id"], 100) for item in items]
    if len(ids) != len(set(ids)):
        raise ValueError("페이지 항목 ID가 중복됩니다.")
    return {"rows": [{"output": {"data": batch_item({"item": item})}} for item in items]}


def batch_collect(a):
    rows = []
    for page in seq(a["pages"], 20):
        for result in seq(obj(page)["output"]["rows"], 20):
            rows.append(obj(result)["output"]["data"])
    failed = [r for r in rows if r["status"] != "completed"]
    return {"rows": rows, "completed": [r for r in rows if r["status"] == "completed"], "failed": failed, "failedCount": len(failed), "cursor": len(a["pages"]), "count": len(rows),
            "summary": {"total": len(rows), "failedCount": len(failed), "completedCount": len(rows)-len(failed), "failedSample": failed[:20], "sampleTruncated": len(failed)>20}}


def batch_repairs(a):
    prepared = batch_repair_prepare(a)
    retried = [batch_item({"item": r}) for page in prepared["pages"] for r in page["items"]]
    return batch_repair_merge({"completed": prepared["completed"], "failed": prepared["failed"], "retried": retried})


def batch_repair_prepare(a):
    completed = seq(a["completed"], 400); failed = seq(a["failed"], 400); repairs = seq(a["repairs"], 400)
    failed_ids = {r["id"] for r in failed}; ids = [obj(r).get("id") for r in repairs]
    completed_ids = {r["id"] for r in completed}
    if len(completed) + len(failed) > 400 or len(failed_ids) != len(failed) or len(completed_ids) != len(completed) or completed_ids & failed_ids:
        raise ValueError("기존 항목 결과의 ID 또는 전체 한도가 올바르지 않습니다.")
    if len(ids) != len(set(ids)) or set(ids) != failed_ids:
        raise ValueError("실패한 항목만 빠짐없이 보완해야 하며 완료 항목을 다시 실행할 수 없습니다.")
    return {**batch_prepare({"items": repairs, "pageSize": 20}), "completed": completed, "failed": failed}


def batch_repair_merge(a):
    completed = seq(a["completed"], 400); failed = seq(a["failed"], 400); retried = seq(a["retried"], 400)
    ids = [obj(r)["id"] for r in retried]
    if len(ids) != len(set(ids)) or set(ids) != {r["id"] for r in failed} or {r["id"] for r in completed} & set(ids):
        raise ValueError("재처리 결과는 실패 ID 집합과 정확히 일치해야 합니다.")
    return {"completed": completed + [r for r in retried if r["status"] == "completed"], "failed": [r for r in retried if r["status"] != "completed"], "passed": all(r["status"] == "completed" for r in retried), "reusedCount": len(completed), "retriedIds": ids}


def transfer_begin(a):
    if a.get("legacy") not in (None, {}):
        raise ValueError("구형 transfer_stage 원장이 남아 있어 새 외부 쓰기를 중단합니다. 회사 서비스에서 요청별 결과를 확인한 뒤 원장 전환을 진행해 주세요. 기존 원장을 자동 삭제하지 않습니다.")
    ledger = copy.deepcopy(obj(a["ledger"])); revision = integer(ledger["revision"], 0, 1000000)
    requests = obj(ledger["requests"]); request = obj(a["request"])
    rid = txt(request["requestId"], 100); title = txt(request["title"], 1000)
    if request["mode"] not in ("create", "reconcile"):
        raise ValueError("등록 또는 조정 요청만 허용합니다.")
    previous = requests.get(rid)
    fingerprint = digest({"requestId": rid, "title": title})
    if previous:
        if previous["requestHash"] != fingerprint:
            raise ValueError("같은 요청 ID의 업무 내용이 바뀌었습니다.")
        return {"mode": "reconcile", "ledger": ledger, "request": previous, "expectedRevision": revision}
    if request["mode"] == "reconcile":
        return {"mode": "missing", "ledger": ledger, "request": request, "expectedRevision": revision}
    if len(requests) >= 400:
        raise ValueError("조정 원장은 최대 400개 요청을 보존합니다.")
    record = {"requestId": rid, "title": title, "requestHash": fingerprint, "status": "reserved", "crmId": "", "ticketId": ""}
    requests[rid] = record; ledger["revision"] = revision + 1
    return {"mode": "create", "ledger": ledger, "request": record, "expectedRevision": revision}


def transfer_record(a):
    ledger = copy.deepcopy(obj(a["ledger"])); revision = integer(ledger["revision"], 0, 1000000)
    rid = txt(a["requestId"], 100); record = obj(ledger["requests"].get(rid)); received = obj(a["receipt"])
    if received.get("requestId") != rid:
        raise ValueError("서비스 영수증의 요청 식별자가 다릅니다.")
    stage = a.get("stage", "crm")
    if stage == "crm":
        if record["status"] != "reserved": raise ValueError("CRM 등록을 이미 진행한 요청입니다.")
        record.update(crmId=txt(received["crmId"], 200), status="crm_created")
    elif stage == "ticket":
        if record["status"] != "crm_created" or received.get("crmId") != record["crmId"] or received.get("created") is not True:
            raise ValueError("티켓 영수증의 CRM 연결 또는 완료 상태가 다릅니다.")
        record.update(ticketId=txt(received["ticketId"], 200), status="completed")
    else:
        raise ValueError("등록된 서비스 단계가 아닙니다.")
    ledger["revision"] = revision + 1
    return {"ledger": ledger, "request": record, "expectedRevision": revision}


def choose_candidate(a):
    scores = seq(a["scores"], 10)
    if not scores:
        raise ValueError("후보 평가가 없습니다.")
    valid = [obj(r) for r in scores if r.get("passed") is True]
    for r in valid:
        txt(r["candidateId"], 100); number(r["score"])
    if not valid:
        return {"state": "none", "candidateIds": [], "winner": ""}
    maximum = max(r["score"] for r in valid)
    ids = [r["candidateId"] for r in valid if r["score"] == maximum]
    if a.get("selectedId") is not None:
        if a["selectedId"] not in ids: raise ValueError("동점 선택은 최고 점수 후보 안에서 해야 합니다.")
        return {"state": "selected", "candidateIds": ids, "winner": a["selectedId"], "humanSelected": True}
    return {"state": "tie" if len(ids) > 1 else "selected", "candidateIds": ids, "winner": ids[0] if len(ids) == 1 else ""}


def budget_plan(a):
    budget = obj(a["runtimeBudget"])
    remaining = {name: max(0, number(budget[maximum]) - number(budget[used])) for name, maximum, used in [("turns", "maxTurns", "usedTurns"), ("tools", "maxToolCalls", "usedToolCalls"), ("tokens", "maxTokens", "usedTokens")]}
    remaining["durationMs"] = max(0, number(budget["remainingDurationMs"]))
    tasks = seq(a["tasks"], 10)
    if len({obj(t)["id"] for t in tasks}) != len(tasks):
        raise ValueError("예산 작업 ID가 중복됩니다.")
    selected, omitted, cost = [], [], {k: 0 for k in remaining}
    for t in sorted(tasks, key=lambda v: (v.get("required") is not True, v["id"])):
        required = t.get("required") is True
        addition = {k: number(obj(t["cost"])[k]) for k in remaining}
        if any(v < 0 for v in addition.values()):
            raise ValueError("비용은 음수일 수 없습니다.")
        if all(cost[k] + addition[k] <= remaining[k] for k in remaining):
            selected.append(t["id"]); cost = {k: cost[k] + addition[k] for k in cost}
        elif required:
            return {"state": "blocked", "selected": [], "optionalSelected": False, "omitted": [v["id"] for v in tasks], "remaining": remaining, "reason": "required_task_budget"}
        else:
            omitted.append(t["id"])
    optional_selected = any(t["id"] in selected and t.get("required") is not True for t in tasks)
    return {"state": "partial" if omitted else "full", "selected": selected, "optionalSelected": optional_selected, "omitted": omitted, "remaining": remaining, "plannedCost": cost}


def response_trust(a):
    request = obj(a["request"]); as_of = stamp(request["asOf"]); age = number(request["maxAgeSeconds"])
    if age < 0:
        raise ValueError("허용 신선도는 음수일 수 없습니다.")
    valid, invalid = [], []
    for r in seq(a["responses"], 10):
        r = obj(r)
        reason = ""
        if r.get("requestId") != request["requestId"] or r.get("target") != request["target"]:
            reason = "request_or_target_mismatch"
        elif not 0 <= as_of - stamp(r["observedAt"]) <= age:
            reason = "stale_or_future"
        elif not isinstance(r.get("source"), str) or not r["source"].strip() or "value" not in r:
            reason = "missing_source_or_value"
        if reason:
            invalid.append({"source": r.get("source", ""), "reason": reason})
        else:
            valid.append(r)
    conflict = len({digest(r["value"]) for r in valid}) > 1
    return {"state": "review" if conflict else "trusted" if valid else "retry", "valid": valid, "invalid": invalid, "value": valid[0]["value"] if valid and not conflict else None}


def table_reconcile(a):
    raw = txt(a["csvText"])
    table = list(csv.DictReader(io.StringIO(raw)))
    seq(table, 100)
    required = {"sku", "quantity", "unit", "unitPrice", "currency"}
    if not table or set(table[0]) != required:
        raise ValueError("표 열은 sku, quantity, unit, unitPrice, currency가 필요합니다.")
    units = {"g": ("g", 1), "kg": ("g", 1000), "ml": ("ml", 1), "l": ("ml", 1000), "ea": ("ea", 1)}
    documents = {}
    for line_number, line in enumerate(txt(a["documentText"]).splitlines(), 1):
        parts = line.split("|")
        if len(parts) != 5:
            raise ValueError("원문은 SKU|수량|단위|단가|통화 형식이어야 합니다.")
        sku, quantity, unit, price, currency = [part.strip() for part in parts]
        if sku in documents:
            raise ValueError("원문 SKU가 중복됩니다.")
        documents[sku] = {"sku": sku, "quantity": quantity, "unit": unit, "unitPrice": price, "currency": currency, "line": line_number, "quote": line}
    def normalized(row):
        if row["unit"] not in units:
            raise ValueError("지원하지 않는 단위입니다.")
        unit, factor = units[row["unit"]]
        quantity, price = number(float(row["quantity"])), number(float(row["unitPrice"]))
        if quantity < 0 or price < 0:
            raise ValueError("수량·단가는 음수일 수 없습니다.")
        return {"unit": unit, "quantity": quantity * factor, "pricePerUnit": price / factor, "currency": txt(row["currency"], 10), "total": quantity * price}
    rows, seen = [], set()
    for i, row in enumerate(table, 2):
        sku = txt(row["sku"], 100)
        if sku in seen:
            raise ValueError("표 SKU가 중복됩니다.")
        seen.add(sku); original = documents.get(sku)
        table_value, document_value = normalized(row), normalized(original) if original else None
        rows.append({"sku": sku, "table": table_value, "document": document_value, "matched": table_value == document_value, "cells": [f"A{i}", f"B{i}", f"C{i}", f"D{i}", f"E{i}"], "sourceLine": original["line"] if original else None, "quote": original["quote"] if original else ""})
    missing = sorted(set(documents) - seen)
    return {"rows": rows, "unmatchedDocumentSkus": missing, "passed": all(r["matched"] for r in rows) and not missing, "count": len(rows)}


def data_contract(a):
    rows = seq(a["rows"], 1000); maximum = integer(a.get("maxRows", 7), 1, 1000); field = txt(a.get("numericField", "count"), 100)
    if not rows or len(rows) > maximum:
        raise ValueError("조회 행 수가 계약 범위를 벗어났습니다.")
    values = [number(obj(row)[field]) for row in rows]
    for row in rows:
        if set(row) != set(seq(a.get("columns", ["day", "count"]), 40)):
            raise ValueError("조회 응답 열이 등록 계약과 다릅니다.")
    return {"values": values, "count": len(rows), "sourceHash": digest(rows), "unit": txt(a.get("unit", "건"), 40)}


def notification(a):
    event = obj(a["event"]); now = stamp(event["at"]); retention = integer(a["retentionSeconds"], 1, 31536000)
    ledger = [r for r in seq(a.get("ledger", []), 400) if stamp(r["at"]) >= now - retention]
    key = txt(event["eventId"], 100)
    prior = next((r for r in ledger if r["eventId"] == key), None)
    fingerprint = digest({"source": event["source"], "state": event["state"]})
    last = next((r for r in reversed(ledger) if r["source"] == event["source"] and r.get("status") == "sent"), None)
    if prior:
        if prior["fingerprint"] != fingerprint:
            raise ValueError("같은 사건 ID의 내용이 바뀌었습니다.")
        return {"state": "duplicate" if prior.get("status") == "sent" else "reconcile", "ledger": ledger, "event": prior}
    if last and last["fingerprint"] == fingerprint:
        return {"state": "unchanged", "ledger": ledger, "event": event}
    record = {**event, "fingerprint": fingerprint, "status": "pending"}
    return {"state": "send", "ledger": ledger + [record], "event": record}


def notification_commit(a):
    ledger = seq(a["ledger"], 400); receipt = obj(a["receipt"])
    if receipt.get("eventId") != a["eventId"] or not isinstance(receipt.get("receiptId"), str) or not receipt["receiptId"].strip():
        raise ValueError("전송 영수증의 사건 ID가 일치하지 않습니다.")
    found = False; updated = []
    for record in ledger:
        if record["eventId"] == a["eventId"]:
            found = True; record = {**record, "status": "sent", "receiptId": receipt["receiptId"]}
        updated.append(record)
    if not found:
        raise ValueError("전송 원장에 사건이 없습니다.")
    return {"ledger": updated, "receiptId": receipt["receiptId"]}


def project_memory(a):
    project = txt(a["projectId"], 100); now = stamp(a["asOf"])
    store = obj(a.get("store", {})); records = [r for r in seq(store.get(project, []), 100) if stamp(r["expiresAt"]) > now]
    candidate = obj(a["candidate"]); key = txt(candidate["key"], 100); txt(candidate["value"], 4000)
    if candidate.get("projectId") != project or not seq(candidate.get("sources", []), 20) or stamp(candidate["expiresAt"]) <= now:
        raise ValueError("프로젝트·근거·유효 기간이 없는 기억을 저장할 수 없습니다.")
    evidence = {r["id"]: txt(r["text"]) for r in seq(a["evidence"], 20)}
    for source in candidate["sources"]:
        if obj(source).get("id") not in evidence or txt(source.get("quote"), 4000) not in evidence[source["id"]]:
            raise ValueError("기억의 인용을 제공한 원자료에서 확인할 수 없습니다.")
    conflicts = [r for r in records if r["key"] == key and r["value"] != candidate["value"]]
    if a.get("commit") is True:
        if a.get("accepted") is not True:
            raise ValueError("검증된 교훈은 사람의 수락 후 저장합니다.")
        history = [{**r, "superseded": True} for r in conflicts]
        records = [r for r in records if r["key"] != key] + history + [{**candidate, "accepted": True}]
    return {"conflicts": conflicts, "requiresReview": True, "store": {**store, project: records}, "active": [r for r in records if not r.get("superseded")], "candidate": candidate}


def hypothesis_update(a):
    hypotheses = seq(a["hypotheses"], 10); observations = seq(a.get("observations", []), 20)
    statuses = []
    for hypothesis in hypotheses:
        h = obj(hypothesis); predictions = obj(h["predictions"]); matches, contradictions = [], []
        for raw in observations:
            observation = obj(raw); feature = txt(observation["feature"], 100); txt(observation["source"], 100)
            if feature in predictions:
                (matches if predictions[feature] == observation["value"] else contradictions).append(feature)
        statuses.append({"id": h["id"], "state": "refuted" if contradictions else "supported" if matches else "unresolved", "matches": matches, "contradictions": contradictions})
    alive = [h for h, state in zip(hypotheses, statuses) if state["state"] != "refuted"]
    observed = {o["feature"] for o in observations}
    candidates = sorted({k for h in alive for k in h["predictions"]} - observed)
    discriminating = [key for key in candidates if len({digest(h["predictions"].get(key)) for h in alive}) > 1]
    selected = a.get("selectedFeature")
    if selected is not None and selected not in discriminating:
        raise ValueError("선택 관찰은 미확인 경쟁 가설을 구별할 수 있어야 합니다.")
    return {"hypotheses": hypotheses, "observations": observations, "states": statuses, "nextFeatures": discriminating, "sufficient": len(alive) == 1 and bool(observations), "winner": alive[0]["id"] if len(alive) == 1 and observations else "", "selectedFeature": selected or ""}


def regression(a):
    def evaluate(rule, value, depth=0):
        if depth > 5:
            raise ValueError("조건 중첩 한도입니다.")
        rule = obj(rule); operation = rule.get("op")
        if operation in ("and", "or"):
            children = seq(rule["rules"], 8)
            if not children:
                raise ValueError("빈 논리 조건입니다.")
            results = [evaluate(child, value, depth + 1) for child in children]
            return all(results) if operation == "and" else any(results)
        left = number(obj(value)[txt(rule["field"], 100)]); right = number(rule["value"])
        operations = {"eq": lambda: left == right, "ne": lambda: left != right, "lt": lambda: left < right, "lte": lambda: left <= right, "gt": lambda: left > right, "gte": lambda: left >= right}
        if operation not in operations:
            raise ValueError("등록되지 않은 조건 연산입니다.")
        return operations[operation]()
    candidate = obj(a["candidate"]); specification = obj(a["specification"])
    cases = seq(a["cases"], 100)
    checks = [{"input": obj(value), "expected": evaluate(specification, value), "actual": evaluate(candidate, value)} for value in cases]
    for check in checks:
        check["passed"] = check["expected"] == check["actual"]
    return {"passed": all(c["passed"] for c in checks), "checks": checks, "counterexamples": [c["input"] for c in checks if not c["passed"]], "count": len(checks)}


def candidate_score(a):
    """Score independently generated numeric allocation plans against one immutable contract."""
    costs = obj(a["costs"]); benefits = obj(a["benefits"]); capacity = number(a["capacity"])
    scores = []
    for candidate in seq(a["candidates"], 10):
        selected = seq(obj(candidate)["selected"], 20)
        if len(set(selected)) != len(selected) or any(k not in costs or k not in benefits for k in selected):
            raise ValueError("후보는 중복 없이 등록된 작업만 선택해야 합니다.")
        cost = sum(number(costs[k]) for k in selected)
        score = sum(number(benefits[k]) for k in selected)
        scores.append({"candidateId": txt(candidate["id"], 100), "passed": cost <= capacity, "score": score, "cost": cost})
    return {"scores": scores, "selection": choose_candidate({"scores": scores})}


def debate(a):
    sources = {r["id"]: txt(r["text"]) for r in seq(a["sources"], 20)}
    originals = {r["id"]: r["claim"] for r in seq(a.get("originalClaims", []), 10)}
    issues, seen = [], set()
    for issue in seq(a["issues"], 10):
        key = txt(issue["id"], 100)
        if key in seen: raise ValueError("쟁점 ID가 중복됩니다.")
        seen.add(key)
        if originals and (key not in originals or obj(issue).get("claim") != originals[key]):
            raise ValueError("반박 단계가 원래 주장이나 쟁점 ID를 바꿨습니다.")
        sides = {}
        for side in ("claim", "rebuttal"):
            record = obj(issue[side]); quote = txt(record["quote"], 4000)
            valid = record.get("sourceId") in sources and quote in sources[record["sourceId"]]
            sides[side] = {**record, "evidenceValid": valid}
        issues.append({"id": key, **sides, "unresolved": not all(v["evidenceValid"] for v in sides.values())})
    if originals and set(originals) != seen:
        raise ValueError("원래 쟁점을 빠짐없이 반박해야 합니다.")
    return {"issues": issues, "unresolvedIds": [i["id"] for i in issues if i["unresolved"]], "passed": all(not i["unresolved"] for i in issues)}


def version(a):
    document = obj(a["document"]); current = digest(document)
    if "decision" in a and obj(a["decision"]).get("versionHash") != current:
        raise ValueError("판단이 현재 편집 버전에 결합되지 않았습니다.")
    return {"document": document, "versionHash": current, "decision": a.get("decision"), "valid": True}


def task_plan(a):
    tasks = seq(a["tasks"], 10); ids = [txt(obj(t)["id"], 100) for t in tasks]
    if len(set(ids)) != len(ids): raise ValueError("계획 작업 ID 중복입니다.")
    done = set(); result = []
    pending = list(tasks)
    while pending:
        ready = [t for t in pending if set(seq(t.get("dependsOn", []), 10)) <= done]
        if not ready: raise ValueError("계획의 의존성이 없거나 순환합니다.")
        for task in ready:
            if task.get("handler") not in ("analyze", "verify", "publish"): raise ValueError("등록되지 않은 계획 작업입니다.")
            result.append({**task, "inputHash": digest(task.get("input", {}))}); done.add(task["id"]); pending.remove(task)
    return {"tasks": result, "planHash": digest(result), "order": [t["id"] for t in result]}


def repair_plan(a):
    plan = task_plan({"tasks": a["tasks"]}); failed = set(seq(a["failedIds"], 10))
    ids = {t["id"] for t in plan["tasks"]}
    if not failed <= ids or not failed: raise ValueError("실제 실패 작업 ID가 필요합니다.")
    invalid = set(failed)
    for task in plan["tasks"]:
        if set(task.get("dependsOn", [])) & invalid: invalid.add(task["id"])
    replacements = seq(a["replacements"], 10)
    if {r["taskId"] for r in replacements} != failed: raise ValueError("실패 작업에만 새 담당 계약을 지정하세요.")
    for replacement in replacements:
        if replacement.get("assignee") not in ("specialist", "reviewer"): raise ValueError("등록되지 않은 새 담당자입니다.")
    cached = obj(a["results"])
    preserved = {key: value for key, value in cached.items() if key in ids - invalid}
    return {"invalidated": sorted(invalid), "preserved": preserved, "replacements": replacements, "rerunOrder": [t["id"] for t in plan["tasks"] if t["id"] in invalid], "planHash": plan["planHash"]}


def receipt(a):
    requested = obj(a["requested"]); received = obj(a["receipt"])
    for key in seq(a.get("matchFields", ["requestId", "crmId"]), 10):
        if requested.get(key) != received.get(key): raise ValueError("서비스 영수증의 요청 식별자가 다릅니다.")
    rid = txt(received[txt(a.get("idField", "ticketId"), 100)], 200)
    return {"id": rid, "receipt": received, "requestHash": digest(requested), "verified": True}


def project_memory_commit(a):
    return project_memory({**a, "commit": True, "accepted": True})


def followup_receipt(a):
    return receipt({**a, "matchFields": ["meetingId"], "idField": "taskId"})


def crm_receipt(a):
    return receipt({**a, "matchFields": ["requestId"], "idField": "crmId"})


OPERATIONS = {"research." + name: fn for name, fn in {
    "frontier": frontier, "policy_resolve": policy_resolve, "policy_diff": policy_diff,
    "impact_search": impact_search, "intake": intake, "batch_prepare": batch_prepare,
    "batch_item": batch_item, "batch_page": batch_page, "batch_collect": batch_collect, "batch_repairs": batch_repairs,
    "batch_repair_prepare": batch_repair_prepare, "batch_repair_merge": batch_repair_merge,
    "transfer_begin": transfer_begin, "transfer_record": transfer_record,
    "choose_candidate": choose_candidate, "budget_plan": budget_plan, "response_trust": response_trust,
    "table_reconcile": table_reconcile, "data_contract": data_contract,
    "notification": notification, "notification_commit": notification_commit,
    "project_memory": project_memory, "hypothesis_update": hypothesis_update, "regression": regression,
    "candidate_score": candidate_score, "debate": debate, "version": version,
    "task_plan": task_plan, "repair_plan": repair_plan, "receipt": receipt,
    "project_memory_commit": project_memory_commit,
    "followup_receipt": followup_receipt, "crm_receipt": crm_receipt,
}.items()}
_rule = {"op": "gte", "field": "x", "value": 0}
_document = {"resourceId": "guide", "version": "v1", "content": "release ready"}
_event = {"eventId": "e1", "at": "2026-10-25T00:00:00Z", "source": "release", "state": "blocked"}
_lesson = {"projectId": "P1", "key": "retry", "value": "영수증 조회", "sources": [{"id": "test1", "quote": "영수증을 조회했다."}], "expiresAt": "2027-01-01T00:00:00Z"}
_memory = {"projectId": "P1", "asOf": "2026-10-25T00:00:00Z", "store": {}, "candidate": _lesson, "evidence": [{"id": "test1", "text": "영수증을 조회했다."}]}
_tasks = [{"id": "facts", "handler": "analyze", "dependsOn": [], "input": {"n": 2}}, {"id": "analysis", "handler": "verify", "dependsOn": ["facts"], "input": {}}]
_examples = {
    "frontier": ("실제 미해결 참조를 방문 집합·출처 계보와 대조하고 다음 질문을 제한합니다.", {"records": [{"id": "a", "text": "A는 B를 참조한다.", "relations": [{"targetId": "b", "query": "B 조회"}]}], "proposal": {"sourceId": "a", "targetId": "b", "query": "B 조회"}}),
    "policy_resolve": ("범위·효력 기간·권위·효력 시작일을 대조해 적용 규정과 동급 충돌을 계산합니다.", {"asOf": "2026-10-25T00:00:00Z", "scope": "개발", "documents": [{"id": "p1", "text": "3일", "value": "3일", "authority": 90, "effectiveFrom": "2025-01-01T00:00:00Z", "scopes": ["개발"]}]}),
    "policy_diff": ("문단 ID로 두 원문 버전의 추가·삭제·수정을 계산하고 해시를 남깁니다.", {"old": [{"id": "a", "text": "30일"}], "new": [{"id": "a", "text": "60일"}]}),
    "impact_search": ("변경 문단 ID를 업무 참조 목록과 교차해 영향과 미확인을 분리합니다.", {"changedIds": ["a"], "registry": [{"taskId": "backup", "policyRefs": ["a"], "referencesComplete": True}]}),
    "intake": ("사내 권한 결과·자료 ID·본문 형식·기존 해시로 반입, 격리, 중복을 계산합니다.", {"documents": [_document], "allowedIds": ["guide"], "permissions": {"guide": True}, "existing": []}),
    "batch_prepare": ("최대400항목을 최대20페이지로 분할하고 다음 커서와 입력 해시를 계산합니다.", {"items": [{"id": "a", "value": 2}, {"id": "b", "value": 3}], "pageSize": 1}),
    "batch_item": ("비음수 숫자 작업을 실제 제곱 계산하며 잘못된 항목을 실패 기록으로 분리합니다.", {"item": {"id": "a", "value": 2}}),
    "batch_page": ("한 페이지의 최대20개 항목을 같은 비음수 계산 계약으로 처리해 항목별 성공·실패를 보존합니다.", {"items": [{"id": "a", "value": 2}, {"id": "b", "value": -1}]}),
    "batch_collect": ("완료한 페이지의 실제 항목 결과에서 성공·실패·완료 커서를 집계합니다.", {"pages": [{"output": {"rows": [{"output": {"data": {"id": "a", "status": "completed", "squared": 4}}}]}}]}),
    "batch_repairs": ("실패 ID와 정확히 같은 보완 집합만 재처리하고 완료 결과를 보존합니다.", {"completed": [{"id": "a", "status": "completed", "squared": 4}], "failed": [{"id": "b", "status": "failed"}], "repairs": [{"id": "b", "value": 3}]}),
    "batch_repair_prepare": ("최대400개 실패 보완을 검증하고 기존 페이지 처리기로 넘길 20항목 페이지를 구성합니다.", {"completed": [], "failed": [{"id": "b", "status": "failed"}], "repairs": [{"id": "b", "value": 3}]}),
    "batch_repair_merge": ("실패 ID와 페이지 재처리 결과를 대조하고 이전 성공 결과를 변경 없이 결합합니다.", {"completed": [], "failed": [{"id": "b", "status": "failed"}], "retried": [{"id": "b", "status": "completed", "squared": 9}]}),
    "transfer_begin": ("구형 원장이 있으면 전환 확인 전 중단하고, 요청별 누적 원장의 중복·내용 충돌 검사 후 외부 쓰기 전 CAS 예약을 만듭니다.", {"ledger": {"revision": 0, "requests": {}}, "legacy": {}, "request": {"requestId": "r1", "title": "배포 오류", "mode": "create"}}),
    "transfer_record": ("실제 CRM·티켓 영수증을 요청 ID와 대조하고 다른 요청을 보존한 CAS 갱신을 만듭니다.", {"ledger": {"revision": 1, "requests": {"r1": {"requestId": "r1", "status": "reserved", "crmId": "", "ticketId": ""}}}, "requestId": "r1", "stage": "crm", "receipt": {"requestId": "r1", "crmId": "c1"}}),
    "choose_candidate": ("같은 기준으로 계산한 합격 후보의 최고 점수와 동률을 판정합니다.", {"scores": [{"candidateId": "a", "passed": True, "score": 2}, {"candidateId": "b", "passed": True, "score": 1}]}),
    "budget_plan": ("실행기가 주입한 실제 잔여 예산으로 필수 작업 우선 계획과 생략 목록을 계산합니다.", {"runtimeBudget": {"maxTurns": 8, "usedTurns": 1, "maxToolCalls": 12, "usedToolCalls": 0, "maxTokens": 8000, "usedTokens": 100, "remainingDurationMs": 60000}, "tasks": [{"id": "required", "required": True, "cost": {"turns": 1, "tools": 0, "tokens": 100, "durationMs": 1000}}]}),
    "response_trust": ("응답의 요청ID·대상·신선도·출처·값 충돌을 검사하여 신뢰/재조회/검토를 구분합니다.", {"request": {"requestId": "q1", "target": "release", "asOf": "2026-10-25T00:00:30Z", "maxAgeSeconds": 60}, "responses": [{"requestId": "q1", "target": "release", "observedAt": "2026-10-25T00:00:00Z", "source": "metrics", "value": "ready"}]}),
    "table_reconcile": ("CSV와 SKU|수량|단위|단가|통화 원문을 파싱해 단위 환산·식별자 결합·출처 셀을 계산합니다.", {"csvText": "sku,quantity,unit,unitPrice,currency\nA,2,kg,1000,KRW", "documentText": "A|2000|g|1|KRW"}),
    "data_contract": ("등록 조회의 열·건수·숫자 형식을 검사하고 검증된 값·단위·원문 해시를 반환합니다.", {"rows": [{"day": "월", "count": 10}, {"day": "화", "count": 20}]}),
    "notification": ("보존 기간 전체 사건ID·변경 상태를 검사해 중복, 미변경, 신규, 미확정을 분리합니다.", {"event": _event, "retentionSeconds": 86400, "ledger": []}),
    "notification_commit": ("실제 영수증의 사건ID와 저장 원장을 대조한 뒤 전송 완료 기록을 만듭니다.", {"ledger": [{**_event, "fingerprint": digest({"source": "release", "state": "blocked"}), "status": "pending"}], "eventId": "e1", "receipt": {"eventId": "e1", "receiptId": "r1"}}),
    "project_memory": ("프로젝트 범위·원문 인용·만료를 검사하고 기존 기억과 충돌을 분리합니다.", _memory),
    "project_memory_commit": ("사람 수락 경로에서 원문 인용·범위·만료를 다시 검사하고 교훈 및 충돌 이력을 저장할 값을 만듭니다.", _memory),
    "hypothesis_update": ("경쟁 가설의 예측과 관찰을 대조해 지지·반증·미해결 및 구별 가능한 다음 특징을 계산합니다.", {"hypotheses": [{"id": "network", "predictions": {"cpu": "normal"}}, {"id": "compute", "predictions": {"cpu": "high"}}], "observations": [{"feature": "cpu", "value": "high", "source": "metrics"}]}),
    "regression": ("제한된 숫자 조건 AST를 명세와 실제 비교하여 반례와 회귀 실패를 계산합니다. 코드를 실행하지 않습니다.", {"candidate": {"op": "gt", "field": "x", "value": 0}, "specification": _rule, "cases": [{"x": 0}, {"x": 1}]}),
    "candidate_score": ("등록 작업의 비용·효용을 같은 기준으로 합산하고 제약 탈락·최고 후보·동률을 계산합니다.", {"costs": {"a": 2, "b": 3}, "benefits": {"a": 4, "b": 5}, "capacity": 4, "candidates": [{"id": "first", "selected": ["a"]}, {"id": "second", "selected": ["b"]}]}),
    "debate": ("각 쟁점의 주장·반박을 실제 출처와 인용에 대조하여 검증 실패 쟁점을 분리합니다.", {"sources": [{"id": "s1", "text": "지연 2분. 표본 1건."}], "issues": [{"id": "latency", "claim": {"sourceId": "s1", "quote": "지연 2분."}, "rebuttal": {"sourceId": "s1", "quote": "표본 1건."}}]}),
    "version": ("사람이 편집한 문서의 해시를 계산하고 후속 판단의 버전 결합을 검증합니다.", {"document": {"title": "공지", "body": "배포 취소"}}),
    "task_plan": ("등록 핸들러·작업 ID·의존 DAG를 검사하고 실행 순서·입력 해시·계획 해시를 계산합니다.", {"tasks": _tasks}),
    "repair_plan": ("실패 작업의 전이적 종속 영향을 계산하고 정상 캐시를 보존하며 허용 담당자만 배정합니다.", {"tasks": _tasks, "failedIds": ["analysis"], "results": {"facts": {"value": 2}, "analysis": {"value": "wrong"}}, "replacements": [{"taskId": "analysis", "assignee": "specialist"}]}),
    "receipt": ("원 요청과 실제 서비스 영수증의 교차 ID를 대조하고 완료 ID·요청 해시를 반환합니다.", {"requested": {"requestId": "r1", "crmId": "c1"}, "receipt": {"requestId": "r1", "crmId": "c1", "ticketId": "t1"}}),
    "followup_receipt": ("회의 요청과 서비스 영수증의 회의ID·신규 업무ID를 검증합니다.", {"requested": {"meetingId": "m1"}, "receipt": {"meetingId": "m1", "taskId": "t1"}}),
    "crm_receipt": ("최초 CRM 등록의 요청ID와 신규 CRM ID를 검증하여 다른 서비스에 잘못 연결하지 않습니다.", {"requested": {"requestId": "r1"}, "receipt": {"requestId": "r1", "crmId": "c1"}}),
}
CONTRACTS = {"research." + key: {"description": description, "exampleArguments": arguments, "effect": "read", "implementationScope": "bounded_pure_json", "limits": {"network": False, "arbitraryCode": False}} for key, (description, arguments) in _examples.items()}
