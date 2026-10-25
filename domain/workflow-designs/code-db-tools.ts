import type { Definition, FlowNode, Resource } from '../../app/lib/model';
import type { DataSchema, InputBinding, Json } from '../../runtime/types';
import type { WorkflowDesign, WorkflowScenario } from '../workflow-design';
import { serializeMcpRegistration } from '../mcp-registration';
import { layoutWorkflow } from '../workflow-layout';

/** Real executable orchestration contracts. Responses below are test scenarios,
 * never product tool implementations or credentials. Company MCP supplies the
 * repository/database adapters and must isolate trial execution itself. */
const stamp='2026-10-25T00:00:00Z';
const obj:DataSchema={type:'object'};
const schema:DataSchema={type:'object',properties:{payload:obj},required:['payload'],additionalProperties:false};
const bind=(nodeId:string,path='text'):InputBinding=>({nodeId,path});
type Ref={id:string;path:string;branch?:string};
type Fixture=NonNullable<WorkflowScenario['toolReplies']>[number];
type Reply=NonNullable<WorkflowScenario['modelReplies']>[number];
type ToolSpec={name:string;description:string;effect:'read'|'write';inputSchema:DataSchema};
type Snapshot={fixtures:Fixture[];replies:Reply[];nodeId:string;record:Record<string,Json>;mutation?:{fixtureName:string;field:string;value:Json}};

