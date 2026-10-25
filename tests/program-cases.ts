import type { Json, ProgramConfig } from "../runtime/types";

export const repairSchema: Json = { type: "object", properties: { name: { type: "string" }, count: { type: "number" }, flags: { type: "array", items: { type: "boolean" } } }, required: ["name", "count", "flags"], additionalProperties: false };
export const matchA: Json = { resourceId: "doc-a", version: "v1", chunkIndex: 0, excerpt: "예약은 24시간 전에 취소합니다.", name: "예약 규정", score: 0.9 };
export const matchB: Json = { resourceId: "doc-b", version: "v2", chunkIndex: 2, excerpt: "영수증은 다음 날 발급합니다.", url: "https://docs.internal/receipt", score: 0.7 };
type Case = { title: string; name: ProgramConfig["name"]; args: Record<string, Json>; failure?: boolean };
export const programCases: Case[] = [
  { title: "actual sum and equal units", name: "numeric_summary", args: { values: [1.5, 2.5, -1], units: ["kg", "kg", "kg"] } },
  { title: "mixed units rejected", name: "numeric_summary", args: { values: [1, 2], units: ["kg", "g"] }, failure: true },
  { title: "boolean is not numeric", name: "numeric_summary", args: { values: [true] }, failure: true },
  { title: "overflow rejected", name: "numeric_summary", args: { values: [1e308, 1e308] }, failure: true },
  { title: "schema identifies exact fields", name: "schema_check", args: { data: { name: "유지", count: "3", flags: [true, "false"] }, schema: repairSchema } },
  { title: "schema repairs only invalid fields", name: "schema_patch", args: { data: { name: "유지", count: "3", flags: [true, "false"] }, schema: repairSchema, patches: [{ path: "count", value: 3 }, { path: "flags.1", value: false }] } },
  { title: "repair touching valid field rejected", name: "schema_patch", args: { data: { name: "유지", count: "3", flags: [true] }, schema: repairSchema, patches: [{ path: "name", value: "변경" }] }, failure: true },
  { title: "incomplete repair stays invalid", name: "schema_patch", args: { data: { name: "유지", count: "3", flags: ["true"] }, schema: repairSchema, patches: [{ path: "count", value: 3 }] } },
  { title: "version and quote exact match", name: "evidence_check", args: { claims: [{ sourceId: "doc-a", version: "v1", quote: "24시간 전에" }], sources: [matchA] } },
  { title: "missing version and empty quote fail", name: "evidence_check", args: { claims: [{ sourceId: "doc-a", version: "v2", quote: "24시간" }, { sourceId: "doc-a", version: "v1", quote: " " }], sources: [matchA] } },
  { title: "all explicit goals pass", name: "goal_check", args: { data: { passed: true, count: 3, expected: 3 }, checks: [{ path: "passed", operator: "eq", value: true }, { path: "count", operator: "eq", rightPath: "expected" }] } },
  { title: "absent goal and type coercion fail", name: "goal_check", args: { data: { count: "3" }, checks: [{ path: "absent", operator: "ne", value: false }, { path: "count", operator: "gte", value: 2 }] } },
  { title: "named hybrid ranks retain provenance", name: "rank_fusion", args: { lists: { vector: [matchB, matchA], lexical: [matchA, matchB] }, topK: 2 } },
  { title: "duplicate hits in one list count once", name: "rank_fusion", args: { lists: [[matchA, matchA], [matchB]], topK: 2, rankConstant: 5 } },
  { title: "conflicting source chunk rejected", name: "rank_fusion", args: { lists: [[matchA], [{ ...(matchA as Record<string, Json>), excerpt: "조작된 내용" }]], topK: 2 }, failure: true },
  { title: "empty search results stay empty", name: "rank_fusion", args: { lists: [[], []], topK: 2 } },
];
