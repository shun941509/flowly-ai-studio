import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { build } from "esbuild";
import { strFromU8, unzipSync } from "fflate";
import type { FlowNode, Workflow } from "../app/lib/model";
import { buildExportPackage } from "../server/export-package";
import { createRun, executeRun } from "../runtime/engine";
import { pythonToolBridge } from "../export-runtime/python-tools";
import { pythonToolDefinition } from "../runtime/python-tools";
import type { Json } from "../runtime/types";
import { extractExportEntries } from "./export-zip";

const user = { userId: "python-tools-offline", email: "tools@example.test", displayName: "로컬 도구 검사" };
const environment: NodeJS.ProcessEnv = { NODE_ENV: "test", ...Object.fromEntries(["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "PATHEXT"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])) };
const testPython = process.env.FLOWLY_TEST_PYTHON || (existsSync(resolve("work/tools-env/Scripts/python.exe")) ? resolve("work/tools-env/Scripts/python.exe") : "python");
const node = (id: string, type: FlowNode["type"], extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title: id, x: 0, y: 0, ...extra });
function workflow(toolId: string, agent = false): Workflow {
  return { id: "python-tool-contract", name: "등록 Python 도구 실제 실행", description: "실제 외부 호출 없는 도구 검증", updatedAt: "2026-10-25", definition: { schemaVersion: 5, nodes: [
    node("input", "input"), node("parse", "transform", { transform: { mode: "parse_json" } }),
    agent ? node("work", "agent", { prompt: "허용된 도구로 입력을 계산하고 그 결과를 답하세요.", pythonTools: [toolId], requireToolResult: true, inputBindings: { args: { nodeId: "parse", path: "data" } } }) :
      node("work", "program", { program: { name: "python_tool", arguments: { toolId }, bindings: { arguments: "args" } }, inputBindings: { args: { nodeId: "parse", path: "data" } } }),
    node("output", "output"),
  ], edges: [{ id: "a", source: "input", target: "parse" }, { id: "b", source: "parse", target: "work" }, { id: "c", source: "work", target: "output" }] } };
}
async function sources() {
  const bundle = await build({ entryPoints: ["export-runtime/cli.ts"], bundle: true, platform: "node", format: "esm", target: "node22", write: false });
  return { node: bundle.outputFiles[0].text, python: await readFile("export-runtime/runner.py", "utf8"), helpers: {
    files: "", triggers: "", requirements: "", pythonTools: await readFile("export-runtime/flowly_tools.py", "utf8"), scientificTools: await readFile("export-runtime/toolpacks_scientific.py", "utf8"), mediaTools: await readFile("export-runtime/toolpacks_media.py", "utf8"), toolRequirements: await readFile("export-runtime/requirements-tools.txt", "utf8"),
  } };
}
const cases: { id: string; args: Record<string, Json>; expected?: Record<string, Json>; verify?: (result: Record<string, Json>) => void; optionalDependency?: boolean }[] = [
  { id: "jsonl", args: { text: '{"count":2}\n{"count":5}' }, expected: { count: 2, records: [{ count: 2 }, { count: 5 }] } },
  { id: "classification_threshold", args: { scores: [0.1, 0.6, 0.9], threshold: 0.7 }, expected: { predictions: [0, 0, 1], threshold: 0.7 } },
  { id: "wer", args: { reference: "a b c", hypothesis: "a d c" }, expected: { distance: 1, referenceWords: 3, wer: 1 / 3 } },
  { id: "data_quality", args: { rows: [{ id: 1 }, { id: 1 }, { id: null }] }, expected: { rowCount: 3, duplicateCount: 1, columns: [{ name: "id", missing: 1, types: { int: 2 } }] } },
  { id: "ssml", args: { text: "A & B" }, expected: { ssml: '<speak><prosody rate="100%">A &amp; B</prosody></speak>' } },
  { id: "bm25", args: { query: "회의실", documents: [{ id: "a", text: "회의실 예약" }, { id: "b", text: "다른 자료" }] }, verify: result => { const found = result.results as { id: string; score: number }[]; assert.equal(found[0].id, "a"); assert.ok(found[0].score > found[1].score); } },
  { id: "knowledge_graph", args: { start: "A", edges: [{ from: "A", to: "B", source: "doc-1" }, { from: "B", to: "C", source: "doc-2" }] }, verify: result => { assert.deepEqual(result.nodes, ["A", "B", "C"]); assert.equal((result.edges as Json[]).length, 2); } },
  { id: "regression", args: { trainingData: [[0], [1], [2], [3]], trainingLabels: [0, 2, 4, 6], data: [[4]] }, optionalDependency: true, verify: result => { assert.ok(Math.abs(Number((result.predictions as Json[])[0]) - 8) < 1e-10); assert.equal(result.stateFormat, "json_training_recipe"); } },
  { id: "pca", args: { data: [[0, 0], [1, 1], [2, 2]], params: { n_components: 1 } }, optionalDependency: true, verify: result => { assert.equal((result.data as Json[]).length, 3); assert.ok(Math.abs(Number((result.explainedVarianceRatio as Json[])[0]) - 1) < 1e-10); } },
  { id: "fft", args: { values: [1, 2, 3, 4] }, optionalDependency: true, verify: result => { assert.deepEqual(result.real, [10, -2, -2, -2]); assert.deepEqual(result.imag, [0, 2, 0, -2]); } },
  { id: "gamma_correction", args: { image: [[0, 64], [128, 255]], gamma: 1 }, optionalDependency: true, verify: result => { assert.deepEqual(result.image, [[0, 64], [128, 255]]); } },
  { id: "pii", args: { text: "a@example.com" }, verify: result => { assert.equal(result.sensitive, true); assert.deepEqual(result.findings, [{ category: "email", start: 0, end: 13 }]); assert.equal(result.completeDetection, false); } },
  { id: "rpa", args: { html: '<p id="result">ready</p>', actions: [{ action: "read", selector: "#result" }] }, optionalDependency: true, verify: result => { assert.deepEqual(result.observations, [{ action: "read", text: "ready" }]); assert.equal(result.networkAllowed, false); assert.equal(result.externalApplicationAccess, false); } },
];

test("actual Node.js and Python ZIP CLIs execute registered tools and preserve replay/data/error parity", async t => {
  const source = await sources(), root = await mkdtemp(join(tmpdir(), "flowly-tools-zip-"));
  try {
    for (const item of cases) {
      let first: unknown;
      for (const language of ["node", "python"] as const) await t.test(`${item.id} ${language}`, async subtest => {
        const folder = join(root, `${item.id}-${language}`);
        const archive = unzipSync(await buildExportPackage({ user, workflow: workflow(item.id), language, connections: [], resolveResources: async () => [], runnerSource: source[language], helpers: source.helpers }));
        for (const name of ["flowly_tools.py", "toolpacks_scientific.py", "toolpacks_media.py", "tool-manifest.json", "tool-contracts.json", "tool-catalog.json", "AI_PROMPT.md", "AGENTS.md", "skills/flowly-workflow/SKILL.md"]) assert.ok(archive[name], name);
        assert.equal(archive[".env"], undefined);
        assert.deepEqual(JSON.parse(strFromU8(archive["tool-manifest.json"])).tools.map((tool: { id: string }) => tool.id), [item.id]);
        const selectedRequirements = strFromU8(archive["requirements-tools.txt"]);
        if (item.id === "jsonl") assert.doesNotMatch(selectedRequirements, /numpy|opencv|torch|playwright|hnsw/);
        if (item.id === "fft") { assert.match(selectedRequirements, /numpy/); assert.match(selectedRequirements, /scipy/); assert.doesNotMatch(selectedRequirements, /torch|playwright|hnsw/); }
        await extractExportEntries(folder, archive);
        await writeFile(join(folder, ".env"), `FLOWLY_PYTHON=${testPython}\n`);
        await writeFile(join(folder, "input.json"), JSON.stringify(item.args));
        const cli = (...args: string[]) => {
          const result = spawnSync(language === "node" ? process.execPath : testPython, [...(language === "node" ? ["runner.mjs"] : ["-X", "utf8", "runner.py"]), ...args], { cwd: folder, env: environment, encoding: "utf8", timeout: 30000, windowsHide: true });
          assert.equal(result.error, undefined); assert.notEqual(result.status, null, result.stderr);
          return { exit: result.status, value: result.stdout.trim() ? JSON.parse(result.stdout) : {}, stderr: result.stderr };
        };
        const check = cli("check");
        if (item.optionalDependency && check.value.status === "unconfigured") { assert.ok(check.value.errors.length); subtest.skip(`로컬 의존성 미설정: ${check.value.errors.join(", ")}`); return; }
        assert.equal(check.value.status, "ready", JSON.stringify(check));
        const run = cli("run", "--input-file", "input.json"); assert.equal(run.exit, 0, JSON.stringify(run.value));
        assert.equal(run.value.status, "succeeded"); assert.equal(run.value.usage.turns, 0); assert.equal(run.value.usage.toolCalls, 1);
        const result = JSON.parse(run.value.result); if (item.expected) assert.deepEqual(result, item.expected); item.verify?.(result);
        if (language === "node") first = result; else assert.deepEqual(result, first);
        const resumed = cli("resume", run.value.id); assert.equal(resumed.value.usage.toolCalls, 1); assert.equal(resumed.value.result, run.value.result);
        if (item.id === "jsonl") {
          await writeFile(join(folder, "flowly_tools.py"), strFromU8(archive["flowly_tools.py"]) + "\n# changed after run\n");
          const modified = cli("resume", run.value.id); assert.equal(modified.exit, 1); assert.match(modified.stderr, /Python 도구 코드.*변경/);
          await writeFile(join(folder, "flowly_tools.py"), archive["flowly_tools.py"]);
          await writeFile(join(folder, ".env"), `FLOWLY_PYTHON=${testPython}\nFLOWLY_TOOL_MODELS={"embedding":"new-model"}\n`);
          const configuration = cli("resume", run.value.id); assert.equal(configuration.exit, 1); assert.match(configuration.stderr, /Python 도구 코드.*변경/);
          await writeFile(join(folder, ".env"), `FLOWLY_PYTHON=${testPython}\n`);
        }
        const invalid = cli("run", "--input", "{}"); assert.equal(invalid.value.status, "failed"); assert.match(invalid.value.error, /Python|도구 입력/);
      });
    }
  } finally { const inside = relative(resolve(tmpdir()), root); assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside)); await rm(root, { recursive: true, force: true }); }
});

