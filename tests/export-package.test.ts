import test from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { type Identity, type Resource, type Workflow } from "../app/lib/model";
import { buildExportManifest, buildExportPackage, ExportPackageError, readExportRequest, type ExportConnection } from "../server/export-package";
import { parseAuthConfig } from "../server/auth/config";

const alice = { userId: "alice", email: "alice@example.com", displayName: "Alice" };
const bob = { userId: "bob", email: "bob@example.com", displayName: "Bob" };
const carol = { userId: "carol", email: "carol@example.com", displayName: "Carol" };
const date = "2026-10-21T00:00:00.000Z";
const resource: Resource = { id: "shared-mcp", ownerId: alice.userId, name: "공유 정의", type: "mcp", description: "조회 도구", content: "서비스 사용 안내", url: "https://tools.example.com/mcp", visibility: "selected", allowedEmails: [bob.email], createdAt: date, updatedAt: date };
const connection = (user: Identity): ExportConnection => ({ id: "own-service", ownerId: user.userId, resourceId: resource.id, name: "본인 연결", endpoint: resource.url, tokenEnv: "FLOWLY_MCP_TOKEN_OWN", tools: [
  { resourceId: resource.id, connectionId: "own-service", toolName: "lookup", name: "lookup", description: "조회", effect: "read", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
  { resourceId: resource.id, connectionId: "own-service", toolName: "unused_write", name: "unused_write", description: "선택 안 한 쓰기", effect: "write", inputSchema: { type: "object" } },
] });
const workflow = (): Workflow => ({ id: "flow", name: "내보내기 검증", description: "", updatedAt: date, definition: { schemaVersion: 2, nodes: [
  { id: "input", type: "input", title: "입력", x: 0, y: 0 },
  { id: "agent", type: "agent", title: "에이전트", x: 0, y: 100, prompt: "도구 결과를 답하세요.", allowedTools: [{ resourceId: resource.id, connectionId: "own-service", toolName: "lookup" }], inputBindings: { text: { nodeId: "input", path: "text" } } },
  { id: "output", type: "output", title: "답변", x: 0, y: 200, inputBindings: { text: { nodeId: "agent", path: "text" } } },
], edges: [{ id: "a", source: "input", target: "agent" }, { id: "b", source: "agent", target: "output" }] } });
const options = (user = alice) => ({ user, workflow: workflow(), connections: [connection(user)], resolveResources: async () => [structuredClone(resource)], exportedAt: date });
const hasStatus = (status: number) => (error: unknown) => error instanceof ExportPackageError && error.status === status;

test("export POST parsing rejects cross-origin, absent-origin, malformed and oversized UTF-8 input", async () => {
  const origin = "http://127.0.0.1:5173";
  const config = parseAuthConfig({ FLOWLY_AUTH_MODE: "test", FLOWLY_ENV: "test", FLOWLY_APP_ORIGIN: origin, FLOWLY_SESSION_SECRET: "a-test-only-secret-with-over-32-characters" });
  const request = (body: string, headers: Record<string, string> = {}) => new Request(`${origin}/api/export`, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body });
  const body = JSON.stringify({ workflow: workflow() });
  assert.equal((await readExportRequest(request(body), config)).language, "node");
  assert.equal((await readExportRequest(request(JSON.stringify({ workflow: workflow(), language: "python" })), config)).language, "python");
  const rejectedHeaders: Record<string, string>[] = [{ origin: "https://attacker.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "none" }];
  for (const headers of rejectedHeaders) await assert.rejects(readExportRequest(request(body, headers), config), hasStatus(403));
  const absentOrigin = request(body); absentOrigin.headers.delete("origin");
  await assert.rejects(readExportRequest(absentOrigin, config), hasStatus(403));
  await assert.rejects(readExportRequest(request(body, { "content-type": "text/plain" }), config), hasStatus(415));
  for (const invalid of ["{", "null", "[]", '{"language":"bash"}']) await assert.rejects(readExportRequest(request(invalid), config), hasStatus(400));
  const multibyte = JSON.stringify({ workflow: { name: "가".repeat(120_000) } });
  assert.ok(multibyte.length < 350_000);
  await assert.rejects(readExportRequest(request(multibyte), config), hasStatus(413));
});

test("export uses session owner, current server materials and only selected tool fields", async () => {
  const selected = connection(alice);
  Object.assign(selected, { token: "NEVER_EXPORT_SERVICE_TOKEN", arbitrary: "NEVER_EXPORT_CONNECTION_FIELD" });
  Object.assign(selected.tools[0], { token: "NEVER_EXPORT_TOOL_TOKEN" });
  const raw = Object.assign(workflow(), { ownerId: carol.userId, connections: [{ token: "NEVER_EXPORT_CLIENT_FIELD" }], resources: [{ content: "NEVER_EXPORT_CLIENT_RESOURCE" }] });
  const user = Object.assign({ ...alice }, { sessionSecret: "NEVER_EXPORT_SESSION_SECRET" });
  const manifest = await buildExportManifest({ ...options(), user, workflow: raw, connections: [selected], resolveResources: async (identity, ids) => {
    assert.equal(identity.userId, alice.userId); assert.deepEqual(ids, [resource.id]);
    return [resource, { ...resource, id: "unused", content: "NEVER_EXPORT_UNUSED_RESOURCE" }];
  } });
  assert.deepEqual(manifest.owner, alice);
  assert.equal(manifest.format, "flowly-executable-export"); assert.equal(manifest.language, "node");
  assert.equal(manifest.resources.length, 1); assert.equal(Object.hasOwn(manifest.resources[0], "allowedEmails"), false);
  assert.deepEqual(manifest.connections[0].tools.map(tool => tool.toolName), ["lookup"]);
  assert.equal(manifest.connections[0].tokenEnv, "FLOWLY_MCP_TOKEN_OWN");
  assert.doesNotMatch(JSON.stringify(manifest), /NEVER_EXPORT|bob@example\.com|unused_write/);
});

test("three users may export shared content but never another user's service connection", async () => {
  assert.equal((await buildExportManifest(options(alice))).owner.userId, alice.userId);
  assert.equal((await buildExportManifest(options(bob))).owner.userId, bob.userId);
  await assert.rejects(buildExportManifest(options(carol)), hasStatus(403));
  await assert.rejects(buildExportManifest({ ...options(bob), connections: [connection(alice)] }), hasStatus(403));
  await assert.rejects(buildExportManifest({ ...options(bob), connections: [] }), hasStatus(403));
});

test("each export rechecks revocation, disappearance, resource kind and exact tool binding", async () => {
  await buildExportManifest(options(bob));
  await assert.rejects(buildExportManifest({ ...options(bob), resolveResources: async () => [{ ...resource, visibility: "private" }] }), hasStatus(403));
  await assert.rejects(buildExportManifest({ ...options(bob), resolveResources: async () => [] }), hasStatus(403));
  await assert.rejects(buildExportManifest({ ...options(), resolveResources: async () => [{ ...resource, type: "document" }] }), /MCP/);
  const other = connection(alice); other.tools[0].resourceId = "wrong-resource";
  await assert.rejects(buildExportManifest({ ...options(), connections: [other] }), hasStatus(403));
});

test("test fixtures and invalid graphs cannot become a real executable package", async () => {
  for (const id of ["test-read", "test-write"]) {
    const flow = workflow(); flow.definition.nodes[1].allowedTools![0].connectionId = id;
    await assert.rejects(buildExportManifest({ ...options(), workflow: flow }), hasStatus(409));
  }
  const flow = workflow(); flow.definition.edges.push({ id: "cycle", source: "agent", target: "input" });
  await assert.rejects(buildExportManifest({ ...options(), workflow: flow }), hasStatus(400));
});

test("credential-bearing endpoints and unsafe env names are never serialized", async () => {
  for (const endpoint of ["https://user:secret@tools.example.com/mcp", "https://tools.example.com/mcp?token=secret", "ftp://mcp.internal/mcp", "https://host:65536/mcp", "http://host/mcp#fragment"]) {
    await assert.rejects(buildExportManifest({ ...options(), connections: [{ ...connection(alice), endpoint }] }), hasStatus(400));
  }
  for (const endpoint of ["http://mcp/mcp", "https://10.0.0.5:8443/mcp", "http://[::1]:8080/mcp"]) assert.equal((await buildExportManifest({ ...options(), connections: [{ ...connection(alice), endpoint }] })).connections[0].endpoint, endpoint);
  await assert.rejects(buildExportManifest({ ...options(), connections: [{ ...connection(alice), tokenEnv: "OPENAI_API_KEY" }] }), hasStatus(400));
});

test("Node and Python ZIPs contain one runner, empty local credentials and accurate recovery instructions", async () => {
  for (const language of ["node", "python"] as const) {
    const runner = language === "node" ? "runner.mjs" : "runner.py";
    const files = unzipSync(await buildExportPackage({ ...options(), language, runnerSource: "# synthetic test source; never executed" }));
    assert.deepEqual(Object.keys(files).sort(), [".env.example", ".gitignore", "README.md", "START_HERE.md", "AI_PROMPT.md", "AI_START.md", "CORE_TERMS.md", "RESOURCE_GUIDE.md", "PROJECT_FILES.json", "ROUNDTRIP.md", "project-check.py", "AGENTS.md", "WORKFLOW_GUIDE.md", "skills/flowly-workflow/SKILL.md", runner, "workflow.json"].sort());
    assert.match(strFromU8(files[".env.example"]), /OPENAI_API_KEY=\nFLOWLY_MODEL=gpt-5\.4-mini\nFLOWLY_MCP_TOKEN_OWN=\n$/);
    assert.match(strFromU8(files["README.md"]), /공유 철회가 이 파일에 적용되지 않습니다/);
    assert.match(strFromU8(files["README.md"]), /승인 또는 거절은 결정만 저장합니다/);
    assert.match(strFromU8(files["README.md"]), language === "node" ? /node runner\.mjs run --input/ : /python runner\.py run --input/);
    assert.match(strFromU8(files[".gitignore"]), /\.flowly-python-runs\//);
    assert.equal(JSON.parse(strFromU8(files["workflow.json"])).language, language);
  }
});

test("missing bundled runner and oversized material fail before returning a download", async () => {
  await assert.rejects(buildExportPackage({ ...options(), runnerSource: "" }), hasStatus(503));
  await assert.rejects(buildExportPackage({ ...options(), runnerSource: "source", resolveResources: async () => [{ ...resource, content: "a".repeat(8_000_000) }] }), hasStatus(413));
});
