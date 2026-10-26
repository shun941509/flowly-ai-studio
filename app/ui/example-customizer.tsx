"use client";
/**
 * 복제된 예제를 목표·자료·역할·결과·완료 조건에 맞게 바꾸는 안내 편집기. 원본 예제와 자료 본문은 유지하고 사본 설계만 변경한다.
 */

import { useState } from 'react';
import { allNodes } from '../../domain/advanced-config';
import { readLegacyMcpRegistration, readMcpRegistration } from '../../domain/mcp-registration';
import type { Definition, FlowNode, Resource, Workflow } from '../lib/model';
import { PredicateSettings } from './predicate-settings';
import { ExtendedNodeSettings } from './extended-nodes';
import { GuideHelp, WorkflowExplanation } from './workflow-guide';

/** 노드 ID가 중첩 흐름마다 같을 수 있어 객체 참조로 대상 하나를 찾는다. 모든 종류의 하위 정의를 재귀적으로 보존하며 교체한다. */
export function replaceExampleNode(definition:Definition,target:FlowNode,patch:Partial<FlowNode>):Definition{
 return {...definition,nodes:definition.nodes.map(node=>node===target?{...node,...patch}:{...node,
 ...(node.parallel?{parallel:{...node.parallel,tasks:node.parallel.tasks.map(task=>({...task,definition:replaceExampleNode(task.definition,target,patch)}))}}:{}),
 ...(node.team?{team:{...node.team,tasks:node.team.tasks.map(task=>({...task,definition:replaceExampleNode(task.definition,target,patch)}))}}:{}),
 ...(node.orchestration?{orchestration:{...node.orchestration,tasks:node.orchestration.tasks.map(task=>({...task,definition:replaceExampleNode(task.definition,target,patch)}))}}:{}),
 ...(node.subworkflow?{subworkflow:{definition:replaceExampleNode(node.subworkflow.definition,target,patch)}}:{}),
 ...(node.loop?{loop:{...node.loop,definition:replaceExampleNode(node.loop.definition,target,patch)}}:{})})};
}

