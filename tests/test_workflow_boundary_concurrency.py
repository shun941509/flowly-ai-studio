"""The offline provider fixture must allocate model reply occurrences atomically."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BOUNDARY = ROOT / "tests/workflow-python-boundary.py"

# Only this test's private folder receives this stub. The actual boundary module
# installs its Http.post method; no runner/tool implementation is replaced in ZIPs.
STUB_RUNNER = '''import json, threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

class Http:
    def post(self, *args, **kwargs):
        raise AssertionError("actual test boundary was not installed")

def main(arguments):
    boundary = Http.post.__globals__
    original_entries = boundary["entries"]
    readers = [0]
    readers_lock = threading.Lock()
    both_read = threading.Event()
    started = threading.Barrier(2)

    def concurrent_entries(path):
        snapshot = original_entries(path)
        if path == ".model-calls.jsonl":
            with readers_lock:
                readers[0] += 1
                if readers[0] == 2:
                    both_read.set()
            # Before the fix both threads capture the same empty snapshot. With
            # the fix the second reader cannot enter until the first logs; this
            # bounded wait expires without deadlocking the production test lock.
            both_read.wait(timeout=0.5)
        return snapshot

    boundary["entries"] = concurrent_entries
    def request(index):
        started.wait(timeout=3)
        body = {"input": [{"role": "user", "content": json.dumps({
            "instruction": "shared-parallel-analysis", "input": {"index": index}
        })}], "tools": []}
        response, _ = Http().post("https://api.openai.com/v1/responses", body, {}, 5000)
        return response["output"][0]["content"][0]["text"]

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            replies = list(executor.map(request, [1, 2]))
    finally:
        boundary["entries"] = original_entries
    Path("observed.json").write_text(json.dumps({
        "replies": replies,
        "occurrences": [entry["occurrence"] for entry in original_entries(".model-calls.jsonl")]
    }), encoding="utf8")
    return 0
'''


class WorkflowBoundaryConcurrencyTests(unittest.TestCase):
    def test_parallel_same_marker_receives_distinct_occurrences(self):
        with tempfile.TemporaryDirectory(prefix="flowly-boundary-race-") as folder:
            root = Path(folder)
            (root / "runner.py").write_text(STUB_RUNNER, encoding="utf8")
            (root / "workflow.json").write_text(json.dumps({"connections": []}), encoding="utf8")
            (root / ".scenario.json").write_text(json.dumps({"modelReplies": [
                {"match": "shared-parallel-analysis", "occurrence": 1, "text": "first actual fixture response"},
                {"match": "shared-parallel-analysis", "occurrence": 2, "text": "second actual fixture response"},
            ]}), encoding="utf8")
            execution = subprocess.run([sys.executable, "-I", "-S", "-X", "utf8", str(BOUNDARY)],
                                       cwd=root, capture_output=True, text=True, timeout=15,
                                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            self.assertEqual(execution.returncode, 0, execution.stderr)
            observed = json.loads((root / "observed.json").read_text(encoding="utf8"))
            self.assertEqual(sorted(observed["occurrences"]), [1, 2],
                             "parallel model calls must not consume the same occurrence")
            self.assertEqual(sorted(observed["replies"]), [
                "first actual fixture response", "second actual fixture response"
            ], "parallel model calls must receive their respective configured replies")


if __name__ == "__main__":
    unittest.main()
