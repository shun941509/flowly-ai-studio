import type { Definition, FlowNode } from "../app/lib/model";
import type { FormConfig, InputRequest, Json, Review, RuntimeRun } from "./types";
import { argsHash, canonicalJson, redactJson, RuntimeFault } from "./policy";
import { dataAt } from "./data-nodes";
import { assertSchema } from "../domain/schema";
import { resolveNodeInput } from "../domain/workflow";

/** Only explicit input/model/data failures may follow an onError edge. */
export class NodeProcessingFault extends RuntimeFault {
  constructor(message: string) { super("failed", message); }
}
export class PauseChild extends Error {}
export function nestedDefinitions(node: FlowNode): Definition[] {
  return [...(node.parallel?.tasks ?? []).map(task => task.definition), ...(node.team?.tasks ?? []).map(task => task.definition), ...(node.orchestration?.tasks ?? []).map(task => task.definition), ...(node.subworkflow ? [node.subworkflow.definition] : []), ...(node.loop ? [node.loop.definition] : [])];
}
export function allNodes(definition: Definition): FlowNode[] {
  return definition.nodes.flatMap(node => [node, ...nestedDefinitions(node).flatMap(allNodes)]);
}
export function runTree(run: RuntimeRun): RuntimeRun[] {
  return [run, ...Object.values(run.checkpoint.groups ?? {}).flatMap(group => group.children.flatMap(runTree))];
}
export function finalOutput(run: RuntimeRun): Record<string, Json> {
  const id = run.checkpoint.completed.filter(id => run.workflow.definition.nodes.find(node => node.id === id)?.type === "output").at(-1);
  if (!id || !run.checkpoint.outputs[id]) throw new RuntimeFault("failed", "하위 작업의 출력 기록을 찾지 못했어요.");
  return run.checkpoint.outputs[id];
}
export function formInput(node: FlowNode, text: string): Record<string, Json> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new NodeProcessingFault("입력 폼에는 JSON 객체를 입력해 주세요."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NodeProcessingFault("입력 폼에는 JSON 객체가 필요해요.");
  const data = value as Record<string, Json>, fields = node.form!.fields;
  if (Object.keys(data).some(key => !fields.some(field => field.key === key))) throw new NodeProcessingFault("입력 폼에 등록하지 않은 필드가 있어요.");
  for (const field of fields) {
    const value = data[field.key];
    if (value === undefined || typeof value === "string" && !value.trim()) { if (field.required) throw new NodeProcessingFault("입력 폼의 필수 값을 채워 주세요."); if (value === undefined) continue; }
    let valid = false;
    if (field.type === "text") valid = typeof value === "string";
    if (field.type === "file") valid = typeof value === "string" && value.length <= 500 && !/^(?:[A-Za-z]:|[\\/])/.test(value) && !value.split(/[\\/]/).some(part => !part || part === "." || part === "..") && !/[\x00-\x1f]/.test(value);
    if (field.type === "number") valid = typeof value === "number" && Number.isFinite(value);
    if (field.type === "boolean") valid = typeof value === "boolean";
    if (field.type === "select") valid = typeof value === "string" && Boolean(field.options?.includes(value));
    if (field.type === "date" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number(value.slice(0, 4)) >= 1) { const date = new Date(`${value}T00:00:00.000Z`); valid = Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; }
    if (!valid) throw new NodeProcessingFault("입력 폼의 자료형·날짜·선택값을 확인해 주세요.");
  }
  return { text: canonicalJson(data), data };
}
export function errorOutput(node: FlowNode, input: Record<string, Json>): Record<string, Json> {
  const template = node.error?.template ?? "작업을 완료하지 못했어요: {{error.message}}";
  return { ...input, text: template.replace(/\{\{([^{}]+)\}\}/g, (_, path: string) => { const value = dataAt(input, path.trim()); return typeof value === "string" ? value : canonicalJson(value); }) };
}
export async function decideReview(root: RuntimeRun, reviewId: string, userId: string, decision: "accepted" | "rejected", edited?: Record<string, Json>): Promise<RuntimeRun> {
  if (root.owner.userId !== userId) throw new RuntimeFault("failed", "이 검토를 처리할 권한이 없어요.");
  if (root.restoredReadOnly) throw new RuntimeFault("failed", "복원한 외부 변경 실행은 조회만 가능해요. 서비스의 실제 결과를 확인한 뒤 새 실행을 시작해 주세요.");
  const run = runTree(root).find(current => current.reviews?.some(review => review.id === reviewId));
  const review = run?.reviews?.find(review => review.id === reviewId);
  if (!run || !review || review.userId !== userId || review.runId !== run.id || run.owner.userId !== userId) throw new RuntimeFault("failed", "이 검토를 처리할 권한이 없어요.");
  const node = run.workflow.definition.nodes.find(node => node.id === review.nodeId && node.type === "review");
  if (!node?.review || await argsHash(review.input) !== review.inputHash) throw new RuntimeFault("failed", "검토 입력이나 설정이 바뀌었어요. 새 실행을 시작해 주세요.");
  if (review.status !== "pending") {
    if (review.status === decision && edited === undefined) return root;
    throw new RuntimeFault("failed", "이미 처리한 검토 요청이에요.");
  }
  if (["succeeded", "failed", "cancelled", "expired", "budget_exceeded", "unknown_outcome"].includes(root.status)) throw new RuntimeFault("failed", "종료된 실행에서는 새 검토를 처리할 수 없어요.");
  if (run.status !== "waiting_review") throw new RuntimeFault("failed", "검토 대기 중인 실행이 아니에요.");
  if (!Number.isFinite(Date.parse(review.expiresAt)) || Date.parse(review.expiresAt) <= Date.now()) { run.status = "expired"; root.status = "expired"; run.error = root.error = "검토 기한이 지났어요. 새 실행을 시작해 주세요."; root.updatedAt = new Date().toISOString(); return root; }
  if (edited !== undefined && (!node.review.allowEdit || decision !== "accepted" || !edited || typeof edited !== "object" || Array.isArray(edited))) throw new RuntimeFault("failed", "이 검토에서는 입력을 수정할 수 없어요.");
  canonicalJson(edited ?? review.input);
  const output = redactJson(structuredClone(edited ?? review.input)) as Record<string, Json>;
  try { if (node.inputSchema) assertSchema(output, node.inputSchema, "검토 입력"); if (node.outputSchema) assertSchema({ ...output, approved: decision === "accepted" }, node.outputSchema, "검토 출력"); }
  catch { throw new RuntimeFault("failed", "수정한 검토 입력의 필수 값과 자료형을 확인해 주세요. 검토 요청은 대기 상태로 유지돼요."); }
  review.output = output; review.status = decision; review.decidedAt = new Date().toISOString();
  run.status = "queued"; root.status = "queued"; run.updatedAt = root.updatedAt = review.decidedAt;
  run.events.push({ sequence: (run.events.at(-1)?.sequence ?? 0) + 1, at: review.decidedAt, type: `review_${decision}`, nodeId: node.id, message: decision === "accepted" ? "검토를 승인했어요. resume로 이어서 실행하세요." : "검토를 반려했어요. resume로 반려 경로를 진행하세요." });
  return root;
}
export function pendingReviews(run: RuntimeRun): (Review & { instructions: string; allowEdit: boolean })[] { return runTree(run).flatMap(current => (current.reviews ?? []).map(review => { const config = current.workflow.definition.nodes.find(node => node.id === review.nodeId)?.review; return { ...review, instructions: config?.instructions ?? "", allowEdit: config?.allowEdit === true }; })); }

