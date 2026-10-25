import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import type { Resource, Workflow } from "../app/lib/model";
import { TEST_IDENTITIES } from "../server/auth/session";
import type { RuntimeCapabilities } from "../runtime/types";

const origin = "http://127.0.0.1:5173";
const post = (cookie: string, path: string, body: unknown) => fetch(origin + path, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) });
const login = async (identity: string) => {
  const response = await fetch(origin + "/api/auth/test", { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ identity, return_to: "/studio" }) });
  assert.equal(response.status, 303); return response.headers.get("set-cookie")!.split(";")[0];
};
const cookies = await Promise.all(["alice", "bob", "carol"].map(login));
let resource: Resource | undefined;
const metadata = { flowlyMcp: { version: 1, connectionId: "integration-internal-lookup", endpointEnv: "FLOWLY_MCP_ENDPOINT_INTERNAL_QA", tokenEnv: "FLOWLY_MCP_TOKEN_INTERNAL_QA", tools: [{ name: "internal_lookup", description: "사내 조회", effect: "read", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }] } };
const data = { type: "mcp", name: "검증용 사내 MCP · 자동 정리", description: "외부 연결 없는 CRUD/권한/ZIP 검증", url: "http://10.20.30.40:8090/mcp", content: JSON.stringify(metadata), visibility: "selected", allowedEmails: [TEST_IDENTITIES.bob.email], ownerId: TEST_IDENTITIES.carol.userId };
const capabilities = async (cookie: string) => {
  const response = await fetch(origin + "/api/runtime", { headers: { cookie } }); assert.equal(response.status, 200);
  return ((await response.json()) as {capabilities: RuntimeCapabilities}).capabilities;
};
try {
  const created = await post(cookies[0], "/api/studio", { action: "resource.create", data });
  assert.equal(created.status, 201, created.status === 201 ? "" : await created.text());
  resource = ((await created.json()) as {resource: Resource}).resource;
  assert.ok(resource); assert.equal(resource.ownerId, TEST_IDENTITIES.alice.userId);
  const workflow: Workflow = { id: "internal-qa", name: "사내 MCP 내보내기 검증", description: "", updatedAt: resource.updatedAt, definition: { schemaVersion: 5, nodes: [
    { id: "input", type: "input", title: "입력", x: 40, y: 40 },
    { id: "tool", type: "tool", title: "조회", x: 40, y: 220, allowedTools: [{ resourceId: resource.id, connectionId: metadata.flowlyMcp.connectionId, toolName: "internal_lookup" }], tool: { arguments: {}, bindings: { query: "text" } } },
    { id: "output", type: "output", title: "결과", x: 40, y: 400 },
  ], edges: [{ id: "a", source: "input", target: "tool" }, { id: "b", source: "tool", target: "output" }] } };
  for (let index = 0; index < cookies.length; index++) {
    const caps = await capabilities(cookies[index]);
    assert.equal(caps.liveEnabled, false);
    const connection = caps.connections.find((item: {resourceId: string}) => item.resourceId === resource!.id);
    assert.equal(Boolean(connection), index !== 2);
    if (connection) { assert.equal(connection.status, "unconfigured"); assert.equal(connection.tools[0].effect, "read"); }
  }
  for (const action of ["resource.update", "resource.delete"]) assert.equal((await post(cookies[1], "/api/studio", { action, id: resource.id, data, baseUpdatedAt: resource.updatedAt })).status, 404);
  for (const language of ["node", "python"]) {
    const response = await post(cookies[1], "/api/export", { workflow, language, connections: [{ endpoint: "https://untrusted.example/mcp" }] });
    assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const manifest = JSON.parse(strFromU8(files["workflow.json"]));
    assert.equal(manifest.owner.userId, TEST_IDENTITIES.bob.userId);
    assert.equal(manifest.connections[0].endpoint, data.url);
    assert.equal(manifest.connections[0].resourceId, resource.id);
    assert.equal(manifest.connections[0].tools[0].toolName, "internal_lookup");
    assert.equal(manifest.connections[0].tools[0].effect, "read");
    assert.ok(files[language === "node" ? "runner.mjs" : "runner.py"]);
    assert.ok(!files[".env"]); assert.match(strFromU8(files[".env.example"]), /^FLOWLY_MCP_TOKEN_INTERNAL_QA=\s*$/m);
    assert.doesNotMatch(strFromU8(files["workflow.json"]), /untrusted\.example/);
  }
  assert.equal((await post(cookies[2], "/api/export", { workflow, language: "node" })).status, 403);
  const revoked = await post(cookies[0], "/api/studio", { action: "resource.update", id: resource.id, data: { ...data, visibility: "private", allowedEmails: [] }, baseUpdatedAt: resource.updatedAt });
  assert.equal(revoked.status, 200); resource = ((await revoked.json()) as {resource: Resource}).resource;
  assert.ok(!(await capabilities(cookies[1])).connections.some((item: {resourceId: string}) => item.resourceId === resource!.id));
  for (const language of ["node", "python"]) assert.equal((await post(cookies[1], "/api/export", { workflow, language })).status, 403);
  for (const cookie of cookies) assert.equal((await post(cookie, "/api/runtime", { action: "run.start", mode: "live", workflow, input: "사내 조회", idempotencyKey: "internal-live-denied" })).status, 409);
  console.log("PASS: internal HTTP:port registration, three-user sharing/ownership, exact registered tools in both ZIPs, forged overrides ignored, revocation/capability refresh, web live denied. External OpenAI/MCP calls: 0.");
} finally {
  if (resource) assert.equal((await post(cookies[0], "/api/studio", { action: "resource.delete", id: resource.id })).status, 200);
}
