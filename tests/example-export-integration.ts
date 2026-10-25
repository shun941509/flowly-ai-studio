import { extractExportEntries } from "./export-zip";
/** All real ZIP artifacts, bounded subprocess concurrency, no ambient credentials. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, readFile, writeFile, open, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";
import { exampleSeeds, type ExampleSeed } from "../domain/example-seeds";
import { getExample } from "../server/example-catalog";
import { buildExampleExport } from "../server/example-export";
import { catalogEvidenceFingerprint } from "../scripts/catalog-evidence.mjs";
import { contractHash } from "../scripts/build-example-catalog.mjs";

type Evidence={id:string;contractHash:string;node:boolean;python:boolean;checks:number;zipHashes:{node:string;python:string}};
const flags=new Map(process.argv.slice(2).map(value=>{const [key,...rest]=value.split("=");return[key,rest.join("=")||"true"];}));
const concurrency=Math.max(1,Math.min(12,Number(flags.get("--workers")||6)));
const limit=Number(flags.get("--limit")||Infinity);
assert.ok(Number.isInteger(concurrency)&&concurrency>0&&limit>0);
const fingerprint=await catalogEvidenceFingerprint();
const environment:NodeJS.ProcessEnv={NODE_ENV:"test",PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,PATHEXT:process.env.PATHEXT};
await mkdir("outputs/catalog",{recursive:true});
const lockPath=resolve("outputs/catalog/validation.lock"),lock=await open(lockPath,"wx");
const temporary=await mkdtemp(join(tmpdir(),"flowly-catalog-"));
const evidence=new Map<string,Evidence>(),failures:{id:string;error:string}[]=[];
let writeQueue=Promise.resolve(),completed=0;

function command(executable:string,args:string[],cwd:string):Promise<{status:number|null;stdout:string;stderr:string}> {
  return new Promise((done,reject)=>{
    const child=spawn(executable,args,{cwd,env:environment,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="";
    const timer=setTimeout(()=>{child.kill();reject(new Error("Artifact process exceeded 45 seconds"));},45000);
    child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");
    child.stdout.on("data",chunk=>{stdout+=chunk;if(stdout.length>2_000_000)child.kill();});child.stderr.on("data",chunk=>{stderr+=chunk;});
    child.on("error",error=>{clearTimeout(timer);reject(error);});
    child.on("close",status=>{clearTimeout(timer);done({status,stdout,stderr});});
  });
}
function persist() {
  writeQueue=writeQueue.then(async()=>{
    const projects=[...evidence.values()].sort((a,b)=>a.id.localeCompare(b.id));
    await writeFile("examples/catalog-verification.json.tmp",JSON.stringify({version:2,fingerprint,scope:"actual exported CLI configuration, injected-provider input/evidence propagation and review accept/reject; NOT live model quality",externalCalls:0,projects,checks:projects.reduce((sum,item)=>sum+item.checks,0),failures},null,2)+"\n");
    await rename("examples/catalog-verification.json.tmp","examples/catalog-verification.json");
  });
  return writeQueue;
}
async function validate(seed:ExampleSeed) {
  const project=getExample(seed.id)!;
  let checks=0;const zipHashes={node:"",python:""};
  const marker=`CATALOG_INPUT_${seed.id}`;
  let input=seed.input+"\n"+marker;
  if(seed.id==="policy-citations") {const fields=JSON.parse(seed.input);fields.question+=" "+marker;input=JSON.stringify(fields);}
  for(const language of ["node","python"] as const) {
    const zip=await buildExampleExport(project,{userId:"catalog-test",email:"test@example.test",displayName:"Catalog Test"},language);
    const directory=join(temporary,`${seed.id}-${language}`);await mkdir(directory);
    const files=unzipSync(zip);
    assert.ok(!files[".env"]&&!Object.keys(files).some(name=>name.includes("preload")||name.includes("test-adapter")));
    await extractExportEntries(directory,files);
    const executable=language==="node"?process.execPath:"python";
    const args=language==="node"?["runner.mjs","check"]:["-X","utf8","runner.py","check"];
    const checked=await command(executable,args,directory);
    assert.equal(checked.status,1,checked.stderr||checked.stdout);
    const diagnostics=JSON.parse(checked.stdout);assert.equal(diagnostics.status,"unconfigured");assert.ok(diagnostics.missingEnv.includes("OPENAI_API_KEY"));checks++;
    await writeFile(join(directory,".test-input.txt"),input);
    if(language==="node") {
      await writeFile(join(directory,".env"),"OPENAI_API_KEY=catalog-test-adapter-placeholder\nFLOWLY_MODEL=test-model\n");
      const cli=async(args:string[])=>{
        const result=await command(process.execPath,["--import",pathToFileURL(resolve("tests/example-node-preload.mjs")).href,"runner.mjs",...args],directory);
        assert.equal(result.status,0,result.stderr||result.stdout);return JSON.parse(result.stdout);
      };
      let run=await cli(["run","--input-file",".test-input.txt"]);
      if(run.status==="waiting_review") {await cli(["accept",run.id,run.reviews[0].id]);run=await cli(["resume",run.id]);}
      assert.equal(run.status,"succeeded",run.error);assert.ok(run.result.includes(marker)&&run.result.includes(`EVIDENCE:${seed.id}`));assert.equal(run.usage.toolCalls,0);
      if(seed.pattern==="review") {
        const pending=await cli(["run","--input-file",".test-input.txt"]);assert.equal(pending.status,"waiting_review");
        await cli(["reject",pending.id,pending.reviews[0].id]);const rejected=await cli(["resume",pending.id]);
        assert.equal(rejected.status,"succeeded");assert.match(rejected.result,/거절/);assert.ok(!rejected.result.includes("TEST_ADAPTER"));checks++;
      }
      if(seed.outputSchema) {
        await writeFile(join(directory,".test-invalid.txt"),input+"\nCATALOG_BAD_SCHEMA");
        const result=await command(process.execPath,["--import",pathToFileURL(resolve("tests/example-node-preload.mjs")).href,"runner.mjs","run","--input-file",".test-invalid.txt"],directory);
        assert.equal(result.status,1,result.stderr||result.stdout);assert.equal(JSON.parse(result.stdout).status,"failed");checks++;
      }
    } else {
      const result=await command("python",["-X","utf8",resolve("tests/example-export-python.py")],directory);
      assert.equal(result.status,0,result.stderr||result.stdout);const inspected=JSON.parse(result.stdout);assert.equal(inspected.testAdapter,true);
      if(seed.pattern==="review"){assert.equal(inspected.reviewRejected,true);checks++;}
      if(seed.outputSchema){assert.equal(inspected.schemaRejected,true);checks++;}
    }
    checks++;
    zipHashes[language]=createHash("sha256").update(zip).digest("hex");
    await writeFile(`outputs/catalog/${seed.id}-${language}.zip`,zip);
    assert.ok(resolve(directory).startsWith(resolve(temporary)+sep));await rm(directory,{recursive:true,force:true});
  }
  evidence.set(seed.id,{id:seed.id,contractHash:contractHash(seed),node:true,python:true,checks,zipHashes});
}
try {
  if(flags.has("--resume")) {
    try {
      const old=JSON.parse(await readFile("examples/catalog-verification.json","utf8"));
      if(old.version===2&&old.fingerprint===fingerprint)for(const item of old.projects) {
        const seed=exampleSeeds.find(seed=>seed.id===item.id);
        if(seed&&item.node&&item.python&&item.contractHash===contractHash(seed))evidence.set(item.id,item);
      }
    } catch(error) {if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  }
  const queue=exampleSeeds.filter(seed=>!evidence.has(seed.id)&&(!flags.get("--prefix")||seed.id.startsWith(flags.get("--prefix")!))).slice(0,limit);
  console.log(`Validating ${queue.length} projects; retained ${evidence.size} unchanged; ${concurrency} workers. External calls blocked.`);
  await Promise.all(Array.from({length:concurrency},async()=>{
    for(;;) {
      const seed=queue.shift();if(!seed)break;
      try {await validate(seed);}catch(error){failures.push({id:seed.id,error:error instanceof Error?error.message:String(error)});console.error(`FAIL ${seed.id}: ${failures.at(-1)!.error.slice(0,1200)}`);}
      completed++;if(completed%10===0){console.log(`Validated ${completed}; pass=${evidence.size}; failures=${failures.length}`);await persist();}
    }
  }));
  await persist();
  console.log(`PASS ${evidence.size} projects, ${[...evidence.values()].reduce((n,item)=>n+item.checks,0)} checks; failed ${failures.length}. External model/MCP calls: 0.`);
  if(failures.length)process.exitCode=1;
}finally {
  await writeQueue;await lock.close();await rm(lockPath,{force:true});
  assert.ok(resolve(temporary).startsWith(resolve(tmpdir())+sep+"flowly-catalog-"));await rm(temporary,{recursive:true,force:true});
}
