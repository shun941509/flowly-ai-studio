import type { Definition, FlowNode, Resource } from '../../app/lib/model';
import type { WorkflowDesign, WorkflowScenario } from '../workflow-design';
import { layoutWorkflow } from '../workflow-layout';
import { serializeMcpRegistration } from '../mcp-registration';
import { parseSearchConfig } from '../search-config';

const b=(nodeId:string,path='text')=>({nodeId,path});
const n=(id:string,type:FlowNode['type'],title:string,extra:Partial<FlowNode>={}):FlowNode=>({id,type,title,x:0,y:0,...extra});
const g=(nodes:FlowNode[],links:[string,string,string?][]):Definition=>layoutWorkflow({schemaVersion:5,nodes,edges:links.map(([source,target,branch],i)=>({id:`e_${source}_${i}`,source,target,...(branch?{branch}:{})}))});
const out=(id:string,source:string,path='text')=>n(id,'output','관측 결과',{inputBindings:{text:b(source,path)}});
const stamp='2026-10-25T00:00:00Z';
const base={ownerId:'flowly-examples',visibility:'public' as const,allowedEmails:[],sample:true,createdAt:stamp,updatedAt:stamp,url:''};
const document:Resource={...base,id:'completed-095-release-contract',type:'document',name:'등록 배포 계약',description:'합성 배포 계약',content:'release requires review, a verified change record, and reversible publication.'};
const skill:Resource={...base,id:'completed-095-release-skill',type:'skill',name:'배포 근거 확인 지침',description:'실제 검사 우선',content:'등록 자료·파일·프로그램 근거만 사용하세요. 승인 없이 외부 변경을 실행하지 마세요.'};
const connectionId='completed-095-publishing';
const connection:Resource={...base,id:connectionId,type:'mcp',name:'사내 변경 기록 등록·취소',url:'https://company-mcp.example.invalid/mcp',description:'미설정: 실제 회사 publish_change/undo_change 도구와 사용자 자격 증명을 내보낸 환경에서 등록합니다.',content:serializeMcpRegistration({version:1,connectionId,endpointEnv:'FLOWLY_MCP_ENDPOINT_COMPLETED095',tokenEnv:'FLOWLY_MCP_TOKEN_COMPLETED095',tools:[{name:'publish_change',description:'검토한 변경 기록을 고정 requestId로 등록합니다.',effect:'write',inputSchema:{type:'object',properties:{requestId:{type:'string'}},required:['requestId'],additionalProperties:false}},{name:'undo_change',description:'완료된 변경 기록 하나를 별도 승인 후 취소합니다.',effect:'write',inputSchema:{type:'object',properties:{recordId:{type:'string'}},required:['recordId'],additionalProperties:false}}]})};
const tool=(toolName:string)=>({resourceId:connectionId,connectionId,toolName});
const jsonAgent=(id:string,prompt:string,bindings:FlowNode['inputBindings'])=>n(id,'agent','근거를 확인하고 실행 범위 결정',{prompt,allowedTools:[],format:'JSON',inputBindings:bindings,outputSchema:{type:'object',properties:{text:{type:'string'},data:{type:'object',properties:{passed:{type:'boolean'},report:{type:'string'}},required:['passed','report'],additionalProperties:false}},required:['text','data']}});

