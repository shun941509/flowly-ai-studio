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
import { dynamicAgentDesigns } from "../domain/workflow-designs/dynamic-agents";
import type { PublicRun, RuntimeRun } from "../runtime/types";

const owner = { userId: "dynamic-export", email: "dynamic@example.test", displayName: "동적 실행 검증" };
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

test("actual Node and Python ZIPs generate roles, run dependency DAGs and resume supplemental input offline", async t => {
  const bundled = await build({ entryPoints: ["export-runtime/cli.ts"], bundle: true, platform: "node", format: "esm", target: "node22", write: false });
  const sources = { node: bundled.outputFiles[0].text, python: await readFile("export-runtime/runner.py", "utf8") };
  const dynamic = await readFile("export-runtime/flowly_dynamic.py", "utf8");
  const root = await mkdtemp(join(tmpdir(), "flowly-dynamic-export-"));
  const expected = new Map<string, unknown>(), design = dynamicAgentDesigns[0];
  try {
    for (const [index, scenario] of design.scenarios.entries()) for (const language of ["node", "python"] as const) await t.test(`${language}: ${scenario.name}`, async () => {
      const directory = join(root, `${index}-${language}`); await mkdir(directory);
      const workflow = { id: design.id, name: design.title, description: design.description, updatedAt: "2026-10-24", definition: design.definition };
      const files = unzipSync(await buildExportPackage({ user: owner, workflow, connections: [], resolveResources: async () => [], language, runnerSource: sources[language], helpers: { files: "", requirements: "", triggers: "", dynamic } }));
      assert.equal(Boolean(files["flowly_dynamic.py"]), language === "python");
      assert.ok(!files[".env"] && !Object.keys(files).some(name => /boundary|scenario|preload/.test(name)));
      await extractExportEntries(directory, files);
      await writeFile(join(directory, ".env"), "OPENAI_API_KEY=synthetic-boundary-only\nFLOWLY_MODEL=synthetic-model\n");
      await writeFile(join(directory, ".scenario.json"), JSON.stringify(scenario));
      let run = invoke(language, directory, ["run", "--input", scenario.input]);
      const id = run.id;
      if (scenario.inputSubmissions) {
        assert.equal(run.status, "waiting_input", JSON.stringify(run));
        for (const submission of scenario.inputSubmissions) {
          const request = run.inputRequests!.find(request => request.nodeId === submission.nodeId)!;
          assert.ok(request); const before = (await log(directory, ".model-calls.jsonl")).length;
          await writeFile(join(directory, "values.json"), JSON.stringify(submission.values));
          run = invoke(language, directory, ["submit", id, request.id, "--values-file", "values.json"]);
          assert.equal(run.status, "queued"); assert.equal((await log(directory, ".model-calls.jsonl")).length, before);
          run = invoke(language, directory, ["resume", id]); assert.equal(run.id, id);
        }
      }
      assert.equal(run.status, scenario.status, JSON.stringify(run));
      for (const text of scenario.contains ?? []) assert.ok(run.result.includes(text), run.result);
      const modelCalls = await log(directory, ".model-calls.jsonl"); assert.equal(modelCalls.length, scenario.modelReplies!.length);
      assert.deepEqual(await log(directory, ".tool-calls.jsonl"), []); assert.deepEqual(await log(directory, ".boundary-errors.jsonl"), []);
      const saved = JSON.parse(await readFile(join(directory, ".state", `${id}.json`), "utf8")).run as RuntimeRun;
      const group = saved.checkpoint.groups?.spawn;
      if (scenario.status === "succeeded") {
        assert.ok(group?.dynamicPlan); assert.equal(group.children.length, group.dynamicPlan.agents.length);
        assert.ok(group.contracts!.every(contract => contract.status === "succeeded"));
        assert.equal(saved.events.filter(event => event.type === "dynamic_plan_saved").length, 1);
      }
      const comparable = { status: run.status, result: run.result, turns: run.usage.turns, roles: group?.dynamicPlan?.agents, contracts: group?.contracts?.map(item => ({ taskId: item.taskId, status: item.status, dependsOn: item.dependsOn })), checks: group?.completionChecks };
      if (language === "node") expected.set(scenario.name, comparable); else assert.deepEqual(comparable, expected.get(scenario.name));
      invoke(language, directory, ["resume", id]); assert.equal((await log(directory, ".model-calls.jsonl")).length, modelCalls.length);
    });
  } finally {
    const location = relative(resolve(tmpdir()), root); assert.ok(location && !location.startsWith("..") && !isAbsolute(location)); await rm(root, { recursive: true, force: true });
  }
});
