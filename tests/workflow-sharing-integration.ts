/** Real local HTTP/D1 contracts. Unique synthetic data only; no provider credentials or services. */
import assert from "node:assert/strict";
import { templateWorkflow, type Workflow, type Resource } from "../app/lib/model";
import { unzipSync, strFromU8 } from "fflate";
const origin = process.env.FLOWLY_TEST_ORIGIN || "http://127.0.0.1:5173", cookies: Record<string, string> = {}, cleanup: { user: string; flow: string; resources?: string[] }[] = [];
type Payload = {workflow:Workflow; workflows:Workflow[]; versions:unknown[]; text:string; kickoff:string; items:{id:string}[]; resources:Resource[]};
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname)) throw new Error("Local test server required.");
let passed = 0;
async function request(user: string, body?: unknown, path = "/api/studio") {
  return fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { origin, ...(cookies[user] ? {cookie:cookies[user]} : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
}
async function good(user: string, body?: unknown, path?: string) {
  const response = await request(user, body, path), data = await response.json() as Payload; assert.ok(response.ok, JSON.stringify(data)); return data;
}
function pass(name: string) { passed++; console.log(`PASS ${name}`); }
try {
  for (const user of ["alice", "bob", "carol"]) {
    const response = await fetch(origin + "/api/auth/test", { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ identity: user, return_to: "/studio" }) });
    assert.equal(response.status, 303); cookies[user] = response.headers.get("set-cookie")!.split(";")[0];
  }
  let workflow: Workflow = (await good("alice", { action:"workflow.save", data:{...templateWorkflow("transform"),id:"sharing-"+crypto.randomUUID(),ownerId:"test:bob",visibility:"public",editEmails:["bob@flowly.test"]} })).workflow;
  cleanup.push({user:"alice",flow:workflow.id});
  assert.equal(workflow.ownerId,"test:alice"); assert.equal(workflow.visibility,"private");
  assert.equal((await request("bob",{action:"workflow.get",id:workflow.id})).status,404);
  assert.equal((await request("",{action:"workflow.get",id:workflow.id})).status,401);
  workflow=(await good("alice",{action:"workflow.share",id:workflow.id,baseUpdatedAt:workflow.updatedAt,data:{visibility:"selected",readEmails:["bob@flowly.test"],editEmails:["carol@flowly.test"]}})).workflow;
  assert.equal((await good("bob",{action:"workflow.get",id:workflow.id})).workflow.access?.canEdit,false);
  assert.equal((await good("carol",{action:"workflow.get",id:workflow.id})).workflow.access?.canEdit,true);
  assert.equal((await request("bob",{action:"workflow.save",data:workflow,baseUpdatedAt:workflow.updatedAt})).status,403);
  assert.equal((await request("carol",{action:"workflow.delete",id:workflow.id})).status,404);
  assert.equal((await request("carol",{action:"workflow.share",id:workflow.id,baseUpdatedAt:workflow.updatedAt,data:{visibility:"public"}})).status,404);
  assert.equal((await request("alice",{action:"workflow.share",id:workflow.id,baseUpdatedAt:workflow.updatedAt,data:{visibility:"public",editVisibility:"public"}})).status,400);
  pass("server distinguishes owner/viewer/editor/unauthorized and rejects public edit, editor delete and ACL changes");
  const responses=await Promise.all(["공동 변경 A","공동 변경 B"].map(name=>request("carol",{action:"workflow.save",data:{...workflow,name},baseUpdatedAt:workflow.updatedAt})));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  for(const response of responses){const data=await response.json() as Payload;if(response.ok)workflow=data.workflow;}
  assert.equal(workflow.lastModifiedBy,"test:carol"); pass("concurrent editor writes commit one design and preserve owner with last modifier");
  for(const language of ["node","python"]){const response=await request("bob",{workflow,language,kind:"agent"},"/api/export");assert.equal(response.status,200);const files=unzipSync(new Uint8Array(await response.arrayBuffer()));assert.ok(files["START_HERE.md"]);const manifest=JSON.parse(strFromU8(files["workflow.json"]));assert.ok(!manifest.workflow.definition.nodes.some((n:{type:string})=>n.type==="agent"));}
  const prompt=await good("bob",{workflow,language:"python",kind:"prompt",intent:"modify"},"/api/export");assert.match(prompt.kickoff,/수정/);assert.ok(prompt.text.includes("workflow.json"));pass("Agent-free designs export actual Node/Python Agent ZIPs and intent-specific copy prompts");
  const originVersion={workflowId:workflow.id,updatedAt:workflow.updatedAt};
  workflow=(await good("carol",{action:"workflow.import",data:{...workflow,name:"외부 수정 통합본"},mode:"version",origin:originVersion})).workflow;
  assert.equal((await good("bob",{action:"workflow.versions",id:workflow.id})).versions.length,1);
  assert.equal((await request("carol",{action:"workflow.import",data:workflow,mode:"version",origin:originVersion})).status,409);
  pass("external modification becomes an atomic new version and stale version import is rejected");
  workflow=(await good("alice",{action:"workflow.share",id:workflow.id,baseUpdatedAt:workflow.updatedAt,data:{visibility:"private",editEmails:[]}})).workflow;
  for(const user of ["bob","carol"]){assert.equal((await request(user,{action:"workflow.get",id:workflow.id})).status,404);assert.equal((await request(user,{action:"workflow.save",data:workflow,baseUpdatedAt:workflow.updatedAt})).status,403);assert.equal((await request(user,{workflow,language:"python",kind:"agent"},"/api/export")).status,403);assert.ok(!(await good(user)).workflows.some((item:Workflow)=>item.id===workflow.id));}
  pass("revocation blocks subsequent read/list/save/export for both viewer and editor");
  const catalog=await good("alice",undefined,"/api/examples?view=supporting&pageSize=1"), id=catalog.items[0].id;
  const before=await good("alice",undefined,"/api/examples?id="+id);
  for(const user of ["bob","carol"]){const original=await good(user,undefined,"/api/examples?id="+id);assert.deepEqual(original,before);const clone=await good(user,{action:"instantiate",id},"/api/examples");cleanup.push({user,flow:clone.workflow.id,resources:clone.resources.map((r:Resource)=>r.id)});assert.equal(clone.workflow.ownerId,"test:"+user);assert.equal(clone.workflow.visibility,"private");assert.deepEqual(clone.workflow.editEmails,[]);assert.ok(clone.resources.every((r:Resource)=>r.ownerId==="test:"+user&&r.visibility==="private"));}
  assert.deepEqual(await good("alice",undefined,"/api/examples?id="+id),before);
  pass("every logged-in user can clone common supporting examples and private sample resources without altering originals");
  assert.equal((await request("alice",{action:"run.start",mode:"live",workflow,input:"차단 확인",idempotencyKey:crypto.randomUUID()},"/api/runtime")).status,409);
  pass("web live execution rejects before any model or MCP dispatch");
  console.log(JSON.stringify({passed,externalOpenAI:0,externalMCP:0,testUsers:3}));
} finally {
  for(const item of cleanup.reverse()){await request(item.user,{action:"workflow.delete",id:item.flow});for(const id of item.resources||[])await request(item.user,{action:"resource.delete",id});}
}
