import test from "node:test";
import assert from "node:assert/strict";
import { systemsWorkflowDesigns } from "../domain/workflow-designs/systems-expansion";
import { createRun, decideReview, executeRun, publicRun } from "../runtime/engine";
import { runTree } from "../runtime/advanced";
import type { Json, RuntimeDependencies } from "../runtime/types";

// Fast control/state regression before the independent Node/Python ZIP CLI suite.
for (const design of systemsWorkflowDesigns) test(`system workflow witnesses: ${design.id}`, async () => {
  const stores = new Map<string, Map<string, Json>>();
  for (const [index, scenario] of design.scenarios.entries()) {
    const storeKey = scenario.stateGroup ?? String(index);
    const memory = stores.get(storeKey) ?? new Map<string, Json>(); stores.set(storeKey, memory);
    const deps: RuntimeDependencies = {
      model: { next: async () => { throw new Error("Model must not be called by these deterministic policies"); } },
      tools: [], callTool: async () => { throw new Error("No external tool is authorized"); },
      assertAccess: async () => {}, isCancelled: async () => false, save: async () => {},
      memory: async operation => {
        if (operation.action === "write") memory.set(operation.key, structuredClone(operation.value!));
        if (operation.action === "delete") memory.delete(operation.key);
        return { found: memory.has(operation.key), data: structuredClone(memory.get(operation.key) ?? operation.defaultValue ?? null) };
      },
    };
    const run = createRun({ owner: { userId: "witness", email: "witness@example.test", displayName: "검증" }, mode: "test", workflow: { id: design.id, name: design.title, description: design.description, updatedAt: "2026-10-23", definition: design.definition }, resources: design.resources, input: scenario.input });
    await executeRun(run, deps);
    if (run.status === "waiting_review" && scenario.review) {
      for (const review of publicRun(run).reviews!.filter(r => r.status === "pending")) await decideReview(run, review.id, "witness", scenario.review === "accept" ? "accepted" : "rejected");
      await executeRun(run, deps);
    }
    const message = `${design.id}/${scenario.name}: ${run.error ?? run.result}`;
    assert.equal(run.status, scenario.status, message);
    for (const part of scenario.contains ?? []) assert.ok(run.result.includes(part), message);
    const completed = new Set(runTree(run).flatMap(r => r.checkpoint.completed));
    const skipped = new Set(runTree(run).flatMap(r => r.checkpoint.skipped));
    for (const id of scenario.visited ?? []) assert.ok(completed.has(id), `${message} did not execute ${id}`);
    for (const id of scenario.skipped ?? []) assert.ok(skipped.has(id), `${message} did not skip ${id}`);
  }
});
