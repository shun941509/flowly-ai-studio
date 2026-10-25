import type { FlowNode } from '../../app/lib/model';
import type { WorkflowDesign } from '../workflow-design';
import { layoutWorkflow } from '../workflow-layout';

/** A substantive Agent decision gates publication; it cannot override runtime checks. */
export function addKnowledgeResultReview(design:WorkflowDesign):WorkflowDesign {
  const definition=structuredClone(design.definition);
  for(const output of definition.nodes.filter(node=>node.type==='output')) {
    const link=definition.edges.find(edge=>edge.target===output.id);
    if(!link)throw new Error(`Knowledge output has no source: ${design.id}/${output.id}`);
    const source=link.source,id=`${output.id}_agent`,gate=`${output.id}_decision`,held=`${output.id}_held`;
    const agent:FlowNode={id,type:'agent',title:'검색·색인 관측의 공개 가능성 검토',x:0,y:0,prompt:'KNOWLEDGE_RESULT_REVIEW: observations는 실제 색인 또는 검색 결과입니다. 세대·문서 버전·검색 범위·철회 상태에 모순이 없는지 검토하고 {accepted:boolean,reason:string} JSON을 반환하세요. 원문에서 확인되지 않는 업무 사실을 만들지 마세요. 확인이 부족하면 false입니다. 판정은 결과 공개만 제어하고 이미 수행한 색인 작업을 취소하지 않습니다.',format:'JSON',allowedTools:[],inputBindings:{observations:{nodeId:source,path:'text'}},limits:{maxTurns:1,maxToolCalls:1,maxTokens:12000,maxDurationMs:60000}};
    definition.nodes.push(agent,{id:gate,type:'condition',title:'Agent 검토 후 결과 공개',x:0,y:0,predicate:{path:'accepted',operator:'eq',value:true},inputBindings:{accepted:{nodeId:id,path:'data.accepted'},original:{nodeId:source,path:'text'},reason:{nodeId:id,path:'data.reason'}}},{id:held,type:'transform',title:'근거 부족 결과 보류',x:0,y:0,inputBindings:{},transform:{mode:'template',template:'{"held":true,"reason":"Agent가 관측 결과의 공개를 보류했습니다. 이미 완료한 색인 작업의 상태는 유지됩니다."}'}},{id:`${held}_out`,type:'output',title:'결과 보류 안내',x:0,y:0,inputBindings:{text:{nodeId:held,path:'text'}}});
    link.target=id;
    output.inputBindings={text:{nodeId:gate,path:'original'}};
    definition.edges.push({id:`${id}_decision`,source:id,target:gate},{id:`${id}_context`,source,target:gate},{id:`${id}_accepted`,source:gate,target:output.id,branch:'yes'},{id:`${id}_rejected`,source:gate,target:held,branch:'no'},{id:`${id}_held_output`,source:held,target:`${held}_out`});
  }
  const scenarios=design.scenarios.map(scenario=>scenario.status==='succeeded'?{...scenario,modelReplies:[...(scenario.modelReplies??[]),{match:'KNOWLEDGE_RESULT_REVIEW:',text:'{"accepted":true,"reason":"관측된 세대와 결과의 범위가 일치합니다."}'}]}:scenario);
  const first=design.scenarios[0];
  scenarios.push({...first,name:'Agent가 검색·색인 관측을 불충분하다고 판단하면 결과 공개 보류',stateGroup:undefined,outputs:undefined,resumeAgain:true,contains:['"held":true'],excludes:[],modelReplies:[{match:'KNOWLEDGE_RESULT_REVIEW:',text:'{"accepted":false,"reason":"업무 적용 범위를 확인할 추가 검토가 필요합니다."}'}]});
  return {...design,definition:layoutWorkflow(definition),scenarios,acceptance:[...design.acceptance,'명시적 Agent가 실제 관측 결과를 검토하고 공개 여부를 결정합니다. 런타임의 검색 평가·권한·철회 검사를 덮어쓰지 않습니다.']};
}

