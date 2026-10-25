import test from "node:test";
import assert from "node:assert/strict";
import { workflowWorkStyles } from "../domain/work-styles";
import { getExample, listExamples } from "../server/example-catalog";
import type { Definition } from "../app/lib/model";

test("work style classification follows nested execution settings, not title words",()=>{
  const child:Definition={nodes:[{id:"a",title:"작업",type:"agent",x:0,y:0},{id:"q",title:"입력",type:"form",x:0,y:0,form:{mode:"request",fields:[]}}],edges:[]};
  const graph:Definition={nodes:[{id:"parallel",type:"parallel",title:"직접 해결",x:0,y:0,parallel:{concurrency:2,tasks:[{id:"one",name:"역할",definition:child}]}}],edges:[]};
  assert.deepEqual(workflowWorkStyles(graph),["parallel","human","composite"]);
  assert.deepEqual(workflowWorkStyles({nodes:[{id:"a",type:"agent",title:"병렬 검색 복구",prompt:"RAG parallel",x:0,y:0}],edges:[]}),["direct"]);
});
test("catalog work-style filter is applied before pagination and preserves all existing identities",()=>{
  const all=listExamples(new URLSearchParams("pageSize=48")),parallel=listExamples(new URLSearchParams("workStyle=parallel&pageSize=48"));
  assert.equal(all.stats.sourceGraphs,227);assert.equal(all.stats.projects,156);assert.ok(parallel.total>0&&parallel.total<all.total);
  assert.ok(parallel.items.every(project=>project.workStyles?.includes("parallel")));
  assert.ok(parallel.workStyles.some(style=>style.id==="parallel"));
  for(const item of parallel.items)assert.deepEqual(getExample(item.id)?.workStyles,item.workStyles);
  assert.equal(listExamples(new URLSearchParams("workStyle=not_a_style")).total,0);
  assert.ok(listExamples(new URLSearchParams("workStyle=human&pageSize=48")).items.every(item=>item.workStyles?.includes("human")));
});
