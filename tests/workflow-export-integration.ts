/** Actual exported CLIs, bounded concurrency, resumable evidence, no ambient credentials. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile, readFile, open, rename } from "node:fs/promises";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import type { PublicRun, Json } from "../runtime/types";
import type { WorkflowDesign, WorkflowScenario } from "../domain/workflow-design";
import { allNodes } from "../domain/advanced-config";
import { nodeRequiresModel } from "../domain/extended-config";
import { compileDefinition } from "../domain/workflow";
import { FileRunStore } from "../export-runtime/store";
import { extractExportEntries } from "./export-zip";

type Language = "node" | "python";
type Check = { language: Language; scenario: string; status: string; modelCalls: number; modelCallCounts?: Record<string, number>; embeddingCalls?: number; toolCalls?: Record<string, number> };
export type EvidenceEntry = { id: string; designHash: string; executionHash: string; node: boolean; python: boolean; zipHashes: Record<Language,string>; checks: Check[]; configuration?: Record<Language,string> };
type Failure = { id: string; message: string; artifactDirectory?: string };
type Evidence = { version: number; fingerprint: string; projects: EvidenceEntry[]; failures: Failure[]; checks: number; externalCalls: number };
export function isCurrentCheckpoint(value: unknown, fingerprint: string): value is Evidence {
  if(!value||typeof value!=="object")return false;
  const old=value as Partial<Evidence>;
  return old.version===1&&old.fingerprint===fingerprint&&old.externalCalls===0&&Array.isArray(old.projects)&&Array.isArray(old.failures)&&old.projects.every(p=>p&&typeof p.id==="string")&&old.failures.every(f=>f&&typeof f.id==="string"&&typeof f.message==="string");
}
export type Options = { workers: number; resume: boolean; ids: string[]; prefix: string; limit: number; timeoutMs: number; report: string; outputDir: string; help: boolean };
export function parseOptions(args: string[]): Options {
  const result: Options = { workers: 2, resume: false, ids: [], prefix: "", limit: Infinity, timeoutMs: 30000, report: "examples/workflow-verification.json", outputDir: "outputs/workflows", help: false };
  const seen = new Set<string>();
  for (let i=0;i<args.length;i++) {
    const [key,...parts]=args[i].split("=");
    if(!["--workers","--resume","--ids","--id","--prefix","--limit","--timeout-ms","--report","--output-dir","--help"].includes(key))throw new Error(`Unknown option: ${key}`);
    if(seen.has(key))throw new Error(`Repeated option: ${key}`);seen.add(key);
    if(key==="--resume"||key==="--help") {if(parts.length)throw new Error(`${key} does not take a value`);if(key==="--resume")result.resume=true;else result.help=true;continue;}
    const value=parts.length?parts.join("="):args[++i];if(!value||value.startsWith("--"))throw new Error(`Missing value: ${key}`);
    if(key==="--workers"||key==="--limit"||key==="--timeout-ms") {
      const n=Number(value);if(!/^\d+$/.test(value)||!Number.isSafeInteger(n)||n<1)throw new Error(`Invalid positive integer: ${key}`);
      if(key==="--workers") {if(n>4)throw new Error("--workers must be 1..4");result.workers=n;}
      else if(key==="--limit")result.limit=n;else {if(n<1000||n>120000)throw new Error("--timeout-ms must be 1000..120000");result.timeoutMs=n;}
    } else if(key==="--ids"||key==="--id")result.ids.push(...value.split(","));
    else if(key==="--prefix")result.prefix=value;else if(key==="--report")result.report=value;else result.outputDir=value;
  }
  if(result.ids.some(id=>!/^[-a-z0-9]{3,100}$/.test(id))||new Set(result.ids).size!==result.ids.length)throw new Error("Invalid or duplicate workflow ID filter");
  return result;
}
export function isolatedEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { PATH:source.PATH,SystemRoot:source.SystemRoot,TEMP:source.TEMP,TMP:source.TMP,PATHEXT:source.PATHEXT,NODE_ENV:"test",PYTHONUTF8:"1",PYTHONNOUSERSITE:"1" };
}
export const sha256=(bytes: Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
export function canonical(value: unknown): string {
  if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
  if(value&&typeof value==="object")return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export async function reusable(entry: EvidenceEntry, design: WorkflowDesign, record: {designHash:string;executionHash:string}, outputDir: string): Promise<boolean> {
  if(!entry||entry.id!==design.id||entry.node!==true||entry.python!==true||entry.designHash!==record.designHash||entry.designHash!==sha256(canonical(design))||entry.executionHash!==record.executionHash||!entry.zipHashes||!Array.isArray(entry.checks)||entry.checks.length!==design.scenarios.length*2)return false;
  if(new Set(design.scenarios.map(s=>s.name)).size!==design.scenarios.length)return false;
  for(const language of ["node","python"] as const) {

    for(const scenario of design.scenarios) {
      const checks=entry.checks.filter(c=>c.language===language&&c.scenario===scenario.name);
      if(checks.length!==1||checks[0].status!==scenario.status||!Number.isSafeInteger(checks[0].modelCalls)||checks[0].modelCalls<new Set(scenario.modelReplies?.map(r=>r.match)??[]).size||(!(scenario.modelReplies?.length)&&checks[0].modelCalls!==0))return false;
      if(scenario.embeddingCallCount!==undefined&&checks[0].embeddingCalls!==scenario.embeddingCallCount)return false;
      if(scenario.toolCallCounts&&canonical(checks[0].toolCalls)!==canonical(scenario.toolCallCounts))return false;
      if(scenario.modelCallCounts&&canonical(checks[0].modelCallCounts)!==canonical(scenario.modelCallCounts))return false;
    }
    try {
      const bytes=await readFile(join(outputDir,`${design.id}-${language}.zip`));
      if(!/^[a-f0-9]{64}$/.test(entry.zipHashes[language])||sha256(bytes)!==entry.zipHashes[language])return false;
      const manifest=JSON.parse(new TextDecoder().decode(unzipSync(bytes)["workflow.json"]));
      const needsSetup=allNodes(design.definition).some(nodeRequiresModel)||manifest.connections.some((c:{endpointEnv?:string;tokenEnv?:string})=>c.endpointEnv||c.tokenEnv);
      if(entry.configuration?.[language]!== (needsSetup?"unconfigured":"ready"))return false;
    }catch{return false;}
  }
  return true;
}
export async function boundedWorkers<T>(items: T[], concurrency: number, work: (item:T)=>Promise<void>): Promise<void> {
  assert.ok(Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=4);
  let index=0,failed=false;
  const results=await Promise.allSettled(Array.from({length:Math.min(concurrency,items.length)},async()=>{for(;;){if(failed)return;const i=index++;if(i>=items.length)return;try{await work(items[i]);}catch(error){failed=true;throw error;}}}));
  const failure=results.find(result=>result.status==="rejected");if(failure?.status==="rejected")throw failure.reason;
}
export async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path),{recursive:true});const temporary=`${path}.${process.pid}.tmp`;
  await writeFile(temporary,JSON.stringify(value,null,2)+"\n");await rename(temporary,path);
}
/** An exclusive recovery gate prevents two resumptions from deleting a new owner's lock. */
export async function acquireLock(path: string, resume: boolean) {
  const create=async()=>{const handle=await open(path,"wx");try{await handle.writeFile(JSON.stringify({pid:process.pid,nonce:randomUUID(),startedAt:new Date().toISOString()}));return handle;}catch(error){await handle.close();throw error;}};
  try{return await create();}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;if(!resume)throw new Error(`Validation lock exists: ${path}. Use --resume after the previous process exits.`);}
  const gatePath=`${path}.recovery`,gate=await open(gatePath,"wx");
  try {
    let old: {pid?:number;nonce?:string};try{old=JSON.parse(await readFile(path,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return await create();throw new Error(`Cannot safely inspect validation lock: ${path}`);}
    assert.ok(Number.isSafeInteger(old.pid)&&old.pid!>0&&typeof old.nonce==="string","Malformed validation lock; inspect it before removing");
    try{process.kill(old.pid!,0);throw new Error(`Validation process ${old.pid} is still active: ${path}`);}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}
    await rm(path);return await create();
  } finally {await gate.close();await rm(gatePath,{force:true});}
}
function within(root:string,path:string) {const part=relative(resolve(root),resolve(path));assert.ok(part&&!part.startsWith("..")&&!isAbsolute(part),`Path outside validation workspace: ${path}`);}
const runEvents=(run:PublicRun):PublicRun["events"]=>[...run.events,...(run.children??[]).flatMap(child=>runEvents(child.run))];
/** Exercise the exported CLI review interface; never apply edits directly to run state. */
export async function resolveScenarioReviews(run: PublicRun, scenario: WorkflowScenario, cli: (args: string[]) => Promise<PublicRun>, saveEdit: (input: Record<string, Json>) => Promise<string>, progress?: { used: Set<string> }): Promise<PublicRun> {
  const edits = Object.entries(scenario.reviewEdits ?? {}), used = progress?.used ?? new Set<string>();
  assert.ok(!edits.length || scenario.review === "accept", `${scenario.name}: reviewEdits requires accept; reject cannot carry edits`);
  for (const [nodeId, input] of edits) assert.ok(nodeId && input && typeof input === "object" && !Array.isArray(input), `${scenario.name}: invalid edited input for ${nodeId}`);
  for (let attempt = 0; run.status === "waiting_review" && scenario.review && attempt < 8; attempt++) {
    for (const pending of run.reviews?.filter(r => r.status === "pending") ?? []) {
      const args = [scenario.review, run.id, pending.id], edit = edits.find(([nodeId]) => nodeId === pending.nodeId);
      if (edit) args.push("--edited-input-file", await saveEdit(edit[1]));
      await cli(args);
      if (edit) used.add(edit[0]);
    }
    run = await cli(["resume", run.id]);
  }
  if (!progress) assert.deepEqual(edits.map(([nodeId]) => nodeId).filter(nodeId => !used.has(nodeId)), [], `${scenario.name}: unused reviewEdits keys`);
  return run;
}

