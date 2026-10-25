import test from "node:test";
import assert from "node:assert/strict";
import type { Resource } from "../app/lib/model";
import { parseKnowledgeConfig, type KnowledgeConfig } from "../domain/knowledge-config";
import { executeKnowledge, type KnowledgeContext } from "../runtime/knowledge";
import type { Json } from "../runtime/types";

const resource = (id: string, content: string): Resource => ({ id, name: id, type: "document", content, updatedAt: "v1", createdAt: "v1", ownerId: "alice", visibility: "private", allowedEmails: [], url: "", description: "" });
const resources = [resource("release", "release ready " + "a".repeat(186) + "second chunk"), resource("access", "access permissions")];
function fixture() {
  const records = new Map<string, Json>(); const embedded: string[][] = []; let sequence = 0; const denied = new Set<string>();
  const context: KnowledgeContext = { ownerId: "alice", workflowId: "one", operationId: "", resources, embeddingModel: "local-test-vector", assertAccess: async ids => { if (ids.some(id => denied.has(id))) throw Error("권한 없음"); },
    embed: async texts => { embedded.push(texts); return { vectors: texts.map(text => text.includes("release") ? [1, 0] : [0, 1]), model: "local-test-vector" }; },
    memory: async operation => { const key = `${operation.ownerId}/${operation.workflowId}/${operation.key}`; const prior = records.get(key); if (operation.action === "write") { assert.equal((prior as { revision?: number })?.revision ?? 0, operation.expectedRevision, "stale revision"); records.set(key, structuredClone(operation.value!)); } return { data: structuredClone(operation.action === "write" ? operation.value! : prior ?? null), found: operation.action === "write" || prior !== undefined }; },
  };
  const run = (action: KnowledgeConfig["action"], input: Record<string, Json> = {}, extra: Partial<KnowledgeConfig> = {}, operationId = `op${++sequence}`) => executeKnowledge({ action, indexKey: "library", resourceIds: resources.map(r => r.id), mode: "vector", ...extra }, input, { ...context, operationId });
  const stage = async (extra: Partial<KnowledgeConfig> = {}) => run("stage", {}, { chunkSize: 200, ...extra });
  const evaluate = async (generation: string, extra: Partial<KnowledgeConfig> = {}) => run("evaluate", { generation }, { generationPath: "generation", evaluation: [{ query: "release", resourceId: "release" }], ...extra });
  const publish = (generation: string) => run("publish", { generation }, { generationPath: "generation" });
  return { run, stage, evaluate, publish, context, records, embedded, denied };
}

test("knowledge incremental stage embeds only changed source chunks and switches after evaluation", async () => {
  const f = fixture(); const first = await f.stage({ mode: "vector" }); assert.equal(first.embeddedChunks, 3);
  await assert.rejects(f.run("query", { text: "release", generation: "g1" }, { generationPath: "generation" }), /발행/);
  await assert.rejects(f.publish("g1"), /평가/);
  await f.evaluate("g1"); await f.publish("g1");
  const calls = f.embedded.length;
  await assert.rejects(f.run("query", { text: "release" }, { mode: "lexical" }), /검색 방식/);
  assert.equal(f.embedded.length, calls);
  const query = await f.run("query", { text: "release" }); assert.equal(query.generation, "g1");
  const changed = await f.run("stage", { docs: [{ resourceId: "release", version: "v2", content: resources[0].content.slice(0, 200) + "updated chunk" }] }, { mode: "vector", chunkSize: 200, documentsPath: "docs" });
  assert.equal(changed.embeddedChunks, 1); assert.equal(changed.reusedChunks, 2); assert.equal(changed.publishedGeneration, "g1");
  assert.equal((await f.run("query", { text: "release" })).generation, "g1");
  await f.evaluate("g2"); await f.publish("g2");
  const repeated = await f.run("stage", { docs: [{ resourceId: "release", version: "v3", content: resources[0].content.slice(0, 200) + "updated chunk" }] }, { mode: "vector", chunkSize: 200, documentsPath: "docs" });
  assert.equal(repeated.embeddedChunks, 0); assert.equal(repeated.reusedChunks, 3);
  assert.deepEqual(f.embedded.find(texts => texts.includes("updated chunk")), ["updated chunk"]);
});

