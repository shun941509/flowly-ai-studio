import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIModelAdapter, createMcpToolCaller } from "../runtime/adapters";
import type { ToolDefinition } from "../runtime/types";
const tool: ToolDefinition = { resourceId: "mcp", connectionId: "connection", name: "lookup", toolName: "remote_lookup", description: "Read data", effect: "read", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } };
const signal = () => new AbortController().signal;
const options = () => ({ signal: signal(), idempotencyKey: "run:call:hash" });
const modelInput = () => ({ messages: [{ role: "user" as const, content: "찾아주세요" }], tools: [tool], maxTokens: 123, signal: signal() });
const request = (fn: (url: string, init: RequestInit) => Promise<Response>): typeof fetch => ((url, init) => fn(String(url), init ?? {})) as typeof fetch;

test("OpenAI uses fixed Responses endpoint, output cap, no persistence and explicit functions", async () => {
  const model = new OpenAIModelAdapter({ apiKey: "private-key", model: "configured-model", reasoningEffort: "none", fetch: request(async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses"); assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer private-key");
    const body = JSON.parse(String(init.body)); assert.equal(body.max_output_tokens, 123); assert.equal(body.store, false); assert.equal(body.parallel_tool_calls, false); assert.equal(body.model, "configured-model"); assert.equal(body.tools[0].strict, false); assert.equal(body.tools[0].name, "lookup");
    assert.ok(!String(init.body).includes("private-key"));
    assert.deepEqual(body.reasoning, { effort: "none" });
    return Response.json({ status: "completed", output: [{ type: "function_call", name: "lookup", arguments: '{"query":"서울"}', call_id: "provider-call" }], usage: { total_tokens: 37 } });
  }) });
  const reply = await model.next(modelInput()); assert.deepEqual(reply, { kind: "tool", toolName: "lookup", args: { query: "서울" }, callId: "provider-call", usageTokens: 37 });
});
test("OpenAI function observations are correlated without saving reasoning text", async () => {
  const model = new OpenAIModelAdapter({ apiKey: "private-key", model: "configured-model", fetch: request(async (_url, init) => {
    const body = JSON.parse(String(init.body)); assert.equal(body.input[1].type, "function_call"); assert.equal(body.input[2].type, "function_call_output"); assert.equal(body.input[1].call_id, body.input[2].call_id); assert.equal(body.input[2].output, "actual tool output");
    return Response.json({ status: "completed", output: [{ type: "reasoning", summary: [{ text: "private reasoning" }] }, { type: "message", content: [{ type: "output_text", text: "final private-key" }] }], usage: { total_tokens: 8 } });
  }) });
  const reply = await model.next({ ...modelInput(), messages: [{ role: "user", content: "질문" }, { role: "assistant", content: "", callId: "stable", toolName: "lookup", args: { query: "query" } }, { role: "tool", content: "actual tool output", callId: "stable", toolName: "lookup" }] });
  assert.equal(reply.kind, "answer"); assert.doesNotMatch(JSON.stringify(reply), /private-key|private reasoning/);
});
test("provider errors, missing usage and parallel calls fail closed without leaking body", async () => {
  for (const response of [new Response("credential=private-key", { status: 401 }), Response.json({ status: "completed", output: [] }), Response.json({ status: "completed", output: [{ type: "function_call" }, { type: "function_call" }], usage: { total_tokens: 1 } })]) {
    const model = new OpenAIModelAdapter({ apiKey: "private-key", model: "configured-model", fetch: request(async () => response) });
    await assert.rejects(model.next(modelInput()), error => error instanceof Error && !error.message.includes("private-key"));
  }
});
test("MCP initializes, carries session/version, and only calls exact server-owned endpoint", async () => {
  const methods: string[] = []; let sawSecret = false;
  const caller = createMcpToolCaller([{ id: "connection", endpoint: "https://tools.example.com/mcp", token: "connection-secret" }], request(async (url, init) => {
    assert.equal(url, "https://tools.example.com/mcp"); assert.equal(init.redirect, "error");
    const body = JSON.parse(String(init.body)); methods.push(body.method); const headers = new Headers(init.headers);
    assert.equal(headers.get("MCP-Protocol-Version"), "2025-11-25"); assert.match(headers.get("Accept")!, /application\/json, text\/event-stream/); assert.equal(headers.get("Authorization"), "Bearer connection-secret"); sawSecret ||= String(init.body).includes("connection-secret");
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } } }, { headers: { "Mcp-Session-Id": "session-1" } });
    assert.equal(headers.get("Mcp-Session-Id"), "session-1");
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    assert.deepEqual(body.params, { name: "remote_lookup", arguments: { query: "서울" } });
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "서울 connection-secret" }] } });
  }));
  const result = await caller(tool, { query: "서울" }, options());
  assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/call"]); assert.equal(sawSecret, false); assert.doesNotMatch(JSON.stringify(result), /connection-secret/); assert.match(JSON.stringify(result), /서울/);
});
test("MCP SSE tolerates notifications and split CRLF and matches response id", async () => {
  const caller = createMcpToolCaller([{ id: "connection", endpoint: "https://tools.example.com/mcp" }], request(async (_url, init) => {
    const body = JSON.parse(String(init.body));
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const payload = `data: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "SSE 결과" }] } })}\r\n\r\n`;
    const bytes = new TextEncoder().encode(payload);
    return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
  }));
  assert.match(JSON.stringify(await caller(tool, { query: "test" }, options())), /SSE 결과/);
});
test("MCP disallows unconfigured or malformed endpoints and credential URLs", async () => {
  for (const endpoint of ["ftp://tools.internal/mcp", "https://user:pass@tools.example.com/mcp", "https://@tools.internal/mcp", "http://host:65536/mcp", "http://host:0/mcp", "https://tools.example.com/mcp?token=secret", "https://tools.example.com/mcp#fragment", "http://host name/mcp"]) assert.throws(() => createMcpToolCaller([{ id: "connection", endpoint }]));
  let requests = 0; const caller = createMcpToolCaller([], request(async () => { requests++; throw new Error("network must not run"); }));
  await assert.rejects(caller(tool, { query: "test" }, options())); assert.equal(requests, 0);
});

