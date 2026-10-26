# 선택 업무 프로그램을 고정 모듈에서 실행하는 worker. manifest에 포함한 작업만 허용하며 사용자 코드 경로를 받지 않는다.
"""Fixed packaged business algorithms. No user code, dynamic paths or providers."""
import importlib
import importlib.metadata
import json
import math
import sys
import re
from pathlib import Path

MAX_BYTES = 2_000_000
MODULES = ("completion_research", "completion_programs", "completion_operations")

# 고정 세 모듈의 OPERATIONS/CONTRACTS를 합친다. 중복 작업 ID는 덮어쓰지 않고 오류로 처리한다.
def registry():
    operations, contracts = {}, {}
    for name in MODULES:
        module = importlib.import_module(name)
        for key, function in module.OPERATIONS.items():
            if key in operations or not callable(function):
                raise ValueError("Duplicate or invalid registered operation")
            operations[key] = function
        contracts.update(module.CONTRACTS)
    return operations, contracts

def bounded(value):
    count = [0]
    def visit(item, depth=0):
        count[0] += 1
        if depth > 24 or count[0] > 50000:
            raise ValueError("업무 입력·출력의 크기 또는 중첩 한도를 넘었어요.")
        if isinstance(item, float) and not math.isfinite(item):
            raise ValueError("유한한 숫자만 입력할 수 있어요.")
        if isinstance(item, int) and not isinstance(item, bool) and abs(item) > 9007199254740991:
            raise ValueError("안전한 정수 범위를 넘었어요.")
        if isinstance(item, dict):
            if any(not isinstance(key, str) or key in ("__proto__", "constructor", "prototype") for key in item):
                raise ValueError("허용되지 않은 객체 필드예요.")
            for child in item.values(): visit(child, depth + 1)
        elif isinstance(item, list):
            for child in item: visit(child, depth + 1)
        elif item is not None and not isinstance(item, (str, int, float, bool)):
            raise ValueError("JSON 값만 사용할 수 있어요.")
    visit(value)
    encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    if len(encoded.encode("utf8")) > MAX_BYTES:
        raise ValueError("업무 입력·출력은 2MB까지 처리할 수 있어요.")
    return value


# 작업별 의존성 버전과 필요한 로컬 Chrome을 확인한다. 사내 서비스 연동 성공을 의미하지 않는다.
def readiness(names, operations, contracts, allowed):
    missing = []
    for name in names:
        if name not in allowed or name not in operations:
            missing.append({"operation": name, "reason": "unregistered"})
            continue
        for dependency in contracts[name].get("dependencies", []):
            match = re.fullmatch(r"([A-Za-z0-9_.-]+)(?:==([A-Za-z0-9_.-]+))?", dependency)
            if not match:
                missing.append({"operation": name, "dependency": dependency, "reason": "invalid_packaged_contract"})
                continue
            try:
                installed = importlib.metadata.version(match[1])
                if match[2] and installed != match[2]:
                    missing.append({"operation": name, "dependency": dependency, "reason": "version_mismatch"})
            except importlib.metadata.PackageNotFoundError:
                missing.append({"operation": name, "dependency": dependency, "reason": "missing_dependency"})
        if name == "operations.ui_interaction":
            from completion_operations import installed_chrome_path
            if not installed_chrome_path():
                missing.append({"operation": name, "configuration": "installed Chrome browser", "reason": "missing_configuration"})
    return missing

# 허용 목록/의존성을 통과한 JSON만 실행하고 ok/result 또는 오류 계약으로 응답한다.
def main():
    try:
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES: raise ValueError("업무 입력이 2MB 한도를 넘었어요.")
        payload = bounded(json.loads(raw))
        if not isinstance(payload, dict): raise ValueError("작업 요청은 JSON 객체여야 해요.")
        operations, contracts = registry()
        manifest = json.loads(Path(__file__).with_name("completion-manifest.json").read_text(encoding="utf8"))
        selected = manifest.get("operations", [])
        allowed = {item["id"] for item in selected}
        if payload.get("operation") == "check":
            missing = readiness(payload.get("operations", []), operations, contracts, allowed)
            result = {"status": "unconfigured" if missing else "ready", "missing": missing}
        else:
            name = payload.get("operation")
            if name not in allowed or name not in operations: raise ValueError("내보낸 워크플로에서 선택하지 않은 업무 작업이에요.")
            if readiness([name], operations, contracts, allowed): raise ValueError("업무 프로그램 미설정: check에서 필요한 의존성·로컬 설정을 확인해 주세요.")
            arguments = payload.get("arguments", {})
            if not isinstance(arguments, dict): raise ValueError("작업 입력은 JSON 객체여야 해요.")
            result = bounded(operations[name](arguments))
            if not isinstance(result, dict): raise ValueError("작업 결과는 JSON 객체여야 해요.")
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, allow_nan=False))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": {"code": "operation_failed", "message": str(error)[:500]}}, ensure_ascii=False))
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
