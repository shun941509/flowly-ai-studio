import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Resource, Workflow } from "../app/lib/model";
import { parseWorkflowImport, readWorkflowImport, rebindImportedWorkflow, workflowImportDiff } from "../domain/workflow-import";
import { buildExecutableExportPackage } from "../server/export-assets";
import { buildCopyPrompt, buildStartPrompt } from "../server/export-ai-documents";
import { buildExportManifest } from "../server/export-package";
import { extractExportEntries } from "./export-zip";

const date="2026-10-26T00:00:00.000Z";
const user={userId:"roundtrip-test",email:"roundtrip@example.test",displayName:"테스트"};
const workflow:Workflow={id:"roundtrip",name:"Agent 없는 값 전달",description:"등록한 규칙으로만 처리",updatedAt:date,definition:{schemaVersion:5,nodes:[
  {id:"input",type:"input",title:"요청",x:0,y:0},
  {id:"format",type:"transform",title:"형식",x:200,y:0,transform:{mode:"template",template:"완료:{{text}}"}},
  {id:"output",type:"output",title:"결과",x:400,y:0},
],edges:[{id:"a",source:"input",target:"format"},{id:"b",source:"format",target:"output"}]}};
const options={user,workflow,connections:[],resolveResources:async()=>[],exportedAt:date};
const env:NodeJS.ProcessEnv={NODE_ENV:"test",...Object.fromEntries(["PATH","Path","SystemRoot","WINDIR","TEMP","TMP","PATHEXT"].flatMap(key=>process.env[key]?[[key,process.env[key]!]]:[]))};
const python=process.platform==="win32"?"python":"python3";

test("web/executable import keeps only design and origin, rejects unsupported formats",async()=>{
  const web=parseWorkflowImport({format:"flowly-workflow",version:5,workflow:{...workflow,ownerId:"foreign",visibility:"public",editEmails:["someone@test"]}});
  assert.equal(web.workflow.id,workflow.id);assert.equal("ownerId" in web.workflow,false);assert.equal("visibility" in web.workflow,false);
  const manifest=await buildExportManifest(options),parsed=parseWorkflowImport(manifest);
  assert.deepEqual(parsed.origin,{workflowId:workflow.id,updatedAt:date});assert.equal(parsed.format,"executable");
  assert.throws(()=>parseWorkflowImport({...manifest,version:99}),/버전/);
  assert.throws(()=>parseWorkflowImport({format:"other",workflow}),/형식/);
});

test("import rebinds accessible resources without importing exported private bodies",()=>{
  const source=structuredClone(workflow);source.definition.nodes[1]={id:"format",type:"resource",title:"자료",x:200,y:0,resourceId:"old"};
  const parsed=parseWorkflowImport({format:"flowly-executable-export",version:1,workflow:source,resources:[{id:"old",name:"자료",type:"document",content:"DO_NOT_IMPORT_SECRET_BODY"}]});
  const resource:Resource={id:"mine",name:"내 자료",type:"document",ownerId:user.userId,content:"새 내용",description:"",url:"",visibility:"private",allowedEmails:[],createdAt:date,updatedAt:date};
  assert.doesNotMatch(JSON.stringify(parsed),/DO_NOT_IMPORT_SECRET_BODY/);
  assert.throws(()=>rebindImportedWorkflow(parsed,{},[]),/다시 연결/);
  const rebound=rebindImportedWorkflow(parsed,{old:"mine"},[resource]);assert.equal(rebound.definition.nodes[1].resourceId,"mine");
  assert.equal(source.definition.nodes[1].resourceId,"old");
  assert.throws(()=>rebindImportedWorkflow(parsed,{old:"mine"},[{...resource,type:"prompt"}]),/같은 종류/);
  assert.ok(workflowImportDiff(workflow,rebound).changed.includes("root/format"));
});

test("three AI purposes share exact design, short instruction, guide and explicit modification boundaries",async()=>{
  for(const intent of ["run","modify","build"] as const){
    const manifest=await buildExportManifest({...options,intent});
    const prompt=buildCopyPrompt(manifest),kickoff=buildStartPrompt(manifest);
    assert.match(kickoff,/Cowork 또는 Codex/);assert.match(kickoff,/START_HERE.md/);
    assert.match(prompt,/agent\.(mjs|py)/);assert.match(prompt,/완료:\{\{text\}\}/);
    if(intent!=="run")assert.match(prompt,/ROUNDTRIP.md/);
  }
  const published=await buildExportManifest({...options,sourceVersion:{id:"version-test",number:3}});
  assert.equal(published.origin?.versionNumber,3);assert.equal(published.origin?.versionId,"version-test");
  assert.equal(parseWorkflowImport(published).origin.versionNumber,3);
  assert.match(buildCopyPrompt(published),/"number": 3/);
});

