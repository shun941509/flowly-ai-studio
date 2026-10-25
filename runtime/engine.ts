import { isStartNode } from "../domain/advanced-config";
import { evaluatePredicate } from "../domain/predicate";
import { uid, validateGraph, type Identity, type Resource, type Workflow, type FlowNode } from "../app/lib/model";
import { assertSchema, compileDefinition, edgeIsActive, referencedResourceIds, resolveNodeInput } from "../domain/workflow";
import type { CompositeTask, DataSchema, Json, Limits, PublicRun, RuntimeDependencies, RuntimeRun, ToolCall, ToolDefinition } from "./types";
import { executeProgram } from "./programs";
import { completionArguments } from "./completion-programs";
import { assertPythonArguments, assertPythonToolSelected, pythonProgramArguments, pythonToolDefinition } from "./python-tools";
import { executeKnowledge } from "./knowledge";
import { runCandidateSearch, type SearchState } from "./candidate-search";
import { dynamicChildInput, instantiateDynamicTasks, parseDynamicPlan } from "./dynamic-agents";
import { DEFAULT_ORCHESTRATION_MAX_ROUNDS } from "./types";
import { argsHash, canonicalJson, normalizeLimits, redactJson, redactText, RuntimeFault } from "./policy";
import { cosine, documentChunks, guardrailData, mergeData, retrieveDocuments, ruleEvaluation, toolArguments, transformData } from "./data-nodes";
import { dataAt } from "./data-nodes";
import { errorOutput, finalOutput, formInput, NodeProcessingFault, PauseChild, pendingReviews, pendingInputs, runTree } from "./advanced";
export { decideReview, submitInput } from "./advanced";

class PersistenceFault extends Error { constructor(readonly cause: unknown) { super("실행 기록을 저장하지 못했어요."); } }
const terminal = new Set(["succeeded", "failed", "cancelled", "expired", "budget_exceeded", "unknown_outcome"]);
const now = () => new Date().toISOString();
function event(run: RuntimeRun, type: string, message: string, nodeId?: string, data?: Json) {
  run.events.push({ sequence: (run.events.at(-1)?.sequence ?? 0) + 1, at: now(), type, message, ...(nodeId ? { nodeId } : {}), ...(data === undefined ? {} : { data: redactJson(data) }) });
}
function validateValue(value: unknown, schema: DataSchema, label: string) {
  try { assertSchema(value, schema, label); }
  catch (error) { throw new NodeProcessingFault(error instanceof Error ? redactText(error.message) : `${label} 형식을 확인해 주세요.`); }
}
function validateToolArguments(args: Record<string, Json>, tool: ToolDefinition) {
  if (tool.implementation !== "python") return validateValue(args, tool.inputSchema, "도구 입력");
  try { assertPythonArguments(args, tool.inputSchema as unknown as Record<string, Json>); }
  catch (error) { throw new NodeProcessingFault(error instanceof Error ? error.message : "Python 도구 입력을 확인해 주세요."); }
}
export function createRun(input: { id?: string; owner: Identity; mode: "test" | "live"; workflow: Workflow; resources: Resource[]; input: string; initialInput?: Record<string, Json>; limits?: Partial<Limits> }): RuntimeRun {
  if (typeof input.input !== "string" || input.input.length > 20000) throw new RuntimeFault("failed", "실행 입력은 20,000자까지 사용할 수 있어요.");
  const workflow = structuredClone(input.workflow);
  workflow.definition = compileDefinition(workflow.definition);
  const errors = validateGraph(workflow.definition, input.resources);
  if (errors.length) throw new RuntimeFault("failed", errors[0]);
  const ids = referencedResourceIds(workflow.definition);
  const resources = structuredClone(input.resources.filter(r => ids.includes(r.id))).map(r => ({ ...r, allowedEmails: [] }));
  if (ids.some(id => !resources.some(r => r.id === id))) throw new RuntimeFault("failed", "사용할 수 없는 자료가 있어요. 자료 공유 상태를 확인해 주세요.");
  if (input.initialInput) canonicalJson(input.initialInput);
  const run: RuntimeRun = { id: input.id ?? uid("run"), owner: { ...input.owner }, mode: input.mode, status: "queued", workflow, resources, input: input.input, ...(input.initialInput ? { initialInput: structuredClone(input.initialInput) } : {}), result: "", createdAt: now(), updatedAt: now(), limits: normalizeLimits(input.limits), checkpoint: { completed: [], skipped: [], outputs: {}, branches: {}, routes: {}, groups: {}, messages: [], calls: [], turns: 0, toolCalls: 0, tokens: 0, activeMs: 0, nodeUsage: {} }, approvals: [], reviews: [], inputRequests: [], events: [] };
  event(run, "queued", input.mode === "test" ? "테스트 실행을 준비했어요. 외부 AI와 서비스는 호출하지 않아요." : "실제 실행을 준비했어요.");
  return run;
}
export async function decideApproval(run: RuntimeRun, approvalId: string, userId: string, decision: "approved" | "denied"): Promise<RuntimeRun> {
  if (run.owner.userId !== userId) throw new RuntimeFault("failed", "이 승인을 처리할 권한이 없어요.");
  if (run.restoredReadOnly) throw new RuntimeFault("failed", "복원한 외부 변경 실행은 조회만 가능해요. 서비스의 실제 결과를 확인한 뒤 새 실행을 시작해 주세요.");
  if (decision !== "approved" && decision !== "denied") throw new RuntimeFault("failed", "승인 또는 거절을 선택해 주세요.");
  const existingRun = runTree(run).find(current => current.approvals.some(approval => approval.id === approvalId));
  const existing = existingRun?.approvals.find(approval => approval.id === approvalId);
  if (existing && existingRun?.owner.userId === userId && existing.userId === userId && existing.runId === existingRun.id && existing.status === decision) return run;
  if (terminal.has(run.status)) throw new RuntimeFault("failed", "종료된 실행에서는 새 승인을 처리할 수 없어요.");
  const child = runTree(run).slice(1).find(current => current.approvals.some(approval => approval.id === approvalId));
  if (child) { await decideApproval(child, approvalId, userId, decision); run.status = child.status === "expired" ? "expired" : "queued"; run.updatedAt = now(); return run; }
  const approval = run.approvals.find(a => a.id === approvalId);
  if (run.owner.userId !== userId || !approval || approval.userId !== userId || approval.runId !== run.id) throw new RuntimeFault("failed", "이 승인을 처리할 권한이 없어요.");
  if (decision !== "approved" && decision !== "denied") throw new RuntimeFault("failed", "승인 또는 거절을 선택해 주세요.");
  if (approval.status !== "pending") {
    if (approval.status === decision) return run;
    throw new RuntimeFault("failed", "이미 처리한 승인 요청이에요.");
  }
  if (run.status !== "waiting_approval") throw new RuntimeFault("failed", "승인 대기 중인 실행이 아니에요.");
  const call = run.checkpoint.calls.find(c => c.id === approval.callId);
  if (!call || call.tool.effect !== "write" || approval.toolName !== call.tool.name || approval.argsHash !== call.argsHash || await argsHash(call.args) !== approval.argsHash) throw new RuntimeFault("failed", "승인 대상이나 인자가 바뀌었어요. 새 실행에서 다시 승인해 주세요.");
  if (Date.parse(approval.expiresAt) <= Date.now()) {
    run.status = "expired"; run.error = "승인 기한이 지났어요. 새 실행을 시작해 주세요.";
    event(run, "expired", run.error); run.updatedAt = now(); return run;
  }
  approval.status = decision; approval.decidedAt = now(); run.status = "queued"; run.updatedAt = now();
  event(run, decision === "approved" ? "approval_granted" : "approval_denied", decision === "approved" ? "변경 작업을 승인했어요. 현재 권한을 다시 확인한 뒤 재개해요." : "변경 작업을 거절했어요. 거절 결과를 AI에게 전달해요.", call.nodeId);
  return run;
}
export function publicRun(run: RuntimeRun): PublicRun {
  const { id, mode, status, input, result, error, createdAt, updatedAt, limits, events } = run;
  const { turns, toolCalls, tokens, activeMs } = run.checkpoint;
  return { id, mode, status, ...(run.restoredReadOnly ? { restoredReadOnly: true } : {}), ...(run.provider ? { provider: redactJson(run.provider) as RuntimeRun["provider"] } : {}), input: redactText(input), result: redactText(result), ...(error ? { error: redactText(error) } : {}), createdAt, updatedAt, limits, events: structuredClone(events), workflowId: run.workflow.id, workflowName: run.workflow.name, approvals: runTree(run).flatMap(current => current.approvals.map(a => { const call = current.checkpoint.calls.find(c => c.id === a.callId); return { ...a, nodeId: call?.nodeId, args: redactJson(call?.args ?? {}) as Record<string, Json>, effect: call?.tool.effect ?? "write" }; })), reviews: redactJson(pendingReviews(run) as unknown as Json) as unknown as NonNullable<PublicRun["reviews"]>, inputRequests: redactJson(pendingInputs(run) as unknown as Json) as unknown as NonNullable<PublicRun["inputRequests"]>, children: Object.entries(run.checkpoint.groups ?? {}).flatMap(([nodeId, group]) => group.children.map((child, index) => ({ nodeId, taskId: group.taskIds[index], run: publicRun(child) }))), usage: { turns, toolCalls, tokens, activeMs } };
}

