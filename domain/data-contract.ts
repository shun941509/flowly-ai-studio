/**
 * 편집기의 출력 필드 선택지와 입력 매핑 진단을 실행 계약에 맞춰 제공한다.
 * 예시 경로는 실제 값의 존재를 보장하지 않으며 실행 시 스키마 검사를 대신하지 않는다.
 */
import type { Definition, FlowNode } from "../app/lib/model";
import type { DataSchema, InputBinding } from "../runtime/types";
import { safeDataPath } from "./node-config";
import { safeField } from "./schema";

export type OutputField = { path: string; type?: DataSchema["type"]; declared: boolean; label: string };
export const dataTypeNames: Record<DataSchema["type"], string> = { string: "글", number: "숫자", boolean: "참·거짓", object: "객체", array: "목록" };
const obj = (properties: Record<string, DataSchema> = {}): DataSchema => ({ type: "object", properties });
const text: DataSchema = { type: "string" }, number: DataSchema = { type: "number" }, bool: DataSchema = { type: "boolean" };
const list: DataSchema = { type: "array" };

/**
 * 명시적인 매핑을 우선하고 이전 형식의 설계에는 연결 순서에 따른 기본 매핑을 제공한다.
 */
export function effectiveBindings(definition: Definition, node: FlowNode): Record<string, InputBinding> {
  return node.inputBindings ?? Object.fromEntries(definition.edges.filter(edge => edge.target === node.id).map((edge, index) => [index ? `context_${index}` : "text", { nodeId: edge.source, path: "text" }]));
}

/** Field discovery is a hint, never a generated sample answer or a proof of runtime presence. */
/**
 * 블록의 실제 반환 형태·사용자 출력 선언·연결된 입력을 바탕으로 선택 가능한 경로를 계산한다. 재귀 방문 집합으로 순환 추론을 막는다.
 */
