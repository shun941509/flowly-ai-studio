import test from "node:test";
import assert from "node:assert/strict";
import { compileDefinition } from "../domain/workflow";
import { createRun, executeRun, publicRun, submitInput } from "../runtime/engine";
import { renderRunReport } from "../export-runtime/diagnostics";
import type { Definition, FlowNode } from "../app/lib/model";
import type { Json, RuntimeDependencies, RuntimeRun } from "../runtime/types";

const owner = { userId: "input-owner", email: "owner@example.test", displayName: "입력 사용자" };
const node = (id: string, type: FlowNode["type"], config: Partial<FlowNode> = {}): FlowNode => ({ id, type, title: id, x: 0, y: 0, ...config });
const chain = (nodes: FlowNode[]): Definition => ({ schemaVersion: 5, nodes, edges: nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: nodes[i].id, target: n.id })) });
const form = () => node("supplement", "form", { form: { mode: "request", instructions: "주문번호를 입력하세요.", timeoutMinutes: 1, fields: [{ key: "orderId", label: "주문번호", type: "text", required: true }] } });
const definition = () => chain([node("input", "input"), node("before", "transform", { transform: { mode: "template", template: "앞 단계 {{text}}" } }), form(), node("answer", "transform", { transform: { mode: "template", template: "조회 대상 {{data.orderId}}" }, inputBindings: { data: { nodeId: "supplement", path: "data" } } }), node("output", "output")]);
const create = (def = definition()) => createRun({ owner, mode: "test", workflow: { id: "input-flow", name: "보완 입력", description: "", updatedAt: "2026-10-24", definition: def }, resources: [], input: "배송 확인" });
function harness() {
  const saves: RuntimeRun[] = [];
  const deps: RuntimeDependencies = { model: { next: async () => { throw new Error("unexpected model"); } }, tools: [], callTool: async () => { throw new Error("unexpected tool"); }, save: async r => { saves.push(structuredClone(r)); }, assertAccess: async () => {}, isCancelled: async () => false };
  return { saves, deps };
}

test("supplementary input survives reload, validates data, resumes same run and preserves completed nodes", async () => {
  const h = harness(), run = create(); await executeRun(run, h.deps);
  assert.equal(run.status, "waiting_input"); assert.deepEqual(run.checkpoint.completed, ["input", "before"]);
  const request = publicRun(run).inputRequests![0]; assert.equal(request.fields[0].key, "orderId");
  assert.equal(request.input.text, "앞 단계 배송 확인");
  for (const values of [{}, { orderId: "   " }, { orderId: 5 }, { orderId: "X", injected: "bad" }] as Record<string, Json>[]) {
    await assert.rejects(submitInput(run, request.id, owner.userId, values)); assert.equal(run.status, "waiting_input");
  }
  await assert.rejects(submitInput(run, request.id, "other-user", { orderId: "A-42" }), /권한/);
  const recovered = JSON.parse(JSON.stringify(h.saves.at(-1))) as RuntimeRun;
  await submitInput(recovered, request.id, owner.userId, { orderId: "A-42" });
  assert.equal(recovered.status, "queued"); assert.deepEqual(recovered.checkpoint.completed, ["input", "before"]);
  await submitInput(recovered, request.id, owner.userId, { orderId: "A-42" });
  await assert.rejects(submitInput(recovered, request.id, owner.userId, { orderId: "changed" }), /이미 제출/);
  recovered.inputRequests![0].expiresAt = "2000-01-01T00:00:00.000Z"; // Deadline is for submission, not work after it.
  await executeRun(recovered, h.deps);
  assert.equal(recovered.id, run.id); assert.equal(recovered.status, "succeeded", recovered.error); assert.equal(recovered.result, "조회 대상 A-42");
  assert.equal(recovered.events.filter(e => e.type === "node_completed" && e.nodeId === "before").length, 1);
  assert.equal(recovered.checkpoint.turns, 0); assert.equal(recovered.checkpoint.toolCalls, 0);
  assert.match(renderRunReport(recovered), /보완 입력/);
});

test("request is bound to predecessor input and form configuration; expiration and read-only restores cannot progress", async () => {
  for (const change of ["input", "config", "expiry", "restore", "terminal"] as const) {
    const run = create(), h = harness(); await executeRun(run, h.deps); const request = run.inputRequests![0];
    if (change === "input") run.checkpoint.outputs.before.text = "changed";
    if (change === "config") run.workflow.definition.nodes.find(n => n.id === "supplement")!.form!.fields[0].required = false;
    if (change === "expiry") request.expiresAt = "2000-01-01T00:00:00Z";
    if (change === "restore") run.restoredReadOnly = true;
    if (change === "terminal") run.status = "cancelled";
    if (change === "expiry") { await submitInput(run, request.id, owner.userId, { orderId: "A-42" }); assert.equal(run.status, "expired"); }
    else await assert.rejects(submitInput(run, request.id, owner.userId, { orderId: "A-42" }));
    assert.equal(request.status, "pending"); assert.ok(!run.checkpoint.completed.includes("supplement"));
  }
});

test("nested parallel input resumes only the waiting child and retains completed peer", async () => {
  const peer = chain([node("input", "input"), node("done", "transform", { transform: { mode: "template", template: "완료한 근거" } }), node("output", "output")]);
  const grouped = chain([node("input", "input"), node("group", "parallel", { parallel: { concurrency: 2, tasks: [{ id: "peer", name: "근거", definition: peer }, { id: "question", name: "질문", definition: definition() }] } }), node("output", "output")]);
  const run = create(grouped), h = harness(); await executeRun(run, h.deps);
  assert.equal(run.status, "waiting_input", run.error);
  const completed = structuredClone(run.checkpoint.groups!.group.children[0]);
  await submitInput(run, publicRun(run).inputRequests![0].id, owner.userId, { orderId: "A-42" });
  await executeRun(run, h.deps); assert.equal(run.status, "succeeded", run.error);
  assert.deepEqual(run.checkpoint.groups!.group.children[0], completed); assert.match(run.result, /A-42/);
});

test("legacy start forms keep their meaning and supplementary forms require a predecessor", () => {
  const initial = form(); delete initial.form!.mode;
  assert.doesNotThrow(() => compileDefinition(chain([initial, node("output", "output")])));
  assert.throws(() => compileDefinition(chain([form(), node("output", "output")])));
  const invalid = definition(); invalid.nodes.find(n => n.id === "supplement")!.form!.timeoutMinutes = 10081;
  assert.throws(() => compileDefinition(invalid));
});

test("expired nested input expires every ancestor and never revives a waiting parent", async () => {
  const wrap = (child: Definition) => chain([node("input", "input"), node("sub", "subworkflow", { subworkflow: { definition: child } }), node("output", "output")]);
  const run = create(wrap(wrap(definition()))), h = harness(); await executeRun(run, h.deps);
  const middle = run.checkpoint.groups!.sub.children[0], leaf = middle.checkpoint.groups!.sub.children[0];
  const request = leaf.inputRequests![0]; request.expiresAt = "invalid";
  await submitInput(run, request.id, owner.userId, { orderId: "A-42" });
  for (const item of [run, middle, leaf]) assert.equal(item.status, "expired");
  await executeRun(run, h.deps); assert.equal(run.status, "expired"); assert.equal(request.status, "pending");
});