class DesignBuilder {
  nodes:FlowNode[]=[];edges:Definition['edges']=[];fixtures:Fixture[]=[];replies:Reply[]=[];specs:ToolSpec[]=[];gates:Snapshot[]=[];
  recoveryScenarios:WorkflowScenario[]=[];
  current:Ref={id:'request',path:'data'};record:Record<string,Json>;serial=0;lastParallel:string[]=[];
  constructor(readonly plan:string,readonly slug:string,readonly title:string,readonly purpose:string) {
    this.record={target:`company-${plan}`,request:purpose};
    this.nodes=[{id:'input',type:'input',title:'대상과 업무 요청',x:0,y:0},{id:'request',type:'transform',title:'구조화된 요청 확인',x:0,y:0,transform:{mode:'parse_json'}}];
    this.edges=[{id:'initial',source:'input',target:'request'}];
  }
  id(prefix:string){return `${prefix}_${++this.serial}`;}
  add(node:FlowNode,from:Ref=this.current,path='data.structuredContent') {
    this.nodes.push(node);this.edges.push({id:this.id('edge'),source:from.id,target:node.id,...(from.branch?{branch:from.branch}:{})});
    this.current={id:node.id,path};return node.id;
  }
  tool(operation:string,purpose:string,result:Record<string,Json>,effect:'read'|'write'='read') {
    const name=`p${this.plan}_${operation}`,id=this.id(operation),input=structuredClone(this.record);
    this.specs.push({name,description:`${purpose}。payload는 이전 단계의 실제 산출물입니다. 임의 SQL·쉘 명령을 실행하지 말고 등록된 대상과 작업만 처리하세요. 결과 필드: ${Object.keys(result).join(', ')}.`,effect,inputSchema:schema});
    this.add({id,type:'tool',title:purpose,x:0,y:0,allowedTools:[{resourceId:`code-db-${this.plan}`,connectionId:`code-db-${this.plan}`,toolName:name}],tool:{arguments:{},bindings:{payload:'payload'}},inputBindings:{payload:bind(this.current.id,this.current.path)}});
    this.record=structuredClone(result);this.fixtures.push({name,args:{payload:input},result:{structuredContent:result}});return this;
  }
  agent(role:string,purpose:string,result:Record<string,Json>) {
    const id=this.id(role),marker=`CODE_DB_${this.plan}_${role.toUpperCase()}:`;
    this.add({id,type:'agent',title:purpose,x:0,y:0,prompt:`${marker} ${purpose}. 이전 단계 payload만 근거로 JSON 산출물을 작성하세요. 수행하지 않은 시험·변경을 성공이라고 말하지 마세요. 대상·버전·산출물 ID를 보존하고 다음 단계가 필요한 필드를 포함하세요. 필드 계약: ${Object.keys(result).join(', ')}. 내부 사고 원문을 출력하지 마세요.`,format:'JSON',outputSchema:{type:'object',properties:{text:{type:'string'},data:obj},required:['text','data']},allowedTools:[],inputBindings:{payload:bind(this.current.id,this.current.path)},limits:{maxTurns:2,maxToolCalls:1,maxTokens:4000,maxDurationMs:60000}},this.current,'data');
    this.replies.push({match:marker,text:JSON.stringify(result),inputContains:[JSON.stringify(Object.keys(this.record)[0])]});this.record=structuredClone(result);return this;
  }
  gate(field:string,purpose:string,value:Json=true,operator:'eq'|'lte'|'gte'|'gt'='eq') {
    const id=this.id('gate'),source=this.current;
    this.add({id,type:'condition',title:purpose,x:0,y:0,predicate:{path:`record.${field}`,operator,value:value as string|number|boolean},inputBindings:{record:bind(source.id,source.path)}},source,'record');
    this.gates.push({fixtures:structuredClone(this.fixtures),replies:structuredClone(this.replies),nodeId:id,record:structuredClone(this.record)});
    const held=this.id('held'),output=this.id('held_output');
    this.nodes.push({id:held,type:'transform',title:'완료 조건 미달로 보류',x:0,y:0,inputBindings:{},transform:{mode:'template',template:JSON.stringify({status:'held',example:this.plan,reason:purpose})}},{id:output,type:'output',title:'보류 사유',x:0,y:0,inputBindings:{text:bind(held)}});
    this.edges.push({id:this.id('edge'),source:id,target:held,branch:'no'},{id:this.id('edge'),source:held,target:output});
    this.current={id,path:'record',branch:'yes'};return this;
  }
  review(purpose:string) {
    const id=this.id('review'),source=this.current;
    this.add({id,type:'review',title:purpose,x:0,y:0,review:{instructions:`${purpose}. 이 검토와 이후 실제 변경 도구 승인은 별도입니다.`,allowEdit:false,timeoutMinutes:30},inputBindings:{record:bind(source.id,source.path)}},source,'record');
    const held=this.id('review_declined'),out=this.id('review_output');
    this.nodes.push({id:held,type:'transform',title:'검토 거절 기록',x:0,y:0,inputBindings:{},transform:{mode:'template',template:JSON.stringify({status:'held',example:this.plan,reason:'human_review_declined'})}},{id:out,type:'output',title:'거절 결과',x:0,y:0,inputBindings:{text:bind(held)}});
    this.edges.push({id:this.id('edge'),source:id,target:held,branch:'no'},{id:this.id('edge'),source:held,target:out});
    this.current={id,path:'record',branch:'yes'};return this;
  }
  parallel(purpose:string,jobs:{operation:string;purpose:string;result:Record<string,Json>}[]) {
    const id=this.id('parallel'),payload=structuredClone(this.record),source=this.current;
    this.lastParallel=jobs.map(job=>`p${this.plan}_${job.operation}`);
    const tasks=jobs.map((job,index)=>{
      const name=`p${this.plan}_${job.operation}`,prefix=`${id}_${index}`;
      this.specs.push({name,description:`${job.purpose}. 사내에 등록된 대상만 읽거나 격리 시험하세요. 결과 필드: ${Object.keys(job.result).join(', ')}.`,effect:'read',inputSchema:schema});
      this.fixtures.push({name,args:{payload},result:{structuredContent:job.result}});
      return {id:job.operation,name:job.purpose,definition:layoutWorkflow({schemaVersion:5,nodes:[{id:`${prefix}_in`,type:'input',title:'공통 대상 받기',x:0,y:0},{id:`${prefix}_tool`,type:'tool',title:job.purpose,x:0,y:0,allowedTools:[{resourceId:`code-db-${this.plan}`,connectionId:`code-db-${this.plan}`,toolName:name}],tool:{arguments:{},bindings:{payload:'payload'}},inputBindings:{payload:bind(`${prefix}_in`,'payload')}},{id:`${prefix}_out`,type:'output',title:'관측 산출물 전달',x:0,y:0,inputBindings:{text:bind(`${prefix}_tool`),data:bind(`${prefix}_tool`,'data.structuredContent')}}],edges:[{id:`${prefix}_e1`,source:`${prefix}_in`,target:`${prefix}_tool`},{id:`${prefix}_e2`,source:`${prefix}_tool`,target:`${prefix}_out`}]})};
    });
    this.add({id,type:'parallel',title:purpose,x:0,y:0,parallel:{concurrency:Math.min(4,jobs.length),tasks},inputBindings:{payload:bind(source.id,source.path)}},source,'results');
    // Wrap the real ordered task outputs into an object accepted by later tools.
    const wrap=this.id('observations');
    this.add({id:wrap,type:'merge',title:'독립 관측 결과 모으기',x:0,y:0,merge:{mode:'object'},inputBindings:{results:bind(id,'results')}},this.current,'data');
    // Runtime task result contracts also include task IDs/names. Do not pass
    // those envelopes back to MCP fixtures; Agent normalizes the observations.
    this.record={results:jobs.map(job=>({taskId:job.operation,data:job.result}))};
    return this;
  }
  verifyParallel(checks:{task:number;field:string;value:Json}[],purpose:string) {
    const source=this.current,id=this.id('verify_observations');
    this.add({id,type:'program',title:purpose,x:0,y:0,program:{name:'goal_check',arguments:{checks:checks.map(check=>({path:`results.${check.task}.output.data.${check.field}`,operator:'eq',value:check.value}))},bindings:{data:'record'}},inputBindings:{record:bind(source.id,source.path)}},source,'data');
    const merged=this.id('verified_observations');
    this.add({id:merged,type:'merge',title:'검사와 원본 관측 함께 전달',x:0,y:0,merge:{mode:'object'},inputBindings:{verification:bind(id,'data'),observations:bind(source.id,source.path)}},this.current,'data');
    this.edges.push({id:this.id('edge'),source:source.id,target:merged,...(source.branch?{branch:source.branch}:{})});
    this.record={verification:{passed:true},observations:this.record};
    this.gate('verification.passed',purpose);
    const first=checks[0];this.gates.at(-1)!.mutation={fixtureName:this.lastParallel[first.task],field:first.field,value:typeof first.value==='boolean'?!first.value:typeof first.value==='number'?first.value+1:'mismatch'};
    return this;
  }
  compareParallel(field:string,purpose:string) {
    this.gate(`results.0.output.data.${field}`,purpose);
    const snapshot=this.gates.at(-1)!,node=this.nodes.find(n=>n.id===snapshot.nodeId)!;
    node.predicate={path:`record.results.0.output.data.${field}`,operator:'eq',rightPath:`record.results.1.output.data.${field}`};
    snapshot.mutation={fixtureName:this.lastParallel[1],field,value:'mismatched-observation'};
    return this;
  }
  recoverLastGate(operation:string,purpose:string,result:Record<string,Json>) {
    const snapshot=this.gates.at(-1)!;const gate=this.nodes.find(n=>n.id===snapshot.nodeId)!;
    const oldFailure=this.edges.find(edge=>edge.source===gate.id&&edge.branch==='no')!;
    this.edges=this.edges.filter(edge=>edge!==oldFailure);
    const restore=this.id('restore'),verify=this.id('restore_check'),confirmed=this.id('restored'),message=this.id('recovery_message'),output=this.id('recovery_output');
    const name=`p${this.plan}_${operation}`,verifyName=`p${this.plan}_verify_recovery`;
    this.specs.push({name,description:`${purpose}. payload의 고정된 백업·버전으로만 복구하고 다른 대상으로 확대하지 마세요.`,effect:'write',inputSchema:schema},{name:verifyName,description:'복구된 자료와 원래 스키마 버전을 독립 확인합니다.',effect:'read',inputSchema:schema});
    this.nodes.push({id:restore,type:'tool',title:`${purpose} · 별도 승인`,x:0,y:0,allowedTools:[{resourceId:`code-db-${this.plan}`,connectionId:`code-db-${this.plan}`,toolName:name}],tool:{arguments:{},bindings:{payload:'payload'}},inputBindings:{payload:bind(gate.id,'record')}},
      {id:verify,type:'tool',title:'복구 결과 독립 검사',x:0,y:0,allowedTools:[{resourceId:`code-db-${this.plan}`,connectionId:`code-db-${this.plan}`,toolName:verifyName}],tool:{arguments:{},bindings:{payload:'payload'}},inputBindings:{payload:bind(restore,'data.structuredContent')}},
      {id:confirmed,type:'condition',title:'원래 자료·버전으로 복구됐는지 확인',x:0,y:0,predicate:{path:'record.restored',operator:'eq',value:true},inputBindings:{record:bind(verify,'data.structuredContent')}},
      {id:message,type:'transform',title:'복구와 원래 목표 완료를 구분',x:0,y:0,inputBindings:{},transform:{mode:'template',template:JSON.stringify({status:'recovered',originalGoalComplete:false,example:this.plan})}},
      {id:output,type:'output',title:'복구 결과',x:0,y:0,inputBindings:{text:bind(message)}});
    this.edges.push({id:this.id('edge'),source:gate.id,target:restore,branch:'no'},{id:this.id('edge'),source:restore,target:verify},{id:this.id('edge'),source:verify,target:confirmed},{id:this.id('edge'),source:confirmed,target:message,branch:'yes'},{id:this.id('edge'),source:message,target:output},{id:this.id('edge'),source:confirmed,target:oldFailure.target,branch:'no'});
    const fixtures=structuredClone(snapshot.fixtures),failed=fixtures.at(-1)!.result!.structuredContent as Record<string,Json>;
    failed[gate.predicate!.path.replace(/^record\./,'')]=false;
    fixtures.push({name,args:{payload:structuredClone(failed)},result:{structuredContent:result}},{name:verifyName,args:{payload:result},result:{structuredContent:{...result,restored:true}}});
    this.recoveryScenarios.push({name:'적용 후 검사 실패는 별도 승인 복구와 원래 목표 미완료로 기록',input:JSON.stringify({target:`company-${this.plan}`,request:this.purpose}),status:'succeeded',approval:'approve',review:'accept',modelReplies:structuredClone(snapshot.replies),toolReplies:fixtures,toolCallCounts:Object.fromEntries(fixtures.map(f=>[f.name,1])),contains:['recovered','"originalGoalComplete":false'],excludes:['"status":"verified"'],resumeAgain:true});
    return this;
  }
  finish(summary:string):WorkflowDesign {
    this.agent('final_report','독립 관측과 완료 조건을 확인해 최종 보고',{status:'verified',example:this.plan,summary});
    const output=this.id('output');this.add({id:output,type:'output',title:'검증된 보고',x:0,y:0,inputBindings:{text:bind(this.current.id),data:bind(this.current.id,this.current.path)}},this.current,'text');
    const input=JSON.stringify({target:`company-${this.plan}`,request:this.purpose});
    const normal:WorkflowScenario={name:'등록된 사내 도구의 산출물로 정상 경로 완료',input,status:'succeeded',approval:'approve',review:'accept',modelReplies:structuredClone(this.replies),toolReplies:structuredClone(this.fixtures),toolCallCounts:Object.fromEntries(this.fixtures.map(f=>[f.name,1])),contains:['verified',summary],resumeAgain:true};
    const scenarios=[normal,...this.recoveryScenarios];
    // An independently observed false result cannot be promoted by the model.
    const first=this.gates[0];
    if(first){
      const gate=this.nodes.find(node=>node.id===first.nodeId)!,field=gate.predicate!.path.replace(/^record\./,''),bad=structuredClone(first),predicate=gate.predicate!;
      const original=bad.record[field];
      const replacement:Json=typeof original==='boolean'?!original:typeof original==='number'?predicate.operator==='gte'?(predicate.value as number)-1:(predicate.value as number)+1:'contract-mismatch';
      const lastFixture=bad.fixtures.at(-1),lastReply=bad.replies.at(-1);
      const source=this.edges.find(edge=>edge.target===first.nodeId)!.source;
      const sourceNode=this.nodes.find(node=>node.id===source)!;
      if(bad.mutation){
        const fixture=bad.fixtures.find(f=>f.name===bad.mutation!.fixtureName)!;
        (fixture.result!.structuredContent as Record<string,Json>)[bad.mutation.field]=bad.mutation.value;
        scenarios.push({name:'병렬 도구의 실패를 Agent 판단 전에 계산으로 차단',input,status:'succeeded',approval:'approve',review:'accept',modelReplies:bad.replies,toolReplies:bad.fixtures,toolCallCounts:Object.fromEntries(bad.fixtures.map(f=>[f.name,1])),contains:['held'],excludes:['verified'],skipped:[output]});
      }else if(sourceNode.type==='tool'&&lastFixture){
        const actual=lastFixture.result!.structuredContent as Record<string,Json>;actual[field]=replacement;
        scenarios.push({name:'독립 검사가 완료 조건을 충족하지 못하면 후속 작업 차단',input,status:'succeeded',approval:'approve',review:'accept',modelReplies:bad.replies,toolReplies:bad.fixtures,toolCallCounts:Object.fromEntries(bad.fixtures.map(f=>[f.name,1])),contains:['held'],excludes:['verified'],skipped:[output]});
      }else if(sourceNode.type==='agent'&&lastReply){
        const actual=JSON.parse(lastReply.text!) as Record<string,Json>;actual[field]=replacement;lastReply.text=JSON.stringify(actual);
        scenarios.push({name:'검토 Agent의 보류 판단은 후속 작업을 실행하지 않음',input,status:'succeeded',approval:'approve',review:'accept',modelReplies:bad.replies,toolReplies:bad.fixtures,toolCallCounts:Object.fromEntries(bad.fixtures.map(f=>[f.name,1])),contains:['held'],excludes:['verified'],skipped:[output]});
      }
    }
    const firstWrite=this.fixtures.findIndex(f=>this.specs.find(s=>s.name===f.name)?.effect==='write');
    if(firstWrite>=0){
      const write=this.fixtures[firstWrite],writeNode=this.nodes.find(n=>n.allowedTools?.[0]?.toolName===write.name)!;
      const earlierNodes=new Set(this.nodes.slice(0,this.nodes.indexOf(writeNode)).filter(n=>n.type==='agent').map(n=>n.prompt!.split(':')[0]+':'));
      const preceding=this.fixtures.slice(0,firstWrite);
      scenarios.push({name:'외부 변경 승인 거절 시 해당 변경은 호출하지 않음',input,status:'failed',approval:'deny',review:'accept',modelReplies:this.replies.filter(reply=>earlierNodes.has(reply.match)),toolReplies:preceding,toolCallCounts:Object.fromEntries(preceding.map(f=>[f.name,1])),errorContains:['거절']});
      const ambiguous=[...structuredClone(preceding),{...structuredClone(write),error:'disconnect' as const}];
      scenarios.push({name:'변경 응답 유실은 결과 불명으로 멈추고 재실행하지 않음',input,status:'unknown_outcome',approval:'approve',review:'accept',modelReplies:this.replies.filter(reply=>earlierNodes.has(reply.match)),toolReplies:ambiguous,toolCallCounts:Object.fromEntries(ambiguous.map(f=>[f.name,1])),resumeAgain:true});
    }
    const resource:Resource={id:`code-db-${this.plan}`,ownerId:'flowly-examples',type:'mcp',name:`${this.plan} 사내 코드·DB 작업 계약`,description:'미설정: 사내 구현을 도구 및 자료에 등록하세요. 내보낸 .env에서 주소·토큰을 지정합니다. 이 자료는 실제 코드 실행기·DB 서버 구현을 포함하지 않습니다.',url:'https://company-mcp.example.invalid/mcp',content:serializeMcpRegistration({version:1,connectionId:`code-db-${this.plan}`,endpointEnv:'FLOWLY_MCP_ENDPOINT_CODE_DB',tokenEnv:'FLOWLY_MCP_TOKEN_CODE_DB',tools:this.specs}),visibility:'public',allowedEmails:[],sample:true,createdAt:stamp,updatedAt:stamp};
    return {id:`integrated-${this.plan}-${this.slug}`,title:`${this.plan} · ${this.title}`,category:'코드·DB 전문 Agent',description:this.purpose,behavior:`실제 사내 도구 산출물 → Agent 판단 → 조건 검사 → 필요한 검토·승인 → 독립 확인. ${this.purpose}`,definition:layoutWorkflow({schemaVersion:5,nodes:this.nodes,edges:this.edges},{recursive:true}),resources:[resource],inputExample:input,expectedOutput:summary,acceptance:['웹 모델 호출 없음.','사내 MCP 계약과 실행 환경 설정을 분리합니다.','시험 응답은 검증 어댑터에만 있으며 제품 ZIP의 실제 결과로 포함하지 않습니다.','완료 조건 미달·검토 거절·변경 승인 거절을 분리합니다.'],failureCases:scenarios.slice(1).map(s=>s.name),scenarios};
  }
}

