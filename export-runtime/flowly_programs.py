# Node runtime/programs.ts의 고정 계산/검증 계약. 네트워크/파일/eval 없이 JSON으로 동작한다.
"""Finite, pure Flowly calculation/validation programs. No external I/O or eval."""
import copy
import json
import math
import re

PROGRAM_NAMES = ("numeric_summary", "schema_check", "schema_patch", "evidence_check", "goal_check", "rank_fusion")
FORBIDDEN = {"__proto__", "prototype", "constructor"}


def _fail(message):
    raise ValueError(message)


# 길이 한도는 JavaScript UTF-16 기준이다. Python len의 코드 포인트 개수와 구분한다.
def _length(value):
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


def _sort(value):
    return value.encode("utf-16-be", errors="surrogatepass")


def _object(value):
    if not isinstance(value, dict):
        _fail("프로그램 입력은 JSON 객체여야 해요.")
    return value


def _keys(value, allowed, required=None):
    if any(key not in allowed for key in value) or any(key not in value for key in (allowed if required is None else required)):
        _fail("프로그램의 필수 입력과 허용 필드를 확인해 주세요.")


def _list(value, minimum=1, maximum=100):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        _fail(f"프로그램 목록은 {minimum}~{maximum}개로 입력해 주세요.")
    return value


def _text(value, maximum=2000):
    if not isinstance(value, str) or not value.strip() or _length(value) > maximum:
        _fail("프로그램의 글자 입력을 확인해 주세요.")
    return value


def _finite(value):
    try:
        valid = type(value) in (int, float) and math.isfinite(value)
    except (ValueError, OverflowError):
        valid = False
    if not valid:
        _fail("프로그램은 유한한 숫자만 계산할 수 있어요.")
    return value


def _integer(value, minimum, maximum):
    number = _finite(value)
    if number != math.floor(number) or not minimum <= number <= maximum:
        _fail(f"프로그램 정수는 {minimum}~{maximum} 범위여야 해요.")
    return int(number)


# 키 정렬과 정수 표현을 Node에 맞춘다. 정규 문자열은 결과 비교와 중복 판별에 사용한다.
def _canonical(value):
    def normalize(item):
        if type(item) is float and item.is_integer() and abs(item) < 1e21:
            return int(item)
        if isinstance(item, list):
            return [normalize(child) for child in item]
        if isinstance(item, dict):
            return {key: normalize(item[key]) for key in sorted(item, key=_sort)}
        return item
    encoded = json.dumps(normalize(value), ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if len(encoded.encode("utf-8")) > 200000:
        _fail("한 번의 입출력은 200KB를 넘을 수 없어요.")
    return encoded


def _bounded(value):
    count = 0
    def visit(item, depth):
        nonlocal count
        count += 1
        if count > 10000 or depth > 16:
            _fail("프로그램 데이터는 10,000개 값과 16단계 중첩까지 처리할 수 있어요.")
        if item is None or isinstance(item, (str, bool)):
            return
        if type(item) in (int, float):
            _finite(item)
        elif isinstance(item, list):
            for child in item:
                visit(child, depth + 1)
        elif isinstance(item, dict) and all(isinstance(key, str) and key not in FORBIDDEN for key in item):
            for child in item.values():
                visit(child, depth + 1)
        else:
            _fail("허용되지 않은 JSON 값 또는 필드가 있어요.")
    visit(value, 0)
    _canonical(value)
    return copy.deepcopy(value)


def _field(value):
    return isinstance(value, str) and value not in FORBIDDEN and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,79}", value) is not None


def _path(value):
    return isinstance(value, str) and _length(value) <= 500 and all(_field(part) or index > 0 and re.fullmatch(r"0|[1-9][0-9]{0,5}", part) is not None for index, part in enumerate(value.split(".")))


