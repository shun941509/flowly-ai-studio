# 사용자가 시작한 로컬 일정/이벤트/웹훅을 실제 실행기로 전달한다. SQLite 영수증으로 중복 수신 상태를 추적한다.
"""User-started local schedules and authenticated event/webhook listener. Stdlib only."""
from __future__ import annotations
import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import re
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time

class TriggerFault(Exception): pass

def no_links(path):
    for part in (path, *path.parents):
        try: reparse = bool(getattr(part.lstat(), "st_file_attributes", 0) & 0x400)
        except FileNotFoundError: reparse = False
        if part.is_symlink() or reparse:
            raise TriggerFault("트리거 상태·패키지 경로에 심볼릭 링크를 사용할 수 없어요.")

# 진입 블록이 trigger인 패키지만 허용한다. 임의 JSON을 일정 작업 명령으로 해석하지 않는다.
def read_package(path):
    no_links(path)
    raw = path.read_bytes()
    if len(raw) > 8_000_000:
        raise TriggerFault("실행 프로젝트 파일이 너무 커요.")
    package = json.loads(raw)
    if package.get("format") != "flowly-executable-export" or package.get("version") != 1 or package.get("language") not in ("node", "python"):
        raise TriggerFault("내보낸 Node 또는 Python 실행 프로젝트를 지정해 주세요.")
    nodes = package["workflow"]["definition"]["nodes"]
    entries = [n for n in nodes if n["type"] in ("trigger", "input") or n["type"] == "form" and n.get("form", {}).get("mode", "initial") == "initial"]
    if len(entries) != 1 or entries[0]["type"] != "trigger":
        raise TriggerFault("자동 시작 블록이 있는 워크플로를 내보내 주세요.")
    config = entries[0]["trigger"]
    if config.get("kind") not in ("schedule", "webhook", "event") or type(config.get("intervalSeconds")) is not int or not 1 <= config["intervalSeconds"] <= 86400:
        raise TriggerFault("자동 시작 설정이 올바르지 않아요.")
    return package, config, hashlib.sha256(raw).hexdigest()

def load_secret(path):
    no_links(path)
    if not path.is_file() or path.stat().st_size > 64000:
        raise TriggerFault("트리거 미설정: .env에 FLOWLY_TRIGGER_SECRET을 설정해 주세요.")
    value = ""
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        match = re.match(r"^\s*(?:export\s+)?FLOWLY_TRIGGER_SECRET\s*=\s*(.*?)\s*$", line)
        if match:
            value = match[1].strip().strip("\"'")
    if len(value) < 32:
        raise TriggerFault("FLOWLY_TRIGGER_SECRET은 무작위 32자 이상이어야 해요.")
    return value.encode("utf-8")

# 타임스탬프와 원문 본문을 HMAC에 묶고 시간 차이를 검사한다. 이벤트 중복은 영수증으로 별도 관리한다.
def authenticate(secret, stamp, signature, body, now=None):
    if not isinstance(stamp, str) or not re.fullmatch(r"[0-9]{10,12}", stamp) or abs((now or time.time()) - int(stamp)) > 300:
        return False
    expected = hmac.new(secret, stamp.encode() + b"." + body, hashlib.sha256).hexdigest()
    return bool(isinstance(signature, str) and re.fullmatch(r"[a-f0-9]{64}", signature) and hmac.compare_digest(signature, expected))

