import test from "node:test";
import assert from "node:assert/strict";
import { createRun, decideApproval, decideReview, executeRun, publicRun } from "../runtime/engine";
import { compileDefinition } from "../domain/workflow";
import type { Definition, FlowNode, Resource, Workflow } from "../app/lib/model";
import type { Json, OrchestrationConfig, RuntimeDependencies, RuntimeRun, ToolDefinition } from "../runtime/types";

const owner = { userId: "contracts", email: "contracts@example.test", displayName: "계약 검증" };
const n = (id: string, type: FlowNode["type"], extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title: id, x: 0, y: 0, ...extra });
const graph = (nodes: FlowNode[]): Definition => ({ schemaVersion: 5, nodes, edges: nodes.slice(1).map((node, i) => ({ id: `e${i}`, source: nodes[i].id, target: node.id })) });
const child = (template: string, dependencies = false) => graph([n("input", "input"), n("copy", "transform", { transform: { mode: "template", template }, ...(dependencies ? { inputBindings: { artifacts: { nodeId: "input", path: "artifacts" } } } : {}) }), n("output", "output")]);
const first = { id: "first", name: "첫 작업", definition: child("검증한 {{text}}") };
const second = { id: "second", name: "의존 작업", definition: child("연결: {{artifacts.first.text}}", true), dependsOn: ["first"] };
const completed = [{ path: "artifacts.first.text", operator: "contains" as const, value: "검증한" }];
function create(config: OrchestrationConfig, resources: Resource[] = []) {
  const workflow: Workflow = { id: "contracts", name: "작업 계약", description: "", updatedAt: "2026-10-24", definition: graph([n("input", "input"), n("plan", "orchestrator", { prompt: "PLAN", orchestration: config }), n("output", "output")]) };
  return createRun({ owner, workflow, resources, mode: "test", input: "요청", limits: { maxTurns: 20 } });
}
function harness(replies: Json[]) {
  let count = 0; const snapshots: RuntimeRun[] = [];
  const deps: RuntimeDependencies = { model: { next: async () => ({ kind: "answer", text: JSON.stringify(replies[count++]), usageTokens: 1 }) }, tools: [], callTool: async () => { throw Error("unexpected tool"); }, assertAccess: async () => {}, isCancelled: async () => false, save: async run => { snapshots.push(structuredClone(run)); } };
  return { deps, snapshots, calls: () => count };
}

test("registered task dependency and completion use actual saved outputs", async () => {
  const run = create({ tasks: [first, second], maxTasks: 2, completion: [{ path: "artifacts.second.text", operator: "contains", value: "연결: 검증한 요청" }] });
  const h = harness([{ tasks: ["first", "second"] }]); await executeRun(run, h.deps);
  assert.equal(run.status, "succeeded", run.error);
  const group = run.checkpoint.groups!.plan;
  assert.deepEqual(group.children[1].initialInput?.artifacts, { first: { text: "검증한 요청" } });
  assert.ok(group.contracts!.every(item => item.status === "succeeded" && /^[0-9a-f]{64}$/.test(item.inputHash)));
  assert.equal(group.completionChecks![0].passed, true);
  await executeRun(run, h.deps); assert.equal(h.calls(), 1);
});

test("missing prerequisite plan and cyclic definitions fail before child execution", async () => {
  for (const plan of [["second"], ["second", "first"]]) {
    const run = create({ tasks: [first, second], maxTasks: 2 }); const h = harness([{ tasks: plan }]);
    await executeRun(run, h.deps); assert.equal(run.status, "failed"); assert.equal(Object.keys(run.checkpoint.groups!).length, 0);
  }
  assert.throws(() => create({ tasks: [{ ...first, dependsOn: ["second"] }, second], maxTasks: 2 }), /순환|의존/);
  assert.throws(() => create({ tasks: [{ ...first, dependsOn: ["missing"] }], maxTasks: 1 }), /선행|등록/);
});

