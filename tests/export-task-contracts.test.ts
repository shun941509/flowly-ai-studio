import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { unzipSync } from "fflate";
import { buildExportPackage } from "../server/export-package";
import { extractExportEntries } from "./export-zip";
import type { Definition, FlowNode, Workflow } from "../app/lib/model";
import type { OrchestrationConfig, PublicRun, RuntimeRun } from "../runtime/types";

const owner = { userId: "contract-export", email: "contracts@example.test", displayName: "작업 계약" };
const n = (id: string, type: FlowNode["type"], extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title: id, x: 0, y: 0, ...extra });
const graph = (nodes: FlowNode[]): Definition => ({ schemaVersion: 5, nodes, edges: nodes.slice(1).map((node, i) => ({ id: `e${i}`, source: nodes[i].id, target: node.id })) });
const copy = graph([n("input", "input"), n("copy", "transform", { transform: { mode: "template", template: "검증한 {{text}}" } }), n("output", "output")]);
const first = { id: "first", name: "첫 작업", definition: copy };
const second = { id: "second", name: "의존 작업", dependsOn: ["first"], definition: graph([n("input", "input"), n("read", "transform", { inputBindings: { artifacts: { nodeId: "input", path: "artifacts" } }, transform: { mode: "template", template: "선행 결과: {{artifacts.first.text}}" } }), n("output", "output")]) };
const completion = [{ path: "artifacts.first.text", operator: "contains" as const, value: "검증한" }];
const waitTask = { ...first, definition: graph([n("input", "input"), n("more", "form", { form: { mode: "request", instructions: "주문번호", fields: [{ key: "orderId", type: "text", label: "주문번호", required: true }] } }), n("output", "output")]) };
type Case = { name: string; config: OrchestrationConfig; decisions: object[]; status: PublicRun["status"]; submit?: boolean; reused?: boolean };
const cases: Case[] = [
  { name: "dependency outputs", config: { tasks: [first, second], maxTasks: 2, completion: [{ path: "artifacts.second.text", operator: "contains", value: "선행 결과: 검증한" }] }, decisions: [{ tasks: ["first", "second"] }], status: "succeeded" },
  { name: "missing dependency", config: { tasks: [first, second], maxTasks: 2 }, decisions: [{ tasks: ["second", "first"] }], status: "failed" },
  { name: "premature completion", config: { tasks: [first], maxTasks: 1, mode: "adaptive", completion, maxRounds: 3 }, decisions: [{ done: true, tasks: [] }, { done: false, tasks: ["first"] }, { done: true, tasks: [] }], status: "succeeded" },
  { name: "bounded failed completion", config: { tasks: [first], maxTasks: 1, mode: "adaptive", completion, maxRounds: 2 }, decisions: [{ done: true, tasks: [] }, { done: true, tasks: [] }], status: "budget_exceeded" },
  { name: "completed task result reuse", config: { tasks: [first], maxTasks: 1, mode: "adaptive", completion, maxRounds: 3 }, decisions: [{ done: false, tasks: ["first"] }, { done: false, tasks: ["first"] }, { done: true, tasks: [] }], status: "succeeded", reused: true },
  { name: "nested input and dependency resume", config: { tasks: [waitTask, second], maxTasks: 2, completion: [{ path: "artifacts.second.text", operator: "contains", value: "A-7" }] }, decisions: [{ tasks: ["first", "second"] }], status: "succeeded", submit: true },
];
const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, NODE_ENV: "test", PYTHONUTF8: "1", PYTHONNOUSERSITE: "1" };
function invoke(language: "node" | "python", directory: string, args: string[]) {
  const prefix = language === "node" ? ["--import", pathToFileURL(resolve("tests/workflow-node-preload.mjs")).href, "runner.mjs"] : ["-X", "utf8", resolve("tests/workflow-python-boundary.py")];
  const result = spawnSync(language === "node" ? process.execPath : "python", [...prefix, ...args, "--state", ".state"], { cwd: directory, env: environment, encoding: "utf8", windowsHide: true, timeout: 20000 });
  assert.equal(result.error, undefined); assert.ok(result.stdout.trim(), result.stderr);
  return JSON.parse(result.stdout) as PublicRun;
}
async function log(directory: string, file: string) {
  try { return (await readFile(join(directory, file), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

test("generated Node and Python ZIPs execute contracts, completion and same-run input recovery offline", async t => {
  const bundled = await build({ entryPoints: ["export-runtime/cli.ts"], bundle: true, platform: "node", format: "esm", target: "node22", write: false });
  const sources = { node: bundled.outputFiles[0].text, python: await readFile("export-runtime/runner.py", "utf8") };
  const root = await mkdtemp(join(tmpdir(), "flowly-contract-export-"));
  const expected = new Map<string, unknown>();
  try {
    for (const [index, spec] of cases.entries()) for (const language of ["node", "python"] as const) await t.test(`${language}: ${spec.name}`, async () => {
      const directory = join(root, `${index}-${language}`); await mkdir(directory);
      const workflow: Workflow = { id: "task-contracts", name: spec.name, description: "오프라인 경계 검증", updatedAt: "2026-10-24", definition: graph([n("input", "input"), n("plan", "orchestrator", { prompt: "P3_PLAN_BOUNDARY", orchestration: spec.config }), n("output", "output")]) };
      const files = unzipSync(await buildExportPackage({ user: owner, workflow, connections: [], resolveResources: async () => [], language, runnerSource: sources[language] }));
      assert.ok(!files[".env"] && !Object.keys(files).some(name => /boundary|scenario|preload/.test(name)));
      await extractExportEntries(directory, files);
      await writeFile(join(directory, ".env"), "OPENAI_API_KEY=synthetic-boundary-only\nFLOWLY_MODEL=synthetic-model\n");
      await writeFile(join(directory, ".scenario.json"), JSON.stringify({ modelReplies: spec.decisions.map((reply, i) => ({ match: "P3_PLAN_BOUNDARY", occurrence: i + 1, text: JSON.stringify(reply) })) }));
      let run = invoke(language, directory, ["run", "--input", "입력"]);
      if (spec.submit) {
        assert.equal(run.status, "waiting_input", JSON.stringify(run)); const id = run.id;
        const request = run.inputRequests![0]; const before = (await log(directory, ".model-calls.jsonl")).length;
        await writeFile(join(directory, "supplemental.json"), '{"orderId":"A-7"}');
        run = invoke(language, directory, ["submit", run.id, request.id, "--values-file", "supplemental.json"]);
        assert.equal(run.status, "queued"); assert.equal((await log(directory, ".model-calls.jsonl")).length, before);
        run = invoke(language, directory, ["resume", id]); assert.equal(run.id, id);
      }
      assert.equal(run.status, spec.status, JSON.stringify(run));
      assert.equal((await log(directory, ".model-calls.jsonl")).length, spec.decisions.length);
      assert.deepEqual(await log(directory, ".tool-calls.jsonl"), []); assert.deepEqual(await log(directory, ".boundary-errors.jsonl"), []);
      const saved = JSON.parse(await readFile(join(directory, ".state", `${run.id}.json`), "utf8")).run as RuntimeRun;
      const group = saved.checkpoint.groups?.plan;
      if (group?.children.length) assert.equal(group.contracts?.length, group.children.length);
      if (spec.reused) { assert.ok(group!.children[1].events.some(event => event.type === "task_reused")); assert.equal(group!.children[1].checkpoint.turns, 0); }
      const comparable = { status: run.status, result: run.result, turns: run.usage.turns, contracts: group?.contracts?.map(item => ({ taskId: item.taskId, status: item.status, dependsOn: item.dependsOn })), checks: group?.completionChecks };
      if (language === "node") expected.set(spec.name, comparable); else assert.deepEqual(comparable, expected.get(spec.name));
      invoke(language, directory, ["resume", run.id]); assert.equal((await log(directory, ".model-calls.jsonl")).length, spec.decisions.length);
    });
  } finally {
    const location = relative(resolve(tmpdir()), root); assert.ok(location && !location.startsWith("..") && !isAbsolute(location)); await rm(root, { recursive: true, force: true });
  }
});
