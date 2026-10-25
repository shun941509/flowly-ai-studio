/** Synthetic local three-user HTTP/D1 checks. No external provider or credentials. */
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { templateWorkflow, type Resource, type Workflow } from "../app/lib/model";
import type { WorkflowVersion } from "../server/repositories/workflow-history";

const origin = "http://127.0.0.1:5173", cookies: Record<string, string> = {};
type ApiResponse = { error?: string; workflow: Workflow; resource: Resource; version: WorkflowVersion; versions: WorkflowVersion[]; diff: { nameChanged: boolean }; comment: { id: string }; comments: { canDelete: boolean }[]; events: { action: string }[]; conflict?: boolean; current: Workflow | Resource };
let resource: Resource | undefined, workflow: Workflow | undefined, passed = 0;
async function post(user: string, body: unknown, path = "/api/studio") {
  return fetch(origin + path, { method: "POST", headers: { origin, cookie: cookies[user], "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
}
async function good(user: string, body: unknown, status = 200) {
  const response = await post(user, body); const result = await response.json() as ApiResponse;
  assert.equal(response.status, status, result.error); return result;
}
function pass(text: string) { passed++; console.log(`PASS ${text}`); }
try {
  for (const user of ["alice", "bob", "carol"]) {
    const response = await fetch(origin + "/api/auth/test", { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ identity: user, return_to: "/studio" }) });
    assert.equal(response.status, 303); cookies[user] = response.headers.get("set-cookie")!.split(";")[0];
  }
  const data = { name: "운영 회귀 합성 자료", type: "document", description: "테스트", content: "감사에 포함하면 안 되는 원문 472601", url: "", visibility: "selected", allowedEmails: ["bob@flowly.test"] };
  resource = (await good("alice", { action: "resource.create", data }, 201)).resource;
  const initial = templateWorkflow("rag"); initial.id = "history-" + crypto.randomUUID();
  initial.definition.nodes.find(node => node.type === "retrieval")!.retrieval!.resourceIds = [resource!.id];
  workflow = (await good("bob", { action: "workflow.save", data: initial })).workflow;
  assert.equal((await post("bob", { action: "workflow.save", data: workflow })).status, 409);
  assert.equal((await post("alice", { action: "workflow.save", data: workflow, baseUpdatedAt: workflow!.updatedAt })).status, 403);
  const version: WorkflowVersion = (await good("bob", { action: "workflow.publish", id: workflow!.id, baseUpdatedAt: workflow!.updatedAt })).version;
  const prior = workflow!;
  const writes = await Promise.all(["동시 편집 A", "동시 편집 B"].map(name => post("bob", { action: "workflow.save", data: { ...prior, name }, baseUpdatedAt: prior.updatedAt })));
  assert.deepEqual(writes.map(response => response.status).sort(), [200, 409]);
  for (const response of writes) { const result = await response.json() as ApiResponse; if (response.status === 200) workflow = result.workflow; else { assert.equal(result.conflict, true); assert.ok(result.current.updatedAt); } }
  pass("real D1 concurrent save commits one draft and rejects stale/missing tokens");

  const diff = (await good("bob", { action: "workflow.diff", id: workflow!.id, fromVersionId: version.id })).diff;
  assert.equal(diff.nameChanged, true);
  assert.equal((await post("carol", { action: "workflow.version", id: workflow!.id, versionId: version.id })).status, 404);
  assert.equal((await good("bob", { action: "workflow.versions", id: workflow!.id })).versions.length, 1);
  const pinned = (await good("bob", { action: "workflow.version", id: workflow!.id, versionId: version.id })).version;
  assert.equal(pinned.name, prior.name);
  assert.equal((await post("bob", { action: "workflow.restore", id: workflow!.id, versionId: version.id, baseUpdatedAt: prior.updatedAt })).status, 409);
  workflow = (await good("bob", { action: "workflow.restore", id: workflow!.id, versionId: version.id, baseUpdatedAt: workflow!.updatedAt })).workflow;
  assert.equal(workflow!.name, prior.name);
  pass("published versions are owner-scoped immutable snapshots with diff and explicit restore");

  const exported = await post("bob", { workflowId: workflow!.id, versionId: version.id, language: "node" }, "/api/export");
  assert.equal(exported.status, 200);
  const files = unzipSync(new Uint8Array(await exported.arrayBuffer()));
  const manifest = JSON.parse(strFromU8(files["workflow.json"]));
  assert.equal(manifest.workflow.name, version.name); assert.equal(manifest.owner.userId, "test:bob");
  pass("published version ZIP is generated from its saved snapshot and verified session");

  const comment = (await good("bob", { action: "comment.create", id: resource!.id, text: "감사에 포함하면 안 되는 댓글 682531" })).comment;
  assert.equal((await post("carol", { action: "resource.comments", id: resource!.id })).status, 404);
  assert.equal((await post("bob", { action: "resource.update", id: resource!.id, data, baseUpdatedAt: resource!.updatedAt })).status, 404);
  assert.equal((await good("alice", { action: "resource.comments", id: resource!.id })).comments[0].canDelete, true);
  assert.equal((await post("alice", { action: "resource.update", id: resource!.id, data })).status, 409);
  const before = resource!;
  resource = (await good("alice", { action: "resource.update", id: resource!.id, data: { ...data, visibility: "private", allowedEmails: [] }, baseUpdatedAt: resource!.updatedAt })).resource;
  assert.equal((await post("alice", { action: "resource.update", id: resource!.id, data, baseUpdatedAt: before.updatedAt })).status, 409);
  assert.equal((await post("bob", { action: "resource.comments", id: resource!.id })).status, 404);
  assert.equal((await post("bob", { action: "comment.delete", id: resource!.id, commentId: comment.id })).status, 404);
  await good("alice", { action: "comment.delete", id: resource!.id, commentId: comment.id });
  pass("comments follow current sharing and cannot grant original-resource mutation rights");

  assert.equal((await post("bob", { action: "workflow.restore", id: workflow!.id, versionId: version.id, baseUpdatedAt: workflow!.updatedAt })).status, 403);
  assert.equal((await post("bob", { workflowId: workflow!.id, versionId: version.id, language: "python" }, "/api/export")).status, 403);
  pass("revoked resource permission blocks restoration and a fresh published-version export");

  const aliceAudit = await good("alice", { action: "audit.list", targetType: "resource", id: resource!.id });
  const bobAudit = await good("bob", { action: "audit.list", targetType: "workflow", id: workflow!.id });
  const serialized = JSON.stringify([aliceAudit, bobAudit]);
  assert.ok(!serialized.includes("472601") && !serialized.includes("682531") && !serialized.includes("bob@flowly.test"));
  assert.ok(bobAudit.events.some((event: { action: string }) => event.action === "workflow.export"));
  assert.equal(bobAudit.events.filter((event: { action: string }) => event.action === "workflow.update").length, 1);
  assert.equal((await good("carol", { action: "audit.list", targetType: "workflow", id: workflow!.id })).events.length, 0);
  pass("audits expose metadata only, include only committed changes and remain owner-scoped");
  console.log(`PASS ${passed} local workflow-history HTTP/D1 scenarios. External API calls: 0.`);
} finally {
  if (workflow) await post("bob", { action: "workflow.delete", id: workflow.id });
  if (resource) await post("alice", { action: "resource.delete", id: resource.id });
}
