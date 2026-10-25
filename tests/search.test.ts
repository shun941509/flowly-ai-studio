import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseSearchConfig } from "../domain/search-config";
import { runCandidateSearch, type SearchState } from "../runtime/candidate-search";
import type { Json } from "../runtime/types";
import { create, graphProblem, graphReplies, searchCases, treeProblem, treeReplies } from "./search-cases";

test("tree and graph search persist real branching, pruning, backtracking and versioned lineage", async () => {
  for (const item of searchCases) {
    let state: SearchState | undefined, calls = 0;
    const result = await runCandidateSearch(item.config, item.input, undefined, { model: async () => structuredClone(item.replies[calls++]), persist: async next => { state = next; }, check: async () => {} });
    const data = result.data as Record<string, Json>;
    assert.equal(data.solved, item.solved, item.name); assert.equal(calls, item.replies.length, item.name);
    assert.equal(state?.pending, undefined);
    if (item.name.startsWith("tree")) { assert.deepEqual(data.selected, ["b", "c"]); assert.equal(data.total, 7); assert.ok(state?.events.some(event => event.type === "backtracked" && event.candidateId === "c1")); }
    if (item.name.startsWith("graph")) {
      assert.deepEqual(data.selected, ["b", "c", "d"]); assert.equal(data.total, 8);
      for (const id of ["c4", "c5"]) assert.equal(state?.candidates.find(candidate => candidate.id === id)?.status, "invalidated");
      assert.deepEqual(state?.candidates.find(candidate => candidate.id === "c6")?.parents, [{ id: "c1", revision: 2 }, { id: "c2", revision: 1 }]);
    }
  }
});

test("a persisted proposal resumes without another model call and rejects changed checkpoint/input/config", async () => {
  let state: SearchState | undefined, calls = 0;
  const config = parseSearchConfig({ mode: "tree" });
  await assert.rejects(runCandidateSearch(config, treeProblem, undefined, { model: async () => { calls++; return structuredClone(treeReplies[0]); }, persist: async next => { state = next; if (next.pending?.reply) throw new Error("process stopped after durable reply"); }, check: async () => {} }), /process stopped/);
  assert.equal(calls, 1); assert.equal(state?.iteration, 0);
  const restored = structuredClone(state!);
  const result = await runCandidateSearch(config, treeProblem, state, { model: async () => structuredClone(treeReplies[calls++]), persist: async next => { state = next; }, check: async () => {} });
  assert.equal(calls, 3); assert.equal((result.data as Record<string, Json>).solved, true);
  const noCalls = { model: async () => { throw new Error("must not call model"); }, persist: async () => {}, check: async () => {} };
  await assert.rejects(runCandidateSearch(config, { ...treeProblem, target: 8 }, restored, noCalls), /입력·설정·체크포인트/);
  await assert.rejects(runCandidateSearch({ ...config, beamWidth: 1 }, treeProblem, restored, noCalls), /입력·설정·체크포인트/);
  restored.candidates[0].total = 999;
  await assert.rejects(runCandidateSearch(config, treeProblem, restored, noCalls), /입력·설정·체크포인트/);
});

test("proposals cannot supply invented items, totals, success, ancestry or unbounded work", async () => {
  for (const reply of [
    { actions: [create(["invented"])] }, { actions: [create(["a", "a"])] },
    { actions: [], solved: true }, { actions: [{ ...create(["b", "c"]), total: 7 }] },
    { actions: [create(["b"], ["c99"])] }, { actions: [{ type: "revise", id: "c0", items: ["b"] }] },
    { actions: Array(4).fill(create(["a"])) },
  ]) await assert.rejects(runCandidateSearch(parseSearchConfig({ mode: "tree" }), treeProblem, undefined, { model: async () => reply as Record<string, Json>, persist: async () => {}, check: async () => {} }));
  assert.throws(() => parseSearchConfig({ maxCandidates: 65 })); assert.throws(() => parseSearchConfig({ itemsPath: "__proto__.value" }));
  let calls = 0;
  await assert.rejects(runCandidateSearch(parseSearchConfig({ mode: "tree" }), treeProblem, undefined, { model: async () => { calls++; return {}; }, persist: async () => {}, check: async () => { throw new Error("cancelled"); } }), /cancelled/);
  assert.equal(calls, 0);
});

test("a rejected graph batch cannot persist partial descendant invalidation", async () => {
  let saved: SearchState | undefined, calls = 0;
  const replies = [...graphReplies.slice(0, 2), { actions: [{ type: "revise", id: "c1", items: ["d"] }, create(["a", "b", "d"], ["c5"])] }];
  await assert.rejects(runCandidateSearch(parseSearchConfig({ mode: "graph" }), graphProblem, undefined, { model: async () => structuredClone(replies[calls++]), persist: async state => { saved = state; }, check: async () => {} }), /유효한 부모/);
  assert.equal(saved?.iteration, 2); assert.equal(saved?.candidates.find(c => c.id === "c1")?.revision, 1); assert.notEqual(saved?.candidates.find(c => c.id === "c5")?.status, "invalidated");
});

test("unexpected reasoning fields are rejected before storing a provider reply", async () => {
  for (const reply of [{ actions: [], reasoning: "DO_NOT_RETAIN_PRIVATE_REASONING" }, { actions: [{ ...create(["b"]), reasoning: "DO_NOT_RETAIN_PRIVATE_REASONING" }] }]) {
    const persisted: SearchState[] = [];
    await assert.rejects(runCandidateSearch(parseSearchConfig({}), treeProblem, undefined, { model: async () => reply as Record<string, Json>, persist: async state => { persisted.push(state); }, check: async () => {} }));
    assert.ok(persisted.length); assert.ok(persisted.every(state => state.pending?.reply === undefined)); assert.ok(!JSON.stringify(persisted).includes("DO_NOT_RETAIN"));
  }
});

test("Python helper produces the exact Node search state and output with the same public proposals", async () => {
  const script = "import json,sys;sys.path.insert(0,sys.argv[1]);from flowly_search import run_candidate_search;v=json.load(sys.stdin);replies=iter(v['replies']);saved=[];result=run_candidate_search(v['config'],v['input'],None,{'model':lambda prompt,input:next(replies),'persist':lambda state:saved.append(state),'check':lambda:None});print(json.dumps({'result':result,'state':saved[-1]},ensure_ascii=False))";
  for (const item of searchCases) {
    let saved: SearchState | undefined, calls = 0;
    const result = await runCandidateSearch(item.config, item.input, undefined, { model: async () => structuredClone(item.replies[calls++]), persist: async state => { saved = state; }, check: async () => {} });
    const py = spawnSync("python", ["-X", "utf8", "-c", script, resolve("export-runtime")], { input: JSON.stringify(item), encoding: "utf8", windowsHide: true });
    assert.equal(py.status, 0, py.stderr); assert.deepEqual(JSON.parse(py.stdout), { result, state: saved }, item.name);
  }
});
