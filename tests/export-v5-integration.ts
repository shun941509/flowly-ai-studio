import { extractExportEntries } from "./export-zip";
/** Native ZIP execution. Local files/OCR/triggers are real; no provider credential is supplied. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { templateWorkflow, type Workflow, type FlowNode } from "../app/lib/model";
import { buildExportPackage } from "../server/export-package";
import { exportRunnerSource, exportPythonSource, exportFileHelperSource, exportTriggerSource, exportFileRequirements } from "../server/generated/export-runner";

const origin="http://127.0.0.1:5173", http=process.argv.includes("--http");
const root=resolve("."),python=resolve(".venv-files/Scripts/python.exe"),temporary=await mkdtemp(join(tmpdir(),"flowly-v5-"));
const environment:NodeJS.ProcessEnv={NODE_ENV:"test",PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,PATHEXT:process.env.PATHEXT};
type Language="node"|"python";
let cookie="", checks=0;
function cli(language:Language,cwd:string,args:string[],status=0){
 const result=spawnSync(language==="node"?process.execPath:python,[...(language==="node"?["runner.mjs"]:["-X","utf8","runner.py"]),...args],{cwd,env:environment,encoding:"utf8",windowsHide:true,timeout:60000});
 assert.equal(result.status,status,result.stderr||result.stdout);return JSON.parse(result.stdout);
}
async function download(language:Language,workflow:Workflow,name:string){
 let zip:Uint8Array;
 if(http){const r=await fetch(origin+"/api/export",{method:"POST",headers:{origin,cookie,"content-type":"application/json"},body:JSON.stringify({workflow,language})});assert.equal(r.status,200,r.status===200?"":await r.text());zip=new Uint8Array(await r.arrayBuffer());}
 else zip=await buildExportPackage({user:{userId:"native-v5",email:"native@example.com",displayName:"로컬 검증"},workflow,connections:[],resolveResources:async()=>[],language,runnerSource:language==="node"?exportRunnerSource:exportPythonSource,helpers:{files:exportFileHelperSource,triggers:exportTriggerSource,requirements:exportFileRequirements}});
 const folder=join(temporary,language+"-"+name);await mkdir(folder);
 await extractExportEntries(folder,unzipSync(zip));
 await writeFile(join(folder,".env"),"FLOWLY_PYTHON="+python+"\n");
 if(process.argv.includes("--save-examples")){await mkdir("outputs",{recursive:true});await writeFile(join("outputs",`flowly-${language}-v5-${name}.zip`),zip);}
 return folder;
}
function outputFlow(format:"csv"|"xlsx"|"docx"|"pdf"){
 const flow=templateWorkflow("blank");const n=(id:string,type:FlowNode["type"],extra:Partial<FlowNode>={}):FlowNode=>({id,type,title:id,x:0,y:0,...extra});
 const tabular=["csv","xlsx"].includes(format);
 const nodes=[n("input","input"),...(tabular?[n("parse","transform",{transform:{mode:"parse_json"}})]:[]),n("file","file_output",{fileOutput:{format,filename:"결과."+format,dataPath:tabular?"data":"text"},...(tabular?{inputBindings:{data:{nodeId:"parse",path:"data"}}}:{})}),n("extract","document_extract",{documentExtract:{mode:tabular?"table":"text",filePath:"file",maxPages:100,language:"kor+eng"},inputBindings:{file:{nodeId:"file",path:"file"}}}),n("output","output")];
 flow.definition={schemaVersion:5,nodes,edges:nodes.slice(1).map((n,i)=>({id:"e"+i,source:nodes[i].id,target:n.id}))};return flow;
}
try{
 if(http){const login=await fetch(origin+"/api/auth/test",{method:"POST",redirect:"manual",headers:{origin,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({identity:"alice",return_to:"/studio"})});assert.equal(login.status,303);cookie=login.headers.get("set-cookie")!.split(";")[0];}
 for(const language of ["node","python"] as const){
  const text=await download(language,templateWorkflow("file-text"),"file-text");await mkdir(join(text,"inputs"));await writeFile(join(text,"inputs","sample.txt"),"실제 파일 읽기 · Flowly");
  assert.equal(cli(language,text,["check"]).status,"ready");const read=cli(language,text,["run","--input",'{"file":"sample.txt"}']);assert.equal(read.status,"succeeded",read.error);assert.match(read.result,/실제 파일 읽기/);assert.equal(read.usage.turns,0);checks++;
  const bad=cli(language,text,["run","--input",'{"file":"../.env"}'],1);assert.equal(bad.status,"failed");checks++;
  for(const format of ["csv","xlsx","docx","pdf"] as const){
   const folder=await download(language,outputFlow(format),format);assert.equal(cli(language,folder,["check"]).status,"ready");
   const run=cli(language,folder,["run","--input",["csv","xlsx"].includes(format)?JSON.stringify([{이름:"민수",값:42}]):"안녕하세요 Flowly 실제 산출물"]);assert.equal(run.status,"succeeded",run.error);assert.match(run.result,/민수|안녕하세요/);assert.equal(run.usage.turns,0);assert.equal(run.usage.toolCalls,0);
   const output=run.events.find((event:{type:string;nodeId?:string})=>event.type==="node_completed"&&event.nodeId==="file").data.output.file.path;
   const before=await readFile(join(folder,output));const resumed=cli(language,folder,["resume",run.id]);assert.equal(resumed.status,"succeeded");assert.deepEqual(await readFile(join(folder,output)),before);checks++;
  }
  const ocr=await download(language,templateWorkflow("file-ocr"),"ocr");await mkdir(join(ocr,"inputs"));await cp(join(root,"tessdata"),join(ocr,"tessdata"),{recursive:true});
  const image=spawnSync(python,["-c","from PIL import Image,ImageDraw,ImageFont; import sys; i=Image.new('RGB',(1000,180),'white'); ImageDraw.Draw(i).text((25,40),'안녕하세요 Flowly 12345',font=ImageFont.truetype('C:/Windows/Fonts/malgun.ttf',45),fill='black'); i.save(sys.argv[1])",join(ocr,"inputs","sample.png")],{env:environment,encoding:"utf8",windowsHide:true});assert.equal(image.status,0,image.stderr);
  assert.equal(cli(language,ocr,["check"]).status,"ready");const recognized=cli(language,ocr,["run","--input",'{"file":"sample.png"}']);assert.equal(recognized.status,"succeeded",recognized.error);assert.match(recognized.result,/Flowly/);assert.match(recognized.result.replaceAll(" ",""),/안녕하세요/);checks++;
  const guarded=await download(language,templateWorkflow("guard-evaluate"),"guard");const filtered=cli(language,guarded,["run","--input","문의 내용은 someone@example.com으로 보내 주세요."]);assert.equal(filtered.status,"succeeded",filtered.error);assert.doesNotMatch(filtered.result,/someone@example/);checks++;
  const scheduleFlow=templateWorkflow("scheduled-work");scheduleFlow.definition.nodes[0].trigger!.intervalSeconds=1;const scheduled=await download(language,scheduleFlow,"schedule");await writeFile(join(scheduled,"input.txt"),"예약 실행 검증");
  const trigger=spawnSync(python,["flowly_triggers.py","schedule","--max-runs","1","--input-file","input.txt","--node",process.execPath,"--python",python],{cwd:scheduled,env:environment,encoding:"utf8",windowsHide:true,timeout:30000});assert.equal(trigger.status,0,trigger.stderr||trigger.stdout);const receipt=JSON.parse(trigger.stdout);assert.equal(receipt.status,"succeeded");assert.match(cli(language,scheduled,["status",receipt.runId]).result,/예약 실행 검증/);checks++;
  for(const kind of ["web-stream","adaptive-plan"]){const folder=await download(language,templateWorkflow(kind),kind);const missing=cli(language,folder,["check"],1);assert.equal(missing.status,"unconfigured");assert.ok(missing.missingEnv.includes("OPENAI_API_KEY"));checks++;}
  console.log(`PASS ${language}: native file read/path rejection, four output roundtrips/replay, Korean OCR, filter/evaluation, scheduled process and missing model configuration`);
 }
 console.log(`PASS ${checks} v5 native scenarios. Actual OpenAI/MCP calls: 0. Native file/trigger/OCR operations: real.`);
}finally{const target=resolve(temporary),base=resolve(tmpdir());assert.ok(target.startsWith(base+"\\flowly-v5-")||target.startsWith(base+"/flowly-v5-"));await rm(target,{recursive:true,force:true});}
