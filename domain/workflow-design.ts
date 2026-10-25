import type { Definition, Resource } from "../app/lib/model";

/** An independently authored executable graph, never a prompt-only case variant. */
export type WorkflowScenario = {
  name: string;
  input: string;
  modelReplies?: { match: string; text?: string; toolCall?: { name: string; args: Record<string, import("../runtime/types").Json>; callId?: string }; occurrence?: number; inputContains?: string[]; inputExcludes?: string[]; observationContains?: string[]; allowedTools?: string[]; delayMs?: number }[];
  embeddingReplies?: { text: string; vector: number[] }[];
  embeddingCallCount?: number;
  toolReplies?: { name: string; args: Record<string, import("../runtime/types").Json>; result?: Record<string, import("../runtime/types").Json>; error?: "disconnect" | "tool_error"; localOperation?: string; count?: number }[];
  toolCallCounts?: Record<string, number>;
  modelCallCounts?: Record<string, number>;
  parallelMatches?: string[];
  approval?: "approve" | "deny";
  resumeAgain?: boolean;
  errorContains?: string[];
  stateGroup?: string;
  /** Test-only historical state, written through the actual store before a CLI run. Never exported. */
  memorySeeds?: { key: string; value: import("../runtime/types").Json }[];
  /** Test-only local files, relative to inputs/. Never included in production ZIPs. */
  files?: Record<string, string>;
  /** Resolve a particular pending decision first when sibling workflows are waiting. */
  decisionSequence?: { kind: "submit" | "accept" | "reject" | "approve" | "deny"; nodeId: string; values?: Record<string, import("../runtime/types").Json> }[];
  outputs?: Record<string, Record<string, import("../runtime/types").Json>>;
  review?: "accept" | "reject";
  /** Test-only edited input, keyed by review node ID; never exported in packages. */
  reviewEdits?: Record<string, Record<string, import("../runtime/types").Json>>;
  /** Test-only supplemental values; the real CLI must persist a wait before submission. */
  inputSubmissions?: { nodeId: string; values: Record<string, import("../runtime/types").Json>; invalidValues?: Record<string, import("../runtime/types").Json>[]; repeat?: boolean }[];
  /** Counts across the run tree detect replayed work after a checkpoint is resumed. */
  completedCounts?: Record<string, number>;
  status: import("../runtime/types").RunStatus;
  contains?: string[];
  excludes?: string[];
  visited?: string[];
  skipped?: string[];
};
export type WorkflowDesign = {
  id: string;
  title: string;
  category: string;
  description: string;
  behavior: string;
  definition: Definition;
  resources: Resource[];
  inputExample: string;
  expectedOutput: string;
  acceptance: string[];
  failureCases: string[];
  scenarios: WorkflowScenario[];
};
