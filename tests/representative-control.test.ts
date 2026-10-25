import test from "node:test";
import assert from "node:assert/strict";
import { representativeControlDesigns } from "../domain/workflow-designs/representative-control";
import type { WorkflowDesign, WorkflowScenario } from "../domain/workflow-design";
import { createRun, decideApproval, decideReview, executeRun, publicRun } from "../runtime/engine";
import { canonicalJson } from "../runtime/policy";
import { runTree } from "../runtime/advanced";
import type { Json, RuntimeDependencies, RuntimeRun, ToolDefinition } from "../runtime/types";
import { compileDefinition } from "../domain/workflow";
import { ruleEvaluation } from "../runtime/data-nodes";
import { parseExtendedNodeConfig } from "../domain/extended-config";

const owner = { userId: "representative-controls", email: "controls@example.test", displayName: "제어 흐름 검사" };
const tools: ToolDefinition[] = [
  { resourceId: "showcase-knowledge-mcp", connectionId: "showcase-knowledge", toolName: "lookup_reference", name: "lookup_reference", description: "읽기 전용 조회", effect: "read", supportsIdempotency: false, inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
  { resourceId: "showcase-publishing-mcp", connectionId: "showcase-publishing", toolName: "create_record", name: "create_record", description: "승인 후 등록", effect: "write", supportsIdempotency: false, inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title", "body"], additionalProperties: false } },
];
const serialize = (run: RuntimeRun): RuntimeRun => JSON.parse(JSON.stringify(run));
test("not_blank checks the selected string path without accepting missing/non-string values", () => {
  const node = representativeControlDesigns[0].definition.nodes.find(node => node.id === "initial_nonempty")!;
  for (const value of ["", " \t\r\n\u00a0\u3000\ufeff", null, false, 0, [], {}]) {
    const result = ruleEvaluation(node, { data: { answer: value, sourceId: "source" } });
    assert.equal((result.evaluation as Record<string, Json>).passed, false);
  }
  assert.equal((ruleEvaluation(node, { data: {} }).evaluation as Record<string, Json>).passed, false);
  assert.equal((ruleEvaluation(node, { data: { answer: " \t내용\n", sourceId: " source " } }).evaluation as Record<string, Json>).passed, true);
  for (const value of ["", "data.__proto__", "data.answer[0]", "a".repeat(501)]) assert.throws(() => parseExtendedNodeConfig({ type: "evaluate", evaluation: { ...node.evaluation, rules: [{ kind: "not_blank", value }] } }));
});
function environment(scenario: WorkflowScenario) {
  const turns = new Map<string, number>(), calls: { name: string; args: Record<string, Json>; key: string }[] = [], saved: RuntimeRun[] = [];
  const usedReplies = new Set<number>(), usedToolReplies = new Map<number, number>();
  let access = true;
  const deps: RuntimeDependencies = {
    tools, save: async run => { saved.push(serialize(run)); }, assertAccess: async () => { if (!access) throw new Error("Access revoked"); }, isCancelled: async () => false,
    model: { next: async ({ messages, tools: allowed }) => {
      const payload = JSON.parse(messages.find(message => message.role === "user")!.content);
      const matches = [...new Set((scenario.modelReplies ?? []).filter(reply => JSON.stringify(payload).includes(reply.match)).map(reply => reply.match))];
      assert.equal(matches.length, 1, `Expected one prompt fixture for ${payload.instruction}`);
      const match = matches[0], occurrence = (turns.get(match) ?? 0) + 1; turns.set(match, occurrence);
      const index = scenario.modelReplies!.findIndex(reply => reply.match === match && (reply.occurrence === undefined || reply.occurrence === occurrence));
      assert.ok(index >= 0, `Unexpected model step ${match}/${occurrence}`);
      const reply = scenario.modelReplies![index]; usedReplies.add(index);
      const input = JSON.stringify(payload.input), observation = JSON.stringify(messages.filter(message => message.role === "tool"));
      for (const text of reply.inputContains ?? []) assert.ok(input.includes(text), `Missing model input ${text}`);
      for (const text of reply.inputExcludes ?? []) assert.ok(!input.includes(text), `Unexpected model input ${text}`);
      for (const text of reply.observationContains ?? []) assert.ok(observation.includes(text), `Missing tool observation ${text}`);
      if (reply.allowedTools) assert.deepEqual(allowed.map(tool => tool.name).sort(), [...reply.allowedTools].sort());
      return reply.toolCall ? { kind: "tool", toolName: reply.toolCall.name, args: structuredClone(reply.toolCall.args), callId: reply.toolCall.callId ?? `${match}-${occurrence}`, usageTokens: 1 } : { kind: "answer", text: reply.text!, usageTokens: 1 };
    } },
    callTool: async (tool, args, options) => {
      // No real network in this unit test. Actual CLI adapter/HTTP boundary parity is
      // checked separately by test:examples, outside the downloaded package.
      calls.push({ name: tool.toolName, args: structuredClone(args), key: options.idempotencyKey });
      const index = (scenario.toolReplies ?? []).findIndex((reply, index) => reply.name === tool.toolName && canonicalJson(reply.args) === canonicalJson(args) && (usedToolReplies.get(index) ?? 0) < (reply.count ?? 1));
      assert.ok(index >= 0, `Unexpected tool call ${tool.toolName}: ${canonicalJson(args)}`);
      const reply = scenario.toolReplies![index]; usedToolReplies.set(index, (usedToolReplies.get(index) ?? 0) + 1);
      if (reply.error) throw new Error("Injected response loss at the tool boundary");
      return structuredClone(reply.result!);
    },
  };
  return { deps, calls, saved, turns, usedReplies, usedToolReplies, revoke: () => { access = false; } };
}
function create(design: WorkflowDesign, scenario: WorkflowScenario) {
  return createRun({ owner, mode: "test", workflow: { id: design.id, name: design.title, description: design.description, definition: design.definition, updatedAt: "2026-10-23T00:00:00Z" }, resources: design.resources, input: scenario.input });
}

for (const design of representativeControlDesigns) for (const scenario of design.scenarios) test(`${design.id}: ${scenario.name}`, async () => {
  const h = environment(scenario);
  let run = create(design, scenario);
  await executeRun(run, h.deps);
  if (run.status === "waiting_review") {
    assert.equal(h.calls.length, 0, "No write may happen while content review is pending");
    assert.equal(h.saved.at(-1)?.status, "waiting_review", "Review pause must be persisted");
  }
  if (scenario.review && run.status === "waiting_review") {
    run = serialize(h.saved.at(-1)!);
    for (const review of publicRun(run).reviews!.filter(review => review.status === "pending")) await decideReview(run, review.id, owner.userId, scenario.review === "accept" ? "accepted" : "rejected");
    run = serialize(run);
    await executeRun(run, h.deps);
  }
  if (run.status === "waiting_approval") {
    assert.equal(h.calls.length, 0, "Content review acceptance is not permission to dispatch a write");
    assert.equal(h.saved.at(-1)?.status, "waiting_approval", "Write approval pause must be persisted");
  }
  if (scenario.approval && run.status === "waiting_approval") {
    run = serialize(h.saved.at(-1)!);
    const pending = publicRun(run).approvals.filter(approval => approval.status === "pending");
    assert.equal(pending.length, 1);
    for (const approval of pending) {
      assert.deepEqual(approval.args, { title: "회의 일정 안내", body: "내일 오전 10시에 회의를 시작합니다." });
      await decideApproval(run, approval.id, owner.userId, scenario.approval === "approve" ? "approved" : "denied");
      await decideApproval(run, approval.id, owner.userId, scenario.approval === "approve" ? "approved" : "denied");
    }
    run = serialize(run);
    await executeRun(run, h.deps);
  }
  if (scenario.resumeAgain) {
    const before = h.calls.length;
    run = serialize(run); await executeRun(run, h.deps); await executeRun(run, h.deps);
    assert.equal(h.calls.length, before, "Terminal/resumed execution must not repeat an external operation");
  }
  const context = `${scenario.name}: ${run.error ?? run.result}`;
  assert.equal(run.status, scenario.status, context);
  for (const text of scenario.contains ?? []) assert.ok(run.result.includes(text), context);
  for (const text of scenario.excludes ?? []) assert.ok(!run.result.includes(text), context);
  for (const text of scenario.errorContains ?? []) assert.ok(run.error?.includes(text), context);
  for (const [name, expected] of Object.entries(scenario.toolCallCounts ?? {})) assert.equal(h.calls.filter(call => call.name === name).length, expected, context);
  const completed = new Set(runTree(run).flatMap(child => child.checkpoint.completed)), skipped = new Set(runTree(run).flatMap(child => child.checkpoint.skipped));
  for (const id of scenario.visited ?? []) assert.ok(completed.has(id), `${context} did not complete ${id}`);
  for (const id of scenario.skipped ?? []) assert.ok(skipped.has(id), `${context} did not skip ${id}`);
  assert.equal(h.usedReplies.size, scenario.modelReplies?.length ?? 0, "Every declared model fixture must be exercised");
  for (const [index, fixture] of (scenario.toolReplies ?? []).entries()) assert.equal(h.usedToolReplies.get(index) ?? 0, fixture.count ?? 1, "Every declared tool fixture must be exercised");
  if (scenario.name.includes("허용되지 않은")) assert.ok(run.events.some(event => event.type === "tool_rejected"));
  if (scenario.name.includes("도구 없이") || scenario.name.includes("도구 없는")) assert.ok(run.events.some(event => event.type === "tool_result_required"));
});

test("required tool result is an opt-in Agent-only boolean and needs an allowed tool", () => {
  const original = representativeControlDesigns[0].definition;
  assert.equal(compileDefinition(original).nodes.find(node => node.id === "research")!.requireToolResult, true);
  for (const value of ["true", 1, null]) {
    const definition = structuredClone(original); Object.assign(definition.nodes.find(node => node.id === "research")!, { requireToolResult: value });
    assert.throws(() => compileDefinition(definition), /Agent/);
  }
  const wrongKind = structuredClone(original); wrongKind.nodes[0].requireToolResult = false;
  assert.throws(() => compileDefinition(wrongKind), /Agent/);
  const missing = structuredClone(original); missing.nodes.find(node => node.id === "research")!.allowedTools = [];
  assert.throws(() => compileDefinition(missing), /도구/);
  const legacy = structuredClone(original); delete legacy.nodes.find(node => node.id === "research")!.requireToolResult;
  assert.equal(compileDefinition(legacy).nodes.find(node => node.id === "research")!.requireToolResult, undefined);
});

test("required tool result never accepts a completed tool from a different node or a failed call", async () => {
  const design = representativeControlDesigns[0], scenario = design.scenarios.find(s => s.name === "계속 도구 없이 답하면 판단 한도에서 중단")!;
  for (const variant of ["other-node", "failed", "unselected-tool"] as const) {
    const h = environment(scenario), run = create(design, scenario);
    run.checkpoint.calls.push({ id: "prior-call", nodeId: variant === "other-node" ? "input" : "research", tool: variant === "unselected-tool" ? { ...tools[0], toolName: "not_selected" } : tools[0], args: { query: scenario.input }, argsHash: "prior-hash", status: variant === "failed" ? "failed" : "completed", result: { text: "이 Agent의 확인 근거가 아님" }, attempts: 2 });
    await executeRun(run, h.deps);
    assert.equal(run.status, "budget_exceeded", `${variant}: ${run.error}`);
    assert.equal(run.result, ""); assert.equal(h.calls.length, 0);
  }
});

test("required tool result suppresses unverified streaming and persists the correction request", async () => {
  const design = structuredClone(representativeControlDesigns[0]); design.definition.nodes.find(node => node.id === "answer_out")!.delivery = { stream: true };
  const scenario = design.scenarios.find(s => s.name === "도구 없는 첫 답변을 거절하고 실제 조회 후에만 확정")!, h = environment(scenario), run = create(design, scenario);
  const original = h.deps.model.next, streaming: boolean[] = [];
  h.deps.model.next = async request => { streaming.push(Boolean(request.onDelta)); if (streaming.length === 2) assert.ok(request.messages.some(message => message.role === "user" && message.content.includes("완료된 도구 결과가 없습니다"))); return original(request); };
  await executeRun(run, h.deps);
  assert.equal(run.status, "succeeded", run.error);
  assert.deepEqual(streaming, [false, false, true]);
  const correction = h.saved.find(snapshot => snapshot.events.some(event => event.type === "tool_result_required"));
  assert.ok(correction); assert.equal(correction.checkpoint.completed.includes("research"), false);
  assert.equal(correction.result, "");
});

const publishing = representativeControlDesigns.find(design => design.id === "showcase-approved-publishing")!;
const approved = publishing.scenarios.find(scenario => scenario.approval === "approve" && scenario.status === "succeeded")!;
async function waitingApproval() {
  const h = environment(approved), run = create(publishing, approved);
  await executeRun(run, h.deps);
  await decideReview(run, run.reviews![0].id, owner.userId, "accepted");
  await executeRun(run, h.deps);
  assert.equal(run.status, "waiting_approval");
  return { h, run };
}
test("publishing approval cannot authorize another user or changed arguments", async () => {
  const { h, run } = await waitingApproval();
  await assert.rejects(decideApproval(run, run.approvals[0].id, "other-user", "approved"), /권한/);
  run.checkpoint.calls[0].args.body = "승인 대상과 다른 내용";
  await assert.rejects(decideApproval(run, run.approvals[0].id, owner.userId, "approved"), /인자/);
  assert.equal(h.calls.length, 0);
});
test("publishing rechecks access after approval and before external dispatch", async () => {
  const { h, run } = await waitingApproval();
  await decideApproval(run, run.approvals[0].id, owner.userId, "approved"); h.revoke();
  await executeRun(run, h.deps);
  assert.equal(run.status, "failed"); assert.equal(h.calls.length, 0);
});
test("publishing cannot edit reviewed content without starting a new approval", async () => {
  const h = environment(approved), run = create(publishing, approved); await executeRun(run, h.deps);
  await assert.rejects(decideReview(run, run.reviews![0].id, owner.userId, "accepted", { text: "변경 내용", data: { title: "다른 제목", body: "다른 본문" } }), /수정/);
  assert.equal(h.calls.length, 0);
});
test("publishing recovers a saved completed write without replay after response persistence", async () => {
  const { h, run } = await waitingApproval();
  await decideApproval(run, run.approvals[0].id, owner.userId, "approved"); await executeRun(run, h.deps);
  const checkpoint = h.saved.find(saved => saved.status === "running" && saved.checkpoint.calls[0]?.status === "completed" && !saved.checkpoint.completed.includes("publish"));
  assert.ok(checkpoint); assert.equal(h.calls.length, 1);
  const recovered = serialize(checkpoint), fresh = environment(approved);
  await executeRun(recovered, fresh.deps);
  assert.equal(recovered.status, "succeeded", recovered.error); assert.equal(fresh.calls.length, 0);
  assert.ok(recovered.result.includes("record-test-41"));
});
test("publishing dispatching checkpoint remains unknown and cannot replay", async () => {
  const { h, run } = await waitingApproval();
  await decideApproval(run, run.approvals[0].id, owner.userId, "approved");
  run.checkpoint.calls[0].status = "dispatching"; run.checkpoint.calls[0].attempts = 1;
  const recovered = serialize(run); await executeRun(recovered, h.deps); await executeRun(recovered, h.deps);
  assert.equal(recovered.status, "unknown_outcome"); assert.equal(h.calls.length, 0);
});