export function addCandidateReview(design:WorkflowDesign):WorkflowDesign {
  const definition=structuredClone(design.definition),solved=definition.nodes.find(node=>node.id==='solved')!;
  solved.inputBindings={...solved.inputBindings,original:{nodeId:'parse',path:'data'}};
  definition.edges.push({id:'review_original_input',source:'parse',target:'solved'});
  const downstream=definition.edges.find(edge=>edge.source==='solved'&&edge.branch==='yes')!;
  const target=definition.nodes.find(node=>node.id===downstream.target)!;
  downstream.target='candidate_reviewer';
  definition.nodes.push({id:'candidate_reviewer',type:'agent',title:'원래 요청과 검증 후보의 업무 적합성 검토',x:0,y:0,prompt:'CANDIDATE_PUBLIC_REVIEW: original과 selected,total을 대조해 공개 가능한지 검토하세요. 합계의 계산 결과를 바꾸지 마세요. 원래 조건에 없는 의미나 해답 유일성·부재를 주장하지 마세요. {accepted:boolean,reason:string} JSON을 반환하고 적용 범위가 불분명하면 false입니다.',format:'JSON',allowedTools:[],inputBindings:{original:{nodeId:'solved',path:'original'},selected:{nodeId:'solved',path:'search.selected'},total:{nodeId:'solved',path:'search.total'}},limits:{maxTurns:1,maxToolCalls:1,maxTokens:6000,maxDurationMs:60000}},
    {id:'candidate_reviewed',type:'condition',title:'독립 Agent 검토 수락 여부',x:0,y:0,predicate:{path:'accepted',operator:'eq',value:true},inputBindings:{accepted:{nodeId:'candidate_reviewer',path:'data.accepted'},search:{nodeId:'solved',path:'search'}}},
    {id:'candidate_held',type:'transform',title:'후보 적용 범위 보류',x:0,y:0,inputBindings:{},transform:{mode:'template',template:'계산한 후보의 업무 적용 범위를 Agent가 확인하지 못해 공개를 보류했습니다.'}},
    {id:'candidate_held_out',type:'output',title:'후보 보류 안내',x:0,y:0});
  for(const binding of Object.values(target.inputBindings??{}))if(binding.nodeId==='solved')binding.nodeId='candidate_reviewed';
  definition.edges.push({id:'candidate_agent_review',source:'candidate_reviewer',target:'candidate_reviewed'},{id:'candidate_review_context',source:'solved',target:'candidate_reviewed',branch:'yes'},{id:'candidate_accept',source:'candidate_reviewed',target:target.id,branch:'yes'},{id:'candidate_reject',source:'candidate_reviewed',target:'candidate_held',branch:'no'},{id:'candidate_held_output',source:'candidate_held',target:'candidate_held_out'});
  const scenarios=design.scenarios.map(scenario=>{
    const runsReview=scenario.status==='succeeded'&&scenario.modelCallCounts;
    return runsReview?{...scenario,modelReplies:[...(scenario.modelReplies??[]),{match:'CANDIDATE_PUBLIC_REVIEW:',text:'{"accepted":true,"reason":"원래 항목과 계산한 후보의 사용 범위를 확인했습니다."}'}],modelCallCounts:{...scenario.modelCallCounts,'CANDIDATE_PUBLIC_REVIEW:':1}}:scenario;
  });
  const first=design.scenarios[0];
  scenarios.push({...first,name:'계산 성공 뒤 Agent의 적용 범위 거절은 결과 공개 차단',review:undefined,resumeAgain:true,contains:['공개를 보류'],outputs:undefined,modelReplies:[...(first.modelReplies??[]),{match:'CANDIDATE_PUBLIC_REVIEW:',text:'{"accepted":false,"reason":"실제 업무 적용 조건이 더 필요합니다."}'}],modelCallCounts:{...first.modelCallCounts,'CANDIDATE_PUBLIC_REVIEW:':1},skipped:['result']});
  return {...design,definition:layoutWorkflow(definition),scenarios,acceptance:[...design.acceptance,'명시적 Agent가 원래 요청과 공개 후보의 적합성을 검토하며, 거절하면 계산 성공만으로 결과를 공개하지 않습니다.']};
}
