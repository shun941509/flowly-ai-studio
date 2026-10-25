"""Allowlisted, bounded local tools for both exported runners.

No model downloads, remote service calls, shell commands, pickle, or arbitrary
Python imports from workflow arguments. Optional models live below ./models and
are selected by the operator in FLOWLY_TOOL_MODELS (a JSON object of relative
model paths). Tool results describe public computations, never hidden reasoning.
"""
from __future__ import annotations

import collections
import hashlib
import importlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import sys
from functools import lru_cache

MAX_BYTES = 1_000_000
MAX_ITEMS = 2000

# Bounded worker execution should not spawn a CPU-sized BLAS/OpenMP pool.
for _variable in ("OMP_NUM_THREADS","OPENBLAS_NUM_THREADS","MKL_NUM_THREADS","LOKY_MAX_CPU_COUNT"):
    os.environ[_variable]="1"


class ToolError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def fail(message, code="invalid_input"):
    raise ToolError(code, message)


def dependency(module, package=None):
    try:
        return importlib.import_module(module)
    except ImportError:
        fail(f"필요한 Python 패키지가 없어요: {package or module}. requirements-tools.txt를 확인해 주세요.", "missing_dependency")


def bounded(value):
    count = 0
    def visit(item, depth):
        nonlocal count
        count += 1
        if count > 100_000 or depth > 20:
            fail("입력 중첩 또는 항목 한도를 초과했어요.")
        if isinstance(item, dict):
            if any(not isinstance(k, str) or k in {"__proto__", "constructor", "prototype"} for k in item):
                fail("허용되지 않은 JSON 키예요.")
            for child in item.values(): visit(child, depth + 1)
        elif isinstance(item, list):
            for child in item: visit(child, depth + 1)
        elif isinstance(item, float) and not math.isfinite(item):
            fail("NaN 또는 무한대는 입력할 수 없어요.")
        elif item is not None and not isinstance(item, (str, int, float, bool)):
            fail("JSON 값만 입력할 수 있어요.")
    visit(value, 0)
    try:
        if len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")) > MAX_BYTES:
            fail("도구 입출력은 1MB 이하여야 해요.")
    except (ValueError, OverflowError):
        fail("JSON으로 표현할 수 없는 값이에요.")
    return value


def array(value, minimum=1, maximum=MAX_ITEMS):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        fail(f"목록은 {minimum}~{maximum}개여야 해요.")
    return value


def number(value):
    if type(value) not in (int, float) or not math.isfinite(value): fail("유한한 숫자가 필요해요.")
    return value


def integer(value, minimum, maximum):
    number(value)
    if value != int(value) or not minimum <= value <= maximum: fail(f"정수는 {minimum}~{maximum} 범위여야 해요.")
    return int(value)


def text(value, maximum=200_000, empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value.strip()):
        fail("문자열 입력과 길이를 확인해 주세요.")
    return value


def matrix(value):
    rows = array(value, maximum=1000)
    width = len(array(rows[0], maximum=128))
    if len(rows) * width > 32_000: fail("행렬은 32,000개 셀 이하여야 해요.")
    for row in rows:
        if len(array(row, maximum=128)) != width: fail("행렬의 열 수가 일치해야 해요.")
        for item in row: number(item)
    return rows


