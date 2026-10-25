import test from "node:test";
import assert from "node:assert/strict";
import { sampleResources, templateWorkflow, type FlowNode, type Resource, type Workflow } from "../app/lib/model";
import { compileDefinition, referencedResourceIds, resolveNodeInput } from "../domain/workflow";
import { inspectWorkflow } from "../domain/preflight";
import { createRun, decideApproval, executeRun } from "../runtime/engine";
import { mergeData, retrieveDocuments, transformData } from "../runtime/data-nodes";
import type { Json, RuntimeDependencies, RuntimeRun, ToolDefinition } from "../runtime/types";
import { buildExportManifest } from "../server/export-package";

const owner = { userId: "tester", email: "tester@example.com", displayName: "검증" };
const node = (type: FlowNode["type"], extra: Partial<FlowNode> = {}): FlowNode => ({ id: "step", type, title: "작업", x: 0, y: 150, ...extra });
function flow(step: FlowNode): Workflow {
  return { id: "flow", name: "검증", description: "", updatedAt: "2026-10-22", definition: { schemaVersion: 3, nodes: [node("input", { id: "input" }), step, node("output", { id: "output" })], edges: [{ id: "a", source: "input", target: "step" }, { id: "b", source: "step", target: "output" }] } };
}
const tool: ToolDefinition = { resourceId: "sample-openai-docs", connectionId: "docs", toolName: "fetch", name: "fetch", effect: "read", description: "synthetic read", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } };
function harness(definition = tool) {
  const calls: Record<string, Json>[] = [], saved: RuntimeRun[] = [];
  const deps: RuntimeDependencies = { model: { next: async () => { throw new Error("unexpected model call"); } }, tools: [definition], save: async run => { saved.push(structuredClone(run)); }, assertAccess: async () => {}, isCancelled: async () => false, callTool: async (_t, args) => { assert.equal(saved.at(-1)!.checkpoint.calls.at(-1)!.status, "dispatching"); calls.push(args); return { value: args.query }; } };
  return { deps, calls, saved };
}
function direct(definition = tool) { return flow(node("tool", { allowedTools: [definition], tool: { arguments: {}, bindings: { query: "text" } } })); }
function run(workflow: Workflow, input = "전달된 값") { return createRun({ owner, mode: "live", workflow, resources: sampleResources, input }); }

