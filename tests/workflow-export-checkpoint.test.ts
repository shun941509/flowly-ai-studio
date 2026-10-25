import { zipSync, strToU8 } from "fflate";
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import type {WorkflowDesign} from "../domain/workflow-design";
import type {PublicRun,Review} from "../runtime/types";
import {parseOptions,isolatedEnvironment,isCurrentCheckpoint,reusable,sha256,canonical,boundedWorkers,command,CLI_STDOUT_LIMIT,acquireLock,resolveScenarioReviews,resolveScenarioDecisions,type EvidenceEntry} from "./workflow-export-integration";

const waitingReview = (): PublicRun => ({id:"run-review",mode:"test",status:"waiting_review",input:"",result:"",createdAt:"",updatedAt:"",limits:{maxTurns:10,maxToolCalls:10,maxTokens:1000,maxDurationMs:1000},workflowId:"review",workflowName:"review",approvals:[],events:[],usage:{turns:0,toolCalls:0,tokens:0,activeMs:0},reviews:[{id:"pending-review",nodeId:"correct",runId:"run-review",userId:"test",inputHash:"hash",input:{data:{preview:"old"}},expiresAt:"",status:"pending"} satisfies Review]});
test("decision driver handles approval, late edited review, second approval and terminal replay in order", async () => {
  const base = waitingReview(), calls: string[][] = [], edits: unknown[] = [];
  const approval = (id: string): PublicRun => ({ ...base, status: "waiting_approval", reviews: [], approvals: [{ id, status: "pending" }] as PublicRun["approvals"] });
  let current = approval("first-approval"), resumes = 0;
  const result = await resolveScenarioDecisions(current, { name: "interleaved decisions", input: "", status: "succeeded", approval: "approve", review: "accept", reviewEdits: { correct: { data: { preview: "verified" } } }, resumeAgain: true }, async args => {
    calls.push(args);
    if (args[0] === "resume") current = ++resumes === 1 ? base : resumes === 2 ? approval("second-approval") : { ...base, status: "succeeded", reviews: [], result: "verified" };
    return current;
  }, async value => { edits.push(value); return "edited.json"; });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(edits, [{ data: { preview: "verified" } }]);
  assert.deepEqual(calls.map(args => args[0]), ["approve", "resume", "accept", "resume", "approve", "resume", "resume"]);
  assert.deepEqual(calls[2], ["accept", base.id, "pending-review", "--edited-input-file", "edited.json"]);
});
test("review edits use the actual CLI file option before resuming the accepted branch",async()=>{
  const calls:string[][]=[],saved:unknown[]=[],run=waitingReview(),input={data:{requested:"Hello\nMina",preview:"Hello\nMina"}};
  const result=await resolveScenarioReviews(run,{name:"corrected",input:"",status:"succeeded",review:"accept",reviewEdits:{correct:input}},async args=>{calls.push(args);return {...run,status:args[0]==="resume"?"succeeded":"waiting_review"};},async value=>{saved.push(value);return ".review-edited-0-0.json";});
  assert.equal(result.status,"succeeded");assert.deepEqual(saved,[input]);assert.deepEqual(calls,[["accept","run-review","pending-review","--edited-input-file",".review-edited-0-0.json"],["resume","run-review"]]);
});
test("unused edited review keys fail even when the run otherwise succeeds",async()=>{
  await assert.rejects(resolveScenarioReviews({...waitingReview(),status:"succeeded"},{name:"misspelled review",input:"",status:"succeeded",review:"accept",reviewEdits:{wrong_node:{data:{preview:"new"}}}},async()=>{assert.fail("no pending review");},async()=>{assert.fail("must not save unused input");}),/unused reviewEdits keys/);
});
test("rejected review fixtures cannot carry edited inputs",async()=>{
  await assert.rejects(resolveScenarioReviews(waitingReview(),{name:"invalid rejection",input:"",status:"succeeded",review:"reject",reviewEdits:{correct:{data:{preview:"new"}}}},async()=>{assert.fail("must reject before CLI mutation");},async()=>{assert.fail("must not save rejected input");}),/reject cannot carry edits/);
});
test("ordinary review rejection preserves the unedited CLI decision",async()=>{
  const calls:string[][]=[],run=waitingReview();
  await resolveScenarioReviews(run,{name:"reject",input:"",status:"succeeded",review:"reject"},async args=>{calls.push(args);return {...run,status:args[0]==="resume"?"succeeded":"waiting_review"};},async()=>{assert.fail("rejection has no edit file");});
  assert.deepEqual(calls,[["reject","run-review","pending-review"],["resume","run-review"]]);
});

