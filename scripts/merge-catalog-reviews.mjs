import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { allSeeds, contractHash } from "./build-example-catalog.mjs";
const directory=new URL("../examples/catalog-reviews/",import.meta.url);
await mkdir(directory,{recursive:true});
const target=new URL("../examples/catalog-review.json",import.meta.url);
const previous=JSON.parse(await readFile(target,"utf8"));
const current=new Map(allSeeds.map(seed=>[seed.id,contractHash(seed)]));
const entries=new Map(previous.reviewed.filter(item=>item.contractHash===current.get(item.id)).map(item=>[item.id,item]));
const rejected=[],reports=[];
for(const filename of (await readdir(directory)).filter(name=>name.endsWith(".json")).sort()) {
  const report=JSON.parse((await readFile(new URL(filename,directory),"utf8")).replace(/^\uFEFF/,""));
  if(report.version!==1||report.humanReviewed!==false||typeof report.reviewer!=="string"||!Array.isArray(report.reviewed)||!Array.isArray(report.rejected))throw new Error(`Invalid independent review: ${filename}`);
  const prefix=filename.startsWith("business-checks-technical")?"tech-":filename.startsWith("technical-checks-operations")?"ops-":filename.startsWith("operations-checks-business")||filename.startsWith("root-checks-business")?"biz-":undefined;
  if(!prefix)throw new Error(`Unassigned review ownership: ${filename}`);
  let retained=0;
  for(const item of report.reviewed) {
    if(!item.id?.startsWith(prefix)||!current.has(item.id))throw new Error(`Wrong review scope: ${filename}/${item.id}`);
    if(item.contractHash!==current.get(item.id))continue;
    entries.set(item.id,{...item,reviewer:report.reviewer});retained++;
  }
  for(const item of report.rejected) {if(!current.has(item.id))throw new Error(`Unknown rejected project: ${item.id}`);rejected.push({...item,reviewer:report.reviewer});}
  reports.push({file:filename,reviewer:report.reviewer,scope:report.scope,unchangedReviewed:retained});
}
for(const item of rejected)entries.delete(item.id);
await writeFile(target,JSON.stringify({version:2,reviewer:"independent-agent-review",humanReviewed:false,reports,reviewed:[...entries.values()].sort((a,b)=>a.id.localeCompare(b.id)),rejected},null,2)+"\n");
console.log(`Retained ${entries.size}/${allSeeds.length} current independent reviews; ${rejected.length} unresolved rejections.`);
