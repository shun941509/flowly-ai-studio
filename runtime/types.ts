// 설계·실행 기록·어댑터 사이의 공통 TypeScript 계약. Python 실행기에도 대응 스키마가 있으므로 기본값과 상태 의미를 함께 검토한다.
import type { Definition, Identity, Resource, Workflow } from "../app/lib/model";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type DataSchema = { type: "string" | "number" | "boolean" | "object" | "array"; properties?: Record<string, DataSchema>; required?: string[]; items?: DataSchema; additionalProperties?: boolean };
export type InputBinding = { nodeId: string; path: string };
export type PredicateConfig = { path: string; operator: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains"; value?: null | boolean | number | string; rightPath?: string };
export type ToolNodeConfig = { arguments: Record<string, Json>; bindings: Record<string, string> };
export type ProgramName = "numeric_summary" | "schema_check" | "schema_patch" | "evidence_check" | "goal_check" | "rank_fusion" | "python_tool" | "completion";
export type ProgramConfig = ToolNodeConfig & { name: ProgramName };
export type TransformConfig = { mode: "pick" | "template" | "parse_json"; fields?: Record<string, string>; template?: string };
export type MergeConfig = { mode: "object" | "array" | "text"; separator?: string; deduplicate?: boolean };
export type RetrievalConfig = { resourceIds: string[]; topK: number; chunkSize: number; mode?: "lexical" | "vector" | "web"; indexKey?: string };
// 하위 설계는 부모 노드 안에 보관한다. dependsOn은 같은 작업 집합의 선행 작업 ID이며 순환을 허용하지 않는다.
export type CompositeTask = { id: string; name: string; definition: Definition; dependsOn?: string[] };
export type ParallelConfig = { tasks: CompositeTask[]; concurrency: number; completion?: { mode: "first_match"; checks: PredicateConfig[] } };
export type TeamConfig = Omit<ParallelConfig, "completion"> & { mode: "sequential" | "parallel" };
export type DynamicAgentSpec = { id: string; templateId: string; role: string; goal: string; input: Record<string, Json>; dependsOn: string[] };
export type DynamicAgentConfig = { maxAgents: number; concurrency: number; templates: { taskId: string; agentNodeId: string; inputSchema: DataSchema }[] };
export type OrchestrationConfig = { tasks: CompositeTask[]; maxTasks: number; mode?: "plan" | "adaptive" | "dynamic"; dynamic?: DynamicAgentConfig; maxRounds?: number; completion?: PredicateConfig[] };
// Keep omitted fields valid in existing documents; both exported runners use this default.
export const DEFAULT_ORCHESTRATION_MAX_ROUNDS = 3;
export type SubworkflowConfig = { definition: Definition };
export type LoopConfig = SubworkflowConfig & { itemsPath: string; maxItems: number; concurrency: number };
export type ReviewConfig = { instructions: string; allowEdit: boolean; timeoutMinutes: number };
export type ClassificationConfig = { labels: { id: string; name: string; description: string }[] };
export type FormConfig = { mode?: "initial" | "request"; instructions?: string; timeoutMinutes?: number; fields: { key: string; label: string; type: "text" | "number" | "boolean" | "date" | "select" | "file"; required: boolean; options?: string[] }[] };
export type MemoryConfig = { action: "read" | "write" | "delete"; key: string; valuePath?: string; defaultValue?: Json; backend?: "local" | "mcp"; ttlSeconds?: number; scope?: "workflow" | "run"; expectedRevisionPath?: string };
export type ErrorConfig = { template: string };
export type FileInputConfig = { path: string; maxBytes: number };
export type DocumentExtractConfig = { mode: "text" | "table" | "ocr"; filePath: string; maxPages: number; language: string };
export type GuardrailConfig = { action: "mask" | "remove" | "block"; categories: ("email" | "phone" | "resident_id" | "card" | "secret")[] };
export type EvaluationConfig = { mode: "rules" | "model"; rules: { kind: "contains" | "not_contains" | "not_blank" | "min_length" | "max_length" | "json"; value: string }[]; rubric: string; threshold: number };
export type FileOutputConfig = { format: "csv" | "xlsx" | "pdf" | "docx"; filename: string; dataPath: string };
export type TriggerConfig = { kind: "schedule" | "webhook" | "event"; intervalSeconds: number; startAt: string; eventType: string };
export type CompensationConfig = ToolNodeConfig & { sourceNodeId: string };
export type ExtendedNodeConfig = { fileInput?: FileInputConfig; documentExtract?: DocumentExtractConfig; guardrail?: GuardrailConfig; evaluation?: EvaluationConfig; fileOutput?: FileOutputConfig; trigger?: TriggerConfig; compensation?: CompensationConfig; delivery?: { stream: boolean } };
export type AdvancedNodeConfig = { parallel?: ParallelConfig; team?: TeamConfig; orchestration?: OrchestrationConfig; subworkflow?: SubworkflowConfig; loop?: LoopConfig; review?: ReviewConfig; classification?: ClassificationConfig; form?: FormConfig; memory?: MemoryConfig; error?: ErrorConfig; onError?: "stop" | "branch" };
// 전체 실행과 개별 노드가 공유하는 예산 단위. maxDurationMs는 사람의 승인 대기 시간이 아닌 활동 시간을 제한한다.
export type Limits = { maxTurns: number; maxToolCalls: number; maxTokens: number; maxDurationMs: number };
export const DEFAULT_LIMITS: Limits = {maxTurns:8,maxToolCalls:12,maxTokens:8000,maxDurationMs:120000};
export type ToolSelection = { resourceId: string; connectionId: string; toolName: string };
// effect와 supportsIdempotency는 사전에 고정한 정책이다. 외부 도구 응답의 주석으로 승인 정책을 낮추지 않는다.
export type ToolDefinition = ToolSelection & { name: string; description: string; inputSchema: DataSchema; outputSchema?: DataSchema; outputTarget?: "structuredContent" | "result"; effect: "read" | "write"; supportsIdempotency?: boolean; implementation?: "python" | "skill"; pythonToolId?: string; skillExecutionId?: string; skillResourceVersion?: string };
export type Message = { role: "user" | "assistant" | "tool"; content: string; toolName?: string; callId?: string; args?: Record<string, Json> };
export type ModelReply = ({ kind: "answer"; text: string } | { kind: "tool"; toolName: string; args: Record<string, Json>; callId: string }) & { usageTokens: number };
export interface ModelAdapter {
  readonly embeddingModel?: string;
  next(input: { messages: Message[]; tools: ToolDefinition[]; maxTokens: number; signal: AbortSignal; onDelta?: (text: string) => void | Promise<void> }): Promise<ModelReply>;
  embed?(input: { texts: string[]; maxTokens: number; signal: AbortSignal }): Promise<{ vectors: number[][]; usageTokens: number; model: string }>;
  search?(input: { query: string; maxTokens: number; signal: AbortSignal; onDelta?: (text: string) => void | Promise<void> }): Promise<{ text: string; sources: { url: string; title: string }[]; usageTokens: number }>;
}
export type RunStatus = "queued" | "running" | "waiting_approval" | "waiting_review" | "waiting_input" | "succeeded" | "failed" | "cancelled" | "expired" | "budget_exceeded" | "unknown_outcome";
export type RunEvent = { sequence: number; at: string; type: string; nodeId?: string; message: string; data?: Json };
export type ToolCall = { id: string; nodeId: string; tool: ToolDefinition; args: Record<string, Json>; argsHash: string; status: "planned" | "dispatching" | "completed" | "failed" | "denied" | "unknown_outcome"; result?: Json; attempts: number };
// 승인은 실행·사용자·도구 호출·인자 해시·만료에 결합된다. 동일 노드에 대한 포괄적인 쓰기 권한이 아니다.
export type Approval = { id: string; runId: string; userId: string; callId: string; toolName: string; argsHash: string; expiresAt: string; status: "pending" | "approved" | "denied"; decidedAt?: string };
export type Review = { id: string; runId: string; nodeId: string; userId: string; inputHash: string; input: Record<string, Json>; expiresAt: string; status: "pending" | "accepted" | "rejected"; output?: Record<string, Json>; decidedAt?: string };
export type InputRequest = { id: string; runId: string; nodeId: string; userId: string; inputHash: string; configHash: string; input: Record<string, Json>; expiresAt: string; status: "pending" | "submitted"; output?: Record<string, Json>; submittedAt?: string };
export type TaskContract = { taskId: string; definitionHash: string; inputHash: string; dependsOn: string[]; childRunId: string; status: RunStatus };
export type ChildGroup = { winnerIndex?: number; cancelledTaskIds?: string[]; dynamicPlan?: { configHash: string; inputHash: string; planHash: string; agents: DynamicAgentSpec[] }; contracts?: TaskContract[]; completionChecks?: { path: string; passed: boolean }[]; children: RuntimeRun[]; taskIds: string[]; plan?: string[]; rounds?: { plan: string[]; start: number; end: number }[]; planningDone?: boolean; accounted?: { turns: number; toolCalls: number; tokens: number } };
// 완료/건너뜀 노드, 실제 출력, 선택 분기, 자식 실행과 누적 사용량을 저장한다. 재개할 때 완료된 외부 부작용을 반복하지 않는 근거다.
export type Checkpoint = { completed: string[]; skipped: string[]; outputs: Record<string, Record<string, Json>>; branches: Record<string, boolean>; routes?: Record<string, string>; groups?: Record<string, ChildGroup>; activeNodeId?: string; messages: Message[]; calls: ToolCall[]; turns: number; toolCalls: number; tokens: number; activeMs: number; nodeUsage?: Record<string,{turns:number;toolCalls:number;tokens:number;activeMs:number}> };
export type RuntimeRun = { skillRuntimeFingerprint?: string; pythonToolsFingerprint?: string; searchStates?: Record<string, Json>; connectionTargets?: Record<string, string>; id: string; owner: Identity; mode: "test" | "live"; status: RunStatus; workflow: Workflow; resources: Resource[]; provider?: { model?: string; embeddingModel?: string }; restoredReadOnly?: boolean; input: string; initialInput?: Record<string, Json>; result: string; error?: string; errorRecoverable?: boolean; createdAt: string; updatedAt: string; limits: Limits; checkpoint: Checkpoint; approvals: Approval[]; reviews?: Review[]; inputRequests?: InputRequest[]; events: RunEvent[] };
export type PublicRun = Pick<RuntimeRun, "id" | "mode" | "status" | "input" | "result" | "error" | "createdAt" | "updatedAt" | "limits" | "events" | "provider" | "restoredReadOnly"> & { workflowId: string; workflowName: string; approvals: (Approval & { nodeId?: string; args: Record<string, Json>; effect: "read" | "write" })[]; reviews?: Review[]; inputRequests?: (InputRequest & { instructions: string; fields: FormConfig["fields"] })[]; children?: { nodeId: string; taskId: string; run: PublicRun }[]; usage: Pick<Checkpoint, "turns" | "toolCalls" | "tokens" | "activeMs"> };
// 엔진은 저장·현재 권한·취소·모델·도구 구현을 주입받는다. 웹의 설계 미리보기와 실제 실행 어댑터를 이 경계에서 구분한다.
export interface RuntimeDependencies {
  model: ModelAdapter;
  tools: ToolDefinition[];
  save(run: RuntimeRun): Promise<void>;
  assertAccess(resourceIds: string[], tool?: ToolDefinition): Promise<void>;
  isCancelled(): Promise<boolean>;
  memory?(operation: { ownerId: string; workflowId: string; operationId: string; action: "read" | "write" | "delete"; key: string; value?: Json; defaultValue?: Json; ttlSeconds?: number; expectedRevision?: number; trackOperation?: boolean }): Promise<{ data: Json; found: boolean; expiresAt?: string }>;
  files?(request: { operation: "input" | "extract" | "output" | "check"; runId: string; nodeId: string; config: Record<string, Json>; input: Record<string, Json>; signal: AbortSignal }): Promise<Record<string, Json>>;
  pythonTool?(request: { toolId: string; arguments: Record<string, Json>; signal: AbortSignal }): Promise<Json>;
  skill?(request: { resourceId: string; entryId: string; arguments: Record<string, Json>; signal: AbortSignal }): Promise<Json>;
  completion?(request: { operation: string; arguments: Record<string, Json>; signal: AbortSignal }): Promise<Json>;
  vectorCache?(key: string, value?: Json): Promise<Json | undefined>;
  onDelta?(event: { runId: string; nodeId: string; text: string }): void | Promise<void>;
  callTool(tool: ToolDefinition, args: Record<string, Json>, options: { signal: AbortSignal; deadlineAt?: number; idempotencyKey: string }): Promise<Json>;
}
export type RuntimeCapabilities = { testEnabled: boolean; liveEnabled: boolean; liveReason: string; connections: { id: string; resourceId: string; name: string; status: "configured" | "unconfigured"; tools: ToolDefinition[] }[] };
