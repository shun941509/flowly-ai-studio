import test from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { parseResource, type Identity, type Resource, type Workflow } from "../app/lib/model";
import { buildExportManifest, buildExportPackage, ExportPackageError } from "../server/export-package";
import { registeredConnections } from "../server/example-connections";
import { exportConnectionsFor } from "../server/connections";
import { checkPackage } from "../export-runtime/diagnostics";

const owner: Identity = { userId: "owner", email: "owner@company.test", displayName: "Owner" };
const recipient: Identity = { userId: "recipient", email: "recipient@company.test", displayName: "Recipient" };
const other: Identity = { userId: "other", email: "other@company.test", displayName: "Other" };
const date = "2026-10-23T00:00:00.000Z";
const definition = {
  version: 1, connectionId: "company-knowledge", endpointEnv: "FLOWLY_MCP_ENDPOINT_COMPANY", tokenEnv: "FLOWLY_MCP_TOKEN_COMPANY",
  tools: [{ name: "lookup_policy", description: "사내 규정 조회", effect: "read", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
    { name: "create_policy", description: "사내 규정 등록", effect: "write", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }],
};
const material = (): Resource => ({ id: "company-resource", ownerId: owner.userId, createdAt: date, updatedAt: date,
  ...parseResource({ name: "사내 규정 MCP", type: "mcp", description: "사내 등록 연결", url: "http://10.20.30.40:8090/mcp", visibility: "selected", allowedEmails: [recipient.email], content: JSON.stringify({ flowlyMcp: definition }) }) });
function flow(resource: Resource, toolName = "lookup_policy"): Workflow {
  return { id: "registered-flow", name: "사내 조회", description: "", updatedAt: date, definition: { schemaVersion: 5, nodes: [
    { id: "input", type: "input", title: "입력", x: 0, y: 0 },
    { id: "tool", type: "tool", title: "사내 도구", x: 0, y: 180, allowedTools: [{ resourceId: resource.id, connectionId: definition.connectionId, toolName }], tool: { arguments: {}, bindings: { query: "text" } } },
    { id: "output", type: "output", title: "출력", x: 0, y: 360 },
  ], edges: [{ id: "a", source: "input", target: "tool" }, { id: "b", source: "tool", target: "output" }] } };
}
function options(resource = material(), user = recipient) { return { user, workflow: flow(resource), connections: [], resolveResources: async () => [resource] }; }

test("registered resources supply exact tools for both export languages without server secrets or public defaults", async () => {
  assert.deepEqual(exportConnectionsFor(owner, { FLOWLY_CONNECTIONS_JSON: "invalid legacy config", OPENAI_API_KEY: "NOT_A_REAL_KEY" }), []);
  for (const language of ["node", "python"] as const) {
    const files = unzipSync(await buildExportPackage({ ...options(), language, runnerSource: "// fixture source; no calls" }));
    const manifest = JSON.parse(strFromU8(files["workflow.json"]));
    assert.equal(manifest.connections.length, 1);
    const c = manifest.connections[0];
    assert.equal(c.ownerId, recipient.userId);
    assert.equal(c.endpoint, material().url);
    assert.equal(c.endpointEnv, definition.endpointEnv);
    assert.deepEqual(c.tools.map((t: {toolName: string}) => t.toolName), ["lookup_policy"]);
    if (language === "node") {
      assert.equal(checkPackage(manifest, {}).status, "unconfigured");
      assert.equal(checkPackage(manifest, { FLOWLY_MCP_ENDPOINT_COMPANY: "http://mcp.intranet:8090/mcp", FLOWLY_MCP_TOKEN_COMPANY: "synthetic-only" }).status, "ready");
    }
    assert.match(strFromU8(files[".env.example"]), /^FLOWLY_MCP_TOKEN_COMPANY=\s*$/m);
    assert.match(strFromU8(files["README.md"]), /도구 및 자료/);
    assert.ok(!files[".env"]);
    assert.ok(!("allowedEmails" in manifest.resources[0]));
    assert.doesNotMatch(JSON.stringify(manifest), /developers\.openai\.com/);
  }
});

test("MCP definitions follow three-user sharing, revocation, and exact registered tool selection", async () => {
  const resource = material();
  assert.equal(registeredConnections(owner, [resource]).length, 1);
  assert.equal(registeredConnections(recipient, [resource]).length, 1);
  assert.deepEqual(registeredConnections(other, [resource]), []);
  await buildExportManifest(options(resource, owner));
  await buildExportManifest(options(resource, recipient));
  await assert.rejects(buildExportManifest(options(resource, other)), (error: unknown) => error instanceof ExportPackageError && error.status === 403);
  await assert.rejects(buildExportManifest(options({ ...resource, visibility: "private" })), /권한|철회/);
  const forged = flow(resource, "unregistered_tool");
  await assert.rejects(buildExportManifest({ ...options(), workflow: forged }), /도구 및 자료/);
  const write = await buildExportManifest({ ...options(), workflow: flow(resource, "create_policy") });
  assert.equal(write.connections[0].tools[0].effect, "write");
  assert.equal(write.connections[0].tools[0].supportsIdempotency, false);
});

test("current registrations override old server effect/schema and free text does not grant a connection", async () => {
  const resource = material(), legacy = registeredConnections(recipient, [resource]);
  legacy[0].tools.find(tool => tool.toolName === "create_policy")!.effect = "read";
  const manifest = await buildExportManifest({ ...options(), workflow: flow(resource, "create_policy"), connections: legacy });
  assert.equal(manifest.connections[0].tools[0].effect, "write");
  const freeText = { ...resource, content: "사내 자료 이용 안내" };
  assert.deepEqual(registeredConnections(recipient, [freeText]), []);
  await assert.rejects(buildExportManifest(options(freeText)), /도구 및 자료/);
});
