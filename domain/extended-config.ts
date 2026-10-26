/**
 * 파일 입출력·문서 추출·가드레일·평가·트리거·보상 작업의 설정 검증.
 * 응답 모델과 임베딩 필요 여부도 여기서 구분하며 웹에서 서비스를 호출하지 않는다.
 */
import type { FlowNode } from "../app/lib/model";
import type { ExtendedNodeConfig, GuardrailConfig, EvaluationConfig } from "../runtime/types";
import { parseDataNodeConfig, safeDataPath } from "./node-config";

export const extendedConfigTypes = { fileInput: "file_input", documentExtract: "document_extract", guardrail: "guardrail", evaluation: "evaluate", fileOutput: "file_output", trigger: "trigger", compensation: "compensate" } as const;
function object(value: unknown, fields: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !fields.includes(k))) throw new Error("블록 설정의 항목과 형식을 확인해 주세요.");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max) throw new Error(`설정은 ${max}자 이내로 입력해 주세요.`);
  return value;
}
function path(value: unknown) { const v = text(value, 500); if (!safeDataPath(v)) throw new Error("이전 결과의 값 경로를 확인해 주세요."); return v; }
function int(value: unknown, max: number) { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`설정은 1~${max} 정수가 필요해요.`); return value; }
function choice<T extends string>(value: unknown, options: readonly T[]): T { if (!options.includes(value as T)) throw new Error("지원하는 처리 방식을 선택해 주세요."); return value as T; }
/**
 * 각 블록이 지원하는 설정과 범위를 확인한다. 실제 파일 접근·모델 평가·보상 실행은 실행기의 책임이다.
 */
export function parseExtendedNodeConfig(node: Record<string, unknown>): ExtendedNodeConfig {
  const out: ExtendedNodeConfig = {};
  for (const [field, type] of Object.entries(extendedConfigTypes)) if (node[field] !== undefined && node.type !== type) throw new Error("다른 종류의 블록 설정이 포함되어 있어요.");
  if (node.fileInput !== undefined) { const c = object(node.fileInput, ["path", "maxBytes"]); out.fileInput = { path: path(c.path), maxBytes: int(c.maxBytes, 10000000) }; }
  if (node.documentExtract !== undefined) { const c = object(node.documentExtract, ["mode", "filePath", "maxPages", "language"]); const language = text(c.language, 80); if (!/^[A-Za-z_+\-]+$/.test(language)) throw new Error("OCR 언어는 kor+eng 같은 언어 코드로 입력해 주세요."); out.documentExtract = { mode: choice(c.mode, ["text", "table", "ocr"]), filePath: path(c.filePath), maxPages: int(c.maxPages, 100), language }; }
  if (node.guardrail !== undefined) {
    const c = object(node.guardrail, ["action", "categories"]);
    if (!Array.isArray(c.categories) || !c.categories.length || c.categories.length > 5 || new Set(c.categories).size !== c.categories.length) throw new Error("검사할 민감정보 종류를 중복 없이 선택해 주세요.");
    out.guardrail = { action: choice(c.action, ["mask", "remove", "block"]), categories: c.categories.map(v => choice(v, ["email", "phone", "resident_id", "card", "secret"])) as GuardrailConfig["categories"] };
  }
  if (node.evaluation !== undefined) {
    const c = object(node.evaluation, ["mode", "rules", "rubric", "threshold"]), mode = choice(c.mode, ["rules", "model"]);
    if (!Array.isArray(c.rules) || c.rules.length > 20 || (mode === "rules" && !c.rules.length)) throw new Error("평가 규칙은 1~20개가 필요해요.");
    if (typeof c.threshold !== "number" || !Number.isFinite(c.threshold) || c.threshold < 0 || c.threshold > 1) throw new Error("평가 통과 기준은 0~1 사이예요.");
    const rules: EvaluationConfig["rules"] = c.rules.map(raw => { const r = object(raw, ["kind", "value"]); const kind = choice(r.kind, ["contains", "not_contains", "not_blank", "min_length", "max_length", "json"]); const value = kind === "not_blank" ? path(r.value) : text(r.value, 2000, kind === "json"); if (["min_length", "max_length"].includes(kind) && (!/^\d+$/.test(value) || Number(value) > 200000)) throw new Error("길이 평가 기준은 0~200,000 정수예요."); return { kind, value }; });
    out.evaluation = { mode, rules, rubric: text(c.rubric, 4000, mode === "rules"), threshold: c.threshold };
  }
  if (node.fileOutput !== undefined) {
    const c = object(node.fileOutput, ["format", "filename", "dataPath"]), format = choice(c.format, ["csv", "xlsx", "pdf", "docx"]), filename = text(c.filename, 120);
    if (/[\\/:*?"<>|\x00-\x1f]/.test(filename) || filename.startsWith(".") || /[ .]$/.test(filename) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(filename) || !filename.toLowerCase().endsWith(`.${format}`)) throw new Error("파일명은 선택한 확장자를 포함하고 폴더 경로 없이 입력해 주세요.");
    out.fileOutput = { format, filename, dataPath: path(c.dataPath) };
  }
  if (node.trigger !== undefined) {
    const c = object(node.trigger, ["kind", "intervalSeconds", "startAt", "eventType"]), kind = choice(c.kind, ["schedule", "webhook", "event"]), startAt = text(c.startAt, 100, true);
    if (startAt && (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(startAt) || !Number.isFinite(Date.parse(startAt)))) throw new Error("시작 시각은 시간대가 포함된 ISO 날짜로 입력해 주세요.");
    out.trigger = { kind, intervalSeconds: int(c.intervalSeconds, 86400), startAt, eventType: text(c.eventType, 120, kind !== "event") };
  }
  if (node.compensation !== undefined) {
    const c = object(node.compensation, ["sourceNodeId", "arguments", "bindings"]);
    const tool = parseDataNodeConfig({ type: "tool", tool: { arguments: c.arguments, bindings: c.bindings } }).tool!;
    out.compensation = { sourceNodeId: text(c.sourceNodeId, 100), ...tool };
  }
  if (node.delivery !== undefined) { const c = object(node.delivery, ["stream"]); if (node.type !== "output" || typeof c.stream !== "boolean") throw new Error("답변 출력에서 스트리밍 여부를 설정해 주세요."); out.delivery = { stream: c.stream }; }
  return out;
}
export const missingExtendedConfig = (node: FlowNode) => Object.entries(extendedConfigTypes).some(([key, type]) => type === node.type && node[key as keyof ExtendedNodeConfig] === undefined);
/**
 * 벡터 검색/색인처럼 임베딩 연결이 필요한 설정인지 판별한다.
 */
export const nodeUsesEmbeddings = (node: FlowNode) => node.type === "retrieval" && node.retrieval?.mode === "vector" || node.type === "knowledge" && node.knowledge?.mode === "vector" && ["stage", "query", "evaluate"].includes(node.knowledge.action);
/**
 * 응답 생성 모델이 필요한 블록과 실행 방식을 판별한다.
 */
export const nodeRequiresResponseModel = (node: FlowNode) => ["ai", "agent", "classify", "orchestrator", "candidate_search"].includes(node.type) || node.type === "evaluate" && node.evaluation?.mode === "model" || node.type === "retrieval" && node.retrieval?.mode === "web";
/**
 * 응답 생성 또는 임베딩 중 하나라도 필요하면 모델 설정 대상으로 표시한다.
 */
export const nodeRequiresModel = (node: FlowNode) => nodeRequiresResponseModel(node) || nodeUsesEmbeddings(node);
