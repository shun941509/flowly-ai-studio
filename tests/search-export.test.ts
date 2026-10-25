import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { unzipSync } from "fflate";
import { buildExportPackage } from "../server/export-package";
import { extractExportEntries } from "./export-zip";
import type { FlowNode, Workflow } from "../app/lib/model";
import type { PublicRun, RuntimeRun } from "../runtime/types";
import type { SearchConfig, SearchState } from "../runtime/candidate-search";
import { searchCases, treeReplies } from "./search-cases";

const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, NODE_ENV: "test", PYTHONUTF8: "1", PYTHONNOUSERSITE: "1" };
const owner = { userId: "search-export", email: "search@example.test", displayName: "후보 탐색 검증" };
const n = (id: string, type: FlowNode["type"], extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title: id, x: 0, y: 0, ...extra });
const workflow = (search: SearchConfig): Workflow => ({ id: "bounded-candidate-search", name: "실제 후보 탐색 실행기", description: "외부 응답만 테스트 경계에서 대체", updatedAt: "2026-10-24", definition: { schemaVersion: 5, nodes: [n("input", "input"), n("parse", "transform", { transform: { mode: "parse_json" } }), n("search", "candidate_search", { search, inputBindings: { items: { nodeId: "parse", path: "data.items" }, target: { nodeId: "parse", path: "data.target" } }, limits: { maxTurns: 12, maxToolCalls: 1, maxTokens: 32000, maxDurationMs: 120000 } }), n("output", "output")], edges: [{ id: "e0", source: "input", target: "parse" }, { id: "e1", source: "parse", target: "search" }, { id: "e2", source: "search", target: "output" }] } });
async function lines(directory: string, name: string) { try { return (await readFile(join(directory, name), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }

test("actual exported CLIs execute tree/graph search and recover durable proposals after abrupt exit", async t => {
  const bundle = await build({ entryPoints: ["export-runtime/cli.ts"], bundle: true, platform: "node", format: "esm", target: "node22", write: false });
  const sources = { node: bundle.outputFiles[0].text, python: await readFile("export-runtime/runner.py", "utf8") };
  const helper = await readFile("export-runtime/flowly_search.py", "utf8");
  const root = await mkdtemp(join(tmpdir(), "flowly-search-export-"));
  const nodeBoundary = pathToFileURL(resolve("tests/workflow-node-preload.mjs")).href, pythonBoundary = resolve("tests/workflow-python-boundary.py");
  const nodeCrash = join(root, "search-crash.mjs"), pythonCrash = join(root, "search-crash.py");
  await writeFile(nodeCrash, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const rename=fs.promises.rename;fs.promises.rename=async(...args)=>{await rename(...args);if(String(args[1]).endsWith('.json')){const record=JSON.parse(fs.readFileSync(args[1],'utf8'));if(record.run?.searchStates?.search?.pending?.reply)process.exit(86)}};syncBuiltinESMExports();`);
  await writeFile(pythonCrash, (await readFile(pythonBoundary, "utf8")).replace("raise SystemExit(runner.main(sys.argv[1:]))", `import os\noriginal_save=runner.Store.save\ndef crash_save(self,package_hash,run):\n    original_save(self,package_hash,run)\n    if run.get('searchStates',{}).get('search',{}).get('pending',{}).get('reply') is not None:\n        os._exit(86)\nrunner.Store.save=crash_save\nraise SystemExit(runner.main(sys.argv[1:]))`));
  try {
    const expected = new Map<string, unknown>();
    for (const [index, item] of searchCases.entries()) for (const language of ["node", "python"] as const) await t.test(`${language}: ${item.name}`, async () => {
      const folder = join(root, `${index}-${language}`); await mkdir(folder);
      const entries = unzipSync(await buildExportPackage({ language, user: owner, workflow: workflow(item.config), connections: [], resolveResources: async () => [], runnerSource: sources[language], helpers: { files: "", triggers: "", requirements: "", search: helper } }));
      assert.equal(Boolean(entries["flowly_search.py"]), language === "python"); assert.ok(!entries[".env"] && !Object.keys(entries).some(name => /scenario|boundary|crash/.test(name)));
      await extractExportEntries(folder, entries);
      await writeFile(join(folder, ".scenario.json"), JSON.stringify({ modelReplies: item.replies.map((reply, occurrence) => ({ match: "FLOWLY_CANDIDATE_SEARCH:", occurrence: occurrence + 1, text: JSON.stringify(reply), allowedTools: [] })) }));
      const cli = (args: string[], crash = false) => {
        const prefix = language === "node" ? ["--import", nodeBoundary, ...(crash ? ["--import", pathToFileURL(nodeCrash).href] : []), "runner.mjs"] : ["-X", "utf8", crash ? pythonCrash : pythonBoundary];
        const result = spawnSync(language === "node" ? process.execPath : "python", [...prefix, ...args, "--state", ".state"], { cwd: folder, env: environment, encoding: "utf8", timeout: 30000, windowsHide: true });
        assert.equal(result.error, undefined); return result;
      };
      const configuration = cli(["check"]); assert.equal(JSON.parse(configuration.stdout).status, "unconfigured");
      await writeFile(join(folder, ".env"), "OPENAI_API_KEY=synthetic-boundary-only\nFLOWLY_MODEL=synthetic-model\n");
      let result;
      if (index === 0) {
        const stopped = cli(["run", "--input", JSON.stringify(item.input)], true); assert.equal(stopped.status, 86, stopped.stderr + stopped.stdout);
        const records = (await readdir(join(folder, ".state"))).filter(name => /^run_.*\.json$/.test(name)); assert.equal(records.length, 1);
        const prior = JSON.parse(await readFile(join(folder, ".state", records[0]), "utf8")).run as RuntimeRun;
        const state = prior.searchStates!.search as unknown as SearchState; assert.equal(state.iteration, 0); assert.deepEqual(state.pending?.reply, treeReplies[0]);
        assert.equal((await lines(folder, ".model-calls.jsonl")).length, 1);
        assert.equal(cli(["unlock"]).status, 0); result = cli(["resume", prior.id]);
        assert.equal(JSON.parse(result.stdout).id, prior.id);
      } else result = cli(["run", "--input", JSON.stringify(item.input)]);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const run = JSON.parse(result.stdout) as PublicRun; assert.equal(run.status, "succeeded", JSON.stringify(run));
      const data = JSON.parse(run.result!); assert.equal(data.solved, item.solved);
      const saved = JSON.parse(await readFile(join(folder, ".state", `${run.id}.json`), "utf8")).run as RuntimeRun;
      assert.equal((await lines(folder, ".model-calls.jsonl")).length, item.replies.length); assert.deepEqual(await lines(folder, ".tool-calls.jsonl"), []); assert.deepEqual(await lines(folder, ".boundary-errors.jsonl"), []);
      if (language === "node") expected.set(item.name, { data, state: saved.searchStates?.search }); else assert.deepEqual({ data, state: saved.searchStates?.search }, expected.get(item.name));
      assert.equal(JSON.parse(cli(["resume", run.id]).stdout).status, "succeeded"); assert.equal((await lines(folder, ".model-calls.jsonl")).length, item.replies.length);
    });
  } finally {
    const contained = relative(resolve(tmpdir()), root); assert.ok(contained && !contained.startsWith("..") && !isAbsolute(contained)); await rm(root, { recursive: true, force: true });
  }
});