const design=(id:string,slug:string,title:string,purpose:string)=>new DesignBuilder(id,slug,title,purpose);
const target=(id:string)=>({target:`company-${id}`});

const bug=design('069','code-repair','재현 근거를 확인한 버그 수정','등록된 결함을 재현하고 수정 후보 시험·독립 리뷰·승인된 적용·재검증을 연결합니다.')
  .tool('reproduce','격리 환경에서 결함 재현',{...target('069'),reproduced:true,baseline:'rev1',evidence:'trace-1'})
  .gate('reproduced','결함 재현 근거 확인')
  .agent('implementation','재현 근거에 맞는 수정 후보 선택',{...target('069'),baseline:'rev1',operation:'fix_registered_defect'})
  .tool('prepare_patch','격리 패치와 시험 산출물 준비',{...target('069'),artifact:'patch-1',testsPassed:true})
  .gate('testsPassed','실제 패치 시험 통과')
  .agent('independent_review','시험 산출물과 변경 범위를 독립 검토',{...target('069'),artifact:'patch-1',accepted:true})
  .gate('accepted','독립 검토 수락')
  .tool('apply_patch','검토한 패치 적용 · 승인 필요',{...target('069'),revision:'rev2',artifact:'patch-1'},'write')
  .tool('verify_patch','적용 버전에서 회귀 시험 재실행',{...target('069'),revision:'rev2',verified:true})
  .gate('verified','적용 후 회귀 시험 확인').finish('재현된 결함의 수정과 적용 후 시험을 확인했습니다.');

