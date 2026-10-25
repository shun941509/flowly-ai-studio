import { extractExportEntries } from "./export-zip";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { unzipSync } from "fflate";
import type { Definition, FlowNode, Resource, Workflow } from "../app/lib/model";
import { allNodes } from "../domain/advanced-config";
import { buildExportPackage } from "../server/export-package";
import type { ExportManifest } from "../server/export-package";
import type { PublicRun, RuntimeRun } from "../runtime/types";

type Language = "node" | "python";
type Case = { name: string; maxRounds?: number; mode?: "adaptive" | "plan"; decisions: number; done: boolean; nested?: boolean };
const cases: Case[] = [
  { name: "omitted rounds finish on third decision", mode: "adaptive", decisions: 3, done: true },
  { name: "omitted rounds stop before fourth decision", mode: "adaptive", decisions: 3, done: false },
  { name: "explicit one can finish immediately", mode: "adaptive", maxRounds: 1, decisions: 1, done: true },
  { name: "explicit one cannot make a second decision", mode: "adaptive", maxRounds: 1, decisions: 1, done: false },
  { name: "explicit eight can finish on eighth decision", mode: "adaptive", maxRounds: 8, decisions: 8, done: true },
  { name: "explicit eight cannot make a ninth decision", mode: "adaptive", maxRounds: 8, decisions: 8, done: false },
  { name: "omitted mode retains one plan", decisions: 1, done: true },
  { name: "explicit plan ignores adaptive round setting", mode: "plan", maxRounds: 8, decisions: 1, done: true },
  { name: "nested omitted rounds finish on third decision", mode: "adaptive", decisions: 3, done: true, nested: true },
];
const owner = { userId: "defaults-test", email: "defaults@example.test", displayName: "기본값 검사" };
const node = (id: string, type: FlowNode["type"], extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title: id, x: 0, y: 0, ...extra });
const graph = (nodes: FlowNode[]): Definition => ({ schemaVersion: 5, nodes, edges: nodes.slice(1).map((next, index) => ({ id: `edge_${index}`, source: nodes[index].id, target: next.id })) });
const child = graph([node("input", "input"), node("copy", "transform", { transform: { mode: "template", template: "검증한 입력: {{text}}" } }), node("output", "output")]);

function workflow(spec: Case): Workflow {
  const definition = graph([node("input", "input"), node("coordinator", "orchestrator", {
    prompt: "P0_ORCHESTRATION_BOUNDARY",
    orchestration: { tasks: [{ id: "check", name: "입력 전달 검사", definition: child }], maxTasks: 1,
      ...(spec.mode === undefined ? {} : { mode: spec.mode }), ...(spec.maxRounds === undefined ? {} : { maxRounds: spec.maxRounds }) },
  }), node("output", "output")]);
  return { id: "orchestration-defaults", name: spec.name, description: "합성 응답을 사용하는 실행 경계 검사", updatedAt: "2026-10-24",
    definition: spec.nested ? graph([node("input", "input"), node("nested", "subworkflow", { subworkflow: { definition } }), node("output", "output")]) : definition };
}

const environment: NodeJS.ProcessEnv = { ...Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])), NODE_ENV: "test", PYTHONUTF8: "1", PYTHONNOUSERSITE: "1" };

