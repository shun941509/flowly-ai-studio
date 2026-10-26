import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ResourceHistoryRepository } from "../server/repositories/resource-history";
import { D1TestResourceFileStore, ResourceFilesRepository, resourceFileHash } from "../server/resource-files";
import { HistoryError } from "../server/repositories/errors";
import { buildExportPackage } from "../server/export-package";
import { RESOURCE_CONTENT_MAX_CHARS, RESOURCE_FILE_MAX_BYTES } from "../domain/resource-contract";
import { parseResource, type Identity, type Resource, type Workflow } from "../app/lib/model";

const alice:Identity={userId:"alice",email:"alice@example.test",displayName:"소유자"};
const bob:Identity={userId:"bob",email:"bob@example.test",displayName:"읽는 사용자"};
const carol:Identity={userId:"carol",email:"carol@example.test",displayName:"권한 없는 사용자"};
const input={name:"문서",type:"document",description:"공유 자료",content:"원본 한국어 본문",url:"",visibility:"selected",allowedEmails:[bob.email]};
const status=(value:number)=>(error:unknown)=>error instanceof HistoryError&&error.status===value;
const digest=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function setup(legacy=false){
 const sqlite=new DatabaseSync(":memory:");
 sqlite.exec(readFileSync(new URL("../drizzle/0000_flat_robbie_robertson.sql",import.meta.url),"utf8"));
 if(legacy)sqlite.prepare("INSERT INTO resources VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("legacy",alice.userId,"이전 자료","document","","유지할 본문","","private","[]","2026-10-20T00:00:00.000Z","2026-10-20T00:00:00.000Z");
 for(const file of ["0002_workflow_history.sql","0003_workflow_sharing.sql","0004_resource_packages.sql"])sqlite.exec(readFileSync(new URL("../drizzle/"+file,import.meta.url),"utf8"));
 type Statement={sync():{meta:{changes:number}}};
 const db={prepare(sql:string){let args:(string|number|null)[]=[];const statement={bind(...values:(string|number|null)[]){args=values;return statement;},sync(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};},async run(){return statement.sync();},async first(){return sqlite.prepare(sql).get(...args)??null;},async all(){return {results:sqlite.prepare(sql).all(...args)};}};return statement;},async batch(statements:Statement[]){sqlite.exec("BEGIN IMMEDIATE");try{const result=statements.map(s=>s.sync());sqlite.exec("COMMIT");return result;}catch(error){sqlite.exec("ROLLBACK");throw error;}}} as unknown as D1Database;
 const store=new D1TestResourceFileStore(db);
 return {sqlite,db,store,resources:new ResourceHistoryRepository(db),files:new ResourceFilesRepository(db,store)};
}
function flow(resource:Resource):Workflow{return {id:"storage-flow",name:"자료 검사",description:"",updatedAt:resource.updatedAt,definition:{schemaVersion:5,nodes:[{id:"input",type:"input",title:"입력",x:0,y:0},{id:"resource",type:"resource",title:"자료",resourceId:resource.id,x:200,y:0},{id:"output",type:"output",title:"결과",x:400,y:0}],edges:[{id:"a",source:"input",target:"resource"},{id:"b",source:"resource",target:"output"}]}};}

test("resource migration retains existing private rows without inventing file setup or verified execution",async()=>{
 const {sqlite,db,resources}=setup(true);
 try{
  const old=await resources.get(alice,"legacy");assert.equal(old.content,"유지할 본문");assert.equal(old.visibility,"private");assert.equal(old.files,undefined);assert.equal(old.details,undefined);
  await assert.rejects(resources.get(bob,"legacy"),status(403));
  const missing=new ResourceFilesRepository(db);assert.deepEqual({configured:missing.status().configured,kind:missing.status().kind},{configured:false,kind:"unconfigured"});
  await assert.rejects(missing.upload(alice,"sample.txt","text/plain",new Uint8Array()),status(503));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM resource_files").get()!.count,0);
 }finally{sqlite.close();}
});

