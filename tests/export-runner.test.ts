import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { templateWorkflow, sampleResources } from "../app/lib/model";
import { parseExportManifest, type ExportManifest } from "../export-runtime/manifest";
import { runCommand } from "../export-runtime/runner";
import { FileRunStore } from "../export-runtime/store";
import type { PublicRun, RuntimeDependencies, ToolDefinition } from "../runtime/types";
import { OpenAIModelAdapter } from "../runtime/adapters/openai";
import { createMcpToolCaller } from "../runtime/adapters/mcp";
import { checkPackage, renderRunReport, type CheckResult } from "../export-runtime/diagnostics";

const owner = { userId: "exporter", email: "exporter@example.com", displayName: "내보낸 사용자" };
const tool: ToolDefinition = { resourceId: "sample-search", connectionId: "owned-mcp", toolName: "lookup", name: "lookup", description: "허용된 공개 읽기", effect: "read", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } };
function manifest(effect: "read" | "write" = "read"): ExportManifest {
  const workflow = templateWorkflow("agent"); workflow.definition.nodes.find(n => n.type === "agent")!.allowedTools = [tool];
  const { allowedEmails: _, ...resource } = sampleResources.find(r => r.id === "sample-search")!; void _;
  return { format: "flowly-executable-export", version: 1, language: "node", exportedAt: new Date().toISOString(), owner, workflow, resources: [resource], connections: [{ id: "owned-mcp", ownerId: owner.userId, resourceId: tool.resourceId, name: "공식 읽기 서비스", endpoint: "https://tools.example.com/mcp", tools: [{ ...tool, effect }] }] };
}
async function fixture(value = manifest()) {
  const directory = await mkdtemp(join(tmpdir(), "flowly-export-test-"));
  const packagePath = join(directory, "workflow.json"), stateDirectory = join(directory, "runs");
  await writeFile(packagePath, JSON.stringify(value));
  return { directory, packagePath, stateDirectory, async cleanup() { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); } };
}
function adapters(onCall: () => void = () => {}): Pick<RuntimeDependencies, "model" | "callTool"> {
  return { model: { async next({ messages }) {
    const observation = messages.find(m => m.role === "tool");
    if (observation) return { kind: "answer", text: observation.content, usageTokens: 40 };
    return { kind: "tool", toolName: tool.name, callId: "provider-call", args: { query: "실제 입력 확인" }, usageTokens: 30 };
  } }, callTool: async (_tool, args) => { onCall(); return { text: `도구가 받은 값: ${args.query}` }; } };
}

test("export runner persists live-mode input/tool output without loading a test fallback", async () => {
  const f = await fixture(); let calls = 0;
  try {
    const result = await runCommand({ action: "run", input: "질문" }, { ...f, adapters: adapters(() => calls++) }) as PublicRun;
    assert.equal(result.mode, "live"); assert.equal(result.status, "succeeded"); assert.equal(calls, 1); assert.match(result.result, /도구가 받은 값/);
    const state = JSON.parse(await readFile(join(f.stateDirectory, `${result.id}.json`), "utf8"));
    assert.equal(state.run.checkpoint.calls[0].status, "completed"); assert.equal(state.run.checkpoint.calls[0].args.query, "실제 입력 확인");
    await runCommand({ action: "resume", runId: result.id }, { ...f, adapters: adapters(() => calls++) }); assert.equal(calls, 1);
    assert.ok(!(await readdir(f.stateDirectory)).some(name => name.endsWith(".tmp") || name.endsWith(".lock")));
  } finally { await f.cleanup(); }
});

