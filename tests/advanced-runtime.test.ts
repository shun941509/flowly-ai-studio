import test from "node:test";
import assert from "node:assert/strict";
import { advancedTemplate } from "../app/lib/advanced-templates";
import { sampleResources, type Definition, type FlowNode, type Workflow } from "../app/lib/model";
import { createRun, decideApproval, decideReview, executeRun, publicRun } from "../runtime/engine";
import type { Json, ModelReply, RuntimeDependencies, RuntimeRun, ToolDefinition } from "../runtime/types";

const owner = { userId: "advanced-owner", email: "advanced@example.com", displayName: "고급 노드 테스트" };
const node = (id: string, type: FlowNode["type"], config: Partial<FlowNode> = {}): FlowNode => ({ id, type, title: id, x: 0, y: 0, ...config });
const chain = (nodes: FlowNode[]): Definition => ({ schemaVersion: 4, nodes, edges: nodes.slice(1).map((target, index) => ({ id: `edge_${index}`, source: nodes[index].id, target: target.id })) });
const workflow = (definition: Definition): Workflow => ({ id: "advanced-flow", name: "고급 흐름", description: "", updatedAt: "2026-10-22", definition });
const create = (definition: Definition, input = "한국어 입력", limits = {}) => createRun({ owner, mode: "test", workflow: workflow(definition), resources: sampleResources, input, limits });
const answer = (text: string): ModelReply => ({ kind: "answer", text, usageTokens: 25 });
function harness(options: Partial<RuntimeDependencies> = {}) {
  const snapshots: RuntimeRun[] = [];
  const deps: RuntimeDependencies = { model: { next: async () => { throw new Error("unexpected model"); } }, tools: [], callTool: async () => { throw new Error("unexpected tool"); }, save: async run => { snapshots.push(structuredClone(run)); }, assertAccess: async () => {}, isCancelled: async () => false, ...options };
  return { snapshots, deps };
}
const agentTask = (prompt: string) => chain([node("input", "input"), node("agent", "agent", { prompt, allowedTools: [] }), node("output", "output")]);
const grouped = (config: Partial<FlowNode>) => chain([node("input", "input"), node("group", "parallel", config), node("output", "output")]);

test("parallel executes overlapping isolated children and persists plans before model dispatch", async () => {
  let active = 0, maximum = 0, calls = 0;
  const h = harness();
  h.deps.model.next = async ({ messages }) => {
    calls++; active++; maximum = Math.max(maximum, active);
    assert.equal(h.snapshots.at(-1)!.checkpoint.groups!.group.children.length, 2);
    const instruction = JSON.parse(messages[0].content).instruction;
    await new Promise(resolve => setTimeout(resolve, 35)); active--; return answer(instruction);
  };
  const run = create(grouped({ parallel: { concurrency: 2, tasks: [{ id: "first", name: "첫 작업", definition: agentTask("첫 답") }, { id: "second", name: "둘째 작업", definition: agentTask("둘째 답") }] } }));
  await executeRun(run, h.deps);
  assert.equal(run.status, "succeeded", run.error); assert.equal(maximum, 2); assert.equal(calls, 2);
  assert.equal(run.checkpoint.turns, 2); assert.equal(run.checkpoint.tokens, 50); assert.match(run.result, /첫 답\n둘째 답/);
  await executeRun(run, h.deps); assert.equal(calls, 2);
});

test("global and group budgets are divided before parallel dispatch and cannot be oversubscribed", async () => {
  let calls = 0; const h = harness({ model: { next: async () => { calls++; return answer("unused"); } } });
  const run = create(grouped({ limits: { maxTurns: 1 }, parallel: { concurrency: 2, tasks: [{ id: "a", name: "a", definition: agentTask("a") }, { id: "b", name: "b", definition: agentTask("b") }] } }));
  await executeRun(run, h.deps); assert.equal(run.status, "budget_exceeded"); assert.equal(calls, 0);
  assert.ok(run.checkpoint.groups!.group.children.every(child => child.limits.maxTurns === 0));
});

