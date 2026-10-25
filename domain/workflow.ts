import { parseDefinition, validateGraph, type Definition, type FlowNode, type FlowEdge } from "../app/lib/model";
import { allNodes, childDefinitions } from "./advanced-config";
import type { Json } from "../runtime/types";
export { assertSchema } from "./schema";

/** v1 AI remains a single model call. MCP catalog references never grant tools. */
export function migrateV1(definition: Definition): Definition {
  return {...definition, schemaVersion:2, nodes:definition.nodes.map(node=>({...node,
    inputBindings:node.inputBindings ?? Object.fromEntries(definition.edges.filter(e=>e.target===node.id).map((e,i)=>[i===0?"text":`context_${i}`,{nodeId:e.source,path:"text"}])),
    inputSchema:node.inputSchema ?? {type:"object"}, outputSchema:node.outputSchema ?? (node.predicate ? {type:"object",properties:{matched:{type:"boolean"}},required:["matched"]} : ["input","trigger","guardrail","evaluate","review","classify","memory"].includes(node.type) ? {type:"object"} : {type:"object",properties:{text:{type:"string"}},required:["text"]}),
  }))};
}
/** Additive v3 data/tool nodes. Existing v2 semantics and mappings stay unchanged. */
export function migrateV2(definition: Definition): Definition {
  return { ...definition, schemaVersion: 3, nodes: definition.nodes.map(node => ({ ...node })) };
}
/** v4 keeps old mappings; embedded definitions are pinned and migrated independently. */
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
export function migrateV4(definition: Definition): Definition {
  return { ...definition, schemaVersion: 5, nodes: definition.nodes.map(node => ({ ...node,
    ...(node.parallel ? { parallel: { ...node.parallel, tasks: node.parallel.tasks.map(t => ({ ...t, definition: migrateV4(t.definition) })) } } : {}),
    ...(node.team ? { team: { ...node.team, tasks: node.team.tasks.map(t => ({ ...t, definition: migrateV4(t.definition) })) } } : {}),
    ...(node.orchestration ? { orchestration: { ...node.orchestration, tasks: node.orchestration.tasks.map(t => ({ ...t, definition: migrateV4(t.definition) })) } } : {}),
    ...(node.subworkflow ? { subworkflow: { definition: migrateV4(node.subworkflow.definition) } } : {}),
    ...(node.loop ? { loop: { ...node.loop, definition: migrateV4(node.loop.definition) } } : {}),
  })) };
}
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
export function referencedResourceIds(definition: Definition): string[] {
  return [...new Set(allNodes(definition).flatMap(n=>[...(n.resourceId?[n.resourceId]:[]),...(n.retrieval?.resourceIds ?? []),...(n.knowledge?.resourceIds ?? []),...(n.allowedTools||[]).map(t=>t.resourceId)]))];
}
export function edgeIsActive(edge: FlowEdge, branches: Record<string, boolean> = {}, routes: Record<string, string> = {}): boolean {
  return !edge.branch || (Object.hasOwn(routes, edge.source) ? routes[edge.source] === edge.branch : (edge.branch === "yes" || edge.branch === "no") && branches[edge.source] === (edge.branch === "yes"));
}
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