const refactor=design('070','behavior-refactor','동작 보존 리팩터링','코드 구조와 기준 동작을 병렬 관측하고 동작 차이 검사를 통과한 리팩터링만 검토·적용합니다.')
  .parallel('구조와 기준 동작 독립 조사',[{operation:'inspect_structure',purpose:'코드 구조 분석',result:{module:'module-a',revision:'rev1'}},{operation:'capture_behavior',purpose:'기준 입력·출력 수집',result:{baseline:'behavior-1',cases:12}}])
  .agent('refactor_plan','구조 개선과 동작 보존 조건 정의',{...target('070'),baseline:'behavior-1',operation:'extract_component'})
  .tool('compare_candidate','리팩터링 후보의 동작 차이 검사',{...target('070'),artifact:'refactor-1',equivalent:true,cases:12})
  .gate('equivalent','기준 동작과 후보 동작 일치').review('동작 차이와 공개 API 변경 여부 검토')
  .tool('apply_refactor','동작 보존 후보 적용 · 승인 필요',{...target('070'),revision:'rev2'},'write')
  .tool('verify_public_api','적용 후 공개 API 호환성 확인',{...target('070'),compatible:true})
  .gate('compatible','적용 후 API 계약 유지').finish('기준 동작과 공개 API를 보존한 리팩터링을 확인했습니다.');

