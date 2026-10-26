"""Local operations: real temp SQLite/files/subprocess; injected network, no keys."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import zipfile

SOURCE = Path(__file__).parents[1] / "export-runtime"
SPEC = importlib.util.spec_from_file_location("flowly_ops", SOURCE / "flowly_ops.py")
ops = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ops)


def manifest():
    return {"format": "flowly-executable-export", "version": 1, "language": "python", "owner": {"userId": "alice", "email": "alice@example.com", "displayName": "Alice"},
            "workflow": {"id": "flow", "name": "검증", "definition": {"schemaVersion": 5, "nodes": [{"id": "in", "type": "input", "title": "입력"}, {"id": "out", "type": "output", "title": "출력"}], "edges": [{"id": "edge", "source": "in", "target": "out"}]}},
            "resources": [], "connections": [], "limits": {"maxTurns": 8, "maxToolCalls": 12, "maxTokens": 8000, "maxDurationMs": 120000}}


class OperationsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "workflow.json").write_text(json.dumps(manifest()), encoding="utf-8")
        shutil.copyfile(SOURCE / "runner.py", self.root / "runner.py")
        self.ops = ops.Operations(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def request(self, action, **kwargs):
        return self.ops.dispatch({"action": action, "confirmProduction": True, **kwargs})

    def execute(self, text="확인한 입력", **kwargs):
        job = self.request("jobs.enqueue", input=text, **kwargs)["job"]
        self.ops.worker(once=True)
        return self.ops.job(job["id"])

    def test_operations_only_default_and_legacy_state_are_preserved(self):
        self.assertEqual(self.ops.profile()["name"], "production")
        self.assertTrue(self.ops.profile()["production"])
        with self.assertRaises(ops.OperationsFault):
            self.ops.dispatch({"action": "jobs.enqueue", "input": "confirmation required"})
        with self.assertRaises(ops.OperationsFault):
            self.request("profiles.set", name="bypass", env=".env", production=False)
        with self.ops.db() as db:
            db.execute("INSERT INTO profiles VALUES('development','.env.old',0)")
        old_state = self.root / ".flowly-profiles/development/runs"
        old_state.mkdir(parents=True)
        marker = old_state / "preserved.txt"
        marker.write_text("old history", encoding="utf-8")
        reopened = ops.Operations(self.root)
        legacy = reopened.profile("development")
        self.assertEqual(legacy["env"], ".env.old")
        self.assertEqual(legacy["state"], ".flowly-profiles/development/runs")
        self.assertTrue(legacy["production"])
        self.assertEqual(marker.read_text(encoding="utf-8"), "old history")
        with self.assertRaises(ops.OperationsFault):
            reopened.dispatch({"action": "jobs.enqueue", "profile": "development", "input": "no confirmation"})
        queued = reopened.dispatch({"action": "jobs.enqueue", "profile": "development", "input": "legacy history", "confirmProduction": True})["job"]
        reopened.worker(once=True)
        self.assertEqual(reopened.job(queued["id"])["status"], "succeeded")
        self.assertEqual(marker.read_text(encoding="utf-8"), "old history")

    def test_profiles_are_isolated_and_production_requires_explicit_confirmation(self):
        profile = self.request("profiles.set", name="production", env=".env.production", production=True, confirmProduction=True)["profile"]
        self.assertEqual(profile["state"], ".flowly-profiles/production/runs")
        with self.assertRaises(ops.OperationsFault):
            self.request("jobs.enqueue", profile="production", input="허용 안 됨", confirmProduction=False)
        with self.assertRaises(ops.OperationsFault):
            self.request("profiles.set", name="escape", env="../outside.env")
        queued = self.request("jobs.enqueue", profile="production", input="별도 실행", confirmProduction=True)["job"]
        with self.assertRaises(ops.OperationsFault):
            self.request("profiles.set", name="production", env=".env.changed")
        self.assertEqual(self.request("jobs.cancel", jobId=queued["id"])["job"]["status"], "cancelled")

    def test_real_native_check_and_queue_run_need_no_model_and_survive_reopen(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "ambient-must-not-pass"}), patch.object(ops.ProbeTransport, "post", side_effect=AssertionError("offline")):
            self.assertEqual(self.request("check")["status"], "ready")
            job = self.execute()
        self.assertEqual(job["status"], "succeeded", job)
        reopened = ops.Operations(self.root)
        self.assertEqual(reopened.job(job["id"])["runId"], job["runId"])
        result = self.request("runs.status", runId=job["runId"])
        self.assertEqual(result["result"], "확인한 입력")
        (self.root / ".env").write_text("invalid environment line", encoding="utf-8")
        self.assertEqual(self.request("runs.status", runId=job["runId"])["status"], "succeeded")
        self.assertEqual(len(self.request("runs.list")["runs"]), 1)
        self.assertFalse(list((self.root / ".flowly-ops" / "inputs").glob("*.txt")))

    def test_local_setup_keeps_credentials_on_disk_and_never_returns_secrets(self):
        package = manifest()
        package["workflow"]["definition"]["nodes"][0]["type"] = "agent"
        package["connections"] = [{"name": "사내 검색", "endpointEnv": "FLOWLY_MCP_ENDPOINT_LOCAL", "tokenEnv": "FLOWLY_MCP_TOKEN_LOCAL", "endpoint": ""}]
        (self.root / "workflow.json").write_text(json.dumps(package), encoding="utf-8")
        # The isolated second directory represents a newly exported project.
        second = self.root / "configured"
        second.mkdir()
        (second / "workflow.json").write_text(json.dumps(package), encoding="utf-8")
        configured = ops.Operations(second)
        (second / ".env").write_text("KEEP_SETTING=retained\n", encoding="utf-8")
        with patch.object(ops.ProbeTransport, "post", side_effect=AssertionError("offline")):
            value = configured.dispatch({"confirmProduction": True, "action": "setup.save", "values": {"OPENAI_API_KEY": "test-boundary-secret", "FLOWLY_MODEL": "test-model", "FLOWLY_MCP_ENDPOINT_LOCAL": "http://internal.example/mcp", "FLOWLY_MCP_TOKEN_LOCAL": "test-boundary-mcp"}})
        self.assertFalse(value["networkChecked"])
        self.assertNotIn("test-boundary-secret", json.dumps(value))
        self.assertNotIn("test-boundary-mcp", json.dumps(value))
        env = ops.load_env(second / ".env")
        self.assertEqual(env["KEEP_SETTING"], "retained")
        self.assertEqual(env["OPENAI_API_KEY"], "test-boundary-secret")
        configured.dispatch({"confirmProduction": True, "action": "setup.save", "values": {"OPENAI_API_KEY": "", "FLOWLY_MODEL": "changed-model"}})
        self.assertEqual(ops.load_env(second / ".env")["OPENAI_API_KEY"], "test-boundary-secret")
        misplaced = configured.dispatch({"confirmProduction": True, "action": "setup.save", "values": {"FLOWLY_MODEL": "test-boundary-secret"}})
        self.assertNotIn("test-boundary-secret", json.dumps(misplaced))
        with self.assertRaises(ops.OperationsFault):
            configured.dispatch({"confirmProduction": True, "action": "setup.save", "values": {"FLOWLY_PYTHON": "arbitrary program"}})
        with self.assertRaises(ops.OperationsFault):
            configured.dispatch({"confirmProduction": True, "action": "setup.save", "values": {"OPENAI_API_KEY": "line\nbreak"}})
        configured.dispatch({"confirmProduction": True, "action": "jobs.enqueue", "input": "queued"})
        with self.assertRaises(ops.OperationsFault):
            configured.dispatch({"confirmProduction": True, "action": "setup.save", "values": {"FLOWLY_MODEL": "race"}})

    def test_input_upload_preserves_original_and_rejects_paths_and_empty_files(self):
        first = self.ops.upload_input("자료.txt", "첫 자료".encode())
        second = self.ops.upload_input("자료.txt", "다음 자료".encode())
        self.assertNotEqual(first["path"], second["path"])
        self.assertEqual((self.root / first["projectPath"]).read_text(encoding="utf-8"), "첫 자료")
        for name in ("../outside.txt", ".env", "CON", "nested/file.txt", "bad\\file.txt"):
            with self.assertRaises(ops.OperationsFault): self.ops.upload_input(name, b"test")
        with self.assertRaises(ops.OperationsFault): self.ops.upload_input("empty.txt", b"")

    def test_setup_rejects_reserved_and_cross_role_aliases_before_reading_environment(self):
        for index, (field, alias) in enumerate((("endpointEnv", "OPENAI_API_KEY"), ("endpointEnv", "FLOWLY_MODEL"), ("endpointEnv", "FLOWLY_EMBEDDING_MODEL"), ("endpointEnv", "FLOWLY_MCP_TOKEN_OTHER"), ("tokenEnv", "FLOWLY_MODEL"), ("tokenEnv", "FLOWLY_MCP_ENDPOINT_OTHER"), ("endpointEnv", "FLOWLY_MCP_ENDPOINT_"))):
            with self.subTest(field=field, alias=alias):
                folder = self.root / f"invalid-{index}"
                folder.mkdir()
                package = manifest()
                package["connections"] = [{field: alias}]
                (folder / "workflow.json").write_text(json.dumps(package), encoding="utf-8")
                (folder / ".env").write_text("OPENAI_API_KEY=synthetic-local-secret\n", encoding="utf-8")
                operation = ops.Operations(folder)
                with patch.object(operation, "environment", side_effect=AssertionError("must not read any environment values")) as read:
                    for action in ("setup.status", "setup.save"):
                        with self.assertRaises(ops.OperationsFault): operation.dispatch({"action": action, "values": {}})
                    read.assert_not_called()

    def test_setup_blocks_every_profile_sharing_same_environment_file(self):
        self.request("profiles.set", name="second", env=".env")
        self.request("profiles.set", name="unrelated", env=".env.other")
        (self.root / ".env").write_text("KEEP_SETTING=unchanged\n", encoding="utf-8")
        job = self.request("jobs.enqueue", profile="second", input="shared setting consumer")["job"]
        for status in ("queued", "dispatching", "running"):
            with self.ops.db() as db: db.execute("UPDATE jobs SET status=? WHERE id=?", (status, job["id"]))
            with self.assertRaises(ops.OperationsFault): self.request("setup.save", values={})
            self.assertTrue(self.request("setup.save", profile="unrelated", values={})["saved"])
            self.assertEqual((self.root / ".env").read_text(encoding="utf-8"), "KEEP_SETTING=unchanged\n")
        with self.ops.db() as db: db.execute("UPDATE jobs SET status='cancelled' WHERE id=?", (job["id"],))
        state = self.ops.state(self.ops.profile("second"))
        state.mkdir(parents=True, exist_ok=True)
        for name in (".runner.lock", ".unlock.lock"):
            lock = state / name
            lock.write_text("test lock", encoding="utf-8")
            with self.assertRaises(ops.OperationsFault): self.request("setup.save", values={})
            lock.unlink()
        self.assertTrue(self.request("setup.save", values={})["saved"])

    def test_active_cancel_is_not_hidden_by_two_hundred_newer_queued_jobs(self):
        active = [self.request("jobs.enqueue", input="active")["job"] for _ in range(2)]
        with self.ops.db() as db:
            db.execute("UPDATE jobs SET status='running' WHERE id=?", (active[0]["id"],))
            db.execute("UPDATE jobs SET status='dispatching' WHERE id=?", (active[1]["id"],))
            for index in range(201):
                db.execute("INSERT INTO jobs(id,profile,priority,status,created,updated,command) VALUES(?,'production',0,'queued','2099-01-01','2099-01-01','run')", (f"newer_{index}",))
        self.assertTrue(all(job["status"] == "queued" for job in self.request("jobs.list")["jobs"]))
        cancelled = self.request("jobs.cancel_active")["jobs"]
        self.assertEqual({job["id"] for job in cancelled}, {job["id"] for job in active})
        self.assertTrue(all(job["cancelRequested"] for job in cancelled))
        self.assertTrue(all(not job["cancelRequested"] for job in self.request("jobs.list")["jobs"]))
        for job in active: self.assertTrue((self.ops.home / "cancel" / (job["id"] + ".json")).is_file())

    def test_output_download_is_bound_to_current_profile_run_and_recorded_outputs(self):
        job = self.execute()
        state = self.ops.state(self.ops.profile()) / (job["runId"] + ".json")
        record = json.loads(state.read_text(encoding="utf-8"))
        output = self.root / "outputs" / "result.txt"
        output.parent.mkdir()
        output.write_text("실제 결과 파일", encoding="utf-8")
        record["run"]["checkpoint"]["outputs"]["out"] = {"file": {"path": "outputs/result.txt"}}
        state.write_text(json.dumps(record), encoding="utf-8")
        listed = self.request("outputs.list", runId=job["runId"])
        self.assertEqual(listed["files"][0]["path"], "outputs/result.txt")
        downloaded = self.request("outputs.download", runId=job["runId"], path="outputs/result.txt")
        self.assertEqual(ops.base64.b64decode(downloaded["base64"]).decode(), "실제 결과 파일")
        for path in (".env", "../outside.txt", "outputs/other.txt"):
            with self.assertRaises(ops.OperationsFault): self.request("outputs.download", runId=job["runId"], path=path)

    def test_priority_fifo_and_cancelled_jobs_are_not_dispatched(self):
        a = self.request("jobs.enqueue", input="first", priority=1)["job"]
        b = self.request("jobs.enqueue", input="high", priority=5)["job"]
        c = self.request("jobs.enqueue", input="second", priority=1)["job"]
        self.request("jobs.cancel", jobId=c["id"])
        self.assertEqual(self.ops.worker(once=True)["processed"][0]["id"], b["id"])
        self.assertEqual(self.ops.worker(once=True)["processed"][0]["id"], a["id"])
        self.assertEqual(self.ops.worker(once=True)["processed"], [])

    def test_real_wait_submit_and_resume_with_typed_values_survive_reopen(self):
        root = self.root / "input-workflow"
        root.mkdir()
        data = manifest()
        data["workflow"]["definition"]["nodes"].insert(1, {"id": "form", "type": "form", "title": "추가 입력", "form": {"mode": "request", "fields": [
            {"key": "count", "label": "수량", "type": "number", "required": True}, {"key": "accepted", "label": "확인", "type": "boolean", "required": True}]}})
        data["workflow"]["definition"]["edges"] = [{"id": "start", "source": "in", "target": "form"}, {"id": "result", "source": "form", "target": "out"}]
        (root / "workflow.json").write_text(json.dumps(data), encoding="utf-8")
        shutil.copyfile(SOURCE / "runner.py", root / "runner.py")
        operation = ops.Operations(root)
        request = lambda action, **values: operation.dispatch({"action": action, "confirmProduction": True, **values})
        job = request("jobs.enqueue", input="확인 요청")["job"]
        operation.worker(once=True)
        waiting = operation.job(job["id"])
        self.assertEqual(waiting["status"], "waiting_input", waiting)
        run_id = waiting["runId"]
        run = request("runs.status", runId=run_id)
        request_id = run["inputRequests"][0]["id"]
        with self.assertRaises(ops.OperationsFault):
            request("runs.submit_input", runId=run_id, requestId=request_id, values={"count": "0", "accepted": False})
        self.assertEqual(request("runs.status", runId=run_id)["status"], "waiting_input")
        stored = request("runs.submit_input", runId=run_id, requestId=request_id, values={"count": 0, "accepted": False})
        self.assertEqual(stored["status"], "queued")
        self.assertFalse(list(operation.home.glob("input_*.json")))
        operation = ops.Operations(root)
        request("runs.resume", runId=run_id)
        operation.worker(once=True)
        result = request("runs.status", runId=run_id)
        self.assertEqual(result["id"], run_id)
        self.assertEqual(result["status"], "succeeded", result)
        self.assertEqual(json.loads(result["result"]), {"count": 0, "accepted": False})

    def test_queue_age_prevents_lower_priority_starvation(self):
        old = self.request("jobs.enqueue", input="old", priority=-100)["job"]
        self.request("jobs.enqueue", input="new", priority=100)
        with self.ops.db() as db:
            db.execute("UPDATE jobs SET created='2000-01-01T00:00:00Z' WHERE id=?", (old["id"],))
        self.assertEqual(self.ops.worker(once=True)["processed"][0]["id"], old["id"])

    def test_shared_maintenance_locks_other_profiles_and_pauses_worker_dispatch(self):
        self.request("profiles.set", name="other", env=".env.other")
        self.request("jobs.enqueue", profile="other", input="wait")
        with self.ops.maintenance(self.ops.profile(), shared=True):
            self.assertTrue((self.ops.state(self.ops.profile("other")) / ".runner.lock").exists())
            self.assertEqual(self.ops.worker(once=True)["processed"], [])
        self.assertEqual(self.ops.worker(once=True)["processed"][0]["status"], "succeeded")

    def test_worker_lock_and_crash_recovery_do_not_replay_dispatched_work(self):
        job = self.request("jobs.enqueue", input="work")["job"]
        with self.ops.worker_lock(), self.assertRaises(ops.OperationsFault):
            ops.Operations(self.root).worker(once=True)
        with self.ops.db() as db:
            db.execute("UPDATE jobs SET status='dispatching' WHERE id=?", (job["id"],))
        with patch.object(self.ops, "cli", side_effect=AssertionError("must not replay")):
            self.assertEqual(self.ops.worker(once=True)["processed"], [])
        self.assertEqual(self.ops.job(job["id"])["status"], "unknown_outcome")

    def test_running_cancel_writes_signal_immediately_and_worker_records_unknown_on_loss(self):
        job = self.request("jobs.enqueue", input="work")["job"]
        with self.ops.db() as db:
            db.execute("UPDATE jobs SET status='running' WHERE id=?", (job["id"],))
        self.request("jobs.cancel", jobId=job["id"])
        self.assertTrue((self.root / ".flowly-ops" / "cancel" / (job["id"] + ".json")).exists())
        with patch.object(self.ops, "cli", side_effect=AssertionError("must not retry")):
            self.ops.worker(once=True)
        self.assertEqual(self.ops.job(job["id"])["status"], "unknown_outcome")

    def test_native_cooperative_cancellation_records_cancelled_without_execution(self):
        profile = self.ops.profile()
        signal_file = self.root / "cancel.json"
        signal_file.write_text("{}", encoding="utf-8")
        result = self.ops.cli(profile, ["run", "--input", "not processed"], signal_file)
        self.assertEqual(result["status"], "cancelled")
        self.assertFalse(result["result"])
        self.assertEqual(result["usage"]["toolCalls"], 0)

    def test_jobs_reject_resume_of_unknown_or_terminal_and_duplicate_queue(self):
        job = self.execute()
        with self.assertRaises(ops.OperationsFault):
            self.request("runs.resume", runId=job["runId"])
        with patch.object(self.ops, "cli", return_value={"status": "queued"}):
            self.request("runs.resume", runId=job["runId"])
            with self.assertRaises(ops.OperationsFault):
                self.request("runs.resume", runId=job["runId"])

    def test_probe_requires_confirmation_and_never_inherits_ambient_credentials(self):
        with patch.object(ops.ProbeTransport, "post", side_effect=AssertionError("no configured key")), patch.dict(os.environ, {"OPENAI_API_KEY": "do-not-read"}):
            with self.assertRaises(ops.OperationsFault):
                self.request("probe", target="openai")
            result = self.request("probe", target="openai", confirm=True)
        self.assertEqual(result["checks"][0]["status"], "unconfigured")
        self.assertEqual(result["remoteCalls"]["openaiResponses"], 0)

    def test_openai_probe_counts_minimal_request_without_retaining_output_or_errors(self):
        (self.root / ".env").write_text("OPENAI_API_KEY=injected-test-key\nFLOWLY_MODEL=mock\n", encoding="utf-8")
        class Transport:
            def post(inner, endpoint, body, headers):
                self.assertEqual(endpoint, "https://api.openai.com/v1/responses")
                self.assertFalse(body["store"])
                self.assertEqual(body["max_output_tokens"], 16)
                self.assertNotIn("tools", body)
                return {"status": "completed", "usage": {"total_tokens": 3}, "output": [{"text": "private output"}]}, {}
        self.ops.transport = Transport()
        result = self.request("probe", target="openai", confirm=True)
        self.assertEqual(result["remoteCalls"]["openaiResponses"], 1)
        self.assertEqual(result["checks"][0]["usageTokens"], 3)
        self.assertNotIn("private output", json.dumps(result))
        with patch.object(self.ops.transport, "post", side_effect=ValueError("injected-test-key")):
            result = self.request("probe", target="openai", confirm=True)
        self.assertEqual(result["checks"][0]["status"], "failed")
        self.assertNotIn("injected-test-key", json.dumps(result))

    def test_mcp_probe_negotiates_lists_compares_schema_and_never_calls_tool(self):
        expected = {"toolName": "lookup", "inputSchema": {"type": "object"}, "effect": "read"}
        self.ops.package["connections"] = [{"id": "docs", "ownerId": "alice", "endpoint": "https://docs.example.com/mcp", "tools": [expected]}]
        methods = []
        class Transport:
            def post(inner, endpoint, body, headers, rpc_id, notification):
                methods.append(body["method"])
                result = {"protocolVersion": ops.PROTOCOL, "capabilities": {"tools": {}}} if body["method"] == "initialize" else {"tools": [{"name": "lookup", "inputSchema": {"type": "object", "required": ["newField"]}, "annotations": {"readOnlyHint": True}}]}
                return {"jsonrpc": "2.0", "id": rpc_id, "result": result}, {"Mcp-Session-Id": "session"}
        self.ops.transport = Transport()
        result = self.request("probe", target="mcp", confirm=True)
        self.assertEqual(methods, ["initialize", "notifications/initialized", "tools/list"])
        self.assertEqual(result["checks"][0]["changedTools"], ["lookup"])
        self.assertEqual(result["remoteCalls"]["mcpToolsCall"], 0)
        self.assertNotIn("endpoint", json.dumps(result))

    def test_mcp_endpoint_template_with_only_token_never_uses_placeholder_or_ambient_address(self):
        self.ops.package["connections"] = [{"id": "docs", "ownerId": "alice", "endpoint": "https://placeholder.example.com/mcp", "endpointEnv": "FLOWLY_MCP_ENDPOINT_DOCS", "tokenEnv": "FLOWLY_MCP_TOKEN_DOCS", "tools": []}]
        for suffix in ("", 'FLOWLY_MCP_ENDPOINT_DOCS="   "\n'):
            (self.root / ".env").write_text("FLOWLY_MCP_TOKEN_DOCS=injected-local-token\n" + suffix, encoding="utf-8")
            with self.subTest(suffix=suffix), patch.dict(os.environ, {"FLOWLY_MCP_ENDPOINT_DOCS": "https://ambient.example.com/mcp"}), patch.object(self.ops.transport, "post") as send:
                result = self.request("probe", target="mcp", confirm=True)
            send.assert_not_called()
            self.assertEqual(result["checks"][0]["status"], "unconfigured")
            self.assertEqual(result["checks"][0]["missingEnv"], ["FLOWLY_MCP_ENDPOINT_DOCS"])
            self.assertEqual(sum(result["remoteCalls"].values()), 0)
            self.assertNotIn("injected-local-token", json.dumps(result))

    def test_mcp_endpoint_template_uses_only_the_explicit_local_safe_address(self):
        expected = {"toolName": "lookup", "inputSchema": {"type": "object"}, "effect": "read"}
        self.ops.package["connections"] = [{"id": "docs", "ownerId": "alice", "endpoint": "https://placeholder.example.com/mcp", "endpointEnv": "FLOWLY_MCP_ENDPOINT_DOCS", "tokenEnv": "FLOWLY_MCP_TOKEN_DOCS", "tools": [expected]}]
        (self.root / ".env").write_text("FLOWLY_MCP_TOKEN_DOCS=injected-local-token\nFLOWLY_MCP_ENDPOINT_DOCS=https://configured.example.com/mcp\n", encoding="utf-8")
        methods = []
        class Transport:
            def post(inner, endpoint, body, headers, rpc_id, notification):
                self.assertEqual(endpoint, "https://configured.example.com/mcp")
                self.assertEqual(headers.get("Authorization"), "Bearer injected-local-token")
                methods.append(body["method"])
                result = {"protocolVersion": ops.PROTOCOL, "capabilities": {"tools": {}}} if body["method"] == "initialize" else {"tools": [{"name": "lookup", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": True}}]}
                return {"jsonrpc": "2.0", "id": rpc_id, "result": result}, {}
        self.ops.transport = Transport()
        result = self.request("probe", target="mcp", confirm=True)
        self.assertEqual(result["checks"][0]["status"], "connected")
        self.assertEqual(methods, ["initialize", "notifications/initialized", "tools/list"])
        self.assertEqual(result["remoteCalls"]["mcpToolsCall"], 0)
        self.assertNotIn("configured.example.com", json.dumps(result))
        self.assertNotIn("injected-local-token", json.dumps(result))

    def test_mcp_endpoint_template_rejects_unsafe_addresses_before_any_http_or_token_send(self):
        self.ops.package["connections"] = [{"id": "docs", "ownerId": "alice", "endpoint": "https://placeholder.example.com/mcp", "endpointEnv": "FLOWLY_MCP_ENDPOINT_DOCS", "tokenEnv": "FLOWLY_MCP_TOKEN_DOCS", "tools": []}]
        for endpoint in ("ftp://configured.internal/mcp", "https://@host/mcp", "https://host/mcp?token=secret", "https://host/mcp#fragment", "https://user:password@configured.example.com/mcp", "https://host:65536/mcp"):
            (self.root / ".env").write_text(f"FLOWLY_MCP_TOKEN_DOCS=injected-local-token\nFLOWLY_MCP_ENDPOINT_DOCS={endpoint}\n", encoding="utf-8")
            with self.subTest(endpoint=endpoint), patch.object(self.ops.transport, "post") as send:
                result = self.request("probe", target="mcp", confirm=True)
            send.assert_not_called()
            self.assertEqual(result["checks"][0]["status"], "failed")
            self.assertEqual(sum(result["remoteCalls"].values()), 0)
            self.assertNotIn("injected-local-token", json.dumps(result))

    def test_mcp_endpoint_template_rejects_malformed_variable_names_before_http(self):
        (self.root / ".env").write_text("FLOWLY_MCP_TOKEN_DOCS=injected-local-token\nOPENAI_API_KEY=not-an-address\n", encoding="utf-8")
        for key in ("", None, 4, [], "OPENAI_API_KEY", "FLOWLY_MCP_ENDPOINT_lowercase", "FLOWLY_MCP_ENDPOINT_DOCS\n"):
            self.ops.package["connections"] = [{"id": "docs", "ownerId": "alice", "endpoint": "https://placeholder.example.com/mcp", "endpointEnv": key, "tokenEnv": "FLOWLY_MCP_TOKEN_DOCS", "tools": []}]
            with self.subTest(key=key), patch.object(self.ops.transport, "post") as send:
                with self.assertRaises(ops.OperationsFault):
                    self.request("probe", target="mcp", confirm=True)
            send.assert_not_called()

    def test_mcp_endpoint_template_without_required_token_is_unconfigured(self):
        self.ops.package["connections"] = [{"id": "docs", "ownerId": "alice", "endpoint": "https://placeholder.example.com/mcp", "endpointEnv": "FLOWLY_MCP_ENDPOINT_DOCS", "tokenEnv": "FLOWLY_MCP_TOKEN_DOCS", "tools": []}]
        (self.root / ".env").write_text("FLOWLY_MCP_ENDPOINT_DOCS=https://configured.example.com/mcp\n", encoding="utf-8")
        with patch.object(self.ops.transport, "post") as send:
            result = self.request("probe", target="mcp", confirm=True)
        send.assert_not_called()
        self.assertEqual(result["checks"][0]["status"], "unconfigured")
        self.assertEqual(result["checks"][0]["missingEnv"], ["FLOWLY_MCP_TOKEN_DOCS"])

    def test_all_probe_finds_nested_vectors_and_embeds_one_small_input_without_chat_model(self):
        (self.root / ".env").write_text("OPENAI_API_KEY=injected-embedding-key\n", encoding="utf-8")
        vector = {"id": "retrieve", "type": "retrieval", "retrieval": {"mode": "vector"}}
        self.ops.package["workflow"]["definition"]["nodes"].append({"id": "nested", "type": "parallel", "parallel": {"tasks": [{"definition": {"nodes": [vector, vector]}}]}})
        class Transport:
            def post(inner, endpoint, body, headers):
                self.assertEqual(endpoint, "https://api.openai.com/v1/embeddings")
                self.assertEqual(body, {"model": "text-embedding-3-small", "input": ["connection check"], "encoding_format": "float"})
                return {"model": body["model"], "data": [{"index": 0, "embedding": [.25, -.75]}], "usage": {"total_tokens": 2}}, {}
        self.ops.transport = Transport()
        result = self.request("probe", target="all", confirm=True)
        embedding = next(check for check in result["checks"] if check["kind"] == "embeddings")
        self.assertEqual(embedding["status"], "connected")
        self.assertEqual(embedding["dimensions"], 2)
        self.assertEqual(embedding["modelSource"], "default")
        self.assertEqual(embedding["defaultModel"], "text-embedding-3-small")
        self.assertEqual(result["remoteCalls"]["openaiEmbeddings"], 1)
        self.assertEqual(result["remoteCalls"]["openaiResponses"], 0)
        self.assertNotIn("injected-embedding-key", json.dumps(result))
        self.assertNotIn(".25", json.dumps(result))

    def test_embeddings_probe_reports_missing_settings_without_inheriting_key(self):
        (self.root / ".env").write_text("FLOWLY_EMBEDDING_MODEL=\n", encoding="utf-8")
        with patch.dict(os.environ, {"OPENAI_API_KEY": "ambient-do-not-use"}), patch.object(self.ops.transport, "post", side_effect=AssertionError("unconfigured")):
            result = self.request("probe", target="embeddings", confirm=True)
        self.assertEqual(result["checks"][0]["status"], "unconfigured")
        self.assertEqual(result["checks"][0]["missingEnv"], ["OPENAI_API_KEY", "FLOWLY_EMBEDDING_MODEL"])
        self.assertEqual(result["remoteCalls"]["openaiEmbeddings"], 0)

    def test_embeddings_probe_rejects_invalid_vectors_model_index_and_usage(self):
        (self.root / ".env").write_text("OPENAI_API_KEY=injected-embedding-key\nFLOWLY_EMBEDDING_MODEL=configured-embedding\n", encoding="utf-8")
        valid = {"model": "configured-embedding", "data": [{"index": 0, "embedding": [.25, -.75]}], "usage": {"total_tokens": 2}}
        bad = []
        for vector in ([0, 0], [float("nan")], [float("inf")], [True, .25], [], [1] * 4097):
            value = copy.deepcopy(valid)
            value["data"][0]["embedding"] = vector
            bad.append(value)
        value = copy.deepcopy(valid)
        value["model"] = "different"
        bad.append(value)
        value = copy.deepcopy(valid)
        value["data"][0]["index"] = 1
        bad.append(value)
        value = copy.deepcopy(valid)
        value["usage"]["total_tokens"] = True
        bad.append(value)
        for value in bad:
            with self.subTest(response=value), patch.object(self.ops.transport, "post", return_value=(value, {})):
                result = self.request("probe", target="embeddings", confirm=True)
                self.assertEqual(result["checks"][0]["status"], "failed")
                self.assertEqual(result["remoteCalls"]["openaiEmbeddings"], 1)
                self.assertNotIn("injected-embedding-key", json.dumps(result))

    def test_all_probe_without_vector_node_does_not_send_embeddings(self):
        (self.root / ".env").write_text("OPENAI_API_KEY=injected-embedding-key\nFLOWLY_MODEL=mock\n", encoding="utf-8")
        response = {"status": "completed", "usage": {"total_tokens": 2}}
        with patch.object(self.ops.transport, "post", return_value=(response, {})) as request:
            result = self.request("probe", target="all", confirm=True)
        self.assertEqual(request.call_count, 1)
        self.assertEqual(result["remoteCalls"]["openaiEmbeddings"], 0)
        self.assertEqual([check["kind"] for check in result["checks"]], ["openai"])

    def test_probe_endpoint_policy_accepts_private_hosts_and_rejects_invalid_urls(self):
        for endpoint in ("http://localhost/mcp", "https://127.0.0.1:8443/mcp", "http://mcp.internal:8080/mcp", "https://[::1]:9443/mcp", "https://mcp/mcp"):
            self.assertEqual(ops.safe_endpoint(endpoint).geturl(), endpoint)
        for endpoint in ("ftp://host/mcp", "http://host:65536/mcp", "https://user:password@host/mcp", "http:///mcp", "https://host/mcp?token=x"):
            with self.assertRaises(ops.OperationsFault):
                ops.safe_endpoint(endpoint)

    def test_backup_restore_state_outputs_reports_and_refuse_overwrite(self):
        job = self.execute()
        for folder in ("outputs", "reports"):
            (self.root / folder).mkdir()
            (self.root / folder / "result.txt").write_text("실제 산출물", encoding="utf-8")
        backup = self.request("backup", scopes=["state", "outputs", "reports"])
        self.assertEqual(backup["files"], 3)
        with self.assertRaises(ops.OperationsFault):
            self.request("restore", backupId=backup["backupId"], confirm=True)
        paths = [self.ops.state(self.ops.profile()) / (job["runId"] + ".json"), self.root / "outputs" / "result.txt", self.root / "reports" / "result.txt"]
        for path in paths:
            path.unlink()
        self.assertEqual(self.request("restore", backupId=backup["backupId"], confirm=True)["files"], 3)
        self.assertEqual(self.request("runs.status", runId=job["runId"])["status"], "succeeded")

    def test_backup_excludes_env_and_rejects_exact_local_secret_in_artifact(self):
        (self.root / ".env").write_text("OPENAI_API_KEY=injected-secret-only\n", encoding="utf-8")
        (self.root / "outputs").mkdir()
        (self.root / "outputs" / "notes.txt").write_text("injected-secret-only", encoding="utf-8")
        with self.assertRaises(ops.OperationsFault):
            self.request("backup", scopes=["outputs"])
        (self.root / "outputs" / "notes.txt").unlink()
        backup = self.request("backup", scopes=["state"])
        with zipfile.ZipFile(self.root / ".flowly-ops" / "backups" / (backup["backupId"] + ".zip")) as archive:
            self.assertNotIn(".env", archive.namelist())

    def test_restore_checks_hash_traversal_and_package_scope_before_write(self):
        directory = self.root / ".flowly-ops" / "backups"
        directory.mkdir()
        metadata = {"version": 1, "profile": "production", "packageHash": self.ops.package_hash, "files": [{"path": "state/../../evil.txt", "size": 1, "sha256": "wrong"}]}
        with zipfile.ZipFile(directory / "backup_bad.zip", "w") as archive:
            archive.writestr("manifest.json", json.dumps(metadata))
            archive.writestr("state/../../evil.txt", "x")
        with self.assertRaises(ops.OperationsFault):
            self.request("restore", backupId="backup_bad", confirm=True)
        self.assertFalse((self.root / "evil.txt").exists())

    def test_retention_preserves_unknown_pending_memory_and_only_removes_old_terminal(self):
        job = self.execute()
        directory = self.ops.state(self.ops.profile())
        successful = directory / (job["runId"] + ".json")
        unknown = directory / ("run_" + "a" * 32 + ".json")
        record = ops.read_json(successful)
        record["run"].update(id="run_" + "a" * 32, status="unknown_outcome")
        ops.atomic_json(unknown, record)
        memory = directory / "memory_keep.json"
        memory.write_text("{}", encoding="utf-8")
        for path in (successful, unknown, memory):
            os.utime(path, (1000, 1000))
        result = self.request("prune", scopes=["state"], olderThanDays=1, confirm=True)
        self.assertEqual(len(result["removed"]), 1)
        self.assertTrue(unknown.exists())
        self.assertTrue(memory.exists())

    def test_maintenance_uses_native_lock_and_pending_run_prevents_backup(self):
        profile = self.ops.profile()
        with self.ops.maintenance(profile):
            result = self.ops.cli(profile, ["check"])
            self.assertEqual(result["status"], "ready")
            with self.assertRaises(ops.OperationsFault):
                self.ops.cli(profile, ["run", "--input", "lock denies"])
        self.assertFalse((self.ops.state(profile) / ".runner.lock").exists())

    def test_dataset_real_nonmodel_runs_and_regression_comparison(self):
        dataset = self.root / "cases.json"
        dataset.write_text(json.dumps({"cases": [{"id": "one", "input": "한글", "expected": "한글"}, {"id": "two", "input": "second", "contains": ["sec"]}]}), encoding="utf-8")
        baseline = self.request("evaluate", dataset="cases.json")
        self.assertEqual({key: baseline["summary"][key] for key in ("total", "executed", "passed")}, {"total": 2, "executed": 2, "passed": 2})
        self.assertEqual(baseline["summary"]["failureRate"], 0)
        self.assertEqual(baseline["summary"]["totalTokens"], 0)
        self.assertGreater(baseline["summary"]["activeMs"], 0)
        self.assertEqual(baseline["summary"]["cost"]["status"], "unconfigured")
        dataset.write_text(json.dumps({"cases": [{"id": "one", "input": "한글", "expected": "다름"}]}), encoding="utf-8")
        current = self.request("evaluate", dataset="cases.json")
        comparison = self.request("compare", evaluationId=current["id"], baselineId=baseline["id"])
        self.assertEqual(comparison["summary"]["regressions"], 1)
        self.assertEqual(comparison["summary"]["delta"]["passRate"], -1)
        self.assertIsNone(comparison["summary"]["delta"]["cost"])
        saved = (self.root / ".flowly-ops" / "evaluations" / (current["id"] + ".json")).read_text(encoding="utf-8")
        self.assertNotIn("다름", saved)

    def test_prices_manual_dated_range_and_csv_billing_comparison(self):
        job = self.execute()
        path = self.ops.state(self.ops.profile()) / (job["runId"] + ".json")
        record = ops.read_json(path)
        record["run"]["checkpoint"]["tokens"] = 1000
        ops.atomic_json(path, record)
        price = self.request("prices.set", model="mock", inputPerMillion=1, outputPerMillion=3, currency="USD", asOf="2026-10-22")
        self.assertEqual(price["price"]["asOf"], "2026-10-22")
        estimate = self.request("prices.estimate", runId=job["runId"], model="mock")
        self.assertEqual(estimate["range"], {"minimum": .001, "maximum": .003})
        (self.root / "bill.csv").write_text("start,end,model,amount,currency\n2026-10-01,2026-10-31,mock,0.01,USD\n", encoding="utf-8")
        self.request("bills.import", path="bill.csv")
        self.request("bills.import", path="bill.csv")
        comparison = self.request("bills.compare", runId=job["runId"], model="mock", start="2026-10-01", end="2026-10-31")
        self.assertEqual(comparison["billed"], .01)
        self.assertAlmostEqual(comparison["difference"]["minimum"], .007)
        self.assertIn("실제 청구 아님", estimate["label"])

    def test_secret_input_is_scrubbed_before_queue_persistence(self):
        (self.root / ".env").write_text("FLOWLY_TRIGGER_SECRET=local-injected-sensitive-value", encoding="utf-8")
        job = self.request("jobs.enqueue", input="message local-injected-sensitive-value")["job"]
        stored = (self.root / ".flowly-ops" / "inputs" / (job["id"] + ".txt")).read_text(encoding="utf-8")
        self.assertNotIn("local-injected-sensitive-value", stored)
        self.assertNotIn("input", self.request("jobs.list")["jobs"][0])

    def test_changed_package_blocks_operations_without_reusing_old_queue(self):
        self.request("jobs.enqueue", input="before change")
        with (self.root / "workflow.json").open("a", encoding="utf-8") as stream:
            stream.write(" ")
        with self.assertRaises(ops.OperationsFault):
            self.request("jobs.list")
        with self.assertRaises(ops.OperationsFault):
            ops.Operations(self.root)

    def test_request_file_cli_runs_without_reading_environment_or_stdin(self):
        import subprocess
        path = self.root / "operation.json"
        path.write_text('{"action":"profiles.list"}', encoding="utf-8")
        result = subprocess.run([os.sys.executable, "-X", "utf8", str(SOURCE / "flowly_ops.py"), "request", "--root", str(self.root), "--request-file", "operation.json"], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(json.loads(result.stdout)["profiles"][0]["name"], "production")

    def test_cross_version_baseline_file_and_period_estimate_use_pinned_models(self):
        dataset = self.root / "cases.json"
        dataset.write_text(json.dumps({"cases": [{"id": "case", "input": "same", "expected": "different"}]}), encoding="utf-8")
        result = self.request("evaluate", dataset="cases.json")
        (self.root / "baseline.json").write_text(json.dumps({"packageHash": "previous-version", "results": [{"caseId": "case", "passed": True}]}), encoding="utf-8")
        self.assertEqual(self.request("compare", evaluationId=result["id"], baselineFile="baseline.json")["summary"]["regressions"], 1)
        job_run = result["results"][0]["runId"]
        path = self.ops.state(self.ops.profile()) / (job_run + ".json")
        record = ops.read_json(path)
        record["run"]["provider"] = {"model": "fixed"}
        record["run"]["checkpoint"]["tokens"] = 1000
        ops.atomic_json(path, record)
        (self.root / ".env").write_text("FLOWLY_MODEL=changed-after-run\n", encoding="utf-8")
        self.request("prices.set", model="fixed", inputPerMillion=1, outputPerMillion=2, currency="USD", asOf="2026-10-22")
        estimate = self.request("prices.estimate", runId=job_run, model="wrong-override")
        self.assertEqual(estimate["model"], "fixed")
        day = record["run"]["createdAt"][:10]
        (self.root / "bill.csv").write_text(f"start,end,model,amount,currency\n{day},{day},fixed,0.01,USD\n", encoding="utf-8")
        self.request("bills.import", path="bill.csv")
        compared = self.request("bills.compare", model="fixed", start=day, end=day)
        self.assertEqual(compared["estimate"]["runCount"], 1)
        self.assertEqual(compared["estimate"]["totalTokens"], 1000)
        self.assertEqual(compared["billed"], .01)
        record["run"]["provider"]["embeddingModel"] = "embedding"
        ops.atomic_json(path, record)
        self.assertEqual(self.request("prices.estimate", runId=job_run)["status"], "mixed_models")

    def test_evaluation_summary_compares_cost_time_failure_without_claiming_billing(self):
        result = {"caseId": "one", "status": "failed", "passed": False, "usage": {"tokens": 100, "activeMs": 50}, "estimate": {"status": "estimated", "currency": "USD", "range": {"minimum": 1, "maximum": 2}}}
        summary = ops.evaluation_summary([result])
        self.assertEqual(summary["failed"], 1)
        self.assertEqual(summary["failureRate"], 1)
        self.assertEqual(summary["cost"]["maximum"], 2)
        self.assertEqual(summary["activeMs"], 50)
        self.assertIn("실제 청구 아님", summary["cost"]["label"])

    def test_old_write_capable_backup_cannot_reactivate_after_terminal_retention(self):
        self.root = self.root / "write-capable"
        self.root.mkdir()
        value = manifest()
        tool = {"resourceId": "mcp", "connectionId": "conn", "toolName": "change", "name": "change", "description": "외부 변경", "inputSchema": {"type": "object"}, "effect": "write"}
        value["resources"] = [{"id": "mcp", "ownerId": "alice", "name": "연결", "type": "mcp", "content": "설정", "updatedAt": "2026-10-22T00:00:00Z"}]
        value["connections"] = [{"id": "conn", "ownerId": "alice", "resourceId": "mcp", "name": "연결", "endpoint": "https://service.example.com/mcp", "tools": [tool]}]
        (self.root / "workflow.json").write_text(json.dumps(value), encoding="utf-8")
        shutil.copyfile(SOURCE / "runner.py", self.root / "runner.py")
        self.ops = ops.Operations(self.root)
        job = self.execute()
        path = self.ops.state(self.ops.profile()) / (job["runId"] + ".json")
        record = ops.read_json(path)
        record["run"]["status"] = "waiting_approval"
        ops.atomic_json(path, record)
        backup = self.request("backup", scopes=["state"])
        record["run"]["status"] = "succeeded"
        ops.atomic_json(path, record)
        os.utime(path, (1000, 1000))
        self.request("prune", scopes=["state"], olderThanDays=1, confirm=True)
        restored = self.request("restore", backupId=backup["backupId"], confirm=True)
        self.assertEqual(restored["readOnlyRuns"], 1)
        status = self.request("runs.status", runId=job["runId"])
        self.assertTrue(status["restoredReadOnly"])
        for command in (["resume", job["runId"]], ["approve", job["runId"], "approval_missing"]):
            with self.assertRaises(ops.OperationsFault):
                self.ops.cli(self.ops.profile(), command)
        self.assertEqual(self.execute("새 실행은 별도로 허용")["status"], "succeeded")

    def test_reparse_directories_cannot_receive_queue_input_or_backup(self):
        from types import SimpleNamespace
        original = Path.lstat
        for name, action in (("inputs", "jobs.enqueue"), ("backups", "backup")):
            target = self.root / ".flowly-ops" / name
            target.mkdir(exist_ok=True)
            def attributes(path, *args, **kwargs):
                value = original(path, *args, **kwargs)
                return SimpleNamespace(st_mode=value.st_mode, st_file_attributes=0x400) if path == target else value
            with patch.object(Path, "lstat", attributes), self.assertRaises(ops.OperationsFault):
                self.request(action, input="do not write", scopes=["state"])
            self.assertEqual(list(target.iterdir()), [])

    def test_profile_change_during_enqueue_fails_without_storing_job_or_input(self):
        original = self.ops.environment
        def changed(profile):
            values = original(profile)
            self.request("profiles.set", name="production", env=".env.changed")
            return values
        with patch.object(self.ops, "environment", side_effect=changed), self.assertRaises(ops.OperationsFault):
            self.request("jobs.enqueue", input="work")
        self.assertEqual(self.request("jobs.list")["jobs"], [])
        self.assertEqual(list((self.root / ".flowly-ops" / "inputs").glob("*.txt")), [])

    def test_native_paused_checkpoint_is_not_automatically_queued_again(self):
        job = self.request("jobs.enqueue", input="one request")["job"]
        with patch.object(self.ops, "cli", return_value={"status": "queued", "id": "run_" + "a" * 32}) as invoke:
            self.ops.worker(once=True)
            self.assertEqual(self.ops.job(job["id"])["status"], "paused")
            self.assertEqual(self.ops.worker(once=True)["processed"], [])
            self.assertEqual(invoke.call_count, 1)


if __name__ == "__main__":
    unittest.main()
