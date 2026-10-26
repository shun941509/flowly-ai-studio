# 선택한 Skill 파일만 승인 후 실행하는 로컬 감독 프로세스. OS 보안 샌드박스는 아니며 사용자는 코드를 검토해야 한다.
# 호출자는 Windows Job Object/POSIX 프로세스 그룹으로 이 프로세스와 자손을 함께 취소한다.
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time


def checked_files(resource, root):
    result = {}
    for item in resource.get("files", []):
        relative = item.get("exportPath", "")
        if not isinstance(relative, str) or not relative.startswith("skills/") or "\\" in relative or ":" in relative or any(part in ("", ".", "..") for part in relative.split("/")):
            raise ValueError("Skill 첨부의 고정 상대 경로를 확인해 주세요.")
        path = root / relative
        for current in (path, *path.parents):
            if current == root:
                break
            if current.is_symlink() or getattr(current, "is_junction", lambda: False)():
                raise ValueError("Skill 파일에 심볼릭 링크나 정션을 사용할 수 없어요.")
        if not path.resolve().is_relative_to(root) or not path.is_file() or path.stat().st_size != item.get("size") or not 0 <= item["size"] <= 5000000:
            raise ValueError("Skill 파일 위치 또는 크기가 등록한 원본과 달라요.")
        if hashlib.sha256(path.read_bytes()).hexdigest() != item.get("sha256"):
            raise ValueError("Skill 파일 해시가 바뀌었어요. 수정본을 새 버전으로 등록해 주세요.")
        if not relative.endswith("/" + item["path"]):
            raise ValueError("Skill 파일의 상대 위치가 바뀌었어요.")
        result[item["id"]] = path
    return result


