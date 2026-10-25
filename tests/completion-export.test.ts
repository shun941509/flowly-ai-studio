import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";
import type { Definition, FlowNode } from "../app/lib/model";
import type { PublicRun } from "../runtime/types";
import type { WorkflowScenario } from "../domain/workflow-design";
import { buildExecutableExportPackage } from "../server/export-assets";
import { extractExportEntries } from "./export-zip";
import { isolatedEnvironment, resolveScenarioDecisions } from "./workflow-export-integration";

const n = (id: string, type: FlowNode["type"], extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title: id, x: 0, y: 0, ...extra });
const chain = (nodes: FlowNode[]): Definition => ({ schemaVersion: 5, nodes, edges: nodes.slice(1).map((target, i) => ({ id: `e${i}`, source: nodes[i].id, target: target.id })) });
const output = (source: string) => n("output", "output", { inputBindings: { text: { nodeId: source, path: "text" }, data: { nodeId: source, path: "data" } } });
const agent = (id: string) => n(id, "agent", { prompt: id, allowedTools: [], format: "JSON" });
const task = (id: string) => ({ id, name: id, definition: chain([n("input", "input"), agent(id), output(id)]) });
const budget = n("budget", "program", { program: { name: "completion", arguments: { operation: "research.budget_plan", arguments: { tasks: [{ id: "필수🚀", required: true, cost: { turns: 1, tools: 0, tokens: 5, durationMs: 5 } }] } }, bindings: {} } });

test("both shipped ZIPs execute first-match cancellation, actual budget and helper pinning without external services", async t => {
  const root = await mkdtemp(join(tmpdir(), "flowly-completion-export-"));
  try {
    for (const language of ["node", "python"] as const) for (const kind of ["race", "budget", "pin", "avatar"] as const) await t.test(`${language}/${kind}`, async () => {
      const directory = join(root, `${language}-${kind}`); await mkdir(directory);
      const graph = kind === "race" ? chain([n("input", "input"), n("race", "parallel", { parallel: { concurrency: 2, tasks: [task("SLOW_TEST:"), task("FAST_TEST:")].map((item, index) => ({ ...item, id: index ? "fast" : "slow", definition: chain([n("input", "input"), agent(index ? "fast" : "slow"), output(index ? "fast" : "slow")]) })), completion: { mode: "first_match", checks: [{ path: "data.sufficient", operator: "eq", value: true }] } } }), n("output", "output")]) : chain([n("input", "input"), agent("budget_agent"), budget, ...(kind === "pin" ? [n("wait", "form", { form: { mode: "request", fields: [{ key: "note", type: "text", label: "추가 확인", required: true }] } })] : []), output(kind === "pin" ? "wait" : "budget")]);
      if (kind === "avatar") graph.nodes = graph.nodes.map(node => node.id === "budget" ? { ...node, program: { name: "completion", arguments: { operation: "technical.avatar", arguments: { checks: [{ answer: "yes", expected: "yes" }], caption: "한글 확인 🚀", state: "intro", choice: "continue" } }, bindings: {} } } : node);
      const bytes = await buildExecutableExportPackage({ language, workflow: { id: `verify-${kind}`, name: "공통 계약 검증", description: "", updatedAt: "2026-10-25", definition: graph }, user: { userId: "test", email: "test@example.test", displayName: "검증" }, connections: [], resolveResources: async () => [] });
      const files = unzipSync(bytes);
      for (const file of ["AI_PROMPT.md", "AGENTS.md", "START_HERE.md", "WORKFLOW_GUIDE.md", "skills/flowly-workflow/SKILL.md"]) assert.ok(files[file], file);
      assert.ok(!files[".env"]);
      if (kind !== "race") for (const file of ["flowly_completions.py", "completion_research.py", "completion_programs.py", "completion_operations.py", "completion-manifest.json", "COMPLETION_PROGRAMS.md"]) assert.ok(files[file], file);
      await extractExportEntries(directory, files);
      await writeFile(join(directory, ".env"), "OPENAI_API_KEY=boundary-only-placeholder\nFLOWLY_MODEL=test-model\n");
      const scenario: WorkflowScenario = { name: kind, input: "request", status: kind === "pin" ? "waiting_input" : "succeeded", modelReplies: kind === "race" ? [{ match: "slow", text: '{"sufficient":true,"source":"slow"}', delayMs: 500 }, { match: "fast", text: '{"sufficient":true,"source":"fast"}', delayMs: 50 }] : [{ match: "budget_agent", text: '{"passed":true}' }] };
      await writeFile(join(directory, ".scenario.json"), JSON.stringify(scenario));
      const invoke = (args: string[]) => {
        const prefix = language === "node" ? ["--import", pathToFileURL(resolve("tests/workflow-node-preload.mjs")).href, "runner.mjs"] : ["-X", "utf8", resolve("tests/workflow-python-boundary.py")];
        const result = spawnSync(language === "node" ? process.execPath : "python", [...prefix, ...args], { cwd: directory, env: isolatedEnvironment(process.env), encoding: "utf8", windowsHide: true, timeout: 25000 });
        assert.equal(result.error, undefined, result.stderr); return { exit: result.status, value: result.stdout.trim() ? JSON.parse(result.stdout) : { error: result.stderr } };
      };
      const initial = invoke(["run", "--input", "request"]); assert.equal(initial.exit, 0, JSON.stringify(initial.value));
      const run = initial.value as PublicRun; assert.equal(run.status, scenario.status, run.error);
      if (kind === "race") { assert.equal(run.children!.find(child => child.taskId === "slow")!.run.status, "cancelled"); assert.equal(run.children!.find(child => child.taskId === "fast")!.run.status, "succeeded"); assert.match(run.result, /fast/); }
      if (kind === "budget") { const result = JSON.parse(run.result); assert.equal(result.state, "full"); assert.deepEqual(result.selected, ["필수🚀"]); assert.equal(result.remaining.turns, 7); assert.equal(result.remaining.tokens, 7997); }
      if (kind === "avatar") { const report = invoke(["report", run.id, "--output", "report.html"]); assert.equal(report.exit, 0); const html = await readFile(join(directory, "report.html"), "utf8"); assert.match(html, /data:image\/svg\+xml;base64,/); assert.match(html, /아바타 SVG 저장/); assert.match(html, /img-src data:/); assert.ok(!html.includes("<svg")); assert.match(run.result, /한글 확인 🚀/); }
      if (kind === "pin") {
        await writeFile(join(directory, "completion_research.py"), new TextDecoder().decode(files["completion_research.py"]) + "\n# changed after checkpoint\n");
        const denied = invoke(["resume", run.id]); assert.equal(denied.exit, 1); assert.match(JSON.stringify(denied.value), /변경/);
        await writeFile(join(directory, "completion_research.py"), files["completion_research.py"]);
        const resumed = await resolveScenarioDecisions(run, { ...scenario, status: "succeeded", inputSubmissions: [{ nodeId: "wait", values: { note: "confirmed" }, repeat: true }], resumeAgain: true }, async args => { const result = invoke(args); assert.equal(result.exit, 0, JSON.stringify(result.value)); return result.value; }, async input => { await writeFile(join(directory, "values.json"), JSON.stringify(input)); return "values.json"; });
        assert.equal(resumed.status, "succeeded");
        const calls = (await readFile(join(directory, ".model-calls.jsonl"), "utf8")).trim().split("\n"); assert.equal(calls.length, 1);
      }
    });
  } finally { const path = relative(resolve(tmpdir()), root); assert.ok(path && !path.startsWith("..") && !isAbsolute(path)); await rm(root, { recursive: true, force: true }); }
});