class Launcher:
    def __init__(self, package_path, env_path, state, node="node", python=None):
        self.package_path = Path(package_path).absolute()
        self.root = self.package_path.parent
        self.env_path = Path(env_path).absolute()
        self.state = Path(state).absolute()
        no_links(self.state)
        self.state.mkdir(parents=True, exist_ok=True)
        self.package, self.config, self.package_hash = read_package(self.package_path)
        self.agent_path = self.root / "agent-manifest.json"
        no_links(self.agent_path)
        if self.agent_path.exists() and self.agent_path.stat().st_size > 1_000_000:
            raise TriggerFault("Agent 실행 구성이 너무 커요.")
        self.agent_hash = hashlib.sha256(self.agent_path.read_bytes()).hexdigest() if self.agent_path.exists() else None
        self.entrypoint = "runner.mjs" if self.package["language"] == "node" else "runner.py"
        if self.agent_hash is not None:
            try:
                agent = json.loads(self.agent_path.read_text(encoding="utf-8"))
                expected = "agent.mjs" if self.package["language"] == "node" else "agent.py"
                if agent.get("format") != "flowly-agent-project" or agent.get("version") != 1 or agent.get("language") != self.package["language"] or agent.get("entrypoint") != expected or agent.get("workflow") != "workflow.json" or self.package_path.name != "workflow.json":
                    raise ValueError()
                self.entrypoint = expected
            except (ValueError, AttributeError):
                raise TriggerFault("Agent 실행 구성이 올바르지 않아요. 다시 내보내 주세요.") from None
        self.command = [node, str(self.root / self.entrypoint)] if self.package["language"] == "node" else [python or sys.executable, "-X", "utf8", str(self.root / self.entrypoint)]
        self.run_state = self.root / (".flowly-runs" if self.package["language"] == "node" else ".flowly-python-runs")
        self.database = self.state / "receipts.sqlite"
        no_links(self.database)
        with self.db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, digest TEXT NOT NULL, status TEXT NOT NULL, run_id TEXT, created REAL NOT NULL)")
            previous = db.execute("SELECT value FROM metadata WHERE key='package' ").fetchone()
            if previous and previous[0] != self.package_hash:
                raise TriggerFault("트리거가 사용하는 패키지가 변경됐어요. 원본을 복구하거나 새 트리거 상태 폴더를 지정해 주세요.")
            db.execute("INSERT OR IGNORE INTO metadata VALUES ('package',?)", (self.package_hash,))
            execution = self.entrypoint + ":" + (self.agent_hash or "runtime")
            previous_execution = db.execute("SELECT value FROM metadata WHERE key='execution'").fetchone()
            if previous_execution and previous_execution[0] != execution:
                raise TriggerFault("실행 진입점이 변경됐어요. 원본을 복구하거나 새 트리거 상태 폴더를 지정해 주세요.")
            db.execute("INSERT OR IGNORE INTO metadata VALUES ('execution',?)", (execution,))
            db.commit()
    def db(self):
        return closing(sqlite3.connect(self.database, timeout=5))
    def assert_package(self):
        no_links(self.package_path)
        if hashlib.sha256(self.package_path.read_bytes()).hexdigest() != self.package_hash:
            raise TriggerFault("패키지가 변경되어 자동 시작을 중단했어요.")
        no_links(self.agent_path)
        current = hashlib.sha256(self.agent_path.read_bytes()).hexdigest() if self.agent_path.exists() else None
        if current != self.agent_hash:
            raise TriggerFault("Agent 실행 구성이 변경되어 자동 시작을 중단했어요.")
    def cli(self, args):
        self.assert_package()
        # Do not inherit provider keys; the runner reads only its explicit local env file.
        child_env = {k: os.environ[k] for k in ("PATH", "SystemRoot", "TEMP", "TMP", "PATHEXT", "VIRTUAL_ENV") if k in os.environ}
        timeout = min(610, max(15, self.package.get("limits", {}).get("maxDurationMs", 120000) / 1000 + 10))
        try:
            package_options = [] if self.agent_hash is not None else ["--package", str(self.package_path)]
            result = subprocess.run(self.command + args + package_options + ["--state", str(self.run_state), "--env", str(self.env_path)], cwd=self.root, env=child_env, capture_output=True, timeout=timeout)
            if len(result.stdout) > 2_000_000:
                raise TriggerFault("실행기의 상태 응답이 너무 커요.")
            value = json.loads(result.stdout.decode("utf-8-sig"))
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (OSError, ValueError, subprocess.TimeoutExpired):
            raise TriggerFault("실행기 결과를 확인하지 못했어요. 실행 기록을 직접 확인하고 같은 이벤트를 자동 재실행하지 마세요.") from None
    def receipts(self):
        with self.db() as db:
            return [{"eventId": r[0], "status": r[1], "runId": r[2]} for r in db.execute("SELECT id,status,run_id FROM receipts ORDER BY created DESC LIMIT 100")]
    def refresh_pending(self):
        with self.db() as db:
            pending = db.execute("SELECT id,status,run_id FROM receipts WHERE status IN ('dispatching','unknown_outcome','running','queued','waiting_review','waiting_approval','waiting_input')").fetchall()
        for event_id, status, run_id in pending:
            if not run_id or status in ("dispatching", "unknown_outcome"):
                raise TriggerFault("이전 자동 실행의 결과 확인이 필요해요. 저장된 실행·트리거 기록을 확인해 주세요.")
            current = self.cli(["status", run_id])
            with self.db() as db:
                db.execute("UPDATE receipts SET status=? WHERE id=?", (current.get("status", "unknown_outcome"), event_id))
                db.commit()
            if current.get("status") not in ("succeeded", "failed", "cancelled", "expired", "budget_exceeded"):
                raise TriggerFault("이전 실행의 승인·검토·재개 또는 결과 확인이 필요해요.")
    # 이벤트를 기록하고 이미 처리한 이벤트는 재사용한다. 불명확한 외부 변경은 자동 반복하지 않는다.
    def dispatch(self, event_id, payload, digest=None):
        if not isinstance(event_id, str) or not re.fullmatch(r"[A-Za-z0-9_:\-.]{1,160}", event_id):
            raise TriggerFault("이벤트 ID는 160자 이하의 영문·숫자 식별자여야 해요.")
        input_text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False, allow_nan=False)
        if len(input_text.encode()) > 80000:
            raise TriggerFault("이벤트 입력은 80KB 이하로 보내 주세요.")
        digest = digest or hashlib.sha256(input_text.encode()).hexdigest()
        with self.db() as db:
            old = db.execute("SELECT digest,status,run_id FROM receipts WHERE id=?", (event_id,)).fetchone()
        if old:
            if not hmac.compare_digest(old[0], digest):
                raise TriggerFault("이미 받은 이벤트 ID의 내용이 달라요.")
            return {"eventId": event_id, "status": old[1], "runId": old[2], "duplicate": True}
        self.refresh_pending()
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM receipts WHERE status IN ('dispatching','unknown_outcome','running','queued','waiting_review','waiting_approval','waiting_input')").fetchone():
                raise TriggerFault("다른 자동 실행이 진행 중이에요.")
            try:
                db.execute("INSERT INTO receipts VALUES (?,?,'dispatching',NULL,?)", (event_id, digest, time.time()))
            except sqlite3.IntegrityError:
                raise TriggerFault("같은 이벤트가 이미 접수됐어요.") from None
            db.commit()
        fd, name = tempfile.mkstemp(prefix="input-", suffix=".json", dir=self.state)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(input_text)
            result = self.cli(["run", "--input-file", name])
            run_id, status = result.get("id"), result.get("status")
            if not isinstance(run_id, str) or status not in ("queued", "running", "succeeded", "failed", "cancelled", "expired", "budget_exceeded", "unknown_outcome", "waiting_approval", "waiting_review", "waiting_input"):
                raise TriggerFault("실행 응답을 확인하지 못했어요. 자동 재실행하지 않아요.")
            with self.db() as db:
                db.execute("UPDATE receipts SET status=?,run_id=? WHERE id=?", (status, run_id, event_id))
                db.commit()
            return {"eventId": event_id, "status": status, "runId": run_id, "duplicate": False}
        except BaseException:
            with self.db() as db:
                db.execute("UPDATE receipts SET status='unknown_outcome' WHERE id=? AND status='dispatching'", (event_id,))
                db.commit()
            raise
        finally:
            Path(name).unlink(missing_ok=True)

