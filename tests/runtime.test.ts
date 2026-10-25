import test from "node:test";
import assert from "node:assert/strict";
import { createRun, decideApproval, executeRun, publicRun } from "../runtime/engine";
import { argsHash } from "../runtime/policy";
import { createTestToolCaller, TestModelAdapter, createMcpToolCaller } from "../runtime/adapters";
import { sampleResources, type FlowNode, type Workflow } from "../app/lib/model";
import type { Json, ModelAdapter, ModelReply, RuntimeDependencies, RuntimeRun, ToolDefinition } from "../runtime/types";

const owner = { userId: "owner", email: "owner@example.com", displayName: "소유자" };
const read: ToolDefinition = { resourceId: "sample-search", connectionId: "test-read", toolName: "lookup", name: "lookup", description: "조회", effect: "read", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } };
const write: ToolDefinition = { ...read, connectionId: "test-write", name: "draft_note", toolName: "draft_note", effect: "write" };
function workflow(tool: ToolDefinition | undefined = read, patch: Partial<FlowNode> = {}): Workflow {
  return { id: "flow", name: "테스트", description: "", updatedAt: "2026-10-21", definition: { nodes: [
    { id: "input", type: "input", title: "입력", x: 0, y: 0 },
    { id: "agent", type: "agent", title: "AI 작업", prompt: "도구 결과를 알려 주세요.", allowedTools: tool ? [tool] : [], x: 0, y: 100, ...patch },
    { id: "output", type: "output", title: "출력", x: 0, y: 200 },
  ], edges: [{ id: "e1", source: "input", target: "agent" }, { id: "e2", source: "agent", target: "output" }] } };
}
function create(tool: ToolDefinition | undefined = read, patch: Partial<FlowNode> = {}, input = "새로운 입력") {
  return createRun({ owner, mode: "test", workflow: workflow(tool, patch), resources: sampleResources, input });
}
function harness(options: Partial<RuntimeDependencies> = {}) {
  const saved: RuntimeRun[] = []; const calls: { tool: ToolDefinition; args: Record<string, Json> }[] = []; let revoked = false; let cancelled = false;
  const deps: RuntimeDependencies = { model: new TestModelAdapter(), tools: [read, write], save: async run => { saved.push(structuredClone(run)); }, assertAccess: async () => { if (revoked) throw new Error("secret provider error"); }, isCancelled: async () => cancelled, callTool: createTestToolCaller(call => calls.push(call)), ...options };
  return { deps, saved, calls, revoke: () => { revoked = true; }, cancel: () => { cancelled = true; } };
}
const toolReply = (toolName: string, query = "작업"): ModelReply => ({ kind: "tool", toolName, args: { query }, callId: "provider-id", usageTokens: 10 });
const answer = (text = "완료"): ModelReply => ({ kind: "answer", text, usageTokens: 10 });
function scripted(replies: ModelReply[]): ModelAdapter { let i = 0; return { next: async () => replies[Math.min(i++, replies.length - 1)] }; }

