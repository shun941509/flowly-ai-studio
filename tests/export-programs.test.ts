import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { build } from "esbuild";
import { unzipSync } from "fflate";
import type { FlowNode, Workflow } from "../app/lib/model";
import { buildExportPackage } from "../server/export-package";
import { executeProgram } from "../runtime/programs";
import type { ProgramConfig } from "../runtime/types";
import { extractExportEntries } from "./export-zip";
import { programCases } from "./program-cases";

const user = { userId: "programs-test", email: "programs@example.test", displayName: "계산 검증" };
const environment: NodeJS.ProcessEnv = { NODE_ENV: "test", ...Object.fromEntries(["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "PATHEXT"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])) };
const node = (id: string, type: FlowNode["type"], extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title: id, x: 0, y: 0, ...extra });
function workflow(config: ProgramConfig): Workflow {
  return { id: "registered-program-check", name: "등록 프로그램 실제 실행", description: "모델·MCP 없는 계산과 검사", updatedAt: "2026-10-24", definition: { schemaVersion: 5, nodes: [
    node("input", "input"), node("parse", "transform", { transform: { mode: "parse_json" } }),
    node("program", "program", { program: config, inputBindings: { data: { nodeId: "parse", path: "data" } } }), node("output", "output"),
  ], edges: [{ id: "a", source: "input", target: "parse" }, { id: "b", source: "parse", target: "program" }, { id: "c", source: "program", target: "output" }] } };
}

test("both real exported CLIs run six registered programs with success, failure and replay parity", async t => {
  const bundle = await build({ entryPoints: ["export-runtime/cli.ts"], bundle: true, platform: "node", format: "esm", target: "node22", write: false });
  const sources = { node: bundle.outputFiles[0].text, python: await readFile("export-runtime/runner.py", "utf8") };
  const helper = await readFile("export-runtime/flowly_programs.py", "utf8");
  const root = await mkdtemp(join(tmpdir(), "flowly-programs-"));
  try {
    for (const [index, item] of programCases.entries()) {
      const outputs = new Map<string, unknown>();
      for (const language of ["node", "python"] as const) await t.test(`${language}: ${item.title}`, async () => {
        const folder = join(root, `${index}-${language}`); await mkdir(folder);
        const config: ProgramConfig = { name: item.name, arguments: {}, bindings: Object.fromEntries(Object.keys(item.args).map(key => [key, `data.${key}`])) };
        const zip = await buildExportPackage({ user, workflow: workflow(config), language, connections: [], resolveResources: async () => [], runnerSource: sources[language], helpers: { files: "", triggers: "", requirements: "", programs: helper } });
        const entries = unzipSync(zip); assert.equal(Boolean(entries["flowly_programs.py"]), language === "python");
        assert.equal(entries[".env"], undefined); await extractExportEntries(folder, entries);
        const cli = (...args: string[]) => {
          const result = spawnSync(language === "node" ? process.execPath : "python", [...(language === "node" ? ["runner.mjs"] : ["-X", "utf8", "runner.py"]), ...args], { cwd: folder, env: environment, encoding: "utf8", timeout: 20000, windowsHide: true });
          assert.equal(result.error, undefined); assert.notEqual(result.status, null, result.stderr);
          return { exit: result.status, value: JSON.parse(result.stdout) };
        };
        const checked = cli("check"); assert.equal(checked.exit, 0, JSON.stringify(checked.value)); assert.equal(checked.value.status, "ready");
        await writeFile(join(folder, "input.json"), JSON.stringify(item.args));
        const execution = cli("run", "--input-file", "input.json");
        assert.equal(execution.exit, item.failure ? 1 : 0, JSON.stringify(execution.value));
        const run = execution.value; assert.equal(run.status, item.failure ? "failed" : "succeeded", JSON.stringify(run));
        assert.equal(run.usage.turns, 0); assert.equal(run.usage.toolCalls, 0);
        if (!item.failure) {
          const data = JSON.parse(run.result); assert.deepEqual(data, executeProgram({ name: item.name, arguments: item.args, bindings: {} }, {}).data);
          if (language === "node") outputs.set(item.title, data); else assert.deepEqual(data, outputs.get(item.title));
          const resumed = cli("resume", run.id); assert.equal(resumed.value.status, run.status); assert.equal(resumed.value.result, run.result);
          assert.equal(resumed.value.events.filter((event: { type: string; nodeId?: string }) => event.type === "node_completed" && event.nodeId === "program").length, 1);
        }
      });
    }
    await assert.rejects(buildExportPackage({ user, workflow: workflow({ name: "numeric_summary", arguments: { values: [1] }, bindings: {} }), language: "python", connections: [], resolveResources: async () => [], runnerSource: sources.python }), /프로그램 실행 도우미/);
  } finally {
    const inside = relative(resolve(tmpdir()), root); assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside));
    await rm(root, { recursive: true, force: true });
  }
});
