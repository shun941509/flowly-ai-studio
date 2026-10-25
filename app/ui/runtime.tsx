"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Workflow } from "../lib/model";
import { uid } from "../lib/model";
import type { Json, PublicRun, RuntimeCapabilities, RunStatus } from "../../runtime/types";
import { EmptyState, Icon, Modal, formatDate } from "./common";

const statusNames: Record<RunStatus, string> = {
  queued: "실행 대기", running: "실행 중", waiting_approval: "승인 대기", waiting_review: "사람 검토 대기", waiting_input: "보완 입력 대기", succeeded: "완료",
  failed: "실행 실패", cancelled: "취소됨", expired: "승인·검토·입력 만료", budget_exceeded: "한도 초과", unknown_outcome: "결과 확인 필요",
};
type ResponseData = { error?: string; capabilities?: RuntimeCapabilities; runs?: PublicRun[]; run?: PublicRun };
type RuntimeAction = "run.cancel" | "run.resume" | "approval.decide" | "input.submit";

async function request(body?: Record<string, unknown>): Promise<ResponseData> {
  let response: Response;
  try {
    response = await fetch("/api/runtime", body ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    } : { cache: "no-store" });
  } catch {
    throw new Error("실행 서비스에 연결하지 못했어요. 서버 연결을 확인하고 상태를 새로고침해 주세요. 요청이 처리되었을 수 있으니 현재 상태를 먼저 확인해 주세요.");
  }
  let data: ResponseData;
  try { data = await response.json() as ResponseData; }
  catch { throw new Error("실행 상태를 확인하지 못했어요. 상태를 새로고침한 뒤 다시 확인해 주세요."); }
  if (!response.ok) throw new Error(data.error || "실행 서비스에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.");
  return data;
}

export function useRuntime(demo: boolean) {
  const [capabilities, setCapabilities] = useState<RuntimeCapabilities | null>(null);
  const [runs, setRuns] = useState<PublicRun[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!demo);
  const inFlight = useRef(false);
  const retry = useRef<{ signature: string; key: string } | null>(null);
  const refresh = useCallback(async () => {
    if (demo || inFlight.current) return;
    inFlight.current = true;
    try {
      const data = await request();
      setCapabilities(data.capabilities || null);
      setRuns(data.runs || []);
      setError("");
    } catch (e) { setError((e as Error).message); }
    finally { inFlight.current = false; setLoading(false); }
  }, [demo]);
  useEffect(() => {
    const timer = setTimeout(() => { void refresh(); }, 0);
    return () => clearTimeout(timer);
  }, [refresh]);
  const hasActiveRun = runs.some(run => ["queued", "running", "waiting_approval", "waiting_review", "waiting_input"].includes(run.status));
  useEffect(() => {
    if (!hasActiveRun || demo) return;
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => clearInterval(timer);
  }, [hasActiveRun, demo, refresh]);
  function remember(run: PublicRun) { setRuns(previous => [run, ...previous.filter(item => item.id !== run.id)]); }
  async function start(workflow: Workflow, input: string, mode: "test" | "live") {
    if (demo) throw new Error("체험 공간에서는 미리보기만 사용할 수 있어요. 로그인한 후 실행해 주세요.");
    setBusy(true);
    const signature = JSON.stringify({ workflow, input, mode });
    if (retry.current?.signature !== signature) retry.current = { signature, key: uid("request") };
    try {
      const data = await request({ action: "run.start", workflow, input, mode, idempotencyKey: retry.current.key });
      if (!data.run) throw new Error("실행 접수를 확인하지 못했어요. 다시 누르면 같은 요청으로 확인합니다.");
      remember(data.run);
      retry.current = null;
      return data.run;
    } finally { setBusy(false); }
  }
  async function act(action: RuntimeAction, id: string, extra: Record<string, unknown> = {}) {
    if (demo) return;
    setBusy(true);
    try {
      const data = await request({ action, id, ...extra });
      if (!data.run) throw new Error("변경된 실행 상태를 확인하지 못했어요. 새로고침해 주세요.");
      remember(data.run);
    } finally { setBusy(false); }
  }
  return { capabilities, runs, error, busy, loading, refresh, start, act };
}
export type RuntimeController = ReturnType<typeof useRuntime>;

export function RuntimeStatus({ run }: { run: PublicRun }) {
  return <span className={`runtime-status runtime-status-${run.status}`}><span className="status-dot" />{statusNames[run.status]}</span>;
}

