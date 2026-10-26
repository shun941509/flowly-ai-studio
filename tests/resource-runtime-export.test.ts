import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { unzipSync } from "fflate";
import type { Definition, FlowNode, Resource, Workflow } from "../app/lib/model";
import type { PublicRun, RuntimeRun } from "../runtime/types";
import { resolveResourcePrompt } from "../domain/resource-prompt";
import { parseExportManifest } from "../export-runtime/manifest";
import { buildExportPackage } from "../server/export-package";
import { extractExportEntries } from "./export-zip";

const owner = { userId: "resource-runtime", email: "resources@example.test", displayName: "자료 실행 검증" };
const date = "2026-10-27T00:00:00.000Z";
const n = (id: string, type: FlowNode["type"], extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title: id, x: 0, y: 0, ...extra });
const graph = (nodes: FlowNode[]): Definition => ({ schemaVersion: 5, nodes, edges: nodes.slice(1).map((node, index) => ({ id: `e${index}`, source: nodes[index].id, target: node.id })) });
const material = (id: string, type: Resource["type"], content = ""): Resource => ({ id, type, content, ownerId: owner.userId, name: id, description: "실제 로컬 실행 검증용 자료", url: "", visibility: "private", allowedEmails: [], createdAt: date, updatedAt: date });
const prompt: Resource = { ...material("prompt", "prompt", "{{topic}} / {{count}} / {{optional}}"), details: { version: 1, prompt: { variables: [{ name: "topic", type: "string", required: true }, { name: "count", type: "number", required: true, defaultValue: 3 }, { name: "optional", type: "string", required: false }] } } };

test("Prompt uses typed binding/value/default precedence and one-pass interpolation without a model", () => {
  const resolved = resolveResourcePrompt(prompt, { text: "{{count}}" }, { topic: "ignored", count: 4 }, { topic: "text" });
  assert.equal(resolved.text, "{{count}} / 4 / "); assert.deepEqual({ ...resolved.values }, { topic: "{{count}}", count: 4 });
  assert.equal(resolveResourcePrompt(prompt, {}, { topic: "제목" }).text, "제목 / 3 / ");
  assert.throws(() => resolveResourcePrompt(prompt), /필수/);
  assert.throws(() => resolveResourcePrompt(prompt, {}, { topic: "제목", count: "3" }), /Prompt 변수/);
  assert.throws(() => resolveResourcePrompt(prompt, {}, { topic: "제목", extra: true }), /등록되지/);
  assert.throws(() => resolveResourcePrompt(prompt, {}, {}, { topic: "missing.value" }), /찾지/);
  assert.equal(resolveResourcePrompt(material("plain", "prompt", "{{unchanged}} literal")).text, "{{unchanged}} literal");
});

