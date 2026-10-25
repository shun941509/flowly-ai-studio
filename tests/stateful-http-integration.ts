/** Local HTTP/D1 verification of stateful exports and knowledge resource permissions. */
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { allNodes } from "../domain/advanced-config";
import { nodeRequiresModel } from "../domain/extended-config";
import { compileDefinition } from "../domain/workflow";
import { ragLifecycleDesigns } from "../domain/workflow-designs/rag-lifecycle";
import { dynamicAgentDesigns } from "../domain/workflow-designs/dynamic-agents";
import { candidateSearchDesigns } from "../domain/workflow-designs/candidate-search";
import type { Resource, Workflow } from "../app/lib/model";
import type { ExportManifest } from "../server/export-package";
import type { RuntimeCapabilities } from "../runtime/types";

const origin = "http://127.0.0.1:5173";
const cookies: Record<string, string> = {};
const created: { workflowId: string; resources: string[] }[] = [];
const designs = [...ragLifecycleDesigns, ...dynamicAgentDesigns, ...candidateSearchDesigns];
const post = (user: string, path: string, body: unknown, source = origin) => fetch(origin + path, { method: "POST", headers: { cookie: cookies[user], origin: source, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
async function workspace(user: string) {
  const response = await fetch(origin + "/api/studio", { headers: { cookie: cookies[user] }, signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as { resources: Resource[]; workflows: Workflow[] };
}
async function filesFrom(response: Response) {
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get("content-type") ?? "", /application\/zip/);
  return unzipSync(new Uint8Array(await response.arrayBuffer()));
}
const resourceData = (r: Resource, visibility: Resource["visibility"], allowedEmails: string[]) => ({ name: r.name, type: r.type, description: r.description, content: r.content, url: r.url, visibility, allowedEmails });
async function share(resource: Resource, visibility: Resource["visibility"], allowedEmails: string[]) {
  const response = await post("alice", "/api/studio", { action: "resource.update", id: resource.id, baseUpdatedAt: resource.updatedAt, data: resourceData(resource, visibility, allowedEmails) });
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as { resource: Resource }).resource;
}

try {
  assert.equal((await fetch(origin + "/api/examples", { headers: { "x-chatgpt-user-id": "test:alice" } })).status, 401);
  for (const user of ["alice", "bob", "carol"]) {
    const response = await fetch(origin + "/api/auth/test", { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ identity: user, return_to: "/studio" }), signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 303); cookies[user] = response.headers.get("set-cookie")!.split(";")[0];
    await workspace(user);
  }
  assert.equal((await post("alice", "/api/examples", { action: "download-project", id: designs[0].id, language: "python" }, "https://untrusted.example")).status, 403);
  console.log("PASS 1: authenticated local sessions and same-origin checks guard stateful example exports");

  assert.equal(designs.length, 6);
  for (const design of designs) for (const language of ["node", "python"] as const) {
    const files = await filesFrom(await post("alice", "/api/examples", { action: "download-project", id: design.id, language, ownerId: "forged", apiKey: "must-not-be-exported" }));
    const manifest = JSON.parse(strFromU8(files["workflow.json"])) as ExportManifest;
    const contract = JSON.parse(strFromU8(files["example-contract.json"]));
    assert.equal(manifest.owner.userId, "test:alice"); assert.equal(manifest.language, language);
    assert.deepEqual(manifest.workflow.definition, compileDefinition(design.definition));
    assert.equal(contract.id, design.id); assert.equal(contract.liveVerified, false);
    assert.equal(manifest.connections.length, 0);
    assert.ok(files[language === "node" ? "runner.mjs" : "runner.py"]);
    assert.ok(!files[".env"] && !Object.keys(files).some(path => /scenario|preload|boundary/.test(path)));
    assert.ok(!strFromU8(files["workflow.json"]).includes("must-not-be-exported"));
    for (const path of ["START_HERE.md", "AI_PROMPT.md", "AGENTS.md", "WORKFLOW_GUIDE.md", "skills/flowly-workflow/SKILL.md"]) assert.ok(files[path]?.length, `${design.id}: missing ${path}`);
    assert.match(strFromU8(files["AGENTS.md"]), /웹에서는 OpenAI를 호출하지/);
    assert.match(strFromU8(files["START_HERE.md"]), /\.env/);
    const nodes = allNodes(manifest.workflow.definition);
    if (nodes.some(nodeRequiresModel)) assert.match(strFromU8(files[".env.example"]), /^OPENAI_API_KEY=\s*$/m);
    else assert.ok(!strFromU8(files[".env.example"]).includes("OPENAI_API_KEY="));
    const expected = { knowledge: nodes.some(n => n.type === "knowledge"), dynamic: nodes.some(n => n.orchestration?.mode === "dynamic"), search: nodes.some(n => n.type === "candidate_search") };
    for (const [helper, needed] of Object.entries(expected)) assert.equal(Boolean(files[`flowly_${helper}.py`]), language === "python" && needed, `${design.id}/${language} helper ${helper}`);
    const guide = strFromU8(files["WORKFLOW_GUIDE.md"]);
    if (expected.knowledge) assert.ok(guide.includes('"knowledge"') && guide.includes('"indexKey"'));
    if (expected.dynamic) assert.ok(guide.includes('"dynamic"') && guide.includes('"maxAgents"'));
    if (expected.search) assert.ok(guide.includes('"search"') && guide.includes('"maxCandidates"'));
    if (design.id === "p3-rag-incremental") assert.match(strFromU8(files["START_HERE.md"]), /FLOWLY_EMBEDDING_MODEL/);
  }
  console.log("PASS 2: six designs download twelve exact-graph ZIPs with required Python helpers, AI documents and empty credentials");

  for (const design of designs) {
    const response = await post("alice", "/api/runtime", { action: "run.start", mode: "live", workflow: { id: design.id, name: design.title, definition: design.definition }, input: design.inputExample, idempotencyKey: crypto.randomUUID() });
    assert.equal(response.status, 409); const rejected = await response.json() as { error: string; run?: unknown };
    assert.match(rejected.error, /웹에서는 OpenAI를 호출하지/); assert.equal(rejected.run, undefined);
  }
  for (const user of ["alice", "bob", "carol"]) {
    const response = await fetch(origin + "/api/runtime", { headers: { cookie: cookies[user] } }); assert.equal(response.status, 200);
    const payload = await response.json() as { capabilities: RuntimeCapabilities }; assert.equal(payload.capabilities.liveEnabled, false);
  }
  console.log("PASS 3: all six complete web live requests stop before execution; every user's live capability remains disabled");

  const original = ragLifecycleDesigns[0];
  const clonedResponse = await post("alice", "/api/examples", { action: "instantiate", id: original.id, ownerId: "test:bob" });
  assert.equal(clonedResponse.status, 201, await clonedResponse.clone().text());
  const copy = await clonedResponse.json() as { workflow: Workflow; resources: Resource[] };
  created.push({ workflowId: copy.workflow.id, resources: copy.resources.map(r => r.id) });
  assert.equal(copy.resources.length, original.resources.length); assert.notEqual(copy.workflow.id, original.id);
  const copiedIds = new Set(copy.resources.map(r => r.id));
  assert.ok(copy.resources.every(r => r.ownerId === "test:alice" && r.visibility === "private" && !r.sample && !original.resources.some(old => old.id === r.id)));
  for (const node of allNodes(copy.workflow.definition).filter(n => n.knowledge)) {
    assert.ok(node.knowledge!.resourceIds.every(id => copiedIds.has(id)));
    assert.ok(node.knowledge!.evaluation?.every(sample => copiedIds.has(sample.resourceId)) ?? true);
  }
  for (const user of ["bob", "carol"]) {
    const visible = await workspace(user); assert.ok(!visible.workflows.some(w => w.id === copy.workflow.id));
    assert.ok(!visible.resources.some(r => copiedIds.has(r.id)));
    for (const language of ["node", "python"]) assert.equal((await post(user, "/api/export", { workflow: copy.workflow, language, ownerId: "test:alice" })).status, 403);
  }
  console.log("PASS 4: RAG instantiation remaps private document and evaluation IDs; forged ownership cannot export them");

  let current = copy.resources;
  for (const resource of current) for (const user of ["bob", "carol"]) {
    assert.equal((await post(user, "/api/studio", { action: "resource.update", id: resource.id, baseUpdatedAt: resource.updatedAt, ownerId: "test:alice", data: { ...resourceData(resource, "public", []), content: "forged content" } })).status, 404);
    assert.equal((await post(user, "/api/studio", { action: "resource.delete", id: resource.id, ownerId: "test:alice" })).status, 404);
  }
  const retained = await workspace("alice"); for (const resource of current) assert.equal(retained.resources.find(r => r.id === resource.id)?.content, resource.content);
  console.log("PASS 5: resource ID knowledge and forged body ownership do not allow another user to edit or delete originals");

  current = await Promise.all(current.map(resource => share(resource, "selected", ["bob@flowly.test"])));
  assert.ok((await workspace("bob")).resources.filter(r => copiedIds.has(r.id)).length === current.length);
  assert.ok(!(await workspace("carol")).resources.some(r => copiedIds.has(r.id)));
  for (const language of ["node", "python"] as const) {
    const files = await filesFrom(await post("bob", "/api/export", { workflow: copy.workflow, language }));
    const manifest = JSON.parse(strFromU8(files["workflow.json"])) as ExportManifest;
    assert.equal(manifest.owner.userId, "test:bob"); assert.deepEqual(manifest.resources.map(r => r.id).sort(), [...copiedIds].sort());
    assert.ok(manifest.resources.every(r => !("allowedEmails" in r))); assert.equal(manifest.connections.length, 0);
    assert.equal((await post("carol", "/api/export", { workflow: copy.workflow, language })).status, 403);
  }
  console.log("PASS 6: selected sharing allows Bob to export the knowledge graph in both languages while Carol is denied");

  current = await Promise.all(current.map(resource => share(resource, "public", [])));
  for (const language of ["node", "python"]) await filesFrom(await post("carol", "/api/export", { workflow: copy.workflow, language }));
  assert.equal((await post("bob", "/api/studio", { action: "resource.delete", id: current[0].id })).status, 404);
  assert.equal((await post("carol", "/api/studio", { action: "resource.update", id: current[0].id, baseUpdatedAt: current[0].updatedAt, data: resourceData(current[0], "private", []) })).status, 404);
  console.log("PASS 7: all-user sharing enables Carol's exports while both recipients remain unable to modify the original");

  current = await Promise.all(current.map(resource => share(resource, "private", [])));
  for (const user of ["bob", "carol"]) for (const language of ["node", "python"]) assert.equal((await post(user, "/api/export", { workflow: copy.workflow, language })).status, 403);
  for (const language of ["node", "python"]) await filesFrom(await post("alice", "/api/export", { workflow: copy.workflow, language }));
  console.log("PASS 8: sharing revocation blocks all new recipient exports but preserves owner access; downloaded copies are not remotely recalled");
  console.log("PASS 8 local HTTP/D1 groups. OpenAI calls: 0. Remote MCP calls: 0. No service credentials read or supplied.");
} finally {
  for (const copy of created) {
    const deleted = await post("alice", "/api/studio", { action: "workflow.delete", id: copy.workflowId }); assert.equal(deleted.status, 200, await deleted.clone().text());
    for (const id of copy.resources) { const removed = await post("alice", "/api/studio", { action: "resource.delete", id }); assert.equal(removed.status, 200, await removed.clone().text()); }
  }
}
