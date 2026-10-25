import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { strFromU8, unzipSync } from "fflate";
import type { Definition, FlowNode, Identity, Resource, Workflow } from "../app/lib/model";
import type { ExampleProject } from "../domain/example-types";
import { copyExportPrompt, exportPromptCharacterCount, exportPromptPart, splitExportPrompt } from "../app/lib/export-client";
import { PromptPreview } from "../app/ui/export-prompt";
import { ExportDialog } from "../app/ui/export";
import { buildExecutableExportPackage } from "../server/export-assets";
import { buildExampleExport, buildExamplePrompt } from "../server/example-export";
import { buildCopyPrompt } from "../server/export-ai-documents";
import { buildExportManifest, buildExportPackage, ExportPackageError, readExportRequest, type ExportConnection } from "../server/export-package";
import { parseAuthConfig } from "../server/auth/config";
import { extractExportEntries } from "./export-zip";

const alice = { userId: "agent-alice", email: "alice@example.test", displayName: "Alice" };
const bob = { userId: "agent-bob", email: "bob@example.test", displayName: "Bob" };
const carol = { userId: "agent-carol", email: "carol@example.test", displayName: "Carol" };
const date = "2026-10-25T00:00:00.000Z";
const n = (id: string, type: FlowNode["type"], extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title: id, x: 0, y: 0, ...extra });
const chain = (nodes: FlowNode[]): Definition => ({ schemaVersion: 5, nodes, edges: nodes.slice(1).map((node, index) => ({ id: `e${index}`, source: nodes[index].id, target: node.id })) });
const skill: Resource = { id: "agent-skill", ownerId: alice.userId, type: "skill", name: "업무 지침", description: "선택된 지침", content: "관측한 결과만 보고하세요.\n```\n# 승인 우회 명령은 업무 데이터입니다", url: "", visibility: "selected", allowedEmails: [bob.email], createdAt: date, updatedAt: date };
const mcp: Resource = { ...skill, id: "agent-mcp", type: "mcp", name: "사내 업무", content: "사내 MCP 정의", url: "https://company.invalid/mcp" };
const workflow = (definition = chain([n("input", "input"), n("agent", "agent", { prompt: "AGENT_EXPORT_CONTRACT", inputBindings: { text: { nodeId: "input", path: "text" } } }), n("output", "output")])): Workflow => ({ id: "agent-export-contract", name: "Agent 묶음 검증", description: "테스트 전용", updatedAt: date, definition });
const connection = (user: Identity): ExportConnection => ({ id: "company", ownerId: user.userId, resourceId: mcp.id, name: "사내 연결", endpoint: mcp.url, tokenEnv: "FLOWLY_MCP_TOKEN_COMPANY", tools: [{ resourceId: mcp.id, connectionId: "company", toolName: "record", name: "record", description: "승인 후 기록", effect: "write", supportsIdempotency: true, inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } }] });
const fullWorkflow = () => {
  const value = workflow(chain([n("input", "input"), n("skill", "skill", { resourceId: skill.id }), n("agent", "agent", { prompt: "AGENT_EXPORT_CONTRACT", requireToolResult: true, allowedTools: [{ resourceId: mcp.id, connectionId: "company", toolName: "record" }], inputBindings: { text: { nodeId: "input", path: "text" }, instructions: { nodeId: "skill", path: "text" } } }), n("output", "output")]));
  value.definition.edges.push({ id: "input-agent", source: "input", target: "agent" }); return value;
};
const options = (user = alice) => ({ user, workflow: fullWorkflow(), connections: [connection(user)], resolveResources: async () => [structuredClone(skill), structuredClone(mcp)], exportedAt: date });
const status = (code: number) => (error: unknown) => error instanceof ExportPackageError && error.status === code;

test("four export choices preserve parsing and published-version contracts", async () => {
  const origin = "http://127.0.0.1:5173";
  const config = parseAuthConfig({ FLOWLY_AUTH_MODE: "test", FLOWLY_ENV: "test", FLOWLY_APP_ORIGIN: origin, FLOWLY_SESSION_SECRET: "test-secret-over-thirty-two-characters" });
  const request = (body: unknown) => new Request(`${origin}/api/export`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await readExportRequest(request({ workflow: workflow() }), config)).kind, "runtime");
  for (const kind of ["runtime", "agent", "prompt"] as const) for (const language of ["node", "python"] as const) {
    const parsed = await readExportRequest(request({ workflowId: "workflow", versionId: "published-v1", language, kind }), config);
    assert.deepEqual(parsed, { workflowId: "workflow", versionId: "published-v1", language, kind });
  }
  await assert.rejects(readExportRequest(request({ workflow: workflow(), kind: "prompt-file" }), config), status(400));
  await assert.rejects(buildExportPackage({ ...options(), kind: "prompt", runnerSource: "unused" }), status(400));
});

