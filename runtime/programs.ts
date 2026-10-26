// 수치 요약·스키마 검사/수정·근거/완료 조건 검사·순위 융합의 고정 프로그램. Python flowly_programs.py와 출력 계약을 맞춘다.
import { parseDataNodeConfig } from "../domain/node-config";
import { evaluatePredicate, parsePredicate } from "../domain/predicate";
import { parseSchema } from "../domain/schema";
import { dataAt } from "./data-nodes";
import { canonicalJson } from "./policy";
import type { DataSchema, Json, ProgramConfig } from "./types";

export const programNames = ["numeric_summary", "schema_check", "schema_patch", "evidence_check", "goal_check", "rank_fusion"] as const;
type Obj = Record<string, Json>;
type Issue = { path: string; expected: string; message: string };
const fail = (message: string): never => { throw new Error(message); };
function object(value: Json | undefined): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("프로그램 입력은 JSON 객체여야 해요.");
  return value;
}
function keys(value: Obj, allowed: string[], required = allowed): void {
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail("프로그램의 필수 입력과 허용 필드를 확인해 주세요.");
}
function list(value: Json | undefined, min = 1, max = 100): Json[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return fail(`프로그램 목록은 ${min}~${max}개로 입력해 주세요.`);
  return value;
}
function text(value: Json | undefined, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) return fail("프로그램의 글자 입력을 확인해 주세요.");
  return value;
}
function finite(value: Json | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fail("프로그램은 유한한 숫자만 계산할 수 있어요.");
  return value;
}
function integer(value: Json | undefined, min: number, max: number): number {
  const number = finite(value);
  if (!Number.isInteger(number) || number < min || number > max) return fail(`프로그램 정수는 ${min}~${max} 범위여야 해요.`);
  return number;
}
// 프로그램 입력을 JSON으로 복사하면서 값 개수·중첩 한도를 제한한다. 실행 가능한 객체나 코드는 받지 않는다.
function boundedJson(value: unknown): Json {
  const copy = JSON.parse(canonicalJson(value)) as Json;
  let count = 0;
  function visit(item: Json, depth: number) {
    if (++count > 10000 || depth > 16) fail("프로그램 데이터는 10,000개 값과 16단계 중첩까지 처리할 수 있어요.");
    if (item && typeof item === "object") Object.values(item).forEach(child => visit(child, depth + 1));
  }
  visit(copy, 0); return copy;
}

function schemaErrors(value: Json, schema: DataSchema): Issue[] {
  const errors: Issue[] = [];
  function issue(path: string, expected: string, message: string) { if (errors.length >= 200) fail("검증 오류가 200개를 넘어요. 입력을 나누어 주세요."); errors.push({ path, expected, message }); }
  function check(item: Json, rule: DataSchema, path: string) {
    const matches = rule.type === "array" ? Array.isArray(item) : rule.type === "object" ? item !== null && typeof item === "object" && !Array.isArray(item) : typeof item === rule.type;
    if (!matches || typeof item === "number" && !Number.isFinite(item)) { issue(path, rule.type, "형식이 맞지 않아요."); return; }
    if (rule.type === "object") {
      const obj = item as Obj;
      for (const key of [...new Set(rule.required ?? [])].sort()) if (!Object.hasOwn(obj, key)) issue(path ? `${path}.${key}` : key, rule.properties?.[key]?.type ?? "required", "필수 값이 없어요.");
      for (const key of Object.keys(obj).sort()) {
        const child = path ? `${path}.${key}` : key;
        if (rule.properties?.[key]) check(obj[key], rule.properties[key], child);
        else if (rule.additionalProperties === false) issue(child, "absent", "허용되지 않은 필드예요.");
      }
    }
    if (rule.type === "array" && rule.items) (item as Json[]).forEach((child, index) => check(child, rule.items!, path ? `${path}.${index}` : String(index)));
  }
  check(value, schema, ""); return errors;
}

