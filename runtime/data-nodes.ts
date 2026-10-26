// 모델 없이 처리하는 값 매핑·변환·합류·규칙 평가·문서 검색 함수. 여기서 반환하는 필드가 편집기 입출력 계약의 기준이다.
import type { FlowNode, Resource } from "../app/lib/model";
import { safeDataPath, validateJson } from "../domain/node-config";
import { canonicalJson } from "./policy";
import type { Json } from "./types";
import { RuntimeFault } from "./policy";
import { resourceSearchText } from "../domain/resource-document";

// 허용된 점 경로와 자기 소유 필드만 읽는다. 누락 값은 암묵적 빈 값으로 바꾸지 않고 호출자에게 오류로 전달한다.
export function dataAt(input: Record<string, Json>, path: string): Json {
  if (!safeDataPath(path)) throw new Error("값 경로 형식을 확인해 주세요.");
  let value: Json = input;
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) || !Object.hasOwn(value, key)) throw new Error(`입력에서 ${path} 값을 찾지 못했어요.`);
    value = (value as Record<string, Json>)[key];
  }
  return value;
}
const textOf = (v: Json) => typeof v === "string" ? v : canonicalJson(v);

// 설계에 고정한 인자를 복사한 뒤 명시적 바인딩만 덮어쓴다. 보상 노드도 같은 규칙을 따른다.
export function toolArguments(node: FlowNode, input: Record<string, Json>): Record<string, Json> {
  const config = node.type === "compensate" ? node.compensation : node.tool;
  const args = structuredClone(config?.arguments ?? {});
  for (const [name, path] of Object.entries(config?.bindings ?? {})) args[name] = dataAt(input, path);
  validateJson(args);
  return args;
}