test("owner/viewer/stranger file access follows current attachments while owners can restore older files",async()=>{
 const {sqlite,resources,files}=setup();
 try{
  const bytes=new TextEncoder().encode("한글🙂\n".repeat(20000)),attachment=await files.upload(alice,"originals/한국어.txt","text/plain",bytes);
  assert.equal(attachment.size,bytes.byteLength);assert.equal(attachment.sha256,digest(bytes));
  assert.deepEqual((await files.read(alice,attachment.id)).bytes,bytes);
  await assert.rejects(files.read(bob,attachment.id),status(403));
  let source=await resources.create(alice,{...input,files:[attachment]});
  const first=(await resources.versions(alice,source.id))[0];
  assert.equal((await resources.get(bob,source.id)).id,source.id);assert.deepEqual((await files.read(bob,attachment.id)).bytes,bytes);
  await assert.rejects(resources.get(carol,source.id),status(403));await assert.rejects(files.read(carol,attachment.id),status(403));
  await assert.rejects(resources.update(bob,source.id,{content:"허용 안 됨"},source.updatedAt),status(404));
  await assert.rejects(resources.versions(bob,source.id),status(404));
  await assert.rejects(resources.create(bob,{...input,files:[attachment]}),status(403));
  const replacement=await files.upload(alice,"originals/new.txt","text/plain",new TextEncoder().encode("교체"));
  source=await resources.update(alice,source.id,{files:[replacement]},source.updatedAt);
  await assert.rejects(files.read(bob,attachment.id),status(403));assert.deepEqual((await files.read(alice,attachment.id)).bytes,bytes);
  source=await resources.update(alice,source.id,{visibility:"private",allowedEmails:[]},source.updatedAt);
  await assert.rejects(resources.restore(bob,source.id,first.id,source.updatedAt),status(404));
  const restored=await resources.restore(alice,source.id,first.id,source.updatedAt);
  assert.equal(restored.visibility,"private");assert.deepEqual(restored.allowedEmails,[]);assert.equal(restored.files![0].id,attachment.id);
  assert.ok(restored.updatedAt>source.updatedAt);assert.equal((await resources.versions(alice,source.id)).length,4);
  await assert.rejects(files.read(bob,attachment.id),status(403));assert.deepEqual((await files.read(alice,attachment.id)).bytes,bytes);
 }finally{sqlite.close();}
});