def model_path(tool_id):
    try: settings = json.loads(os.environ.get("FLOWLY_TOOL_MODELS", "{}"))
    except ValueError: fail("FLOWLY_TOOL_MODELS는 JSON 객체여야 해요.", "missing_configuration")
    if not isinstance(settings, dict): fail("FLOWLY_TOOL_MODELS는 JSON 객체여야 해요.", "missing_configuration")
    relative = settings.get(tool_id)
    if not isinstance(relative, str) or not relative:
        fail(f"{tool_id}의 로컬 모델을 FLOWLY_TOOL_MODELS에 설정해 주세요.", "missing_model")
    raw_root=Path.cwd()/"models"
    if raw_root.exists() and (raw_root.is_symlink() or bool(getattr(raw_root.lstat(),"st_file_attributes",0)&0x400)):
        fail("models 폴더는 링크·정션일 수 없어요.","missing_configuration")
    root = raw_root.resolve()
    raw = Path(relative)
    if raw.is_absolute() or ".." in raw.parts or ":" in relative:
        fail("모델 경로는 models 폴더 내부의 상대 경로여야 해요.", "missing_configuration")
    candidate = root / raw
    for parent in (candidate, *candidate.parents):
        if parent.exists() and (parent.is_symlink() or bool(getattr(parent.lstat(), "st_file_attributes", 0) & 0x400)):
            fail("모델 경로에 링크·정션은 사용할 수 없어요.", "missing_configuration")
        if parent == root: break
    resolved = candidate.resolve()
    if not resolved.is_relative_to(root): fail("모델 경로가 허용 범위를 벗어났어요.", "missing_configuration")
    if not resolved.exists(): fail(f"{tool_id}의 로컬 모델 파일이 없어요.", "missing_model")
    return resolved


def tokens(value):
    return re.findall(r"[\w]+", value.lower(), re.UNICODE)


def documents(args):
    docs = array(args.get("documents"), maximum=1000)
    result = []
    seen = set()
    for index, item in enumerate(docs):
        if isinstance(item, str): item = {"id": str(index), "text": item}
        if not isinstance(item, dict): fail("문서는 문자열 또는 id/text 객체여야 해요.")
        key = text(item.get("id"), 200)
        if key in seen: fail("문서 ID는 중복될 수 없어요.")
        seen.add(key)
        result.append({"id": key, "text": text(item.get("text"), 50_000, True)})
    return result


def search(tool_id, args):
    if tool_id == "cosine_similarity":
        a, b = array(args.get("a"), maximum=4096), array(args.get("b"), maximum=4096)
        if len(a) != len(b): fail("벡터 차원이 일치해야 해요.")
        a, b = [number(x) for x in a], [number(x) for x in b]
        norm = math.sqrt(sum(x*x for x in a) * sum(x*x for x in b))
        return {"score": sum(x*y for x, y in zip(a,b)) / norm if norm else 0.0, "zeroVector": norm == 0}
    if tool_id == "rrf":
        rankings = array(args.get("rankings"), maximum=20)
        k = integer(args.get("k", 60), 1, 1000)
        scores = collections.defaultdict(float)
        for ranking in rankings:
            seen = set()
            for position, item in enumerate(array(ranking, 0, 1000), 1):
                key = text(item if isinstance(item, str) else item.get("id"), 200)
                if key not in seen: scores[key] += 1 / (k + position)
                seen.add(key)
        return {"results": [{"id": key, "score": score} for key,score in sorted(scores.items(), key=lambda x:(-x[1],x[0]))]}
    if tool_id == "query_expansion":
        query = text(args.get("query"), 2000)
        synonyms = args.get("synonyms", {})
        if not isinstance(synonyms, dict): fail("동의어 사전이 필요해요.")
        expanded = [query]
        for token in tokens(query):
            for synonym in array(synonyms.get(token, []), 0, 10):
                candidate = query + " " + text(synonym, 100)
                if candidate not in expanded: expanded.append(candidate)
        return {"queries": expanded[:50], "method": "explicit_synonym_dictionary"}
    if tool_id in {"bm25", "tfidf"}:
        docs = documents(args)
        query = tokens(text(args.get("query"), 2000))
        bags = [collections.Counter(tokens(doc["text"])) for doc in docs]
        dfs = collections.Counter(token for bag in bags for token in bag)
        avg = sum(sum(bag.values()) for bag in bags) / len(bags) or 1
        scored = []
        for doc, bag in zip(docs, bags):
            score = 0.0
            for token in query:
                freq = bag[token]
                if tool_id == "bm25":
                    idf = math.log(1 + (len(bags)-dfs[token]+0.5)/(dfs[token]+0.5))
                    score += idf * freq*2.5/(freq + 1.5*(0.25+0.75*sum(bag.values())/avg)) if freq else 0
                else:
                    score += freq * (math.log((1+len(bags))/(1+dfs[token])) + 1)
            scored.append({"id": doc["id"], "score": score})
        return {"results": sorted(scored,key=lambda x:(-x["score"],x["id"]))[:integer(args.get("topK",10),1,1000)], "method": tool_id}
    if tool_id == "hybrid_search":
        return search("rrf", {"rankings": [args.get("lexicalResults"),args.get("vectorResults")], "k": args.get("k",60)})
    if tool_id == "semantic_search":
        query = array(args.get("queryVector"),maximum=4096)
        results=[]
        for item in array(args.get("vectors"),maximum=1000):
            if not isinstance(item,dict): fail("id/vector 객체가 필요해요.")
            results.append({"id":text(item.get("id"),200),**search("cosine_similarity",{"a":query,"b":item.get("vector")})})
        return {"results":sorted(results,key=lambda x:(-x["score"],x["id"]))[:integer(args.get("topK",10),1,1000)],"method":"exact_cosine"}
    fail("지원하지 않는 검색 도구예요.")


