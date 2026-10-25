"""Bounded local RAG generations, incremental vectors, evaluation and tombstones.

This module makes no network calls. The runner supplies its metered embedding callback
and atomic owner/workflow-scoped store. Exported snapshots cannot query remote ACLs.
"""
import copy
import hashlib
import json
import math
import re


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def fail(message):
    raise ValueError(message)


def data_at(value, path):
    for key in path.split("."):
        if isinstance(value, dict) and key in value:
            value = value[key]
        elif isinstance(value, list) and re.fullmatch(r"0|[1-9][0-9]*", key) and int(key) < len(value):
            value = value[int(key)]
        else:
            fail("지식 색인 입력 경로를 찾지 못했어요.")
    return value


def validate_config(config):
    keys = {"action", "indexKey", "resourceIds", "mode", "chunkSize", "topK", "generationPath", "expectedRevisionPath", "documentsPath", "resourceIdsPath", "queryPath", "evaluation"}
    if not isinstance(config, dict) or set(config) - keys:
        fail("지식 색인 설정 형식을 확인해 주세요.")
    if config.get("action") not in ("stage", "evaluate", "publish", "query", "revoke", "rollback", "inspect"):
        fail("지식 색인 작업을 선택해 주세요.")
    if not isinstance(config.get("indexKey"), str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,59}", config["indexKey"]) or config["indexKey"] in ("constructor", "prototype", "__proto__"):
        fail("색인 이름을 확인해 주세요.")
    ids = config.get("resourceIds")
    if not isinstance(ids, list) or not 1 <= len(ids) <= 20 or any(not isinstance(i, str) or not i or len(i) > 100 for i in ids) or len(set(ids)) != len(ids):
        fail("허용 자료를 중복 없이 1~20개 선택해 주세요.")
    if config.get("mode", "lexical") not in ("lexical", "vector"):
        fail("지식 색인 검색 방식을 확인해 주세요.")
    for key, minimum, maximum in (("chunkSize", 200, 2000), ("topK", 1, 10)):
        if key in config and (type(config[key]) is not int or not minimum <= config[key] <= maximum):
            fail("조각 크기 또는 검색 개수 한도를 확인해 주세요.")
    for key in ("generationPath", "expectedRevisionPath", "documentsPath", "resourceIdsPath", "queryPath"):
        if key in config:
            path = config[key]
            if not isinstance(path, str) or len(path) > 500 or any(piece in ("constructor", "prototype", "__proto__") or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,79}" if i == 0 else r"(?:[A-Za-z_][A-Za-z0-9_-]{0,79}|0|[1-9][0-9]{0,5})", piece) for i, piece in enumerate(path.split("."))):
                fail("지식 색인의 입력 경로를 확인해 주세요.")
    if config["action"] in ("evaluate", "publish", "rollback") and not config.get("generationPath"):
        fail("작업 대상 색인 버전 경로가 필요해요.")
    if "evaluation" in config:
        samples = config["evaluation"]
        if not isinstance(samples, list) or not 1 <= len(samples) <= 10 or any(not isinstance(s, dict) or set(s) != {"query", "resourceId"} or not isinstance(s.get("query"), str) or not s["query"].strip() or len(s["query"]) > 500 or s.get("resourceId") not in ids for s in samples):
            fail("평가 질문과 허용 자료의 정답 ID를 1~10개 등록해 주세요.")
    if config["action"] == "evaluate" and not config.get("evaluation"):
        fail("발행 전 검색 평가 질문이 필요해요.")
    return copy.deepcopy(config)


def cosine(a, b):
    if not isinstance(a, list) or not isinstance(b, list) or not a or len(a) != len(b) or len(a) > 4096 or any(type(n) not in (int, float) or not math.isfinite(n) for n in a + b):
        fail("임베딩 벡터 형식이 올바르지 않아요.")
    aa, bb = math.hypot(*a), math.hypot(*b)
    if not aa or not bb or not math.isfinite(aa) or not math.isfinite(bb):
        fail("임베딩 벡터가 비어 있거나 정규화할 수 없어요.")
    return max(-1, min(1, sum(x / aa * (y / bb) for x, y in zip(a, b))))


