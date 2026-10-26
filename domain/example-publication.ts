/**
 * 공통 예제를 공개 목록에 실을 때 사용하는 Agent 포함 여부와 중복 검사.
 * 게시 가능성 검사는 실제 모델 품질이나 외부 서비스 연결 검증과 구분한다.
 */
import type { Definition } from "../app/lib/model";
import { allNodes } from "./advanced-config";
import { groupWorkflowIdentities } from "./workflow-identity";

/** Model-only calls and calculations remain useful supporting flows, not Agent examples. */
/**
 * 중첩 설계까지 명시적인 Agent 블록을 찾아 예제 게시 정책에 사용한다. 일반 설계 다운로드의 활성 조건은 아니다.
 */
export function hasExplicitAgent(definition: Definition): boolean {
  return allNodes(definition).some(node => node.type === "agent");
}

/** Every published example must have its own executable structure, including children. */
/**
 * 예제 집합의 구조·실행 식별자를 비교해 단순 이름 변경으로 수를 늘리는 것을 막는다.
 */
export function assertDistinctExamples(entries: {id:string;definition:Definition}[]) {
  const groups=groupWorkflowIdentities(entries);
  const topologies=new Set(groups.map(group=>group.topology));
  if(groups.some(group=>group.ids.length>1)||topologies.size!==entries.length) {
    throw new Error("예제 프로젝트에는 서로 다른 실행 구조만 등록할 수 있어요. 같은 흐름의 문구·설정 변형은 제외해 주세요.");
  }
  return {projects:entries.length,topologies:topologies.size};
}
