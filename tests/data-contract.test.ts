import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Definition, FlowNode } from "../app/lib/model";
import { effectiveBindings, mappingIssues, outputFields, setOutputField } from "../domain/data-contract";
import { InputMappings, OutputContractEditor } from "../app/ui/input-mappings";
import { assertSchema } from "../domain/schema";
import { formInput } from "../runtime/advanced";
import { resolveNodeInput } from "../domain/workflow";

const n=(id:string,type:FlowNode["type"],extra:Partial<FlowNode>={}):FlowNode=>({id,type,title:id,x:0,y:0,...extra});
const definition=(nodes:FlowNode[],pairs:string[][]):Definition=>({schemaVersion:5,nodes,edges:pairs.map(([source,target],i)=>({id:String(i),source,target}))});

test("field picker uses form result fields and actual input resolution without producing sample answers",()=>{
  const source=n("form","form",{form:{fields:[{key:"budget",label:"예산",type:"number",required:true},{key:"topic",label:"주제",type:"text",required:true}]}});
  const target=n("agent","agent",{inputBindings:{budget:{nodeId:"form",path:"data.budget"}},inputSchema:{type:"object",properties:{budget:{type:"number"}},required:["budget"]}});
  const graph=definition([source,target],[["form","agent"]]);
  assert.equal(outputFields(source,graph).find(f=>f.path==="data.budget")?.type,"number");
  const input=resolveNodeInput(graph,target,{form:formInput(source,'{"budget":17,"topic":"조사"}')},[]);
  assert.deepEqual(input,{budget:17});assertSchema(input,target.inputSchema);
  assert.deepEqual(mappingIssues(graph,target),[]);
  const markup=renderToStaticMarkup(createElement(InputMappings,{node:target,definition:graph,onChange:()=>{}}));
  assert.match(markup,/data.budget/);assert.match(markup,/받을 형식/);assert.match(markup,/실제 응답이 아니에요/);
});
test("known mismatch is explained while dynamic fields remain possible and runtime enforces types",()=>{
  const source=n("source","agent",{format:"JSON",outputSchema:{type:"object",properties:{data:{type:"object",properties:{score:{type:"number"}}}}}});
  const target=n("target","transform",{inputBindings:{text:{nodeId:"source",path:"data.score"}},inputSchema:{type:"object",properties:{text:{type:"string"}}}});
  const graph=definition([source,target],[["source","target"]]);
  assert.equal(mappingIssues(graph,target)[0]?.severity,"warning");
  assert.throws(()=>assertSchema(resolveNodeInput(graph,target,{source:{text:"",data:{score:42}}},[]),target.inputSchema),/형식/);
  assert.deepEqual(mappingIssues(graph,{...target,inputBindings:{text:{nodeId:"source",path:"data.external_dynamic_field"}}}),[]);
});
test("tool response uses actual data field and child output is not a group wrapper",()=>{
  assert.equal(outputFields(n("tool","tool")).some(f=>f.path==="result"),false);
  assert.equal(outputFields(n("tool","tool")).some(f=>f.path==="data"),true);
  const child=definition([n("a","input"),n("b","form",{form:{mode:"request",fields:[{key:"score",label:"점수",type:"number",required:true}]}}),n("out","output",{inputBindings:{score:{nodeId:"b",path:"data.score"}}})],[["a","b"],["b","out"]]);
  const fields=outputFields(n("sub","subworkflow",{subworkflow:{definition:child}}));
  assert.equal(fields.find(f=>f.path==="score")?.type,"number");assert.equal(fields.some(f=>f.path==="results"),false);
});
test("legacy bindings and explicit empty bindings preserve their different meanings",()=>{
  const a=n("a","input"),b=n("b","output"),graph=definition([a,b],[["a","b"]]);
  assert.deepEqual(effectiveBindings(graph,b),{text:{nodeId:"a",path:"text"}});
  assert.deepEqual(effectiveBindings(graph,{...b,inputBindings:{}}),{});
  assert.match(mappingIssues(graph,{...b,inputBindings:{text:{nodeId:"missing",path:"text"}}})[0].message,/직접 연결/);
});
test("declarative output edits preserve schemas, validate actual results and reject unsafe paths",()=>{
  const schema=setOutputField(undefined,"data.title","string")!;
  assertSchema({data:{title:"새 설계"}},schema);assert.throws(()=>assertSchema({data:{title:3}},schema),/형식/);
  const original=structuredClone(schema),next=setOutputField(schema,"data.count","number")!;
  assert.deepEqual(schema,original);assert.equal(next.properties?.data.properties?.title.type,"string");
  assert.equal(setOutputField(next,"data.count")?.properties?.data.properties?.count,undefined);
  assert.throws(()=>setOutputField(schema,"__proto__.polluted","string"),/영문/);
  assert.throws(()=>setOutputField(schema,"data.title.child","string"),/상위/);
  const markup=renderToStaticMarkup(createElement(OutputContractEditor,{node:n("agent","agent",{outputSchema:next}),onChange:()=>{}}));
  assert.match(markup,/data.title/);assert.match(markup,/출력 형식 적용/);
});
test("field discovery handles cyclic incomplete graphs without recursion and array item paths are illustrative",()=>{
  const graph=definition([n("a","condition",{inputBindings:{x:{nodeId:"b",path:"x"}}}),n("b","condition",{inputBindings:{x:{nodeId:"a",path:"x"}}})],[["a","b"],["b","a"]]);
  assert.ok(outputFields(graph.nodes[0],graph).length<10);
  const fields=outputFields(n("p","parallel"));assert.ok(fields.some(f=>f.path==="results.0.output"));assert.ok(!fields.some(f=>f.path==="results.0.status"));
});
test("array output contracts validate every item and preserve sibling fields when edited",()=>{
  const schema=setOutputField(undefined,"data.items.0.title","string")!;
  const next=setOutputField(schema,"data.items.0.score","number")!;
  assertSchema({data:{items:[{title:"첫 번째",score:1},{title:"두 번째",score:2}]}},next);
  assert.throws(()=>assertSchema({data:{items:[{title:"정상",score:1},{title:"오류",score:"2"}]}},next),/형식/);
  assert.equal(next.properties?.data.properties?.items.items?.properties?.title.type,"string");
  assert.equal(setOutputField(next,"data.items.0.score")?.properties?.data.properties?.items.items?.properties?.score,undefined);
  assert.equal(schema.properties?.data.properties?.items.items?.properties?.score,undefined);
  assert.throws(()=>setOutputField(schema,"data.items.1.title","string"),/영문/);
});
test("passthrough memory and classification only expose text when mapped; review exposes its decision",()=>{
  for(const type of ["memory","classify"] as const){
    const target=n("target",type,{inputBindings:{value:{nodeId:"input",path:"text"}}});
    const graph=definition([n("input","input"),target],[["input","target"]]);
    assert.ok(!outputFields(target,graph).some(field=>field.path==="text"));
    assert.equal(outputFields(target,graph).find(field=>field.path==="value")?.type,"string");
  }
  assert.equal(outputFields(n("review","review")).find(field=>field.path==="approved")?.type,"boolean");
  assert.equal(outputFields(n("eval","evaluate")).find(field=>field.path==="evaluation.reason")?.type,"string");
});
test("overwritten output values remove stale input descendants from the picker",()=>{
  const source=n("source","agent",{outputSchema:{type:"object",properties:{data:{type:"object",properties:{oldField:{type:"string"}}},evaluation:{type:"object",properties:{oldScore:{type:"number"}}}}}});
  const memory=n("memory","memory",{inputBindings:{data:{nodeId:"source",path:"data"}}});
  const evaluate=n("evaluate","evaluate",{inputBindings:{evaluation:{nodeId:"source",path:"evaluation"}}});
  const graph=definition([source,memory,evaluate],[["source","memory"],["source","evaluate"]]);
  assert.ok(!outputFields(memory,graph).some(field=>field.path==="data.oldField"));
  assert.ok(outputFields(memory,graph).some(field=>field.path==="data"));
  assert.ok(!outputFields(evaluate,graph).some(field=>field.path==="evaluation.oldScore"));
  assert.ok(outputFields(evaluate,graph).some(field=>field.path==="evaluation.score"));
});
test("orchestration completion fields follow actual nonempty dependencies or completion settings",()=>{
  const node=n("plan","orchestrator",{orchestration:{tasks:[{id:"one",name:"작업",definition:definition([n("input","input"),n("out","output")],[["input","out"]]),dependsOn:[]}],maxTasks:1}});
  assert.ok(!outputFields(node).some(field=>field.path==="artifacts"||field.path==="completionChecks"));
  node.orchestration!.tasks[0].dependsOn=["prior"];
  assert.ok(outputFields(node).some(field=>field.path==="artifacts"));
});