test("loop supports empty and twenty data-only items with zero model reservation and rejects overflow", async () => {
  for (const length of [0, 20, 21]) {
    const definition = advancedTemplate("repeat-items")!; definition.nodes.find(item => item.type === "loop")!.loop!.maxItems = 20;
    const run = create(definition, JSON.stringify(Array.from({ length }, (_, i) => `일 ${i}`))); const h = harness(); await executeRun(run, h.deps);
    assert.equal(run.status, length > 20 ? "failed" : "succeeded", run.error);
    if (length <= 20) { assert.equal(run.checkpoint.outputs.loop.count, length); assert.equal(run.checkpoint.turns, 0); assert.equal(run.checkpoint.toolCalls, 0); }
  }
});

test("sequential Agent team passes previous output and accumulated results to the next role", async () => {
  let calls = 0;
  const h = harness({ model: { next: async ({ messages }) => { calls++; const input = JSON.parse(messages[0].content).input; if (calls === 1) return answer("첫 초안"); assert.equal(input.previous.text, "첫 초안"); return answer("검토한 초안"); } } });
  const run = create(advancedTemplate("agent-team")!); await executeRun(run, h.deps);
  assert.equal(run.status, "succeeded", run.error); assert.equal(calls, 2); assert.match(run.result, /검토한 초안/);
  assert.equal(run.checkpoint.groups!.team.children[1].initialInput!.results instanceof Array, true);
});

test("orchestrator persists its bounded plan and does not re-plan after checkpoint recovery", async () => {
  let calls = 0, crash = true; const snapshots: RuntimeRun[] = [];
  const h = harness({ model: { next: async () => { calls++; return answer('{"tasks":["format"]}'); } }, save: async run => {
    if (crash && run.checkpoint.groups?.plan?.children[0].checkpoint.completed.includes("input")) { crash = false; throw new Error("synthetic interrupted save"); }
    snapshots.push(structuredClone(run));
  } });
  const run = create(advancedTemplate("orchestrated-work")!);
  await assert.rejects(executeRun(run, h.deps), /synthetic interrupted save/);
  const recovered = snapshots.at(-1)!; await executeRun(recovered, h.deps);
  assert.equal(recovered.status, "succeeded", recovered.error); assert.equal(calls, 1); assert.deepEqual(recovered.checkpoint.groups!.plan.plan, ["format"]);
  const invalid = create(advancedTemplate("orchestrated-work")!); const bad = harness({ model: { next: async () => answer('{"tasks":["format","format"]}') } });
  await executeRun(invalid, bad.deps); assert.equal(invalid.status, "failed"); assert.equal(Object.keys(invalid.checkpoint.groups!).length, 0);
});

test("nested human review survives serialization, validates ownership/hash and resumes only after a stored decision", async () => {
  const definition = grouped({ type: "subworkflow", subworkflow: { definition: advancedTemplate("human-review")! } });
  let run = create(definition); const h = harness(); await executeRun(run, h.deps);
  assert.equal(run.status, "waiting_review"); assert.equal(publicRun(run).reviews!.length, 1);
  run = JSON.parse(JSON.stringify(run)); const review = publicRun(run).reviews![0];
  await assert.rejects(decideReview(run, review.id, "other-owner", "accepted"), /권한/);
  await decideReview(run, review.id, owner.userId, "accepted", { text: "사람이 고친 내용" });
  assert.equal(run.status, "queued"); assert.equal(run.result, ""); await executeRun(run, h.deps);
  assert.equal(run.status, "succeeded", run.error); assert.equal(run.result, "사람이 고친 내용");
  assert.equal(run.checkpoint.groups!.group.children[0].checkpoint.routes!.review, "yes");
});