export function outputFields(node: FlowNode, definition?: Definition, visiting = new Set<string>()): OutputField[] {
  if (visiting.has(node.id)) return [];
  const seen = new Set(visiting).add(node.id), fields = new Map<string, OutputField>();
  const replaceField = (field: OutputField) => {
    for (const path of fields.keys()) if (path === field.path || path.startsWith(`${field.path}.`)) fields.delete(path);
    fields.set(field.path, field);
  };
  const addSchema = (schema: DataSchema, prefix = "", declared = false, depth = 0) => {
    if (depth > 8) return;
    if (prefix) replaceField({ path: prefix, type: schema.type, declared, label: dataTypeNames[schema.type] });
    if (schema.type === "object") for (const [name, child] of Object.entries(schema.properties ?? {})) addSchema(child, prefix ? `${prefix}.${name}` : name, declared, depth + 1);
    // Index zero is an editable path example, not a guarantee that the list is nonempty.
    if (schema.type === "array" && schema.items && prefix) addSchema(schema.items, `${prefix}.0`, declared, depth + 1);
  };
  const inputFields = () => {
    if (!definition) return;
    for (const [target, binding] of Object.entries(effectiveBindings(definition, node))) {
      const source = definition.nodes.find(item => item.id === binding.nodeId);
      if (!source) continue;
      for (const field of outputFields(source, definition, seen)) if (field.path === binding.path || field.path.startsWith(`${binding.path}.`)) {
        const path = target + field.path.slice(binding.path.length);
        fields.set(path, { ...field, path, declared: false });
      }
    }
  };
  if (["condition", "review", "evaluate", "guardrail", "resource", "skill", "error", "output", "classify", "memory"].includes(node.type)) inputFields();
  if (!["condition", "review", "evaluate", "guardrail", "memory", "classify"].includes(node.type)) addSchema(obj({ text }));
  if (node.type === "input") addSchema(node.inputSchema ?? obj({ text }));
  if (node.type === "form") addSchema(obj({ data: obj(Object.fromEntries((node.form?.fields ?? []).map(field => [field.key, { type: field.type === "number" ? "number" : field.type === "boolean" ? "boolean" : "string" } as DataSchema]))) }));
  if (["ai", "agent"].includes(node.type) && node.format === "JSON") fields.set("data", { path: "data", declared: false, label: "JSON 값 · 출력 형식을 선언하면 세부 항목을 선택할 수 있어요" });
  if (node.type === "tool" || node.type === "compensate" || node.program?.name === "python_tool") fields.set("data", { path: "data", declared: false, label: "도구 응답 · 상세 형식은 연결한 도구에 따라 달라요" });
  if (node.type === "transform" || node.type === "merge" || node.type === "program" && node.program?.name !== "python_tool") {
    if (node.type === "transform" && node.transform?.mode === "template") { /* template returns text only */ }
    else if (node.type === "transform" && node.transform?.mode === "parse_json") fields.set("data", { path: "data", declared: false, label: "해석한 JSON 값" });
    else if (node.type === "merge" && node.merge?.mode !== "object") addSchema(obj({ data: list }));
    else {
      addSchema(obj({ data: obj() }));
      if (node.type === "merge" && definition) for (const [target, binding] of Object.entries(effectiveBindings(definition, node))) {
        const source = definition.nodes.find(item => item.id === binding.nodeId);
        if (source) for (const field of outputFields(source, definition, seen)) if (field.path === binding.path || field.path.startsWith(`${binding.path}.`)) {
          const path = `data.${target}${field.path.slice(binding.path.length)}`; fields.set(path, { ...field, path, declared: false });
        }
      }
      if (node.type === "transform" && node.transform?.mode === "pick") for (const key of Object.keys(node.transform.fields ?? {})) fields.set(`data.${key}`, { path: `data.${key}`, declared: false, label: "선택한 값" });
      if (node.program?.name === "numeric_summary") addSchema(obj({ data: obj({ count: number, sum: number, min: number, max: number, mean: number, unit: text }) }));
      if (node.program?.name === "schema_check" || node.program?.name === "schema_patch") addSchema(obj({ data: obj({ valid: bool, errors: list }) }));
    }
  }
  if (node.type === "condition") addSchema(obj({ matched: bool }));
  if (node.type === "evaluate") addSchema(obj({ evaluation: obj({ passed: bool, score: number, checks: list, reason: text }) }));
  if (node.type === "review") addSchema(obj({ approved: bool }));
  if (node.type === "guardrail") addSchema(obj({ guardrail: obj({ changed: bool, counts: obj() }) }));
  if (node.type === "trigger") fields.set("data", { path: "data", declared: false, label: "받은 JSON 값 또는 문자열" });
  if (node.type === "classify") addSchema(obj({ label: text, reason: text }));
  if (node.type === "retrieval") addSchema(obj({ query: text, count: number, ...(node.retrieval?.mode === "web" ? { sources: list } : { matches: list }) }));
  if (node.type === "resource" || node.type === "skill") addSchema(obj({ resource: obj({ id: text, version: text, type: text, content: text }) }));
  if (node.type === "memory") { replaceField({ path: "data", declared: false, label: "저장된 값" }); addSchema(obj({ found: bool })); }
  if (["parallel", "agent_team", "orchestrator", "loop"].includes(node.type)) {
    addSchema(obj({ results: { type: "array", items: obj({ taskId: text, output: obj({ text }) }) }, count: number }));
    if (node.orchestration?.completion || node.orchestration?.tasks.some(task => task.dependsOn?.length)) addSchema(obj({ artifacts: obj(), completionChecks: list }));
  }
  if (node.type === "subworkflow" && node.subworkflow) for (const child of node.subworkflow.definition.nodes.filter(child => child.type === "output")) for (const field of outputFields(child, node.subworkflow.definition)) fields.set(field.path, { ...field, declared: false });
  if (node.onError === "branch") addSchema(obj({ error: obj({ message: text, nodeId: text }) }));
  if (node.outputSchema) addSchema(node.outputSchema, "", true);
  return [...fields.values()].filter(field => safeDataPath(field.path));
}

function pathSchema(schema: DataSchema | undefined, path: string): DataSchema | undefined {
  let current = schema;
  for (const part of path.split(".")) current = current?.type === "array" && /^(0|[1-9]\d*)$/.test(part) ? current.items : current?.type === "object" ? current.properties?.[part] : undefined;
  return current;
}
export type MappingIssue = { nodeId: string; field: string; message: string; severity: "error" | "warning" };
/**
 * 직접 선행 관계와 필수 입력을 검사한다. 알려진 자료형의 불일치와 분기에서 값이 빠질 가능성은 경고로 구분한다.
 */
