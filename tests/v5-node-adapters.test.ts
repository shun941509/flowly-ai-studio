import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenAIModelAdapter } from "../runtime/adapters/openai";
import { fileBridge } from "../export-runtime/files";
import { FileRunStore } from "../export-runtime/store";
import { missingEnvironment, selectedConnections } from "../export-runtime/diagnostics";
import type { ExportManifest } from "../export-runtime/manifest";

const fakeFetch = (callback: (url: string, init: RequestInit) => Response | Promise<Response>) => ((url, init) => callback(String(url), init ?? {})) as typeof fetch;
const signal = () => new AbortController().signal;
const completed = (text: string) => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { total_tokens: 32 } });
test("SSE handles byte-split UTF8/CRLF, redacts split credentials and requires completed usage", async () => {
  for (const finish of [true, false]) {
    const secret = "synthetic-private-credential", partials: string[] = [];
    const frames = [{ type: "response.output_text.delta", delta: "한글 ".repeat(200) + "synthetic-private-" }, { type: "response.output_text.delta", delta: "credential 끝" }, ...(finish ? [{ type: "response.completed", response: completed("최종 결과") }] : [])];
    const model = new OpenAIModelAdapter({ apiKey: secret, model: "mock-model", fetch: fakeFetch((_url, init) => {
      assert.equal(JSON.parse(String(init.body)).stream, true);
      const bytes = new TextEncoder().encode(frames.map(frame => "data: " + JSON.stringify(frame) + "\r\n\r\n").join(""));
      return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
    }) });
    const pending = model.next({ messages: [{ role: "user", content: "질문" }], tools: [], maxTokens: 100, signal: signal(), onDelta: text => { partials.push(text); } });
    if (finish) assert.deepEqual(await pending, { kind: "answer", text: "최종 결과", usageTokens: 32 });
    else await assert.rejects(pending, /완료 이벤트/);
    assert.ok(partials.length > 0); assert.doesNotMatch(partials.join(""), /synthetic-private-credential|\uFFFD/);
  }
});

test("SSE also redacts long service credentials spanning separate provider chunks", async () => {
  const service = "synthetic-service-" + "x".repeat(700), deltas: string[] = [];
  const parts = ["가".repeat(2000) + service.slice(0, 550), service.slice(550) + " 마지막"];
  const frames = [...parts.map(delta => ({ type: "response.output_text.delta", delta })), { type: "response.completed", response: completed("결과 " + service) }];
  const model = new OpenAIModelAdapter({ apiKey: "synthetic-api-key", secrets: [service], model: "mock", fetch: fakeFetch(() => new Response(frames.map(value => "data: " + JSON.stringify(value) + "\n\n").join(""), { headers: { "content-type": "text/event-stream" } })) });
  const result = await model.next({ messages: [], tools: [], maxTokens: 100, signal: signal(), onDelta: text => { deltas.push(text); } });
  assert.doesNotMatch(deltas.join(""), /synthetic-service|x{20}/);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-service|x{20}/);
});

test("embeddings uses fixed float API, preserves index order, validates dimensions and usage", async () => {
  const model = new OpenAIModelAdapter({ apiKey: "synthetic-key", model: "unused", embeddingModel: "custom-embedding", fetch: fakeFetch((url, init) => {
    assert.equal(url, "https://api.openai.com/v1/embeddings"); assert.deepEqual(JSON.parse(String(init.body)), { model: "custom-embedding", input: ["one", "two"], encoding_format: "float" });
    return Response.json({ model: "custom-embedding", data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { total_tokens: 5 } });
  }) });
  assert.deepEqual(await model.embed({ texts: ["one", "two"], maxTokens: 100, signal: signal() }), { vectors: [[1, 0], [0, 1]], model: "custom-embedding", usageTokens: 5 });
  const invalid = new OpenAIModelAdapter({ apiKey: "synthetic-key", model: "unused", fetch: fakeFetch(() => Response.json({ model: "bad", data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [2, 3] }], usage: { total_tokens: 1 } })) });
  await assert.rejects(invalid.embed({ texts: ["one", "two"], maxTokens: 100, signal: signal() }), /벡터/);
});

test("Responses web search exposes only cited HTTPS sources and no provider reasoning", async () => {
  const model = new OpenAIModelAdapter({ apiKey: "synthetic-key", model: "web-model", fetch: fakeFetch((_url, init) => {
    const body = JSON.parse(String(init.body)); assert.deepEqual(body.tools, [{ type: "web_search" }]); assert.equal(body.store, false); assert.equal(body.tool_choice, "required"); assert.equal(body.max_tool_calls, 1);
    return Response.json({ ...completed("찾은 결과"), output: [{ type: "web_search_call", status: "completed" }, { type: "reasoning", content: [{ text: "private-reasoning" }] }, { type: "message", content: [{ type: "output_text", text: "찾은 결과", annotations: [{ type: "url_citation", url: "https://example.com/page", title: "문서" }, { type: "url_citation", url: "http://unsafe.example/page", title: "제외" }] }] }] });
  }) });
  const result = await model.search({ query: "질문", maxTokens: 100, signal: signal() });
  assert.deepEqual(result.sources, [{ url: "https://example.com/page", title: "문서" }]); assert.equal(result.usageTokens, 32); assert.doesNotMatch(JSON.stringify(result), /private-reasoning/);
});

