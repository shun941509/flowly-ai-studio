import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {workflowDesigns} from '../domain/workflow-designs';
import {readMcpRegistration} from '../domain/mcp-registration';
import {createRun,executeRun,decideApproval,decideReview,submitInput} from '../runtime/engine';
import {NodeProcessingFault} from '../runtime/advanced';
import type {Json,RuntimeDependencies,RuntimeRun} from '../runtime/types';

const wanted=new Set(['011','014','029','042','044','054']);
const python=process.env.FLOWLY_PYTHON??'python';
const script="import sys,json;sys.path.insert(0,'export-runtime');from flowly_completions import registry;p=json.load(sys.stdin);print(json.dumps(registry()[0][p['operation']](p['arguments']),ensure_ascii=False))";
const children=(run:RuntimeRun):RuntimeRun[]=>[run,...Object.values(run.checkpoint.groups??{}).flatMap(group=>group.children.flatMap(children))];

for(const design of workflowDesigns.filter(d=>wanted.has(d.id.split('-')[1])))test(`${design.id}: real engine and pure helpers, explicit local provider fixtures`,async t=>{
 const stores=new Map<string,Map<string,Json>>();
 for(const [index,scenario] of design.scenarios.entries())await t.test(scenario.name,async()=>{
  const stateKey=scenario.stateGroup??String(index),store=stores.get(stateKey)??new Map<string,Json>();stores.set(stateKey,store);
  for(const seed of scenario.memorySeeds??[])store.set(design.id+':'+seed.key,structuredClone(seed.value));
  const operations=new Map<string,{data:Json;found:boolean}>(),modelCounts=new Map<string,number>(),toolCounts=new Map<string,number>();
  const tools=design.resources.flatMap(resource=>{const registration=readMcpRegistration(resource);return registration?registration.tools.map(tool=>({...tool,resourceId:resource.id,connectionId:registration.connectionId,toolName:tool.name})):[];});
  const run=createRun({owner:{userId:'test',email:'test@example.test',displayName:'Explicit fixture'},mode:'test',workflow:{id:design.id,name:design.title,description:design.description,updatedAt:'test',definition:design.definition},resources:design.resources,input:scenario.input});
  const deps:RuntimeDependencies={
   tools,save:async()=>{},assertAccess:async()=>{},isCancelled:async()=>false,
   memory:async operation=>{
    if(operation.trackOperation!==false&&operations.has(operation.operationId))return structuredClone(operations.get(operation.operationId)!);
    const key=operation.workflowId+':'+operation.key,prior=store.get(key);let value=prior;
    if(operation.action==='write'){
     if(operation.expectedRevision!==undefined)assert.equal((prior as {revision?:number}|undefined)?.revision??0,operation.expectedRevision,'CAS');
     value=structuredClone(operation.value!);store.set(key,value);
    }else if(operation.action==='delete'){store.delete(key);value=undefined;}
    const result={data:structuredClone(value??operation.defaultValue??null),found:value!==undefined};
    if(operation.trackOperation!==false)operations.set(operation.operationId,result);
    return result;
   },
   completion:async request=>{
    const result=spawnSync(python,['-I','-X','utf8','-c',script],{input:JSON.stringify(request),encoding:'utf8',windowsHide:true,timeout:15000});
    if(result.status!==0)throw new NodeProcessingFault(result.stderr.trim().split('\n').at(-1)!);return JSON.parse(result.stdout);
   },
   model:{next:async({messages})=>{
    const content=messages.map(m=>m.content).join('\n'),reply=scenario.modelReplies?.find(r=>content.includes(r.match));
    assert.ok(reply,`unexpected model: ${content.slice(0,300)}`);
    modelCounts.set(reply.match,(modelCounts.get(reply.match)??0)+1);
    for(const text of reply.inputContains??[])assert.ok(content.includes(text),`missing model input ${text}`);
    for(const text of reply.inputExcludes??[])assert.ok(!content.includes(text),`unexpected model input ${text}`);
    if(reply.delayMs)await new Promise(resolve=>setTimeout(resolve,reply.delayMs));
    return {kind:'answer',text:reply.text!,usageTokens:1};
   }},
   callTool:async(tool,args)=>{
    const reply=scenario.toolReplies?.find(r=>r.name===tool.toolName&&isDeepStrictEqual(r.args,args));
    assert.ok(reply,`unexpected tool ${tool.toolName}: ${JSON.stringify(args)}`);
    toolCounts.set(tool.toolName,(toolCounts.get(tool.toolName)??0)+1);
    if(reply.error)throw new Error(reply.error);return reply.result!;
   },
  };
  for(let turn=0;turn<20;turn++){
   await executeRun(run,deps);
   if(!['waiting_approval','waiting_review','waiting_input'].includes(run.status))break;
   for(const child of children(run)){
    for(const approval of child.approvals.filter(a=>a.status==='pending'))await decideApproval(run,approval.id,'test',scenario.approval==='deny'?'denied':'approved');
    for(const review of child.reviews?.filter(r=>r.status==='pending')??[])await decideReview(run,review.id,'test',scenario.review==='reject'?'rejected':'accepted');
    for(const input of child.inputRequests?.filter(r=>r.status==='pending')??[]){const submission=scenario.inputSubmissions?.find(s=>s.nodeId===input.nodeId);assert.ok(submission);await submitInput(run,input.id,'test',submission.values);}
   }
  }
  assert.equal(run.status,scenario.status,run.error);
  for(const text of scenario.contains??[])assert.ok(run.result.includes(text),`missing result ${text}: ${run.result}`);
  for(const text of scenario.errorContains??[])assert.ok(run.error?.includes(text),`missing error ${text}: ${run.error}`);
  for(const nodeId of scenario.skipped??[])assert.ok(children(run).some(child=>child.checkpoint.skipped.includes(nodeId)),`not skipped ${nodeId}`);
  for(const [id,count] of Object.entries(scenario.completedCounts??{}))assert.equal(children(run).reduce((sum,child)=>sum+Number(child.checkpoint.completed.includes(id)),0),count,id);
  for(const [name,count] of Object.entries(scenario.toolCallCounts??{}))assert.equal(toolCounts.get(name)??0,count,name);
  for(const seed of scenario.memorySeeds??[])assert.deepEqual(store.get(design.id+':'+seed.key),seed.value,'legacy history must remain unchanged');
  if(scenario.resumeAgain){const calls=[...modelCounts,...toolCounts];await executeRun(run,deps);assert.deepEqual([...modelCounts,...toolCounts],calls);}
 });
});
