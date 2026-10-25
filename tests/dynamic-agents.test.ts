import test from "node:test";
import assert from "node:assert/strict";
import { createRun, decideApproval, executeRun, publicRun, submitInput } from "../runtime/engine";
import { parseDynamicPlan } from "../runtime/dynamic-agents";
import { parseDefinition, type Definition, type FlowNode, type Resource, type Workflow } from "../app/lib/model";
import { expandedNodeCount } from "../domain/advanced-config";
import type { DynamicAgentSpec, Json, OrchestrationConfig, RuntimeDependencies, RuntimeRun, ToolDefinition } from "../runtime/types";

const owner = { userId: "dynamic", email: "dynamic@example.test", displayName: "생성 검증" };
const n = (id: string, type: FlowNode["type"], extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title: id, x: 0, y: 0, ...extra });
const graph = (nodes: FlowNode[]): Definition => ({ schemaVersion: 5, nodes, edges: nodes.slice(1).map((node, i) => ({ id: `e${i}`, source: nodes[i].id, target: node.id })) });
const worker = (wait = false) => graph([n("input", "input"), n("worker", "agent", { prompt: "DYNAMIC_WORKER", format: "JSON", allowedTools: [], inputBindings: { assignment: { nodeId: "input", path: "assignment" }, artifacts: { nodeId: "input", path: "artifacts" } } }), ...(wait ? [n("more", "form", { form: { mode: "request", fields: [{ key: "note", label: "보완", type: "text", required: true }] } })] : []), n("output", "output")]);
const schema = { type: "object" as const, properties: { topic: { type: "string" as const } }, required: ["topic"], additionalProperties: false };
export const dynamicConfig = (wait = false): OrchestrationConfig => ({ mode: "dynamic", maxTasks: 1, tasks: [{ id: "analysis", name: "허용된 분석 기능", definition: worker(wait) }], dynamic: { maxAgents: 4, concurrency: 2, templates: [{ taskId: "analysis", agentNodeId: "worker", inputSchema: schema }] }, completion: [{ path: "summary.completedCount", operator: "gte", value: 1 }] });
const assignment = (id: string, dependsOn: string[] = []): DynamicAgentSpec => ({ id, templateId: "analysis", role: `${id} 역할`, goal: `${id} 관점 분석`, input: { topic: id }, dependsOn });
function create(config = dynamicConfig(), resources: Resource[] = []) {
  const workflow: Workflow = { id: "dynamic-contracts", name: "생성된 역할 실행", description: "", updatedAt: "2026-10-24", definition: graph([n("input", "input"), n("plan", "orchestrator", { prompt: "DYNAMIC_PLAN", orchestration: config }), n("output", "output")]) };
  return createRun({ owner, workflow, resources, mode: "test", input: "기술 검토", limits: { maxTurns: 20 } });
}
function harness(agents: DynamicAgentSpec[]) {
  let calls = 0, active = 0, concurrency = 0; const snapshots: RuntimeRun[] = [], workerInputs: Json[] = [];
  const deps: RuntimeDependencies = { tools: [], assertAccess: async () => {}, isCancelled: async () => false, callTool: async () => { throw Error("unexpected tool"); }, save: async run => { snapshots.push(structuredClone(run)); }, model: { next: async ({ messages }) => {
    calls++; const content = messages.map(message => message.content).join("\n");
    if (content.includes("DYNAMIC_PLAN")) return { kind: "answer", text: JSON.stringify({ agents }), usageTokens: 1 };
    active++; concurrency = Math.max(concurrency, active); workerInputs.push(content); await new Promise(resolve => setTimeout(resolve, 10)); active--;
    return { kind: "answer", text: '{"passed":true,"report":"분석 완료"}', usageTokens: 1 };
  } } };
  return { deps, snapshots, workerInputs, calls: () => calls, concurrency: () => concurrency };
}

