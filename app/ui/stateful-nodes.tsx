"use client";
import { useState } from "react";
import type { FlowNode, NodeType, Resource } from "../lib/model";
import { parseKnowledgeConfig, type KnowledgeConfig } from "../../domain/knowledge-config";
import { parseSearchConfig, SEARCH_DEFAULTS } from "../../domain/search-config";
import { parseAdvancedNodeConfig } from "../../domain/advanced-config";
import { parseDefinition, uid } from "../lib/model";

export const knowledgeActions: Record<KnowledgeConfig["action"], string> = {stage:"변경 자료 준비",evaluate:"검색 품질 평가",publish:"평가한 버전 발행",query:"발행한 지식 검색",revoke:"자료 사용 철회",rollback:"이전 버전 복구",inspect:"색인 상태 확인"};
export function statefulDefaults(type: NodeType): Partial<FlowNode> {
  if(type === "knowledge") return {knowledge:{action:"stage",indexKey:"company_knowledge",resourceIds:[],mode:"lexical",chunkSize:700,topK:3}};
  if(type === "candidate_search") return {search:{...SEARCH_DEFAULTS},prompt:"입력 항목에서 목표 합계에 맞는 조합을 찾아 주세요.",format:"JSON"};
  return {};
}
function JsonSetting({value,label,onApply}:{value:unknown;label:string;onApply:(value:unknown)=>void}) {
  const [draft,setDraft]=useState(JSON.stringify(value,null,2)),[error,setError]=useState("");
  return <><label className="field-label">{label}<textarea rows={9} maxLength={20000} value={draft} onChange={e=>setDraft(e.target.value)}/></label><button type="button" className="btn secondary" onClick={()=>{try{onApply(JSON.parse(draft));setError("");}catch(e){setError(e instanceof SyntaxError?"올바른 JSON으로 입력해 주세요.":(e as Error).message);}}}>설정 검사 후 적용</button>{error&&<p className="form-error" role="alert">{error}</p>}</>;
}
export function StatefulNodeSettings({node,resources,onChange}:{node:FlowNode;resources:Resource[];onChange:(node:FlowNode)=>void}) {
  if(node.type === "knowledge") {
    const c=node.knowledge??statefulDefaults("knowledge").knowledge!;
    return <><label className="field-label">색인 작업<select value={c.action} onChange={e=>{const action=e.target.value as KnowledgeConfig["action"];onChange({...node,knowledge:{...c,action,...(["evaluate","publish","rollback"].includes(action)?{generationPath:c.generationPath??"generation"}:{}),...(action==="evaluate"?{evaluation:c.evaluation??[]}:{})}});}}>{Object.entries(knowledgeActions).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><label className="field-label">색인 이름<input maxLength={60} value={c.indexKey} onChange={e=>onChange({...node,knowledge:{...c,indexKey:e.target.value}})}/></label><label className="field-label">검색 방식<select value={c.mode??"lexical"} onChange={e=>onChange({...node,knowledge:{...c,mode:e.target.value as "lexical"|"vector"}})}><option value="lexical">단어 검색 · 모델 연결 불필요</option><option value="vector">벡터 검색 · 내보낸 환경의 임베딩</option></select></label><h4 className="context-title">사용할 수 있는 자료</h4>{resources.filter(r=>["document","prompt"].includes(r.type)).map(r=><label className="inline-check" key={r.id}><input type="checkbox" checked={c.resourceIds.includes(r.id)} onChange={e=>onChange({...node,knowledge:{...c,resourceIds:e.target.checked?[...c.resourceIds,r.id]:c.resourceIds.filter(id=>id!==r.id)}})}/><span>{r.name}</span></label>)}<p className="field-help">같은 색인 이름과 사용자·워크플로의 실행은 내보낸 상태 폴더에서 지식을 공유해요. 준비 → 평가 → 발행 순서로 연결하세요. 철회한 자료는 이전 버전을 복구해도 검색되지 않아요.</p><JsonSetting key={JSON.stringify(c)} label="세부 설정 · 입력 경로와 평가 질문" value={c} onApply={value=>onChange({...node,knowledge:parseKnowledgeConfig(value)})}/><p className="field-help">documentsPath: 변경 문서 배열 경로, generationPath: 버전 경로, expectedRevisionPath: 현재 리비전 경로, resourceIdsPath: 철회할 자료 ID 배열, queryPath: 질문 경로예요. 평가는 evaluation에 query와 resourceId를 지정해요. 웹의 원본 자료와 내보낸 파일의 삭제는 별도예요.</p></>;
  }
  const c=node.search??SEARCH_DEFAULTS;
  return <><label className="field-label">탐색 방식<select value={c.mode} onChange={e=>onChange({...node,search:{...c,mode:e.target.value as "tree"|"graph"}})}><option value="tree">트리 탐색 · 분기·가지치기·되돌아가기 (ToT)</option><option value="graph">그래프 탐색 · 병합·수정·자손 무효화 (GoT)</option></select></label><label className="field-label">작업 지침<textarea rows={3} maxLength={12000} value={node.prompt??""} onChange={e=>onChange({...node,prompt:e.target.value})}/></label><JsonSetting key={JSON.stringify(c)} label="입력 경로와 탐색 한도" value={c} onApply={value=>onChange({...node,search:parseSearchConfig(value)})}/><p className="field-help">현재 검증기는 항목의 양의 정수 합계가 목표와 같은지 계산해요. 입력은 items: [&#123;id, value&#125;]와 target이며, 출력 data.solved로 분기할 수 있어요. 후보 수·깊이·반복 수와 전체 실행 한도를 함께 지켜요. 모델의 내부 사고 원문은 요청하거나 기록하지 않아요.</p></>;
}
export function DynamicAgentSettings({node,onChange}:{node:FlowNode;onChange:(node:FlowNode)=>void}) {
  const c=node.orchestration!;
  function addTemplate() {
    const taskId=uid("capability");
    const definition=parseDefinition({schemaVersion:5,nodes:[{id:"input",type:"input",title:"배정받은 작업",x:230,y:30},{id:"worker",type:"agent",title:"생성된 역할 수행",x:230,y:240,prompt:"배정된 역할·목표와 assignment.input의 요청을 수행하세요. artifacts에 선행 결과가 있습니다. 확인한 결과만 답하세요.",format:"JSON",allowedTools:[],inputBindings:{text:{nodeId:"input",path:"text"},assignment:{nodeId:"input",path:"assignment"},artifacts:{nodeId:"input",path:"artifacts"}}},{id:"output",type:"output",title:"작업 결과",x:230,y:450,inputBindings:{text:{nodeId:"worker",path:"text"},data:{nodeId:"worker",path:"data"}}}],edges:[{id:"a",source:"input",target:"worker"},{id:"b",source:"worker",target:"output"}]});
    onChange({...node,orchestration:{...c,tasks:[...c.tasks,{id:taskId,name:"동적 Agent 작업 틀",definition}],dynamic:{maxAgents:c.dynamic?.maxAgents??3,concurrency:c.dynamic?.concurrency??2,templates:[...(c.dynamic?.templates??[]),{taskId,agentNodeId:"worker",inputSchema:{type:"object",properties:{request:{type:"string"}},required:["request"],additionalProperties:false}}]}}});
  }
  return <><p className="field-help">등록된 작업 틀의 지정 Agent에 새 역할·목표·입력을 전달해요. 최대 8개를 생성하고 선행 결과가 준비된 작업을 최대 4개씩 실행합니다. 도구·코드·권한은 작업 틀의 허용 범위를 유지해요.</p><button type="button" className="btn secondary" disabled={c.tasks.length>=8} onClick={addTemplate}>Agent 작업 틀 추가</button><JsonSetting key={JSON.stringify(c.dynamic)} label="생성 한도와 작업 틀의 입력 형식" value={c.dynamic} onApply={dynamic=>{const parsed=parseAdvancedNodeConfig({type:"orchestrator",orchestration:{...c,dynamic}},parseDefinition);onChange({...node,...parsed});}}/><p className="field-help">templates의 taskId는 작업 ID, agentNodeId는 해당 작업 안의 Agent ID, inputSchema는 생성할 입력 객체 형식이에요. 새 역할·목표·입력은 assignment에, 선행 결과는 artifacts에 전달됩니다. 완료 조건에는 summary.completedCount 등을 사용할 수 있어요.</p></>;
}
