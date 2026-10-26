/**
 * 도구화 후보와 예제의 관계를 읽는 카탈로그 조회 계층.
 * 목록에 연결된 후보는 도구 사용 허가나 실제 서비스 검증 완료를 뜻하지 않는다.
 */
import catalog from './tool-catalog.json';
import support from './tool-support.json';
import type { DataSchema, Json } from '../runtime/types';

/** Candidate membership is independent from installed dependencies and live configuration. */
export type ToolCandidate = {
  id: string;
  name: string;
  label: string;
  family: string;
  description: string;
  implementation: 'python' | 'configuration' | 'model' | 'mcp';
  dependencyGroup: string;
  exampleIds: string[];
  inputSchema: DataSchema;
  exampleArguments: Record<string, Json>;
  usage: string;
  dependencies: string[];
  modelRequired: boolean;
  effect: 'read' | 'write';
  status: 'available' | 'configuration_required';
  /** 소스 분기·반환문 감사 정보다. 설치·모델 품질·실행 성공 인증이 아니다. */
  support?: ToolSupport;
};
export type ToolSupport = {
  source: string; handler: string; sourceLine: number; sourceFingerprint: string;
  algorithm: string; outputFields: string[]; outputDescription: string; limitation: string;
  scope: string; verification: 'source_audited'; sharedImplementationIds: string[];
};
export type PlannedExample = {
  id: string;
  title: string;
  status: string;
  sourceIds: string[];
  families: string[];
  requirement: string;
  /** Candidate recommendations; these do not grant permission or enable every tool. */
  toolIds: string[];
  integrationStatus: string;
  baselineStatus: string;
  integrationScope: string;
  agentCriterionMet: boolean;
  acceptance?: string[];
  remainingSetup?: string[];
};
export const TOOL_CATALOG = catalog as unknown as {
  version: 1;
  source: string;
  classificationNote: string;
  families: { id: string; name: string; dependencyGroup: string; count: number }[];
  tools: ToolCandidate[];
  examples: PlannedExample[];
};
export const TOOL_FAMILIES = TOOL_CATALOG.families;
// 지원 설명은 Python 처리 함수 지문을 보관한 별도 생성물에서 합친다. 기존 카탈로그·워크플로 JSON 형식은 유지한다.
const supportById = support.tools as Record<string, ToolSupport>;
export const TOOL_CANDIDATES: ToolCandidate[] = TOOL_CATALOG.tools.map(tool => ({ ...tool, support: supportById[tool.id] }));
export const PLANNED_EXAMPLES = TOOL_CATALOG.examples;
const candidatesById = new Map(TOOL_CANDIDATES.map(tool => [tool.id, tool]));
const examplesById = new Map(PLANNED_EXAMPLES.map(example => [example.id, example]));
export const getToolCandidate = (id: string): ToolCandidate | undefined => candidatesById.get(id);
export const getPlannedExample = (id: string): PlannedExample | undefined => examplesById.get(id);
export const getToolsForExample = (id: string): ToolCandidate[] => TOOL_CANDIDATES.filter(tool => tool.exampleIds.includes(id));
export const getExamplesForTool = (id: string): PlannedExample[] => PLANNED_EXAMPLES.filter(example => example.toolIds.includes(id));

/** No remote discovery and no candidate-to-tool permission expansion. */
/**
 * 지정된 후보 식별자를 카탈로그 정의로 해석한다. 실행 허용 목록과 사용자 자료 권한은 다른 경계에서 검사한다.
 */
export function resolveToolCandidates(ids: readonly string[]): ToolCandidate[] {
  const unique = [...new Set(ids)];
  return unique.map(id => {
    const tool = getToolCandidate(id);
    if (!tool) throw new Error(`등록되지 않은 Python 도구입니다: ${id}`);
    return tool;
  });
}
