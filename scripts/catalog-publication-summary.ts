/**
 * 전체 소스 회귀검사 수와 명시적 Agent 예제의 게시 목표를 따로 집계한다. 보조 흐름을 Agent 예제 목표 수에 더하지 않는다.
 */
/** Keep source regression coverage separate from the published Agent-example target. */
export type ClassifiedInventoryRecord = {
  id: string;
  hasAgent: boolean;
  topologyHash: string;
  executionHash: string;
  verified: boolean;
};

export function summarizeCatalogPublication(records: readonly ClassifiedInventoryRecord[], target: number) {
  if (!Number.isSafeInteger(target) || target < 1) throw new Error("목표는 양의 정수여야 합니다.");
  if (new Set(records.map(record => record.id)).size !== records.length) throw new Error("집계에 중복 설계 ID가 있습니다.");
  const agents = records.filter(record => record.hasAgent), supporting = records.filter(record => !record.hasAgent);
  const groups = (items: readonly ClassifiedInventoryRecord[]) => ({
    topologyGroups: new Set(items.map(item => item.topologyHash)).size,
    executionGroups: new Set(items.map(item => item.executionHash)).size,
  });
  const agentGroups = groups(agents), independentAgents = Math.min(agentGroups.topologyGroups, agentGroups.executionGroups);
  return {
    source: { graphs: records.length, ...groups(records), verifiedGraphs: records.filter(record => record.verified).length },
    publication: {
      criterion: "explicit_agent_including_nested_workflows",
      agentExamples: agents.length,
      supportingFlows: supporting.length,
      verifiedAgentExamples: agents.filter(record => record.verified).length,
      verifiedSupportingFlows: supporting.filter(record => record.verified).length,
      agentTopologyGroups: agentGroups.topologyGroups,
      agentExecutionGroups: agentGroups.executionGroups,
      target,
      remainingAgentExamples: Math.max(0, target - independentAgents),
      targetReached: independentAgents >= target,
    },
  };
}
