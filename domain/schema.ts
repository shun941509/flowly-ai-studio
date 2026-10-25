import type { DataSchema, InputBinding, Json, Limits, ToolSelection } from "../runtime/types";
import { safeDataPath } from "./node-config";
import { getToolCandidate } from "./tool-catalog";

const dangerous = new Set(["__proto__", "prototype", "constructor"]);
export function safeField(value: string) { return /^[a-zA-Z_][a-zA-Z0-9_-]{0,79}$/.test(value) && !dangerous.has(value); }
export function parseSchema(value: unknown, depth = 0): DataSchema {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 8) throw new Error("입출력 형식을 확인해 주세요.");
  const s = value as DataSchema;
  if (Object.keys(s).some(key=>!["type","properties","required","items","additionalProperties"].includes(key))) throw new Error("지원하지 않는 스키마 제약이 있어요. 지원 형식으로 명시해 주세요.");
  if (!["object", "array", "string", "number", "boolean"].includes(s.type)) throw new Error("지원하지 않는 입출력 형식이에요.");
  const out: DataSchema = {type:s.type};
  if (s.properties !== undefined) {
    if (s.type !== "object" || !s.properties || typeof s.properties !== "object" || Array.isArray(s.properties) || Object.keys(s.properties).length > 40) throw new Error("객체 필드 형식을 확인해 주세요.");
    out.properties = {};
    for (const [key, schema] of Object.entries(s.properties)) { if (!safeField(key)) throw new Error("필드 이름을 확인해 주세요."); out.properties[key] = parseSchema(schema, depth + 1); }
  }
  if (s.required !== undefined) { if (s.type !== "object" || !Array.isArray(s.required) || s.required.length > 40 || s.required.some(k => typeof k !== "string" || !safeField(k))) throw new Error("필수 필드를 확인해 주세요."); out.required = [...s.required]; }
  if (s.items !== undefined) { if (s.type !== "array") throw new Error("배열 형식에서만 항목을 지정할 수 있어요."); out.items = parseSchema(s.items, depth + 1); }
  if (s.additionalProperties !== undefined) { if (s.type !== "object" || typeof s.additionalProperties !== "boolean") throw new Error("추가 필드 허용 여부를 확인해 주세요."); out.additionalProperties = s.additionalProperties; }
  return out;
}
export function assertSchema(value: unknown, schema?: DataSchema, label = "데이터"): asserts value is Json {
  if (!schema) return;
  const matches = schema.type === "array" ? Array.isArray(value) : schema.type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : typeof value === schema.type;
  if (!matches || (typeof value === "number" && !Number.isFinite(value))) throw new Error(`${label} 형식이 맞지 않아요 (${schema.type}).`);
  if (schema.type === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required || []) if (!Object.hasOwn(obj,key)) throw new Error(`${label}.${key} 값이 필요해요.`);
    for (const [key,item] of Object.entries(obj)) {
      if (dangerous.has(key)) throw new Error("허용되지 않은 필드예요.");
      if (schema.properties?.[key]) assertSchema(item, schema.properties[key], `${label}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`${label}.${key} 필드를 사용할 수 없어요.`);
    }
  }
  if (schema.type === "array" && schema.items) (value as unknown[]).forEach((v,i) => assertSchema(v,schema.items,`${label}[${i}]`));
}
export function parseNodeRuntime(value: unknown) {
  const n = value as Record<string, unknown>;
  const out: {inputBindings?: Record<string,InputBinding>; inputSchema?:DataSchema; outputSchema?:DataSchema; allowedTools?:ToolSelection[]; pythonTools?:string[]; requireToolResult?:boolean; limits?:Partial<Limits>} = {};
  if (n.pythonTools !== undefined) {
    if (n.type !== "agent" || !Array.isArray(n.pythonTools) || n.pythonTools.length > 12 || n.pythonTools.some(id => typeof id !== "string" || !getToolCandidate(id)) || new Set(n.pythonTools).size !== n.pythonTools.length) throw new Error("Agent에서 사용할 등록 Python 도구를 중복 없이 12개까지 선택해 주세요.");
    out.pythonTools = [...n.pythonTools];
  }
  if (n.requireToolResult !== undefined) {
    if (n.type !== "agent" || typeof n.requireToolResult !== "boolean") throw new Error("도구 결과 필수 설정은 Agent 블록에서 켜기·끄기로 지정해 주세요.");
    out.requireToolResult = n.requireToolResult;
  }
  if (n.inputBindings !== undefined) {
    if (!n.inputBindings || typeof n.inputBindings !== "object" || Array.isArray(n.inputBindings) || Object.keys(n.inputBindings).length>40) throw new Error("이전 블록 입력 연결을 확인해 주세요.");
    out.inputBindings = {};
    for (const [key,raw] of Object.entries(n.inputBindings)) {
      const b = raw as InputBinding;
      if (!safeField(key) || !b || typeof b.nodeId!=="string" || b.nodeId.length>100 || typeof b.path!=="string" || !safeDataPath(b.path)) throw new Error("입력 연결의 블록과 필드를 확인해 주세요.");
      out.inputBindings[key] = {nodeId:b.nodeId,path:b.path};
    }
  }
  if (n.inputSchema !== undefined) out.inputSchema = parseSchema(n.inputSchema);
  if (n.outputSchema !== undefined) out.outputSchema = parseSchema(n.outputSchema);
  if (n.allowedTools !== undefined) {
    if (!Array.isArray(n.allowedTools) || n.allowedTools.length>12) throw new Error("허용 도구는 12개까지 선택할 수 있어요.");
    out.allowedTools = n.allowedTools.map((t:ToolSelection) => {
      if (!t || [t.resourceId,t.connectionId,t.toolName].some(x=>typeof x!=="string" || !x || x.length>100)) throw new Error("도구 연결을 확인해 주세요.");
      return {resourceId:t.resourceId, connectionId:t.connectionId,toolName:t.toolName};
    });
  }
  if ((out.allowedTools?.length ?? 0) + (out.pythonTools?.length ?? 0) > 12) throw new Error("MCP와 Python 도구를 합쳐 12개까지 선택할 수 있어요.");
  if (n.limits !== undefined) {
    if (!n.limits || typeof n.limits!=="object") throw new Error("실행 한도를 확인해 주세요.");
    out.limits = {};
    const ceilings:Limits = {maxTurns:20,maxToolCalls:20,maxTokens:32000,maxDurationMs:120000};
    for (const key of Object.keys(ceilings) as (keyof Limits)[]) {
      const v = (n.limits as Limits)[key];
      if (v !== undefined) { if (!Number.isInteger(v) || v<1 || v>ceilings[key]) throw new Error("실행 한도가 허용 범위를 벗어났어요."); out.limits[key] = v; }
    }
  }
  return out;
}