def basic(tool_id, args):
    if tool_id == "jsonl":
        source = text(args.get("text"), empty=True)
        lines = source.splitlines()
        if len(lines)>2000: fail("JSONL은 최대 2,000행이에요.")
        records=[]
        for index,line in enumerate(lines,1):
            if not line.strip(): continue
            try: records.append(json.loads(line,parse_constant=lambda _:fail("유한한 JSON 숫자가 필요해요.")))
            except json.JSONDecodeError: fail(f"JSONL {index}행의 JSON 형식이 잘못됐어요.")
        return {"records":records,"count":len(records)}
    if tool_id == "chunking":
        source=text(args.get("text"),empty=True)
        size=integer(args.get("size",700),1,10000)
        overlap=integer(args.get("overlap",0),0,size-1)
        chunks=[]
        for start in range(0,len(source),size-overlap):
            chunks.append({"id":str(len(chunks)),"start":start,"end":min(start+size,len(source)),"text":source[start:start+size]})
            if start+size>=len(source): break
        if len(chunks)>2000: fail("분할 결과가 2,000개를 초과했어요.")
        return {"chunks":chunks,"unit":"unicode_codepoint"}
    if tool_id in {"tokenizer","tokens"}:
        module=dependency("tokenizers")
        tokenizer=module.Tokenizer.from_file(str(model_path(tool_id)))
        encoded=tokenizer.encode(text(args.get("text"),empty=True))
        return {"count":len(encoded.ids),"ids":encoded.ids,"tokens":encoded.tokens,"offsets":[list(x) for x in encoded.offsets]}
    if tool_id == "json_schema":
        module=dependency("jsonschema")
        schema=args.get("schema")
        if not isinstance(schema,dict): fail("schema 객체가 필요해요.")
        def scan(item):
            if isinstance(item,dict):
                for key,value in item.items():
                    if key in {"$ref","$dynamicRef"} and (not isinstance(value,str) or not value.startswith("#")):
                        fail("외부 JSON Schema 참조는 허용하지 않아요.")
                    if key in {"pattern","patternProperties"}: fail("임의 정규식 스키마는 지원하지 않아요.")
                    scan(value)
            elif isinstance(item,list):
                for child in item: scan(child)
        scan(schema)
        module.Draft202012Validator.check_schema(schema)
        errors=sorted(module.Draft202012Validator(schema).iter_errors(args.get("value")),key=lambda e:str(list(e.path)))
        return {"valid":not errors,"errors":[{"path":list(e.path),"keyword":e.validator} for e in errors[:100]],"draft":"2020-12"}
    if tool_id == "data_quality":
        rows=array(args.get("rows"),0,2000)
        if any(not isinstance(row,dict) for row in rows): fail("자료 행은 JSON 객체여야 해요.")
        columns=sorted({key for row in rows for key in row})
        if len(columns)>128: fail("열 수는 128개 이하여야 해요.")
        encoded=[json.dumps(row,sort_keys=True,ensure_ascii=False) for row in rows]
        return {"rowCount":len(rows),"duplicateCount":len(rows)-len(set(encoded)),"columns":[{"name":col,"missing":sum(row.get(col) is None or row.get(col)=="" for row in rows),"types":dict(collections.Counter(type(row.get(col)).__name__ for row in rows if row.get(col) is not None))} for col in columns]}
    if tool_id == "classification_threshold":
        threshold=number(args.get("threshold",0.5))
        if not 0<=threshold<=1: fail("임계값은 0~1이어야 해요.")
        scores=[number(x) for x in array(args.get("scores"))]
        if any(not 0<=x<=1 for x in scores): fail("확률은 0~1이어야 해요.")
        return {"predictions":[int(x>=threshold) for x in scores],"threshold":threshold}
    if tool_id == "wer":
        a=text(args.get("reference"),20000,True).split(); b=text(args.get("hypothesis"),20000,True).split()
        if len(a)>2000 or len(b)>2000: fail("WER 입력은 각 2,000단어 이하여야 해요.")
        if not a: fail("WER 기준 문장은 비어 있을 수 없어요.")
        row=list(range(len(b)+1))
        for i,x in enumerate(a,1):
            nxt=[i]
            for j,y in enumerate(b,1): nxt.append(min(nxt[-1]+1,row[j]+1,row[j-1]+(x!=y)))
            row=nxt
        return {"distance":row[-1],"referenceWords":len(a),"wer":row[-1]/len(a)}
    if tool_id == "throughput":
        count=integer(args.get("count"),0,1_000_000_000); seconds=number(args.get("seconds"))
        if seconds<=0: fail("측정 시간은 0보다 커야 해요.")
        return {"itemsPerSecond":count/seconds,"count":count,"seconds":seconds}
    if tool_id in {"benchmark","evals"}:
        cases=array(args.get("cases"),maximum=1000)
        results=[]
        for case in cases:
            if not isinstance(case,dict) or "expected" not in case or "actual" not in case: fail("평가 항목에는 expected/actual이 필요해요.")
            mode=case.get("mode","exact")
            if mode=="exact": passed=case["expected"]==case["actual"]
            elif mode=="contains": passed=text(case["expected"],10000) in text(case["actual"],10000,True)
            elif mode=="numeric": passed=abs(number(case["expected"])-number(case["actual"]))<=abs(number(case.get("tolerance",1e-9)))
            else: fail("평가 방식은 exact/contains/numeric 중 하나예요.")
            results.append({"id":str(case.get("id",len(results))),"passed":passed})
        return {"results":results,"passed":sum(item["passed"] for item in results),"total":len(results)}
    if tool_id == "knowledge_graph":
        edges=array(args.get("edges"),0,2000)
        graph=collections.defaultdict(list)
        for edge in edges:
            if not isinstance(edge,dict): fail("관계는 from/to/source 객체여야 해요.")
            source=text(edge.get("from"),200); target=text(edge.get("to"),200)
            text(edge.get("source"),500)
            graph[source].append(edge)
        start=text(args.get("start"),200); depth=integer(args.get("depth",2),0,8)
        seen={start}; frontier=[start]; found=[]
        for _ in range(depth):
            nxt=[]
            for node in frontier:
                for edge in graph[node]:
                    found.append(edge)
                    if edge["to"] not in seen: seen.add(edge["to"]); nxt.append(edge["to"])
            frontier=nxt
        return {"nodes":sorted(seen),"edges":found,"method":"directed_breadth_first","extraction":"provided_relations"}
    if tool_id == "ssml":
        from xml.sax.saxutils import escape
        value=text(args.get("text"),10000)
        rate=integer(args.get("rate",100),50,200)
        return {"ssml":f'<speak><prosody rate="{rate}%">{escape(value)}</prosody></speak>'}
    fail("지원하지 않는 기본 도구예요.")


