// Node 패키지의 오프라인 사전 검사와 저장 기록 HTML 보고서 생성. ready는 로컬 설정 준비이며 실제 외부 연결 성공을 뜻하지 않는다.
import { isStartNode } from "../domain/advanced-config";
import { open } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { resolveNodeInput } from "../domain/workflow";
import { inspectWorkflow } from "../domain/preflight";
import { allNodes } from "../runtime/advanced";
import { nodeRequiresModel, nodeRequiresResponseModel } from "../domain/extended-config";
import { safeEndpoint } from "../runtime/adapters/http";
import { redactJson, redactText } from "../runtime/policy";
import type { Json, RuntimeRun } from "../runtime/types";
import { parseExportManifest, type ExportManifest } from "./manifest";
import { selectedPythonToolIds } from "../runtime/python-tools";

export type CheckResult = {
  status: "ready" | "unconfigured" | "invalid";
  language: "node";
  counts: { nodes: number; resources: number; tools: number };
  requiresModel: boolean;
  missingEnv: string[];
  errors: string[];
};

export function modelRequired(manifest: ExportManifest): boolean {
  return allNodes(manifest.workflow.definition).some(nodeRequiresModel);
}
export function selectedConnections(manifest: ExportManifest) {
  const selected = allNodes(manifest.workflow.definition).filter(node => ["agent", "tool", "compensate"].includes(node.type) || node.type === "memory" && node.memory?.backend === "mcp").flatMap(node => node.allowedTools || []);
  return manifest.connections.filter(connection => selected.some(tool => tool.connectionId === connection.id && tool.resourceId === connection.resourceId));
}
// 실제 사용하는 중첩 노드와 연결에서 필요한 변수 이름만 반환한다. 비밀 값 자체는 진단 결과에 담지 않는다.
export function missingEnvironment(manifest: ExportManifest, env: Record<string, string | undefined>): string[] {
  const names = modelRequired(manifest) ? ["OPENAI_API_KEY"] : [];
  if (allNodes(manifest.workflow.definition).some(nodeRequiresResponseModel)) names.push("FLOWLY_MODEL");
  for (const connection of selectedConnections(manifest)) {
    if (connection.tokenEnv) names.push(connection.tokenEnv);
    if (connection.endpointEnv) names.push(connection.endpointEnv);
  }
  return [...new Set(names)].filter(name => !env[name]?.trim()).sort();
}

/** Structural and local-setting checks only. Never constructs a provider or sends a request. */
// 제공자 어댑터를 만들지 않고 구조·자료·설정만 검사한다. 네트워크 연결 점검은 로컬 운영 기능의 별도 동작이다.
export function checkPackage(value: unknown, env: Record<string, string | undefined> = {}, environmentError?: string): CheckResult {
  const result: CheckResult = { status: "invalid", language: "node", counts: { nodes: 0, resources: 0, tools: 0 }, requiresModel: false, missingEnv: [], errors: [] };
  let manifest: ExportManifest;
  try { manifest = parseExportManifest(value); }
  catch { result.errors.push("워크플로 패키지의 버전·노드·연결·자료·도구 형식을 확인하고 다시 내보내 주세요."); return result; }
  if (manifest.language !== "node") { result.errors.push("Node.js용으로 내보낸 workflow.json을 사용해 주세요."); return result; }
  result.counts = { nodes: allNodes(manifest.workflow.definition).length, resources: manifest.resources.length, tools: manifest.connections.reduce((count, connection) => count + connection.tools.length, 0) + selectedPythonToolIds(manifest.workflow.definition).length };
  result.requiresModel = modelRequired(manifest);
  result.missingEnv = missingEnvironment(manifest, env);
  for (const connection of selectedConnections(manifest)) if (connection.endpointEnv && env[connection.endpointEnv]?.trim()) {
    try { safeEndpoint(env[connection.endpointEnv]!.trim()); }
    catch { result.errors.push(`${connection.endpointEnv}: 인증 정보·쿼리·프래그먼트가 없는 HTTP 또는 HTTPS 주소를 입력해 주세요. 내부망 주소와 사용자 지정 포트를 사용할 수 있어요.`); }
  }
  const secrets = Object.entries(env).filter(([name, value]) => value?.trim() && (name === "OPENAI_API_KEY" || name === "FLOWLY_TRIGGER_SECRET" || name === "FLOWLY_WATERMARK_KEY" || name === "FLOWLY_CONTENT_CREDENTIALS_KEY" || /^FLOWLY_MCP_TOKEN_[A-Z0-9_]+$/.test(name))).map(([, value]) => value!);
  if (secrets.some(secret => JSON.stringify(value).includes(secret))) result.errors.push("프로젝트 내용에 로컬 비밀 값이 포함되어 있어요. 비밀 값을 제거하고 다시 내보내 주세요.");
  const inspection = inspectWorkflow(manifest.workflow, manifest.resources.map(resource => ({ ...resource, allowedEmails: [] })), {
    testEnabled: false, liveEnabled: false, liveReason: "오프라인 검사",
    connections: manifest.connections.map(connection => ({ ...connection, status: "configured" })),
  });
  if (!inspection.canExport) result.errors.push("블록의 도구 선택·필수 입력·자료 연결을 확인해 주세요. 웹의 내보내기 사전 검사에서 해당 블록을 찾을 수 있어요.");
  if (environmentError) result.errors.push("환경 파일을 읽지 못했어요. 파일 크기·접근 권한·형식을 확인해 주세요.");
  result.status = result.errors.length ? "invalid" : result.missingEnv.length ? "unconfigured" : "ready";
  return result;
}

