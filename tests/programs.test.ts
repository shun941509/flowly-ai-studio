import test from "node:test";
import assert from "node:assert/strict";
import { executeProgram, programNames } from "../runtime/programs";
import type { Json, ProgramConfig } from "../runtime/types";
import { matchA, matchB, programCases, repairSchema } from "./program-cases";

function run(name: ProgramConfig["name"], args: Record<string, Json>) { return executeProgram({ name, arguments: args, bindings: {} }, {}); }
test("registered programs perform deterministic calculations and checks without mutating inputs", () => {
  assert.equal(programNames.length, 6);
  for (const item of programCases) {
    const original = structuredClone(item.args);
    if (item.failure) assert.throws(() => run(item.name, item.args), item.title);
    else { const result = run(item.name, item.args); assert.deepEqual(JSON.parse(result.text), result.data, item.title); }
    assert.deepEqual(item.args, original, item.title);
  }
  assert.deepEqual(run("numeric_summary", programCases[0].args).data, { count: 3, sum: 3, min: -1, max: 2.5, mean: 1, unit: "kg" });
  assert.deepEqual(run("schema_check", programCases[4].args).data, { valid: false, errors: [
    { path: "count", expected: "number", message: "형식이 맞지 않아요." }, { path: "flags.1", expected: "boolean", message: "형식이 맞지 않아요." },
  ] });
  assert.deepEqual(run("schema_patch", programCases[5].args).data, { data: { name: "유지", count: 3, flags: [true, false] }, valid: true, errors: [], appliedPaths: ["count", "flags.1"] });
  assert.equal(run("schema_patch", programCases[7].args).data.valid, false);
  assert.equal(run("evidence_check", programCases[8].args).data.passed, true);
  assert.equal(run("evidence_check", programCases[9].args).data.passed, false);
  assert.equal(run("goal_check", programCases[10].args).data.passed, true);
  assert.equal(run("goal_check", programCases[11].args).data.passed, false);
  const fused = run("rank_fusion", programCases[12].args).data.matches as Record<string, Json>[];
  assert.deepEqual(fused.map(match => match.resourceId), ["doc-a", "doc-b"]);
  assert.equal(fused[0].score, 1 / 61 + 1 / 62); assert.equal(fused[1].score, fused[0].score);
  assert.equal(fused[0].excerpt, (matchA as Record<string, Json>).excerpt);
  assert.deepEqual(run("rank_fusion", programCases[15].args).data, { matches: [], count: 0 });
});

test("program bindings override literals and refuse missing paths or unknown commands", () => {
  assert.equal(executeProgram({ name: "numeric_summary", arguments: { values: [99] }, bindings: { values: "data.values" } }, { data: { values: [2, 4] } }).data.sum, 6);
  assert.throws(() => executeProgram({ name: "numeric_summary", arguments: {}, bindings: { values: "data.missing" } }, { data: {} }), /찾지 못/);
  assert.throws(() => executeProgram({ name: "eval", arguments: {}, bindings: {} } as unknown as ProgramConfig, {}), /등록된/);
  assert.throws(() => executeProgram({ name: "numeric_summary", arguments: {}, bindings: { values: "data.__proto__" } }, {}), /경로/);
  assert.throws(() => run("numeric_summary", { values: [1], command: "write-file" }), /허용 필드/);
});

test("program bounds fail closed and schema repair never changes a valid field", () => {
  const numericCases: Record<string, Json>[] = [{ values: [] }, { values: Array(1001).fill(1) }, { values: [1], units: ["kg", "kg"] }, { values: [Infinity] }];
  for (const args of numericCases) assert.throws(() => run("numeric_summary", args));
  assert.throws(() => run("schema_patch", { data: { name: "okay", count: "bad", flags: [] }, schema: repairSchema, patches: [{ path: "count", value: 1 }, { path: "count", value: 2 }] }), /한 번/);
  assert.deepEqual(run("schema_patch", { data: { name: "okay", flags: [] }, schema: repairSchema, patches: [{ path: "count", value: 3 }] }).data.data, { name: "okay", flags: [], count: 3 });
  assert.equal(run("schema_patch", { data: { name: "okay", count: "bad", flags: [] }, schema: repairSchema, patches: [{ path: "count", value: "still bad" }] }).data.valid, false);
  assert.throws(() => run("schema_check", { data: {}, schema: { type: "object", arbitrary: true } }));
  assert.throws(() => run("schema_check", { data: Array(201).fill("bad"), schema: { type: "array", items: { type: "number" } } }), /200/);
  const fusionCases: Record<string, Json>[] = [{ lists: [[matchA]], topK: 11 }, { lists: [[matchA]], topK: 1, rankConstant: 0 }, { lists: Array(5).fill([matchB]), topK: 1 }];
  for (const args of fusionCases) assert.throws(() => run("rank_fusion", args));
  assert.throws(() => run("evidence_check", { claims: [], sources: [] }));
  assert.throws(() => run("goal_check", { data: {}, checks: [] }));
});
