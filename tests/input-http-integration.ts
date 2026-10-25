/** Run against the built local test-auth/D1 server. No external model or MCP requests. */
import assert from "node:assert/strict";
import type { Definition, FlowNode, Resource, Workflow } from "../app/lib/model";
import type { Json, PublicRun } from "../runtime/types";

const origin = "http://127.0.0.1:5173", cookies: Record<string, string> = {};
const createdResources: string[] = [];
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
const node = (id: string, type: FlowNode["type"], settings: Partial<FlowNode> = {}): FlowNode => ({ id, type, title: id, x: 0, y: 0, ...settings });
const chain = (nodes: FlowNode[]): Definition => ({ schemaVersion: 5, nodes, edges: nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: nodes[i].id, target: n.id })) });
function inputDefinition(resourceId?: string): Definition {
  return chain([
    node("input", "input"),
    ...(resourceId ? [node("resource", "resource", { resourceId })] : []),
    node("before", "transform", { transform: { mode: "template", template: "저장한 앞 단계: {{text}}" } }),
    node("supplement", "form", { form: { mode: "request", instructions: "주문번호, 수량과 확인 여부를 입력하세요.", timeoutMinutes: 10, fields: [
      { key: "orderId", label: "주문번호", type: "text", required: true },
      { key: "quantity", label: "수량", type: "number", required: true },
      { key: "confirmed", label: "확인", type: "boolean", required: true },
    ] } }),
    node("answer", "transform", { inputBindings: { supplied: { nodeId: "supplement", path: "data" } }, transform: { mode: "template", template: "주문 {{supplied.orderId}} / 수량 {{supplied.quantity}} / 확인 {{supplied.confirmed}}" } }),
    node("output", "output"),
  ]);
}
function nestedDefinition(resourceId?: string): Definition {
  const peer = chain([node("input", "input"), node("peer_done", "transform", { transform: { mode: "template", template: "이미 완료한 병렬 근거" } }), node("output", "output")]);
  const nested = chain([node("input", "input"), node("nested", "subworkflow", { subworkflow: { definition: inputDefinition(resourceId) } }), node("output", "output")]);
  return chain([node("input", "input"), node("group", "parallel", { parallel: { concurrency: 2, tasks: [
    { id: "peer", name: "완료된 동료", definition: peer }, { id: "question", name: "중첩 보완 입력", definition: nested },
  ] } }), node("output", "output")]);
}
const workflow = (definition: Definition): Workflow => ({ id: `input-http-${crypto.randomUUID()}`, name: "입력 대기 HTTP/D1 검사", description: "합성 검사", definition, updatedAt: new Date().toISOString() });
async function post(user: string, body: unknown, path = "/api/runtime") {
  return fetch(origin + path, { method: "POST", headers: { origin, cookie: cookies[user], "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function readRun(response: Response, expectedStatus = 200): Promise<PublicRun> {
  assert.equal(response.status, expectedStatus, await response.clone().text());
  const payload = await response.json() as { run: PublicRun };
  assert.ok(payload.run); return payload.run;
}
async function status(id: string): Promise<PublicRun> {
  return readRun(await fetch(`${origin}/api/runtime?id=${encodeURIComponent(id)}`, { headers: { cookie: cookies.bob } }));
}
async function wait(id: string, expected: PublicRun["status"]): Promise<PublicRun> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const run = await status(id);
    if (run.status === expected) return run;
    assert.ok(!["failed", "cancelled", "expired", "budget_exceeded", "unknown_outcome"].includes(run.status), `${run.status}: ${run.error}`);
    await pause();
  }
  throw new Error(`Timed out waiting for ${expected}`);
}
async function start(definition: Definition): Promise<PublicRun> {
  const run = await readRun(await post("bob", { action: "run.start", mode: "test", workflow: workflow(definition), input: "보완 요청", idempotencyKey: crypto.randomUUID() }), 202);
  return wait(run.id, "waiting_input");
}
async function submit(run: PublicRun, values: Record<string, Json>, user = "bob"): Promise<Response> {
  // A wait state is saved just before the worker releases its lease.
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await post(user, { action: "input.submit", id: run.id, requestId: run.inputRequests![0].id, values });
    if (response.status !== 400 || !/다른 작업을 처리하고/.test(await response.clone().text())) return response;
    if (["failed", "cancelled", "expired", "succeeded", "budget_exceeded", "unknown_outcome"].includes((await status(run.id)).status)) return response;
    await pause();
  }
  throw new Error("Input submission lease did not become available");
}
const values = { orderId: "A-42", quantity: 0, confirmed: false };
const completed = (run: PublicRun, nodeId: string) => run.events.filter(event => event.type === "node_completed" && event.nodeId === nodeId).length;
function noProviderCalls(run: PublicRun) {
  assert.equal(run.usage.turns, 0); assert.equal(run.usage.toolCalls, 0); assert.equal(run.usage.tokens, 0);
  for (const child of run.children ?? []) noProviderCalls(child.run);
}
function waitingLeaf(run: PublicRun): PublicRun {
  return run.children!.find(child => child.taskId === "question")!.run.children![0].run;
}

