#!/usr/bin/env python3
"""Local, user-started operations for either exported runner. Python 3.11+, stdlib.

No provider credentials are inherited by child processes. Network probes happen only
through the explicit probe action; check, reports and maintenance remain offline.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager, ExitStack
import csv
from datetime import datetime, timezone
import hashlib
import http.client
import io
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid
import zipfile


class OperationsFault(Exception):
    """Messages are fixed local explanations, never upstream response bodies."""


TERMINAL = {"succeeded", "failed", "cancelled", "expired", "budget_exceeded"}
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$")
PROFILE = re.compile(r"^[a-z][a-z0-9_-]{0,39}$")
PROTOCOL = "2025-11-25"
SAFE_ENV = ("PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "PATHEXT", "VIRTUAL_ENV")


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def no_links(path):
    for item in (path, *path.parents):
        if item.is_symlink() or item.exists() and getattr(item.lstat(), "st_file_attributes", 0) & 0x400:
            raise OperationsFault("운영 경로에는 심볼릭 링크나 연결 폴더를 사용할 수 없어요.")


def safe_id(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise OperationsFault("기록 ID 형식을 확인해 주세요.")
    return value


def relative(root, value):
    if not isinstance(value, str) or not value or len(value) > 500 or "\\" in value or re.search(r"[\x00-\x1f:]", value):
        raise OperationsFault("프로젝트 안의 상대 경로를 지정해 주세요.")
    path = Path(value)
    if path.is_absolute() or any(part in ("..", ".") for part in value.split("/")):
        raise OperationsFault("프로젝트 밖의 파일에는 접근할 수 없어요.")
    candidate = root / path
    no_links(candidate)
    if not candidate.resolve().is_relative_to(root.resolve()):
        raise OperationsFault("프로젝트 밖의 파일에는 접근할 수 없어요.")
    return candidate


def read_json(path, maximum=16_000_000):
    no_links(path)
    if path.stat().st_size > maximum:
        raise OperationsFault("설정 또는 기록 파일이 허용 크기를 넘었어요.")
    return json.loads(path.read_text(encoding="utf-8-sig"))


def atomic_json(path, value):
    no_links(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as stream:
            stream.write(canonical(value))
            stream.flush()
            os.fsync(stream.fileno())
        no_links(path)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def alive(pid):
    if type(pid) is not int or pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        api = ctypes.WinDLL("kernel32", use_last_error=True)
        api.OpenProcess.restype = ctypes.c_void_p
        api.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_bool, ctypes.c_uint32]
        api.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
        api.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = api.OpenProcess(0x1000, False, pid)
        if not handle:
            return ctypes.get_last_error() == 5
        try:
            code = ctypes.c_uint32()
            return not api.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value == 259
        finally:
            api.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def scrub(value, secrets=()):
    if isinstance(value, str):
        for secret in secrets:
            if secret:
                value = value.replace(secret, "[비밀 값 숨김]")
        value = re.sub(r"\bsk-[A-Za-z0-9_-]{8,}\b|\bBearer\s+[^\s\"']+", "[비밀 값 숨김]", value)
        return value
    if isinstance(value, list):
        return [scrub(item, secrets) for item in value]
    if isinstance(value, dict):
        return {key: scrub(item, secrets) for key, item in value.items()}
    return value


def load_env(path):
    if not path.exists():
        return {}
    no_links(path)
    if path.stat().st_size > 64_000:
        raise OperationsFault("환경 파일은 64KB 이하여야 해요.")
    values = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = re.fullmatch(r"(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)", stripped)
        if not match:
            raise OperationsFault("환경 파일 형식을 확인해 주세요.")
        value = match[2]
        if value.startswith(("'", '"')):
            if len(value) < 2 or value[-1] != value[0]:
                raise OperationsFault("환경 파일의 따옴표를 확인해 주세요.")
            value = value[1:-1]
        else:
            value = value.split(" #", 1)[0].strip()
        values[match[1]] = value
    return values


def secrets_in(env):
    return [value for key, value in env.items() if value and (key in ("OPENAI_API_KEY", "FLOWLY_TRIGGER_SECRET") or key.startswith("FLOWLY_MCP_TOKEN_"))]


def vector_node_present(definition, depth=0):
    if depth > 3 or not isinstance(definition, dict) or not isinstance(definition.get("nodes"), list):
        raise OperationsFault("검색 블록이 포함된 워크플로 정의를 확인해 주세요.")
    found = False
    for node in definition["nodes"]:
        if node.get("type") == "retrieval" and node.get("retrieval", {}).get("mode") == "vector":
            found = True
        key = {"parallel": "parallel", "agent_team": "team", "orchestrator": "orchestration"}.get(node.get("type"))
        children = [task["definition"] for task in node.get(key, {}).get("tasks", [])] if key else [node[node["type"]]["definition"]] if node.get("type") in ("loop", "subworkflow") else []
        for child in children:
            found = vector_node_present(child, depth + 1) or found
    return found


def evaluation_summary(results, total=None):
    executed = len(results)
    passed = sum(item.get("passed") is True for item in results)
    failed = sum(item.get("status") in ("failed", "cancelled", "expired", "budget_exceeded", "unknown_outcome") for item in results)
    estimates = [item["estimate"] for item in results if item.get("estimate", {}).get("status") == "estimated"]
    currencies = {item["currency"] for item in estimates}
    cost = {"status": "unconfigured", "estimatedRuns": len(estimates), "label": "수동 단가 추정 · 실제 청구 아님"}
    if estimates and len(currencies) == 1:
        cost.update(status="estimated" if len(estimates) == executed else "partial", currency=next(iter(currencies)), minimum=sum(item["range"]["minimum"] for item in estimates), maximum=sum(item["range"]["maximum"] for item in estimates))
    return {"total": total if total is not None else executed, "executed": executed, "passed": passed, "failed": failed,
            "passRate": passed / executed if executed else None, "failureRate": failed / executed if executed else None,
            "totalTokens": sum(item.get("usage", {}).get("tokens", 0) for item in results),
            "activeMs": sum(item.get("usage", {}).get("activeMs", 0) for item in results), "cost": cost}


def safe_endpoint(value):
    try:
        if not isinstance(value, str) or not re.match(r"https?://", value, re.I) or re.search(r"[\s\x00-\x1f\x7f\\]", value):
            raise ValueError()
        parsed = urllib.parse.urlsplit(value)
        host = parsed.hostname or ""
        if parsed.scheme not in ("http", "https") or not host or parsed.port == 0 or "@" in parsed.netloc or parsed.query or parsed.fragment:
            raise ValueError()
        if ":" in host:
            ipaddress.ip_address(host)
        elif not re.fullmatch(r"[A-Za-z0-9_.-]+", host.encode("idna").decode("ascii")):
            raise ValueError()
        return parsed
    except (TypeError, ValueError):
        raise OperationsFault("인증 정보·쿼리·프래그먼트가 없는 HTTP 또는 HTTPS 주소가 필요해요. 내부망 주소와 사용자 지정 포트를 사용할 수 있어요.") from None


class ProbeTransport:
    """No redirects/proxies; pin the resolved socket and use normal TLS verification for HTTPS."""
    def post(self, endpoint, body, headers, rpc_id=None, notification=False):
        parsed = safe_endpoint(endpoint)
        deadline = time.monotonic() + 20
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        addresses = socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
        if not addresses:
            raise OperationsFault("연결 주소를 찾지 못했어요. 실행 환경의 DNS·VPN·네트워크 설정을 확인해 주세요.")
        address = addresses[0][4][0]
        base_connection = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        class Pinned(base_connection):
            def connect(inner):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError()
                raw = socket.create_connection((address, port), timeout=remaining)
                try:
                    inner.sock = inner._context.wrap_socket(raw, server_hostname=parsed.hostname) if parsed.scheme == "https" else raw
                except BaseException:
                    raw.close()
                    raise
                if time.monotonic() >= deadline:
                    inner.close()
                    raise TimeoutError()
        connection = Pinned(parsed.hostname, port=port, timeout=20)
        timer = threading.Timer(20, connection.close)
        timer.daemon = True
        timer.start()
        try:
            target = parsed.path or "/"
            if parsed.query:
                target += "?" + parsed.query
            connection.request("POST", target, canonical(body).encode("utf-8"), {"Content-Type": "application/json", **headers})
            response = connection.getresponse()
            if response.status not in (200, 201, 202, 204):
                raise OperationsFault("원격 연결이 요청을 거절했어요. 자격 증명·권한·모델·서비스 설정을 확인해 주세요.")
            received = dict(response.getheaders())
            if notification:
                return {}, received
            content = bytearray()
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError()
                if connection.sock:
                    connection.sock.settimeout(remaining)
                part = response.read1(16384)
                if not part:
                    break
                content.extend(part)
                if len(content) > 1_000_000:
                    raise OperationsFault("프로브 응답 크기가 한도를 넘었어요.")
                if "text/event-stream" in response.getheader("Content-Type", ""):
                    text = bytes(content).decode("utf-8", errors="replace").replace("\r\n", "\n")
                    for frame in text.split("\n\n")[:-1]:
                        data = "\n".join(line[5:].lstrip() for line in frame.splitlines() if line.startswith("data:"))
                        if data and data != "[DONE]":
                            value = json.loads(data)
                            if rpc_id is None or value.get("id") == rpc_id:
                                return value, received
            return json.loads(content), received
        except OperationsFault:
            raise
        except (OSError, ValueError, TimeoutError, http.client.HTTPException):
            raise OperationsFault("원격 응답을 확인하지 못했어요. 프로브를 자동 재시도하지 않았어요.") from None
        finally:
            timer.cancel()
            connection.close()


class Operations:
    def __init__(self, root, transport=None):
        self.root = Path(root).absolute()
        no_links(self.root)
        self.root = self.root.resolve()
        self.package_path = self.root / "workflow.json"
        self.package = read_json(self.package_path, 8_000_000)
        if self.package.get("format") != "flowly-executable-export" or self.package.get("version") != 1 or self.package.get("language") not in ("node", "python"):
            raise OperationsFault("내보낸 실행 프로젝트 폴더를 지정해 주세요.")
        self.package_hash = hashlib.sha256(self.package_path.read_bytes()).hexdigest()
        self.agent_path = relative(self.root, "agent-manifest.json")
        if self.agent_path.exists() and self.agent_path.stat().st_size > 1_000_000:
            raise OperationsFault("Agent 실행 구성이 너무 커요.")
        self.agent_hash = hashlib.sha256(self.agent_path.read_bytes()).hexdigest() if self.agent_path.exists() else None
        self.entrypoint = "runner.mjs" if self.package["language"] == "node" else "runner.py"
        if self.agent_hash is not None:
            agent = read_json(self.agent_path, 1_000_000)
            expected = "agent.mjs" if self.package["language"] == "node" else "agent.py"
            if not isinstance(agent, dict) or agent.get("format") != "flowly-agent-project" or agent.get("version") != 1 or agent.get("language") != self.package["language"] or agent.get("entrypoint") != expected or agent.get("workflow") != "workflow.json":
                raise OperationsFault("Agent 실행 구성이 올바르지 않아요. 다시 내보내 주세요.")
            self.entrypoint = expected
        self.home = relative(self.root, ".flowly-ops")
        self.home.mkdir(exist_ok=True)
        self.database = self.home / "operations.sqlite"
        self.transport = transport or ProbeTransport()
        self.stop = threading.Event()
        self.worker_token = None
        with self.db() as db:
            db.executescript("""
              CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS profiles(name TEXT PRIMARY KEY,env TEXT NOT NULL,production INTEGER NOT NULL);
              CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,profile TEXT NOT NULL,priority INTEGER NOT NULL,status TEXT NOT NULL,run_id TEXT,created TEXT NOT NULL,updated TEXT NOT NULL,command TEXT NOT NULL,input_path TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0,error TEXT);
              CREATE TABLE IF NOT EXISTS prices(model TEXT PRIMARY KEY,input_rate REAL NOT NULL,output_rate REAL NOT NULL,currency TEXT NOT NULL,as_of TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS bills(id TEXT PRIMARY KEY,start TEXT NOT NULL,end TEXT NOT NULL,model TEXT NOT NULL,amount REAL NOT NULL,currency TEXT NOT NULL,input_tokens INTEGER,output_tokens INTEGER);
            """)
            stored = db.execute("SELECT value FROM metadata WHERE key='package'").fetchone()
            if stored and stored[0] != self.package_hash:
                raise OperationsFault("패키지가 변경됐어요. 원본을 복구하거나 새 폴더에서 운영을 시작해 주세요.")
            db.execute("INSERT OR IGNORE INTO metadata VALUES('package',?)", (self.package_hash,))
            execution = self.entrypoint + ":" + (self.agent_hash or "runtime")
            previous = db.execute("SELECT value FROM metadata WHERE key='execution'").fetchone()
            if previous and previous[0] != execution:
                raise OperationsFault("실행 진입점이 변경됐어요. 원본을 복구하거나 새 폴더에서 운영을 시작해 주세요.")
            db.execute("INSERT OR IGNORE INTO metadata VALUES('execution',?)", (execution,))
            db.execute("INSERT OR IGNORE INTO profiles VALUES('development','.env',0)")
        try:
            os.chmod(self.database, 0o600)
        except OSError:
            pass

    @contextmanager
    def db(self):
        no_links(self.database)
        for suffix in ("-journal", "-wal", "-shm"):
            no_links(self.database.with_name(self.database.name + suffix))
        connection = sqlite3.connect(self.database, timeout=5)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def assert_package(self):
        no_links(self.package_path)
        no_links(self.home)
        if hashlib.sha256(self.package_path.read_bytes()).hexdigest() != self.package_hash:
            raise OperationsFault("실행 프로젝트가 변경되어 운영 작업을 중단했어요.")
        no_links(self.agent_path)
        current = hashlib.sha256(self.agent_path.read_bytes()).hexdigest() if self.agent_path.exists() else None
        if current != self.agent_hash:
            raise OperationsFault("Agent 실행 구성이 변경되어 운영 작업을 중단했어요.")

    def profile(self, name="development"):
        if not isinstance(name, str) or not PROFILE.fullmatch(name):
            raise OperationsFault("프로필 이름은 영문 소문자로 시작하는 40자 이하 식별자여야 해요.")
        with self.db() as db:
            row = db.execute("SELECT * FROM profiles WHERE name=?", (name,)).fetchone()
        if row is None:
            raise OperationsFault("등록된 프로필을 선택해 주세요.")
        relative(self.root, row["env"])
        return {"name": name, "env": row["env"], "state": f".flowly-profiles/{name}/runs", "production": bool(row["production"])}

    def environment(self, profile):
        return load_env(relative(self.root, profile["env"]))

    def state(self, profile):
        return relative(self.root, profile["state"])

    def confirm(self, request, profile):
        if profile["production"] and request.get("confirmProduction") is not True:
            raise OperationsFault("운영 프로필 실행에는 confirmProduction=true 확인이 필요해요.")

    def idle(self, profile):
        with self.db() as db:
            running = db.execute("SELECT 1 FROM jobs WHERE profile=? AND status IN ('running','dispatching') LIMIT 1", (profile["name"],)).fetchone()
        if running:
            raise OperationsFault("실행 중인 작업을 끝내거나 취소한 다음 관리해 주세요.")
        for lock_name in (".runner.lock", ".unlock.lock"):
            if (self.state(profile) / lock_name).exists():
                raise OperationsFault("실행기 잠금이 있어요. 실행 중인지 확인하고 종료된 잠금만 해제해 주세요.")

    def command(self):
        filename = self.entrypoint
        path = relative(self.root, filename)
        if not path.is_file():
            raise OperationsFault("패키지의 기본 실행기 파일이 없어요.")
        return ["node", str(path)] if filename.endswith("mjs") else [sys.executable, "-X", "utf8", str(path)]

    def cli(self, profile, arguments, cancel_path=None, cancelled=None):
        self.assert_package()
        package_options = [] if self.agent_hash is not None else ["--package", str(self.package_path)]
        args = self.command() + list(arguments) + package_options + ["--state", str(self.state(profile)), "--env", str(relative(self.root, profile["env"]))]
        if cancel_path is not None:
            args += ["--cancel-file", str(cancel_path)]
        child_env = {key: os.environ[key] for key in SAFE_ENV if key in os.environ}
        output, oversized = [], threading.Event()
        timeout = min(610, max(20, self.package.get("limits", {}).get("maxDurationMs", 120000) / 1000 + 15))
        try:
            process = subprocess.Popen(args, cwd=self.root, env=child_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except OSError:
            raise OperationsFault("실행기를 시작하지 못했어요. Node 또는 Python 설치를 확인해 주세요.") from None
        def consume(stream, keep):
            length = 0
            while True:
                part = stream.read(8192)
                if not part:
                    break
                length += len(part)
                if length > 2_000_000:
                    oversized.set()
                    process.kill()
                    break
                if keep:
                    output.append(part)
        readers = [threading.Thread(target=consume, args=(process.stdout, True), daemon=True), threading.Thread(target=consume, args=(process.stderr, False), daemon=True)]
        for reader in readers:
            reader.start()
        deadline = time.monotonic() + timeout
        cancellation_at = None
        try:
            while process.poll() is None:
                cancel = self.stop.is_set() or cancelled is not None and cancelled()
                if cancel and cancel_path is not None:
                    if not cancel_path.exists():
                        atomic_json(cancel_path, {"cancelled": True})
                    cancellation_at = cancellation_at or time.monotonic()
                if time.monotonic() >= deadline or cancellation_at is not None and time.monotonic() - cancellation_at > 5:
                    process.kill()
                    process.wait()
                    raise OperationsFault("실행기 응답이 중단됐어요. 저장된 외부 변경 결과를 확인하기 전 자동 재시도하지 않아요.")
                time.sleep(.05)
            for reader in readers:
                reader.join()
            if oversized.is_set():
                raise OperationsFault("실행기 출력 한도를 넘었어요. 저장된 실행 상태를 확인해 주세요.")
            try:
                result = json.loads(b"".join(output).decode("utf-8-sig"))
                if not isinstance(result, dict):
                    raise ValueError()
            except (ValueError, UnicodeError):
                raise OperationsFault("실행기 결과를 확인할 수 없어요. 설정과 저장된 상태를 확인해 주세요.") from None
            # Native persisted output is already redacted. Status/decisions must
            # remain available when the user's environment file is missing/broken.
            return scrub(result)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            for reader in readers:
                reader.join()
            process.stdout.close()
            process.stderr.close()

    def job(self, ident):
        with self.db() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (safe_id(ident),)).fetchone()
        if row is None:
            raise OperationsFault("작업 기록을 찾을 수 없어요.")
        return {"id": row["id"], "profile": row["profile"], "priority": row["priority"], "status": row["status"], "runId": row["run_id"], "createdAt": row["created"], "updatedAt": row["updated"], "cancelRequested": bool(row["cancel_requested"]), **({"error": row["error"]} if row["error"] else {})}

    def enqueue(self, request, resume=False):
        profile = self.profile(request.get("profile", "development"))
        self.confirm(request, profile)
        priority = request.get("priority", 0)
        if type(priority) is not int or not -100 <= priority <= 100:
            raise OperationsFault("우선순위는 -100부터 100까지 정수로 지정해 주세요.")
        ident, timestamp = "job_" + uuid.uuid4().hex, now()
        path, run_id = None, None
        if resume:
            run_id = safe_id(request.get("runId"))
            status = self.cli(profile, ["status", run_id])
            if status.get("status") != "queued":
                raise OperationsFault("결정을 마친 queued 실행만 명시적으로 재개할 수 있어요. 불명확한 외부 변경은 재시도하지 않아요.")
        else:
            text = request.get("input", "")
            if not isinstance(text, str) or not text.strip() or len(text) > 12000:
                raise OperationsFault("실행 입력은 1~12,000자로 작성해 주세요.")
            text = scrub(text, secrets_in(self.environment(profile)))
            path = self.home / "inputs" / (ident + ".txt")
            no_links(path)
            path.parent.mkdir(exist_ok=True)
            no_links(path)
            with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as stream:
                stream.write(text)
        try:
            with self.db() as db:
                db.execute("BEGIN IMMEDIATE")
                current_profile = db.execute("SELECT env,production FROM profiles WHERE name=?", (profile["name"],)).fetchone()
                if current_profile is None or current_profile["env"] != profile["env"] or bool(current_profile["production"]) != profile["production"]:
                    raise OperationsFault("작업을 등록하는 동안 프로필이 바뀌었어요. 새 설정을 확인한 뒤 다시 요청해 주세요.")
                if run_id and db.execute("SELECT 1 FROM jobs WHERE run_id=? AND status IN ('queued','dispatching','running')", (run_id,)).fetchone():
                    raise OperationsFault("같은 실행이 이미 대기열에 있어요.")
                db.execute("INSERT INTO jobs(id,profile,priority,status,run_id,created,updated,command,input_path) VALUES(?,?,?,'queued',?,?,?,?,?)",
                           (ident, profile["name"], priority, run_id, timestamp, timestamp, "resume" if resume else "run", path.relative_to(self.root).as_posix() if path else None))
        except BaseException:
            if path:
                path.unlink(missing_ok=True)
            raise
        return {"job": self.job(ident)}

    @contextmanager
    def worker_lock(self):
        path = self.home / ".worker.lock"
        no_links(path)
        token = uuid.uuid4().hex
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            except FileExistsError:
                previous = read_json(path, 2000)
                if alive(previous.get("pid")):
                    raise OperationsFault("이 프로젝트의 작업 실행기가 이미 실행 중이에요.") from None
                path.unlink()
                descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(canonical({"pid": os.getpid(), "token": token}))
                stream.flush()
                os.fsync(stream.fileno())
            # A missing old lock never authorizes replay of a dispatching job.
            db.execute("UPDATE jobs SET status='unknown_outcome',error=?,updated=? WHERE status IN ('dispatching','running')", ("이전 실행기가 종료됐어요. 저장된 상태를 확인해 주세요.", now()))
        self.worker_token = token
        try:
            yield
        finally:
            self.worker_token = None
            if path.exists() and read_json(path, 2000).get("token") == token:
                path.unlink()

    def worker(self, once=False):
        processed = []
        with self.worker_lock():
            while not self.stop.is_set():
                with self.db() as db:
                    db.execute("BEGIN IMMEDIATE")
                    row = None if (self.home / ".maintenance.lock").exists() else db.execute("SELECT * FROM jobs WHERE status='queued' AND cancel_requested=0 ORDER BY MIN(200,priority+MAX(0,CAST((julianday('now')-julianday(created))*288 AS INTEGER))) DESC,created ASC,id ASC LIMIT 1").fetchone()
                    if row:
                        db.execute("UPDATE jobs SET status='dispatching',updated=? WHERE id=? AND status='queued'", (now(), row["id"]))
                if row is None:
                    if once:
                        break
                    self.stop.wait(.3)
                    continue
                profile = self.profile(row["profile"])
                cancel_path = self.home / "cancel" / (row["id"] + ".json")
                cancel_path.parent.mkdir(exist_ok=True)
                before = {item["id"] for item in self.runs(profile)}
                def cancelled():
                    return self.job(row["id"])["cancelRequested"]
                try:
                    if (self.home / ".maintenance.lock").exists():
                        with self.db() as db:
                            db.execute("UPDATE jobs SET status='queued',updated=? WHERE id=?", (now(), row["id"]))
                        if once:
                            break
                        continue
                    with self.db() as db:
                        db.execute("UPDATE jobs SET status='running',updated=? WHERE id=?", (now(), row["id"]))
                    arguments = ["resume", row["run_id"]] if row["command"] == "resume" else ["run", "--input-file", str(relative(self.root, row["input_path"]))]
                    result = self.cli(profile, arguments, cancel_path, cancelled)
                    status, run_id = result.get("status"), result.get("id")
                    if status not in TERMINAL | {"queued", "waiting_approval", "waiting_review", "waiting_input", "unknown_outcome"} or not isinstance(run_id, str) or not ID.fullmatch(run_id):
                        raise OperationsFault("실행기 상태 응답을 확인하지 못했어요.")
                    if status == "queued":
                        status = "paused"  # A native checkpoint is not a new queue dispatch.
                    error = None
                except (OperationsFault, OSError, ValueError):
                    status, run_id, error = "unknown_outcome", row["run_id"], "저장된 실행 상태와 외부 결과를 확인해 주세요. 자동 재시도하지 않아요."
                    created = [item for item in self.runs(profile) if item["id"] not in before]
                    if len(created) == 1:
                        run_id = created[0]["id"]
                with self.db() as db:
                    db.execute("UPDATE jobs SET status=?,run_id=?,error=?,updated=? WHERE id=?", (status, run_id, error, now(), row["id"]))
                if row["input_path"]:
                    relative(self.root, row["input_path"]).unlink(missing_ok=True)
                processed.append(self.job(row["id"]))
                if once:
                    break
        return {"processed": processed}

    def runs(self, profile):
        directory = self.state(profile)
        if not directory.exists():
            return []
        results = []
        for path in directory.glob("run_*.json"):
            document = read_json(path)
            run = document.get("run")
            if document.get("packageHash") != self.package_hash or not isinstance(run, dict) or run.get("owner", {}).get("userId") != self.package.get("owner", {}).get("userId"):
                continue
            results.append({key: run.get(key) for key in ("id", "status", "createdAt", "updatedAt")})
        return sorted(results, key=lambda item: item.get("createdAt", ""), reverse=True)[:1000]

    def raw_run(self, profile, ident):
        record = read_json(self.state(profile) / (safe_id(ident) + ".json"))
        if record.get("packageHash") != self.package_hash or record.get("run", {}).get("owner", {}).get("userId") != self.package.get("owner", {}).get("userId"):
            raise OperationsFault("현재 프로필과 패키지의 실행 기록이 아니에요.")
        return record["run"]

    def probe(self, request):
        if request.get("confirm") is not True or request.get("target") not in ("openai", "embeddings", "mcp", "all"):
            raise OperationsFault("외부 호출이 발생하는 프로브는 target과 confirm=true를 명시해 주세요.")
        profile = self.profile(request.get("profile", "development"))
        self.confirm(request, profile)
        env = self.environment(profile)
        probe_embeddings = request["target"] == "embeddings" or request["target"] == "all" and vector_node_present(self.package["workflow"]["definition"])
        checks, calls = [], {"openaiResponses": 0, "openaiEmbeddings": 0, "mcpInitialize": 0, "mcpNotifications": 0, "mcpToolsList": 0, "mcpToolsCall": 0}
        if request["target"] in ("openai", "all"):
            item = {"kind": "openai", "status": "unconfigured"}
            if env.get("OPENAI_API_KEY") and env.get("FLOWLY_MODEL"):
                try:
                    calls["openaiResponses"] += 1
                    response, _ = self.transport.post("https://api.openai.com/v1/responses", {"model": env["FLOWLY_MODEL"], "input": "Reply OK.", "max_output_tokens": 16, "store": False, "reasoning": {"effort": "none"}}, {"Authorization": "Bearer " + env["OPENAI_API_KEY"]})
                    tokens = response.get("usage", {}).get("total_tokens")
                    if response.get("status") != "completed" or type(tokens) is not int or tokens < 0:
                        raise OperationsFault("최소 모델 요청이 완료되지 않았어요. 모델 설정과 토큰 한도를 확인해 주세요.")
                    item.update(status="connected", usageTokens=tokens)
                except Exception:
                    item.update(status="failed", error="모델 연결을 확인하지 못했어요. 키·모델·권한·결제 설정을 확인해 주세요.")
            checks.append(item)
        if probe_embeddings:
            configured = "FLOWLY_EMBEDDING_MODEL" in env
            model = env.get("FLOWLY_EMBEDDING_MODEL", "text-embedding-3-small").strip()
            missing = ([] if env.get("OPENAI_API_KEY", "").strip() else ["OPENAI_API_KEY"]) + ([] if model else ["FLOWLY_EMBEDDING_MODEL"])
            item = {"kind": "embeddings", "status": "unconfigured", "modelSource": "environment" if configured else "default", "missingEnv": missing,
                    **({"defaultModel": "text-embedding-3-small"} if not configured else {})}
            if not missing:
                try:
                    calls["openaiEmbeddings"] += 1
                    response, _ = self.transport.post("https://api.openai.com/v1/embeddings", {"model": model, "input": ["connection check"], "encoding_format": "float"}, {"Authorization": "Bearer " + env["OPENAI_API_KEY"]})
                    data, tokens = response.get("data"), response.get("usage", {}).get("total_tokens")
                    if response.get("model") != model or type(tokens) is not int or tokens < 0 or not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], dict) or type(data[0].get("index")) is not int or data[0]["index"] != 0:
                        raise OperationsFault("임베딩 응답의 모델·순서·사용량을 확인할 수 없어요.")
                    vector = data[0].get("embedding")
                    if not isinstance(vector, list) or not 1 <= len(vector) <= 4096 or any(type(value) not in (int, float) or not math.isfinite(value) for value in vector):
                        raise OperationsFault("임베딩 벡터 형식이 올바르지 않아요.")
                    norm = sum(value * value for value in vector)
                    if not math.isfinite(norm) or norm <= 0:
                        raise OperationsFault("임베딩 벡터가 유효하지 않아요.")
                    item.update(status="connected", usageTokens=tokens, dimensions=len(vector))
                except Exception:
                    item.update(status="failed", error="임베딩 연결 또는 응답을 확인하지 못했어요. 키·임베딩 모델·권한·사용 한도를 확인해 주세요.")
            checks.append(item)
        if request["target"] in ("mcp", "all"):
            for connection in self.package.get("connections", []):
                item = {"kind": "mcp", "id": connection.get("id"), "status": "unconfigured"}
                key = connection.get("tokenEnv")
                if key and (not isinstance(key, str) or not re.fullmatch(r"FLOWLY_MCP_TOKEN_[A-Z0-9_]+", key)):
                    raise OperationsFault("MCP 연결의 토큰 환경 변수 이름이 올바르지 않아요.")
                endpoint_key = connection.get("endpointEnv")
                if "endpointEnv" in connection and (not isinstance(endpoint_key, str) or not re.fullmatch(r"FLOWLY_MCP_ENDPOINT_[A-Z0-9_]+", endpoint_key)):
                    raise OperationsFault("MCP 연결 주소의 환경 변수 이름이 올바르지 않아요.")
                # The local profile is the only source for an endpoint template.
                # Never send its token to the public definition's placeholder.
                endpoint = env.get(endpoint_key, "").strip() if endpoint_key else connection.get("endpoint")
                missing = ([endpoint_key] if endpoint_key and not endpoint else []) + ([key] if key and not env.get(key, "").strip() else [])
                if missing:
                    item["missingEnv"] = missing
                else:
                    try:
                        safe_endpoint(endpoint)
                        if connection.get("ownerId") != self.package.get("owner", {}).get("userId"):
                            raise OperationsFault("다른 소유자의 연결은 사용할 수 없어요.")
                        session = None
                        def rpc(method, params=None, notification=False):
                            nonlocal session
                            ident = uuid.uuid4().hex
                            headers = {"Accept": "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL}
                            if key:
                                headers["Authorization"] = "Bearer " + env[key]
                            if session:
                                headers["Mcp-Session-Id"] = session
                            body = {"jsonrpc": "2.0", "method": method, **({} if notification else {"id": ident}), **({"params": params} if params is not None else {})}
                            counter = "mcpInitialize" if method == "initialize" else "mcpNotifications" if notification else "mcpToolsList"
                            calls[counter] += 1
                            response, received = self.transport.post(endpoint, body, headers, ident, notification)
                            assigned = next((v for k, v in received.items() if k.lower() == "mcp-session-id"), None)
                            if assigned:
                                if not isinstance(assigned, str) or not re.fullmatch(r"[\x21-\x7e]{1,1024}", assigned):
                                    raise OperationsFault("MCP 세션 형식을 확인할 수 없어요.")
                                session = assigned
                            if notification:
                                return {}
                            if response.get("jsonrpc") != "2.0" or response.get("id") != ident or response.get("error") or not isinstance(response.get("result"), dict):
                                raise OperationsFault("MCP 프로브 응답을 확인할 수 없어요.")
                            return response["result"]
                        initialized = rpc("initialize", {"protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": {"name": "flowly-ops-probe", "version": "1"}})
                        if initialized.get("protocolVersion") != PROTOCOL or "tools" not in initialized.get("capabilities", {}):
                            raise OperationsFault("지원하는 MCP 도구 프로토콜을 확인해 주세요.")
                        rpc("notifications/initialized", notification=True)
                        listed, cursor = [], None
                        for _ in range(10):
                            page = rpc("tools/list", {"cursor": cursor} if cursor else {})
                            if not isinstance(page.get("tools"), list):
                                raise OperationsFault("MCP 도구 목록을 확인할 수 없어요.")
                            listed.extend(page["tools"])
                            if len(listed) > 1000:
                                raise OperationsFault("MCP 도구 목록 한도를 넘었어요.")
                            cursor = page.get("nextCursor")
                            if not cursor:
                                break
                            if not isinstance(cursor, str) or len(cursor) > 2000:
                                raise OperationsFault("MCP 목록 커서가 올바르지 않아요.")
                        if cursor:
                            raise OperationsFault("MCP 도구 목록 페이지 한도를 넘었어요.")
                        changed = []
                        for expected in connection.get("tools", []):
                            actual = next((tool for tool in listed if tool.get("name") == expected.get("toolName")), None)
                            if actual is None or canonical(actual.get("inputSchema")) != canonical(expected.get("inputSchema")) or expected.get("effect") == "read" and actual.get("annotations", {}).get("readOnlyHint") is not True:
                                changed.append(expected["toolName"])
                        item.update(status="changed" if changed else "connected", changedTools=changed, listedTools=len(listed))
                    except Exception:
                        item.update(status="failed", error="MCP 초기 협상 또는 도구 목록을 확인하지 못했어요. 연결 설정과 공개 도구 스키마를 확인해 주세요.")
                checks.append(item)
        return {"status": "connected" if checks and all(item["status"] == "connected" for item in checks) else "attention", "checks": scrub(checks, secrets_in(env)), "remoteCalls": calls}

    def scope(self, profile, name):
        if name == "state":
            return self.state(profile)
        if name in ("outputs", "reports"):
            return relative(self.root, name)
        raise OperationsFault("보관 범위는 state, outputs, reports 중에서 선택해 주세요.")

    @contextmanager
    def directory_lock(self, directory):
        no_links(directory)
        directory.mkdir(parents=True, exist_ok=True)
        path, nonce = directory / ".runner.lock", uuid.uuid4().hex
        if (directory / ".unlock.lock").exists():
            raise OperationsFault("실행기 잠금 복구가 진행 중이에요.")
        try:
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            raise OperationsFault("실행기와 관리 작업을 동시에 시작할 수 없어요.") from None
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(canonical({"pid": os.getpid(), "nonce": nonce}))
            if (directory / ".unlock.lock").exists():
                raise OperationsFault("실행기 잠금 복구가 진행 중이에요.")
            yield
        finally:
            if path.exists() and read_json(path, 2000).get("nonce") == nonce:
                path.unlink()

    @contextmanager
    def maintenance(self, profile, shared=False):
        self.idle(profile)
        marker, nonce = self.home / ".maintenance.lock", uuid.uuid4().hex
        try:
            descriptor = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            raise OperationsFault("다른 관리 작업이 진행 중이에요.") from None
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(canonical({"pid": os.getpid(), "nonce": nonce}))
            profiles = [profile]
            if shared:
                with self.db() as db:
                    profiles = [self.profile(row[0]) for row in db.execute("SELECT name FROM profiles ORDER BY name")]
            with ExitStack() as stack:
                for item in profiles:
                    self.idle(item)
                    stack.enter_context(self.directory_lock(self.state(item)))
                if shared:
                    for name in (".flowly-runs", ".flowly-python-runs"):
                        directory = relative(self.root, name)
                        if directory.exists():
                            stack.enter_context(self.directory_lock(directory))
                yield
        finally:
            if marker.exists() and read_json(marker, 2000).get("nonce") == nonce:
                marker.unlink()

    def files(self, profile, scopes):
        if not isinstance(scopes, list) or not scopes or len(set(scopes)) != len(scopes):
            raise OperationsFault("보관 범위를 하나 이상 선택해 주세요.")
        files, total = [], 0
        for scope in scopes:
            directory = self.scope(profile, scope)
            if not directory.exists():
                continue
            for path in directory.rglob("*"):
                no_links(path)
                if not path.is_file() or path.name.startswith(".") or path.suffix == ".tmp":
                    continue
                if ".env" in path.name.lower() or path.suffix.lower() in (".pem", ".key", ".p12", ".pfx"):
                    raise OperationsFault("환경·비밀 파일은 백업이나 보존 작업에 포함할 수 없어요.")
                size = path.stat().st_size
                total += size
                if total > 100_000_000 or len(files) >= 5000 or size > 16_000_000:
                    raise OperationsFault("관리 대상은 파일 5,000개·전체 100MB 이하여야 해요.")
                files.append((scope, path, path.relative_to(directory).as_posix()))
        return files

    def backup(self, request):
        profile = self.profile(request.get("profile", "development"))
        if not request.get("_locked"):
            self.idle(profile)
        selected = self.files(profile, request.get("scopes", ["state"]))
        ident = "backup_" + uuid.uuid4().hex
        directory = self.home / "backups"
        no_links(directory)
        directory.mkdir(exist_ok=True)
        target = directory / (ident + ".tmp")
        no_links(target)
        metadata = {"version": 1, "packageHash": self.package_hash, "profile": profile["name"], "createdAt": now(), "files": []}
        secrets = secrets_in(self.environment(profile))
        with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
            with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for scope, path, name in selected:
                    data = path.read_bytes()
                    if any(secret.encode("utf-8") in data for secret in secrets):
                        raise OperationsFault("백업 대상에 로컬 비밀 값이 포함돼 있어요. 먼저 제거해 주세요.")
                    member = scope + "/" + name
                    archive.writestr(member, data)
                    metadata["files"].append({"path": member, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)})
                archive.writestr("manifest.json", canonical(metadata))
        os.replace(target, target.with_suffix(".zip"))
        return {"backupId": ident, "files": len(selected), "scopes": request.get("scopes", ["state"])}

    def restore(self, request):
        if request.get("confirm") is not True:
            raise OperationsFault("복원에는 confirm=true가 필요해요.")
        profile = self.profile(request.get("profile", "development"))
        if not request.get("_locked"):
            self.idle(profile)
        source = self.home / "backups" / (safe_id(request.get("backupId")) + ".zip")
        no_links(source)
        prepared = []
        write_capable = any(tool.get("effect") == "write" for connection in self.package.get("connections", []) for tool in connection.get("tools", []))
        read_only_runs = 0
        with zipfile.ZipFile(source) as archive:
            infos = archive.infolist()
            if len(infos) > 5001 or sum(item.file_size for item in infos) > 100_000_000 or any(item.file_size > 16_000_000 for item in infos):
                raise OperationsFault("백업 크기가 복원 한도를 넘었어요.")
            metadata = json.loads(archive.read("manifest.json"))
            if metadata.get("packageHash") != self.package_hash or metadata.get("profile") != profile["name"] or metadata.get("version") != 1:
                raise OperationsFault("같은 패키지와 프로필의 백업만 복원할 수 있어요.")
            if len({item.filename for item in infos}) != len(infos) or {item.filename for item in infos} != {"manifest.json"} | {item["path"] for item in metadata["files"]}:
                raise OperationsFault("백업 목록과 파일이 일치하지 않아요.")
            for item in metadata["files"]:
                scope, separator, name = item["path"].partition("/")
                if not separator or any(part.startswith(".") for part in name.split("/")) or ".env" in Path(name).name.lower() or Path(name).suffix.lower() in (".pem", ".key", ".p12", ".pfx"):
                    raise OperationsFault("백업 파일 경계가 올바르지 않아요.")
                directory = self.scope(profile, scope)
                target = relative(directory, name)
                if target.exists():
                    raise OperationsFault("복원 대상 파일이 이미 있어요. 빈 대상에만 복원할 수 있어요.")
                data = archive.read(item["path"])
                if len(data) != item["size"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
                    raise OperationsFault("백업 파일의 무결성 검사가 실패했어요.")
                if scope == "state" and re.fullmatch(r"run_[A-Za-z0-9_-]+\.json", name):
                    record = json.loads(data)
                    if record.get("packageHash") != self.package_hash or not isinstance(record.get("run"), dict):
                        raise OperationsFault("복원 실행 기록의 패키지와 형식을 확인해 주세요.")
                    if write_capable:
                        record["run"]["restoredReadOnly"] = True
                        data = canonical(record).encode("utf-8")
                        read_only_runs += 1
                prepared.append((target, data))
        created = []
        try:
            for target, data in prepared:
                target.parent.mkdir(parents=True, exist_ok=True)
                no_links(target)
                with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                created.append(target)
        except BaseException:
            for target in created:
                target.unlink(missing_ok=True)
            raise
        return {"status": "restored", "files": len(prepared), "readOnlyRuns": read_only_runs}

    def prune(self, request):
        days = request.get("olderThanDays")
        if request.get("confirm") is not True or type(days) is not int or not 1 <= days <= 3650:
            raise OperationsFault("정리 기간은 1~3650일이며 confirm=true가 필요해요.")
        profile = self.profile(request.get("profile", "development"))
        if not request.get("_locked"):
            self.idle(profile)
        selected = self.files(profile, request.get("scopes", ["state"]))
        cutoff, removed = time.time() - days * 86400, []
        for scope, path, name in selected:
            if path.stat().st_mtime >= cutoff:
                continue
            if scope == "state":
                if not re.fullmatch(r"run_[A-Za-z0-9_-]+\.json", name):
                    continue  # Memory/vector ledgers are never age-pruned.
                record = read_json(path)
                if record.get("packageHash") != self.package_hash or record.get("run", {}).get("status") not in TERMINAL:
                    continue
            no_links(path)
            path.unlink()
            removed.append(scope + "/" + name)
        return {"removed": removed}

    def evaluate(self, request):
        profile = self.profile(request.get("profile", "development"))
        self.confirm(request, profile)
        dataset = read_json(relative(self.root, request.get("dataset")), 1_000_000)
        cases = dataset.get("cases") if isinstance(dataset, dict) else None
        if not isinstance(cases, list) or not 1 <= len(cases) <= 100:
            raise OperationsFault("평가 자료는 cases 배열에 1~100개 사례를 넣어 주세요.")
        seen = set()
        for case in cases:
            if not isinstance(case, dict) or set(case) - {"id", "input", "expected", "contains"} or not ID.fullmatch(str(case.get("id", ""))) or case["id"] in seen or not isinstance(case.get("input"), str) or not 1 <= len(case["input"]) <= 12000 or not isinstance(case.get("contains", []), list) or len(case.get("contains", [])) > 20 or any(not isinstance(item, str) or len(item) > 2000 for item in case.get("contains", [])) or "expected" in case and not isinstance(case["expected"], str):
                raise OperationsFault("평가 사례의 ID·입력·expected·contains 형식을 확인해 주세요.")
            seen.add(case["id"])
        ident = "evaluation_" + uuid.uuid4().hex
        record = {"id": ident, "profile": profile["name"], "packageHash": self.package_hash, "createdAt": now(), "status": "running", "results": []}
        target = self.home / "evaluations" / (ident + ".json")
        atomic_json(target, record)
        for case in cases:
            queued = self.enqueue({"profile": profile["name"], "input": case["input"], "confirmProduction": request.get("confirmProduction")})["job"]
            # Evaluate the exact case in an isolated serial queue turn. Existing jobs
            # are not silently run as part of evaluation.
            with self.db() as db:
                other = db.execute("SELECT 1 FROM jobs WHERE status IN ('queued','dispatching','running') AND id<>?", (queued["id"],)).fetchone()
            if other:
                self.dispatch({"action": "jobs.cancel", "jobId": queued["id"]})
                record.update(status="blocked", error="다른 대기 작업을 먼저 처리한 다음 평가를 시작해 주세요.")
                atomic_json(target, record)
                return record
            self.worker(once=True)
            job = self.job(queued["id"])
            result = self.cli(profile, ["status", job["runId"]]) if job["runId"] else {}
            text = result.get("result", "")
            passed = job["status"] == "succeeded" and ("expected" not in case or text == case["expected"]) and all(item in text for item in case.get("contains", []))
            estimate = self.estimate(profile, job["runId"]) if job["runId"] else {"status": "unconfigured", "label": "실행 기록을 확인할 수 없어 비용을 추정하지 않아요."}
            record["results"].append({"caseId": case["id"], "jobId": job["id"], "runId": job["runId"], "status": job["status"], "passed": passed,
                                      "usage": {key: result.get("usage", {}).get(key, 0) for key in ("tokens", "turns", "toolCalls", "activeMs")},
                                      "provider": result.get("provider", {}), "estimate": estimate})
            record["summary"] = evaluation_summary(record["results"], len(cases))
            atomic_json(target, record)
            if job["status"] not in TERMINAL:
                record["status"] = "blocked"
                break
        else:
            record["status"] = "completed"
        record["summary"] = evaluation_summary(record["results"], len(cases))
        atomic_json(target, record)
        return record

    def estimate(self, profile, ident, model=None):
        run = self.raw_run(profile, ident)
        fixed = run.get("provider") or {}
        model = fixed.get("model") or fixed.get("embeddingModel") or model
        mixed = bool(fixed.get("model") and fixed.get("embeddingModel"))
        with self.db() as db:
            price = db.execute("SELECT * FROM prices WHERE model=?", (model,)).fetchone()
        tokens = run.get("checkpoint", {}).get("tokens", 0)
        if type(tokens) is not int or tokens < 0:
            raise OperationsFault("실행 토큰 기록을 확인할 수 없어요.")
        if not price:
            return {"status": "unconfigured", "model": model, "totalTokens": tokens, "label": "수동 단가 추정 · 실제 청구 아님"}
        if mixed:
            return {"status": "mixed_models", "model": model, "models": [fixed["model"], fixed["embeddingModel"]], "totalTokens": tokens, "label": "모델별 토큰 분리가 없어 금액을 확정하지 않아요. 수동 제공자 사용량을 확인해 주세요."}
        low, high = sorted((price["input_rate"], price["output_rate"]))
        return {"status": "estimated", "model": model, "totalTokens": tokens, "range": {"minimum": tokens * low / 1_000_000, "maximum": tokens * high / 1_000_000}, "currency": price["currency"], "asOf": price["as_of"], "label": "수동 단가 추정 · 실제 청구 아님", "limitations": "전체 토큰만 저장되어 입력·출력 비율은 범위로 표시해요. 검색·도구 요금과 여러 모델 사용분은 별도 확인이 필요해요."}

    def dispatch(self, request):
        if not isinstance(request, dict):
            raise OperationsFault("운영 요청은 JSON 객체여야 해요.")
        self.assert_package()
        action = request.get("action")
        if action == "profiles.list":
            with self.db() as db:
                names = [row[0] for row in db.execute("SELECT name FROM profiles ORDER BY name")]
            return {"profiles": [self.profile(name) for name in names]}
        if action == "profiles.set":
            name, env = request.get("name"), request.get("env")
            if not isinstance(name, str) or not PROFILE.fullmatch(name) or not isinstance(env, str) or not (Path(env).name.startswith(".env") or env.endswith(".env")) or type(request.get("production", False)) is not bool:
                raise OperationsFault("프로필 이름과 로컬 .env 경로를 확인해 주세요.")
            relative(self.root, env)
            if request.get("production") and request.get("confirmProduction") is not True:
                raise OperationsFault("운영 프로필 등록에는 confirmProduction=true가 필요해요.")
            with self.db() as db:
                db.execute("BEGIN IMMEDIATE")
                if db.execute("SELECT 1 FROM jobs WHERE profile=? AND status IN ('queued','dispatching','running')", (name,)).fetchone():
                    raise OperationsFault("대기 또는 실행 작업이 있는 프로필은 설정을 바꿀 수 없어요.")
                directory = relative(self.root, f".flowly-profiles/{name}/runs")
                if (directory / ".runner.lock").exists() or (directory / ".unlock.lock").exists():
                    raise OperationsFault("실행기 잠금이 있는 프로필은 설정을 바꿀 수 없어요.")
                db.execute("INSERT INTO profiles VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET env=excluded.env,production=excluded.production", (name, env, int(request.get("production", False))))
            return {"profile": self.profile(name)}
        if action == "jobs.list":
            with self.db() as db:
                ids = [row[0] for row in db.execute("SELECT id FROM jobs ORDER BY created DESC,id DESC LIMIT 200")]
            return {"jobs": [self.job(ident) for ident in ids]}
        if action in ("jobs.enqueue", "runs.resume"):
            return self.enqueue(request, resume=action == "runs.resume")
        if action == "jobs.cancel":
            ident = safe_id(request.get("jobId"))
            job = self.job(ident)
            with self.db() as db:
                db.execute("UPDATE jobs SET cancel_requested=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated=? WHERE id=? AND status IN ('queued','dispatching','running')", (now(), ident))
                row = db.execute("SELECT input_path FROM jobs WHERE id=?", (ident,)).fetchone()
            if job["status"] == "queued" and row["input_path"]:
                relative(self.root, row["input_path"]).unlink(missing_ok=True)
            if job["status"] in ("dispatching", "running"):
                atomic_json(self.home / "cancel" / (ident + ".json"), {"cancelled": True})
            return {"job": self.job(ident)}
        if action in ("runs.list", "runs.status", "runs.decision", "runs.submit_input", "check"):
            profile = self.profile(request.get("profile", "development"))
            if action == "runs.list":
                return {"runs": self.runs(profile)}
            if action == "check":
                return self.cli(profile, ["check"])
            ident = safe_id(request.get("runId"))
            if action == "runs.status":
                return self.cli(profile, ["status", ident])
            self.confirm(request, profile)
            if action == "runs.submit_input":
                if not isinstance(request.get("values"), dict) or len(canonical(request["values"]).encode()) > 200000:
                    raise OperationsFault("추가 입력은 200KB 이하 JSON 객체로 전달해 주세요.")
                path = self.home / ("input_" + uuid.uuid4().hex + ".json")
                atomic_json(path, scrub(request["values"], secrets_in(self.environment(profile))))
                try:
                    return self.cli(profile, ["submit", ident, safe_id(request.get("requestId")), "--values-file", str(path)])
                finally:
                    path.unlink(missing_ok=True)
            decision = request.get("decision")
            if decision not in ("approve", "deny", "accept", "reject"):
                raise OperationsFault("승인·거절·검토 결정을 확인해 주세요.")
            args = [decision, ident, safe_id(request.get("decisionId"))]
            path = None
            if "editedInput" in request:
                if decision != "accept" or not isinstance(request["editedInput"], dict) or len(canonical(request["editedInput"]).encode()) > 200000:
                    raise OperationsFault("수정 입력은 검토 승인에서 200KB 이하 객체로 전달해 주세요.")
                path = self.home / ("edit_" + uuid.uuid4().hex + ".json")
                atomic_json(path, scrub(request["editedInput"], secrets_in(self.environment(profile))))
                args += ["--edited-input-file", str(path)]
            try:
                return self.cli(profile, args)
            finally:
                if path:
                    path.unlink(missing_ok=True)
        if action == "probe":
            return self.probe(request)
        if action == "backup":
            profile = self.profile(request.get("profile", "development"))
            with self.maintenance(profile, bool(set(request.get("scopes", ["state"])) & {"outputs", "reports"})):
                return self.backup({**request, "_locked": True})
        if action == "restore":
            profile = self.profile(request.get("profile", "development"))
            with self.maintenance(profile, True):
                return self.restore({**request, "_locked": True})
        if action == "prune":
            profile = self.profile(request.get("profile", "development"))
            with self.maintenance(profile, bool(set(request.get("scopes", ["state"])) & {"outputs", "reports"})):
                return self.prune({**request, "_locked": True})
        if action == "evaluate":
            return self.evaluate(request)
        if action == "compare":
            current = read_json(self.home / "evaluations" / (safe_id(request.get("evaluationId")) + ".json"))
            baseline = read_json(relative(self.root, request["baselineFile"]), 1_000_000) if request.get("baselineFile") else read_json(self.home / "evaluations" / (safe_id(request.get("baselineId")) + ".json"))
            if not isinstance(baseline, dict) or not isinstance(baseline.get("results"), list) or len(baseline["results"]) > 100 or any(not isinstance(item, dict) or not isinstance(item.get("caseId"), str) or type(item.get("passed")) is not bool for item in baseline["results"]):
                raise OperationsFault("이전 평가 결과 파일의 results 형식을 확인해 주세요.")
            previous = {item["caseId"]: item for item in baseline["results"]}
            cases = [{"caseId": item["caseId"], "passed": item["passed"], "baselinePassed": previous.get(item["caseId"], {}).get("passed"), "regression": previous.get(item["caseId"], {}).get("passed") is True and not item["passed"],
                      "deltaTokens": item.get("usage", {}).get("tokens", 0) - previous.get(item["caseId"], {}).get("usage", {}).get("tokens", 0),
                      "deltaActiveMs": item.get("usage", {}).get("activeMs", 0) - previous.get(item["caseId"], {}).get("usage", {}).get("activeMs", 0)} for item in current["results"]]
            current_summary, baseline_summary = evaluation_summary(current["results"]), evaluation_summary(baseline["results"])
            delta = {key: current_summary[key] - baseline_summary[key] if current_summary[key] is not None and baseline_summary[key] is not None else None for key in ("passRate", "failureRate", "totalTokens", "activeMs")}
            current_cost, baseline_cost = current_summary["cost"], baseline_summary["cost"]
            if current_cost.get("status") == baseline_cost.get("status") == "estimated" and current_cost.get("currency") == baseline_cost.get("currency"):
                delta["cost"] = {"currency": current_cost["currency"], "minimum": current_cost["minimum"] - baseline_cost["maximum"], "maximum": current_cost["maximum"] - baseline_cost["minimum"]}
            else:
                delta["cost"] = None
            return {"summary": {"compared": len(cases), "regressions": sum(item["regression"] for item in cases), "current": current_summary, "baseline": baseline_summary, "delta": delta}, "cases": cases, "packageHashes": {"current": current.get("packageHash"), "baseline": baseline.get("packageHash")}}
        if action == "prices.set":
            model, currency, date = request.get("model"), request.get("currency"), request.get("asOf")
            rates = [request.get("inputPerMillion"), request.get("outputPerMillion")]
            if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,100}", model) or not isinstance(currency, str) or not re.fullmatch(r"[A-Z]{3}", currency) or not isinstance(date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date) or any(type(rate) not in (int, float) or not math.isfinite(rate) or not 0 <= rate <= 1_000_000 for rate in rates):
                raise OperationsFault("모델·통화·기준일·백만 토큰당 수동 단가를 확인해 주세요.")
            datetime.strptime(date, "%Y-%m-%d")
            with self.db() as db:
                db.execute("INSERT INTO prices VALUES(?,?,?,?,?) ON CONFLICT(model) DO UPDATE SET input_rate=excluded.input_rate,output_rate=excluded.output_rate,currency=excluded.currency,as_of=excluded.as_of", (model, *rates, currency, date))
            return {"price": {key: request[key] for key in ("model", "inputPerMillion", "outputPerMillion", "currency", "asOf")}}
        if action == "prices.estimate":
            return self.estimate(self.profile(request.get("profile", "development")), request.get("runId"), request.get("model"))
        if action == "bills.import":
            path = relative(self.root, request.get("path"))
            if path.suffix.lower() != ".csv" or path.stat().st_size > 1_000_000:
                raise OperationsFault("수동 청구 자료는 1MB 이하 CSV여야 해요.")
            rows = list(csv.DictReader(path.read_text(encoding="utf-8-sig").splitlines()))
            if not 1 <= len(rows) <= 1000:
                raise OperationsFault("청구 CSV에는 1~1000개 행이 필요해요.")
            prepared = []
            for row in rows:
                if not {"start", "end", "model", "amount", "currency"} <= set(row):
                    raise OperationsFault("청구 CSV 열은 start,end,model,amount,currency가 필요해요.")
                for key in ("start", "end"):
                    datetime.strptime(row[key], "%Y-%m-%d")
                amount = float(row["amount"])
                if row["end"] < row["start"] or not math.isfinite(amount) or amount < 0 or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,100}", row["model"]) or not re.fullmatch(r"[A-Z]{3}", row["currency"]):
                    raise OperationsFault("청구 자료의 기간·모델·금액·통화를 확인해 주세요.")
                ident = hashlib.sha256(canonical(row).encode()).hexdigest()
                prepared.append((ident, row["start"], row["end"], row["model"], amount, row["currency"], None, None))
            with self.db() as db:
                db.executemany("INSERT OR IGNORE INTO bills VALUES(?,?,?,?,?,?,?,?)", prepared)
            return {"rows": len(prepared)}
        if action == "bills.compare":
            profile = self.profile(request.get("profile", "development"))
            if request.get("runId"):
                estimate = self.estimate(profile, request["runId"], request.get("model"))
            else:
                for key in ("start", "end"):
                    datetime.strptime(request[key], "%Y-%m-%d")
                if request["end"] < request["start"]:
                    raise OperationsFault("비교 기간의 시작과 끝을 확인해 주세요.")
                estimates, excluded = [], 0
                for run in self.runs(profile):
                    if request["start"] <= run["createdAt"][:10] <= request["end"]:
                        record = self.raw_run(profile, run["id"])
                        if request.get("model") not in set((record.get("provider") or {}).values()):
                            excluded += 1
                            continue
                        estimates.append(self.estimate(profile, run["id"]))
                valid = [item for item in estimates if item.get("status") == "estimated"]
                currencies = {item["currency"] for item in valid}
                complete = bool(valid) and len(valid) == len(estimates) and len(currencies) == 1
                estimate = {"status": "estimated" if complete else "unconfigured", "model": request.get("model"), "runCount": len(valid), "excludedRuns": excluded + len(estimates) - len(valid), "totalTokens": sum(item["totalTokens"] for item in valid), "currency": next(iter(currencies)) if len(currencies) == 1 else None, "range": {"minimum": sum(item["range"]["minimum"] for item in valid), "maximum": sum(item["range"]["maximum"] for item in valid)}, "label": "프로필·고정 모델·UTC 시작일 기준 기간 추정 합계 · 실제 청구 아님"}
            with self.db() as db:
                rows = db.execute("SELECT amount,currency FROM bills WHERE model=? AND start=? AND end=?", (request.get("model"), request.get("start"), request.get("end"))).fetchall()
            currency = estimate.get("currency")
            compatible = bool(rows) and estimate.get("status") == "estimated" and all(row["currency"] == currency for row in rows)
            billed = sum(row["amount"] for row in rows) if compatible else None
            return {"estimate": estimate, "billed": billed, "currency": currency, "difference": {"minimum": billed - estimate["range"]["maximum"], "maximum": billed - estimate["range"]["minimum"]} if compatible else None, "label": "수동 청구 자료 비교 · 다른 프로필/프로젝트·검색·도구 요금·시간 기준 차이는 포함되지 않을 수 있어요."}
        raise OperationsFault("지원하지 않는 운영 작업이에요.")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Flowly 로컬 운영 도구 · check 외 네트워크 호출은 명시적 실행에서만 발생합니다.")
    parser.add_argument("command", choices=("request", "worker"))
    parser.add_argument("--root", default=".")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--request-file")
    args = parser.parse_args(argv)
    try:
        operations = Operations(args.root)
        def stop(_signum, _frame):
            operations.stop.set()
        signal.signal(signal.SIGINT, stop)
        signal.signal(signal.SIGTERM, stop)
        if args.command == "worker":
            result = operations.worker(args.once)
        else:
            if args.request_file:
                path = relative(operations.root, args.request_file)
                if path.suffix.lower() != ".json" or path.name.startswith(".env") or path.stat().st_size > 1_000_000:
                    raise OperationsFault("운영 요청 파일은 프로젝트 안의 1MB 이하 JSON 파일이어야 해요.")
                raw = path.read_bytes()
            else:
                raw = sys.stdin.buffer.read(1_000_001)
            if len(raw) > 1_000_000:
                raise OperationsFault("운영 요청은 1MB 이하여야 해요.")
            result = operations.dispatch(json.loads(raw))
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0
    except OperationsFault as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 1
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error, zipfile.BadZipFile):
        print(json.dumps({"error": "운영 설정 또는 기록 형식을 확인해 주세요. 비밀 값은 출력하지 않아요."}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
