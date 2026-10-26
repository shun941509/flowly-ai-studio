"use client";
/** 외부 수정 설계·자료·파일을 명시적으로 검토한다. 가져온 코드·키·이전 실행 상태는 웹에서 실행하거나 복원하지 않는다. */
import { useMemo, useState } from "react";
import type { Resource, Workflow } from "../lib/model";
import type { ResourceAttachment } from "../../domain/resource-contract";
import { resourceFileHash } from "../../domain/resource-export";
import { Modal, FilePicker } from "./common";
import { studioRequest } from "./operations";
import { inspectWorkflow } from "../../domain/preflight";
import { importedResourceDiff, readWorkflowImport, rebindImportedWorkflow, workflowImportDiff, type ImportedResource, type ImportOrigin, type WorkflowImport } from "../../domain/workflow-import";

type Choice="keep"|"copy"|"version";
const errorText=(value:unknown)=>value instanceof Error?value.message:"파일과 현재 자료 권한을 확인해 주세요.";
const fieldNames={name:"이름",description:"설명",content:"본문",url:"출처 주소",details:"유형별 설정"};

/** 자료 저장과 설계 저장을 구분한다. 부분 성공한 자료 ID를 유지하여 재시도 때 사본을 중복 생성하지 않는다. */
export function ExternalImportDialog({current,resources,onClose,onSave,canUpdate=false,userId,onResourcesImported}:{current?:Workflow;resources:Resource[];onClose:()=>void;canUpdate?:boolean;userId?:string;onResourcesImported?:(resources:Resource[])=>void;onSave:(workflow:Workflow,mode:"copy"|"version",origin:ImportOrigin)=>Promise<void>}){
 const [imported,setImported]=useState<WorkflowImport|null>(null),[files,setFiles]=useState<File[]>([]);
 const [mapping,setMapping]=useState<Record<string,string>>({}),[choices,setChoices]=useState<Record<string,Choice>>({});
 const [saved,setSaved]=useState<Record<string,Resource>>({}),[checked,setChecked]=useState<Workflow|null>(null);
 const [error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false),[mode,setMode]=useState<"copy"|"version">("copy");
 const available=useMemo(()=>[...Object.values(saved),...resources.filter(r=>!Object.values(saved).some(s=>s.id===r.id))],[resources,saved]);
 const diff=useMemo(()=>imported?workflowImportDiff(current,imported.workflow):null,[current,imported]);
 const matchingVersion=Boolean(current&&imported?.origin.workflowId===current.id&&imported.origin.updatedAt===current.updatedAt);
 const pending=imported?.resourceChanges.filter(r=>choices[r.sourceResourceId]!=="keep"&&!saved[r.sourceResourceId])??[];
 const phase=checked?4:imported?pending.length?2:3:0;
 async function select(file:File){
  setBusy(true);setError("");setNotice("");setChecked(null);setImported(null);setMode("copy");setFiles([file]);setSaved({});
  try{const value=await readWorkflowImport(file.name,new Uint8Array(await file.arrayBuffer()));setImported(value);setMapping(Object.fromEntries(value.resourceHints.map(h=>[h.id,resources.some(r=>r.id===h.id)?h.id:""])));setChoices(Object.fromEntries(value.resourceChanges.map(r=>[r.sourceResourceId,"keep"])));}
  catch(cause){setError(errorText(cause));}finally{setBusy(false);}
 }
 async function upload(candidate:ImportedResource){
  const files:ResourceAttachment[]=[],ids=new Map<string,string>();
  for(const attachment of candidate.files){
   if(attachment.state==="missing")throw new Error("ZIP에 빠진 첨부가 있어요. 원본 파일을 복구하거나 workflow.json의 파일 목록에서 삭제한 뒤 다시 선택하세요.");
   let bytes=attachment.bytes;
   if(!bytes){const response=await fetch("/api/resource-files?id="+encodeURIComponent(attachment.file.id));if(!response.ok)throw new Error("원본 파일을 읽을 수 없어요. 현재 권한을 확인하거나 첨부가 포함된 ZIP을 선택하세요.");bytes=new Uint8Array(await response.arrayBuffer());if(bytes.byteLength!==attachment.file.size||await resourceFileHash(bytes)!==attachment.file.sha256)throw new Error("JSON의 첨부 정보가 현재 원본과 달라요. 수정한 파일이 포함된 프로젝트 ZIP을 선택하세요.");}
   const response=await fetch("/api/resource-files?path="+encodeURIComponent(attachment.file.path)+"&mimeType="+encodeURIComponent(attachment.file.mimeType),{method:"POST",headers:{"Content-Type":"application/octet-stream"},body:bytes.slice().buffer as ArrayBuffer});
   const result=await response.json() as {file?:ResourceAttachment;error?:string};if(!response.ok||!result.file)throw new Error(result.error||"첨부를 준비하지 못했어요.");
   files.push(result.file);ids.set(attachment.file.id,result.file.id);
  }
  return {files,ids};
 }
 async function applyResources(){
  if(!imported||!userId)return;setBusy(true);setChecked(null);setError("");setNotice("");let count=0;
  try{for(const candidate of pending){
   const source=resources.find(r=>r.id===candidate.sourceResourceId);if(!source)throw new Error("원본 자료에 현재 접근할 수 없어요. 다른 자료로 재연결하세요.");
   const prepared=await upload(candidate),data=structuredClone(candidate.data),choice=choices[candidate.sourceResourceId];data.files=prepared.files;
   for(const execution of data.details?.skill?.executions??[])execution.entryFileId=prepared.ids.get(execution.entryFileId)??execution.entryFileId;
   if(data.details?.document?.originalFileId)data.details.document.originalFileId=prepared.ids.get(data.details.document.originalFileId)??data.details.document.originalFileId;
   if(choice==="version"){data.visibility=source.visibility;data.allowedEmails=source.allowedEmails;}
   const result=await studioRequest<{resource:Resource}>("resource.import",{sourceResourceId:candidate.sourceResourceId,baseUpdatedAt:choice==="copy"?source.updatedAt:candidate.baseUpdatedAt,mode:choice,data});
   setSaved(values=>({...values,[candidate.sourceResourceId]:result.resource}));setMapping(values=>({...values,[candidate.sourceResourceId]:result.resource.id}));onResourcesImported?.([result.resource]);count++;
  }setNotice(`자료 ${count}개를 저장하고 새 ID로 연결했어요. 설계를 검사한 뒤 저장하세요.`);}
  catch(cause){setError(errorText(cause));if(count)setNotice(`자료 ${count}개는 저장되어 유지됩니다. 나머지를 확인하고 다시 적용하세요. 설계는 아직 저장하지 않았어요.`);}
  finally{setBusy(false);}
 }
 function validate(){if(!imported)return;setError("");try{if(pending.length)throw new Error("선택한 자료 변경을 먼저 적용하거나 현재 자료 유지로 바꿔 주세요.");const workflow=rebindImportedWorkflow(imported,mapping,available),inspection=inspectWorkflow(workflow,available);if(!inspection.canExport)throw new Error(inspection.issues.filter(i=>i.severity==="error").map(i=>i.message).join("\n"));setChecked(workflow);}catch(cause){setChecked(null);setError(errorText(cause));}}
 async function save(){if(!checked||!imported)return;setBusy(true);setError("");try{await onSave(checked,mode,imported.origin);onClose();}catch(cause){setError(errorText(cause));}finally{setBusy(false);}}
 return <Modal title="외부 AI 수정본 가져오기" size="compare" onClose={()=>{if(!busy)onClose();}}>
  <div className="modal-body import-dialog-body">
   <p className="form-intro">설계와 자료 변경을 확인하고 필요한 내용만 가져오세요. 원본을 자동으로 덮어쓰지 않아요.</p>
   <ol className="import-steps" aria-label="가져오기 진행 단계">{["파일 선택","원본·설계 비교","자료·파일 검토","재연결·검증","저장"].map((step,index)=><li key={step} aria-current={index===phase?"step":undefined} className={index<=phase?"active":""}><span>{index+1}</span>{step}</li>)}</ol>
   <FilePicker label="수정한 workflow.json 또는 프로젝트 ZIP" accept=".json,.zip" disabled={busy} files={files} onFiles={selected=>{if(selected[0])void select(selected[0]);}} help="JSON 8MB · ZIP 30MB 이하. 첨부가 바뀌었다면 ZIP을 선택하세요. 키·개인 .env·이전 실행 기록은 가져오지 않아요."/>
   {busy&&<p role="status">파일과 자료를 처리하고 있어요.</p>}
   {imported&&<>
    <div className="import-comparison-grid">
     <section className="settings-card"><h3>1. 원본·버전 확인</h3><strong>{imported.workflow.name}</strong><p>{imported.format==="web"?"웹 워크플로":"실행 프로젝트"} · {imported.origin.versionNumber?`발행 버전 ${imported.origin.versionNumber}`:"초안"} · 설계 v{imported.workflow.definition.schemaVersion||1}</p><dl><dt>원본 ID</dt><dd>{imported.origin.workflowId||"확인 불가"}</dd><dt>기준 시각</dt><dd>{imported.origin.updatedAt||"확인 불가"}</dd></dl><p>{matchingVersion?"현재 저장 버전과 일치해요.":"원본이나 기준 버전이 달라 설계는 새 사본으로 저장하세요."}</p></section>
     <section className="settings-card"><h3>2. 설계·실행기 변경</h3><p>추가 {diff?.added.length} · 제거 {diff?.removed.length} · 변경 {diff?.changed.length}</p><details><summary>블록·연결 변경 위치</summary><ul>{diff&&Object.entries(diff).flatMap(([kind,paths])=>paths.map(path=><li key={kind+path}>{kind==="added"?"추가":kind==="removed"?"제거":"변경"} · {path}</li>))}</ul></details><p>파일 비교: {imported.integrity==="unchecked"?"비교 기준 없음 / JSON만 선택":imported.integrity==="matched"?"내보낸 기준과 일치":"수정·누락 파일 있음"}</p>{imported.changedFiles.length>0&&<details><summary>바뀐 파일 {imported.changedFiles.length}개</summary><ul>{imported.changedFiles.map(path=><li key={path}>{path}</li>)}</ul></details>}{imported.codeChanges.length>0&&<p className="form-error">실행기 코드 {imported.codeChanges.length}개는 캔버스로 변환하지 않아요. 재내보내기는 표준 실행기를 사용하므로 코드 수정은 별도 검토하세요.</p>}<p className="field-help">파일 일치는 발행자 인증이나 코드 안전성·서비스 성공의 보증이 아니에요.</p></section>
    </div>
    <section className="settings-card"><h3>3. 자료·첨부 변경 확인</h3>
     {!imported.resourceChanges.length?<p>자료 확장이 없는 기존 형식이에요. 현재 자료로 재연결하며 본문은 자동으로 가져오지 않아요.</p>:imported.resourceChanges.map(candidate=>{
      const source=resources.find(r=>r.id===candidate.sourceResourceId),changes=importedResourceDiff(candidate,source),applied=saved[candidate.sourceResourceId];
      const canVersion=Boolean(userId&&source?.ownerId===userId&&source.updatedAt===candidate.baseUpdatedAt);
      return <article className="import-resource-card" key={candidate.sourceResourceId}>
       <h4>{candidate.data.name} <small>{candidate.data.type}</small></h4><p>본문·설정 {changes.fields.length}개 · 파일 변경 {changes.files.length}개 · 기준 {candidate.baseUpdatedAt}</p>
       <details><summary>자료 변경 내용과 첨부 보기</summary>{changes.fields.map(field=><div key={field}><strong>{fieldNames[field]}</strong><div className="import-text-comparison"><div><span>현재 자료</span><pre>{JSON.stringify(source?.[field]??"",null,2)}</pre></div><div><span>가져온 내용</span><pre>{JSON.stringify(candidate.data[field]??"",null,2)}</pre></div></div></div>)}<ul>{changes.files.map(file=><li key={file.path}>{file.change==="missing"?"ZIP 누락":file.change==="added"?"추가":file.change==="removed"?"삭제":"내용 수정"} · {file.path}</li>)}</ul><ul>{candidate.files.map(file=><li key={file.file.id}>{file.file.path} · {file.file.size.toLocaleString()} 바이트 · {file.state==="unavailable"?"현재 원본 조회 필요":file.state==="missing"?"파일 누락":file.state==="modified"?"내용 변경":"내보낸 바이트와 일치"}</li>)}</ul></details>
       {applied?<p className="success-badge">저장됨: {applied.name} · {applied.id}</p>:<label>이 자료 처리<select disabled={busy} value={choices[candidate.sourceResourceId]??"keep"} onChange={event=>{setChoices(values=>({...values,[candidate.sourceResourceId]:event.target.value as Choice}));setChecked(null);}}><option value="keep">현재 자료 유지·아래에서 재연결</option><option value="copy" disabled={!userId||!source}>가져온 내용으로 내 비공개 사본 만들기</option><option value="version" disabled={!canVersion}>내 원본의 새 버전으로 저장</option></select></label>}
       <p className="field-help">{!source?"현재 읽을 수 없는 원본이에요. 다른 자료로 재연결하세요.":source.ownerId!==userId?"공유 원본은 수정하지 않고 내 사본을 만들 수 있어요.":source.updatedAt!==candidate.baseUpdatedAt?"원본이 변경됐어요. 비교 후 새 사본을 선택하세요.":"서버가 저장 시 현재 권한과 충돌을 다시 확인해요."}</p>
      </article>;
     })}
     {pending.length>0&&<button type="button" className="btn secondary" disabled={busy||!userId} onClick={()=>void applyResources()}>선택한 자료 {pending.length}개 변경 적용</button>}
     <p className="field-help">자료와 설계는 별도로 저장해요. 저장된 자료는 창을 닫아도 유지됩니다. Skill 첨부는 보관하며 웹에서 실행하지 않아요.</p>
    </section>
    <section className="settings-card"><h3>4. 자료 재연결·설계 검사</h3>{!imported.resourceHints.length?<p>연결 자료가 없어요.</p>:imported.resourceHints.map(hint=><label key={hint.id}>{hint.name}<select disabled={busy} value={mapping[hint.id]||""} onChange={event=>{setMapping(values=>({...values,[hint.id]:event.target.value}));setChecked(null);}}><option value="">사용할 자료를 선택하세요</option>{available.filter(r=>!hint.type||r.type===hint.type).map(r=><option key={r.id} value={r.id}>{r.name} ({r.type})</option>)}</select></label>)}<p className="field-help">워크플로 공유와 자료 권한은 별개이며 저장·내보내기에서 현재 권한을 재검사해요.</p><button type="button" className="btn secondary" disabled={busy||pending.length>0} onClick={validate}>재연결하고 설계 검증</button></section>
    {checked&&<section className="settings-card"><h3>5. 저장 방식</h3><p className="success-badge" role="status">설계와 자료를 검사했어요. 실제 모델·MCP 연결 검사는 하지 않았어요.</p><label>설계 저장 방식<select disabled={busy} value={mode} onChange={event=>setMode(event.target.value as "copy"|"version")}><option value="copy">새 비공개 사본</option><option value="version" disabled={!canUpdate||!matchingVersion}>원본의 새 버전</option></select></label><p className="field-help">다시 내보내면 문서와 파일 비교 기준도 갱신돼요. 변경된 설계는 새 실행으로 시작하고 이전 승인을 재사용하지 않아요.</p></section>}
   </>}
   {notice&&<p className="soft-note" role="status">{notice}</p>}{error&&<p className="form-error" role="alert" style={{whiteSpace:"pre-wrap"}}>{error}</p>}
  </div>
  <footer className="modal-footer"><button className="btn secondary" disabled={busy} onClick={onClose}>닫기</button><button className="btn primary" disabled={busy||!checked} onClick={()=>void save()}>{busy?"처리 중…":mode==="copy"?"새 사본으로 저장":"새 버전으로 저장"}</button></footer>
 </Modal>;
}

