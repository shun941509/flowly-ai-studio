"use client";
/**
 * 내 설계·공유 설계 목록과 소유자의 공유 설정 화면. 서버가 반환한 access를 표시하며 최종 권한은 각 API가 다시 검사한다.
 */

import { useState, type ReactNode } from "react";
import type { Identity, Workflow } from "../lib/model";
import { EmptyState, Icon, IconButton, MiniFlow, Modal, formatDate } from "./common";
import { studioRequest } from "./operations";

/** 수정 권한에 읽기 권한이 포함되는 정책을 목록의 읽기 범위 문구에도 반영한다. */
export const readScopeLabel = (workflow: Workflow) => workflow.visibility === "public" ? "전체 로그인 사용자" : workflow.visibility === "selected" ? "지정 사용자" : workflow.editScope === "selected" || workflow.editEmails?.length ? "나와 지정 편집자" : "나만";
/** 소유·지정 공유·공동 편집·전체 공개 설계를 화면별로 나눈다. 공동 편집자의 블록 수정과 워크플로 삭제 권한은 구분한다. */
export function WorkflowList({ workflows, user, shared, actions, onOpen, onCopy, onDelete, onShare }: { workflows: Workflow[]; user: Identity; shared: boolean; actions?: ReactNode; onOpen: (workflow: Workflow) => void; onCopy: (workflow: Workflow) => void; onDelete: (workflow: Workflow) => void; onShare: (workflow: Workflow) => void }) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"received" | "edit" | "public">("received");
  const shown = workflows.filter(workflow => {
    const owned = !workflow.ownerId || workflow.ownerId === user.userId;
    if (!shared) return owned;
    if (tab === "public") return workflow.visibility === "public";
    if (tab === "edit") return !owned && workflow.access?.canEdit;
    return !owned && workflow.visibility !== "public";
  }).filter(workflow => workflow.name.toLowerCase().includes(query.toLowerCase()));
  return <section className="page-content workflow-list"><header className="page-heading"><div><span className="eyebrow">{shared ? "WORK TOGETHER" : "BUILT BY YOU"}</span><h1>{shared ? "공유 워크플로" : "내 워크플로"}</h1><p>{shared ? "현재 읽기·수정 권한이 있는 설계예요. 연결된 자료는 별도 권한이 필요합니다." : "원본을 유지하면서 공유하거나 내 사본을 만들 수 있어요."}</p></div>{actions && <div className="page-heading-actions">{actions}</div>}</header>
    {shared && <div className="filter-tabs" role="group" aria-label="공유 목록"><button aria-pressed={tab === "received"} className={tab === "received" ? "active" : ""} onClick={() => setTab("received")}>나에게 공유됨</button><button aria-pressed={tab === "edit"} className={tab === "edit" ? "active" : ""} onClick={() => setTab("edit")}>함께 편집</button><button aria-pressed={tab === "public"} className={tab === "public" ? "active" : ""} onClick={() => setTab("public")}>전체 공개</button></div>}
    <div className="list-controls"><label className="search-field"><Icon name="search" size={17}/><input aria-label="워크플로 검색" placeholder="워크플로 검색" value={query} onChange={e => setQuery(e.target.value)}/></label><span>{shown.length}개</span></div>
    <div className="workflow-grid">{shown.map((workflow, index) => <article className="workflow-card" key={workflow.id}><button className="workflow-open" onClick={() => onOpen(workflow)}><MiniFlow variant={index % 3}/><div><span className={`workflow-access-badge ${workflow.access?.canEdit === false ? "read-only" : "editable"}`}><Icon name={workflow.access?.canEdit === false ? "lock" : "workflow"} size={13}/>{workflow.access?.canEdit === false ? "조회 전용" : "편집 가능"}</span><h3>{workflow.name}</h3><p className="workflow-card-description">{workflow.description || "블록을 연결한 작업 설계"}</p><div className="workflow-permissions"><span>읽기 <strong>{readScopeLabel(workflow)}</strong></span><span>수정 <strong>{(workflow.editScope === "selected" || workflow.editEmails?.length) ? "지정 사용자" : workflow.access?.canEdit && workflow.ownerId !== user.userId ? "함께 편집" : "소유자"}</strong></span></div><span className="workflow-meta"><span>{formatDate(workflow.updatedAt)}</span><span>마지막 수정자 {workflow.lastModifiedName || workflow.lastModifiedBy || workflow.ownerId || user.displayName}</span></span></div></button><footer><button className="text-btn" onClick={() => onCopy(workflow)}><Icon name="copy" size={14}/>내 사본 만들기</button>{(!workflow.ownerId || workflow.ownerId === user.userId) && <><button className="text-btn" onClick={() => onShare(workflow)}>공유 설정</button><IconButton icon="trash" label={`${workflow.name} 삭제`} onClick={() => onDelete(workflow)}/></>}</footer></article>)}</div>
    {!shown.length && <EmptyState icon={shared ? "users" : "workflow"} title={query ? "검색한 워크플로가 없어요" : "표시할 워크플로가 없어요"} description={query ? "검색어를 줄이거나 다른 이름으로 찾아보세요." : shared ? "소유자에게 공유를 요청하거나 다른 공유 목록을 확인하세요." : "새 워크플로를 만들거나 예제를 복제해 시작하세요."}/>}
  </section>;
}
/** 읽기는 전체 공개를 허용하지만 수정은 지정 이메일만 받는다. baseUpdatedAt을 전송하여 오래된 공유 설정의 덮어쓰기를 막는다. */
export function WorkflowSharingDialog({ workflow, onClose, onSaved }: { workflow: Workflow; onClose: () => void; onSaved: (workflow: Workflow) => void }) {
  const [visibility, setVisibility] = useState(workflow.visibility || "private"), [readers, setReaders] = useState(workflow.readEmails?.join("\n") || ""), [editors, setEditors] = useState(workflow.editEmails?.join("\n") || ""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const emails = (text: string) => text.split(/[\s,;]+/).filter(Boolean);
  async function save() {
    setBusy(true); setError("");
    try { const result = await studioRequest<{ workflow: Workflow }>("workflow.share", { id: workflow.id, baseUpdatedAt: workflow.updatedAt, data: { visibility, readEmails: emails(readers), editEmails: emails(editors) } }); onSaved(result.workflow); onClose(); }
    catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  return <Modal title={`공유 설정 · ${workflow.name}`} onClose={onClose}><div className="modal-body workflow-sharing-form"><p>수정 권한에 읽기 권한이 포함됩니다. 삭제와 공유 관리는 소유자만 할 수 있어요. MCP·Skill·Prompt·Document의 권한과 자격 증명은 공유되지 않습니다.</p><label className="field-label">읽기 범위<select value={visibility} onChange={e => setVisibility(e.target.value as typeof visibility)}><option value="private">나만</option><option value="selected">지정 사용자</option><option value="public">전체 로그인 사용자</option></select></label>{visibility === "selected" && <label className="field-label">읽을 사용자 이메일<textarea value={readers} onChange={e => setReaders(e.target.value)} placeholder="user@company.com"/></label>}<label className="field-label">함께 수정할 사용자 이메일<textarea value={editors} onChange={e => setEditors(e.target.value)} placeholder="비워 두면 나만 수정 · 이메일을 줄바꿈으로 구분"/></label><p>전체 사용자에게 수정 권한은 부여할 수 없어요. 공유를 철회하면 다음 조회·저장·내보내기 요청부터 차단됩니다. 이미 내려받은 파일은 회수할 수 없습니다.</p>{error && <p className="error-message" role="alert">{error}</p>}</div><footer className="modal-footer"><button className="btn secondary" onClick={onClose} disabled={busy}>닫기</button><button className="btn primary" onClick={() => void save()} disabled={busy}>{busy ? "저장 중" : "공유 설정 저장"}</button></footer></Modal>;
}
