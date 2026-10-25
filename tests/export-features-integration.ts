import { extractExportEntries } from "./export-zip";
/** Exercise the actual HTTP ZIP artifacts in both native CLIs. Optional public, tokenless MCP read. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { templateWorkflow, type Workflow } from "../app/lib/model";

const origin = "http://127.0.0.1:5173";
const temporary = await mkdtemp(join(tmpdir(), "flowly-features-"));
const liveLanguages = new Set(process.argv.includes("--live-mcp") ? ["node", "python"] : process.argv.includes("--live-mcp-python") ? ["python"] : []);
const saveExamples = process.argv.includes("--save-examples");
const environment: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(environment)) if (key.startsWith("OPENAI") || key.startsWith("FLOWLY")) delete environment[key];
let cookie = "", passed = 0;
function cli(language: "node" | "python", directory: string, args: string[]) {
  const result = spawnSync(language === "node" ? process.execPath : "python", [...(language === "python" ? ["-X", "utf8", "runner.py"] : ["runner.mjs"]), ...args], { cwd: directory, env: environment, encoding: "utf8", windowsHide: true, timeout: 150000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
async function download(language: "node" | "python", flow: Workflow, name: string) {
  const response = await fetch(origin + "/api/export", { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ language, workflow: flow }) });
  assert.equal(response.status, 200, await (response.status === 200 ? Promise.resolve("") : response.text()));
  const zip = new Uint8Array(await response.arrayBuffer());
  const directory = join(temporary, `${language}-${name}`); await mkdir(directory);
  await extractExportEntries(directory, unzipSync(zip));
  if (saveExamples) { await mkdir("outputs", { recursive: true }); await writeFile(join("outputs", `flowly-${language}-${name}.zip`), zip); }
  return directory;
}
try {
  const login = await fetch(origin + "/api/auth/test", { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ identity: "alice", return_to: "/studio" }) });
  assert.equal(login.status, 303); cookie = login.headers.get("set-cookie")!.split(";")[0];
  const comparisons: Record<string, string[]> = { data: [], retrieval: [] };
  for (const language of ["node", "python"] as const) {
    if (saveExamples) await download(language, templateWorkflow("docs-agent"), "project");
    const data = await download(language, templateWorkflow("data-processing"), "data");
    const checked = cli(language, data, ["check"]); assert.equal(checked.status, "ready"); assert.equal(checked.requiresModel, false); assert.deepEqual(checked.missingEnv, []);
    const executed = cli(language, data, ["run", "--input", '{"name":"민수","task":"회의록 정리"}']);
    assert.equal(executed.status, "succeeded"); assert.equal(executed.result, "담당자: 민수\n할 일: 회의록 정리");
    assert.equal(executed.usage.turns, 0); assert.equal(executed.usage.toolCalls, 0); comparisons.data.push(executed.result);
    cli(language, data, ["report", executed.id, "--output", "report.html"]);
    const report = await readFile(join(data, "report.html"), "utf8");
    assert.match(report, /Content-Security-Policy/); assert.match(report, /회의록 정리/); assert.doesNotMatch(report, /<script|https?:\/\/[^<]*\.js/);
    console.log(`PASS ${language}: exported JSON → transform → merge → result; check/report, zero network`); passed++;
    const retrieval = templateWorkflow("rag");
    retrieval.definition.nodes = retrieval.definition.nodes.filter(n => n.type !== "ai");
    retrieval.definition.edges = [{ id: "in", source: "input", target: "search" }, { id: "out", source: "search", target: "output" }];
    const search = await download(language, retrieval, "search");
    const found = cli(language, search, ["run", "--input", "휴가 신청 절차"]);
    assert.equal(found.status, "succeeded"); assert.match(found.result, /출처: sample-handbook/); assert.equal(found.usage.turns, 0); comparisons.retrieval.push(found.result);
    const empty = cli(language, search, ["run", "--input", "xyz-not-a-matching-document"]); assert.match(empty.result, /검색된 근거가 없어요/);
    console.log(`PASS ${language}: exported retrieval returns source evidence/no-match without model key`); passed++;
    const rag = await download(language, templateWorkflow("rag"), "rag");
    const command = language === "node" ? process.execPath : "python";
    const args = language === "node" ? ["runner.mjs", "check"] : ["-X", "utf8", "runner.py", "check"];
    const missing = spawnSync(command, args, { cwd: rag, env: environment, encoding: "utf8", windowsHide: true, timeout: 10000 });
    assert.equal(missing.status, 1); assert.equal(JSON.parse(missing.stdout).status, "unconfigured"); assert.ok(JSON.parse(missing.stdout).missingEnv.includes("OPENAI_API_KEY"));
    console.log(`PASS ${language}: RAG requires user-configured model credentials and makes no model call`); passed++;
    const direct = await download(language, templateWorkflow("direct-tool"), "direct-tool");
    const directCheck = cli(language, direct, ["check"]); assert.equal(directCheck.status, "ready"); assert.equal(directCheck.requiresModel, false);
    if (liveLanguages.has(language)) {
      const read = cli(language, direct, ["run", "--input", "Read the configured public documentation section"]);
      assert.equal(read.status, "succeeded"); assert.equal(read.usage.turns, 0); assert.equal(read.usage.toolCalls, 1); assert.match(read.result.toLowerCase(), /parallel/);
      console.log(`PASS ${language}: actual public MCP read completed once; OpenAI model calls 0`); passed++;
    }
  }
  assert.equal(comparisons.data[0], comparisons.data[1]); assert.equal(comparisons.retrieval[0], comparisons.retrieval[1]);
  console.log(`PASS native Node/Python output parity (${passed} scenarios). OpenAI model calls: 0. Public MCP tool calls: ${liveLanguages.size}. No keys read or supplied.`);
} finally {
  const path = resolve(temporary), base = resolve(tmpdir());
  assert.ok(path.startsWith(base + "\\flowly-features-") || path.startsWith(base + "/flowly-features-"));
  await rm(path, { recursive: true, force: true });
}
