"""Offline tests for the exported Python runtime. No API credentials or network calls."""
import copy
import importlib.util
import io
import json
import os
import hashlib
from pathlib import Path
import socket
import tempfile
import threading
import time
from datetime import datetime, timezone
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("flowly_runner", Path(__file__).parents[1] / "export-runtime" / "runner.py")
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


def package(effect="read", node_type="agent"):
    tool = {"resourceId": "resource", "connectionId": "connection", "toolName": "lookup", "name": "lookup", "description": "자료 확인",
            "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"], "additionalProperties": False}, "effect": effect}
    manifest = {
        "format": "flowly-executable-export", "version": 1, "language": "python",
        "owner": {"userId": "alice", "email": "alice@example.test", "displayName": "Alice"},
        "workflow": {"id": "flow", "name": "Test", "definition": {"schemaVersion": 2, "nodes": [
            {"id": "input", "type": "input", "title": "입력"},
            {"id": "agent", "type": node_type, "title": "작업", "prompt": "한국어로 답하세요.", "allowedTools": [{k: tool[k] for k in ("resourceId", "connectionId", "toolName")}], "inputBindings": {"text": {"nodeId": "input", "path": "text"}}},
            {"id": "output", "type": "output", "title": "결과", "inputBindings": {"text": {"nodeId": "agent", "path": "text"}}},
        ], "edges": [{"id": "edge1", "source": "input", "target": "agent"}, {"id": "edge2", "source": "agent", "target": "output"}]}},
        "resources": [{"id": "resource", "ownerId": "alice", "type": "mcp", "name": "자료", "content": "등록 텍스트", "updatedAt": "2026-10-21T00:00:00Z"}],
        "connections": [{"id": "connection", "ownerId": "alice", "resourceId": "resource", "name": "연결", "endpoint": "https://tools.example.com/mcp", "tokenEnv": "FLOWLY_MCP_TOKEN_TEST", "tools": [tool]}],
        "limits": copy.deepcopy(runner.DEFAULT_LIMITS),
    }
    return runner.validate_package(manifest)


def answer(text="완료", tokens=10):
    return {"kind": "answer", "text": text, "usageTokens": tokens}


def call(query="입력", name="lookup"):
    return {"kind": "tool", "toolName": name, "args": {"query": query}, "usageTokens": 10}


def data_package(kind, config, effect="read"):
    manifest = package(effect)
    node = manifest["workflow"]["definition"]["nodes"][1]
    node["type"] = kind
    node[kind] = config
    if kind != "tool":
        node["allowedTools"] = []
        manifest["connections"] = []
        manifest["resources"] = []
    return runner.validate_package(manifest)