test("data-processing template executes real transforms and merge with zero model/tool calls", async () => {
  const h = harness(), execution = run(templateWorkflow("data-processing"), '{"name":"민수","task":"회의록 정리"}');
  await executeRun(execution, h.deps);
  assert.equal(execution.status, "succeeded", execution.error);
  assert.equal(execution.result, "담당자: 민수\n할 일: 회의록 정리");
  assert.equal(execution.checkpoint.turns, 0); assert.equal(h.calls.length, 0);
});
test("transforms preserve JSON types, resolve array fields and reject missing/dangerous fields", () => {
  assert.deepEqual(transformData(node("transform", { transform: { mode: "pick", fields: { active: "data.0.active" } } }), { data: [{ active: false }] }), { text: '{"active":false}', data: { active: false } });
  assert.throws(() => transformData(node("transform", { transform: { mode: "template", template: "{{missing}}" } }), { text: "x" }), /찾지/);
  assert.throws(() => transformData(node("transform", { transform: { mode: "parse_json" } }), { text: '{"__proto__":{"polluted":true}}' }), /허용/);
  assert.throws(() => compileDefinition(flow(node("transform", { transform: { mode: "pick", fields: { x: "data.constructor" } } })).definition), /필드|경로/);
  assert.throws(() => compileDefinition(flow(node("transform", { transform: { mode: "template", template: "x".repeat(12001) } })).definition), /12,000/);
});
test("merge preserves deterministic key order, types, single-level flatten and canonical deduplication", () => {
  const merged = mergeData(node("merge", { merge: { mode: "array", deduplicate: true } }), { z: [false, { b: 2, a: 1 }], a: [{ a: 1, b: 2 }, 0] });
  assert.deepEqual(merged.data, [{ a: 1, b: 2 }, 0, false]);
  const d = compileDefinition(flow(node("merge", { inputBindings: { context_1: { nodeId: "input", path: "text" } } })).definition);
  assert.deepEqual(resolveNodeInput(d, d.nodes[1], { input: { text: "single" } }, []), { context_1: "single" });
});
test("retrieval ranks Korean evidence with source/version and reports no-match honestly", async () => {
  const search = templateWorkflow("rag").definition.nodes[1];
  const found = retrieveDocuments(search, { text: "휴가 신청 절차" }, sampleResources);
  assert.ok(Number(found.count) > 0); assert.match(String(found.text), /휴가 신청|출처: sample-handbook/);
  const first = (found.matches as Record<string, Json>[])[0]; assert.equal(first.resourceId, "sample-handbook"); assert.equal(first.version, sampleResources[0].updatedAt);
  const absent = retrieveDocuments(search, { text: "zzzz-no-such-evidence" }, sampleResources);
  assert.equal(absent.count, 0); assert.match(String(absent.text), /검색된 근거가 없어요/);
  assert.throws(() => retrieveDocuments(search, { text: "휴가" }, []), /접근/);
  const h = harness(); let received = "";
  h.deps.model.next = async ({ messages }) => { received = messages[0].content; return { kind: "answer", text: "synthetic fixture answer", usageTokens: 10 }; };
  const execution = run(templateWorkflow("rag"), "휴가 신청"); await executeRun(execution, h.deps);
  assert.equal(execution.status, "succeeded", execution.error); assert.match(received, /출처: sample-handbook/);
});
test("direct MCP maps actual upstream values and resumes completed read without replay", async () => {
  const h = harness(), execution = run(direct()); await executeRun(execution, h.deps);
  assert.equal(execution.status, "succeeded"); assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0], { query: "전달된 값" });
  assert.equal(execution.checkpoint.turns, 0); assert.equal(execution.result, '{"value":"전달된 값"}');
  const restored = h.saved.findLast(r => r.checkpoint.calls[0]?.status === "completed" && !r.checkpoint.completed.includes("step"))!;
  await executeRun(restored, h.deps); assert.equal(h.calls.length, 1); assert.equal(restored.status, "succeeded");
});
test("direct writes require exact approval; deny/revocation and uncertain result never become success", async () => {
  const write = { ...tool, effect: "write" as const };
  for (const decision of ["approved", "denied"] as const) {
    const h = harness(write), execution = run(direct(write)); await executeRun(execution, h.deps);
    assert.equal(execution.status, "waiting_approval"); assert.equal(h.calls.length, 0);
    await decideApproval(execution, execution.approvals[0].id, owner.userId, decision);
    await executeRun(execution, h.deps); await executeRun(execution, h.deps);
    assert.equal(h.calls.length, decision === "approved" ? 1 : 0); assert.equal(execution.status, decision === "approved" ? "succeeded" : "failed");
  }
  const h = harness(write), uncertain = run(direct(write)); await executeRun(uncertain, h.deps);
  await decideApproval(uncertain, uncertain.approvals[0].id, owner.userId, "approved");
  h.deps.callTool = async () => { h.calls.push({}); throw new Error("connection lost"); };
  await executeRun(uncertain, h.deps); await executeRun(uncertain, h.deps);
  assert.equal(uncertain.status, "unknown_outcome"); assert.equal(h.calls.length, 1);
});
test("direct read exhausted retries fail and limits block further attempts", async () => {
  const h = harness(); let count = 0; h.deps.callTool = async () => { count++; throw new Error("read down"); };
  const failed = run(direct()); await executeRun(failed, h.deps); assert.equal(failed.status, "failed"); assert.equal(count, 2);
  const budget = run(direct()); budget.limits.maxToolCalls = 1; count = 0; await executeRun(budget, h.deps);
  assert.equal(budget.status, "budget_exceeded"); assert.equal(count, 1);
});
test("retrieval references participate in export sharing checks, revocation and type validation", async () => {
  const workflow = templateWorkflow("rag");
  assert.deepEqual(referencedResourceIds(compileDefinition(workflow.definition)), ["sample-handbook"]);
  const document: Resource = { ...sampleResources[0], ownerId: "other", visibility: "selected", sample: false, allowedEmails: [owner.email] };
  const args = { user: owner, workflow, connections: [], resolveResources: async () => [document] };
  assert.equal((await buildExportManifest(args)).resources.length, 1);
  await assert.rejects(buildExportManifest({ ...args, resolveResources: async () => [{ ...document, allowedEmails: [] }] }), /권한|철회/);
  await assert.rejects(buildExportManifest({ ...args, resolveResources: async () => [{ ...document, type: "skill" }] }), /문서|프롬프트/);
});
test("preflight flags actual missing tool arguments and does not claim remote verification", () => {
  const workflow = direct(); workflow.definition.nodes[1].tool = { arguments: {}, bindings: {} };
  const capabilities = { testEnabled: false, liveEnabled: false, liveReason: "export only", connections: [{ id: tool.connectionId, resourceId: tool.resourceId, name: "Docs", status: "configured" as const, tools: [tool] }] };
  const check = inspectWorkflow(workflow, sampleResources, capabilities);
  assert.equal(check.canExport, false); assert.equal(check.requiresModel, false); assert.ok(check.issues.some(i => i.nodeId === "step" && i.message.includes("query")));
  assert.equal(inspectWorkflow(templateWorkflow("data-processing"), sampleResources, capabilities).canExport, true);
  workflow.definition.nodes[1].inputBindings = { text: { nodeId: "input", path: "" } };
  assert.ok(inspectWorkflow(workflow, sampleResources, capabilities).issues.some(i => i.nodeId === "step" && i.message.includes("입력 연결")));
});
test("branch joins exclude inputs from inactive edges even when their source completed", async () => {
  const workflow = flow(node("condition", { condition: "yes" }));
  workflow.definition.nodes.splice(2, 0, node("merge", { id: "merge", merge: { mode: "text", separator: "|" }, inputBindings: { first: { nodeId: "input", path: "text" }, second: { nodeId: "step", path: "text" } } }));
  workflow.definition.nodes.push(node("output", { id: "no" }));
  workflow.definition.edges = [{ id: "a", source: "input", target: "step" }, { id: "b", source: "input", target: "merge" }, { id: "c", source: "step", target: "merge", branch: "yes" }, { id: "d", source: "step", target: "no", branch: "no" }, { id: "e", source: "merge", target: "output" }];
  const h = harness(), execution = run(workflow, "no"); await executeRun(execution, h.deps);
  assert.equal(execution.status, "succeeded", execution.error); assert.equal(execution.checkpoint.branches.step, false);
  assert.equal(execution.checkpoint.outputs.merge.text, "no"); assert.deepEqual(execution.checkpoint.outputs.merge.data, ["no"]);
  assert.deepEqual(resolveNodeInput(execution.workflow.definition, execution.workflow.definition.nodes.find(n => n.id === "merge")!, execution.checkpoint.outputs, [], execution.checkpoint.branches), { first: "no" });
});
