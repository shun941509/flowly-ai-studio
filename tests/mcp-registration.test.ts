import test from "node:test";
import assert from "node:assert/strict";
import { parseMcpAddress, readMcpRegistration, readLegacyMcpRegistration, serializeMcpRegistration, type McpRegistration } from "../domain/mcp-registration";
import { parseResource, sampleResources, templateWorkflow } from "../app/lib/model";
import { assertSchema } from "../domain/schema";

const registration = (): McpRegistration => ({ version: 1, connectionId: "company-search", endpointEnv: "FLOWLY_MCP_ENDPOINT_COMPANY", tools: [{ name: "search_documents", description: "회사 문서를 검색합니다.", effect: "read", inputSchema: { type: "object", properties: { query: { type: "string" }, options: { type: "object", properties: { limit: { type: "number" } }, required: ["limit"], additionalProperties: false } }, required: ["query"], additionalProperties: false } }] });
const read = (value: unknown, url = "") => readMcpRegistration({ type: "mcp", content: JSON.stringify({ flowlyMcp: value }), url });
const resourceInput = () => ({ name: "사내 검색", type: "mcp", description: "회사 서비스 연결", content: serializeMcpRegistration(registration()), url: "", visibility: "private", allowedEmails: [] });

test("MCP registration round trips as non-secret metadata and validates actual tool input", () => {
  const original = registration(), before = structuredClone(original);
  const content = serializeMcpRegistration(original);
  const parsed = readMcpRegistration({ type: "mcp", content, url: "http://documents.corp:8085/mcp" });
  assert.deepEqual(parsed, original);
  assert.deepEqual(original, before);
  assert.equal(Object.hasOwn(parsed!, "tokenEnv"), false);
  assertSchema({ query: "휴가 정책", options: { limit: 3 } }, parsed!.tools[0].inputSchema);
  assert.throws(() => assertSchema({ query: 42 }, parsed!.tools[0].inputSchema));
  assert.throws(() => assertSchema({ query: "휴가", options: {} }, parsed!.tools[0].inputSchema));
  assert.throws(() => assertSchema({ query: "휴가", unexpected: true }, parsed!.tools[0].inputSchema));
  const authenticated = { ...original, tokenEnv: "FLOWLY_MCP_TOKEN_COMPANY" };
  assert.deepEqual(read(authenticated), authenticated);
});

test("MCP addresses allow company hosts, private IPs and custom ports without contacting them", () => {
  for (const address of ["http://mcp.company.internal:8080/mcp", "http://10.0.0.8:3500/mcp", "http://localhost:3333/mcp", "https://127.0.0.1:4443/mcp", "http://[::1]:9000/mcp", "http://company-server/mcp", "https://mcp.example.com/mcp"]) {
    assert.equal(parseMcpAddress(address), address);
    assert.equal(read(registration(), address)?.connectionId, "company-search");
    assert.equal(parseResource({ ...resourceInput(), url: address }).url, address);
  }
  assert.equal(parseMcpAddress(""), "");
  assert.equal(parseResource(resourceInput()).url, "");
});

test("MCP addresses reject credentials, ambiguous URL syntax and embedded secrets", () => {
  for (const address of ["ftp://company/mcp", "file:///company/mcp", "http:company/mcp", "http:/company/mcp", "http://user:password@company/mcp", "http://@company/mcp", "http://company/mcp@token", "http://company:0/mcp", "http://company:65536/mcp", "http:\\company\\mcp", "http://company/mcp?token=secret", "http://company/mcp#secret", "http://company/\nmcp", "http://company/mcp path", "http://company/mcp\u00a0path", "https://company/sk-testSecretToken123456789", "https://company/Bearer%20token", "http://"]) {
    assert.throws(() => parseMcpAddress(address), `Accepted address: ${address}`);
    assert.throws(() => parseResource({ ...resourceInput(), url: address }), `Saved address: ${address}`);
  }
});

test("legacy resource descriptions remain readable and editable without claiming registration", () => {
  for (const content of ["기존 회사 MCP 사용 설명", "{broken legacy text", '{"instructions":"조회용"}', "[]", "null"]) {
    assert.equal(readMcpRegistration({ type: "mcp", content, url: "http://company:8080/mcp" }), null);
    const saved = parseResource({ ...resourceInput(), content, url: "http://company:8080/mcp" });
    assert.equal(saved.content, content);
    assert.throws(() => parseResource({ ...resourceInput(), content }));
  }
  assert.equal(readMcpRegistration({ type: "document", content: '{"flowlyMcp":', url: "" }), null);
});

test("recognized invalid MCP metadata cannot silently downgrade to a description", () => {
  for (const content of ['{"flowlyMcp":', '{"flowlyMcp":null}', '{"flowlyMcp":[]}', JSON.stringify({ flowlyMcp: registration(), token: "a-token-value" })]) {
    assert.throws(() => readMcpRegistration({ type: "mcp", content, url: "http://company/mcp" }));
    assert.throws(() => parseResource({ ...resourceInput(), content, url: "http://company/mcp" }));
  }
  for (const patch of [{ version: 2 }, { connectionId: "" }, { connectionId: "../company" }, { endpointEnv: "OPENAI_API_KEY" }, { endpointEnv: "FLOWLY_MCP_ENDPOINT_" }, { endpointEnv: "FLOWLY_MCP_ENDPOINT_company" }, { tokenEnv: "sk-not-an-environment-name" }, { tokenEnv: "" }, { token: "secret" }, { endpoint: "http://company/mcp" }]) {
    assert.throws(() => read({ ...registration(), ...patch }), `Accepted ${JSON.stringify(patch)}`);
  }
});

