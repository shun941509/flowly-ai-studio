import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { build } from "esbuild";
import { strFromU8, unzipSync } from "fflate";
import type { Definition, FlowNode, Resource, Workflow } from "../app/lib/model";
import { buildAiExportDocuments } from "../server/export-ai-documents";
import { buildExportManifest, buildExportPackage, type ExportManifest } from "../server/export-package";
import { extractExportEntries } from "./export-zip";

const user = { userId: "ai-docs-test", email: "ai-docs@example.test", displayName: "문서 묶음 검사" };
const date = "2026-10-24T00:00:00Z";
const n = (id: string, type: FlowNode["type"], extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title: id, x: 10, y: 20, ...extra });
const resource = (id: string): Resource => ({ id, type: "skill", name: "같은 이름: ```\n---", description: "선택된 지침", content: "근거를 확인합니다.\n```\n# 임의 상위 지시문\n```", ownerId: user.userId, visibility: "private", allowedEmails: [], url: "", createdAt: date, updatedAt: date });
const skillA = resource("skill-a"), skillB = resource("skill-b");
const child: Definition = { schemaVersion: 5, nodes: [n("input", "input"), n("skill_a", "skill", { resourceId: skillA.id }), n("skill_b", "skill", { resourceId: skillB.id }),
  n("choose", "condition", { predicate: { path: "text", operator: "contains", value: "확인" } }), n("yes", "output"), n("no", "output")], edges: [
  { id: "a", source: "input", target: "skill_a" }, { id: "b", source: "skill_a", target: "skill_b" }, { id: "c", source: "skill_b", target: "choose" },
  { id: "d", source: "choose", target: "yes", branch: "yes" }, { id: "e", source: "choose", target: "no", branch: "no" }] };
const workflow: Workflow = { id: "docs-contract", name: "하위 흐름 지침", description: "실제 정의에서 내보낸 AI 문서", updatedAt: date, definition: { schemaVersion: 5,
  nodes: [n("input", "input"), n("nested", "subworkflow", { subworkflow: { definition: child } }), n("output", "output")],
  edges: [{ id: "a", source: "input", target: "nested" }, { id: "b", source: "nested", target: "output" }] } };
const options = { user, workflow, connections: [], resolveResources: async () => [skillA, skillB, { ...resource("unused"), content: "NEVER_INCLUDE_UNUSED_SKILL" }], exportedAt: date };