test("review reject uses no branch; tampering, edit policy, expiry and waiting time remain bounded", async () => {
  const h = harness(); const rejected = create(advancedTemplate("human-review")!); await executeRun(rejected, h.deps);
  await decideReview(rejected, rejected.reviews![0].id, owner.userId, "rejected"); await executeRun(rejected, h.deps);
  assert.equal(rejected.status, "succeeded"); assert.equal(rejected.checkpoint.routes!.review, "no"); assert.ok(rejected.checkpoint.skipped.includes("output"));
  const tampered = create(advancedTemplate("human-review")!); await executeRun(tampered, h.deps); tampered.reviews![0].input.text = "changed";
  await assert.rejects(decideReview(tampered, tampered.reviews![0].id, owner.userId, "accepted"), /바뀌/);
  const expired = create(advancedTemplate("human-review")!); await executeRun(expired, h.deps); expired.reviews![0].expiresAt = "2020-01-01T00:00:00Z";
  await decideReview(expired, expired.reviews![0].id, owner.userId, "accepted"); assert.equal(expired.status, "expired");
  const policy = advancedTemplate("human-review")!; policy.nodes.find(item => item.type === "review")!.review!.allowEdit = false;
  const fixed = create(policy); await executeRun(fixed, h.deps); await assert.rejects(decideReview(fixed, fixed.reviews![0].id, owner.userId, "accepted", { text: "edit" }), /수정/);
  const waited = create(advancedTemplate("human-review")!, "waiting", { maxDurationMs: 5000 }); await executeRun(waited, h.deps); waited.updatedAt = "2020-01-01T00:00:00Z"; await decideReview(waited, waited.reviews![0].id, owner.userId, "accepted"); await executeRun(waited, h.deps); assert.equal(waited.status, "succeeded");
});

test("form validates actual dates and unknown fields; classify activates exactly its registered route", async () => {
  let calls = 0; const h = harness({ model: { next: async () => { calls++; return answer('{"label":"urgent","reason":"기한 임박"}'); } } });
  const definition = advancedTemplate("classified-form")!;
  definition.nodes[0].form!.fields.push({ key: "due", label: "기한", type: "date", required: true });
  for (const input of [{ name: "민수", question: "문의", due: "2026-02-30" }, { name: "민수", question: "문의", due: "0000-01-01" }, { name: "민수", question: "문의", due: "2026-02-28", extra: "no" }]) {
    const run = create(definition, JSON.stringify(input)); await executeRun(run, h.deps); assert.equal(run.status, "failed");
  }
  assert.equal(calls, 0);
  const run = create(definition, JSON.stringify({ name: "민수", question: "오늘 마감", due: "2026-02-28" })); await executeRun(run, h.deps);
  assert.equal(run.status, "succeeded", run.error); assert.equal(calls, 1); assert.equal(run.checkpoint.routes!.classify, "urgent"); assert.ok(run.checkpoint.skipped.includes("output"));
  const bad = create(definition, JSON.stringify({ name: "민수", question: "문의", due: "2026-02-28" })); h.deps.model.next = async () => answer('{"label":"unknown","reason":"invalid"}'); await executeRun(bad, h.deps); assert.equal(bad.status, "failed");
});

function errorBranch(type: "transform" | "ai" = "transform"): Definition {
  return { schemaVersion: 4, nodes: [node("input", "input"), node("work", type, { onError: "branch", ...(type === "transform" ? { transform: { mode: "parse_json" } } : { prompt: "테스트 답변" }) }), node("success", "output"), node("error", "error", { error: { template: "대체 결과: {{error.message}}" }, inputBindings: { error: { nodeId: "work", path: "error" } } }), node("failure", "output")], edges: [{ id: "a", source: "input", target: "work" }, { id: "b", source: "work", target: "success", branch: "success" }, { id: "c", source: "work", target: "error", branch: "error" }, { id: "d", source: "error", target: "failure" }] };
}
test("recoverable processing errors follow explicit error paths; permission, budget and persistence errors cannot", async () => {
  const run = create(errorBranch(), "not json"); const h = harness(); await executeRun(run, h.deps);
  assert.equal(run.status, "succeeded", run.error); assert.equal(run.checkpoint.routes!.work, "error"); assert.match(run.result, /대체 결과/);
  const denied = create(errorBranch()); await executeRun(denied, harness({ assertAccess: async () => { throw new Error("revoked"); } }).deps); assert.equal(denied.status, "failed"); assert.equal(denied.errorRecoverable, false); assert.ok(!denied.checkpoint.completed.includes("error"));
  const limited = create(errorBranch("ai"), "input", { maxTokens: 1 }); await executeRun(limited, h.deps); assert.equal(limited.status, "budget_exceeded"); assert.ok(!limited.checkpoint.completed.includes("error"));
  const saving = create(errorBranch()); await assert.rejects(executeRun(saving, harness({ save: async () => { throw new Error("lease lost"); } }).deps), /lease lost/); assert.ok(!saving.checkpoint.completed.includes("error"));
});