PATTERNS = {
    "email": r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z0-9])",
    "phone": r"(?<!\d)(?:\+82[- ]?)?0?1[016789][- ]?\d{3,4}[- ]?\d{4}(?!\d)",
    "resident_id": r"(?<!\d)\d{6}[- ]?[1-4]\d{6}(?!\d)",
    "secret": r"\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~-]{12,})\b",
}


def privacy(tool_id,args):
    if tool_id=="ai_citation":
        docs={d["id"]:d["text"] for d in documents(args)}
        results=[]
        for citation in array(args.get("citations"),0,1000):
            if not isinstance(citation,dict): fail("인용 객체가 필요해요.")
            doc_id=text(citation.get("id"),200); quote=text(citation.get("quote"),10000)
            results.append({"id":doc_id,"valid":doc_id in docs and quote in docs[doc_id]})
        return {"valid":all(x["valid"] for x in results),"citations":results,"checks":"exact_source_and_quote_only"}
    if tool_id in {"pii","redaction","anonymization","data_classification"}:
        source=text(args.get("text"),empty=True); findings=[]
        for category,pattern in PATTERNS.items():
            for match in re.finditer(pattern,source): findings.append({"category":category,"start":match.start(),"end":match.end()})
        findings.sort(key=lambda item:(item["start"],item["end"]))
        result={"findings":findings,"sensitive":bool(findings),"method":"bounded_pattern_detection","completeDetection":False}
        if tool_id=="data_classification": result["classification"]="restricted" if any(x["category"] in {"resident_id","secret"} for x in findings) else "personal" if findings else "unclassified"
        elif tool_id!="pii":
            redacted=source
            for finding in reversed(findings): redacted=redacted[:finding["start"]]+"["+finding["category"]+"]"+redacted[finding["end"]:]
            result["text"]=redacted
            result["anonymityGuaranteed"]=False
        return result
    if tool_id=="moderation":
        source=text(args.get("text"),empty=True)
        phrases=array(args.get("blockedPhrases"),1,1000)
        matches=[index for index,phrase in enumerate(phrases) if text(phrase,200).casefold() in source.casefold()]
        return {"blocked":bool(matches),"ruleIndexes":matches,"method":"configured_phrase_rules","completeDetection":False}
    if tool_id=="differential_privacy":
        # A single bounded scalar query. No untracked composition/privacy ledger.
        import secrets
        epsilon=number(args.get("epsilon")); sensitivity=number(args.get("sensitivity")); value=number(args.get("value"))
        if not 0<epsilon<=10 or not 0<sensitivity<=1_000_000: fail("epsilon(0,10], 민감도(0,1000000]를 명시해 주세요.")
        if args.get("singleQueryAcknowledged") is not True: fail("단일 질의의 민감도·예산 검토 후 singleQueryAcknowledged=true를 지정해 주세요.","missing_configuration")
        u=(secrets.randbelow(2**53)+0.5)/2**53-0.5
        noise=-(sensitivity/epsilon)*math.copysign(1,u)*math.log1p(-2*abs(u))
        return {"value":value+noise,"epsilonSpent":epsilon,"mechanism":"laplace_scalar","compositionManaged":False}
    fail("지원하지 않는 개인정보 도구예요.")