function invoke(language: Language, directory: string, args: string[]) {
  const prefix = language === "node" ? ["--import", pathToFileURL(resolve("tests/workflow-node-preload.mjs")).href, "runner.mjs"] : ["-X", "utf8", resolve("tests/workflow-python-boundary.py")];
  const result = spawnSync(language === "node" ? process.execPath : "python", [...prefix, ...args], { cwd: directory, env: environment, encoding: "utf8", windowsHide: true, timeout: 20000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, null, result.stderr);
  assert.ok(result.stdout.trim(), result.stderr);
  return { status: result.status, value: JSON.parse(result.stdout) };
}

async function entries(directory: string, name: string): Promise<Record<string, unknown>[]> {
  try { return (await readFile(join(directory, name), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

test("actual exported Node/Python CLIs share orchestration and provider defaults without network", async t => {
  // Bundle the current source, not an older generated runner. Provider boundaries
  // block sockets and return explicit synthetic HTTP responses outside the ZIP.
  const bundled = await build({ entryPoints: ["export-runtime/cli.ts"], bundle: true, platform: "node", format: "esm", target: "node22", write: false });
  const sources = { node: bundled.outputFiles[0].text, python: await readFile("export-runtime/runner.py", "utf8") };
  const root = await mkdtemp(join(tmpdir(), "flowly-orchestration-defaults-"));
  const results = new Map<string, unknown>();
  try {
    for (const [index, spec] of cases.entries()) for (const language of ["node", "python"] as const) await t.test(`${language}: ${spec.name}`, async () => {
      const directory = join(root, `${index}-${language}`); await mkdir(directory);
      const zip = await buildExportPackage({ user: owner, workflow: workflow(spec), connections: [], resolveResources: async () => [], language, runnerSource: sources[language] });
      const files = unzipSync(zip);
      assert.ok(!files[".env"] && !Object.keys(files).some(name => /preload|boundary|scenario/.test(name)));
      await extractExportEntries(directory, files);
      const manifest = JSON.parse(new TextDecoder().decode(files["workflow.json"])) as ExportManifest;
      const config = allNodes(manifest.workflow.definition).find(node => node.type === "orchestrator")!.orchestration!;
      // Legacy optional fields stay omitted; no schema migration or forced rewrite.
      assert.equal(config.maxRounds, spec.maxRounds); assert.equal(config.mode, spec.mode);
      const adaptive = spec.mode === "adaptive";
      const replies = Array.from({ length: spec.decisions }, (_, i) => ({ match: "P0_ORCHESTRATION_BOUNDARY", occurrence: i + 1,
        text: JSON.stringify(adaptive ? { done: spec.done && i === spec.decisions - 1, tasks: spec.done && i === spec.decisions - 1 ? [] : ["check"] } : { tasks: ["check"] }),
        inputContains: adaptive ? ["한국어 경계 입력", `\"round\":${i + 1}`, ...(i ? ["검증한 입력: 한국어 경계 입력"] : [])] : ["한국어 경계 입력"] }));
      await writeFile(join(directory, ".scenario.json"), JSON.stringify({ modelReplies: replies }));
      const missing = invoke(language, directory, ["check"]);
      assert.equal(missing.status, 1); assert.equal(missing.value.status, "unconfigured"); assert.ok(missing.value.missingEnv.includes("OPENAI_API_KEY"));
      assert.equal((await entries(directory, ".model-calls.jsonl")).length, 0);
      await writeFile(join(directory, ".env"), "OPENAI_API_KEY=synthetic-boundary-only\nFLOWLY_MODEL=synthetic-model\n");
      const executed = invoke(language, directory, ["run", "--input", "한국어 경계 입력", "--state", ".state"]);
      const run = executed.value as PublicRun;
      assert.equal(executed.status, spec.done ? 0 : 1, JSON.stringify(run));
      assert.equal(run.status, spec.done ? "succeeded" : "budget_exceeded", JSON.stringify(run));
      assert.equal((await entries(directory, ".model-calls.jsonl")).length, spec.decisions);
      assert.deepEqual(await entries(directory, ".boundary-errors.jsonl"), []);
      assert.deepEqual(await entries(directory, ".tool-calls.jsonl"), []);
      const saved = JSON.parse(await readFile(join(directory, ".state", `${run.id}.json`), "utf8")).run as RuntimeRun;
      const coordinator = spec.nested ? saved.checkpoint.groups!.nested.children[0] : saved;
      const group = coordinator.checkpoint.groups!.coordinator;
      const childCount = adaptive ? spec.decisions - (spec.done ? 1 : 0) : 1;
      assert.equal(group.children.length, childCount);
      assert.ok(group.children.every(child => child.status === "succeeded"));
      assert.equal(group.rounds?.length ?? 0, adaptive ? spec.decisions : 0);
      assert.equal(group.planningDone ?? false, adaptive && spec.done);
      // A terminal run, including an exhausted one, never retries another model turn.
      const resumed = invoke(language, directory, ["resume", run.id, "--state", ".state"]);
      assert.equal(resumed.value.status, run.status);
      assert.equal((await entries(directory, ".model-calls.jsonl")).length, spec.decisions);
      const comparable = { status: run.status, result: run.result, turns: run.usage.turns, children: childCount, rounds: group.rounds?.length ?? 0 };
      if (language === "node") results.set(spec.name, comparable); else assert.deepEqual(comparable, results.get(spec.name));
      if (index === 0) for (const invalid of [0, 9]) {
        config.maxRounds = invalid;
        // allNodes returns references to the original node config.
        await writeFile(join(directory, "workflow.json"), JSON.stringify(manifest));
        const checked = invoke(language, directory, ["check"]);
        assert.equal(checked.status, 1); assert.equal(checked.value.status, "invalid");
        assert.equal((await entries(directory, ".model-calls.jsonl")).length, spec.decisions);
      }
    });
    const embeddingCases = [undefined, "", "   ", "  custom-embedding  "];
    for (const [index, supplied] of embeddingCases.entries()) for (const language of ["node", "python"] as const) await t.test(`${language}: provider defaults ${index} survive review and resume`, async () => {
      const directory = join(root, `provider-${index}-${language}`); await mkdir(directory);
      const resource: Resource = { id: "reference", type: "document", name: "근거", content: "cats policy", description: "", url: "", ownerId: owner.userId, visibility: "private", allowedEmails: [], createdAt: "2026-10-24", updatedAt: "2026-10-24" };
      const definition = graph([node("input", "input"), node("search", "retrieval", { retrieval: { mode: "vector", resourceIds: [resource.id], topK: 1, chunkSize: 700 } }),
        node("answer", "ai", { prompt: "P0_PROVIDER_BOUNDARY" }), node("review", "review", { review: { instructions: "결과 확인", allowEdit: false, timeoutMinutes: 10 } }), node("output", "output")]);
      definition.edges.at(-1)!.branch = "yes"; definition.nodes.push(node("denied", "output")); definition.edges.push({ id: "denied", source: "review", target: "denied", branch: "no" });
      const value: Workflow = { id: "provider-defaults", name: "모델 설정 기본값", description: "", updatedAt: "2026-10-24", definition };
      const files = unzipSync(await buildExportPackage({ user: owner, workflow: value, connections: [], resolveResources: async () => [resource], language, runnerSource: sources[language] }));
      await extractExportEntries(directory, files);
      await writeFile(join(directory, ".scenario.json"), JSON.stringify({ modelReplies: [{ match: "P0_PROVIDER_BOUNDARY", text: "확인한 답변", inputContains: ["cats policy"] }], embeddingReplies: [{ text: "cats policy", vector: [1, 0] }, { text: "cats", vector: [1, 0] }] }));
      await writeFile(join(directory, ".env"), `OPENAI_API_KEY=synthetic-boundary-only\nFLOWLY_MODEL="  synthetic-model  "\n${supplied === undefined ? "" : `FLOWLY_EMBEDDING_MODEL="${supplied}"\n`}`);
      const waiting = invoke(language, directory, ["run", "--input", "cats", "--state", ".state"]);
      assert.equal(waiting.status, 0, JSON.stringify(waiting.value)); assert.equal(waiting.value.status, "waiting_review", JSON.stringify(waiting.value));
      const expected = { model: "synthetic-model", embeddingModel: supplied?.trim() || "text-embedding-3-small" };
      assert.deepEqual(waiting.value.provider, expected);
      const stored = JSON.parse(await readFile(join(directory, ".state", `${waiting.value.id}.json`), "utf8")).run as RuntimeRun;
      assert.deepEqual(stored.provider, expected);
      // The same effective settings with whitespace removed are a valid resume;
      // completed retrieval and model calls must remain completed.
      await writeFile(join(directory, ".env"), `OPENAI_API_KEY=synthetic-boundary-only\nFLOWLY_MODEL=${expected.model}\nFLOWLY_EMBEDDING_MODEL=${expected.embeddingModel}\n`);
      assert.equal(invoke(language, directory, ["accept", waiting.value.id, waiting.value.reviews[0].id, "--state", ".state"]).status, 0);
      const resumed = invoke(language, directory, ["resume", waiting.value.id, "--state", ".state"]);
      assert.equal(resumed.status, 0, JSON.stringify(resumed.value)); assert.equal(resumed.value.status, "succeeded"); assert.equal(resumed.value.result, "확인한 답변"); assert.deepEqual(resumed.value.provider, expected);
      assert.equal((await entries(directory, ".model-calls.jsonl")).length, 1); assert.equal((await entries(directory, ".embedding-calls.jsonl")).length, 2);
      assert.deepEqual(await entries(directory, ".boundary-errors.jsonl"), []); assert.deepEqual(await entries(directory, ".tool-calls.jsonl"), []);
    });
  } finally {
    const inside = relative(resolve(tmpdir()), root);
    assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside));
    await rm(root, { recursive: true, force: true });
  }
});