def definition(payload):
    resource = payload["resource"]
    skill = resource.get("details", {}).get("skill", {})
    entry = next((item for item in skill.get("executions", []) if item.get("id") == payload.get("entryId")), None)
    if skill.get("kind") != "executable" or not entry:
        raise ValueError("명시적으로 선택한 Skill 실행 정의가 없어요.")
    root = Path(__file__).resolve().parent
    files = checked_files(resource, root)
    file = next((item for item in resource.get("files", []) if item["id"] == entry.get("entryFileId")), None)
    if not file or not file["path"].startswith("scripts/") or entry.get("language") not in ("python", "javascript") or not file["path"].lower().endswith(".py" if entry["language"] == "python" else ".mjs"):
        raise ValueError("Skill 진입 파일은 scripts/의 Python .py 또는 JavaScript .mjs여야 해요.")
    if type(entry.get("timeoutMs")) is not int or not 100 <= entry["timeoutMs"] <= 120000 or type(entry.get("maxOutputBytes")) is not int or not 1 <= entry["maxOutputBytes"] <= 1000000:
        raise ValueError("Skill 실행 시간·출력 한도를 확인해 주세요.")
    if not isinstance(entry.get("dependencies"), list) or len(entry["dependencies"]) > 20 or entry["language"] == "javascript" and entry["dependencies"]:
        raise ValueError("JavaScript는 내장 모듈과 동봉 파일만 지원해요.")
    missing = []
    for dependency in entry["dependencies"]:
        if not isinstance(dependency, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*(?:==[A-Za-z0-9_.+-]+)?", dependency):
            raise ValueError("Python 의존성은 패키지명 또는 이름==버전으로 지정해 주세요.")
        name, _, version = dependency.partition("==")
        try:
            installed = importlib.metadata.version(name)
            if version and installed != version:
                missing.append(dependency)
        except importlib.metadata.PackageNotFoundError:
            missing.append(dependency)
    # -I로 사용자 PYTHONPATH/사용자 site를 차단하되 동봉한 상대 모듈은 진입 폴더와 Skill 루트에서 가져올 수 있다.
    bootstrap = "import os,runpy,sys;entry=sys.argv[1];sys.argv=[entry];sys.path[:0]=[os.path.dirname(entry),os.getcwd()];runpy.run_path(entry,run_name='__main__')"
    command = [sys.executable, "-X", "utf8", "-I", "-c", bootstrap, str(files[file["id"]])] if entry["language"] == "python" else ["node", str(files[file["id"]])]
    if entry["language"] == "javascript":
        try:
            version = subprocess.run(["node", "--version"], capture_output=True, timeout=5, check=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout.decode().strip()
            if not re.fullmatch(r"v\d+\.\d+\.\d+", version) or int(version[1:].split(".")[0]) < 22:
                missing.append("Node.js 22 이상")
        except (OSError, subprocess.SubprocessError):
            missing.append("Node.js 22 이상")
    package_root = root / file["exportPath"][:-len(file["path"])]
    return entry, command, package_root, missing


def execute(payload):
    entry, command, cwd, missing = definition(payload)
    if payload.get("operation") == "check":
        return {"status": "unconfigured" if missing else "ready", "missing": missing, "language": entry["language"], "approvalRequired": True}
    if payload.get("operation") != "execute" or missing:
        raise ValueError("Skill 의존성 미설정: " + ", ".join(missing) if missing else "지원하지 않는 Skill 작업이에요.")
    arguments = payload.get("arguments")
    if not isinstance(arguments, dict):
        raise ValueError("Skill 입력은 JSON 객체여야 해요.")
    encoded = json.dumps(arguments, ensure_ascii=False, allow_nan=False).encode("utf-8")
    if len(encoded) > 1000000:
        raise ValueError("Skill 입력은 1MB 이하여야 해요.")
    # 모델/MCP 자격 증명·도구팩 비밀·NODE_OPTIONS·PYTHONPATH를 상속하지 않는다. 임의 코드 자체의 네트워크/파일 접근은 OS 정책에 따른다.
    environment = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "PATH", "Path", "TEMP", "TMP", "LANG") if key in os.environ}
    environment.update({"PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1", "NODE_ENV": "production"})
    child = subprocess.Popen(command, cwd=cwd, env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    chunks, total, overflow = [], [0], threading.Event()

    def consume(stream, capture):
        while True:
            chunk = stream.read(4096)
            if not chunk:
                return
            total[0] += len(chunk)
            if total[0] > entry["maxOutputBytes"]:
                overflow.set()
                return
            if capture:
                chunks.append(chunk)

    def send():
        try:
            child.stdin.write(encoded)
            child.stdin.close()
        except (OSError, ValueError):
            pass

    readers = [threading.Thread(target=consume, args=(child.stdout, True), daemon=True), threading.Thread(target=consume, args=(child.stderr, False), daemon=True)]
    for thread in [*readers, threading.Thread(target=send, daemon=True)]:
        thread.start()
    deadline = time.monotonic() + entry["timeoutMs"] / 1000
    try:
        while child.poll() is None or any(thread.is_alive() for thread in readers):
            if overflow.is_set():
                raise ValueError("Skill 결과가 출력 한도를 넘었어요. 부작용을 확인한 뒤 새 실행을 시작하세요.")
            if time.monotonic() >= deadline:
                raise ValueError("Skill 실행 시간 한도를 넘었어요. 부작용을 확인한 뒤 새 실행을 시작하세요.")
            time.sleep(0.01)
        if overflow.is_set() or child.returncode:
            raise ValueError("Skill 실행이 실패했어요. 부작용을 확인한 뒤 새 실행을 시작하세요.")
        return json.loads(b"".join(chunks).decode("utf-8"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError("유효하지 않은 JSON 숫자예요.")))
    finally:
        if child.poll() is None:
            child.kill()
        # 자손 프로세스 정리는 호출자의 Job Object/프로세스 그룹이 담당한다.


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(2000001)
        if len(raw) > 2000000:
            raise ValueError("Skill 요청 크기 한도를 넘었어요.")
        result = execute(json.loads(raw))
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, allow_nan=False))
    except Exception as error:
        print(json.dumps({"ok": False, "error": {"code": "skill_execution", "message": str(error)[:500]}}, ensure_ascii=False))
        sys.exit(1)
