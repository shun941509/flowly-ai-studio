"""Knowledge lifecycle tests use deterministic vectors and durable local memory only."""
import copy
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("flowly_knowledge", Path(__file__).parents[1] / "export-runtime" / "flowly_knowledge.py")
knowledge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(knowledge)


class KnowledgeTests(unittest.TestCase):
    def setUp(self):
        self.records, self.embedded, self.denied, self.sequence = {}, [], set(), 0
        self.resources = [{"id": "release", "type": "document", "name": "release", "url": "", "updatedAt": "v1", "content": "release ready " + "a" * 186 + "second chunk"}, {"id": "access", "type": "document", "name": "access", "url": "", "updatedAt": "v1", "content": "access permissions"}]

        def memory(op):
            key = (op["ownerId"], op["workflowId"], op["key"])
            if op["action"] == "write":
                if self.records.get(key, {}).get("revision", 0) != op["expectedRevision"]:
                    raise ValueError("stale")
                self.records[key] = copy.deepcopy(op["value"])
            return {"found": key in self.records, "data": copy.deepcopy(self.records.get(key))}

        def access(ids):
            if self.denied.intersection(ids):
                raise ValueError("권한 없음")

        def embed(texts):
            self.embedded.append(texts)
            return {"vectors": [[1, 0] if "release" in text else [0, 1] for text in texts], "model": "local-test-vector"}

        self.context = {"owner_id": "alice", "workflow_id": "one", "operation_id": "", "resources": self.resources, "embedding_model": "local-test-vector", "memory": memory, "assert_access": access, "embed": embed}

    def run_action(self, action, data=None, config=None, operation=None):
        self.sequence += 1
        return knowledge.execute_knowledge({"action": action, "indexKey": "library", "mode": "vector", "resourceIds": ["release", "access"], **(config or {})}, data or {}, {**self.context, "operation_id": operation or str(self.sequence)})

    def evaluate(self, generation, samples=None, mode="vector"):
        return self.run_action("evaluate", {"g": generation}, {"mode": mode, "generationPath": "g", "evaluation": samples or [{"query": "release", "resourceId": "release"}]})

    def publish(self, generation, action="publish"):
        return self.run_action(action, {"g": generation}, {"generationPath": "g"})

    def test_changed_chunks_only_and_staged_visibility(self):
        first = self.run_action("stage", config={"mode": "vector", "chunkSize": 200})
        self.assertEqual(first["embeddedChunks"], 3)
        with self.assertRaisesRegex(ValueError, "발행"):
            self.run_action("query", {"text": "release", "generation": "g1"}, {"generationPath": "generation"})
        with self.assertRaisesRegex(ValueError, "평가"):
            self.publish("g1")
        self.evaluate("g1")
        self.publish("g1")
        calls = len(self.embedded)
        with self.assertRaisesRegex(ValueError, "검색 방식"):
            self.run_action("query", {"text": "release"}, {"mode": "lexical"})
        self.assertEqual(len(self.embedded), calls)
        doc = {"resourceId": "release", "version": "v2", "content": self.resources[0]["content"][:200] + "updated chunk"}
        changed = self.run_action("stage", {"docs": [doc]}, {"mode": "vector", "chunkSize": 200, "documentsPath": "docs"})
        self.assertEqual((changed["embeddedChunks"], changed["reusedChunks"]), (1, 2))
        self.assertEqual(self.run_action("query", {"text": "release"})["generation"], "g1")
        self.evaluate("g2")
        self.publish("g2")
        same = self.run_action("stage", {"docs": [doc]}, {"mode": "vector", "chunkSize": 200, "documentsPath": "docs"})
        self.assertEqual((same["embeddedChunks"], same["reusedChunks"]), (0, 3))
        self.assertIn(["updated chunk"], self.embedded)

    def test_revocation_purges_all_generations_and_rollback_never_resurrects(self):
        for generation in ("g1", "g2"):
            self.run_action("stage", config={"mode": "vector"})
            self.evaluate(generation)
            self.publish(generation)
        self.run_action("revoke", {"ids": ["release"]}, {"resourceIdsPath": "ids"})
        with self.assertRaisesRegex(ValueError, "평가"):
            self.publish("g1", "rollback")
        self.evaluate("g1", [{"query": "access", "resourceId": "access"}])
        self.publish("g1", "rollback")
        result = self.run_action("query", {"text": "release"})
        self.assertEqual([m["resourceId"] for m in result["matches"]], ["access"])
        self.assertNotIn("second chunk", str(self.records))
        with self.assertRaisesRegex(ValueError, "철회"):
            self.run_action("stage", {"docs": [{"resourceId": "release", "version": "v3", "content": "resurrect"}]}, {"documentsPath": "docs"})

    def test_retry_idempotency_changed_args_and_stale_revision(self):
        first = self.run_action("stage", config={"mode": "vector"}, operation="same")
        self.assertEqual(first, self.run_action("stage", config={"mode": "vector"}, operation="same"))
        self.assertEqual(len(self.embedded), 1)
        with self.assertRaisesRegex(ValueError, "입력"):
            self.run_action("stage", {"changed": True}, {"mode": "vector"}, operation="same")
        with self.assertRaisesRegex(ValueError, "리비전"):
            self.run_action("stage", {"revision": 0}, {"expectedRevisionPath": "revision"})

    def test_scope_current_access_and_embedding_model(self):
        self.run_action("stage", config={"mode": "vector"})
        self.evaluate("g1")
        self.publish("g1")
        config = {"action": "query", "indexKey": "library", "mode": "vector", "resourceIds": ["release"]}
        for changed in ({"owner_id": "bob"}, {"workflow_id": "another"}):
            with self.assertRaisesRegex(ValueError, "색인 버전"):
                knowledge.execute_knowledge(config, {"text": "release"}, {**self.context, **changed, "operation_id": "query"})
        with self.assertRaisesRegex(ValueError, "모델"):
            knowledge.execute_knowledge(config, {"text": "release"}, {**self.context, "embedding_model": "changed", "operation_id": "query"})
        self.denied.add("release")
        with self.assertRaisesRegex(ValueError, "권한"):
            self.run_action("query", {"text": "release"})

    def test_parser_and_failed_evaluation(self):
        for changed in ({"action": "exec"}, {"indexKey": "__proto__"}, {"topK": 11}, {"generationPath": "constructor.a"}, {"action": "publish"}, {"action": "evaluate", "generationPath": "g"}, {"code": "anything"}):
            with self.assertRaises(ValueError):
                knowledge.validate_config({"action": "stage", "indexKey": "test", "resourceIds": ["release"], **changed})
        self.run_action("stage", {"docs": [{"resourceId": "release", "version": "v2", "content": "no target term"}]}, {"documentsPath": "docs", "mode": "lexical"})
        self.assertFalse(self.evaluate("g1", mode="lexical")["passed"])
        with self.assertRaisesRegex(ValueError, "평가"):
            self.publish("g1")


if __name__ == "__main__":
    unittest.main()