test("premature model completion continues only within the declared rounds", async () => {
  const run = create({ tasks: [first], maxTasks: 1, mode: "adaptive", completion: completed, maxRounds: 3 });
  const h = harness([{ done: true, tasks: [] }, { done: false, tasks: ["first"] }, { done: true, tasks: [] }]);
  await executeRun(run, h.deps); assert.equal(run.status, "succeeded", run.error); assert.equal(h.calls(), 3);
  assert.deepEqual(run.events.filter(e => e.type === "completion_checked").map(e => (e.data as { checks: { passed: boolean }[] }).checks[0].passed), [false, true]);
  const exhausted = create({ tasks: [first], maxTasks: 1, mode: "adaptive", completion: completed, maxRounds: 2 });
  const bad = harness([{ done: true, tasks: [] }, { done: true, tasks: [] }]); await executeRun(exhausted, bad.deps);
  assert.equal(exhausted.status, "budget_exceeded"); assert.equal(bad.calls(), 2);
});

test("saved task input and definition contracts reject resume tampering", async () => {
  const wait = { ...first, definition: graph([n("input", "input"), n("more", "form", { form: { mode: "request", fields: [{ key: "note", label: "보완", type: "text", required: true }] } }), n("output", "output")]) };
  const run = create({ tasks: [wait], maxTasks: 1, completion: completed }); const h = harness([{ tasks: ["first"] }]);
  await executeRun(run, h.deps); assert.equal(run.status, "waiting_input");
  for (const mutate of [(r: RuntimeRun) => { r.checkpoint.groups!.plan.children[0].initialInput!.text = "changed"; }, (r: RuntimeRun) => { r.checkpoint.groups!.plan.contracts = []; }]) {
    const clone = structuredClone(run); mutate(clone); await executeRun(clone, h.deps); assert.equal(clone.status, "failed");
  }
  assert.equal(h.calls(), 1);
});

test("same completed write task reuses proof and never dispatches a second external write", async () => {
  const tool: ToolDefinition = { name: "save", toolName: "save", resourceId: "mcp", connectionId: "conn", description: "save", effect: "write", inputSchema: { type: "object" } };
  const writeTask = { id: "write", name: "변경", definition: graph([n("input", "input"), n("save", "tool", { allowedTools: [{ resourceId: "mcp", connectionId: "conn", toolName: "save" }], tool: { arguments: { note: "one" }, bindings: {} } }), n("output", "output")]) };
  const run = create({ tasks: [writeTask], maxTasks: 1, mode: "adaptive", maxRounds: 3, completion: [{ path: "artifacts.write.text", operator: "contains", value: "saved" }] }, [{ id: "mcp", type: "mcp", name: "사내 연결", description: "", content: "", url: "", ownerId: owner.userId, visibility: "private", allowedEmails: [], createdAt: "now", updatedAt: "now" }]);
  let writes = 0;
  const h = harness([{ done: false, tasks: ["write"] }, { done: false, tasks: ["write"] }, { done: true, tasks: [] }]);
  h.deps.tools = [tool]; h.deps.callTool = async () => { writes++; return { saved: true }; };
  await executeRun(run, h.deps); assert.equal(run.status, "waiting_approval", run.error);
  await decideApproval(run, publicRun(run).approvals[0].id, owner.userId, "approved"); await executeRun(run, h.deps);
  assert.equal(run.status, "succeeded", run.error); assert.equal(writes, 1);
  const group = run.checkpoint.groups!.plan;
  assert.ok(group.children[1].events.some(event => event.type === "task_reused")); assert.equal(group.children[1].checkpoint.toolCalls, 0);
  assert.equal(run.checkpoint.toolCalls, 1);
  assert.ok(compileDefinition(run.workflow.definition));
});

test("accepted human review remains valid when explicit resume is later than its submission deadline", async () => {
  const definition = graph([n("input", "input"), n("review", "review", { review: { instructions: "확인", allowEdit: false, timeoutMinutes: 1 } }), n("output", "output")]);
  definition.edges[1].branch = "yes";
  definition.edges.push({ id: "no", source: "review", target: "output", branch: "no" });
  const workflow: Workflow = { id: "review-deadline", name: "검토 기한", description: "", updatedAt: "2026-10-24", definition };
  const run = createRun({ owner, workflow, resources: [], mode: "test", input: "검토 내용" }); const h = harness([]);
  await executeRun(run, h.deps); assert.equal(run.status, "waiting_review");
  await decideReview(run, run.reviews![0].id, owner.userId, "accepted");
  run.reviews![0].expiresAt = "2000-01-01T00:00:00Z";
  await executeRun(run, h.deps); assert.equal(run.status, "succeeded", run.error); assert.equal(run.result, "검토 내용");
});
