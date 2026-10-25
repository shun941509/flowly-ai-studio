import test from "node:test";
import assert from "node:assert/strict";
import { exampleSeeds } from "../domain/example-seeds";
import { getExample, instantiateExample, listExamples, saveExample } from "../server/example-catalog";
import { compileDefinition, referencedResourceIds } from "../domain/workflow";
import { canEditResource, canReadResource, validateGraph } from "../app/lib/model";
import { frameworkPacks } from "../server/generated/framework-packs";
import { workflowDesigns } from "../domain/workflow-designs";
import { workflowIdentity } from "../domain/workflow-identity";
import { hasExplicitAgent } from "../domain/example-publication";

const agentDesigns=workflowDesigns.filter(design=>hasExplicitAgent(design.definition));
const supportingDesigns=workflowDesigns.filter(design=>!hasExplicitAgent(design.definition));

test("catalog publishes only authored executable graphs and counts the remaining design work honestly",()=>{
  const list=listExamples(new URLSearchParams());
  assert.equal(list.stats.projects,agentDesigns.length);assert.ok(list.stats.projects>=24);assert.equal(list.stats.target,3200);
  assert.equal(list.stats.remaining,Math.max(0,list.stats.target-agentDesigns.length));assert.equal(list.stats.reviewed,0);
  assert.ok(!("cases" in list.stats));
  assert.equal(list.stats.variants,frameworkPacks.length);assert.equal(list.items.length,18);
  assert.ok(list.items.every(item=>item.kind==="workflow"));
  const topologies=new Set<string>(),executions=new Set<string>();
  for(const design of workflowDesigns) {
    const definition=compileDefinition(design.definition),identity=workflowIdentity(definition);
    assert.deepEqual(validateGraph(definition,design.resources),[],design.id);
    assert.ok(!topologies.has(identity.topology),`Same topology: ${design.id}`);topologies.add(identity.topology);
    assert.ok(!executions.has(identity.execution),`Same executable graph: ${design.id}`);executions.add(identity.execution);
    const project=getExample(design.id)!;assert.equal(project.kind,"workflow");
    assert.deepEqual(project.workflow.definition,definition,`Published graph must match authored graph: ${design.id}`);
    assert.equal(project.verification.live,false);assert.ok(project.acceptance.length>=3,design.id);assert.ok(project.failureCases.length>=1,design.id);
    assert.ok(design.scenarios.length>=2,`Normal and boundary scenarios: ${design.id}`);
  }
  assert.equal(list.stats.topologies,agentDesigns.length);assert.equal(list.stats.sourceTopologies,topologies.size);assert.equal(list.stats.sourceGraphs,workflowDesigns.length);assert.equal(list.stats.supporting,supportingDesigns.length);
  assert.ok(list.items.every(item=>item.hasAgent&&item.classification==="agent"));
});
test("archived prompt-only cases have no public list, project lookup, or search entry",()=>{
  const cases=listExamples(new URLSearchParams("view=cases&pageSize=48"));
  const designIds=new Set(workflowDesigns.map(d=>d.id));
  assert.equal(cases.total,0);assert.deepEqual(cases.items,[]);
  const archived=exampleSeeds.filter(seed=>!designIds.has(seed.id));
  assert.equal(archived.length,exampleSeeds.length-exampleSeeds.filter(seed=>designIds.has(seed.id)).length);
  for(const seed of archived)assert.equal(getExample(seed.id),undefined,`Archived case must not build a public project: ${seed.id}`);
  const query=listExamples(new URLSearchParams({q:archived.at(-1)!.id}));
  assert.equal(query.total,0);assert.deepEqual(query.items,[]);
});
test("catalog filters/page limits do not leak workflow/source blobs",()=>{
  const all=listExamples(new URLSearchParams("pageSize=999"));assert.equal(all.pageSize,48);
  assert.ok(all.items.every(item=>!("workflow" in item)&&!("files" in item)));
  const next=listExamples(new URLSearchParams("page=2&pageSize=18"));assert.equal(next.items.length,Math.min(18,Math.max(0,agentDesigns.length-18)));
  assert.equal(all.total,agentDesigns.length);assert.equal(all.items.length,Math.min(48,agentDesigns.length));
  assert.deepEqual(new Set(all.categories),new Set(agentDesigns.map(d=>d.category)));
  assert.deepEqual(new Set(all.frameworks),new Set(agentDesigns.flatMap(design=>getExample(design.id)!.frameworks)));
  const cases=listExamples(new URLSearchParams("view=cases&page=2&pageSize=18"));assert.equal(cases.items.length,0);assert.equal(cases.total,0);
  const query=listExamples(new URLSearchParams({view:"supporting",q:"출장비"}));assert.equal(query.items[0].id,"typed-expense");
  assert.equal(listExamples(new URLSearchParams("page=-1&pageSize=abc")).page,1);
  assert.equal(getExample("../../.env"),undefined);
  assert.ok(listExamples(new URLSearchParams({q:"에이전트 팀"})).items.some(item=>item.id==="incident-review"));
  const representatives=listExamples(new URLSearchParams({category:"대표 AI 시스템"}));
  assert.equal(representatives.total,6);
  assert.deepEqual(new Set(representatives.items.map(item=>item.id)),new Set(workflowDesigns.filter(design=>design.id.startsWith("showcase-")).map(design=>design.id)));
});
test("sequential team passes previous draft and parallel release checks gate the real result",()=>{
  const team=getExample("incident-review")!.workflow.definition;
  assert.equal(team.nodes.find(n=>n.type==="output")!.inputBindings!.text.path,"results.1.output.text");
  const group=team.nodes.find(n=>n.team)!.team!;
  assert.equal(group.mode,"sequential");assert.equal(group.tasks.length,2);
  assert.ok(team.nodes.some(n=>n.type==="resource"));
  const reviewer=group.tasks[1].definition.nodes.find(n=>n.type==="agent")!;
  assert.deepEqual(reviewer.inputBindings!.draft,{nodeId:"challenge_input",path:"previous.text"});
  assert.deepEqual(reviewer.inputBindings!.source,{nodeId:"challenge_input",path:"text"});
  const parallel=getExample("release-readiness")!.workflow.definition;
  const checks=parallel.nodes.find(n=>n.id==="release_checks")!;
  assert.equal(checks.parallel!.tasks.length,3);
  assert.deepEqual(checks.inputBindings!.data,{nodeId:"release_input",path:"data"});
  const gate=parallel.nodes.find(n=>n.id==="release_gate")!;
  assert.deepEqual(gate.predicate,{path:"evaluation.passed",operator:"eq",value:true});
  assert.deepEqual(gate.inputBindings!.evaluation,{nodeId:"release_evaluate",path:"evaluation"});
  assert.ok(parallel.edges.some(e=>e.source===gate.id&&e.target==="release_ready"&&e.branch==="yes"));
  assert.ok(parallel.edges.some(e=>e.source===gate.id&&e.target==="release_hold"&&e.branch==="no"));
});
test("cloning remaps every resource to private server-owned data across three identities",()=>{
  const identities=["alice","bob","charlie"].map(userId=>({userId,email:`${userId}@example.test`,displayName:userId}));
  const project=getExample("policy-citations")!,before=JSON.stringify(project);
  assert.equal(project.resources.length,2);
  const copies=identities.map(user=>instantiateExample(project,user));
  assert.equal(new Set(copies.map(c=>c.workflow.id)).size,3);
  copies.forEach((copy,index)=>{
    assert.ok(copy.resources.every(r=>!r.sample&&r.ownerId===identities[index].userId&&r.visibility==="private"));
    assert.deepEqual([...referencedResourceIds(copy.workflow.definition)].sort(),copy.resources.map(r=>r.id).sort());
    assert.ok(copy.resources.every(r=>!project.resources.some(original=>original.id===r.id)));
    for(const resource of copy.resources)for(let other=0;other<3;other++) {assert.equal(canReadResource(resource,identities[other]),other===index);assert.equal(canEditResource(resource,identities[other]),other===index);}
  });assert.equal(JSON.stringify(project),before);
});
test("clone resource/workflow/audit are one atomic D1 batch",async()=>{
  const batches:unknown[][]=[];const fake={prepare:(sql:string)=>({bind:(...args:unknown[])=>({sql,args})}),batch:async(statements:unknown[])=>{batches.push(statements);return[];}};
  const project=getExample("policy-citations")!;
  await saveExample(fake as unknown as D1Database,project,{userId:"trusted",email:"trusted@example.test",displayName:"Trusted"});
  assert.equal(batches.length,1);assert.equal(batches[0].length,project.resources.length+2);
  assert.ok(JSON.stringify(batches).includes("trusted"));assert.ok(JSON.stringify(batches).includes("example.instantiate"));
});
test("each native pack resolves a catalog project and has explicit offline/live evidence",()=>{
  for(const pack of frameworkPacks) {
    assert.ok(getExample(pack.projectId),`Missing project for ${pack.id}`);assert.ok(pack.files[pack.entrypoint]);assert.ok(pack.files["README.md"]);
    assert.equal(pack.verification.live,false);
    for(const filename of Object.keys(pack.files))assert.ok(!filename.includes("..")&&!filename.includes("node_modules")&&!/^\.env$/.test(filename));
  }
});

test("Agent default and supporting views partition every source without dropping nested Agents",()=>{
  const paged=(view:string)=>Array.from({length:Math.ceil(workflowDesigns.length/48)},(_,i)=>listExamples(new URLSearchParams({view,page:String(i+1),pageSize:"48"})).items).flat();
  const agents=paged("catalog"),supporting=paged("supporting");
  assert.equal(agents.length,agentDesigns.length);assert.equal(supporting.length,supportingDesigns.length);
  assert.ok(agents.every(item=>item.hasAgent&&item.classification==="agent"));
  assert.ok(supporting.every(item=>!item.hasAgent&&item.classification==="supporting"));
  assert.equal(new Set([...agents,...supporting].map(item=>item.id)).size,workflowDesigns.length);
  const nested=workflowDesigns.find(design=>!design.definition.nodes.some(node=>node.type==="agent")&&hasExplicitAgent(design.definition));assert.ok(nested);assert.ok(agents.some(item=>item.id===nested.id));
  for(const item of supporting) {const project=getExample(item.id)!;assert.equal(project.hasAgent,false);assert.equal(project.classification,"supporting");}
});