/** 현재 자료와 복제 시 받은 자료를 ID로 합친다. 같은 ID는 복제 응답의 최신 항목을 사용한다. */
export function mergeExampleResources(available:Resource[],copied:Resource[]):Resource[]{
 return [...new Map([...available,...copied].map(resource=>[resource.id,resource])).values()];
}
/** 검색·지식 평가·도구 참조까지 하위 노드 전체에서 수집한다. 재연결할 자료가 일부 참조에서 빠지지 않도록 한다. */
export function exampleResourceIds(definition:Definition):string[]{
 return [...new Set(allNodes(definition).flatMap(node=>[node.resourceId,...(node.retrieval?.resourceIds??[]),...(node.knowledge?.resourceIds??[]),...(node.knowledge?.evaluation?.map(item=>item.resourceId)??[]),...(node.allowedTools?.map(tool=>tool.resourceId)??[])]).filter((id):id is string=>Boolean(id)))];
}
const registration=(resource:Resource)=>readMcpRegistration(resource)??readLegacyMcpRegistration(resource);
function schemaSignature(value:unknown):string{
 if(Array.isArray(value))return `[${value.map(schemaSignature).sort().join(',')}]`;
 if(value&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${schemaSignature(item)}`).join(',')}}`;
 return JSON.stringify(value);
}
/** 같은 종류인지, 중복 검색 자료인지, MCP 도구 계약이 맞는지 점검한다. 같은 이름의 도구라는 이유만으로 호환된다고 보지 않는다. */
export function exampleResourceReplacementIssue(definition:Definition,sourceId:string,replacement:Resource,resources:Resource[]):string|undefined{
 const source=resources.find(resource=>resource.id===sourceId);
 if(!source)return '기존 자료의 종류와 도구 계약을 확인할 수 없습니다. 자료 권한을 확인한 뒤 다시 열어 주세요.';
 if(source.type!==replacement.type)return '기존 자료와 같은 종류만 선택할 수 있습니다.';
 const nodes=allNodes(definition);
 if(sourceId!==replacement.id&&nodes.some(node=>[node.retrieval?.resourceIds,node.knowledge?.resourceIds].some(ids=>ids?.includes(sourceId)&&ids.includes(replacement.id))))return '이 자료가 같은 검색 또는 색인에 이미 연결되어 있습니다. 중복되지 않는 자료를 선택해 주세요.';
 if(source.type!=='mcp')return;
 try{
  const next=registration(replacement);
  if(!next)return '도구 및 자료에서 MCP 도구 정의를 등록해야 합니다.';
  let prior:ReturnType<typeof registration>=null;
  try{prior=registration(source);}catch{/* Broken old definitions stay intact until a valid replacement is chosen. */}
  const names=[...new Set(nodes.flatMap(node=>(node.allowedTools??[]).filter(tool=>tool.resourceId===sourceId).map(tool=>tool.toolName)))];
  const missing=names.filter(name=>!next.tools.some(tool=>tool.name===name));
  if(missing.length)return `필요한 도구가 없습니다: ${missing.join(', ')}`;
  for(const name of names){const before=prior?.tools.find(tool=>tool.name===name),after=next.tools.find(tool=>tool.name===name)!;if(before&&(before.effect!==after.effect||schemaSignature(before.inputSchema)!==schemaSignature(after.inputSchema)))return `${name}의 작업 종류 또는 입력 형식이 다릅니다. 편집기에서 인자·승인 정책을 확인하고 연결해 주세요.`;}
 }catch(reason){return (reason as Error).message;}
}
/** Rebind every structural reference together, including a knowledge evaluation's expected document. */
/** 검사를 통과한 대상 자료로 모든 관련 ID를 복제본에서 교체한다. MCP는 연결 ID도 갱신하며 원본 정의를 직접 수정하지 않는다. */
export function rebindExampleResource(definition:Definition,sourceId:string,targetId:string,resources:Resource[]):Definition{
 const target=resources.find(resource=>resource.id===targetId);
 if(!target)throw new Error('현재 사용할 수 없는 자료입니다. 자료 권한을 확인해 주세요.');
 const issue=exampleResourceReplacementIssue(definition,sourceId,target,resources);if(issue)throw new Error(issue);
 const next=structuredClone(definition),connection=target.type==='mcp'?registration(target):null;
 for(const node of allNodes(next)){
  if(node.resourceId===sourceId)node.resourceId=target.id;
  if(node.retrieval)node.retrieval.resourceIds=node.retrieval.resourceIds.map(id=>id===sourceId?target.id:id);
  if(node.knowledge){node.knowledge.resourceIds=node.knowledge.resourceIds.map(id=>id===sourceId?target.id:id);if(node.knowledge.evaluation)node.knowledge.evaluation=node.knowledge.evaluation.map(item=>item.resourceId===sourceId?{...item,resourceId:target.id}:item);}
  if(node.allowedTools)node.allowedTools=node.allowedTools.map(tool=>tool.resourceId===sourceId?{...tool,resourceId:target.id,connectionId:connection!.connectionId}:tool);
 }
 return next;
}

/** 현재 접근 가능한 같은 종류의 자료로 재연결한다. 화면에서 검사한 뒤에도 저장·내보내기의 서버 권한 검사가 필요하다. */
export function ExampleMaterials({definition,resources,onChange}:{definition:Definition;resources:Resource[];onChange:(definition:Definition)=>void}){
 const [error,setError]=useState(''),[notice,setNotice]=useState('');
 const nodes=allNodes(definition),ids=exampleResourceIds(definition);
 function rebind(sourceId:string,targetId:string){try{onChange(rebindExampleResource(definition,sourceId,targetId,resources));setError('');setNotice('연결된 모든 블록과 지식 색인 평가의 자료 ID를 함께 변경했습니다. 검색 평가 질문과 실제 도구 인자가 새 자료에 맞는지 확인하세요.');}catch(reason){setError((reason as Error).message);setNotice('');}}
 return <><p>샘플 자료와 현재 사용할 수 있는 ‘도구 및 자료’에서 같은 종류를 골라 연결합니다. 같은 자료를 참조하는 블록은 함께 바뀌며 원본 자료 내용은 수정하지 않습니다. 실제 주소·키·토큰은 내보낸 실행 환경에서 설정하세요.</p>
 {ids.map(id=>{const source=resources.find(resource=>resource.id===id),users=nodes.filter(node=>exampleResourceIds({nodes:[node],edges:[]}).includes(id));const names=[...new Set(users.flatMap(node=>(node.allowedTools??[]).filter(tool=>tool.resourceId===id).map(tool=>tool.toolName)))];const options=resources.filter(resource=>resource.type===source?.type);return <section className="example-material" key={id}><label className="field-label">{source?.name??'사용할 수 없는 자료'} 연결 ({source?.type??'종류 확인 필요'})<select aria-label={`${source?.name??id} 대체 자료`} value={id} disabled={!source} onChange={event=>rebind(id,event.target.value)}>{!source&&<option value={id}>{id} · 삭제 또는 권한 확인 필요</option>}{options.map(resource=>{const issue=exampleResourceReplacementIssue(definition,id,resource,resources);return <option key={resource.id} value={resource.id} disabled={Boolean(issue)&&resource.id!==id}>{resource.name}{issue?` · ${issue}`:''}</option>;})}</select></label><p className="field-help">사용 블록: {[...new Set(users.map(node=>node.title))].join(', ')}</p>{names.length>0&&<p>유지할 MCP 도구: {names.join(', ')}. 동일한 도구 이름·작업 종류·입력 형식의 등록을 선택하세요. 도구 인자와 승인 설정은 유지됩니다.</p>}{source?.type==='mcp'&&<><button className="btn secondary" type="button" disabled={Boolean(exampleResourceReplacementIssue(definition,id,source,resources))} onClick={()=>rebind(id,id)}>현재 MCP의 등록된 연결 ID로 맞추기</button><p className="field-help">다른 이름이나 입력 형식의 도구로 바꾸려면 편집기에서 해당 블록의 도구·인자 연결을 함께 수정하세요.</p></>}{source&&exampleResourceReplacementIssue(definition,id,source,resources)&&<p className="form-error">{exampleResourceReplacementIssue(definition,id,source,resources)}</p>}{!source&&<p className="form-error">현재 자료를 열 수 없어 기존 연결을 보존합니다. ‘도구 및 자료’에서 공유 권한을 확인해 주세요.</p>}</section>;})}
 {!ids.length&&<p>이 설계에는 등록 자료나 MCP 연결이 없습니다. 필요한 자료는 편집기에서 추가할 수 있습니다.</p>}
 {nodes.some(node=>node.knowledge)&&<p className="field-help">지식 색인의 허용 자료와 평가의 정답 자료 ID를 함께 변경합니다. 입력 데이터·프로그램 인자·프롬프트에 직접 적은 자료 ID는 자동 변경하지 않으므로 새 자료에 맞게 확인하세요.</p>}
 {error&&<p className="form-error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}<GuideHelp term="mcp"/></>;
}
/** 서버에서 만든 사본의 편집 초안을 단계별로 관리한다. 마지막 저장은 사본의 기준 수정 시각을 함께 보내 충돌을 확인한다. */
export function ExampleCustomizer({workflow,resources,onDone,onSkip}:{workflow:Workflow;resources:Resource[];onDone:(workflow:Workflow)=>void;onSkip:()=>void}){
 const [draft,setDraft]=useState(()=>structuredClone(workflow)),[step,setStep]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const nodes=allNodes(draft.definition),steps=['목표','자료','역할','결과','완료 조건'];
 const patch=(node:FlowNode,value:Partial<FlowNode>)=>setDraft({...draft,definition:replaceExampleNode(draft.definition,node,value)});
 async function save(){setBusy(true);setError('');try{const response=await fetch('/api/studio',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'workflow.save',data:draft,baseUpdatedAt:workflow.updatedAt})});const result=await response.json() as {error?:string;workflow:Workflow};if(!response.ok)throw new Error(result.error??'맞춤 설정 저장에 실패했어요. 사본은 보존되어 있습니다.');onDone(result.workflow);}catch(reason){setError((reason as Error).message);}finally{setBusy(false);}}
 return <section className="example-customizer"><header className="customizer-heading"><span className="eyebrow">MAKE IT YOURS</span><h2>내 사본에 맞춤 설정</h2><p>예제 원본은 유지하고 내 비공개 사본만 수정합니다. 언제든 사본을 그대로 열어 계속 편집할 수 있어요.</p></header><nav aria-label="예제 맞춤 설정 단계">{steps.map((label,index)=><button type="button" aria-current={step===index?'step':undefined} className={step===index?'btn primary':'btn secondary'} key={label} onClick={()=>setStep(index)}>{index+1}. {label}</button>)}</nav><div className="customizer-step-heading"><h3>{steps[step]} 설정</h3><span>{step+1} / {steps.length}단계</span></div><div className="customizer-step-content">
 {step===0&&<><label className="field-label">프로젝트 이름<input maxLength={80} value={draft.name} onChange={event=>setDraft({...draft,name:event.target.value})}/></label><label className="field-label">목표 설명<textarea rows={4} maxLength={300} value={draft.description} onChange={event=>setDraft({...draft,description:event.target.value})}/></label><p>이 설명은 프로젝트 소개입니다. 실제 AI 작업 지시는 다음 ‘역할’ 단계에서 바꾸세요.</p></>}
 {step===1&&<ExampleMaterials definition={draft.definition} resources={resources} onChange={definition=>setDraft({...draft,definition})}/>}
 {step===2&&<>{nodes.filter(node=>['agent','ai','orchestrator'].includes(node.type)).map((node,index)=><section key={index}><label className="field-label">역할 이름<input maxLength={80} value={node.title} onChange={event=>patch(node,{title:event.target.value})}/></label><label className="field-label">{node.title}의 실제 목표와 작업 지침<textarea rows={5} maxLength={12000} value={node.prompt??''} onChange={event=>patch(node,{prompt:event.target.value})}/></label></section>)}{!nodes.some(node=>['agent','ai','orchestrator'].includes(node.type))&&<p>이 설계에는 모델 역할이 없습니다. 계산·도구의 실행 순서를 유지하며 Agent를 자동으로 추가하지 않습니다.</p>}</>}
 {step===3&&<>{nodes.filter(node=>['agent','ai'].includes(node.type)).map((node,index)=><label className="field-label" key={index}>{node.title}의 결과 형식<select value={node.format??'Markdown'} onChange={event=>patch(node,{format:event.target.value})}><option>Markdown</option><option>텍스트</option><option>JSON</option></select></label>)}<p>형식을 바꾸면 다음 블록의 입력 연결도 확인해야 합니다. JSON의 상세 내용은 data 안에 전달됩니다.</p><GuideHelp term="mapping"/><WorkflowExplanation definition={draft.definition}/></>}
 {step===4&&<><p>완료는 아래 실제 조건·평가·검토 설정으로 판단합니다. 이름이나 소개 문장만 바꾸면 판정 기준이 바뀌지 않습니다.</p>{nodes.filter(node=>['condition','evaluate','review'].includes(node.type)||node.orchestration?.completion).map((node,index)=><div key={index}><strong>{node.title}</strong><details><summary>고급: 현재 판정 설정 확인</summary><pre>{JSON.stringify(node.predicate??node.condition??node.evaluation??node.review??node.orchestration?.completion,null,2)}</pre></details>{node.type==='condition'&&<PredicateSettings node={node} onChange={next=>patch(node,next)}/>} {node.type==='evaluate'&&<ExtendedNodeSettings node={node} definition={draft.definition} onChange={next=>patch(node,next)} onSettings={()=>{}}/>}{node.review&&<label className="field-label">사람 검토의 완료 기준<textarea value={node.review.instructions} rows={3} maxLength={4000} onChange={event=>patch(node,{review:{...node.review!,instructions:event.target.value}})}/></label>}</div>)}<p>복합 작업 조정 완료 조건·입력 매핑은 사본을 연 뒤 해당 블록 설정에서 변경하세요. 판정 블록이 없는 설계는 출력까지 처리했음을 확인하는 흐름이며 추가 품질 기준은 조건·평가·사람 검토 블록으로 만드세요.</p></>}
 </div>{error&&<p className="form-error" role="alert">{error}</p>}<footer className="modal-footer"><button className="text-btn" disabled={busy} onClick={onSkip}>맞춤 설정 건너뛰고 사본 열기</button>{step>0&&<button className="btn secondary" onClick={()=>setStep(step-1)}>이전</button>}{step<4?<button className="btn primary" onClick={()=>setStep(step+1)}>다음: {steps[step+1]}</button>:<button className="btn primary" disabled={busy||!draft.name.trim()} onClick={()=>void save()}>{busy?'저장 중':'사본에 저장하고 편집기 열기'}</button>}</footer></section>;
}
