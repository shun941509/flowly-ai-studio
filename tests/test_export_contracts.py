"""Registered task contracts, dependency artifacts and completion gates; no services."""
import copy
import unittest
import test_export_python as fixtures

runner = fixtures.runner


def task(ident, template, depends=None):
    node = {"type": "transform", "transform": {"mode": "template", "template": template}}
    if depends:
        node["inputBindings"] = {"artifacts": {"nodeId": "input", "path": "artifacts"}}
    return {"id": ident, "name": ident, "definition": fixtures.advanced_definition(node), **({"dependsOn": depends} if depends is not None else {})}


def manifest(**config):
    return fixtures.advanced_package({"type": "orchestrator", "prompt": "PLAN", "orchestration": {"tasks": [task("first", "검증한 {{text}}")], "maxTasks": 1, **config}})


class TaskContractTests(unittest.TestCase):
    setUp = fixtures.RuntimeTests.setUp
    tearDown = fixtures.RuntimeTests.tearDown
    start = fixtures.RuntimeTests.start
    resume = fixtures.RuntimeTests.resume

    def test_dependency_outputs_and_completion_are_deterministic(self):
        package = manifest(tasks=[task("first", "검증한 {{text}}"), task("second", "연결: {{artifacts.first.text}}", ["first"])], maxTasks=2,
                           completion=[{"path": "artifacts.second.text", "operator": "contains", "value": "연결: 검증한"}])
        run = self.start(package, fixtures.FakeProviders([fixtures.answer('{"tasks":["first","second"]}')]))
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        group = run["checkpoint"]["groups"]["work"]
        self.assertIn("first", group["children"][1]["initialInput"]["artifacts"])
        self.assertTrue(group["completionChecks"][0]["passed"])
        self.assertTrue(all(item["status"] == "succeeded" and len(item["inputHash"]) == 64 for item in group["contracts"]))

    def test_invalid_plan_and_dependency_cycles_are_rejected(self):
        for dependencies in (["second"], ["absent"]):
            with self.assertRaises(runner.Fault):
                manifest(tasks=[task("first", "a", dependencies), task("second", "b", ["first"])], maxTasks=2)
        package = manifest(tasks=[task("first", "a"), task("second", "b", ["first"])], maxTasks=2)
        for plan in ('{"tasks":["second"]}', '{"tasks":["second","first"]}'):
            run = self.start(package, fixtures.FakeProviders([fixtures.answer(plan)]))
            self.assertEqual(run["status"], "failed")
            self.assertEqual(run["checkpoint"]["groups"], {})

    def test_model_done_is_subject_to_completion_gate_and_round_limit(self):
        config = {"mode": "adaptive", "maxRounds": 3, "completion": [{"path": "artifacts.first.text", "operator": "contains", "value": "검증한"}]}
        replies = [fixtures.answer('{"done":true,"tasks":[]}'), fixtures.answer('{"done":false,"tasks":["first"]}'), fixtures.answer('{"done":true,"tasks":[]}')]
        run = self.start(manifest(**config), fixtures.FakeProviders(replies))
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        self.assertEqual([event["data"]["checks"][0]["passed"] for event in run["events"] if event["type"] == "completion_checked"], [False, True])
        run = self.start(manifest(**{**config, "maxRounds": 2}), fixtures.FakeProviders([replies[0], replies[0]]))
        self.assertEqual(run["status"], "budget_exceeded")
        self.assertEqual(len(run["checkpoint"]["groups"]["work"]["rounds"]), 2)

    def test_repeated_completed_write_reuses_result_but_changed_input_fails_closed(self):
        source = fixtures.package("write")
        selection = source["workflow"]["definition"]["nodes"][1]["allowedTools"]
        child = fixtures.advanced_definition({"type": "tool", "allowedTools": selection, "tool": {"arguments": {"query": "one"}, "bindings": {}}})
        for contracted in (True, False):
            package = fixtures.advanced_package({"type": "orchestrator", "prompt": "PLAN", "orchestration": {"tasks": [{"id": "write", "name": "쓰기", "definition": child}], "maxTasks": 1, "mode": "adaptive", "maxRounds": 3,
               **({"completion": [{"path": "artifacts.write.text", "operator": "contains", "value": "saved"}]} if contracted else {})}}, tools=True)
            package["connections"][0]["tools"][0]["effect"] = "write"
            providers = fixtures.FakeProviders([fixtures.answer('{"done":false,"tasks":["write"]}'), fixtures.answer('{"done":false,"tasks":["write"]}'), fixtures.answer('{"done":true,"tasks":[]}')], tool_result={"saved": True})
            run = self.start(package, providers)
            self.assertEqual(run["status"], "waiting_approval", run.get("error"))
            runner.decide(run, runner.summary(run)["approvals"][0]["id"], "approve", "alice")
            self.store.save("package-hash", run)
            finished = self.resume(package, providers, run)
            self.assertEqual(finished["status"], "succeeded" if contracted else "failed", finished.get("error"))
            self.assertEqual(len(providers.calls), 1)
            if contracted:
                reused = finished["checkpoint"]["groups"]["work"]["children"][1]
                self.assertEqual(reused["events"][0]["type"], "task_reused")
                self.assertEqual(reused["checkpoint"]["toolCalls"], 0)

    def test_resume_rejects_missing_contracts_and_modified_child_input(self):
        wait = fixtures.advanced_definition({"type": "form", "form": {"mode": "request", "fields": [{"key": "note", "label": "보완", "type": "text", "required": True}]}})
        package = manifest(tasks=[{"id": "first", "name": "보완", "definition": wait}], completion=[{"path": "artifacts.first.text", "operator": "contains", "value": "note"}])
        providers = fixtures.FakeProviders([fixtures.answer('{"tasks":["first"]}')])
        run = self.start(package, providers)
        self.assertEqual(run["status"], "waiting_input", run.get("error"))
        for mutate in (lambda group: group.update(contracts=[]), lambda group: group["children"][0]["initialInput"].update(text="changed")):
            clone = copy.deepcopy(run)
            mutate(clone["checkpoint"]["groups"]["work"])
            self.store.save("package-hash", clone)
            self.assertEqual(self.resume(package, providers, clone)["status"], "failed")
        self.assertEqual(len(providers.models), 1)


if __name__ == "__main__":
    unittest.main()
