import type { Definition } from "../app/lib/model";
import { allNodes } from "./advanced-config";
import { groupWorkflowIdentities } from "./workflow-identity";

/** Model-only calls and calculations remain useful supporting flows, not Agent examples. */
export function hasExplicitAgent(definition: Definition): boolean {
  return allNodes(definition).some(node => node.type === "agent");
}

/** Every published example must have its own executable structure, including children. */
export function assertDistinctExamples(entries: {id:string;definition:Definition}[]) {
  const groups=groupWorkflowIdentities(entries);
  const topologies=new Set(groups.map(group=>group.topology));
  if(groups.some(group=>group.ids.length>1)||topologies.size!==entries.length) {
    throw new Error("예제 프로젝트에는 서로 다른 실행 구조만 등록할 수 있어요. 같은 흐름의 문구·설정 변형은 제외해 주세요.");
  }
  return {projects:entries.length,topologies:topologies.size};
}