test("real data flows from input through tool observation into final answer; checkpoint before call", async () => {
  const h = harness(); const run = create();
  h.deps.callTool = async (tool, args, options) => { assert.equal(h.saved.at(-1)?.checkpoint.calls.at(-1)?.status, "dispatching"); return createTestToolCaller(call => h.calls.push(call))(tool, args, options); };
  await executeRun(run, h.deps);
  assert.equal(run.status, "succeeded"); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].args.query, "새로운 입력"); assert.match(run.result, /새로운 입력/); assert.match(run.result, /실제 AI 답변 아님/);
  assert.deepEqual(run.checkpoint.completed, ["input", "agent", "output"]);
  assert.ok(h.saved.length >= 7); assert.equal(publicRun(run).approvals.length, 0);
});
test("model receives actual tool observation on subsequent turn", async () => {
  let turn = 0; const h = harness({ model: { next: async ({ messages }) => { turn++; if (turn === 1) return toolReply("lookup"); assert.match(messages.at(-1)!.content, /UNIQUE_RESULT_318/); return answer("관찰 완료"); } }, callTool: async () => ({ text: "UNIQUE_RESULT_318" }) });
  const run = create(); await executeRun(run, h.deps); assert.equal(run.status, "succeeded"); assert.equal(turn, 2);
});
test("unselected tools and tools in legacy ai nodes never execute", async () => {
  const h = harness({ model: scripted([toolReply("forbidden"), answer()]) }); const run = create(); await executeRun(run, h.deps);
  assert.equal(run.status, "succeeded"); assert.equal(h.calls.length, 0); assert.ok(run.events.some(e => e.type === "tool_rejected"));
  const legacy = create(undefined, { type: "ai", allowedTools: [] }); const legacyHarness = harness({ model: scripted([toolReply("lookup"), answer()]) }); await executeRun(legacy, legacyHarness.deps);
  assert.equal(legacy.status, "failed"); assert.equal(legacyHarness.calls.length, 0); assert.equal(legacy.checkpoint.turns, 1);
});
test("turn and tool budgets stop endless agents without extra external calls", async () => {
  for (const [limits, expected] of [[{ maxTurns: 2 }, 2], [{ maxToolCalls: 1 }, 1]] as const) {
    const h = harness({ model: scripted([toolReply("lookup")]) }); const run = create(read, { limits }); await executeRun(run, h.deps);
    assert.equal(run.status, "budget_exceeded"); assert.equal(h.calls.length, expected);
  }
});
test("token budget prevents model calls before dispatch and stops overruns before tools", async () => {
  let turns = 0; const h = harness({ model: { next: async () => { turns++; return { ...toolReply("lookup"), usageTokens: 32001 }; } } });
  const low = create(read, { limits: { maxTokens: 10 } }); await executeRun(low, h.deps); assert.equal(low.status, "budget_exceeded"); assert.equal(turns, 0);
  const overrun = create(); await executeRun(overrun, h.deps); assert.equal(overrun.status, "budget_exceeded"); assert.equal(h.calls.length, 0); assert.equal(turns, 1);
});
test("time budget aborts a blocked model", async () => {
  let aborted = false; const h = harness({ model: { next: async ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true })) } });
  const run = create(read, { limits: { maxDurationMs: 100 } }); await executeRun(run, h.deps);
  assert.equal(run.status, "budget_exceeded"); assert.equal(aborted, true); assert.equal(h.calls.length, 0);
});
test("write pauses durably, binds approval to user and canonical arguments, then runs once", async () => {
  const h = harness(); const run = create(write); await executeRun(run, h.deps);
  assert.equal(run.status, "waiting_approval"); assert.equal(h.calls.length, 0); assert.equal(h.saved.at(-1)!.status, "waiting_approval");
  const approval = run.approvals[0];
  await assert.rejects(decideApproval(run, approval.id, "other-user", "approved"), /권한/);
  assert.equal(approval.status, "pending");
  await decideApproval(run, approval.id, owner.userId, "approved"); await decideApproval(run, approval.id, owner.userId, "approved");
  await executeRun(run, h.deps); await executeRun(run, h.deps);
  assert.equal(run.status, "succeeded"); assert.equal(h.calls.length, 1);
  assert.equal(await argsHash({ b: 1, a: 2 }), await argsHash({ a: 2, b: 1 }));
});
test("changed arguments cannot reuse approval", async () => {
  const h = harness(); const run = create(write); await executeRun(run, h.deps);
  run.checkpoint.calls[0].args.query = "바뀐 입력";
  await assert.rejects(decideApproval(run, run.approvals[0].id, owner.userId, "approved"), /인자/);
  assert.equal(h.calls.length, 0);
});
test("denial is observed and repeated identical write stays blocked", async () => {
  const h = harness({ model: scripted([toolReply("draft_note"), toolReply("draft_note"), answer("거절됨")]) }); const run = create(write); await executeRun(run, h.deps);
  await decideApproval(run, run.approvals[0].id, owner.userId, "denied"); await executeRun(run, h.deps);
  assert.equal(run.status, "succeeded"); assert.equal(h.calls.length, 0); assert.equal(run.approvals.length, 1); assert.ok(run.events.some(e => e.type === "tool_duplicate_blocked"));
});
test("expired approvals and revoked sharing cannot dispatch writes", async () => {
  const h = harness(); const run = create(write); await executeRun(run, h.deps); run.approvals[0].expiresAt = "2020-01-01T00:00:00.000Z";
  await decideApproval(run, run.approvals[0].id, owner.userId, "approved"); await executeRun(run, h.deps); assert.equal(run.status, "expired"); assert.equal(h.calls.length, 0);
  const revoked = create(write); const h2 = harness(); await executeRun(revoked, h2.deps); await decideApproval(revoked, revoked.approvals[0].id, owner.userId, "approved"); h2.revoke(); await executeRun(revoked, h2.deps);
  assert.equal(revoked.status, "failed"); assert.equal(h2.calls.length, 0); assert.doesNotMatch(JSON.stringify(publicRun(revoked)), /secret provider/);
});