# Canonical IDs only; aliases are added below for terminology compatibility.
BASIC=set("jsonl chunking tokenizer tokens json_schema data_quality classification_threshold wer throughput benchmark evals knowledge_graph ssml".split())
SEARCH=set("bm25 tfidf cosine_similarity rrf query_expansion hybrid_search semantic_search".split())
PRIVACY=set("pii redaction anonymization data_classification moderation ai_citation differential_privacy".split())


def registry():
    from toolpacks_scientific import SCIENTIFIC
    from toolpacks_media import MEDIA
    return BASIC | SEARCH | PRIVACY | set(SCIENTIFIC) | set(MEDIA)


@lru_cache(maxsize=1)
def tool_contracts():
    path=Path(__file__).with_name("tool-contracts.json")
    try:
        contents=json.loads(path.read_text(encoding="utf-8-sig"))
        if contents.get("version")!=1 or not isinstance(contents.get("tools"),dict):raise ValueError()
        return contents["tools"]
    except (OSError,ValueError,AttributeError):fail("내보낸 tool-contracts.json 파일이 없거나 올바르지 않아요.","missing_configuration")


def describe_tools():
    from toolpacks_scientific import SCIENTIFIC
    from toolpacks_media import MEDIA
    result=[]
    contracts=tool_contracts()
    for tool_id in sorted(registry() & set(contracts)):
        requirements = SCIENTIFIC.get(tool_id, MEDIA.get(tool_id, []))
        if tool_id=="json_schema": requirements=["jsonschema"]
        if tool_id in {"tokenizer","tokens"}: requirements=["tokenizers"]
        scopes={
            "ann":"exact_nearest_neighbors_baseline","object_detection":"threshold_components_without_semantic_classes",
            "image_segmentation":"otsu_binary_segmentation","object_tracking":"single_template_matching",
            "computer_vision":"image_statistics","speaker_diarization":"acoustic_clustering_without_verified_identity",
            "rpa":"isolated_supplied_html_without_network","computer_use":"isolated_supplied_html_without_network",
            "content_credentials":"flowly_hmac_manifest_not_c2pa","watermark":"flowly_hmac_mark_not_ai_authorship_detection",
            "ai_citation":"exact_source_and_quote_only","knowledge_graph":"provided_relations_traversal",
            "causal_inference":"randomized_difference_in_means","time_series_forecast":"linear_trend_baseline",
            "moderation":"configured_phrase_rules","differential_privacy":"single_scalar_laplace_without_composition_ledger",
            "anonymization":"pattern_redaction_without_anonymity_guarantee","xai":"heldout_permutation_importance",
            "model_drift":"provided_value_distribution_ks_test","vad":"energy_threshold_not_semantic_speech_detection",
        }
        result.append({"id":tool_id,"effect":"read","implementation":"python","dependencies":requirements,"inputSchema":contracts[tool_id]["inputSchema"],"exampleArguments":contracts[tool_id]["exampleArguments"],"usage":contracts[tool_id]["usage"],"modelRequired":tool_id in MODEL_TOOLS,"bounded":True,"scope":scopes.get(tool_id,"registered_local_algorithm")})
    return result


