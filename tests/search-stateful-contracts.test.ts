import test from "node:test";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import type { FlowNode, Resource, Workflow } from "../app/lib/model";
import type { ExampleProject } from "../domain/example-types";
import { allNodes } from "../domain/advanced-config";
import { parseSearchConfig } from "../domain/search-config";
import type { KnowledgeConfig } from "../domain/knowledge-config";
import { buildExportManifest, buildExportPackage } from "../server/export-package";
import { instantiateExample } from "../server/example-catalog";
import { checkPackage } from "../export-runtime/diagnostics";

const owner = { userId: "stateful-contract", email: "stateful@example.test", displayName: "상태 계약" };
const document: Resource = { id: "original-source", ownerId: "source-owner", name: "내부 기술 자료", type: "document", content: "배포 전에 백업을 확인합니다.", description: "합성 자료", url: "", visibility: "public", allowedEmails: [], createdAt: "2026-10-24", updatedAt: "2026-10-24" };
const n = (id: string, type: FlowNode["type"], extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title: id, x: 0, y: 0, ...extra });
function workflow(node: FlowNode): Workflow { return { id: "stateful-config", name: "상태 계약 검사", description: "", updatedAt: "2026-10-24", definition: { schemaVersion: 5, nodes: [n("input", "input"), node, n("output", "output")], edges: [{ id: "a", source: "input", target: node.id }, { id: "b", source: node.id, target: "output" }] } }; }
const knowledge = (mode: "lexical" | "vector", action: KnowledgeConfig["action"] = "stage") => n("knowledge", "knowledge", { knowledge: { action, indexKey: "company_docs", resourceIds: [document.id], mode } });

test("cloning nested knowledge settings remaps evaluation targets to private copied resources", () => {
  const child = workflow(n("evaluation", "knowledge", { knowledge: { action: "evaluate", indexKey: "company_docs", resourceIds: [document.id], generationPath: "generation", evaluation: [{ query: "배포 백업", resourceId: document.id }] } })).definition;
  const source: ExampleProject = { id: "stateful-example", title: "상태 예제", description: "", category: "test", frameworks: ["Flowly"], tags: [], nodeTypes: ["input", "subworkflow", "knowledge", "output"], status: "setup_required", uniqueBehavior: "", verification: { schema: true, node: false, python: false, live: false }, inputExample: "", expectedOutput: "", requirements: [], variants: [], acceptance: [], failureCases: [], sourceLicense: "직접 작성", workflow: workflow(n("nested", "subworkflow", { subworkflow: { definition: child } })), resources: [document] };
  const copy = instantiateExample(source, owner), id = copy.resources[0].id;
  assert.notEqual(id, document.id); assert.equal(copy.resources[0].visibility, "private"); assert.equal(copy.resources[0].ownerId, owner.userId);
  const config = allNodes(copy.workflow.definition).find(node => node.knowledge)!.knowledge!;
  assert.deepEqual(config.resourceIds, [id]); assert.equal(config.evaluation![0].resourceId, id);
  assert.equal(allNodes(source.workflow.definition).find(node => node.knowledge)!.knowledge!.evaluation![0].resourceId, document.id);
});

test("embedding-only knowledge requires a key while candidate search also requires a response model", async () => {
  const cases = [
    { node: knowledge("lexical"), env: [] },
    { node: knowledge("vector"), env: ["OPENAI_API_KEY"] },
    { node: knowledge("vector", "inspect"), env: [] },
    { node: n("search", "candidate_search", { search: parseSearchConfig({}) }), env: ["FLOWLY_MODEL", "OPENAI_API_KEY"] },
  ];
  for (const item of cases) {
    const manifest = await buildExportManifest({ user: owner, workflow: workflow(item.node), connections: [], resolveResources: async () => item.node.knowledge ? [document] : [], language: "node" });
    const result = checkPackage(manifest, {}); assert.equal(result.status, item.env.length ? "unconfigured" : "ready", JSON.stringify(result)); assert.deepEqual(result.missingEnv, item.env);
    const keyOnly = checkPackage(manifest, { OPENAI_API_KEY: "synthetic-isolated-configuration-value" });
    assert.equal(keyOnly.status, item.env.includes("FLOWLY_MODEL") ? "unconfigured" : "ready");
  }
});

test("Python stateful ZIPs fail closed without their required helper and include exact settings in AI guides", async () => {
  for (const item of [knowledge("lexical"), n("search", "candidate_search", { search: parseSearchConfig({ mode: "graph", beamWidth: 3 }) })]) {
    const options = { user: owner, workflow: workflow(item), connections: [], resolveResources: async () => item.knowledge ? [document] : [], language: "python" as const, runnerSource: "# Test fixture for export composition only; never executed." };
    await assert.rejects(buildExportPackage(options), /실행 도우미/);
    const files = unzipSync(await buildExportPackage({ ...options, helpers: { files: "", triggers: "", requirements: "", search: "# helper fixture", knowledge: "# helper fixture" } }));
    assert.equal(Boolean(files["flowly_search.py"]), item.type === "candidate_search"); assert.equal(Boolean(files["flowly_knowledge.py"]), item.type === "knowledge");
    assert.match(strFromU8(files["WORKFLOW_GUIDE.md"]), item.knowledge ? /company_docs/ : /"beamWidth": 3/);
    assert.ok(!files[".env"]);
  }
});