test("provider search without execution and mismatched or zero embeddings are rejected", async () => {
  const model = new OpenAIModelAdapter({ apiKey: "synthetic-key", model: "mock", fetch: fakeFetch(() => Response.json(completed("검색하지 않은 답변"))) });
  await assert.rejects(model.search({ query: "질문", maxTokens: 100, signal: signal() }), /웹 검색 호출/);
  for (const [responseModel, embedding] of [["different-model", [1, 0]], ["text-embedding-3-small", [0, 0]]] as const) {
    const model = new OpenAIModelAdapter({ apiKey: "synthetic-key", model: "mock", fetch: fakeFetch(() => Response.json({ model: responseModel, data: [{ index: 0, embedding }], usage: { total_tokens: 1 } })) });
    await assert.rejects(model.embed({ texts: ["text"], maxTokens: 100, signal: signal() }), /모델|벡터/);
  }
});

test("real Node/Python file bridge hashes input, extracts Unicode, creates formula-safe CSV once and rejects escapes", async t => {
  const root = await mkdtemp(join(tmpdir(), "flowly-v5-files-"));
  t.after(async () => { assert.ok(root.includes("flowly-v5-files-")); await rm(root, { recursive: true, force: true }); });
  await copyFile(new URL("../export-runtime/flowly_files.py", import.meta.url), join(root, "flowly_files.py"));
  await mkdir(join(root, "inputs")); await writeFile(join(root, "inputs", "문서.txt"), "한국어 실제 파일\n검증 결과", "utf8");
  const bridge = fileBridge(join(root, "workflow.json"), join(root, ".flowly-runs"));
  const base = { runId: "run_fixture", nodeId: "file", signal: signal() };
  const input = await bridge({ ...base, operation: "input", config: { path: "file", maxBytes: 1000 }, input: { file: "문서.txt" } });
  assert.match(String((input.file as Record<string, unknown>).sha256), /^[a-f0-9]{64}$/);
  const extracted = await bridge({ ...base, operation: "extract", config: { mode: "text", filePath: "file", maxPages: 10, language: "eng" }, input });
  assert.match(String(extracted.text), /한국어 실제 파일/);
  const request = { ...base, operation: "output" as const, config: { format: "csv", filename: "result.csv", dataPath: "rows" }, input: { rows: [{ name: "한국어", unsafe: "=1+1" }] } };
  const first = await bridge(request), second = await bridge(request); assert.deepEqual(second.file, first.file);
  const path = String((first.file as Record<string, unknown>).path); assert.ok(path.startsWith("outputs/")); const csv = await readFile(join(root, path), "utf8"); assert.match(csv, /한국어/); assert.match(csv, /'=1\+1/);
  await assert.rejects(bridge({ ...base, operation: "input", config: { path: "file", maxBytes: 1000 }, input: { file: "../outside.txt" } }), /허용|경로/);
  await writeFile(join(root, "inputs", "문서.txt"), "변경됨"); await assert.rejects(bridge({ ...base, operation: "extract", config: { mode: "text", filePath: "file", maxPages: 10, language: "eng" }, input }), /변경|해시/);
});

test("local memory expires across durable operations and vector cache persists without credentials", async t => {
  const root = await mkdtemp(join(tmpdir(), "flowly-v5-state-"));
  t.after(async () => { assert.ok(root.includes("flowly-v5-state-")); await rm(root, { recursive: true, force: true }); });
  const store = new FileRunStore(root); await store.acquire();
  try {
    const common = { ownerId: "a", workflowId: "w", key: "value" };
    await store.memory({ ...common, operationId: "write", action: "write", value: "old", ttlSeconds: 1 });
    const file = (await readdir(root)).find(name => name.startsWith(".memory-"))!; const record = JSON.parse(await readFile(join(root, file), "utf8")); record.expires.value = "2000-01-01T00:00:00Z"; await writeFile(join(root, file), JSON.stringify(record));
    assert.deepEqual(await store.memory({ ...common, operationId: "read", action: "read", defaultValue: "fallback" }), { data: "fallback", found: false });
    await store.vectorCache("index-key", { model: "test", vectors: [[1, 0]] }); assert.deepEqual(await store.vectorCache("index-key"), { model: "test", vectors: [[1, 0]] }); assert.equal(await store.vectorCache("different"), undefined);
  } finally { await store.release(); }
});

test("environment selection requires only embedding key for vector-only and includes memory/compensation connections", () => {
  const manifest = { workflow: { definition: { nodes: [{ id: "vector", type: "retrieval", retrieval: { mode: "vector" } }, { id: "memory", type: "memory", memory: { backend: "mcp" }, allowedTools: [{ connectionId: "memory", resourceId: "m" }] }, { id: "undo", type: "compensate", allowedTools: [{ connectionId: "undo", resourceId: "u" }] }], edges: [] } }, connections: [{ id: "memory", resourceId: "m" }, { id: "undo", resourceId: "u" }] } as unknown as ExportManifest;
  assert.deepEqual(missingEnvironment(manifest, {}), ["OPENAI_API_KEY"]); assert.deepEqual(missingEnvironment(manifest, { OPENAI_API_KEY: "synthetic" }), []); assert.equal(selectedConnections(manifest).length, 2);
});
