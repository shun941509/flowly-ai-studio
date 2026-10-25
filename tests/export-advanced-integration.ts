import { extractExportEntries } from "./export-zip";
/** Actual downloaded native CLIs, with no provider credentials and no network calls from runners. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { templateWorkflow, type Workflow } from "../app/lib/model";

const origin = "http://127.0.0.1:5173";
const temporary = await mkdtemp(join(tmpdir(), "flowly-advanced-"));
const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, PATHEXT: process.env.PATHEXT };
const saveExamples = process.argv.includes("--save-examples");
const results: Record<string, string[]> = {};
let cookie = "", checks = 0;
type Language = "node" | "python";
function cli(language: Language, cwd: string, args: string[], code = 0) {
  const executed = spawnSync(language === "node" ? process.execPath : "python", [...(language === "node" ? ["runner.mjs"] : ["-X", "utf8", "runner.py"]), ...args], { cwd, env, encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(executed.status, code, executed.stderr || executed.stdout);
  return JSON.parse(executed.stdout);
}
async function download(language: Language, flow: Workflow, name: string) {
  const response = await fetch(origin + "/api/export", { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ workflow: flow, language }) });
  assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
  const bytes = new Uint8Array(await response.arrayBuffer()), folder = join(temporary, `${language}-${name}`);
  await mkdir(folder);
  await extractExportEntries(folder, unzipSync(bytes));
  if (saveExamples) { await mkdir("outputs", { recursive: true }); await writeFile(join("outputs", `flowly-${language}-${name}.zip`), bytes); }
  return folder;
}
function compare(name: string, text: string) { (results[name] ??= []).push(text); }
function errorFlow(): Workflow {
  const w = templateWorkflow("blank"); w.name = "오류 분기 실제 실행";
  w.definition = { schemaVersion: 4, nodes: [
    { id: "input", type: "input", title: "입력", x: 0, y: 0 },
    { id: "parse", type: "transform", title: "JSON 해석", x: 0, y: 100, transform: { mode: "parse_json" }, onError: "branch" },
    { id: "error", type: "error", title: "오류 안내", x: 100, y: 200, error: { template: "다시 입력해 주세요: {{error.message}}" }, inputBindings: { error: { nodeId: "parse", path: "error" } } },
    { id: "output", type: "output", title: "출력", x: 0, y: 300 },
  ], edges: [{ id: "a", source: "input", target: "parse" }, { id: "b", source: "parse", target: "output", branch: "success" }, { id: "c", source: "parse", target: "error", branch: "error" }, { id: "d", source: "error", target: "output" }] };
  return w;
}
try {
  const login = await fetch(origin + "/api/auth/test", { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ identity: "alice", return_to: "/studio" }) });
  assert.equal(login.status, 303); cookie = login.headers.get("set-cookie")!.split(";")[0];
  for (const language of ["node", "python"] as const) {
    for (const [kind, input, expected] of [
      ["parallel-work", "실제 데이터", "받은 내용: 실제 데이터\n확인할 요청: 실제 데이터"],
      ["repeat-items", '["회의 준비","보고서 작성"]', "항목 0: 회의 준비\n항목 1: 보고서 작성"],
      ["reusable-work", "재사용 확인", "정리한 내용: 재사용 확인"],
      ["remember-value", "로컬 저장 확인", "로컬 저장 확인"],
    ]) {
      const folder = await download(language, templateWorkflow(kind), kind);
      assert.equal(cli(language, folder, ["check"]).status, "ready");
      const run = cli(language, folder, ["run", "--input", input]);
      assert.equal(run.status, "succeeded", run.error); assert.equal(run.result, expected); assert.equal(run.usage.turns, 0); assert.equal(run.usage.toolCalls, 0);
      compare(kind, run.result);
      cli(language, folder, ["report", run.id, "--output", "report.html"]);
      const html = await readFile(join(folder, "report.html"), "utf8"); assert.match(html, /Content-Security-Policy/); assert.doesNotMatch(html, /<script/);
      if (kind === "parallel-work") assert.equal(run.children.length, 2);
      if (kind === "repeat-items") {
        const empty = cli(language, folder, ["run", "--input", "[]"]); assert.equal(empty.status, "succeeded"); assert.equal(empty.result, "");
        const excess = cli(language, folder, ["run", "--input", JSON.stringify(Array.from({ length: 11 }, (_, i) => i))], 1); assert.equal(excess.status, "failed");
      }
      console.log(`PASS ${language}: ${kind} native check/run/report; no providers`); checks++;
    }
    const reviewFolder = await download(language, templateWorkflow("human-review"), "human-review");
    const pending = cli(language, reviewFolder, ["run", "--input", "수정 전"]); assert.equal(pending.status, "waiting_review");
    await writeFile(join(reviewFolder, "edited.json"), JSON.stringify({ text: "사람이 수정한 내용" }));
    const accepted = cli(language, reviewFolder, ["accept", pending.id, pending.reviews[0].id, "--edited-input-file", "edited.json"]); assert.equal(accepted.status, "queued");
    const resumed = cli(language, reviewFolder, ["resume", pending.id]); assert.equal(resumed.status, "succeeded"); assert.equal(resumed.result, "사람이 수정한 내용"); compare("review", resumed.result);
    const rejectRun = cli(language, reviewFolder, ["run", "--input", "거절할 내용"]);
    cli(language, reviewFolder, ["reject", rejectRun.id, rejectRun.reviews[0].id]);
    assert.equal(cli(language, reviewFolder, ["resume", rejectRun.id]).status, "succeeded");
    const nested = templateWorkflow("reusable-work"); nested.definition.nodes[1].subworkflow!.definition = templateWorkflow("human-review").definition;
    const nestedFolder = await download(language, nested, "nested-review");
    const nestedPending = cli(language, nestedFolder, ["run", "--input", "하위 검토"]); assert.equal(nestedPending.status, "waiting_review"); assert.equal(nestedPending.reviews.length, 1);
    cli(language, nestedFolder, ["accept", nestedPending.id, nestedPending.reviews[0].id]);
    assert.equal(cli(language, nestedFolder, ["resume", nestedPending.id]).result, "하위 검토");
    console.log(`PASS ${language}: durable review edit/accept/reject/resume and nested review`); checks++;
    const errorFolder = await download(language, errorFlow(), "error-route");
    const recovered = cli(language, errorFolder, ["run", "--input", "invalid-json"]); assert.equal(recovered.status, "succeeded"); assert.match(recovered.result, /^다시 입력해 주세요:/);
    const success = cli(language, errorFolder, ["run", "--input", '{"valid":true}']); assert.equal(success.status, "succeeded"); assert.equal(success.result, '{"valid":true}');
    console.log(`PASS ${language}: error and success routes select only active inputs`); checks++;
    for (const kind of ["agent-team", "orchestrated-work", "classified-form"]) {
      const folder = await download(language, templateWorkflow(kind), kind), checked = cli(language, folder, ["check"], 1);
      assert.equal(checked.status, "unconfigured"); assert.equal(checked.requiresModel, true); assert.ok(checked.missingEnv.includes("OPENAI_API_KEY"));
      console.log(`PASS ${language}: ${kind} requires explicit local model credentials`); checks++;
    }
  }
  for (const [name, values] of Object.entries(results)) assert.equal(values[0], values[1], `${name} native parity`);
  console.log(`PASS ${checks} exported advanced scenarios. Actual OpenAI calls: 0. External MCP calls: 0. Credentials supplied: 0.`);
} finally {
  const target = resolve(temporary), base = resolve(tmpdir());
  assert.ok(target.startsWith(base + "\\flowly-advanced-") || target.startsWith(base + "/flowly-advanced-"));
  await rm(target, { recursive: true, force: true });
}