const calculation=(id:string,operation:string)=>g([n(`${id}_input`,'input','독립 검사 입력'),n(`${id}_program`,'program','등록된 실제 계산',{program:{name:'completion',arguments:{operation:`operations.${operation}`,arguments:{}},bindings:{}},inputBindings:{}}),n(`${id}_output`,'output','검사 결과',{inputBindings:{text:b(`${id}_program`),data:b(`${id}_program`,'data')}})],[[`${id}_input`,`${id}_program`],[`${id}_program`,`${id}_output`]]);
const loopBody=g([n('c095_loop_input','input','이번 항목'),n('c095_loop_ai','ai','한 항목 설명',{prompt:'COMPLETED_095_ITEM: 전달된 항목을 한 줄로 설명하세요.',inputBindings:{item:b('c095_loop_input','item')}}),out('c095_loop_output','c095_loop_ai')],[['c095_loop_input','c095_loop_ai'],['c095_loop_ai','c095_loop_output']]);
const subBody=g([n('c095_sub_input','input','등록 검사 항목'),n('c095_loop','loop','목록별 제한 검사',{loop:{definition:loopBody,itemsPath:'items',maxItems:2,concurrency:1},inputBindings:{items:b('c095_sub_input','items')}}),out('c095_sub_output','c095_loop')],[['c095_sub_input','c095_loop'],['c095_loop','c095_sub_output']]);
const orchestrationBody=g([n('c095_orch_input','input','하위 작업 계약'),n('c095_subworkflow','subworkflow','재사용 가능한 검사 단계',{subworkflow:{definition:subBody},inputBindings:{items:b('c095_orch_input','items')}}),out('c095_orch_output','c095_subworkflow')],[['c095_orch_input','c095_subworkflow'],['c095_subworkflow','c095_orch_output']]);
const teamBody=g([n('c095_team_input','input','전문 검토 근거'),n('c095_team_agent','agent','독립 검토 Agent',{prompt:'COMPLETED_095_TEAM: 실제 계산 근거를 확인하고 검토 결과를 한 줄로 답하세요.',allowedTools:[]}),out('c095_team_output','c095_team_agent')],[['c095_team_input','c095_team_agent'],['c095_team_agent','c095_team_output']]);

