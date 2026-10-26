/** 실제 로컬 Workers/D1 HTTP 경계와 내려받은 Agent ZIP을 검사한다. 테스트 계정·독립 DB만 사용한다. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import type { Resource, Workflow } from "../app/lib/model";
import type { ResourceAttachment, ResourceVersion } from "../domain/resource-contract";
import { extractExportEntries } from "./export-zip";

const origin=process.env.FLOWLY_TEST_ORIGIN||"http://127.0.0.1:5190";
if(!["127.0.0.1","localhost"].includes(new URL(origin).hostname))throw new Error("로컬 테스트 서버만 사용하세요.");
const cookies:Record<string,string>={},prefix="resource-http-"+crypto.randomUUID(),cleanup:{user:string;id:string}[]=[];
let passed=0;
const pass=(name:string)=>{passed++;console.log("PASS "+name);};
async function request(user:string,path:string,body?:unknown){return fetch(origin+path,{method:body===undefined?"GET":"POST",headers:{origin,cookie:cookies[user]??"",...(body===undefined?{}:{"content-type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});}
async function action<T>(user:string,action:string,body:Record<string,unknown>={}):Promise<T>{const response=await request(user,"/api/studio",{action,...body}),data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data as T;}
async function upload(user:string,path:string,content:string){const response=await fetch(origin+"/api/resource-files?path="+encodeURIComponent(path)+"&mimeType=text%2Fplain",{method:"POST",headers:{origin,cookie:cookies[user]},body:content});const data=await response.json() as {file:ResourceAttachment};assert.equal(response.status,201,JSON.stringify(data));return data.file;}
try{
 for(const user of ["alice","bob","carol"]){const response=await fetch(origin+"/api/auth/test",{method:"POST",redirect:"manual",headers:{origin,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({identity:user,return_to:"/studio"})});assert.equal(response.status,303);cookies[user]=response.headers.get("set-cookie")!.split(";")[0];}
 assert.equal((await request("","/api/resource-files")).status,401);
 const storage=(await (await request("alice","/api/resource-files")).json()) as {storage:{kind:string;configured:boolean}};assert.equal(storage.storage.configured,true);if(process.env.FLOWLY_EXPECT_FILE_STORE)assert.equal(storage.storage.kind,process.env.FLOWLY_EXPECT_FILE_STORE);
 const file=await upload("alice","references/한글.txt","보존할 원본\n");
 assert.equal((await request("bob","/api/resource-files?id="+file.id)).status,403);
 let resource=(await action<{resource:Resource}>("alice","resource.create",{data:{name:prefix,type:"document",description:"HTTP 계약",content:"전달할 한국어 본문",url:"",visibility:"selected",allowedEmails:["bob@flowly.test"],files:[file],details:{version:1,document:{originalFileId:file.id,extractionStatus:"not_requested"}}}})).resource;
 cleanup.push({user:"alice",id:resource.id});
 assert.equal(await (await request("bob","/api/resource-files?id="+file.id)).text(),"보존할 원본\n");
 assert.equal((await request("carol","/api/resource-files?id="+file.id)).status,403);
 assert.equal((await request("bob","/api/studio",{action:"resource.update",id:resource.id,baseUpdatedAt:resource.updatedAt,data:resource})).status,404);
 assert.equal((await request("bob","/api/studio",{action:"resource.versions",id:resource.id})).status,404);
 assert.equal((await request("bob","/api/studio",{action:"resource.delete",id:resource.id})).status,404);
 const stale=await request("bob","/api/studio",{action:"resource.import",sourceResourceId:resource.id,baseUpdatedAt:"stale",mode:"copy",data:resource});assert.equal(stale.status,409);const staleBody=await stale.json() as {current:Resource};assert.deepEqual(staleBody.current.allowedEmails,[]);
 pass("첨부와 본문의 소유자/조회자/권한 없음 및 이전버전 접근 구분");
 const copy=(await action<{resource:Resource}>("bob","resource.import",{sourceResourceId:resource.id,baseUpdatedAt:resource.updatedAt,mode:"copy",data:resource})).resource;cleanup.push({user:"bob",id:copy.id});
 assert.equal(copy.visibility,"private");assert.equal(copy.ownerId,"test:bob");assert.notEqual(copy.files![0].id,file.id);assert.equal(copy.details?.document?.originalFileId,copy.files![0].id);
 pass("공유 자료를 파일 참조까지 보존한 개인 사본으로 복제");
 const workflow:Workflow={id:prefix,name:"자료 실제 내보내기",description:"API가 생성한 ZIP",updatedAt:new Date().toISOString(),definition:{schemaVersion:5,nodes:[{id:"input",type:"input",title:"입력",x:0,y:0},{id:"material",type:"resource",title:"본문",resourceId:resource.id,x:200,y:0},{id:"output",type:"output",title:"결과",x:400,y:0}],edges:[{id:"a",source:"input",target:"material"},{id:"b",source:"material",target:"output"}]}};
 const env:NodeJS.ProcessEnv={...Object.fromEntries(["PATH","Path","SystemRoot","WINDIR","TEMP","TMP","PATHEXT"].flatMap(key=>process.env[key]?[[key,process.env[key]!]]:[])),NODE_ENV:"test"};
 for(const language of ["node","python"] as const){const response=await request("bob","/api/export",{workflow,language,kind:"agent"});assert.equal(response.status,200,await (response.ok?Promise.resolve(""):response.text()));const entries=unzipSync(new Uint8Array(await response.arrayBuffer())),manifest=JSON.parse(strFromU8(entries["workflow.json"]));assert.equal(strFromU8(entries[manifest.resources[0].files[0].exportPath]),"보존할 원본\n");const folder=resolve("outputs",prefix,language);await mkdir(folder,{recursive:true});await extractExportEntries(folder,entries);const result=spawnSync(language==="node"?process.execPath:(process.platform==="win32"?"python":"python3"),[...(language==="python"?["-X","utf8"]:[]),language==="node"?"agent.mjs":"agent.py","run","--input","원문"],{cwd:folder,env,encoding:"utf8",timeout:60000,windowsHide:true});assert.equal(result.status,0,result.stderr||result.stdout);const run=JSON.parse(result.stdout);assert.equal(run.status,"succeeded");assert.equal(run.result,`원문

[${resource.name}]
전달할 한국어 본문`);}
 pass("HTTP에서 받은 Agent 없는 Node/Python ZIP에 실제 첨부 포함 및 CLI 실행");
 const outcomes=await Promise.all(["동시 A","동시 B"].map(name=>request("alice","/api/studio",{action:"resource.update",id:resource.id,baseUpdatedAt:resource.updatedAt,data:{name}})));assert.deepEqual(outcomes.map(item=>item.status).sort(),[200,409]);for(const response of outcomes){const body=await response.json() as {resource?:Resource};if(response.ok)resource=body.resource!;}
 const versions=(await action<{versions:ResourceVersion[]}>("alice","resource.versions",{id:resource.id})).versions;assert.equal(versions.length,2);
 resource=(await action<{resource:Resource}>("alice","resource.update",{id:resource.id,baseUpdatedAt:resource.updatedAt,data:{visibility:"private",allowedEmails:[]}})).resource;
 resource=(await action<{resource:Resource}>("alice","resource.restore",{id:resource.id,versionId:versions.at(-1)!.id,baseUpdatedAt:resource.updatedAt})).resource;assert.equal(resource.visibility,"private");
 assert.equal((await request("bob","/api/resource-files?id="+file.id)).status,403);
 assert.equal((await request("bob","/api/export",{workflow,language:"node",kind:"agent"})).status,403);
 assert.equal(await (await request("bob","/api/resource-files?id="+copy.files![0].id)).text(),"보존할 원본\n");
 pass("동시 수정 충돌·복구 시 현재 공유 유지·철회 후 파일/내보내기 차단·이미 만든 개인 사본 보존");
 assert.equal((await request("alice","/api/runtime",{action:"run.start",mode:"live",workflow,input:"사용 금지",idempotencyKey:crypto.randomUUID()})).status,409);
 pass("웹 실제 모델/MCP 실행 경로 차단");
 const report={passed,fileStore:storage.storage.kind,externalOpenAI:0,externalMCP:0,actualExportLanguages:["node","python"],testUsers:3};await writeFile(resolve("outputs/resource-http-verification-"+storage.storage.kind+".json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{for(const item of cleanup.reverse())await request(item.user,"/api/studio",{action:"resource.delete",id:item.id});}