test("export runner composes real Responses and MCP adapters across two model turns using mock HTTP only", async () => {
  const f = await fixture(); let modelRequests = 0; const mcpMethods: string[] = [];
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url) === "https://api.openai.com/v1/responses") {
      modelRequests++; assert.equal(body.model, "gpt-5.4-mini"); assert.deepEqual(body.reasoning, { effort: "none" }); assert.equal(body.store, false);
      if (modelRequests === 1) return Response.json({ status: "completed", usage: { total_tokens: 31 }, output: [{ type: "function_call", name: "lookup", call_id: "provider-owned-id", arguments: '{"query":"실제 입력 확인"}' }] });
      assert.equal(body.input[1].type, "function_call"); assert.equal(body.input[2].type, "function_call_output"); assert.equal(body.input[1].call_id, body.input[2].call_id);
      assert.equal(JSON.parse(body.input[2].output).content[0].text, "MCP에서 읽은 자료");
      return Response.json({ status: "completed", usage: { total_tokens: 49 }, output: [{ type: "message", content: [{ type: "output_text", text: "읽은 자료에 근거한 한국어 답변" }] }] });
    }
    assert.equal(String(url), "https://tools.example.com/mcp"); mcpMethods.push(body.method);
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    assert.equal(body.params.name, "lookup"); assert.deepEqual(body.params.arguments, { query: "실제 입력 확인" });
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "MCP에서 읽은 자료" }] } });
  }) as typeof fetch;
  try {
    const result = await runCommand({ action: "run", input: "입력" }, { ...f, adapters: { model: new OpenAIModelAdapter({ apiKey: "mock-http-only-key", model: "gpt-5.4-mini", reasoningEffort: "none", fetch: request }), callTool: createMcpToolCaller([{ id: "owned-mcp", endpoint: "https://tools.example.com/mcp" }], request) } }) as PublicRun;
    assert.equal(result.status, "succeeded"); assert.equal(result.usage.tokens, 80); assert.equal(modelRequests, 2); assert.deepEqual(mcpMethods, ["initialize", "notifications/initialized", "tools/call"]);
  } finally { await f.cleanup(); }
});

test("missing local credentials fail before any run record or network operation", async () => {
  const f = await fixture();
  try {
    await assert.rejects(runCommand({ action: "run", input: "질문" }, { ...f, env: {} }), /모델 연결 미설정/);
    assert.deepEqual(await readdir(f.stateDirectory), []);
  } finally { await f.cleanup(); }
});