const upgrade=design('071','dependency-upgrade','의존성 업그레이드 행렬 검증','의존성 변경 범위를 확인하고 단위·통합·호환 시험을 독립 실행한 뒤 검증된 잠금 파일을 적용합니다.')
  .tool('inspect_dependencies','현재 잠금 파일·지원 범위 조회',{...target('071'),lockHash:'lock1',allowedVersion:'v2'})
  .agent('upgrade_plan','허용 버전과 영향 범위를 정리',{...target('071'),from:'v1',to:'v2',lockHash:'lock1'})
  .tool('resolve_lock','격리 환경에서 새 잠금 파일 해석',{...target('071'),artifact:'lock2',resolvable:true})
  .gate('resolvable','의존성 충돌 없음')
  .parallel('서로 다른 시험 계약 병렬 검증',[{operation:'unit_matrix',purpose:'단위 시험',result:{passed:true,suite:'unit'}},{operation:'integration_matrix',purpose:'통합 시험',result:{passed:true,suite:'integration'}},{operation:'compatibility_matrix',purpose:'지원 버전 호환 시험',result:{passed:true,suite:'compatibility'}}])
  .verifyParallel([{task:0,field:'passed',value:true},{task:1,field:'passed',value:true},{task:2,field:'passed',value:true}],'세 시험의 실제 통과 값 확인')
  .agent('matrix_review','세 시험 산출물의 누락·실패를 확인',{...target('071'),artifact:'lock2',allPassed:true})
  .gate('allPassed','세 시험 결과 확인').tool('apply_lock','검증된 잠금 파일 적용 · 승인 필요',{...target('071'),lockHash:'lock2'},'write')
  .finish('단위·통합·호환 시험을 확인한 의존성 변경입니다.');

const coverage=design('072','test-gap','누락 시험 분석과 개선 검증','기준 커버리지와 미검증 요구사항을 읽고 Agent가 작성한 시험 후보가 실제 실패를 탐지하는지 확인합니다.')
  .tool('coverage_baseline','기준 커버리지와 누락 요구사항 조회',{...target('072'),uncovered:['empty_input'],baseline:70})
  .agent('test_design','누락 요구사항을 검증하는 시험 후보 설계',{...target('072'),caseId:'empty_input',expected:'reject'})
  .tool('mutation_test','격리 시험과 변이 탐지율 측정',{...target('072'),detected:true,newCoverage:85,baseline:70})
  .gate('detected','결함 변이를 실제 탐지')
  .tool('test_stability','반복 실행으로 불안정 시험 확인',{...target('072'),stable:true,runs:10})
  .gate('stable','반복 시험 안정성 확인').finish('누락 요구사항과 결함 변이를 탐지하는 안정된 시험 후보입니다.');

const concurrency=design('073','concurrency-analysis','동시성 결함 분석','경합을 재현하고 스케줄 변화와 이벤트 순서를 병렬 분석해 수정 가설을 검증합니다.')
  .tool('reproduce_race','경합 재현 및 사건 ID 고정',{...target('073'),reproduced:true,traceId:'race-1'})
  .gate('reproduced','경합 재현 확인')
  .agent('race_hypothesis','공유 상태와 순서 가설 정의',{...target('073'),traceId:'race-1',hypothesis:'lost_update'})
  .parallel('스케줄·이벤트 독립 분석',[{operation:'stress_schedules',purpose:'다른 스케줄에서 반복 시험',result:{lostUpdates:3,runs:20}},{operation:'inspect_events',purpose:'이벤트 선후 관계 조회',result:{conflictingWrites:2}}])
  .agent('race_fix','관측 결과에 맞는 동기화 후보 선택',{...target('073'),operation:'atomic_update',traceId:'race-1'})
  .tool('verify_race_fix','격리 수정 후보에 경합 시험 적용',{...target('073'),lostUpdates:0,verified:true})
  .gate('verified','후보 경합 시험 통과').review('동기화 비용과 교착 가능성 검토').finish('경합 재현과 동기화 후보 시험 결과를 확인했습니다.');

const performance=design('074','performance-regression','성능 회귀 비교','같은 부하 조건의 기준·후보 프로파일을 병렬 측정하고 측정 차이와 원인 가설을 분리합니다.')
  .parallel('동일 부하의 두 프로파일',[{operation:'baseline_profile',purpose:'기준 버전 부하 측정',result:{p95:100,requests:1000,loadId:'load-1'}},{operation:'candidate_profile',purpose:'후보 버전 부하 측정',result:{p95:160,requests:1000,loadId:'load-1'}}])
  .compareParallel('loadId','측정 부하 ID 동일성 검사')
  .agent('profile_analysis','부하 동일성과 성능 회귀 근거 대조',{...target('074'),sameLoad:true,regression:true,hypothesis:'query_count'})
  .gate('sameLoad','비교 부하 조건 일치').tool('profile_hypothesis','프로파일 가설의 실제 호출 횟수 검사',{...target('074'),queryIncrease:30,evidence:'profile-call-count'})
  .review('측정 환경과 개선 범위 검토').finish('같은 부하에서 측정한 회귀와 추가 조사 근거입니다.');

