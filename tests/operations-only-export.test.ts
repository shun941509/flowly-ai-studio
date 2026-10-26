import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import type { Workflow } from "../app/lib/model";
import { buildExecutableExportPackage } from "../server/export-assets";
import { extractExportEntries } from "./export-zip";

const user={userId:"operations-export-test",email:"operations@example.test",displayName:"운영 ZIP 검사"};
const workflow:Workflow={id:"operations-export",name:"Agent 없는 값 전달",description:"실제 입력 전달 검사",updatedAt:"2026-10-26T00:00:00Z",definition:{schemaVersion:5,nodes:[
  {id:"input",type:"input",title:"입력",x:0,y:0},
  {id:"format",type:"transform",title:"결과 구성",x:240,y:0,transform:{mode:"template",template:"운영 결과:{{text}}"}},
  {id:"output",type:"output",title:"출력",x:480,y:0},
],edges:[{id:"a",source:"input",target:"format"},{id:"b",source:"format",target:"output"}]}};
const env:NodeJS.ProcessEnv={NODE_ENV:"test",...Object.fromEntries(["PATH","Path","SystemRoot","WINDIR","TEMP","TMP","PATHEXT"].flatMap(key=>process.env[key]?[[key,process.env[key]!]]:[]))};
const python=process.platform==="win32"?"python":"python3";

for(const language of ["node","python"] as const)for(const kind of ["runtime","agent"] as const)test(`${language}/${kind}: operational ZIP has no development mode or test fixtures and executes its actual no-Agent design`,async()=>{
  const folder=await mkdtemp(join(tmpdir(),"flowly-operations-export-"));
  try{
    const files=unzipSync(await buildExecutableExportPackage({user,workflow,language,kind,connections:[],resolveResources:async()=>[]}));
    await extractExportEntries(folder,files);
    for(const name of Object.keys(files))assert.doesNotMatch(name,/(^|\/)(tests?|fixtures?|mocks?|node_modules|\.dev\.vars)(\/|$)|(?:vite|wrangler)\.config|preload|boundary/);
    for(const name of ["START_HERE.md","AI_START.md","AI_PROMPT.md","AGENTS.md","workflow.json",".env.example","flowly_ops.py","flowly_local.py","OPERATIONS.md","PROJECT_FILES.json","project-check.py","ROUNDTRIP.md"])assert.ok(files[name],name);
    assert.equal(files[".env"],undefined);
    const local=strFromU8(files["flowly_local.py"]),operations=strFromU8(files["flowly_ops.py"]);
    assert.doesNotMatch(local,/newProduction|placeholder="development"|\|\|'development'/);
    assert.match(local,/confirmProduction:\$\('production'\)\.checked/);
    assert.match(operations,/VALUES\('production','\.env',1\)/);
    assert.match(operations,/production=false는 지원하지 않습니다/);
    const manifest=JSON.parse(strFromU8(files["workflow.json"]));
    assert.deepEqual(manifest.workflow.definition.edges,workflow.definition.edges);
    assert.deepEqual(manifest.workflow.definition.nodes.map((node:{id:string;type:string;title:string})=>({id:node.id,type:node.type,title:node.title})),workflow.definition.nodes.map(({id,type,title})=>({id,type,title})));
    assert.deepEqual(manifest.workflow.definition.nodes[1].transform,workflow.definition.nodes[1].transform);
    assert.deepEqual(manifest.workflow.definition.nodes[2].inputBindings,{text:{nodeId:"format",path:"text"}});
    if(kind==="agent")assert.deepEqual(JSON.parse(strFromU8(files["agent-manifest.json"])).agents,[]);
    const entry=(kind==="agent"?"agent":"runner")+(language==="node"?".mjs":".py");
    const invoke=(args:string[])=>{const result=spawnSync(language==="node"?process.execPath:python,[...(language==="python"?["-X","utf8"]:[]),entry,...args],{cwd:folder,env,encoding:"utf8",timeout:25000,windowsHide:true});assert.equal(result.status,0,result.stderr||result.stdout);return JSON.parse(result.stdout);};
    assert.equal(invoke(["check"]).status,"ready");
    const run=invoke(["run","--input","입력 값 그대로"]);
    assert.equal(run.status,"succeeded");assert.equal(run.result,"운영 결과:입력 값 그대로");
    const integrity=spawnSync(python,["-X","utf8","project-check.py"],{cwd:folder,env,encoding:"utf8",timeout:25000,windowsHide:true});
    assert.equal(integrity.status,0,integrity.stderr||integrity.stdout);
  }finally{const inside=relative(resolve(tmpdir()),folder);assert.ok(inside&&!inside.startsWith("..")&&!isAbsolute(inside));await rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

for(const language of ["node","python"] as const)test(`${language}: an actual exported AI runner stops unconfigured without any fake model fallback`,async()=>{
  const folder=await mkdtemp(join(tmpdir(),"flowly-missing-config-"));
  try{
    const selected=structuredClone(workflow);selected.definition.nodes[1]={id:"format",type:"agent",title:"실제 모델이 필요한 Agent",x:240,y:0,prompt:"요청에 답하세요."};
    const files=unzipSync(await buildExecutableExportPackage({user,workflow:selected,language,kind:"runtime",connections:[],resolveResources:async()=>[]}));
    await extractExportEntries(folder,files);
    const invoke=(action:string)=>spawnSync(language==="node"?process.execPath:python,[...(language==="python"?["-X","utf8"]:[]),language==="node"?"runner.mjs":"runner.py",action,...(action==="run"?["--input","설정 없는 요청"]:[])],{cwd:folder,env,encoding:"utf8",timeout:25000,windowsHide:true});
    const check=invoke("check");assert.equal(JSON.parse(check.stdout).status,"unconfigured");assert.match(check.stdout,/OPENAI_API_KEY/);
    const run=invoke("run");assert.notEqual(run.status,0);assert.match(run.stdout+run.stderr,/미설정|OPENAI_API_KEY/);assert.doesNotMatch(run.stdout,/"status"\s*:\s*"succeeded"/);
  }finally{const inside=relative(resolve(tmpdir()),folder);assert.ok(inside&&!inside.startsWith("..")&&!isAbsolute(inside));await rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
