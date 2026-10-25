import { extractExportEntries } from "./export-zip";
/** Both actual exported CLIs through the real operations helper; no provider keys or mock runtime. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { templateWorkflow } from "../app/lib/model";
import { buildExportPackage } from "../server/export-package";
import { exportRunnerSource, exportPythonSource, exportOperationsSource, exportLocalSource, exportOperationsGuide } from "../server/generated/export-runner";

const temporary=await mkdtemp(join(tmpdir(),"flowly-ops-native-"));
const python=resolve(".venv-files/Scripts/python.exe"),http=process.argv.includes("--http"),origin="http://127.0.0.1:5173";
const environment:NodeJS.ProcessEnv={NODE_ENV:"test",PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,PATHEXT:process.env.PATHEXT};
let cookie="",checks=0;
function ops(folder:string,request:Record<string,unknown>,status=0){const r=spawnSync(python,["-X","utf8","flowly_ops.py","request"],{cwd:folder,env:environment,input:JSON.stringify(request),encoding:"utf8",windowsHide:true,timeout:60000});assert.equal(r.status,status,r.stdout+r.stderr);return JSON.parse(r.stdout);}
function worker(folder:string){const r=spawnSync(python,["-X","utf8","flowly_ops.py","worker","--once"],{cwd:folder,env:environment,encoding:"utf8",windowsHide:true,timeout:60000});assert.equal(r.status,0,r.stdout+r.stderr);return JSON.parse(r.stdout);}
try{
 if(http){const login=await fetch(origin+"/api/auth/test",{method:"POST",redirect:"manual",headers:{origin,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({identity:"alice",return_to:"/studio"})});assert.equal(login.status,303);cookie=login.headers.get("set-cookie")!.split(";")[0];}
 for(const language of ["node","python"] as const){
  const workflow=templateWorkflow("reusable-work");let bytes:Uint8Array;
  if(http){const response=await fetch(origin+"/api/export",{method:"POST",headers:{origin,cookie,"content-type":"application/json"},body:JSON.stringify({workflow,language})});assert.equal(response.status,200,response.status===200?"":await response.text());bytes=new Uint8Array(await response.arrayBuffer());}
  else bytes=await buildExportPackage({user:{userId:"ops-native",email:"ops@example.com",displayName:"운영 검증"},workflow,language,connections:[],resolveResources:async()=>[],runnerSource:language==="node"?exportRunnerSource:exportPythonSource,operations:{ops:exportOperationsSource,local:exportLocalSource,guide:exportOperationsGuide}});
  const folder=join(temporary,language);await mkdir(folder);await extractExportEntries(folder,unzipSync(bytes));
  assert.equal(ops(folder,{action:"profiles.list"}).profiles[0].name,"development");assert.equal(ops(folder,{action:"check"}).status,"ready");checks++;
  ops(folder,{action:"profiles.set",name:"production",env:".env.production",production:true},1);
  ops(folder,{action:"profiles.set",name:"production",env:".env.production",production:true,confirmProduction:true});
  ops(folder,{action:"jobs.enqueue",profile:"production",input:"권한 확인"},1);checks++;
  const low=ops(folder,{action:"jobs.enqueue",input:"낮은 순서",priority:-10}).job,high=ops(folder,{action:"jobs.enqueue",input:"높은 순서",priority:10}).job,cancel=ops(folder,{action:"jobs.enqueue",input:"취소",priority:5}).job;
  ops(folder,{action:"jobs.cancel",jobId:cancel.id});worker(folder);
  let jobs=ops(folder,{action:"jobs.list"}).jobs;assert.equal(jobs.find((j:{id:string})=>j.id===high.id).status,"succeeded");assert.equal(jobs.find((j:{id:string})=>j.id===low.id).status,"queued");assert.equal(jobs.find((j:{id:string})=>j.id===cancel.id).status,"cancelled");
  worker(folder);jobs=ops(folder,{action:"jobs.list"}).jobs;const runId=jobs.find((j:{id:string})=>j.id===low.id).runId;
  const run=ops(folder,{action:"runs.status",runId});assert.equal(run.status,"succeeded");assert.equal(run.result,"정리한 내용: 낮은 순서");assert.equal(run.usage.turns,0);assert.equal(run.usage.toolCalls,0);checks++;
  await mkdir(join(folder,"evaluations"));await writeFile(join(folder,"evaluations","cases.json"),JSON.stringify({cases:[{id:"one",input:"A",expected:"정리한 내용: A"},{id:"two",input:"B",contains:["B"]}]}));
  const baseline=ops(folder,{action:"evaluate",dataset:"evaluations/cases.json"}),current=ops(folder,{action:"evaluate",dataset:"evaluations/cases.json"});assert.ok(baseline.id);assert.ok(current.id);const comparison=ops(folder,{action:"compare",evaluationId:current.id,baselineId:baseline.id});assert.equal(comparison.cases.length,2);checks++;
  const backup=ops(folder,{action:"backup",scopes:["state"]});assert.ok(backup.files>0);const state=join(folder,".flowly-profiles","development","runs");assert.ok(resolve(state).startsWith(resolve(temporary)+"\\")||resolve(state).startsWith(resolve(temporary)+"/"));await rename(state,join(folder,"state-before-restore"));
  const restored=ops(folder,{action:"restore",backupId:backup.backupId,confirm:true});assert.equal(restored.status,"restored");assert.equal(ops(folder,{action:"runs.status",runId}).result,run.result);ops(folder,{action:"restore",backupId:backup.backupId,confirm:true},1);checks++;
  const pruned=ops(folder,{action:"prune",scopes:["state"],olderThanDays:30,confirm:true});assert.deepEqual(pruned.removed,[]);checks++;
  ops(folder,{action:"prices.set",model:"local-estimate-example",inputPerMillion:1,outputPerMillion:4,currency:"USD",asOf:"2026-10-22"});
  const estimate=ops(folder,{action:"prices.estimate",runId,model:"local-estimate-example"});assert.equal(estimate.status,"estimated");assert.deepEqual(estimate.range,{minimum:0,maximum:0});checks++;
  await writeFile(join(folder,"bill.csv"),"start,end,model,amount,currency\n2026-10-01,2026-10-31,local-estimate-example,0,USD\n");assert.equal(ops(folder,{action:"bills.import",path:"bill.csv"}).rows,1);checks++;
  assert.match(await readFile(join(folder,"README.md"),"utf8"),/로컬 실행 화면/);
  if(process.argv.includes("--save-examples")){await mkdir("outputs",{recursive:true});await writeFile(join("outputs",`flowly-${language}-operations.zip`),bytes);}
  console.log(`PASS ${language}: real queue priority/cancel, native execution, profiles, datasets, comparison, backup/restore, retention and cost/bill records`);
 }
 console.log(`PASS ${checks} native operations scenarios. OpenAI/MCP calls: 0. Providers configured: none.`);
}finally{const target=resolve(temporary),base=resolve(tmpdir());assert.ok(target.startsWith(base+"\\flowly-ops-native-")||target.startsWith(base+"/flowly-ops-native-"));await rm(target,{recursive:true,force:true});}