test("verification flags reject unbounded concurrency and invalid filters",()=>{
  assert.equal(parseOptions([]).workers,2);assert.equal(parseOptions(["--workers=4","--resume","--ids","alpha,beta","--limit=2"]).resume,true);
  for(const args of [["--workers=5"],["--workers=0"],["--workers=NaN"],["--timeout-ms=999"],["--limit=-1"],["--ids=../key"],["--id=aab,aab"],["--unknown"],["--prefix"],["--resume=false"]])assert.throws(()=>parseOptions(args));
});
test("verification child environment excludes provider keys and code injection settings",()=>{
  const safe=isolatedEnvironment({NODE_ENV:"production",PATH:"local-bin",OPENAI_API_KEY:"synthetic-secret",NODE_OPTIONS:"--import malicious.mjs",PYTHONPATH:"unsafe",HTTP_PROXY:"secret-proxy",HOME:"secret-home"});
  assert.equal(safe.PATH,"local-bin");assert.equal(safe.PYTHONNOUSERSITE,"1");
  for(const key of ["OPENAI_API_KEY","NODE_OPTIONS","PYTHONPATH","HTTP_PROXY","HOME"])assert.ok(!(key in safe));
});
test("checkpoint requires the current harness/runtime fingerprint and zero external calls",()=>{
  const current={version:1,fingerprint:"current",projects:[],failures:[],checks:0,externalCalls:0};
  assert.equal(isCurrentCheckpoint(current,"current"),true);
  for(const old of [{...current,fingerprint:"old"},{...current,externalCalls:1},{...current,version:2},{...current,projects:[null]},null])assert.equal(isCurrentCheckpoint(old,"current"),false);
});
test("resume revalidates design, execution, every scenario, config evidence and both ZIP bytes",async()=>{
  const folder=await mkdtemp(join(tmpdir(),"flowly-resume-test-"));
  try {
    const design:WorkflowDesign={id:"resume-test",title:"test",category:"test",description:"test",behavior:"test",definition:{nodes:[],edges:[]},resources:[],inputExample:"",expectedOutput:"",acceptance:[],failureCases:[],scenarios:[{name:"normal",input:"",status:"succeeded"},{name:"boundary",input:"",status:"failed"}]};
    const record={designHash:sha256(canonical(design)),executionHash:"execution"};
    const zip=zipSync({"workflow.json":strToU8(JSON.stringify({connections:[]}))});
    const entry:EvidenceEntry={id:design.id,...record,node:true,python:true,zipHashes:{node:sha256(zip),python:sha256(zip)},configuration:{node:"ready",python:"ready"},checks:["node","python"].flatMap(language=>design.scenarios.map(s=>({language:language as "node"|"python",scenario:s.name,status:s.status,modelCalls:0})))};
    await writeFile(join(folder,"resume-test-node.zip"),zip);await writeFile(join(folder,"resume-test-python.zip"),zip);
    assert.equal(await reusable(entry,design,record,folder),true);
    for(const changed of [{...entry,node:false},{...entry,designHash:"old"},{...entry,executionHash:"old"},{...entry,configuration:undefined},{...entry,checks:entry.checks.slice(1)},{...entry,checks:entry.checks.map((c,i)=>i===0?{...c,status:"failed"}:c)},{...entry,checks:entry.checks.map((c,i)=>i===0?{...c,modelCalls:1}:c)}])assert.equal(await reusable(changed,design,record,folder),false);
    assert.equal(await reusable(entry,{...design,description:"changed authored design"},record,folder),false);
    await writeFile(join(folder,"resume-test-python.zip"),"changed-bytes");assert.equal(await reusable(entry,design,record,folder),false);
    await rm(join(folder,"resume-test-python.zip"));assert.equal(await reusable(entry,design,record,folder),false);
  } finally {await rm(folder,{recursive:true,force:true});}
});
test("bounded workers run every item once without exceeding the configured process load",async()=>{
  let active=0,peak=0;const seen:number[]=[];
  await boundedWorkers([0,1,2,3,4,5,6],2,async item=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));seen.push(item);active--;});
  assert.equal(peak,2);assert.deepEqual(seen.sort(),[0,1,2,3,4,5,6]);
});
test("worker failure drains active work before releasing the checkpoint lock",async()=>{
  let drained=false;const visited:number[]=[];
  await assert.rejects(boundedWorkers([0,1,2,3],2,async item=>{visited.push(item);if(item===0){await new Promise(r=>setTimeout(r,5));throw new Error("checkpoint failed");}await new Promise(r=>setTimeout(r,20));drained=true;}),/checkpoint failed/);
  assert.equal(drained,true);assert.deepEqual(visited,[0,1]);
});
test("CLI timeout retains bounded diagnostic output and does not report success",async()=>{
  const result=await command(process.execPath,["-e","console.log('started');setTimeout(()=>{},10000)"],process.cwd(),1000);
  assert.equal(result.timedOut,true);assert.ok(result.stdout.includes("started"));assert.notEqual(result.status,0);
});
test("CLI captures large valid checkpoint JSON without clipping, and still bounds excessive output",async()=>{
  const valid=await command(process.execPath,["-e","process.stdout.write(JSON.stringify({result:'x'.repeat(5_000_000)}))"],process.cwd(),10000);
  assert.equal(valid.status,0);assert.equal(valid.overflow,false);assert.equal(valid.timedOut,false);
  assert.equal(JSON.parse(valid.stdout).result.length,5_000_000);
  const excessive=await command(process.execPath,["-e",`process.stdout.write('x'.repeat(${CLI_STDOUT_LIMIT+1}));setTimeout(()=>{},10000)`],process.cwd(),10000);
  assert.equal(excessive.overflow,true);assert.equal(excessive.stdout.length,CLI_STDOUT_LIMIT);assert.notEqual(excessive.status,0);
});
test("resume recovers only a confirmed dead validation owner, never a live lock",async()=>{
  const folder=await mkdtemp(join(tmpdir(),"flowly-lock-test-")),path=join(folder,"validation.lock");
  try {
    const live=await acquireLock(path,false);
    await assert.rejects(acquireLock(path,true),/still active/);await live.close();await rm(path);
    const child=spawnSync(process.execPath,["-e","console.log(process.pid)"],{env:isolatedEnvironment(process.env),encoding:"utf8",windowsHide:true});assert.equal(child.status,0);
    await writeFile(path,JSON.stringify({pid:Number(child.stdout.trim()),nonce:"ended-child"}));
    const recovered=await acquireLock(path,true);await recovered.close();
  } finally {await rm(folder,{recursive:true,force:true});}
});