/** A submission records validated data. Only a separate resume may execute downstream work. */
export async function submitInput(root: RuntimeRun, requestId: string, userId: string, values: Record<string, Json>): Promise<RuntimeRun> {
  if (root.owner.userId !== userId) throw new RuntimeFault("failed", "이 입력 요청을 처리할 권한이 없어요.");
  if (root.restoredReadOnly) throw new RuntimeFault("failed", "복원한 외부 변경 실행은 조회만 가능해요.");
  const run = runTree(root).find(current => current.inputRequests?.some(request => request.id === requestId));
  const request = run?.inputRequests?.find(request => request.id === requestId);
  if (!run || !request || run.owner.userId !== userId || request.userId !== userId || request.runId !== run.id) throw new RuntimeFault("failed", "이 입력 요청을 처리할 권한이 없어요.");
  const ancestors = runTree(root).filter(parent => runTree(parent).some(child => child.id === run.id));
  if (ancestors.some(parent => parent.owner.userId !== userId || parent.restoredReadOnly || ["succeeded", "failed", "cancelled", "expired", "budget_exceeded", "unknown_outcome"].includes(parent.status))) throw new RuntimeFault("failed", "종료되었거나 권한이 없는 상위 실행에서는 입력을 제출할 수 없어요.");
  const node = run.workflow.definition.nodes.find(node => node.id === request.nodeId && node.type === "form" && node.form?.mode === "request");
  if (!node?.form || await argsHash(node.form) !== request.configHash || await argsHash(request.input) !== request.inputHash) throw new RuntimeFault("failed", "입력 요청의 대상이나 설정이 바뀌었어요. 새 실행을 시작해 주세요.");
  const current = resolveNodeInput(run.workflow.definition, node, run.checkpoint.outputs, run.checkpoint.skipped, run.checkpoint.branches, run.checkpoint.routes);
  if (await argsHash(current) !== request.inputHash) throw new RuntimeFault("failed", "입력 요청의 이전 결과가 바뀌었어요. 새 실행을 시작해 주세요.");
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new RuntimeFault("failed", "보완 입력은 JSON 객체여야 해요.");
  const encoded = canonicalJson(values);
  if (encoded.length > 20000) throw new RuntimeFault("failed", "보완 입력은 20,000자까지 사용할 수 있어요.");
  const output = formInput(node, canonicalJson(redactJson(values)));
  if (node.outputSchema) assertSchema(output, node.outputSchema, "보완 입력 출력");
  if (["succeeded", "failed", "cancelled", "expired", "budget_exceeded", "unknown_outcome"].includes(root.status)) throw new RuntimeFault("failed", "종료된 실행에서는 입력을 제출할 수 없어요.");
  if (request.status !== "pending") {
    if (request.status === "submitted" && canonicalJson(output) === canonicalJson(request.output)) return root;
    throw new RuntimeFault("failed", "이미 제출한 입력이에요. 다른 값으로 바꿀 수 없어요.");
  }
  if (run.status !== "waiting_input") throw new RuntimeFault("failed", "입력 대기 중인 실행이 아니에요.");
  if (!Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= Date.now()) {
    const at = new Date().toISOString();
    for (const parent of ancestors) { parent.status = "expired"; parent.error = "입력 기한이 지났어요. 새 실행을 시작해 주세요."; parent.updatedAt = at; }
    return root;
  }
  request.output = output; request.status = "submitted"; request.submittedAt = new Date().toISOString();
  for (const parent of ancestors) { parent.status = "queued"; parent.updatedAt = request.submittedAt; }
  run.events.push({ sequence: (run.events.at(-1)?.sequence ?? 0) + 1, at: request.submittedAt, type: "input_submitted", nodeId: node.id, message: "보완 입력을 저장했어요. resume로 같은 실행을 이어가세요." });
  return root;
}
export function pendingInputs(run: RuntimeRun): (InputRequest & { instructions: string; fields: FormConfig["fields"] })[] {
  return runTree(run).flatMap(current => (current.inputRequests ?? []).map(request => { const config = current.workflow.definition.nodes.find(node => node.id === request.nodeId)?.form; return { ...request, instructions: config?.instructions ?? "", fields: config?.fields ?? [] }; }));
}