test("Agent uses only explicitly permitted Python tools, records observations and enforces call budget", async () => {
  const flow = workflow("jsonl", true), input = JSON.stringify({ text: '{"actual":7}' });
  const run = createRun({ owner: user, mode: "test", workflow: flow, resources: [], input });
  let calls = 0;
  await executeRun(run, { tools: [], save: async () => {}, assertAccess: async (_ids, tool) => { assert.equal(tool, undefined); }, isCancelled: async () => false,
    callTool: async () => { throw new Error("MCP must never handle a local Python tool"); }, pythonTool: async request => { calls++; return pythonToolBridge(resolve("export-runtime/workflow.json"))(request); },
    model: { next: async ({ messages, tools }) => {
      assert.deepEqual(tools, [pythonToolDefinition("jsonl")]);
      const observation = messages.find(message => message.role === "tool");
      return observation ? { kind: "answer", text: observation.content, usageTokens: 1 } : { kind: "tool", toolName: "python_jsonl", args: JSON.parse(input), callId: "model-boundary-only", usageTokens: 1 };
    } },
  });
  assert.equal(run.status, "succeeded", run.error); assert.equal(calls, 1); assert.equal(run.checkpoint.calls[0].tool.implementation, "python");
  assert.deepEqual(JSON.parse(run.result), { records: [{ actual: 7 }], count: 1 });
  const absent = createRun({ owner: user, mode: "test", workflow: flow, resources: [], input });
  await executeRun(absent, { tools: [], save: async () => {}, assertAccess: async () => {}, isCancelled: async () => false, callTool: async () => null, model: { next: async () => { throw new Error("Must fail before model"); } } });
  assert.equal(absent.status, "failed"); assert.match(absent.error!, /Python 도구 미설정/); assert.equal(absent.checkpoint.turns, 0);
  const limited = createRun({ owner: user, mode: "test", workflow: flow, resources: [], input, limits: { maxToolCalls: 1 } });
  let boundedCalls = 0;
  await executeRun(limited, { tools: [], save: async () => {}, assertAccess: async () => {}, isCancelled: async () => false, callTool: async () => { throw new Error("No MCP"); },
    pythonTool: async request => { boundedCalls++; return pythonToolBridge(resolve("export-runtime/workflow.json"))(request); },
    model: { next: async () => ({ kind: "tool", toolName: "python_jsonl", args: JSON.parse(input), callId: "repeat", usageTokens: 1 }) },
  });
  assert.equal(limited.status, "budget_exceeded"); assert.equal(boundedCalls, 1);
});

