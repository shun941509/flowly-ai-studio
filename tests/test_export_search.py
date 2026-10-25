"""Finite tree/graph solver tests. No credentials, network, or model services."""
import copy
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "export-runtime"))
from flowly_search import parse_search_config, run_candidate_search


TREE = {"items": [{"id": "a", "value": 6}, {"id": "b", "value": 4}, {"id": "c", "value": 3}], "target": 7}
REPLIES = [{"actions": [{"type": "create", "items": ["a"]}, {"type": "create", "items": ["b"]}]}, {"actions": []}, {"actions": [{"type": "create", "items": ["b", "c"]}]}]


class CandidateSearchTests(unittest.TestCase):
    def test_durable_reply_resumes_without_repeating_model(self):
        saved, calls = [], []
        def model(prompt, input_data):
            calls.append(input_data)
            return copy.deepcopy(REPLIES[len(calls) - 1])
        def persist(state):
            saved.append(state)
            if state.get("pending", {}).get("reply") is not None:
                raise RuntimeError("crash after reply persisted")
        config = parse_search_config({"mode": "tree"})
        with self.assertRaisesRegex(RuntimeError, "crash"):
            run_candidate_search(config, TREE, None, {"model": model, "persist": persist, "check": lambda: None})
        self.assertEqual(len(calls), 1)
        result = run_candidate_search(config, TREE, saved[-1], {"model": model, "persist": saved.append, "check": lambda: None})
        self.assertEqual(len(calls), 3)
        self.assertEqual(result["data"]["selected"], ["b", "c"])
        self.assertEqual(result["data"]["total"], 7)
        self.assertTrue(any(event["type"] == "backtracked" for event in saved[-1]["events"]))

    def test_untrusted_success_and_items_are_rejected(self):
        for reply in ({"actions": [], "solved": True}, {"actions": [{"type": "create", "items": ["invented"]}]}, {"actions": [{"type": "create", "items": ["a"], "total": 7}]}):
            with self.assertRaises(ValueError):
                run_candidate_search({}, TREE, None, {"model": lambda prompt, input_data: reply, "persist": lambda state: None, "check": lambda: None})

    def test_invalid_problem_and_limit_settings_fail_before_model(self):
        for value in ({"maxDepth": 9}, {"branchFactor": True}, {"beamWidth": 17}, {"itemsPath": "data.__proto__"}):
            with self.assertRaises(ValueError):
                parse_search_config(value)
        for value in ({**TREE, "target": True}, {**TREE, "items": [{"id": "a", "value": 0}]}, {**TREE, "items": [{"id": "a", "value": 3}, {"id": "a", "value": 4}]}):
            with self.assertRaises(ValueError):
                run_candidate_search({}, value, None, {"model": lambda *args: self.fail("model must not run"), "persist": lambda state: None, "check": lambda: None})

    def test_cancel_and_exhaustion_never_fabricate_a_solution(self):
        def cancelled():
            raise RuntimeError("cancelled")
        with self.assertRaisesRegex(RuntimeError, "cancelled"):
            run_candidate_search({}, TREE, None, {"model": lambda *args: self.fail("model must not run"), "persist": lambda state: None, "check": cancelled})
        result = run_candidate_search({}, TREE, None, {"model": lambda *args: {"actions": []}, "persist": lambda state: None, "check": lambda: None})
        self.assertEqual(result["data"]["status"], "exhausted")
        self.assertFalse(result["data"]["solved"])

    def test_unexpected_reasoning_is_not_persisted(self):
        for reply in ({"actions": [], "reasoning": "DO_NOT_RETAIN"}, {"actions": [{"type": "create", "items": ["b"], "reasoning": "DO_NOT_RETAIN"}]}):
            saved = []
            with self.assertRaises(ValueError):
                run_candidate_search({}, TREE, None, {"model": lambda *args: reply, "persist": saved.append, "check": lambda: None})
            self.assertTrue(saved)
            self.assertTrue(all("reply" not in state.get("pending", {}) for state in saved))
            self.assertNotIn("DO_NOT_RETAIN", repr(saved))


if __name__ == "__main__":
    unittest.main()