function numericSummary(args: Obj): Obj {
  keys(args, ["values", "units"], ["values"]);
  const values = list(args.values, 1, 1000).map(finite);
  let unit: string | undefined;
  if (args.units !== undefined) {
    const units = list(args.units, values.length, values.length).map(value => text(value, 80));
    if (new Set(units).size !== 1) fail("서로 다른 단위를 합산할 수 없어요.");
    unit = units[0];
  }
  const sum = finite(values.reduce((total, value) => total + value, 0));
  return { count: values.length, sum, min: Math.min(...values), max: Math.max(...values), mean: finite(sum / values.length), ...(unit ? { unit } : {}) };
}
// patch 모드에서도 현재 오류가 있는 경로만 한 번씩 수정한다. 전체 데이터나 정상 필드를 임의 교체하는 연산이 아니다.
function schemaCheck(args: Obj, patch: boolean): Obj {
  keys(args, patch ? ["data", "schema", "patches"] : ["data", "schema"]);
  const schema = parseSchema(args.schema), data = boundedJson(args.data);
  const before = schemaErrors(data, schema);
  if (!patch) return { valid: before.length === 0, errors: before };
  const invalid = new Set(before.map(error => error.path)), appliedPaths: string[] = [];
  for (const value of list(args.patches, 0, 40)) {
    const change = object(value); keys(change, ["path", "value"]);
    const path = text(change.path, 500);
    if (!invalid.has(path) || appliedPaths.includes(path)) fail("현재 오류가 있는 필드만 한 번씩 수정할 수 있어요.");
    const parts = path.split(".");
    if (parts.some(part => ["__proto__", "constructor", "prototype"].includes(part))) fail("허용되지 않은 수정 경로예요.");
    let parent = data;
    for (const part of parts.slice(0, -1)) {
      if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, part)) fail("수정할 필드의 상위 값이 없어요.");
      parent = (parent as Obj)[part];
    }
    if (!parent || typeof parent !== "object") fail("수정할 필드의 상위 값이 없어요.");
    const last = parts.at(-1)!;
    if (Array.isArray(parent)) {
      if (!/^(0|[1-9][0-9]*)$/.test(last) || Number(last) >= parent.length) fail("수정할 배열 항목이 없어요.");
      parent[Number(last)] = boundedJson(change.value);
    } else (parent as Obj)[last] = boundedJson(change.value);
    appliedPaths.push(path);
  }
  const errors = schemaErrors(data, schema);
  return { data, valid: errors.length === 0, errors, appliedPaths };
}
function evidenceCheck(args: Obj): Obj {
  keys(args, ["claims", "sources"]);
  const sources = list(args.sources, 0, 100).map(value => {
    const source = object(value); keys(source, ["resourceId", "version", "excerpt", "chunkIndex", "name", "url", "score"], ["resourceId", "version", "excerpt"]);
    return { resourceId: text(source.resourceId, 100), version: text(source.version, 200), excerpt: text(source.excerpt, 20000) };
  });
  const checks = list(args.claims, 1, 100).map((value, index) => {
    const claim = object(value); keys(claim, ["sourceId", "version", "quote"]);
    const sourceId = text(claim.sourceId, 100), version = text(claim.version, 200);
    if (typeof claim.quote !== "string" || claim.quote.length > 20000) fail("인용문은 20,000자 이하의 글이어야 해요.");
    const quote = claim.quote as string;
    const matches = sources.filter(source => source.resourceId === sourceId && source.version === version);
    const passed = Boolean(quote.trim()) && matches.some(source => source.excerpt.includes(quote));
    return { index, sourceId, version, passed, reason: passed ? "source_and_quote_match" : !quote.trim() ? "empty_quote" : !matches.length ? "source_version_missing" : "quote_missing" };
  });
  return { passed: checks.every(check => check.passed), checks };
}
function goalCheck(args: Obj): Obj {
  keys(args, ["data", "checks"]);
  const checks = list(args.checks, 1, 40).map((value, index) => {
    const predicate = parsePredicate(value);
    let passed = false, reason = "condition_false";
    try { passed = evaluatePredicate(predicate, args.data); if (passed) reason = "condition_true"; } catch { reason = "missing_or_incompatible_value"; }
    return { index, path: predicate.path, passed, reason };
  });
  return { passed: checks.every(check => check.passed), checks };
}
function rankFusion(args: Obj): Obj {
  keys(args, ["lists", "topK", "rankConstant"], ["lists", "topK"]);
  const topK = integer(args.topK, 1, 10), rankConstant = args.rankConstant === undefined ? 60 : finite(args.rankConstant);
  if (rankConstant <= 0 || rankConstant > 1000) fail("순위 상수는 0 초과 1,000 이하여야 해요.");
  const matches = new Map<string, Obj>();
  const inputLists = Array.isArray(args.lists) ? args.lists : Object.keys(object(args.lists)).sort().map(key => (args.lists as Obj)[key]);
  for (const values of list(inputLists, 1, 4)) {
    const seen = new Set<string>();
    list(values, 0, 100).forEach((value, index) => {
      const raw = object(value); keys(raw, ["resourceId", "version", "chunkIndex", "excerpt", "name", "url", "score"], ["resourceId", "version", "chunkIndex", "excerpt"]);
      const resourceId = text(raw.resourceId, 100), version = text(raw.version, 200), chunkIndex = integer(raw.chunkIndex, 0, 1000000), excerpt = text(raw.excerpt, 20000);
      if (raw.name !== undefined && typeof raw.name !== "string" || raw.url !== undefined && typeof raw.url !== "string" || raw.score !== undefined && (typeof raw.score !== "number" || !Number.isFinite(raw.score))) fail("검색 결과의 이름·주소·점수 형식을 확인해 주세요.");
      const key = canonicalJson([resourceId, version, chunkIndex]), existing = matches.get(key);
      if (existing && existing.excerpt !== excerpt) fail("같은 문서 버전과 조각의 내용이 서로 달라요.");
      if (seen.has(key)) return;
      seen.add(key);
      if (existing) existing.score = Number(existing.score) + 1 / (rankConstant + index + 1);
      else matches.set(key, { resourceId, version, chunkIndex, excerpt, ...(raw.name !== undefined ? { name: raw.name } : {}), ...(raw.url !== undefined ? { url: raw.url } : {}), score: 1 / (rankConstant + index + 1) });
    });
  }
  const ranked = [...matches.entries()].sort(([a, left], [b, right]) => Number(right.score) - Number(left.score) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, topK).map(([, value]) => value);
  return { matches: ranked, count: ranked.length };
}

/** Finite registry: no network, files, shell, uploaded source, SQL or eval. */
// 등록된 이름으로만 분기한다. 사용자 입력을 eval이나 동적 모듈로 실행하지 않는다.
export function executeProgram(config: ProgramConfig, input: Record<string, Json>): { text: string; data: Obj } {
  if (config.name === "python_tool" || config.name === "completion") throw new Error("등록된 Python 프로그램은 내보낸 실행기의 도구 어댑터가 필요해요.");
  const parsed = parseDataNodeConfig({ type: "program", program: config }).program!;
  const args = structuredClone(parsed.arguments);
  for (const [name, path] of Object.entries(parsed.bindings)) args[name] = dataAt(input, path);
  const safe = object(boundedJson(args));
  const result = parsed.name === "numeric_summary" ? numericSummary(safe) : parsed.name === "schema_check" ? schemaCheck(safe, false) : parsed.name === "schema_patch" ? schemaCheck(safe, true) : parsed.name === "evidence_check" ? evidenceCheck(safe) : parsed.name === "goal_check" ? goalCheck(safe) : rankFusion(safe);
  return { text: canonicalJson(result), data: result };
}
