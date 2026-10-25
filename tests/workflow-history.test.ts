import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { WorkflowHistoryRepository, HistoryError, workflowDiff } from "../server/repositories/workflow-history";
import { templateWorkflow, type Identity } from "../app/lib/model";
import { compileDefinition } from "../domain/workflow";

const alice: Identity = { userId: "alice", email: "alice@example.invalid", displayName: "Alice" };
const bob: Identity = { userId: "bob", email: "bob@example.invalid", displayName: "Bob" };
const carol: Identity = { userId: "carol", email: "carol@example.invalid", displayName: "Carol" };
const resourceInput = { name: "자료", type: "document", description: "설명", content: "공개되지 않는 본문", url: "", visibility: "selected", allowedEmails: [bob.email] };
const status = (code: number) => (error: unknown) => error instanceof HistoryError && error.status === code;
function setup() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of ["0000_flat_robbie_robertson.sql", "0002_workflow_history.sql"]) sqlite.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  type Statement = { sync(): { meta: { changes: number } } };
  const db = {
    prepare(sql: string) {
      let args: (string | number | null)[] = [];
      const statement = {
        bind(...values: (string | number | null)[]) { args = values; return statement; },
        sync() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; },
        async run() { return statement.sync(); },
        async first() { return sqlite.prepare(sql).get(...args) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
      }; return statement;
    },
    async batch(statements: Statement[]) {
      sqlite.exec("BEGIN IMMEDIATE");
      try { const results = statements.map(statement => statement.sync()); sqlite.exec("COMMIT"); return results; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
  return { sqlite, repo: new WorkflowHistoryRepository(db) };
}

test("workflow updates require the original token and only one concurrent edit commits with its audit", async () => {
  const { sqlite, repo } = setup();
  try {
    const initial = await repo.saveWorkflow(alice, templateWorkflow("transform"), undefined);
    await assert.rejects(() => repo.saveWorkflow(bob, initial, initial.updatedAt), status(403));
    await assert.rejects(() => repo.saveWorkflow(alice, initial, undefined), status(409));
    const results = await Promise.allSettled([repo.saveWorkflow(alice, { ...initial, name: "첫 편집" }, initial.updatedAt), repo.saveWorkflow(alice, { ...initial, name: "다음 편집" }, initial.updatedAt)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected" && status(409)(result.reason)).length, 1);
    const events = await repo.audits(alice, "workflow", initial.id);
    assert.deepEqual(events.map(event => event.action).sort(), ["workflow.create", "workflow.update"]);
    assert.equal((await repo.audits(bob, "workflow", initial.id)).length, 0);
  } finally { sqlite.close(); }
});

test("immutable numbered versions restore with conflict checks and latest resource permission", async () => {
  const { sqlite, repo } = setup();
  try {
    const resource = await repo.createResource(alice, resourceInput), flow = templateWorkflow("rag");
    flow.definition.nodes.find(node => node.type === "retrieval")!.retrieval!.resourceIds = [resource.id];
    const initial = await repo.saveWorkflow(bob, flow, undefined), first = await repo.publish(bob, initial.id, initial.updatedAt);
    assert.equal(first.number, 1); assert.throws(() => sqlite.prepare("UPDATE workflow_versions SET name='tampered' WHERE id=?").run(first.id), /immutable/);
    const edited = await repo.saveWorkflow(bob, { ...initial, name: "수정본" }, initial.updatedAt);
    const second = await repo.publish(bob, edited.id, edited.updatedAt); assert.equal(second.number, 2);
    assert.equal((await repo.getVersion(bob, initial.id, first.id)).name, initial.name);
    await assert.rejects(() => repo.getVersion(carol, initial.id, first.id), status(404));
    await assert.rejects(() => repo.restore(bob, initial.id, first.id, initial.updatedAt), status(409));
    const restored = await repo.restore(bob, initial.id, first.id, edited.updatedAt); assert.equal(restored.name, initial.name);
    assert.deepEqual((await repo.versions(bob, initial.id)).map(version => version.number), [2, 1]);
    await repo.updateResource(alice, resource.id, { ...resourceInput, visibility: "private", allowedEmails: [] }, resource.updatedAt);
    await assert.rejects(() => repo.restore(bob, initial.id, first.id, restored.updatedAt), status(403));
    await assert.rejects(() => repo.publish(bob, initial.id, restored.updatedAt), status(403));
  } finally { sqlite.close(); }
});

test("resource comments use current three-user sharing; original edits remain owner-only", async () => {
  const { sqlite, repo } = setup();
  try {
    let resource = await repo.createResource(alice, resourceInput);
    await assert.rejects(() => repo.createComment(carol, resource.id, "unauthorized"), status(404));
    const comment = await repo.createComment(bob, resource.id, "검토 sk-abcdefghijklmnopqrstuvwxyz");
    assert.match(comment.text, /비밀 값 숨김/);
    assert.equal((await repo.comments(alice, resource.id))[0].canDelete, true);
    await assert.rejects(() => repo.updateResource(bob, resource.id, resourceInput, resource.updatedAt), status(404));
    await assert.rejects(() => repo.updateResource(alice, resource.id, resourceInput, undefined), status(409));
    const old = resource;
    resource = await repo.updateResource(alice, resource.id, { ...resourceInput, visibility: "public", allowedEmails: [] }, resource.updatedAt);
    assert.equal((await repo.comments(carol, resource.id))[0].canDelete, false);
    await assert.rejects(() => repo.deleteComment(carol, resource.id, comment.id), status(404));
    resource = await repo.updateResource(alice, resource.id, { ...resourceInput, visibility: "private", allowedEmails: [] }, resource.updatedAt);
    await assert.rejects(() => repo.updateResource(alice, resource.id, old, old.updatedAt), status(409));
    await assert.rejects(() => repo.comments(bob, resource.id), status(404));
    await assert.rejects(() => repo.deleteComment(bob, resource.id, comment.id), status(404));
    await repo.deleteComment(alice, resource.id, comment.id);
    const audit = JSON.stringify(await repo.audits(alice));
    for (const forbidden of [resourceInput.content, resourceInput.description, bob.email, "abcdefghijklmnopqrstuvwxyz", "검토"]) assert.ok(!audit.includes(forbidden));
    assert.ok(audit.includes("comment.create")); assert.ok(audit.includes("comment.delete"));
  } finally { sqlite.close(); }
});

test("a failed audit insert rolls back source edits and published snapshots", async () => {
  const { sqlite, repo } = setup();
  try {
    const original = await repo.saveWorkflow(alice, templateWorkflow("transform"), undefined);
    sqlite.exec("CREATE TRIGGER deny_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
    await assert.rejects(() => repo.saveWorkflow(alice, { ...original, name: "불완전 저장" }, original.updatedAt), /audit unavailable/);
    assert.equal(sqlite.prepare("SELECT name FROM workflows WHERE id=?").get(original.id)!.name, original.name);
    await assert.rejects(() => repo.publish(alice, original.id, original.updatedAt), /audit unavailable/);
    assert.equal((await repo.versions(alice, original.id)).length, 0);
  } finally { sqlite.close(); }
});

test("comment insert rechecks sharing inside the transaction and export audit accepts metadata only", async () => {
  const { sqlite, repo } = setup();
  try {
    const resource = await repo.createResource(alice, resourceInput);
    const pending = repo.createComment(bob, resource.id, "late comment");
    sqlite.prepare("UPDATE resources SET visibility='private' WHERE id=?").run(resource.id);
    await assert.rejects(() => pending, status(403));
    assert.equal((await repo.comments(alice, resource.id)).length, 0);
    await repo.recordAudit(alice, "workflow.export", "workflow", "unsaved", { version: 2, fields: ["language", "sk-secret-leak"] });
    const events = await repo.audits(alice, "workflow", "unsaved"); assert.deepEqual(events[0].metadata, { version: 2, fields: ["language"] });
    assert.equal((await repo.audits(bob)).length, 0);
  } finally { sqlite.close(); }
});

test("version diff identifies additions, removals and exact changed fields with bounded values", () => {
  const from = templateWorkflow("transform"), to = structuredClone(from);
  to.name = "새 이름"; to.definition.nodes[1].title = "새 작업"; to.definition.nodes[1].prompt = "긴 값".repeat(1000);
  to.definition.nodes.push({ id: "new", type: "output", title: "추가", x: 0, y: 0 }); to.definition.edges.pop();
  const diff = workflowDiff(from, to);
  assert.deepEqual(diff.nodes.added, ["new"]); assert.ok(diff.nodes.changed[0].fields.includes("prompt"));
  assert.equal(diff.edges.removed.length, 1); assert.equal(diff.nameChanged, true); assert.equal(diff.truncated, true);
  assert.ok(diff.changes.some(change => change.path.endsWith(".prompt") && String(change.after).length === 2001));
});

test("version diff ignores implicit mapping/schema defaults introduced by publication", () => {
  const draft = templateWorkflow("transform"), published = { ...draft, definition: compileDefinition(draft.definition) };
  const edited = structuredClone(draft); edited.name = "이름만 수정"; edited.definition.nodes[1].title = "제목만 수정";
  const diff = workflowDiff(published, edited);
  assert.equal(diff.nameChanged, true); assert.deepEqual(diff.nodes.changed, [{ id: edited.definition.nodes[1].id, title: "제목만 수정", fields: ["title"] }]);
  assert.ok(diff.changes.every(change => change.path === "name" || change.path.endsWith(".title")));
});
