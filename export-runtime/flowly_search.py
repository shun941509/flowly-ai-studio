"""Bounded public candidate search. No network, arbitrary code, or hidden reasoning."""
import copy
import hashlib
import json
import re

SEARCH_DEFAULTS = {"mode": "tree", "itemsPath": "items", "targetPath": "target", "maxDepth": 4, "maxCandidates": 24, "maxIterations": 12, "branchFactor": 3, "beamWidth": 4}
SEARCH_PROMPT = "FLOWLY_CANDIDATE_SEARCH: 원래 problem의 항목 ID만 사용하여 목표 합계를 찾는 공개 후보를 제안하세요. JSON {actions:[{type:'create',items:[ID],parents:[후보ID]} 또는 {type:'revise',id:후보ID,items:[ID]}],summary?:'짧은 공개 작업 설명'}만 반환하세요. 합계, 점수, 성공 여부는 실행기가 원본 데이터로 계산합니다. tree에서는 selected 후보의 항목을 포함하는 자식만 만드세요. graph에서는 현재 유효 후보를 최대 3개 병합하거나 기존 후보를 수정할 수 있어요. 수정한 조상의 모든 자손은 폐기됩니다. 내부 사고 과정이나 비공개 추론을 작성하지 마세요. 더 진행할 수 없으면 actions:[]를 반환하세요."


def _fail(message):
    raise ValueError(message)


