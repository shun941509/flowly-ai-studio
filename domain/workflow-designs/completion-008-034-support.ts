/**
 * 008~034 작성 파일이 공유하는 스키마·노드·연결·시나리오 도우미다. 여기의 기본값을 바꾸면 여러 예제의 실제 실행 계약이 함께 달라진다.
 * 노드/연결/자료는 내려받을 설계이며 scenarios의 응답·상태 기대값은 테스트 전용이다.
 */
import type { Definition, FlowNode, Resource } from '../../app/lib/model';
import type { DataSchema, InputBinding, Json } from '../../runtime/types';
import type { WorkflowDesign, WorkflowScenario } from '../workflow-design';
import { serializeMcpRegistration } from '../mcp-registration';
import { layoutWorkflow } from '../workflow-layout';
export const str:DataSchema={type:'string'},num:DataSchema={type:'number'},bool:DataSchema={type:'boolean'};
export const obj=(properties:Record<string,DataSchema>,required=Object.keys(properties)):DataSchema=>({type:'object',properties,required,additionalProperties:false});
export const arr=(items:DataSchema):DataSchema=>({type:'array',items});
export const any:DataSchema={type:'object',additionalProperties:true};
export const b=(nodeId:string,path='text'):InputBinding=>({nodeId,path});
export const n=(id:string,type:FlowNode['type'],title:string,extra:Partial<FlowNode>={}):FlowNode=>({id,type,title,x:0,y:0,...extra});
export const graph=(nodes:FlowNode[],links:[string,string,string?][]):Definition=>layoutWorkflow({schemaVersion:5,nodes,edges:links.map(([source,target,branch],i)=>({id:`e${i}`,source,target,...(branch?{branch}:{})}))});
export const input=()=>n('input','input','작업 입력');
export const parse=()=>n('parse','transform','계약 입력 읽기',{transform:{mode:'parse_json'}});
export const ai=(id:string,tag:string,prompt:string,bindings:Record<string,InputBinding>,schema?:DataSchema)=>n(id,'agent',id,{prompt:`${tag}: ${prompt}`,inputBindings:bindings,allowedTools:[],...(schema?{format:'JSON',outputSchema:obj({text:str,data:schema})}:{}),limits:{maxTurns:2,maxToolCalls:2,maxTokens:6000,maxDurationMs:60000}});
export const calc=(id:string,operation:string,from:string,path='data')=>n(id,'program',operation,{program:{name:'completion',arguments:{operation:`research.${operation}`},bindings:{arguments:'args'}},inputBindings:{args:b(from,path)}});
export const merge=(id:string,bindings:Record<string,InputBinding>)=>n(id,'merge','명시적인 입력 결합',{merge:{mode:'object'},inputBindings:bindings});
export const gate=(id:string,path:string,value:string|number|boolean|null,bindings:Record<string,InputBinding>)=>n(id,'condition',id,{predicate:{path,operator:'eq',value},inputBindings:bindings});
export const out=(id:string,from:string,path='text')=>n(id,'output','결과',{inputBindings:{text:b(from,path)}});
export const note=(id:string,text:string)=>n(id,'transform',id,{inputBindings:{},transform:{mode:'template',template:text}});
export const stop=(id:string,message:string)=>n(id,'error',id,{error:{template:message},inputBindings:{}});
export const review=(id:string,from:string,path='data',allowEdit=false)=>n(id,'review','사람 확인',{inputBindings:{record:b(from,path)},review:{instructions:'근거와 현재 버전을 확인한 뒤 수락하거나 거절하세요.',allowEdit,timeoutMinutes:60}});
export const mem=(id:string,action:'read'|'write',key:string,from?:string,path='data',scope:'run'|'workflow'='run',defaultValue:Json={})=>n(id,'memory',id,{memory:{action,key,scope,defaultValue,...(from?{valuePath:'value'}:{})},inputBindings:from?{value:b(from,path)}:{}});
export const form=(id:string,fields:{key:string;label:string;type:'text'|'number'|'date'|'boolean';required:true}[])=>n(id,'form','누락 입력 보완',{form:{mode:'request',instructions:'근거에 맞는 값을 보완하세요.',timeoutMinutes:60,fields},inputBindings:{}});
export const svc=(id:string,tools:{name:string;effect:'read'|'write';fields:Record<string,DataSchema>}[]):Resource=>({id:`completed-${id}-mcp`,type:'mcp',name:`${id} 사내 서비스 계약`,ownerId:'flowly-examples',visibility:'public',allowedEmails:[],sample:true,createdAt:'2026-10-25',updatedAt:'2026-10-25',url:'https://internal.example.invalid/mcp',description:'미설정: 도구 및 자료에 이 계약을 제공하는 사내 MCP를 등록하고, 내보낸 .env에 주소와 토큰을 지정합니다.',content:serializeMcpRegistration({version:1,connectionId:`completed-${id}`,endpointEnv:`FLOWLY_MCP_ENDPOINT_COMPLETED_${id}`,tokenEnv:`FLOWLY_MCP_TOKEN_COMPLETED_${id}`,tools:tools.map(t=>({name:t.name,effect:t.effect,inputSchema:obj(t.fields),description:`${t.name}: 등록된 사내 계약. 실제 서비스가 미설정이면 실행하지 않습니다.`}))})});
export const tool=(id:string,resource:Resource,name:string,args:Record<string,Json>,bindings:Record<string,InputBinding>={},argumentBindings:Record<string,string>={})=>n(id,'tool',name,{allowedTools:[{resourceId:resource.id,connectionId:`completed-${resource.id.split('-')[1]}`,toolName:name}],tool:{arguments:args,bindings:argumentBindings},inputBindings:bindings});
export const reply=(match:string,value:Json,inputContains?:string[])=>({match:`${match}:`,text:typeof value==='string'?value:JSON.stringify(value),...(inputContains?{inputContains}:{})});
export const result=(name:string,args:Record<string,Json>,data:Record<string,Json>)=>({name,args,result:{structuredContent:data}});
export const make=(id:string,slug:string,title:string,description:string,definition:Definition,resources:Resource[],scenarios:WorkflowScenario[],acceptance:string[]):WorkflowDesign=>{
 const reviews=definition.nodes.filter(node=>node.type==='review');
 const edges=definition.edges.map(edge=>reviews.some(node=>node.id===edge.source)&&!edge.branch?{...edge,branch:'yes'}:edge);
 const nodes=[...definition.nodes];
 for(const node of [...nodes]) if(node.type==='output'&&node.inputBindings?.text&&node.inputBindings.text.path!=='text') {
  const serialId=`${node.id}_serialize`,binding=node.inputBindings.text;
  nodes.push(n(serialId,'transform','구조화된 결과 표시',{transform:{mode:'pick',fields:{result:'value'}},inputBindings:{value:binding}}));
  for(const edge of edges)if(edge.target===node.id)edge.target=serialId;
  edges.push({id:`${serialId}_edge`,source:serialId,target:node.id});
  node.inputBindings={text:b(serialId)};
 }
 for(const node of reviews) if(!edges.some(edge=>edge.source===node.id&&edge.branch==='no')) {nodes.push(stop(`${node.id}_rejected`,'사람 검토를 거절하여 후속 작업을 중단했습니다.'),out(`${node.id}_rejected_out`,`${node.id}_rejected`));edges.push({id:`${node.id}_denied`,source:node.id,target:`${node.id}_rejected`,branch:'no'},{id:`${node.id}_denied_out`,source:`${node.id}_rejected`,target:`${node.id}_rejected_out`});}
 return {id:`completed-${id}-${slug}`,title:`${id} · ${title}`,description,behavior:description,category:'완성 연구·업무 에이전트',definition:layoutWorkflow({...definition,nodes,edges}),resources,scenarios:scenarios.map(s=>{const halted=s.status!=='succeeded';return {...s,...(halted?{skipped:undefined,completedCounts:{...Object.fromEntries((s.skipped??[]).map(id=>[id,0])),...s.completedCounts}}:{}),toolCallCounts:s.toolCallCounts??Object.fromEntries([...new Set((s.toolReplies??[]).map(r=>r.name))].map(name=>[name,(s.toolReplies??[]).filter(r=>r.name===name).reduce((sum,r)=>sum+(r.count??1),0)]))};}),inputExample:scenarios[0].input,expectedOutput:(scenarios[0].contains??[]).join(' / '),acceptance,failureCases:scenarios.slice(1).map(s=>s.name)};
};
