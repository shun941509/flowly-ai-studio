import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";
import { buildExecutableExportPackage } from "../server/export-assets";
import { p1CheckpointDesigns } from "../domain/workflow-designs/p1-checkpoint-recovery";
import { extractExportEntries } from "./export-zip";
import type { RuntimeRun, PublicRun } from "../runtime/types";

const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, NODE_ENV: "test", PYTHONUTF8: "1", PYTHONNOUSERSITE: "1" };
const nodeBoundary = `import fs from 'node:fs';import net from 'node:net';import http from 'node:http';import https from 'node:https';import {syncBuiltinESMExports} from 'node:module';
const deny=()=>{fs.appendFileSync('.unexpected-network','blocked\\n');throw Error('external network forbidden')};globalThis.fetch=deny;net.Socket.prototype.connect=deny;http.request=deny;https.request=deny;
const rename=fs.promises.rename;fs.promises.rename=async(...args)=>{await rename(...args);if(process.env.FLOWLY_CRASH_CHECKPOINT==='1'&&String(args[1]).endsWith('.json')){const state=JSON.parse(fs.readFileSync(args[1],'utf8'));if(state.run?.checkpoint?.completed.includes('before')&&!state.run.checkpoint.completed.includes('supplement'))process.exit(86)}};syncBuiltinESMExports();`;
const pythonBoundary = `import importlib.util,os,socket,sys
from pathlib import Path
def deny(*args,**kwargs):
    Path('.unexpected-network').write_text('blocked')
    raise AssertionError('external network forbidden')
socket.socket.connect=deny
socket.create_connection=deny
spec=importlib.util.spec_from_file_location('checkpoint_runner',Path.cwd()/'runner.py')
runner=importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
saved=runner.Store.save
def save(self,package_hash,run):
    saved(self,package_hash,run)
    if os.environ.get('FLOWLY_CRASH_CHECKPOINT')=='1' and 'before' in run['checkpoint']['completed'] and 'supplement' not in run['checkpoint']['completed']:
        os._exit(86)
runner.Store.save=save
sys.exit(runner.main(sys.argv[1:]))
`;

test("production ZIPs recover the same run after actual abrupt process exit at durable checkpoint", async t => {
  const root = await mkdtemp(join(tmpdir(), "flowly-crash-recovery-"));
  try {
    const nodeHook = join(root, "crash-hook.mjs"), pythonHook = join(root, "crash-hook.py");
    await writeFile(nodeHook, nodeBoundary); await writeFile(pythonHook, pythonBoundary);
    for (const language of ["node", "python"] as const) await t.test(language, async () => {
      const directory = join(root, language); await mkdir(directory);
      const design = p1CheckpointDesigns[0];
      const files = unzipSync(await buildExecutableExportPackage({ language, user: { userId: "checkpoint", email: "checkpoint@example.test", displayName: "복구 검사" }, workflow: { id: design.id, name: design.title, description: design.description, definition: design.definition, updatedAt: "2026-10-24" }, connections: [], resolveResources: async () => [] }));
      assert.ok(!Object.keys(files).some(name => /crash-hook|fixture|boundary|scenario/.test(name))); assert.ok(!files[".env"]);
      await extractExportEntries(directory, files);
      const invoke = (args: string[], crash = false) => {
        const prefix = language === "node" ? ["--import", pathToFileURL(nodeHook).href, "runner.mjs"] : ["-X", "utf8", pythonHook];
        const result = spawnSync(language === "node" ? process.execPath : "python", [...prefix, ...args, "--state", ".state"], { cwd: directory, env: { ...environment, ...(crash ? { FLOWLY_CRASH_CHECKPOINT: "1" } : {}) }, encoding: "utf8", windowsHide: true, timeout: 20000 });
        assert.equal(result.error, undefined, result.error?.message); return result;
      };
      const checked = invoke(["check"]); assert.equal(checked.status, 0, checked.stderr); assert.equal(JSON.parse(checked.stdout).status, "ready");
      const interrupted = invoke(["run", "--input", "장애 점검 요청"], true);
      assert.equal(interrupted.status, 86, interrupted.stderr);
      const names = (await readdir(join(directory, ".state"))).filter(name => /^run_.*\.json$/.test(name)); assert.equal(names.length, 1);
      const record = JSON.parse(await readFile(join(directory, ".state", names[0]), "utf8")); const initial = record.run as RuntimeRun;
      assert.equal(initial.status, "running"); assert.deepEqual(initial.checkpoint.completed, ["input", "before"]);
      assert.equal(initial.checkpoint.outputs.before.text, "접수한 요청: 장애 점검 요청");
      assert.equal(initial.events.filter(e => e.type === "node_completed" && e.nodeId === "before").length, 1);
      assert.equal(invoke(["resume", initial.id]).status, 1, "a dead process lock must be explicitly recovered");
      const lockPath = join(directory, ".state", ".runner.lock"), deadLock = await readFile(lockPath, "utf8");
      await writeFile(lockPath, JSON.stringify({ ...JSON.parse(deadLock), pid: process.pid }));
      assert.equal(invoke(["unlock"]).status, 1, "a live process lock must not be removed");
      await writeFile(lockPath, deadLock);
      const unlocked = invoke(["unlock"]); assert.equal(unlocked.status, 0, unlocked.stderr);
      const waited = invoke(["resume", initial.id]); assert.equal(waited.status, 0, waited.stderr);
      const waiting = JSON.parse(waited.stdout) as PublicRun; assert.equal(waiting.id, initial.id); assert.equal(waiting.status, "waiting_input");
      await writeFile(join(directory, "values.json"), JSON.stringify({ assignee: "운영 담당", note: "서비스 결과 확인" }));
      const submitted = invoke(["submit", initial.id, waiting.inputRequests![0].id, "--values-file", "values.json"]); assert.equal(submitted.status, 0, submitted.stderr);
      assert.equal(JSON.parse(submitted.stdout).status, "queued");
      const resumed = invoke(["resume", initial.id]); assert.equal(resumed.status, 0, resumed.stderr);
      const finished = JSON.parse(resumed.stdout) as PublicRun; assert.equal(finished.id, initial.id); assert.equal(finished.status, "succeeded");
      assert.equal(finished.result, "접수한 요청: 장애 점검 요청\n담당자: 운영 담당\n보완 메모: 서비스 결과 확인");
      assert.equal(finished.events.filter(e => e.type === "node_completed" && e.nodeId === "before").length, 1);
      const again = JSON.parse(invoke(["resume", initial.id]).stdout) as PublicRun; assert.equal(again.events.length, finished.events.length);
      assert.equal((await readdir(join(directory, ".state"))).filter(name => /^run_.*\.json$/.test(name)).length, 1);
      assert.ok(!(await readdir(directory)).includes(".unexpected-network")); assert.equal(finished.usage.turns, 0); assert.equal(finished.usage.toolCalls, 0);
    });
  } finally {
    const location = relative(resolve(tmpdir()), root); assert.ok(location && !location.startsWith("..") && !isAbsolute(location)); await rm(root, { recursive: true, force: true });
  }
});
