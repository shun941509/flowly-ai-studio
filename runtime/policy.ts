// 실행 한도, 허용 JSON, 인자 해시와 비밀 값 제거의 공통 정책. 승인·재개 비교에 쓰이는 정규화 규칙은 호환성 계약이다.
import { DEFAULT_LIMITS, type Json, type Limits } from "./types";

export { DEFAULT_LIMITS } from "./types";
const CEILINGS: Limits = { maxTurns: 20, maxToolCalls: 20, maxTokens: 32000, maxDurationMs: 120000 };
export class RuntimeFault extends Error {
  constructor(public readonly code: "failed" | "cancelled" | "expired" | "budget_exceeded" | "unknown_outcome", message: string) { super(message); }
}
// 누락 값은 공통 기본값으로 보완하고 환경의 상한을 넘는 값은 거절한다. 하위 실행 예산 분배는 engine에서 처리한다.
export function normalizeLimits(value: Partial<Limits> = {}, ceiling: Limits = CEILINGS): Limits {
  const result = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(result) as (keyof Limits)[]) {
    const supplied = value[key] ?? Math.min(DEFAULT_LIMITS[key], ceiling[key]);
    if (!Number.isSafeInteger(supplied) || supplied < 1 || supplied > ceiling[key]) throw new RuntimeFault("failed", "실행 한도는 허용 범위의 양의 정수로 입력해 주세요.");
    result[key] = supplied;
  }
  return result;
}
// 키 순서·숫자·중첩·크기를 정규화한다. argsHash가 이 바이트열에 의존하므로 편의상 직렬화 방식을 바꾸면 승인 비교가 달라진다.
export function canonicalJson(value: unknown): string {
  function normalize(item: unknown, depth: number): Json {
    if (depth > 24) throw new RuntimeFault("failed", "도구 입력 구조가 너무 깊어요.");
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(x => normalize(x, depth + 1));
    if (typeof item === "object" && item && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)) {
      const result: Record<string, Json> = Object.create(null);
      for (const key of Object.keys(item).sort()) {
        if (["__proto__", "prototype", "constructor"].includes(key)) throw new RuntimeFault("failed", "허용되지 않은 도구 입력 필드예요.");
        result[key] = normalize((item as Record<string, unknown>)[key], depth + 1);
      }
      return result;
    }
    throw new RuntimeFault("failed", "도구 입력은 유효한 JSON이어야 해요.");
  }
  const text = JSON.stringify(normalize(value, 0));
  if (new TextEncoder().encode(text).length > 200000) throw new RuntimeFault("failed", "한 번의 입출력은 200KB를 넘을 수 없어요.");
  return text;
}
export async function argsHash(args: Record<string, Json>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(args)));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
}
// Logs never include provider errors. Known credential shapes are removed from returned data.
export function redactText(text: string): string {
  return text.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[비밀 값 숨김]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [비밀 값 숨김]");
}
export function redactJson(value: Json): Json {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|client[_-]?secret)$/i.test(key) ? "[비밀 값 숨김]" : redactJson(item)]));
  return value;
}
// 알려진 자격 증명 원문을 문자열과 객체 키에서 제거한다. 패턴 기반 redactText만으로 잡히지 않는 값에 사용한다.
export function redactSecret(value: Json, secret?: string): Json {
  if (!secret) return value;
  if (typeof value === "string") return value.split(secret).join("[비밀 값 숨김]");
  if (Array.isArray(value)) return value.map(item => redactSecret(item, secret));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.split(secret).join("[비밀 값 숨김]"), redactSecret(item, secret)]));
  return value;
}
