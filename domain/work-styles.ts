import type { Definition, NodeType } from "../app/lib/model";
import { allNodes } from "./advanced-config";

export const workStyleLabels = {
  direct: "직접 해결", research: "조사·근거", parallel: "병렬 분석", review: "작성·검증", planning: "계획·배정", human: "사람과 협업", search: "후보 탐색", recovery: "실패·복구", memory: "기억 활용", composite: "하위 흐름 조합",
} as const;
export type WorkStyle = keyof typeof workStyleLabels;
/** Classification uses executable blocks/settings, never title or prompt keywords. */
export function workflowWorkStyles(definition: Definition): WorkStyle[] {
  const nodes=allNodes(definition), has=(...types:NodeType[])=>nodes.some(node=>types.includes(node.type));
  const result:WorkStyle[]=[];
  if(has("retrieval","knowledge"))result.push("research");
  if(has("parallel")||nodes.some(node=>node.team?.mode==="parallel"||node.loop&&node.loop.concurrency>1))result.push("parallel");
  if(has("evaluate")||nodes.some(node=>node.team?.mode==="sequential"))result.push("review");
  if(has("orchestrator"))result.push("planning");
  if(has("review")||nodes.some(node=>node.form?.mode==="request"))result.push("human");
  if(has("candidate_search"))result.push("search");
  if(has("error","compensate")||nodes.some(node=>node.onError==="branch"))result.push("recovery");
  if(has("memory"))result.push("memory");
  if(has("parallel","agent_team","orchestrator","subworkflow","loop"))result.push("composite");
  if(!result.length)result.push("direct");
  return result;
}