test("both exported Agent CLIs use real local Python results with only model boundaries replaced by explicit fixtures", async () => {
  const source = await sources(), root = await mkdtemp(join(tmpdir(), "flowly-agent-tools-"));
  try {
    for (const language of ["node", "python"] as const) {
      const folder = join(root, language);
      const archive = unzipSync(await buildExportPackage({ user, workflow: workflow("jsonl", true), language, connections: [], resolveResources: async () => [], runnerSource: source[language], helpers: source.helpers }));
      assert.match(strFromU8(archive["START_HERE.md"]), /tool-manifest/);
      await extractExportEntries(folder, archive);
      await writeFile(join(folder, ".env"), "OPENAI_API_KEY=fixture-only-never-a-real-key\nFLOWLY_MODEL=fixture-model\n");
      await writeFile(join(folder, "input.json"), JSON.stringify({ text: '{"answer":42}' }));
      const nodeFixture = `globalThis.fetch = async (url, init) => {
        if (String(url) !== 'https://api.openai.com/v1/responses') throw new Error('Network prohibited');
        const body = JSON.parse(init.body);
        if (body.tools.length !== 1 || body.tools[0].name !== 'python_jsonl') throw new Error('Unexpected tool access');
        const observation = body.input.find(item => item.type === 'function_call_output');
        return Response.json({status:'completed',usage:{total_tokens:1},output:observation ? [{type:'message',content:[{type:'output_text',text:observation.output}]}] : [{type:'function_call',name:'python_jsonl',call_id:'explicit-model-fixture',arguments:JSON.stringify({text:'{"answer":42}'})}]});
      };`;
      const pythonFixture = `import json, sys, runner\ndef fixture(self, messages, tools, max_tokens, timeout_ms, **kwargs):\n    assert [tool['name'] for tool in tools] == ['python_jsonl']\n    observation = next((m for m in messages if m['role'] == 'tool'), None)\n    return {'kind':'answer','text':observation['content'],'usageTokens':1} if observation else {'kind':'tool','toolName':'python_jsonl','args':{'text':'{"answer":42}'},'usageTokens':1}\ndef prohibited(*args, **kwargs):\n    raise AssertionError('External tool prohibited')\nrunner.Providers.model = fixture\nrunner.Providers.tool = prohibited\nsys.exit(runner.main())\n`;
      await writeFile(join(folder, language === "node" ? "explicit-model-fixture.mjs" : "explicit_model_fixture.py"), language === "node" ? nodeFixture : pythonFixture);
      const command = language === "node" ? ["--import", "./explicit-model-fixture.mjs", "runner.mjs"] : ["-X", "utf8", "explicit_model_fixture.py"];
      const result = spawnSync(language === "node" ? process.execPath : "python", [...command, "run", "--input-file", "input.json"], { cwd: folder, env: environment, encoding: "utf8", timeout: 30000, windowsHide: true });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const run = JSON.parse(result.stdout); assert.equal(run.status, "succeeded"); assert.equal(run.usage.toolCalls, 1); assert.equal(run.usage.turns, 2);
      assert.deepEqual(JSON.parse(run.result), { records: [{ answer: 42 }], count: 1 });
      assert.equal(run.events.filter((event: { type: string }) => event.type === "tool_completed").length, 1);
      const missingFolder = join(root, `${language}-missing-model`);
      const missingArchive = unzipSync(await buildExportPackage({ user, workflow: workflow("tokens", true), language, connections: [], resolveResources: async () => [], runnerSource: source[language], helpers: source.helpers }));
      await extractExportEntries(missingFolder, missingArchive);
      await writeFile(join(missingFolder, ".env"), `OPENAI_API_KEY=fixture-only-never-a-real-key\nFLOWLY_MODEL=fixture-model\nFLOWLY_PYTHON=${testPython}\n`);
      await writeFile(join(missingFolder, "input.json"), JSON.stringify({ text: "모델이 없는 토큰 계산" }));
      await writeFile(join(missingFolder, language === "node" ? "explicit-model-fixture.mjs" : "explicit_model_fixture.py"), language === "node" ? "globalThis.fetch = async () => { throw new Error('MODEL_CALLED_BEFORE_READINESS'); };" : "import sys, runner\ndef forbidden(*args, **kwargs):\n    raise AssertionError('MODEL_CALLED_BEFORE_READINESS')\nrunner.Providers.model = forbidden\nsys.exit(runner.main())\n");
      const missing = spawnSync(language === "node" ? process.execPath : testPython, [...command, "run", "--input-file", "input.json"], { cwd: missingFolder, env: environment, encoding: "utf8", timeout: 30000, windowsHide: true });
      assert.equal(missing.status, 1); assert.match(missing.stderr, /Python 도구 미설정/); assert.doesNotMatch(missing.stdout + missing.stderr, /MODEL_CALLED_BEFORE_READINESS/);
    }
  } finally { const inside = relative(resolve(tmpdir()), root); assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside)); await rm(root, { recursive: true, force: true }); }
});