const frontend=design('075','frontend-verification','화면 상호작용·접근성 검증','화면 계약을 고정하고 키보드·접근성·시각 상태를 독립 검사한 뒤 수정 우선순위를 검토합니다.')
  .tool('inspect_screen','대상 화면과 상호작용 계약 조회',{...target('075'),screen:'settings',revision:'ui1'})
  .parallel('화면의 세 관점 검사',[{operation:'keyboard_test',purpose:'키보드 이동·포커스 검사',result:{critical:0,focusOrder:['name','save']}},{operation:'accessibility_test',purpose:'접근성 규칙 검사',result:{critical:0,warnings:1}},{operation:'visual_test',purpose:'화면 크기별 겹침 검사',result:{critical:0,widths:[390,1440]}}])
  .verifyParallel([{task:0,field:'critical',value:0},{task:1,field:'critical',value:0},{task:2,field:'critical',value:0}],'세 검사에서 차단 결함이 없음')
  .agent('ui_review','세 검사 결과의 실패·누락과 우선순위 판단',{...target('075'),blocking:0,followUp:'contrast_warning'})
  .gate('blocking','차단 결함 없음',0).review('경고와 실제 사용성 확인 범위 검토')
  .tool('interaction_replay','확인된 입력·저장 동작 재생',{...target('075'),saved:true,networkWrites:0})
  .gate('saved','격리 화면 저장 동작 확인').finish('키보드·접근성·시각 검사와 격리 동작 재생을 확인했습니다.');

const build=design('076','reproducible-build','재현 가능한 빌드','고정된 소스·잠금 파일·환경으로 두 격리 빌드를 수행하고 산출물 해시와 구성 정보를 대조합니다.')
  .tool('build_manifest','소스·의존성·환경 버전 고정',{...target('076'),source:'commit1',lock:'lock1',environment:'env1'})
  .agent('build_plan','고정된 빌드 입력과 비교 대상 확인',{...target('076'),source:'commit1',lock:'lock1',environment:'env1'})
  .parallel('독립 환경 두 곳에서 빌드',[{operation:'build_a',purpose:'첫 격리 빌드',result:{artifactHash:'sha256:fixture',environment:'env1'}},{operation:'build_b',purpose:'두 번째 격리 빌드',result:{artifactHash:'sha256:fixture',environment:'env1'}}])
  .compareParallel('artifactHash','두 실제 산출물 해시 일치')
  .agent('build_comparison','두 해시와 환경 조건을 대조',{...target('076'),hashesMatch:true,artifactHash:'sha256:fixture'})
  .gate('hashesMatch','독립 빌드 해시 일치').tool('artifact_manifest','산출물 구성 목록 검사',{...target('076'),complete:true,files:12})
  .gate('complete','필수 산출물 포함').finish('고정 입력의 두 격리 빌드와 산출물 구성을 확인했습니다.');

const assets=design('079','database-diagnosis','DB 자산·상태 진단','등록된 DB 자산의 연결·용량·오류·권한 상태를 독립 조회하고 근거 있는 진단을 만듭니다.')
  .tool('database_inventory','등록된 DB 자산·버전 확인',{...target('079'),database:'db1',version:'schema1'})
  .parallel('상태 지표 병렬 조회',[{operation:'health',purpose:'상태 지표',result:{reachable:true}},{operation:'capacity',purpose:'용량 지표',result:{usedPercent:55}},{operation:'errors',purpose:'오류 통계',result:{recentErrors:0}},{operation:'permissions',purpose:'서비스 권한 범위',result:{excessPrivileges:0}}])
  .agent('diagnosis','독립 관측과 미확인 영역을 구분해 진단',{...target('079'),evidenceComplete:true,severity:'normal'})
  .gate('evidenceComplete','필수 상태 관측 확보').finish('DB 자산의 상태·용량·오류·권한 관측을 종합했습니다.');

const query=design('080','query-performance','느린 질의 분석','느린 질의의 실행 계획과 통계를 읽고 후보를 격리 시험해 결과 동등성과 비용 감소를 확인합니다.')
  .tool('explain_query','등록된 질의의 실행 계획 조회',{...target('080'),queryId:'query1',cost:100})
  .agent('query_plan','실행 계획에 맞는 최적화 후보 선택',{...target('080'),queryId:'query1',operation:'use_registered_rewrite'})
  .tool('dry_run_query','격리 후보 질의의 결과·비용 대조',{...target('080'),equivalent:true,cost:60})
  .gate('equivalent','결과 집합 동등성 확인').agent('query_cost_review','동등한 결과의 후보에 부하·캐시 조건을 지정',{...target('080'),queryId:'query1',load:'same-load',cache:'warm-and-cold'})
  .tool('repeat_query','반복 부하에서 비용 재측정',{...target('080'),p95Improved:true,runs:10})
  .gate('p95Improved','반복 측정 개선 확인').finish('결과 동등성과 반복 측정 개선을 확인한 질의 후보입니다.');

const indexes=design('081','index-management','색인 변경 검토·적용','읽기·쓰기 부하를 함께 고려한 색인 후보를 시험하고 검토·승인 후 적용과 후속 부하를 검사합니다.')
  .tool('index_inventory','현재 색인과 질의 사용량 조회',{...target('081'),indexVersion:1,queryId:'query1'})
  .agent('index_proposal','질의 개선과 쓰기 비용을 함께 검토',{...target('081'),operation:'create_registered_index',expectedVersion:1})
  .tool('index_trial','격리 색인의 읽기·쓰기 비용 측정',{...target('081'),acceptable:true,artifact:'index-plan1'})
  .gate('acceptable','쓰기 비용 한도 내의 개선').review('색인 크기·잠금·롤백 조건 확인')
  .tool('apply_index','검토한 색인 적용 · 승인 필요',{...target('081'),indexVersion:2},'write')
  .tool('verify_index','적용 후 실행 계획과 쓰기 지연 검사',{...target('081'),verified:true})
  .gate('verified','색인 변경 후 독립 확인').tool('index_observation','추가 관측 구간의 오류 검사',{...target('081'),errors:0})
  .finish('읽기 개선과 쓰기 비용을 확인한 색인 변경입니다.');