test("nested write approval remains exact and an uncertain external outcome cannot follow error paths", async () => {
  const tool: ToolDefinition = { resourceId: "sample-search", connectionId: "test-write", toolName: "write", name: "write", description: "write", effect: "write", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
  const child = chain([node("input", "input"), node("write", "tool", { allowedTools: [tool], tool: { arguments: {}, bindings: { text: "text" } } }), node("output", "output")]);
  const run = create(grouped({ type: "subworkflow", subworkflow: { definition: child } })); let calls = 0;
  const h = harness({ tools: [tool], callTool: async () => { calls++; return { text: "written" }; } });
  await executeRun(run, h.deps); assert.equal(run.status, "waiting_approval"); assert.equal(calls, 0);
  const approval = publicRun(run).approvals[0]; await decideApproval(run, approval.id, owner.userId, "approved"); await executeRun(run, h.deps);
  assert.equal(run.status, "succeeded", run.error); assert.equal(calls, 1); await executeRun(run, h.deps); assert.equal(calls, 1);
  const uncertain = create(grouped({ type: "subworkflow", subworkflow: { definition: child } })); await executeRun(uncertain, h.deps); await decideApproval(uncertain, publicRun(uncertain).approvals[0].id, owner.userId, "approved"); h.deps.callTool = async () => { throw new Error("lost reply"); }; await executeRun(uncertain, h.deps); assert.equal(uncertain.status, "unknown_outcome");
});

test("memory requires a configured adapter and preserves the root owner/workflow scope in child operations", async () => {
  const run = create(advancedTemplate("remember-value")!); await executeRun(run, harness().deps); assert.equal(run.status, "failed"); assert.match(run.error!, /미설정/);
  const operations: Parameters<NonNullable<RuntimeDependencies["memory"]>>[0][] = []; let stored: Json = null;
  const h = harness({ memory: async operation => { operations.push(operation); if (operation.action === "write") stored = operation.value!; return { data: stored, found: true }; } });
  const nested = create(grouped({ type: "subworkflow", subworkflow: { definition: advancedTemplate("remember-value")! } })); await executeRun(nested, h.deps);
  assert.equal(nested.status, "succeeded", nested.error); assert.ok(operations.every(operation => operation.ownerId === owner.userId && operation.workflowId === nested.workflow.id)); assert.equal(nested.result, "한국어 입력");
});

test("a failed child stops queued siblings and a recoverable child error may use the parent error route", async () => {
  const invalid = chain([node("input", "input"), node("parse", "transform", { transform: { mode: "parse_json" } }), node("output", "output")]);
  const first = grouped({ parallel: { concurrency: 1, tasks: [{ id: "bad", name: "bad", definition: invalid }, { id: "never", name: "never", definition: agentTask("must not run") }] } });
  let modelCalls = 0; const h = harness({ model: { next: async () => { modelCalls++; return answer("unexpected"); } } });
  const run = create(first, "not JSON"); await executeRun(run, h.deps); assert.equal(run.status, "failed"); assert.equal(modelCalls, 0); assert.equal(run.checkpoint.groups!.group.children[1].status, "queued");
  const routed = errorBranch(); Object.assign(routed.nodes.find(item => item.id === "work")!, { type: "subworkflow", transform: undefined, subworkflow: { definition: invalid } });
  const handled = create(routed, "not JSON"); await executeRun(handled, h.deps); assert.equal(handled.status, "succeeded", handled.error); assert.equal(handled.checkpoint.routes!.work, "error");
  const protectedChild = agentTask("protected"); const denied = create(grouped({ type: "subworkflow", subworkflow: { definition: protectedChild } }));
  const security = harness({ assertAccess: async () => { if (denied.checkpoint.groups?.group) throw new Error("revoked inside group"); } });
  await executeRun(denied, security.deps); assert.equal(denied.status, "failed"); assert.equal(denied.errorRecoverable, false);
});

test("parallel waiting approvals remain individually actionable after one decision and do not replay completed writes", async () => {
  const tool: ToolDefinition = { resourceId: "sample-search", connectionId: "test-write", toolName: "write", name: "write", description: "write", effect: "write", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
  const child = chain([node("input", "input"), node("write", "tool", { allowedTools: [tool], tool: { arguments: {}, bindings: { text: "text" } } }), node("output", "output")]);
  const run = create(grouped({ parallel: { concurrency: 2, tasks: [{ id: "a", name: "a", definition: child }, { id: "b", name: "b", definition: child }] } })); let calls = 0;
  const h = harness({ tools: [tool], callTool: async () => { calls++; return { text: "written" }; } });
  await executeRun(run, h.deps); assert.equal(run.status, "waiting_approval"); assert.equal(publicRun(run).approvals.length, 2);
  await decideApproval(run, publicRun(run).approvals[0].id, owner.userId, "approved"); await executeRun(run, h.deps);
  assert.equal(run.status, "waiting_approval"); assert.equal(calls, 1);
  await decideApproval(run, publicRun(run).approvals[1].id, owner.userId, "approved"); await executeRun(run, h.deps);
  assert.equal(run.status, "succeeded", run.error); assert.equal(calls, 1); assert.equal(run.checkpoint.toolCalls, 1);
});

test("review validates edited schemas before deciding and leaves invalid edits pending", async () => {
  const definition = advancedTemplate("human-review")!;
  definition.nodes.find(item => item.type === "review")!.inputSchema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
  const run = create(definition); const h = harness(); await executeRun(run, h.deps); const review = run.reviews![0];
  await assert.rejects(decideReview(run, review.id, owner.userId, "accepted", { text: 42 }), /자료형/);
  assert.equal(review.status, "pending"); assert.equal(run.status, "waiting_review");
});

test("global cancellation and elapsed limits propagate to children without starting more model calls", async () => {
  let calls = 0; const h = harness({ model: { next: async () => { calls++; return answer("unused"); } }, isCancelled: async () => true });
  const cancelled = create(advancedTemplate("agent-team")!); await executeRun(cancelled, h.deps); assert.equal(cancelled.status, "cancelled"); assert.equal(calls, 0);
  const limited = create(advancedTemplate("agent-team")!, "input", { maxDurationMs: 30 });
  const timeout = harness({ model: { next: async () => { calls++; return new Promise(() => {}); } } });
  await executeRun(limited, timeout.deps); assert.equal(limited.status, "budget_exceeded"); assert.equal(calls, 1); assert.equal(limited.checkpoint.groups!.team.children[1].status, "queued");
});

test("terminal roots cannot be revived by nested review/approval decisions or idempotent retries", async () => {
  const definition = grouped({ type: "subworkflow", subworkflow: { definition: advancedTemplate("human-review")! } });
  const h = harness();
  for (const status of ["cancelled", "failed", "unknown_outcome", "succeeded"] as const) {
    const run = create(definition); await executeRun(run, h.deps); const review = publicRun(run).reviews![0]; run.status = status;
    await assert.rejects(decideReview(run, review.id, owner.userId, "accepted"), /종료된/); assert.equal(run.status, status);
  }
  const decided = create(definition); await executeRun(decided, h.deps); const review = publicRun(decided).reviews![0]; await decideReview(decided, review.id, owner.userId, "accepted"); decided.status = "cancelled"; await decideReview(decided, review.id, owner.userId, "accepted"); assert.equal(decided.status, "cancelled");
});

const writeTool: ToolDefinition = { resourceId: "sample-search", connectionId: "test-write", toolName: "write", name: "write", description: "write", effect: "write", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
function duplicateWrites() {
  const child = chain([node("input", "input"), node("write", "tool", { allowedTools: [writeTool], tool: { arguments: {}, bindings: { text: "text" } } }), node("output", "output")]);
  return create(grouped({ parallel: { concurrency: 2, tasks: [{ id: "a", name: "a", definition: child }, { id: "b", name: "b", definition: child }] } }));
}
test("identical concurrently approved child writes share one durable external effect across resume", async () => {
  let calls = 0; const h = harness({ tools: [writeTool], callTool: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 20)); return { text: "one effect" }; } });
  const run = duplicateWrites(); await executeRun(run, h.deps);
  const approvals = publicRun(run).approvals; assert.equal(approvals.length, 2);
  for (const approval of approvals) await decideApproval(run, approval.id, owner.userId, "approved");
  await executeRun(run, h.deps); assert.equal(run.status, "succeeded", run.error); assert.equal(calls, 1);
  await decideApproval(run, approvals[0].id, owner.userId, "approved"); assert.equal(run.status, "succeeded"); await executeRun(run, h.deps); assert.equal(calls, 1);
  for (const status of ["cancelled", "failed", "unknown_outcome"] as const) { const blocked = duplicateWrites(); await executeRun(blocked, h.deps); blocked.status = status; await assert.rejects(decideApproval(blocked, publicRun(blocked).approvals[0].id, owner.userId, "approved"), /종료된/); assert.equal(blocked.status, status); }
});