class FakeProviders:
    secrets = []

    def __init__(self, replies, tool_result=None, tool_error=None):
        self.replies = list(replies)
        self.tool_result = tool_result or {"content": [{"type": "text", "text": "확인한 자료"}]}
        self.tool_error = tool_error
        self.models = []
        self.calls = []

    def model(self, messages, tools, tokens, timeout):
        self.models.append((messages, tools, tokens, timeout))
        reply = self.replies.pop(0)
        return reply(messages) if callable(reply) else reply

    def tool(self, tool, args, key, timeout):
        self.calls.append((tool, args, key, timeout))
        if self.tool_error:
            raise self.tool_error
        return self.tool_result


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.store = runner.Store(self.directory / "state")

    def tearDown(self):
        self.temp.cleanup()

    def start(self, manifest, providers, input_text="사용자 질문"):
        run = runner.new_run(manifest, input_text)
        self.store.save("package-hash", run)
        runner.Engine(manifest, "package-hash", self.store, providers, run).execute()
        return run

    def resume(self, manifest, providers, run):
        loaded = runner.Store(self.directory / "state").load("package-hash", run["id"])
        runner.Engine(manifest, "package-hash", self.store, providers, loaded).execute()
        return loaded

    def test_read_tool_input_and_observation_reach_final_answer(self):
        def initial(messages):
            self.assertEqual(json.loads(messages[0]["content"])["input"]["text"], "질문A")
            return call("질문A")
        def final(messages):
            self.assertEqual(json.loads(messages[-1]["content"])["content"][0]["text"], "확인한 자료")
            return answer("자료에 근거한 답변")
        providers = FakeProviders([initial, final])
        run = self.start(package(), providers, "질문A")
        self.assertEqual(run["status"], "succeeded")
        self.assertEqual(run["result"], "자료에 근거한 답변")
        self.assertEqual(providers.calls[0][1], {"query": "질문A"})
        self.assertEqual(run["checkpoint"]["turns"], 2)
        self.assertEqual(run["checkpoint"]["toolCalls"], 1)

    def test_resource_skill_and_json_mapping_drive_condition(self):
        manifest = package(node_type="ai")
        resource = manifest["resources"][0]
        resource["type"] = "document"
        manifest["resources"].append({**resource, "id": "skill", "name": "지침", "type": "skill", "content": "작업 요령"})
        nodes = manifest["workflow"]["definition"]["nodes"]
        nodes[1]["inputBindings"] = {"text": {"nodeId": "skill", "path": "text"}}
        nodes[1]["format"] = "JSON"
        nodes[-1]["id"] = "yes"
        nodes[-1]["inputBindings"] = {"text": {"nodeId": "condition", "path": "text"}}
        nodes.extend([
            {"id": "resource", "title": "자료", "type": "resource", "resourceId": "resource"},
            {"id": "skill", "title": "지침", "type": "skill", "resourceId": "skill"},
            {"id": "condition", "title": "분기", "type": "condition", "condition": "ready", "inputBindings": {"text": {"nodeId": "agent", "path": "data.status"}}},
            {"id": "no", "title": "불일치", "type": "output", "inputBindings": {"text": {"nodeId": "condition", "path": "text"}}},
        ])
        links = [("input", "resource", None), ("resource", "skill", None), ("skill", "agent", None), ("agent", "condition", None), ("condition", "yes", "yes"), ("condition", "no", "no")]
        manifest["workflow"]["definition"]["edges"] = [{"id": str(i), "source": source, "target": target, **({"branch": branch} if branch else {})} for i, (source, target, branch) in enumerate(links)]
        runner.validate_package(manifest)
        def model(messages):
            text = json.loads(messages[0]["content"])["input"]["text"]
            self.assertIn("원래 질문", text)
            self.assertIn("등록 텍스트", text)
            self.assertIn("작업 요령", text)
            return answer('{"status":"READY"}')
        run = self.start(manifest, FakeProviders([model]), "원래 질문")
        self.assertEqual(run["status"], "succeeded")
        self.assertEqual(run["result"], "READY")
        self.assertIn("no", run["checkpoint"]["skipped"])

    def test_write_approval_restored_from_disk_and_repeated_resume_safe(self):
        manifest, providers = package("write"), FakeProviders([call(), answer()])
        run = self.start(manifest, providers)
        self.assertEqual(run["status"], "waiting_approval")
        self.assertEqual(len(providers.calls), 0)
        approval = run["approvals"][0]
        with self.assertRaises(runner.Fault):
            runner.decide(run, approval["id"], "approve", "bob")
        runner.decide(run, approval["id"], "approve", "alice")
        runner.decide(run, approval["id"], "approve", "alice")
        self.store.save("package-hash", run)
        run = self.resume(manifest, providers, run)
        self.assertEqual(run["status"], "succeeded")
        self.assertEqual(len(providers.calls), 1)
        self.resume(manifest, providers, run)
        self.assertEqual(len(providers.calls), 1)

    def test_denial_no_write_and_no_repeat_approval(self):
        manifest, providers = package("write"), FakeProviders([call(), call(), answer("거절을 반영한 답변")])
        run = self.start(manifest, providers)
        runner.decide(run, run["approvals"][0]["id"], "deny", "alice")
        self.store.save("package-hash", run)
        run = self.resume(manifest, providers, run)
        self.assertEqual(run["status"], "succeeded")
        self.assertEqual(len(providers.calls), 0)
        self.assertEqual(len(run["approvals"]), 1)
        self.assertEqual(run["checkpoint"]["turns"], 3)

    def test_changed_arguments_and_expired_approval_rejected(self):
        run = self.start(package("write"), FakeProviders([call()]))
        approval = run["approvals"][0]
        run["checkpoint"]["calls"][0]["args"]["query"] = "변경"
        with self.assertRaises(runner.Fault):
            runner.decide(run, approval["id"], "approve", "alice")
        run["checkpoint"]["calls"][0]["args"]["query"] = "입력"
        approval["expiresAt"] = "2020-01-01T00:00:00Z"
        with self.assertRaises(runner.Fault) as caught:
            runner.decide(run, approval["id"], "approve", "alice")
        self.assertEqual(caught.exception.code, "expired")

    def test_unknown_write_never_retried(self):
        manifest, providers = package("write"), FakeProviders([call()], tool_error=OSError("opaque remote failure"))
        run = self.start(manifest, providers)
        runner.decide(run, run["approvals"][0]["id"], "approve", "alice")
        self.store.save("package-hash", run)
        run = self.resume(manifest, providers, run)
        self.assertEqual(run["status"], "unknown_outcome")
        self.assertEqual(len(providers.calls), 1)
        self.resume(manifest, providers, run)
        self.assertEqual(len(providers.calls), 1)
        self.assertNotIn("opaque remote failure", json.dumps(run))

    def test_crash_after_durable_write_intent_requires_reconciliation(self):
        manifest, providers = package("write"), FakeProviders([call()], tool_error=KeyboardInterrupt())
        run = self.start(manifest, providers)
        runner.decide(run, run["approvals"][0]["id"], "approve", "alice")
        self.store.save("package-hash", run)
        with self.assertRaises(KeyboardInterrupt):
            self.resume(manifest, providers, run)
        disk = self.store.load("package-hash", run["id"])
        self.assertEqual(disk["checkpoint"]["calls"][0]["status"], "dispatching")
        safe = FakeProviders([])
        recovered = self.resume(manifest, safe, disk)
        self.assertEqual(recovered["status"], "unknown_outcome")
        self.assertEqual(len(safe.calls), 0)

    def test_read_failure_retries_only_twice(self):
        providers = FakeProviders([call(), answer("연결 실패 안내")], tool_error=OSError("network"))
        run = self.start(package(), providers)
        self.assertEqual(len(providers.calls), 2)
        self.assertEqual(run["status"], "succeeded")
        self.assertEqual(run["checkpoint"]["calls"][0]["status"], "failed")

    def test_turn_tool_token_and_time_limits(self):
        manifest = package()
        manifest["workflow"]["definition"]["nodes"][1]["limits"] = {"maxTurns": 1}
        providers = FakeProviders([call(), answer()])
        run = self.start(manifest, providers)
        self.assertEqual(run["status"], "budget_exceeded")
        self.assertEqual(len(providers.models), 1)
        manifest = package()
        manifest["limits"]["maxToolCalls"] = 1
        providers = FakeProviders([call("first"), call("second")])
        run = self.start(manifest, providers)
        self.assertEqual(run["status"], "budget_exceeded")
        self.assertEqual(len(providers.calls), 1)
        manifest = package()
        manifest["limits"]["maxTokens"] = 20
        providers = FakeProviders([])
        self.assertEqual(self.start(manifest, providers)["status"], "budget_exceeded")
        self.assertEqual(len(providers.models), 0)
        run = runner.new_run(package(), "시간 한도")
        run["checkpoint"]["activeMs"] = 120001
        runner.Engine(package(), "package-hash", self.store, providers, run).execute()
        self.assertEqual(run["status"], "budget_exceeded")

    def test_unallowed_tool_and_ai_tool_requests_never_dispatch(self):
        providers = FakeProviders([call(name="unallowed"), answer()])
        run = self.start(package(), providers)
        self.assertEqual(run["status"], "succeeded")
        self.assertEqual(len(providers.calls), 0)
        self.assertIn("tool_rejected", [event["type"] for event in run["events"]])
        providers = FakeProviders([call()])
        run = self.start(package(node_type="ai"), providers)
        self.assertEqual(run["status"], "failed")
        self.assertEqual(len(providers.calls), 0)

    def test_schema_failures_prevent_tool_dispatch(self):
        providers = FakeProviders([{**call(), "args": {"query": 7}}])
        run = self.start(package(), providers)
        self.assertEqual(run["status"], "failed")
        self.assertEqual(len(providers.calls), 0)
        with self.assertRaises(runner.Fault):
            runner.check_schema({"type": "object", "oneOf": []})
        with self.assertRaises(runner.Fault):
            runner.assert_schema(True, {"type": "number"})

    def test_atomic_save_preserves_previous_state_when_replace_fails(self):
        run = runner.new_run(package(), "입력")
        self.store.save("hash", run)
        run["result"] = "새 결과"
        with patch.object(runner.os, "replace", side_effect=OSError("disk failed")):
            with self.assertRaises(OSError):
                self.store.save("hash", run)
        self.assertEqual(self.store.load("hash", run["id"])["result"], "")
        self.assertFalse(list(self.store.directory.glob("*.tmp")))
        with self.assertRaises(runner.Fault):
            self.store.load("different-package", run["id"])

    def test_failed_checkpoint_prevents_external_calls(self):
        providers = FakeProviders([call()])
        run = runner.new_run(package(), "입력")
        with patch.object(self.store, "save", side_effect=OSError("disk failed")):
            with self.assertRaises(OSError):
                runner.Engine(package(), "hash", self.store, providers, run).execute()
        self.assertEqual(len(providers.models), 0)
        self.assertEqual(len(providers.calls), 0)

    def test_single_writer_lock_and_dead_process_unlock(self):
        with self.store.locked():
            with self.assertRaises(runner.Fault):
                with runner.Store(self.store.directory).locked():
                    self.fail("second writer")
            self.assertTrue(runner.process_alive(os.getpid()))
            with self.assertRaises(runner.Fault):
                self.store.unlock()
        self.assertFalse(self.store.lock_path.exists())

    def test_unlock_recovery_gate_prevents_new_writer_or_second_unlock(self):
        self.store.lock_path.write_text(json.dumps({"pid": 999999, "nonce": "old"}))
        def probe(_pid):
            with self.assertRaises(runner.Fault):
                with runner.Store(self.store.directory).locked():
                    self.fail("new writer during recovery")
            with self.assertRaises(runner.Fault):
                runner.Store(self.store.directory).unlock()
            return False
        with patch.object(runner, "process_alive", side_effect=probe):
            self.store.unlock()
        self.assertFalse(self.store.lock_path.exists())
        self.assertFalse(self.store.unlock_path.exists())

    def test_lock_loss_while_flushing_does_not_replace_checkpoint(self):
        run = runner.new_run(package(), "input")
        with self.store.locked():
            self.store.save("hash", run)
            run["result"] = "new result"
            original_fsync = runner.os.fsync
            def change_lock(fd):
                original_fsync(fd)
                self.store.lock_path.write_text(json.dumps({"pid": os.getpid(), "nonce": "other"}))
            with patch.object(runner.os, "fsync", side_effect=change_lock):
                with self.assertRaises(runner.Fault):
                    self.store.save("hash", run)
            self.assertEqual(self.store.load("hash", run["id"])["result"], "")
        self.store.lock_path.write_text(json.dumps({"pid": 999999, "nonce": "old"}))
        with patch.object(runner, "process_alive", return_value=False):
            self.store.unlock()
        self.assertFalse(self.store.lock_path.exists())

    def test_package_constraints_and_explicit_env_only(self):
        invalid = package()
        invalid["connections"][0]["ownerId"] = "bob"
        with self.assertRaises(runner.Fault):
            runner.validate_package(invalid)
        invalid = package()
        invalid["connections"][0]["tokenEnv"] = "OPENAI_API_KEY"
        with self.assertRaises(runner.Fault):
            runner.validate_package(invalid)
        invalid = package()
        invalid["workflow"]["definition"]["nodes"][1]["inputBindings"]["text"]["nodeId"] = "output"
        with self.assertRaises(runner.Fault):
            runner.validate_package(invalid)
        env_file = self.directory / ".env"
        env_file.write_text("FLOWLY_MODEL=mock-only\n", encoding="utf-8")
        with patch.dict(os.environ, {"OPENAI_API_KEY": "ambient-must-not-be-used"}):
            env = runner.load_env(env_file)
            self.assertNotIn("OPENAI_API_KEY", env)
            with self.assertRaises(runner.Fault):
                runner.Providers(env, [])

    def test_package_change_and_lost_lock_stop_before_tool_dispatch(self):
        manifest_path = self.directory / "workflow.json"
        manifest_path.write_bytes(b"original")
        self.store.bind_package(manifest_path, hashlib.sha256(b"original").hexdigest())
        def changed_package(_messages):
            manifest_path.write_bytes(b"changed")
            return call()
        providers = FakeProviders([changed_package])
        with self.assertRaises(runner.Fault):
            self.start(package(), providers)
        self.assertEqual(len(providers.calls), 0)
        manifest_path.write_bytes(b"original")
        def lost_lock(_messages):
            self.store.lock_path.write_text(json.dumps({"pid": os.getpid(), "nonce": "someone-else"}))
            return call()
        providers = FakeProviders([lost_lock])
        with self.store.locked():
            with self.assertRaises(runner.Fault):
                self.start(package(), providers)
        self.assertEqual(len(providers.calls), 0)

    def test_interrupted_active_time_is_not_reset_on_resume(self):
        manifest = package()
        run = runner.new_run(manifest, "input")
        run["status"] = "running"
        run["updatedAt"] = "2020-01-01T00:00:00Z"
        self.store.save("package-hash", run)
        providers = FakeProviders([])
        restored = self.resume(manifest, providers, run)
        self.assertEqual(restored["status"], "budget_exceeded")
        self.assertEqual(len(providers.models), 0)

    def test_custom_mapping_does_not_invent_text_field(self):
        manifest = package(node_type="ai")
        node = manifest["workflow"]["definition"]["nodes"][1]
        node["inputBindings"] = {"query": {"nodeId": "input", "path": "text"}}
        node["inputSchema"] = {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"], "additionalProperties": False}
        def model(messages):
            self.assertEqual(json.loads(messages[0]["content"])["input"], {"query": "custom"})
            return answer()
        self.assertEqual(self.start(manifest, FakeProviders([model]), "custom")["status"], "succeeded")

    def test_cli_secret_scrubbing_preflight_and_expired_state_persistence(self):
        manifest_file = self.directory / "workflow.json"
        manifest_file.write_text(json.dumps(package()), encoding="utf-8")
        env_file = self.directory / ".env"
        secret = "exact-local-unit-secret"
        env_file.write_text("OPENAI_API_KEY=" + secret + "\nFLOWLY_MODEL=mock-only\n", encoding="utf-8")
        providers = FakeProviders([answer("answer " + secret)])
        providers.secrets = [secret]
        flags = ["--package", str(manifest_file), "--state", str(self.store.directory), "--env", str(env_file)]
        out = io.StringIO()
        with patch.object(runner, "Providers", return_value=providers), patch("sys.stdout", out):
            self.assertEqual(runner.main(["run", "--input", "input " + secret] + flags), 0)
        self.assertNotIn(secret, out.getvalue())
        for path in self.store.directory.glob("*.json"):
            self.assertNotIn(secret, path.read_text(encoding="utf-8"))
        manifest = package()
        manifest["resources"][0]["content"] = "accidental " + secret
        manifest_file.write_text(json.dumps(manifest), encoding="utf-8")
        with patch.object(runner, "Providers", return_value=providers), patch("sys.stderr", io.StringIO()):
            self.assertEqual(runner.main(["run", "--input", "safe"] + flags), 1)
        self.assertEqual(len(providers.models), 1)
        manifest = package("write")
        manifest_file.write_text(json.dumps(manifest), encoding="utf-8")
        loaded, package_hash = runner.load_package(manifest_file)
        run = runner.new_run(loaded, "승인")
        runner.Engine(loaded, package_hash, self.store, FakeProviders([call()]), run).execute()
        approval_id = run["approvals"][0]["id"]
        run["approvals"][0]["expiresAt"] = "2020-01-01T00:00:00Z"
        self.store.save(package_hash, run)
        with patch("sys.stderr", io.StringIO()):
            self.assertEqual(runner.main(["approve", run["id"], approval_id] + flags), 1)
        self.assertEqual(self.store.load(package_hash, run["id"])["status"], "expired")

    def test_approval_decision_marks_queued_without_executing(self):
        providers = FakeProviders([call()])
        run = self.start(package("write"), providers)
        runner.decide(run, run["approvals"][0]["id"], "approve", "alice")
        self.assertEqual(run["status"], "queued")
        self.assertEqual(len(providers.calls), 0)

    def test_approval_expiring_during_mcp_initialize_never_calls_write(self):
        manifest = package("write")
        run = self.start(manifest, FakeProviders([call()]))
        approval = run["approvals"][0]
        runner.decide(run, approval["id"], "approve", "alice")
        approval["expiresAt"] = datetime.fromtimestamp(time.time() + 0.025, timezone.utc).isoformat()
        self.store.save("package-hash", run)
        methods = []
        class SlowInitializeHttp:
            def post(self, url, body, headers, timeout, rpc_id=None, notification=False):
                methods.append(body["method"])
                time.sleep(0.04)
                return {"jsonrpc": "2.0", "id": rpc_id, "result": {"protocolVersion": runner.VERSION, "capabilities": {"tools": {}}}}, {}
        providers = runner.Providers({"OPENAI_API_KEY": "offline-ai-token", "FLOWLY_MODEL": "mock-only", "FLOWLY_MCP_TOKEN_TEST": "offline-mcp-token"}, manifest["connections"], SlowInitializeHttp())
        restored = self.resume(manifest, providers, run)
        self.assertNotIn("tools/call", methods)
        self.assertNotEqual(restored["status"], "succeeded")

    def test_cli_run_and_status_without_credentials_or_network_access(self):
        manifest_file = self.directory / "workflow.json"
        manifest_file.write_text(json.dumps(package()), encoding="utf-8")
        env_file = self.directory / ".env"
        env_file.write_text("OPENAI_API_KEY=offline-test-value\nFLOWLY_MODEL=mock-only\n", encoding="utf-8")
        input_file = self.directory / "input.txt"
        input_file.write_text("파일에서 입력", encoding="utf-8")
        providers = FakeProviders([answer("파일 입력 확인")])
        out = io.StringIO()
        with patch.object(runner, "Providers", return_value=providers), patch("sys.stdout", out):
            result = runner.main(["run", "--input-file", str(input_file), "--package", str(manifest_file), "--state", str(self.store.directory), "--env", str(env_file)])
        self.assertEqual(result, 0)
        data = json.loads(out.getvalue())
        env_file.unlink()
        with patch("sys.stdout", io.StringIO()):
            self.assertEqual(runner.main(["status", data["id"], "--package", str(manifest_file), "--state", str(self.store.directory)]), 0)

    def test_direct_tool_maps_exact_arguments_without_model(self):
        manifest = data_package("tool", {"arguments": {"query": "constant"}, "bindings": {"query": "text"}})
        providers = FakeProviders([], tool_result={"value": "실제 도구 관찰"})
        run = self.start(manifest, providers, "mapped input")
        self.assertEqual(run["status"], "succeeded")
        self.assertEqual(providers.calls[0][1], {"query": "mapped input"})
        self.assertEqual(run["checkpoint"]["outputs"]["agent"]["data"], {"value": "실제 도구 관찰"})
        self.assertEqual(len(providers.models), 0)
        self.assertEqual(run["checkpoint"]["turns"], 0)

    def test_direct_write_approval_denial_and_unknown_outcome(self):
        manifest = data_package("tool", {"arguments": {}, "bindings": {"query": "text"}}, "write")
        providers = FakeProviders([], tool_result={"written": True})
        run = self.start(manifest, providers)
        self.assertEqual(run["status"], "waiting_approval")
        self.assertEqual(len(providers.calls), 0)
        runner.decide(run, run["approvals"][0]["id"], "approve", "alice")
        self.store.save("package-hash", run)
        restored = self.resume(manifest, providers, run)
        self.assertEqual(restored["status"], "succeeded")
        self.resume(manifest, providers, restored)
        self.assertEqual(len(providers.calls), 1)
        run = self.start(manifest, providers)
        runner.decide(run, run["approvals"][0]["id"], "deny", "alice")
        self.store.save("package-hash", run)
        denied = self.resume(manifest, providers, run)
        self.assertEqual(denied["status"], "failed")
        self.assertEqual(len(providers.calls), 1)
        unknown_provider = FakeProviders([], tool_error=OSError("remote detail must stay private"))
        run = self.start(manifest, unknown_provider)
        runner.decide(run, run["approvals"][0]["id"], "approve", "alice")
        self.store.save("package-hash", run)
        unknown = self.resume(manifest, unknown_provider, run)
        self.assertEqual(unknown["status"], "unknown_outcome")
        self.resume(manifest, unknown_provider, unknown)
        self.assertEqual(len(unknown_provider.calls), 1)

    def test_direct_write_same_arguments_across_nodes_reuses_durable_result(self):
        manifest = data_package("tool", {"arguments": {"query": "same"}, "bindings": {}}, "write")
        definition = manifest["workflow"]["definition"]
        second = copy.deepcopy(definition["nodes"][1])
        second.update({"id": "second", "inputBindings": {"text": {"nodeId": "agent", "path": "text"}}})
        definition["nodes"].insert(2, second)
        definition["nodes"][-1]["inputBindings"] = {"text": {"nodeId": "second", "path": "text"}}
        definition["edges"][1]["target"] = "second"
        definition["edges"].append({"id": "second-output", "source": "second", "target": "output"})
        runner.validate_package(manifest)
        providers = FakeProviders([], tool_result={"written": True})
        run = self.start(manifest, providers)
        runner.decide(run, run["approvals"][0]["id"], "approve", "alice")
        self.store.save("package-hash", run)
        restored = self.resume(manifest, providers, run)
        self.assertEqual(restored["status"], "succeeded")
        self.assertEqual(len(providers.calls), 1)
        self.assertEqual(len(restored["approvals"]), 1)
        self.assertEqual(restored["checkpoint"]["outputs"]["agent"], restored["checkpoint"]["outputs"]["second"])

    def test_direct_read_failures_retry_once_then_fail_node(self):
        providers = FakeProviders([], tool_error=OSError("opaque"))
        manifest = data_package("tool", {"arguments": {}, "bindings": {"query": "text"}})
        run = self.start(manifest, providers)
        self.assertEqual(run["status"], "failed")
        self.assertEqual(len(providers.calls), 2)
        self.assertEqual(len(providers.models), 0)

    def test_transform_modes_nested_arrays_and_invalid_input(self):
        value = runner.transform_data({"mode": "parse_json"}, {"text": '{"rows":[{"name":"한글"}],"count":2}'})
        picked = runner.transform_data({"mode": "pick", "fields": {"label": "data.rows.0.name", "count": "data.count"}}, value)
        self.assertEqual(picked["data"], {"label": "한글", "count": 2})
        rendered = runner.transform_data({"mode": "template", "template": "{{data.label}} · {{ data.count }}"}, picked)
        self.assertEqual(rendered, {"text": "한글 · 2"})
        for config, input_data in [({"mode": "parse_json"}, {"text": "bad JSON"}), ({"mode": "pick", "fields": {"a": "data.missing"}}, value), ({"mode": "template", "template": "{{data.rows.9.name}}"}, value), ({"mode": "parse_json"}, {"text": '{"__proto__":{}}'})]:
            with self.assertRaises(runner.Fault):
                runner.transform_data(config, input_data)

    def test_merge_sorted_inputs_deduplicates_without_context_fallback(self):
        self.assertEqual(runner.merge_data({"mode": "array", "deduplicate": True}, {"b": [2, 3], "a": [1, 2]})["data"], [1, 2, 3])
        self.assertEqual(runner.merge_data({"mode": "text", "separator": " | "}, {"b": {"count": 2}, "a": "first"})["text"], 'first | {"count":2}')
        manifest = data_package("merge", {"mode": "array"})
        manifest["workflow"]["definition"]["nodes"][1]["inputBindings"] = {"context_1": {"nodeId": "input", "path": "text"}}
        run = self.start(manifest, FakeProviders([]), "only once")
        self.assertEqual(run["checkpoint"]["outputs"]["agent"]["data"], ["only once"])
        merged = runner.merge_data({"mode": "object"}, {"b": "second", "a": "first"})
        self.assertEqual(merged["data"], {"b": "second", "a": "first"})

    def test_retrieval_chunks_unicode_scores_sources_and_no_match(self):
        config = {"resourceIds": ["doc1", "doc2"], "topK": 2, "chunkSize": 200}
        manifest = data_package("transform", {"mode": "pick"})
        node = manifest["workflow"]["definition"]["nodes"][1]
        node["type"] = "retrieval"
        node.pop("transform")
        node["retrieval"] = config
        manifest["resources"] = [{"id": ident, "name": ident, "type": "document", "content": content, "url": "https://example.test/" + ident, "updatedAt": "fixed-version"} for ident, content in [("doc1", "사과 회사의 Apple 문서"), ("doc2", "관계없는 문서")]]
        runner.validate_package(manifest)
        providers = FakeProviders([])
        run = self.start(manifest, providers, "사과 Apple")
        output = run["checkpoint"]["outputs"]["agent"]
        self.assertEqual(output["count"], 1)
        self.assertEqual(output["matches"][0]["resourceId"], "doc1")
        self.assertEqual(output["matches"][0]["score"], 2)
        self.assertEqual(output["matches"][0]["version"], "fixed-version")
        self.assertIn("출처: https://example.test/doc1", output["text"])
        self.assertEqual(len(providers.models), 0)
        empty = runner.retrieve_documents(config, {"text": "xyz"}, manifest["resources"])
        self.assertEqual(empty["count"], 0)
        self.assertIn("검색된 근거가 없어요", empty["text"])
        with self.assertRaises(runner.Fault):
            runner.retrieve_documents(config, {"text": "  "}, manifest["resources"])

    def test_retrieval_codepoint_boundaries_and_stable_resource_order(self):
        config = {"resourceIds": ["b", "a"], "topK": 10, "chunkSize": 200}
        content = "🍎" * 198 + "사과"
        resources = [{"id": ident, "name": ident, "type": "document", "content": content, "url": "", "updatedAt": "v1"} for ident in ("a", "b")]
        result = runner.retrieve_documents(config, {"text": "사과"}, resources)
        self.assertEqual([m["resourceId"] for m in result["matches"]], ["b", "a"])
        self.assertEqual([m["chunkIndex"] for m in result["matches"]], [0, 0])
        self.assertEqual(len(result["matches"][0]["excerpt"]), 200)
        self.assertEqual(runner.retrieval_tokens("워크플로 검색"), ["워크플로", "워크", "크플", "플로", "검색"])

    def test_transform_merge_dag_waits_for_both_branches(self):
        manifest = data_package("transform", {"mode": "parse_json"})
        definition = manifest["workflow"]["definition"]
        definition["nodes"].insert(2, {"id": "name", "type": "transform", "title": "이름", "transform": {"mode": "template", "template": "이름: {{data.name}}"}, "inputBindings": {"data": {"nodeId": "agent", "path": "data"}}})
        definition["nodes"].insert(3, {"id": "task", "type": "transform", "title": "작업", "transform": {"mode": "template", "template": "작업: {{data.task}}"}, "inputBindings": {"data": {"nodeId": "agent", "path": "data"}}})
        definition["nodes"].insert(4, {"id": "merge", "type": "merge", "title": "결과", "merge": {"mode": "text", "separator": "\n"}, "inputBindings": {"second": {"nodeId": "task", "path": "text"}, "first": {"nodeId": "name", "path": "text"}}})
        definition["nodes"][-1]["inputBindings"] = {"text": {"nodeId": "merge", "path": "text"}}
        edges = [("input", "agent"), ("agent", "name"), ("agent", "task"), ("name", "merge"), ("task", "merge"), ("merge", "output")]
        definition["edges"] = [{"id": str(i), "source": source, "target": target} for i, (source, target) in enumerate(edges)]
        runner.validate_package(manifest)
        provider = FakeProviders([])
        run = self.start(manifest, provider, '{"name":"민수","task":"정리"}')
        self.assertEqual(run["result"], "이름: 민수\n작업: 정리")
        self.assertEqual(run["status"], "succeeded")
        self.assertEqual(run["checkpoint"]["completed"], ["input", "agent", "name", "task", "merge", "output"])
        self.assertEqual(len(provider.models) + len(provider.calls), 0)

    def test_merge_omits_inactive_condition_edge_even_when_other_input_activates_node(self):
        manifest = data_package("merge", {"mode": "object"})
        definition = manifest["workflow"]["definition"]
        definition["nodes"].insert(1, {"id": "condition", "type": "condition", "title": "조건", "condition": "yes"})
        definition["nodes"].append({"id": "noOutput", "type": "output", "title": "거짓"})
        merge = next(n for n in definition["nodes"] if n["id"] == "agent")
        merge["inputBindings"] = {"always": {"nodeId": "input", "path": "text"}, "conditional": {"nodeId": "condition", "path": "text"}}
        definition["edges"] += [{"id": "input-condition", "source": "input", "target": "condition"},
                                {"id": "yes", "source": "condition", "target": "agent", "branch": "yes"},
                                {"id": "no", "source": "condition", "target": "noOutput", "branch": "no"}]
        runner.validate_package(manifest)
        run = self.start(manifest, FakeProviders([]), "no")
        self.assertEqual(run["status"], "succeeded")
        self.assertFalse(run["checkpoint"]["branches"]["condition"])
        self.assertEqual(run["checkpoint"]["outputs"]["agent"]["data"], {"always": "no"})
        merged_input = runner.resolve_input(definition, merge, run["checkpoint"]["outputs"], run["checkpoint"]["skipped"], run["checkpoint"]["branches"])
        self.assertEqual(merged_input, {"always": "no"})
        definition["edges"].append({"id": "also-no", "source": "condition", "target": "agent", "branch": "no"})
        self.assertEqual(runner.resolve_input(definition, merge, run["checkpoint"]["outputs"], [], {"condition": False}), {"always": "no", "conditional": "no"})

    def test_v1_v2_v3_v4_migrate_to_v5_and_unsafe_new_configs_rejected(self):
        for version in (1, 2, 3, 4):
            manifest = package()
            manifest["workflow"]["definition"]["schemaVersion"] = version
            converted = runner.validate_package(manifest)
            self.assertEqual(converted["workflow"]["definition"]["schemaVersion"], 5)
            self.assertEqual(converted["workflow"]["definition"]["nodes"][1]["type"], "agent")
        for kind, config in [("transform", {"mode": "pick", "fields": {"a": "data.__proto__.key"}}), ("merge", {"mode": "text", "separator": "x" * 201}), ("tool", {"arguments": {"query": "x" * 20001}, "bindings": {}}), ("retrieval", {"resourceIds": ["a"], "topK": 11, "chunkSize": 700})]:
            with self.assertRaises(runner.Fault):
                data_package(kind, config)

    def test_shared_schema_rejects_inapplicable_or_ill_typed_constraints(self):
        invalid = [
            {"type": "object", "properties": None}, {"type": "object", "required": None},
            {"type": "object", "required": ["text"] * 41}, {"type": "string", "required": ["text"]},
            {"type": "object", "items": {"type": "string"}}, {"type": "array", "items": None},
            {"type": "object", "additionalProperties": "false"}, {"type": "string", "additionalProperties": False},
            {"type": "array", "unknownConstraint": True},
        ]
        for schema in invalid:
            with self.subTest(schema=schema), self.assertRaises(runner.Fault):
                runner.check_schema(schema)
        runner.check_schema({"type": "object", "properties": {}, "required": [], "additionalProperties": False})
        with self.assertRaises(runner.Fault):
            runner.read_path({"items": [1]}, "items.length")
        for text in ("9" * 1000, "[" * 1100 + "0" + "]" * 1100):
            with self.assertRaises(runner.Fault):
                runner.transform_data({"mode": "parse_json"}, {"text": text})

    def test_unicode_configuration_lengths_match_typescript_units(self):
        with self.assertRaises(runner.Fault):
            data_package("transform", {"mode": "template", "template": "🍎" * 6001})
        with self.assertRaises(runner.Fault):
            data_package("merge", {"mode": "text", "separator": "🍎" * 101})
        manifest = data_package("transform", {"mode": "pick"})
        manifest["resources"] = [{"id": "korean", "type": "document", "content": "한" * 100000}]
        runner.validate_package(manifest)
        self.assertEqual(runner.js_length("🍎한"), 3)

    def test_check_and_nonmodel_run_need_no_keys_and_never_touch_network(self):
        manifest = data_package("transform", {"mode": "template", "template": "확인: {{text}}"})
        path = self.directory / "workflow.json"
        path.write_text(json.dumps(manifest), encoding="utf-8")
        flags = ["--package", str(path), "--env", str(self.directory / "missing.env"), "--state", str(self.store.directory)]
        with patch.object(runner.Http, "post", side_effect=AssertionError("must stay offline")), patch.dict(os.environ, {"OPENAI_API_KEY": "ambient-must-not-be-used"}):
            out = io.StringIO()
            with patch("sys.stdout", out):
                self.assertEqual(runner.main(["check"] + flags), 0)
            checked = json.loads(out.getvalue())
            self.assertEqual(checked["status"], "ready")
            self.assertFalse(checked["requiresModel"])
            with patch("sys.stdout", io.StringIO()):
                self.assertEqual(runner.main(["run", "--input", "no key"] + flags), 0)
        path.write_text(json.dumps(package()), encoding="utf-8")
        checked = runner.check_project(path, self.directory / "missing.env")
        self.assertEqual(checked["status"], "unconfigured")
        self.assertEqual(checked["missingEnv"], ["FLOWLY_MCP_TOKEN_TEST", "FLOWLY_MODEL", "OPENAI_API_KEY"])
        self.assertNotIn("ambient-must-not-be-used", json.dumps(checked))

    def test_check_unused_connection_is_not_a_required_credential(self):
        manifest = data_package("transform", {"mode": "pick"})
        manifest["resources"] = package()["resources"]
        manifest["connections"] = package()["connections"]
        manifest["connections"][0].pop("endpoint")
        path = self.directory / "workflow.json"
        path.write_text(json.dumps(manifest), encoding="utf-8")
        checked = runner.check_project(path, self.directory / "missing.env")
        self.assertEqual(checked["status"], "ready")
        self.assertEqual(checked["missingEnv"], [])
        with patch.object(runner.Http, "post", side_effect=AssertionError("offline")), patch("sys.stdout", io.StringIO()):
            self.assertEqual(runner.main(["run", "--input", "only local", "--package", str(path), "--env", str(self.directory / "missing.env"), "--state", str(self.store.directory)]), 0)

    def test_check_rejects_missing_or_invalid_fixed_tool_arguments(self):
        path = self.directory / "workflow.json"
        for arguments in ({}, {"query": True}):
            manifest = data_package("tool", {"arguments": arguments, "bindings": {}})
            path.write_text(json.dumps(manifest), encoding="utf-8")
            result = runner.check_project(path, self.directory / "missing.env")
            self.assertEqual(result["status"], "invalid")
            self.assertTrue(result["errors"])

    def test_report_escapes_untrusted_html_without_env_or_network_and_refuses_overwrite(self):
        manifest = data_package("transform", {"mode": "template", "template": "{{text}}"})
        path = self.directory / "workflow.json"
        path.write_text(json.dumps(manifest), encoding="utf-8")
        loaded, package_hash = runner.load_package(path)
        run = runner.new_run(loaded, "<script>unsafe()</script>")
        runner.Engine(loaded, package_hash, self.store, FakeProviders([]), run).execute()
        run["workflow"]["definition"]["nodes"][0]["title"] = "Bearer title-secret-value"
        self.store.save(package_hash, run)
        output = self.directory / "report.html"
        flags = ["--package", str(path), "--state", str(self.store.directory), "--output", str(output)]
        printed = io.StringIO()
        with patch.object(runner, "load_env", side_effect=AssertionError("no credentials for report")), patch.object(runner.Http, "post", side_effect=AssertionError("offline report")), patch("sys.stdout", printed):
            self.assertEqual(runner.main(["report", run["id"]] + flags), 0)
        self.assertEqual(json.loads(printed.getvalue()), {"status": "report_written", "runId": run["id"], "output": str(output.resolve())})
        text = output.read_text(encoding="utf-8")
        self.assertIn("Content-Security-Policy", text)
        self.assertNotIn("<script>", text)
        self.assertIn("&lt;script&gt;unsafe()&lt;/script&gt;", text)
        self.assertNotIn("title-secret-value", text)
        with patch("sys.stderr", io.StringIO()):
            self.assertEqual(runner.main(["report", run["id"]] + flags), 1)
        self.assertEqual(output.read_text(encoding="utf-8"), text)


class ProviderTests(unittest.TestCase):
    def test_absolute_http_deadline_stops_dripping_socket(self):
        reader, writer = socket.socketpair()
        stopped = threading.Event()
        class Response:
            headers = {"Content-Type": "application/json"}
            def __enter__(self):
                return self
            def __exit__(self, *args):
                stopped.set()
                reader.close()
                writer.close()
            def read1(self, size):
                return reader.recv(size)
        http = runner.Http()
        def open_response(*args, **kwargs):
            http.active_request[0].append(reader)
            return Response()
        def drip():
            while not stopped.wait(0.005):
                try:
                    writer.send(b" ")
                except OSError:
                    break
        thread = threading.Thread(target=drip, daemon=True)
        thread.start()
        started = time.monotonic()
        try:
            with patch.object(http.opener, "open", side_effect=open_response):
                with self.assertRaises(runner.Fault) as caught:
                    http.post("https://example.com/mcp", {}, {}, 40)
            self.assertEqual(caught.exception.code, "budget_exceeded")
            self.assertLess(time.monotonic() - started, 0.5)
        finally:
            stopped.set()
            reader.close()
            writer.close()
            thread.join(timeout=1)

    def test_openai_request_and_secret_redaction(self):
        captured = []
        class FakeHttp:
            def post(self, url, body, headers, timeout):
                captured.append((url, body, headers))
                return {"status": "completed", "usage": {"total_tokens": 11}, "output": [{"type": "message", "content": [{"type": "output_text", "text": "echo offline-secret-value"}]}]}, {}
        provider = runner.Providers({"OPENAI_API_KEY": "offline-secret-value", "FLOWLY_MODEL": "mock-only"}, [], FakeHttp())
        reply = provider.model([{"role": "user", "content": "hello"}], [], 100, 5000)
        self.assertEqual(captured[0][0], "https://api.openai.com/v1/responses")
        self.assertIs(captured[0][1]["store"], False)
        self.assertIs(captured[0][1]["parallel_tool_calls"], False)
        self.assertEqual(captured[0][1]["reasoning"], {"effort": "none"})
        self.assertNotIn("offline-secret-value", reply["text"])

    def test_provider_requests_use_normalized_model_and_embedding_defaults(self):
        for supplied in (None, "", "   ", "  custom-embedding  "):
            with self.subTest(embedding=supplied):
                captured = []
                expected = (supplied or "").strip() or "text-embedding-3-small"
                class FakeHttp:
                    def post(inner, url, body, headers, timeout, **kwargs):
                        captured.append(body["model"])
                        if url.endswith("/embeddings"):
                            return {"model": expected, "data": [{"index": 0, "embedding": [1, 0]}], "usage": {"total_tokens": 1}}, {}
                        message = {"type": "message", "content": [{"type": "output_text", "text": "합성 응답", "annotations": [{"type": "url_citation", "url": "https://example.test/reference", "title": "합성 근거"}]}]}
                        output = ([{"type": "web_search_call", "status": "completed"}] if body.get("tool_choice") == "required" else []) + [message]
                        return {"status": "completed", "usage": {"total_tokens": 1}, "output": output}, {}
                env = {"OPENAI_API_KEY": "synthetic-boundary-only", "FLOWLY_MODEL": "  synthetic-model  "}
                if supplied is not None:
                    env["FLOWLY_EMBEDDING_MODEL"] = supplied
                provider = runner.Providers(env, [], FakeHttp())
                provider.model([], [], 100, 5000)
                provider.embed(["cats"], 100, 5000)
                provider.search("cats", 100, 5000)
                self.assertEqual(captured, ["synthetic-model", expected, "synthetic-model"])
                self.assertEqual(provider.embedding_model, expected)

    def test_mcp_handshake_headers_fixed_policy_and_secret_redaction(self):
        captured = []
        class FakeHttp:
            def post(self, url, body, headers, timeout, rpc_id=None, notification=False):
                captured.append((url, body, headers))
                if body["method"] == "initialize":
                    result = {"protocolVersion": runner.VERSION, "capabilities": {"tools": {}}}
                elif notification:
                    return {}, {}
                else:
                    result = {"content": [{"type": "text", "text": "token offline-mcp-token"}]}
                return {"jsonrpc": "2.0", "id": rpc_id, "result": result}, {"Mcp-Session-Id": "session-1"}
        manifest = package()
        tool = manifest["connections"][0]["tools"][0]
        tool["supportsIdempotency"] = True
        provider = runner.Providers({"OPENAI_API_KEY": "offline-ai-token", "FLOWLY_MODEL": "mock-only", "FLOWLY_MCP_TOKEN_TEST": "offline-mcp-token"}, manifest["connections"], FakeHttp())
        result = provider.tool(tool, {"query": "hi"}, "stable-key", 5000)
        self.assertEqual([item[1]["method"] for item in captured], ["initialize", "notifications/initialized", "tools/call"])
        self.assertEqual(captured[-1][2]["Mcp-Session-Id"], "session-1")
        self.assertEqual(captured[-1][1]["params"]["_meta"], {"flowly/idempotencyKey": "stable-key"})
        self.assertNotIn("offline-mcp-token", json.dumps(result))

    def test_safe_url_no_redirect_and_sse_ignores_server_requests(self):
        for endpoint in ("ftp://example.com", "https://example.com/mcp#fragment", "http://host:65536/mcp", "https://example.com/mcp?token=x", "https://u:p@example.com/mcp", "https://@host/mcp"):
            with self.assertRaises(runner.Fault):
                runner.safe_endpoint(endpoint)
        with self.assertRaises(runner.Fault):
            runner.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.test")
        data = b'data: {"jsonrpc":"2.0","id":"server-request","method":"sampling/createMessage"}\n\ndata: {"jsonrpc":"2.0","id":"wanted","result":{"ok":true}}\n\n'
        class Response(io.BytesIO):
            headers = {"Content-Type": "text/event-stream"}
        http = runner.Http()
        with patch.object(http.opener, "open", return_value=Response(data)):
            result, _ = http.post("https://example.com/mcp", {}, {}, 5000, "wanted")
        self.assertEqual(result["result"], {"ok": True})

    def test_endpoint_policy_allows_internal_http_https_and_custom_ports(self):
        for endpoint in ("http://localhost/mcp", "http://10.0.0.4:8080/mcp", "https://[::1]:8443/mcp", "https://service.internal/mcp", "http://mcp/mcp", "https://tools.example.test/mcp", "https://tools.example.com:443/mcp"):
            with self.subTest(endpoint=endpoint):
                self.assertEqual(runner.safe_endpoint(endpoint), endpoint)
        for endpoint in ("http://[invalid]/mcp", "http://host:0/mcp", "http://host:65536/mcp", "http://host name/mcp", "http:///mcp", "http://user:password@host/mcp"):
            with self.subTest(endpoint=endpoint), self.assertRaises(runner.Fault):
                runner.safe_endpoint(endpoint)



def advanced_definition(node):
    node = {"id": "work", "title": "작업", **copy.deepcopy(node)}
    edges = [{"id": "in", "source": "input", "target": "work"}]
    labels = ["yes", "no"] if node["type"] == "review" else [item["id"] for item in node.get("classification", {}).get("labels", [])]
    edges += [{"id": "out" + str(index), "source": "work", "target": "output", **({"branch": label} if label else {})} for index, label in enumerate(labels or [None])]
    return {"schemaVersion": 4, "nodes": [{"id": "input", "type": "input", "title": "입력"}, node,
            {"id": "output", "type": "output", "title": "결과"}], "edges": edges}


def advanced_package(node, tools=False):
    manifest = package()
    manifest["workflow"]["definition"] = advanced_definition(node)
    if not tools:
        manifest["resources"], manifest["connections"] = [], []
    return runner.validate_package(manifest)


def template_child(template="{{text}}", fields=None):
    node = {"type": "transform", "transform": {"mode": "template", "template": template}}
    if fields:
        node["inputBindings"] = {key: {"nodeId": "input", "path": path} for key, path in fields.items()}
    return advanced_definition(node)


def tasks(*definitions):
    return [{"id": "task_" + str(i), "name": "작업 " + str(i), "definition": definition} for i, definition in enumerate(definitions)]


class AdvancedRuntimeTests(unittest.TestCase):
    setUp = RuntimeTests.setUp
    tearDown = RuntimeTests.tearDown
    start = RuntimeTests.start
    resume = RuntimeTests.resume

    def test_parallel_read_calls_overlap_and_children_are_durable_first(self):
        manifest = package()
        selection = manifest["workflow"]["definition"]["nodes"][1]["allowedTools"]
        child = advanced_definition({"type": "tool", "allowedTools": selection, "tool": {"arguments": {}, "bindings": {"query": "text"}}})
        manifest = advanced_package({"type": "parallel", "parallel": {"tasks": tasks(child, child), "concurrency": 2}}, tools=True)
        barrier = threading.Barrier(2)
        class Concurrent(FakeProviders):
            def tool(inner, tool, args, key, timeout):
                files = list(self.store.directory.glob("run_*.json"))
                saved = json.loads(files[0].read_text(encoding="utf-8"))["run"]
                self.assertEqual(len(saved["checkpoint"]["groups"]["work"]["children"]), 2)
                barrier.wait(timeout=2)
                return super().tool(tool, args, key, timeout)
        provider = Concurrent([])
        run = self.start(manifest, provider, "동시 읽기")
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        self.assertEqual(len(provider.calls), 2)
        self.assertEqual(run["checkpoint"]["toolCalls"], 2)
        self.assertEqual(run["checkpoint"]["outputs"]["work"]["count"], 2)
        self.resume(manifest, provider, run)
        self.assertEqual(len(provider.calls), 2)

    def test_twenty_loop_items_run_with_zero_assigned_model_budget(self):
        manifest = advanced_package({"type": "loop", "loop": {"definition": template_child("{{item}}", {"item": "item"}), "itemsPath": "items", "maxItems": 20, "concurrency": 4},
                                     "inputBindings": {"items": {"nodeId": "input", "path": "items"}}})
        run = runner.new_run(manifest, "", {"items": list(range(20))})
        runner.Engine(manifest, "package-hash", self.store, FakeProviders([]), run).execute()
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        self.assertEqual(run["checkpoint"]["outputs"]["work"]["count"], 20)
        self.assertEqual(run["checkpoint"]["groups"]["work"]["children"][0]["limits"]["maxTurns"], 0)
        self.assertEqual(run["checkpoint"]["turns"], 0)
        for items in ([], list(range(21))):
            run = runner.new_run(manifest, "", {"items": items})
            runner.Engine(manifest, "package-hash", self.store, FakeProviders([]), run).execute()
            self.assertEqual(run["status"], "succeeded" if not items else "failed")

    def test_recursive_review_edit_and_resume_and_terminal_decisions(self):
        child = advanced_definition({"type": "review", "review": {"instructions": "확인", "allowEdit": True, "timeoutMinutes": 5}})
        manifest = advanced_package({"type": "subworkflow", "subworkflow": {"definition": child}})
        provider = FakeProviders([])
        run = self.start(manifest, provider)
        self.assertEqual(run["status"], "waiting_review", run.get("error"))
        child_run = run["checkpoint"]["groups"]["work"]["children"][0]
        review = child_run["reviews"][0]
        self.assertEqual(runner.summary(run)["children"][0]["run"]["reviews"][0]["id"], review["id"])
        self.assertIn(review["id"], runner.report_html(run))
        with self.assertRaises(runner.Fault):
            runner.decide_review(run, review["id"], "accept", "bob")
        runner.decide_review(run, review["id"], "accept", "alice", {"text": "수정됨"})
        self.assertEqual(run["status"], "queued")
        self.store.save("package-hash", run)
        run = self.resume(manifest, provider, run)
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        self.assertEqual(run["result"], "수정됨")
        with self.assertRaises(runner.Fault):
            runner.decide_review(run, review["id"], "accept", "alice", {"text": "수정됨"})
        self.assertEqual(run["status"], "succeeded")

    def test_review_rejection_expiry_edit_policy_and_hash_binding(self):
        manifest = advanced_package({"type": "review", "review": {"instructions": "", "allowEdit": False, "timeoutMinutes": 5}})
        run = self.start(manifest, FakeProviders([]))
        review = run["reviews"][0]
        with self.assertRaises(runner.Fault):
            runner.decide_review(run, review["id"], "accept", "alice", {"text": "수정"})
        runner.decide_review(run, review["id"], "reject", "alice")
        self.store.save("package-hash", run)
        run = self.resume(manifest, FakeProviders([]), run)
        self.assertFalse(run["checkpoint"]["outputs"]["work"]["approved"])
        self.assertEqual(run["checkpoint"]["routes"]["work"], "no")
        for mutate in (lambda review: review.update(expiresAt="2020-01-01T00:00:00Z"), lambda review: review["input"].update(text="바뀜")):
            run = self.start(manifest, FakeProviders([]))
            mutate(run["reviews"][0])
            with self.assertRaises(runner.Fault):
                runner.decide_review(run, run["reviews"][0]["id"], "accept", "alice")

    def test_public_status_flattens_nested_reviews_and_approvals_without_duplicates(self):
        review = advanced_definition({"type": "review", "review": {"instructions": "확인", "allowEdit": False, "timeoutMinutes": 5}})
        child = advanced_definition({"type": "subworkflow", "subworkflow": {"definition": review}})
        manifest = advanced_package({"type": "subworkflow", "subworkflow": {"definition": child}})
        run = self.start(manifest, FakeProviders([]))
        status = runner.summary(run)
        self.assertEqual(status["status"], "waiting_review")
        self.assertEqual(len(status["reviews"]), 1)
        self.assertEqual(status["reviews"][0]["id"], status["children"][0]["run"]["children"][0]["run"]["reviews"][0]["id"])
        self.assertEqual(status["workflowId"], "flow")
        self.assertEqual(status["limits"], manifest["limits"])
        manifest, _, run = self.waiting_writes()
        status = runner.summary(run)
        self.assertEqual(len(status["approvals"]), 2)
        self.assertEqual(len({item["id"] for item in status["approvals"]}), 2)
        self.assertTrue(all(item["effect"] == "write" and item["args"] == {"query": run["input"]} for item in status["approvals"]))

    def test_orchestrator_plan_survives_review_pause_without_another_model(self):
        child = advanced_definition({"type": "review", "review": {"instructions": "확인", "allowEdit": False, "timeoutMinutes": 5}})
        manifest = advanced_package({"type": "orchestrator", "prompt": "두 번째 작업 선택", "orchestration": {"tasks": tasks(template_child("미선택"), child), "maxTasks": 1}})
        provider = FakeProviders([answer('{"tasks":["task_1"]}')])
        run = self.start(manifest, provider)
        self.assertEqual(run["status"], "waiting_review", run.get("error"))
        group = run["checkpoint"]["groups"]["work"]
        self.assertEqual(group["plan"], ["task_1"])
        runner.decide_review(run, group["children"][0]["reviews"][0]["id"], "accept", "alice")
        self.store.save("package-hash", run)
        run = self.resume(manifest, provider, run)
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        self.assertEqual(len(provider.models), 1)
        invalid = self.start(manifest, FakeProviders([answer('{"tasks":["invented"]}')]))
        self.assertEqual(invalid["status"], "failed")
        self.assertFalse(invalid["checkpoint"]["groups"])

    def test_team_modes_pass_previous_and_results_and_share_budget(self):
        child = advanced_definition({"type": "agent", "prompt": "역할 답변", "allowedTools": [], "inputBindings": {key: {"nodeId": "input", "path": key} for key in ("text", "previous", "results")}})
        for mode in ("sequential", "parallel"):
            manifest = advanced_package({"type": "agent_team", "team": {"tasks": tasks(child, child), "mode": mode, "concurrency": 2}})
            def model(messages):
                data = json.loads(messages[0]["content"])["input"]
                self.assertIn("previous", data)
                self.assertIn("results", data)
                return answer("두 번째" if data["previous"] else "첫 번째")
            provider = FakeProviders([model, model])
            run = self.start(manifest, provider)
            self.assertEqual(run["status"], "succeeded", run.get("error"))
            self.assertEqual(run["checkpoint"]["turns"], 2)
            self.assertEqual(run["checkpoint"]["tokens"], 20)
            expected = "첫 번째\n두 번째" if mode == "sequential" else "첫 번째\n첫 번째"
            self.assertEqual(run["result"], expected)

    def test_classifier_uses_registered_route_only(self):
        node = {"type": "classify", "prompt": "분류", "classification": {"labels": [{"id": "a", "name": "가", "description": ""}, {"id": "b", "name": "나", "description": ""}]}}
        manifest = advanced_package(node)
        run = self.start(manifest, FakeProviders([answer('{"label":"b","reason":"입력에 맞음"}')]))
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        self.assertEqual(run["checkpoint"]["routes"]["work"], "b")
        failed = self.start(manifest, FakeProviders([answer('{"label":"other","reason":""}')]))
        self.assertEqual(failed["status"], "failed")

    def test_form_validates_dates_boolean_unknown_fields_and_number(self):
        fields = [{"key": key, "label": key, "type": kind, "required": True} for key, kind in (("count", "number"), ("ok", "boolean"), ("day", "date"))]
        manifest = advanced_package({"type": "transform", "transform": {"mode": "template", "template": "{{text}}"}})
        manifest["workflow"]["definition"]["nodes"][0].update(type="form", form={"fields": fields})
        runner.validate_package(manifest)
        valid = {"count": 3, "ok": True, "day": "2024-02-29"}
        run = self.start(manifest, FakeProviders([]), json.dumps(valid))
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        self.assertEqual(run["checkpoint"]["outputs"]["input"]["data"], valid)
        for changed in ({**valid, "count": True}, {**valid, "ok": 1}, {**valid, "day": "2025-02-29"}, {**valid, "unknown": "x"}):
            self.assertEqual(self.start(manifest, FakeProviders([]), json.dumps(changed))["status"], "failed")

    def test_memory_operation_replay_scope_and_delete(self):
        write = advanced_package({"type": "memory", "memory": {"action": "write", "key": "name", "valuePath": "text"}})
        run = self.start(write, FakeProviders([]), "저장 값")
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        op = {"ownerId": "alice", "workflowId": "flow", "operationId": run["id"] + ":work", "action": "write", "key": "name", "value": "저장 값"}
        self.assertEqual(self.store.memory(op), {"data": "저장 값", "found": True})
        with self.assertRaises(runner.Fault):
            self.store.memory({**op, "value": "바뀜"})
        read = advanced_package({"type": "memory", "memory": {"action": "read", "key": "name", "defaultValue": "없음"}})
        result = self.start(read, FakeProviders([]))["checkpoint"]["outputs"]["work"]
        self.assertEqual(result["data"], "저장 값")
        read["workflow"]["id"] = "different"
        result = self.start(read, FakeProviders([]))["checkpoint"]["outputs"]["work"]
        self.assertFalse(result["found"])
        self.assertEqual(result["data"], "없음")
        delete = advanced_package({"type": "memory", "memory": {"action": "delete", "key": "name"}})
        self.assertTrue(self.start(delete, FakeProviders([]))["checkpoint"]["outputs"]["work"]["found"])

    def test_normal_error_branch_and_fatal_budget_cannot_branch(self):
        manifest = advanced_package({"type": "transform", "transform": {"mode": "parse_json"}})
        definition = manifest["workflow"]["definition"]
        definition["nodes"][1]["onError"] = "branch"
        definition["edges"][1]["branch"] = "success"
        definition["nodes"].extend([{"id": "handler", "type": "error", "title": "오류", "error": {"template": "안내: {{error.message}}"}, "inputBindings": {"error": {"nodeId": "work", "path": "error"}}}, {"id": "failure", "type": "output", "title": "오류 결과"}])
        definition["edges"].extend([{"id": "error", "source": "work", "target": "handler", "branch": "error"}, {"id": "handled", "source": "handler", "target": "failure"}])
        runner.validate_package(manifest)
        run = self.start(manifest, FakeProviders([]), "invalid json")
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        self.assertIn("안내:", run["result"])
        self.assertIn("output", run["checkpoint"]["skipped"])
        node = manifest["workflow"]["definition"]["nodes"][1]
        del node["transform"]
        node.update(type="ai", prompt="답변", limits={"maxTokens": 1})
        runner.validate_package(manifest)
        run = self.start(manifest, FakeProviders([]))
        self.assertEqual(run["status"], "budget_exceeded")
        self.assertNotIn("handler", run["checkpoint"]["completed"])

    def test_nested_write_approvals_deduplicate_across_parallel_children(self):
        manifest = package("write")
        selection = manifest["workflow"]["definition"]["nodes"][1]["allowedTools"]
        child = advanced_definition({"type": "tool", "allowedTools": selection, "tool": {"arguments": {}, "bindings": {"query": "text"}}})
        manifest["workflow"]["definition"] = advanced_definition({"type": "parallel", "parallel": {"tasks": tasks(child, child), "concurrency": 2}})
        runner.validate_package(manifest)
        provider = FakeProviders([])
        run = self.start(manifest, provider)
        self.assertEqual(run["status"], "waiting_approval", run.get("error"))
        # New work may stop once the first child waits. Resume it until each child is planned.
        for _ in range(3):
            pending = [a for child in runner.all_runs(run) for a in child["approvals"] if a["status"] == "pending"]
            for approval in pending:
                runner.decide(run, approval["id"], "approve", "alice")
            self.store.save("package-hash", run)
            run = self.resume(manifest, provider, run)
            if run["status"] == "succeeded":
                break
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        self.assertEqual(len(provider.calls), 1)
        self.assertEqual(run["checkpoint"]["toolCalls"], 1)
        approval = next(a for child in runner.all_runs(run) for a in child["approvals"])
        with self.assertRaises(runner.Fault):
            runner.decide(run, approval["id"], "approve", "alice")
        self.resume(manifest, provider, run)
        self.assertEqual(len(provider.calls), 1)

    def test_nested_unknown_write_stops_before_other_child_effects(self):
        child = package("write")["workflow"]["definition"]
        manifest = advanced_package({"type": "parallel", "parallel": {"tasks": tasks(child, child), "concurrency": 2}}, tools=True)
        manifest["connections"][0]["tools"][0]["effect"] = "write"
        provider = FakeProviders([call(), call()])
        run = self.start(manifest, provider)
        child_run = next(item for item in runner.all_runs(run) if item["approvals"])
        child_run["checkpoint"]["calls"][0].update(status="dispatching", attempts=1)
        self.store.save("package-hash", run)
        run = self.resume(manifest, FakeProviders([]), run)
        self.assertEqual(run["status"], "unknown_outcome")
        self.assertEqual(provider.calls, [])

    def test_nested_check_detects_models_and_invalid_recursive_config(self):
        child = advanced_definition({"type": "agent", "prompt": "역할", "allowedTools": []})
        manifest = advanced_package({"type": "subworkflow", "subworkflow": {"definition": child}})
        path = self.directory / "workflow.json"
        path.write_text(json.dumps(manifest), encoding="utf-8")
        checked = runner.check_project(path, self.directory / "missing.env")
        self.assertTrue(checked["requiresModel"])
        self.assertEqual(checked["counts"]["nodes"], 6)
        self.assertEqual(checked["missingEnv"], ["FLOWLY_MODEL", "OPENAI_API_KEY"])
        definition = template_child()
        for _ in range(4):
            definition = advanced_definition({"type": "subworkflow", "subworkflow": {"definition": definition}})
        manifest["workflow"]["definition"] = definition
        with self.assertRaises(runner.Fault):
            runner.validate_package(manifest)

    def test_export_resource_and_connection_counts_are_each_bounded_to_100(self):
        manifest = package()
        resource, connection = manifest["resources"][0], manifest["connections"][0]
        for index in range(1, 100):
            resource_id, connection_id = "resource_" + str(index), "connection_" + str(index)
            manifest["resources"].append({**resource, "id": resource_id})
            manifest["connections"].append({**connection, "id": connection_id, "resourceId": resource_id,
                "tools": [{**tool, "resourceId": resource_id, "connectionId": connection_id} for tool in connection["tools"]]})
        runner.validate_package(manifest)
        for key in ("resources", "connections"):
            oversized = copy.deepcopy(manifest)
            oversized[key].append(copy.deepcopy(oversized[key][0]))
            with self.subTest(collection=key), self.assertRaisesRegex(runner.Fault, "100"):
                runner.validate_package(oversized)

    def waiting_writes(self):
        manifest = package("write")
        selection = manifest["workflow"]["definition"]["nodes"][1]["allowedTools"]
        child = advanced_definition({"type": "tool", "allowedTools": selection, "tool": {"arguments": {}, "bindings": {"query": "text"}}})
        manifest["workflow"]["definition"] = advanced_definition({"type": "parallel", "parallel": {"tasks": tasks(child, child), "concurrency": 2}})
        runner.validate_package(manifest)
        provider = FakeProviders([])
        run = self.start(manifest, provider)
        children = run["checkpoint"]["groups"]["work"]["children"]
        reference = next(child for child in children if child["approvals"])
        # Persist both planned decisions, regardless of the pool's stop-start race.
        for child in children:
            if not child["approvals"]:
                call = copy.deepcopy(reference["checkpoint"]["calls"][0])
                call["id"] = "call_" + runner.uuid.uuid4().hex
                approval = copy.deepcopy(reference["approvals"][0])
                approval.update(id="approval_" + runner.uuid.uuid4().hex, runId=child["id"], callId=call["id"])
                child["checkpoint"].update(completed=["input"], outputs={"input": {"text": run["input"]}}, calls=[call], activeNodeId="work")
                child["approvals"], child["status"] = [approval], "waiting_approval"
        self.store.save("package-hash", run)
        return manifest, provider, run

    def test_global_denied_approval_wins_before_approved_sibling_dispatch(self):
        manifest, provider, run = self.waiting_writes()
        children = run["checkpoint"]["groups"]["work"]["children"]
        runner.decide(run, children[0]["approvals"][0]["id"], "approve", "alice")
        runner.decide(run, children[1]["approvals"][0]["id"], "deny", "alice")
        self.store.save("package-hash", run)
        run = self.resume(manifest, provider, run)
        self.assertEqual(run["status"], "failed")
        self.assertEqual(provider.calls, [])

    def test_write_completion_save_failure_poison_stops_sibling_and_recovery(self):
        manifest, provider, run = self.waiting_writes()
        for child in run["checkpoint"]["groups"]["work"]["children"]:
            runner.decide(run, child["approvals"][0]["id"], "approve", "alice")
        self.store.save("package-hash", run)
        original = self.store._save
        failed = []
        def fail_completed(package_hash, current):
            if not failed and any(call["status"] == "completed" for descendant in runner.all_runs(current) for call in descendant["checkpoint"]["calls"]):
                failed.append(True)
                raise OSError("injected checkpoint failure")
            return original(package_hash, current)
        with patch.object(self.store, "_save", side_effect=fail_completed), self.assertRaises(OSError):
            self.resume(manifest, provider, run)
        self.assertEqual(len(provider.calls), 1)
        recovered = runner.Store(self.directory / "state").load("package-hash", run["id"])
        runner.Engine(manifest, "package-hash", runner.Store(self.directory / "state"), provider, recovered).execute()
        self.assertEqual(recovered["status"], "unknown_outcome")
        self.assertEqual(len(provider.calls), 1)

    def test_child_model_zero_budget_from_parent_node_limit_calls_no_provider(self):
        child = advanced_definition({"type": "ai", "prompt": "답변"})
        manifest = advanced_package({"type": "parallel", "limits": {"maxTurns": 1}, "parallel": {"tasks": tasks(child, child), "concurrency": 2}})
        provider = FakeProviders([])
        run = self.start(manifest, provider)
        self.assertEqual(run["status"], "budget_exceeded")
        self.assertEqual(provider.models, [])
        self.assertFalse(run["errorRecoverable"])

    def test_nested_provider_timeout_is_clamped_to_ancestor_remaining_time(self):
        manifest = advanced_package({"type": "subworkflow", "subworkflow": {"definition": template_child()}})
        run = runner.new_run(manifest, "원문")
        parent = runner.Engine(manifest, "package-hash", self.store, FakeProviders([]), run)
        node = manifest["workflow"]["definition"]["nodes"][1]
        child = runner.new_run(manifest, "", {"text": "입력"})
        group = {"children": [child], "taskIds": ["task"], "accounted": {"turns": 0, "toolCalls": 0, "tokens": 0}}
        proxy = runner.ChildStore(parent, node, group, 0, threading.Event(), threading.Event())
        engine = runner.Engine(manifest, "package-hash", proxy, FakeProviders([]), child)
        with patch.object(parent, "guard", return_value=23):
            self.assertLessEqual(engine.guard(), 23)

    def test_review_schema_validation_preserves_pending_and_cli_stdout_json(self):
        manifest = advanced_package({"type": "review", "review": {"instructions": "", "allowEdit": True, "timeoutMinutes": 5},
                                     "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}})
        run = self.start(manifest, FakeProviders([]))
        with self.assertRaises(runner.Fault):
            runner.decide_review(run, run["reviews"][0]["id"], "accept", "alice", {"other": "누락"})
        self.assertEqual(run["reviews"][0]["status"], "pending")
        path = self.directory / "workflow.json"
        path.write_text(json.dumps(manifest), encoding="utf-8")
        state = self.directory / "cli-state"
        flags = ["--package", str(path), "--state", str(state), "--env", str(self.directory / "missing.env")]
        with patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(runner.main(["run", "--input", "검토", *flags]), 0)
            created = json.loads(output.getvalue())
        with patch("sys.stdout", new_callable=io.StringIO) as output, patch("sys.stderr", new_callable=io.StringIO):
            self.assertEqual(runner.main(["accept", created["id"], created["reviews"][0]["id"], *flags]), 0)
            self.assertEqual(json.loads(output.getvalue())["status"], "queued")

    @unittest.skipUnless(os.name == "nt", "Windows file sharing recovery")
    def test_snapshot_replace_retries_short_reader_lock_and_rechecks_owner(self):
        manifest = advanced_package({"type": "transform", "transform": {"mode": "template", "template": "{{text}}"}})
        run = runner.new_run(manifest, "test")
        original = os.replace
        count = []
        def transient(source, target):
            count.append(1)
            if len(count) == 1:
                raise PermissionError("reader holds file")
            return original(source, target)
        with patch.object(runner.os, "replace", side_effect=transient):
            self.store.save("package-hash", run)
        self.assertEqual(len(count), 2)
        self.assertEqual(self.store.load("package-hash", run["id"])["id"], run["id"])


class ExtendedRuntimeTests(unittest.TestCase):
    setUp = RuntimeTests.setUp
    tearDown = RuntimeTests.tearDown
    start = RuntimeTests.start
    resume = RuntimeTests.resume

    def test_guardrail_recurses_without_disclosing_detections_and_block_is_policy(self):
        value = {"text": "mail a@example.com", "rows": [{"phone": "010-1234-5678"}], "number": 7}
        result = runner.protect_input({"action": "mask", "categories": ["email", "phone"]}, value)
        self.assertNotIn("a@example.com", json.dumps(result))
        self.assertEqual(result["guardrail"]["counts"], {"email": 1, "phone": 1})
        self.assertEqual(result["number"], 7)
        removed = runner.protect_input({"action": "remove", "categories": ["email"]}, value)
        self.assertEqual(removed["text"], "mail ")
        with self.assertRaises(runner.ProtectedFault) as caught:
            runner.protect_input({"action": "block", "categories": ["email"]}, value)
        self.assertNotIn("a@example.com", str(caught.exception))
        manifest = advanced_package({"type": "guardrail", "guardrail": {"action": "block", "categories": ["email"]}})
        run = self.start(manifest, FakeProviders([]), "a@example.com")
        self.assertEqual(run["status"], "failed")
        self.assertFalse(run["errorRecoverable"])
        manifest["workflow"]["definition"]["nodes"][1]["onError"] = "branch"
        with self.assertRaises(runner.Fault):
            runner.validate_package(manifest)

    def test_rule_and_model_evaluation_preserve_text_and_validate_score(self):
        config = {"mode": "rules", "rules": [{"kind": "contains", "value": "정답"}, {"kind": "max_length", "value": "8"}], "rubric": "", "threshold": 1}
        manifest = advanced_package({"type": "evaluate", "evaluation": config})
        run = self.start(manifest, FakeProviders([]), "정답입니다")
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        output = run["checkpoint"]["outputs"]["work"]
        self.assertEqual(output["text"], "정답입니다")
        self.assertTrue(output["evaluation"]["passed"])
        manifest["workflow"]["definition"]["nodes"][1]["evaluation"].update(mode="model", rubric="정확성 평가")
        provider = FakeProviders([answer('{"score":0.8,"reason":"조건 충족"}')])
        run = self.start(manifest, provider)
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        self.assertEqual(run["checkpoint"]["turns"], 1)
        self.assertFalse(run["checkpoint"]["outputs"]["work"]["evaluation"]["passed"])
        run = self.start(manifest, FakeProviders([answer('{"score":1.2,"reason":"bad"}')]))
        self.assertEqual(run["status"], "failed")

    def test_local_memory_ttl_is_enforced_but_operation_replay_stays_stable(self):
        operation = {"ownerId": "alice", "workflowId": "flow", "operationId": "write", "action": "write", "key": "key", "value": "value", "ttlSeconds": 1}
        with patch.object(runner.time, "time", return_value=1000):
            self.assertEqual(self.store.memory(operation), {"data": "value", "found": True})
        with patch.object(runner.time, "time", return_value=1002):
            self.assertEqual(self.store.memory(operation), {"data": "value", "found": True})
            result = self.store.memory({"ownerId": "alice", "workflowId": "flow", "operationId": "read", "action": "read", "key": "key", "defaultValue": "missing"})
        self.assertEqual(result, {"data": "missing", "found": False})

    def test_mcp_memory_write_fixes_namespace_ttl_arguments_and_requires_approval(self):
        manifest = package("write")
        node = manifest["workflow"]["definition"]["nodes"][1]
        node.update(type="memory", memory={"backend": "mcp", "action": "write", "key": "name", "valuePath": "text", "ttlSeconds": 60})
        node["outputSchema"] = {"type": "object"}
        manifest["connections"][0]["tools"][0]["inputSchema"] = {"type": "object"}
        runner.validate_package(manifest)
        provider = FakeProviders([], tool_result={"structuredContent": {"data": "saved", "found": True, "expiresAt": "2050-01-01T00:00:00Z"}})
        run = self.start(manifest, provider)
        self.assertEqual(run["status"], "waiting_approval", run.get("error"))
        planned = copy.deepcopy(run["checkpoint"]["calls"][0]["args"])
        self.assertEqual(planned["namespace"], runner.digest({"ownerId": "alice", "workflowId": "flow"}))
        runner.decide(run, run["approvals"][0]["id"], "approve", "alice")
        self.store.save("package-hash", run)
        run = self.resume(manifest, provider, run)
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        self.assertEqual(provider.calls[0][1], planned)
        self.assertEqual(run["checkpoint"]["outputs"]["agent"]["data"], "saved")

    def test_mcp_memory_expired_read_uses_default_and_wrong_effect_is_rejected(self):
        manifest = package()
        node = manifest["workflow"]["definition"]["nodes"][1]
        node.update(type="memory", memory={"backend": "mcp", "action": "read", "key": "name", "defaultValue": "없음"}, outputSchema={"type": "object"})
        manifest["connections"][0]["tools"][0]["inputSchema"] = {"type": "object"}
        runner.validate_package(manifest)
        provider = FakeProviders([], tool_result={"structuredContent": {"data": "expired", "found": True, "expiresAt": "2020-01-01T00:00:00Z"}})
        run = self.start(manifest, provider)
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        self.assertEqual(run["checkpoint"]["outputs"]["agent"]["data"], "없음")
        manifest["connections"][0]["tools"][0]["effect"] = "write"
        with self.assertRaises(runner.Fault):
            runner.validate_package(manifest)

    def vector_package(self):
        manifest = advanced_package({"type": "retrieval", "retrieval": {"mode": "web", "resourceIds": [], "topK": 1, "chunkSize": 200}})
        manifest["resources"] = [{"id": key, "name": key, "ownerId": "alice", "type": "document", "content": key + " facts", "updatedAt": "version1"} for key in ("cats", "dogs")]
        manifest["workflow"]["definition"]["nodes"][1]["retrieval"].update(mode="vector", resourceIds=["cats", "dogs"])
        return runner.validate_package(manifest)

    def test_vector_retrieval_builds_real_adapter_index_and_reuses_scoped_cache(self):
        class Embeddings(FakeProviders):
            embedding_model = "injected-embedding"
            def __init__(inner):
                super().__init__([])
                inner.embeddings = []
            def embed(inner, texts, max_tokens, timeout):
                inner.embeddings.append(texts)
                return {"vectors": [[1, 0] if "cats" in text else [0, 1] for text in texts], "usageTokens": len(texts), "model": inner.embedding_model}
        manifest, provider = self.vector_package(), Embeddings()
        run = self.start(manifest, provider, "cats")
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        self.assertEqual(run["checkpoint"]["outputs"]["work"]["matches"][0]["resourceId"], "cats")
        self.assertEqual(run["checkpoint"]["turns"], 2)
        self.assertEqual(run["checkpoint"]["toolCalls"], 2)
        self.assertEqual(run["checkpoint"]["tokens"], 3)
        second = self.start(manifest, provider, "dogs")
        self.assertEqual(second["checkpoint"]["turns"], 1)
        self.assertEqual(len(provider.embeddings), 3)
        manifest["resources"][0]["content"] += " changed"
        self.start(manifest, provider, "cats")
        self.assertEqual(len(provider.embeddings), 5)

    def test_vector_budget_prevents_provider_and_check_requires_key_only(self):
        manifest = self.vector_package()
        manifest["limits"]["maxTokens"] = 1
        class Embeddings(FakeProviders):
            def embed(inner, *args):
                raise AssertionError("budget must prevent request")
        run = self.start(manifest, Embeddings([]), "cats")
        self.assertEqual(run["status"], "budget_exceeded")
        path = self.directory / "workflow.json"
        path.write_text(json.dumps(manifest), encoding="utf-8")
        checked = runner.check_project(path, self.directory / "missing.env")
        self.assertEqual(checked["missingEnv"], ["OPENAI_API_KEY"])

    def test_web_search_requires_https_sources_and_accounts_search_call(self):
        manifest = advanced_package({"type": "retrieval", "retrieval": {"mode": "web", "resourceIds": [], "topK": 3, "chunkSize": 700}})
        class Search(FakeProviders):
            def search(inner, query, tokens, timeout):
                return {"text": "근거 답변", "sources": [{"url": "https://example.com/source", "title": "근거"}], "usageTokens": 15}
        run = self.start(manifest, Search([]))
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        self.assertEqual(run["checkpoint"]["toolCalls"], 1)
        self.assertEqual(run["checkpoint"]["outputs"]["work"]["count"], 1)
        with patch.object(Search, "search", return_value={"text": "unsafe", "sources": [{"url": "http://example.com", "title": "bad"}], "usageTokens": 1}):
            self.assertEqual(self.start(manifest, Search([]))["status"], "failed")

    def test_adaptive_round_plan_is_durable_and_resume_does_not_replan(self):
        child = advanced_definition({"type": "review", "review": {"instructions": "검토", "allowEdit": False, "timeoutMinutes": 5}})
        manifest = advanced_package({"type": "orchestrator", "prompt": "완료 결과로 판단", "orchestration": {"tasks": tasks(child), "maxTasks": 1, "mode": "adaptive", "maxRounds": 2}})
        provider = FakeProviders([answer('{"done":false,"tasks":["task_0"]}'), answer('{"done":true,"tasks":[]}')])
        run = self.start(manifest, provider)
        self.assertEqual(run["status"], "waiting_review", run.get("error"))
        group = run["checkpoint"]["groups"]["work"]
        self.assertEqual(group["taskIds"], ["round_1_task_0"])
        runner.decide_review(run, runner.summary(run)["reviews"][0]["id"], "accept", "alice")
        self.store.save("package-hash", run)
        run = self.resume(manifest, provider, run)
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        self.assertTrue(run["checkpoint"]["groups"]["work"]["planningDone"])
        self.assertEqual(len(provider.models), 2)
        self.assertEqual(len(run["checkpoint"]["groups"]["work"]["rounds"]), 2)

    def test_adaptive_needs_explicit_done_within_max_rounds(self):
        manifest = advanced_package({"type": "orchestrator", "prompt": "계획", "orchestration": {"tasks": tasks(template_child()), "maxTasks": 1, "mode": "adaptive", "maxRounds": 1}})
        run = self.start(manifest, FakeProviders([answer('{"done":false,"tasks":["task_0"]}')]))
        self.assertEqual(run["status"], "budget_exceeded")
        self.assertFalse(run["errorRecoverable"])

    def test_trigger_preserves_launcher_input_and_nested_trigger_is_rejected(self):
        manifest = advanced_package({"type": "transform", "transform": {"mode": "template", "template": "{{text}}"}})
        manifest["workflow"]["definition"]["nodes"][0].update(type="trigger", trigger={"kind": "event", "intervalSeconds": 60, "startAt": "", "eventType": "created"})
        runner.validate_package(manifest)
        raw = '{"eventType":"created","text":"실행"}'
        run = self.start(manifest, FakeProviders([]), raw)
        self.assertEqual(run["result"], raw)
        self.assertEqual(run["checkpoint"]["outputs"]["input"]["data"], {"eventType": "created", "text": "실행"})
        self.assertEqual(self.start(manifest, FakeProviders([]), "plain")["checkpoint"]["outputs"]["input"]["data"], "plain")
        with self.assertRaises(runner.Fault):
            advanced_package({"type": "subworkflow", "subworkflow": {"definition": manifest["workflow"]["definition"]}})

    def test_file_form_rejects_absolute_parent_and_control_paths(self):
        field = {"fields": [{"key": "file", "label": "파일", "type": "file", "required": True}]}
        self.assertEqual(runner.form_data(field, {"file": "reports/note.txt"})["data"]["file"], "reports/note.txt")
        for filename in ("../outside.txt", "C:\\outside.txt", "/outside.txt", "folder/../outside.txt", "bad\x00.txt"):
            with self.subTest(filename=filename), self.assertRaises(runner.ProtectedFault):
                runner.form_data(field, {"file": filename})

    def test_embeddings_http_contract_orders_vectors_and_validates_usage(self):
        class MockHttp:
            def post(inner, url, body, headers, timeout, **kwargs):
                self.assertEqual(url, "https://api.openai.com/v1/embeddings")
                self.assertEqual(body["encoding_format"], "float")
                self.assertEqual(body["model"], "text-embedding-3-small")
                return {"model": body["model"], "data": [{"index": 1, "embedding": [0, 1]}, {"index": 0, "embedding": [1, 0]}], "usage": {"total_tokens": 2}}, {}
        provider = runner.Providers({"OPENAI_API_KEY": "injected-no-network"}, [], MockHttp(), require_model=False)
        self.assertEqual(provider.embed(["a", "b"], 10, 100)["vectors"], [[1, 0], [0, 1]])
        with patch.object(provider.http, "post", return_value=({"model": "text-embedding-3-small", "data": [], "usage": {"total_tokens": None}}, {})), self.assertRaises(runner.Fault):
            provider.embed(["a"], 10, 100)

    def test_sse_only_completed_response_becomes_final_and_reasoning_is_ignored(self):
        class Response(io.BytesIO):
            headers = {"Content-Type": "text/event-stream"}
            def read1(inner, size):
                return inner.read(17)
        partial = b'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'
        reasoning = b'data: {"type":"response.reasoning_text.delta","delta":"private reasoning"}\n\n'
        completed = {"type": "response.completed", "response": {"status": "completed", "usage": {"total_tokens": 9}, "output": [{"type": "message", "content": [{"type": "output_text", "text": "final"}]}]}}
        http = runner.Http()
        provider = runner.Providers({"OPENAI_API_KEY": "injected-no-network", "FLOWLY_MODEL": "mock"}, [], http)
        deltas = []
        with patch.object(http.opener, "open", return_value=Response(partial + reasoning + b"data: " + json.dumps(completed).encode() + b"\n\n")):
            reply = provider.model([], [], 50, 1000, on_delta=deltas.append)
        self.assertEqual(reply["text"], "final")
        self.assertEqual(deltas, ["partial"])
        with patch.object(http.opener, "open", return_value=Response(partial)), self.assertRaises(runner.Fault):
            provider.model([], [], 50, 1000, on_delta=deltas.append)

    def test_stream_events_are_partial_jsonl_and_hide_split_credentials(self):
        manifest = package(node_type="ai")
        manifest["workflow"]["definition"]["nodes"][-1]["delivery"] = {"stream": True}
        secret = "test-only-credential-value"
        class Streaming(FakeProviders):
            secrets = [secret]
            def model(inner, messages, tools, tokens, timeout, on_delta=None):
                for delta in (secret[:8], secret[8:], " " + "visible " * 60):
                    on_delta(delta)
                return answer("complete")
        with patch("sys.stderr", new_callable=io.StringIO) as stderr:
            run = self.start(manifest, Streaming([]))
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        self.assertEqual(run["result"], "complete")
        self.assertNotIn(secret, stderr.getvalue())
        self.assertTrue(all(json.loads(line)["partial"] for line in stderr.getvalue().splitlines()))
        self.assertTrue(any(event["type"] == "model_delta" for event in run["events"]))

    def bind_manifest(self, manifest):
        path = self.directory / "workflow.json"
        path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        self.store.bind_package(path, hashlib.sha256(path.read_bytes()).hexdigest())
        return path

    def test_actual_local_file_input_and_text_extraction_verify_hash(self):
        manifest = advanced_package({"type": "file_input", "fileInput": {"path": "file", "maxBytes": 100000}, "inputBindings": {"file": {"nodeId": "input", "path": "file"}}})
        self.bind_manifest(manifest)
        folder = self.directory / "inputs"
        folder.mkdir()
        document = folder / "note.txt"
        document.write_text("실제 로컬 문서\n두 번째 줄", encoding="utf-8")
        run = runner.new_run(manifest, "", {"file": "note.txt"})
        engine = runner.Engine(manifest, "package-hash", self.store, FakeProviders([]), run)
        engine.execute()
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        descriptor = run["checkpoint"]["outputs"]["work"]["file"]
        self.assertEqual(descriptor["sha256"], hashlib.sha256(document.read_bytes()).hexdigest())
        node = {"id": "extract", "type": "document_extract", "documentExtract": {"mode": "text", "filePath": "file", "maxPages": 10, "language": "kor+eng"}}
        extracted = engine.files(node, {"file": descriptor})
        self.assertIn("실제 로컬 문서", extracted["text"])
        document.write_text("changed", encoding="utf-8")
        with self.assertRaises(runner.Fault):
            engine.files(node, {"file": descriptor})
        with self.assertRaises(runner.ProtectedFault):
            engine.files(manifest["workflow"]["definition"]["nodes"][1], {"file": "../outside.txt"})

    def test_actual_csv_output_is_formula_safe_and_receipt_prevents_duplicates(self):
        manifest = advanced_package({"type": "file_output", "fileOutput": {"format": "csv", "filename": "report.csv", "dataPath": "data"}, "inputBindings": {"data": {"nodeId": "input", "path": "rows"}}})
        path = self.bind_manifest(manifest)
        run = runner.new_run(manifest, "", {"rows": [{"name": "=SUM(1,2)", "note": "safe"}]})
        engine = runner.Engine(manifest, "package-hash", self.store, FakeProviders([]), run)
        engine.execute()
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        descriptor = run["checkpoint"]["outputs"]["work"]["file"]
        result_path = path.parent / descriptor["path"]
        self.assertIn("'=SUM(1,2)", result_path.read_text(encoding="utf-8-sig"))
        repeated = engine.files(manifest["workflow"]["definition"]["nodes"][1], {"data": [{"name": "=SUM(1,2)", "note": "safe"}]})
        self.assertEqual(repeated["file"], descriptor)
        self.assertEqual(len(list((self.directory / "outputs").rglob("*.csv"))), 1)
        with self.assertRaises(runner.ProtectedFault):
            engine.files(manifest["workflow"]["definition"]["nodes"][1], {"data": [{"name": "different"}]})
        checked = runner.check_project(path, self.directory / "missing.env")
        self.assertEqual(checked["status"], "ready", checked)

    def test_file_check_reports_missing_dependencies_without_network_or_content(self):
        manifest = advanced_package({"type": "file_output", "fileOutput": {"format": "pdf", "filename": "report.pdf", "dataPath": "text"}})
        path = self.bind_manifest(manifest)
        response = type("Result", (), {"returncode": 0, "stdout": b'{"status":"unconfigured","missing":["reportlab"]}'})()
        with patch.object(runner.subprocess, "run", return_value=response) as invoked, patch.object(runner.Http, "post", side_effect=AssertionError("offline")):
            checked = runner.check_project(path, self.directory / "missing.env")
        self.assertEqual(checked["status"], "unconfigured")
        self.assertIn("reportlab", checked["errors"][0])
        self.assertNotIn("OPENAI_API_KEY", invoked.call_args.kwargs["env"])

    def test_compensation_has_new_approval_and_cannot_repeat_original_operation(self):
        manifest = package("write")
        original = manifest["workflow"]["definition"]["nodes"][1]
        original.update(type="tool", tool={"arguments": {"query": "create"}, "bindings": {}})
        compensation = {"id": "undo", "title": "보상", "type": "compensate", "allowedTools": copy.deepcopy(original["allowedTools"]), "compensation": {"sourceNodeId": "agent", "arguments": {"query": "undo"}, "bindings": {}}}
        definition = manifest["workflow"]["definition"]
        definition["nodes"].insert(2, compensation)
        definition["nodes"][-1]["inputBindings"] = {"text": {"nodeId": "undo", "path": "text"}}
        definition["edges"][1]["target"] = "undo"
        definition["edges"].append({"id": "done", "source": "undo", "target": "output"})
        runner.validate_package(manifest)
        provider = FakeProviders([], tool_result={"applied": True})
        run = self.start(manifest, provider)
        runner.decide(run, run["approvals"][0]["id"], "approve", "alice")
        self.store.save("package-hash", run)
        run = self.resume(manifest, provider, run)
        self.assertEqual(run["status"], "waiting_approval", run.get("error"))
        self.assertEqual(len(provider.calls), 1)
        self.assertEqual(len(run["approvals"]), 2)
        runner.decide(run, run["approvals"][1]["id"], "approve", "alice")
        self.store.save("package-hash", run)
        run = self.resume(manifest, provider, run)
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        self.assertEqual([call[1]["query"] for call in provider.calls], ["create", "undo"])
        self.resume(manifest, provider, run)
        self.assertEqual(len(provider.calls), 2)
        manifest["workflow"]["definition"]["nodes"][2]["compensation"]["arguments"]["query"] = "create"
        provider = FakeProviders([], tool_result={"applied": True})
        run = self.start(manifest, provider)
        runner.decide(run, run["approvals"][0]["id"], "approve", "alice")
        self.store.save("package-hash", run)
        run = self.resume(manifest, provider, run)
        self.assertEqual(run["status"], "failed")
        self.assertFalse(run["errorRecoverable"])
        self.assertEqual(len(provider.calls), 1)

    def test_memory_read_receipt_expires_and_trigger_secret_is_scrubbed(self):
        op = {"ownerId": "alice", "workflowId": "flow", "operationId": "write", "action": "write", "key": "key", "value": "value", "ttlSeconds": 1}
        read = {"ownerId": "alice", "workflowId": "flow", "operationId": "read", "action": "read", "key": "key", "defaultValue": "missing"}
        with patch.object(runner.time, "time", return_value=1000):
            self.store.memory(op)
            self.assertTrue(self.store.memory(read)["found"])
        with patch.object(runner.time, "time", return_value=1002):
            self.assertEqual(self.store.memory(read), {"data": "missing", "found": False})
        self.assertEqual(runner.local_secrets({"FLOWLY_TRIGGER_SECRET": "injected-trigger-secret"}), ["injected-trigger-secret"])

    def test_web_provider_requires_one_completed_search_and_citation(self):
        response = {"status": "completed", "usage": {"total_tokens": 7}, "output": [
            {"type": "web_search_call", "status": "completed"},
            {"type": "message", "content": [{"type": "output_text", "text": "근거", "annotations": [{"type": "url_citation", "url": "https://example.com/docs", "title": "문서"}]}]}]}
        provider = runner.Providers({"OPENAI_API_KEY": "injected-no-network", "FLOWLY_MODEL": "mock"}, [])
        with patch.object(provider.http, "post", return_value=(response, {})) as request:
            self.assertEqual(provider.search("질문", 50, 100)["usageTokens"], 7)
            self.assertEqual(request.call_args.args[1]["max_tool_calls"], 1)
            self.assertEqual(request.call_args.args[1]["tool_choice"], "required")
        response["output"].insert(0, {"type": "web_search_call", "status": "completed"})
        with patch.object(provider.http, "post", return_value=(response, {})), self.assertRaises(runner.Fault):
            provider.search("질문", 50, 100)

    def test_failed_stream_never_commits_partial_as_output(self):
        manifest = package(node_type="ai")
        manifest["workflow"]["definition"]["nodes"][-1]["delivery"] = {"stream": True}
        class Broken(FakeProviders):
            def model(inner, messages, tools, tokens, timeout, on_delta=None):
                on_delta("아직 미완료")
                raise runner.Fault("연결 중단")
        with patch("sys.stderr", new_callable=io.StringIO):
            run = self.start(manifest, Broken([]))
        self.assertEqual(run["status"], "failed")
        self.assertFalse(run.get("result"))
        self.assertNotIn("agent", run["checkpoint"]["outputs"])
        self.assertTrue(any(event["type"] == "model_delta" for event in run["events"]))

    def test_invalid_cached_vector_is_policy_failure_before_query(self):
        manifest = self.vector_package()
        class Vectors(FakeProviders):
            embedding_model = "text-embedding-3-small"
            def embed(inner, *args):
                self.fail("잘못된 캐시 이후 제공자를 호출하면 안 됩니다")
        with patch.object(self.store, "vector_cache", return_value={"model": "text-embedding-3-small", "vectors": [[0, 0], [0, 0]]}):
            run = self.start(manifest, Vectors([]))
        self.assertEqual(run["status"], "failed")
        self.assertFalse(run["errorRecoverable"])

    def test_stream_scrubs_split_mcp_and_trigger_secrets(self):
        manifest = package(node_type="ai")
        manifest["workflow"]["definition"]["nodes"][-1]["delivery"] = {"stream": True}
        secrets = ["injected-mcp-secret-value", "injected-trigger-secret-value"]
        class Streaming(FakeProviders):
            def model(inner, messages, tools, tokens, timeout, on_delta=None):
                for secret in secrets:
                    on_delta("visible " * 40 + secret[:9])
                    on_delta(secret[9:] + " done " * 50)
                return answer("complete")
        provider = Streaming([])
        provider.secrets = secrets
        with patch("sys.stderr", new_callable=io.StringIO) as stderr:
            run = self.start(manifest, provider)
        for secret in secrets:
            self.assertNotIn(secret, stderr.getvalue())
            self.assertNotIn(secret, json.dumps(run))

    def test_cancellation_of_active_write_keeps_unknown_outcome(self):
        manifest = package("write")
        provider = FakeProviders([call()])
        run = self.start(manifest, provider)
        runner.decide(run, run["approvals"][0]["id"], "approve", "alice")
        self.store.save("package-hash", run)
        provider.tool_error = runner.ProtectedFault("사용자 취소", "cancelled")
        run = self.resume(manifest, provider, run)
        self.assertEqual(run["status"], "unknown_outcome")
        self.assertEqual(run["checkpoint"]["calls"][0]["status"], "unknown_outcome")
        before = len(provider.calls)
        self.resume(manifest, provider, run)
        self.assertEqual(len(provider.calls), before)

    def test_model_setting_pin_blocks_resume_before_calls_but_allows_key_rotation(self):
        manifest = package(node_type="ai")
        run = runner.new_run(manifest, "입력")
        run["provider"] = {"model": "fixed-model"}
        provider = runner.Providers({"OPENAI_API_KEY": "injected-rotated", "FLOWLY_MODEL": "different-model"}, [])
        with patch.object(provider.http, "post", side_effect=AssertionError("must not send")):
            runner.Engine(manifest, "package-hash", self.store, provider, run).execute()
        self.assertEqual(run["status"], "failed")
        self.assertFalse(run["errorRecoverable"])
        run = runner.new_run(manifest, "입력")
        run["provider"] = {"model": "fixed-model"}
        provider.env["FLOWLY_MODEL"] = "fixed-model"
        with patch.object(provider, "model", return_value=answer("rotation works")):
            runner.Engine(manifest, "package-hash", self.store, provider, run).execute()
        self.assertEqual(run["status"], "succeeded")
        self.assertEqual(runner.summary(run)["provider"], {"model": "fixed-model"})

    def test_restored_read_only_run_blocks_engine_and_decisions(self):
        manifest = package("write")
        provider = FakeProviders([call()])
        run = self.start(manifest, provider)
        run["restoredReadOnly"] = True
        before = copy.deepcopy(run)
        with self.assertRaises(runner.ProtectedFault):
            runner.Engine(manifest, "package-hash", self.store, provider, run).execute()
        with self.assertRaises(runner.Fault):
            runner.decide(run, run["approvals"][0]["id"], "approve", "alice")
        with self.assertRaises(runner.Fault):
            runner.decide_review(run, "missing", "accept", "alice")
        self.assertEqual(run, before)
        self.assertEqual(provider.calls, [])
        self.assertTrue(runner.summary(run)["restoredReadOnly"])


if __name__ == "__main__":
    unittest.main()