const locks=design('082','deadlock-investigation','잠금·교착 분석','잠금 스냅샷을 고정해 대기 관계와 장기 트랜잭션을 분석하고 승인된 제한 조치 뒤 재확인합니다.')
  .tool('lock_snapshot','잠금 스냅샷과 영향 범위 수집',{...target('082'),snapshot:'locks1',confirmed:true})
  .gate('confirmed','대기 관계 스냅샷 확보')
  .parallel('대기·트랜잭션 독립 분석',[{operation:'wait_graph',purpose:'대기 관계 순환 확인',result:{cycle:true,transactionIds:['t1','t2']}},{operation:'transaction_age',purpose:'장기 트랜잭션 확인',result:{oldest:'t1',seconds:300}}])
  .agent('lock_action','영향 범위가 제한된 등록 조치 선택',{...target('082'),operation:'cancel_registered_session',session:'t1'})
  .review('세션 중단 영향과 재시도 책임 확인').tool('apply_lock_action','대상 세션 조치 · 승인 필요',{...target('082'),actionId:'action1'},'write')
  .tool('verify_locks','대기·오류 변화 재조회',{...target('082'),resolved:true})
  .gate('resolved','잠금 영향 해소 확인').finish('제한된 승인 조치 이후 잠금 상태를 재확인했습니다.');

const migration=design('083','schema-migration','스키마 변경 배포 검증','스키마 차이와 호환 조건을 분석하고 격리 이관 시험·백업·승인된 변경·데이터 보존 검사를 연결합니다.')
  .tool('schema_snapshot','현재 스키마·행 수·버전 고정',{...target('083'),version:1,rows:12})
  .agent('migration_plan','순방향·복구 계약이 있는 이관 후보 선택',{...target('083'),operation:'registered_migration_v2',expectedVersion:1})
  .tool('migration_rehearsal','격리 이관과 복구 절차 시험',{...target('083'),rehearsed:true,plan:'migration2'})
  .gate('rehearsed','이관·복구 리허설 완료').tool('create_migration_backup','변경 전 백업 생성 · 승인 필요',{...target('083'),backupId:'backup1',version:1},'write')
  .tool('apply_migration','버전 결합 스키마 변경 · 승인 필요',{...target('083'),backupId:'backup1',version:2},'write')
  .tool('verify_migration','행 보존·제약·호환성 독립 검사',{...target('083'),verified:true,rows:12,backupId:'backup1',version:2})
  .gate('verified','이관 후 자료·계약 확인').recoverLastGate('restore_migration_backup','변경 전 백업으로 복구',{...target('083'),backupId:'backup1',version:1})
  .review('변경 후 관측과 복구 지점 인계').finish('리허설·백업·승인된 변경과 자료 보존 검사를 확인했습니다.');

const backup=design('084','backup-restore','백업·복원 리허설','백업 정책과 복구 목표를 확인하고 새 백업의 무결성 및 격리 복원 결과를 실제 검사합니다.')
  .tool('backup_policy','백업 보존·복구 목표 조회',{...target('084'),rpoMinutes:60,rtoMinutes:30})
  .agent('restore_plan','복구 목표에 맞는 백업·격리 복원 계획',{...target('084'),operation:'backup_and_isolated_restore',rtoMinutes:30})
  .tool('create_backup','새 백업 생성 · 승인 필요',{...target('084'),backupId:'backup2'},'write')
  .tool('verify_backup','백업 체크섬과 필수 객체 검사',{...target('084'),backupId:'backup2',integrity:true})
  .gate('integrity','백업 무결성 확인').tool('restore_rehearsal','격리 대상에 복원 · 승인 필요',{...target('084'),restoredTarget:'isolated-db',durationMinutes:12},'write')
  .tool('verify_restore','격리 복원 행·제약·접속 시험',{...target('084'),verified:true,durationMinutes:12})
  .gate('verified','복원 자료와 제약 확인').gate('durationMinutes','복구 시간 목표 충족',30,'lte')
  .finish('백업 무결성과 격리 복원의 자료·시간 목표를 확인했습니다.');

const permissions=design('086','database-permissions','DB 권한 최소화 검토','현재 권한과 사용 근거를 비교하고 최소 권한 변경을 검토·승인한 뒤 허용·거절 동작을 함께 확인합니다.')
  .tool('privilege_inventory','사용자·역할·최근 사용 권한 조회',{...target('086'),role:'service1',version:1})
  .agent('privilege_proposal','사용 근거와 업무 필요를 대조해 권한 변경 제안',{...target('086'),operation:'remove_unused_grant',expectedVersion:1})
  .tool('privilege_preview','변경 영향·업무 필수 권한 대조',{...target('086'),safe:true,plan:'privileges2'})
  .gate('safe','필수 업무 권한 유지').review('권한 소유자와 업무 담당자 검토')
  .tool('apply_privileges','검토한 역할 권한 변경 · 승인 필요',{...target('086'),version:2},'write')
  .parallel('허용·거절 계약 각각 검사',[{operation:'positive_permission_test',purpose:'필수 허용 작업 검사',result:{allowed:true}},{operation:'negative_permission_test',purpose:'철회 권한 거절 검사',result:{denied:true}}])
  .verifyParallel([{task:0,field:'allowed',value:true},{task:1,field:'denied',value:true}],'권한 허용·거절 결과 직접 검사')
  .agent('permission_review','허용·거절 두 결과를 독립 대조',{...target('086'),verified:true})
  .gate('verified','최소 권한 동작 확인').finish('필수 허용과 불필요 권한 거절을 모두 확인했습니다.');