def _read(data, path):
    if not _path(path):
        _fail("값 경로 형식을 확인해 주세요.")
    value = data
    for key in path.split("."):
        if isinstance(value, list) and re.fullmatch(r"0|[1-9][0-9]*", key) and int(key) < len(value):
            value = value[int(key)]
        elif isinstance(value, dict) and key in value:
            value = value[key]
        else:
            _fail(f"입력에서 {path} 값을 찾지 못했어요.")
    return value


def _schema(value, depth=0):
    rule = _object(value)
    _keys(rule, ["type", "properties", "required", "items", "additionalProperties"], ["type"])
    if depth > 8 or rule["type"] not in ("object", "array", "string", "number", "boolean"):
        _fail("입출력 형식을 확인해 주세요.")
    if "properties" in rule:
        props = _object(rule["properties"])
        if rule["type"] != "object" or len(props) > 40 or any(not _field(key) for key in props):
            _fail("객체 필드 형식을 확인해 주세요.")
        for child in props.values():
            _schema(child, depth + 1)
    if "required" in rule:
        required = _list(rule["required"], 0, 40)
        if rule["type"] != "object" or any(not _field(key) for key in required):
            _fail("필수 필드를 확인해 주세요.")
    if "items" in rule:
        if rule["type"] != "array":
            _fail("배열 형식에서만 항목을 지정할 수 있어요.")
        _schema(rule["items"], depth + 1)
    if "additionalProperties" in rule and (rule["type"] != "object" or type(rule["additionalProperties"]) is not bool):
        _fail("추가 필드 허용 여부를 확인해 주세요.")
    return rule


def _schema_errors(value, schema):
    errors = []
    def issue(path, expected, message):
        if len(errors) >= 200:
            _fail("검증 오류가 200개를 넘어요. 입력을 나누어 주세요.")
        errors.append({"path": path, "expected": expected, "message": message})
    def check(item, rule, path):
        kind = rule["type"]
        matches = {"array": isinstance(item, list), "object": isinstance(item, dict), "string": isinstance(item, str), "boolean": type(item) is bool, "number": type(item) in (int, float)}[kind]
        if not matches:
            issue(path, kind, "형식이 맞지 않아요.")
            return
        if kind == "object":
            for key in sorted(set(rule.get("required", [])), key=_sort):
                if key not in item:
                    issue(f"{path}.{key}" if path else key, rule.get("properties", {}).get(key, {}).get("type", "required"), "필수 값이 없어요.")
            for key in sorted(item, key=_sort):
                child = f"{path}.{key}" if path else key
                if key in rule.get("properties", {}):
                    check(item[key], rule["properties"][key], child)
                elif rule.get("additionalProperties") is False:
                    issue(child, "absent", "허용되지 않은 필드예요.")
        if kind == "array" and "items" in rule:
            for index, child in enumerate(item):
                check(child, rule["items"], f"{path}.{index}" if path else str(index))
    check(value, schema, "")
    return errors


def _numeric(args):
    _keys(args, ["values", "units"], ["values"])
    values = [_finite(value) for value in _list(args["values"], 1, 1000)]
    unit = None
    if "units" in args:
        units = [_text(value, 80) for value in _list(args["units"], len(values), len(values))]
        if len(set(units)) != 1:
            _fail("서로 다른 단위를 합산할 수 없어요.")
        unit = units[0]
    # Match JavaScript's sequential IEEE-754 addition, including overflow handling.
    total = 0.0
    for value in values:
        total += float(value)
    total = _finite(total)
    result = {"count": len(values), "sum": total, "min": min(values), "max": max(values), "mean": _finite(total / len(values))}
    if unit is not None:
        result["unit"] = unit
    return result


