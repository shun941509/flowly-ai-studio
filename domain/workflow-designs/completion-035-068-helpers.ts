import type { Definition, FlowNode, Resource } from '../../app/lib/model';
import type { InputBinding, Json, DataSchema } from '../../runtime/types';
import type { WorkflowDesign, WorkflowScenario } from '../workflow-design';
import { layoutWorkflow } from '../workflow-layout';
import { serializeMcpRegistration } from '../mcp-registration';

export const b=(nodeId:string,path='text'):InputBinding=>({nodeId,path});
export const n=(id:string,type:FlowNode['type'],title:string,extra:Partial<FlowNode>={}):FlowNode=>({id,type,title,x:0,y:0,...extra});
export function graph(nodes:FlowNode[],links:[string,string,string?][]):Definition{
 for(const node of nodes.filter(node=>node.type==='output')){
  const ref=node.inputBindings?.text,source=nodes.find(item=>item.id===ref?.nodeId);
  if(ref?.path==='text'&&source&&(source.type==='program'||source.type==='tool'||source.type==='merge'||source.type==='agent'&&source.format==='JSON')&&!node.inputBindings?.data)node.inputBindings!.data=b(source.id,'data');
 }
 for(const node of [...nodes].filter(node=>node.type==='review')){
  const from=node.inputBindings?.text?.nodeId, source=nodes.find(item=>item.id===from);
  if(source?.type==='condition')node.inputBindings=Object.fromEntries(Object.keys(source.inputBindings??{}).map(key=>[key,b(source.id,key)]));
  for(const link of links)if(link[0]===node.id&&!link[2])link[2]='yes';
  if(!links.some(link=>link[0]===node.id&&link[2]==='no')){
   const held=node.id+'_rejected',output=held+'_out';
   nodes.push(n(held,'transform','거절·미완료 기록',{inputBindings:{},transform:{mode:'template',template:'검토가 거절되어 후속 작업을 실행하지 않았습니다.'}}),out(output,held));
   links.push([node.id,held,'no'],[held,output]);
  }
 }
 return layoutWorkflow({schemaVersion:5,nodes,edges:links.map(([source,target,branch],i)=>({id:`edge_${i}`,source,target,...(branch?{branch}:{})}))},{recursive:true});
}
export const start=()=>[n('input','input','작업 입력 JSON'),n('parse','transform','입력 계약 읽기',{transform:{mode:'parse_json'}})];
export const op=(id:string,operation:string,title:string,bindings:Record<string,InputBinding>,args:Record<string,Json>={}):FlowNode=>n(id,'program',title,{program:{name:'completion' as never,arguments:{operation:`technical.${operation}`,arguments:args},bindings:Object.keys(bindings).length?{arguments:'arguments'}:{}},inputBindings:bindings});
export const calc=(id:string,operation:string,title:string,from:string,path='data')=>op(id,operation,title,{arguments:b(from,path)});
export const fixed=(id:string,value:Json,title=id)=>n(id,'transform',title,{inputBindings:{},transform:{mode:'template',template:JSON.stringify(value)}});
export const parse=(id:string,title=id)=>n(id,'transform',title,{transform:{mode:'parse_json'}});
export const out=(id:string,from:string,path='text')=>n(id,'output','검증 결과',{inputBindings:{text:b(from,path)}});
export const agent=(plan:string,id:string,title:string,prompt:string,inputBindings:Record<string,InputBinding>,json=true)=>n(id,'agent',title,{prompt:`COMPLETED_${plan}_${id}: ${prompt} 내부 사고 원문을 출력하지 말고 관측 결과와 짧은 근거만 답하세요.`,format:json?'JSON':'Markdown',allowedTools:[],inputBindings,limits:{maxTurns:1,maxToolCalls:1,maxTokens:5000,maxDurationMs:60000}});
export const reply=(plan:string,id:string,value:Json,extra:Partial<NonNullable<WorkflowScenario['modelReplies']>[number]>={})=>({match:`COMPLETED_${plan}_${id}:`,text:typeof value==='string'?value:JSON.stringify(value),...extra});
export const gate=(id:string,from:string,path='data.passed',value:Json=true,context?:Record<string,InputBinding>)=>n(id,'condition','결정적 완료 조건',{predicate:{path:'record.'+path,operator:'eq',value:value as never},inputBindings:{record:b(from,'data'),...context}});
export const check=(id:string,from:string,path='passed',context?:Record<string,InputBinding>)=>n(id,'condition','결정적 검사 통과',{predicate:{path:'record.'+path,operator:'eq',value:true},inputBindings:{text:b(from),data:b(from,'data'),record:b(from,'data'),...context}});
export const hold=(id='hold',reason='검사 미통과로 다음 작업을 보류했습니다.')=>fixed(id,{status:'held',reason},'미완료 상태 명시');
export const review=(id:string,from:string,instructions:string)=>n(id,'review','사람 검토·재개',{review:{instructions,allowEdit:false,timeoutMinutes:60},inputBindings:{text:b(from),data:b(from,'data')}});
export const waitInput=(id:string,fields:{key:string;label:string;type:'text'|'number'|'boolean';required:boolean}[],from?:string)=>n(id,'form','보완 입력 대기',{form:{mode:'request',instructions:'요청한 입력을 제출하면 같은 실행에서 이어집니다.',fields},...(from?{inputBindings:{context:b(from,'data')}}:{})});
export const object=(properties:Record<string,DataSchema>):DataSchema=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export function service(plan:string,tools:{name:string;effect:'read'|'write';fields:Record<string,DataSchema>;description:string}[]):Resource{
 return {id:`completion-${plan}-service`,ownerId:'flowly-examples',type:'mcp',name:`${plan} 사내 작업 서비스`,description:'미설정: 등록된 계약을 제공하는 사내 서비스가 필요합니다. 주소·토큰은 내보낸 .env에 설정합니다.',url:'https://company.example.invalid/mcp',content:serializeMcpRegistration({version:1,connectionId:`completion-${plan}`,endpointEnv:`FLOWLY_MCP_ENDPOINT_COMPLETION_${plan}`,tokenEnv:`FLOWLY_MCP_TOKEN_COMPLETION_${plan}`,tools:tools.map(t=>({name:t.name,effect:t.effect,description:t.description,inputSchema:object(t.fields)}))}),visibility:'public',allowedEmails:[],sample:true,createdAt:'2026-10-25',updatedAt:'2026-10-25'};
}
export const tool=(plan:string,id:string,name:string,title:string,args:Record<string,Json>,bindings:Record<string,string>,inputBindings:Record<string,InputBinding>)=>n(id,'tool',title,{allowedTools:[{resourceId:`completion-${plan}-service`,connectionId:`completion-${plan}`,toolName:name}],tool:{arguments:args,bindings},inputBindings});
export function design(plan:string,slug:string,title:string,behavior:string,definition:Definition,scenarios:WorkflowScenario[],acceptance:string[],resources:Resource[]=[]):WorkflowDesign{
 return {id:`completed-${plan}-${slug}`,title:`${plan} · ${title}`,category:'기술·지식·협업 Agent 완성',description:behavior,behavior,definition,resources,scenarios:scenarios.map(s=>({...s,...(s.toolReplies?{toolCallCounts:s.toolCallCounts??s.toolReplies.reduce<Record<string,number>>((counts,t)=>({...counts,[t.name]:(counts[t.name]??0)+(t.count??1)}),{})}:{})})),inputExample:scenarios[0].input,expectedOutput:'관측·계산으로 확인한 완료 조건과 미완료 사유',acceptance:['웹에서 OpenAI를 호출하지 않으며 사용자 실행 환경만 실제 모델을 설정합니다.',...acceptance],failureCases:scenarios.slice(1).map(s=>s.name)};
}