/** Single-writer engine. save() MUST provide a durable lease/CAS boundary; any save failure stops work. */
type EngineDependencies = RuntimeDependencies & { cancellationSignal?: AbortSignal; shouldPause?: () => boolean; remainingDuration?: () => number; rootRun?: RuntimeRun; writeLocks?: Map<string, Promise<void>>; writeBoundary?: { failed: boolean } };
export async function executeRun(run: RuntimeRun, deps: EngineDependencies): Promise<RuntimeRun> {
  if (run.restoredReadOnly) throw new RuntimeFault("failed", "복원한 외부 변경 실행은 조회만 가능해요. 서비스의 실제 결과를 확인한 뒤 새 실행을 시작해 주세요.");
  if (terminal.has(run.status)) return run;
  const checkpoint = run.checkpoint;
  const rootRun = deps.rootRun ?? run;
  const writeLocks = deps.writeLocks ?? new Map<string, Promise<void>>();
  const writeBoundary = deps.writeBoundary ?? { failed: false };
  checkpoint.nodeUsage ??= {};
  checkpoint.routes ??= {}; checkpoint.groups ??= {}; run.reviews ??= []; run.inputRequests ??= [];
  // After an interrupted active worker, charge the unrecorded interval conservatively.
  // Human approval waiting time is deliberately excluded from the active execution budget.
  if (run.status === "running") {
    const unrecorded = Math.max(0, Date.now() - Date.parse(run.updatedAt));
    if (Number.isFinite(unrecorded)) {
      checkpoint.activeMs += unrecorded;
      if (checkpoint.activeNodeId && checkpoint.nodeUsage[checkpoint.activeNodeId]) checkpoint.nodeUsage[checkpoint.activeNodeId].activeMs += unrecorded;
    }
  }
  let clockAt = Date.now();
  const tick = () => { const elapsed = Math.max(0, Date.now() - clockAt); clockAt = Date.now(); checkpoint.activeMs += elapsed; const id = checkpoint.activeNodeId; if (id && checkpoint.nodeUsage?.[id]) checkpoint.nodeUsage[id].activeMs += elapsed; };
  const persist = async () => { tick(); run.updatedAt = now(); try { await deps.save(run); } catch (cause) { throw new PersistenceFault(cause); } };
  const ids = referencedResourceIds(run.workflow.definition);
  const stream = run.workflow.definition.nodes.some(node => node.type === "output" && node.delivery?.stream);
  const deltaFor = (node: FlowNode) => stream ? async (text: string) => { await guard(node); const safe = redactText(text); event(run, "model_delta", "부분 답변을 받았어요. 완료 전에는 최종 결과가 아니에요.", node.id, { text: safe, partial: true }); await persist(); await deps.onDelta?.({ runId: run.id, nodeId: node.id, text: safe }); } : undefined;
  function usage(node: FlowNode) { return checkpoint.nodeUsage![node.id] ??= { turns: 0, toolCalls: 0, tokens: 0, activeMs: 0 }; }
  function nodeLimits(node?: FlowNode) {
    if (!node) return run.limits;
    const limits = { ...run.limits };
    for (const key of Object.keys(limits) as (keyof Limits)[]) limits[key] = Math.min(node.limits?.[key] ?? run.limits[key], run.limits[key]);
    return limits; // Internal child allocations may be zero; public configuration remains positive.
  }
  async function guard(node?: FlowNode, tool?: ToolDefinition) {
    tick();
    if (await deps.isCancelled()) throw new RuntimeFault("cancelled", "실행을 취소했어요. 이미 완료된 외부 변경은 되돌리지 않아요.");
    if (deps.shouldPause?.()) throw new PauseChild();
    if (checkpoint.activeMs >= run.limits.maxDurationMs || (node && usage(node).activeMs >= nodeLimits(node).maxDurationMs) || (deps.remainingDuration?.() ?? Infinity) <= 0) throw new RuntimeFault("budget_exceeded", "실행 시간 한도에 도달했어요. 한도 또는 작업 범위를 조정해 주세요.");
    if (checkpoint.turns > run.limits.maxTurns || checkpoint.toolCalls > run.limits.maxToolCalls || checkpoint.tokens > run.limits.maxTokens || node && (usage(node).turns > nodeLimits(node).maxTurns || usage(node).toolCalls > nodeLimits(node).maxToolCalls || usage(node).tokens > nodeLimits(node).maxTokens)) throw new RuntimeFault("budget_exceeded", "실행의 전체 또는 블록 한도를 넘었어요. 추가 외부 호출을 중지했어요.");
    if (tool?.implementation === "python") {
      if (!node) throw new RuntimeFault("failed", "Python 도구의 실행 블록을 확인할 수 없어요.");
      assertPythonToolSelected(node, tool);
      if (!deps.pythonTool) throw new RuntimeFault("failed", "Python 도구 미설정: 실행 프로젝트를 내보내고 Python 도우미를 설정해 주세요. 웹에서는 실행하지 않아요.");
    }
    try { await deps.assertAccess(ids, tool?.implementation === "python" ? undefined : tool); } catch (error) { if (error instanceof PauseChild || error instanceof PersistenceFault || error instanceof RuntimeFault && error.code !== "failed") throw error; throw new RuntimeFault("failed", "자료 또는 연결을 사용할 권한이 없어요. 공유와 연결 상태를 확인해 주세요."); }
  }
  async function bounded<T>(node: FlowNode, operation: (signal: AbortSignal, deadlineAt: number) => Promise<T>, approvalExpiresAt?: number): Promise<T> {
    tick();
    const executionRemaining = Math.min(run.limits.maxDurationMs - checkpoint.activeMs, nodeLimits(node).maxDurationMs - usage(node).activeMs, deps.remainingDuration?.() ?? Infinity);
    const approvalRemaining = approvalExpiresAt === undefined ? Infinity : approvalExpiresAt - Date.now();
    const deadlineAt = Math.min(Date.now() + executionRemaining, approvalExpiresAt ?? Infinity);
    const remaining = deadlineAt - Date.now();
    const timeoutFault = () => approvalRemaining <= executionRemaining ? new RuntimeFault("expired", "승인 기한이 지났어요. 추가 변경 요청을 중단했어요.") : new RuntimeFault("budget_exceeded", "실행 시간 한도에 도달했어요.");
    if (remaining <= 0 || !Number.isFinite(remaining)) throw timeoutFault();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = () => new RuntimeFault("cancelled", "실행을 취소했어요. 이미 완료된 외부 변경은 되돌리지 않아요.");
    if (deps.cancellationSignal?.aborted) throw cancelled();
    let abort: (() => void) | undefined;
    try {
      const stopped = new Promise<never>((_, reject) => {
        abort = () => { reject(cancelled()); controller.abort(); };
        deps.cancellationSignal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => { reject(timeoutFault()); controller.abort(); }, remaining);
      });
      return await Promise.race([stopped, operation(controller.signal, deadlineAt)]);
    } finally { if (timer) clearTimeout(timer); if (abort) deps.cancellationSignal?.removeEventListener("abort", abort); tick(); }
  }
  const observe = (call: ToolCall, result: Json) => {
    if (!checkpoint.messages.some(m => m.role === "tool" && m.callId === call.id)) checkpoint.messages.push({ role: "tool", toolName: call.tool.name, callId: call.id, content: canonicalJson(result) });
  };
  async function dispatch(node: FlowNode, call: ToolCall) {
    if (call.status === "completed" || call.status === "denied" || call.status === "failed") return dispatchInner(node, call);
    if (call.tool.effect !== "write") return dispatchInner(node, call);
    const key = canonicalJson([call.tool.resourceId, call.tool.connectionId, call.tool.toolName, call.argsHash]);
    const previous = writeLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const current = previous.then(() => gate); writeLocks.set(key, current);
    await previous;
    try {
      if (writeBoundary.failed) throw new RuntimeFault("unknown_outcome", "이 실행의 외부 변경 기록을 저장하지 못했어요. 결과를 확인하기 전에는 추가 변경을 하지 않아요.");
      await guard(node, call.tool);
      if (await argsHash(call.args) !== call.argsHash) throw new RuntimeFault("failed", "저장된 도구 인자가 변경되어 실행을 중지했어요.");
      const matches = runTree(rootRun).flatMap(current => current.checkpoint.calls.map(other => ({ current, other }))).filter(({ other }) => other.id !== call.id && other.tool.resourceId === call.tool.resourceId && other.tool.connectionId === call.tool.connectionId && other.tool.toolName === call.tool.toolName && other.argsHash === call.argsHash);
      const denied = matches.find(({ current, other }) => other.status === "denied" || current.approvals.some(approval => approval.status === "denied" && approval.callId === other.id && approval.argsHash === other.argsHash && approval.runId === current.id && approval.userId === rootRun.owner.userId && approval.toolName === other.tool.name));
      const duplicate = matches.find(({ other }) => other.status === "unknown_outcome" || other.status === "dispatching")?.other ?? denied?.other ?? matches.find(({ other }) => other.status === "completed")?.other;
      if (duplicate && (duplicate.status === "dispatching" || duplicate.status === "unknown_outcome")) throw new RuntimeFault("unknown_outcome", "같은 외부 변경의 결과가 불명확해요. 서비스에서 확인하기 전에는 다시 실행하지 않아요.");
      if (denied) { call.status = "denied"; call.result = { error: "다른 하위 작업에서 같은 외부 변경을 거절했어요. 변경을 호출하지 않았어요." }; observe(call, call.result); event(run, "tool_duplicate_blocked", "같은 입력의 변경 작업이 이미 거절되어 추가 호출을 막았어요.", node.id); await persist(); return; }
      const approval = run.approvals.find(approval => approval.callId === call.id);
      if (node.type === "compensate" && !approval) return await dispatchInner(node, call);
      if (duplicate && !(approval && approval.status === "pending") && !(approval && approval.status === "denied")) {
        if (approval && (approval.userId !== run.owner.userId || approval.runId !== run.id || approval.argsHash !== call.argsHash || approval.toolName !== call.tool.name || Date.parse(approval.expiresAt) <= Date.now())) throw new RuntimeFault("expired", "승인 대상 또는 기한을 확인해 주세요. 추가 변경을 중지했어요.");
        call.status = duplicate.status === "completed" ? "completed" : "denied"; call.result = structuredClone(duplicate.result ?? { error: "이미 거절한 외부 변경이에요." });
        observe(call, call.result); event(run, "tool_duplicate_blocked", "다른 하위 작업에서 이미 처리한 변경 결과를 재사용했어요. 외부 변경을 다시 호출하지 않았어요.", node.id); await persist(); return;
      }
      return await dispatchInner(node, call);
    } catch (error) { if (error instanceof PersistenceFault) { writeBoundary.failed = true; if (call.attempts > 0) call.status = "unknown_outcome"; } throw error; }
    finally { release(); if (writeLocks.get(key) === current) writeLocks.delete(key); }
  }
  async function dispatchInner(node: FlowNode, call: ToolCall) {
    if (call.status === "completed" || call.status === "denied" || call.status === "failed") { observe(call, call.result ?? { error: "도구 실행이 완료되지 않았어요." }); return; }
    if (call.status === "unknown_outcome" || (call.status === "dispatching" && call.tool.effect === "write")) {
      call.status = "unknown_outcome";
      throw new RuntimeFault("unknown_outcome", "외부 변경 결과를 확인할 수 없어요. 서비스에서 결과를 확인한 뒤 새 작업을 시작해 주세요. 자동 재실행하지 않아요.");
    }
    const current = call.tool.implementation === "python" ? pythonToolDefinition(call.tool.pythonToolId ?? "") : deps.tools.find(t => t.resourceId === call.tool.resourceId && t.connectionId === call.tool.connectionId && t.toolName === call.tool.toolName && t.name === call.tool.name);
    if (!current || canonicalJson(current) !== canonicalJson(call.tool)) throw new RuntimeFault("failed", "연결된 도구의 설정이 바뀌었어요. 새 실행을 시작해 주세요.");
    validateToolArguments(call.args, call.tool);
    if (await argsHash(call.args) !== call.argsHash) throw new RuntimeFault("failed", "저장된 도구 인자가 변경되어 실행을 중지했어요.");
    await guard(node, current);
    let approvalExpiresAt: number | undefined;
    if (call.tool.effect === "write") {
      const approval = run.approvals.find(a => a.callId === call.id && a.runId === run.id && a.userId === run.owner.userId && a.toolName === call.tool.name && a.argsHash === call.argsHash);
      if (!approval) {
        run.approvals.push({ id: uid("approval"), runId: run.id, userId: run.owner.userId, callId: call.id, toolName: call.tool.name, argsHash: call.argsHash, expiresAt: new Date(Date.now() + 30 * 60000).toISOString(), status: "pending" });
        run.status = "waiting_approval"; event(run, "waiting_approval", "외부 변경 전에 승인이 필요해요. 도구와 입력 내용을 확인해 주세요.", node.id, { tool: call.tool.name, args: call.args }); await persist(); return;
      }
      if (approval.status === "denied") { call.status = "denied"; call.result = { error: "사용자가 이 변경 작업을 거절했어요. 같은 작업을 다시 요청하지 마세요." }; observe(call, call.result); await persist(); return; }
      if (Date.parse(approval.expiresAt) <= Date.now()) throw new RuntimeFault("expired", "승인 기한이 지났어요. 새 실행을 시작해 주세요.");
      if (approval.status !== "approved") { run.status = "waiting_approval"; await persist(); return; }
      approvalExpiresAt = Date.parse(approval.expiresAt);
    }
    const limit = nodeLimits(node);
    while (call.attempts < (call.tool.effect === "read" ? 2 : 1)) {
      await guard(node, current);
      if (checkpoint.toolCalls >= run.limits.maxToolCalls || usage(node).toolCalls >= limit.maxToolCalls) throw new RuntimeFault("budget_exceeded", "도구 호출 한도에 도달했어요. 추가 도구는 호출하지 않았어요.");
      call.status = "dispatching"; call.attempts++; checkpoint.toolCalls++; usage(node).toolCalls++;
      event(run, "tool_started", "연결된 도구를 사용하고 있어요.", node.id, { tool: call.tool.name, args: call.args, attempt: call.attempts });
      await persist(); // Durable intent before any external effect.
      // This check has no external effect; revoked permission must stay a clear failure.
      await guard(node, current);
      let result: Json;
      try {
        result = await bounded(node, (signal, deadlineAt) => current.implementation === "python" ? deps.pythonTool!({ toolId: current.pythonToolId!, arguments: structuredClone(call.args), signal }) : deps.callTool(current, structuredClone(call.args), { signal, deadlineAt, idempotencyKey: `${run.id}:${call.id}:${call.argsHash}` }), approvalExpiresAt);
        canonicalJson(result);
      } catch (error) {
        if (call.tool.implementation === "python" && error instanceof RuntimeFault) {
          call.status = "failed"; call.result = { error: error.message }; observe(call, call.result);
          event(run, "tool_failed", error.message, node.id); await persist(); throw error;
        }
        if (call.tool.effect === "write") { call.status = "unknown_outcome"; throw new RuntimeFault("unknown_outcome", "외부 변경 결과를 확인할 수 없어요. 서비스에서 결과를 확인해 주세요. 자동 재실행하지 않아요."); }
        if (error instanceof RuntimeFault) throw error;
        if (call.attempts < 2) { call.status = "planned"; event(run, "tool_retry", "읽기 연결에 실패했어요. 한 번 더 시도해요.", node.id); await persist(); await bounded(node, signal => new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 100); signal.addEventListener("abort", () => { clearTimeout(timer); reject(new RuntimeFault("budget_exceeded", "실행 시간 한도에 도달했어요.")); }, { once: true }); })); continue; }
        call.status = "failed"; call.result = { error: "읽기 도구 연결에 실패했어요. 연결 설정을 확인해 주세요." }; observe(call, call.result); event(run, "tool_failed", "읽기 도구 연결에 실패했어요.", node.id); await persist(); return;
      }
      call.status = "completed"; call.result = redactJson(result); observe(call, call.result);
      event(run, "tool_completed", "도구 결과를 받았어요.", node.id, { tool: call.tool.name, result: call.result });
      await persist(); return;
    }
    // A crash after the last read attempt must not leave an unresolved tool message.
    call.status = "failed"; call.result = { error: "읽기 도구의 재시도 한도를 사용했어요." }; observe(call, call.result); await persist();
  }
  async function agent(node: FlowNode, input: Record<string, Json>): Promise<Record<string, Json> | undefined> {
    const selected = node.type === "agent" ? node.allowedTools ?? [] : [];
    const tools = selected.map(selection => {
      const found = deps.tools.find(t => t.resourceId === selection.resourceId && t.connectionId === selection.connectionId && t.toolName === selection.toolName);
      if (!found) throw new RuntimeFault("failed", "선택한 도구가 연결되지 않았어요. 연결 설정을 확인해 주세요.");
      return found;
    }).concat(node.type === "agent" ? (node.pythonTools ?? []).map(pythonToolDefinition) : []);
    if (new Set(tools.map(t => t.name)).size !== tools.length) throw new RuntimeFault("failed", "연결된 도구의 이름이 중복돼요. 연결 설정을 확인해 주세요.");
    const hasRequiredToolResult = () => !node.requireToolResult || checkpoint.calls.some(call => call.nodeId === node.id && call.status === "completed" && tools.some(tool => tool.resourceId === call.tool.resourceId && tool.connectionId === call.tool.connectionId && tool.toolName === call.tool.toolName));
    for (const tool of tools) await guard(node, tool);
    if (!checkpoint.messages.length) checkpoint.messages.push({ role: "user", content: canonicalJson({ input, instruction: node.prompt ?? "", outputFormat: node.format ?? "텍스트" }) });
    const limit = nodeLimits(node);
    for (;;) {
      for (const call of checkpoint.calls.filter(c => c.nodeId === node.id)) { await dispatch(node, call); if (run.status === "waiting_approval") return; }
      await guard(node);
      if (checkpoint.turns >= run.limits.maxTurns || usage(node).turns >= limit.maxTurns) throw new RuntimeFault("budget_exceeded", "AI 판단 횟수 한도에 도달했어요. 작업 범위 또는 한도를 조정해 주세요.");
      const remaining = Math.min(run.limits.maxTokens - checkpoint.tokens, limit.maxTokens - usage(node).tokens);
      // UTF-8 bytes + framing is a conservative preflight; reserve the full request before dispatch.
      const estimatedInput = new TextEncoder().encode(JSON.stringify({ messages: checkpoint.messages, tools })).length + 512;
      const outputBudget = Math.min(2048, remaining - estimatedInput);
      if (outputBudget < 16) throw new RuntimeFault("budget_exceeded", "AI 사용량 한도에 도달했어요. 입력을 줄이거나 한도를 조정해 주세요.");
      const reserve = estimatedInput + outputBudget;
      checkpoint.turns++; usage(node).turns++; checkpoint.tokens += reserve; usage(node).tokens += reserve;
      event(run, "model_started", "AI가 다음 행동을 결정하고 있어요.", node.id); await persist();
      for (const tool of tools) await guard(node, tool);
      await guard(node);
      let reply;
      try { reply = await bounded(node, signal => deps.model.next({ messages: structuredClone(checkpoint.messages), tools: structuredClone(tools), maxTokens: outputBudget, signal, ...(stream && hasRequiredToolResult() ? { onDelta: deltaFor(node) } : {}) })); }
      catch (error) { if (error instanceof RuntimeFault) throw error; throw new NodeProcessingFault("AI 연결에 실패했어요. 모델 설정과 연결 상태를 확인해 주세요."); }
      if (!Number.isSafeInteger(reply.usageTokens) || reply.usageTokens < 0) throw new RuntimeFault("failed", "AI 사용량을 확인할 수 없어 실행을 중지했어요.");
      checkpoint.tokens += reply.usageTokens - reserve; usage(node).tokens += reply.usageTokens - reserve;
      await guard(node);
      if (checkpoint.tokens > run.limits.maxTokens || usage(node).tokens > limit.maxTokens) throw new RuntimeFault("budget_exceeded", "AI 사용량 한도에 도달했어요. 추가 동작을 중지했어요.");
      if (reply.kind === "answer") {
        if (typeof reply.text !== "string" || reply.text.length > 100000) throw new NodeProcessingFault("AI 답변 형식이 올바르지 않아요.");
        const text = redactText(reply.text); checkpoint.messages.push({ role: "assistant", content: text });
        if (!hasRequiredToolResult()) {
          checkpoint.messages.push({ role: "user", content: "이 Agent는 허용된 도구의 성공한 결과가 있어야 답변할 수 있습니다. 아직 이 단계에서 완료된 도구 결과가 없습니다. 허용된 도구를 호출하고 그 관찰 결과를 확인하세요. 실패·거절·다른 단계의 결과는 대신 사용할 수 없습니다." });
          event(run, "tool_result_required", "필수 도구 결과가 없어 답변을 확정하지 않았어요. 남은 한도 안에서 도구 확인을 요청해요.", node.id);
          await persist(); continue;
        }
        if (node.format === "JSON") { let parsed: unknown; try { parsed = JSON.parse(text); } catch { throw new NodeProcessingFault("AI 답변이 요청한 JSON 형식과 달라요."); } canonicalJson(parsed); return { text, data: parsed as Json }; }
        return { text };
      }
      if (node.type === "ai") throw new RuntimeFault("failed", "AI 모델 블록에서는 도구를 실행할 수 없어요. 도구가 필요하면 Agent 블록을 사용해 주세요.");
      const tool = tools.find(t => t.name === reply.toolName);
      const callId = uid("call");
      if (!reply.args || Array.isArray(reply.args) || typeof reply.args !== "object") throw new RuntimeFault("failed", "AI가 제안한 도구 입력 형식이 올바르지 않아요.");
      canonicalJson(reply.args);
      checkpoint.messages.push({ role: "assistant", content: "", toolName: reply.toolName, callId, args: reply.args });
      if (!tool) {
        checkpoint.messages.push({ role: "tool", toolName: reply.toolName, callId, content: "이 도구는 허용되지 않았어요. 허용된 도구로 답하거나 종료해 주세요." });
        event(run, "tool_rejected", "AI가 허용되지 않은 도구를 요청했어요. 호출을 차단했어요.", node.id); await persist(); continue;
      }
      validateToolArguments(reply.args, tool);
      const hash = await argsHash(reply.args);
      const repeated = checkpoint.calls.find(c => c.tool.resourceId === tool.resourceId && c.tool.connectionId === tool.connectionId && c.tool.toolName === tool.toolName && c.argsHash === hash && (c.status === "denied" || (tool.effect === "write" && c.status === "completed")));
      if (repeated) {
        checkpoint.messages.push({ role: "tool", toolName: tool.name, callId, content: canonicalJson(repeated.result ?? { error: "같은 변경 작업을 반복할 수 없어요." }) });
        event(run, "tool_duplicate_blocked", "이미 처리한 변경 작업의 중복 호출을 차단했어요.", node.id); await persist(); continue;
      }
      checkpoint.calls.push({ id: callId, nodeId: node.id, tool: structuredClone(tool), args: structuredClone(reply.args), argsHash: hash, status: "planned", attempts: 0 });
      await persist();
    }
  }
  async function directTool(node: FlowNode, input: Record<string, Json>, suppliedArgs?: Record<string, Json>): Promise<Record<string, Json> | undefined> {
    const selection = node.allowedTools?.[0];
    const localProgram = node.type === "program" && node.program?.name === "python_tool";
    const tool = localProgram ? pythonToolDefinition(String(node.program!.arguments.toolId)) : selection && deps.tools.find(t => t.resourceId === selection.resourceId && t.connectionId === selection.connectionId && t.toolName === selection.toolName);
    if (!tool || !localProgram && node.allowedTools?.length !== 1) throw new RuntimeFault("failed", "실행할 도구를 하나 선택하고 연결 설정을 확인해 주세요.");
    await guard(node, tool);
    const args = suppliedArgs ?? toolArguments(node, input);
    validateToolArguments(args, tool);
    const hash = await argsHash(args);
    let call = checkpoint.calls.find(c => c.nodeId === node.id);
    if (call && (call.argsHash !== hash || canonicalJson(call.tool) !== canonicalJson(tool))) throw new RuntimeFault("failed", "저장된 도구 입력 또는 설정이 바뀌었어요.");
    if (!call) {
      const previous = node.type !== "compensate" && tool.effect === "write" && checkpoint.calls.find(c => c.tool.resourceId === tool.resourceId && c.tool.connectionId === tool.connectionId && c.tool.toolName === tool.toolName && c.argsHash === hash && ["completed", "denied"].includes(c.status));
      if (previous) {
        if (previous.status === "denied") throw new RuntimeFault("failed", "같은 변경 작업이 이미 거절되어 실행을 중지했어요.");
        event(run, "tool_duplicate_blocked", "이미 완료한 변경 작업의 결과를 재사용했어요.", node.id);
        const data = previous.result ?? null; return { text: typeof data === "string" ? data : canonicalJson(data), data };
      }
      call = { id: uid("call"), nodeId: node.id, tool: structuredClone(tool), args: structuredClone(args), argsHash: hash, status: "planned", attempts: 0 };
      checkpoint.calls.push(call); await persist();
    }
    await dispatch(node, call);
    if ((run.status as string) === "waiting_approval") return;
    if (call.status !== "completed") { if (call.status === "denied") throw new RuntimeFault("failed", "도구 실행이 거절되어 흐름을 중지했어요."); throw new NodeProcessingFault("도구 실행에 실패했어요. 연결과 입력을 확인해 주세요."); }
    const data = call.result ?? null;
    return { text: typeof data === "string" ? data : canonicalJson(data), data };
  }
  async function auxiliary<T extends { usageTokens: number }>(node: FlowNode, payload: Json, output: boolean, operation: (signal: AbortSignal, maxTokens: number) => Promise<T>): Promise<T> {
    await guard(node); const limits = nodeLimits(node);
    if (checkpoint.turns >= run.limits.maxTurns || usage(node).turns >= limits.maxTurns || checkpoint.toolCalls >= run.limits.maxToolCalls || usage(node).toolCalls >= limits.maxToolCalls) throw new RuntimeFault("budget_exceeded", "검색·임베딩 호출 한도에 도달했어요.");
    const remaining = Math.min(run.limits.maxTokens - checkpoint.tokens, limits.maxTokens - usage(node).tokens);
    const estimated = new TextEncoder().encode(canonicalJson(payload)).length + 512;
    const maxTokens = output ? Math.min(2048, remaining - estimated) : 0;
    const reserve = estimated + maxTokens;
    if (reserve > remaining || (output && maxTokens < 16)) throw new RuntimeFault("budget_exceeded", "검색·임베딩 토큰 한도에 도달했어요. 자료 또는 질문을 줄여 주세요.");
    checkpoint.turns++; usage(node).turns++; checkpoint.toolCalls++; usage(node).toolCalls++; checkpoint.tokens += reserve; usage(node).tokens += reserve;
    event(run, "model_started", "검색 또는 임베딩 제공자를 호출해요.", node.id); await persist(); await guard(node);
    const result = await bounded(node, signal => operation(signal, output ? maxTokens : estimated));
    if (!Number.isSafeInteger(result.usageTokens) || result.usageTokens < 0) throw new RuntimeFault("failed", "검색·임베딩 사용량을 확인할 수 없어요.");
    checkpoint.tokens += result.usageTokens - reserve; usage(node).tokens += result.usageTokens - reserve; await guard(node); await persist(); return result;
  }
  async function retrieval(node: FlowNode, input: Record<string, Json>): Promise<Record<string, Json>> {
    const config = node.retrieval!;
    if (!config.mode || config.mode === "lexical") return retrieveDocuments(node, input, run.resources);
    const query = input.text;
    if (typeof query !== "string" || !query.trim()) throw new NodeProcessingFault("검색에는 비어 있지 않은 text 질문이 필요해요.");
    if (config.mode === "web") {
      if (!deps.model.search) throw new RuntimeFault("failed", "웹 검색 제공자가 미설정이에요.");
      const result = await auxiliary(node, query, true, (signal, maxTokens) => deps.model.search!({ query, maxTokens, signal, ...(stream ? { onDelta: deltaFor(node) } : {}) }));
      if (!result.text || !Array.isArray(result.sources) || !result.sources.length || result.sources.some(source => { try { const url = new URL(source.url); return url.protocol !== "https:" || !!url.username || !!url.password || typeof source.title !== "string"; } catch { return true; } })) throw new NodeProcessingFault("웹 검색 결과의 HTTPS 출처를 확인하지 못했어요.");
      return { text: result.text, query, sources: result.sources, count: result.sources.length };
    }
    if (!deps.model.embed || !deps.vectorCache) throw new RuntimeFault("failed", "벡터 검색 제공자 또는 인덱스 저장소가 미설정이에요.");
    const chunks = documentChunks(node, run.resources);
    if (!chunks.length) throw new NodeProcessingFault("벡터 검색할 문서 내용이 비어 있어요.");
    const model = deps.model.embeddingModel ?? "text-embedding-3-small";
    const key = await argsHash({ ownerId: run.owner.userId, workflowId: rootRun.workflow.id, model, indexKey: config.indexKey ?? "default", chunks });
    let cached: Json | undefined;
    try { cached = await deps.vectorCache(key); } catch { throw new RuntimeFault("failed", "벡터 인덱스 저장소를 읽지 못했어요."); }
    let vectors: number[][];
    if (cached && typeof cached === "object" && !Array.isArray(cached) && cached.model === model && Array.isArray(cached.vectors)) vectors = cached.vectors as number[][];
    else {
      const result = await auxiliary(node, chunks.map(chunk => chunk.excerpt), false, (signal, maxTokens) => deps.model.embed!({ texts: chunks.map(chunk => chunk.excerpt), maxTokens, signal }));
      if (result.model !== model) throw new RuntimeFault("failed", "임베딩 모델과 인덱스 설정이 달라요.");
      vectors = result.vectors;
      if (vectors.length !== chunks.length) throw new NodeProcessingFault("임베딩 결과 개수가 자료와 달라요.");
      vectors.forEach(vector => cosine(vector, vector));
      try { await deps.vectorCache(key, { model, vectors }); } catch { throw new RuntimeFault("failed", "벡터 인덱스를 저장하지 못했어요."); }
    }
    try { if (vectors.length !== chunks.length || !vectors[0]?.length || vectors.some(vector => !Array.isArray(vector) || vector.length !== vectors[0].length || vector.length > 4096)) throw Error(); vectors.forEach(vector => cosine(vector, vector)); }
    catch { throw new RuntimeFault("failed", "저장된 벡터 인덱스 형식이 올바르지 않아요. 인덱스를 점검해 주세요."); }
    const result = await auxiliary(node, query, false, (signal, maxTokens) => deps.model.embed!({ texts: [query], maxTokens, signal }));
    if (result.model !== model || result.vectors.length !== 1) throw new NodeProcessingFault("질문 임베딩 결과를 확인하지 못했어요.");
    const matches = chunks.map((chunk, index) => ({ ...chunk, score: cosine(vectors[index], result.vectors[0]) })).sort((a, b) => b.score - a.score).slice(0, config.topK);
    return { text: `질문: ${query}\n\n${matches.map((match, index) => `[${index + 1}] ${match.name}\n${match.excerpt}\n출처: ${match.url || match.resourceId}`).join("\n\n")}`, query, matches, count: matches.length };
  }
  async function knowledgeNode(node: FlowNode, input: Record<string, Json>): Promise<Record<string, Json>> {
    if (!deps.memory) throw new RuntimeFault("failed", "지식 색인 저장소가 미설정이에요.");
    return executeKnowledge(node.knowledge!, input, {
      ownerId: run.owner.userId, workflowId: rootRun.workflow.id, operationId: `${run.id}:${node.id}`,
      resources: run.resources, embeddingModel: deps.model.embeddingModel ?? "text-embedding-3-small",
      assertAccess: async resourceIds => { await guard(node); await deps.assertAccess(resourceIds); },
      memory: async operation => { await guard(node); try { return await deps.memory!(operation); } catch (error) { throw new PersistenceFault(error); } },
      ...(deps.model.embed ? { embed: (texts: string[]) => auxiliary(node, texts, false, (signal, maxTokens) => deps.model.embed!({texts, signal, maxTokens})) } : {}),
    });
  }
  async function searchNode(node: FlowNode, input: Record<string, Json>): Promise<Record<string, Json>> {
    return runCandidateSearch(node.search!, input, run.searchStates?.[node.id] as unknown as SearchState | undefined, {
      check: () => guard(node),
      persist: async state => { run.searchStates ??= {}; run.searchStates[node.id] = state as unknown as Json; await persist(); },
      model: async (prompt, proposalInput) => {
        checkpoint.messages = [];
        const reply = await agent({...node, type: "ai", allowedTools: [], requireToolResult: false, format: "JSON", prompt: `${prompt}\n작업 지침: ${node.prompt ?? ""}`}, proposalInput);
        checkpoint.messages = [];
        if (!reply?.data || typeof reply.data !== "object" || Array.isArray(reply.data)) throw new NodeProcessingFault("후보 생성 결과는 JSON 객체여야 해요.");
        return reply.data as Record<string, Json>;
      },
    });
  }
  async function memoryNode(node: FlowNode, input: Record<string, Json>): Promise<Record<string, Json> | undefined> {
    const config = node.memory!;
    let value: Json | undefined;
    try { value = config.action === "write" ? dataAt(input, config.valuePath!) : undefined; } catch { throw new NodeProcessingFault("메모리에 저장할 입력 경로를 확인해 주세요."); }
    if (config.backend === "mcp") {
      const selection = node.allowedTools?.[0], tool = selection && deps.tools.find(t => t.resourceId === selection.resourceId && t.connectionId === selection.connectionId && t.toolName === selection.toolName);
      if (!tool || node.allowedTools?.length !== 1 || tool.effect !== (config.action === "read" ? "read" : "write")) throw new RuntimeFault("failed", "메모리 작업에 맞는 읽기 또는 변경 도구를 하나 연결해 주세요.");
      const prior = checkpoint.calls.find(call => call.nodeId === node.id);
      const args: Record<string, Json> = { namespace: await argsHash({ ownerId: run.owner.userId, workflowId: rootRun.workflow.id }), key: config.key, action: config.action, ...(value === undefined ? {} : { value }), ...(config.action === "write" && config.ttlSeconds ? { expiresAt: prior?.args.expiresAt ?? new Date(Date.now() + config.ttlSeconds * 1000).toISOString() } : {}) };
      const result = await directTool(node, input, args); if (!result) return;
      let data = result.data;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        if (data.structuredContent) data = data.structuredContent;
        else if (Array.isArray(data.content)) { const item = data.content.find(value => value && typeof value === "object" && !Array.isArray(value) && value.type === "text"); if (item && typeof item === "object" && !Array.isArray(item) && typeof item.text === "string") { try { data = JSON.parse(item.text); } catch {} } }
      }
      if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.found !== "boolean" || !("data" in data) || (data.expiresAt !== undefined && (typeof data.expiresAt !== "string" || !Number.isFinite(Date.parse(data.expiresAt))))) throw new NodeProcessingFault("메모리 도구의 data·found·expiresAt 응답 계약을 확인해 주세요.");
      if (config.action === "write" && config.ttlSeconds && !data.expiresAt) throw new RuntimeFault("failed", "메모리 서비스가 저장 만료 시각을 확인하지 않았어요. 서비스 TTL 계약을 확인해 주세요.");
      const expired = typeof data.expiresAt === "string" && Date.parse(data.expiresAt) <= Date.now();
      return { ...input, data: expired || !data.found ? config.defaultValue ?? null : data.data, found: !expired && data.found };
    }
    if (!deps.memory) throw new RuntimeFault("failed", "로컬 메모리 저장 어댑터가 미설정이에요.");
    const memoryWorkflowId = config.scope === "run" ? `${rootRun.workflow.id}:run:${rootRun.id}` : rootRun.workflow.id;
    let expectedRevision: Json | undefined;
    try { expectedRevision = config.expectedRevisionPath ? dataAt(input, config.expectedRevisionPath) : undefined; } catch { throw new NodeProcessingFault("기억 버전을 확인할 입력 경로를 찾을 수 없어요."); }
    if (config.expectedRevisionPath && (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !Number.isSafeInteger(expectedRevision + 1) || !value || typeof value !== "object" || Array.isArray(value) || value.revision !== expectedRevision + 1)) throw new NodeProcessingFault("기억 쓰기에는 확인한 버전과 그보다 1 큰 revision을 가진 새 객체가 필요해요.");
    let stored;
    try { stored = await bounded(node, async () => deps.memory!({ ownerId: run.owner.userId, workflowId: memoryWorkflowId, operationId: `${run.id}:${node.id}`, action: config.action, key: config.key, ...(value === undefined ? {} : { value }), ...(config.defaultValue === undefined ? {} : { defaultValue: config.defaultValue }), ...(config.ttlSeconds ? { ttlSeconds: config.ttlSeconds } : {}), ...(expectedRevision !== undefined ? { expectedRevision: expectedRevision as number } : {}) })); }
    catch (error) { if (error instanceof RuntimeFault) throw error; throw new NodeProcessingFault(expectedRevision !== undefined ? "기억 버전이 바뀌었거나 저장할 수 없어요. 최신 기억을 읽어 수정안을 다시 검토하세요." : "로컬 메모리를 읽거나 저장하지 못했어요. 상태 폴더와 저장 권한을 확인해 주세요."); }
    return { ...input, data: stored.data, found: stored.found };
  }
  async function inputNode(node: FlowNode, input: Record<string, Json>): Promise<Record<string, Json> | undefined> {
    const hash = await argsHash(input), configHash = await argsHash(node.form!);
    let request = run.inputRequests!.find(item => item.nodeId === node.id);
    if (!request) {
      request = { id: uid("input"), runId: run.id, nodeId: node.id, userId: run.owner.userId, inputHash: hash, configHash, input: structuredClone(input), expiresAt: new Date(Date.now() + (node.form!.timeoutMinutes ?? 1440) * 60000).toISOString(), status: "pending" };
      run.inputRequests!.push(request);
    }
    if (request.runId !== run.id || request.userId !== run.owner.userId || request.inputHash !== hash || request.configHash !== configHash || await argsHash(request.input) !== hash) throw new RuntimeFault("failed", "입력 요청의 대상이나 설정이 바뀌었어요. 새 실행을 시작해 주세요.");
    if (request.status === "submitted") {
      if (!request.output || canonicalJson(formInput(node, canonicalJson(request.output.data))) !== canonicalJson(request.output)) throw new RuntimeFault("failed", "제출한 입력 기록을 확인할 수 없어요.");
      return structuredClone(request.output);
    }
    if (!Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= Date.now()) throw new RuntimeFault("expired", "입력 기한이 지났어요. 새 실행을 시작해 주세요.");
    run.status = "waiting_input"; event(run, "waiting_input", node.form!.instructions || "계속 진행할 보완 정보를 입력해 주세요.", node.id); await persist(); return;
  }
  async function reviewNode(node: FlowNode, input: Record<string, Json>): Promise<Record<string, Json> | undefined> {
    const hash = await argsHash(input);
    let review = run.reviews!.find(item => item.nodeId === node.id);
    if (!review) {
      review = { id: uid("review"), runId: run.id, userId: run.owner.userId, nodeId: node.id, inputHash: hash, input: structuredClone(input), expiresAt: new Date(Date.now() + node.review!.timeoutMinutes * 60000).toISOString(), status: "pending" };
      run.reviews!.push(review);
    }
    if (review.inputHash !== hash || await argsHash(review.input) !== hash) throw new RuntimeFault("failed", "검토 대상 입력이 바뀌었어요. 새 실행을 시작해 주세요.");
    if (review.status === "pending") {
      if (!Number.isFinite(Date.parse(review.expiresAt)) || Date.parse(review.expiresAt) <= Date.now()) throw new RuntimeFault("expired", "검토 기한이 지났어요. 새 실행을 시작해 주세요.");
      run.status = "waiting_review"; event(run, "waiting_review", node.review!.instructions || "다음 단계 전에 내용을 검토해 주세요.", node.id); await persist(); return;
    }
    const approved = review.status === "accepted"; checkpoint.routes![node.id] = approved ? "yes" : "no"; checkpoint.branches[node.id] = approved;
    return { ...structuredClone(review.output ?? review.input), approved };
  }
  async function classify(node: FlowNode, input: Record<string, Json>): Promise<Record<string, Json>> {
    const answer = await agent({ ...node, type: "ai", format: "JSON", prompt: `${node.prompt ?? ""}\n입력을 등록된 라벨 중 하나로 분류하고 {"label":"라벨ID","reason":"짧은 설명"} JSON만 반환하세요. 라벨: ${canonicalJson(node.classification!.labels)}` }, input);
    const data = answer?.data;
    if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some(key => key !== "label" && key !== "reason") || typeof data.label !== "string" || !node.classification!.labels.some(label => label.id === data.label) || typeof data.reason !== "string" || data.reason.length > 1000) throw new NodeProcessingFault("AI 분류 결과가 등록된 라벨 또는 설명 형식과 달라요.");
    checkpoint.routes![node.id] = data.label;
    return { ...input, label: data.label, reason: redactText(data.reason) };
  }
  async function dynamicNode(node: FlowNode, input: Record<string, Json>): Promise<Record<string, Json> | undefined> {
    const config = node.orchestration!, settings = config.dynamic!;
    let group = checkpoint.groups![node.id];
    if (!group) {
      checkpoint.messages = [];
      const answer = await agent({ ...node, type: "ai", format: "JSON", prompt: `${node.prompt ?? ""}\n필요한 역할과 작업을 동적으로 분해하세요. {"agents":[{"id":"생성ID","templateId":"등록기능ID","role":"역할","goal":"목표","input":{},"dependsOn":[]}]} JSON만 반환하세요. 생성 ID는 영문/숫자/밑줄 40자 이내이고 숫자로 시작하지 않아요. 최대 ${settings.maxAgents}개이며 등록 기능·입력 스키마만 사용하세요. 도구·권한·코드·정책을 생성하거나 변경하지 마세요.` }, { input, templates: settings.templates.map(item => ({ ...item, name: config.tasks.find(task => task.id === item.taskId)!.name })) });
      const agents = parseDynamicPlan(answer?.data, config);
      group = checkpoint.groups![node.id] = { children: [], taskIds: [], contracts: [], accounted: { turns: 0, toolCalls: 0, tokens: 0 }, dynamicPlan: { agents, configHash: await argsHash(config), inputHash: await argsHash(input), planHash: await argsHash({ agents }) } };
      checkpoint.messages = [];
      event(run, "dynamic_plan_saved", "생성한 역할·입력·선행 관계를 실행 전에 저장했어요.", node.id, { agents }); await persist();
    }
    const plan = group.dynamicPlan;
    if (!plan || plan.configHash !== await argsHash(config) || plan.inputHash !== await argsHash(input) || plan.planHash !== await argsHash({ agents: plan.agents }) || canonicalJson(parseDynamicPlan({ agents: plan.agents }, config)) !== canonicalJson(plan.agents)) throw new RuntimeFault("failed", "저장된 동적 작업 계획·입력·기능 계약이 변경됐어요.");
    const tasks = instantiateDynamicTasks(plan.agents, config);
    if (!group.children.length) {
      const limits = nodeLimits(node), count = tasks.length;
      const allocated: Limits = { maxTurns: Math.floor(Math.max(0, Math.min(run.limits.maxTurns - checkpoint.turns, limits.maxTurns - usage(node).turns)) / count), maxToolCalls: Math.floor(Math.max(0, Math.min(run.limits.maxToolCalls - checkpoint.toolCalls, limits.maxToolCalls - usage(node).toolCalls)) / count), maxTokens: Math.floor(Math.max(0, Math.min(run.limits.maxTokens - checkpoint.tokens, limits.maxTokens - usage(node).tokens)) / count), maxDurationMs: Math.max(1, Math.floor(Math.min(run.limits.maxDurationMs - checkpoint.activeMs, limits.maxDurationMs - usage(node).activeMs))) };
      for (const [index, task] of tasks.entries()) {
        const child = createRun({ owner: run.owner, mode: run.mode, workflow: { ...run.workflow, name: task.name, definition: task.definition }, resources: run.resources, input: "", initialInput: dynamicChildInput(plan.agents[index], input) });
        child.limits = { ...allocated }; if (run.provider) child.provider = structuredClone(run.provider);
        group.children.push(child); group.taskIds.push(task.id);
        group.contracts!.push({ taskId: task.id, definitionHash: await argsHash(child.workflow.definition), inputHash: await argsHash(child.initialInput!), dependsOn: [...task.dependsOn ?? []], childRunId: child.id, status: child.status });
      }
      event(run, "dynamic_agents_created", "등록된 기능을 바탕으로 새 역할의 하위 실행과 한도를 저장했어요.", node.id, { taskIds: group.taskIds, concurrency: settings.concurrency }); await persist();
    }
    return groupNode({ ...node, type: "parallel", parallel: { tasks, concurrency: settings.concurrency }, orchestration: { ...config, tasks, mode: "plan" } }, input);
  }
  async function groupNode(node: FlowNode, input: Record<string, Json>): Promise<Record<string, Json> | undefined> {
    let group = checkpoint.groups![node.id];
    const config = node.orchestration;
    const contracted = Boolean(config?.completion || config?.tasks.some(task => task.dependsOn?.length));
    const artifacts = (before = group?.children.length ?? 0): Record<string, Json> => {
      const values: Record<string, Json> = {};
      for (const contract of group?.contracts ?? []) { const index = group.children.findIndex(child => child.id === contract.childRunId); if (index >= 0 && index < before && group.children[index].status === "succeeded") values[contract.taskId] = finalOutput(group.children[index]); }
      return values;
    };
    const checkPlan = (plan: string[]) => {
      const available = new Set(Object.keys(artifacts()));
      for (const id of plan) { const task = config!.tasks.find(task => task.id === id)!; if ((task.dependsOn ?? []).some(id => !available.has(id))) throw new NodeProcessingFault("선행 작업을 완료하거나 같은 계획에서 먼저 선택해 주세요."); available.add(id); }
    };
    const checkCompletion = () => {
      const context = { input, artifacts: artifacts(), summary: { agentCount: group.children.length, completedCount: group.children.filter(child => child.status === "succeeded").length } };
      group.completionChecks = (config?.completion ?? []).map(predicate => { let passed = false; try { passed = evaluatePredicate(predicate, context); } catch {} return { path: predicate.path, passed }; });
      if (config?.completion) event(run, "completion_checked", "모델의 완료 선언과 별도로 결과 조건을 검사했어요.", node.id, { checks: group.completionChecks });
      return group.completionChecks.every(check => check.passed);
    };
    const addContracts = async (tasks: CompositeTask[], children: RuntimeRun[]) => {
      if (!config) return;
      group.contracts ??= [];
      for (const [index, child] of children.entries()) group.contracts.push({ taskId: tasks[index].id, definitionHash: await argsHash(tasks[index].definition), inputHash: await argsHash(child.initialInput ?? {}), dependsOn: [...tasks[index].dependsOn ?? []], childRunId: child.id, status: child.status });
    };
    if (config && group && (group.contracts && (group.contracts.length !== group.children.length || new Set(group.contracts.map(item => item.childRunId)).size !== group.children.length) || contracted && group.children.length > 0 && !group.contracts)) throw new RuntimeFault("failed", "하위 작업 계약 원장이 누락되었어요.");
    if (config && group?.contracts) for (const contract of group.contracts) {
      const child = group.children.find(child => child.id === contract.childRunId), task = config.tasks.find(task => task.id === contract.taskId);
      if (!child || !task || await argsHash(task.definition) !== contract.definitionHash || await argsHash(child.workflow.definition) !== contract.definitionHash || await argsHash(child.initialInput ?? {}) !== contract.inputHash || canonicalJson(task.dependsOn ?? []) !== canonicalJson(contract.dependsOn)) throw new RuntimeFault("failed", "저장한 하위 작업 정의·입력·의존 관계가 변경됐어요.");
    }
    let concurrency = node.parallel?.concurrency ?? node.loop?.concurrency ?? (node.team?.mode === "parallel" ? node.team.concurrency : 1);
    concurrency = Math.max(1, Math.min(4, concurrency));
    const prepare = (tasks: { id: string; name: string; definition: Workflow["definition"] }[], inputs: Record<string, Json>[]) => {
      const limits = nodeLimits(node), count = Math.max(1, tasks.length);
      const allocated: Limits = {
        maxTurns: Math.floor(Math.max(0, Math.min(run.limits.maxTurns - checkpoint.turns, limits.maxTurns - usage(node).turns)) / count),
        maxToolCalls: Math.floor(Math.max(0, Math.min(run.limits.maxToolCalls - checkpoint.toolCalls, limits.maxToolCalls - usage(node).toolCalls)) / count),
        maxTokens: Math.floor(Math.max(0, Math.min(run.limits.maxTokens - checkpoint.tokens, limits.maxTokens - usage(node).tokens)) / count),
        maxDurationMs: Math.max(1, Math.floor(Math.min(run.limits.maxDurationMs - checkpoint.activeMs, limits.maxDurationMs - usage(node).activeMs))),
      };
      return tasks.map((task, index) => {
        const child = createRun({ owner: run.owner, mode: run.mode, workflow: { ...run.workflow, name: task.name, definition: task.definition }, resources: run.resources, input: "", initialInput: inputs[index], limits: { ...allocated, maxTurns: Math.max(1, allocated.maxTurns), maxToolCalls: Math.max(1, allocated.maxToolCalls), maxTokens: Math.max(1, allocated.maxTokens) } });
        child.limits = { ...allocated }; if (run.provider) child.provider = structuredClone(run.provider); return child;
      });
    };
    if (node.type === "orchestrator" && node.orchestration?.mode === "adaptive") {
      group ??= checkpoint.groups![node.id] = { children: [], taskIds: [], rounds: [], planningDone: false, accounted: { turns: 0, toolCalls: 0, tokens: 0 } };
      if (!group.planningDone && group.children.every(child => child.status === "succeeded")) {
        const round = (group.rounds?.length ?? 0) + 1;
        if (round > (node.orchestration.maxRounds ?? DEFAULT_ORCHESTRATION_MAX_ROUNDS)) throw new RuntimeFault("budget_exceeded", "조정자의 최대 판단 라운드에 도달했어요. 완료 확인 없이 추가 작업하지 않아요.");
        const tasks = node.orchestration.tasks, results = group.children.map((child, index) => ({ taskId: group.taskIds[index], output: finalOutput(child) }));
        checkpoint.messages = [];
        const answer = await agent({ ...node, type: "ai", format: "JSON", prompt: `${node.prompt ?? ""}\n완료한 결과를 검토하세요. 완료면 {"done":true,"tasks":[]}, 추가 작업이면 {"done":false,"tasks":["작업ID"]}만 반환하세요. 추가 작업은 1~${node.orchestration.maxTasks}개이며 중복·미등록 ID 금지.` }, { input, results, round, tasks: tasks.map(task => ({ id: task.id, name: task.name, ...(task.dependsOn ? { dependsOn: task.dependsOn } : {}) })), ...(contracted ? { artifacts: artifacts(), completionChecks: group.completionChecks ?? [] } : {}) });
        const selected = answer?.data;
        if (!selected || typeof selected !== "object" || Array.isArray(selected) || Object.keys(selected).some(key => key !== "done" && key !== "tasks") || typeof selected.done !== "boolean" || !Array.isArray(selected.tasks) || selected.tasks.length > node.orchestration.maxTasks || (selected.done ? selected.tasks.length !== 0 : selected.tasks.length === 0) || selected.tasks.some(id => typeof id !== "string" || !tasks.some(task => task.id === id)) || new Set(selected.tasks).size !== selected.tasks.length) throw new NodeProcessingFault("조정자의 완료 판단 또는 작업 선택이 허용 범위를 벗어났어요.");
        const plan = selected.tasks as string[], start = group.children.length;
        checkPlan(plan);
        const chosen = plan.map(id => tasks.find(task => task.id === id)!);
        const children = prepare(chosen, chosen.map(() => contracted ? structuredClone(input) : ({ ...structuredClone(input), results: structuredClone(results), round })));
        group.children.push(...children); await addContracts(chosen, children);
        group.taskIds.push(...plan.map(id => `round_${round}_${id}`));
        (group.rounds ??= []).push({ plan, start, end: group.children.length }); group.planningDone = selected.done && checkCompletion();
        checkpoint.messages = [];
        event(run, "orchestration_round", "완료 판단과 다음 라운드 작업을 저장했어요.", node.id, { round, plan, done: group.planningDone }); await persist();
      }
    }
    if (!group) {
      let tasks = node.parallel?.tasks ?? node.team?.tasks ?? node.orchestration?.tasks ?? [];
      let inputs: Record<string, Json>[] = tasks.map(() => node.team ? { ...structuredClone(input), previous: null, results: [] } : structuredClone(input));
      let plan: string[] | undefined;
      if (node.type === "orchestrator") {
        const answer = await agent({ ...node, type: "ai", format: "JSON", prompt: `${node.prompt ?? ""}\n등록된 작업 중 수행할 작업 ID를 순서대로 선택하고 {"tasks":["작업ID"]} JSON만 반환하세요. 1~${node.orchestration!.maxTasks}개, 중복 금지. 작업: ${canonicalJson(tasks.map(task => ({ id: task.id, name: task.name, ...(task.dependsOn ? { dependsOn: task.dependsOn } : {}) })))}` }, input);
        const selected = answer?.data;
        if (!selected || typeof selected !== "object" || Array.isArray(selected) || Object.keys(selected).some(key => key !== "tasks") || !Array.isArray(selected.tasks) || !selected.tasks.length || selected.tasks.length > node.orchestration!.maxTasks || selected.tasks.some(id => typeof id !== "string" || !tasks.some(task => task.id === id)) || new Set(selected.tasks).size !== selected.tasks.length) throw new NodeProcessingFault("조정자가 선택한 작업 목록이 허용된 범위를 벗어났어요.");
        plan = selected.tasks as string[]; checkPlan(plan); tasks = plan.map(id => tasks.find(task => task.id === id)!); inputs = tasks.map(() => structuredClone(input));
      } else if (node.type === "subworkflow") { tasks = [{ id: "subworkflow", name: node.title, definition: node.subworkflow!.definition }]; inputs = [structuredClone(input)]; }
      else if (node.type === "loop") {
        let items: Json;
        try { items = dataAt(input, node.loop!.itemsPath); } catch { throw new NodeProcessingFault("반복할 배열의 입력 경로를 확인해 주세요."); }
        if (!Array.isArray(items) || items.length > node.loop!.maxItems) throw new NodeProcessingFault("반복 입력은 설정한 최대 항목 수 이하의 배열이어야 해요.");
        tasks = items.map((_, index) => ({ id: String(index), name: `${node.title} ${index + 1}`, definition: node.loop!.definition })); inputs = items.map((item, index) => ({ ...structuredClone(input), item, index }));
      }
      const children = prepare(tasks, inputs);
      group = { children, taskIds: tasks.map(task => task.id), ...(plan ? { plan } : {}), accounted: { turns: 0, toolCalls: 0, tokens: 0 } }; checkpoint.groups![node.id] = group;
      await addContracts(tasks, children);
      event(run, "group_prepared", "하위 작업과 실행 한도를 저장했어요.", node.id, { taskIds: group.taskIds, concurrency }); await persist();
    }
    const firstMatch = node.parallel?.completion;
    const controllers = group.children.map(() => new AbortController());
    const peerCancelled = (index: number) => firstMatch && group.winnerIndex !== undefined && index !== group.winnerIndex && group.cancelledTaskIds?.includes(group.taskIds[index]);
    let saveQueue = Promise.resolve(); let failedSave: unknown; let stopStarting = group.winnerIndex !== undefined;
    const account = () => {
      const totals = group.children.reduce((sum, child) => ({ turns: sum.turns + child.checkpoint.turns, toolCalls: sum.toolCalls + child.checkpoint.toolCalls, tokens: sum.tokens + child.checkpoint.tokens }), { turns: 0, toolCalls: 0, tokens: 0 });
      const prior = group.accounted ?? { turns: 0, toolCalls: 0, tokens: 0 };
      for (const key of ["turns", "toolCalls", "tokens"] as const) { checkpoint[key] += totals[key] - prior[key]; usage(node)[key] += totals[key] - prior[key]; }
      group.accounted = totals;
    };
    const saveChild = async () => {
      if (firstMatch && group.winnerIndex === undefined) {
        const winner = group.children.findIndex(child => child.status === "succeeded" && firstMatch.checks.every(check => { try { return evaluatePredicate(check, finalOutput(child)); } catch { return false; } }));
        if (winner >= 0) {
          group.winnerIndex = winner; group.cancelledTaskIds = [];
          group.children.forEach((child, index) => { if (index !== winner && !terminal.has(child.status)) { group.cancelledTaskIds!.push(group.taskIds[index]); controllers[index].abort(); } });
          event(run, "parallel_winner", "완료 조건을 먼저 충족한 결과를 선택하고 나머지 미완료 작업을 취소해요.", node.id, { taskId: group.taskIds[winner] });
          stopStarting = true;
        }
      }
      for (const contract of group.contracts ?? []) contract.status = group.children.find(child => child.id === contract.childRunId)!.status;
      account();
      if (group.children.some((child, index) => (!firstMatch && ["waiting_approval", "waiting_review", "waiting_input"].includes(child.status)) || terminal.has(child.status) && child.status !== "succeeded" && !(peerCancelled(index) && child.status === "cancelled"))) stopStarting = true;
      saveQueue = saveQueue.then(async () => { if (failedSave) throw failedSave; await persist(); }).catch(error => { failedSave = error; throw error; });
      try { await saveQueue; } catch (error) { throw error instanceof PersistenceFault ? error : new PersistenceFault(error); }
    };
    const waiting = (child: RuntimeRun) => child.status === "waiting_approval" || child.status === "waiting_review" || child.status === "waiting_input";
    const failed = (child: RuntimeRun) => terminal.has(child.status) && child.status !== "succeeded";
    let next = 0; let fatal: unknown; const scheduled = new Set<number>();
    const work = async () => {
      while (!stopStarting && !fatal) {
        const index = group.dynamicPlan ? group.children.findIndex((child, candidate) => !scheduled.has(candidate) && child.status !== "succeeded" && (group.contracts?.find(contract => contract.childRunId === child.id)?.dependsOn ?? []).every(id => group.children[group.taskIds.indexOf(id)]?.status === "succeeded")) : next++;
        if (index < 0 || index >= group.children.length) return;
        scheduled.add(index);
        const child = group.children[index]; if (child.status === "succeeded") continue;
        if (failed(child)) { stopStarting = true; return; }
        if (config && child.events.every(event => event.type === "queued")) {
          const contract = group.contracts?.find(contract => contract.childRunId === child.id);
          if (contract) {
            if (contracted) {
              const available = artifacts(index), values: Record<string, Json> = {};
              for (const dependency of contract.dependsOn) { if (!(dependency in available)) throw new RuntimeFault("failed", "완료된 선행 작업 산출물이 필요해요."); values[dependency] = available[dependency]; }
              child.initialInput = group.dynamicPlan ? dynamicChildInput(group.dynamicPlan.agents[index], input, values) : { ...structuredClone(input), artifacts: values }; contract.inputHash = await argsHash(child.initialInput);
            }
            const previous = (group.contracts ?? []).filter(item => item.taskId === contract.taskId && item.childRunId !== child.id).map(item => ({ contract: item, child: group.children.find(child => child.id === item.childRunId)! })).filter(item => item.child.status === "succeeded");
            const written = previous.find(item => runTree(item.child).some(run => run.checkpoint.calls.some(call => call.tool.effect === "write" && call.status === "completed")));
            if (written && written.contract.inputHash !== contract.inputHash) throw new RuntimeFault("failed", "완료된 변경 작업을 다른 입력으로 다시 계획했어요. 실제 결과를 확인하고 새 실행을 시작하세요.");
            const reusable = previous.find(item => item.contract.inputHash === contract.inputHash && item.contract.definitionHash === contract.definitionHash);
            if (reusable && (contracted || written)) {
              Object.assign(child.checkpoint, { completed: [...reusable.child.checkpoint.completed], skipped: [...reusable.child.checkpoint.skipped], outputs: structuredClone(reusable.child.checkpoint.outputs), branches: structuredClone(reusable.child.checkpoint.branches), routes: structuredClone(reusable.child.checkpoint.routes) });
              child.result = reusable.child.result; child.status = "succeeded"; child.updatedAt = now();
              event(child, "task_reused", "같은 입력으로 완료된 작업 결과를 재사용했어요.", undefined, { sourceRunId: reusable.child.id });
              await saveChild(); continue;
            }
            await saveChild();
          }
        }
        if (node.team?.mode === "sequential" && child.checkpoint.completed.length === 0) {
          const outputs = group.children.slice(0, index).map(finalOutput);
          child.initialInput = { ...structuredClone(input), previous: outputs.at(-1) ?? null, results: outputs }; await saveChild();
        }
        try {
          await executeRun(child, { ...deps, rootRun, writeLocks, writeBoundary, save: saveChild,
            cancellationSignal: deps.cancellationSignal ? AbortSignal.any([deps.cancellationSignal, controllers[index].signal]) : controllers[index].signal,
            isCancelled: async () => Boolean(controllers[index].signal.aborted || await deps.isCancelled()),
            remainingDuration: () => { tick(); return Math.min(run.limits.maxDurationMs - checkpoint.activeMs, nodeLimits(node).maxDurationMs - usage(node).activeMs, deps.remainingDuration?.() ?? Infinity); },
            shouldPause: () => Boolean(deps.shouldPause?.() || failedSave || fatal || group.children.some((other, otherIndex) => other !== child && failed(other) && !(peerCancelled(otherIndex) && other.status === "cancelled"))),
            assertAccess: async (resourceIds, tool) => { await guard(node, tool); await deps.assertAccess(resourceIds, tool); },
          });
        } catch (error) { fatal = error; stopStarting = true; }
        if ((!firstMatch && waiting(child)) || failed(child) && !(peerCancelled(index) && child.status === "cancelled")) stopStarting = true;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, group.children.length)) }, work));
    await saveQueue; account();
    if (fatal) throw fatal instanceof PersistenceFault ? fatal : new PersistenceFault(fatal);
    if (firstMatch && group.winnerIndex !== undefined) {
      group.children.forEach((child, index) => {
        if (!peerCancelled(index)) return;
        for (const current of runTree(child)) {
          for (const approval of current.approvals) if (approval.status === "pending" || approval.status === "approved" && current.checkpoint.calls.some(call => call.id === approval.callId && call.status === "planned")) { approval.status = "denied"; approval.decidedAt = now(); }
          for (const review of current.reviews ?? []) if (review.status === "pending") { review.status = "rejected"; review.decidedAt = now(); }
          const unknown = current.checkpoint.calls.some(call => call.tool.effect === "write" && ["dispatching", "unknown_outcome"].includes(call.status));
          if (unknown) { current.status = "unknown_outcome"; child.status = "unknown_outcome"; }
          else if (!terminal.has(current.status)) { current.status = "cancelled"; current.error = "다른 작업이 완료 조건을 충족하여 중단했어요."; event(current, "cancelled", current.error); }
        }
      });
      await saveChild();
    }
    const failure = group.children.find(child => child.status === "unknown_outcome") ?? group.children.find((child, index) => failed(child) && !(peerCancelled(index) && child.status === "cancelled"));
    if (failure) { if (failure.status === "failed" && failure.errorRecoverable === true) throw new NodeProcessingFault(failure.error ?? "하위 작업의 입력과 설정을 확인해 주세요."); throw new RuntimeFault(failure.status as "failed" | "cancelled" | "expired" | "budget_exceeded" | "unknown_outcome", failure.error ?? "하위 작업이 실패해 전체 실행을 중지했어요."); }
    if (firstMatch && group.winnerIndex !== undefined) {
      const winner = { taskId: group.taskIds[group.winnerIndex], output: finalOutput(group.children[group.winnerIndex]) };
      const results = group.children.flatMap((child, index) => child.status === "succeeded" ? [{ taskId: group.taskIds[index], output: finalOutput(child) }] : []);
      return { text: String(winner.output.text ?? ""), matched: true, winner, results, count: results.length, cancelledTasks: group.cancelledTaskIds ?? [], observations: group.children.map((child, index) => ({ taskId: group.taskIds[index], status: child.status, output: child.status === "succeeded" ? finalOutput(child) : (child.checkpoint.outputs[child.checkpoint.completed.at(-1) ?? ""] ?? {}), completed: child.checkpoint.completed, invalidatedApprovals: child.approvals.filter(approval => approval.status === "denied").length })) };
    }
    const pending = group.children.find(waiting);
    if (pending) { run.status = group.children.some(child => child.status === "waiting_approval") ? "waiting_approval" : group.children.some(child => child.status === "waiting_review") ? "waiting_review" : "waiting_input"; event(run, run.status, "하위 작업의 승인·검토·보완 입력을 기다려요.", node.id); await persist(); return; }
    if (group.children.some(child => child.status !== "succeeded")) throw new PauseChild();
    if (node.type === "orchestrator" && node.orchestration?.mode === "adaptive" && !group.planningDone) return groupNode(node, input);
    if (config?.mode !== "adaptive" && config?.completion && !checkCompletion()) throw new NodeProcessingFault("완료 조건을 충족하지 못했어요. 결과와 작업 계획을 확인해 주세요.");
    if (node.type === "subworkflow") return finalOutput(group.children[0]);
    const results = group.children.map((child, index) => ({ taskId: group.taskIds[index], output: finalOutput(child) }));
    return { text: results.map(result => String(result.output.text ?? "")).join("\n"), results, count: results.length, ...(firstMatch ? { matched: false, winner: null, cancelledTasks: [], observations: group.children.map((child, index) => ({ taskId: group.taskIds[index], status: child.status, output: child.status === "succeeded" ? finalOutput(child) : (child.checkpoint.outputs[child.checkpoint.completed.at(-1) ?? ""] ?? {}), completed: child.checkpoint.completed, invalidatedApprovals: 0 })) } : {}), ...(contracted ? { artifacts: artifacts(), completionChecks: group.completionChecks ?? [] } : {}) };
  }
  try {
    const unresolvedWrite = checkpoint.calls.find(c => c.tool.effect === "write" && (c.status === "dispatching" || c.status === "unknown_outcome"));
    if (unresolvedWrite) {
      unresolvedWrite.status = "unknown_outcome";
      throw new RuntimeFault("unknown_outcome", "중단된 외부 변경의 결과를 확인할 수 없어요. 서비스에서 결과를 확인해 주세요. 자동 재실행하지 않아요.");
    }
    run.workflow.definition = compileDefinition(run.workflow.definition);
    await guard(); run.status = "running"; event(run, "running", "실행을 시작하거나 저장된 지점에서 재개해요."); await persist();
    const definition = run.workflow.definition;
    while (checkpoint.completed.length + checkpoint.skipped.length < definition.nodes.length) {
      const node = definition.nodes.find(n => !checkpoint.completed.includes(n.id) && !checkpoint.skipped.includes(n.id) && definition.edges.filter(e => e.target === n.id).every(e => checkpoint.completed.includes(e.source) || checkpoint.skipped.includes(e.source)));
      if (!node) throw new RuntimeFault("failed", "다음 블록을 결정할 수 없어요. 연결을 확인해 주세요.");
      const incoming = definition.edges.filter(e => e.target === node.id);
      const active = incoming.filter(e => !checkpoint.skipped.includes(e.source) && edgeIsActive(e, checkpoint.branches, checkpoint.routes));
      if (!isStartNode(node) && !active.length) { checkpoint.skipped.push(node.id); event(run, "node_skipped", "조건에 따라 이 블록을 건너뛰었어요.", node.id); await persist(); continue; }
      if (checkpoint.activeNodeId !== node.id) { checkpoint.messages = []; checkpoint.activeNodeId = node.id; }
      usage(node); await guard(node); event(run, "node_started", `${node.title} 작업을 진행해요.`, node.id); await persist();
      let output: Record<string, Json> | undefined;
      try {
      let input: Record<string, Json>;
      try { input = isStartNode(node) ? run.initialInput ?? { text: run.input } : resolveNodeInput(definition, node, checkpoint.outputs, checkpoint.skipped, checkpoint.branches, checkpoint.routes); }
      catch (error) { throw new NodeProcessingFault(error instanceof Error ? redactText(error.message) : "이전 블록의 출력 연결을 확인해 주세요."); }
      if (node.inputSchema) validateValue(input, node.inputSchema, "블록 입력");
      if (node.type === "input") output = structuredClone(input);
      else if (node.type === "form") output = node.form?.mode === "request" ? await inputNode(node, input) : formInput(node, run.initialInput ? canonicalJson(run.initialInput) : run.input);
      else if (node.type === "agent" || node.type === "ai") output = await agent(node, input);
      else if (node.type === "program") {
        if (node.program?.name === "python_tool") output = await directTool(node, input, pythonProgramArguments(node, input));
        else if (node.program?.name === "completion") {
          if (!deps.completion) throw new NodeProcessingFault("업무 프로그램 미설정: Python 실행 도우미를 포함하여 내보내 주세요.");
          const args = completionArguments(node, input), operation = String(node.program.arguments.operation);
          if (operation === "research.budget_plan") {
            if (Object.hasOwn(args, "runtimeBudget")) throw new NodeProcessingFault("runtimeBudget은 실행기가 계산하는 값이므로 직접 지정할 수 없어요.");
            args.runtimeBudget = { maxTurns: run.limits.maxTurns, usedTurns: checkpoint.turns, maxToolCalls: run.limits.maxToolCalls, usedToolCalls: checkpoint.toolCalls, maxTokens: run.limits.maxTokens, usedTokens: checkpoint.tokens, remainingDurationMs: Math.max(0, Math.floor(Math.min(run.limits.maxDurationMs - checkpoint.activeMs, deps.remainingDuration?.() ?? Infinity))) };
          }
          if (operation === "technical.taskboard_transition") args.now = Date.now() / 1000;
          const data = await bounded(node, signal => deps.completion!({ operation, arguments: args, signal }));
          if (!data || typeof data !== "object" || Array.isArray(data)) throw new NodeProcessingFault("업무 프로그램이 JSON 객체를 반환하지 않았어요.");
          output = { text: canonicalJson(data), data };
        } else try { output = executeProgram(node.program!, input); } catch (error) { throw new NodeProcessingFault(error instanceof Error ? error.message : "등록 프로그램 입력을 확인해 주세요."); }
      }
      else if (node.type === "knowledge" || node.type === "candidate_search") {
        try { output = node.type === "knowledge" ? await knowledgeNode(node, input) : await searchNode(node, input); }
        catch (error) { if (error instanceof RuntimeFault || error instanceof PersistenceFault || error instanceof PauseChild) throw error; throw new NodeProcessingFault(error instanceof Error ? redactText(error.message) : "지식 색인·후보 탐색 입력을 확인해 주세요."); }
      }
      else if (node.type === "orchestrator" && node.orchestration?.mode === "dynamic") output = await dynamicNode(node, input);
      else if (["parallel", "agent_team", "orchestrator", "subworkflow", "loop"].includes(node.type)) output = await groupNode(node, input);
      else if (node.type === "review") output = await reviewNode(node, input);
      else if (node.type === "classify") output = await classify(node, input);
      else if (node.type === "error") { try { output = errorOutput(node, input); } catch { throw new NodeProcessingFault("오류 안내 양식의 입력 경로를 확인해 주세요."); } }
      else if (node.type === "memory") output = await memoryNode(node, input);
      else if (node.type === "trigger") { let data: Json = run.input; try { data = JSON.parse(run.input); } catch {} canonicalJson(data); output = { ...input, text: run.input, data }; }
      else if (node.type === "guardrail") output = guardrailData(node, input);
      else if (node.type === "evaluate") {
        if (node.evaluation!.mode === "rules") output = ruleEvaluation(node, input);
        else {
          const answer = await agent({ ...node, type: "ai", format: "JSON", prompt: `${node.evaluation!.rubric}\n입력 결과를 평가하고 {"score":0~1 숫자,"reason":"짧은 평가 설명"} JSON만 반환하세요.` }, input);
          const result = answer?.data;
          if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).some(key => key !== "score" && key !== "reason") || typeof result.score !== "number" || !Number.isFinite(result.score) || result.score < 0 || result.score > 1 || typeof result.reason !== "string" || result.reason.length > 1000) throw new NodeProcessingFault("AI 평가의 점수와 설명 형식을 확인해 주세요.");
          output = { ...input, evaluation: { score: result.score, passed: result.score >= node.evaluation!.threshold, checks: [], reason: result.reason } };
        }
      }
      else if (["file_input", "document_extract", "file_output"].includes(node.type)) {
        if (!deps.files) throw new RuntimeFault("failed", "파일 처리 도우미가 미설정이에요. 내보낸 실행 프로젝트에서 설정해 주세요.");
        output = await bounded(node, signal => deps.files!({ operation: node.type === "file_input" ? "input" : node.type === "document_extract" ? "extract" : "output", runId: run.id, nodeId: node.id, config: (node.fileInput ?? node.documentExtract ?? node.fileOutput)! as unknown as Record<string, Json>, input, signal }));
      }
      else if (node.type === "compensate") {
        const source = checkpoint.calls.filter(call => call.nodeId === node.compensation!.sourceNodeId && call.tool.effect === "write");
        if (!source.some(call => call.status === "completed") || source.some(call => call.status === "unknown_outcome" || call.status === "dispatching")) throw new RuntimeFault("failed", "완료가 확인된 원래 변경 작업이 없어 보상하지 않았어요.");
        const chosen = node.allowedTools?.[0], tool = chosen && deps.tools.find(tool => tool.resourceId === chosen.resourceId && tool.connectionId === chosen.connectionId && tool.toolName === chosen.toolName);
        if (!tool || tool.effect !== "write") throw new RuntimeFault("failed", "보상에는 변경 도구 하나와 별도 승인이 필요해요.");
        const compensationHash = await argsHash(toolArguments(node, input));
        if (source.some(call => call.status === "completed" && call.tool.resourceId === tool.resourceId && call.tool.connectionId === tool.connectionId && call.tool.toolName === tool.toolName && call.argsHash === compensationHash)) throw new RuntimeFault("failed", "보상 작업이 원래 변경과 같은 도구·입력이에요. 되돌리는 작업을 별도로 지정해 주세요.");
        output = await directTool(node, input);
      }
      else if (node.type === "tool") output = await directTool(node, input);
      else if (node.type === "transform" || node.type === "merge" || node.type === "retrieval") {
        try { output = node.type === "transform" ? transformData(node, input) : node.type === "merge" ? mergeData(node, input) : await retrieval(node, input); }
        catch (error) { if (error instanceof RuntimeFault || error instanceof PersistenceFault) throw error; throw new NodeProcessingFault(error instanceof Error ? redactText(error.message) : "값 처리 설정을 확인해 주세요."); }
      }
      else if (node.type === "condition") { const matches = node.predicate ? evaluatePredicate(node.predicate, input) : String(input.text ?? "").toLocaleLowerCase().includes((node.condition ?? "").toLocaleLowerCase()); checkpoint.branches[node.id] = matches; checkpoint.routes![node.id] = matches ? "yes" : "no"; output = { ...input, matched: matches }; }
      else if (node.type === "resource" || node.type === "skill") {
        const resource = run.resources.find(r => r.id === node.resourceId);
        if (!resource) throw new RuntimeFault("failed", "연결한 자료를 찾을 수 없어요.");
        output = { ...input, text: `${String(input.text ?? "")}\n\n[${resource.name}]\n${resource.content}`, resource: { id: resource.id, version: resource.updatedAt, type: resource.type, content: resource.content } };
      } else output = { ...input, text: String(input.text ?? "") };
      if ((run.status as string) === "waiting_approval" || (run.status as string) === "waiting_review" || (run.status as string) === "waiting_input") return run;
      if (!output) throw new RuntimeFault("failed", "블록 결과를 확인할 수 없어요.");
      canonicalJson(output);
      if (node.outputSchema) validateValue(output, node.outputSchema, "블록 출력");
      if (node.onError === "branch") checkpoint.routes![node.id] = "success";
      } catch (error) {
        if (!(error instanceof NodeProcessingFault) || node.onError !== "branch") throw error;
        output = { text: "", error: { message: redactText(error.message), nodeId: node.id } }; checkpoint.routes![node.id] = "error";
        event(run, "node_error_handled", "실패 내용을 오류 경로로 전달해요.", node.id, output);
      }
      checkpoint.outputs[node.id] = output; checkpoint.completed.push(node.id);
      if (node.type === "output") run.result = String(output.text ?? "");
      event(run, "node_completed", `${node.title} 작업을 마쳤어요.`, node.id, { output });
      await persist(); checkpoint.activeNodeId = undefined; checkpoint.messages = [];
    }
    await guard(); run.status = "succeeded"; event(run, "succeeded", run.mode === "test" ? "테스트 실행을 마쳤어요. 실제 AI 결과가 아니에요." : "실제 실행을 마쳤어요."); await persist();
  } catch (error) {
    if (error instanceof PersistenceFault) throw error.cause;
    if (error instanceof PauseChild) { run.status = "queued"; event(run, "paused", "다른 하위 작업의 상태를 확인하기 위해 잠시 멈췄어요."); await persist(); return run; }
    run.status = error instanceof RuntimeFault ? error.code : "failed";
    run.errorRecoverable = error instanceof NodeProcessingFault;
    run.error = error instanceof RuntimeFault ? error.message : "입출력 형식 또는 실행 설정을 확인해 주세요.";
    event(run, run.status, run.error, checkpoint.activeNodeId); await persist();
  }
  return run;
}
