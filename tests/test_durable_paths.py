"""Real atomic memory writes under a path longer than Windows MAX_PATH."""
import importlib.util
import shutil
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("flowly_runner", Path(__file__).parents[1] / "export-runtime/runner.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class DurablePaths(unittest.TestCase):
    def test_long_directory_atomic_memory_cas_and_vector_cache(self):
        with tempfile.TemporaryDirectory(prefix="flowly-durable-") as root:
            directory = Path(root).joinpath(*(["nested-state-" + "x" * 36] * 6))
            self.assertGreater(len(str(directory)), 300)
            store = runner.Store(directory)
            base = {"ownerId": "owner", "workflowId": "workflow", "key": "shared-board"}
            with store.locked():
                written = store.memory({**base, "operationId": "write-1", "action": "write", "expectedRevision": 0, "value": {"revision": 1, "text": "기억🚀"}})
                self.assertEqual(written["data"]["revision"], 1)
                with self.assertRaises(runner.Fault):
                    store.memory({**base, "operationId": "conflict", "action": "write", "expectedRevision": 0, "value": {"revision": 1}})
                store.vector_cache("a" * 64, {"rows": [1, 2]})
            reopened = runner.Store(directory)
            with reopened.locked():
                result = reopened.memory({**base, "operationId": "read-2", "action": "read"})
                self.assertEqual(result["data"]["text"], "기억🚀")
                self.assertEqual(reopened.vector_cache("a" * 64), {"rows": [1, 2]})
                self.assertFalse(list(reopened.directory.glob("*.tmp")))
            cleanup = runner.durable_path(Path(root) / ("nested-state-" + "x" * 36))
            self.assertEqual(cleanup.parent, runner.durable_path(root))
            shutil.rmtree(cleanup)


if __name__ == "__main__":
    unittest.main()
