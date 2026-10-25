import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { monitorCancellationFile } from "../export-runtime/cancellation";
import { createRun, decideApproval, decideReview, executeRun } from "../runtime/engine";
import { sampleResources, templateWorkflow } from "../app/lib/model";
import { TestModelAdapter } from "../runtime/adapters/test";
import type { RuntimeDependencies, ToolDefinition } from "../runtime/types";
import type { PublicRun } from "../runtime/types";
import type { ExportManifest } from "../export-runtime/manifest";
import { runCommand } from "../export-runtime/runner";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "flowly-cancel-")), packagePath = join(root, "workflow.json");
  await writeFile(packagePath, "{}");
  return { root, packagePath, async close() { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); } };
}
test("queue cancel file is local, rejects escape paths and aborts on creation", async () => {
  const f = await fixture(); let stop: (() => void) | undefined;
  try {
    await assert.rejects(() => monitorCancellationFile(f.packagePath, "../cancel", new AbortController()), /프로젝트 폴더/);
    await mkdir(join(f.root, "signals"));
    const controller = new AbortController(); stop = await monitorCancellationFile(f.packagePath, "signals/job.cancel", controller);
    assert.equal(controller.signal.aborted, false);
    await writeFile(join(f.root, "signals", "job.cancel"), "content is never read");
    await new Promise(resolve => setTimeout(resolve, 160)); assert.equal(controller.signal.aborted, true);
  } finally { stop?.(); await f.close(); }
});
test("queue signal rejects parent junction escape and notices an existing empty flag", async () => {
  const f = await fixture(), external = await fixture(); let stop: (() => void) | undefined;
  try {
    await symlink(external.root, join(f.root, "outside"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => monitorCancellationFile(f.packagePath, "outside/cancel", new AbortController()), /벗어났/);
    await writeFile(join(f.root, "cancel"), ""); const controller = new AbortController();
    stop = await monitorCancellationFile(f.packagePath, "cancel", controller); assert.equal(controller.signal.aborted, true);
  } finally { stop?.(); await f.close(); await external.close(); }
});
const owner = { userId: "cancel-owner", displayName: "취소 검사", email: "cancel@example.invalid" };
const tool: ToolDefinition = { resourceId: "sample-search", connectionId: "test", toolName: "query", name: "query", description: "취소 검사", effect: "read", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } };
function setup(effect: "read" | "write") {
  const workflow = templateWorkflow("agent"); workflow.definition.nodes.find(node => node.type === "agent")!.allowedTools = [tool];
  const run = createRun({ owner, mode: "test", workflow, resources: sampleResources, input: "취소" });
  const controller = new AbortController(); let aborted = false, started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const deps: RuntimeDependencies & { cancellationSignal: AbortSignal } = {
    model: new TestModelAdapter(), tools: [{ ...tool, effect }], save: async () => {}, assertAccess: async () => {}, isCancelled: async () => controller.signal.aborted, cancellationSignal: controller.signal,
    callTool: async (_tool, _args, options) => { started(); return new Promise((_resolve, reject) => { options.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true }); }); },
  };
  return { run, deps, controller, waiting, get aborted() { return aborted; } };
}
test("queue cancellation aborts an active read without retry and durably marks cancelled", async () => {
  const h = setup("read"), pending = executeRun(h.run, h.deps); await h.waiting; h.controller.abort(); await pending;
  assert.equal(h.aborted, true); assert.equal(h.run.status, "cancelled"); assert.equal(h.run.checkpoint.calls[0].attempts, 1);
});
test("queue cancellation during an approved write preserves unknown outcome and never retries", async () => {
  const h = setup("write"); await executeRun(h.run, h.deps); assert.equal(h.run.status, "waiting_approval");
  await decideApproval(h.run, h.run.approvals[0].id, owner.userId, "approved");
  const pending = executeRun(h.run, h.deps); await h.waiting; h.controller.abort(); await pending;
  assert.equal(h.aborted, true); assert.equal(h.run.status, "unknown_outcome"); assert.equal(h.run.checkpoint.calls[0].status, "unknown_outcome");
  await executeRun(h.run, h.deps); assert.equal(h.run.checkpoint.calls[0].attempts, 1);
});

