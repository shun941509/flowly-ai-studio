/**
 * 조건 분기와 완료 조건에서 공유하는 제한된 비교식 파서·평가기.
 * 사용자 입력을 코드로 평가하지 않고 정해진 연산자와 값 경로로 판단한다.
 */
import type { PredicateConfig } from "../runtime/types";
import { safeDataPath } from "./node-config";

const primitive = (v: unknown) => v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
/**
 * 비교식 구조를 검사해 실행기가 해석할 수 있는 조건만 허용한다.
 */
export function parsePredicate(value: unknown): PredicateConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("값 비교 조건을 확인해 주세요.");
  const c = value as Record<string, unknown>;
  if (Object.keys(c).some(k => !["path", "operator", "value", "rightPath"].includes(k)) || typeof c.path !== "string" || !safeDataPath(c.path) || !["eq", "ne", "gt", "gte", "lt", "lte", "contains"].includes(String(c.operator)) || (Object.hasOwn(c, "value") === Object.hasOwn(c, "rightPath"))) throw new Error("비교 경로·연산자와 비교 대상 하나를 지정해 주세요.");
  if (Object.hasOwn(c, "value") && !primitive(c.value)) throw new Error("비교 값은 글자·숫자·참/거짓·null 중 하나여야 해요.");
  if (Object.hasOwn(c, "rightPath") && (typeof c.rightPath !== "string" || !safeDataPath(c.rightPath))) throw new Error("비교할 다른 값의 경로를 확인해 주세요.");
  return structuredClone(c) as PredicateConfig;
}
/**
 * 현재 입력에서 경로 값을 찾아 등록된 비교 연산을 적용한다.
 */
export function evaluatePredicate(config: PredicateConfig, input: unknown): boolean {
  const c = parsePredicate(config);
  const read = (path: string): unknown => path.split(".").reduce<unknown>((value, part) => {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) throw new Error("조건에서 비교할 값이 없어요. 입력 연결을 확인해 주세요.");
    return (value as Record<string, unknown>)[part];
  }, input);
  const left = read(c.path), right = c.rightPath === undefined ? c.value : read(c.rightPath);
  if (!primitive(left) || !primitive(right)) throw new Error("조건은 단일 글자·숫자·참/거짓 값만 비교할 수 있어요.");
  if (c.operator === "eq" || c.operator === "ne") return c.operator === "eq" ? left === right : left !== right;
  if (c.operator === "contains") {
    if (typeof left !== "string" || typeof right !== "string") throw new Error("포함 비교에는 두 문자열이 필요해요.");
    return left.includes(right);
  }
  if (typeof left !== "number" || typeof right !== "number") throw new Error("크기 비교에는 두 숫자가 필요해요. 숫자로 보이는 문자열은 허용하지 않아요.");
  return c.operator === "gt" ? left > right : c.operator === "gte" ? left >= right : c.operator === "lt" ? left < right : left <= right;
}
