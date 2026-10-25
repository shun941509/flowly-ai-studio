import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeRepository } from "../server/repositories/runtime";
import { createRun } from "../runtime/engine";
import { sampleResources, templateWorkflow } from "../app/lib/model";
function d1(sqlite:DatabaseSync):D1Database {
  return {prepare(sql:string) {
    let args:(string|number|null)[]=[];
    const statement={bind(...values:(string|number|null)[]){args=values;return statement;},async run(){const result=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(result.changes)}};},async first(){return sqlite.prepare(sql).get(...args)??null;},async all(){return {results:sqlite.prepare(sql).all(...args)};}};
    return statement;
  }} as unknown as D1Database;
}
test("durable run repository isolates owners, deduplicates requests and fences stale workers",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"flowly-repository-")),path=join(dir,"test.sqlite");let sqlite=new DatabaseSync(path);
  try {
    sqlite.exec(readFileSync(new URL("../drizzle/0001_fearless_fenris.sql",import.meta.url),"utf8"));
    let repo=new RuntimeRepository(d1(sqlite));
    const make=()=>createRun({owner:{userId:"a",email:"a@test.invalid",displayName:"A"},mode:"test",workflow:templateWorkflow("agent"),resources:sampleResources,input:"test"});
    const run=await repo.create(make(),"request-key","hash");
    assert.equal((await repo.create(make(),"request-key","hash")).id,run.id);
    await assert.rejects(()=>repo.create(make(),"request-key","different"),/다른 입력/);
    assert.equal(await repo.get("b",run.id),null);assert.equal(await repo.claim("b",run.id),null);
    const lease=await repo.claim("a",run.id);assert.ok(lease);
    assert.equal(await repo.claim("a",run.id),null);
    lease.run.status="waiting_approval";await lease.save(lease.run);await lease.release();
    sqlite.close();sqlite=new DatabaseSync(path);repo=new RuntimeRepository(d1(sqlite));
    assert.equal((await repo.get("a",run.id))?.status,"waiting_approval");
    const replacement=await repo.claim("a",run.id,true);assert.ok(replacement);
    await assert.rejects(()=>lease.save(lease.run));
    await repo.cancel("b",run.id);assert.equal(await replacement.isCancelled(),false);
    await repo.cancel("a",run.id);assert.equal(await replacement.isCancelled(),true);
    sqlite.exec("UPDATE runtime_runs SET lease_until=0");
    const newer=await repo.claim("a",run.id,true);assert.ok(newer);
    await assert.rejects(()=>replacement.save(replacement.run),/만료/);
    await replacement.release();assert.equal(await repo.claim("a",run.id,true),null);
    await newer.release();
  } finally {sqlite.close();for(const suffix of ["","-wal","-shm"]) {try{unlinkSync(path+suffix);}catch{}}rmdirSync(dir);}
});
