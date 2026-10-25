/** Local HTTP, ZIP and shipped CLI checks. Never supplies model/service credentials. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { templateWorkflow } from "../app/lib/model";

const origin="http://127.0.0.1:5173",cookies:Record<string,string>={};
const directory=await mkdtemp(join(tmpdir(),"flowly-export-check-"));
let resourceId:string|undefined;
async function post(path:string,user:string|undefined,body:unknown,requestOrigin=origin) {
  return fetch(origin+path,{method:"POST",headers:{origin:requestOrigin,"content-type":"application/json",...(user?{cookie:cookies[user]}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
}
try {
  for(const user of ["alice","bob","carol"]) {
    const response=await fetch(origin+"/api/auth/test",{method:"POST",redirect:"manual",headers:{origin,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({identity:user,return_to:"/studio"})});
    assert.equal(response.status,303);cookies[user]=response.headers.get("set-cookie")!.split(";")[0];
  }
  const workflow=templateWorkflow("docs-agent");
  assert.equal((await post("/api/export",undefined,{workflow})).status,401);
  assert.equal((await post("/api/export","alice",{workflow},"https://attacker.example")).status,403);
  assert.equal((await post("/api/export","alice",{workflow,language:"shell"})).status,400);
  assert.equal((await post("/api/export","alice",{workflow:templateWorkflow("agent")})).status,409);
  console.log("PASS export route authenticates, checks Origin and rejects unsupported/test-only exports");
  for(const language of ["node","python"] as const) {
    const response=await post("/api/export","alice",{workflow:{...workflow,ownerId:"forged-user"},language});
    assert.equal(response.status,200);assert.equal(response.headers.get("content-type"),"application/zip");
    const files=unzipSync(new Uint8Array(await response.arrayBuffer()));
    const manifest=JSON.parse(strFromU8(files["workflow.json"]));
    assert.equal(manifest.owner.userId,"test:alice");assert.equal(manifest.language,language);
    assert.deepEqual(manifest.connections.map((c:{id:string})=>c.id),["openai-docs"]);
    assert.deepEqual(manifest.resources.map((r:{id:string})=>r.id),["sample-openai-docs"]);
    assert.match(strFromU8(files[".env.example"]),/OPENAI_API_KEY=\n/);
    const runner=language==="node"?"runner.mjs":"runner.py";
    assert.ok(files[runner]);assert.ok(!files[language==="node"?"runner.py":"runner.mjs"]);
    for(const name of [runner,"workflow.json"])await writeFile(join(directory,name),files[name]);
    const command=language==="node"?process.execPath:"python";
    const commandPrefix=language==="python"?["-X","utf8"]:[];
    const help=spawnSync(command,[...commandPrefix,runner,"--help"],{cwd:directory,encoding:"utf8",windowsHide:true,timeout:10000});
    assert.equal(help.status,0,help.stderr);
    const missing=spawnSync(command,[...commandPrefix,runner,"run","--input","병렬 도구 호출은 어떻게 설정하나요?"],{cwd:directory,encoding:"utf8",windowsHide:true,timeout:10000});
    assert.equal(missing.status,1);assert.match(missing.stderr,/미설정/);
    console.log(`PASS ${language} HTTP ZIP contains actual runnable source; missing local credentials stop before execution`);
  }
  const data={name:"내보내기 권한 검사",type:"document",description:"합성 검사 자료",content:"공유 내보내기 검사",url:"",visibility:"selected",allowedEmails:["bob@flowly.test"]};
  const created=await post("/api/studio","alice",{action:"resource.create",data});assert.equal(created.status,201);
  const createdResource=((await created.json()) as {resource:{id:string;updatedAt:string}}).resource;resourceId=createdResource.id;
  const shared=templateWorkflow("rag");shared.definition.nodes.find(n=>n.type==="retrieval")!.retrieval!.resourceIds=[resourceId];
  assert.equal((await post("/api/export","bob",{workflow:shared})).status,200);
  assert.equal((await post("/api/export","carol",{workflow:shared})).status,403);
  const update=await post("/api/studio","alice",{action:"resource.update",id:resourceId,baseUpdatedAt:createdResource.updatedAt,data:{...data,visibility:"private",allowedEmails:[]}});assert.equal(update.status,200);
  assert.equal((await post("/api/export","bob",{workflow:shared})).status,403);
  console.log("PASS three-user retrieval export permissions and revocation are rechecked through real HTTP/D1");
  console.log("OpenAI model calls: 0. External MCP calls: 0. No credentials supplied or copied.");
} finally {
  if(resourceId)await post("/api/studio","alice",{action:"resource.delete",id:resourceId});
  if(!resolve(directory).startsWith(resolve(tmpdir())+"\\flowly-export-check-")&&!resolve(directory).startsWith(resolve(tmpdir())+"/flowly-export-check-"))throw new Error("Unexpected temporary directory");
  await rm(directory,{recursive:true,force:true});
}