test("a persisted denial blocks an identically approved sibling before either child dispatches", async () => {
  let calls = 0; const h = harness({ tools: [writeTool], callTool: async () => { calls++; return { text: "forbidden" }; } });
  const run = duplicateWrites(); await executeRun(run, h.deps); const approvals = publicRun(run).approvals;
  await decideApproval(run, approvals[0].id, owner.userId, "approved"); await decideApproval(run, approvals[1].id, owner.userId, "denied");
  await executeRun(run, h.deps); assert.equal(run.status, "failed"); assert.equal(calls, 0);
});

test("failed durable completion poisons sibling writes and restart preserves unknown outcome", async () => {
  let calls = 0, loseSave = false; const snapshots: RuntimeRun[] = [];
  const h = harness({ tools: [writeTool], callTool: async () => { calls++; return { text: "effect occurred" }; }, save: async run => {
    if (loseSave && Object.values(run.checkpoint.groups ?? {}).some(group => group.children.some(child => child.checkpoint.calls.some(call => call.status === "completed")))) throw new Error("synthetic completion save lost");
    snapshots.push(structuredClone(run));
  } });
  const run = duplicateWrites(); await executeRun(run, h.deps); for (const approval of publicRun(run).approvals) await decideApproval(run, approval.id, owner.userId, "approved");
  loseSave = true; await assert.rejects(executeRun(run, h.deps), /synthetic completion save lost/); assert.equal(calls, 1);
  loseSave = false; const recovered = snapshots.at(-1)!; await executeRun(recovered, h.deps); assert.equal(recovered.status, "unknown_outcome"); assert.equal(calls, 1);
});

