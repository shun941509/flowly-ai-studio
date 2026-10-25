"use client";

import { useCallback, useEffect, useState } from "react";
import type { Definition, Identity, Resource, Workflow } from "../lib/model";
import { Icon, Modal, formatDate } from "./common";

export class StudioRequestError extends Error {
  constructor(message:string,readonly status:number,readonly current?:Workflow|Resource){super(message);}
}
export async function studioRequest<T>(action:string,body:Record<string,unknown>={}):Promise<T>{
  const response=await fetch("/api/studio",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,...body})});
  const value=await response.json() as T & {error?:string;current?:Workflow|Resource};
  if(!response.ok)throw new StudioRequestError(value.error||"요청을 처리하지 못했어요.",response.status,value.current);
  return value as T;
}

export type PublishedVersion={id:string;workflowId:string;number:number;name:string;description:string;definition:Definition;createdAt:string};
type VersionSummary=Omit<PublishedVersion,"definition">;
type WorkflowDiff={nameChanged:boolean;descriptionChanged:boolean;nodes:{added:string[];removed:string[];changed:{id:string;title:string;fields:string[]}[]};edges:{added:string[];removed:string[];changed:string[]};changes:{path:string;before:unknown;after:unknown}[];truncated:boolean};
type AuditEntry={id:string;action:string;actorId:string;createdAt:string;metadata:unknown};
type CommentEntry={id:string;authorId:string;authorName:string;text:string;createdAt:string;canDelete:boolean};
const message=(e:unknown)=>e instanceof Error?e.message:"요청을 처리하지 못했어요.";

