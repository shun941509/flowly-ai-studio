import { parsePredicate } from "./predicate";
import type { Definition, FlowNode } from "../app/lib/model";
import type { AdvancedNodeConfig, CompositeTask, FormConfig, Json } from "../runtime/types";
import { DEFAULT_ORCHESTRATION_MAX_ROUNDS } from "../runtime/types";
import { safeDataPath, validateJson } from "./node-config";
import { parseSchema } from "./schema";

export const safeNodeKey = (value: string) => /^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(value) && !["__proto__", "prototype", "constructor"].includes(value);
const configTypes: Record<string, string> = { parallel: "parallel", team: "agent_team", orchestration: "orchestrator", subworkflow: "subworkflow", loop: "loop", review: "review", classification: "classify", form: "form", memory: "memory", error: "error" };
const noErrorBranch = ["input", "form", "trigger", "guardrail", "output", "condition", "review", "classify"];
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error("블록 설정의 항목과 객체 형식을 확인해 주세요.");
  return value as Record<string, unknown>;
}
function string(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max) throw new Error(`블록 설정의 글자는 ${max}자 이내로 입력해 주세요.`);
  return value;
}
function key(value: unknown): string { const s = string(value, 80); if (!safeNodeKey(s)) throw new Error("식별자는 영문·숫자·밑줄·하이픈으로 입력하고 영문 또는 밑줄로 시작해 주세요."); return s; }
function integer(value: unknown, max: number): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`이 설정은 1~${max} 정수가 필요해요.`); return value; }
function boolean(value: unknown): boolean { if (typeof value !== "boolean") throw new Error("설정의 켜기·끄기 값을 확인해 주세요."); return value; }
function path(value: unknown): string { const s = string(value, 500); if (!safeDataPath(s)) throw new Error("이전 값의 경로를 확인해 주세요."); return s; }
function unique(values: string[]) { if (new Set(values).size !== values.length) throw new Error("설정에 같은 식별자나 선택값이 반복되어 있어요."); }

function dependencyIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error("선행 작업은 8개까지 지정할 수 있어요.");
  const ids = value.map(key); unique(ids); return ids;
}
function completionPredicates(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw new Error("완료 조건은 1~20개가 필요해요.");
  return value.map(parsePredicate);
}