const nodes:FlowNode[]=[
  n('c095_trigger','trigger','배포 검토 요청 시작',{trigger:{kind:'event',intervalSeconds:60,startAt:'',eventType:'change.requested'}}),
  n('c095_parse','transform','요청 JSON 해석',{transform:{mode:'parse_json'}}),
  n('c095_file','file_input','등록된 변경 파일 읽기',{fileInput:{path:'path',maxBytes:10000},inputBindings:{path:b('c095_parse','data.path')}}),
  n('c095_extract','document_extract','파일 본문 추출',{documentExtract:{mode:'text',filePath:'file',maxPages:2,language:'eng'},inputBindings:{file:b('c095_file','file')}}),
  n('c095_filter','guardrail','외부 전달 전 개인정보 마스킹',{guardrail:{action:'mask',categories:['email','secret']}}),
  n('c095_resource','resource','기술 계약 본문',{resourceId:document.id}),
  n('c095_skill','skill','검토 작업 지침',{resourceId:skill.id}),
  n('c095_retrieval','retrieval','허용 자료에서 배포 근거 검색',{retrieval:{resourceIds:[document.id],topK:1,chunkSize:300},inputBindings:{text:b('c095_filter')}}),
  n('c095_stage','knowledge','허용 자료를 준비 세대로 등록',{knowledge:{action:'stage',indexKey:'completed095',resourceIds:[document.id]}}),
  n('c095_knowledge_evaluate','knowledge','실제 검색으로 세대 평가',{knowledge:{action:'evaluate',indexKey:'completed095',resourceIds:[document.id],generationPath:'generation',evaluation:[{query:'release',resourceId:document.id}]},inputBindings:{generation:b('c095_stage','generation')}}),
  n('c095_publish_index','knowledge','평가된 지식 세대 발행',{knowledge:{action:'publish',indexKey:'completed095',resourceIds:[document.id],generationPath:'generation'},inputBindings:{generation:b('c095_knowledge_evaluate','generation')}}),
  jsonAgent('c095_agent','COMPLETED_095_PLAN: 마스킹 파일과 등록 자료를 대조하여 {passed:boolean,report:string} JSON으로 실행 가능 범위만 제안하세요.',{file:b('c095_filter'),reference:b('c095_retrieval'),instructions:b('c095_skill')}),
  n('c095_classify','classify','검토 진행 또는 보류 분류',{prompt:'COMPLETED_095_CLASSIFY: proposal.passed가 true면 proceed, false면 hold를 선택하세요.',classification:{labels:[{id:'proceed',name:'진행',description:'등록 범위의 변경'},{id:'hold',name:'보류',description:'근거 부족'}]},inputBindings:{proposal:b('c095_agent','data')}}),
  n('c095_error','error','근거 부족 작업 보류',{error:{template:'등록 근거가 부족하여 변경을 보류했습니다.'}}),out('c095_error_output','c095_error'),
  n('c095_parallel','parallel','코드 구조와 데이터 품질 독립 검사',{parallel:{concurrency:2,tasks:[{id:'code',name:'등록 코드 조사',definition:calculation('c095_code','code_inspect')},{id:'data',name:'격리 데이터 품질',definition:calculation('c095_data','db_quality')}]}}),
  n('c095_team','agent_team','검사 근거를 전문 Agent가 검토',{team:{mode:'sequential',concurrency:1,tasks:[{id:'reviewer',name:'독립 기술 검토',definition:teamBody}]}}),
  n('c095_orchestrator','orchestrator','등록된 하위 검사 순서 조정',{prompt:'COMPLETED_095_ORCHESTRATE: 등록된 verify 작업 한 개를 선택하세요.',orchestration:{mode:'plan',maxTasks:1,tasks:[{id:'verify',name:'목록별 문서 확인',definition:orchestrationBody}]},inputBindings:{items:b('c095_parse','data.items')}}),
  n('c095_candidate','candidate_search','예산에 맞는 항목 조합을 실제 계산',{search:parseSearchConfig({mode:'tree',maxIterations:3}),inputBindings:{items:b('c095_parse','data.candidates'),target:b('c095_parse','data.target')}}),
  n('c095_condition','condition','탐색한 조합이 목표를 충족하는가',{predicate:{path:'search.solved',operator:'eq',value:true},inputBindings:{search:b('c095_candidate','data')}}),
  n('c095_held','transform','한도 내 해답 없음',{inputBindings:{},transform:{mode:'template',template:'검증된 조합을 찾지 못하여 보류합니다.'}}),out('c095_held_output','c095_held'),
  n('c095_form','form','변경 책임자 보완 입력 대기',{form:{mode:'request',instructions:'실제 검증된 변경의 책임자를 입력합니다.',timeoutMinutes:30,fields:[{key:'owner',label:'책임자',type:'text',required:true}]}}),
  n('c095_merge','merge','검증 근거와 책임자 결합',{merge:{mode:'object'},inputBindings:{owner:b('c095_form','data.owner'),search:b('c095_condition','search'),report:b('c095_team')}}),
  n('c095_evaluate','evaluate','책임자와 근거 비어 있음 검사',{evaluation:{mode:'rules',rules:[{kind:'not_blank',value:'data.owner'}],rubric:'책임자 누락 검사',threshold:1},inputBindings:{data:b('c095_merge','data')}}),
  n('c095_review','review','기록 등록 전 사람 검토',{review:{instructions:'책임자·파일·실제 계산 근거를 검토합니다. 다음 변경 도구는 별도 승인됩니다.',allowEdit:false,timeoutMinutes:30},inputBindings:{data:b('c095_merge','data')}}),
  n('c095_rejected','transform','검토 거절 기록',{inputBindings:{},transform:{mode:'template',template:'담당자가 변경 등록을 거절했습니다.'}}),out('c095_rejected_output','c095_rejected'),
  n('c095_memory','memory','승인 전 검토 원장 저장',{memory:{action:'write',key:'completed095_review',scope:'run',valuePath:'review'},inputBindings:{review:b('c095_review','data')}}),
  n('c095_write','tool','사내 변경 기록 등록 · 별도 승인',{allowedTools:[tool('publish_change')],tool:{arguments:{requestId:'completed-095-release'},bindings:{}}}),
  jsonAgent('c095_verify','COMPLETED_095_VERIFY: 실제 등록 결과와 원장 근거를 대조해 {passed:boolean,report:string}을 답하세요. 검증 실패면 보상이 필요합니다.',{result:b('c095_write','data'),review:b('c095_memory','data')}),
  n('c095_verified','condition','등록 후 독립 검토 통과',{predicate:{path:'verification.passed',operator:'eq',value:true},inputBindings:{verification:b('c095_verify','data'),record:b('c095_write','data.structuredContent')}}),
  n('c095_export','file_output','검증 결과 CSV 저장',{fileOutput:{format:'csv',filename:'release-result.csv',dataPath:'rows'},inputBindings:{rows:b('c095_parse','data.exportRows')}}),out('c095_output','c095_export'),
  n('c095_compensate','compensate','완료된 기록만 별도 승인 취소',{allowedTools:[tool('undo_change')],compensation:{sourceNodeId:'c095_write',arguments:{},bindings:{recordId:'record.recordId'}},inputBindings:{record:b('c095_verified','record')}}),
  n('c095_recovered','transform','보상 결과와 목표 미완료 구분',{inputBindings:{},transform:{mode:'template',template:'보상 완료 · 원래 배포 목표는 미완료입니다.'}}),out('c095_recovered_output','c095_recovered'),
];
const links:[string,string,string?][]=[['c095_trigger','c095_parse'],['c095_parse','c095_file'],['c095_file','c095_extract'],['c095_extract','c095_filter'],['c095_filter','c095_resource'],['c095_resource','c095_skill'],['c095_skill','c095_retrieval'],['c095_filter','c095_retrieval'],['c095_retrieval','c095_stage'],['c095_stage','c095_knowledge_evaluate'],['c095_knowledge_evaluate','c095_publish_index'],['c095_publish_index','c095_agent'],['c095_filter','c095_agent'],['c095_retrieval','c095_agent'],['c095_skill','c095_agent'],['c095_agent','c095_classify'],['c095_classify','c095_error','hold'],['c095_error','c095_error_output'],['c095_classify','c095_parallel','proceed'],['c095_parallel','c095_team'],['c095_team','c095_orchestrator'],['c095_parse','c095_orchestrator'],['c095_orchestrator','c095_candidate'],['c095_parse','c095_candidate'],['c095_candidate','c095_condition'],['c095_condition','c095_held','no'],['c095_held','c095_held_output'],['c095_condition','c095_form','yes'],['c095_form','c095_merge'],['c095_condition','c095_merge','yes'],['c095_team','c095_merge'],['c095_merge','c095_evaluate'],['c095_evaluate','c095_review'],['c095_merge','c095_review'],['c095_review','c095_rejected','no'],['c095_rejected','c095_rejected_output'],['c095_review','c095_memory','yes'],['c095_memory','c095_write'],['c095_write','c095_verify'],['c095_memory','c095_verify'],['c095_verify','c095_verified'],['c095_write','c095_verified'],['c095_verified','c095_export','yes'],['c095_parse','c095_export'],['c095_export','c095_output'],['c095_verified','c095_compensate','no'],['c095_compensate','c095_recovered'],['c095_recovered','c095_recovered_output']];
// Carry payloads through the selected branch. A direct edge from the original
// input to a later stage would incorrectly activate it after an earlier hold.
nodes.find(x=>x.id==='c095_classify')!.inputBindings!.request=b('c095_parse','data');
nodes.find(x=>x.id==='c095_parallel')!.inputBindings={request:b('c095_classify','request')};
nodes.find(x=>x.id==='c095_error')!.inputBindings={reason:b('c095_classify','reason')};
nodes.find(x=>x.id==='c095_form')!.inputBindings={search:b('c095_condition','search')};
nodes.find(x=>x.id==='c095_write')!.inputBindings={};
links.push(['c095_parse','c095_classify']);
for(const target of ['c095_orchestrator','c095_candidate']){
  const edge=links.find(x=>x[0]==='c095_parse'&&x[1]===target)!;edge[0]='c095_classify';edge[2]='proceed';
  const bindings=nodes.find(x=>x.id===target)!.inputBindings!;
  for(const [key,value]of Object.entries(bindings))if(value.nodeId==='c095_parse')bindings[key]=b('c095_classify',value.path.replace(/^data\./,'request.'));
}
nodes.find(x=>x.id==='c095_condition')!.inputBindings!.report=b('c095_team');links.push(['c095_team','c095_condition']);
nodes.find(x=>x.id==='c095_merge')!.inputBindings!.report=b('c095_condition','report');
links.splice(links.findIndex(x=>x[0]==='c095_team'&&x[1]==='c095_merge'),1);
links.splice(links.findIndex(x=>x[0]==='c095_parse'&&x[1]==='c095_export'),1);
const exportEdge=links.find(x=>x[0]==='c095_verified'&&x[1]==='c095_export')!;exportEdge[1]='c095_csv_rows';
nodes.push(n('c095_csv_rows','transform','검증된 등록 결과를 행으로 구성',{transform:{mode:'template',template:'{"rows":[{"recordId":"{{record.recordId}}","status":"verified"}]}'},inputBindings:{record:b('c095_verified','record')}}),n('c095_csv_parse','transform','CSV 행 JSON 읽기',{transform:{mode:'parse_json'}}));
links.push(['c095_csv_rows','c095_csv_parse'],['c095_csv_parse','c095_export']);
nodes.find(x=>x.id==='c095_export')!.inputBindings={rows:b('c095_csv_parse','data.rows')};
const input=JSON.stringify({path:'change.txt',items:['release review'],candidates:[{id:'a',value:2},{id:'b',value:3}],target:5,exportRows:[{request:'completed-095-release',status:'verified'}]});
const replies=[{match:'COMPLETED_095_PLAN:',text:'{"passed":true,"report":"등록된 배포 검토입니다."}'},{match:'COMPLETED_095_CLASSIFY:',text:'{"label":"proceed","reason":"등록 범위"}'},{match:'COMPLETED_095_TEAM:',text:'실제 코드와 데이터 검사 근거를 확인했습니다.'},{match:'COMPLETED_095_ORCHESTRATE:',text:'{"tasks":["verify"]}'},{match:'COMPLETED_095_ITEM:',text:'release review 항목을 확인했습니다.'},{match:'FLOWLY_CANDIDATE_SEARCH:',text:'{"actions":[{"type":"create","items":["a","b"]}]}'},{match:'COMPLETED_095_VERIFY:',text:'{"passed":true,"report":"등록된 기록과 검토 근거가 일치합니다."}'}];
const write={name:'publish_change',args:{requestId:'completed-095-release'},result:{structuredContent:{recordId:'record-095'}}};
const submission={nodeId:'c095_form',values:{owner:'검토 담당자'},invalidValues:[{}],repeat:true};
const normal:WorkflowScenario={name:'모든 기능의 정상 경로를 실제 파일·계산·승인·보완 입력으로 실행',input,files:{'change.txt':'release contact operator@example.invalid'},status:'succeeded',review:'accept',approval:'approve',inputSubmissions:[submission],modelReplies:replies,toolReplies:[write],toolCallCounts:{publish_change:1},visited:['c095_output'],resumeAgain:true};
export const allBlocksCompletion:WorkflowDesign={id:'completed-095-all-blocks-release',title:'095 · 모든 블록을 사용하는 사내 변경 검토 프로젝트',category:'등록 작업 기반 완성 예제',description:'파일·근거·지식 세대·독립 계산·전문 검토·하위 작업·후보 탐색·보완 입력·기록 승인·CSV·보상 경로를 하나의 실제 실행 프로젝트로 연결합니다.',behavior:'파일 검토→지식 등록→Agent 분류→병렬 계산·팀·조정·하위 반복→후보 검증→입력 대기→검토·기록 승인→CSV 또는 별도 승인 보상',definition:g(nodes,links),resources:[document,skill,connection],inputExample:input,expectedOutput:'검증된 CSV 또는 보상 완료·목표 미완료 기록',acceptance:['서로 배타적인 분기는 별도 시나리오로 실행하며 모든 블록을 한 경로에서 실행했다고 주장하지 않습니다.','모델·MCP 경계만 테스트 대역이며 파일·지식 색인·후보 계산·메모리·승인·재개는 실제 실행기입니다.','내보낸 환경의 inputs/change.txt와 사내 MCP URL·개인 토큰은 사용자가 설정합니다.'],failureCases:['자료 분류 보류','후보 미충족','검토 거절','등록 승인 거절','등록 후 검증 실패는 승인된 보상'],scenarios:[normal,{...normal,name:'등록 후 독립 검증 실패는 별도 승인으로 원래 기록만 보상',modelReplies:replies.map(r=>r.match==='COMPLETED_095_VERIFY:'?{...r,text:'{"passed":false,"report":"검증 불일치"}'}:r),toolReplies:[write,{name:'undo_change',args:{recordId:'record-095'},result:{structuredContent:{undone:true,recordId:'record-095'}}}],toolCallCounts:{publish_change:1,undo_change:1},contains:['원래 배포 목표는 미완료'],visited:['c095_compensate'],skipped:['c095_output']},{...normal,name:'초기 근거 부족 분류는 모든 변경을 차단',modelReplies:[{...replies[0],text:'{"passed":false,"report":"범위 밖 요청"}'},{...replies[1],text:'{"label":"hold","reason":"범위 밖"}'}],toolReplies:[],toolCallCounts:{},inputSubmissions:[],visited:['c095_error'],skipped:['c095_write','c095_output'],contains:['보류'],resumeAgain:false},{...normal,name:'등록 승인 거절 시 외부 변경 호출 없음',status:'failed',approval:'deny',modelReplies:replies.slice(0,-1),toolReplies:[],toolCallCounts:{},visited:[],resumeAgain:false,errorContains:['거절']}]};


