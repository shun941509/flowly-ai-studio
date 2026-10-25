import test from "node:test";
import assert from "node:assert/strict";
import { representativeRetrievalDesigns, representativeShippingTool } from "../domain/workflow-designs/representative-retrieval";
import { compileDefinition } from "../domain/workflow";
import { workflowIdentity } from "../domain/workflow-identity";
import { createRun, executeRun, publicRun, submitInput } from "../runtime/engine";
import { runTree } from "../runtime/advanced";
import type { Json, RuntimeDependencies } from "../runtime/types";
import type { WorkflowDesign, WorkflowScenario } from "../domain/workflow-design";

const owner = { userId: "representative-retrieval-test", email: "retrieval@example.test", displayName: "검색 실행 검사" };
const fixture = (design: WorkflowDesign, scenario: WorkflowScenario, cache = new Map<string, Json>()) => {
  const models: string[] = [], embeddingCalls: string[][] = [], calls: { name: string; args: Record<string, Json> }[] = [];
  const dependencies: RuntimeDependencies = {
    tools: [representativeShippingTool], assertAccess: async () => {}, isCancelled: async () => false, save: async () => {},
    vectorCache: async (key, value) => { if (value !== undefined) cache.set(key, structuredClone(value)); return cache.get(key); },
    model: {
      embeddingModel: "text-embedding-3-small",
      next: async ({ messages }) => {
        const payload = JSON.parse(messages.find(message => message.role === "user")!.content);
        const response = scenario.modelReplies?.find(reply => JSON.stringify(payload).includes(reply.match));
        assert.ok(response, `Unexpected model input: ${payload.instruction}`);
        const mapped = JSON.stringify(payload.input);
        for (const required of response.inputContains ?? []) assert.ok(mapped.includes(required), `${response.match}: missing ${required}`);
        for (const excluded of response.inputExcludes ?? []) assert.ok(!mapped.includes(excluded), `${response.match}: leaked ${excluded}`);
        models.push(response.match);
        return { kind: "answer", text: response.text!, usageTokens: 1 };
      },
      embed: async ({ texts }) => {
        embeddingCalls.push([...texts]);
        return { model: "text-embedding-3-small", usageTokens: 1, vectors: texts.map(text => { const expected = scenario.embeddingReplies?.find(item => item.text === text); assert.ok(expected, `Unexpected embedding text: ${text}`); return expected.vector; }) };
      },
    },
    callTool: async (tool, args) => {
      calls.push({ name: tool.toolName, args });
      const reply = scenario.toolReplies?.find(item => item.name === tool.toolName && JSON.stringify(item.args) === JSON.stringify(args));
      assert.ok(reply, `Unexpected tool ${tool.toolName}: ${JSON.stringify(args)}`);
      return structuredClone(reply.result!);
    },
  };
  const run = createRun({ owner, mode: "test", workflow: { id: design.id, name: design.title, description: design.description, definition: compileDefinition(design.definition), updatedAt: "2026-10-23" }, resources: design.resources, input: scenario.input });
  return { run, dependencies, models, embeddingCalls, calls };
};

for (const design of representativeRetrievalDesigns) test(`representative branch and data witnesses: ${design.id}`, async () => {
  const caches = new Map<string, Map<string, Json>>();
  for (const [index, scenario] of design.scenarios.entries()) {
    const key = scenario.stateGroup ?? String(index), cache = caches.get(key) ?? new Map<string, Json>(); caches.set(key, cache);
    const state = fixture(design, scenario, cache);
    await executeRun(state.run, state.dependencies);
    for (const submission of scenario.inputSubmissions ?? []) {
      assert.equal(state.run.status, "waiting_input", `${design.id}/${scenario.name}`);
      const request = publicRun(state.run).inputRequests?.find(item => item.nodeId === submission.nodeId && item.status === "pending");
      assert.ok(request, `Missing input request: ${submission.nodeId}`);
      const callsBefore = [state.models.length, state.embeddingCalls.length, state.calls.length];
      for (const values of submission.invalidValues ?? []) {
        await assert.rejects(submitInput(state.run, request.id, owner.userId, values));
        assert.equal(state.run.status, "waiting_input");
      }
      await submitInput(state.run, request.id, owner.userId, submission.values);
      if (submission.repeat) await submitInput(state.run, request.id, owner.userId, submission.values);
      assert.deepEqual([state.models.length, state.embeddingCalls.length, state.calls.length], callsBefore, "Input submission must not dispatch work");
      await executeRun(state.run, state.dependencies);
    }
    const label = `${design.id}/${scenario.name}: ${state.run.error ?? state.run.result}`;
    assert.equal(state.run.status, scenario.status, label);
    for (const fragment of scenario.contains ?? []) assert.ok(state.run.result.includes(fragment), `${label}: missing ${fragment}`);
    for (const fragment of scenario.excludes ?? []) assert.ok(!state.run.result.includes(fragment), `${label}: leaked ${fragment}`);
    const tree = runTree(state.run), complete = tree.flatMap(run => run.checkpoint.completed), skipped = tree.flatMap(run => run.checkpoint.skipped);
    for (const id of scenario.visited ?? []) assert.ok(complete.includes(id), `${label}: did not execute ${id}`);
    for (const id of scenario.skipped ?? []) assert.ok(skipped.includes(id), `${label}: did not skip ${id}`);
    for (const [id, count] of Object.entries(scenario.completedCounts ?? {})) assert.equal(tree.flatMap(run => run.events).filter(event => event.type === "node_completed" && event.nodeId === id).length, count, `${label}: replayed ${id}`);
    for (const [id, fields] of Object.entries(scenario.outputs ?? {})) {
      const output = tree.find(run => Object.hasOwn(run.checkpoint.outputs, id))?.checkpoint.outputs[id];
      assert.ok(output, `${label}: no output from ${id}`);
      for (const [field, value] of Object.entries(fields)) assert.deepEqual(output[field], value, `${label}/${id}.${field}`);
    }
    for (const reply of scenario.modelReplies ?? []) assert.ok(state.models.includes(reply.match), `${label}: did not call ${reply.match}`);
    if (scenario.embeddingCallCount !== undefined) assert.equal(state.embeddingCalls.length, scenario.embeddingCallCount, label);
    for (const [name, count] of Object.entries(scenario.toolCallCounts ?? {})) assert.equal(state.calls.filter(call => call.name === name).length, count, label);
  }
});