test("dynamic planner creates distinct roles from one capability, schedules parallel prerequisites, and persists before dispatch", async () => {
  const run = create(), h = harness([assignment("judge", ["a", "b"]), assignment("a"), assignment("b")]);
  await executeRun(run, h.deps); assert.equal(run.status, "succeeded", run.error);
  const group = run.checkpoint.groups!.plan;
  assert.deepEqual(group.taskIds, ["a", "b", "judge"]); assert.equal(h.concurrency(), 2); assert.equal(h.calls(), 4);
  assert.equal(new Set(group.children.map(child => child.id)).size, 3);
  assert.deepEqual(Object.keys(group.children[2].initialInput!.artifacts as object), ["a", "b"]);
  assert.ok(h.workerInputs.every(input => String(input).includes("assignment")));
  assert.ok(h.snapshots.some(saved => saved.checkpoint.groups?.plan?.dynamicPlan && saved.checkpoint.groups.plan.children.length === 0));
  assert.ok(group.contracts!.every(contract => contract.status === "succeeded")); assert.equal(group.completionChecks![0].passed, true);
  await executeRun(run, h.deps); assert.equal(h.calls(), 4);
});

test("dynamic plans reject unknown capability, authority injection, invalid typed input, duplicate IDs, cycles and excessive count", () => {
  const config = dynamicConfig(), a = assignment("a");
  for (const agents of [[{ ...a, templateId: "unregistered" }], [{ ...a, allowedTools: ["shell"] }], [{ ...a, input: { topic: 42 } }], [a, a], [assignment("a", ["b"]), assignment("b", ["a"])], [assignment("a", ["missing"])], Array.from({ length: 5 }, (_, i) => assignment(`agent${i}`))]) assert.throws(() => parseDynamicPlan({ agents }, config));
  assert.throws(() => parseDynamicPlan({ agents: [a], policy: "skip approval" }, config));
  assert.throws(() => create({ ...config, completion: undefined }));
});

test("dynamic wait keeps generated plan and child identity across submit/resume without replanning", async () => {
  const run = create(dynamicConfig(true)), h = harness([assignment("specialist")]); await executeRun(run, h.deps);
  assert.equal(run.status, "waiting_input", run.error); const childId = run.checkpoint.groups!.plan.children[0].id;
  const request = publicRun(run).inputRequests![0]; await submitInput(run, request.id, owner.userId, { note: "승인된 보완" });
  assert.equal(h.calls(), 2); await executeRun(run, h.deps); assert.equal(run.status, "succeeded", run.error);
  assert.equal(run.checkpoint.groups!.plan.children[0].id, childId); assert.equal(h.calls(), 2);
});

test("dynamic resume rejects changed plan, capability and child contracts", async () => {
  const run = create(dynamicConfig(true)), h = harness([assignment("specialist")]); await executeRun(run, h.deps);
  for (const mutate of [(r: RuntimeRun) => { r.checkpoint.groups!.plan.dynamicPlan!.agents[0].goal = "different"; }, (r: RuntimeRun) => { r.checkpoint.groups!.plan.children[0].workflow.definition.nodes[1].allowedTools = [{ resourceId: "hidden", connectionId: "hidden", toolName: "shell" }]; }, (r: RuntimeRun) => { r.checkpoint.groups!.plan.contracts = []; }]) {
    const altered = structuredClone(run); mutate(altered); await executeRun(altered, h.deps); assert.equal(altered.status, "failed");
  }
  assert.equal(h.calls(), 2);
});

test("dynamic completion cannot be bypassed by a model's success claim and shared budgets stop extra work", async () => {
  const config = dynamicConfig(); config.completion = [{ path: "artifacts.specialist.data.passed", operator: "eq", value: false }];
  const run = create(config), h = harness([assignment("specialist")]); await executeRun(run, h.deps); assert.equal(run.status, "failed");
  const limited = create(), limitHarness = harness([assignment("a"), assignment("b")]); limited.limits.maxTurns = 2;
  await executeRun(limited, limitHarness.deps); assert.equal(limited.status, "budget_exceeded"); assert.equal(limitHarness.calls(), 1);
});

