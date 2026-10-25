import test from "node:test";
import assert from "node:assert/strict";
import { parseDefinition, sampleResources, simulateFlow, templateWorkflow, type FlowNode } from "../app/lib/model";
import { allNodes, nodeRoutes } from "../domain/advanced-config";
import { compileDefinition, referencedResourceIds, resolveNodeInput } from "../domain/workflow";
import { inspectWorkflow } from "../domain/preflight";
import { buildExportManifest, type ExportConnection } from "../server/export-package";
import { parseExportManifest } from "../export-runtime/manifest";

const templates = ["parallel-work", "agent-team", "orchestrated-work", "repeat-items", "human-review", "classified-form", "reusable-work", "remember-value"];
test("eight advanced templates compile to v5 and retain nested definitions through JSON", () => {
  for (const kind of templates) {
    const d = compileDefinition(templateWorkflow(kind).definition);
    assert.equal(d.schemaVersion, 5, kind);
    assert.deepEqual(compileDefinition(JSON.parse(JSON.stringify(d))), d, kind);
    assert.ok(allNodes(d).length >= d.nodes.length);
  }
});
test("bounded nested DAG rejects excessive depth, aggregate nodes and unconnected inner mappings", () => {
  let d = templateWorkflow("reusable-work").definition;
  for (let i = 0; i < 3; i++) { const parent = templateWorkflow("reusable-work").definition; parent.nodes[1].subworkflow = { definition: d }; d = parent; }
  assert.throws(() => compileDefinition(d), /3단계/);
  const large = templateWorkflow("parallel-work").definition;
  const child = templateWorkflow("data-processing").definition;
  const middle = templateWorkflow("parallel-work").definition;
  middle.nodes[1].parallel!.tasks = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, name: `t${i}`, definition: child }));
  large.nodes[1].parallel!.tasks = Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, name: `p${i}`, definition: middle }));
  assert.throws(() => parseDefinition(large), /120/);
  const broken = templateWorkflow("reusable-work").definition;
  broken.nodes[1].subworkflow!.definition.nodes[1].inputBindings = { text: { nodeId: "output", path: "text" } };
  assert.throws(() => compileDefinition(broken), /직접 연결/);
});
test("new configuration rejects invalid keys, types, cross-node fields and missing required contracts", () => {
  const valid = templateWorkflow("remember-value").definition;
  for (const key of ["constructor", "__proto__", "1name", "a.b"]) {
    const d = structuredClone(valid); d.nodes[1].memory!.key = key;
    assert.throws(() => parseDefinition(d));
  }
  const missing = structuredClone(valid); delete missing.nodes[1].memory;
  assert.throws(() => compileDefinition(missing), /실행 설정/);
  const mismatch = structuredClone(valid); mismatch.nodes[1].review = { instructions: "", allowEdit: true, timeoutMinutes: 1 };
  assert.throws(() => parseDefinition(mismatch), /다른 종류/);
  const field = templateWorkflow("classified-form").definition.nodes[0];
  assert.throws(() => parseDefinition({ nodes: [{ ...field, form: { fields: [{ key: "x", label: "x", type: "boolean", required: "true" }] } }], edges: [] }));
  assert.throws(() => parseDefinition({ nodes: [{ ...field, form: { fields: [{ key: "x", label: "x", type: "select", required: true, options: ["같음", "같음"] }] } }], edges: [] }));
});
test("routing requires all declared destinations and excludes inactive predecessor values", () => {
  const d = compileDefinition(templateWorkflow("classified-form").definition);
  assert.deepEqual(nodeRoutes(d.nodes[1]), [{ id: "normal", label: "일반" }, { id: "urgent", label: "긴급" }]);
  assert.throws(() => compileDefinition({ ...d, edges: d.edges.filter(e => e.branch !== "urgent") }), /연결/);
  assert.deepEqual(resolveNodeInput(d, d.nodes[2], { classify: { text: "숨겨야 할 일반 결과" } }, [], {}, { classify: "urgent" }), {});
  assert.deepEqual(resolveNodeInput(d, d.nodes[3], { classify: { text: "긴급 결과" } }, [], {}, { classify: "urgent" }), { text: "긴급 결과" });
  for (const type of ["input", "form", "output", "condition", "review", "classify"] as const) {
    assert.throws(() => parseDefinition({ nodes: [{ id: "n", type, x: 0, y: 0, onError: "branch" }], edges: [] }), /오류 분기/);
  }
});
test("agent team requires actual agent work and missing child model configuration remains visible", () => {
  const team = templateWorkflow("agent-team");
  assert.equal(inspectWorkflow(team, []).requiresModel, true);
  team.definition.nodes[1].team!.tasks[0].definition = templateWorkflow("parallel-work").definition;
  assert.throws(() => compileDefinition(team.definition), /에이전트/);
  assert.equal(inspectWorkflow(templateWorkflow("reusable-work"), []).requiresModel, false);
  const childAI = templateWorkflow("reusable-work");
  childAI.definition.nodes[1].subworkflow!.definition = templateWorkflow("agent-team").definition;
  assert.equal(inspectWorkflow(childAI, []).requiresModel, true);
});
test("nested resource permissions are rechecked for owner, shared recipient, outsider and revocation", async () => {
  const alice = { userId: "alice", email: "alice@example.test", displayName: "A" }, bob = { userId: "bob", email: "bob@example.test", displayName: "B" }, carol = { userId: "carol", email: "carol@example.test", displayName: "C" };
  const doc = { ...sampleResources[0], id: "private-doc", ownerId: alice.userId, sample: false, visibility: "selected" as const, allowedEmails: [bob.email] };
  const flow = templateWorkflow("reusable-work");
  const child = templateWorkflow("rag").definition;
  child.nodes.find(n => n.type === "retrieval")!.retrieval!.resourceIds = [doc.id];
  flow.definition.nodes[1].subworkflow = { definition: child };
  assert.deepEqual(referencedResourceIds(flow.definition), [doc.id]);
  const exportAs = (user: typeof alice) => buildExportManifest({ user, workflow: flow, connections: [], resolveResources: async () => [doc] });
  assert.equal((await exportAs(alice)).resources[0].id, doc.id);
  assert.equal((await exportAs(bob)).resources[0].id, doc.id);
  await assert.rejects(exportAs(carol), /권한/);
  doc.allowedEmails = [];
  await assert.rejects(exportAs(bob), /권한/);
});
test("nested direct tool exports use current registered definitions without inheriting another user's connection", async () => {
  const user = { userId: "alice", email: "alice@example.test", displayName: "A" };
  const flow = templateWorkflow("reusable-work");
  flow.definition.nodes[1].subworkflow = { definition: templateWorkflow("direct-tool").definition };
  const connection: ExportConnection = { id: "openai-docs", ownerId: "other", resourceId: "sample-openai-docs", name: "Read", endpoint: "https://developers.openai.com/mcp", tools: [{ connectionId: "openai-docs", resourceId: "sample-openai-docs", toolName: "fetch_openai_doc", name: "fetch_openai_doc", effect: "read", description: "Read", inputSchema: { type: "object" } }] };
  const build = () => buildExportManifest({ user, workflow: flow, connections: [connection], resolveResources: async () => sampleResources });
  const manifest = await build(); assert.equal(manifest.connections.length, 1); assert.equal(manifest.resources.length, 1);
  assert.equal(manifest.connections[0].ownerId, user.userId);
  assert.equal(manifest.connections[0].endpointEnv, "FLOWLY_MCP_ENDPOINT_COMPANY_DOCS");
  assert.notEqual(manifest.connections[0].endpoint, connection.endpoint);
  assert.deepEqual(manifest.connections[0].tools[0].inputSchema.required, ["url", "anchor"]);
  flow.definition.nodes[1].subworkflow.definition = templateWorkflow("agent").definition;
  await assert.rejects(build(), /테스트 도구/);
  const inspection = inspectWorkflow(flow, sampleResources);
  assert.equal(inspection.issues.find(i => i.message.includes("테스트 전용"))?.nodeId, flow.definition.nodes[1].id);
});
test("review memory and classification defaults do not invent a text-only output contract", () => {
  const candidates: FlowNode[] = [templateWorkflow("human-review").definition.nodes[1], templateWorkflow("remember-value").definition.nodes[1], templateWorkflow("classified-form").definition.nodes[1]];
  for (const candidate of candidates) {
    const flow = templateWorkflow(candidate.type === "review" ? "human-review" : candidate.type === "memory" ? "remember-value" : "classified-form");
    assert.deepEqual(compileDefinition(flow.definition).nodes.find(n => n.type === candidate.type)!.outputSchema, { type: "object" });
  }
});
test("preview includes form starts and describes advanced execution without pretending to execute it", () => {
  const form = simulateFlow(templateWorkflow("classified-form"), "검사 입력", []);
  assert.equal(form.steps[0].status, "completed");
  assert.match(form.steps[1].detail, /모델을 호출하거나 실제 경로를 선택하지 않았/);
  assert.match(form.result, /AI가 생성한 답변이 아닙니다/);
  const nested = templateWorkflow("reusable-work"); nested.definition.nodes[1].subworkflow!.definition = templateWorkflow("rag").definition;
  const preview = simulateFlow(nested, "휴가", sampleResources);
  assert.match(preview.result, /팀 업무 가이드/);
  assert.match(preview.steps[1].detail, /내보낸 실행기/);
});
test("nested package resource limits reject before download and allow exactly one hundred resources", async () => {
  const user = { userId: "alice", email: "alice@example.test", displayName: "A" };
  const resources = Array.from({ length: 120 }, (_, i) => ({ ...sampleResources[0], id: `doc-${i}`, ownerId: user.userId, sample: false, type: "document" as const, visibility: "private" as const, allowedEmails: [] }));
  const flow = templateWorkflow("reusable-work");
  const child = templateWorkflow("blank").definition;
  const searches: FlowNode[] = Array.from({ length: 6 }, (_, i) => ({ id: `search-${i}`, type: "retrieval", title: `검색 ${i}`, x: 0, y: i * 100, retrieval: { resourceIds: resources.slice(i * 20, i * 20 + 20).map(r => r.id), topK: 3, chunkSize: 700 } }));
  child.nodes = [child.nodes[0], ...searches, child.nodes[1]];
  child.edges = child.nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: child.nodes[i].id, target: n.id }));
  flow.definition.nodes[1].subworkflow = { definition: child };
  const build = () => buildExportManifest({ user, workflow: flow, connections: [], resolveResources: async () => resources });
  assert.equal(inspectWorkflow(flow, resources).canExport, false);
  await assert.rejects(build(), /자료는 100개/);
  searches[5].retrieval!.resourceIds = searches[0].retrieval!.resourceIds;
  assert.equal(inspectWorkflow(flow, resources).canExport, true);
  const manifest = await build();
  assert.equal(manifest.resources.length, 100);
  assert.equal(parseExportManifest(manifest).resources.length, 100);
  assert.throws(() => parseExportManifest({ ...manifest, resources: [...manifest.resources, resources[100]] }), /자료 또는 연결/);
  assert.throws(() => parseExportManifest({ ...manifest, connections: Array.from({ length: 101 }, () => ({})) }), /자료 또는 연결/);
});