test("Agent package requires an explicit recursive Agent; AI, Skill and tools alone do not qualify", async () => {
  const base = { user: alice, connections: [], resolveResources: async () => [], kind: "agent" as const };
  for (const type of ["ai", "transform"] as const) {
    const definition = chain([n("input", "input"), n("work", type, type === "transform" ? { transform: { mode: "template", template: "{{text}}" } } : { prompt: "분석" }), n("output", "output")]);
    await assert.rejects(buildExportManifest({ ...base, workflow: workflow(definition) }), status(409));
  }
  const noAgent = fullWorkflow(); noAgent.definition.nodes = noAgent.definition.nodes.map(node => node.type === "agent" ? { ...node, type: "tool", tool: { arguments: { value: "예시" }, bindings: {} }, requireToolResult: undefined } as FlowNode : node);
  await assert.rejects(buildExportManifest({ ...options(), workflow: noAgent, kind: "agent" }), status(409));
  const nested = workflow(chain([n("input", "input"), n("nested", "subworkflow", { subworkflow: { definition: workflow().definition } }), n("output", "output")]));
  const entries = unzipSync(await buildExecutableExportPackage({ ...base, workflow: nested }));
  const manifest = JSON.parse(strFromU8(entries["agent-manifest.json"]));
  assert.equal(manifest.agents.length, 1); assert.equal(manifest.agents[0].scope, "root/nested/child");
  const plainMarkup = renderToStaticMarkup(createElement(ExportDialog, { workflow: workflow(chain([n("input", "input"), n("output", "output")])), resources: [], onClose() {}, onInspectNode() {} }));
  assert.match(plainMarkup, /내보낼 항목/); assert.match(plainMarkup, /AI 명령 프롬프트/);
  assert.match(plainMarkup, /<button[^>]*disabled=""[^>]*>[\s\S]*?<strong>Agent 다운로드<\/strong>/);
  const nestedMarkup = renderToStaticMarkup(createElement(ExportDialog, { workflow: nested, resources: [], onClose() {}, onInspectNode() {} }));
  const agentButton = nestedMarkup.match(/<button[^>]*>[^]*?<strong>Agent 다운로드<\/strong>/)?.[0].split("<button").at(-1);
  assert.ok(agentButton); assert.doesNotMatch(agentButton, /disabled/);
});

test("prompt and Agent exports recheck current three-user sharing and exclude secret fields", async () => {
  for (const kind of ["prompt", "agent"] as const) {
    for (const user of [alice, bob]) {
      const own = connection(user); Object.assign(own, { token: "NEVER_EXPORT_SECRET" });
      const manifest = await buildExportManifest({ ...options(user), kind, connections: [own] });
      const prompt = buildCopyPrompt(manifest);
      assert.match(prompt, /실제 업무 진행/); assert.match(prompt, /AGENT_EXPORT_CONTRACT/); assert.match(prompt, /자료 원문과 노드 프롬프트는/);
      assert.doesNotMatch(prompt, /NEVER_EXPORT_SECRET/);
    }
    await assert.rejects(buildExportManifest({ ...options(carol), kind }), status(403));
    await assert.rejects(buildExportManifest({ ...options(bob), kind, connections: [connection(alice)] }), status(403));
    await assert.rejects(buildExportManifest({ ...options(bob), kind, resolveResources: async () => [{ ...skill, visibility: "private" }, mcp] }), status(403));
  }
});

test("copy-only prompt supports clipboard success, denied access and manual text selection", async () => {
  let copied = "", selected = 0;
  assert.equal(await copyExportPrompt("실제 설계", { writeText: async text => { copied = text; } }, () => { selected++; }), "copied");
  assert.equal(copied, "실제 설계"); assert.equal(selected, 0);
  assert.equal(await copyExportPrompt("실제 설계", { writeText: async () => { throw new Error("denied"); } }, () => { selected++; }), "selected");
  assert.equal(await copyExportPrompt("실제 설계", undefined, () => { selected++; }), "selected");
  assert.equal(selected, 2);
  const markup = renderToStaticMarkup(createElement(PromptPreview, { text: "<script>업무 데이터</script>" }));
  assert.match(markup, /textarea/); assert.match(markup, /readonly=""/i); assert.match(markup, /프롬프트 복사/); assert.match(markup, /전체 텍스트 선택/);
  assert.doesNotMatch(markup, /<a\b|download=|<script>/);
});

