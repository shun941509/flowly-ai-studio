"""Dynamic role generation, dependency scheduling and same-run recovery; offline."""
import copy
import json
import unittest
import test_export_python as fixtures

runner = fixtures.runner


def assignment(ident, dependencies=None):
    return {"id": ident, "templateId": "analysis", "role": ident + " 역할", "goal": ident + " 관점 분석", "input": {"topic": ident}, "dependsOn": dependencies or []}


def manifest(wait=False):
    definition = fixtures.advanced_definition({"type": "agent", "prompt": "DYNAMIC_WORKER", "format": "JSON", "allowedTools": [], "inputBindings": {"assignment": {"nodeId": "input", "path": "assignment"}, "artifacts": {"nodeId": "input", "path": "artifacts"}}})
    if wait:
        definition["nodes"].insert(2, {"id": "more", "type": "form", "title": "보완", "form": {"mode": "request", "fields": [{"key": "note", "label": "보완", "type": "text", "required": True}]}, "inputBindings": {"text": {"nodeId": "work", "path": "text"}}})
        definition["edges"] = [{"id": "e1", "source": "input", "target": "work"}, {"id": "e2", "source": "work", "target": "more"}, {"id": "e3", "source": "more", "target": "output"}]
        definition["nodes"][-1]["inputBindings"] = {"text": {"nodeId": "more", "path": "text"}}
    return fixtures.advanced_package({"type": "orchestrator", "prompt": "DYNAMIC_PLAN", "orchestration": {"mode": "dynamic", "tasks": [{"id": "analysis", "name": "분석 기능", "definition": definition}], "maxTasks": 1,
        "dynamic": {"maxAgents": 4, "concurrency": 2, "templates": [{"taskId": "analysis", "agentNodeId": "work", "inputSchema": {"type": "object", "properties": {"topic": {"type": "string"}}, "required": ["topic"], "additionalProperties": False}}]},
        "completion": [{"path": "summary.completedCount", "operator": "gte", "value": 1}]}})


