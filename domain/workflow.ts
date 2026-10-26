/**
 * 워크플로 JSON을 현재 실행 계약으로 정규화하고, 노드 사이의 실제 값 전달을 정의한다.
 * UI와 실행기가 공유하는 순수 로직이며 세션·자료 권한 검사는 호출 측의 서버/실행 어댑터 책임이다.
 */
import { parseDefinition, validateGraph, type Definition, type FlowNode, type FlowEdge } from "../app/lib/model";
import { allNodes, childDefinitions } from "./advanced-config";
import type { Json } from "../runtime/types";
export { assertSchema } from "./schema";

/** v1 AI remains a single model call. MCP catalog references never grant tools. */
/**
 * 오래된 설계에 입력 매핑과 기본 스키마를 보충한다. 연결 순서가 기본 text/context_n 매핑을 결정하며 AI 블록을 Agent로 바꾸지는 않는다.
 */
export function migrateV1(definition: Definition): Definition {
  return {...definition, schemaVersion:2, nodes:definition.nodes.map(node=>({...node,
    inputBindings:node.inputBindings ?? Object.fromEntries(definition.edges.filter(e=>e.target===node.id).map((e,i)=>[i===0?"text":`context_${i}`,{nodeId:e.source,path:"text"}])),
    inputSchema:node.inputSchema ?? {type:"object"}, outputSchema:node.outputSchema ?? (node.predicate ? {type:"object",properties:{matched:{type:"boolean"}},required:["matched"]} : ["input","trigger","guardrail","evaluate","review","classify","memory"].includes(node.type) ? {type:"object"} : {type:"object",properties:{text:{type:"string"}},required:["text"]}),
  }))};
}
/** Additive v3 data/tool nodes. Existing v2 semantics and mappings stay unchanged. */
/**
 * 기존 매핑을 보존한 채 v3 버전 표식과 노드 사본을 만든다.
 */
export function migrateV2(definition: Definition): Definition {
  return { ...definition, schemaVersion: 3, nodes: definition.nodes.map(node => ({ ...node })) };
}
/** v4 keeps old mappings; embedded definitions are pinned and migrated independently. */
/**
 * 병렬·팀·조정·반복·하위 워크플로에 고정된 자식 설계까지 v4 계약으로 이관한다.
 */
export function migrateV3(definition: Definition): Definition {
  const migrate = (child: Definition) => migrateV3(migrateV2(migrateV1(child)));
  return { ...definition, schemaVersion: 4, nodes: definition.nodes.map(node => ({ ...node,
    ...(node.parallel ? { parallel: { ...node.parallel, tasks: node.parallel.tasks.map(t => ({ ...t, definition: migrate(t.definition) })) } } : {}),
    ...(node.team ? { team: { ...node.team, tasks: node.team.tasks.map(t => ({ ...t, definition: migrate(t.definition) })) } } : {}),
    ...(node.orchestration ? { orchestration: { ...node.orchestration, tasks: node.orchestration.tasks.map(t => ({ ...t, definition: migrate(t.definition) })) } } : {}),
    ...(node.subworkflow ? { subworkflow: { definition: migrate(node.subworkflow.definition) } } : {}),
    ...(node.loop ? { loop: { ...node.loop, definition: migrate(node.loop.definition) } } : {}),
  })) };
}
/** v5 preserves old behavior; new settings are opt-in and child definitions remain pinned. */
/**
 * 새 설정을 강제하지 않고 중첩 설계까지 v5 버전으로 맞춘다.
 */
