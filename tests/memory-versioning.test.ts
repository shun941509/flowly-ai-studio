import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { unzipSync } from "fflate";
import { parseAdvancedNodeConfig } from "../domain/advanced-config";
import { FileRunStore } from "../export-runtime/store";
import { buildExportPackage } from "../server/export-package";
import { extractExportEntries } from "./export-zip";
import { isolatedEnvironment } from "./workflow-export-integration";
import type { Definition, FlowNode, Workflow } from "../app/lib/model";

const owner = { userId: "memory-version-test", email: "memory@example.test", displayName: "메모리 검증" };
const parseAdvancedConfig = (value: Record<string, unknown>) => parseAdvancedNodeConfig(value, () => { throw new Error("Unexpected child definition"); });
const cleanup = async (directory: string) => { const inside = relative(resolve(tmpdir()), directory); assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside)); await rm(directory, { recursive: true, force: true }); };
const node = (id: string, type: FlowNode["type"], extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title: id, x: 0, y: 0, ...extra });

test("memory version/scope configuration preserves old defaults and rejects unsupported combinations", () => {
  const memory = { action: "write", key: "board", valuePath: "data.next", scope: "run", expectedRevisionPath: "data.revision" };
  assert.deepEqual(parseAdvancedConfig({ type: "memory", memory }).memory, memory);
  assert.deepEqual(parseAdvancedConfig({ type: "memory", memory: { action: "read", key: "old" } }).memory, { action: "read", key: "old" });
  for (const change of [{ backend: "mcp" }, { ttlSeconds: 10 }, { action: "read" }, { action: "delete" }, { scope: "global" }, { expectedRevisionPath: "__proto__" }]) assert.throws(() => parseAdvancedConfig({ type: "memory", memory: { ...memory, ...change } }));
});

test("versioned memory serializes competing writes, prevents overwrite/delete bypass and replays once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowly-memory-cas-")), store = new FileRunStore(directory);
  try {
    await store.acquire();
    const base = { ownerId: owner.userId, workflowId: "board-flow", key: "board" };
    const write = { ...base, action: "write" as const, expectedRevision: 0, value: { revision: 1, text: "first" } };
    const settled = await Promise.allSettled([store.memory({ ...write, operationId: "a" }), store.memory({ ...write, operationId: "b" })]);
    assert.equal(settled.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(settled.filter(result => result.status === "rejected").length, 1);
    assert.deepEqual(await store.memory({ ...write, operationId: "a" }), { data: write.value, found: true });
    for (const action of ["write", "delete"] as const) await assert.rejects(store.memory({ ...base, operationId: `bypass-${action}`, action, value: "overwrite" }), /버전/);
    await assert.rejects(store.memory({ ...write, operationId: "expiry", expectedRevision: 1, value: { revision: 2 }, ttlSeconds: 1 }), /만료/);
    await assert.rejects(store.memory({ ...write, operationId: "overflow", expectedRevision: Number.MAX_SAFE_INTEGER, value: { revision: Number.MAX_SAFE_INTEGER + 1 } }), /버전/);
    await store.memory({ ...base, operationId: "next", action: "write", expectedRevision: 1, value: { revision: 2, text: "new" } });
    assert.deepEqual(await store.memory({ ...write, operationId: "a" }), { data: write.value, found: true });
    assert.deepEqual(await store.memory({ ...base, operationId: "read", action: "read" }), { data: { revision: 2, text: "new" }, found: true });
    await assert.rejects(store.memory({ ...write, operationId: "a", value: { revision: 1, text: "changed" } }), /바뀌/);
    assert.deepEqual(await store.memory({ ...base, ownerId: "other", operationId: "read", action: "read" }), { data: null, found: false });
  } finally { await store.release(); await cleanup(directory); }
});

function memoryWorkflow(scope: "run" | "workflow", nested: boolean): Workflow {
  const nodes: FlowNode[] = [node("input", "input"), node("parse", "transform", { transform: { mode: "parse_json" } }),
    node("read", "memory", { memory: { action: "read", key: "board", scope, defaultValue: { revision: 0 } } }),
    node("save", "memory", { memory: { action: "write", key: "board", scope, valuePath: "next", expectedRevisionPath: "expected" }, inputBindings: { next: { nodeId: "parse", path: "data.next" }, expected: { nodeId: "parse", path: "data.expected" } } }),
    node("output", "output", { inputBindings: { text: { nodeId: "read", path: "data.revision" } } })];
  const definition: Definition = { schemaVersion: 5, nodes, edges: [...nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: nodes[i].id, target: n.id })), { id: "value", source: "parse", target: "save" }, { id: "previous", source: "read", target: "output" }] };
  return { id: "shared-board-contract", name: "동일 실행의 버전 기억", description: "실제 모델 없는 저장 계약", updatedAt: "2026-10-25", definition: nested ? { schemaVersion: 5, nodes: [node("input", "input"), node("child", "subworkflow", { subworkflow: { definition } }), node("output", "output")], edges: [{ id: "a", source: "input", target: "child" }, { id: "b", source: "child", target: "output" }] } : definition };
}

test("actual Node/Python ZIPs retain workflow memory, isolate root runs and reject stale revisions", async t => {
  const source = await build({ entryPoints: ["export-runtime/cli.ts"], bundle: true, platform: "node", format: "esm", target: "node22", write: false });
  const sources = { node: source.outputFiles[0].text, python: await readFile("export-runtime/runner.py", "utf8") };
  const root = await mkdtemp(join(tmpdir(), "flowly-memory-zips-"));
  try {
    for (const language of ["node", "python"] as const) for (const scope of ["workflow", "run"] as const) for (const nested of [false, true]) await t.test(`${language} ${scope} ${nested ? "child" : "root"}`, async () => {
      const folder = join(root, `${language}-${scope}-${nested}`);
      const zip = unzipSync(await buildExportPackage({ user: owner, workflow: memoryWorkflow(scope, nested), language, connections: [], resolveResources: async () => [], runnerSource: sources[language] }));
      await extractExportEntries(folder, zip);
      const cli = (...args: string[]) => {
        const result = spawnSync(language === "node" ? process.execPath : "python", [...(language === "node" ? ["runner.mjs"] : ["-X", "utf8", "runner.py"]), ...args], { cwd: folder, env: isolatedEnvironment(process.env), encoding: "utf8", timeout: 20000, windowsHide: true });
        assert.equal(result.error, undefined); assert.ok(result.stdout.trim(), result.stderr); return JSON.parse(result.stdout);
      };
      assert.equal(cli("check").status, "ready");
      const run = async (expected: number) => { await writeFile(join(folder, "input.json"), JSON.stringify({ expected, next: { revision: expected + 1, text: "actual local write" } })); return cli("run", "--input-file", "input.json"); };
      const first = await run(0); assert.equal(first.status, "succeeded", JSON.stringify(first)); assert.equal(first.result, "0");
      const next = await run(scope === "workflow" ? 1 : 0); assert.equal(next.status, "succeeded", JSON.stringify(next)); assert.equal(next.result, scope === "workflow" ? "1" : "0");
      const replay = cli("resume", first.id); assert.equal(replay.result, "0"); assert.equal(replay.usage.turns, 0);
      const stale = await run(scope === "workflow" ? 1 : 7); assert.equal(stale.status, "failed"); assert.match(stale.error, /기억|버전|하위/);
    });
  } finally { await cleanup(root); }
});