test("revoke purges every generation and vector; old-generation rollback needs fresh evaluation and cannot resurrect", async () => {
  const f = fixture(); await f.stage({ mode: "vector" }); await f.evaluate("g1"); await f.publish("g1");
  await f.stage({ mode: "vector" }); await f.evaluate("g2"); await f.publish("g2");
  await f.run("revoke", { ids: ["release"] }, { resourceIdsPath: "ids" });
  assert.equal((await f.run("query", { text: "release" })).count, 1);
  await assert.rejects(f.run("rollback", { generation: "g1" }, { generationPath: "generation" }), /평가/);
  await f.evaluate("g1", { evaluation: [{ query: "access", resourceId: "access" }] });
  await f.run("rollback", { generation: "g1" }, { generationPath: "generation" });
  const query = await f.run("query", { text: "release" }); assert.equal((query.matches as { resourceId: string }[])[0].resourceId, "access");
  assert.ok(!JSON.stringify([...f.records.values()]).includes("second chunk"));
  await assert.rejects(f.run("stage", { docs: [{ resourceId: "release", version: "v9", content: "resurrect" }] }, { documentsPath: "docs" }), /철회/);
});

test("mutation retry is idempotent, changed arguments and stale revisions fail before any new state", async () => {
  const f = fixture(); const config = { action: "stage", indexKey: "library", resourceIds: ["release"], mode: "vector" } as const;
  const c = { ...f.context, operationId: "same" };
  const first = await executeKnowledge({ ...config, resourceIds: [...config.resourceIds] }, {}, c);
  assert.deepEqual(await executeKnowledge({ ...config, resourceIds: [...config.resourceIds] }, {}, c), first); assert.equal(f.embedded.length, 1);
  await assert.rejects(executeKnowledge({ ...config, resourceIds: [...config.resourceIds] }, { different: true }, c), /입력/);
  await assert.rejects(f.run("stage", { revision: 0 }, { expectedRevisionPath: "revision" }), /리비전/);
  assert.equal((await f.run("inspect")).revision, 1);
});

test("owner/workflow namespaces, current access, vector model and candidate evaluation are enforced", async () => {
  const f = fixture(); await f.stage({ mode: "vector" }); await f.evaluate("g1"); await f.publish("g1");
  for (const changed of [{ ownerId: "bob" }, { workflowId: "other" }]) await assert.rejects(executeKnowledge({ action: "query", indexKey: "library", resourceIds: ["release"] }, { text: "release" }, { ...f.context, ...changed, operationId: "other" }), /색인 버전/);
  await assert.rejects(executeKnowledge({ action: "query", indexKey: "library", mode: "vector", resourceIds: ["release"] }, { text: "release" }, { ...f.context, embeddingModel: "changed", operationId: "model" }), /모델/);
  f.denied.add("release"); await assert.rejects(f.run("query", { text: "release" }), /권한/); f.denied.clear();
  await f.run("stage", { docs: [{ resourceId: "release", version: "v2", content: "no expected term" }] }, { documentsPath: "docs", mode: "lexical" });
  const evaluated = await f.evaluate("g2", { mode: "lexical" }); assert.equal(evaluated.passed, false); await assert.rejects(f.publish("g2"), /평가/);
});

test("knowledge parser rejects unsupported fields, arbitrary document IDs and oversized settings", async () => {
  for (const extra of [{ action: "exec" }, { indexKey: "__proto__" }, { topK: 11 }, { generationPath: "constructor.a" }, { action: "publish" }, { action: "evaluate", generationPath: "g" }, { code: "anything" }]) assert.throws(() => parseKnowledgeConfig({ action: "stage", indexKey: "test", resourceIds: ["release"], ...extra }));
  const f = fixture(); await assert.rejects(f.run("stage", { docs: [{ resourceId: "unknown", version: "v1", content: "hello" }] }, { documentsPath: "docs" }), /허용 ID/);
});

test("concurrent generation changes use compare-and-swap instead of overwriting a newer state", async () => {
  const f = fixture();
  const outcomes = await Promise.allSettled([f.stage(), f.stage()]);
  assert.equal(outcomes.filter(o => o.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(o => o.status === "rejected").length, 1);
  assert.equal((await f.run("inspect")).revision, 1);
});
