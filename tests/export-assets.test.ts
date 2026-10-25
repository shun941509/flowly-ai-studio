import { extractExportEntries } from "./export-zip";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { templateWorkflow, type Workflow } from "../app/lib/model";
import type { ExampleProject } from "../domain/example-types";
import { buildExecutableExportPackage } from "../server/export-assets";
import { buildExampleExport } from "../server/example-export";

const user = { userId: "export-assets-test", email: "export@example.test", displayName: "ZIP 검증" };
const python = process.env.FLOWLY_TEST_PYTHON || (existsSync(resolve(".venv-files/Scripts/python.exe"))
  ? resolve(".venv-files/Scripts/python.exe") : process.platform === "win32" ? "python" : "python3");
// Deliberately do not inherit model credentials, provider URLs, NODE_OPTIONS or Python hooks.
const environment: NodeJS.ProcessEnv = { NODE_ENV: "test", ...Object.fromEntries(
  ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "PATHEXT"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []),
) };
type Language = "node" | "python";
type Download = "editor" | "example";
type Run = {
  id: string; status: string; error?: string; result: string; runId: string;
  usage: { turns: number; toolCalls: number };
  events: { type: string; nodeId?: string; data: { output: { file: { path: string } } } }[];
  missingEnv?: string[];
};

function project(workflow: Workflow): ExampleProject {
  return { id: "export-assets-fixture", title: "파일·자동 시작 패키지 검증", description: "테스트 전용 합성 자료", kind: "workflow",
    category: "검증", frameworks: [], tags: [], nodeTypes: workflow.definition.nodes.map(node => node.type), status: "ready",
    uniqueBehavior: "내보낸 파일 도우미와 트리거의 실제 실행", verification: { schema: true, node: false, python: false, live: false },
    inputExample: "테스트 입력", expectedOutput: "테스트 기준", requirements: [], workflow, resources: [], variants: [],
    acceptance: ["로컬 데이터 전달"], failureCases: ["파일 경로 이탈 거절"], sourceLicense: "synthetic-test" };
}

function download(kind: Download, workflow: Workflow, language: Language) {
  return kind === "example" ? buildExampleExport(project(workflow), user, language)
    : buildExecutableExportPackage({ user, workflow, language, connections: [], resolveResources: async () => [] });
}

function command(executable: string, args: string[], cwd: string, status = 0, input?: string): string {
  const result = spawnSync(executable, args, { cwd, env: environment, input, encoding: "utf8", windowsHide: true, timeout: 20_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, status, result.stderr || result.stdout);
  return result.stdout;
}

function cli(language: Language, cwd: string, args: string[], status = 0): Run {
  return JSON.parse(command(language === "node" ? process.execPath : python,
    [...(language === "node" ? ["runner.mjs"] : ["-X", "utf8", "runner.py"]), ...args], cwd, status));
}

test("editor and example downloads share complete runtime assets and conditional helpers", async () => {
  for (const language of ["node", "python"] as const) for (const kind of ["table-export", "scheduled-work", "guard-evaluate"]) {
    const workflow = templateWorkflow(kind);
    const editor = unzipSync(await download("editor", workflow, language));
    const example = unzipSync(await download("example", workflow, language));
    const runtime = language === "node" ? "runner.mjs" : "runner.py";
    const assets = [runtime, "flowly_ops.py", "flowly_local.py", "OPERATIONS.md",
      ...(kind === "table-export" ? ["flowly_files.py", "requirements-files.txt"] : []),
      ...(kind === "scheduled-work" ? ["flowly_triggers.py"] : [])];
    for (const filename of assets) {
      assert.ok(editor[filename]?.length, `${language}/${kind}: editor missing ${filename}`);
      assert.deepEqual(example[filename], editor[filename], `${language}/${kind}: example differs at ${filename}`);
    }
    for (const files of [editor, example]) {
      assert.equal(Boolean(files["flowly_files.py"]), kind === "table-export");
      assert.equal(Boolean(files["flowly_triggers.py"]), kind === "scheduled-work");
      assert.match(strFromU8(files["README.md"]), /로컬 실행 화면과 운영 도구/);
      assert.ok(!files[".env"]);
      assert.doesNotMatch(Object.keys(files).join(" "), /preload|test-adapter/);
    }
    assert.ok(example["example-contract.json"] && example["EXAMPLE.md"] && example["input.txt"]);
  }
});

for (const kind of ["editor", "example"] as const) for (const language of ["node", "python"] as const) {
  test(`${kind} ${language} ZIP executes real file helpers, output replay and operations without model/MCP`, async () => {
    const folder = await mkdtemp(join(tmpdir(), "flowly-export-assets-"));
    try {
      const bytes = await download(kind, templateWorkflow("table-export"), language);
      await extractExportEntries(folder, unzipSync(bytes));
      await writeFile(join(folder, ".env"), `FLOWLY_PYTHON=${python}\n`);
      await mkdir(join(folder, "inputs"));
      await writeFile(join(folder, "inputs", "sample.csv"), "이름,수량\nFlowly,7\n");
      assert.equal(cli(language, folder, ["check"]).status, "ready");
      const run = cli(language, folder, ["run", "--input", '{"file":"sample.csv"}']);
      assert.equal(run.status, "succeeded", run.error);
      assert.equal(run.usage.turns, 0); assert.equal(run.usage.toolCalls, 0);
      const output = run.events.find(event => event.type === "node_completed" && event.nodeId === "export")?.data.output.file.path;
      assert.ok(output);
      const written = await readFile(join(folder, output), "utf8");
      assert.match(written, /Flowly,7/);
      assert.equal(cli(language, folder, ["resume", run.id]).status, "succeeded");
      assert.equal(await readFile(join(folder, output), "utf8"), written);
      assert.equal(cli(language, folder, ["run", "--input", '{"file":"../.env"}'], 1).status, "failed");
      const checked = JSON.parse(command(python, ["-X", "utf8", "flowly_ops.py", "request"], folder, 0, '{"action":"check"}'));
      assert.equal(checked.status, "ready");
      assert.match(command(python, ["-X", "utf8", "flowly_local.py", "--help"], folder), /usage:/);
    } finally {
      assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep + "flowly-export-assets-"));
      await rm(folder, { recursive: true, force: true });
    }
  });

  test(`${kind} ${language} ZIP starts its actual scheduled runner without model/MCP`, async () => {
    const folder = await mkdtemp(join(tmpdir(), "flowly-export-trigger-"));
    try {
      const workflow = templateWorkflow("scheduled-work"); workflow.definition.nodes[0].trigger!.intervalSeconds = 1;
      await extractExportEntries(folder, unzipSync(await download(kind, workflow, language)));
      await writeFile(join(folder, "input.txt"), "자동 시작 패키지 회귀 검증");
      const receipt: Run = JSON.parse(command(python, ["-X", "utf8", "flowly_triggers.py", "schedule", "--max-runs", "1", "--input-file", "input.txt", "--node", process.execPath, "--python", python], folder));
      assert.equal(receipt.status, "succeeded");
      const run = cli(language, folder, ["status", receipt.runId]);
      assert.equal(run.status, "succeeded"); assert.match(run.result, /자동 시작 패키지 회귀 검증/);
      assert.equal(run.usage.turns, 0); assert.equal(run.usage.toolCalls, 0);
    } finally {
      assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep + "flowly-export-trigger-"));
      await rm(folder, { recursive: true, force: true });
    }
  });
}
