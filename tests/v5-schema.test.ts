import test from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { templateWorkflow, parseDefinition, type Workflow } from "../app/lib/model";
import { compileDefinition } from "../domain/workflow";
import { inspectWorkflow } from "../domain/preflight";
import { buildExportPackage } from "../server/export-package";
import { parseExtendedNodeConfig } from "../domain/extended-config";

const user={userId:"v5-test",email:"v5@example.com",displayName:"검증"};
const kinds=["file-text","file-ocr","table-export","guard-evaluate","vector-answer","web-stream","adaptive-plan","scheduled-work","memory-ttl"];
test("v5 templates and explicit older-version migrations retain all new settings",()=>{
  for(const kind of kinds){const d=compileDefinition(templateWorkflow(kind).definition);assert.equal(d.schemaVersion,5);assert.deepEqual(compileDefinition(JSON.parse(JSON.stringify(d))),d);}
  for(const version of [1,2,3,4]) {const d=templateWorkflow("assistant").definition;d.schemaVersion=version as 1|2|3|4;assert.equal(compileDefinition(d).schemaVersion,5);}
});
test("file, guardrail, evaluator and trigger contracts reject unsafe or unbounded configuration",()=>{
  const invalid=[
    {type:"file_input",fileInput:{path:"__proto__",maxBytes:10}},
    {type:"file_input",fileInput:{path:"file",maxBytes:10000001}},
    {type:"document_extract",documentExtract:{mode:"ocr",filePath:"file",maxPages:101,language:"kor"}},
    {type:"document_extract",documentExtract:{mode:"ocr",filePath:"file",maxPages:1,language:"../kor"}},
    {type:"guardrail",guardrail:{action:"mask",categories:["email","email"]}},
    {type:"evaluate",evaluation:{mode:"rules",rules:[],rubric:"",threshold:1}},
    {type:"evaluate",evaluation:{mode:"rules",rules:[{kind:"min_length",value:"200001"}],rubric:"",threshold:1}},
    {type:"evaluate",evaluation:{mode:"model",rules:[],rubric:"",threshold:.5}},
    {type:"trigger",trigger:{kind:"schedule",intervalSeconds:0,startAt:"",eventType:""}},
    {type:"trigger",trigger:{kind:"schedule",intervalSeconds:1,startAt:"2026-10-22T10:00:00",eventType:""}},
    {type:"ai",delivery:{stream:true}},
    {type:"ai",guardrail:{action:"block",categories:["email"]}},
  ];
  for(const value of invalid) assert.throws(()=>parseExtendedNodeConfig(value));
  for(const filename of ["../out.csv","CON.csv","a.xlsx","out.csv ","C:\\out.csv"])
    assert.throws(()=>parseExtendedNodeConfig({type:"file_output",fileOutput:{format:"csv",filename,dataPath:"data"}}));
});
test("trigger is root-only and privacy blocking cannot use the recoverable error branch",()=>{
  const nested=templateWorkflow("reusable-work").definition;nested.nodes[1].subworkflow!.definition=templateWorkflow("scheduled-work").definition;
  assert.throws(()=>compileDefinition(nested),/자동 시작|최상위/);
  const guarded=templateWorkflow("guard-evaluate").definition;guarded.nodes[1].onError="branch";
  assert.throws(()=>parseDefinition(guarded),/오류 분기/);
});
test("vector, web and model evaluation require external model setup without web live execution",()=>{
  for(const kind of ["vector-answer","web-stream","adaptive-plan"]) {const status=inspectWorkflow(templateWorkflow(kind),[]);assert.equal(status.requiresModel,true);assert.ok(status.issues.some(i=>i.message.includes("웹에서는 모델을 호출하지")));}
  const flow=templateWorkflow("guard-evaluate");flow.definition.nodes[2].evaluation={mode:"model",rules:[],rubric:"평가",threshold:.5};assert.equal(inspectWorkflow(flow,[]).requiresModel,true);
});
test("both export languages include only needed helpers and refuse incomplete runtime packages",async()=>{
  for(const language of ["node","python"] as const)for(const kind of ["file-text","scheduled-work","guard-evaluate"]){
    const workflow:Workflow=templateWorkflow(kind);
    const options={user,workflow,connections:[],resolveResources:async()=>[],language,runnerSource:"# test fixture",helpers:{files:"# helper fixture",requirements:"# deps fixture",triggers:"# trigger fixture"}};
    const files=unzipSync(await buildExportPackage(options));
    assert.equal(Boolean(files["flowly_files.py"]),kind==="file-text");
    assert.equal(Boolean(files["requirements-files.txt"]),kind==="file-text");
    assert.equal(Boolean(files["flowly_triggers.py"]),kind==="scheduled-work");
    assert.doesNotMatch(strFromU8(files[".env.example"]),/OPENAI_API_KEY/);
    assert.equal(JSON.parse(strFromU8(files["workflow.json"])).workflow.definition.schemaVersion,5);
    if(kind!=="guard-evaluate")await assert.rejects(buildExportPackage({...options,helpers:undefined}),/도우미/);
  }
});