MODEL_TOOLS=set("tokenizer tokens embedding reranking ner sentiment pose_estimation stt tts multimodal".split())


def check_tools(ids):
    ids=array(ids,0,195)
    descriptions={item["id"]:item for item in describe_tools()}
    tools=[]; missing=[]
    for tool_id in ids:
        if tool_id not in descriptions: fail(f"등록되지 않은 도구예요: {str(tool_id)[:100]}","unknown_tool")
        item={**descriptions[tool_id],"status":"ready","missing":[]}
        for module in item["dependencies"]:
            try: found=importlib.util.find_spec(module) is not None
            except (ImportError,ValueError): found=False
            if not found: item["missing"].append({"code":"missing_dependency","name":module})
        if item["modelRequired"]:
            try: model_path(tool_id)
            except ToolError as exc: item["missing"].append({"code":exc.code,"message":str(exc)})
        if tool_id in {"watermark","content_credentials"}:
            variable="FLOWLY_WATERMARK_KEY" if tool_id=="watermark" else "FLOWLY_CONTENT_CREDENTIALS_KEY"
            if not os.environ.get(variable): item["missing"].append({"code":"missing_configuration","message":f"{variable}를 설정해 주세요."})
        if tool_id in {"rpa","computer_use"} and not item["missing"]:
            try:
                from playwright.sync_api import sync_playwright
                with sync_playwright() as manager:
                    if not Path(manager.chromium.executable_path).is_file(): item["missing"].append({"code":"missing_configuration","message":"Playwright Chromium이 필요해요."})
            except Exception: item["missing"].append({"code":"missing_configuration","message":"Playwright Chromium 상태를 확인할 수 없어요."})
        if tool_id=="ocr" and not item["missing"]:
            import shutil
            if not shutil.which("tesseract"): item["missing"].append({"code":"missing_configuration","message":"로컬 Tesseract 엔진이 필요해요."})
        if item["missing"]:
            item["status"]="unconfigured"
            missing.extend({"toolId":tool_id,**reason} for reason in item["missing"])
        tools.append(item)
    return {"status":"unconfigured" if missing else "ready","tools":tools,"missing":missing,"networkProbed":False}


