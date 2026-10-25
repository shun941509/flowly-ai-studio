"""Real Python Engine + durable Store; explicit local providers, zero external I/O."""
import importlib.util
from pathlib import Path
import tempfile
import threading
import time
import unittest

spec = importlib.util.spec_from_file_location("completion_parallel_runner", Path(__file__).parents[1] / "export-runtime" / "runner.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def node(ident, kind, **extra):
    return {"id": ident, "type": kind, "title": ident, "inputBindings": {}, **extra}


def chain(nodes):
    for previous, following in zip(nodes, nodes[1:]):
        if not following["inputBindings"]:
            following["inputBindings"] = {"text": {"nodeId": previous["id"], "path": "text"}}
    return {"schemaVersion": 5, "nodes": nodes, "edges": [{"id": "edge" + str(i), "source": a["id"], "target": b["id"]} for i, (a, b) in enumerate(zip(nodes, nodes[1:]))]}


TOOL = {"name": "write", "toolName": "write", "resourceId": "resource", "connectionId": "company", "description": "local test boundary", "effect": "write", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}}


def package(with_review=False):
    writer = chain([node("wi", "input"), node("write", "tool", allowedTools=[TOOL], tool={"arguments": {}, "bindings": {}}), node("wo", "output")])
    winner_nodes = [node("gi", "input")]
    if with_review:
        winner_nodes.append(node("review", "review", review={"instructions": "local test review", "allowEdit": False, "timeoutMinutes": 30}))
    winner_nodes.extend([node("winner", "agent", prompt="winner", format="JSON", allowedTools=[]), node("go", "output", inputBindings={"text": {"nodeId": "winner", "path": "text"}, "data": {"nodeId": "winner", "path": "data"}})])
    winner = chain(winner_nodes)
    if with_review:
        next(edge for edge in winner["edges"] if edge["source"] == "review")["branch"] = "yes"
        winner["nodes"].append(node("rejected", "output", inputBindings={"text": {"nodeId": "review", "path": "text"}}))
        winner["edges"].append({"id": "rejected", "source": "review", "target": "rejected", "branch": "no"})
    definition = chain([node("input", "input"), node("race", "parallel", parallel={"concurrency": 2, "completion": {"mode": "first_match", "checks": [{"path": "data.complete", "operator": "eq", "value": True}]}, "tasks": [{"id": "writer", "name": "writer", "definition": writer}, {"id": "winner", "name": "winner", "definition": winner}]}), node("output", "output")])
    return {"owner": {"userId": "local", "email": "local@example.test", "displayName": "Local"}, "workflow": {"id": "race-test", "name": "race", "description": "", "updatedAt": "2026-10-25", "definition": definition}, "resources": [], "connections": [{"id": "company", "resourceId": "resource", "ownerId": "local", "tools": [TOOL]}], "limits": {"maxTurns": 8, "maxToolCalls": 12, "maxTokens": 12000, "maxDurationMs": 10000}}


class LocalProviders:
    secrets = []

    def __init__(self, state=None, wait_for_dispatch=False):
        self.state = state if state is not None else {"calls": 0, "models": 0, "started": threading.Event(), "mutex": threading.Lock()}
        self.wait_for_dispatch = wait_for_dispatch
        self.cancelled = lambda: False

    def fork(self):
        return LocalProviders(self.state, self.wait_for_dispatch)

    def model(self, messages, tools, output_budget, timeout_ms, **kwargs):
        self.state["models"] += 1
        if self.wait_for_dispatch:
            if not self.state["started"].wait(2):
                raise AssertionError("write dispatch was never reached")
        else:
            time.sleep(0.12)
        return {"kind": "answer", "text": '{"complete":true}', "usageTokens": 1}

    def tool(self, tool, arguments, idempotency_key, timeout_ms):
        with self.state["mutex"]:
            self.state["calls"] += 1
        self.state["started"].set()
        end = time.monotonic() + 3
        while not self.cancelled():
            if time.monotonic() >= end:
                raise AssertionError("parallel peer cancellation did not reach the provider")
            time.sleep(0.005)
        raise runner.Fault("test-only interrupted response")


