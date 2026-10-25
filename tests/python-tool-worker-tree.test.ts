import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pythonToolWorker } from "../export-runtime/python-tools";

const python = process.env.FLOWLY_TEST_PYTHON || (existsSync(resolve("work/tools-env/Scripts/python.exe")) ? resolve("work/tools-env/Scripts/python.exe") : "python");
const fixture = resolve("tests/toolpack_worker_fixture.py");
const helper = spawnSync(python, ["-I", "-S", "-c", "import runpy,sys; sys.stdout.write(runpy.run_path(sys.argv[1])['HELPER_SOURCE'])", fixture], { encoding: "utf8", windowsHide: true, timeout: 15000 });
assert.equal(helper.status, 0, helper.stderr);

async function runCase(mode: "cancel" | "exit") {
  const root = await mkdtemp(join(tmpdir(), "flowly-node-worker-tree-"));
  const controller = new AbortController();
  let pids: number[] = [];
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await writeFile(join(root, "flowly_tools.py"), helper.stdout);
    const worker = pythonToolWorker(join(root, "workflow.json"), python);
    const started = performance.now();
    // Handle rejection immediately while waiting for the fixture readiness file.
    const completion = worker({ mode }, controller.signal).then(result => ({ result }), error => ({ error }));
    const readyDeadline = performance.now() + 12000;
    while (!existsSync(join(root, "pids.json")) && performance.now() < readyDeadline) await delay(25);
    assert.ok(existsSync(join(root, "pids.json")), "synthetic helper did not start");
    pids = JSON.parse(await readFile(join(root, "pids.json"), "utf8"));
    const cancelStarted = performance.now();
    if (mode === "cancel") controller.abort();
    const value = await Promise.race([
      completion,
      new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error("worker did not settle within the bounded cleanup deadline")), 8000); }),
    ]);
    assert.ok(performance.now() - (mode === "cancel" ? cancelStarted : started) < (mode === "cancel" ? 3500 : 15000), "cleanup must not wait for descendant pipe closure");
    if (mode === "cancel") {
      assert.ok("error" in value);
      assert.equal(value.error.code, "cancelled");
    } else {
      assert.ok("result" in value, "error" in value ? String(value.error) : undefined);
      assert.deepEqual(value.result, { finished: true });
    }
    const stopped = spawnSync(python, ["-I", "-S", fixture, "wait", ...pids.map(String)], { encoding: "utf8", windowsHide: true, timeout: 10000 });
    assert.equal(stopped.status, 0, "helper or descendant survived worker completion");
  } finally {
    if (watchdog) clearTimeout(watchdog);
    controller.abort();
    if (!pids.length && existsSync(join(root, "pids.json"))) pids = JSON.parse(await readFile(join(root, "pids.json"), "utf8"));
    spawnSync(python, ["-I", "-S", fixture, "cleanup", ...pids.map(String)], { windowsHide: true, timeout: 15000 });
    await rm(root, { recursive: true, force: true });
  }
}

test("Node bridge cancellation terminates helper and its descendant", () => runCase("cancel"));
test("Node bridge successful helper exit releases descendant pipes", () => runCase("exit"));