test("parallel Agent team initializes previous and results for every role", async () => {
  const definition = advancedTemplate("agent-team")!; definition.nodes.find(item => item.type === "agent_team")!.team!.mode = "parallel"; definition.nodes.find(item => item.type === "agent_team")!.team!.concurrency = 2;
  const h = harness({ model: { next: async ({ messages }) => { const input = JSON.parse(messages[0].content).input; if (Object.hasOwn(input, "previous")) assert.equal(input.previous, null); return answer("independent role"); } } });
  const run = create(definition); await executeRun(run, h.deps); assert.equal(run.status, "succeeded", run.error); assert.ok(run.checkpoint.groups!.team.children.every(child => child.initialInput!.previous === null && Array.isArray(child.initialInput!.results)));
});

test("a completed child write remains completed when an identical sibling is later denied", async () => {
  const child = chain([node("input", "input"), node("agent", "agent", { prompt: "변경 후 답변", allowedTools: [writeTool] }), node("output", "output")]);
  let calls = 0, crash = false; const snapshots: RuntimeRun[] = [];
  const h = harness({ tools: [writeTool], model: { next: async ({ messages }) => messages.some(message => message.role === "tool") ? answer("관찰 완료") : { kind: "tool", toolName: "write", args: { text: "same" }, callId: "provider-id", usageTokens: 10 } }, callTool: async () => { calls++; return { text: "changed once" }; }, save: async run => {
    const first = run.checkpoint.groups?.group?.children[0];
    if (crash && first && first.checkpoint.turns >= 2 && first.checkpoint.calls[0]?.status === "completed") { crash = false; throw new Error("stop before next model"); }
    snapshots.push(structuredClone(run));
  } });
  let run = create(grouped({ parallel: { concurrency: 2, tasks: [{ id: "a", name: "a", definition: child }, { id: "b", name: "b", definition: child }] } }));
  await executeRun(run, h.deps); const approvals = publicRun(run).approvals;
  await decideApproval(run, approvals[0].id, owner.userId, "approved"); crash = true;
  await assert.rejects(executeRun(run, h.deps), /stop before next model/); assert.equal(calls, 1);
  run = snapshots.at(-1)!; assert.equal(run.checkpoint.groups!.group.children[0].checkpoint.calls[0].status, "completed");
  // Restore the sibling's pending-approval boundary while the first Agent still needs its next turn.
  run.checkpoint.groups!.group.children[1].status = "waiting_approval";
  await decideApproval(run, approvals[1].id, owner.userId, "denied"); await executeRun(run, h.deps);
  assert.equal(run.status, "succeeded", run.error); assert.equal(calls, 1);
  assert.equal(run.checkpoint.groups!.group.children[0].checkpoint.calls[0].status, "completed");
  assert.equal(run.checkpoint.groups!.group.children[1].checkpoint.calls[0].status, "denied");
});