test("approval is durable, bound to the displayed arguments, and only resume executes once", async () => {
  const f = await fixture(manifest("write")); let calls = 0;
  try {
    const waiting = await runCommand({ action: "run", input: "변경" }, { ...f, adapters: adapters(() => calls++) }) as PublicRun;
    assert.equal(waiting.status, "waiting_approval"); assert.equal(calls, 0); assert.deepEqual(waiting.approvals[0].args, { query: "실제 입력 확인" });
    const decision = await runCommand({ action: "approve", runId: waiting.id, approvalId: waiting.approvals[0].id }, f) as PublicRun;
    assert.equal(decision.status, "queued"); assert.equal(calls, 0);
    const resumed = await runCommand({ action: "resume", runId: waiting.id }, { ...f, adapters: adapters(() => calls++) }) as PublicRun;
    assert.equal(resumed.status, "succeeded"); assert.equal(calls, 1);
    await runCommand({ action: "resume", runId: waiting.id }, { ...f, adapters: adapters(() => calls++) }); assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test("denial resumes with an observation and never performs the external write", async () => {
  const f = await fixture(manifest("write")); let calls = 0;
  try {
    const waiting = await runCommand({ action: "run", input: "변경" }, { ...f, adapters: adapters(() => calls++) }) as PublicRun;
    await runCommand({ action: "deny", runId: waiting.id, approvalId: waiting.approvals[0].id }, f);
    const resumed = await runCommand({ action: "resume", runId: waiting.id }, { ...f, adapters: adapters(() => calls++) }) as PublicRun;
    assert.equal(resumed.status, "succeeded"); assert.equal(calls, 0); assert.match(resumed.result, /거절/);
  } finally { await f.cleanup(); }
});

test("interrupted dispatching writes become unknown_outcome and are never replayed", async () => {
  const f = await fixture(manifest("write")); let calls = 0;
  try {
    const waiting = await runCommand({ action: "run", input: "변경" }, { ...f, adapters: adapters() }) as PublicRun;
    await runCommand({ action: "approve", runId: waiting.id, approvalId: waiting.approvals[0].id }, f);
    const store = new FileRunStore(f.stateDirectory); await store.acquire();
    const state = await store.load(waiting.id); state.run.status = "running"; state.run.updatedAt = new Date().toISOString(); state.run.checkpoint.calls[0].status = "dispatching"; state.run.checkpoint.calls[0].attempts = 1;
    await store.save(state.run, state.packageHash); await store.release();
    const resumed = await runCommand({ action: "resume", runId: waiting.id }, { ...f, adapters: adapters(() => calls++) }) as PublicRun;
    assert.equal(resumed.status, "unknown_outcome"); assert.equal(calls, 0);
  } finally { await f.cleanup(); }
});

test("changed package and tampered approved arguments stop before external effects", async () => {
  const f = await fixture(manifest("write")); let calls = 0;
  try {
    const waiting = await runCommand({ action: "run", input: "변경" }, { ...f, adapters: adapters() }) as PublicRun;
    const store = new FileRunStore(f.stateDirectory); await store.acquire(); const state = await store.load(waiting.id); state.run.checkpoint.calls[0].args.query = "변경된 인자"; await store.save(state.run, state.packageHash); await store.release();
    await assert.rejects(runCommand({ action: "approve", runId: waiting.id, approvalId: waiting.approvals[0].id }, f), /인자가 바뀌/);
    await writeFile(f.packagePath, (await readFile(f.packagePath, "utf8")) + "\n");
    await assert.rejects(runCommand({ action: "resume", runId: waiting.id }, { ...f, adapters: adapters(() => calls++) }), /맞지 않/); assert.equal(calls, 0);
  } finally { await f.cleanup(); }
});

test("exclusive file lock prevents simultaneous writers and refuses to unlock a living process", async () => {
  const f = await fixture(); const first = new FileRunStore(f.stateDirectory), second = new FileRunStore(f.stateDirectory);
  try {
    await first.acquire(); await assert.rejects(second.acquire(), /다른 실행기/); await assert.rejects(second.unlock(), /살아 있어/); await first.assertLock(); await first.release();
    await second.acquire(); await second.release();
  } finally { await f.cleanup(); }
});

test("manifest cannot carry connection credentials or another user's connection", () => {
  for (const change of [{ token: "must-not-export" }, { ownerId: "someone-else" }]) {
    const value = manifest(); Object.assign(value.connections[0], change); assert.throws(() => parseExportManifest(value), /허용되지 않은/);
  }
});

test("expired approvals are persisted as expired without calling a model or tool", async () => {
  const f = await fixture(manifest("write"));
  try {
    const waiting = await runCommand({ action: "run", input: "변경" }, { ...f, adapters: adapters() }) as PublicRun;
    const store = new FileRunStore(f.stateDirectory); await store.acquire(); const state = await store.load(waiting.id); state.run.approvals[0].expiresAt = "2020-01-01T00:00:00.000Z"; await store.save(state.run, state.packageHash); await store.release();
    const result = await runCommand({ action: "approve", runId: waiting.id, approvalId: waiting.approvals[0].id }, f) as PublicRun;
    assert.equal(result.status, "expired"); assert.equal((await store.load(waiting.id)).run.status, "expired");
  } finally { await f.cleanup(); }
});

test("local credentials and exact echoed secrets never enter checkpoints or CLI results", async () => {
  const f = await fixture(); const secret = "local-user-key-never-export-this";
  try {
    const result = await runCommand({ action: "run", input: `질문 ${secret}` }, { ...f, env: { OPENAI_API_KEY: secret }, adapters: { ...adapters(), model: { async next() { return { kind: "answer", text: `답변 ${secret}`, usageTokens: 40 }; } } } }) as PublicRun;
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    assert.doesNotMatch(await readFile(join(f.stateDirectory, `${result.id}.json`), "utf8"), new RegExp(secret));
  } finally { await f.cleanup(); }
});

test("unlock reclaims only an exited process and the CLI fails clearly before credentials are configured", async () => {
  const f = await fixture(); const store = new FileRunStore(f.stateDirectory);
  try {
    await store.acquire(); await store.release();
    const childPid = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }));
    await writeFile(join(f.stateDirectory, ".runner.lock"), JSON.stringify({ pid: childPid, nonce: "exited-process" }));
    await store.unlock(); await store.acquire(); await store.release();
    const cli = resolve("export-runtime/cli.ts"), tsx = resolve("node_modules/tsx/dist/cli.mjs");
    await writeFile(join(f.directory, "input.txt"), "한글 질문");
    const child = spawnSync(process.execPath, [tsx, cli, "run", "--input-file", "input.txt"], { cwd: f.directory, encoding: "utf8" });
    assert.equal(child.status, 1); assert.match(child.stderr, /모델 연결 미설정/); assert.equal(child.stdout, "");
  } finally { await f.cleanup(); }
});