export function WorkflowVersionsDialog({workflow,dirty,onClose,onRestore,onExport}:{workflow:Workflow;dirty:boolean;onClose:()=>void;onRestore:(workflow:Workflow)=>void;onExport:(version:PublishedVersion)=>void}){
  const [versions,setVersions]=useState<VersionSummary[]>([]),[selected,setSelected]=useState(""),[version,setVersion]=useState<PublishedVersion|null>(null);
  const [compareTo,setCompareTo]=useState(""),[diff,setDiff]=useState<WorkflowDiff|null>(null);
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [restoreConfirm,setRestoreConfirm]=useState(false);
  const load=useCallback(async()=>{
    setLoading(true);setError("");
    try{const data=await studioRequest<{versions:VersionSummary[]}>("workflow.versions",{id:workflow.id});setVersions(data.versions);setSelected(id=>data.versions.some(v=>v.id===id)?id:data.versions[0]?.id||"");}
    catch(e){setError(message(e));}finally{setLoading(false);}
  },[workflow.id]);
  useEffect(()=>{const timer=setTimeout(()=>void load(),0);return()=>clearTimeout(timer);},[load]);
  useEffect(()=>{let active=true;if(selected)void studioRequest<{version:PublishedVersion}>("workflow.version",{id:workflow.id,versionId:selected}).then(data=>{if(active)setVersion(data.version);}).catch(e=>{if(active)setError(message(e));});return()=>{active=false;};},[workflow.id,selected]);
  async function publish(){
    setBusy(true);setError("");setNotice("");
    try{const data=await studioRequest<{version:PublishedVersion}>("workflow.publish",{id:workflow.id,baseUpdatedAt:workflow.updatedAt});setVersions(list=>[data.version,...list]);setSelected(data.version.id);setVersion(data.version);setDiff(null);setNotice(`버전 ${data.version.number}을 발행했어요.`);}
    catch(e){setError(message(e));}finally{setBusy(false);}
  }
  async function compare(){
    setBusy(true);setError("");setDiff(null);
    try{const data=await studioRequest<{diff:WorkflowDiff}>("workflow.diff",{id:workflow.id,fromVersionId:selected,...(compareTo?{toVersionId:compareTo}:{})});setDiff(data.diff);}
    catch(e){setError(message(e));}finally{setBusy(false);}
  }
  async function restore(){
    setBusy(true);setError("");
    try{const data=await studioRequest<{workflow:Workflow}>("workflow.restore",{id:workflow.id,versionId:selected,baseUpdatedAt:workflow.updatedAt});onRestore(data.workflow);onClose();}
    catch(e){setError(message(e));setRestoreConfirm(false);}finally{setBusy(false);}
  }
  return <Modal title="발행 버전 관리" wide onClose={()=>{if(!busy)onClose();}}>
    <div className="modal-body operations-body">
      <p className="form-intro">저장한 구성을 번호가 있는 버전으로 보관하세요. 발행본은 바뀌지 않으며, 복원하면 현재 편집본이 선택한 버전의 내용으로 저장됩니다.</p>
      <div className="operations-heading"><strong>{workflow.name}</strong><button className="btn primary" disabled={busy||loading||dirty} onClick={()=>void publish()}><Icon name="layers" size={15}/>현재 저장본 발행</button></div>
      {dirty&&<p className="soft-note">저장하지 않은 변경이 있어요. 먼저 저장한 다음 발행하거나 복원해 주세요. 아래 비교의 ‘현재 저장본’에는 저장하지 않은 내용이 포함되지 않아요.</p>}
      {loading?<p role="status">발행 버전을 불러오는 중이에요.</p>:versions.length===0?<p className="operations-empty">아직 발행한 버전이 없어요. 현재 저장본을 발행해 첫 버전을 만들 수 있어요.</p>:<>
        <label className="field-label">기준 발행 버전<select value={selected} disabled={busy} onChange={e=>{setSelected(e.target.value);setVersion(null);setCompareTo("");setDiff(null);setRestoreConfirm(false);}}>{versions.map(v=><option key={v.id} value={v.id}>버전 {v.number} · {v.name} · {formatDate(v.createdAt)}</option>)}</select></label>
        {version&&<div className="version-summary"><span>버전 {version.number}</span><strong>{version.name}</strong><p>{version.description||"설명 없음"}</p><small>{version.definition.nodes.length}개 블록 · {version.definition.edges.length}개 연결 · {formatDate(version.createdAt)}</small></div>}
        <div className="operations-compare"><label className="field-label">비교할 구성<select value={compareTo} disabled={busy} onChange={e=>{setCompareTo(e.target.value);setDiff(null);}}><option value="">현재 저장본</option>{versions.filter(v=>v.id!==selected).map(v=><option key={v.id} value={v.id}>버전 {v.number} · {v.name}</option>)}</select></label><button className="btn secondary" disabled={busy||!version} onClick={()=>void compare()}><Icon name="branch" size={15}/>변경 내용 비교</button></div>
        {diff&&<section className="version-diff" aria-label="버전 변경 내용"><p>이름 {diff.nameChanged?"변경됨":"같음"} · 설명 {diff.descriptionChanged?"변경됨":"같음"}</p>{(["nodes","edges"] as const).map(key=><div key={key}><h4>{key==="nodes"?"블록":"연결선"}</h4>{(["added","removed","changed"] as const).map(kind=><p key={kind}><b>{kind==="added"?"추가":kind==="removed"?"삭제":"변경"} {diff[key][kind].length}개</b>{diff[key][kind].length>0&&<span>{diff[key][kind].map(item=>typeof item==="string"?(key==="nodes"?(version?.definition.nodes.find(n=>n.id===item)||workflow.definition.nodes.find(n=>n.id===item))?.title||item:item):`${item.title} (${item.fields.join(", ")})`).join(", ")}</span>}</p>)}</div>)}{diff.changes.length>0&&<details><summary>항목별 이전·이후 값 확인</summary>{diff.changes.map((change,index)=><div key={index}><strong>{change.path}</strong><pre>{JSON.stringify({이전:change.before,이후:change.after},null,2)}</pre></div>)}</details>}{diff.truncated&&<p className="field-help">차이가 많아 일부 항목만 표시했어요.</p>}</section>}
        <div className="operations-actions"><button className="btn secondary" disabled={busy||!version} onClick={()=>{if(version)onExport(version);}}><Icon name="download" size={15}/>선택한 버전 내보내기</button><button className="btn secondary" disabled={busy||dirty||!version} onClick={()=>setRestoreConfirm(true)}><Icon name="undo" size={15}/>선택한 버전으로 복원</button></div>
        {restoreConfirm&&<div className="operation-confirm" role="alert"><p>현재 저장본을 버전 {version?.number}의 내용으로 바꿀까요? 현재 내용도 보관하려면 먼저 발행해 두세요.</p><div className="operations-actions"><button className="btn secondary" disabled={busy} onClick={()=>setRestoreConfirm(false)}>취소</button><button className="btn primary" disabled={busy} onClick={()=>void restore()}>이 버전으로 복원하고 저장</button></div></div>}
      </>}
      {notice&&<p className="success-badge" role="status">{notice}</p>}
      {error&&<p className="form-error" role="alert">{error}</p>}
    </div><footer className="modal-footer"><button className="btn secondary" disabled={busy||loading} onClick={()=>void load()}>새로고침</button><button className="btn secondary" disabled={busy} onClick={onClose}>닫기</button></footer>
  </Modal>;
}