def validate_vectors(vectors, count):
    if not isinstance(vectors, list) or len(vectors) != count or any(not isinstance(v, list) or not v or len(v) > 4096 or len(v) != len(vectors[0]) for v in vectors):
        fail("지식 색인 임베딩 개수 또는 차원이 맞지 않아요.")
    for vector in vectors:
        cosine(vector, vector)


def execute_knowledge(raw, input_data, context):
    config = validate_config(raw)
    owner, workflow, operation = context["owner_id"], context["workflow_id"], context["operation_id"]
    if not owner or not workflow or not operation:
        fail("지식 색인 소유자와 실행 범위를 확인해 주세요.")
    access, memory = context["assert_access"], context["memory"]
    access(config["resourceIds"])
    available = {}
    for ident in config["resourceIds"]:
        resource = next((r for r in context["resources"] if r["id"] == ident and r["type"] in ("document", "prompt")), None)
        if resource is None:
            fail("지식 색인의 허용 자료 또는 종류를 확인해 주세요.")
        available[ident] = resource
    scope = {"ownerId": owner, "workflowId": workflow, "key": "knowledge_" + config["indexKey"]}
    stored = memory({**scope, "action": "read", "operationId": operation + ":read", "trackOperation": False})
    state = copy.deepcopy(stored["data"]) if stored["found"] else {"version": 1, **scope, "indexKey": config["indexKey"], "revision": 0, "sequence": 0, "tombstoneRevision": 0, "published": None, "generations": {}, "vectors": {}, "revoked": [], "operations": {}}
    if not isinstance(state, dict) or state.get("version") != 1 or state.get("ownerId") != owner or state.get("workflowId") != workflow or state.get("indexKey") != config["indexKey"] or type(state.get("revision")) is not int or state["revision"] < 0 or not isinstance(state.get("revoked"), list) or any(not isinstance(state.get(k), dict) for k in ("generations", "vectors", "operations")):
        fail("저장된 지식 색인의 범위 또는 형식이 올바르지 않아요.")
    request_hash, operation_key = digest({"config": config, "input": input_data}), digest({"operationId": operation})
    previous = state["operations"].get(operation_key)
    if config["action"] not in ("query", "inspect") and previous:
        if previous["hash"] != request_hash:
            fail("완료된 지식 작업의 입력이 바뀌었어요.")
        return copy.deepcopy(previous["result"])
    get = lambda name, default=None: data_at(input_data, config[name]) if name in config else default
    expected = get("expectedRevisionPath")
    if expected is not None and (type(expected) is not int or expected != state["revision"]):
        fail("색인 리비전이 바뀌었어요. 최신 상태를 확인하고 다시 요청해 주세요.")
    previous_revision = state["revision"]
    generation_id = get("generationPath", state["published"])
    allowed = set(config["resourceIds"])

    def target():
        if not isinstance(generation_id, str) or generation_id not in state["generations"]:
            fail("대상 색인 버전이 없어요. 먼저 준비·평가·발행해 주세요.")
        return state["generations"][generation_id]

    def chunks(generation):
        return [c for c in generation["chunks"] if c["resourceId"] in allowed and c["resourceId"] not in state["revoked"]]

    def output(data):
        return {"text": canonical(data), **data}

    def persist(data):
        if len(state["operations"]) >= 128:
            fail("색인 변경 기록 128개 한도에 도달했어요. 새 색인 이름으로 보관을 분리해 주세요.")
        state["revision"] += 1
        result = output({**data, "revision": state["revision"], "publishedGeneration": state["published"]})
        state["operations"][operation_key] = {"hash": request_hash, "result": copy.deepcopy(result)}
        if len(canonical(state).encode("utf-16-le")) // 2 > 200000:
            fail("지식 색인 저장 한도 200,000자에 도달했어요. 자료·조각 또는 버전 수를 줄여 주세요.")
        access(config["resourceIds"])
        memory({**scope, "operationId": operation + ":commit", "action": "write", "value": state, "expectedRevision": previous_revision, "trackOperation": False})
        return result

    def search(generation, query):
        if generation["mode"] != config.get("mode", "lexical"):
            fail("색인 검색 방식과 노드 설정이 달라요. 같은 검색 방식을 선택해 주세요.")
        if not isinstance(query, str) or not query.strip() or len(query.encode("utf-16-le")) // 2 > 2000:
            fail("지식 검색 질문은 비어 있지 않은 2,000자 이내 문자열이어야 해요.")
        candidates = chunks(generation)
        access(sorted(set(c["resourceId"] for c in candidates)))
        if generation["mode"] == "vector":
            if not context.get("embed") or generation["model"] != context.get("embedding_model", "text-embedding-3-small"):
                fail("색인 임베딩 모델이 현재 설정과 달라요. 같은 모델로 조회하거나 새 버전을 준비해 주세요.")
            embedded = context["embed"]([query])
            if embedded["model"] != generation["model"]:
                fail("질문 임베딩 모델이 색인과 달라요.")
            validate_vectors(embedded["vectors"], 1)
            scores = [cosine(state["vectors"].get(c.get("vectorKey"), []), embedded["vectors"][0]) for c in candidates]
        else:
            terms = set(re.findall(r"[^\W]+", query.lower(), re.UNICODE))
            scores = [sum(term in c["excerpt"].lower() for term in terms) for c in candidates]
        matches = [{k: c[k] for k in ("resourceId", "version", "name", "url", "chunkIndex", "excerpt")} | {"score": score} for c, score in zip(candidates, scores) if generation["mode"] == "vector" or score > 0]
        return sorted(matches, key=lambda m: (-m["score"], m["resourceId"], m["chunkIndex"]))[:config.get("topK", 3)]

    action = config["action"]
    if action == "inspect":
        return output({"revision": state["revision"], "publishedGeneration": state["published"], "revoked": [i for i in state["revoked"] if i in allowed], "generations": [{"generation": g["id"], "mode": g["mode"], "model": g["model"], "chunkCount": len(chunks(g)), "evaluated": bool(g.get("evaluation", {}).get("passed") and g["evaluation"]["tombstoneRevision"] == state["tombstoneRevision"]), "publishedOnce": bool(g.get("publishedOnce"))} for g in state["generations"].values()]})
    if action == "query":
        generation = target()
        if state["published"] != generation["id"]:
            fail("현재 발행한 색인 버전만 조회할 수 있어요. 후보는 평가 후 발행해 주세요.")
        matches = search(generation, data_at(input_data, config.get("queryPath", "text")))
        return output({"generation": generation["id"], "revision": state["revision"], "published": state["published"] == generation["id"], "count": len(matches), "matches": matches})
    if action == "stage":
        if len(state["generations"]) >= 8:
            fail("색인 버전 8개 한도에 도달했어요. 새 색인 이름으로 보관을 분리해 주세요.")
        documents = get("documentsPath", [{"resourceId": r["id"], "version": r["updatedAt"], "content": r["content"]} for r in available.values() if r["id"] not in state["revoked"]])
        if not isinstance(documents, list) or not 1 <= len(documents) <= 20:
            fail("갱신 문서는 1~20개 필요해요.")
        changed, new_chunks = set(), []
        for doc in documents:
            if not isinstance(doc, dict) or set(doc) != {"resourceId", "version", "content"} or not isinstance(doc["resourceId"], str) or doc["resourceId"] not in allowed or doc["resourceId"] in changed or doc["resourceId"] in state["revoked"] or not isinstance(doc["version"], str) or not doc["version"].strip() or len(doc["version"]) > 100 or not isinstance(doc["content"], str) or not doc["content"].strip() or len(doc["content"].encode("utf-16-le")) // 2 > 40000:
                fail("갱신 문서의 허용 ID·버전·본문 또는 철회 상태를 확인해 주세요.")
            changed.add(doc["resourceId"])
            resource, size = available[doc["resourceId"]], config.get("chunkSize", 700)
            for index, start in enumerate(range(0, len(doc["content"]), size)):
                new_chunks.append({"resourceId": doc["resourceId"], "version": doc["version"], "name": resource.get("name", doc["resourceId"]), "url": resource.get("url", ""), "chunkIndex": index, "excerpt": doc["content"][start:start + size]})
        base = state["generations"].get(state["published"])
        candidates = sorted(([copy.deepcopy(c) for c in chunks(base) if c["resourceId"] not in changed] if base else []) + new_chunks, key=lambda c: (c["resourceId"], c["chunkIndex"]))
        if len(candidates) > 100:
            fail("지식 색인은 버전당 100개 조각까지 저장할 수 있어요.")
        mode = config.get("mode", "lexical")
        model = context.get("embedding_model", "text-embedding-3-small") if mode == "vector" else ""
        embedded_count = 0
        if mode == "vector":
            if not context.get("embed"):
                fail("지식 색인 임베딩 제공자가 미설정이에요.")
            missing = {}
            for chunk in candidates:
                chunk["vectorKey"] = digest({"resourceId": chunk["resourceId"], "model": model, "excerpt": chunk["excerpt"]})
                if chunk["vectorKey"] not in state["vectors"]:
                    missing[chunk["vectorKey"]] = chunk["excerpt"]
            if missing:
                embedded = context["embed"](list(missing.values()))
                if embedded["model"] != model:
                    fail("문서 임베딩 모델이 현재 설정과 달라요.")
                validate_vectors(embedded["vectors"], len(missing))
                state["vectors"].update(dict(zip(missing, embedded["vectors"])))
                embedded_count = len(missing)
        else:
            for chunk in candidates:
                chunk.pop("vectorKey", None)
        state["sequence"] += 1
        ident = "g" + str(state["sequence"])
        signature = digest({"chunks": candidates, "model": model, "mode": mode})
        state["generations"][ident] = {"id": ident, "chunks": candidates, "model": model, "mode": mode, "signature": signature}
        return persist({"generation": ident, "status": "staged", "chunkCount": len(candidates), "embeddedChunks": embedded_count, "reusedChunks": len(candidates) - embedded_count if mode == "vector" else 0, "signature": signature})
    if action == "evaluate":
        generation = target()
        checks = [{**s, "passed": any(m["resourceId"] == s["resourceId"] for m in search(generation, s["query"]))} for s in config["evaluation"]]
        passed = all(c["passed"] for c in checks)
        generation["evaluation"] = {"passed": passed, "checks": checks, "tombstoneRevision": state["tombstoneRevision"]}
        return persist({"generation": generation["id"], "passed": passed, "checks": checks})
    if action in ("publish", "rollback"):
        generation = target()
        evaluation = generation.get("evaluation", {})
        if not evaluation.get("passed") or evaluation.get("tombstoneRevision") != state["tombstoneRevision"] or (action == "rollback" and not generation.get("publishedOnce")):
            fail("같은 철회 상태에서 검색 평가를 통과한 버전만 발행·복구할 수 있어요.")
        access(sorted(set(c["resourceId"] for c in chunks(generation))))
        state["published"] = generation["id"]
        generation["publishedOnce"] = True
        return persist({"generation": generation["id"], "status": "rolled_back" if action == "rollback" else "published"})
    ids = get("resourceIdsPath", config["resourceIds"])
    if not isinstance(ids, list) or not ids or any(not isinstance(i, str) or i not in allowed for i in ids):
        fail("철회할 자료 ID는 허용 자료에서 선택해 주세요.")
    state["revoked"] = sorted(set(state["revoked"] + ids))
    state["tombstoneRevision"] += 1
    for generation in state["generations"].values():
        generation["chunks"] = [c for c in generation["chunks"] if c["resourceId"] not in state["revoked"]]
        generation.pop("evaluation", None)
        generation["signature"] = digest({k: generation[k] for k in ("chunks", "model", "mode")})
    referenced = {c["vectorKey"] for g in state["generations"].values() for c in g["chunks"] if "vectorKey" in c}
    state["vectors"] = {key: value for key, value in state["vectors"].items() if key in referenced}
    return persist({"status": "revoked", "revoked": ids, "tombstoneRevision": state["tombstoneRevision"]})