test("approval expiration during MCP initialization prevents the subsequent external write", async () => {
  const h = harness(); const run = create(write); await executeRun(run, h.deps);
  await decideApproval(run, run.approvals[0].id, owner.userId, "approved");
  run.approvals[0].expiresAt = new Date(Date.now() + 80).toISOString();
  const methods: string[] = [];
  const request = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); methods.push(body.method);
    if (body.method === "initialize") {
      // Deliberately ignore AbortSignal to verify the adapter rechecks the deadline before any follow-up request.
      await new Promise(resolve => setTimeout(resolve, 160));
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } } });
    }
    throw new Error("A write must never be dispatched after approval expires");
  }) as typeof fetch;
  h.deps.callTool = createMcpToolCaller([{ id: "test-write", endpoint: "https://tools.example.com/mcp" }], request);
  await executeRun(run, h.deps); await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(run.status, "unknown_outcome"); assert.deepEqual(methods, ["initialize"]);
  await executeRun(run, h.deps); assert.deepEqual(methods, ["initialize"]);
});
test("serialized waiting checkpoints resume on a new worker", async () => {
  const h = harness(); await executeRun(create(write), h.deps); const restored = structuredClone(h.saved.at(-1)!);
  await decideApproval(restored, restored.approvals[0].id, owner.userId, "approved"); const h2 = harness(); await executeRun(restored, h2.deps);
  assert.equal(restored.status, "succeeded"); assert.equal(h2.calls.length, 1); assert.equal(restored.checkpoint.turns, 2);
});
test("dispatching writes recover as unknown outcome; never replay", async () => {
  const h = harness(); const run = create(write); await executeRun(run, h.deps); await decideApproval(run, run.approvals[0].id, owner.userId, "approved");
  run.checkpoint.calls[0].status = "dispatching"; run.checkpoint.calls[0].attempts = 1;
  await executeRun(run, h.deps); assert.equal(run.status, "unknown_outcome"); assert.equal(h.calls.length, 0);
});
test("lost write response is unknown and not retried even when idempotency is advertised", async () => {
  let calls = 0; const h = harness({ callTool: async () => { calls++; throw new Error("token=secret"); } }); const run = create(write);
  await executeRun(run, h.deps); await decideApproval(run, run.approvals[0].id, owner.userId, "approved"); await executeRun(run, h.deps); await executeRun(run, h.deps);
  assert.equal(run.status, "unknown_outcome"); assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(publicRun(run)), /token=secret/);
});
test("completed write is not repeated when crash occurs before next model answer", async () => {
  const h = harness(); const run = create(write); await executeRun(run, h.deps); await decideApproval(run, run.approvals[0].id, owner.userId, "approved"); await executeRun(run, h.deps);
  const savedAfterTool = h.saved.find(r => r.status === "running" && r.checkpoint.calls[0]?.status === "completed" && !r.checkpoint.completed.includes("agent"))!;
  assert.ok(savedAfterTool); const h2 = harness(); await executeRun(structuredClone(savedAfterTool), h2.deps); assert.equal(h2.calls.length, 0);
});
test("lease loss stops execution before a planned side effect", async () => {
  const h = harness({ save: async run => { if (run.checkpoint.calls.some(c => c.status === "dispatching")) throw new Error("lease lost"); } }); const run = create();
  await assert.rejects(executeRun(run, h.deps), /lease lost/); assert.equal(h.calls.length, 0);
});
test("read retries are bounded, consume call budget, and preserve observations", async () => {
  let calls = 0; const h = harness({ callTool: async () => { calls++; if (calls === 1) throw new Error("transient"); return { text: "성공" }; } }); const run = create(); await executeRun(run, h.deps);
  assert.equal(run.status, "succeeded"); assert.equal(calls, 2); assert.equal(run.checkpoint.toolCalls, 2); assert.match(run.result, /성공/);
});
test("cancel before start or while waiting prevents further tool calls", async () => {
  const h = harness(); const run = create(write); await executeRun(run, h.deps); h.cancel(); await executeRun(run, h.deps);
  assert.equal(run.status, "cancelled"); assert.equal(h.calls.length, 0);
  const h2 = harness(); h2.cancel(); const initial = create(); await executeRun(initial, h2.deps); assert.equal(initial.status, "cancelled"); assert.equal(initial.checkpoint.turns, 0);
});
test("tool input and node output schemas fail before downstream effects", async () => {
  const h = harness({ model: scripted([{ kind: "tool", toolName: "lookup", args: { query: 42 }, usageTokens: 1, callId: "x" }]) }); const run = create(); await executeRun(run, h.deps); assert.equal(run.status, "failed"); assert.equal(h.calls.length, 0);
  const h2 = harness({ model: scripted([answer("문자열")]) }); const output = create(undefined, { outputSchema: { type: "object", properties: { text: { type: "number" } }, required: ["text"] } }); await executeRun(output, h2.deps);
  assert.equal(output.status, "failed"); assert.ok(!output.checkpoint.completed.includes("output"));
});
test("JSON answers preserve typed data for explicit downstream bindings", async () => {
  const h = harness({ model: scripted([answer('{"count":3,"ok":true}')]) }); const run = create(undefined, { format: "JSON" });
  await executeRun(run, h.deps); assert.equal(run.status, "succeeded"); assert.deepEqual(run.checkpoint.outputs.agent.data, { count: 3, ok: true });
});
test("condition evaluates mapped previous output, not initial input", async () => {
  const definition = workflow(undefined).definition;
  definition.nodes.push({ id: "condition", type: "condition", title: "판단", condition: "ACCEPT", x: 0, y: 150 }, { id: "no", type: "output", title: "아니요", x: 100, y: 200 });
  definition.edges = [{ id: "e1", source: "input", target: "agent" }, { id: "e2", source: "agent", target: "condition" }, { id: "e3", source: "condition", target: "output", branch: "yes" }, { id: "e4", source: "condition", target: "no", branch: "no" }];
  const run = createRun({ owner, mode: "test", workflow: { ...workflow(undefined), definition }, resources: sampleResources, input: "REJECT" });
  const h = harness({ model: scripted([answer("ACCEPT")]) }); await executeRun(run, h.deps);
  assert.equal(run.status, "succeeded"); assert.ok(run.checkpoint.completed.includes("output")); assert.ok(run.checkpoint.skipped.includes("no")); assert.equal(run.result, "ACCEPT");
});
test("snapshot remains pinned when source workflow or resources change", async () => {
  const source = workflow(); const resources = structuredClone(sampleResources); const run = createRun({ owner, mode: "test", workflow: source, resources, input: "입력" });
  source.definition.nodes[1].prompt = "changed"; resources[2].content = "changed";
  assert.notEqual(run.workflow.definition.nodes[1].prompt, "changed"); assert.notEqual(run.resources[0].content, "changed");
});
test("node limits inherit global limits and cannot raise them", async () => {
  const h = harness(); const run = create(read, { limits: { maxTokens: 32000, maxTurns: 20 } }); await executeRun(run, h.deps);
  assert.equal(run.status, "succeeded"); assert.equal(run.checkpoint.turns, 2);
  const limited = createRun({ owner, mode: "test", workflow: workflow(read, { limits: { maxTurns: 20 } }), resources: sampleResources, input: "입력", limits: { maxTurns: 1 } });
  await executeRun(limited, harness().deps); assert.equal(limited.status, "budget_exceeded"); assert.equal(limited.checkpoint.turns, 1);
});
test("restart charges unrecorded active time but unresolved write remains unknown outcome", async () => {
  const h = harness(); const run = create(); run.status = "running"; run.updatedAt = "2020-01-01T00:00:00.000Z"; await executeRun(run, h.deps);
  assert.equal(run.status, "budget_exceeded"); assert.equal(h.calls.length, 0);
  const writeRun = create(write); await executeRun(writeRun, h.deps); await decideApproval(writeRun, writeRun.approvals[0].id, owner.userId, "approved");
  writeRun.status = "running"; writeRun.updatedAt = "2020-01-01T00:00:00.000Z"; writeRun.checkpoint.calls[0].status = "dispatching";
  await executeRun(writeRun, h.deps); assert.equal(writeRun.status, "unknown_outcome"); assert.equal(h.calls.length, 0);
});
