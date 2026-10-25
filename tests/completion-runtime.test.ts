import test from "node:test";
import assert from "node:assert/strict";
import { createRun, decideApproval, decideReview, executeRun } from "../runtime/engine";
import { sampleResources } from "../app/lib/model";
import type { Definition, FlowNode } from "../app/lib/model";
import type { RuntimeDependencies, ToolDefinition } from "../runtime/types";

const node = (id: string, type: FlowNode["type"], extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title: id, x: 0, y: 0, ...extra });
const chain = (nodes: FlowNode[]): Definition => ({ schemaVersion: 5, nodes, edges: nodes.slice(1).map((target, i) => ({ id: `e${i}`, source: nodes[i].id, target: target.id })) });
const create = (definition: Definition) => createRun({ owner: { userId: "local", email: "local@example.test", displayName: "Local" }, mode: "test", workflow: { id: "completion-test", name: "계약 검사", description: "", updatedAt: "2026-10-25", definition }, resources: [], input: "request" });
const deps = (extra: Partial<RuntimeDependencies> = {}): RuntimeDependencies => ({ model: { next: async () => { throw Error("unexpected model"); } }, tools: [], callTool: async () => { throw Error("unexpected tool"); }, save: async () => {}, assertAccess: async () => {}, isCancelled: async () => false, ...extra });
const task = (id: string) => ({ id, name: id, definition: chain([node("input", "input"), node(id, "agent", { prompt: id, format: "JSON", allowedTools: [] }), node("output", "output", { inputBindings: { text: { nodeId: id, path: "text" }, data: { nodeId: id, path: "data" } } })]) });

test("first matching parallel result cancels active peer and repeated resume preserves the winner", async () => {
  let cancelled = false, calls = 0;
  const run = create(chain([node("input", "input"), node("race", "parallel", { parallel: { concurrency: 2, tasks: [task("slow"), task("fast")], completion: { mode: "first_match", checks: [{ path: "data.sufficient", operator: "eq", value: true }] } } }), node("output", "output")]));
  const d = deps({ model: { next: async ({ messages, signal }) => {
    calls++;
    const slow = messages[0].content.includes('"instruction":"slow"');
    if (slow) await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 2000); signal.addEventListener("abort", () => { cancelled = true; clearTimeout(timer); reject(Error("cancelled")); }, { once: true }); });
    else await new Promise(resolve => setTimeout(resolve, 30));
    return { kind: "answer", text: JSON.stringify({ sufficient: true, source: slow ? "slow" : "fast" }), usageTokens: 2 };
  } } });
  await executeRun(run, d);
  assert.equal(run.status, "succeeded", run.error); assert.equal(cancelled, true);
  const output = run.checkpoint.outputs.race;
  assert.deepEqual(output.cancelledTasks, ["slow"]); assert.equal((output.winner as { taskId: string }).taskId, "fast");
  assert.equal(run.checkpoint.groups!.race.children[0].status, "cancelled");
  await executeRun(run, d); assert.equal(calls, 2);
});

test("no matching result is explicit and cannot claim a winner", async () => {
  const run = create(chain([node("input", "input"), node("race", "parallel", { parallel: { concurrency: 2, tasks: [task("a"), task("b")], completion: { mode: "first_match", checks: [{ path: "data.sufficient", operator: "eq", value: true }] } } }), node("output", "output")]));
  await executeRun(run, deps({ model: { next: async () => ({ kind: "answer", text: '{"sufficient":false}', usageTokens: 2 }) } }));
  assert.equal(run.status, "succeeded", run.error); assert.equal(run.checkpoint.outputs.race.matched, false); assert.equal(run.checkpoint.outputs.race.winner, null);
});

