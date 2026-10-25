/** Local test-auth/D1 verification only. No external model or MCP requests. */
import assert from "node:assert/strict";
import { templateWorkflow, type Workflow } from "../app/lib/model";
import type { PublicRun } from "../runtime/types";

const origin = "http://127.0.0.1:5173", cookies: Record<string, string> = {};
let resourceId: string | undefined;
const getRun = async (response: Response) => ((await response.json()) as { run: PublicRun }).run;
async function post(path: string, user: string, body: unknown) {
  return fetch(origin + path, { method: "POST", headers: { origin, cookie: cookies[user], "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function status(user: string, id: string) {
  const response = await fetch(`${origin}/api/runtime?id=${encodeURIComponent(id)}`, { headers: { cookie: cookies[user] } });
  assert.equal(response.status, 200); return getRun(response);
}
async function wait(user: string, id: string, expected: string) {
  for (let attempt = 0; attempt < 50; attempt++) { const run = await status(user, id); if (run.status === expected) return run; if (["failed", "cancelled", "expired"].includes(run.status)) throw new Error(`${run.status}: ${run.error}`); await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out waiting for ${expected}`);
}
async function start(workflow: Workflow) {
  const response = await post("/api/runtime", "bob", { action: "run.start", mode: "test", workflow, input: "검토 입력", idempotencyKey: crypto.randomUUID() });
  assert.equal(response.status, 202, await (response.status === 202 ? Promise.resolve("") : response.text()));
  return getRun(response);
}
try {
  for (const user of ["alice", "bob", "carol"]) {
    const response = await fetch(origin + "/api/auth/test", { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ identity: user, return_to: "/studio" }) });
    assert.equal(response.status, 303); cookies[user] = response.headers.get("set-cookie")!.split(";")[0];
  }
  const workflow = templateWorkflow("human-review");
  let run = await start(workflow); run = await wait("bob", run.id, "waiting_review");
  assert.equal((await post("/api/runtime", "carol", { action: "review.decide", id: run.id, reviewId: run.reviews![0].id, decision: "accept" })).status, 404);
  const decision = await post("/api/runtime", "bob", { action: "review.decide", id: run.id, reviewId: run.reviews![0].id, decision: "accept", editedInput: { text: "D1에 저장한 수정" } });
  assert.equal(decision.status, 202); assert.equal((await getRun(decision)).status, "queued");
  await post("/api/runtime", "bob", { action: "run.resume", id: run.id });
  assert.equal((await wait("bob", run.id, "succeeded")).result, "D1에 저장한 수정");
  console.log("PASS verified owner alone decides review; edit is durable before explicit resume");
  const nested = templateWorkflow("reusable-work"); nested.definition.nodes[1].subworkflow!.definition = workflow.definition;
  run = await start(nested); run = await wait("bob", run.id, "waiting_review");
  assert.equal(run.children!.length, 1); assert.equal(run.reviews!.length, 1);
  await post("/api/runtime", "bob", { action: "review.decide", id: run.id, reviewId: run.reviews![0].id, decision: "reject" });
  await post("/api/runtime", "bob", { action: "run.resume", id: run.id });
  assert.equal((await wait("bob", run.id, "succeeded")).result, "검토 입력");
  console.log("PASS nested review rejection takes the stored no route through D1 recovery");
  run = await start(nested); run = await wait("bob", run.id, "waiting_review");
  await post("/api/runtime", "bob", { action: "run.cancel", id: run.id });
  await wait("bob", run.id, "cancelled");
  assert.equal((await post("/api/runtime", "bob", { action: "review.decide", id: run.id, reviewId: run.reviews![0].id, decision: "accept" })).status, 400);
  assert.equal((await status("bob", run.id)).status, "cancelled");
  console.log("PASS waiting nested review is cancellable and stale decisions cannot revive it");
  const data = { name: "검토 공유 철회 검사", type: "document", description: "합성 검사", content: "검토 전용 자료", url: "", visibility: "selected", allowedEmails: ["bob@flowly.test"] };
  const created = await post("/api/studio", "alice", { action: "resource.create", data }); assert.equal(created.status, 201); const createdResource = ((await created.json()) as { resource: { id: string; updatedAt: string } }).resource; resourceId = createdResource.id;
  const protectedFlow = templateWorkflow("human-review");
  protectedFlow.definition.nodes.push({ id: "resource", type: "resource", title: "공유 자료", x: 0, y: 0, resourceId });
  protectedFlow.definition.edges = [{ id: "ir", source: "input", target: "resource" }, { id: "rv", source: "resource", target: "review" }, ...protectedFlow.definition.edges.filter(e => e.source === "review")];
  run = await start(protectedFlow); run = await wait("bob", run.id, "waiting_review");
  await post("/api/studio", "alice", { action: "resource.update", id: resourceId, baseUpdatedAt: createdResource.updatedAt, data: { ...data, visibility: "private", allowedEmails: [] } });
  const denied = await post("/api/runtime", "bob", { action: "review.decide", id: run.id, reviewId: run.reviews![0].id, decision: "accept" });
  assert.equal(denied.status, 202); assert.equal((await getRun(denied)).status, "failed");
  console.log("PASS review decision rechecks current sharing and stops after revocation");
  console.log("PASS 4 local HTTP/D1 advanced scenarios. External API calls: 0.");
} finally {
  if (resourceId) await post("/api/studio", "alice", { action: "resource.delete", id: resourceId });
}
