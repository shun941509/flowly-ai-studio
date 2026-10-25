"""Persistent supplementary input in the real Python engine/CLI, without services."""
import copy
import io
import json
import os
from pathlib import Path
import socket
import unittest
from unittest.mock import patch

import test_export_python as fixtures

runner = fixtures.runner
FakeProviders = fixtures.FakeProviders
advanced_package, advanced_definition = fixtures.advanced_package, fixtures.advanced_definition
tasks, package, answer = fixtures.tasks, fixtures.package, fixtures.answer


def request_node(**config):
    return {"type": "form", "form": {"mode": "request", "instructions": "주문번호를 입력하세요.",
            "fields": [{"key": "orderId", "label": "주문번호", "type": "text", "required": True}], **config}}


class SupplementaryInputTests(unittest.TestCase):
    setUp = fixtures.RuntimeTests.setUp
    tearDown = fixtures.RuntimeTests.tearDown
    start = fixtures.RuntimeTests.start
    resume = fixtures.RuntimeTests.resume

    def test_wait_is_durable_and_submit_never_executes_downstream_model(self):
        manifest = advanced_package(request_node())
        definition = manifest["workflow"]["definition"]
        definition["nodes"].insert(2, {"id": "agent", "title": "확인", "type": "agent", "prompt": "요청에 답하세요.", "allowedTools": [], "inputBindings": {"text": {"nodeId": "work", "path": "text"}}})
        definition["nodes"][-1]["inputBindings"] = {"text": {"nodeId": "agent", "path": "text"}}
        definition["edges"][-1]["target"] = "agent"
        definition["edges"].append({"id": "result", "source": "agent", "target": "output"})
        runner.validate_package(manifest)
        providers = FakeProviders([answer("배송 확인 완료")])
        run = self.start(manifest, providers, "배송 문의")
        self.assertEqual(run["status"], "waiting_input", run.get("error"))
        self.assertEqual(run["checkpoint"]["completed"], ["input"])
        self.assertEqual(providers.models, [])
        request = run["inputRequests"][0]
        reopened = runner.Store(self.directory / "state")
        loaded = reopened.load("package-hash", run["id"])
        runner.submit_input(loaded, request["id"], "alice", {"orderId": "A-7"})
        self.assertEqual(loaded["status"], "queued")
        self.assertEqual(providers.models, [])
        reopened.save("package-hash", loaded)
        finished = self.resume(manifest, providers, loaded)
        self.assertEqual(finished["id"], run["id"])
        self.assertEqual(finished["status"], "succeeded", finished.get("error"))
        self.assertEqual(finished["result"], "배송 확인 완료")
        self.assertEqual(len(providers.models), 1)
        self.assertIn("A-7", providers.models[0][0][0]["content"])
        self.resume(manifest, providers, finished)
        self.assertEqual(len(providers.models), 1)

    def test_invalid_values_preserve_pending_and_original_input(self):
        fields = [{"key": "orderId", "label": "주문번호", "type": "text", "required": True},
                  {"key": "count", "label": "수량", "type": "number", "required": True},
                  {"key": "accepted", "label": "확인", "type": "boolean", "required": True},
                  {"key": "date", "label": "날짜", "type": "date", "required": True},
                  {"key": "kind", "label": "분류", "type": "select", "required": True, "options": ["A", "B"]}]
        manifest = advanced_package(request_node(fields=fields))
        run = self.start(manifest, FakeProviders([]), "원래 문의")
        request = run["inputRequests"][0]
        valid = {"orderId": "A", "count": 0, "accepted": False, "date": "2024-02-29", "kind": "B"}
        for value in ({}, [], {**valid, "orderId": "  "}, {**valid, "count": "2"}, {**valid, "accepted": 1}, {**valid, "date": "2025-02-29"}, {**valid, "kind": "C"}, {**valid, "extra": "x"}, {**valid, "orderId": "x" * 20001}):
            with self.subTest(value_type=type(value).__name__), self.assertRaises(runner.Fault):
                runner.submit_input(run, request["id"], "alice", value)
            self.assertEqual(request["status"], "pending")
            self.assertEqual(run["status"], "waiting_input")
        runner.submit_input(run, request["id"], "alice", valid)
        self.assertEqual(request["output"]["data"], valid)
        self.assertEqual(run["input"], "원래 문의")

    def test_duplicate_is_idempotent_and_changed_duplicate_is_rejected(self):
        manifest = advanced_package(request_node())
        run = self.start(manifest, FakeProviders([]))
        request = run["inputRequests"][0]
        runner.submit_input(run, request["id"], "alice", {"orderId": "A"})
        snapshot = copy.deepcopy(run)
        runner.submit_input(run, request["id"], "alice", {"orderId": "A"})
        self.assertEqual(run, snapshot)
        with self.assertRaises(runner.Fault):
            runner.submit_input(run, request["id"], "alice", {"orderId": "B"})

    def test_input_config_checkpoint_owner_terminal_and_restore_tampering_rejected(self):
        manifest = advanced_package(request_node())
        original = self.start(manifest, FakeProviders([]))
        mutators = [lambda r: r["inputRequests"][0]["input"].update(text="tampered"),
                    lambda r: r["checkpoint"]["outputs"]["input"].update(text="tampered"),
                    lambda r: r["workflow"]["definition"]["nodes"][1]["form"].update(instructions="tampered"),
                    lambda r: r["inputRequests"][0].update(userId="bob"),
                    lambda r: r.update(status="failed"), lambda r: r.update(restoredReadOnly=True)]
        for mutate in mutators:
            run = copy.deepcopy(original)
            mutate(run)
            with self.assertRaises(runner.Fault):
                runner.submit_input(run, run["inputRequests"][0]["id"], "alice", {"orderId": "A"})
            self.assertEqual(run["inputRequests"][0]["status"], "pending")
        with self.assertRaises(runner.Fault):
            runner.submit_input(original, original["inputRequests"][0]["id"], "bob", {"orderId": "A"})

    def test_pending_expiry_invalid_date_and_timely_submitted_resume_after_deadline(self):
        manifest = advanced_package(request_node(timeoutMinutes=1))
        for expiry in ("2020-01-01T00:00:00Z", "invalid"):
            run = self.start(manifest, FakeProviders([]))
            run["inputRequests"][0]["expiresAt"] = expiry
            with self.assertRaises(runner.Fault):
                runner.submit_input(run, run["inputRequests"][0]["id"], "alice", {"orderId": "A"})
            self.assertEqual(run["status"], "expired")
        run = self.start(manifest, FakeProviders([]))
        request = run["inputRequests"][0]
        runner.submit_input(run, request["id"], "alice", {"orderId": "A"})
        request["expiresAt"] = "2020-01-01T00:00:00Z"
        run["updatedAt"] = "2020-01-01T00:00:00Z"
        self.store.save("package-hash", run)
        finished = self.resume(manifest, FakeProviders([]), run)
        self.assertEqual(finished["status"], "succeeded", finished.get("error"))
        self.assertLess(finished["checkpoint"]["activeMs"], 10000)

    def test_resume_pending_stays_waiting_without_new_request(self):
        manifest = advanced_package(request_node())
        run = self.start(manifest, FakeProviders([]))
        request_id = run["inputRequests"][0]["id"]
        resumed = self.resume(manifest, FakeProviders([]), run)
        self.assertEqual(resumed["status"], "waiting_input")
        self.assertEqual([r["id"] for r in resumed["inputRequests"]], [request_id])
        resumed["inputRequests"][0]["expiresAt"] = "2020-01-01T00:00:00Z"
        self.store.save("package-hash", resumed)
        self.assertEqual(self.resume(manifest, FakeProviders([]), resumed)["status"], "expired")

    def test_nested_wait_keeps_completed_tool_peer_and_public_contract(self):
        selection = package()["workflow"]["definition"]["nodes"][1]["allowedTools"]
        tool = advanced_definition({"type": "tool", "allowedTools": selection, "tool": {"arguments": {}, "bindings": {"query": "text"}}})
        nested = advanced_definition({"type": "subworkflow", "subworkflow": {"definition": advanced_definition(request_node())}})
        manifest = advanced_package({"type": "parallel", "parallel": {"tasks": tasks(tool, nested), "concurrency": 1}}, tools=True)
        providers = FakeProviders([])
        run = self.start(manifest, providers)
        self.assertEqual(run["status"], "waiting_input", run.get("error"))
        public = runner.summary(run)
        self.assertEqual(len(public["inputRequests"]), 1)
        self.assertEqual(public["inputRequests"][0]["fields"][0]["key"], "orderId")
        request_id = public["inputRequests"][0]["id"]
        self.assertIn(request_id, runner.report_html(run))
        completed = copy.deepcopy(run["checkpoint"]["groups"]["work"]["children"][0])
        self.assertEqual(len(providers.calls), 1)
        runner.submit_input(run, request_id, "alice", {"orderId": "A"})
        self.store.save("package-hash", run)
        finished = self.resume(manifest, providers, run)
        self.assertEqual(finished["status"], "succeeded", finished.get("error"))
        self.assertEqual(finished["checkpoint"]["groups"]["work"]["children"][0], completed)
        self.assertEqual(len(providers.calls), 1)

    def test_request_requires_predecessor_and_initial_form_stays_compatible(self):
        manifest = advanced_package(request_node())
        definition = manifest["workflow"]["definition"]
        for mode in ("bad", None):
            candidate = copy.deepcopy(manifest)
            candidate["workflow"]["definition"]["nodes"][1]["form"]["mode"] = mode
            with self.assertRaises(runner.Fault):
                runner.validate_package(candidate)
        for limit in (0, 10081, 1.5, True):
            with self.assertRaises(runner.Fault):
                advanced_package(request_node(timeoutMinutes=limit))
        for limit in (1, 10080):
            advanced_package(request_node(timeoutMinutes=limit))
        definition["nodes"] = definition["nodes"][1:]
        definition["edges"] = definition["edges"][1:]
        with self.assertRaises(runner.Fault):
            runner.validate_package(manifest)
        initial = advanced_package({"type": "transform", "transform": {"mode": "template", "template": "{{text}}"}})
        initial["workflow"]["definition"]["nodes"][0].update(type="form", form={"fields": request_node()["form"]["fields"]})
        runner.validate_package(initial)
        self.assertEqual(self.start(initial, FakeProviders([]), '{"orderId":"A"}')["status"], "succeeded")

    def test_cli_submit_restart_is_json_only_no_network_and_no_env_needed(self):
        manifest = advanced_package(request_node())
        manifest_path, values_path = self.directory / "workflow.json", self.directory / "values.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        values_path.write_text('{"orderId":"A-7"}', encoding="utf-8")
        flags = ["--package", str(manifest_path), "--state", str(self.directory / "cli-state"), "--env", str(self.directory / "invalid.env")]
        with patch.object(socket, "create_connection", side_effect=AssertionError("network forbidden")), patch.dict(os.environ, {}, clear=True):
            with patch("sys.stdout", new_callable=io.StringIO) as output:
                self.assertEqual(runner.main(["run", "--input", "배송 문의", *flags]), 0)
                created = json.loads(output.getvalue())
            self.assertEqual(created["status"], "waiting_input")
            (self.directory / "invalid.env").write_text("not a valid environment file", encoding="utf-8")
            with patch("sys.stdout", new_callable=io.StringIO) as output, patch("sys.stderr", new_callable=io.StringIO):
                self.assertEqual(runner.main(["submit", created["id"], created["inputRequests"][0]["id"], "--values-file", str(values_path), *flags]), 0)
                self.assertEqual(json.loads(output.getvalue())["status"], "queued")
            (self.directory / "invalid.env").unlink()
            with patch("sys.stdout", new_callable=io.StringIO) as output:
                self.assertEqual(runner.main(["resume", created["id"], *flags]), 0)
                finished = json.loads(output.getvalue())
            self.assertEqual(finished["status"], "succeeded")
            self.assertEqual(finished["id"], created["id"])
            self.assertEqual(json.loads(finished["result"]), {"orderId": "A-7"})

    def test_timely_accepted_review_resumes_after_submission_deadline(self):
        manifest = advanced_package({"type": "review", "review": {"instructions": "확인", "allowEdit": False, "timeoutMinutes": 1}})
        run = self.start(manifest, FakeProviders([]), "검토 내용")
        runner.decide_review(run, run["reviews"][0]["id"], "accept", "alice")
        run["reviews"][0]["expiresAt"] = "2000-01-01T00:00:00Z"
        self.store.save("package-hash", run)
        resumed = self.resume(manifest, FakeProviders([]), run)
        self.assertEqual(resumed["status"], "succeeded", resumed.get("error"))
        self.assertEqual(resumed["result"], "검토 내용")


if __name__ == "__main__":
    unittest.main()