function ChildRunList({ items }: { items: NonNullable<PublicRun["children"]> }) {
  return <div className="runtime-child-list">{items.map(child => <details className="runtime-data" key={child.run.id}><summary><span>{child.run.workflowName} · {child.taskId}</span><RuntimeStatus run={child.run}/></summary><p className="field-help">하위 실행 ID: {child.run.id}</p><p className="field-help">모델 {child.run.usage.turns}회 · 도구 {child.run.usage.toolCalls}회 · 토큰 {child.run.usage.tokens.toLocaleString()}개</p>{child.run.error&&<p className="form-error">{child.run.error}</p>}{child.run.result&&<pre>{child.run.result}</pre>}{!!child.run.children?.length&&<ChildRunList items={child.run.children}/>}</details>)}</div>;
}

function SupplementalInput({ request: pending, enabled, busy, onSubmit }: { request: NonNullable<PublicRun["inputRequests"]>[number]; enabled: boolean; busy: boolean; onSubmit: (values: Record<string, Json>) => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const set = (key: string, value: string) => setValues(current => ({ ...current, [key]: value }));
  return <section className="runtime-approval"><div><h3>{pending.status === "pending" ? "보완 입력을 기다리고 있어요" : "제출한 보완 입력"}</h3><span className="neutral-badge">{enabled ? "테스트 실행" : "내보낸 실행기에서 입력"}</span></div><p>{pending.instructions || "다음 작업에 필요한 정보를 입력해 주세요."}</p><p className="field-help">입력 요청 ID: {pending.id} · 블록: {pending.nodeId}</p><details className="runtime-data"><summary>입력 요청 당시의 내용</summary><pre>{JSON.stringify(pending.input, null, 2)}</pre></details><small>입력 유효 기간: {formatDate(pending.expiresAt)}</small>
    {pending.status === "submitted" ? <><pre>{JSON.stringify(pending.output?.data ?? pending.output, null, 2)}</pre><p className="field-help">입력을 저장했어요. ‘저장된 단계에서 재개’를 누르면 이어갑니다.</p></> : enabled ? <form onSubmit={event => { event.preventDefault(); const data: Record<string, Json> = {}; for (const field of pending.fields) { const value = values[field.key] ?? ""; if (!value && !field.required) continue; data[field.key] = field.type === "number" ? Number(value) : field.type === "boolean" ? value === "true" : value; } void onSubmit(data); }}>
      {pending.fields.map(field => <label className="field-label" key={field.key}>{field.label}{field.required ? " (필수)" : " (선택)"}{field.type === "select" || field.type === "boolean" ? <select required={field.required} value={values[field.key] ?? ""} disabled={busy} onChange={event => set(field.key, event.target.value)}><option value="">선택해 주세요</option>{field.type === "boolean" ? <><option value="true">예</option><option value="false">아니요</option></> : field.options?.map(option => <option key={option} value={option}>{option}</option>)}</select> : <input type={field.type === "date" ? "date" : field.type === "number" ? "number" : "text"} step={field.type === "number" ? "any" : undefined} required={field.required} maxLength={12000} value={values[field.key] ?? ""} disabled={busy} onChange={event => set(field.key, event.target.value)} />}{field.type === "file" && <small className="field-help">내보낸 프로젝트의 inputs/ 아래 상대 파일명을 입력하세요. 파일을 업로드하지 않습니다.</small>}</label>)}
      <button className="btn primary" type="submit" disabled={busy}>보완 입력 저장</button><p className="field-help">저장은 모델이나 도구를 호출하지 않아요. 입력 검증을 통과한 뒤 별도로 재개하세요.</p>
    </form> : <p className="field-help">내보낸 프로젝트에서 submit 실행ID 요청ID --values-file 보완입력.json으로 값을 저장한 뒤 resume 실행ID로 이어가세요. 웹은 실제 모델을 호출하지 않습니다.</p>}
  </section>;
}

export function RuntimeHistory({ runtime, demo, onOpen }: { runtime: RuntimeController; demo: boolean; onOpen: (id: string) => void }) {
  return <section className="runtime-history" aria-label="서버 실행 기록"><div className="runtime-section-heading"><div><h2>이전 서버 실행 기록</h2><p>기존 기록을 확인하세요. 내보낸 프로젝트의 실행 기록은 해당 프로젝트에 저장됩니다.</p></div>{!demo && <button className="btn secondary" onClick={() => void runtime.refresh()}>상태 새로고침</button>}</div>
    {runtime.error && <p className="form-error" role="alert">{runtime.error}</p>}
    {demo ? <div className="soft-note"><Icon name="info" size={17}/><p>체험 공간은 이 브라우저의 미리보기만 사용해요. 로그인하면 실행 프로젝트를 내보낼 수 있어요.</p></div> : runtime.loading ? <p role="status">실행 기록을 불러오고 있어요.</p> : runtime.runs.length ? <div className="runtime-history-list">{runtime.runs.map(run => <button className="runtime-history-row" key={run.id} onClick={() => onOpen(run.id)}><span><strong>{run.workflowName}</strong><small>{run.input}</small></span><span className="runtime-mode">{run.mode === "test" ? "테스트 실행" : "실제 실행"}</span><RuntimeStatus run={run}/><time>{formatDate(run.createdAt)}</time><Icon name="chevronRight" size={16}/></button>)}</div> : <EmptyState icon="history" title="서버 실행 기록이 없어요" description="실행 프로젝트를 내보낸 뒤 해당 폴더에서 실제 실행하고 기록을 확인하세요."/>}
  </section>;
}

export function RuntimeSettings({ capabilities, demo, error, onRefresh }: { capabilities: RuntimeCapabilities | null; demo: boolean; error: string; onRefresh: () => void }) {
  return <section className="settings-card"><header><Icon name="plug" size={21}/><div><h3>실행 프로젝트와 연결 도구</h3><p>내보낸 프로젝트에서 사용할 수 있는 도구 정의예요.</p></div><span className="neutral-badge">내 환경에서 실행</span></header><div className="runtime-settings-body">
    <p>웹에서는 워크플로를 설계하고 Node.js 또는 Python 프로젝트로 내보내요. OpenAI API 키와 필요한 서비스 토큰은 다운로드한 프로젝트의 .env에 직접 설정하세요.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {demo && <p>로그인하면 현재 계정이 사용할 수 있는 연결 목록을 확인할 수 있어요.</p>}
    {capabilities?.connections.map(connection => <article className="runtime-connection" key={`${connection.resourceId}:${connection.id}`}><div><strong>{connection.name}</strong><span className="neutral-badge">실행 환경 설정 필요</span></div><ul>{connection.tools.map(tool => <li key={tool.toolName}><strong>{tool.name}</strong><span>{tool.effect === "write" ? "변경 작업 · 승인 필요" : "읽기 전용"}</span><p>{tool.description}</p></li>)}</ul></article>)}
    <p className="field-help">‘도구 및 자료’에서 사내 MCP 주소와 실행할 도구를 등록·수정하세요. 목록은 사용할 수 있는 정의이며 실제 연결 성공을 뜻하지 않아요. 공유에는 외부 계정 권한이 포함되지 않습니다. 주소와 토큰 값은 내보낸 폴더의 .env에 설정하세요.</p>
    {!demo && <button className="btn secondary" onClick={onRefresh}>도구 목록 새로고침</button>}
  </div></section>;
}

export function RuntimeDialog({ runtime, workflow, selectedId, onSelect, onClose }: { runtime: RuntimeController; workflow: Workflow; selectedId: string | null; onSelect: (id: string | null) => void; onClose: () => void }) {
  const [mode, setMode] = useState<"test" | "live">("test");
  const [input, setInput] = useState("우리 팀의 휴가 신청 절차를 알려주세요.");
  const [error, setError] = useState("");
  const run = runtime.runs.find(item => item.id === selectedId);
  const enabled = mode === "test" ? runtime.capabilities?.testEnabled : runtime.capabilities?.liveEnabled;
  async function action(name: RuntimeAction, extra: Record<string, unknown> = {}) {
    if (!run) return;
    setError("");
    try { await runtime.act(name, run.id, extra); } catch (e) { setError((e as Error).message); }
  }
  async function start() {
    if (!input.trim()) { setError("실행할 질문을 입력해 주세요."); return; }
    setError("");
    try { onSelect((await runtime.start(workflow, input, mode)).id); } catch (e) { setError((e as Error).message); }
  }
  return <Modal title={run ? `${run.mode === "test" ? "테스트" : "실제"} 실행 상세` : "워크플로 실행"} wide onClose={onClose}>
    <div className="modal-body runtime-body">{!run ? <>
      <div className="runtime-modes" role="group" aria-label="실행 방식"><button aria-pressed={mode === "test"} onClick={() => setMode("test")} disabled={runtime.busy}><Icon name="workflow" size={18}/><strong>테스트 실행</strong><small>외부 API 호출 없음</small></button><button aria-pressed={mode === "live"} onClick={() => setMode("live")} disabled={runtime.busy}><Icon name="sparkles" size={18}/><strong>실제 실행</strong><small>{runtime.capabilities?.liveEnabled ? "외부 서비스 사용" : "연결 필요"}</small></button></div>
      <div className="run-notice"><span><Icon name="info" size={16}/><b>{mode === "test" ? "테스트 응답으로 실행 흐름 확인" : "실제 AI와 서비스 사용"}</b></span><p>{mode === "test" ? "정해진 테스트 모델과 도구로 실행합니다. 결과는 실제 AI가 만든 답변이 아니며 외부 API를 호출하지 않습니다." : runtime.capabilities?.liveEnabled ? "선택한 도구와 외부 AI 모델을 호출하며 사용 요금이 발생할 수 있어요. 변경 작업은 승인한 후 실행됩니다." : runtime.capabilities?.liveReason || "모델과 서비스 연결이 설정되지 않았어요. 설정에서 연결 상태를 확인해 주세요."}</p></div>
      {mode === "test" && runtime.capabilities && !runtime.capabilities.testEnabled && <p className="form-error">이 환경에서는 테스트 실행을 사용할 수 없어요. 서버의 테스트 실행 설정을 확인해 주세요.</p>}
      {runtime.error && <p className="form-error" role="alert">{runtime.error}</p>}
      <label className="field-label">AI에게 어떤 일을 맡길까요?<textarea value={input} onChange={event => setInput(event.target.value)} rows={4} maxLength={12000} disabled={runtime.busy}/></label><div className="run-summary"><Icon name="workflow" size={17}/><span>{workflow.name}</span><span>{workflow.definition.nodes.length}개 블록</span></div><p className="field-help">지금 편집한 구성과 자료 버전으로 실행을 시작해요. 시작 후 편집해도 진행 중 실행은 바뀌지 않습니다.</p>
    </> : <>
      <div className="runtime-detail-heading"><RuntimeStatus run={run}/><span>{formatDate(run.createdAt)}</span></div>
      {run.mode === "test" && <div className="run-notice"><span><Icon name="info" size={16}/><b>테스트 실행 · 외부 API 호출 없음</b></span><p>정해진 테스트 모델과 도구의 응답입니다. 실제 AI가 생성한 답변이 아닙니다.</p></div>}
      <h3 className="run-section-title">{run.workflowName}</h3><details className="runtime-data"><summary>입력한 질문</summary><pre>{run.input}</pre></details>
      <div className="runtime-usage"><span>모델 판단 <strong>{run.usage.turns} / {run.limits.maxTurns}회</strong></span><span>도구 사용 <strong>{run.usage.toolCalls} / {run.limits.maxToolCalls}회</strong></span><span>{run.mode === "test" ? "테스트 토큰" : "사용 토큰"}<strong>{run.usage.tokens.toLocaleString()} / {run.limits.maxTokens.toLocaleString()}</strong></span><span>활성 시간 <strong>{(run.usage.activeMs / 1000).toFixed(1)} / {run.limits.maxDurationMs / 1000}초</strong></span></div>
      {run.error && <div className="form-error multiline" role="alert"><Icon name="alert" size={17}/><span>{run.error}</span></div>}
      {run.status === "unknown_outcome" && <p className="soft-note">외부 서비스에서 작업이 처리되었는지 확인이 필요해요. 중복 변경을 막기 위해 자동으로 다시 실행하지 않습니다.</p>}
      {run.status === "waiting_review" && <div className="soft-note"><Icon name="users" size={17}/><p>사람 검토를 기다리고 있어요. 내보낸 실행기의 status 명령으로 내용을 확인하고 accept 또는 reject 후 resume으로 이어가세요. 웹에서는 실제 실행을 진행하지 않아요.</p></div>}
      {run.reviews?.map(review=><section className="runtime-approval" key={review.id}><div><h3>{review.status==="pending"?"사람 검토 대기":review.status==="accepted"?"수락한 검토":"거절한 검토"}</h3><span className="neutral-badge">로컬 실행기에서 결정</span></div><p className="field-help">검토 ID: {review.id} · 블록: {review.nodeId}</p><pre>{JSON.stringify(review.output??review.input,null,2)}</pre><small>검토 유효 기간: {formatDate(review.expiresAt)}</small><p className="field-help">내보낸 프로젝트의 status에서 검토 ID를 확인하고 accept 또는 reject로 결정한 뒤 resume을 실행하세요.</p></section>)}
      {run.status === "waiting_input" && <div className="soft-note"><Icon name="braces" size={17}/><p>추가 정보를 기다리는 동안 실행 상태와 완료한 작업을 보관해요. 입력을 저장한 뒤 같은 실행을 재개하세요.</p></div>}
      {run.inputRequests?.map(pending => <SupplementalInput key={pending.id} request={pending} enabled={run.mode === "test" && run.status === "waiting_input"} busy={runtime.busy} onSubmit={values => action("input.submit", { requestId: pending.id, values })} />)}
      {!!run.children?.length&&<><h3 className="run-section-title">하위 작업 상태</h3><ChildRunList items={run.children}/></>}
      {run.approvals.map(approval => <section className="runtime-approval" key={approval.id}><div><h3>{approval.status === "pending" ? "변경 작업을 승인해 주세요" : approval.status === "approved" ? "승인한 작업" : "거절한 작업"}</h3><span className="warning-badge">{approval.effect === "write" ? "변경 작업" : "읽기 작업"}</span></div><p><strong>도구: {approval.toolName}</strong></p><p>아래 내용 그대로 실행할지 확인해 주세요. 승인 후에도 자료와 연결 권한을 다시 확인합니다.</p><pre>{JSON.stringify(approval.args, null, 2)}</pre><small>승인 유효 기간: {formatDate(approval.expiresAt)}</small>{approval.status === "pending" && run.status === "waiting_approval" && <div className="runtime-approval-actions"><button className="btn secondary" disabled={runtime.busy} onClick={() => void action("approval.decide", { approvalId: approval.id, decision: "deny" })}>거절</button><button className="btn primary" disabled={runtime.busy} onClick={() => void action("approval.decide", { approvalId: approval.id, decision: "approve" })}>이 내용으로 승인</button></div>}</section>)}
      <h3 className="run-section-title">실행 기록</h3><ol className="runtime-events">{run.events.map(event => <li key={event.sequence}><span>{event.sequence}</span><div><p>{event.message}</p><time>{formatDate(event.at)}</time>{event.data !== undefined && <details className="runtime-data"><summary>입력 · 결과 보기</summary><pre>{JSON.stringify(event.data, null, 2)}</pre></details>}</div></li>)}</ol>
      {run.result && <><h3 className="run-section-title">{run.mode === "test" ? "테스트 결과" : "실행 결과"}</h3><pre className="result-content">{run.result}</pre></>}
      <p className="field-help">화면을 닫아도 실행 기록과 승인·검토·입력 대기는 서버에 보관돼요. 진행이 멈췄다면 저장된 단계에서 재개할 수 있습니다.</p>
    </>}{error && <div className="form-error multiline" role="alert"><Icon name="alert" size={17}/><span>{error}</span></div>}</div>
    <footer className="modal-footer runtime-footer"><button className="btn secondary" onClick={onClose}>닫기</button>{run ? <>{["queued", "running", "waiting_approval", "waiting_review", "waiting_input"].includes(run.status) && <button className="btn secondary" disabled={runtime.busy} onClick={() => void action("run.cancel")}>실행 취소</button>}{["queued", "running"].includes(run.status) && <button className="btn primary" disabled={runtime.busy} onClick={() => void action("run.resume")}>저장된 단계에서 재개</button>}<button className="btn secondary" onClick={() => void runtime.refresh()} disabled={runtime.busy}>상태 새로고침</button></> : <button className="btn primary" onClick={() => void start()} disabled={runtime.busy || !enabled}><Icon name={runtime.busy ? "loader" : "play"} size={16} className={runtime.busy ? "spin" : ""}/>{runtime.busy ? "실행 요청 중…" : mode === "test" ? "테스트 실행" : "실제 실행"}</button>}</footer>
  </Modal>;
}