# schema_patch는 현재 오류가 있는 필드만 수정한다. 전체 자료를 교체하는 임의 패치가 아니다.
def _check(args, patch=False):
    _keys(args, ["data", "schema", "patches"] if patch else ["data", "schema"])
    schema, data = _schema(args["schema"]), _bounded(args["data"])
    before = _schema_errors(data, schema)
    if not patch:
        return {"valid": not before, "errors": before}
    invalid = {error["path"] for error in before}
    applied = []
    for value in _list(args["patches"], 0, 40):
        change = _object(value)
        _keys(change, ["path", "value"])
        path = _text(change["path"], 500)
        if path not in invalid or path in applied:
            _fail("현재 오류가 있는 필드만 한 번씩 수정할 수 있어요.")
        parts, parent = path.split("."), data
        if any(part in FORBIDDEN for part in parts):
            _fail("허용되지 않은 수정 경로예요.")
        for part in parts[:-1]:
            if isinstance(parent, list) and re.fullmatch(r"0|[1-9][0-9]*", part) and int(part) < len(parent):
                parent = parent[int(part)]
            elif isinstance(parent, dict) and part in parent:
                parent = parent[part]
            else:
                _fail("수정할 필드의 상위 값이 없어요.")
        last = parts[-1]
        if isinstance(parent, list):
            if not re.fullmatch(r"0|[1-9][0-9]*", last) or int(last) >= len(parent):
                _fail("수정할 배열 항목이 없어요.")
            parent[int(last)] = _bounded(change["value"])
        elif isinstance(parent, dict):
            parent[last] = _bounded(change["value"])
        else:
            _fail("수정할 필드의 상위 값이 없어요.")
        applied.append(path)
    errors = _schema_errors(data, schema)
    return {"data": data, "valid": not errors, "errors": errors, "appliedPaths": applied}


def _evidence(args):
    _keys(args, ["claims", "sources"])
    sources = []
    for value in _list(args["sources"], 0, 100):
        source = _object(value)
        _keys(source, ["resourceId", "version", "excerpt", "chunkIndex", "name", "url", "score"], ["resourceId", "version", "excerpt"])
        sources.append({"resourceId": _text(source["resourceId"], 100), "version": _text(source["version"], 200), "excerpt": _text(source["excerpt"], 20000)})
    checks = []
    for index, value in enumerate(_list(args["claims"], 1, 100)):
        claim = _object(value)
        _keys(claim, ["sourceId", "version", "quote"])
        source_id, version, quote = _text(claim["sourceId"], 100), _text(claim["version"], 200), claim["quote"]
        if not isinstance(quote, str) or _length(quote) > 20000:
            _fail("인용문은 20,000자 이하의 글이어야 해요.")
        matches = [source for source in sources if source["resourceId"] == source_id and source["version"] == version]
        passed = bool(quote.strip()) and any(quote in source["excerpt"] for source in matches)
        checks.append({"index": index, "sourceId": source_id, "version": version, "passed": passed, "reason": "source_and_quote_match" if passed else "empty_quote" if not quote.strip() else "source_version_missing" if not matches else "quote_missing"})
    return {"passed": all(check["passed"] for check in checks), "checks": checks}


def _goals(args):
    _keys(args, ["data", "checks"])
    checks = []
    primitive = lambda value: value is None or type(value) in (str, bool, int, float)
    for index, value in enumerate(_list(args["checks"], 1, 40)):
        rule = _object(value)
        _keys(rule, ["path", "operator", "value", "rightPath"], ["path", "operator"])
        if not _path(rule["path"]) or rule["operator"] not in ("eq", "ne", "gt", "gte", "lt", "lte", "contains") or ("value" in rule) == ("rightPath" in rule) or "value" in rule and not primitive(rule["value"]) or "rightPath" in rule and not _path(rule["rightPath"]):
            _fail("비교 경로·연산자와 비교 대상 하나를 지정해 주세요.")
        passed, reason = False, "condition_false"
        try:
            left = _read(args["data"], rule["path"])
            right = _read(args["data"], rule["rightPath"]) if "rightPath" in rule else rule["value"]
            if not primitive(left) or not primitive(right):
                raise ValueError("incompatible")
            operator = rule["operator"]
            if operator in ("eq", "ne"):
                equal = left == right and (type(left) is type(right) or type(left) in (int, float) and type(right) in (int, float))
                passed = equal if operator == "eq" else not equal
            elif operator == "contains":
                if not isinstance(left, str) or not isinstance(right, str):
                    raise ValueError("incompatible")
                passed = right in left
            else:
                if type(left) not in (int, float) or type(right) not in (int, float):
                    raise ValueError("incompatible")
                passed = left > right if operator == "gt" else left >= right if operator == "gte" else left < right if operator == "lt" else left <= right
            if passed:
                reason = "condition_true"
        except ValueError:
            reason = "missing_or_incompatible_value"
        checks.append({"index": index, "path": rule["path"], "passed": passed, "reason": reason})
    return {"passed": all(check["passed"] for check in checks), "checks": checks}


