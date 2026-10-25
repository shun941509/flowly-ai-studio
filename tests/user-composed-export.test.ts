/** New user graphs, actual downloaded runtimes, explicit model/MCP HTTP fixtures. */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { buildExecutableExportPackage } from "../server/export-assets";
import { allNodes } from "../domain/advanced-config";
import { compileDefinition } from "../domain/workflow";
import type { WorkflowScenario } from "../domain/workflow-design";
import type { Json, PublicRun } from "../runtime/types";
import { composedOwner, userComposedCases } from "./fixtures/user-composed-workflows";
import { extractExportEntries } from "./export-zip";
import { canonical, command, resolveScenarioDecisions, sha256 } from "./workflow-export-integration";

const python = process.env.FLOWLY_TEST_PYTHON || (existsSync(resolve("work/tools-env/Scripts/python.exe")) ? resolve("work/tools-env/Scripts/python.exe") : "python");
const root = resolve("work/user-composed-verification");
const flattened = (run: PublicRun): PublicRun["events"] => [...run.events, ...(run.children ?? []).flatMap(child => flattened(child.run))];
const jsonText = (value: string) => { try { return canonical(JSON.parse(value)); } catch { return value; } };
const counts = (run: PublicRun, type: string) => {
  const result: Record<string, number> = {};
  for (const event of flattened(run)) if (event.type === type && event.nodeId) result[event.nodeId] = (result[event.nodeId] ?? 0) + 1;
  return result;
};
const childStates = (run: PublicRun, path = "root"): { path: string; status: string; result: string }[] => (run.children ?? []).flatMap(child => {
  const childPath = `${path}/${child.nodeId}/${child.taskId}`;
  return [{ path: childPath, status: child.run.status, result: jsonText(child.run.result) }, ...childStates(child.run, childPath)];
});
const comparable = (run: PublicRun, models: Record<string, number>, tools: Record<string, number>) => ({
  status: run.status, result: jsonText(run.result), completed: counts(run, "node_completed"), skipped: counts(run, "node_skipped"),
  childStates: childStates(run),
  models, tools, usage: { turns: run.usage.turns, toolCalls: run.usage.toolCalls, tokens: run.usage.tokens },
  pendingInputs: (run.inputRequests ?? []).map(request => ({ nodeId: request.nodeId, status: request.status })),
  approvals: run.approvals.map(approval => ({ nodeId: approval.nodeId, toolName: approval.toolName, args: approval.args, status: approval.status })),
});
type Log = Record<string, unknown>;
async function log(folder: string, name: string): Promise<Log[]> {
  try { return (await readFile(join(folder, name), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
const countCalls = (calls: Log[], field: string, initial: Record<string, number> = {}) => {
  const count = { ...initial }; for (const call of calls) { const key = String(call[field]); count[key] = (count[key] ?? 0) + 1; } return count;
};
function assertScenario(run: PublicRun, scenario: WorkflowScenario) {
  const events = flattened(run), label = scenario.name;
  assert.equal(run.status, scenario.status, `${label}: ${run.error ?? run.result}`);
  for (const value of scenario.contains ?? []) assert.ok(run.result.includes(value), `${label}: missing ${value}: ${run.result}`);
  for (const value of scenario.excludes ?? []) assert.ok(!run.result.includes(value), `${label}: unwanted ${value}`);
  for (const id of scenario.visited ?? []) assert.ok(events.some(event => event.nodeId === id && event.type === "node_completed"), `${label}: missing ${id}`);
  for (const id of scenario.skipped ?? []) assert.ok(events.some(event => event.nodeId === id && event.type === "node_skipped"), `${label}: not skipped ${id}`);
  for (const [id, expected] of Object.entries(scenario.completedCounts ?? {})) assert.equal(events.filter(event => event.nodeId === id && event.type === "node_completed").length, expected, `${label}: duplicate/missing completion ${id}`);
  for (const [id, fields] of Object.entries(scenario.outputs ?? {})) {
    const value = (events.findLast(event => event.nodeId === id && event.type === "node_completed")?.data as { output?: Record<string, Json> })?.output;
    for (const [key, expected] of Object.entries(fields)) assert.deepEqual(value?.[key], expected, `${label}: incorrect ${id}.${key}`);
  }
}

for (const fixture of userComposedCases) test(`user composition ${fixture.id}: runtime/Agent × Node.js/Python`, { timeout: 300000 }, async () => {
  await mkdir(root, { recursive: true });
  const folder = await mkdtemp(join(root, `${fixture.id}-`));
  const parity = new Map<string, ReturnType<typeof comparable>>();
  const evidence: { package: string; zipHash: string; scenario: string; contract: ReturnType<typeof comparable> }[] = [];
  let setupChecks = 0;
  for (const kind of ["runtime", "agent"] as const) for (const language of ["node", "python"] as const) {
    const work = join(folder, `${kind}-${language}`); await mkdir(work);
    const zip = await buildExecutableExportPackage({ user: composedOwner, workflow: fixture.workflow, resolveResources: async () => fixture.resources, connections: fixture.connections, kind, language, exportedAt: "2026-10-25T00:00:00.000Z" });
    const files = unzipSync(zip); await writeFile(join(folder, `${kind}-${language}.zip`), zip);
    assert.ok(!files[".env"] && !Object.keys(files).some(name => /boundary|scenario|preload/.test(name)), "Production ZIP leaked a testing fixture");
    const manifest = JSON.parse(strFromU8(files["workflow.json"]));
    assert.deepEqual(manifest.workflow.definition, compileDefinition(fixture.workflow.definition), "Export changed a user-authored graph beyond declared schema defaults");
    for (const name of ["AI_PROMPT.md", "AGENTS.md", "START_HERE.md", "WORKFLOW_GUIDE.md", "skills/flowly-workflow/SKILL.md"]) assert.ok(files[name]?.length, name);
    const guide = strFromU8(files["WORKFLOW_GUIDE.md"]);
    for (const node of allNodes(fixture.workflow.definition)) assert.ok(guide.includes(`"id": ${JSON.stringify(node.id)}`), `Guide lost nested node ${node.id}`);
    if (kind === "agent") {
      const agentManifest = JSON.parse(strFromU8(files["agent-manifest.json"]));
      assert.equal(agentManifest.agents.length, allNodes(fixture.workflow.definition).filter(node => node.type === "agent").length);
      assert.ok(files["Agent.md"] && files["mcp.json"]);
    }
    await extractExportEntries(work, files);
    const entry = `${kind === "agent" ? "agent" : "runner"}.${language === "node" ? "mjs" : "py"}`;
    if (kind === "agent" && language === "python") {
      const source = await readFile("tests/workflow-python-boundary.py", "utf8");
      assert.ok(source.includes("raise SystemExit(runner.main(sys.argv[1:]))"), "Boundary entrypoint changed");
      await writeFile(join(work, ".agent-boundary.py"), source.replace("raise SystemExit(runner.main(sys.argv[1:]))", "import runpy\noriginal_run_path = runpy.run_path\ndef enter_runtime(path, **kwargs):\n    assert Path(path).resolve() == (Path.cwd() / 'runner.py').resolve()\n    raise SystemExit(runner.main(sys.argv[1:]))\nrunpy.run_path = enter_runtime\noriginal_run_path(str(Path.cwd() / 'agent.py'), run_name='__main__')"));
    }
    const prefix = language === "node" ? ["--import", pathToFileURL(resolve("tests/workflow-node-preload.mjs")).href, entry] : ["-X", "utf8", kind === "agent" ? ".agent-boundary.py" : resolve("tests/workflow-python-boundary.py")];
    let invocation = 0;
    const invoke = async (args: string[]) => {
      const result = await command(language === "node" ? process.execPath : python, [...prefix, ...args], work, 45000);
      await writeFile(join(work, `command-${++invocation}.json`), JSON.stringify({ args, ...result }, null, 2));
      assert.ok(!result.timedOut && !result.overflow && !result.error, `${kind}/${language}: CLI process failure; evidence=${work}`);
      let value;
      try { value = JSON.parse(result.stdout); } catch { throw new Error(`${kind}/${language}: malformed JSON ${result.stderr || result.stdout}; evidence=${work}`); }
      return { result, value };
    };
    await writeFile(join(work, ".scenario.json"), JSON.stringify({ name: "unconfigured", modelReplies: [] }));
    const unconfigured = await invoke(["check"]); setupChecks++;
    assert.equal(unconfigured.result.status, 1); assert.equal(unconfigured.value.status, "unconfigured"); assert.ok(unconfigured.value.missingEnv.includes("OPENAI_API_KEY"));
    await writeFile(join(work, ".env"), ["OPENAI_API_KEY=user-composition-test-boundary-placeholder", "FLOWLY_MODEL=test-model", `FLOWLY_PYTHON=${python}`, ...manifest.connections.flatMap((connection: { endpointEnv?: string; endpoint: string; tokenEnv?: string }) => [...(connection.endpointEnv ? [`${connection.endpointEnv}=${connection.endpoint}`] : []), ...(connection.tokenEnv ? [`${connection.tokenEnv}=user-composition-test-token-placeholder`] : [])]), ""].join("\n"));
    for (const [index, scenario] of fixture.scenarios.entries()) {
      await writeFile(join(work, ".scenario.json"), JSON.stringify(scenario)); await writeFile(join(work, ".input.txt"), scenario.input);
      for (const name of [".model-calls.jsonl", ".tool-calls.jsonl", ".model-timing.jsonl", ".boundary-errors.jsonl"]) await writeFile(join(work, name), "");
      const cli = async (args: string[]): Promise<PublicRun> => {
        const beforeModels = await log(work, ".model-calls.jsonl"), beforeTools = await log(work, ".tool-calls.jsonl");
        const { result, value } = await invoke([...args, "--state", `.state-${index}`]);
        assert.equal(result.status, ["failed", "cancelled", "expired", "budget_exceeded", "unknown_outcome", "unconfigured", "invalid"].includes(value.status) ? 1 : 0, result.stderr || result.stdout);
        if (["status", "submit", "approve", "deny", "accept", "reject"].includes(args[0])) {
          assert.deepEqual(await log(work, ".model-calls.jsonl"), beforeModels, "Decision/status command executed a model");
          assert.deepEqual(await log(work, ".tool-calls.jsonl"), beforeTools, "Decision/status command executed a tool");
        }
        if (value.status === "waiting_approval") for (const pending of value.approvals.filter((a: { status: string }) => a.status === "pending")) assert.ok(!(await log(work, ".tool-calls.jsonl")).some(call => call.name === pending.toolName && canonical(call.args) === canonical(pending.args)), "Write dispatched before approval");
        return value;
      };
      let edited = 0;
      const initial = await cli(["run", "--input-file", ".input.txt"]);
      if (scenario.inputSubmissions?.length) assert.equal(initial.status, "waiting_input", "Did not durably wait for user input");
      if (scenario.approval) assert.equal(initial.status, "waiting_approval", "Did not durably wait for write approval");
      const run = await resolveScenarioDecisions(initial, scenario, cli, async values => { const filename = `.values-${index}-${++edited}.json`; await writeFile(join(work, filename), JSON.stringify(values)); return filename; });
      assertScenario(run, scenario);
      assert.deepEqual(await log(work, ".boundary-errors.jsonl"), [], "Model/MCP boundary mismatch must never be hidden by an expected failure");
      const calls = await log(work, ".model-calls.jsonl"), modelCounts = countCalls(calls, "match"), toolCounts = countCalls(await log(work, ".tool-calls.jsonl"), "name", Object.fromEntries(Object.keys(scenario.toolCallCounts ?? {}).map(name => [name, 0])));
      for (const expected of scenario.modelReplies ?? []) assert.ok(calls.some(call => call.match === expected.match && (!expected.occurrence || call.occurrence === expected.occurrence)), `Missing validated model step ${expected.match}`);
      if (!scenario.modelReplies?.length) assert.equal(calls.length, 0);
      if (scenario.modelCallCounts) assert.deepEqual(modelCounts, scenario.modelCallCounts);
      assert.deepEqual(toolCounts, scenario.toolCallCounts ?? {}, "Unexpected or repeated MCP call");
      if (scenario.parallelMatches?.length) {
        const timings = await log(work, ".model-timing.jsonl");
        const ranges = scenario.parallelMatches.map(match => { const start = timings.find(t => t.match === match && t.phase === "start"), end = timings.find(t => t.match === match && t.phase === "end"); assert.ok(start && end); return [Number(start.at), Number(end.at)]; });
        assert.ok(Math.max(...ranges.map(range => range[0])) < Math.min(...ranges.map(range => range[1])), "Parallel model boundaries did not overlap");
      }
      const contract = comparable(run, modelCounts, toolCounts), previous = parity.get(scenario.name);
      if (previous) assert.deepEqual(contract, previous, `Runtime/Agent Node/Python behavior mismatch: ${scenario.name}`); else parity.set(scenario.name, contract);
      evidence.push({ package: `${kind}-${language}`, zipHash: sha256(zip), scenario: scenario.name, contract });
      await writeFile(join(work, `scenario-${index}-result.json`), JSON.stringify(run, null, 2));
    }
  }
  assert.equal(setupChecks, 4); assert.equal(evidence.length, fixture.scenarios.length * 4);
  await writeFile(join(root, `${fixture.id}-evidence.json`), JSON.stringify({ id: fixture.id, description: fixture.description, definitionHash: sha256(canonical(fixture.workflow.definition)), verifiedAt: new Date().toISOString(), graphCountedAsPublicExample: false, configurationChecks: setupChecks, externalApiCalls: 0, scope: "actual exported runtime/Agent CLIs; network blocked; model/MCP responses are explicit test fixtures", artifactDirectory: folder, checks: evidence }, null, 2));
});
