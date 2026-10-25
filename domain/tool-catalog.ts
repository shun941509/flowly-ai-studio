import catalog from './tool-catalog.json';
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
export const TOOL_CANDIDATES = TOOL_CATALOG.tools;
export const PLANNED_EXAMPLES = TOOL_CATALOG.examples;
const candidatesById = new Map(TOOL_CANDIDATES.map(tool => [tool.id, tool]));
const examplesById = new Map(PLANNED_EXAMPLES.map(example => [example.id, example]));
export const getToolCandidate = (id: string): ToolCandidate | undefined => candidatesById.get(id);
export const getPlannedExample = (id: string): PlannedExample | undefined => examplesById.get(id);
export const getToolsForExample = (id: string): ToolCandidate[] => TOOL_CANDIDATES.filter(tool => tool.exampleIds.includes(id));
export const getExamplesForTool = (id: string): PlannedExample[] => PLANNED_EXAMPLES.filter(example => example.toolIds.includes(id));

/** No remote discovery and no candidate-to-tool permission expansion. */
export function resolveToolCandidates(ids: readonly string[]): ToolCandidate[] {
  const unique = [...new Set(ids)];
  return unique.map(id => {
    const tool = getToolCandidate(id);
    if (!tool) throw new Error(`등록되지 않은 Python 도구입니다: ${id}`);
    return tool;
  });
}