try {
  for (const user of ["alice", "bob", "carol"]) {
    const response = await fetch(origin + "/api/auth/test", { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ identity: user, return_to: "/studio" }) });
    assert.equal(response.status, 303); cookies[user] = response.headers.get("set-cookie")!.split(";")[0];
    // Populate the local verified-user directory before resource operations.
    assert.equal((await fetch(origin + "/api/studio", { headers: { cookie: cookies[user] } })).status, 200);
  }

  let run = await start(inputDefinition());
  assert.equal(run.inputRequests!.length, 1); assert.equal(run.inputRequests![0].fields.length, 3);
  for (const user of ["alice", "carol"]) {
    assert.equal((await fetch(`${origin}/api/runtime?id=${run.id}`, { headers: { cookie: cookies[user] } })).status, 404);
    assert.equal((await submit(run, values, user)).status, 404);
    assert.equal((await post(user, { action: "input.submit", id: run.id, requestId: run.inputRequests![0].id, values, ownerId: "test:bob", userId: "test:bob" })).status, 404);
  }
  assert.equal((await status(run.id)).inputRequests![0].status, "pending");
  console.log("PASS 1: three verified users; only the run owner can read or submit, body identity cannot override authentication");

  for (const invalid of [{}, { ...values, orderId: "   " }, { ...values, quantity: "0" }, { ...values, confirmed: "false" }, { ...values, unexpected: "injected" }]) {
    assert.equal((await submit(run, invalid)).status, 400);
    const unchanged = await status(run.id);
    assert.equal(unchanged.status, "waiting_input"); assert.equal(unchanged.inputRequests![0].status, "pending");
    assert.equal(completed(unchanged, "answer"), 0); noProviderCalls(unchanged);
  }
  console.log("PASS 2: missing, blank, mistyped and unknown fields are rejected without advancing the run");

  const queued = await readRun(await submit(run, values), 202);
  assert.equal(queued.status, "queued"); assert.equal(queued.inputRequests![0].status, "submitted");
  assert.deepEqual(queued.inputRequests![0].output!.data, values);
  assert.equal(completed(queued, "answer"), 0); assert.equal(completed(queued, "before"), 1);
  const duplicate = await readRun(await submit(run, values), 202);
  assert.deepEqual(duplicate.events, queued.events);
  assert.equal((await submit(run, { ...values, orderId: "different" })).status, 400);
  await pause(); const stored = await status(run.id);
  assert.equal(stored.status, "queued"); assert.equal(completed(stored, "answer"), 0);
  assert.deepEqual(stored.events, queued.events); noProviderCalls(stored);
  await readRun(await post("bob", { action: "run.resume", id: run.id }), 202);
  const finished = await wait(run.id, "succeeded");
  assert.equal(finished.id, run.id); assert.equal(finished.result, "주문 A-42 / 수량 0 / 확인 false");
  assert.equal(completed(finished, "before"), 1); assert.equal(completed(finished, "answer"), 1); noProviderCalls(finished);
  console.log("PASS 3: typed values are durable, identical submissions are idempotent, changed resubmissions fail and only explicit resume executes");

  run = await start(nestedDefinition());
  const peer = structuredClone(run.children!.find(child => child.taskId === "peer")!.run);
  assert.equal(peer.status, "succeeded"); assert.equal(completed(peer, "peer_done"), 1);
  const leafId = waitingLeaf(run).id; assert.equal(completed(waitingLeaf(run), "before"), 1);
  const nestedQueued = await readRun(await submit(run, values), 202);
  assert.equal(nestedQueued.status, "queued"); assert.equal(waitingLeaf(nestedQueued).status, "queued");
  assert.equal(completed(waitingLeaf(nestedQueued), "answer"), 0);
  assert.deepEqual(nestedQueued.children!.find(child => child.taskId === "peer")!.run, peer);
  await readRun(await post("bob", { action: "run.resume", id: run.id }), 202);
  const nestedDone = await wait(run.id, "succeeded");
  assert.equal(waitingLeaf(nestedDone).id, leafId); assert.equal(completed(waitingLeaf(nestedDone), "before"), 1);
  assert.equal(completed(waitingLeaf(nestedDone), "answer"), 1);
  assert.deepEqual(nestedDone.children!.find(child => child.taskId === "peer")!.run, peer);
  assert.match(nestedDone.result, /A-42/); noProviderCalls(nestedDone);
  console.log("PASS 4: deeply nested submission resumes the same child and preserves the completed parallel peer");

  run = await start(nestedDefinition());
  await readRun(await post("bob", { action: "run.cancel", id: run.id }), 202);
  await wait(run.id, "cancelled");
  assert.equal((await submit(run, values)).status, 400);
  const cancelled = await status(run.id);
  assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.inputRequests![0].status, "pending");
  assert.equal(completed(waitingLeaf(cancelled), "answer"), 0); noProviderCalls(cancelled);
  console.log("PASS 5: cancelling a nested input wait prevents stale submissions from reviving it");

  const resourceData = { name: `보완 입력 공유 검사 ${crypto.randomUUID()}`, type: "document", description: "합성 자료", content: "보완 입력 전에 읽는 사내 자료", url: "", visibility: "selected", allowedEmails: ["bob@flowly.test"] };
  const createdResponse = await post("alice", { action: "resource.create", data: resourceData }, "/api/studio");
  assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
  const resource = ((await createdResponse.json()) as { resource: Resource }).resource;
  createdResources.push(resource.id);
  assert.equal((await post("carol", { action: "run.start", mode: "test", workflow: workflow(nestedDefinition(resource.id)), input: "권한 없음", idempotencyKey: crypto.randomUUID() })).status, 400);
  run = await start(nestedDefinition(resource.id));
  assert.equal((await post("bob", { action: "resource.delete", id: resource.id }, "/api/studio")).status, 404);
  const revoked = await post("alice", { action: "resource.update", id: resource.id, baseUpdatedAt: resource.updatedAt, data: { ...resourceData, visibility: "private", allowedEmails: [] } }, "/api/studio");
  assert.equal(revoked.status, 200, await revoked.clone().text());
  const rejected = await readRun(await submit(run, values), 202);
  assert.equal(rejected.status, "failed"); assert.match(rejected.error!, /공유|권한/);
  assert.equal(rejected.inputRequests![0].status, "pending"); assert.equal(completed(waitingLeaf(rejected), "answer"), 0);
  assert.equal((await status(run.id)).status, "failed"); noProviderCalls(rejected);
  console.log("PASS 6: submission rechecks a deeply nested shared resource and durably stops after owner revocation");
  console.log("PASS 6 local HTTP/D1 supplementary-input scenarios. External API calls: 0.");
} finally {
  for (const id of createdResources) {
    const response = await post("alice", { action: "resource.delete", id }, "/api/studio");
    assert.equal(response.status, 200, await response.clone().text());
  }
}