def server(launcher, port, secret):
    if launcher.config["kind"] not in ("webhook", "event"):
        raise TriggerFault("웹훅 또는 이벤트 자동 시작 방식을 선택해 주세요.")
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def reply(self, code, value):
            data = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
        def reject(self, code, value):
            # Preserve the error response when a rejected body arrives after headers.
            # Drain only a bounded amount/time; never parse or dispatch these bytes.
            self.close_connection = True
            self.reply(code, value)
            self.wfile.flush()
            try:
                self.connection.shutdown(socket.SHUT_WR)
                deadline, remaining = time.monotonic() + .1, 65536
                while remaining and time.monotonic() < deadline:
                    self.connection.settimeout(max(.001, deadline - time.monotonic()))
                    chunk = self.rfile.read1(min(8192, remaining))
                    if not chunk: break
                    remaining -= len(chunk)
            except OSError:
                pass
        def do_POST(self):
            self.connection.settimeout(10)
            if self.path != "/events": return self.reject(404, {"error": "경로를 확인해 주세요."})
            if self.headers.get("Transfer-Encoding") or self.headers.get("Content-Type", "").split(";")[0] != "application/json": return self.reject(415, {"error": "길이가 명시된 JSON 요청이 필요해요."})
            try:
                size = int(self.headers.get("Content-Length", "-1"))
                if not 1 <= size <= 100000: return self.reject(413, {"error": "요청 크기를 확인해 주세요."})
                body = self.rfile.read(size)
                if len(body) != size or not authenticate(secret, self.headers.get("X-Flowly-Timestamp"), self.headers.get("X-Flowly-Signature"), body): return self.reply(401, {"error": "이벤트 서명이 올바르지 않거나 만료됐어요."})
                event = json.loads(body)
                if not isinstance(event, dict) or set(event) != {"eventId", "type", "input"} or not isinstance(event["type"], str): return self.reply(400, {"error": "eventId, type, input을 포함한 이벤트가 필요해요."})
                if launcher.config["kind"] == "event" and event["type"] != launcher.config["eventType"]: return self.reply(422, {"error": "이 워크플로가 받는 이벤트 종류가 아니에요."})
                result = launcher.dispatch(event["eventId"], event["input"], hashlib.sha256(body).hexdigest())
                self.reply(200 if result["duplicate"] else 202, result)
            except TriggerFault as exc: self.reply(409, {"error": str(exc)})
            except (ValueError, TimeoutError): self.reply(400, {"error": "이벤트 JSON과 전송 시간을 확인해 주세요."})
    return HTTPServer(("127.0.0.1", port), Handler)