function packageFor(workflow = templateWorkflow("agent")): ExportManifest {
  workflow.definition.nodes.filter(node => node.type === "agent").forEach(node => { node.allowedTools = [tool]; });
  return { format: "flowly-executable-export", version: 1, language: "node", exportedAt: new Date().toISOString(), owner, workflow,
    resources: sampleResources.map(resource => { const { allowedEmails: _, ...snapshot } = resource; void _; return snapshot; }),
    connections: [{ id: "test", ownerId: owner.userId, resourceId: "sample-search", name: "주입 도구", endpoint: "https://tools.example.com/mcp", tools: [{ ...tool, effect: "write" }] }] };
}
test("provider model is pinned before execution; rotation is allowed, changes block resume before dispatch", async () => {
  const f = await fixture(), manifest = packageFor(); const stateDirectory = join(f.root, "runs"); let calls = 0;
  const adapters = { model: new TestModelAdapter(), callTool: async () => { calls++; return { text: "approved" }; } };
  try {
    await writeFile(f.packagePath, JSON.stringify(manifest));
    const options = { packagePath: f.packagePath, stateDirectory, env: { OPENAI_API_KEY: "synthetic-key-a", FLOWLY_MODEL: "model-a" }, adapters };
    const first = await runCommand({ action: "run", input: "pin" }, options) as PublicRun;
    assert.equal(first.status, "waiting_approval"); assert.deepEqual(first.provider, { model: "model-a" });
    const status = await runCommand({ action: "status", runId: first.id }, { packagePath: f.packagePath, stateDirectory }) as PublicRun;
    assert.deepEqual(status.provider, first.provider);
    await runCommand({ action: "approve", runId: first.id, approvalId: first.approvals[0].id }, { packagePath: f.packagePath, stateDirectory });
    await assert.rejects(() => runCommand({ action: "resume", runId: first.id }, { ...options, env: { ...options.env, FLOWLY_MODEL: "model-b" } }), /모델 설정/);
    assert.equal(calls, 0);
    const result = await runCommand({ action: "resume", runId: first.id }, { ...options, env: { OPENAI_API_KEY: "synthetic-key-rotated", FLOWLY_MODEL: "model-a", FLOWLY_EMBEDDING_MODEL: "unused" } }) as PublicRun;
    assert.equal(result.status, "succeeded"); assert.equal(calls, 1);
    const path = join(stateDirectory, first.id + ".json"), saved = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(saved.run.provider, { model: "model-a" }); assert.doesNotMatch(JSON.stringify(saved), /synthetic-key/);
    delete saved.run.provider; await writeFile(path, JSON.stringify(saved));
    assert.equal((await runCommand({ action: "resume", runId: first.id }, { ...options, env: { ...options.env, FLOWLY_MODEL: "legacy-compatible" } }) as PublicRun).status, "succeeded");
  } finally { await f.close(); }
});
test("vector-only runs pin default embedding model without requiring or recording a response model", async () => {
  const f = await fixture(), workflow = templateWorkflow("rag"), retrieval = workflow.definition.nodes.find(node => node.type === "retrieval")!;
  retrieval.retrieval!.mode = "vector";
  const input = workflow.definition.nodes.find(node => node.type === "input")!, output = workflow.definition.nodes.find(node => node.type === "output")!;
  workflow.definition = { schemaVersion: 5, nodes: [input, retrieval, output], edges: [{ id: "ir", source: input.id, target: retrieval.id }, { id: "ro", source: retrieval.id, target: output.id }] };
  const manifest = packageFor(workflow), stateDirectory = join(f.root, "runs");
  let embeddings = 0;
  const adapters = { model: { next: async () => { throw new Error("unexpected model"); }, embed: async ({ texts }: { texts: string[] }) => { embeddings++; return { vectors: texts.map(() => [1, 0]), usageTokens: 3, model: "text-embedding-3-small" }; } }, callTool: async () => { throw new Error("unexpected tool"); } };
  try {
    await writeFile(f.packagePath, JSON.stringify(manifest));
    const options = { packagePath: f.packagePath, stateDirectory, adapters, env: { OPENAI_API_KEY: "synthetic-key" } };
    const result = await runCommand({ action: "run", input: "문서 검색" }, options) as PublicRun;
    assert.equal(result.status, "succeeded"); assert.deepEqual(result.provider, { embeddingModel: "text-embedding-3-small" });
    const count = embeddings;
    await assert.rejects(() => runCommand({ action: "resume", runId: result.id }, { ...options, env: { ...options.env, FLOWLY_EMBEDDING_MODEL: "different-embedding" } }), /모델 설정/);
    assert.equal(embeddings, count);
  } finally { await f.close(); }
});
test("provider metadata refuses accidental credentials before a run is stored", async () => {
  const f = await fixture();
  try {
    await writeFile(f.packagePath, JSON.stringify(packageFor()));
    await assert.rejects(() => runCommand({ action: "run", input: "pin" }, { packagePath: f.packagePath, stateDirectory: join(f.root, "runs"), env: { OPENAI_API_KEY: "synthetic-secret", FLOWLY_MODEL: "synthetic-secret" }, adapters: { model: new TestModelAdapter(), callTool: async () => ({}) } }), /비밀 값/);
  } finally { await f.close(); }
});