/** Every decision and resume uses a fresh exported CLI process and durable state. */
export async function resolveScenarioDecisions(run: PublicRun, scenario: WorkflowScenario, cli: (args: string[]) => Promise<PublicRun>, saveEdit: (input: Record<string, Json>) => Promise<string>): Promise<PublicRun> {
  const reviewProgress = { used: new Set<string>() }, submissions = scenario.inputSubmissions ?? [];
  assert.ok(!Object.keys(scenario.reviewEdits ?? {}).length || scenario.review === "accept", `${scenario.name}: reviewEdits requires accept; reject cannot carry edits`);
  let submitted = 0;
  for (const decision of scenario.decisionSequence ?? []) {
    const collection = decision.kind === "submit" ? run.inputRequests : decision.kind === "accept" || decision.kind === "reject" ? run.reviews : run.approvals;
    const pending = collection?.find(item => item.nodeId === decision.nodeId && item.status === "pending");
    assert.ok(pending, `${scenario.name}: missing explicit ${decision.kind} decision at ${decision.nodeId}`);
    const args = [decision.kind, run.id, pending.id];
    if (decision.kind === "submit") { assert.ok(decision.values, "Explicit input submission requires values"); args.push("--values-file", await saveEdit(decision.values)); }
    else if (decision.kind === "accept" && decision.values) { args.push("--edited-input-file", await saveEdit(decision.values)); reviewProgress.used.add(decision.nodeId); }
    else assert.ok(!decision.values, "This decision does not accept values");
    await cli(args);
    run = await cli(["resume", run.id]);
  }
  for (let attempt = 0; attempt < 24; attempt++) {
    if (run.status === "waiting_input" && submitted < submissions.length) {
      run = await resolveScenarioInputs(run, { ...scenario, inputSubmissions: [submissions[submitted++]] }, cli, saveEdit);
    } else if (run.status === "waiting_review" && scenario.review) {
      run = await resolveScenarioReviews(run, scenario, cli, saveEdit, reviewProgress);
    } else if (run.status === "waiting_approval" && scenario.approval) {
      const pending = run.approvals.filter(a => a.status === "pending");
      assert.ok(pending.length, "Approval waiting without a pending decision");
      for (const approval of pending) await cli([scenario.approval, run.id, approval.id]);
      run = await cli(["resume", run.id]);
    } else break;
  }
  assert.equal(submitted, submissions.length, `${scenario.name}: unused supplemental inputs`);
  assert.deepEqual(Object.keys(scenario.reviewEdits ?? {}).filter(nodeId => !reviewProgress.used.has(nodeId)), [], `${scenario.name}: unused reviewEdits keys`);
  if(scenario.resumeAgain) {
    const before=run;
    run=await cli(["resume",run.id]);
    assert.equal(run.status,before.status,"Repeated resume changed terminal outcome");
    assert.equal(run.result,before.result,"Repeated resume changed terminal output");
    assert.deepEqual(run.usage,before.usage,"Repeated resume replayed work");
  }
  return run;
}
/** Submit through fresh processes, prove that invalid values leave durable waits intact. */
export async function resolveScenarioInputs(run: PublicRun, scenario: WorkflowScenario, cli: (args: string[]) => Promise<PublicRun>, saveValues: (input: Record<string, Json>) => Promise<string>): Promise<PublicRun> {
  const completed = (current: PublicRun): Record<string, number> => {
    const result: Record<string, number> = {};
    const visit = (item: PublicRun) => { for (const event of item.events) if (event.type === "node_completed") { const key = `${item.id}/${event.nodeId}`; result[key] = (result[key] ?? 0) + 1; } item.children?.forEach(child => visit(child.run)); };
    visit(current); return result;
  };
  const sameCompleted = (before: PublicRun, after: PublicRun) => { const counts = completed(after); for (const [key, count] of Object.entries(completed(before))) assert.equal(counts[key], count, `${scenario.name}: resumed work was replayed: ${key}`); };
  for (const submission of scenario.inputSubmissions ?? []) {
    assert.equal(run.status, "waiting_input", `${scenario.name}: supplemental input did not wait`);
    const waiting = run, request = run.inputRequests?.find(item => item.status === "pending" && item.nodeId === submission.nodeId);
    assert.ok(request, `${scenario.name}: missing input request for ${submission.nodeId}`);
    run = await cli(["status", run.id]);
    assert.equal(run.id, waiting.id, `${scenario.name}: reload changed run ID`);
    assert.equal(run.status, "waiting_input", `${scenario.name}: wait was not persisted`);
    assert.deepEqual(run.inputRequests, waiting.inputRequests, `${scenario.name}: pending input changed on reload`);
    for (const values of submission.invalidValues ?? []) {
      await assert.rejects(cli(["submit", run.id, request.id, "--values-file", await saveValues(values)]), `${scenario.name}: invalid supplemental values were accepted`);
      run = await cli(["status", waiting.id]);
      assert.equal(run.status, "waiting_input", `${scenario.name}: invalid submission changed wait status`);
      assert.equal(run.inputRequests?.find(item => item.id === request.id)?.status, "pending");
      sameCompleted(waiting, run);
      assert.deepEqual(run.usage, waiting.usage, `${scenario.name}: invalid submission executed work`);
    }
    const valuesFile = await saveValues(submission.values);
    run = await cli(["submit", run.id, request.id, "--values-file", valuesFile]);
    assert.equal(run.id, waiting.id, `${scenario.name}: submit created a different run`);
    assert.equal(run.inputRequests?.find(item => item.id === request.id)?.status, "submitted");
    assert.deepEqual(run.usage, waiting.usage, `${scenario.name}: submission executed work before resume`);
    if (submission.repeat) {
      const submitted = run;
      run = await cli(["submit", run.id, request.id, "--values-file", valuesFile]);
      assert.deepEqual(run.inputRequests, submitted.inputRequests, `${scenario.name}: duplicate submission changed the request`);
      assert.deepEqual(run.usage, submitted.usage, `${scenario.name}: duplicate submission executed work`);
    }
    run = await cli(["resume", waiting.id]);
    assert.equal(run.id, waiting.id, `${scenario.name}: resume created a different run`);
    sameCompleted(waiting, run);
  }
  return run;
}
type CommandResult={status:number|null;stdout:string;stderr:string;timedOut:boolean;overflow:boolean;error?:string};
// A valid 400-item run includes durable child results and events. Keep capture
// bounded without truncating that public CLI response before JSON validation.
export const CLI_STDOUT_LIMIT=16_000_000;
export function command(exe:string,args:string[],cwd:string,timeoutMs:number):Promise<CommandResult> {
  return new Promise(done=>{
    const child=spawn(exe,args,{cwd,env:isolatedEnvironment(process.env),windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="",timedOut=false,overflow=false,settled=false;
    const finish=(status:number|null,error?:string)=>{if(settled)return;settled=true;clearTimeout(timer);done({status,stdout,stderr,timedOut,overflow,...(error?{error}:{})});};
    const timer=setTimeout(()=>{timedOut=true;child.kill();},timeoutMs);
    const capture=(kind:"stdout"|"stderr",chunk:string)=>{if(kind==="stdout")stdout=(stdout+chunk).slice(0,CLI_STDOUT_LIMIT);else stderr=(stderr+chunk).slice(0,1_000_000);if(stdout.length>=CLI_STDOUT_LIMIT||stderr.length>=1_000_000){overflow=true;child.kill();}};
    child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");child.stdout.on("data",x=>capture("stdout",x));child.stderr.on("data",x=>capture("stderr",x));child.on("error",error=>finish(null,error.message));child.on("close",status=>finish(status));
  });
}

export async function main(args=process.argv.slice(2)) {
  const options=parseOptions(args);
  const localPython=resolve("work/tools-env",process.platform==="win32"?"Scripts/python.exe":"bin/python");
  const pythonExecutable=process.env.FLOWLY_TEST_PYTHON||(existsSync(localPython)?localPython:"python");
  if(options.help){console.log("Workflow ZIP verification: --workers 2 (1..4), --resume, --ids id1,id2, --prefix text, --limit N, --timeout-ms 30000, --report path, --output-dir path. Filters run complete Node/Python scenarios. Resume requires current fingerprint, authored design/execution hashes, complete checks and both saved ZIP hashes. Ctrl+C stops scheduling after active projects and preserves evidence.");return;}
  const [{workflowDesigns},{default:published},{getExample},{buildExampleExport},{catalogEvidenceFingerprint}]=await Promise.all([import("../domain/workflow-designs"),import("../domain/generated/workflow-designs.json"),import("../server/example-catalog"),import("../server/example-export"),import("../scripts/catalog-evidence.mjs")]);
  const designsById=new Map(workflowDesigns.map(d=>[d.id,d])),records=new Map(published.map(r=>[r.id,r]));
  for(const design of workflowDesigns.filter(d=>(!options.ids.length||options.ids.includes(d.id))&&(!options.prefix||d.id.startsWith(options.prefix))).slice(0,options.limit)) {
    const record=records.get(design.id);assert.ok(record,`Missing published design: ${design.id}`);
    const {scenarios:_scenarios,...authored}=design;void _scenarios;
    const {designHash,executionHash:_executionHash,topologyHash:_topologyHash,...publicDefinition}=record;void [_executionHash,_topologyHash];
    assert.equal(designHash,sha256(canonical(design)),`Published design hash is stale: ${design.id}`);
    assert.equal(canonical(publicDefinition),canonical({...authored,definition:compileDefinition(design.definition)}),`Published graph/resources differ from the authored design: ${design.id}`);
  }
  for(const id of options.ids)assert.ok(designsById.has(id),`Unknown workflow filter: ${id}`);
  const selected=workflowDesigns.filter(d=>(!options.ids.length||options.ids.includes(d.id))&&(!options.prefix||d.id.startsWith(options.prefix))).slice(0,options.limit);
  assert.ok(selected.length,"No workflows match the filter");
  const fingerprint=await catalogEvidenceFingerprint(),outputDir=resolve(options.outputDir),reportPath=resolve(options.report);
  await mkdir(outputDir,{recursive:true});await mkdir(dirname(reportPath),{recursive:true});
  const lockPath=join(outputDir,"validation.lock"),reportLockPath=`${reportPath}.lock`;
  const lock=await acquireLock(lockPath,options.resume);let reportLock:Awaited<ReturnType<typeof open>>|undefined;
  try {reportLock=await acquireLock(reportLockPath,options.resume);}catch(error){await lock.close();await rm(lockPath,{force:true});throw error;}
  const root=await mkdtemp(join(outputDir,".validation-")),evidence=new Map<string,EvidenceEntry>(),failures=new Map<string,Failure>();
  let writeQueue=Promise.resolve(),done=0,retained=0,stopping=false;const started=Date.now();
  const stop=()=>{stopping=true;console.log("Stopping after active projects; checkpoint will be retained.");};process.on("SIGINT",stop);process.on("SIGTERM",stop);
  const persist=()=>{writeQueue=writeQueue.then(async()=>{const projects=[...evidence.values()].sort((a,b)=>a.id.localeCompare(b.id));await atomicJson(reportPath,{version:1,fingerprint,scope:"explicit workflow branch/data/state scenarios on actual exported CLIs; test-only provider responses, not live model quality",projects,checks:projects.reduce((n,p)=>n+p.checks.length+2,0),failures:[...failures.values()],externalCalls:0,progress:{selected:selected.length,completed:done,retained,workers:options.workers,interrupted:stopping,updatedAt:new Date().toISOString()}});});return writeQueue;};
  try {
    if(options.resume) {
      let old:Evidence|undefined;
      try{old=JSON.parse(await readFile(reportPath,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw new Error(`Checkpoint unreadable; preserved without overwriting: ${String(error)}`);}
      if(isCurrentCheckpoint(old,fingerprint)) {
        assert.equal(new Set(old.projects.map(p=>p.id)).size,old.projects.length,"Duplicate checkpoint IDs");
        for(const entry of old.projects) {const design=designsById.get(entry.id),record=records.get(entry.id);if(design&&record&&await reusable(entry,design,record,outputDir))evidence.set(entry.id,entry);}
        for(const failure of old.failures)if(designsById.has(failure.id))failures.set(failure.id,failure);
      }
    }
    retained=selected.filter(d=>evidence.has(d.id)).length;
    const queue=selected.filter(d=>!evidence.has(d.id));
    console.log(`Workflow verification: selected=${selected.length}/${workflowDesigns.length}, resume=${retained}, execute=${queue.length}, workers=${options.workers}. External network blocked; secret environment excluded.`);
    const heartbeat=setInterval(()=>console.log(`Progress ${done+retained}/${selected.length}; active/completed CLI work; pass=${evidence.size}; failed=${failures.size}; elapsed=${Math.round((Date.now()-started)/1000)}s`),15000);
    try {await boundedWorkers(queue,options.workers,async design=>{
      if(stopping)return;
      const directory=join(root,design.id);within(root,directory);await mkdir(directory);
      const checks:Check[]=[],zipHashes={node:"",python:""},configuration={node:"",python:""};
      try {
        assert.match(design.id,/^[-a-z0-9]{3,100}$/);assert.ok(design.scenarios.length>=2);assert.equal(new Set(design.scenarios.map(s=>s.name)).size,design.scenarios.length,"Duplicate scenario names");
        const record=records.get(design.id);assert.ok(record,"Missing published design");assert.equal(sha256(canonical(design)),record.designHash,"Published design is stale; rebuild before verifying");
        const project=getExample(design.id);assert.ok(project,"Missing public workflow");
        for(const language of ["node","python"] as const) {
          const work=join(directory,language);await mkdir(work);
          const zip=await buildExampleExport(project,{userId:"workflow-test",email:"test@example.test",displayName:"Test"},language);
          const files=unzipSync(zip);assert.ok(!files[".env"]&&!Object.keys(files).some(p=>p.includes("scenario")||p.includes("preload")||p.includes("boundary")));
          const manifest=JSON.parse(new TextDecoder().decode(files["workflow.json"]));
          for (const name of ["AI_PROMPT.md", "AGENTS.md", "START_HERE.md", "WORKFLOW_GUIDE.md", "skills/flowly-workflow/SKILL.md"]) assert.ok(files[name]?.length, `Missing AI export: ${name}`);
          const guide = new TextDecoder().decode(files["WORKFLOW_GUIDE.md"]);
          for (const node of allNodes(project.workflow.definition)) {
            assert.ok(guide.includes(`"id": ${JSON.stringify(node.id)}`), `AI guide omitted node ${node.id}`);
            if (node.program?.name === "completion") {
              assert.ok(files["completion-manifest.json"] && files["COMPLETION_PROGRAMS.md"] && files["requirements-completion.txt"], "Completion setup documents missing");
              assert.ok(guide.includes(JSON.stringify(node.program.arguments.operation)), `AI guide omitted registered operation ${node.id}`);
            }
          }
          assert.ok(new TextDecoder().decode(files["START_HERE.md"]).includes(language === "node" ? "node runner.mjs check" : "python runner.py check"), "AI instructions use the wrong runner");
          await extractExportEntries(work,files);
          const exe=language==="node"?process.execPath:pythonExecutable,prefix=language==="node"?["--import",pathToFileURL(resolve("tests/workflow-node-preload.mjs")).href,"runner.mjs"]:["-X","utf8",resolve("tests/workflow-python-boundary.py")];
          let commandIndex=0;
          const invoke=async(cliArgs:string[])=>{const result=await command(exe,[...prefix,...cliArgs],work,options.timeoutMs);await atomicJson(join(work,`command-${String(++commandIndex).padStart(4,"0")}.json`),{args:cliArgs,...result});assert.ok(!result.timedOut&&!result.overflow&&!result.error,`CLI failed: ${JSON.stringify(result)}`);return result;};
          await writeFile(join(work,".env"),`FLOWLY_PYTHON=${pythonExecutable}\n`);
          await writeFile(join(work,".scenario.json"),JSON.stringify({name:"configuration",modelReplies:[]}));
          const ready=await invoke(["check"]),diagnostics=JSON.parse(ready.stdout),requiresModel:boolean=allNodes(project.workflow.definition).some(nodeRequiresModel);
          const requiresSetup:boolean=requiresModel||manifest.connections.some((c:{endpointEnv?:string;tokenEnv?:string})=>c.endpointEnv||c.tokenEnv);
          assert.equal(ready.status,requiresSetup?1:0,ready.stderr||ready.stdout);assert.equal(diagnostics.status,requiresSetup?"unconfigured":"ready",ready.stderr||ready.stdout);
          if(requiresModel)assert.ok(diagnostics.missingEnv.includes("OPENAI_API_KEY"));configuration[language]=diagnostics.status;
          for(const connection of manifest.connections)for(const key of [connection.endpointEnv,connection.tokenEnv].filter(Boolean))assert.ok(diagnostics.missingEnv.includes(key),`Missing setup not reported: ${key}`);
          await writeFile(join(work,".env"),["OPENAI_API_KEY=workflow-test-boundary-placeholder","FLOWLY_MODEL=test-model",`FLOWLY_PYTHON=${pythonExecutable}`,...manifest.connections.flatMap((c:{endpointEnv?:string;endpoint:string;tokenEnv?:string})=>[...(c.endpointEnv?[`${c.endpointEnv}=${c.endpoint}`]:[]),...(c.tokenEnv?[`${c.tokenEnv}=workflow-tool-boundary-placeholder`]:[])]),""].join("\n"));
          const readLog=async(name:string):Promise<Record<string,unknown>[]>=>{try{return (await readFile(join(work,name),"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return [];throw error;}};
          for(const[index,scenario]of design.scenarios.entries()) {
            assert.ok(!scenario.stateGroup||/^[-a-zA-Z0-9_]{1,100}$/.test(scenario.stateGroup),"Unsafe state group");
            for (const [name, content] of Object.entries(scenario.files ?? {})) {
              const target = resolve(work, "inputs", name); within(resolve(work, "inputs"), target);
              await mkdir(dirname(target), { recursive: true }); await writeFile(target, content, "utf8");
            }
            await writeFile(join(work,".scenario.json"),JSON.stringify(scenario));await writeFile(join(work,`.scenario-${index}.json`),JSON.stringify(scenario));await writeFile(join(work,".scenario-input.txt"),scenario.input);await writeFile(join(work,".model-calls.jsonl"),"");
            for(const name of [".tool-calls.jsonl",".embedding-calls.jsonl",".model-timing.jsonl",".boundary-errors.jsonl"])await writeFile(join(work,name),"");
            const state=`.state-${scenario.stateGroup??index}`;
            if (scenario.memorySeeds?.length) {
              assert.ok(scenario.memorySeeds.length <= 20, "Too many historical memory fixtures");
              const statePath=resolve(work,state);within(work,statePath);
              if(language==="node") {
                const store=new FileRunStore(statePath);await store.acquire();
                try {for(const [seedIndex,seed] of scenario.memorySeeds.entries())await store.memory({ownerId:manifest.owner.userId,workflowId:manifest.workflow.id,operationId:`historical-fixture-${index}-${seedIndex}`,action:"write",key:seed.key,value:seed.value});}
                finally {await store.release();}
              } else {
                const seeded=await command(pythonExecutable,["-X","utf8",resolve("tests/seed-workflow-memory.py"),state],work,options.timeoutMs);
                assert.equal(seeded.status,0,seeded.stderr||seeded.stdout);assert.ok(!seeded.timedOut&&!seeded.overflow&&!seeded.error,"Historical fixture seed failed");
              }
            }
            const cli=async(cliArgs:string[])=>{
              const beforeTools=await readLog(".tool-calls.jsonl"),beforeModels=await readLog(".model-calls.jsonl");
              const result=await invoke([...cliArgs,"--state",state]);let value;
              if(["accept","reject","approve","deny","submit","status"].includes(cliArgs[0])){
                assert.deepEqual(await readLog(".tool-calls.jsonl"),beforeTools,"Decision command dispatched a tool before resume");
                assert.deepEqual(await readLog(".model-calls.jsonl"),beforeModels,"Decision command called a model before resume");
              }
              try{value=JSON.parse(result.stdout);}catch{throw new Error(`${design.id}/${language}/${scenario.name}: ${result.stderr||result.stdout}`);}
              assert.equal(result.status,["failed","cancelled","expired","budget_exceeded","unknown_outcome","unconfigured","invalid"].includes(value.status)?1:0,result.stderr||result.stdout);
              if(value.status==="waiting_approval")for(const pending of value.approvals.filter((a:{status:string})=>a.status==="pending"))assert.ok(!(await readLog(".tool-calls.jsonl")).some(c=>c.name===pending.toolName&&canonical(c.args)===canonical(pending.args)),"Write occurred before approval");
              return value;
            };
            let editIndex=0;
            const run:PublicRun=await resolveScenarioDecisions(await cli(["run","--input-file",".scenario-input.txt"]),scenario,cli,async input=>{const path=`.review-edited-${index}-${editIndex++}.json`;await writeFile(join(work,path),JSON.stringify(input));return path;});
            const label=`${design.id}/${language}/${scenario.name}`,events=runEvents(run);await atomicJson(join(work,`result-${index}.json`),run);
            assert.deepEqual(await readLog(".boundary-errors.jsonl"),[],`${label}: test boundary contract failed; expected workflow failure must not hide a fixture error`);
            assert.equal(run.status,scenario.status,`${label}: ${run.error??run.result}`);
            for(const value of scenario.errorContains??[])assert.ok(run.error?.includes(value),`${label}: missing error ${value}: ${run.error}`);
            for(const value of scenario.contains??[])assert.ok(run.result.includes(value),`${label}: missing ${value} in ${run.result}`);
            for(const value of scenario.excludes??[])assert.ok(!run.result.includes(value),`${label}: leaked ${value}`);
            for(const id of scenario.visited??[])assert.ok(events.some(e=>e.nodeId===id&&e.type==="node_completed"),`${label}: not completed ${id}`);
            for(const id of scenario.skipped??[])assert.ok(events.some(e=>e.nodeId===id&&e.type==="node_skipped"),`${label}: not skipped ${id}`);
            for(const [id,count]of Object.entries(scenario.completedCounts??{}))assert.equal(events.filter(e=>e.nodeId===id&&e.type==="node_completed").length,count,`${label}: completion count for ${id}`);
            for(const[nodeId,fields]of Object.entries(scenario.outputs??{})){const output=(events.findLast(e=>e.nodeId===nodeId&&e.type==="node_completed")?.data as {output?:Record<string,Json>})?.output;for(const[key,value]of Object.entries(fields))assert.deepEqual(output?.[key],value,`${label}: ${nodeId}.${key}`);}
            const calls=(await readFile(join(work,".model-calls.jsonl"),"utf8")).trim().split("\n").filter(Boolean);await writeFile(join(work,`model-calls-${index}.jsonl`),calls.join("\n"));
            if(!scenario.modelReplies?.length)assert.equal(calls.length,0,`${label}: unexpected model call`);
            for(const reply of scenario.modelReplies??[])assert.ok(calls.some(call=>{const c=JSON.parse(call);return c.match===reply.match&&(!reply.occurrence||c.occurrence===reply.occurrence);}),`${label}: expected validated model input for ${reply.match}/${reply.occurrence??"any"}`);
            const modelCallCounts:Record<string,number>={};for(const line of calls){const {match}=JSON.parse(line);modelCallCounts[match]=(modelCallCounts[match]??0)+1;}
            if(scenario.modelCallCounts)assert.deepEqual(modelCallCounts,scenario.modelCallCounts,`${label}: unexpected/repeated model calls`);
            const embeddingCalls=(await readLog(".embedding-calls.jsonl")).length;
            assert.equal(embeddingCalls,scenario.embeddingCallCount??0,`${label}: embedding count/cache reuse`);
            const actualTools=await readLog(".tool-calls.jsonl"),toolCalls=Object.fromEntries(Object.keys(scenario.toolCallCounts??{}).map(name=>[name,0]));
            for(const call of actualTools)toolCalls[String(call.name)]=(toolCalls[String(call.name)]??0)+1;
            assert.deepEqual(toolCalls,scenario.toolCallCounts??{},`${label}: unexpected/repeated tools`);
            if(scenario.parallelMatches?.length){
              const timings=await readLog(".model-timing.jsonl");
              const intervals=scenario.parallelMatches.map(match=>{const start=timings.find(t=>t.match===match&&t.phase==="start"),end=timings.find(t=>t.match===match&&t.phase==="end");assert.ok(start&&end,`${label}: missing timing ${match}`);return [Number(start.at),Number(end.at)];});
              assert.ok(Math.max(...intervals.map(t=>t[0]))<Math.min(...intervals.map(t=>t[1])),`${label}: parallel agents did not overlap`);
            }
            checks.push({language,scenario:scenario.name,status:run.status,modelCalls:calls.length,modelCallCounts,embeddingCalls,toolCalls});
          }
          zipHashes[language]=sha256(zip);const target=join(outputDir,`${design.id}-${language}.zip`);await writeFile(`${target}.tmp`,zip);await rename(`${target}.tmp`,target);
        }
        evidence.set(design.id,{id:design.id,designHash:record.designHash,executionHash:record.executionHash,node:true,python:true,zipHashes,checks,configuration});failures.delete(design.id);
        within(root,directory);await rm(directory,{recursive:true,force:true});console.log(`PASS ${design.id}: ${checks.length} Node/Python scenarios`);
      } catch(error){const message=error instanceof Error?error.stack??error.message:String(error);evidence.delete(design.id);const failure={id:design.id,message,artifactDirectory:directory};failures.set(design.id,failure);await atomicJson(join(directory,"failure.json"),failure);console.error(`FAIL ${design.id}: ${message.slice(0,1200)}; evidence=${directory}`);}
      done++;await persist();
    });}finally{clearInterval(heartbeat);}
    if(await catalogEvidenceFingerprint()!==fingerprint){evidence.clear();failures.set("__fingerprint_changed__",{id:"__fingerprint_changed__",message:"Runtime/harness changed during validation; results cannot be reused. Run --resume after sources stabilize."});}
    await persist();
    console.log(`${evidence.size}/${workflowDesigns.length} executable workflows; ${[...evidence.values()].reduce((n,p)=>n+p.checks.length+2,0)} checks; ${failures.size} failed; ${retained} selected reused. External calls: 0.`);
    if(failures.size||stopping)process.exitCode=stopping?130:1;
  } finally {
    process.off("SIGINT",stop);process.off("SIGTERM",stop);
    try {await writeQueue;} finally {
      await reportLock.close();await lock.close();await rm(reportLockPath,{force:true});await rm(lockPath,{force:true});
      // Failed workspaces remain inspectable; only an empty successful run root is removed.
      if(![...failures.values()].some(f=>f.artifactDirectory?.startsWith(root))) {within(outputDir,root);await rm(root,{recursive:true,force:true});}
    }
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