function dataManifest(): ExportManifest {
  const value = manifest();
  value.workflow.definition = { schemaVersion: 3, nodes: [
    { id: "input", type: "input", title: "사용자 입력", x: 0, y: 0 },
    { id: "output", type: "output", title: "결과 출력", x: 0, y: 200, inputBindings: { text: { nodeId: "input", path: "text" } } },
  ], edges: [{ id: "input-output", source: "input", target: "output" }] };
  value.resources = []; value.connections = [];
  return value;
}

test("offline check reports missing variable names without values, network, or state writes", async t => {
  const value = manifest(); value.connections[0].tokenEnv = "FLOWLY_MCP_TOKEN_LOOKUP";
  const f = await fixture(value); let networkCalls = 0;
  t.mock.method(globalThis, "fetch", () => { networkCalls++; throw new Error("offline check attempted network"); });
  try {
    const result = await runCommand({ action: "check" }, f) as CheckResult;
    assert.equal(result.status, "unconfigured"); assert.equal(result.requiresModel, true);
    assert.deepEqual(result.missingEnv, ["FLOWLY_MCP_TOKEN_LOOKUP", "FLOWLY_MODEL", "OPENAI_API_KEY"]);
    assert.deepEqual(result.counts, { nodes: 3, resources: 1, tools: 1 });
    const ready = await runCommand({ action: "check" }, { ...f, env: { OPENAI_API_KEY: "synthetic-check-only-secret", FLOWLY_MODEL: "synthetic-model", FLOWLY_MCP_TOKEN_LOOKUP: "synthetic-service-token" } }) as CheckResult;
    assert.equal(ready.status, "ready"); assert.deepEqual(ready.missingEnv, []);
    assert.doesNotMatch(JSON.stringify(ready), /synthetic|tools\.example/); assert.equal(networkCalls, 0);
    await assert.rejects(stat(f.stateDirectory), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

test("offline check rejects malformed graphs, absent resources, credentials and incomplete direct tool arguments", () => {
  const invalidGraph = manifest(); invalidGraph.workflow.definition.edges.push({ id: "cycle", source: "output", target: "input" });
  const missingResource = manifest(); missingResource.resources = [];
  const credentialLeak = manifest(); Object.assign(credentialLeak.connections[0], { token: "synthetic-secret-not-for-errors" });
  const incompleteTool = manifest(); const direct = incompleteTool.workflow.definition.nodes.find(node => node.type === "agent")!;
  direct.type = "tool"; direct.tool = { arguments: {}, bindings: {} };
  for (const value of [invalidGraph, missingResource, credentialLeak, incompleteTool, { content: "synthetic-secret-not-for-errors" }]) {
    const result = checkPackage(value, { OPENAI_API_KEY: "synthetic-key", FLOWLY_MODEL: "synthetic-model" });
    assert.equal(result.status, "invalid"); assert.ok(result.errors.length); assert.doesNotMatch(JSON.stringify(result), /synthetic/);
  }
});

test("non-model flows do not require a model key or unused service tokens and execute without network", async t => {
  const value = dataManifest();
  const unused = manifest(); value.resources = unused.resources; value.connections = unused.connections;
  value.connections[0].tokenEnv = "FLOWLY_MCP_TOKEN_UNUSED";
  const f = await fixture(value); let calls = 0;
  t.mock.method(globalThis, "fetch", () => { calls++; throw new Error("data workflow attempted network"); });
  try {
    const checked = await runCommand({ action: "check" }, f) as CheckResult;
    assert.equal(checked.status, "ready"); assert.equal(checked.requiresModel, false); assert.deepEqual(checked.missingEnv, []);
    const result = await runCommand({ action: "run", input: "모델 없이 전달한 값" }, f) as PublicRun;
    assert.equal(result.status, "succeeded"); assert.match(result.result, /모델 없이 전달한 값/); assert.equal(result.usage.tokens, 0); assert.equal(calls, 0);
  } finally { await f.cleanup(); }
});

test("direct tools require only their selected connection token, not a model key", () => {
  const value = manifest(); const direct = value.workflow.definition.nodes.find(node => node.type === "agent")!;
  direct.type = "tool"; direct.tool = { arguments: { query: "offline only" }, bindings: {} };
  value.connections[0].tokenEnv = "FLOWLY_MCP_TOKEN_LOOKUP";
  const result = checkPackage(value);
  assert.equal(result.requiresModel, false); assert.deepEqual(result.missingEnv, ["FLOWLY_MCP_TOKEN_LOOKUP"]);
  assert.equal(checkPackage(value, { FLOWLY_MCP_TOKEN_LOOKUP: "synthetic-check-only-token" }).status, "ready");
});

test("offline check rejects an exact configured secret copied into the package without revealing it", () => {
  const value = manifest(); value.resources[0].content = "notes: synthetic-exact-secret-must-not-be-copied";
  const result = checkPackage(value, { OPENAI_API_KEY: "synthetic-exact-secret-must-not-be-copied", FLOWLY_MODEL: "synthetic-model" });
  assert.equal(result.status, "invalid"); assert.match(result.errors.join(" "), /비밀 값/); assert.doesNotMatch(JSON.stringify(result), /synthetic/);
});

test("report escapes hostile stored content, redacts known secrets and omits model messages", async t => {
  const f = await fixture(); let calls = 0;
  try {
    const result = await runCommand({ action: "run", input: "원래 입력" }, { ...f, adapters: adapters() }) as PublicRun;
    const saved = await new FileRunStore(f.stateDirectory).load(result.id);
    saved.run.result = '</pre><script>alert("report")</script><img src="https://bad.example" onerror="bad()"> sk-synthetic-report-secret-123456789';
    saved.run.events.push({ sequence: saved.run.events.length + 1, at: new Date().toISOString(), type: "report_test", message: '<svg onload="bad()">', data: { authorization: "Bearer synthetic-token", password: "private-password", safe: '<a href="javascript:bad()">x</a>' } });
    saved.run.checkpoint.messages = [{ role: "assistant", content: "INTERNAL_MODEL_MESSAGES_MUST_NOT_APPEAR" }];
    const html = renderRunReport(saved.run);
    assert.doesNotMatch(html, /<script|<img|<svg|<a href|javascript:bad\(\)">|INTERNAL_MODEL_MESSAGES|private-password|synthetic-report-secret|synthetic-token/);
    assert.match(html, /&lt;script&gt;/); assert.match(html, /&lt;svg/); assert.match(html, /default-src 'none'/); assert.match(html, /재구성/);
    assert.match(html, /도구 호출/); assert.match(html, /실제 입력 확인/); assert.match(html, /도구가 받은 값/); assert.match(html, /청구 비용 아님/);
    const store = new FileRunStore(f.stateDirectory); await store.acquire(); await store.save(saved.run, saved.packageHash); await store.release();
    const original = await readFile(join(f.stateDirectory, `${result.id}.json`), "utf8");
    t.mock.method(globalThis, "fetch", () => { calls++; throw new Error("report attempted network"); });
    const output = join(f.directory, "report.html");
    const report = await runCommand({ action: "report", runId: result.id, output }, f);
    assert.deepEqual(report, { status: "report_written", runId: result.id, output }); assert.equal(calls, 0);
    assert.equal(await readFile(output, "utf8"), html); assert.equal(await readFile(join(f.stateDirectory, `${result.id}.json`), "utf8"), original);
    if (process.platform !== "win32") assert.equal((await stat(output)).mode & 0o777, 0o600);
  } finally { await f.cleanup(); }
});

test("report creates only a new HTML file, preserves an existing file and verifies the original package", async () => {
  const f = await fixture(manifest("write"));
  try {
    const waiting = await runCommand({ action: "run", input: "변경" }, { ...f, adapters: adapters() }) as PublicRun;
    const output = join(f.directory, "approval.html");
    await runCommand({ action: "report", runId: waiting.id, output }, f);
    const html = await readFile(output, "utf8"); assert.match(html, /승인 대기/); assert.match(html, new RegExp(waiting.approvals[0].id));
    await assert.rejects(runCommand({ action: "report", runId: waiting.id, output }, f), /이미 있어/);
    assert.equal(await readFile(output, "utf8"), html);
    await assert.rejects(runCommand({ action: "report", runId: waiting.id, output: join(f.directory, "not-html.js") }, f), /\.html/);
    await writeFile(f.packagePath, (await readFile(f.packagePath, "utf8")) + "\n");
    await assert.rejects(runCommand({ action: "report", runId: waiting.id, output: join(f.directory, "changed.html") }, f), /변경됐/);
    await assert.rejects(stat(join(f.directory, "changed.html")), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

test("CLI check ignores ambient keys, data runs need no env file, and report never loads env", async () => {
  const f = await fixture(); const cli = resolve("export-runtime/cli.ts"), tsx = resolve("node_modules/tsx/dist/cli.mjs");
  const invoke = (args: string[]) => spawnSync(process.execPath, [tsx, cli, ...args], { cwd: f.directory, encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "synthetic-ambient-key", FLOWLY_MODEL: "synthetic-model" } });
  try {
    const missing = invoke(["check"]); assert.equal(missing.status, 1); assert.equal(JSON.parse(missing.stdout).status, "unconfigured"); assert.doesNotMatch(missing.stdout + missing.stderr, /synthetic/);
    const invalid = invoke(["check", "--env", f.directory]); assert.equal(invalid.status, 1); assert.equal(JSON.parse(invalid.stdout).status, "invalid");
    await writeFile(f.packagePath, JSON.stringify(dataManifest()));
    const checked = invoke(["check"]); assert.equal(checked.status, 0); assert.equal(JSON.parse(checked.stdout).status, "ready");
    const run = invoke(["run", "--input", "환경 파일 없는 데이터 흐름"]); assert.equal(run.status, 0, run.stderr); const result = JSON.parse(run.stdout); assert.equal(result.status, "succeeded");
    const report = invoke(["report", result.id, "--output", "result.html", "--env", f.directory]); assert.equal(report.status, 0, report.stderr); assert.equal(JSON.parse(report.stdout).status, "report_written");
    const exists = invoke(["report", result.id, "--output", "result.html"]); assert.equal(exists.status, 1); assert.match(exists.stderr, /이미 있어/);
    const noOutput = invoke(["report", result.id]); assert.equal(noOutput.status, 1);
    await writeFile(f.packagePath, "not-json-synthetic-secret");
    const malformed = invoke(["check"]); assert.equal(malformed.status, 1); assert.equal(JSON.parse(malformed.stdout).status, "invalid"); assert.doesNotMatch(malformed.stdout, /synthetic/);
  } finally { await f.cleanup(); }
});