class DynamicAgentTests(unittest.TestCase):
    setUp = fixtures.RuntimeTests.setUp
    tearDown = fixtures.RuntimeTests.tearDown
    start = fixtures.RuntimeTests.start
    resume = fixtures.RuntimeTests.resume

    def test_generated_roles_share_capability_but_have_unique_contracts_and_dependencies(self):
        agents = [assignment("judge", ["a", "b"]), assignment("a"), assignment("b")]
        providers = fixtures.FakeProviders([fixtures.answer(json.dumps({"agents": agents}))] + [fixtures.answer('{"passed":true}')] * 3)
        run = self.start(manifest(), providers)
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        group = run["checkpoint"]["groups"]["work"]
        self.assertEqual(group["taskIds"], ["a", "b", "judge"])
        self.assertEqual(len({child["id"] for child in group["children"]}), 3)
        self.assertEqual(set(group["children"][2]["initialInput"]["artifacts"]), {"a", "b"})
        self.assertEqual(len(providers.models), 4)
        self.assertTrue(all(contract["status"] == "succeeded" for contract in group["contracts"]))

    def test_invalid_plan_rejected_before_any_child_dispatch(self):
        bad = [[{**assignment("a"), "templateId": "unknown"}], [{**assignment("a"), "input": {"topic": 42}}], [{**assignment("a"), "tools": ["shell"]}], [assignment("a"), assignment("a")], [assignment("a", ["b"]), assignment("b", ["a"])], [assignment("a", ["missing"])] ]
        for agents in bad:
            providers = fixtures.FakeProviders([fixtures.answer(json.dumps({"agents": agents}))])
            run = self.start(manifest(), providers)
            self.assertEqual(run["status"], "failed", run.get("error"))
            self.assertEqual(len(providers.models), 1)
            self.assertEqual(run["checkpoint"]["groups"], {})

    def test_wait_resume_keeps_generated_identity_and_does_not_plan_again(self):
        package = manifest(True)
        providers = fixtures.FakeProviders([fixtures.answer(json.dumps({"agents": [assignment("specialist")]})), fixtures.answer('{"passed":true}')])
        run = self.start(package, providers)
        self.assertEqual(run["status"], "waiting_input", run.get("error"))
        child_id = run["checkpoint"]["groups"]["work"]["children"][0]["id"]
        runner.submit_input(run, runner.summary(run)["inputRequests"][0]["id"], "alice", {"note": "보완 완료"})
        self.store.save("package-hash", run)
        finished = self.resume(package, providers, run)
        self.assertEqual(finished["status"], "succeeded", finished.get("error"))
        self.assertEqual(finished["checkpoint"]["groups"]["work"]["children"][0]["id"], child_id)
        self.assertEqual(len(providers.models), 2)

    def test_plan_or_child_contract_change_rejects_resume(self):
        package = manifest(True)
        providers = fixtures.FakeProviders([fixtures.answer(json.dumps({"agents": [assignment("specialist")]})), fixtures.answer('{"passed":true}')])
        run = self.start(package, providers)
        for mutate in (lambda group: group["dynamicPlan"]["agents"][0].update(goal="changed"), lambda group: group.update(contracts=[]), lambda group: group["children"][0]["initialInput"].update(text="changed")):
            altered = copy.deepcopy(run)
            mutate(altered["checkpoint"]["groups"]["work"])
            self.store.save("package-hash", altered)
            self.assertEqual(self.resume(package, providers, altered)["status"], "failed")
        self.assertEqual(len(providers.models), 2)

    def test_completion_and_parent_budget_still_apply(self):
        package = manifest()
        package["workflow"]["definition"]["nodes"][1]["orchestration"]["completion"] = [{"path": "artifacts.specialist.data.passed", "operator": "eq", "value": False}]
        providers = fixtures.FakeProviders([fixtures.answer(json.dumps({"agents": [assignment("specialist")]})), fixtures.answer('{"passed":true}')])
        self.assertEqual(self.start(package, providers)["status"], "failed")
        limited = manifest()
        limited["limits"]["maxTurns"] = 2
        providers = fixtures.FakeProviders([fixtures.answer(json.dumps({"agents": [assignment("a"), assignment("b")]}))])
        self.assertEqual(self.start(limited, providers)["status"], "budget_exceeded")
        self.assertEqual(len(providers.models), 1)

    def test_memory_compare_and_swap_replays_before_revision_check(self):
        operation = {"ownerId": "alice", "workflowId": "knowledge", "key": "index", "operationId": "first", "action": "write", "expectedRevision": 0, "value": {"revision": 1}}
        self.assertEqual(self.store.memory(operation)["data"]["revision"], 1)
        self.assertEqual(self.store.memory(operation)["data"]["revision"], 1)
        with self.assertRaises(runner.ProtectedFault):
            self.store.memory({**operation, "operationId": "stale"})
        with self.assertRaises(runner.ProtectedFault):
            self.store.memory({**operation, "expectedRevision": 1})
        self.assertEqual(self.store.memory({**operation, "operationId": "second", "expectedRevision": 1, "value": {"revision": 2}})["data"]["revision"], 2)

    def test_generated_agent_keeps_write_approval_and_does_not_repeat_write(self):
        source = fixtures.package("write")
        for decision in ("approve", "deny"):
            package = manifest()
            package["resources"], package["connections"] = source["resources"], source["connections"]
            package["workflow"]["definition"]["nodes"][1]["orchestration"]["tasks"][0]["definition"]["nodes"][1]["allowedTools"] = source["workflow"]["definition"]["nodes"][1]["allowedTools"]
            package = runner.validate_package(package)
            providers = fixtures.FakeProviders([fixtures.answer(json.dumps({"agents": [assignment("writer")]})), fixtures.call(), fixtures.answer('{"passed":true}')])
            run = self.start(package, providers)
            self.assertEqual(run["status"], "waiting_approval", run.get("error"))
            self.assertEqual(len(providers.calls), 0)
            child_id = run["checkpoint"]["groups"]["work"]["children"][0]["id"]
            runner.decide(run, runner.summary(run)["approvals"][0]["id"], decision, "alice")
            self.store.save("package-hash", run)
            finished = self.resume(package, providers, run)
            self.assertEqual(finished["status"], "succeeded", finished.get("error"))
            self.assertEqual(len(providers.calls), 1 if decision == "approve" else 0)
            self.assertEqual(finished["checkpoint"]["groups"]["work"]["children"][0]["id"], child_id)
            self.resume(package, providers, finished)
            self.assertEqual(len(providers.models), 3)

    def test_generated_prompt_overflow_rejects_instead_of_truncating(self):
        package = manifest()
        package["workflow"]["definition"]["nodes"][1]["orchestration"]["tasks"][0]["definition"]["nodes"][1]["prompt"] = "x" * 12000
        providers = fixtures.FakeProviders([fixtures.answer(json.dumps({"agents": [assignment("worker")]}))])
        run = self.start(package, providers)
        self.assertEqual(run["status"], "failed")
        self.assertIn("12,000", run["error"])
        self.assertEqual(len(providers.models), 1)

    def test_global_expansion_includes_siblings_loops_and_adaptive_rounds(self):
        package = manifest()
        config = package["workflow"]["definition"]["nodes"][1]["orchestration"]
        config["dynamic"]["maxAgents"] = 8
        definition = config["tasks"][0]["definition"]
        definition["nodes"][-1:-1] = [{"id": "copy" + str(i), "type": "transform", "title": "복사", "transform": {"mode": "template", "template": "{{text}}"}} for i in range(5)]
        definition["edges"] = [{"id": "edge" + str(i), "source": definition["nodes"][i]["id"], "target": definition["nodes"][i + 1]["id"]} for i in range(7)]
        for node in definition["nodes"][2:]:
            node.pop("inputBindings", None)
        package = runner.validate_package(package)
        child = package["workflow"]["definition"]
        self.assertEqual(runner.expanded_node_count(child), 67)
        siblings = copy.deepcopy(package)
        nodes = siblings["workflow"]["definition"]["nodes"]
        extra = copy.deepcopy(nodes[1])
        extra.update(id="second", inputBindings={"text": {"nodeId": "work", "path": "text"}})
        nodes.insert(2, extra)
        nodes[-1]["inputBindings"] = {"text": {"nodeId": "second", "path": "text"}}
        siblings["workflow"]["definition"]["edges"] = [{"id": "e1", "source": "input", "target": "work"}, {"id": "e2", "source": "work", "target": "second"}, {"id": "e3", "source": "second", "target": "output"}]
        self.assertEqual(runner.expanded_node_count(siblings["workflow"]["definition"]), 132)
        with self.assertRaisesRegex(runner.Fault, "120"):
            runner.validate_package(siblings)
        for node in ({"type": "loop", "loop": {"definition": child, "itemsPath": "items", "maxItems": 2, "concurrency": 2}}, {"type": "orchestrator", "prompt": "계획", "orchestration": {"mode": "adaptive", "maxTasks": 1, "maxRounds": 2, "tasks": [{"id": "child", "name": "하위", "definition": child}]}}):
            with self.assertRaisesRegex(runner.Fault, "120"):
                fixtures.advanced_package(node)
        legacy = fixtures.advanced_package({"type": "loop", "loop": {"definition": definition, "itemsPath": "items", "maxItems": 20, "concurrency": 2}})
        self.assertEqual(runner.expanded_node_count(legacy["workflow"]["definition"]), 163)


if __name__ == "__main__":
    unittest.main()