const auditLabels:Record<string,string>={"workflow.create":"워크플로 생성","workflow.save":"워크플로 저장","workflow.update":"워크플로 수정","workflow.publish":"버전 발행","workflow.restore":"버전 복원","workflow.delete":"워크플로 삭제","resource.create":"자료 등록","resource.update":"자료 수정","resource.delete":"자료 삭제","comment.create":"댓글 작성","comment.delete":"댓글 삭제","workflow.export":"실행 프로젝트 내보내기"};
export function AuditDialog({targetType,id,name,onClose}:{targetType:"workflow"|"resource";id:string;name:string;onClose:()=>void}){
  const [events,setEvents]=useState<AuditEntry[]>([]),[error,setError]=useState(""),[loading,setLoading]=useState(true);
  const load=useCallback(async()=>{setLoading(true);setError("");try{const data=await studioRequest<{events:AuditEntry[]}>("audit.list",{targetType,id});setEvents(data.events);}catch(e){setError(message(e));}finally{setLoading(false);}},[targetType,id]);
  useEffect(()=>{const timer=setTimeout(()=>void load(),0);return()=>clearTimeout(timer);},[load]);
  return <Modal title="변경 감사 이력" wide onClose={onClose}><div className="modal-body operations-body"><p className="form-intro">‘{name}’의 저장·발행·공유 변경 같은 관리 작업을 확인하세요. 실행 중 도구 호출은 실행 기록에서 확인할 수 있어요.</p>{loading?<p role="status">이력을 불러오는 중이에요.</p>:events.length?<ol className="audit-list">{events.map(event=><li key={event.id}><Icon name="history" size={17}/><div><strong>{auditLabels[event.action]||event.action}</strong><small>{event.actorId} · {formatDate(event.createdAt)}</small>{event.metadata!=null&&<details><summary>변경 정보</summary><pre>{JSON.stringify(event.metadata,null,2)}</pre></details>}</div></li>)}</ol>:<p className="operations-empty">기록된 변경이 없어요. 감사 기능이 적용된 이후의 작업부터 표시됩니다.</p>}{error&&<p className="form-error" role="alert">{error}</p>}</div><footer className="modal-footer"><button className="btn secondary" disabled={loading} onClick={()=>void load()}>새로고침</button><button className="btn secondary" onClick={onClose}>닫기</button></footer></Modal>;
}

