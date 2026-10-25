"""Real Python worker process-tree cleanup with local synthetic processes only."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from toolpack_worker_fixture import HELPER_SOURCE, cleanup, wait_stopped

ROOT = Path(__file__).resolve().parents[1]
DRIVER = '''import json, runpy, sys, time
from pathlib import Path
root = Path(__file__).resolve().parent
module = runpy.run_path(str(root / "runner.py"), run_name="flowly_worker_tree_test")
mode = sys.argv[1]
started = time.monotonic()
cancelled_at = []
def cancelled():
    if (root / "pids.json").exists():
        cancelled_at.append(time.monotonic())
        return True
    return False
try:
    result = module["python_tool_worker"]({"mode": mode},
        timeout_ms=4000 if mode == "timeout" else 15000,
        cancelled=cancelled if mode == "cancel" else None)
    value = {"result": result}
except module["Fault"] as error:
    value = {"code": error.code}
value["elapsed"] = time.monotonic() - started
value["cleanupElapsed"] = time.monotonic() - cancelled_at[0] if cancelled_at else max(0, value["elapsed"] - 4) if mode == "timeout" else 0
print(json.dumps(value), flush=True)
'''


class ToolWorkerTreeTests(unittest.TestCase):
    def run_case(self, mode):
        with tempfile.TemporaryDirectory(prefix="flowly-python-worker-tree-") as folder:
            root = Path(folder)
            shutil.copyfile(ROOT / "export-runtime/runner.py", root / "runner.py")
            (root / "flowly_tools.py").write_text(HELPER_SOURCE, encoding="utf8")
            (root / "driver.py").write_text(DRIVER, encoding="utf8")
            driver = subprocess.Popen([sys.executable, "-I", "-S", "-X", "utf8", str(root / "driver.py"), mode],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                      creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            pids = []
            try:
                try:
                    output, error = driver.communicate(timeout=20)
                except subprocess.TimeoutExpired:
                    self.fail("worker did not settle within the bounded cleanup deadline")
                self.assertEqual(driver.returncode, 0, error)
                self.assertTrue((root / "pids.json").is_file(), "synthetic helper did not start")
                pids = json.loads((root / "pids.json").read_text())
                value = json.loads(output)
                self.assertLess(value["cleanupElapsed"], 3.5, "cleanup must not wait for descendant pipe closure")
                if mode == "exit":
                    self.assertLess(value["elapsed"], 10, "normal completion must not wait for descendant pipe closure")
                self.assertTrue(wait_stopped(pids), "helper or descendant survived worker completion")
                return value
            finally:
                if (root / "pids.json").is_file():
                    pids = json.loads((root / "pids.json").read_text())
                cleanup([driver.pid, *pids])
                if driver.poll() is None:
                    driver.kill()
                driver.communicate(timeout=3)

    def test_cancellation_stops_helper_and_descendant(self):
        self.assertEqual(self.run_case("cancel")["code"], "cancelled")

    def test_timeout_stops_helper_and_descendant(self):
        self.assertEqual(self.run_case("timeout")["code"], "budget_exceeded")

    def test_successful_helper_exit_releases_descendant_pipes(self):
        self.assertEqual(self.run_case("exit")["result"], {"finished": True})


if __name__ == "__main__":
    unittest.main()