/** Input filtering is explicit workflow behavior, separate from secret log redaction. */
export function guardrailData(node: FlowNode, input: Record<string, Json>): Record<string, Json> {
  const config = node.guardrail!;
  const patterns: Record<string, RegExp> = {
    email: /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi,
    phone: /(?<!\d)(?:\+82[- .]?)?0?1[016789][- .]?\d{3,4}[- .]?\d{4}(?!\d)/g,
    resident_id: /(?<!\d)\d{6}[- ]?[1-8]\d{6}(?!\d)/g,
    card: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g,
    secret: /(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~+\/-]{8,}|(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*["']?[^\s,"'}]{4,})/gi,
  };
  const counts: Record<string, Json> = Object.fromEntries(config.categories.map(category => [category, 0]));
  const visit = (value: Json): Json => {
    if (typeof value === "string") {
      let result = value;
      for (const category of config.categories) result = result.replace(patterns[category], () => { counts[category] = Number(counts[category]) + 1; return config.action === "remove" ? "" : `[${category} 숨김]`; });
      return result;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
    return value;
  };
  const data = visit(input) as Record<string, Json>;
  const changed = Object.values(counts).some(count => Number(count) > 0);
  if (changed && config.action === "block") throw new RuntimeFault("failed", "민감한 입력이 탐지되어 정책에 따라 중지했어요. 원문은 표시하지 않아요.");
  return { ...data, guardrail: { counts, changed } };
}

// 문자 수 규칙은 유니코드 코드 포인트 기준이다. 모델 평가와 달리 이 결과는 고정 규칙으로 재현 가능하다.
export function ruleEvaluation(node: FlowNode, input: Record<string, Json>): Record<string, Json> {
  const text = String(input.text ?? ""), config = node.evaluation!;
  const checks = config.rules.map(rule => {
    let passed = false;
    if (rule.kind === "contains") passed = text.includes(rule.value);
    if (rule.kind === "not_contains") passed = !text.includes(rule.value);
    if (rule.kind === "not_blank") { try { const value = dataAt(input, rule.value); passed = typeof value === "string" && value.trim().length > 0; } catch {} }
    if (rule.kind === "min_length") passed = Array.from(text).length >= Number(rule.value);
    if (rule.kind === "max_length") passed = Array.from(text).length <= Number(rule.value);
    if (rule.kind === "json") { try { validateJson(JSON.parse(text)); passed = true; } catch {} }
    return { kind: rule.kind, passed };
  });
  const score = checks.filter(check => check.passed).length / Math.max(1, checks.length);
  return { ...input, evaluation: { score, passed: score >= config.threshold, checks, reason: `${checks.filter(check => check.passed).length}/${checks.length} 규칙 통과` } };
}

// 권한 검사 후 전달된 문서 스냅샷을 약 20% 겹치는 조각으로 나누고 원본 버전을 함께 기록한다.
export function documentChunks(node: FlowNode, resources: Resource[]) {
  const config = node.retrieval!;
  const chunks: { resourceId: string; name: string; url: string; version: string; chunkIndex: number; excerpt: string }[] = [];
  for (const id of config.resourceIds) {
    const resource = resources.find(r => r.id === id && ["document", "prompt"].includes(r.type));
    if (!resource) throw new RuntimeFault("failed", "검색 자료의 권한 또는 종류를 확인해 주세요.");
    const chars = Array.from(resourceSearchText(resource)), stride = config.chunkSize - Math.floor(config.chunkSize * .2);
    for (let start = 0, chunkIndex = 0; start < chars.length; start += stride, chunkIndex++) {
      chunks.push({ resourceId: id, name: resource.name, url: resource.url, version: resource.updatedAt, chunkIndex, excerpt: chars.slice(start, start + config.chunkSize).join("") });
      if (start + config.chunkSize >= chars.length) break;
    }
  }
  return chunks;
}

export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length || [...a, ...b].some(value => !Number.isFinite(value))) throw new Error("임베딩 벡터 형식이 올바르지 않아요.");
  const aLength = Math.hypot(...a), bLength = Math.hypot(...b);
  if (!aLength || !bLength || !Number.isFinite(aLength) || !Number.isFinite(bLength)) throw new Error("임베딩 벡터가 비어 있거나 정규화할 수 없어요.");
  const score = a.reduce((sum, value, index) => sum + (value / aLength) * (b[index] / bLength), 0);
  if (!Number.isFinite(score)) throw new Error("임베딩 유사도를 계산하지 못했어요.");
  return Math.max(-1, Math.min(1, score));
}

export function transformData(node: FlowNode, input: Record<string, Json>): Record<string, Json> {
  const c = node.transform ?? { mode: "pick", fields: { text: "text" } };
  if (c.mode === "template") {
    const template = c.template ?? "";
    const text = template.replace(/\{\{([^{}]*)\}\}/g, (_, path: string) => textOf(dataAt(input, path.trim())));
    return { text };
  }
  let data: Json;
  if (c.mode === "parse_json") {
    if (typeof input.text !== "string") throw new Error("JSON으로 바꿀 text 입력은 문자열이어야 해요.");
    try { data = JSON.parse(input.text); } catch { throw new Error("입력 내용이 올바른 JSON이 아니에요."); }
    validateJson(data);
  } else {
    data = Object.fromEntries(Object.entries(c.fields ?? { text: "text" }).map(([name, path]) => [name, dataAt(input, path)]));
  }
  return { text: canonicalJson(data), data };
}

// 입력 키를 정렬한 후 합쳐 실행 순서와 무관한 결과를 만든다. 중복 제거는 정규화된 JSON 값 기준이다.
export function mergeData(node: FlowNode, input: Record<string, Json>): Record<string, Json> {
  const c = node.merge ?? { mode: "text" };
  const entries = Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (c.mode === "object") { const data = Object.fromEntries(entries); return { text: canonicalJson(data), data }; }
  let values = entries.map(([, v]) => v);
  if (c.mode === "array") values = values.flatMap(v => Array.isArray(v) ? v : [v]);
  if (c.deduplicate) { const seen = new Set<string>(); values = values.filter(v => { const key = canonicalJson(v); if (seen.has(key)) return false; seen.add(key); return true; }); }
  return { text: c.mode === "text" ? values.map(textOf).join(c.separator ?? "\n\n") : canonicalJson(values), data: values };
}

/** Local lexical retrieval over authorized export snapshots; no embeddings/model/network. */
// 단어와 한글 2글자 조각의 포함 개수로 순위를 매기는 로컬 검색이다. 벡터 검색은 engine의 별도 경로를 사용한다.
export function retrieveDocuments(node: FlowNode, input: Record<string, Json>, resources: Resource[]): Record<string, Json> {
  const c = node.retrieval;
  if (!c || typeof input.text !== "string" || !input.text.trim()) throw new Error("문서 검색에는 검색할 자료와 비어 있지 않은 text 질문이 필요해요.");
  const query = input.text;
  const tokens = new Set<string>();
  for (const word of query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    tokens.add(word);
    for (const hangul of word.match(/[가-힣]+/g) ?? []) for (let i = 0; i < hangul.length - 1; i++) tokens.add(hangul.slice(i, i + 2));
  }
  const terms = [...tokens].slice(0, 64);
  const matches: { resourceId: string; name: string; url: string; version: string; chunkIndex: number; excerpt: string; score: number; order: number }[] = [];
  c.resourceIds.forEach((id, order) => {
    const resource = resources.find(r => r.id === id);
    if (!resource || !["document", "prompt"].includes(resource.type)) throw new Error("검색할 문서에 접근할 수 없어요. 연결한 자료를 확인해 주세요.");
    const chars = Array.from(resourceSearchText(resource));
    const stride = c.chunkSize - Math.floor(c.chunkSize * .2);
    for (let start = 0, chunkIndex = 0; start < chars.length; start += stride, chunkIndex++) {
      const excerpt = chars.slice(start, start + c.chunkSize).join("");
      const lower = excerpt.toLowerCase();
      const score = terms.filter(term => lower.includes(term)).length;
      if (score) matches.push({ resourceId: id, name: resource.name, url: resource.url, version: resource.updatedAt, chunkIndex, excerpt, score, order });
      if (start + c.chunkSize >= chars.length) break;
    }
  });
  const selected = matches.sort((a, b) => b.score - a.score || a.order - b.order || a.chunkIndex - b.chunkIndex).slice(0, c.topK).map(m => ({ resourceId: m.resourceId, name: m.name, url: m.url, version: m.version, chunkIndex: m.chunkIndex, excerpt: m.excerpt, score: m.score }));
  const evidence = selected.map((m, i) => `[${i + 1}] ${m.name} (조각 ${m.chunkIndex + 1})\n${m.excerpt}\n출처: ${m.url || m.resourceId}`).join("\n\n") || "검색된 근거가 없어요. 자료에서 확인되지 않은 내용을 만들지 마세요.";
  return { text: `질문: ${query}\n\n${evidence}`, query, matches: selected, count: selected.length };
}
