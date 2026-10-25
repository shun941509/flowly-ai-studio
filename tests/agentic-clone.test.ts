import test from "node:test";
import assert from "node:assert/strict";
import { agenticExpansionWorkflowDesigns } from "../domain/workflow-designs/agentic-expansion";
import { compileDefinition } from "../domain/workflow";
import { getExample, instantiateExample } from "../server/example-catalog";
import { createRun, executeRun } from "../runtime/engine";
import type { RuntimeDependencies } from "../runtime/types";

// Deterministic responses at the model adapter boundary. No API, keys or network.
const owner = { userId: "clone-regression-user", email: "clone@example.test", displayName: "복사 회귀 검사" };
const authored = agenticExpansionWorkflowDesigns.find(design => design.id === "rag-citation-id-repair")!;

function project() {
  const published = getExample(authored.id);
  assert.ok(published, "The executable example must be published before clone tests run");
  return {
    ...published,
    resources: structuredClone(authored.resources),
    workflow: { ...published.workflow, definition: compileDefinition(authored.definition) },
  };
}

for (const path of ["direct", "instantiated"] as const) {
  for (const response of ["correct", "repair", "unresolved"] as const) {
    test(`citation IDs use retrieved resources: ${path}/${response}`, async () => {
      const source = project();
      const selected = path === "instantiated" ? instantiateExample(source, owner) : source;
      const originalId = source.resources[0].id, retrievedId = selected.resources[0].id;
      if (path === "instantiated") {
        assert.notEqual(retrievedId, originalId);
        assert.equal(selected.resources[0].ownerId, owner.userId);
        assert.equal(selected.resources[0].visibility, "private");
        assert.equal(source.resources[0].id, originalId, "Copying must preserve the source resource");
      }
      const run = createRun({ owner, mode: "test", workflow: selected.workflow, resources: selected.resources, input: "회의실 예약 취소" });
      const calls: string[] = [];
      const wrongId = path === "instantiated" ? originalId : "unregistered-document";
      const deps: RuntimeDependencies = {
        tools: [], save: async () => {}, assertAccess: async () => {}, isCancelled: async () => false,
        callTool: async () => { throw new Error("External tools are forbidden in this test"); },
        model: { next: async ({ messages }) => {
          const payload = JSON.parse(messages.find(message => message.role === "user")!.content);
          const input = payload.input;
          const isRepair = JSON.stringify(payload).includes("CITE_REPAIR:");
          calls.push(isRepair ? "repair" : "draft");
          if (isRepair) {
            assert.equal(input.matches[0].resourceId, retrievedId);
            assert.ok(input.evidence.includes(`출처: ${retrievedId}`));
            assert.ok(input.evidence.includes("회의실 예약은 시작 10분 전까지"));
            assert.equal(input.data.sourceId, wrongId);
          } else {
            assert.ok(input.text.includes(`출처: ${retrievedId}`));
          }
          const sourceId = response === "correct" || (response === "repair" && isRepair) ? retrievedId : wrongId;
          return { kind: "answer", text: JSON.stringify({ answer: "테스트 응답: 시작 10분 전까지 취소", sourceId }), usageTokens: 1 };
        } },
      };
      await executeRun(run, deps);
      assert.equal(run.status, "succeeded", run.error);
      assert.equal((run.checkpoint.outputs.search.matches as { resourceId: string }[])[0].resourceId, retrievedId);
      assert.equal(run.checkpoint.outputs.valid.matched, response === "correct");
      if (response === "correct") {
        assert.deepEqual(calls, ["draft"]);
        assert.ok(run.checkpoint.completed.includes("direct"));
        assert.ok(run.checkpoint.skipped.includes("repair"));
      } else {
        assert.deepEqual(calls, ["draft", "repair"]);
        assert.equal(run.checkpoint.outputs.revalid.matched, response === "repair");
        assert.ok(run.checkpoint.completed.includes(response === "repair" ? "repaired" : "failure"));
      }
      if (response === "unresolved") {
        assert.ok(run.result.includes("답변을 보류"));
        assert.ok(!run.result.includes("테스트 응답"));
      } else assert.ok(run.result.includes("테스트 응답: 시작 10분 전까지 취소"));
    });
  }
}