test("representative search and request dispatch have different executable graph identities", () => {
  const identities = representativeRetrievalDesigns.map(design => workflowIdentity(compileDefinition(design.definition)));
  assert.notEqual(identities[0].topology, identities[1].topology);
  assert.notEqual(identities[0].execution, identities[1].execution);
});

test("combined request has overlapping active policy and shipping child executions", async () => {
  const design = representativeRetrievalDesigns[1];
  const scenario = design.scenarios.find(item => item.name === "복합 요청은 정책과 배송을 병렬 실행")!;
  const state = fixture(design, scenario);
  let overlapping = false;
  state.dependencies.save = async root => {
    for (const current of runTree(root)) {
      const group = current.checkpoint.groups?.support_parallel;
      if (group?.children.length === 2 && group.children.every(child => child.status === "running")) overlapping = true;
    }
  };
  await executeRun(state.run, state.dependencies);
  assert.equal(state.run.status, "succeeded", state.run.error);
  assert.equal(overlapping, true, "A sequential dispatcher must not satisfy the parallel example");
  assert.equal(state.calls.length, 1);
});

test("RAG index is rebuilt for a document version and content change", async () => {
  const original = representativeRetrievalDesigns[0], cache = new Map<string, Json>();
  const initial = fixture(original, original.scenarios[0], cache);
  await executeRun(initial.run, initial.dependencies);
  assert.equal(initial.run.status, "succeeded", initial.run.error);
  assert.equal(initial.embeddingCalls.length, 2);
  const changed = structuredClone(original);
  changed.resources[0].content = "예약 취소는 시작 48시간 전까지 가능합니다. 변경된 문서입니다.";
  changed.resources[0].updatedAt = "2026-10-24T00:00:00Z";
  const scenario: WorkflowScenario = { name: "changed document", input: "취소 기한", status: "succeeded", embeddingReplies: [{ text: changed.resources[0].content, vector: [1, 0, 0] }, { text: changed.resources[1].content, vector: [0, 1, 0] }, { text: "취소 기한", vector: [1, 0, 0] }], modelReplies: [{ match: "SHOWCASE_RAG_ANSWER:", text: JSON.stringify({ answer: "48시간 전까지 가능합니다.", sourceId: changed.resources[0].id, quote: "예약 취소는 시작 48시간 전까지 가능합니다." }), inputContains: ["48시간 전"], inputExcludes: ["24시간 전"] }] };
  const fresh = fixture(changed, scenario, cache);
  await executeRun(fresh.run, fresh.dependencies);
  assert.equal(fresh.run.status, "succeeded", fresh.run.error);
  assert.equal(fresh.embeddingCalls.length, 2, "Changed document must create a new index, plus query embedding");
  assert.equal(cache.size, 2);
  assert.ok(fresh.run.result.includes("48시간 전"));
  assert.ok(fresh.run.result.includes("2026-10-24"));
});

test("RAG citation validation follows remapped private resource IDs", async () => {
  const design = structuredClone(representativeRetrievalDesigns[0]);
  const oldId = design.resources[0].id, newId = "private-cancellation-copy";
  design.resources[0].id = newId;
  design.resources[0].ownerId = owner.userId;
  design.resources[0].visibility = "private";
  for (const node of design.definition.nodes) if (node.retrieval) node.retrieval.resourceIds = node.retrieval.resourceIds.map(id => id === oldId ? newId : id);
  const scenario = structuredClone(design.scenarios[0]);
  scenario.modelReplies![0].text = scenario.modelReplies![0].text!.replaceAll(oldId, newId);
  scenario.modelReplies![0].inputContains = scenario.modelReplies![0].inputContains!.map(value => value === oldId ? newId : value);
  const state = fixture(design, scenario);
  await executeRun(state.run, state.dependencies);
  assert.equal(state.run.status, "succeeded", state.run.error);
  assert.ok(state.run.result.includes(newId));
  assert.ok(!state.run.result.includes(oldId));
  assert.equal(state.run.checkpoint.outputs.source_valid.matched, true);
});