test("Node and Python reject unsupported resource extension fields and limits consistently", () => {
  const base = { format: "flowly-executable-export", version: 1, language: "node", exportedAt: date, owner, workflow: { id: "parse", name: "검사", description: "", updatedAt: date, definition: graph([n("input", "input"), n("resource", "resource", { resourceId: prompt.id }), n("output", "output")]) }, resources: [{ ...prompt, allowedEmails: undefined }], connections: [] };
  const variants = [
    { version: true }, { version: 1, unknown: true }, { version: 1, purpose: "가".repeat(4001) }, { version: 1, inputExample: "x".repeat(20001) },
    { version: 1, verification: { kind: "user_reported", checkedAt: date, environment: "", scope: "scope", outcome: "passed" } },
    { version: 1, prompt: null }, { version: 1, prompt: { variables: [], unknown: true } }, { version: 1, prompt: { variables: [], role: "x".repeat(4001) } },
    { version: 1, prompt: { variables: [{ name: "x", type: "string", required: true, unknown: true }] } },
    { version: 1, prompt: { variables: [{ name: "x".repeat(65), type: "string", required: true }] } },
    { version: 1, prompt: { variables: [{ name: "x", type: "string", required: true, description: "x".repeat(501) }] } },
    { version: 1, prompt: { variables: [{ name: "x", type: "number", required: false, defaultValue: "wrong" }] } },
    { version: 1, prompt: { variables: [], sampleInput: { undeclared: "no" } } },
    { version: 1, prompt: { variables: [{ name: "x", type: "number", required: false }], sampleInput: { x: "wrong" } } },
    { version: 1, document: { extractionStatus: "provided", extractedText: "" } },
    { version: 1, document: { extractionStatus: "not_requested", unknown: true } },
    { version: 1, document: { extractionStatus: "not_requested", source: "x".repeat(2001) } },
    { version: 1, document: { extractionStatus: "not_requested", originalFileId: null } },
    { version: 1, skill: { kind: "instruction", unknown: true } },
    { version: 1, skill: { kind: "package", executions: [] } },
    { version: 1, verification: { kind: "user_reported", checkedAt: date, environment: "test", scope: "scope", outcome: "passed", unknown: true } },
  ];
  const manifests = variants.map(details => JSON.parse(JSON.stringify({ ...base, resources: [{ ...base.resources[0], type: "document" in details ? "document" : "skill" in details ? "skill" : "prompt", details }] })));
  for (const manifest of manifests) assert.throws(() => parseExportManifest(manifest));
  const script = "import copy,importlib.util,json,sys\ns=importlib.util.spec_from_file_location('resource_runner',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nresults=[]\nfor p in json.load(sys.stdin):\n p['language']='python'\n try: m.validate_package(p);results.append(True)\n except Exception: results.append(False)\nprint(json.dumps(results))";
  const result = spawnSync("python", ["-X", "utf8", "-c", script, resolve("export-runtime/runner.py")], { input: JSON.stringify(manifests), encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), variants.map(() => false));
});

const environment: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, PYTHONUTF8: "1", PYTHONNOUSERSITE: "1", OPENAI_API_KEY: "test-secret-must-not-reach-skill", FLOWLY_MCP_TOKEN_TEST: "test-mcp-secret" };
type Language = "node" | "python";
function invoke(language: Language, directory: string, args: string[], boundary = false) {
  const prefix = language === "node" ? [...(boundary ? ["--import", pathToFileURL(resolve("tests/workflow-node-preload.mjs")).href] : []), "runner.mjs"] : ["-X", "utf8", boundary ? resolve("tests/workflow-python-boundary.py") : "runner.py"];
  const child = spawnSync(language === "node" ? process.execPath : "python", [...prefix, ...args, "--state", ".state"], { cwd: directory, env: environment, encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 3_000_000 });
  assert.equal(child.error, undefined); return { ...child, value: child.stdout.trim() ? JSON.parse(child.stdout) as PublicRun & { errors?: string[] } : undefined };
}
const pythonCode = "import json,sys,os\nfrom pathlib import Path\na=json.load(sys.stdin)\np=Path('count.txt'); p.write_text(p.read_text()+'x' if p.exists() else 'x')\nprint(json.dumps({'text':a['topic']+':'+str(a['count']*2),'credentialAbsent':not any(k in os.environ for k in ['OPENAI_API_KEY','FLOWLY_MCP_TOKEN_TEST'])}))\n";
const javascriptCode = "import fs from 'node:fs';const a=JSON.parse(fs.readFileSync(0,'utf8'));fs.appendFileSync('count.txt','x');console.log(JSON.stringify({text:a.topic+':'+(a.count*2),credentialAbsent:!process.env.OPENAI_API_KEY&&!process.env.FLOWLY_MCP_TOKEN_TEST}));\n";
function skillResource(code: string, language: "python" | "javascript" = "python", timeoutMs = 3000, maxOutputBytes = 5000) {
  const bytes = Buffer.from(code); const file = { id: "script", path: `scripts/main.${language === "python" ? "py" : "mjs"}`, mimeType: "text/plain", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), createdAt: date };
  const resource: Resource = { ...material("skill", "skill", "승인받은 코드만 실행합니다. [실행 파일](" + file.path + ")"), files: [file], details: { version: 1, skill: { kind: "executable", executions: [{ id: "calculate", language, entryFileId: file.id, dependencies: [], effect: "read", timeoutMs, maxOutputBytes, inputSchema: { type: "object", properties: { topic: { type: "string" }, count: { type: "number" } }, required: ["topic", "count"], additionalProperties: false }, outputSchema: { type: "object", properties: { text: { type: "string" }, credentialAbsent: { type: "boolean" } }, required: ["text", "credentialAbsent"], additionalProperties: false } }] } } };
  return { resource, bytes };
}
const skillGraph = () => graph([n("input", "input"), n("prompt", "resource", { resourceId: "prompt", resourceBindings: { topic: "text" } }), n("skill", "skill", { resourceId: "skill", inputBindings: { variables: { nodeId: "prompt", path: "prompt.values" } }, skillExecution: { entryId: "calculate", arguments: {}, bindings: { topic: "variables.topic", count: "variables.count" } } }), n("output", "output", { inputBindings: { text: { nodeId: "skill", path: "data.text" } } })]);