export function ResourceComments({resource,user}:{resource:Resource;user:Identity}){
  const [comments,setComments]=useState<CommentEntry[]>([]),[text,setText]=useState(""),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(""),[deleteId,setDeleteId]=useState<string|null>(null);
  const load=useCallback(async()=>{setLoading(true);setError("");try{const data=await studioRequest<{comments:CommentEntry[]}>("resource.comments",{id:resource.id});setComments(data.comments);}catch(e){setError(message(e));}finally{setLoading(false);}},[resource.id]);
  useEffect(()=>{const timer=setTimeout(()=>void load(),0);return()=>clearTimeout(timer);},[load]);
  async function add(){setBusy(true);setError("");try{const data=await studioRequest<{comment:CommentEntry}>("comment.create",{id:resource.id,text:text.trim()});setComments(list=>[...list,data.comment]);setText("");}catch(e){setError(message(e));}finally{setBusy(false);}}
  async function remove(id:string){setBusy(true);setError("");try{await studioRequest("comment.delete",{id:resource.id,commentId:id});setComments(list=>list.filter(c=>c.id!==id));setDeleteId(null);}catch(e){setError(message(e));}finally{setBusy(false);}}
  return <section className="resource-comments" aria-label="자료 댓글"><div className="operations-heading"><h4>함께 나누는 의견</h4><button className="text-btn" disabled={busy||loading} onClick={()=>void load()}>새로고침</button></div><p className="field-help">이 자료를 볼 수 있는 사용자가 댓글을 남길 수 있어요. API 키나 개인 정보를 적지 마세요.</p>{loading?<p role="status">댓글을 불러오는 중이에요.</p>:comments.length?<ol className="comment-list">{comments.map(comment=><li key={comment.id}><div><strong>{comment.authorName|| (comment.authorId===user.userId?"나":"공유 사용자")}</strong><time>{formatDate(comment.createdAt)}</time></div><p>{comment.text}</p>{comment.canDelete&&<div className="comment-actions">{deleteId===comment.id?<><span>이 댓글을 삭제할까요?</span><button className="text-btn danger-text" disabled={busy} onClick={()=>void remove(comment.id)}>삭제 확인</button><button className="text-btn" disabled={busy} onClick={()=>setDeleteId(null)}>취소</button></>:<button className="text-btn" disabled={busy} onClick={()=>setDeleteId(comment.id)}>삭제</button>}</div>}</li>)}</ol>:<p className="operations-empty">아직 댓글이 없어요.</p>}<label className="field-label">댓글<textarea rows={3} maxLength={2000} value={text} disabled={busy} onChange={e=>setText(e.target.value)} placeholder="자료에 관한 질문이나 수정 의견을 남겨 주세요."/></label><div className="operations-actions"><small>{text.length}/2,000자</small><button className="btn secondary" disabled={busy||!text.trim()} onClick={()=>void add()}><Icon name="message" size={15}/>댓글 등록</button></div>{error&&<p className="form-error" role="alert">{error}</p>}</section>;
}

export function WorkflowConflictDialog({draft,current,onClose,onOpenCurrent,onSaveCopy}:{draft:Workflow;current:Workflow|null;onClose:()=>void;onOpenCurrent:()=>void;onSaveCopy:()=>Promise<void>}){
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  return <Modal title="다른 곳에서 변경된 워크플로예요" wide onClose={()=>{if(!busy)onClose();}}><div className="modal-body operations-body"><p className="form-intro">이 화면의 편집 내용은 그대로 남아 있어요. 다른 곳에서 저장한 내용을 자동으로 덮어쓰지 않았습니다. 내 편집본을 새 워크플로로 저장하거나 최신 저장본을 확인하세요.</p><div className="conflict-columns"><section><h3>내 편집본</h3><strong>{draft.name}</strong><p>{draft.definition.nodes.length}개 블록 · {draft.definition.edges.length}개 연결</p></section><section><h3>최신 저장본</h3>{current?<><strong>{current.name}</strong><p>{current.definition.nodes.length}개 블록 · {current.definition.edges.length}개 연결 · {formatDate(current.updatedAt)}</p><details><summary>최신 구성 확인</summary><pre>{JSON.stringify(current.definition,null,2)}</pre></details></>:<p>최신 내용을 불러오지 못했어요. 편집본을 먼저 보관한 뒤 다시 시도해 주세요.</p>}</section></div>{error&&<p className="form-error" role="alert">{error}</p>}</div><footer className="modal-footer operations-actions"><button className="btn secondary" disabled={busy} onClick={onClose}>계속 편집</button><button className="btn secondary" disabled={busy||!current} onClick={onOpenCurrent}>내 변경을 버리고 최신본 열기</button><button className="btn primary" disabled={busy} onClick={async()=>{setBusy(true);setError("");try{await onSaveCopy();onClose();}catch(e){setError(message(e));}finally{setBusy(false);}}}>내 편집본을 새로 저장</button></footer></Modal>;
}