test("sequential child provider timeout shrinks to the current ancestor remaining time", async context => {
  // Assert the actual deadline, independent of host event-loop contention.
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const run = create(advancedTemplate("agent-team")!, "input", { maxDurationMs: 240 });
  let calls = 0; let elapsedAtSecond = 0; let secondWait = 0;
  let firstEntered!: () => void, secondEntered!: () => void;
  const first = new Promise<void>(resolve => { firstEntered = resolve; });
  const second = new Promise<void>(resolve => { secondEntered = resolve; });
  const h = harness({ model: { next: async ({ signal }) => {
    calls++;
    if (calls === 1) { firstEntered(); await new Promise(resolve => setTimeout(resolve, 150)); return answer("first role"); }
    elapsedAtSecond = run.checkpoint.activeMs; const started = Date.now();
    secondEntered();
    return new Promise((_, reject) => signal.addEventListener("abort", () => { secondWait = Date.now() - started; reject(new Error("ancestor deadline")); }, { once: true }));
  } } });
  const pending = executeRun(run, h.deps);
  await first; context.mock.timers.tick(150); await second;
  const remaining = 240 - elapsedAtSecond;
  assert.equal(remaining, 90);
  context.mock.timers.tick(remaining - 1); assert.equal(secondWait, 0);
  context.mock.timers.tick(1); assert.equal(secondWait, remaining);
  await pending; assert.equal(run.status, "budget_exceeded"); assert.equal(calls, 2);
});