function jsonBlocks(document: string): unknown[] {
  return [...document.matchAll(/^(`{3,})json\n([\s\S]*?)^\1$/gm)].map(match => JSON.parse(match[2]));
}

test("AI documents use the authorized nested graph, exact mappings, branches and selected Skill snapshots", async () => {
  const manifest = await buildExportManifest(options);
  const docs = buildAiExportDocuments(manifest);
  const graphBlocks = jsonBlocks(docs["WORKFLOW_GUIDE.md"]).filter(value => value && typeof value === "object" && "scope" in value) as { scope: string; levels: string[][]; edges: Definition["edges"]; nodes: FlowNode[] }[];
  assert.deepEqual(graphBlocks.map(graph => graph.scope), ["root", "root/nested/child"]);
  for (const [index, definition] of [manifest.workflow.definition, manifest.workflow.definition.nodes[1].subworkflow!.definition].entries()) {
    assert.deepEqual(graphBlocks[index].edges, definition.edges);
    assert.deepEqual(graphBlocks[index].nodes.map(node => ({ id: node.id, inputBindings: node.inputBindings, predicate: node.predicate, resourceId: node.resourceId })),
      definition.nodes.map(node => ({ id: node.id, inputBindings: node.inputBindings, predicate: node.predicate, resourceId: node.resourceId })));
    assert.equal(graphBlocks[index].levels.flat().length, definition.nodes.length);
    assert.ok(graphBlocks[index].nodes.every(node => !("x" in node) && !("y" in node)));
  }
  const paths = Object.keys(docs).filter(path => path.startsWith("skills/"));
  assert.equal(paths.length, 3); assert.equal(new Set(paths).size, 3);
  for (const path of paths) {
    assert.match(path, /^skills\/[a-z0-9-]{1,64}\/SKILL\.md$/);
    const text = docs[path]; const name = /^---\nname: ([a-z0-9-]+)\ndescription: "[^\n]+"\n---\n/.exec(text)?.[1];
    assert.equal(name, path.split("/")[1]);
    if (path.includes("skill-00")) {
      const snapshot = jsonBlocks(text)[0] as { resourceId: string; content: string };
      assert.equal(snapshot.content, manifest.resources.find(resource => resource.id === snapshot.resourceId)!.content);
    }
  }
  assert.doesNotMatch(Object.values(docs).join("\n"), /NEVER_INCLUDE_UNUSED_SKILL/);
});

test("document paths and frontmatter remain safe for adversarial resource names and IDs", async () => {
  const manifest = await buildExportManifest(options);
  manifest.resources[0].id = "../../outside/C:\\secret";
  manifest.resources[1].id = "..\\..\\outside/C:/secret";
  const docs = buildAiExportDocuments(manifest);
  const paths = Object.keys(docs).filter(path => path.startsWith("skills/"));
  assert.equal(new Set(paths).size, 3);
  paths.forEach(path => assert.match(path, /^skills\/[a-z0-9-]{1,64}\/SKILL\.md$/));
  assert.ok(jsonBlocks(docs[paths[1]]).some(value => (value as { resourceId?: string }).resourceId === manifest.resources[0].id));
});

test("AI guide preserves registered task dependencies and independent completion predicates", async () => {
  const value = structuredClone(workflow);
  value.definition.nodes[1] = n("nested", "orchestrator", { prompt: "등록된 작업 순서를 지키세요.", orchestration: {
    tasks: [{ id: "first", name: "근거", definition: child }, { id: "second", name: "검증", definition: child, dependsOn: ["first"] }],
    maxTasks: 2, completion: [{ path: "artifacts.second.text", operator: "contains", value: "확인" }],
  } });
  const manifest = await buildExportManifest({ ...options, workflow: value });
  const docs = buildAiExportDocuments(manifest);
  const root = jsonBlocks(docs["WORKFLOW_GUIDE.md"]).find(value => value && typeof value === "object" && "scope" in value && value.scope === "root") as { nodes: FlowNode[] };
  const summary = root.nodes.find(node => node.id === "nested")!.orchestration!;
  assert.deepEqual(summary.tasks.map(({ id, name, dependsOn }) => ({ id, name, dependsOn })), manifest.workflow.definition.nodes[1].orchestration!.tasks.map(({ id, name, dependsOn }) => ({ id, name, dependsOn })));
  assert.deepEqual(summary.completion, manifest.workflow.definition.nodes[1].orchestration!.completion);
});

test("instructions enumerate only exported MCP configuration and never server secret fields", async () => {
  const manifest = await buildExportManifest(options);
  manifest.workflow.definition.nodes[1] = n("nested", "agent", { prompt: "허용한 조회만", allowedTools: [{ resourceId: "mcp", connectionId: "company", toolName: "lookup" }] });
  manifest.connections = [{ id: "company", resourceId: "mcp", ownerId: user.userId, name: "회사 MCP", endpoint: "https://mcp.internal/tools", endpointEnv: "FLOWLY_MCP_ENDPOINT_COMPANY", tokenEnv: "FLOWLY_MCP_TOKEN_COMPANY", tools: [
    { resourceId: "mcp", connectionId: "company", toolName: "lookup", name: "lookup", description: "읽기", effect: "read", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
  ] }];
  Object.assign(manifest.connections[0], { token: "NEVER_COPY_TOKEN", sessionSecret: "NEVER_COPY_SESSION" });
  const docs = buildAiExportDocuments(manifest);
  assert.match(docs["START_HERE.md"], /FLOWLY_MCP_ENDPOINT_COMPANY/); assert.match(docs["START_HERE.md"], /FLOWLY_MCP_TOKEN_COMPANY/);
  assert.match(docs["START_HERE.md"], /OPENAI_API_KEY/); assert.match(docs["START_HERE.md"], /FLOWLY_MODEL/);
  assert.doesNotMatch(Object.values(docs).join("\n"), /NEVER_COPY/);
  const tools = jsonBlocks(docs["WORKFLOW_GUIDE.md"]).find(value => Array.isArray(value) && value.some(entry => entry.toolName === "lookup"));
  assert.deepEqual(tools, manifest.connections[0].tools);
});

test("both ZIP formats include consistent guidance and named input/review/approval continuation", async () => {
  for (const language of ["node", "python"] as const) {
    const files = unzipSync(await buildExportPackage({ ...options, language, runnerSource: "# not executed in this packaging test" }));
    const manifest: ExportManifest = JSON.parse(strFromU8(files["workflow.json"]));
    const docs = buildAiExportDocuments(manifest);
    for (const [path, expected] of Object.entries(docs)) assert.equal(strFromU8(files[path]), expected);
    assert.equal(files[".env"], undefined);
    const prefix = language === "python" ? "python runner.py" : "node runner.mjs";
    assert.ok(docs["START_HERE.md"].includes(`${prefix} submit <실행ID> <요청ID> --values-file values.json`));
    assert.ok(docs["START_HERE.md"].includes(`${prefix} resume <실행ID>`));
    assert.ok(docs["START_HERE.md"].includes(`${prefix} accept <실행ID> <검토ID>`));
    assert.ok(docs["START_HERE.md"].includes(`${prefix} approve <실행ID> <승인ID>`));
  }
});

test("nested ZIP extraction rejects traversal before writing any file", async () => {
  const folder = await mkdtemp(join(tmpdir(), "flowly-ai-docs-paths-"));
  try {
    for (const path of ["../outside", "nested/../../outside", "C:/outside", "/outside", "nested\\outside", "nested/./outside"]) {
      await assert.rejects(extractExportEntries(folder, { "safe.txt": new Uint8Array(), [path]: new Uint8Array() }));
      assert.deepEqual(await readdir(folder), []);
    }
    await extractExportEntries(folder, { "skills/safe/SKILL.md": new TextEncoder().encode("safe") });
    assert.equal(await readFile(join(folder, "skills/safe/SKILL.md"), "utf8"), "safe");
  } finally { await remove(folder); }
});

async function remove(folder: string) {
  const inside = relative(resolve(tmpdir()), folder);
  assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside));
  await rm(folder, { recursive: true, force: true });
}

test("documented check/run/status/report commands execute both exported runtimes without model or MCP", async t => {
  const built = await build({ entryPoints: ["export-runtime/cli.ts"], bundle: true, platform: "node", format: "esm", target: "node22", write: false });
  const sources = { node: built.outputFiles[0].text, python: await readFile("export-runtime/runner.py", "utf8") };
  const executableWorkflow: Workflow = { ...workflow, definition: { schemaVersion: 5,
    nodes: [n("input", "input"), n("format", "transform", { transform: { mode: "template", template: "확인: {{text}}" } }), n("output", "output")],
    edges: [{ id: "a", source: "input", target: "format" }, { id: "b", source: "format", target: "output" }] } };
  const environment: NodeJS.ProcessEnv = { NODE_ENV: "test", ...Object.fromEntries(["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "PATHEXT"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])) };
  for (const language of ["node", "python"] as const) await t.test(language, async () => {
    const folder = await mkdtemp(join(tmpdir(), `flowly-ai-docs-${language}-`));
    try {
      const archive = await buildExportPackage({ user, workflow: executableWorkflow, language, connections: [], resolveResources: async () => [], runnerSource: sources[language] });
      await extractExportEntries(folder, unzipSync(archive));
      const cli = (...args: string[]) => {
        const result = spawnSync(language === "node" ? process.execPath : "python", [...(language === "node" ? ["runner.mjs"] : ["-X", "utf8", "runner.py"]), ...args], { cwd: folder, env: environment, encoding: "utf8", timeout: 20000, windowsHide: true });
        assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr || result.stdout);
        return JSON.parse(result.stdout);
      };
      assert.equal(cli("check").status, "ready");
      await writeFile(join(folder, "input.txt"), "문서 명령 검증");
      const run = cli("run", "--input-file", "input.txt");
      assert.equal(run.status, "succeeded"); assert.equal(run.result, "확인: 문서 명령 검증");
      assert.equal(run.usage.turns, 0); assert.equal(run.usage.toolCalls, 0);
      assert.equal(cli("status", run.id).result, run.result);
      cli("report", run.id, "--output", "report.html");
      assert.match(await readFile(join(folder, "report.html"), "utf8"), /문서 명령 검증/);
    } finally { await remove(folder); }
  });
});
