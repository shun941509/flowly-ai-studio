import test from "node:test";
import assert from "node:assert/strict";
import type { Definition, FlowNode, Resource, Workflow } from "../app/lib/model";
import { createRun, decideApproval, decideReview, executeRun, publicRun } from "../runtime/engine";
import type { Json, RuntimeDependencies, RuntimeRun, ToolDefinition } from "../runtime/types";
import { argsHash } from "../runtime/policy";

const owner = { userId: "v5-test", email: "v5@example.test", displayName: "V5" };
const node = (id: string, type: FlowNode["type"], extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title: id, x: 0, y: 0, ...extra });
const graph = (nodes: FlowNode[]): Definition => ({ schemaVersion: 5, nodes, edges: nodes.slice(1).map((next, i) => ({ id: `edge${i}`, source: nodes[i].id, target: next.id })) });
const resource = (id: string, type: Resource["type"], content = "한국어 휴가 정책"): Resource => ({ id, ownerId: owner.userId, type, content, name: id, description: "", url: "", visibility: "private", allowedEmails: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" });
const resources = [resource("document", "document"), resource("mcp", "mcp")];
const workflow = (definition: Definition): Workflow => ({ id: "v5-flow", name: "v5", description: "", updatedAt: "2026-01-01", definition });
const create = (definition: Definition, input = "한국어 질문", initialInput?: Record<string, Json>) => createRun({ owner, mode: "test", workflow: workflow(definition), resources, input, initialInput, limits: { maxTokens: 16000 } });
const chain = (middle: FlowNode, end: Partial<FlowNode> = {}) => graph([node("input", "input"), middle, node("output", "output", end)]);
function harness(extra: Partial<RuntimeDependencies> = {}) {
  const snapshots: RuntimeRun[] = [];
  const deps: RuntimeDependencies = { model: { next: async () => { throw new Error("Unexpected model"); } }, tools: [], callTool: async () => { throw new Error("Unexpected tool"); }, save: async run => { snapshots.push(structuredClone(run)); }, assertAccess: async () => {}, isCancelled: async () => false, ...extra };
  return { deps, snapshots };
}
const selection = { resourceId: "mcp", connectionId: "service", toolName: "write" };
const tool: ToolDefinition = { ...selection, name: "write", effect: "write", description: "Synthetic", inputSchema: { type: "object" } };
const memoryNode = (action: "read" | "write" | "delete", extra = {}): FlowNode => node("memory", "memory", { memory: { action, key: "notes", backend: "mcp", ...(action === "write" ? { valuePath: "text", ttlSeconds: 60 } : {}), ...extra }, allowedTools: [selection] });

test("guardrail recursively masks/removes without returning detected originals; block cannot take onError", async () => {
  for (const action of ["mask", "remove"] as const) {
    const run = create(chain(node("filter", "guardrail", { guardrail: { action, categories: ["email", "phone", "resident_id", "card", "secret"] }, inputBindings: { text: { nodeId: "input", path: "text" }, nested: { nodeId: "input", path: "nested" } } })), "", { text: "a@example.com 010-1234-5678", nested: ["900101-1234567", "4111 1111 1111 1111", "api_key=sample-secret-value"] });
    await executeRun(run, harness().deps); assert.equal(run.status, "succeeded", run.error);
    const output = run.checkpoint.outputs.filter; assert.doesNotMatch(JSON.stringify(output), /a@example|1234-5678|900101|4111|sample-secret/); assert.equal((output.guardrail as Record<string, Json>).changed, true);
  }
  const definition = chain(node("filter", "guardrail", { guardrail: { action: "block", categories: ["email"] }, onError: "branch" }));
  definition.nodes.push(node("failure", "output")); definition.edges[1].branch = "success"; definition.edges.push({ id: "error", source: "filter", target: "failure", branch: "error" });
  assert.throws(() => create(definition, "private@example.com"), /오류 분기/);
  const run = create(chain(node("filter", "guardrail", { guardrail: { action: "block", categories: ["email"] } })), "private@example.com"); await executeRun(run, harness().deps);
  assert.equal(run.status, "failed"); assert.equal(run.errorRecoverable, false); assert.equal(run.checkpoint.routes?.filter, undefined); assert.doesNotMatch(run.error!, /private@example/);
});

test("rules and model evaluation preserve text and validate scores using real usage accounting", async () => {
  const config = { mode: "rules" as const, rules: [{ kind: "contains" as const, value: "한국어" }, { kind: "max_length" as const, value: "100" }], rubric: "", threshold: .8 };
  const run = create(chain(node("evaluate", "evaluate", { evaluation: config }))); await executeRun(run, harness().deps);
  assert.equal(run.status, "succeeded", run.error); assert.equal(run.result, "한국어 질문"); assert.equal((run.checkpoint.outputs.evaluate.evaluation as Record<string, Json>).score, 1); assert.equal(run.checkpoint.turns, 0);
  for (const score of [.75, 2]) {
    const run = create(chain(node("evaluate", "evaluate", { evaluation: { mode: "model", rules: [], rubric: "정확성", threshold: .5 } })));
    await executeRun(run, harness({ model: { next: async () => ({ kind: "answer", text: JSON.stringify({ score, reason: "평가 설명" }), usageTokens: 77 }) } }).deps);
    assert.equal(run.status, score === 2 ? "failed" : "succeeded", run.error); assert.equal(run.checkpoint.tokens, 77);
  }
});

test("trigger is a real start node and preserves structured event payload", async () => {
  const run = create(graph([node("trigger", "trigger", { trigger: { kind: "event", intervalSeconds: 5, startAt: "", eventType: "invoice" } }), node("output", "output")]), '{"id":"event-1","amount":42}');
  await executeRun(run, harness().deps); assert.equal(run.status, "succeeded", run.error); assert.deepEqual(run.checkpoint.outputs.trigger.data, { id: "event-1", amount: 42 }); assert.equal(run.checkpoint.skipped.length, 0);
});

test("file nodes route configured requests through bounded adapter and missing adapters fail honestly", async () => {
  const definition = graph([node("input", "input"), node("file", "file_input", { fileInput: { path: "text", maxBytes: 1000 } }), node("extract", "document_extract", { documentExtract: { mode: "text", filePath: "file", maxPages: 10, language: "eng" }, inputBindings: { file: { nodeId: "file", path: "file" } } }), node("save", "file_output", { fileOutput: { format: "csv", filename: "result.csv", dataPath: "text" } }), node("output", "output")]);
  const called: string[] = []; const run = create(definition);
  await executeRun(run, harness({ files: async request => { called.push(request.operation); assert.equal(request.runId, run.id); assert.equal(request.signal.aborted, false); return { text: "processed", file: { path: "inputs/file.txt" } }; } }).deps);
  assert.equal(run.status, "succeeded", run.error); assert.deepEqual(called, ["input", "extract", "output"]);
  const missing = create(definition); await executeRun(missing, harness().deps); assert.equal(missing.status, "failed"); assert.match(missing.error!, /미설정/);
});

test("vector retrieval builds authorized index once, queries on each run and invalidates changed content", async () => {
  const cache = new Map<string, Json>(); const texts: string[][] = [];
  const deps = harness({ vectorCache: async (key, value) => { if (value !== undefined) cache.set(key, structuredClone(value)); return cache.get(key); }, model: { embeddingModel: "test-embedding", next: async () => { throw Error(); }, embed: async input => { texts.push(input.texts); return { vectors: input.texts.map(() => [1, 0]), model: "test-embedding", usageTokens: 10 }; } } }).deps;
  const definition = chain(node("search", "retrieval", { retrieval: { mode: "vector", resourceIds: ["document"], chunkSize: 300, topK: 1, indexKey: "policy" } }));
  const first = create(definition); await executeRun(first, deps); assert.equal(first.status, "succeeded", first.error); assert.equal(first.checkpoint.turns, 2); assert.equal(first.checkpoint.toolCalls, 2); assert.equal(first.checkpoint.tokens, 20); assert.equal(cache.size, 1);
  const second = create(definition); await executeRun(second, deps); assert.equal(second.status, "succeeded", second.error); assert.equal(second.checkpoint.turns, 1); assert.equal(texts.length, 3);
  const changed = create(definition); changed.resources[0].content = "바뀐 정책"; await executeRun(changed, deps); assert.equal(changed.status, "succeeded", changed.error); assert.equal(cache.size, 2);
  const limited = create(definition); limited.limits.maxToolCalls = 1; cache.clear(); const before = texts.length; await executeRun(limited, deps); assert.equal(limited.status, "budget_exceeded"); assert.equal(texts.length - before, 1);
});

test("web search counts provider usage and refuses unverified source URLs", async () => {
  for (const url of ["https://example.com/source", "http://localhost/private"]) {
    const run = create(chain(node("search", "retrieval", { retrieval: { mode: "web", resourceIds: [], chunkSize: 300, topK: 2 } })));
    await executeRun(run, harness({ model: { next: async () => { throw Error(); }, search: async () => ({ text: "출처 있는 결과", sources: [{ url, title: "근거" }], usageTokens: 21 }) } }).deps);
    assert.equal(run.status, url.startsWith("https:") ? "succeeded" : "failed", run.error); assert.equal(run.checkpoint.toolCalls, 1); assert.equal(run.checkpoint.tokens, 21);
  }
});

test("MCP memory forces owner namespace, binds TTL before approval and resumes exactly once", async () => {
  let calls = 0; const run = create(chain(memoryNode("write")), "remember"); const h = harness({ tools: [tool], callTool: async (_tool, args) => { calls++; assert.equal(args.namespace, await argsHash({ ownerId: owner.userId, workflowId: run.workflow.id })); return { data: args.value, found: true, expiresAt: args.expiresAt }; } });
  await executeRun(run, h.deps); assert.equal(run.status, "waiting_approval"); assert.equal(calls, 0);
  const args = structuredClone(run.checkpoint.calls[0].args);
  await decideApproval(run, run.approvals[0].id, owner.userId, "approved"); await executeRun(run, h.deps);
  assert.equal(run.status, "succeeded", run.error); assert.equal(calls, 1); assert.deepEqual(run.checkpoint.calls[0].args, args); assert.equal(run.checkpoint.outputs.memory.data, "remember");
  await executeRun(run, h.deps); assert.equal(calls, 1);
  const read = create(chain(memoryNode("read", { defaultValue: "expired fallback" })));
  await executeRun(read, harness({ tools: [{ ...tool, effect: "read" }], callTool: async () => ({ data: "expired", found: true, expiresAt: "2000-01-01T00:00:00Z" }) }).deps);
  assert.equal(read.status, "succeeded", read.error); assert.equal(read.checkpoint.outputs.memory.found, false); assert.equal(read.checkpoint.outputs.memory.data, "expired fallback");
});

test("compensation requires completed original write, fresh approval and durable call reuse", async () => {
  const undo = { ...tool, name: "undo", toolName: "undo" };
  const definition = graph([node("input", "input"), node("write", "tool", { allowedTools: [selection], tool: { arguments: { action: "create" }, bindings: {} } }), node("undo", "compensate", { allowedTools: [{ ...selection, toolName: "undo" }], compensation: { sourceNodeId: "write", arguments: { action: "delete" }, bindings: {} } }), node("output", "output")]);
  let calls = 0; const h = harness({ tools: [tool, undo], callTool: async () => { calls++; return { success: true }; } });
  const run = create(definition); await executeRun(run, h.deps); assert.equal(calls, 0);
  await decideApproval(run, run.approvals[0].id, owner.userId, "approved"); await executeRun(run, h.deps); assert.equal(run.status, "waiting_approval"); assert.equal(calls, 1); assert.equal(run.approvals.length, 2);
  await decideApproval(run, run.approvals[1].id, owner.userId, "approved"); await executeRun(run, h.deps); assert.equal(run.status, "succeeded", run.error); assert.equal(calls, 2);
  await executeRun(run, h.deps); assert.equal(calls, 2);
  const denied = create(definition); await executeRun(denied, h.deps); await decideApproval(denied, denied.approvals[0].id, owner.userId, "denied"); await executeRun(denied, h.deps); assert.equal(denied.status, "failed"); assert.equal(denied.approvals.length, 1);
});

test("adaptive planner observes results and persists separate round identities; round exhaustion is not success", async () => {
  const task = graph([node("input", "input"), node("output", "output")]);
  const definition = chain(node("adaptive", "orchestrator", { prompt: "완료할 때까지 검토", orchestration: { mode: "adaptive", maxRounds: 3, maxTasks: 1, tasks: [{ id: "draft", name: "초안", definition: task }] } }));
  let turns = 0; const h = harness({ model: { next: async ({ messages }) => { turns++; const payload = JSON.parse(messages[0].content).input; assert.equal(payload.round, turns); assert.equal(payload.results.length, turns - 1); return { kind: "answer", text: JSON.stringify({ done: turns === 3, tasks: turns === 3 ? [] : ["draft"] }), usageTokens: 10 }; } } });
  const run = create(definition); await executeRun(run, h.deps); assert.equal(run.status, "succeeded", run.error); assert.equal(turns, 3); const group = run.checkpoint.groups!.adaptive; assert.deepEqual(group.taskIds, ["round_1_draft", "round_2_draft"]); assert.equal(group.rounds!.length, 3); assert.equal(group.planningDone, true);
  const exhausted = create(definition); exhausted.workflow.definition.nodes[1].orchestration!.maxRounds = 1;
  await executeRun(exhausted, harness({ model: { next: async () => ({ kind: "answer", text: '{"done":false,"tasks":["draft"]}', usageTokens: 1 }) } }).deps); assert.equal(exhausted.status, "budget_exceeded");
});

test("streaming saves partial events but final result requires successful completed provider response", async () => {
  for (const interrupted of [false, true]) {
    const partials: string[] = []; const h = harness({ onDelta: event => { partials.push(event.text); }, model: { next: async ({ onDelta }) => { assert.ok(onDelta); await onDelta("부분 답"); if (interrupted) throw Error("synthetic disconnect"); return { kind: "answer", text: "최종 답", usageTokens: 20 }; } } });
    const run = create(chain(node("model", "ai", { prompt: "응답" }), { delivery: { stream: true } })); await executeRun(run, h.deps);
    assert.deepEqual(partials, ["부분 답"]); assert.ok(h.snapshots.some(value => value.events.some(event => event.type === "model_delta")));
    assert.equal(run.status, interrupted ? "failed" : "succeeded", run.error); assert.equal(run.result, interrupted ? "" : "최종 답");
  }
});

test("adaptive checkpoint resumes nested review without re-planning or repeating finished children", async () => {
  const task = graph([node("input", "input"), node("review", "review", { review: { instructions: "검토", allowEdit: false, timeoutMinutes: 10 } }), node("output", "output"), node("denied", "output")]);
  task.edges = [{ id: "a", source: "input", target: "review" }, { id: "b", source: "review", target: "output", branch: "yes" }, { id: "c", source: "review", target: "denied", branch: "no" }];
  let calls = 0; const deps = harness({ model: { next: async () => { calls++; return { kind: "answer", text: calls === 1 ? '{"done":false,"tasks":["check"]}' : '{"done":true,"tasks":[]}', usageTokens: 10 }; } } }).deps;
  let run = create(chain(node("adaptive", "orchestrator", { prompt: "검토", orchestration: { mode: "adaptive", maxRounds: 3, maxTasks: 1, tasks: [{ id: "check", name: "검토", definition: task }] } })));
  await executeRun(run, deps); assert.equal(run.status, "waiting_review"); assert.equal(calls, 1);
  run = JSON.parse(JSON.stringify(run)); await decideReview(run, publicRun(run).reviews![0].id, owner.userId, "accepted"); await executeRun(run, deps);
  assert.equal(run.status, "succeeded", run.error); assert.equal(calls, 2); assert.equal(run.checkpoint.groups!.adaptive.children.length, 1); assert.equal(run.checkpoint.groups!.adaptive.rounds!.length, 2);
});

test("compensation refuses an identical original operation instead of claiming a reused success", async () => {
  const definition = graph([node("input", "input"), node("write", "tool", { allowedTools: [selection], tool: { arguments: { action: "create" }, bindings: {} } }), node("undo", "compensate", { allowedTools: [selection], compensation: { sourceNodeId: "write", arguments: { action: "create" }, bindings: {} } }), node("output", "output")]);
  let calls = 0; const deps = harness({ tools: [tool], callTool: async () => { calls++; return { result: true }; } }).deps;
  const run = create(definition); await executeRun(run, deps); await decideApproval(run, run.approvals[0].id, owner.userId, "approved"); await executeRun(run, deps);
  assert.equal(run.status, "failed"); assert.equal(calls, 1); assert.match(run.error!, /같은 도구/);
});

test("cached vector corruption and storage failure cannot be diverted through error branches", async () => {
  const definition = chain(node("search", "retrieval", { retrieval: { mode: "vector", resourceIds: ["document"], chunkSize: 300, topK: 1 }, onError: "branch" }));
  definition.nodes.push(node("error", "output")); definition.edges[1].branch = "success"; definition.edges.push({ id: "error", source: "search", target: "error", branch: "error" });
  let calls = 0; const run = create(definition);
  await executeRun(run, harness({ vectorCache: async () => ({ model: "test", vectors: [["bad"]] }), model: { embeddingModel: "test", next: async () => { throw Error(); }, embed: async () => { calls++; return { vectors: [[1]], usageTokens: 1, model: "test" }; } } }).deps);
  assert.equal(run.status, "failed"); assert.equal(run.errorRecoverable, false); assert.equal(run.checkpoint.routes?.search, undefined); assert.equal(calls, 0);
});