test("MCP dispatches HTTP and HTTPS internal DNS, private IPv4, IPv6 and custom ports exactly", async () => {
  for (const endpoint of ["http://mcp/mcp", "http://127.0.0.1:8080/mcp", "https://10.0.0.4:8443/mcp", "https://[::1]:9443/mcp", "https://docs.internal/mcp"]) {
    const methods: string[] = [];
    const caller = createMcpToolCaller([{ id: "connection", endpoint, token: "local-token" }], request(async (url, init) => {
      assert.equal(url, endpoint); assert.equal(init.redirect, "error");
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer local-token");
      const body = JSON.parse(String(init.body)); methods.push(body.method);
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} } } : { structuredContent: { found: true } } });
    }));
    assert.deepEqual(await caller(tool, { query: "query" }, options()), { structuredContent: { found: true } });
    assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/call"]);
  }
});
test("MCP rejects incompatible protocol, wrong RPC id and tool errors", async () => {
  for (const mode of ["protocol", "rpc", "tool"]) {
    const caller = createMcpToolCaller([{ id: "connection", endpoint: "https://tools.example.com/mcp" }], request(async (_url, init) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: mode === "protocol" ? "unsupported" : "2025-11-25", capabilities: { tools: {} } } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: mode === "rpc" ? "wrong" : body.id, result: { isError: true, content: [{ text: "provider-secret" }] } });
    }));
    await assert.rejects(caller(tool, { query: "test" }, options()), error => error instanceof Error && !error.message.includes("provider-secret"));
  }
});

test("MCP checks absolute deadline even before an AbortSignal timer has fired", async () => {
  let requests = 0;
  const caller = createMcpToolCaller([{ id: "connection", endpoint: "https://tools.example.com/mcp" }], request(async () => { requests++; throw new Error("must not send"); }));
  await assert.rejects(caller(tool, { query: "test" }, { ...options(), deadlineAt: Date.now() - 1 }), /허용 시간/);
  assert.equal(requests, 0);
});