/** The caller supplies a bounded recursive parser to avoid graph/model module cycles. */
export function parseAdvancedNodeConfig(n: Record<string, unknown>, parseChild: (value: unknown) => Definition): AdvancedNodeConfig {
  const out: AdvancedNodeConfig = {};
  for (const [field, type] of Object.entries(configTypes)) if (n[field] !== undefined && n.type !== type) throw new Error("다른 종류의 블록 설정이 포함되어 있어요.");
  if (n.onError !== undefined) {
    if (n.onError !== "stop" && n.onError !== "branch") throw new Error("오류 시 중지 또는 분기를 선택해 주세요.");
    if (n.onError === "branch" && noErrorBranch.includes(String(n.type))) throw new Error("이 블록에서는 오류 분기를 사용할 수 없어요.");
    out.onError = n.onError;
  }
  const tasks = (value: unknown, dependencies = false): CompositeTask[] => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new Error("하위 작업은 1~8개를 등록해 주세요.");
    const result = value.map(raw => { const t = object(raw, dependencies ? ["id", "name", "definition", "dependsOn"] : ["id", "name", "definition"]); return { id: key(t.id), name: string(t.name, 80), definition: parseChild(t.definition), ...(t.dependsOn !== undefined ? { dependsOn: dependencyIds(t.dependsOn) } : {}) }; });
    unique(result.map(t => t.id));
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw new Error("작업의 선행 관계가 순환하고 있어요.");
      if (visited.has(id)) return;
      const task = result.find(t => t.id === id); if (!task) throw new Error("등록하지 않은 선행 작업이에요.");
      visiting.add(id); (task.dependsOn ?? []).forEach(visit); visiting.delete(id); visited.add(id);
    };
    result.forEach(task => visit(task.id)); return result;
  };
  if (n.parallel !== undefined) {
    const c = object(n.parallel, ["tasks", "concurrency", "completion"]);
    let completion;
    if (c.completion !== undefined) { const policy = object(c.completion, ["mode", "checks"]); if (policy.mode !== "first_match") throw new Error("병렬 완료 방식은 조건을 먼저 충족한 결과 선택만 지원해요."); completion = { mode: "first_match" as const, checks: completionPredicates(policy.checks) }; }
    out.parallel = { tasks: tasks(c.tasks), concurrency: integer(c.concurrency, 4), ...(completion ? { completion } : {}) };
  }
  if (n.team !== undefined) { const c = object(n.team, ["tasks", "mode", "concurrency"]); if (c.mode !== "sequential" && c.mode !== "parallel") throw new Error("팀 작업의 순차 또는 병렬 실행을 선택해 주세요."); out.team = { tasks: tasks(c.tasks), mode: c.mode, concurrency: integer(c.concurrency, 4) }; }
  if (n.orchestration !== undefined) {
    const c = object(n.orchestration, ["tasks", "maxTasks", "mode", "maxRounds", "completion", "dynamic"]);
    const list = tasks(c.tasks, true);
    if (c.mode !== undefined && c.mode !== "plan" && c.mode !== "adaptive" && c.mode !== "dynamic") throw new Error("작업 조정 방식을 확인해 주세요.");
    out.orchestration = { tasks: list, maxTasks: integer(c.maxTasks, list.length), ...(c.mode !== undefined ? { mode: c.mode } : {}), ...(c.maxRounds !== undefined ? { maxRounds: integer(c.maxRounds, 8) } : {}), ...(c.completion !== undefined ? { completion: completionPredicates(c.completion) } : {}) };
    if (c.mode === "dynamic") {
      const d = object(c.dynamic, ["maxAgents", "concurrency", "templates"]);
      if (!out.orchestration.completion?.length) throw new Error("동적 에이전트에는 독립적으로 확인할 완료 조건이 필요해요.");
      if (!Array.isArray(d.templates) || !d.templates.length || d.templates.length > 8) throw new Error("생성할 에이전트의 작업 틀을 1~8개 지정해 주세요.");
      const templates = d.templates.map(raw => {
        const t = object(raw, ["taskId", "agentNodeId", "inputSchema"]), taskId = key(t.taskId), agentNodeId = key(t.agentNodeId), inputSchema = parseSchema(t.inputSchema);
        const task = list.find(item => item.id === taskId);
        if (!task || !task.definition.nodes.some(node => node.id === agentNodeId && node.type === "agent") || inputSchema.type !== "object") throw new Error("작업 틀의 에이전트와 객체 입력 형식을 확인해 주세요.");
        return { taskId, agentNodeId, inputSchema };
      });
      unique(templates.map(t => t.taskId));
      if (list.some(t => t.dependsOn?.length || allNodes(t.definition).some(node => node.orchestration?.mode === "dynamic"))) throw new Error("동적 작업의 선행 관계는 생성 계획에 지정하며, 작업 틀 안에 동적 생성을 중첩할 수 없어요.");
      const maxAgents = integer(d.maxAgents, 8);
      if (maxAgents * Math.max(...list.map(t => allNodes(t.definition).length)) > 120) throw new Error("생성한 작업의 전체 블록 한도는 120개예요.");
      out.orchestration.dynamic = { maxAgents, concurrency: integer(d.concurrency, 4), templates };
    } else if (c.dynamic !== undefined) throw new Error("동적 생성 설정은 동적 계획 방식에서만 사용할 수 있어요.");
  }
  if (n.subworkflow !== undefined) { const c = object(n.subworkflow, ["definition"]); out.subworkflow = { definition: parseChild(c.definition) }; }
  if (n.loop !== undefined) { const c = object(n.loop, ["definition", "itemsPath", "maxItems", "concurrency"]); out.loop = { definition: parseChild(c.definition), itemsPath: path(c.itemsPath), maxItems: integer(c.maxItems, 20), concurrency: integer(c.concurrency, 4) }; }
  if (n.review !== undefined) { const c = object(n.review, ["instructions", "allowEdit", "timeoutMinutes"]); out.review = { instructions: string(c.instructions, 4000, true), allowEdit: boolean(c.allowEdit), timeoutMinutes: integer(c.timeoutMinutes, 1440) }; }
  if (n.classification !== undefined) {
    const c = object(n.classification, ["labels"]);
    if (!Array.isArray(c.labels) || c.labels.length < 2 || c.labels.length > 8) throw new Error("분류는 2~8개를 등록해 주세요.");
    const labels = c.labels.map(raw => { const l = object(raw, ["id", "name", "description"]); return { id: key(l.id), name: string(l.name, 80), description: string(l.description, 500, true) }; });
    unique(labels.map(l => l.id)); out.classification = { labels };
  }
  if (n.form !== undefined) {
    const c = object(n.form, ["fields", "mode", "instructions", "timeoutMinutes"]);
    if (!Array.isArray(c.fields) || c.fields.length < 1 || c.fields.length > 20) throw new Error("입력 항목은 1~20개를 등록해 주세요.");
    const fields: FormConfig["fields"] = c.fields.map(raw => {
      const f = object(raw, ["key", "label", "type", "required", "options"]);
      if (!["text", "number", "boolean", "date", "select", "file"].includes(String(f.type))) throw new Error("입력 항목의 자료형을 선택해 주세요.");
      let options: string[] | undefined;
      if (f.type === "select") { if (!Array.isArray(f.options) || f.options.length < 1 || f.options.length > 30) throw new Error("선택지는 1~30개가 필요해요."); options = f.options.map(v => string(v, 200)); unique(options); }
      else if (f.options !== undefined) throw new Error("선택형 항목에서만 선택지를 등록할 수 있어요.");
      return { key: key(f.key), label: string(f.label, 80), type: f.type as FormConfig["fields"][number]["type"], required: boolean(f.required), ...(options ? { options } : {}) };
    });
    unique(fields.map(f => f.key));
    if (c.mode !== undefined && c.mode !== "initial" && c.mode !== "request") throw new Error("입력 양식의 시작 또는 보완 입력 방식을 선택해 주세요.");
    out.form = { fields, ...(c.mode !== undefined ? { mode: c.mode } : {}), ...(c.instructions !== undefined ? { instructions: string(c.instructions, 4000, true) } : {}), ...(c.timeoutMinutes !== undefined ? { timeoutMinutes: integer(c.timeoutMinutes, 10080) } : {}) };
  }
  if (n.memory !== undefined) {
    const c = object(n.memory, ["action", "key", "valuePath", "defaultValue", "backend", "ttlSeconds", "scope", "expectedRevisionPath"]);
    if (c.scope !== undefined && c.scope !== "workflow" && c.scope !== "run") throw new Error("기억 범위는 워크플로 또는 현재 실행으로 선택해 주세요.");
    if (c.backend === "mcp" && (c.scope === "run" || c.expectedRevisionPath !== undefined)) throw new Error("실행별 기억과 버전 충돌 검사는 로컬 기억에서 지원해요.");
    if (c.expectedRevisionPath !== undefined && (c.action !== "write" || c.ttlSeconds !== undefined)) throw new Error("버전 충돌 검사는 만료 시간이 없는 기억 쓰기에서 사용해 주세요.");
    if (c.backend !== undefined && c.backend !== "local" && c.backend !== "mcp") throw new Error("기억 저장 위치를 확인해 주세요.");
    if (c.action !== "read" && c.action !== "write" && c.action !== "delete") throw new Error("기억의 읽기·쓰기·삭제 중 하나를 선택해 주세요.");
    if (c.action === "write" && c.valuePath === undefined) throw new Error("저장할 값의 경로가 필요해요.");
    if (c.defaultValue !== undefined) { validateJson(c.defaultValue); if (JSON.stringify(c.defaultValue).length > 20000) throw new Error("기억 기본값은 20,000자까지 사용할 수 있어요."); }
    out.memory = { action: c.action, key: key(c.key), ...(c.valuePath !== undefined ? { valuePath: path(c.valuePath) } : {}), ...(c.defaultValue !== undefined ? { defaultValue: structuredClone(c.defaultValue) as Json } : {}), ...(c.backend !== undefined ? { backend: c.backend } : {}), ...(c.ttlSeconds !== undefined ? { ttlSeconds: integer(c.ttlSeconds, 31536000) } : {}), ...(c.scope !== undefined ? {scope: c.scope} : {}), ...(c.expectedRevisionPath !== undefined ? {expectedRevisionPath: path(c.expectedRevisionPath)} : {}) };
  }
  if (n.error !== undefined) { const c = object(n.error, ["template"]); out.error = { template: string(c.template, 12000, true) }; }
  return out;
}
export function childDefinitions(node: FlowNode): Definition[] {
  return [...(node.parallel?.tasks ?? node.team?.tasks ?? node.orchestration?.tasks ?? []).map(t => t.definition), ...(node.subworkflow ? [node.subworkflow.definition] : []), ...(node.loop ? [node.loop.definition] : [])];
}
export function allNodes(definition: Definition): FlowNode[] { return definition.nodes.flatMap(node => [node, ...childDefinitions(node).flatMap(allNodes)]); }
/** Conservative materialized-node bound, used only for workflows opting into dynamic creation. */
export function expandedNodeCount(definition: Definition): number {
  return definition.nodes.reduce((count, node) => {
    const children = childDefinitions(node).map(expandedNodeCount);
    let expanded = children.reduce((sum, value) => sum + value, 0);
    if (node.orchestration?.mode === "dynamic") expanded = node.orchestration.dynamic!.maxAgents * Math.max(0, ...children);
    else if (node.orchestration?.mode === "adaptive") expanded = node.orchestration.maxTasks * (node.orchestration.maxRounds ?? DEFAULT_ORCHESTRATION_MAX_ROUNDS) * Math.max(0, ...children);
    else if (node.loop) expanded = node.loop.maxItems * expanded;
    return count + 1 + expanded;
  }, 0);
}
export function nodeRoutes(node: FlowNode): { id: string; label: string }[] {
  if (node.type === "condition") return [{ id: "yes", label: "예" }, { id: "no", label: "아니요" }];
  if (node.type === "review") return [{ id: "yes", label: "수락" }, { id: "no", label: "거절" }];
  if (node.type === "classify") return (node.classification?.labels ?? []).map(l => ({ id: l.id, label: l.name }));
  if (node.onError === "branch") return [{ id: "success", label: "성공" }, { id: "error", label: "오류" }];
  return [];
}
export function missingAdvancedConfig(node: FlowNode): boolean {
  const field = Object.keys(configTypes).find(key => configTypes[key] === node.type);
  return !!field && node[field as keyof AdvancedNodeConfig] === undefined;
}

export function isStartNode(node: FlowNode): boolean { return node.type === "input" || node.type === "trigger" || node.type === "form" && node.form?.mode !== "request"; }