const escapeHtml = (value: unknown) => redactText(String(value ?? "")).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
function data(value: unknown): string {
  if (value === undefined) return '<p class="muted">기록 없음</p>';
  const sanitized = redactJson(JSON.parse(JSON.stringify(value)) as Json);
  return `<pre>${escapeHtml(typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized, null, 2))}</pre>`;
}
const detail = (label: string, value: unknown) => `<details><summary>${escapeHtml(label)}</summary>${data(value)}</details>`;
const number = (value: number | undefined) => Number.isFinite(value) ? value!.toLocaleString("ko-KR") : "미기록";
const statusNames: Record<string, string> = { queued: "대기", running: "실행 중", waiting_approval: "승인 대기", waiting_review: "검토 대기", waiting_input: "입력 대기", submitted: "입력 제출", succeeded: "완료", failed: "실패", cancelled: "취소", expired: "만료", budget_exceeded: "한도 초과", unknown_outcome: "결과 확인 필요", pending: "결정 대기", approved: "승인", denied: "거절", accepted: "검토 수락", rejected: "검토 거절", planned: "호출 준비", dispatching: "호출 중", completed: "완료", skipped: "건너뜀" };
const state = (value: string) => escapeHtml(statusNames[value] || value);
// 저장된 아바타 출력도 외부 입력으로 취급하여 허용한 SVG 형식만 표시한다.
function avatarPreview(output: Record<string, Json> | undefined): string {
  const value = output?.data;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const avatar = value.avatar;
  if (!avatar || typeof avatar !== "object" || Array.isArray(avatar) || avatar.format !== "flowly-avatar-cue-v1" || typeof avatar.svg !== "string") return "";
  const svg = redactText(avatar.svg);
  if (svg.length > 30000 || !/^<svg\s[^>]*>[\s\S]*<\/svg>$/.test(svg) || /<\s*(?:script|foreignObject|image|use|style|animate|set|iframe|a)\b|\bon\w+\s*=|(?:href|src)\s*=|url\s*\(|<!|<\?/i.test(svg)) return "";
  const url = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  return `<figure><img src="${url}" alt="에이전트의 확인 상태와 안내" style="max-width:400px;width:100%;height:auto"><figcaption>${escapeHtml(avatar.caption)}</figcaption><a href="${url}" download="agent-avatar.svg">아바타 SVG 저장</a></figure>`;
}

/** Standalone, script-free report. Persisted messages/internal model reasoning are not rendered. */
export function renderRunReport(run: RuntimeRun): string {
  const cp = run.checkpoint;
  if (!cp || !Array.isArray(cp.calls) || !Array.isArray(cp.completed) || !Array.isArray(cp.skipped) || !cp.outputs || !Array.isArray(run.approvals) || !Array.isArray(run.events)) throw new Error("실행 기록 형식을 확인해 주세요.");
  const duration = Math.max(0, Date.parse(run.updatedAt) - Date.parse(run.createdAt));
  const nodes = run.workflow.definition.nodes.map(node => {
    const nodeState = cp.completed.includes(node.id) ? "completed" : cp.skipped.includes(node.id) ? "skipped" : cp.activeNodeId === node.id ? run.status : "queued";
    let input: unknown;
    if (isStartNode(node)) input = run.initialInput ?? { text: run.input };
    else if (nodeState !== "queued" && nodeState !== "skipped") {
      try { input = resolveNodeInput(run.workflow.definition, node, cp.outputs, cp.skipped, cp.branches, cp.routes); }
      catch { input = "저장된 앞 단계 출력에서 입력을 재구성할 수 없어요."; }
    }
    const usage = cp.nodeUsage?.[node.id];
    return `<article><div class="row"><h3>${escapeHtml(node.title)}</h3><span class="badge">${state(nodeState)}</span></div><p class="muted">${escapeHtml(node.type)} · ${escapeHtml(node.id)}</p><p>모델 판단 ${number(usage?.turns)}회 · 도구 ${number(usage?.toolCalls)}회 · 토큰 ${number(usage?.tokens)} · 활성 시간 ${number(usage?.activeMs)}ms</p>${detail("입력 (저장된 매핑으로 재구성)", input)}${avatarPreview(cp.outputs[node.id])}${detail("저장된 출력", cp.outputs[node.id])}</article>`;
  }).join("");
  const calls = cp.calls.map(call => `<article><div class="row"><h3>${escapeHtml(call.tool.name)}</h3><span class="badge">${state(call.status)}</span></div><p>${escapeHtml(call.tool.effect === "write" ? "외부 변경" : "읽기")} · ${escapeHtml(call.nodeId)} · ${number(call.attempts)}회 시도</p>${detail("호출 인자", call.args)}${detail("도구 결과 또는 오류", call.result)}</article>`).join("");
  const approvals = run.approvals.map(approval => `<tr><td>${escapeHtml(approval.id)}</td><td>${escapeHtml(approval.toolName)}</td><td>${state(approval.status)}</td><td>${escapeHtml(approval.expiresAt)}</td><td>${escapeHtml(approval.decidedAt || "미결정")}</td></tr>`).join("");
  const events = run.events.map(event => `<li><time>${escapeHtml(event.at)}</time><strong>${escapeHtml(event.type)}</strong><p>${escapeHtml(event.message)}</p>${event.data === undefined ? "" : detail("기록 데이터", event.data)}</li>`).join("");
  const children = Object.entries(cp.groups ?? {}).flatMap(([nodeId, group]) => group.children.map((child, index) => `<article><h3>하위 작업 ${escapeHtml(nodeId)} / ${escapeHtml(group.taskIds[index])}</h3>${renderRunReport(child).split("<main>")[1].split("</main>")[0]}</article>`)).join("");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(run.workflow.name)} · Flowly 실행 보고서</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f7f2;color:#263a30;font:15px/1.7 system-ui,sans-serif}main{max-width:1080px;margin:auto;padding:38px 24px}h1{font-size:28px;line-height:1.35;margin:8px 0}h2{font-size:20px;margin:32px 0 14px}h3{font-size:16px;margin:0}p{margin:8px 0}.muted,time{color:#607063;font-size:12px}.notice{background:#fff8e7;border:1px solid #e8d6ab;padding:14px;border-radius:9px}.row{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}.badge{border:1px solid #b6c9ac;background:#edf4e8;padding:3px 9px;border-radius:20px;font-size:12px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:24px 0}.metrics div,article{background:white;border:1px solid #dfe6d8;padding:18px;border-radius:9px}article+article{margin-top:12px}.metrics strong{display:block;font-size:22px}.metrics span{font-size:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f6ef;padding:14px;border-radius:6px;font-size:12px;max-height:600px;overflow:auto}details{margin-top:10px}summary{cursor:pointer;font-size:13px;color:#355a35}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:12px;background:#fff}th,td{border-bottom:1px solid #dfe6d8;padding:12px;text-align:left;overflow-wrap:anywhere}ol{padding:0;list-style:none}li{border-left:3px solid #d5e2ca;margin:14px 0;padding:0 0 0 15px}li>strong{margin-left:10px;font-size:12px}.error{border-left:3px solid #b95348;padding-left:14px}@media(max-width:600px){main{padding:20px 14px}h1{font-size:22px}.metrics{grid-template-columns:repeat(2,1fr)}article{padding:14px}}@media print{body{background:white}main{max-width:none}details{break-inside:avoid}pre{max-height:none}}
</style></head><body><main><p class="muted">FLOWLY · 로컬 실행 기록</p><div class="row"><h1>${escapeHtml(run.workflow.name)}</h1><span class="badge">${state(run.status)}</span></div><p class="muted">실행 ID ${escapeHtml(run.id)} · 모드 ${escapeHtml(run.mode)}</p><p>시작 ${escapeHtml(run.createdAt)}<br>마지막 기록 ${escapeHtml(run.updatedAt)} · 기록 시점까지 경과 ${number(duration)}ms</p>${run.restoredReadOnly ? '<p class="notice">복원한 외부 변경 실행은 조회만 가능합니다. 실제 서비스 결과를 확인한 뒤 새 실행을 시작하세요. 이 기록의 승인·검토·재개는 차단됩니다.</p>' : ""}<p class="notice">이 보고서는 로컬 저장 기록의 복사본이며 새 모델·도구 호출을 하지 않습니다. 입력은 고정된 매핑과 앞 단계 저장 출력으로 재구성했습니다. 민감한 입력·자료·결과가 포함될 수 있으므로 공유 범위를 확인하세요. 알려진 비밀 패턴은 가리지만 임의의 비밀을 모두 탐지하지는 않습니다.</p><div class="metrics"><div><strong>${number(cp.turns)}</strong><span>모델 판단</span></div><div><strong>${number(cp.toolCalls)}</strong><span>도구 호출</span></div><div><strong>${number(cp.tokens)}</strong><span>기록된 토큰 · 청구 비용 아님</span></div><div><strong>${number(cp.activeMs)}ms</strong><span>활성 실행 시간</span></div></div><h2>입력과 최종 결과</h2>${detail("사용자 입력", run.input)}${detail("최종 결과", run.result)}${run.error ? `<div class="error"><h3>오류</h3>${data(run.error)}</div>` : ""}<h2>노드별 입력·출력</h2>${nodes}<h2>도구 호출</h2>${calls || '<p class="muted">도구 호출 기록 없음</p>'}<h2>승인 기록</h2>${approvals ? `<div class="table"><table><thead><tr><th>승인 ID</th><th>도구</th><th>결정</th><th>만료</th><th>결정 시각</th></tr></thead><tbody>${approvals}</tbody></table></div>` : '<p class="muted">승인 기록 없음</p>'}<h2>실행 한도</h2>${data(run.limits)}<h2>상태·오류 이벤트</h2><ol>${events}</ol><h2>사람 검토 기록</h2>${detail("검토 요청과 결정", run.reviews ?? [])}<h2>보완 입력 기록</h2>${detail("입력 요청과 제출", run.inputRequests ?? [])}${children ? `<h2>하위 작업</h2>${children}` : ""}</main></body></html>`;
}

export async function writeRunReport(run: RuntimeRun, destination: string): Promise<string> {
  const output = resolve(destination);
  if (![".html", ".htm"].includes(extname(output).toLowerCase())) throw new Error("보고서 출력 경로는 .html 파일로 지정해 주세요.");
  const html = renderRunReport(run);
  if (Buffer.byteLength(html) > 64_000_000) throw new Error("보고서가 너무 커요. 실행 기록과 자료 크기를 확인해 주세요.");
  let file;
  try { file = await open(output, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("보고서 파일이 이미 있어요. 다른 --output 경로를 선택해 주세요."); throw new Error("보고서 출력 폴더와 쓰기 권한을 확인해 주세요."); }
  try { await file.writeFile(html); await file.sync(); }
  finally { await file.close(); }
  return output;
}
