import test from "node:test";
import assert from "node:assert/strict";
import type { Definition, FlowNode } from "../app/lib/model";
import { representativeCollaborationDesigns } from "../domain/workflow-designs/representative-collaboration";
import { representativeControlDesigns } from "../domain/workflow-designs/representative-control";
import { representativeRetrievalDesigns } from "../domain/workflow-designs/representative-retrieval";
import { edgePorts, executionModeLabel, layoutWorkflow, placeNewNode, routeWorkflowEdges, segmentCrossesNode, workflowBounds, WORKFLOW_NODE_HEIGHT as H, WORKFLOW_NODE_WIDTH as W } from "../domain/workflow-layout";

const designs=[...representativeCollaborationDesigns,...representativeControlDesigns,...representativeRetrievalDesigns];
function allGraphs(definition:Definition):Definition[]{return [definition,...definition.nodes.flatMap(node=>[...(node.parallel?.tasks??node.team?.tasks??node.orchestration?.tasks??[]).flatMap(task=>allGraphs(task.definition)),...(node.loop?allGraphs(node.loop.definition):[]),...(node.subworkflow?allGraphs(node.subworkflow.definition):[])])];}
function withoutPositions(value:unknown):unknown{if(Array.isArray(value))return value.map(withoutPositions);if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).filter(([key])=>key!=="x"&&key!=="y").map(([key,item])=>[key,withoutPositions(item)]));return value;}
function assertClear(definition:Definition){
 for(const [index,a] of definition.nodes.entries())for(const b of definition.nodes.slice(index+1))assert.ok(a.x+W<=b.x||b.x+W<=a.x||a.y+H<=b.y||b.y+H<=a.y,`${a.id}/${b.id} overlap`);
 const routes=routeWorkflowEdges(definition);
 assert.equal(routes.length,definition.edges.length);
 const bounds=workflowBounds(definition,routes);
 for(const route of routes){
  assert.equal(route.blocked,false,`${route.edgeId} could not avoid nodes`);
  for(const [index,point] of route.points.entries()){
   assert.ok(point.x>=bounds.minX&&point.x<=bounds.maxX&&point.y>=bounds.minY&&point.y<=bounds.maxY);
   if(index)for(const node of definition.nodes)assert.equal(segmentCrossesNode(route.points[index-1],point,node),false,`${route.edgeId} crosses ${node.id}`);
  }
  const edge=definition.edges.find(edge=>edge.id===route.edgeId)!;
  const ports=edgePorts(definition.nodes.find(node=>node.id===edge.source)!,definition.nodes.find(node=>node.id===edge.target)!,edge);
  assert.deepEqual(route.points[0],ports.start);assert.deepEqual(route.points.at(-1),ports.end);
 }
}
for(const design of designs)test(`${design.id}: coordinates only, dependency order, no overlaps or node-crossing edges`,()=>{
 const original=structuredClone(design.definition), arranged=layoutWorkflow(design.definition);
 assert.deepEqual(design.definition,original,"input not mutated");
 assert.deepEqual(withoutPositions(arranged),withoutPositions(original),"execution contract and array order retained");
 assert.deepEqual(layoutWorkflow(arranged),arranged,"deterministic/idempotent");
 for(const graph of allGraphs(arranged)){
  assertClear(graph);
  for(const edge of graph.edges){const source=graph.nodes.find(node=>node.id===edge.source)!,target=graph.nodes.find(node=>node.id===edge.target)!;assert.ok(source.y+H<target.y,`${edge.source} must precede ${edge.target}`);}
 }
});
const node=(id:string,x=0,y=0,type:FlowNode["type"]="transform"):FlowNode=>({id,type,title:id,x,y});
test("long skip connection routes around intermediate nodes while retaining all edges",()=>{
 const graph=layoutWorkflow({nodes:[node("first"),node("middle"),node("last")],edges:[{id:"a",source:"first",target:"middle"},{id:"b",source:"middle",target:"last"},{id:"skip",source:"first",target:"last"}]});
 assertClear(graph);assert.ok(routeWorkflowEdges(graph).find(route=>route.edgeId==="skip")!.points.length>=4);
});
test("manual backward and side-by-side positions route around node boxes without relocating them",()=>{
 const graph:Definition={nodes:[node("from",100,400),node("obstacle",320,220),node("to",500,20)],edges:[{id:"back",source:"from",target:"to"}]};
 const snapshot=structuredClone(graph);assertClear(graph);assert.deepEqual(graph,snapshot);
});
test("invalid cycles stay editable, bounded and semantically unchanged",()=>{
 const graph:Definition={nodes:[node("a"),node("b")],edges:[{id:"a",source:"a",target:"b"},{id:"b",source:"b",target:"a"}]};
 const arranged=layoutWorkflow(graph);assert.deepEqual(withoutPositions(arranged),withoutPositions(graph));assertClear(arranged);
});
test("40 independent nodes fit stored coordinate limits without collisions",()=>{
 const graph=layoutWorkflow({nodes:Array.from({length:40},(_,i)=>node(`n${i}`)),edges:[]});assertClear(graph);assert.ok(graph.nodes.every(node=>Math.abs(node.x)<=10000&&Math.abs(node.y)<=10000));
});
test("new nodes and copies avoid occupied slots without altering saved coordinates",()=>{
 const graph:Definition={nodes:[node("old",40,40)],edges:[]};const original=structuredClone(graph);
 for(let i=0;i<35;i++){const point=placeNewNode(graph,{x:40,y:40});graph.nodes.push(node(`new${i}`,point.x,point.y));}
 assert.deepEqual(graph.nodes[0],original.nodes[0]);assertClear(graph);
 const dropped=placeNewNode(graph,{x:7000,y:7000});assert.deepEqual(dropped,{x:7000,y:7000});
});
test("execution labels distinguish actual parallel tasks, sequential teams and adaptive choice",()=>{
 assert.match(executionModeLabel({...node("parallel"),parallel:{tasks:[],concurrency:3}})!,/동시 최대 3개/);
 assert.match(executionModeLabel({...node("team"),team:{tasks:[],concurrency:3,mode:"sequential"}})!,/순차 실행/);
 assert.match(executionModeLabel({...node("adaptive"),orchestration:{tasks:[],maxTasks:3,maxRounds:2,mode:"adaptive"}})!,/다음 작업 선택 · 최대 2회/);
});