export function migrateV4(definition: Definition): Definition {
  return { ...definition, schemaVersion: 5, nodes: definition.nodes.map(node => ({ ...node,
    ...(node.parallel ? { parallel: { ...node.parallel, tasks: node.parallel.tasks.map(t => ({ ...t, definition: migrateV4(t.definition) })) } } : {}),
    ...(node.team ? { team: { ...node.team, tasks: node.team.tasks.map(t => ({ ...t, definition: migrateV4(t.definition) })) } } : {}),
    ...(node.orchestration ? { orchestration: { ...node.orchestration, tasks: node.orchestration.tasks.map(t => ({ ...t, definition: migrateV4(t.definition) })) } } : {}),
    ...(node.subworkflow ? { subworkflow: { definition: migrateV4(node.subworkflow.definition) } } : {}),
    ...(node.loop ? { loop: { ...node.loop, definition: migrateV4(node.loop.definition) } } : {}),
  })) };
}
/**
 * 외부 값을 파싱·이관한 뒤 그래프와 직접 선행 노드의 입력 매핑을 검사한다. 중첩 오류도 모아 예외로 보고하며 실행이나 외부 연결은 수행하지 않는다.
 */
export function compileDefinition(value: unknown): Definition {
  const parsed = parseDefinition(value);
  const withBindings = migrateV1(parsed);
  const d = migrateV4(migrateV3(migrateV2(withBindings)));
  const errors = validateGraph(d);
  const validateBindings = (graph: Definition) => { for (const node of graph.nodes) {
    for (const b of Object.values(node.inputBindings||{})) if (!graph.edges.some(e=>e.source===b.nodeId && e.target===node.id)) errors.push(`‘${node.title}’의 입력은 직접 연결된 이전 블록에서 선택해 주세요.`);
    childDefinitions(node).forEach(validateBindings);
  } };
  validateBindings(d);
  if (errors.length) throw new Error([...new Set(errors)].join("\n"));
  return d;
}
/**
 * 중첩 설계의 자료·검색·지식 색인·허용 도구 참조를 중복 없이 수집한다. 반환된 ID 자체는 사용 권한을 뜻하지 않는다.
 */
export function referencedResourceIds(definition: Definition): string[] {
  return [...new Set(allNodes(definition).flatMap(n=>[...(n.resourceId?[n.resourceId]:[]),...(n.retrieval?.resourceIds ?? []),...(n.knowledge?.resourceIds ?? []),...(n.allowedTools||[]).map(t=>t.resourceId)]))];
}
/**
 * 명시적인 route 선택을 우선하고, 이전 실행 기록의 yes/no 불리언 분기는 호환 경로로 해석한다.
 */
export function edgeIsActive(edge: FlowEdge, branches: Record<string, boolean> = {}, routes: Record<string, string> = {}): boolean {
  return !edge.branch || (Object.hasOwn(routes, edge.source) ? routes[edge.source] === edge.branch : (edge.branch === "yes" || edge.branch === "no") && branches[edge.source] === (edge.branch === "yes"));
}
/**
 * 실행된 경로의 선행 출력에서 선언한 경로만 읽는다. 없는 값은 오류로 처리하며 건너뛴 분기의 값을 만들어 내지 않는다.
 */
export function resolveNodeInput(definition: Definition, node: FlowNode, outputs: Record<string,Record<string,Json>>, skipped: string[], branches?: Record<string,boolean>, routes?: Record<string,string>): Record<string,Json> {
  const result:Record<string,Json> = {};
  for (const [target,binding] of Object.entries(node.inputBindings||{})) {
    if (skipped.includes(binding.nodeId)) continue;
    if ((branches || routes) && !definition.edges.some(e => e.target === node.id && e.source === binding.nodeId && edgeIsActive(e, branches, routes))) continue;
    let value:unknown = outputs[binding.nodeId];
    for (const key of binding.path.split(".")) {
      if (!value || typeof value!=="object" || (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) || !Object.hasOwn(value,key)) throw new Error(`‘${node.title}’에서 이전 결과 ${binding.path}를 찾지 못했어요.`);
      value = (value as Record<string,unknown>)[key];
    }
    result[target] = value as Json;
  }
  // At branch joins the active predecessor may occupy a secondary binding.
  if (!["merge","transform"].includes(node.type) && !Object.hasOwn(result,"text") && Object.keys(result).some(k=>k.startsWith("context_"))) result.text = result[Object.keys(result).find(k=>k.startsWith("context_"))!];
  return result;
}