test("resource CAS commits one writer with one version/audit and rolls back failed attachment adoption",async()=>{
 const {sqlite,resources,files}=setup();
 try{
  const initial=await resources.create(alice,input);
  const writes=await Promise.allSettled([resources.update(alice,initial.id,{content:"첫 번째"},initial.updatedAt),resources.update(alice,initial.id,{content:"두 번째"},initial.updatedAt)]);
  assert.equal(writes.filter(r=>r.status==="fulfilled").length,1);assert.equal(writes.filter(r=>r.status==="rejected"&&status(409)(r.reason)).length,1);
  const current=await resources.get(alice,initial.id);assert.equal((await resources.versions(alice,current.id)).length,2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE target_id=?").get(current.id)!.n,2);
  const attachment=await files.upload(alice,"references/new.txt","text/plain",new TextEncoder().encode("new"));
  sqlite.exec("CREATE TRIGGER resource_failure BEFORE INSERT ON audit_events WHEN NEW.action='resource.update' BEGIN SELECT RAISE(ABORT,'test resource rollback'); END;");
  await assert.rejects(resources.update(alice,current.id,{content:"rollback",files:[attachment]},current.updatedAt),/test resource rollback/);
  const after=await resources.get(alice,current.id);assert.equal(after.updatedAt,current.updatedAt);assert.equal(after.content,current.content);
  assert.equal((await resources.versions(alice,current.id)).length,2);
  assert.equal(sqlite.prepare("SELECT resource_id FROM resource_files WHERE id=?").get(attachment.id)!.resource_id,null);
  await assert.rejects(resources.restore(alice,current.id,(await resources.versions(alice,current.id))[1].id,initial.updatedAt),status(409));
 }finally{sqlite.close();}
});

test("shared resource copy clones attachment identities and keeps both source and private copy independently authorized",async()=>{
 const {sqlite,resources,files}=setup();
 try{
  const bytes=new TextEncoder().encode("원본 첨부"),attachment=await files.upload(alice,"originals/file.txt","text/plain",bytes);
  let source=await resources.create(alice,{...input,files:[attachment],details:{version:1,document:{extractionStatus:"pending_local",originalFileId:attachment.id}}});
  await assert.rejects(resources.import(bob,source.id,source.updatedAt,"version",source),status(403));
  const copy=await resources.import(bob,source.id,source.updatedAt,"copy",{...source,name:"내 사본",visibility:"public",allowedEmails:[carol.email]});
  assert.notEqual(copy.id,source.id);assert.equal(copy.ownerId,bob.userId);assert.equal(copy.visibility,"private");assert.deepEqual(copy.allowedEmails,[]);
  assert.notEqual(copy.files![0].id,attachment.id);assert.equal(copy.details!.document!.originalFileId,copy.files![0].id);
  assert.equal((await resources.get(alice,source.id)).name,source.name);
  assert.deepEqual((await files.read(bob,copy.files![0].id)).bytes,bytes);
  await assert.rejects(files.read(carol,copy.files![0].id),status(403));
  source=await resources.update(alice,source.id,{visibility:"private",allowedEmails:[]},source.updatedAt);
  await assert.rejects(files.read(bob,attachment.id),status(403));await assert.rejects(resources.get(bob,source.id),status(403));
  await assert.rejects(resources.import(bob,source.id,source.updatedAt,"copy",source),status(403));
  await assert.rejects(files.resolve(bob,[{...source,visibility:"public"}]),status(403));
  await assert.rejects(buildExportPackage({user:bob,workflow:flow(source),connections:[],resolveResources:async(u,ids)=>Promise.all(ids.map(id=>resources.get(u,id))),resolveResourceFiles:(u,r)=>files.resolve(u,r),runnerSource:"// never executed"}),status(403));
  assert.deepEqual((await files.read(bob,copy.files![0].id)).bytes,bytes);
  assert.ok((await buildExportPackage({user:bob,workflow:flow(copy),connections:[],resolveResources:async(u,ids)=>Promise.all(ids.map(id=>resources.get(u,id))),resolveResourceFiles:(u,r)=>files.resolve(u,r),runnerSource:"// packaging only"})).length>0);
 }finally{sqlite.close();}
});

test("storage hashes exact Buffer slices and rejects changed metadata, corrupted payloads and missing chunks",async()=>{
 const {sqlite,resources,files}=setup();
 try{
  const bytes=Buffer.from("prefix한글후미suffix").subarray(6,18);
  assert.equal(await resourceFileHash(bytes),digest(bytes));
  const attachment=await files.upload(alice,"references/data.txt","text/plain",bytes);
  assert.equal(attachment.sha256,digest(bytes));
  for(const value of [{...attachment,sha256:"0".repeat(64)},{...attachment,size:attachment.size+1},{...attachment,path:"other.txt"}])await assert.rejects(resources.create(alice,{...input,files:[value]}),status(403));
  await resources.create(alice,{...input,files:[attachment]});
  assert.deepEqual(Buffer.from((await files.read(alice,attachment.id)).bytes),bytes);
  const row=sqlite.prepare("SELECT storage_key FROM resource_files WHERE id=?").get(attachment.id)!;
  sqlite.prepare("UPDATE resource_file_chunks SET data=? WHERE file_id=?").run(btoa("tampered"),row.storage_key);
  await assert.rejects(files.read(alice,attachment.id),status(409));
  sqlite.prepare("DELETE FROM resource_file_chunks WHERE file_id=?").run(row.storage_key);
  await assert.rejects(files.read(alice,attachment.id),status(404));
  const large=await files.upload(alice,"large.txt","text/plain",new Uint8Array(100000));
  const largeKey=sqlite.prepare("SELECT storage_key FROM resource_files WHERE id=?").get(large.id)!.storage_key;
  sqlite.prepare("DELETE FROM resource_file_chunks WHERE file_id=? AND part=1").run(largeKey);
  await assert.rejects(files.read(alice,large.id),/조각이 누락/);
 }finally{sqlite.close();}
});

test("resource and file size contracts count UTF-8 bytes and retain exact declared boundaries",async()=>{
 const {sqlite,resources,files}=setup();
 try{
  const text="한".repeat(RESOURCE_CONTENT_MAX_CHARS);
  const saved=await resources.create(alice,{...input,content:text});assert.equal(saved.content,text);
  await assert.rejects(resources.create(alice,{...input,content:text+"한"}),/200,?000/);
  const bytes=new Uint8Array(RESOURCE_FILE_MAX_BYTES).fill(65);
  const exact=await files.upload(alice,"max.txt","text/plain",bytes);assert.equal(exact.size,RESOURCE_FILE_MAX_BYTES);
  assert.equal((await files.read(alice,exact.id)).bytes.byteLength,RESOURCE_FILE_MAX_BYTES);
  await assert.rejects(files.upload(alice,"over.txt","text/plain",new Uint8Array(RESOURCE_FILE_MAX_BYTES+1)),status(413));
  const empty=await files.upload(alice,"empty.txt","text/plain",new Uint8Array());assert.equal((await files.read(alice,empty.id)).bytes.byteLength,0);
  for(const path of ["../outside",".env","C:/secret","scripts/../../escape","private.pem"])await assert.rejects(files.upload(alice,path,"text/plain",new Uint8Array()),/경로|키 파일/);
  const four=Array.from({length:4},(_,i)=>({...exact,id:"part"+i,path:"part"+i+".txt"}));
  assert.equal(parseResource({...input,files:four}).files!.length,4);
  assert.throws(()=>parseResource({...input,files:[...four,{...empty,id:"extra",path:"extra.txt",size:1}]}),/20MB/);
 }finally{sqlite.close();}
});

test("one staged file cannot be adopted by two resources during concurrent create",async()=>{
 const {sqlite,resources,files}=setup();
 try{
  const attachment=await files.upload(alice,"shared-staged.txt","text/plain",new TextEncoder().encode("one owner binding"));
  const results=await Promise.allSettled([resources.create(alice,{...input,name:"first",files:[attachment]}),resources.create(alice,{...input,name:"second",files:[attachment]})]);
  assert.equal(results.filter(result=>result.status==="fulfilled").length,1,"one immutable file ID must belong to exactly one resource");
  const winner=results.find(result=>result.status==="fulfilled");assert.ok(winner&&winner.status==="fulfilled");
  assert.equal(sqlite.prepare("SELECT resource_id FROM resource_files WHERE id=?").get(attachment.id)!.resource_id,winner.value.id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM resources").get()!.n,1);
 }finally{sqlite.close();}
});

test("restoring a legacy no-file/no-details version clears newer optional fields without restoring old ACL",async()=>{
 const {sqlite,resources,files}=setup();
 try{
  let source=await resources.create(alice,input);const first=(await resources.versions(alice,source.id))[0];
  const attachment=await files.upload(alice,"later.txt","text/plain",new TextEncoder().encode("later"));
  source=await resources.update(alice,source.id,{files:[attachment],details:{version:1,purpose:"나중 추가"},visibility:"private",allowedEmails:[]},source.updatedAt);
  const restored=await resources.restore(alice,source.id,first.id,source.updatedAt);
  assert.equal(restored.details,undefined);assert.equal(restored.files?.length??0,0);
  assert.equal(restored.visibility,"private");assert.deepEqual(restored.allowedEmails,[]);
 }finally{sqlite.close();}
});

