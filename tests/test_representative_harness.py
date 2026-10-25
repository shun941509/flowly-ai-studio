"""Required tool evidence policy in the real exported Python engine; no network."""
import copy
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_export_python import runner, package, FakeProviders, answer, call


class RequiredToolResultTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = runner.Store(Path(self.temp.name) / "state")

    def tearDown(self):
        self.temp.cleanup()

    def test_required_answer_and_source_reject_blank_missing_and_non_string_fields(self):
        config = {"mode": "rules", "rules": [{"kind": "not_blank", "value": "data.answer"}, {"kind": "not_blank", "value": "data.sourceId"}], "rubric": "", "threshold": 1}
        node = {"type": "evaluate", "evaluation": config}
        runner.validate_extended_config(node)
        for field in ("answer", "sourceId"):
            for value in ("", " \t\n\r\u00a0\u3000\ufeff", None, False, 0, [], {}):
                data = {"answer": "내용", "sourceId": "source", field: value}
                with self.subTest(field=field, value=value):
                    self.assertFalse(runner.evaluate_rules(config, "", {"data": data})["passed"])
        self.assertFalse(runner.evaluate_rules(config, "", {"data": {}})["passed"])
        self.assertTrue(runner.evaluate_rules(config, "", {"data": {"answer": " \t내용\n", "sourceId": " source "}})["passed"])
        for value in ("", "data.__proto__", "data.answer[0]", "a" * 501):
            invalid = copy.deepcopy(node)
            invalid["evaluation"]["rules"][0]["value"] = value
            with self.subTest(value=value), self.assertRaises(runner.Fault):
                runner.validate_extended_config(invalid)

    def manifest(self):
        manifest = package()
        node = manifest["workflow"]["definition"]["nodes"][1]
        node["requireToolResult"] = True
        node["limits"] = {"maxTurns": 3, "maxToolCalls": 2, "maxTokens": 7000, "maxDurationMs": 30000}
        return runner.validate_package(manifest)

    def execute(self, manifest, providers, run=None):
        run = run or runner.new_run(manifest, "확인할 질문")
        self.store.save("test-package", run)
        runner.Engine(manifest, "test-package", self.store, providers, run).execute()
        return run

    def test_answer_without_observation_is_corrected_then_real_tool_result_is_used(self):
        def observe_feedback(messages):
            self.assertTrue(any(message["role"] == "user" and "완료된 도구 결과가 없습니다" in message["content"] for message in messages))
            return call("확인할 질문")
        def observed(messages):
            self.assertIn("확인한 자료", json.dumps(messages, ensure_ascii=False))
            return answer("조회한 자료로 답변")
        providers = FakeProviders([answer("조회 없이 만든 주장"), observe_feedback, observed])
        run = self.execute(self.manifest(), providers)
        self.assertEqual(run["status"], "succeeded")
        self.assertEqual(run["result"], "조회한 자료로 답변")
        self.assertEqual(len(providers.calls), 1)
        self.assertEqual(sum(event["type"] == "tool_result_required" for event in run["events"]), 1)

    def test_repeated_answer_without_tool_stops_at_existing_turn_budget(self):
        providers = FakeProviders([answer("근거 없는 답변")] * 3)
        run = self.execute(self.manifest(), providers)
        self.assertEqual(run["status"], "budget_exceeded")
        self.assertEqual(run["result"], "")
        self.assertEqual(len(providers.models), 3)
        self.assertEqual(providers.calls, [])

    def test_completed_call_from_another_node_or_unselected_tool_cannot_satisfy_policy(self):
        for node_id, tool_name in (("input", "lookup"), ("agent", "not_selected")):
            with self.subTest(node=node_id, tool=tool_name):
                manifest = self.manifest()
                run = runner.new_run(manifest, "질문")
                tool = copy.deepcopy(manifest["connections"][0]["tools"][0])
                tool["toolName"] = tool_name
                run["checkpoint"]["calls"].append({"id": "other-call", "nodeId": node_id, "tool": tool, "args": {"query": "질문"}, "argsHash": runner.digest({"query": "질문"}), "status": "completed", "attempts": 1, "result": {"text": "다른 단계의 결과"}})
                providers = FakeProviders([answer("잘못 확정하려는 답변")] * 3)
                run = self.execute(manifest, providers, run)
                self.assertEqual(run["status"], "budget_exceeded")
                self.assertEqual(run["result"], "")
                self.assertEqual(providers.calls, [])

    def test_failed_read_is_not_successful_evidence(self):
        providers = FakeProviders([call(), answer("오류를 무시한 답변"), answer("여전히 근거 없음")], tool_error=RuntimeError("injected disconnect"))
        run = self.execute(self.manifest(), providers)
        self.assertEqual(run["status"], "budget_exceeded")
        self.assertEqual(len(providers.calls), 2)
        self.assertEqual(run["result"], "")
        self.assertEqual(run["checkpoint"]["calls"][0]["status"], "failed")

    def test_policy_is_optional_and_strictly_typed(self):
        manifest = self.manifest()
        for value in ("true", 1, None):
            invalid = copy.deepcopy(manifest)
            invalid["workflow"]["definition"]["nodes"][1]["requireToolResult"] = value
            with self.subTest(value=value), self.assertRaises(runner.Fault):
                runner.validate_package(invalid)
        invalid = copy.deepcopy(manifest)
        invalid["workflow"]["definition"]["nodes"][0]["requireToolResult"] = False
        with self.assertRaises(runner.Fault):
            runner.validate_package(invalid)
        invalid = copy.deepcopy(manifest)
        invalid["workflow"]["definition"]["nodes"][1]["allowedTools"] = []
        with self.assertRaises(runner.Fault):
            runner.validate_package(invalid)
        legacy = package()
        run = self.execute(legacy, FakeProviders([answer("기존 동작 유지")]))
        self.assertEqual(run["status"], "succeeded")
        self.assertEqual(run["result"], "기존 동작 유지")

    def test_unverified_stream_is_suppressed_until_tool_result_exists(self):
        class StreamingProviders(FakeProviders):
            def __init__(self):
                super().__init__([answer("미확인 부분 답변"), call(), answer("확인한 결과")])
                self.streams = []
            def model(self, messages, tools, tokens, timeout, **kwargs):
                self.streams.append(bool(kwargs.get("on_delta")))
                return super().model(messages, tools, tokens, timeout)
        manifest = self.manifest()
        manifest["workflow"]["definition"]["nodes"][-1]["delivery"] = {"stream": True}
        providers = StreamingProviders()
        run = self.execute(manifest, providers)
        self.assertEqual(run["status"], "succeeded")
        self.assertEqual(providers.streams, [False, False, True])

    def test_same_node_completed_checkpoint_can_resume_without_repeating_tool(self):
        manifest = self.manifest()
        run = runner.new_run(manifest, "질문")
        tool = copy.deepcopy(manifest["connections"][0]["tools"][0])
        run["checkpoint"]["calls"].append({"id": "saved-read", "nodeId": "agent", "tool": tool, "args": {"query": "질문"}, "argsHash": runner.digest({"query": "질문"}), "status": "completed", "attempts": 1, "result": {"text": "이미 확인한 자료"}})
        providers = FakeProviders([answer("이미 확인한 자료로 답변")])
        run = self.execute(manifest, providers, json.loads(json.dumps(run)))
        self.assertEqual(run["status"], "succeeded")
        self.assertEqual(providers.calls, [])

    def test_changed_service_target_on_resume_preserves_pending_checkpoint(self):
        manifest = package("write")
        manifest["connections"][0]["endpointEnv"] = "FLOWLY_MCP_ENDPOINT_TEST"
        providers = FakeProviders([call()])
        run = self.execute(manifest, providers)
        self.assertEqual(run["status"], "waiting_approval")
        run["connectionTargets"] = {"connection": "https://original.example.test/mcp"}
        root = Path(self.temp.name)
        package_path = root / "workflow.json"
        package_path.write_text(json.dumps(manifest), encoding="utf-8")
        loaded, digest = runner.load_package(package_path)
        self.store.bind_package(package_path, digest)
        self.store.save(digest, run)
        fake = FakeProviders([])
        fake.connections = [{"id": "connection", "endpointEnv": "FLOWLY_MCP_ENDPOINT_TEST", "endpoint": "https://changed.example.test/mcp"}]
        with patch.object(runner, "environment_for", return_value={}), patch.object(runner, "Providers", return_value=fake), patch("sys.stderr", new_callable=io.StringIO) as errors:
            status = runner.main(["resume", run["id"], "--package", str(package_path), "--state", str(root / "state")])
        self.assertEqual(status, 1)
        self.assertIn("서비스 주소", errors.getvalue())
        saved = self.store.load(digest, run["id"])
        self.assertEqual(saved["status"], "waiting_approval")
        self.assertEqual(saved["approvals"][0]["status"], "pending")
        self.assertEqual(fake.calls, [])


if __name__ == "__main__":
    unittest.main()