test("downloaded Node and Python ZIPs execute real Skill code with approval, files and typed resources; no external service", async t => {
  const bundled = await build({ entryPoints: ["export-runtime/cli.ts"], bundle: true, platform: "node", format: "esm", target: "node22", write: false });
  const sources = { node: bundled.outputFiles[0].text, python: await readFile("export-runtime/runner.py", "utf8") };
  const helpers = { skills: await readFile("export-runtime/flowly_skills.py", "utf8"), files: await readFile("export-runtime/flowly_files.py", "utf8"), knowledge: await readFile("export-runtime/flowly_knowledge.py", "utf8"), triggers: "", requirements: await readFile("export-runtime/requirements-files.txt", "utf8") };
  const root = await mkdtemp(join(tmpdir(), "flowly-resource-export-"));
  async function pack(language: Language, name: string, definition: Definition, resources: Resource[], payloads: { resource: Resource; bytes: Buffer; fileId?: string }[] = [], connections: Parameters<typeof buildExportPackage>[0]["connections"] = []) {
    const directory = join(root, `${language}-${name}`); await mkdir(directory);
    const workflow: Workflow = { id: "resource-contract", name, description: "실제 로컬 코드와 명시적인 서비스 테스트 대역만 사용", updatedAt: date, definition };
    const files = unzipSync(await buildExportPackage({ user: owner, workflow, language, connections, resolveResources: async () => resources, resolveResourceFiles: async () => payloads.map(({ resource, bytes, fileId }) => ({ resourceId: resource.id, file: fileId ? resource.files!.find(file => file.id === fileId)! : resource.files![0], bytes })), runnerSource: sources[language], helpers }));
    await extractExportEntries(directory, files); return { directory, manifest: JSON.parse(Buffer.from(files["workflow.json"]).toString()) };
  }
  try {
    for (const language of ["node", "python"] as const) {
      await t.test(`${language}: blank and UTF-16 20,000-unit input limits match`, async () => {
        const { directory } = await pack(language, "input-limit", graph([n("input", "input"), n("output", "output")]), []);
        for (const input of ["", "   ", "😀".repeat(10000)]) {
          await writeFile(join(directory, "input.txt"), input);
          const run = invoke(language, directory, ["run", "--input-file", "input.txt"]).value!;
          assert.equal(run.status, "succeeded", JSON.stringify(run)); assert.equal(run.result, input);
        }
        await writeFile(join(directory, "input.txt"), "😀".repeat(10000) + "a");
        assert.notEqual(invoke(language, directory, ["run", "--input-file", "input.txt"]).status, 0);
      });
      for (const codeLanguage of ["python", "javascript"] as const) await t.test(`${language}: approved ${codeLanguage}, resume, duplicate and stripped credentials`, async () => {
        const skill = skillResource(codeLanguage === "python" ? pythonCode : javascriptCode, codeLanguage);
        const { directory, manifest } = await pack(language, codeLanguage, skillGraph(), [prompt, skill.resource], [skill]);
        assert.equal(invoke(language, directory, ["check"]).value!.status, "ready");
        const waiting = invoke(language, directory, ["run", "--input", "설계"]).value!;
        assert.equal(waiting.status, "waiting_approval", JSON.stringify(waiting));
        const approval = waiting.approvals[0]; assert.equal(approval.effect, "write");
        assert.equal(invoke(language, directory, ["approve", waiting.id, approval.id]).value!.status, "queued");
        const run = invoke(language, directory, ["resume", waiting.id]).value!;
        assert.equal(run.status, "succeeded", JSON.stringify(run)); assert.equal(run.result, "설계:6");
        const saved = JSON.parse(await readFile(join(directory, ".state", `${run.id}.json`), "utf8")).run as RuntimeRun;
        assert.equal((saved.checkpoint.calls[0].result as { credentialAbsent: boolean }).credentialAbsent, true);
        assert.equal(saved.checkpoint.calls[0].attempts, 1);
        invoke(language, directory, ["resume", waiting.id]);
        const file = manifest.resources.find((item: Resource) => item.id === "skill").files[0];
        const count = join(directory, file.exportPath.slice(0, -file.path.length), "count.txt");
        assert.equal(await readFile(count, "utf8"), "x");
      });
      await t.test(`${language}: denied Skill never executes`, async () => {
        const skill = skillResource(pythonCode); const { directory } = await pack(language, "deny", skillGraph(), [prompt, skill.resource], [skill]);
        const waiting = invoke(language, directory, ["run", "--input", "거절"]).value!;
        invoke(language, directory, ["deny", waiting.id, waiting.approvals[0].id]);
        const run = invoke(language, directory, ["resume", waiting.id]).value!; assert.equal(run.status, "failed"); assert.equal(run.usage.toolCalls, 0);
      });
      await t.test(`${language}: instruction-only Skill does not execute attached code`, async () => {
        const skill = skillResource(pythonCode);
        const definition = graph([n("input", "input"), n("skill", "skill", { resourceId: "skill" }), n("output", "output")]);
        const { directory } = await pack(language, "instruction-only", definition, [skill.resource], [skill]);
        const run = invoke(language, directory, ["run", "--input", "지침"]).value!;
        assert.equal(run.status, "succeeded", JSON.stringify(run)); assert.equal(run.usage.toolCalls, 0); assert.equal(run.approvals.length, 0);
      });
      await t.test(`${language}: selected Python code imports a hashed companion module`, async () => {
        const skill = skillResource("import json,sys\nfrom companion import calculate\nprint(json.dumps(calculate(json.load(sys.stdin))))\n");
        const bytes = Buffer.from("def calculate(args):\n return {'text': args['topic']+':'+str(args['count']*3), 'credentialAbsent': True}\n");
        skill.resource.files!.push({ id: "companion", path: "scripts/companion.py", mimeType: "text/plain", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), createdAt: date });
        const { directory } = await pack(language, "companion", skillGraph(), [prompt, skill.resource], [skill, { resource: skill.resource, bytes, fileId: "companion" }]);
        const waiting = invoke(language, directory, ["run", "--input", "모듈"]).value!;
        invoke(language, directory, ["approve", waiting.id, waiting.approvals[0].id]);
        const run = invoke(language, directory, ["resume", waiting.id]).value!; assert.equal(run.status, "succeeded", JSON.stringify(run)); assert.equal(run.result, "모듈:9");
      });
      await t.test(`${language}: cancellation terminates selected code before a delayed side effect`, async () => {
        const skill = skillResource("import time\nfrom pathlib import Path\nPath('started.txt').write_text('ready')\ntime.sleep(2)\nPath('late.txt').write_text('must not happen')\nprint('{}')\n", "python", 10000);
        const { directory, manifest } = await pack(language, "cancel", skillGraph(), [prompt, skill.resource], [skill]);
        const waiting = invoke(language, directory, ["run", "--input", "취소"]).value!;
        invoke(language, directory, ["approve", waiting.id, waiting.approvals[0].id]);
        const file = manifest.resources.find((item: Resource) => item.id === "skill").files[0], cwd = join(directory, file.exportPath.slice(0, -file.path.length));
        const cancel = ".flowly-ops/cancel/skill.cancel"; await mkdir(join(directory, ".flowly-ops/cancel"), { recursive: true });
        const prefix = language === "node" ? ["runner.mjs"] : ["-X", "utf8", "runner.py"];
        const child = spawn(language === "node" ? process.execPath : "python", [...prefix, "resume", waiting.id, "--state", ".state", "--cancel-file", cancel], { cwd: directory, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = ""; child.stdout.setEncoding("utf8").on("data", data => { stdout += data; }); child.stderr.setEncoding("utf8").on("data", data => { stderr += data; });
        const done = new Promise<void>((resolveDone, reject) => { child.once("error", reject); child.once("close", () => resolveDone()); });
        const deadline = Date.now() + 10000;
        let started = false;
        while (Date.now() < deadline) { try { await readFile(join(cwd, "started.txt")); started = true; break; } catch { await new Promise(resolveWait => setTimeout(resolveWait, 50)); } }
        await writeFile(join(directory, cancel), "cancel"); await done; assert.ok(started, stderr);
        const run = JSON.parse(stdout) as PublicRun; assert.equal(run.status, "unknown_outcome", stdout); assert.equal(run.usage.toolCalls, 1);
        await new Promise(resolveWait => setTimeout(resolveWait, 2200));
        await assert.rejects(readFile(join(cwd, "late.txt")), { code: "ENOENT" });
      });
      await t.test(`${language}: changed Skill bytes block approval and resume`, async () => {
        const skill = skillResource(pythonCode); const { directory, manifest } = await pack(language, "changed", skillGraph(), [prompt, skill.resource], [skill]);
        const waiting = invoke(language, directory, ["run", "--input", "변경"]).value!;
        await writeFile(join(directory, manifest.resources.find((item: Resource) => item.id === "skill").files[0].exportPath), "print('changed')");
        const approved = invoke(language, directory, ["approve", waiting.id, waiting.approvals[0].id]); assert.notEqual(approved.status, 0);
        assert.notEqual(invoke(language, directory, ["resume", waiting.id]).status, 0);
      });
      for (const failure of ["timeout", "overflow", "schema"] as const) await t.test(`${language}: ${failure} is unknown and never retried`, async () => {
        const code = failure === "timeout" ? "import time\ntime.sleep(3)\n" : failure === "overflow" ? "print('x'*10000)\n" : "print('{}')\n";
        const skill = skillResource(code, "python", failure === "timeout" ? 100 : 3000, failure === "overflow" ? 100 : 5000);
        const { directory } = await pack(language, failure, skillGraph(), [prompt, skill.resource], [skill]);
        const waiting = invoke(language, directory, ["run", "--input", "실패"]).value!;
        invoke(language, directory, ["approve", waiting.id, waiting.approvals[0].id]);
        const failed = invoke(language, directory, ["resume", waiting.id]).value!; assert.equal(failed.status, "unknown_outcome", JSON.stringify(failed)); assert.equal(failed.usage.toolCalls, 1);
        const again = invoke(language, directory, ["resume", waiting.id]).value!; assert.equal(again.status, "unknown_outcome"); assert.equal(again.usage.toolCalls, 1);
      });
      await t.test(`${language}: Document original connects to actual file input and text extraction`, async () => {
        const bytes = Buffer.from("자료 원본 내용\nsecond line", "utf8");
        const doc: Resource = { ...material("document", "document", "원본 파일은 별도 보존"), files: [{ id: "original", path: "manual.txt", size: bytes.length, mimeType: "text/plain", sha256: createHash("sha256").update(bytes).digest("hex"), createdAt: date }], details: { version: 1, document: { originalFileId: "original", extractionStatus: "pending_local" } } };
        const definition = graph([n("input", "input"), n("document", "resource", { resourceId: "document" }), n("file", "file_input", { inputBindings: { path: { nodeId: "document", path: "document.originalPath" } }, fileInput: { path: "path", maxBytes: 10000 } }), n("extract", "document_extract", { inputBindings: { file: { nodeId: "file", path: "file" } }, documentExtract: { mode: "text", filePath: "file", maxPages: 10, language: "kor" } }), n("output", "output")]);
        const { directory } = await pack(language, "document", definition, [doc], [{ resource: doc, bytes }]);
        const run = invoke(language, directory, ["run", "--input", ""]).value!; assert.equal(run.status, "succeeded", JSON.stringify(run)); assert.match(run.result, /자료 원본 내용/);
      });
      await t.test(`${language}: retrieval uses provided extraction, preserves legacy content and explains pending state`, async () => {
        for (const state of ["provided", "pending_local", "legacy"] as const) {
          const doc: Resource = { ...material("document", "document", "이전 본문 정책"), ...(state === "legacy" ? {} : { details: { version: 1 as const, document: { extractionStatus: state, ...(state === "provided" ? { extractedText: "검증된 추출본 정책" } : {}) } } }) };
          const { directory } = await pack(language, `rag-${state}`, graph([n("input", "input"), n("retrieve", "retrieval", { retrieval: { resourceIds: [doc.id], topK: 3, chunkSize: 200, mode: "lexical" } }), n("output", "output")]), [doc]);
          const run = invoke(language, directory, ["run", "--input", "정책"]).value!;
          assert.equal(run.status, state === "pending_local" ? "failed" : "succeeded", JSON.stringify(run));
          if (state === "pending_local") assert.match(run.error!, /텍스트 추출.*문서 내용 추출/);
          else { assert.match(run.result, state === "provided" ? /검증된 추출본 정책/ : /이전 본문 정책/); if (state === "provided") assert.doesNotMatch(run.result, /이전 본문/); }
        }
      });
      await t.test(`${language}: vector retrieval embeds the extracted text through an explicit test boundary`, async () => {
        const doc: Resource = { ...material("document", "document", "검색하면 안 되는 설명"), details: { version: 1, document: { extractionStatus: "provided", extractedText: "추출된 벡터 정책" } } };
        const { directory } = await pack(language, "rag-vector", graph([n("input", "input"), n("retrieve", "retrieval", { retrieval: { resourceIds: [doc.id], topK: 3, chunkSize: 200, mode: "vector" } }), n("output", "output")]), [doc]);
        await writeFile(join(directory, ".env"), "OPENAI_API_KEY=synthetic-boundary-only\n");
        await writeFile(join(directory, ".scenario.json"), JSON.stringify({ embeddingReplies: [{ text: "추출된 벡터 정책", vector: [1, 0] }, { text: "정책", vector: [1, 0] }] }));
        const run = invoke(language, directory, ["run", "--input", "정책"], true).value!;
        assert.equal(run.status, "succeeded", JSON.stringify(run)); assert.match(run.result, /추출된 벡터 정책/); assert.doesNotMatch(run.result, /검색하면 안/);
      });
      await t.test(`${language}: knowledge stage/evaluate/publish/query use extracted text`, async () => {
        const doc: Resource = { ...material("document", "document", "색인하지 않을 설명"), details: { version: 1, document: { extractionStatus: "provided", extractedText: "지식 색인 정책 원문" } } };
        const common = { indexKey: "resource_index", resourceIds: [doc.id], mode: "lexical" as const };
        const definition = graph([n("input", "input"), n("stage", "knowledge", { knowledge: { ...common, action: "stage" } }), n("evaluate", "knowledge", { inputBindings: { generation: { nodeId: "stage", path: "generation" } }, knowledge: { ...common, action: "evaluate", generationPath: "generation", evaluation: [{ query: "정책", resourceId: doc.id }] } }), n("publish", "knowledge", { inputBindings: { generation: { nodeId: "evaluate", path: "generation" } }, knowledge: { ...common, action: "publish", generationPath: "generation" } }), n("question", "transform", { transform: { mode: "template", template: "정책" } }), n("query", "knowledge", { knowledge: { ...common, action: "query" } }), n("output", "output")]);
        const { directory } = await pack(language, "knowledge-extracted", definition, [doc]);
        const run = invoke(language, directory, ["run", "--input", ""]).value!; assert.equal(run.status, "succeeded", JSON.stringify(run)); assert.match(run.result, /지식 색인 정책 원문/); assert.doesNotMatch(run.result, /색인하지 않을/);
      });
      await t.test(`${language}: pending knowledge input is explicit and does not eagerly read unavailable extraction`, async () => {
        const doc: Resource = { ...material("document", "document", "설명"), details: { version: 1, document: { extractionStatus: "pending_local" } } };
        for (const explicit of [false, true]) {
          const definition = graph([n("input", "input"), n("parse", "transform", { transform: { mode: "parse_json" } }), n("stage", "knowledge", { inputBindings: { docs: { nodeId: "parse", path: "data.docs" } }, knowledge: { indexKey: "pending_docs", resourceIds: [doc.id], action: "stage", ...(explicit ? { documentsPath: "docs" } : {}) } }), n("output", "output")]);
          const { directory } = await pack(language, `knowledge-pending-${explicit}`, definition, [doc]);
          const run = invoke(language, directory, ["run", "--input", JSON.stringify({ docs: [{ resourceId: doc.id, version: date, content: "로컬 추출기에서 전달한 본문" }] })]).value!;
          assert.equal(run.status, explicit ? "succeeded" : "failed", JSON.stringify(run)); if (!explicit) assert.match(run.error!, /추출이 완료되지/);
        }
      });
      await t.test(`${language}: MCP structured output schema protects mapped downstream value`, async () => {
        const resource = { ...material("mcp", "mcp"), url: "https://mcp.example.test/mcp" };
        const connection = { id: "mcp", ownerId: owner.userId, resourceId: resource.id, name: "명시적 테스트 대역", endpoint: resource.url, tools: [{ resourceId: resource.id, connectionId: "mcp", toolName: "lookup", name: "lookup", description: "조회", effect: "read" as const, inputSchema: { type: "object" as const }, outputSchema: { type: "object" as const, properties: { count: { type: "number" as const } }, required: ["count"] }, outputTarget: "structuredContent" as const }] };
        const definition = graph([n("input", "input"), n("lookup", "tool", { allowedTools: [{ resourceId: "mcp", connectionId: "mcp", toolName: "lookup" }], tool: { arguments: {}, bindings: {} } }), n("output", "output", { inputBindings: { text: { nodeId: "lookup", path: "data.structuredContent.count" } } })]);
        for (const valid of [true, false]) {
          const { directory } = await pack(language, `mcp-${valid}`, definition, [resource], [], [connection]);
          await writeFile(join(directory, ".scenario.json"), JSON.stringify({ toolReplies: [{ name: "lookup", args: {}, result: { structuredContent: { count: valid ? 7 : "wrong" }, content: [] }, count: 2 }] }));
          const run = invoke(language, directory, ["run", "--input", ""], true).value!;
          assert.equal(run.status, valid ? "succeeded" : "failed", JSON.stringify(run)); if (valid) assert.equal(run.result, "7");
        }
      });
    }
  } finally { const location = relative(resolve(tmpdir()), root); assert.ok(location && !location.startsWith("..") && !isAbsolute(location)); await rm(root, { recursive: true, force: true }); }
});