def _fusion(args):
    _keys(args, ["lists", "topK", "rankConstant"], ["lists", "topK"])
    top_k = _integer(args["topK"], 1, 10)
    constant = _finite(args.get("rankConstant", 60))
    if not 0 < constant <= 1000:
        _fail("순위 상수는 0 초과 1,000 이하여야 해요.")
    input_lists = args["lists"]
    if not isinstance(input_lists, list):
        input_lists = [input_lists[key] for key in sorted(_object(input_lists), key=_sort)]
    matches = {}
    for values in _list(input_lists, 1, 4):
        seen = set()
        for index, value in enumerate(_list(values, 0, 100)):
            raw = _object(value)
            _keys(raw, ["resourceId", "version", "chunkIndex", "excerpt", "name", "url", "score"], ["resourceId", "version", "chunkIndex", "excerpt"])
            resource_id, version = _text(raw["resourceId"], 100), _text(raw["version"], 200)
            chunk_index, excerpt = _integer(raw["chunkIndex"], 0, 1000000), _text(raw["excerpt"], 20000)
            if any(key in raw and not isinstance(raw[key], str) for key in ("name", "url")):
                _fail("검색 결과의 이름·주소·점수 형식을 확인해 주세요.")
            if "score" in raw:
                _finite(raw["score"])
            key = _canonical([resource_id, version, chunk_index])
            existing = matches.get(key)
            if existing is not None and existing["excerpt"] != excerpt:
                _fail("같은 문서 버전과 조각의 내용이 서로 달라요.")
            if key in seen:
                continue
            seen.add(key)
            if existing is not None:
                existing["score"] += 1 / (constant + index + 1)
            else:
                matches[key] = {"resourceId": resource_id, "version": version, "chunkIndex": chunk_index, "excerpt": excerpt, **{key: raw[key] for key in ("name", "url") if key in raw}, "score": 1 / (constant + index + 1)}
    ranked = [value for key, value in sorted(matches.items(), key=lambda item: (-item[1]["score"], _sort(item[0])))[:top_k]]
    return {"matches": ranked, "count": len(ranked)}


# 고정 이름과 명시적 바인딩으로 인자를 준비한 뒤 등록 함수를 선택한다.
def execute_program(config, input_data):
    config = _object(config)
    _keys(config, ["name", "arguments", "bindings"], ["name"])
    if config["name"] not in PROGRAM_NAMES:
        _fail("등록된 계산·검증 프로그램을 선택해 주세요.")
    arguments, bindings = _object(config.get("arguments", {})), _object(config.get("bindings", {}))
    if len(arguments) > 40 or any(not _field(key) for key in arguments) or _length(_canonical(arguments)) > 20000:
        _fail("도구 입력은 40개 필드, 20,000자까지 가능해요.")
    if len(bindings) > 40 or any(not _field(key) or not _path(path) for key, path in bindings.items()):
        _fail("값 연결의 필드 이름과 경로를 확인해 주세요.")
    args = _bounded(arguments)
    for name, path in bindings.items():
        args[name] = _read(input_data, path)
    args = _bounded(args)
    name = config["name"]
    result = _numeric(args) if name == "numeric_summary" else _check(args, name == "schema_patch") if name in ("schema_check", "schema_patch") else _evidence(args) if name == "evidence_check" else _goals(args) if name == "goal_check" else _fusion(args)
    return {"text": _canonical(result), "data": result}