export function mappingIssues(definition: Definition, node: FlowNode): MappingIssue[] {
  const result: MappingIssue[] = [];
  for (const [field, binding] of Object.entries(effectiveBindings(definition, node))) {
    const source = definition.nodes.find(item => item.id === binding.nodeId);
    if (!source || !definition.edges.some(edge => edge.source === source.id && edge.target === node.id)) { result.push({ nodeId: node.id, field, severity: "error", message: `‘${node.title}’의 ${field} 입력에 직접 연결된 앞 단계를 선택해 주세요.` }); continue; }
    if (!safeDataPath(binding.path)) { result.push({ nodeId: node.id, field, severity: "error", message: `‘${node.title}’의 ${field} 결과 경로를 확인해 주세요.` }); continue; }
    const actual = pathSchema(source.outputSchema, binding.path)?.type ?? outputFields(source, definition).find(item => item.path === binding.path)?.type;
    const expected = node.inputSchema?.properties?.[field]?.type;
    const pending=[source.id],seen=new Set<string>();let conditional=false;
    while(pending.length){const id=pending.pop()!;if(seen.has(id))continue;seen.add(id);for(const edge of definition.edges.filter(item=>item.target===id)){if(edge.branch)conditional=true;pending.push(edge.source);}}
    if(conditional)result.push({nodeId:node.id,field,severity:"warning",message:`‘${node.title}’의 ${field}는 분기에서 건너뛸 수 있는 ‘${source.title}’의 값이에요. 실행되지 않은 경로에는 값이 없으므로 필수 입력·합류 처리를 확인하세요.`});
    if (actual && expected && actual !== expected) result.push({ nodeId: node.id, field, severity: "warning", message: `‘${node.title}’의 ${field}: ‘${source.title}’의 ${binding.path}는 ${dataTypeNames[actual]}이고 받을 형식은 ${dataTypeNames[expected]}이에요. 값 변환 또는 형식을 확인하세요. 실제 실행에서 형식을 검사해요.` });
  }
  for (const field of node.inputSchema?.required ?? []) if (!Object.hasOwn(effectiveBindings(definition, node), field) && !(field === "text" && !["merge", "transform"].includes(node.type) && Object.keys(effectiveBindings(definition, node)).some(key => key.startsWith("context_"))) && !["input", "trigger"].includes(node.type) && !(node.type === "form" && node.form?.mode !== "request")) result.push({ nodeId: node.id, field, severity: "error", message: `‘${node.title}’의 필수 입력 ${field}를 연결해 주세요.` });
  return result;
}

/** Edit the already supported schema contract; no workflow format change. */
/**
 * 기존 출력 스키마를 복제해 필드를 추가·변경·제거한다. 배열의 0 경로는 항목 스키마 편집을 뜻한다.
 */
export function setOutputField(schema: DataSchema | undefined, path: string, type?: DataSchema["type"]): DataSchema | undefined {
  const parts = path.split(".");
  if (!parts.length || parts.length > 8 || parts.some((part,index) => !safeField(part) && !(index>0&&part==="0"))) throw new Error("출력 항목은 영문 필드 이름을 점으로 연결해 주세요. 목록 항목은 0으로 표시해요. 예: data.items.0.title");
  const next = structuredClone(schema ?? obj());
  if (next.type !== "object") throw new Error("최상위 출력은 객체 형식이어야 해요.");
  let current = next;
  for (const [index,part] of parts.slice(0, -1).entries()) {
    if (current.type === "array" && part === "0") { current.items ??= {type:parts[index+1]==="0"?"array":"object"};current=current.items;continue; }
    if(current.type!=="object")throw new Error("상위 항목의 객체·목록 형식을 먼저 확인해 주세요.");
    current.properties ??= {};
    const child = current.properties[part];
    if (!child && !type) return next;
    if (child && child.type !== "object" && child.type!=="array") throw new Error("상위 항목이 객체·목록 형식일 때 세부 항목을 추가할 수 있어요.");
    current = current.properties[part] ??= parts[index+1]==="0"?{type:"array"}:obj();
  }
  const last = parts.at(-1)!;
  if(current.type==="array"&&last==="0"){if(type)current.items=current.items?.type===type?current.items:{type};else delete current.items;return next;}
  if(current.type!=="object"||!safeField(last))throw new Error("상위 항목의 객체·목록 형식을 확인해 주세요.");
  current.properties ??= {};
  if (type) {
    const existing = current.properties[last];
    current.properties[last] = existing?.type === type ? existing : { type };
  } else { delete current.properties[last]; current.required = current.required?.filter(key => key !== last); }
  return next;
}