class ParallelCancellation(unittest.TestCase):
    def test_pending_approval_is_invalidated_and_cannot_be_approved_after_winner(self):
        p = package()
        providers = LocalProviders()
        with tempfile.TemporaryDirectory(prefix="flowly-parallel-") as directory:
            store = runner.Store(directory)
            run = runner.new_run(p, "request")
            runner.Engine(p, "test-hash", store, providers, run).execute()
            self.assertEqual(run["status"], "succeeded", run.get("error"))
            writer = run["checkpoint"]["groups"]["race"]["children"][0]
            self.assertEqual(writer["status"], "cancelled")
            self.assertEqual(writer["approvals"][0]["status"], "denied")
            self.assertEqual(providers.state["calls"], 0)
            with self.assertRaises(runner.Fault):
                runner.decide(run, writer["approvals"][0]["id"], "approve", "local")
            restored = store.load("test-hash", run["id"])
            runner.Engine(p, "test-hash", store, providers, restored).execute()
            self.assertEqual(providers.state["calls"], 0)
            self.assertEqual(providers.state["models"], 1)

    def test_approved_but_undispatched_write_is_revoked_before_its_turn(self):
        p = package(with_review=True)
        parallel = p["workflow"]["definition"]["nodes"][1]["parallel"]
        parallel["tasks"].reverse()
        parallel["concurrency"] = 1
        providers = LocalProviders()
        with tempfile.TemporaryDirectory(prefix="flowly-parallel-") as directory:
            store = runner.Store(directory)
            run = runner.new_run(p, "request")
            runner.Engine(p, "test-hash", store, providers, run).execute()
            self.assertEqual(run["status"], "waiting_approval", run.get("error"))
            winner, writer = run["checkpoint"]["groups"]["race"]["children"]
            approval_id = writer["approvals"][0]["id"]
            runner.decide(run, approval_id, "approve", "local")
            runner.decide_review(run, winner["reviews"][0]["id"], "accept", "local")
            self.assertEqual(writer["approvals"][0]["status"], "approved")
            self.assertEqual(writer["checkpoint"]["calls"][0]["status"], "planned")
            runner.Engine(p, "test-hash", store, providers, run).execute()
            self.assertEqual(run["status"], "succeeded", run.get("error"))
            writer = run["checkpoint"]["groups"]["race"]["children"][1]
            self.assertEqual(writer["status"], "cancelled")
            self.assertEqual(writer["approvals"][0]["status"], "denied")
            self.assertEqual(providers.state["calls"], 0)
            with self.assertRaises(runner.Fault):
                runner.decide(run, approval_id, "approve", "local")

    def test_dispatched_write_cancel_is_unknown_and_durable_resume_never_replays(self):
        p = package(with_review=True)
        providers = LocalProviders(wait_for_dispatch=True)
        with tempfile.TemporaryDirectory(prefix="flowly-parallel-") as directory:
            store = runner.Store(directory)
            run = runner.new_run(p, "request")
            runner.Engine(p, "test-hash", store, providers, run).execute()
            self.assertEqual(run["status"], "waiting_approval", run.get("error"))
            writer, winner = run["checkpoint"]["groups"]["race"]["children"]
            runner.decide(run, writer["approvals"][0]["id"], "approve", "local")
            runner.decide_review(run, winner["reviews"][0]["id"], "accept", "local")
            runner.Engine(p, "test-hash", store, providers, run).execute()
            self.assertEqual(run["status"], "unknown_outcome", run.get("error"))
            self.assertEqual(providers.state["calls"], 1)
            writer = run["checkpoint"]["groups"]["race"]["children"][0]
            self.assertEqual(writer["checkpoint"]["calls"][0]["status"], "unknown_outcome")
            self.assertEqual(writer["checkpoint"]["calls"][0]["attempts"], 1)
            restored = store.load("test-hash", run["id"])
            runner.Engine(p, "test-hash", store, providers, restored).execute()
            self.assertEqual(restored["status"], "unknown_outcome")
            self.assertEqual(providers.state["calls"], 1)
            self.assertNotIn("race", restored["checkpoint"]["completed"])


if __name__ == "__main__":
    unittest.main()
