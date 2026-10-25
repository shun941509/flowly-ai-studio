import {test} from "node:test";
import assert from "node:assert/strict";
import {compileDefinition,resolveNodeInput,assertSchema} from "../domain/workflow";
import {templateWorkflow,parseDefinition} from "../app/lib/model";
import {parseSchema} from "../domain/schema";

test("legacy templates migrate explicitly without granting autonomous tools",()=>{
  for(const kind of ["assistant","meeting","research"]) {
    const d=compileDefinition(templateWorkflow(kind).definition);
    assert.equal(d.schemaVersion,5);
    assert.equal(d.nodes.find(n=>n.id==="ai")?.type,"ai");
    assert.equal(d.nodes.some(n=>n.allowedTools?.length),false);
    assert.deepEqual(parseDefinition(d),parseDefinition(JSON.parse(JSON.stringify(d))));
  }
});
test("mapped predecessor outputs drive next input and malformed paths fail",()=>{
  const d=compileDefinition(templateWorkflow("agent").definition),n=d.nodes.find(n=>n.type==="agent")!;
  assert.equal(resolveNodeInput(d,n,{input:{text:"actual upstream"}},[]).text,"actual upstream");
  assert.throws(()=>resolveNodeInput(d,n,{input:{other:"x"}},[]),/찾지/);
  n.inputBindings={text:{nodeId:"output",path:"text"}};
  assert.throws(()=>compileDefinition(d),/직접 연결/);
});
test("cycles, future versions and prototype path injection are rejected",()=>{
  const d=templateWorkflow("agent").definition;
  assert.throws(()=>compileDefinition({...d,edges:[...d.edges,{id:"cycle",source:"output",target:"input"}]}),/순환|입력 블록|출력 블록/);
  assert.throws(()=>parseDefinition({...d,schemaVersion:99}),/버전/);
  for(const id of ["__proto__","constructor","toString","hasOwnProperty"]){assert.throws(()=>parseDefinition({...d,nodes:d.nodes.map((n,i)=>i===0?{...n,id}:n)}),/블록 ID/);}
  d.nodes[1].inputBindings={text:{nodeId:"input",path:"constructor.prototype"}};
  assert.throws(()=>parseDefinition(d),/입력 연결/);
});
test("schema checking reports field errors and enforces additional properties",()=>{
  const schema={type:"object" as const,properties:{text:{type:"string" as const}},required:["text"],additionalProperties:false};
  assert.throws(()=>assertSchema({},schema),/값이 필요/);
  assert.throws(()=>assertSchema({text:5},schema),/형식/);
  assert.throws(()=>assertSchema({text:"ok",extra:true},schema),/필드를 사용할/);
  assert.doesNotThrow(()=>assertSchema({text:"ok"},schema));
  const workflow=templateWorkflow("agent");
  assert.throws(()=>parseDefinition({...workflow.definition,nodes:workflow.definition.nodes.map(n=>n.type==="agent"?{...n,inputSchema:{type:"string",minLength:2}}:n)}),/스키마 제약/);
});
test("malformed explicit schema fields never silently remove validation",()=>{
  for(const schema of [{type:"object",properties:null},{type:"object",required:null},{type:"object",additionalProperties:"false"},{type:"string",required:[]},{type:"object",items:{type:"string"}},{type:"array",items:null}]) assert.throws(()=>parseSchema(schema));
});