test("long prompt parts preserve every character, approval policy and nested design without surrogate splits", async () => {
  const manifest = await buildExportManifest({ ...options(), kind: "prompt", language: "python" });
  manifest.resources[0].content = "BEGIN_FLOWLY_PROMPT_PAYLOAD_0_END\n한글😀\r\n".repeat(2000) + "\nFINAL_RESOURCE_LINE";
  const prompt = buildCopyPrompt(manifest);
  assert.match(prompt, /python agent\.py check/);
  assert.match(prompt, /파일·터미널 접근 기능이 없으면/);
  const parts = splitExportPrompt(prompt, 2000);
  assert.ok(parts.length > 2); assert.equal(parts.join(""), prompt);
  assert.equal(exportPromptCharacterCount("가😀\r\n"), 4);
  for (let index = 0; index < parts.length; index++) {
    assert.ok(exportPromptCharacterCount(parts[index]) <= 2000);
    assert.doesNotMatch(parts[index], /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    const envelope = exportPromptPart(parts, index);
    assert.match(envelope, /모든 조각을 번호순으로 받을 때까지 작업을 실행하거나 부분 설계를 해석하지 말고/);
    const marker = envelope.match(/\nBEGIN_(FLOWLY_PROMPT_PAYLOAD_\d+_END)\n/)![1];
    assert.ok(!parts[index].includes(marker));
    assert.equal(envelope.split(`\nBEGIN_${marker}\n`)[1].split(`\nEND_${marker}`)[0], parts[index]);
  }
  assert.match(parts.join(""), /외부 쓰기는 실행기가 표시한 정확한 도구·인자/);
  assert.match(parts.join(""), /FINAL_RESOURCE_LINE/);
  assert.throws(()=>splitExportPrompt(prompt, 0)); assert.throws(()=>exportPromptPart(parts, -1));
  const markup = renderToStaticMarkup(createElement(PromptPreview, { text: prompt }));
  assert.match(markup, /복사할 프롬프트 범위/); assert.match(markup, /토큰 수가 아니며/); assert.match(markup, /내용 생략 없음/);
});

test("all generated Agent instructions use one language-correct entrypoint and preserve the authorized runtime manifest", async () => {
  for (const language of ["node", "python"] as const) {
    const current = { ...options(), language };
    const runtime = unzipSync(await buildExecutableExportPackage({ ...current, kind: "runtime" }));
    const agent = unzipSync(await buildExecutableExportPackage({ ...current, kind: "agent" }));
    const manifest = await buildExportManifest({ ...current, kind: "prompt" });
    assert.deepEqual(JSON.parse(strFromU8(runtime["workflow.json"])), manifest);
    assert.deepEqual(JSON.parse(strFromU8(agent["workflow.json"])), manifest);
    const command = language === "node" ? "node agent.mjs" : "python agent.py";
    for (const name of ["README.md", "START_HERE.md", "AI_PROMPT.md", "AGENTS.md", "Agent.md", ...Object.keys(agent).filter(name => name.endsWith("/SKILL.md"))]) {
      const contents = strFromU8(agent[name]);
      assert.ok(contents.includes(command), name);
      assert.doesNotMatch(contents, /(?:node|python) runner\.(?:mjs|py)/, name);
      assert.doesNotMatch(contents, language === "node" ? /python agent\.py/ : /node agent\.mjs/, name);
    }
    assert.match(buildCopyPrompt(manifest), language === "node" ? /node agent\.mjs check/ : /python agent\.py check/);
    assert.match(strFromU8(runtime["README.md"]), language === "node" ? /node runner\.mjs/ : /python runner\.py/);
    const plain = await buildExportManifest({ user: alice, workflow: workflow(chain([n("input", "input"), n("output", "output")])), language, kind: "prompt", connections: [], resolveResources: async () => [] });
    assert.match(buildCopyPrompt(plain), language === "node" ? /node runner\.mjs check/ : /python runner\.py check/);
  }
});

function example(value: Workflow): ExampleProject {
  return { id: "agent-export-example", title: value.name, description: "검증 전용", kind: "workflow", category: "검증", frameworks: [], tags: [], nodeTypes: value.definition.nodes.map(node => node.type), status: "setup_required", uniqueBehavior: "Agent 진입점", verification: { schema: true, node: false, python: false, live: false }, inputExample: "입력", expectedOutput: "결과", requirements: [], workflow: value, resources: [], variants: [], acceptance: ["실행"], failureCases: ["미설정"], sourceLicense: "synthetic-test" };
}
test("direct example uses the same Agent manifest contract and copy-only prompt", async () => {
  for (const language of ["node", "python"] as const) {
    const project = example(workflow());
    const files = unzipSync(await buildExampleExport(project, alice, language, "agent"));
    const manifest = JSON.parse(strFromU8(files["agent-manifest.json"]));
    assert.equal(manifest.language, language); assert.equal(manifest.agents[0].nodeId, "agent");
    assert.match(strFromU8(files["EXAMPLE.md"]), language === "node" ? /node agent\.mjs/ : /python agent\.py/);
    assert.ok(files["example-contract.json"] && files["input.txt"]);
    assert.match(await buildExamplePrompt(project, alice, language), /AGENT_EXPORT_CONTRACT/);
  }
});

const python = process.env.FLOWLY_TEST_PYTHON || (existsSync(resolve(".venv-files/Scripts/python.exe")) ? resolve(".venv-files/Scripts/python.exe") : process.platform === "win32" ? "python" : "python3");
const environment: NodeJS.ProcessEnv = { NODE_ENV: "test", ...Object.fromEntries(["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "PATHEXT"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])) };
for (const language of ["node", "python"] as const) for (const nested of [false, true]) test(`${language} ${nested ? "nested" : "root"} Agent ZIP entrypoint executes model/tool boundary, approval/resume and detects modified assets`, async () => {
  const folder = await mkdtemp(join(tmpdir(), "flowly-agent-export-"));
  try {
    const selected = options();
    if (nested) selected.workflow = workflow(chain([n("input", "input"), n("nested", "subworkflow", { subworkflow: { definition: fullWorkflow().definition } }), n("output", "output")]));
    const files = unzipSync(await buildExecutableExportPackage({ ...selected, kind: "agent", language }));
    await extractExportEntries(folder, files);
    assert.ok(!files[".env"]); assert.ok(!Object.keys(files).some(name => /boundary|preload|scenario/.test(name)));
    for (const name of ["Agent.md", "AGENTS.md", "agent-manifest.json", "mcp.json", "agents/role-001.md", "skills/flowly-workflow/SKILL.md", "START_HERE.md", ".env.example"]) assert.ok(files[name]?.length, name);
    const agentManifest = JSON.parse(strFromU8(files["agent-manifest.json"]));
    assert.equal(agentManifest.agents[0].scope, nested ? "root/nested/child" : "root");
    assert.equal(agentManifest.agents[0].allowedTools[0].toolName, "record");
    assert.equal(agentManifest.skills.length, 2);
    const entry = language === "node" ? "agent.mjs" : "agent.py";
    const invoke = (args: string[], expected = 0, boundary = false) => {
      const prefix = language === "node" ? [...(boundary ? ["--import", pathToFileURL(resolve("tests/workflow-node-preload.mjs")).href] : []), entry] : ["-X", "utf8", boundary ? ".agent-boundary.py" : entry];
      const result = spawnSync(language === "node" ? process.execPath : python, [...prefix, ...args], { cwd: folder, env: environment, encoding: "utf8", timeout: 25000, windowsHide: true });
      assert.equal(result.error, undefined, result.error?.message); assert.equal(result.status, expected, result.stderr || result.stdout);
      return JSON.parse(result.stdout);
    };
    const unconfigured = invoke(["check"], 1); assert.equal(unconfigured.status, "unconfigured"); assert.ok(unconfigured.missingEnv.includes("OPENAI_API_KEY"));
    for (const option of ["--package", "--pack", "--package=workflow.json"]) assert.match(invoke(["check", option, "workflow.json"], 1).error, /--package/);
    await writeFile(join(folder, ".env"), "OPENAI_API_KEY=agent-test-boundary-placeholder\nFLOWLY_MODEL=test-model\nFLOWLY_MCP_TOKEN_COMPANY=boundary-placeholder\n");
    await writeFile(join(folder, ".scenario.json"), JSON.stringify({ name: "Agent entrypoint", modelReplies: [
      { match: "AGENT_EXPORT_CONTRACT", occurrence: 1, inputContains: ["정확한 요청"], allowedTools: ["record"], toolCall: { name: "record", args: { value: "approved" } } },
      { match: "AGENT_EXPORT_CONTRACT", occurrence: 2, allowedTools: ["record"], observationContains: ["recorded"], text: "검증용 응답: 승인된 기록 확인" },
    ], toolReplies: [{ name: "record", args: { value: "approved" }, result: { content: [{ type: "text", text: "recorded" }] } }] }));
    // Test boundary only: import the actual ZIP runtime, patch its HTTP transport,
    // then execute the untouched Agent entrypoint and dispatch its runpy target.
    const pythonBoundary = (await readFile("tests/workflow-python-boundary.py", "utf8")).replace("raise SystemExit(runner.main(sys.argv[1:]))", `import runpy\noriginal_run_path = runpy.run_path\ndef enter_runtime(path, **kwargs):\n    assert Path(path).resolve() == (Path.cwd() / 'runner.py').resolve()\n    raise SystemExit(runner.main(sys.argv[1:]))\nrunpy.run_path = enter_runtime\noriginal_run_path(str(Path.cwd() / 'agent.py'), run_name='__main__')`);
    await writeFile(join(folder, ".agent-boundary.py"), pythonBoundary);
    let run = invoke(["run", "--input", "정확한 요청"], 0, true);
    assert.equal(run.status, "waiting_approval");
    assert.equal(existsSync(join(folder, ".tool-calls.jsonl")), false, "write before approval");
    const approval = run.approvals.find((item: { status: string }) => item.status === "pending"); assert.ok(approval);
    invoke(["approve", run.id, approval.id], 0, true);
    assert.equal(existsSync(join(folder, ".tool-calls.jsonl")), false, "decision command dispatched write");
    run = invoke(["resume", run.id], 0, true);
    assert.equal(run.status, "succeeded", run.error); assert.equal(run.result, "검증용 응답: 승인된 기록 확인");
    assert.equal(run.usage.turns, 2); assert.equal(run.usage.toolCalls, 1);
    const before = await readFile(join(folder, ".tool-calls.jsonl"), "utf8");
    assert.equal(invoke(["resume", run.id], 0, true).status, "succeeded");
    assert.equal(await readFile(join(folder, ".tool-calls.jsonl"), "utf8"), before);
    assert.equal(existsSync(join(folder, ".boundary-errors.jsonl")), false);
    assert.equal(invoke(["status", run.id]).status, "succeeded");
    await writeFile(join(folder, "mcp.json"), "{}");
    const invalid = invoke(["check"], 1); assert.equal(invalid.status, "failed"); assert.match(invalid.error, /달라졌거나 누락/);
  } finally {
    const inside = relative(resolve(tmpdir()), folder); assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside));
    await rm(folder, { recursive: true, force: true });
  }
});

test("local operations and trigger helpers in both Agent ZIPs retain Agent validation", async () => {
  for (const language of ["node", "python"] as const) {
    const folder = await mkdtemp(join(tmpdir(), "flowly-agent-helper-zip-"));
    try {
      const current = workflow();
      current.definition.nodes[0] = n("input", "trigger", { trigger: { kind: "event", intervalSeconds: 60, startAt: "", eventType: "request" } });
      const files = unzipSync(await buildExecutableExportPackage({ user: alice, workflow: current, language, kind: "agent", connections: [], resolveResources: async () => [] }));
      await extractExportEntries(folder, files);
      const call = (code: string) => {
        const result = spawnSync(python, ["-X", "utf8", "-c", code], { cwd: folder, env: environment, encoding: "utf8", timeout: 25000, windowsHide: true });
        assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr || result.stdout); return JSON.parse(result.stdout);
      };
      const operations = "import json; from flowly_ops import Operations; value=Operations('.'); print(json.dumps(value.cli(value.profile(), ['check'])))";
      const triggers = "import json; from flowly_triggers import Launcher; value=Launcher('workflow.json','.env','.trigger-test'); print(json.dumps(value.cli(['check'])))";
      for (const invoke of [operations, triggers]) assert.equal(call(invoke).status, "unconfigured");
      await writeFile(join(folder, "mcp.json"), "{}");
      for (const invoke of [operations, triggers]) {
        const result = call(invoke); assert.equal(result.status, "failed"); assert.match(result.error, /달라졌거나 누락/);
      }
    } finally {
      const inside = relative(resolve(tmpdir()), folder); assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside));
      await rm(folder, { recursive: true, force: true });
    }
  }
});
