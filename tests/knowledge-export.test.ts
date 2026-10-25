import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { unzipSync } from "fflate";
import type { Workflow } from "../app/lib/model";
import type { PublicRun, RuntimeRun } from "../runtime/types";
import { ragLifecycleDesigns } from "../domain/workflow-designs/rag-lifecycle";
import { buildExportPackage } from "../server/export-package";
import { extractExportEntries } from "./export-zip";
import { isolatedEnvironment } from "./workflow-export-integration";

const owner = { userId: "knowledge-export", email: "knowledge@example.test", displayName: "로컬 색인 검증" };
function invoke(language: "node" | "python", folder: string, args: string[]) {
  const prefix = language === "node" ? ["--import", pathToFileURL(resolve("tests/workflow-node-preload.mjs")).href, "runner.mjs"] : ["-X", "utf8", resolve("tests/workflow-python-boundary.py")];
  const result = spawnSync(language === "node" ? process.execPath : "python", [...prefix, ...args, "--state", ".state"], { cwd: folder, env: isolatedEnvironment(process.env), encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(result.error, undefined); assert.ok(result.stdout.trim(), result.stderr); return JSON.parse(result.stdout) as PublicRun;
}
async function log(folder: string, file: string) {
  try { return (await readFile(join(folder, file), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function subset(actual: unknown, expected: unknown, path: string) {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) for (const [key, value] of Object.entries(expected)) subset((actual as Record<string, unknown>)?.[key], value, `${path}.${key}`);
  else assert.deepEqual(actual, expected, path);
}

test("three RAG lifecycle designs run across real Node/Python ZIP processes with persistent generations", async t => {
  const bundle = await build({ entryPoints: ["export-runtime/cli.ts"], bundle: true, platform: "node", format: "esm", target: "node22", write: false });
  const sources = { node: bundle.outputFiles[0].text, python: await readFile("export-runtime/runner.py", "utf8") };
  const knowledge = await readFile("export-runtime/flowly_knowledge.py", "utf8");
  const root = await mkdtemp(join(tmpdir(), "flowly-knowledge-export-"));
  const parity = new Map<string, unknown>();
  try {
    for (const design of ragLifecycleDesigns) for (const language of ["node", "python"] as const) {
      const folders = new Set<string>();
      for (const [index, scenario] of design.scenarios.entries()) await t.test(`${design.id} / ${language}: ${scenario.name}`, async () => {
        const folder = join(root, `${design.id}-${language}-${scenario.stateGroup ?? index}`);
        if (!folders.has(folder)) {
          folders.add(folder); await mkdir(folder);
          const workflow: Workflow = { id: design.id, name: design.title, description: design.description, updatedAt: "2026-10-24", definition: design.definition };
          const bytes = await buildExportPackage({ user: owner, workflow, connections: [], resolveResources: async () => design.resources, language, runnerSource: sources[language], helpers: { files: "", triggers: "", requirements: "", knowledge } });
          const files = unzipSync(bytes); assert.equal(Boolean(files["flowly_knowledge.py"]), language === "python"); assert.ok(!files[".env"]);
          await extractExportEntries(folder, files);
          await writeFile(join(folder, ".env"), "OPENAI_API_KEY=synthetic-boundary-only\nFLOWLY_MODEL=synthetic-model\n");
        }
        for (const file of [".model-calls.jsonl", ".embedding-calls.jsonl", ".tool-calls.jsonl", ".boundary-errors.jsonl"]) await writeFile(join(folder, file), "");
        await writeFile(join(folder, ".scenario.json"), JSON.stringify(scenario));
        await writeFile(join(folder, "input.json"), scenario.input);
        const run = invoke(language, folder, ["run", "--input-file", "input.json"]);
        assert.equal(run.status, scenario.status, JSON.stringify(run));
        for (const phrase of scenario.contains ?? []) assert.ok(run.result.includes(phrase), `${phrase} missing: ${run.result}`);
        for (const phrase of scenario.excludes ?? []) assert.ok(!run.result.includes(phrase), `${phrase} unexpectedly present`);
        const saved: RuntimeRun = JSON.parse(await readFile(join(folder, ".state", `${run.id}.json`), "utf8")).run;
        for (const [id, expected] of Object.entries(scenario.outputs ?? {})) subset(saved.checkpoint.outputs[id], expected, id);
        if (scenario.embeddingCallCount !== undefined) assert.equal((await log(folder, ".embedding-calls.jsonl")).length, scenario.embeddingCallCount);
        assert.equal((await log(folder, ".model-calls.jsonl")).length, scenario.modelReplies?.length ?? 0); assert.deepEqual(await log(folder, ".tool-calls.jsonl"), []); assert.deepEqual(await log(folder, ".boundary-errors.jsonl"), []);
        const summary = { status: run.status, result: run.result ? JSON.parse(run.result) : "", embeddingCalls: (await log(folder, ".embedding-calls.jsonl")).length };
        if (language === "node") parity.set(`${design.id}/${index}`, summary); else assert.deepEqual(summary, parity.get(`${design.id}/${index}`));
        if (scenario.resumeAgain) { const again = invoke(language, folder, ["resume", run.id]); assert.equal(again.status, run.status); assert.equal(again.result, run.result); }
        if (design.id === "p3-rag-local-revocation" && index > 0 && scenario.stateGroup) {
          const memoryFile = (await readdir(join(folder, ".state"))).find(name => /memory/.test(name) && name.endsWith(".json"))!;
          const stateText = await readFile(join(folder, ".state", memoryFile), "utf8");
          assert.ok(!stateText.includes("release ready") && !stateText.includes("original chunk"), "revoked content remains in memory state/history");
        }
      });
    }
  } finally {
    const location = relative(resolve(tmpdir()), root); assert.ok(location && !location.startsWith("..") && !isAbsolute(location)); await rm(root, { recursive: true, force: true });
  }
});
