import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";
import { buildExecutableExportPackage } from "../server/export-assets";
import { completion008034Designs } from "../domain/workflow-designs/completion-008-034";
import { extractExportEntries } from "./export-zip";
import { isolatedEnvironment } from "./workflow-export-integration";

test("plan 023 survives actual process death and resumes Agent without replaying persisted work in both ZIPs", async t => {
  const root = await mkdtemp(join(tmpdir(), "flowly-completed023-"));
  try {
    const nodeHook = join(root, "crash.mjs"), pythonHook = join(root, "crash.py");
    await writeFile(nodeHook, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=fs.promises.rename;fs.promises.rename=async(...args)=>{await original(...args);if(process.env.FLOWLY_CRASH_AFTER==='checkpoint'&&String(args[1]).endsWith('.json')){const value=JSON.parse(fs.readFileSync(args[1],'utf8'));if(value.run?.checkpoint?.completed.includes('checkpoint'))process.exit(86)}};syncBuiltinESMExports();`);
    await writeFile(pythonHook, `import os,json,runpy,sys\nfrom pathlib import Path\noriginal=os.replace\ndef replace(source,target):\n original(source,target)\n if os.environ.get('FLOWLY_CRASH_AFTER')=='checkpoint' and str(target).endswith('.json'):\n  value=json.loads(Path(target).read_text(encoding='utf8'))\n  if 'checkpoint' in value.get('run',{}).get('checkpoint',{}).get('completed',[]): os._exit(86)\nos.replace=replace\nrunpy.run_path(${JSON.stringify(resolve("tests/workflow-python-boundary.py")).replaceAll("\\", "\\")},run_name='__main__')\n`);
    const design = completion008034Designs.find(item => item.id === "completed-023-durable-agent-resume")!;
    assert.ok(design); const scenario = design.scenarios.find(item => item.status === "succeeded")!;
    for (const language of ["node", "python"] as const) await t.test(language, async () => {
      const folder = join(root, language); await mkdir(folder);
      const files = unzipSync(await buildExecutableExportPackage({ language, workflow: { id: design.id, name: design.title, description: design.description, updatedAt: "2026-10-25", definition: design.definition }, user: { userId: "recover", email: "recover@example.test", displayName: "복구" }, connections: [], resolveResources: async () => [] }));
      await extractExportEntries(folder, files); await writeFile(join(folder, ".scenario.json"), JSON.stringify(scenario));
      await writeFile(join(folder, ".env"), "OPENAI_API_KEY=boundary-only-placeholder\nFLOWLY_MODEL=test-model\n");
      const invoke = (args: string[], crash = false) => {
        const prefix = language === "node" ? ["--import", pathToFileURL(nodeHook).href, "--import", pathToFileURL(resolve("tests/workflow-node-preload.mjs")).href, "runner.mjs"] : ["-X", "utf8", pythonHook];
        const result = spawnSync(language === "node" ? process.execPath : "python", [...prefix, ...args, "--state", ".state"], { cwd: folder, env: { ...isolatedEnvironment(process.env), ...(crash ? { FLOWLY_CRASH_AFTER: "checkpoint" } : {}) }, windowsHide: true, encoding: "utf8", timeout: 25000 });
        assert.equal(result.error, undefined, result.stderr); return result;
      };
      const stopped = invoke(["run", "--input", scenario.input], true); assert.equal(stopped.status, 86, stopped.stderr || stopped.stdout);
      const stateFile = (await readdir(join(folder, ".state"))).find(name => /^run_.*\.json$/.test(name))!;
      const saved = JSON.parse(await readFile(join(folder, ".state", stateFile), "utf8")).run;
      assert.ok(saved.checkpoint.completed.includes("checkpoint")); assert.ok(!saved.checkpoint.completed.includes("after"));
      assert.equal(invoke(["unlock"]).status, 0);
      const waiting = JSON.parse(invoke(["resume", saved.id]).stdout); assert.equal(waiting.status, "waiting_input");
      await writeFile(join(folder, "values.json"), '{"purpose":"일일 처리량"}');
      assert.equal(invoke(["submit", saved.id, waiting.inputRequests[0].id, "--values-file", "values.json"]).status, 0);
      const finished = invoke(["resume", saved.id]); assert.equal(finished.status, 0, finished.stderr || finished.stdout);
      const run = JSON.parse(finished.stdout); assert.equal(run.id, saved.id); assert.equal(run.status, "succeeded"); assert.match(run.result, /합계 6/);
      for (const nodeId of ["before", "checkpoint", "after"]) assert.equal(run.events.filter((event: { type: string; nodeId: string }) => event.type === "node_completed" && event.nodeId === nodeId).length, 1);
      const again = JSON.parse(invoke(["resume", saved.id]).stdout); assert.deepEqual(again.usage, run.usage);
      assert.equal((await readFile(join(folder, ".model-calls.jsonl"), "utf8")).trim().split("\n").length, 1);
    });
  } finally { const part = relative(resolve(tmpdir()), root); assert.ok(part && !part.startsWith("..") && !isAbsolute(part)); await rm(root, { recursive: true, force: true }); }
});
