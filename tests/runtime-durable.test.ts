import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeRepository } from "../server/repositories/runtime";
import { createRun, decideApproval, executeRun } from "../runtime/engine";
import { TestModelAdapter, createTestToolCaller } from "../runtime/adapters";
import { sampleResources, templateWorkflow } from "../app/lib/model";
import { testTools } from "../server/connections";

function binding(sqlite: DatabaseSync): D1Database {
  return { prepare(sql: string) {
    let args: (string | number | null)[] = [];
    const statement = { bind(...values: (string | number | null)[]) { args = values; return statement; }, async run() { const result = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; }, async first() { return sqlite.prepare(sql).get(...args) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; } };
    return statement;
  } } as unknown as D1Database;
}
const owner = { userId: "a", email: "a@example.com", displayName: "A" };
function writeRun() {
  const workflow = templateWorkflow("agent"); workflow.definition.nodes.find(n => n.type === "agent")!.allowedTools = [testTools[1]];
  return createRun({ owner, mode: "test", workflow, resources: sampleResources, input: "승인할 변경" });
}

test("approved decision is durably queued and resumes once after a new repository process", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flowly-approval-")); const path = join(directory, "state.sqlite"); let sqlite = new DatabaseSync(path); let calls = 0;
  try {
    sqlite.exec(readFileSync(new URL("../drizzle/0001_fearless_fenris.sql", import.meta.url), "utf8"));
    let repo = new RuntimeRepository(binding(sqlite)); const created = await repo.create(writeRun(), "durable-write-request", "hash");
    const lease = await repo.claim(owner.userId, created.id); assert.ok(lease);
    await executeRun(lease.run, { model: new TestModelAdapter(), tools: testTools, save: lease.save, assertAccess: async () => {}, isCancelled: lease.isCancelled, callTool: createTestToolCaller(() => calls++) }); await lease.release();
    assert.equal(calls, 0); assert.equal((await repo.get(owner.userId, created.id))?.status, "waiting_approval");
    const approvalLease = await repo.claim(owner.userId, created.id, true); assert.ok(approvalLease);
    await decideApproval(approvalLease.run, approvalLease.run.approvals[0].id, owner.userId, "approved");
    // The pure decision cannot cause an external call or make a queued state visible before save.
    assert.equal(calls, 0); assert.equal((await repo.get(owner.userId, created.id))?.status, "waiting_approval");
    await approvalLease.save(approvalLease.run); await approvalLease.release();
    sqlite.close(); sqlite = new DatabaseSync(path); repo = new RuntimeRepository(binding(sqlite));
    assert.equal((await repo.get(owner.userId, created.id))?.status, "queued");
    assert.ok((await repo.recoverable()).some(row => row.id === created.id));
    const resumed = await repo.claim(owner.userId, created.id); assert.ok(resumed);
    await executeRun(resumed.run, { model: new TestModelAdapter(), tools: testTools, save: resumed.save, assertAccess: async () => {}, isCancelled: resumed.isCancelled, callTool: createTestToolCaller(() => calls++) }); await resumed.release();
    assert.equal(calls, 1); assert.equal((await repo.get(owner.userId, created.id))?.status, "succeeded");
    assert.equal(await repo.claim(owner.userId, created.id, true), null);
  } finally { sqlite.close(); for (const suffix of ["", "-wal", "-shm"]) { try { unlinkSync(path + suffix); } catch { /* SQLite may not create journal files. */ } } rmdirSync(directory); }
});
test("an expired writer cannot publish an approval decision over the durable pending checkpoint", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(readFileSync(new URL("../drizzle/0001_fearless_fenris.sql", import.meta.url), "utf8")); const repo = new RuntimeRepository(binding(sqlite)); const created = await repo.create(writeRun(), "approval-fence", "hash");
    const lease = await repo.claim(owner.userId, created.id); assert.ok(lease);
    await executeRun(lease.run, { model: new TestModelAdapter(), tools: testTools, save: lease.save, assertAccess: async () => {}, isCancelled: lease.isCancelled, callTool: createTestToolCaller() }); await lease.release();
    const approval = await repo.claim(owner.userId, created.id, true); assert.ok(approval);
    await decideApproval(approval.run, approval.run.approvals[0].id, owner.userId, "approved");
    sqlite.exec("UPDATE runtime_runs SET lease_until=0");
    await assert.rejects(approval.save(approval.run), /만료/);
    const persisted = await repo.get(owner.userId, created.id); assert.equal(persisted?.status, "waiting_approval"); assert.equal(persisted?.approvals[0].status, "pending");
  } finally { sqlite.close(); }
});
test("scheduled queue selects bounded runnable, cancelled and expired work while excluding active leases", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(readFileSync(new URL("../drizzle/0001_fearless_fenris.sql", import.meta.url), "utf8")); const repo = new RuntimeRepository(binding(sqlite));
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const run = writeRun(); run.createdAt = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
      if (i === 1) run.status = "running";
      if ([2, 3, 4].includes(i)) { run.status = "waiting_approval"; run.approvals = [{ id: "approval", runId: run.id, userId: owner.userId, callId: "call", toolName: "draft_note", argsHash: "hash", expiresAt: i === 2 ? "2020-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z", status: "pending" }]; }
      if (i === 5) run.status = "succeeded";
      await repo.create(run, `scheduled-${i}`, `hash-${i}`); ids.push(run.id);
    }
    await repo.cancel(owner.userId, ids[3]);
    const active = await repo.claim(owner.userId, ids[6]); assert.ok(active);
    assert.deepEqual((await repo.recoverable()).map(row => row.id), ids.slice(0, 3));
    sqlite.prepare("UPDATE runtime_runs SET status='succeeded' WHERE id IN (?,?)").run(ids[0], ids[1]);
    assert.deepEqual((await repo.recoverable()).map(row => row.id), ids.slice(2, 4));
    await active.release();
  } finally { sqlite.close(); }
});
