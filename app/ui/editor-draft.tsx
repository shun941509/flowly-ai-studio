"use client";
import { useEffect, useRef, useState } from 'react';
import { decodeEditorDraft, draftKey, draftPrefix, encodeEditorDraft, type EditorDraft } from '../../domain/editor-composition';
import { uid, type Workflow } from '../lib/model';

export function clearEditorDraft(userId:string,workflowId:string){try{sessionStorage.removeItem(draftKey(userId,workflowId));}catch{/* Saving remains possible with storage disabled. */}}
export function EditorDraftRecovery({userId,workflow,workflows,dirty,onRestore}:{userId:string;workflow:Workflow;workflows:Workflow[];dirty:boolean;onRestore:(workflow:Workflow)=>void}){
 const [pending,setPending]=useState<EditorDraft|null>(null),[status,setStatus]=useState(''),[readyScope,setReadyScope]=useState(''),scanned=useRef(''),dismissed=useRef(new Set<string>());
 useEffect(()=>{
  const scope=`${userId}:${workflow.id}`;if(scanned.current===scope)return;
  const timer=setTimeout(()=>{scanned.current=scope;setReadyScope(scope);try{
   const drafts:EditorDraft[]=[];
   for(let i=0;i<sessionStorage.length;i++){const key=sessionStorage.key(i);if(!key?.startsWith(draftPrefix(userId)))continue;try{const value=decodeEditorDraft(sessionStorage.getItem(key)??'',userId);if(!dismissed.current.has(value.workflow.id))drafts.push(value);}catch{/* A malformed or stale draft never replaces the document. */}}
   drafts.sort((a,b)=>Number(b.workflow.id===workflow.id)-Number(a.workflow.id===workflow.id)||b.savedAt.localeCompare(a.savedAt));
   const candidate=drafts.find(item=>JSON.stringify(item.workflow)!==JSON.stringify(workflow));
   if(candidate)setPending(candidate);
  }catch{setStatus('이 브라우저에서 초안을 보관할 수 없어요. 저장 또는 JSON 내보내기를 사용하세요.');}},0);
  return()=>clearTimeout(timer);
 },[userId,workflow]);
 useEffect(()=>{
  if(!dirty||pending||readyScope!==`${userId}:${workflow.id}`)return;
  const timer=setTimeout(()=>{try{sessionStorage.setItem(draftKey(userId,workflow.id),encodeEditorDraft(userId,workflow));setStatus('현재 탭에 편집 초안 보관 중 · 서버 저장은 저장 버튼을 사용하세요.');}catch(error){setStatus(error instanceof Error?error.message:'초안 보관에 실패했어요. 저장 또는 JSON으로 보관하세요.');}},650);
  return()=>clearTimeout(timer);
 },[userId,workflow,dirty,pending,readyScope]);
 useEffect(()=>{
  const flush=()=>{if(!dirty||pending||readyScope!==`${userId}:${workflow.id}`)return;try{sessionStorage.setItem(draftKey(userId,workflow.id),encodeEditorDraft(userId,workflow));}catch{/* The existing leave warning and manual save remain available. */}};
  window.addEventListener('beforeunload',flush);window.addEventListener('pagehide',flush);
  return()=>{window.removeEventListener('beforeunload',flush);window.removeEventListener('pagehide',flush);};
 },[userId,workflow,dirty,pending,readyScope]);
 if(!pending)return status&&dirty?<div className="editor-draft-status" role="status">{status}</div>:null;
 const saved=workflows.find(w=>w.id===pending.workflow.id),conflict=!!saved&&saved.updatedAt!==pending.workflow.updatedAt;
 return <div className="editor-draft-banner" role="status"><span><strong>보관된 초안: {pending.workflow.name}</strong><br/>{conflict?'저장 원본이 바뀌었어요. 원본을 덮어쓰지 않고 새 복사본으로 복구합니다.':'새로고침 전에 작성한 내용을 복구할 수 있어요. 서버에는 아직 저장하지 않아요.'}{dirty&&' 현재 편집을 먼저 저장한 뒤 복구하세요.'}</span><button className="btn secondary" disabled={dirty} onClick={()=>{dismissed.current.add(pending.workflow.id);const restored=conflict?{...pending.workflow,id:uid('flow'),name:`${pending.workflow.name.slice(0,71)} 복구 사본`,updatedAt:''}:pending.workflow;if(conflict)clearEditorDraft(userId,pending.workflow.id);setPending(null);onRestore(restored);}}>초안 복구</button><button className="text-btn" onClick={()=>{dismissed.current.add(pending.workflow.id);clearEditorDraft(userId,pending.workflow.id);setPending(null);}}>보관 초안 삭제</button></div>;
}
