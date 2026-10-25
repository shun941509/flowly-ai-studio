import test from "node:test";
import assert from "node:assert/strict";
import { assertDistinctExamples, hasExplicitAgent } from "../domain/example-publication";
import type { Definition } from "../app/lib/model";

const graph:Definition={schemaVersion:5,nodes:[{id:"input",type:"input",title:"입력",x:0,y:0},{id:"agent",type:"agent",title:"분석",x:0,y:100,prompt:"초안을 작성하세요."},{id:"output",type:"output",title:"결과",x:0,y:200}],edges:[{id:"a",source:"input",target:"agent"},{id:"b",source:"agent",target:"output"}]};
test("publication rejects the same flow even with renamed nodes, prompts, layout and execution settings",()=>{
  const variant=structuredClone(graph);
  variant.nodes=variant.nodes.map(n=>({...n,id:`new-${n.id}`,title:"다른 프로젝트",x:400,y:900,prompt:"완전히 다른 업무 설명",...(n.type==="agent"?{limits:{maxTurns:5}}:{})})).reverse();
  variant.edges=variant.edges.map(e=>({...e,id:`new-${e.id}`,source:`new-${e.source}`,target:`new-${e.target}`})).reverse();
  assert.deepEqual(assertDistinctExamples([{id:"one",definition:graph}]),{projects:1,topologies:1});
  assert.throws(()=>assertDistinctExamples([{id:"one",definition:graph},{id:"two",definition:variant}]),/서로 다른 실행 구조/);
});

test("Agent classification requires an explicit Agent including child workflows",()=>{
  assert.equal(hasExplicitAgent(graph),true);
  const modelOnly=structuredClone(graph);modelOnly.nodes.find(node=>node.type==="agent")!.type="ai";
  assert.equal(hasExplicitAgent(modelOnly),false);
  assert.equal(hasExplicitAgent({nodes:[{id:"child",title:"하위",type:"subworkflow",x:0,y:0,subworkflow:{definition:graph}}],edges:[]}),true);
});