def execute_tool(tool_id,arguments):
    if not isinstance(tool_id,str) or tool_id not in registry(): fail("등록되지 않은 Python 도구예요.","unknown_tool")
    if not isinstance(arguments,dict): fail("도구 인자는 JSON 객체여야 해요.")
    bounded(arguments)
    contract=tool_contracts().get(tool_id)
    if not isinstance(contract,dict):fail("이 내보내기에 포함되지 않은 도구예요.","unknown_tool")
    schema=contract["inputSchema"]
    if any(key not in schema["properties"] for key in arguments):fail("도구 계약에 없는 인자예요.")
    if any(key not in arguments for key in schema.get("required",[])):fail("도구의 필수 인자가 누락됐어요.")
    try:
        if tool_id in BASIC: result=basic(tool_id,arguments)
        elif tool_id in SEARCH: result=search(tool_id,arguments)
        elif tool_id in PRIVACY: result=privacy(tool_id,arguments)
        else:
            from toolpacks_scientific import SCIENTIFIC, execute_scientific
            from toolpacks_media import execute_media
            result=execute_scientific(tool_id,arguments) if tool_id in SCIENTIFIC else execute_media(tool_id,arguments)
        return bounded(result)
    except ToolError: raise
    except (ValueError,TypeError,KeyError,IndexError,OverflowError,ZeroDivisionError):
        fail("도구 입력·모수·자료의 형태 또는 수치 조건을 확인해 주세요.")
    except Exception:
        fail("로컬 도구 실행에 실패했어요. 패키지·모델 호환성과 입력을 확인해 주세요.","execution_failed")


def main():
    try:
        raw=sys.stdin.buffer.read(MAX_BYTES+1)
        if len(raw)>MAX_BYTES: fail("입력은 1MB 이하여야 해요.")
        request=json.loads(raw.decode("utf-8-sig"))
        if not isinstance(request,dict): fail("요청 객체가 필요해요.")
        if request.get("operation")=="describe": result=describe_tools()
        elif request.get("operation")=="check": result=check_tools(request.get("toolIds",[]))
        else: result=execute_tool(request.get("toolId"),request.get("arguments"))
        response={"ok":True,"result":result}
    except ToolError as exc: response={"ok":False,"error":{"code":exc.code,"message":str(exc)}}
    except Exception: response={"ok":False,"error":{"code":"invalid_input","message":"올바른 JSON 도구 요청이 필요해요."}}
    sys.stdout.buffer.write((json.dumps(response,ensure_ascii=False,allow_nan=False)+"\n").encode("utf-8"))


if __name__=="__main__":
    # Helpers import this name even when started as a script; share the exception class.
    sys.modules.setdefault("flowly_tools",sys.modules[__name__])
    main()
