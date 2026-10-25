import test from "node:test";
import assert from "node:assert/strict";
import { connectionsFor, requireCurrentTool, runtimeCapabilities, testRuntimeEnabled, testTools, type ServerEnvironment } from "../server/connections";

const a = { userId: "a", email: "a@example.com", displayName: "A" };
const b = { userId: "b", email: "b@example.com", displayName: "B" };
const c = { userId: "c", email: "c@example.com", displayName: "C" };
const definition = { id: "owned-connection", ownerId: a.userId, resourceId: "public-mcp-definition", name: "연결", endpoint: "https://tools.example.com/mcp", tokenEnv: "FLOWLY_MCP_TOKEN_A", tools: [{ toolName: "remote_lookup", name: "lookup", effect: "read", description: "조회", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }] };
const environment = (overrides: ServerEnvironment = {}): ServerEnvironment => ({ FLOWLY_CONNECTIONS_JSON: JSON.stringify([definition]), FLOWLY_MCP_TOKEN_A: "credential-private-to-A", OPENAI_API_KEY: "model-private-key", FLOWLY_MODEL: "configured-model", ...overrides });

test("shared public MCP definition never shares its owner's connection or credentials", () => {
  const env = environment(); const tool = connectionsFor(a, env)[0].tools[0];
  assert.equal(connectionsFor(a, env).length, 1);
  for (const user of [b, c]) {
    assert.deepEqual(connectionsFor(user, env), []); assert.deepEqual(runtimeCapabilities(user, env).connections, []);
    assert.throws(() => requireCurrentTool(user, env, "live", tool), /권한/);
  }
  assert.doesNotThrow(() => requireCurrentTool(a, env, "live", tool));
  assert.doesNotMatch(JSON.stringify(runtimeCapabilities(a, env)), /credential-private-to-A|model-private-key|FLOWLY_MCP_TOKEN_A|tools\.example/);
});

test("web live execution stays disabled even if a server happens to contain model credentials", () => {
  for (const env of [environment(), environment({ OPENAI_API_KEY: undefined, FLOWLY_MODEL: undefined })]) {
    const capabilities = runtimeCapabilities(a, env);
    assert.equal(capabilities.liveEnabled, false); assert.match(capabilities.liveReason, /내보낸 뒤 본인의 API 키/);
    assert.doesNotMatch(JSON.stringify(capabilities), /model-private-key|credential-private-to-A/);
  }
});
test("service connection must bind resource id, connection id, function name and server policy", () => {
  const env = environment(); const tool = connectionsFor(a, env)[0].tools[0];
  for (const patch of [{ resourceId: "other-resource" }, { connectionId: "other-connection" }, { toolName: "delete" }, { name: "delete" }, { effect: "write" as const }, { inputSchema: { type: "object" as const } }]) assert.throws(() => requireCurrentTool(a, env, "live", { ...tool, ...patch }));
  const changed = environment({ FLOWLY_CONNECTIONS_JSON: JSON.stringify([{ ...definition, tools: [{ ...definition.tools[0], effect: "write", annotations: { readOnlyHint: true } }] }]) });
  assert.equal(connectionsFor(a, changed)[0].tools[0].effect, "write"); assert.throws(() => requireCurrentTool(a, changed, "live", tool));
});
test("missing credentials and removed connections fail closed without live fallback", () => {
  const tool = connectionsFor(a, environment())[0].tools[0];
  const env = environment({ FLOWLY_MCP_TOKEN_A: undefined, OPENAI_API_KEY: undefined });
  const caps = runtimeCapabilities(a, env); assert.equal(caps.liveEnabled, false); assert.deepEqual(caps.connections, []);
  assert.throws(() => requireCurrentTool(a, env, "live", tool), /연결 필요/);
  assert.throws(() => requireCurrentTool(a, environment({ FLOWLY_CONNECTIONS_JSON: "[]" }), "live", tool));
  assert.throws(() => requireCurrentTool(a, environment(), "live", testTools[0]));
});
test("test runtime requires explicit development test-auth flags", () => {
  const configured = { FLOWLY_ENV: "development", FLOWLY_AUTH_MODE: "test", FLOWLY_TEST_RUNTIME: "true" };
  assert.equal(testRuntimeEnabled(configured), true);
  for (const patch of [{ FLOWLY_ENV: "production" }, { FLOWLY_AUTH_MODE: "oidc" }, { FLOWLY_TEST_RUNTIME: "false" }]) {
    const env = { ...configured, ...patch }; assert.equal(testRuntimeEnabled(env), false);
    assert.throws(() => requireCurrentTool(a, env, "test", testTools[0]));
  }
  assert.doesNotThrow(() => requireCurrentTool(a, configured, "test", testTools[0]));
});
test("connection config allows internal destinations but rejects invalid URLs, duplicate names and weakened schemas", () => {
  for (const endpoint of ["http://mcp/mcp", "https://10.0.0.5:8443/mcp", "http://[::1]:8080/mcp", "https://mcp.internal/mcp"]) assert.equal(connectionsFor(a, environment({ FLOWLY_CONNECTIONS_JSON: JSON.stringify([{ ...definition, endpoint }]) }))[0].endpoint, endpoint);
  for (const endpoint of ["ftp://tools.internal/mcp", "https://user:secret@tools.example.com/mcp", "https://@host/mcp", "https://host/mcp#fragment", "https://tools.example.com/mcp?token=secret", "https://host:65536/mcp", "http://host name/mcp"]) assert.throws(() => connectionsFor(a, environment({ FLOWLY_CONNECTIONS_JSON: JSON.stringify([{ ...definition, endpoint }]) })));
  assert.throws(() => connectionsFor(a, environment({ FLOWLY_CONNECTIONS_JSON: JSON.stringify([definition, definition]) })), /중복/);
  assert.throws(() => connectionsFor(a, environment({ FLOWLY_CONNECTIONS_JSON: JSON.stringify([{ ...definition, tokenEnv: "OPENAI_API_KEY" }]) })), /비밀/);
  assert.throws(() => connectionsFor(a, environment({ FLOWLY_CONNECTIONS_JSON: JSON.stringify([{ ...definition, tools: [{ ...definition.tools[0], inputSchema: { type: "object", oneOf: [] } }] }]) })), /스키마/);
});