const retention=design('087','archive-retention','보존·아카이브 검증','보존 정책에 맞는 대상만 선택하고 보관본 조회·무결성 검증 후 만료 처리를 별도 승인합니다.')
  .tool('retention_inventory','자료 보존 기간과 보류 대상 조회',{...target('087'),policy:'retention1',legalHold:false})
  .agent('retention_plan','보류 대상을 제외한 보관 후보 선정',{...target('087'),batch:'batch1',operation:'archive_registered_batch'})
  .tool('retention_preview','보존 기간과 대상 범위 재검사',{...target('087'),eligible:true,batch:'batch1'})
  .gate('eligible','보존·보류 조건 충족').review('보관·만료 범위와 복구 방법 검토')
  .tool('archive_batch','검토한 자료 보관 · 승인 필요',{...target('087'),archiveId:'archive1'},'write')
  .tool('verify_archive','보관본 무결성·조회 가능성 검사',{...target('087'),verified:true,archiveId:'archive1'})
  .gate('verified','보관본 재조회 확인').tool('expire_source','정책에 따른 원본 만료 · 별도 승인',{...target('087'),expired:true},'write')
  .tool('verify_retention','만료 범위와 보관본 재확인',{...target('087'),retainedArchive:true})
  .finish('보관본 검증 후 승인된 범위만 만료 처리했습니다.');

const replication=design('088','replication-diagnosis','복제 지연·불일치 진단','원본·복제본 상태를 독립 조회하고 격차 원인을 조사한 뒤 검토된 복제 조치와 따라잡기 결과를 확인합니다.')
  .parallel('원본·복제본 상태 비교',[{operation:'primary_status',purpose:'원본 로그 위치 조회',result:{position:120,healthy:true}},{operation:'replica_status',purpose:'복제본 위치·오류 조회',result:{position:100,healthy:true}}])
  .agent('replication_analysis','관측 시각과 로그 격차의 비교 가능성 판단',{...target('088'),comparable:true,lag:20})
  .gate('comparable','복제 위치 비교 조건 확인').tool('replication_cause','복제 대기·오류 원인 조회',{...target('088'),cause:'paused_worker',repairable:true})
  .gate('repairable','등록된 복구 조치로 처리 가능').review('복제 재개 영향과 불일치 확인 절차 검토')
  .tool('resume_replication','검토한 복제 재개 · 승인 필요',{...target('088'),resumed:true},'write')
  .tool('verify_replication','따라잡기·표본 일치 검사',{...target('088'),lag:0,consistent:true})
  .gate('consistent','복제 자료 일치 확인').finish('복제 재개 후 로그 격차와 표본 일치를 확인했습니다.');

const capacity=design('089','capacity-planning','DB 용량 추세·증설 계획','용량 시계열과 보존 변화의 영향을 대조해 증설 시점과 검증할 가정을 제시합니다.')
  .tool('capacity_history','기간별 용량·수집 누락 조회',{...target('089'),values:[10,12,14,16],complete:true})
  .gate('complete','용량 관측 구간 완전성 확인').agent('capacity_assumptions','증가 추세와 보존 정책 변화 가정 구분',{...target('089'),values:[10,12,14,16],policyStable:true})
  .gate('policyStable','동일 정책 구간 비교').tool('capacity_projection','등록된 예측기로 용량·한계 시점 계산',{...target('089'),monthsToThreshold:6,uncertainty:'trend_baseline'})
  .agent('capacity_plan','추세와 불확실성에 맞는 증설·보존 검토안',{...target('089'),proposedReviewMonths:3,automaticExpansion:false})
  .review('예측 가정·예산·보존 정책 함께 검토').finish('관측과 가정을 구분한 용량 계획이며 자동 증설하지 않았습니다.');

const testData=design('090','test-data','민감정보를 가린 시험 자료 검증','자료 계약에 맞는 시험 자료를 준비하고 민감정보·참조 무결성·동작 대표성을 검증한 뒤 승인된 시험 공간에만 제공합니다.')
  .tool('test_data_contract','시험 자료의 열·제약·민감도 계약 조회',{...target('090'),schema:'test-schema1',sensitive:['email']})
  .agent('masking_plan','민감정보 처리와 관계 보존 방법 선정',{...target('090'),operation:'registered_test_data_policy',schema:'test-schema1'})
  .tool('prepare_test_data','격리 처리로 시험 자료 후보 준비',{...target('090'),artifact:'test-data1',rows:20})
  .parallel('민감정보·관계·대표성 독립 확인',[{operation:'check_sensitive_fields',purpose:'민감정보 재검사',result:{detected:0}},{operation:'check_references',purpose:'참조·유일성 제약 검사',result:{violations:0}},{operation:'check_test_coverage',purpose:'필수 시험 조건 대표성 검사',result:{covered:true}}])
  .verifyParallel([{task:0,field:'detected',value:0},{task:1,field:'violations',value:0},{task:2,field:'covered',value:true}],'시험 자료의 실제 검사 완료 조건')
  .agent('test_data_review','세 검사에서 누락·위험이 없는지 독립 검토',{...target('090'),artifact:'test-data1',accepted:true})
  .gate('accepted','시험 자료 공개 조건 충족').review('시험 공간·보존 기간·처리 한계 확인')
  .tool('publish_test_data','승인된 시험 공간에만 자료 제공 · 승인 필요',{...target('090'),dataset:'test-data1',destination:'isolated-test'},'write')
  .tool('verify_test_data_access','시험 공간 접근·만료 설정 검사',{...target('090'),restricted:true})
  .gate('restricted','시험 자료 접근 범위 확인').finish('검사한 시험 자료를 제한된 시험 공간에 제공했습니다.');

export const codeDbToolDesigns:WorkflowDesign[]=[bug,refactor,upgrade,coverage,concurrency,performance,frontend,build,assets,query,indexes,locks,migration,backup,permissions,retention,replication,capacity,testData];