def _canonical(value):
    def normalize(item, depth=0):
        if depth > 24:
            _fail("도구 입력 구조가 너무 깊어요.")
        if isinstance(item, dict):
            if any(key in ("__proto__", "prototype", "constructor") for key in item):
                _fail("허용되지 않은 도구 입력 필드예요.")
            return {key: normalize(item[key], depth + 1) for key in sorted(item, key=lambda key: key.encode("utf-16-be", errors="surrogatepass"))}
        if isinstance(item, list):
            return [normalize(child, depth + 1) for child in item]
        if type(item) is float and item.is_integer():
            return int(item)
        return item
    text = json.dumps(normalize(value), ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if len(text.encode("utf-8")) > 200000:
        _fail("한 번의 입출력은 200KB를 넘을 수 없어요.")
    return text


def _hash(value):
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _object(value):
    if not isinstance(value, dict):
        _fail("후보 탐색 데이터는 객체여야 해요.")
    return value


def _integer(value, minimum, maximum):
    return type(value) in (int, float) and minimum <= value <= maximum and int(value) == value


def parse_search_config(value):
    if not isinstance(value, dict):
        _fail("후보 탐색 설정은 객체여야 해요.")
    if any(key not in SEARCH_DEFAULTS for key in value):
        _fail("지원하지 않는 후보 탐색 설정이에요.")
    config = {**SEARCH_DEFAULTS, **value}
    if config["mode"] not in ("tree", "graph"):
        _fail("트리 또는 그래프 탐색을 선택해 주세요.")
    for key in ("itemsPath", "targetPath"):
        path = config[key]
        if not isinstance(path, str) or len(path) > 500 or any(part in ("__proto__", "prototype", "constructor") or not (re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,79}", part) or index > 0 and re.fullmatch(r"0|[1-9][0-9]{0,5}", part)) for index, part in enumerate(path.split("."))):
            _fail("후보 탐색의 입력 경로를 확인해 주세요.")
    for key, minimum, maximum in (("maxDepth", 1, 8), ("maxCandidates", 2, 64), ("maxIterations", 1, 32), ("branchFactor", 1, 6), ("beamWidth", 1, 16)):
        if not _integer(config[key], minimum, maximum):
            _fail(f"후보 탐색 {key}는 {minimum}~{maximum} 범위여야 해요.")
        config[key] = int(config[key])
    return config


def _at(value, path):
    for part in path.split("."):
        if isinstance(value, dict) and part in value:
            value = value[part]
        elif isinstance(value, list) and part.isdigit() and int(part) < len(value):
            value = value[int(part)]
        else:
            _fail("후보 탐색의 입력 경로를 찾지 못했어요.")
    return value


def _problem(config, input_data):
    raw, target = _at(input_data, config["itemsPath"]), _at(input_data, config["targetPath"])
    if not isinstance(raw, list) or not 1 <= len(raw) <= 20 or not _integer(target, 1, 10000000):
        _fail("후보 탐색에는 1~20개 항목과 양의 정수 목표가 필요해요.")
    items = []
    for value in raw:
        item = _object(value)
        if any(key not in ("id", "value") for key in item) or not isinstance(item.get("id"), str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,39}", item["id"]) or not _integer(item.get("value"), 1, 1000000):
            _fail("탐색 항목의 ID와 양의 정수 값을 확인해 주세요.")
        items.append({"id": item["id"], "value": int(item["value"])})
    if len({item["id"] for item in items}) != len(items):
        _fail("탐색 항목 ID가 중복되었어요.")
    return {"items": items, "target": int(target)}


def _active(candidate):
    return candidate["status"] not in ("pruned", "dead_end", "invalidated")


def _redact(text):
    text = re.sub(r"\bsk-[A-Za-z0-9_-]{12,}\b", "[비밀 값 숨김]", text)
    return re.sub(r"\bBearer\s+[A-Za-z0-9._~+\/-]+=*", "Bearer [비밀 값 숨김]", text, flags=re.I)


def run_candidate_search(raw_config, input_data, saved, hooks):
    """hooks: model(prompt,input)->JSON, persist(state), check(); all synchronous."""
    config = parse_search_config(raw_config)
    source = _problem(config, input_data)
    config_hash, input_hash = _hash(config), _hash(input_data)

    def integrity(state):
        return _hash({key: value for key, value in state.items() if key != "integrity"})

    def persist():
        state["integrity"] = integrity(state)
        hooks["persist"](copy.deepcopy(state))

    if saved is not None:
        state = copy.deepcopy(saved)
        if state.get("version") != 1 or state.get("configHash") != config_hash or state.get("inputHash") != input_hash or state.get("integrity") != integrity(state):
            _fail("저장된 후보 탐색의 입력·설정·체크포인트가 달라졌어요.")
    else:
        state = {"version": 1, "configHash": config_hash, "inputHash": input_hash, "integrity": "", "iteration": 0, "candidates": [{"id": "c0", "revision": 1, "items": [], "parents": [], "depth": 0, "total": 0, "distance": source["target"], "status": "frontier"}], "frontier": ["c0"], "events": [], "status": "searching"}
        persist()
    values = {item["id"]: item["value"] for item in source["items"]}

    def public_reply(value):
        response = _object(value)
        if any(key not in ("actions", "summary") for key in response) or not isinstance(response.get("actions"), list) or len(response["actions"]) > config["branchFactor"] or "summary" in response and (not isinstance(response["summary"], str) or len(response["summary"].encode("utf-16-le", errors="surrogatepass")) // 2 > 300):
            _fail("후보 제안은 허용된 actions와 짧은 공개 설명만 포함할 수 있어요.")
        for value in response["actions"]:
            action = _object(value)
            revise = action.get("type") == "revise"
            allowed = ("type", "id", "items") if revise else ("type", "items", "parents")
            if action.get("type") != "create" and not revise or any(key not in allowed for key in action) or not isinstance(action.get("items"), list) or not 1 <= len(action["items"]) <= len(source["items"]) or any(not isinstance(item, str) or item not in values for item in action["items"]) or len(set(action["items"])) != len(action["items"]):
                _fail("후보는 원래 항목 ID를 중복 없이 사용해야 해요.")
            if revise and (not isinstance(action.get("id"), str) or not re.fullmatch(r"c\d{1,3}", action["id"])) or "parents" in action and (not isinstance(action["parents"], list) or not 1 <= len(action["parents"]) <= 3 or any(not isinstance(ident, str) or not re.fullmatch(r"c\d{1,3}", ident) for ident in action["parents"])):
                _fail("후보의 부모 연결을 확인해 주세요.")
        return {"actions": copy.deepcopy(response["actions"]), **({"summary": _redact(response["summary"])} if "summary" in response else {})}

    def event(kind, candidate_id=None, details=None):
        state["events"].append({"type": kind, "iteration": state["iteration"], **({"candidateId": candidate_id} if candidate_id else {}), **({"details": details} if details is not None else {})})

    def rebuild():
        ordered = sorted((candidate for candidate in state["candidates"] if candidate["status"] == "frontier"), key=lambda c: (c["distance"], c["depth"], int(c["id"][1:])))
        for candidate in ordered[config["beamWidth"]:]:
            candidate["status"] = "pruned"
            event("pruned", candidate["id"])
        state["frontier"] = [candidate["id"] for candidate in ordered[:config["beamWidth"]]]

    while state["status"] == "searching":
        hooks["check"]()
        if "pending" not in state:
            if state["iteration"] >= config["maxIterations"] or len(state["candidates"]) >= config["maxCandidates"]:
                state["status"] = "limit"
                event("limit")
                persist()
                break
            selected = next((candidate for candidate in state["candidates"] if state["frontier"] and candidate["id"] == state["frontier"][0]), None)
            if selected is None:
                state["status"] = "exhausted"
                event("exhausted")
                persist()
                break
            state["pending"] = {"selectedId": selected["id"], "request": {"mode": config["mode"], "problem": source, "selected": copy.deepcopy(selected), "candidates": [copy.deepcopy(c) for c in state["candidates"] if _active(c)], "limits": {"branchFactor": config["branchFactor"], "remainingCandidates": config["maxCandidates"] - len(state["candidates"]), "maxDepth": config["maxDepth"]}}}
            persist()
        if "reply" not in state["pending"]:
            hooks["check"]()
            response = hooks["model"](SEARCH_PROMPT, copy.deepcopy(state["pending"]["request"]))
            _canonical(response)
            state["pending"]["reply"] = public_reply(response)
            persist()
        hooks["check"]()
        state = copy.deepcopy(state)
        pending = state["pending"]
        response = public_reply(pending["reply"])
        state["iteration"] += 1
        selected = next(c for c in state["candidates"] if c["id"] == pending["selectedId"])
        if selected["status"] == "frontier":
            selected["status"] = "expanded"
        created = 0
        for raw_action in response["actions"]:
            action = _object(raw_action)
            revise = action.get("type") == "revise"
            allowed = ("type", "id", "items") if revise else ("type", "items", "parents")
            if action.get("type") != "create" and not revise or any(key not in allowed for key in action) or not isinstance(action.get("items"), list) or not 1 <= len(action["items"]) <= len(source["items"]) or any(not isinstance(item, str) or item not in values for item in action["items"]) or len(set(action["items"])) != len(action["items"]):
                _fail("후보는 원래 항목 ID를 중복 없이 사용해야 해요.")
            items = sorted(action["items"])
            candidate = None
            if revise:
                if config["mode"] != "graph" or not isinstance(action.get("id"), str) or action["id"] == "c0":
                    _fail("트리에서는 후보를 수정할 수 없고 루트 후보는 변경할 수 없어요.")
                candidate = next((c for c in state["candidates"] if c["id"] == action["id"]), None)
                if candidate is None or not _active(candidate):
                    _fail("수정할 유효 후보가 없어요.")
                parents = []
                for ref in candidate["parents"]:
                    parent = next((c for c in state["candidates"] if c["id"] == ref["id"] and c["revision"] == ref["revision"] and _active(c)), None)
                    if parent is None:
                        _fail("후보의 선행 버전이 유효하지 않아요.")
                    parents.append(parent)
            else:
                if len(state["candidates"]) >= config["maxCandidates"]:
                    _fail("후보 개수 한도를 넘긴 제안이에요.")
                refs = action.get("parents", [selected["id"]])
                if not isinstance(refs, list) or not 1 <= len(refs) <= (1 if config["mode"] == "tree" else 3) or any(not isinstance(ref, str) for ref in refs) or len(set(refs)) != len(refs) or config["mode"] == "tree" and refs[0] != selected["id"]:
                    _fail("후보의 부모 연결을 확인해 주세요.")
                parents = []
                for ref in refs:
                    parent = next((c for c in state["candidates"] if c["id"] == ref and _active(c)), None)
                    if parent is None:
                        _fail("병합할 유효한 부모 후보가 없어요.")
                    parents.append(parent)
            if any(any(item not in items for item in parent["items"]) for parent in parents):
                _fail("새 후보는 부모 후보의 항목을 모두 포함해야 해요.")
            depth = 1 + max(parent["depth"] for parent in parents)
            if depth > config["maxDepth"]:
                _fail("후보 깊이 한도를 넘긴 제안이에요.")
            if not revise and any(_active(c) and c["items"] == items for c in state["candidates"]):
                event("duplicate_skipped")
                continue
            if revise:
                invalid = {candidate["id"]}
                for descendant in state["candidates"]:
                    if descendant["id"] != candidate["id"] and any(ref["id"] in invalid for ref in descendant["parents"]):
                        descendant["status"] = "invalidated"
                        invalid.add(descendant["id"])
                        event("invalidated", descendant["id"], {"ancestor": candidate["id"]})
            total = sum(values[item] for item in items)
            status = "solution" if total == source["target"] else "dead_end" if total > source["target"] or depth == config["maxDepth"] else "frontier"
            next_candidate = {"id": candidate["id"] if candidate is not None else f"c{len(state['candidates'])}", "revision": (candidate["revision"] if candidate is not None else 0) + 1, "items": items, "parents": [{"id": parent["id"], "revision": parent["revision"]} for parent in parents], "depth": depth, "total": total, "distance": abs(source["target"] - total), "status": status}
            if candidate is not None:
                candidate.update(next_candidate)
            else:
                state["candidates"].append(next_candidate)
                created += 1
            event("revised" if revise else "merged" if len(parents) > 1 else "created", next_candidate["id"], {"total": total, "status": status, "parents": next_candidate["parents"]})
        if "summary" in response:
            event("summary", selected["id"], _redact(response["summary"]))
        continuation = any(any(parent["id"] == selected["id"] for parent in c["parents"]) and c["status"] in ("frontier", "solution") for c in state["candidates"])
        backtrack = not continuation if config["mode"] == "tree" else not created and not any(_object(action).get("type") == "revise" for action in response["actions"])
        if backtrack:
            if config["mode"] == "tree" and selected["status"] == "expanded":
                selected["status"] = "dead_end"
            event("backtracked", selected["id"])
        state.pop("pending", None)
        if any(c["status"] == "solution" for c in state["candidates"]):
            state["status"] = "solved"
        rebuild()
        persist()
    winner = next((c for c in state["candidates"] if c["status"] == "solution"), None)
    data = {"mode": config["mode"], "status": state["status"], "solved": winner is not None, "target": source["target"], "selected": winner["items"] if winner else [], "total": winner["total"] if winner else 0, "iterations": state["iteration"], "candidates": state["candidates"], "events": state["events"]}
    return {"text": _canonical(data), "data": data}
