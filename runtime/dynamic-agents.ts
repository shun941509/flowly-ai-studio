// 동적 Sub-agent 배정 계획을 검증하고 등록된 하위 설계 템플릿으로 구체화한다. 임의 코드나 권한은 생성하지 않는다.
import type { CompositeTask, DynamicAgentSpec, Json, OrchestrationConfig } from "./types";
import { assertSchema } from "../domain/workflow";
import { canonicalJson } from "./policy";
import { NodeProcessingFault } from "./advanced";

const invalid = (message: string): never => { throw new NodeProcessingFault(message); };
const safeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(value) && !["__proto__", "prototype", "constructor"].includes(value);
const templateId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(value) && !["__proto__", "prototype", "constructor"].includes(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= max;

/** Planner output is data, never a new authority, graph, tool, or executable program. */
// 모델 결과의 필드·템플릿·입력 스키마를 검사하고 의존 관계를 위상 정렬한다. 순환이나 미등록 작업은 거절한다.
export function parseDynamicPlan(value: unknown, config: OrchestrationConfig): DynamicAgentSpec[] {
  const settings = config.dynamic;
  if (!settings || !value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !("agents" in value)) return invalid("동적 작업 계획에는 agents 배열만 필요해요.");
  const raw = (value as { agents: unknown }).agents;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > settings.maxAgents || canonicalJson(value as Json).length > 20000) return invalid("생성할 하위 Agent 수 또는 계획 크기가 한도를 벗어났어요.");
  const agents = raw.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).sort().join(",") !== "dependsOn,goal,id,input,role,templateId" || !safeId(item.id) || !templateId(item.templateId) || !text(item.role, 80) || !text(item.goal, 2000) || !item.input || typeof item.input !== "object" || Array.isArray(item.input) || !Array.isArray(item.dependsOn) || item.dependsOn.some((id: unknown) => !safeId(id)) || new Set(item.dependsOn).size !== item.dependsOn.length) return invalid("하위 Agent의 ID·역할·목표·입력·선행 관계 형식을 확인해 주세요.");
    const capability = settings.templates.find(template => template.taskId === item.templateId);
    if (!capability || !config.tasks.some(task => task.id === item.templateId)) return invalid("등록하지 않은 기능 템플릿으로 Agent를 만들 수 없어요.");
    try { assertSchema(item.input, capability.inputSchema, "하위 Agent 입력"); } catch { return invalid("생성된 하위 Agent 입력이 등록된 스키마와 달라요."); }
    return structuredClone(item) as DynamicAgentSpec;
  });
  if (new Set(agents.map(item => item.id)).size !== agents.length) return invalid("생성한 하위 Agent ID가 중복돼요.");
  const ordered: DynamicAgentSpec[] = [], visiting = new Set<string>(), done = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) return invalid("생성한 하위 Agent의 의존 관계가 순환해요.");
    if (done.has(id)) return;
    const agent = agents.find(item => item.id === id); if (!agent) return invalid("등록하지 않은 하위 Agent를 선행 작업으로 지정했어요.");
    visiting.add(id); agent.dependsOn.forEach(visit); visiting.delete(id); done.add(id); ordered.push(agent);
  };
  agents.forEach(agent => visit(agent.id));
  return ordered;
}

// 기존 설계를 복사하고 선택한 Agent의 역할·목표 지침만 추가한다. 도구·승인·실행 한도는 원래 템플릿을 유지한다.
export function instantiateDynamicTasks(agents: DynamicAgentSpec[], config: OrchestrationConfig): CompositeTask[] {
  return agents.map(agent => {
    const original = config.tasks.find(task => task.id === agent.templateId);
    const capability = config.dynamic!.templates.find(template => template.taskId === agent.templateId);
    if (!original || !capability) return invalid("저장된 Agent의 기능 템플릿을 찾을 수 없어요.");
    const definition = structuredClone(original.definition), worker = definition.nodes.find(node => node.id === capability.agentNodeId && node.type === "agent");
    if (!worker) return invalid("등록한 기능 템플릿의 Agent 블록을 확인해 주세요.");
    worker.prompt = `${worker.prompt ?? ""}\n동적으로 배정된 작업(권한·도구·승인·한도는 변경할 수 없음):\n${canonicalJson({ id: agent.id, role: agent.role, goal: agent.goal })}`;
    if (worker.prompt.length > 12000) return invalid("기존 지침과 생성한 역할·목표의 합계가 12,000자를 넘어요. 지침을 줄여 주세요.");
    return { id: agent.id, name: agent.role, definition, dependsOn: [...agent.dependsOn] };
  });
}

// 배정 정보와 완료된 선행 작업 산출물을 별도 필드로 전달하여 모델 지침과 실행 데이터의 경계를 보존한다.
export function dynamicChildInput(agent: DynamicAgentSpec, input: Record<string, Json>, artifacts: Record<string, Json> = {}): Record<string, Json> {
  return { text: typeof input.text === "string" ? input.text : "", assignment: { id: agent.id, role: agent.role, goal: agent.goal, input: structuredClone(agent.input) }, artifacts };
}