test("MCP tool contracts reject duplicates, unsupported schemas and ambiguous effects", () => {
  const tool = registration().tools[0];
  for (const tools of [[], Array.from({ length: 13 }, (_, index) => ({ ...tool, name: `tool_${index}` })), [tool, tool], [{ ...tool, name: "tool.with.dot" }], [{ ...tool, name: "x".repeat(65) }], [{ ...tool, effect: "maybe" }], [{ ...tool, token: "secret" }], [{ ...tool, inputSchema: { type: "array", items: { type: "string" } } }], [{ ...tool, inputSchema: { type: "object", properties: { q: { type: "string", enum: ["x"] } } } }], [{ ...tool, inputSchema: { type: "object", properties: {}, required: ["undeclared"] } }], [{ ...tool, inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q", "q"] } }], [{ ...tool, inputSchema: { type: "object", properties: { nested: { type: "object", properties: {}, required: ["unknown"] } } } }]]) {
    assert.throws(() => read({ ...registration(), tools }), `Accepted contract: ${JSON.stringify(tools)}`);
  }
  const write = read({ ...registration(), tools: [{ ...tool, effect: "write" }] });
  assert.equal(write?.tools[0].effect, "write");
});

test("MCP registrations preserve sharing semantics and strip client ownership claims", () => {
  const input = { ...resourceInput(), visibility: "selected", allowedEmails: ["  ALICE@example.test ", "alice@example.test", "bob@example.test"], ownerId: "another-owner", sample: true };
  const parsed = parseResource(input);
  assert.deepEqual(parsed.allowedEmails, ["alice@example.test", "bob@example.test"]);
  assert.equal(parsed.visibility, "selected");
  assert.equal(Object.hasOwn(parsed, "ownerId"), false);
  assert.equal(Object.hasOwn(parsed, "sample"), false);
  assert.throws(() => parseResource({ ...input, allowedEmails: [] }));
  assert.deepEqual(parseResource({ ...input, visibility: "private" }).allowedEmails, []);
  assert.deepEqual(parseResource({ ...input, visibility: "public" }).allowedEmails, []);
  assert.throws(() => parseResource({ ...resourceInput(), type: "document", url: "http://company/mcp" }));
});

test("three legacy showcase markers migrate explicitly while preserving remote contracts", () => {
  const expected = [
    { id: "showcase-knowledge", key: "KNOWLEDGE", name: "lookup_reference", effect: "read", fields: ["query"] },
    { id: "showcase-shipping", key: "SHIPPING", name: "lookup_shipment", effect: "read", fields: ["orderId"] },
    { id: "showcase-publishing", key: "PUBLISHING", name: "create_record", effect: "write", fields: ["title", "body"] },
  ];
  for (const contract of expected) {
    const resource = { type: "mcp" as const, url: "", content: JSON.stringify({ flowlyConnectionTemplate: contract.id, effect: "read", endpoint: "http://ignored.example.test/mcp" }) }, before = structuredClone(resource);
    assert.equal(readMcpRegistration(resource), null);
    const migrated = readLegacyMcpRegistration(resource)!;
    assert.ok(migrated);
    assert.equal(migrated.connectionId, contract.id);
    assert.equal(migrated.endpointEnv, `FLOWLY_MCP_ENDPOINT_${contract.key}`);
    assert.equal(migrated.tokenEnv, `FLOWLY_MCP_TOKEN_${contract.key}`);
    assert.equal(migrated.tools[0].name, contract.name);
    assert.equal(migrated.tools[0].effect, contract.effect);
    assert.deepEqual(migrated.tools[0].inputSchema.required, contract.fields);
    assert.deepEqual(readMcpRegistration({ ...resource, content: serializeMcpRegistration(migrated) }), migrated);
    assert.deepEqual(resource, before);
  }
  assert.equal(readLegacyMcpRegistration({ type: "mcp", content: '{"flowlyConnectionTemplate":"unknown"}', url: "" }), null);
});

test("company document starter has no public default and maps the user's actual document address", () => {
  const sample = sampleResources.find(item => item.id === "sample-openai-docs")!;
  assert.equal(sample.url, "");
  const registered = readMcpRegistration(sample)!;
  assert.equal(registered.endpointEnv, "FLOWLY_MCP_ENDPOINT_COMPANY_DOCS");
  assert.equal(registered.connectionId, "openai-docs");
  assert.equal(registered.tools[0].name, "fetch_openai_doc");
  for (const kind of ["docs-agent", "direct-tool"]) {
    const workflow = templateWorkflow(kind);
    assert.doesNotMatch(JSON.stringify(workflow), /developers\.openai\.com|https:\/\/platform\.openai\.com/);
    assert.match(workflow.name, /회사/);
    const toolNode = workflow.definition.nodes.find(node => node.type === "tool" || node.type === "agent")!;
    assert.equal(toolNode.allowedTools?.[0].resourceId, sample.id);
    assert.equal(toolNode.allowedTools?.[0].connectionId, registered.connectionId);
    assert.equal(toolNode.allowedTools?.[0].toolName, registered.tools[0].name);
    if (kind === "direct-tool") {
      assert.deepEqual(toolNode.tool?.bindings, { url: "text" });
      assert.deepEqual(toolNode.tool?.arguments, { anchor: "" });
    }
  }
});
