# 명시한 Python 환경에서 실제 SDK 예제의 오프라인 시험과 미설정 경계를 확인한다. 테스트용 자식 환경에 실제 모델 키나 추적 설정을 전달하지 않는다.
"""실제 설치한 Python SDK 대표 예제를 네트워크 차단 테스트로 검사한다.

Usage: python scripts/test-python-frameworks.py --python <shared-env-python> --crew-python <crew-env-python>
각 패키지의 requirements.txt 설치는 사용자가 별도로 수행한다.
"""
import argparse
import ast
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PACKS = ["langgraph-python", "autogen-python", "crewai-python", "smolagents-python", "pydantic-ai-python", "llamaindex-python"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--crew-python")
    parser.add_argument("--llama-python")
    parser.add_argument("--pack", choices=PACKS)
    args = parser.parse_args()
    outcomes = []
    # Allowlist runtime necessities. Provider keys, proxies and tracing secrets are never passed.
    child_environment = {name: os.environ[name] for name in ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "COMSPEC", "PATHEXT", "LOCALAPPDATA", "APPDATA", "USERPROFILE"] if name in os.environ}
    child_environment.update({"PYTHONUTF8": "1", "OTEL_SDK_DISABLED": "true", "CREWAI_TELEMETRY_DISABLED": "true", "CREWAI_TRACING_ENABLED": "false", "LANGCHAIN_TRACING_V2": "false", "LANGSMITH_TRACING": "false"})
    for name in ([args.pack] if args.pack else PACKS):
        selected = args.crew_python if name == "crewai-python" and args.crew_python else args.python
        if name == "llamaindex-python" and args.llama_python:
            selected = args.llama_python
        python = str(Path(selected).resolve())
        directory = ROOT / "examples" / "frameworks" / name
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory(prefix="flowly-framework-") as extracted:
            for filename in manifest["files"]:
                relative = Path(filename)
                if relative.is_absolute() or ".." in relative.parts:
                    raise ValueError("패키지 외부 파일은 허용하지 않습니다.")
                target = Path(extracted) / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(directory / relative, target)
                if target.suffix == ".py":
                    ast.parse(target.read_text(encoding="utf-8"))
            result = subprocess.run([python, "-X", "utf8", "test_offline.py"], cwd=extracted, env=child_environment, capture_output=True, text=True, encoding="utf-8", timeout=120)
            check = subprocess.run([python, "-X", "utf8", "main.py", "--check"], cwd=extracted, env=child_environment, capture_output=True, text=True, encoding="utf-8", timeout=60)
            missing = subprocess.run([python, "-X", "utf8", "main.py"], cwd=extracted, env=child_environment, capture_output=True, text=True, encoding="utf-8", timeout=60)
            boundary = check.returncode == 0 and '"unconfigured"' in check.stdout and missing.returncode != 0 and "미설정" in missing.stderr
        print(name, "PASS" if result.returncode == 0 else "FAIL")
        print(result.stdout[-3000:])
        print(result.stderr[-3000:])
        print("configuration_boundary", "PASS" if boundary else "FAIL")
        if not boundary:
            print(check.stdout[-1000:], check.stderr[-1000:], missing.stdout[-1000:], missing.stderr[-1000:])
        outcomes.append({"id": name, "static": True, "offline": result.returncode == 0 and boundary, "live": False})
    print(json.dumps(outcomes, ensure_ascii=False))
    raise SystemExit(0 if all(item["offline"] for item in outcomes) else 1)


if __name__ == "__main__":
    main()