test("restored write-capable checkpoints remain readable but cannot decide or replay historical effects", async () => {
  const f = await fixture(), stateDirectory = join(f.root, "runs"); let calls = 0;
  const adapters = { model: new TestModelAdapter(), callTool: async () => { calls++; return { text: "side effect" }; } };
  try {
    await writeFile(f.packagePath, JSON.stringify(packageFor()));
    const options = { packagePath: f.packagePath, stateDirectory, adapters };
    const pending = await runCommand({ action: "run", input: "original" }, options) as PublicRun;
    assert.equal(pending.status, "waiting_approval");
    const path = join(stateDirectory, pending.id + ".json"), backup = JSON.parse(await readFile(path, "utf8"));
    await runCommand({ action: "approve", runId: pending.id, approvalId: pending.approvals[0].id }, options);
    assert.equal((await runCommand({ action: "resume", runId: pending.id }, options) as PublicRun).status, "succeeded");
    assert.equal(calls, 1);
    // Operations restore annotates the older snapshot after hash validation.
    backup.run.restoredReadOnly = true; await writeFile(path, JSON.stringify(backup));
    const saved = await readFile(path, "utf8"), restored = await runCommand({ action: "status", runId: pending.id }, options) as PublicRun;
    assert.equal(restored.restoredReadOnly, true); assert.equal(restored.status, "waiting_approval");
    for (const action of ["approve", "deny"] as const) await assert.rejects(() => runCommand({ action, runId: pending.id, approvalId: pending.approvals[0].id }, options), /조회만/);
    for (const action of ["accept", "reject"] as const) await assert.rejects(() => runCommand({ action, runId: pending.id, reviewId: "unused" }, options), /조회만/);
    await assert.rejects(() => runCommand({ action: "resume", runId: pending.id }, options), /조회만/);
    assert.equal(await readFile(path, "utf8"), saved); assert.equal(calls, 1);
    await runCommand({ action: "report", runId: pending.id, output: join(f.root, "restored.html") }, { packagePath: f.packagePath, stateDirectory });
    assert.match(await readFile(join(f.root, "restored.html"), "utf8"), /복원한 외부 변경 실행은 조회만/);
    await assert.rejects(() => decideApproval(backup.run, pending.approvals[0].id, owner.userId, "approved"), /조회만/);
    await assert.rejects(() => decideReview(backup.run, "unused", owner.userId, "accepted"), /조회만/);
    await assert.rejects(() => executeRun(backup.run, { ...adapters, tools: [], save: async () => {}, assertAccess: async () => {}, isCancelled: async () => false }), /조회만/);
    const fresh = await runCommand({ action: "run", input: "new explicit request" }, options) as PublicRun;
    assert.notEqual(fresh.id, pending.id); assert.equal(fresh.status, "waiting_approval"); assert.equal(calls, 1);
  } finally { await f.close(); }
});
