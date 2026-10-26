/** Real downloaded Node.js/Python ZIPs via authenticated loopback UI API. No model/MCP is configured or called. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { unzipSync } from 'fflate';
import type { PublicRun } from '../runtime/types';
import type { Workflow } from '../app/lib/model';
import { buildExportPackage } from '../server/export-package';
import * as assets from '../server/generated/export-runner';
import { extractExportEntries } from './export-zip';
const python=resolve('.venv-files/Scripts/python.exe');
const root = await mkdtemp(join(tmpdir(), 'flowly-local-experience-'));
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, PATHEXT: process.env.PATHEXT };
type Job = {id:string;status:string;runId?:string};
type OutputFile = {path:string;name:string;bytes:number};
const workflow: Workflow = {id:'local-file-experience',name:'파일 입력과 결과 받기 검증',description:'실제 CSV 파일 입력·처리·저장',updatedAt:'2026-10-26T00:00:00.000Z',definition:{schemaVersion:5,nodes:[
{id:'input',type:'form',title:'입력 자료 선택',x:0,y:0,form:{mode:'initial',fields:[{key:'file',type:'file',label:'자료 파일',required:true}]}},
{id:'read',type:'file_input',title:'파일 읽기',x:250,y:0,inputBindings:{data:{nodeId:'input',path:'data'}},fileInput:{path:'data.file',maxBytes:1000000}},
{id:'extract',type:'document_extract',title:'표 추출',x:500,y:0,inputBindings:{file:{nodeId:'read',path:'file'}},documentExtract:{mode:'table',filePath:'file',maxPages:5,language:'kor+eng'}},
{id:'write',type:'file_output',title:'결과 저장',x:750,y:0,inputBindings:{rows:{nodeId:'extract',path:'tables.0.rows'}},fileOutput:{format:'csv',filename:'result.csv',dataPath:'rows'}},
{id:'output',type:'output',title:'결과 확인',x:1000,y:0}],edges:[['input','read'],['read','extract'],['extract','write'],['write','output']].map(([source,target],i)=>({id:`e${i}`,source,target}))}};
async function stop(child:ChildProcess){if(child.exitCode!==null)return;const ended=once(child,'exit');child.kill();await ended;}
try {
 for (const language of ['node','python'] as const) {
  const folder=join(root,language);await mkdir(folder);
  const bytes=await buildExportPackage({user:{userId:'local-qa',email:'local-qa@example.invalid',displayName:'로컬 검증'},workflow,language,kind:'runtime',connections:[],resolveResources:async()=>[],runnerSource:language==='node'?assets.exportRunnerSource:assets.exportPythonSource,helpers:{files:assets.exportFileHelperSource,triggers:assets.exportTriggerSource,requirements:assets.exportFileRequirements},operations:{ops:assets.exportOperationsSource,local:assets.exportLocalSource,guide:assets.exportOperationsGuide}});
  await extractExportEntries(folder,unzipSync(bytes));
  await writeFile(join(folder,'.env'),`FLOWLY_PYTHON=${python}\n`);
  const child=spawn(python,['-X','utf8','-u','-c','import flowly_local,json; s=flowly_local.create_server(".",0); print(json.dumps({"port":s.server_port,"token":s.local_token}),flush=True); s.serve_forever()'],{cwd:folder,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let error='';child.stderr!.on('data',b=>error+=b.toString());
  try {
   const config=await new Promise<{port:number;token:string}>((ok,fail)=>{let output='';const timeout=setTimeout(()=>fail(Error('local server timeout '+error)),15000);child.stdout!.on('data',b=>{output+=b.toString();if(output.includes('\n')){clearTimeout(timeout);try{ok(JSON.parse(output.trim()))}catch(e){fail(e)}}});child.once('exit',()=>{clearTimeout(timeout);fail(Error('local server exited '+error))})});
   const origin=`http://127.0.0.1:${config.port}`,headers={origin,'content-type':'application/json','x-flowly-token':config.token};
   const call=async<T=Record<string,unknown>>(action:string,args:Record<string,unknown>={})=>{const response=await fetch(origin+'/api',{method:'POST',headers,body:JSON.stringify({action,confirmProduction:true,...args})});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result as T;};
   const setup=await call<{fields:unknown[];networkChecked:boolean}>('setup.status');assert.deepEqual(setup.fields,[]);assert.equal(setup.networkChecked,false);const check=await call<{status:string}>('check');assert.equal(check.status,'ready',JSON.stringify(check));
   const upload=await fetch(origin+'/upload',{method:'POST',headers:{...headers,'content-type':'application/octet-stream','x-flowly-filename':'source.csv'},body:'name,value\nA,42\n'});assert.equal(upload.status,200);const file=await upload.json() as {path:string};
   const queued=await call<{worker:{running:boolean};job:Job}>('local.run.start',{input:JSON.stringify({file:file.path})});assert.equal(queued.worker.running,true);
   let job:Job|undefined;for(let attempt=0;attempt<120;attempt++){job=(await call<{jobs:Job[]}>('jobs.list')).jobs.find((j:Job)=>j.id===queued.job.id);if(!['queued','running','dispatching'].includes(job?.status||'queued'))break;await new Promise(r=>setTimeout(r,100));}
   assert.ok(job?.runId);const run=await call<PublicRun>('runs.status',{runId:job.runId});assert.equal(job.status,'succeeded',JSON.stringify(run));assert.equal(run.status,'succeeded');assert.equal(run.usage.turns,0);assert.equal(run.usage.toolCalls,0);
   const results=await call<{files:OutputFile[]}>('outputs.list',{runId:job.runId});assert.equal(results.files.length,1);const downloaded=await call<OutputFile&{base64:string}>('outputs.download',{runId:job.runId,path:results.files[0].path});assert.match(Buffer.from(downloaded.base64,'base64').toString(),/A,42/);
   const denied=await fetch(origin+'/api',{method:'POST',headers,body:JSON.stringify({action:'outputs.download',runId:job.runId,path:'.env'})});assert.equal(denied.status,409);
   await call('local.worker.stop');console.log(`PASS ${language}: downloaded ZIP → setup → upload → typed form → one-click execution → table extraction → output download; model/MCP calls 0`);
  } finally {await stop(child);}
 }
} finally {assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep+'flowly-local-experience-'));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:150});}
