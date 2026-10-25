import test from "node:test";
import assert from "node:assert/strict";
import type { PublicRun } from "../runtime/types";
import { resolveScenarioInputs } from "./workflow-export-integration";

const waiting = (): PublicRun => ({
  id: "same-run", mode: "live", status: "waiting_input", input: "request", result: "", createdAt: "", updatedAt: "",
  limits: { maxTurns: 10, maxToolCalls: 10, maxTokens: 1000, maxDurationMs: 10000 }, workflowId: "workflow", workflowName: "workflow",
  approvals: [], usage: { turns: 1, toolCalls: 0, tokens: 30, activeMs: 15 },
  events: [{ sequence: 1, at: "", type: "node_completed", message: "policy retained", nodeId: "policy_search" }],
  inputRequests: [{ id: "input-request", runId: "same-run", nodeId: "request_order", userId: "test", inputHash: "input", configHash: "config", input: {}, expiresAt: "", status: "pending", instructions: "주문번호", fields: [{ key: "orderId", label: "주문번호", type: "text", required: true }] }],
});

test("supplemental scenario uses durable CLI status, rejects bad values and submits before the same run resumes", async () => {
  let current = waiting(); const calls: string[][] = [], files: Record<string, unknown>[] = [];
  const run = await resolveScenarioInputs(current, { name: "supplement", input: "", status: "succeeded", inputSubmissions: [{ nodeId: "request_order", values: { orderId: "S101" }, invalidValues: [{}], repeat: true }] }, async args => {
    calls.push(args);
    if (args[0] === "submit" && args.at(-1) === "values-0.json") throw new Error("필수 입력 누락");
    if (args[0] === "submit") current = { ...current, status: "queued", inputRequests: current.inputRequests!.map(request => ({ ...request, status: "submitted", output: { text: '{"orderId":"S101"}', data: { orderId: "S101" } } })) };
    if (args[0] === "resume") current = { ...current, status: "succeeded", result: "S101", usage: { ...current.usage, toolCalls: 1 } };
    return structuredClone(current);
  }, async values => { files.push(values); return `values-${files.length - 1}.json`; });
  assert.equal(run.id, "same-run"); assert.equal(run.status, "succeeded"); assert.deepEqual(files, [{}, { orderId: "S101" }]);
  assert.deepEqual(calls.map(args => args[0]), ["status", "submit", "status", "submit", "submit", "resume"]);
  assert.ok(calls.every(args => args[1] === "same-run"));
});

test("supplemental scenario rejects a wait that was not persisted", async () => {
  await assert.rejects(resolveScenarioInputs(waiting(), { name: "lost wait", input: "", status: "succeeded", inputSubmissions: [{ nodeId: "request_order", values: { orderId: "S101" } }] }, async () => ({ ...waiting(), status: "succeeded" }), async () => "values.json"), /wait was not persisted/);
});

test("supplemental scenario detects replay of a previously completed worker", async () => {
  let current = waiting();
  await assert.rejects(resolveScenarioInputs(current, { name: "replayed", input: "", status: "succeeded", inputSubmissions: [{ nodeId: "request_order", values: { orderId: "S101" } }] }, async args => {
    if (args[0] === "submit") current = { ...current, status: "queued", inputRequests: current.inputRequests!.map(request => ({ ...request, status: "submitted" })) };
    if (args[0] === "resume") current = { ...current, status: "succeeded", events: [...current.events, { ...current.events[0], sequence: 2 }] };
    return structuredClone(current);
  }, async () => "values.json"), /resumed work was replayed/);
});