test("knowledge import rebinds evaluation answers with allowed documents without changing questions or index settings",()=>{
  const source=structuredClone(workflow);
  source.definition.nodes[1]={id:"format",type:"knowledge",title:"검색 평가",x:200,y:0,knowledge:{action:"evaluate",indexKey:"company",resourceIds:["old"],generationPath:"text",evaluation:[{query:"운영 기준은 무엇인가요?",resourceId:"old"}]}};
  const parsed=parseWorkflowImport({format:"flowly-executable-export",version:1,workflow:source,resources:[{id:"old",name:"기준 문서",type:"document"}]});
  const resource:Resource={id:"mine",name:"내 기준 문서",type:"document",ownerId:user.userId,content:"확인된 기준",description:"",url:"",visibility:"private",allowedEmails:[],createdAt:date,updatedAt:date};
  const rebound=rebindImportedWorkflow(parsed,{old:"mine"},[resource]);
  assert.deepEqual(rebound.definition.nodes[1].knowledge,{...source.definition.nodes[1].knowledge,resourceIds:["mine"],evaluation:[{query:"운영 기준은 무엇인가요?",resourceId:"mine"}]});
  assert.equal(source.definition.nodes[1].knowledge!.evaluation![0].resourceId,"old");
  assert.equal(parsed.workflow.definition.nodes[1].knowledge!.evaluation![0].resourceId,"old");
  assert.throws(()=>rebindImportedWorkflow(parsed,{old:"mine"},[]),/다시 연결/);
});

for(const language of ["node","python"] as const)test(`${language} zero-Agent download executes, detects code changes, reimports design and runs fresh revised export`,async()=>{
  const folder=await mkdtemp(join(tmpdir(),"flowly-roundtrip-"));
  try{
    const bytes=await buildExecutableExportPackage({...options,language,kind:"agent"});
    const files=unzipSync(bytes);await extractExportEntries(folder,files);
    assert.equal(JSON.parse(strFromU8(files["agent-manifest.json"])).agents.length,0);
    for(const path of ["START_HERE.md","AI_START.md","AI_PROMPT.md","AGENTS.md","Agent.md","CORE_TERMS.md","ROUNDTRIP.md","project-check.py","PROJECT_FILES.json","skills/flowly-workflow/SKILL.md"])assert.ok(files[path],path);
    assert.ok(!files[".env"]);
    const invoke=(args:string[],cwd=folder)=>{const result=spawnSync(language==="node"?process.execPath:python,[...(language==="python"?["-X","utf8"]:[]),language==="node"?"agent.mjs":"agent.py",...args],{cwd,env,encoding:"utf8",timeout:25000,windowsHide:true});assert.equal(result.status,0,result.stderr||result.stdout);return JSON.parse(result.stdout);};
    assert.equal(invoke(["check"]).status,"ready");
    const run=invoke(["run","--input","원문"]);assert.equal(run.status,"succeeded");assert.equal(run.result,"완료:원문");
    const check=spawnSync(python,["-X","utf8","project-check.py"],{cwd:folder,env,encoding:"utf8",timeout:25000,windowsHide:true});assert.equal(check.status,0,check.stderr||check.stdout);
    const imported=await readWorkflowImport("project.zip",bytes);assert.equal(imported.integrity,"matched");
    const manifest=JSON.parse(strFromU8(files["workflow.json"]));manifest.workflow.definition.nodes[1].transform.template="수정:{{text}}";files["workflow.json"]=strToU8(JSON.stringify(manifest));
    const runner=language==="node"?"runner.mjs":"runner.py";files[runner]=strToU8(strFromU8(files[runner])+"\n"+(language==="node"?"// changed":"# changed"));
    const modified=await readWorkflowImport("changed.zip",zipSync(files));assert.equal(modified.integrity,"changed");assert.deepEqual(modified.codeChanges,[runner]);
    const copy=rebindImportedWorkflow(modified,{},[]);copy.id="roundtrip-new";
    const fresh=unzipSync(await buildExecutableExportPackage({...options,workflow:copy,language,kind:"agent"}));const nextFolder=join(folder,"fresh");await mkdir(nextFolder);await extractExportEntries(nextFolder,fresh);
    const newRun=invoke(["run","--input","원문"],nextFolder);assert.equal(newRun.result,"수정:원문");assert.notEqual(newRun.id,run.id);
    await writeFile(join(folder,"workflow.json"),"{}");
    const mismatch=spawnSync(python,["-X","utf8","project-check.py"],{cwd:folder,env,encoding:"utf8",timeout:25000,windowsHide:true});assert.equal(mismatch.status,1);assert.match(mismatch.stdout,/workflow.json/);
  }finally{const inside=relative(resolve(tmpdir()),folder);assert.ok(inside&&!inside.startsWith("..")&&!isAbsolute(inside));await rm(folder,{recursive:true,force:true});}
});