# 시각/주기의 이벤트를 로컬 루프에서 만든다. 중앙 웹에 상주 스케줄러를 등록하는 기능은 아니다.
def schedule(launcher, payload, max_runs, stopped=lambda: False):
    if launcher.config["kind"] != "schedule":
        raise TriggerFault("예약 자동 시작 방식을 선택해 주세요.")
    interval = launcher.config["intervalSeconds"]
    start = launcher.config.get("startAt", "")
    if start:
        parsed = datetime.fromisoformat(start.replace("Z", "+00:00"))
        if parsed.tzinfo is None: raise TriggerFault("예약 시작 시각에는 시간대가 필요해요.")
        initial = parsed.timestamp()
    else: initial = time.time()
    with launcher.db() as db:
        row = db.execute("SELECT value FROM metadata WHERE key='next_due'").fetchone()
        due = float(row[0]) if row else initial
        if not row:
            db.execute("INSERT INTO metadata VALUES ('next_due',?)", (str(due),))
            db.commit()
    for _ in range(max_runs):
        while time.time() < due:
            if stopped(): return
            time.sleep(min(0.2, due - time.time()))
        if stopped(): return
        event_id = "schedule:" + str(int(due * 1000))
        result = launcher.dispatch(event_id, payload)
        # Skip missed ticks instead of replaying a backlog after restart or a long job.
        due = max(due + interval, time.time() + interval)
        with launcher.db() as db:
            db.execute("INSERT OR REPLACE INTO metadata VALUES ('next_due',?)", (str(due),))
            db.commit()
        yield result

def main():
    parser = argparse.ArgumentParser(description="Flowly 로컬 자동 시작 · 웹 모델 호출 없음")
    parser.add_argument("command", choices=["serve", "schedule", "status"])
    parser.add_argument("--package", default="workflow.json")
    parser.add_argument("--env", default=".env")
    parser.add_argument("--state", default=".flowly-triggers")
    parser.add_argument("--node", default="node")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--port", type=int, default=8789)
    parser.add_argument("--max-runs", type=int, default=1)
    parser.add_argument("--input-file")
    args = parser.parse_args()
    stopped = False
    def stop(*_):
        nonlocal stopped
        stopped = True
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        launcher = Launcher(args.package, args.env, args.state, args.node, args.python)
        if args.command == "status":
            print(json.dumps({"receipts": launcher.receipts()}, ensure_ascii=False)); return 0
        # Single launcher process; stale locks require the user to check and remove only after exit.
        lock = launcher.state / ".launcher.lock"
        no_links(lock)
        try: fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError: raise TriggerFault("트리거 잠금이 있어요. 다른 실행기를 종료했는지 확인한 뒤 잠금 파일을 정리해 주세요.") from None
        with os.fdopen(fd, "w") as handle: handle.write(json.dumps({"pid": os.getpid()}))
        try:
            if args.command == "serve":
                if not 1024 <= args.port <= 65535: raise TriggerFault("포트는 1024~65535 범위로 지정해 주세요.")
                with server(launcher, args.port, load_secret(Path(args.env).absolute())) as listener:
                    listener.timeout = .25
                    print(json.dumps({"status": "listening", "url": f"http://127.0.0.1:{args.port}/events"}), flush=True)
                    while not stopped: listener.handle_request()
            else:
                if not 1 <= args.max_runs <= 100000: raise TriggerFault("최대 실행 횟수는 1~100000이에요.")
                payload = ""
                if args.input_file:
                    path = Path(args.input_file)
                    if path.stat().st_size > 80000: raise TriggerFault("예약 입력은 80KB 이하로 지정해 주세요.")
                    payload = path.read_text(encoding="utf-8-sig")
                for receipt in schedule(launcher, payload, args.max_runs, lambda: stopped): print(json.dumps(receipt, ensure_ascii=False), flush=True)
        finally: lock.unlink(missing_ok=True)
    except TriggerFault as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr); return 1
    except Exception:
        print(json.dumps({"error": "자동 시작에 실패했어요. 설정과 저장 경로를 확인해 주세요."}, ensure_ascii=False), file=sys.stderr); return 1
    return 0

if __name__ == "__main__": sys.exit(main())
