import type { Json, ProgramConfig, MergeConfig, RetrievalConfig, ToolNodeConfig, TransformConfig } from "../runtime/types";
import { getToolCandidate } from "./tool-catalog";

const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const field = (s: string) => /^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(s) && !forbidden.has(s);
export const safeDataPath = (s: string) => s.length <= 500 && s.split(".").every((p, i) => field(p) || (i > 0 && /^(0|[1-9][0-9]{0,5})$/.test(p)));
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("블록 설정은 객체 형식으로 입력해 주세요.");
  return v as Record<string, unknown>;
}
function keys(v: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error("지원하지 않는 블록 설정이 있어요.");
}
export function validateJson(value: unknown, depth = 0): asserts value is Json {
  if (depth > 16) throw new Error("데이터 중첩이 너무 깊어요.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(v => validateJson(v, depth + 1)); return; }
  if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (forbidden.has(key)) throw new Error("허용되지 않은 데이터 필드예요.");
      validateJson(v, depth + 1);
    }
    return;
  }
  throw new Error("JSON 데이터 형식을 확인해 주세요.");
}
function paths(v: unknown): Record<string, string> {
  const o = object(v);
  if (Object.keys(o).length > 40) throw new Error("값 연결은 40개까지 가능해요.");
  for (const [key, path] of Object.entries(o)) if (!field(key) || typeof path !== "string" || !safeDataPath(path)) throw new Error("값 연결의 필드 이름과 경로를 확인해 주세요.");
  return { ...o } as Record<string, string>;
}
export function parseDataNodeConfig(n: Record<string, unknown>): { program?: ProgramConfig; tool?: ToolNodeConfig; transform?: TransformConfig; merge?: MergeConfig; retrieval?: RetrievalConfig } {
  const out: ReturnType<typeof parseDataNodeConfig> = {};
  for (const key of ["tool", "program", "transform", "merge", "retrieval"]) if (n[key] !== undefined && n.type !== key) throw new Error("다른 종류의 블록 설정이 포함되어 있어요.");
  if (n.tool !== undefined) {
    const c = object(n.tool); keys(c, ["arguments", "bindings"]);
    const args = object(c.arguments === undefined ? {} : c.arguments); validateJson(args);
    if (Object.keys(args).some(k => !field(k)) || Object.keys(args).length > 40 || JSON.stringify(args).length > 20000) throw new Error("도구 입력은 40개 필드, 20,000자까지 가능해요.");
    out.tool = { arguments: structuredClone(args) as Record<string, Json>, bindings: paths(c.bindings === undefined ? {} : c.bindings) };
  }
  if (n.program !== undefined) {
    const c = object(n.program); keys(c, ["name", "arguments", "bindings"]);
    if (!["numeric_summary", "schema_check", "schema_patch", "evidence_check", "goal_check", "rank_fusion", "python_tool", "completion"].includes(String(c.name))) throw new Error("등록된 계산·검증 프로그램을 선택해 주세요.");
    const tool = parseDataNodeConfig({ type: "tool", tool: { arguments: c.arguments, bindings: c.bindings } }).tool!;
    if (c.name === "python_tool") {
      if (typeof tool.arguments.toolId !== "string" || !getToolCandidate(tool.arguments.toolId) || Object.hasOwn(tool.bindings, "toolId")) throw new Error("Python 도구 ID는 등록된 도구로 고정해 주세요. 앞 단계의 값으로 실행 도구를 바꿀 수 없어요.");
      if (Object.keys(tool.arguments).some(key => !["toolId", "arguments"].includes(key)) || Object.keys(tool.bindings).some(key => key !== "arguments")) throw new Error("Python 도구의 입력은 arguments에 지정해 주세요.");
      if (tool.arguments.arguments !== undefined) object(tool.arguments.arguments);
    }
    if (c.name === "completion") {
      if (typeof tool.arguments.operation !== "string" || !/^(research|technical|operations)\.[a-z][a-z0-9_]{1,79}$/.test(tool.arguments.operation)) throw new Error("등록된 업무 검증 작업 ID를 지정해 주세요.");
      if (Object.keys(tool.arguments).some(key => !["operation", "arguments"].includes(key)) || Object.keys(tool.bindings).some(key => key !== "arguments")) throw new Error("업무 작업 ID는 고정하고 입력만 arguments에 연결해 주세요.");
      if (tool.arguments.arguments !== undefined) object(tool.arguments.arguments);
    }
    out.program = { name: c.name as ProgramConfig["name"], ...tool };
  }
  if (n.transform !== undefined) {
    const c = object(n.transform); keys(c, ["mode", "fields", "template"]);
    if (!["pick", "template", "parse_json"].includes(String(c.mode))) throw new Error("값 변환 방식을 선택해 주세요.");
    if (c.template !== undefined && (typeof c.template !== "string" || c.template.length > 12000)) throw new Error("변환 양식은 12,000자까지 입력해 주세요.");
    if (c.mode === "template" && typeof c.template !== "string") throw new Error("변환 양식을 입력해 주세요.");
    out.transform = { mode: c.mode as TransformConfig["mode"], ...(c.fields !== undefined ? { fields: paths(c.fields) } : {}), ...(typeof c.template === "string" ? { template: c.template } : {}) };
  }
  if (n.merge !== undefined) {
    const c = object(n.merge); keys(c, ["mode", "separator", "deduplicate"]);
    if (!["object", "array", "text"].includes(String(c.mode)) || (c.separator !== undefined && (typeof c.separator !== "string" || c.separator.length > 200)) || (c.deduplicate !== undefined && typeof c.deduplicate !== "boolean")) throw new Error("결과 모으기 설정을 확인해 주세요.");
    out.merge = { mode: c.mode as MergeConfig["mode"], ...(typeof c.separator === "string" ? { separator: c.separator } : {}), ...(typeof c.deduplicate === "boolean" ? { deduplicate: c.deduplicate } : {}) };
  }
  if (n.retrieval !== undefined) {
    const c = object(n.retrieval); keys(c, ["resourceIds", "topK", "chunkSize", "mode", "indexKey"]);
    if (c.mode !== undefined && !["lexical", "vector", "web"].includes(String(c.mode))) throw new Error("검색 방식을 확인해 주세요.");
    if (c.indexKey !== undefined && (typeof c.indexKey !== "string" || !field(c.indexKey))) throw new Error("벡터 색인 이름을 확인해 주세요.");
    if (!Array.isArray(c.resourceIds) || c.resourceIds.length < (c.mode === "web" ? 0 : 1) || c.resourceIds.length > 20 || c.resourceIds.some(id => typeof id !== "string" || !id || id.length > 100) || new Set(c.resourceIds).size !== c.resourceIds.length) throw new Error("검색할 자료를 중복 없이 1~20개 선택해 주세요.");
    if (!Number.isInteger(c.topK) || Number(c.topK) < 1 || Number(c.topK) > 10 || !Number.isInteger(c.chunkSize) || Number(c.chunkSize) < 200 || Number(c.chunkSize) > 2000) throw new Error("검색 결과 수는 1~10개, 조각 크기는 200~2,000자로 설정해 주세요.");
    out.retrieval = { resourceIds: [...c.resourceIds] as string[], topK: c.topK as number, chunkSize: c.chunkSize as number, ...(c.mode !== undefined ? { mode: c.mode as RetrievalConfig["mode"] } : {}), ...(c.indexKey !== undefined ? { indexKey: c.indexKey as string } : {}) };
  }
  return out;
}