test("generated Agents retain registered write approvals and never duplicate an applied operation after resume", async () => {
  const tool: ToolDefinition = { name: "update_record", toolName: "update_record", resourceId: "mcp", connectionId: "conn", effect: "write", description: "승인된 자료 변경", inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"], additionalProperties: false } };
  const resource: Resource = { id: "mcp", type: "mcp", name: "등록된 사내 변경", content: "", description: "", url: "", ownerId: owner.userId, visibility: "private", allowedEmails: [], createdAt: "now", updatedAt: "now" };
  for (const decision of ["approved", "denied"] as const) {
    const config = dynamicConfig(); config.tasks[0].definition.nodes[1].allowedTools = [{ resourceId: "mcp", connectionId: "conn", toolName: "update_record" }];
    const run = create(config, [resource]), h = harness([assignment("writer")]); let models = 0, writes = 0;
    h.deps.tools = [tool]; h.deps.callTool = async () => { writes++; return { applied: true }; };
    h.deps.model.next = async () => (++models === 1 ? { kind: "answer", text: JSON.stringify({ agents: [assignment("writer")] }), usageTokens: 1 } : models === 2 ? { kind: "tool", toolName: "update_record", callId: "write", args: { note: "한 번만" }, usageTokens: 1 } : { kind: "answer", text: '{"passed":true}', usageTokens: 1 });
    await executeRun(run, h.deps); assert.equal(run.status, "waiting_approval", run.error); assert.equal(writes, 0);
    const childId = run.checkpoint.groups!.plan.children[0].id;
    await decideApproval(run, publicRun(run).approvals[0].id, owner.userId, decision); await executeRun(run, h.deps);
    assert.equal(run.status, "succeeded", run.error); assert.equal(writes, decision === "approved" ? 1 : 0); assert.equal(models, 3);
    assert.equal(run.checkpoint.groups!.plan.children[0].id, childId); await executeRun(run, h.deps); assert.equal(writes, decision === "approved" ? 1 : 0);
  }
});

test("generated prompt overflow is rejected instead of silently truncating the task goal", async () => {
  const config = dynamicConfig(); config.tasks[0].definition.nodes[1].prompt = "x".repeat(12000);
  const run = create(config), h = harness([assignment("a")]); await executeRun(run, h.deps);
  assert.equal(run.status, "failed"); assert.match(run.error!, /12,000/); assert.equal(h.calls(), 1);
});

test("global dynamic expansion limit includes sibling orchestrators, loops and adaptive parent rounds", () => {
  const config = dynamicConfig(); config.dynamic!.maxAgents = 8;
  config.tasks[0].definition = graph([n("input", "input"), n("worker", "agent", { prompt: "분석" }), ...Array.from({ length: 5 }, (_, i) => n(`copy${i}`, "transform", { transform: { mode: "template", template: "{{text}}" } })), n("output", "output")]);
  const dynamic = (id: string) => n(id, "orchestrator", { prompt: "계획", orchestration: structuredClone(config) });
  const child = graph([n("input", "input"), dynamic("dynamic"), n("output", "output")]);
  assert.equal(expandedNodeCount(child), 67); assert.doesNotThrow(() => parseDefinition(child));
  const siblings = graph([n("input", "input"), dynamic("one"), dynamic("two"), n("output", "output")]);
  assert.equal(expandedNodeCount(siblings), 132); assert.throws(() => parseDefinition(siblings), /120/);
  const loop = graph([n("input", "input"), n("loop", "loop", { loop: { definition: child, itemsPath: "items", maxItems: 2, concurrency: 2 } }), n("output", "output")]);
  assert.equal(expandedNodeCount(loop), 137); assert.throws(() => parseDefinition(loop), /120/);
  const adaptive = graph([n("input", "input"), n("adaptive", "orchestrator", { prompt: "계획", orchestration: { mode: "adaptive", maxRounds: 2, maxTasks: 1, tasks: [{ id: "child", name: "하위", definition: child }] } }), n("output", "output")]);
  assert.equal(expandedNodeCount(adaptive), 137); assert.throws(() => parseDefinition(adaptive), /120/);
  const legacy = graph([n("input", "input"), n("loop", "loop", { loop: { definition: config.tasks[0].definition, itemsPath: "items", maxItems: 20, concurrency: 2 } }), n("output", "output")]);
  assert.equal(expandedNodeCount(legacy), 163); assert.doesNotThrow(() => parseDefinition(legacy));
});
