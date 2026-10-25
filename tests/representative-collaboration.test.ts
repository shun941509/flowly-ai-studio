import test from "node:test";
import assert from "node:assert/strict";
import { representativeCollaborationDesigns } from "../domain/workflow-designs/representative-collaboration";
import { createRun, decideReview, executeRun, publicRun } from "../runtime/engine";
import { runTree } from "../runtime/advanced";
import type { Json, RuntimeDependencies } from "../runtime/types";
import type { WorkflowDesign, WorkflowScenario } from "../domain/workflow-design";

// Only model replies are fixtures. The real compiler, scheduler, state handling,
// schemas, bindings and review/resume engine run without credentials or network.
async function exercise(design: WorkflowDesign, scenario: WorkflowScenario, failMatch?: string) {
  const owner = { userId: "representative-collaboration-test", email: "collaboration@example.test", displayName: "협업 검증" };
  let active = 0, peak = 0;
  const used: string[] = [], payloads = new Map<string, Record<string, Json>>();
  const replies = scenario.modelReplies ?? [];
  const deps: RuntimeDependencies = {
    tools: [], save: async () => {}, assertAccess: async () => {}, isCancelled: async () => false,
    callTool: async () => { throw new Error("No external tool is authorized in these examples"); },
    model: { next: async ({ messages }) => {
      const payload = JSON.parse(messages.find(message => message.role === "user")!.content);
      const reply = replies.find(candidate => payload.instruction.includes(candidate.match));
      assert.ok(reply, `Unexpected model instruction: ${payload.instruction}`);
      assert.ok(!used.includes(reply.match), `Duplicate call: ${reply.match}`);
      used.push(reply.match); payloads.set(reply.match, payload.input);
      const serialized = JSON.stringify(payload.input);
      for (const fragment of reply.inputContains ?? []) assert.ok(serialized.includes(fragment), `${reply.match} missing actual input ${fragment}: ${serialized}`);
      for (const fragment of reply.inputExcludes ?? []) assert.ok(!serialized.includes(fragment), `${reply.match} leaked ${fragment}`);
      active++; peak = Math.max(peak, active);
      try {
        // The scheduler must enter all three adapters before any reply resolves.
        await new Promise(resolve => setTimeout(resolve, reply.match.startsWith("SHOWCASE_PROPOSAL_") && reply.match !== "SHOWCASE_PROPOSAL_SYNTHESIS:" ? 40 : 1));
        if (reply.match === failMatch) throw new Error("Synthetic model transport failure; no request was sent");
        assert.equal(typeof reply.text, "string");
        return { kind: "answer", text: reply.text!, usageTokens: 1 };
      } finally { active--; }
    } },
  };
  const run = createRun({ owner, mode: "test", workflow: { id: design.id, name: design.title, description: design.description, updatedAt: "2026-10-23", definition: design.definition }, resources: design.resources, input: scenario.input });
  await executeRun(run, deps);
  if (run.status === "waiting_review" && scenario.review) {
    const pending = publicRun(run).reviews!.filter(review => review.status === "pending");
    assert.equal(pending.length, 1);
    const input = pending[0].input;
    assert.ok(String(input.sources).includes("안내 A"));
    assert.ok(String(input.text).includes("예약은 무료"));
    assert.ok(String(input.unresolved).includes("이용료 정보"));
    assert.ok(String(input.originalIssues).includes("무료 예약과 무료 이용"));
    await decideReview(run, pending[0].id, owner.userId, scenario.review === "accept" ? "accepted" : "rejected");
    await executeRun(run, deps);
  }
  return { run, used, peak, payloads };
}

function assertSubset(actual: Record<string, Json>, expected: Record<string, Json>, label: string) {
  for (const [key, value] of Object.entries(expected)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      assert.ok(actual[key] && typeof actual[key] === "object" && !Array.isArray(actual[key]), label);
      assertSubset(actual[key] as Record<string, Json>, value, `${label}.${key}`);
    } else assert.deepEqual(actual[key], value, `${label}.${key}`);
  }
}

for (const design of representativeCollaborationDesigns) {
  for (const scenario of design.scenarios) test(`${design.id}: ${scenario.name}`, async () => {
    const { run, used, peak } = await exercise(design, scenario);
    const context = `${scenario.name}: ${run.error ?? run.result}`;
    assert.equal(run.status, scenario.status, context);
    for (const fragment of scenario.contains ?? []) assert.ok(run.result.includes(fragment), `${context} lacks ${fragment}`);
    for (const fragment of scenario.excludes ?? []) assert.ok(!run.result.includes(fragment), `${context} includes ${fragment}`);
    const tree = runTree(run), completed = new Set(tree.flatMap(current => current.checkpoint.completed)), skipped = new Set(tree.flatMap(current => current.checkpoint.skipped));
    for (const id of scenario.visited ?? []) assert.ok(completed.has(id), `${context} did not execute ${id}`);
    for (const id of scenario.skipped ?? []) assert.ok(skipped.has(id), `${context} did not skip ${id}`);
    for (const [id, expected] of Object.entries(scenario.outputs ?? {})) {
      const output = tree.map(current => current.checkpoint.outputs[id]).find(Boolean);
      assert.ok(output, `${context} missing ${id}`); assertSubset(output, expected, id);
    }
    assert.deepEqual(new Set(used), new Set(scenario.modelReplies?.map(reply => reply.match) ?? []), `${context} did not execute exactly the expected model roles`);
    if (design.id === "showcase-parallel-proposal") assert.equal(peak, 3, "Three independent reviewers must overlap");
    else assert.equal(peak, used.length ? 1 : 0, "Editorial roles must run sequentially");
  });
}

test("parallel transport failure preserves two completed mandatory reviews and never calls synthesis", async () => {
  const design = representativeCollaborationDesigns[0], original = design.scenarios[0];
  const scenario = { ...original, modelReplies: original.modelReplies!.slice(0, 3) };
  const { run, used, peak } = await exercise(design, scenario, "SHOWCASE_PROPOSAL_TECHNICAL:");
  assert.equal(run.status, "succeeded", run.error);
  assert.equal(peak, 3);
  assert.ok(run.result.includes("종합 판정을 보류"));
  assert.ok(run.result.includes("수요 확인 필요"));
  assert.ok(run.result.includes("운영 보완 필요"));
  assert.ok(run.result.includes('"role":"기술"'));
  assert.ok(!used.includes("SHOWCASE_PROPOSAL_SYNTHESIS:"));
  assert.equal(run.checkpoint.groups!.proposal_reviews.children.every(child => child.status === "succeeded"), true);
});
