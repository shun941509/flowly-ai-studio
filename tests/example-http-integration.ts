import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { exampleSeeds } from "../domain/example-seeds";
import { workflowDesigns } from "../domain/workflow-designs";
import { hasExplicitAgent } from "../domain/example-publication";
import { catalogVerification } from "../server/generated/catalog-verification";

const agentDesigns=workflowDesigns.filter(design=>hasExplicitAgent(design.definition));
const supportingDesigns=workflowDesigns.filter(design=>!hasExplicitAgent(design.definition));
import { allNodes } from "../domain/advanced-config";
import { compileDefinition } from "../domain/workflow";
import { TEST_IDENTITIES } from "../server/auth/session";
import type { Resource, Workflow } from "../app/lib/model";
import type { ExportManifest } from "../server/export-package";
import type { RuntimeCapabilities } from "../runtime/types";
const origin="http://127.0.0.1:5173";
const created:{cookie:string;workflowId:string;resources:string[]}[]=[];
async function login(identity:string) {
  const r=await fetch(origin+"/api/auth/test",{method:"POST",redirect:"manual",headers:{origin,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({identity,return_to:"/studio"})});assert.equal(r.status,303);return r.headers.get("set-cookie")!.split(";")[0];
}
const post=(cookie:string,path:string,body:unknown,extra:Record<string,string>={})=>fetch(origin+path,{method:"POST",headers:{cookie,origin,"content-type":"application/json",...extra},body:JSON.stringify(body)});
try {
  const anonymous=await fetch(origin+"/api/examples",{headers:{"x-chatgpt-user-id":"alice"}});assert.equal(anonymous.status,401);
  const cookies=await Promise.all(["alice","bob","carol"].map(login));
  const list=await (await fetch(origin+"/api/examples?pageSize=48",{headers:{cookie:cookies[0]}})).json() as {stats:{projects:number;variants:number;target:number;verified:number;reviewed:number;remaining:number;topologies:number;supporting:number;sourceGraphs:number};items:{id:string;kind:string;hasAgent:boolean;classification:string}[]};
  assert.equal(list.stats.projects,agentDesigns.length);assert.ok(list.stats.projects>=24);assert.equal(list.stats.variants,11);assert.equal(list.stats.target,3200);assert.equal(list.items.length,Math.min(48,agentDesigns.length));
  assert.equal(list.stats.verified,agentDesigns.filter(design=>catalogVerification.includes(design.id)).length);assert.equal(list.stats.reviewed,0);assert.equal(list.stats.topologies,agentDesigns.length);assert.equal(list.stats.remaining,Math.max(0,3200-agentDesigns.length));assert.ok(!("cases" in list.stats));
  assert.ok(list.items.every(item=>item.kind==="workflow"&&item.hasAgent&&item.classification==="agent"));
  const publicIds=list.items.map(item=>item.id);
  for(let page=2;page<=Math.ceil(agentDesigns.length/48);page++) {
    const result=await (await fetch(origin+`/api/examples?pageSize=48&page=${page}`,{headers:{cookie:cookies[0]}})).json() as {items:{id:string}[]};
    publicIds.push(...result.items.map(item=>item.id));
  }
  assert.equal(new Set(publicIds).size,agentDesigns.length);
  assert.deepEqual(publicIds.sort(),agentDesigns.map(design=>design.id).sort());
  assert.equal(list.stats.supporting,supportingDesigns.length);assert.equal(list.stats.sourceGraphs,workflowDesigns.length);
  const supportingIds:string[]=[];
  for(let page=1;page<=Math.ceil(supportingDesigns.length/48);page++) {
    const response=await fetch(origin+`/api/examples?view=supporting&pageSize=48&page=${page}`,{headers:{cookie:cookies[0]}});assert.equal(response.status,200);
    const body=await response.json() as {items:{id:string;hasAgent:boolean;classification:string}[]};
    assert.ok(body.items.every(item=>!item.hasAgent&&item.classification==="supporting"));supportingIds.push(...body.items.map(item=>item.id));
  }
  assert.deepEqual(supportingIds.sort(),supportingDesigns.map(design=>design.id).sort());
  assert.equal(new Set([...publicIds,...supportingIds]).size,workflowDesigns.length);
  const cases=await fetch(origin+"/api/examples?view=cases&pageSize=48",{headers:{cookie:cookies[0]}});
  assert.equal(cases.status,410);
  const caseBody:unknown=await cases.json();assert.ok(caseBody&&typeof caseBody==="object"&&!Array.isArray(caseBody));assert.ok(!("items" in caseBody));
  assert.equal((await post(cookies[0],"/api/examples",{action:"instantiate",id:"policy-citations"},{origin:"https://untrusted.example"})).status,403);
  assert.equal((await post(cookies[0],"/api/examples",{action:"download",variantId:"../../.env"})).status,404);
  assert.equal((await post(cookies[0],"/api/examples",{action:"download-project",id:"policy-citations",language:"bash"})).status,400);
  for(const language of [["node"],["python"],{},null,0])assert.equal((await post(cookies[0],"/api/examples",{action:"download-project",id:"policy-citations",language})).status,400);
  assert.equal((await post(cookies[0],"/api/examples",{action:"download-project",id:"../.env",language:"node"})).status,404);
  assert.equal((await post(cookies[0],"/api/examples",{action:"download-project",id:"policy-citations",language:"node"},{origin:"https://untrusted.example"})).status,403);
  const designIds=new Set(workflowDesigns.map(design=>design.id));
  const archived=exampleSeeds.filter(seed=>!designIds.has(seed.id));
  assert.equal(archived.length,exampleSeeds.length-exampleSeeds.filter(seed=>designIds.has(seed.id)).length);
  for(const id of [archived[0].id,archived[Math.floor(archived.length/2)].id,archived.at(-1)!.id]) {
    const detail=await fetch(origin+"/api/examples?id="+id,{headers:{cookie:cookies[0]}});assert.equal(detail.status,404);
    const detailBody:unknown=await detail.json();assert.ok(detailBody&&typeof detailBody==="object"&&!Array.isArray(detailBody));assert.ok(!("project" in detailBody));
    assert.equal((await post(cookies[0],"/api/examples",{action:"instantiate",id})).status,404);
    for(const language of ["node","python"])assert.equal((await post(cookies[0],"/api/examples",{action:"download-project",id,language})).status,404);
  }
  for(const id of ["policy-citations","data-freshness"])for(const language of ["node","python"]) {
    const response=await post(cookies[0],"/api/examples",{action:"download-project",id,language,ownerId:"forged",workflow:{name:"forged"}});assert.equal(response.status,200);
    const files=unzipSync(new Uint8Array(await response.arrayBuffer()));assert.ok(files["input.txt"]&&files["EXAMPLE.md"]&&files["example-contract.json"]);assert.ok(!files[".env"]);
    const contract=JSON.parse(strFromU8(files["example-contract.json"])),manifest=JSON.parse(strFromU8(files["workflow.json"]));
    assert.equal(contract.id,id);assert.equal(contract.liveVerified,false);assert.notEqual(manifest.owner.userId,"forged");assert.equal(manifest.workflow.name,contract.title);assert.equal(manifest.connections.length,0);
  }
  for(const cookie of cookies) {
    const response=await post(cookie,"/api/examples",{action:"instantiate",id:"policy-citations",ownerId:"forged-owner"});assert.equal(response.status,201,await(response.status===201?Promise.resolve(""):response.text()));
    const copy=await response.json() as {workflow:{id:string;definition:unknown};resources:{id:string;ownerId:string;visibility:string;sample?:boolean}[]};
    created.push({cookie,workflowId:copy.workflow.id,resources:copy.resources.map(r=>r.id)});
    assert.equal(copy.resources.length,2);
    assert.ok(copy.resources.every(r=>r.ownerId!=="forged-owner"&&r.visibility==="private"&&!r.sample));
    for(const language of ["node","python"]) {
      const download=await post(cookie,"/api/export",{workflow:copy.workflow,language});assert.equal(download.status,200);
      const files=unzipSync(new Uint8Array(await download.arrayBuffer()));assert.ok(files[language==="node"?"runner.mjs":"runner.py"]);
      assert.ok(!files[".env"]);const manifest=JSON.parse(strFromU8(files["workflow.json"]));assert.deepEqual(manifest.resources.map((r:{id:string})=>r.id).sort(),copy.resources.map(r=>r.id).sort());
    }
  }
  for(let i=0;i<3;i++) {
    const workspace=await(await fetch(origin+"/api/studio",{headers:{cookie:cookies[i]}})).json() as {resources:{id:string}[];workflows:{id:string}[]};
    for(let j=0;j<3;j++){for(const id of created[j].resources)assert.equal(workspace.resources.some(r=>r.id===id),i===j);assert.equal(workspace.workflows.some(w=>w.id===created[j].workflowId),i===j);}
  }
  // Six executable representatives must be present, not a shortened dynamic subset.
  const showcaseIds=["showcase-parallel-proposal","showcase-rag-evidence","showcase-agent-harness","showcase-request-orchestration","showcase-multi-agent-editorial","showcase-approved-publishing"];
  assert.equal(showcaseIds.length,6);
  const showcaseProjects=showcaseIds.map(id=>{const project=workflowDesigns.find(design=>design.id===id);assert.ok(project,`Missing representative ${id}`);return project;});
  for(const project of showcaseProjects)for(const language of ["node","python"] as const) {
    const response=await post(cookies[0],"/api/examples",{action:"download-project",id:project.id,language,ownerId:"forged",connections:[{id:"forged",endpoint:"https://untrusted.example/mcp"}]});
    assert.equal(response.status,200,`${project.id}/${language}: ${response.status===200?"":await response.text()}`);
    const files=unzipSync(new Uint8Array(await response.arrayBuffer()));
    assert.ok(files[language==="node"?"runner.mjs":"runner.py"]);
    assert.ok(!files[".env"]&&!Object.keys(files).some(path=>/scenario|preload|boundary/.test(path)),"Test adapters and credentials must not be downloaded");
    const manifest=JSON.parse(strFromU8(files["workflow.json"])) as ExportManifest;
    const contract=JSON.parse(strFromU8(files["example-contract.json"]));
    assert.equal(contract.id,project.id);assert.equal(contract.liveVerified,false);
    assert.equal(manifest.owner.userId,TEST_IDENTITIES.alice.userId);assert.equal(manifest.language,language);
    assert.deepEqual(manifest.workflow.definition,compileDefinition(project.definition),"The ZIP must carry the actual independently authored graph");
    assert.deepEqual(manifest.resources.map(resource=>resource.id).sort(),project.resources.map(resource=>resource.id).sort());
    const selected=allNodes(manifest.workflow.definition).flatMap(node=>node.allowedTools??[]);
    assert.equal(manifest.connections.length,new Set(selected.map(tool=>tool.connectionId)).size);
    const settings=strFromU8(files[".env.example"]);
    assert.match(settings,/^OPENAI_API_KEY=\s*$/m);
    for(const connection of manifest.connections) {
      assert.equal(connection.ownerId,TEST_IDENTITIES.alice.userId);
      assert.ok(connection.endpoint.startsWith("https://example.com/flowly-unconfigured/"));
      assert.match(connection.endpointEnv??"",/^FLOWLY_MCP_ENDPOINT_[A-Z0-9_]+$/);
      assert.match(connection.tokenEnv??"",/^FLOWLY_MCP_TOKEN_[A-Z0-9_]+$/);
      assert.ok(settings.split(/\r?\n/).includes(`${connection.endpointEnv}=`));
      assert.ok(settings.split(/\r?\n/).includes(`${connection.tokenEnv}=`));
      assert.ok(connection.tools.every(tool=>selected.some(chosen=>chosen.resourceId===tool.resourceId&&chosen.connectionId===tool.connectionId&&chosen.toolName===tool.toolName)));
    }
  }
  const shippingSource=showcaseProjects.find(project=>project.id==="showcase-request-orchestration")!;
  const shippingResponse=await post(cookies[0],"/api/examples",{action:"instantiate",id:shippingSource.id,ownerId:"forged-owner"});
  assert.equal(shippingResponse.status,201);
  const shippingCopy=await shippingResponse.json() as {workflow:Workflow;resources:Resource[]};
  created.push({cookie:cookies[0],workflowId:shippingCopy.workflow.id,resources:shippingCopy.resources.map(resource=>resource.id)});
  assert.notEqual(shippingCopy.workflow.id,shippingSource.id);
  assert.equal(shippingCopy.resources.length,2);
  assert.ok(shippingCopy.resources.every(resource=>resource.ownerId===TEST_IDENTITIES.alice.userId&&resource.visibility==="private"&&!resource.sample&&!shippingSource.resources.some(original=>original.id===resource.id)));
  const copiedMcp=shippingCopy.resources.find(resource=>resource.type==="mcp")!;assert.ok(copiedMcp);
  const copySelections=allNodes(shippingCopy.workflow.definition).flatMap(node=>node.allowedTools??[]);
  assert.ok(copySelections.length>0&&copySelections.every(tool=>tool.resourceId===copiedMcp.id&&tool.connectionId==="showcase-shipping"&&tool.toolName==="lookup_shipment"));
  for(const language of ["node","python"] as const) {
    const response=await post(cookies[0],"/api/export",{workflow:shippingCopy.workflow,language,ownerId:TEST_IDENTITIES.bob.userId});
    assert.equal(response.status,200,`Private MCP copy export ${language}: ${response.status===200?"":await response.text()}`);
    const files=unzipSync(new Uint8Array(await response.arrayBuffer()));
    const manifest=JSON.parse(strFromU8(files["workflow.json"])) as ExportManifest;
    assert.ok(files[language==="node"?"runner.mjs":"runner.py"]&&!files[".env"]);
    assert.equal(manifest.owner.userId,TEST_IDENTITIES.alice.userId);
    assert.equal(manifest.workflow.id,shippingCopy.workflow.id);
    assert.deepEqual(manifest.resources.map(resource=>resource.id).sort(),shippingCopy.resources.map(resource=>resource.id).sort());
    assert.equal(manifest.connections.length,1);
    const connection=manifest.connections[0];
    assert.equal(connection.ownerId,TEST_IDENTITIES.alice.userId);assert.equal(connection.resourceId,copiedMcp.id);
    assert.equal(connection.endpointEnv,"FLOWLY_MCP_ENDPOINT_SHIPPING");assert.equal(connection.tokenEnv,"FLOWLY_MCP_TOKEN_SHIPPING");
    assert.equal(connection.tools.length,1);assert.equal(connection.tools[0].effect,"read");assert.equal(connection.tools[0].resourceId,copiedMcp.id);
    assert.deepEqual(connection.tools[0].inputSchema.required,["orderId"]);
    assert.ok(manifest.resources.every(resource=>!("allowedEmails" in resource)));
  }
  for(const [index,cookie]of cookies.entries()) {
    const response=await fetch(origin+"/api/runtime",{headers:{cookie}});assert.equal(response.status,200);
    const {capabilities}=await response.json() as {capabilities:RuntimeCapabilities};
    assert.equal(capabilities.liveEnabled,false);assert.ok(capabilities.liveReason.includes("웹에서는 OpenAI를 호출하지"));
    const connection=capabilities.connections.find(candidate=>candidate.resourceId===copiedMcp.id);
    if(index===0) {assert.ok(connection);assert.equal(connection.id,"showcase-shipping");assert.equal(connection.status,"unconfigured");assert.equal(connection.tools[0].resourceId,copiedMcp.id);}
    else assert.equal(connection,undefined,"Other users must not see the private MCP definition");
  }
  for(const cookie of cookies.slice(1))for(const language of ["node","python"]) {
    const response=await post(cookie,"/api/export",{workflow:shippingCopy.workflow,language,ownerId:TEST_IDENTITIES.alice.userId});assert.equal(response.status,403);
  }
  for(const project of showcaseProjects) {
    const response=await post(cookies[0],"/api/runtime",{action:"run.start",mode:"live",workflow:{id:project.id,name:project.title,definition:project.definition},input:project.inputExample,idempotencyKey:`http-${project.id}`});
    assert.equal(response.status,409);
    const rejected=await response.json() as {error:string;run?:unknown};assert.ok(rejected.error.includes("웹에서는 OpenAI를 호출하지"));assert.equal(rejected.run,undefined);
  }
  const variants:{id:string}[]=[];
  for(const item of workflowDesigns) {
    const detail=await(await fetch(origin+"/api/examples?id="+item.id,{headers:{cookie:cookies[0]}})).json() as {project:{variants:{id:string}[]}};
    if(item.id==="shipment-lookup")assert.equal(detail.project.variants.length,2);
    variants.push(...detail.project.variants);
  }
  assert.equal(variants.length,11);
  for(const variant of variants) {
    const response=await post(cookies[0],"/api/examples",{action:"download",variantId:variant.id});assert.equal(response.status,200);
    const files=unzipSync(new Uint8Array(await response.arrayBuffer()));assert.ok(files["README.md"]);assert.ok(files[".env.example"]);assert.ok(!files[".env"]);
    assert.ok(Object.keys(files).every(path=>!path.includes("node_modules")&&!path.includes(".sites-runtime")&&!path.includes("..")));
  }
  const live=await post(cookies[0],"/api/runtime",{action:"run.start",mode:"live"});assert.equal(live.status,409);
  console.log(`PASS 24 groups: original 18 groups (auth/header spoof, ${workflowDesigns.length} graph/topology counts and all pages, retired case list 410, archived case lookup/clone/two-language export 404, CSRF, path/language rejection, 4 real graph ZIPs, three-owner/two-resource clones, 6 Flowly ZIPs, isolation, all 11 native/platform ZIPs, web live denied); 6 representative groups (all 6 projects/12 exact-graph ZIPs with blank credentials, private MCP clone remapping, both owner-scoped MCP clone ZIPs, unconfigured capabilities and connection isolation, cross-owner export denied, all 6 complete live requests rejected). External model/MCP calls: 0.`);
} finally {
  for(const item of created) {
    const response=await post(item.cookie,"/api/studio",{action:"workflow.delete",id:item.workflowId});assert.equal(response.status,200);
    for(const id of item.resources){const removed=await post(item.cookie,"/api/studio",{action:"resource.delete",id});assert.equal(removed.status,200);}
  }
}
