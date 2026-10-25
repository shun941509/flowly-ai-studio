import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { templateWorkflow } from "../app/lib/model";
import { runCommand } from "../export-runtime/runner";
import type { ExportManifest } from "../export-runtime/manifest";
import { FileRunStore } from "../export-runtime/store";
import type { CheckResult } from "../export-runtime/diagnostics";
import type { PublicRun } from "../runtime/types";

const owner = { userId: "local-owner", email: "local@example.com", displayName: "로컬 테스트" };
async function fixture(kind: string) {
  const directory = await mkdtemp(join(tmpdir(), "flowly-advanced-test-"));
  const manifest: ExportManifest = { format: "flowly-executable-export", version: 1, language: "node", exportedAt: "2026-10-22", owner, workflow: templateWorkflow(kind), resources: [], connections: [] };
  const packagePath = join(directory, "workflow.json"), stateDirectory = join(directory, "state"); await writeFile(packagePath, JSON.stringify(manifest));
  return { directory, packagePath, stateDirectory, manifest, async cleanup() { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); } };
}

test("Node check traverses child models and counts nested definitions while data-only groups need no key", async t => {
  let requests = 0; t.mock.method(globalThis, "fetch", () => { requests++; throw new Error("unexpected network"); });
  for (const [kind, requiresModel] of [["parallel-work", false], ["agent-team", true], ["orchestrated-work", true], ["classified-form", true]] as const) {
    const f = await fixture(kind);
    try {
      const checked = await runCommand({ action: "check" }, f) as CheckResult;
      assert.equal(checked.requiresModel, requiresModel); assert.equal(checked.status, requiresModel ? "unconfigured" : "ready");
      if (kind === "parallel-work") { assert.equal(checked.counts.nodes, 9); const run = await runCommand({ action: "run", input: "nested" }, f) as PublicRun; assert.equal(run.status, "succeeded"); assert.equal(run.children!.length, 2); }
    } finally { await f.cleanup(); }
  }
  assert.equal(requests, 0);
});

test("Node review CLI stores an edited decision, redacts secrets, resumes and renders child review reports without env", async () => {
  const f = await fixture("human-review"), cli = resolve("export-runtime/cli.ts"), tsx = resolve("node_modules/tsx/dist/cli.mjs");
  const invoke = (args: string[]) => spawnSync(process.execPath, [tsx, cli, ...args, "--state", f.stateDirectory], { cwd: f.directory, encoding: "utf8" });
  try {
    const started = invoke(["run", "--input", "검토할 내용"]); assert.equal(started.status, 0, started.stderr); const waiting = JSON.parse(started.stdout) as PublicRun;
    assert.equal(waiting.status, "waiting_review");
    await writeFile(join(f.directory, "edited.json"), JSON.stringify({ text: "사람이 수정한 최종값", password: "synthetic-password-do-not-store", extra: "sk-synthetic-only-123456789" }));
    const accepted = invoke(["accept", waiting.id, waiting.reviews![0].id, "--edited-input-file", "edited.json", "--env", f.directory]); assert.equal(accepted.status, 0, accepted.stderr); assert.equal(JSON.parse(accepted.stdout).status, "queued");
    const persisted = await readFile(join(f.stateDirectory, `${waiting.id}.json`), "utf8"); assert.doesNotMatch(persisted, /synthetic-password|sk-synthetic-only/);
    const resumed = invoke(["resume", waiting.id]); assert.equal(resumed.status, 0, resumed.stderr); assert.equal(JSON.parse(resumed.stdout).result, "사람이 수정한 최종값");
    const reported = invoke(["report", waiting.id, "--output", "review.html", "--env", f.directory]); assert.equal(reported.status, 0, reported.stderr); assert.match(await readFile(join(f.directory, "review.html"), "utf8"), /사람 검토 기록/);
    const forbidden = invoke(["reject", waiting.id, waiting.reviews![0].id, "--edited-input-file", "edited.json"]); assert.equal(forbidden.status, 1);
  } finally { await f.cleanup(); }
});

test("Node group report includes safely escaped child results and decisions and completed children are not repeated", async () => {
  const f = await fixture("reusable-work");
  try {
    const run = await runCommand({ action: "run", input: "<script>child result</script>" }, f) as PublicRun;
    assert.equal(run.status, "succeeded"); assert.equal(run.children!.length, 1);
    const before = await readFile(join(f.stateDirectory, `${run.id}.json`), "utf8");
    await runCommand({ action: "resume", runId: run.id }, f);
    assert.equal(await readFile(join(f.stateDirectory, `${run.id}.json`), "utf8"), before);
    const output = join(f.directory, "child.html"); await runCommand({ action: "report", runId: run.id, output }, f);
    const html = await readFile(output, "utf8"); assert.match(html, /하위 작업/); assert.match(html, /&lt;script&gt;child result/); assert.doesNotMatch(html, /<script>/);
  } finally { await f.cleanup(); }
});

test("local memory is atomic, replay-safe, serialized and scoped by owner plus root workflow", async () => {
  const f = await fixture("remember-value"); const store = new FileRunStore(f.stateDirectory);
  try {
    await store.acquire();
    const base = { ownerId: owner.userId, workflowId: f.manifest.workflow.id, key: "value" };
    await store.memory({ ...base, operationId: "run:first", action: "write", value: "first" });
    await store.memory({ ...base, operationId: "run:second", action: "write", value: "second" });
    const replay = await store.memory({ ...base, operationId: "run:first", action: "write", value: "first" }); assert.deepEqual(replay, { data: "first", found: true });
    assert.deepEqual(await store.memory({ ...base, operationId: "run:read", action: "read" }), { data: "second", found: true });
    await assert.rejects(store.memory({ ...base, operationId: "run:first", action: "write", value: "tampered" }), /바뀌/);
    assert.deepEqual(await store.memory({ ...base, ownerId: "another-owner", operationId: "run:other", action: "read", defaultValue: "empty" }), { data: "empty", found: false });
    assert.deepEqual(await store.memory({ ...base, workflowId: "another-flow", operationId: "run:other", action: "read" }), { data: null, found: false });
    await Promise.all(Array.from({ length: 8 }, (_, i) => store.memory({ ...base, key: `field_${i}`, operationId: `parallel:${i}`, action: "write", value: i })));
    for (let i = 0; i < 8; i++) assert.equal((await store.memory({ ...base, key: `field_${i}`, operationId: `read:${i}`, action: "read" })).data, i);
    assert.deepEqual(await store.memory({ ...base, operationId: "run:delete", action: "delete" }), { data: null, found: true });
    assert.deepEqual(await store.memory({ ...base, operationId: "run:after-delete", action: "read" }), { data: null, found: false });
    await store.release();
    assert.ok(!(await readdir(f.stateDirectory)).some(name => name.endsWith(".tmp") || name.endsWith(".lock")));
    const run = await runCommand({ action: "run", input: "저장할 실제 값" }, f) as PublicRun; assert.equal(run.status, "succeeded"); assert.equal(run.result, "저장할 실제 값");
  } finally { await store.release(); await f.cleanup(); }
});