test("budget program receives actual consumed counters and rejects caller-forged budget", async () => {
  const graph = (forged: boolean) => chain([node("input", "input"), node("agent", "agent", { prompt: "one", allowedTools: [] }), node("budget", "program", { program: { name: "completion", arguments: { operation: "research.budget_plan", arguments: forged ? { runtimeBudget: {} } : { tasks: [] } }, bindings: {} } }), node("output", "output")]);
  let dispatched = 0;
  const d = deps({ model: { next: async () => ({ kind: "answer", text: "ready", usageTokens: 17 }) }, completion: async request => { dispatched++; const budget = request.arguments.runtimeBudget as Record<string, number>; assert.equal(budget.usedTurns, 1); assert.equal(budget.usedTokens, 17); assert.equal(budget.maxTurns, 8); return { passed: true }; } });
  const run = create(graph(false)); await executeRun(run, d); assert.equal(run.status, "succeeded", run.error);
  const forged = create(graph(true)); await executeRun(forged, d); assert.equal(forged.status, "failed"); assert.match(forged.error!, /runtimeBudget/); assert.equal(dispatched, 1);
});

test("task leases use the runtime clock instead of a caller supplied timestamp", async () => {
  const start = Date.now() / 1000;
  const run = create(chain([node("input", "input"), node("lease", "program", { program: { name: "completion", arguments: { operation: "technical.taskboard_transition", arguments: { now: 1, action: "claim" } }, bindings: {} } }), node("output", "output")]));
  let observed = 0;
  await executeRun(run, deps({ completion: async request => { observed = request.arguments.now as number; return { passed: true }; } }));
  assert.equal(run.status, "succeeded", run.error);
  assert.ok(observed >= start && observed <= Date.now() / 1000);
});

test("first-match invalidates unused approvals but an interrupted dispatched write remains unknown", async () => {
  const tool: ToolDefinition = { resourceId: "sample-search", connectionId: "reference", toolName: "write", name: "write", description: "write", effect: "write", inputSchema: { type: "object", properties: {}, additionalProperties: false } };
  for (const dispatched of [false, true]) {
    const writer = { id: "write", name: "write", definition: chain([node("input", "input"), node("write", "tool", { allowedTools: [tool], tool: { arguments: {}, bindings: {} } }), node("output", "output")]) };
    const winner = { id: "goal", name: "goal", definition: chain([node("input", "input"), ...(dispatched ? [node("review", "review", { review: { instructions: "목표 확인", allowEdit: false, timeoutMinutes: 30 } })] : []), node("winner", "agent", { prompt: "goal", format: "JSON", allowedTools: [] }), node("output", "output", { inputBindings: { data: { nodeId: "winner", path: "data" }, text: { nodeId: "winner", path: "text" } } })]) };
    if (dispatched) { winner.definition.edges.find(edge => edge.source === "review")!.branch = "yes"; winner.definition.nodes.push(node("rejected", "output")); winner.definition.edges.push({ id: "rejected", source: "review", target: "rejected", branch: "no" }); }
    const definition = chain([node("input", "input"), node("group", "parallel", { parallel: { concurrency: 2, tasks: [writer, winner], completion: { mode: "first_match", checks: [{ path: "data.complete", operator: "eq", value: true }] } } }), node("output", "output")]);
    const run = createRun({ owner: { userId: "local", email: "local@example.test", displayName: "Local" }, mode: "test", workflow: { id: "write-race", name: "승인 취소", description: "", updatedAt: "2026-10-25", definition }, resources: sampleResources, input: "request" });
    let calls = 0;
    const d = deps({ tools: [tool], model: { next: async () => { await new Promise(resolve => setTimeout(resolve, 35)); return { kind: "answer", text: '{"complete":true}', usageTokens: 1 }; } }, callTool: async (_tool, _args, { signal }) => { calls++; return new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(Error("interrupted")), { once: true }); }); } });
    await executeRun(run, d);
    if (!dispatched) {
      assert.equal(run.status, "succeeded", run.error); const child = run.checkpoint.groups!.group.children[0];
      assert.equal(child.status, "cancelled"); assert.equal(child.approvals[0].status, "denied"); assert.equal(calls, 0);
      await assert.rejects(decideApproval(run, child.approvals[0].id, "local", "approved"));
    } else {
      assert.equal(run.status, "waiting_approval"); const [write, goal] = run.checkpoint.groups!.group.children;
      await decideApproval(run, write.approvals[0].id, "local", "approved"); await decideReview(run, goal.reviews![0].id, "local", "accepted");
      await executeRun(run, d); assert.equal(run.status, "unknown_outcome", run.error); assert.equal(calls, 1);
      await executeRun(run, d); assert.equal(calls, 1);
    }
  }
});
