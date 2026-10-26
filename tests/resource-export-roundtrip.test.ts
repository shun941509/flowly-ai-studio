import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { FlowNode, Resource, Workflow } from "../app/lib/model";
import type { ResourceAttachment } from "../domain/resource-contract";
import { resourceFileHash, exportedAttachment, safeResourceFilePath } from "../domain/resource-export";
import { importedResourceDiff, parseWorkflowImport, readWorkflowImport, rebindImportedWorkflow } from "../domain/workflow-import";
import { buildExportManifest, buildExportPackage, ExportPackageError } from "../server/export-package";
import { buildExecutableExportPackage } from "../server/export-assets";
import { buildCopyPrompt } from "../server/export-ai-documents";
import { extractExportEntries } from "./export-zip";

const date="2026-10-27T00:00:00.000Z";
const user={userId:"package-owner",email:"package@example.test",displayName:"패키지 검증"};
const bob={userId:"package-reader",email:"reader@example.test",displayName:"읽는 사용자"};
const resource=(id:string,type:Resource["type"],content="등록한 자료"):Resource=>({id,type,content,name:id,description:"자료 패키지 검증",url:"",ownerId:user.userId,visibility:"private",allowedEmails:[],createdAt:date,updatedAt:date});
const file=(id:string,path:string,bytes:Uint8Array):ResourceAttachment=>({id,path,mimeType:path.endsWith(".pdf")?"application/pdf":"text/plain",size:bytes.byteLength,sha256:createHash("sha256").update(bytes).digest("hex"),createdAt:date});
const graph=(resources:Resource[]):Workflow=>{
 const nodes:FlowNode[]=[{id:"input",type:"input",title:"입력",x:0,y:0},...resources.map((r,i):FlowNode=>({id:r.id,type:r.type==="skill"?"skill":"resource",title:r.name,x:(i+1)*240,y:0,resourceId:r.id})),{id:"output",type:"output",title:"결과",x:1000,y:0}];
 return {id:"package-flow",name:"자료 전달 프로젝트",description:"AI 서비스 없이 자료를 전달합니다.",updatedAt:date,definition:{schemaVersion:5,nodes,edges:nodes.slice(1).map((node,i)=>({id:"edge"+i,source:nodes[i].id,target:node.id}))}};
};
function fixture(){
 // Buffer subarrays intentionally exercise slab/byte-offset hashing and binary files.
 const code=Buffer.from("prefix\nprint('manual only')\nsuffix").subarray(7,28),pdf=Buffer.from([37,80,68,70,0,255,12,19]);
 const skill:Resource={...resource("skill-package","skill","[참고 코드](scripts/helper.py)를 확인하세요."),files:[file("code","scripts/helper.py",code)],details:{version:1,purpose:"계산 지침과 참고 코드",skill:{kind:"package"}}};
 const document:Resource={...resource("document","document","문서 본문"),files:[file("original","originals/source.pdf",pdf)],details:{version:1,document:{source:"사내 문서",extractionStatus:"provided",originalFileId:"original",extractedText:"제공된 추출 텍스트"}}};
 const resources=[skill,document];
 return {resources,code,pdf,options:{user,workflow:graph(resources),connections:[],resolveResources:async()=>resources,resolveResourceFiles:async()=>[{resourceId:skill.id,file:skill.files![0],bytes:code},{resourceId:document.id,file:document.files![0],bytes:pdf}],exportedAt:date,runnerSource:"# synthetic packaging-only source; not executed"}};
}

test("resource paths and hashing preserve exact Buffer slices without storage metadata",async()=>{
 const bytes=Buffer.from("unrelated-selected-unrelated").subarray(10,18);
 assert.equal(await resourceFileHash(bytes),createHash("sha256").update(bytes).digest("hex"));
 for(const path of ["../outside",".env",".env.local","folder\\secret","C:/secret","a/../b","NUL.txt","private.pem"])assert.equal(safeResourceFilePath(path),false,path);
 assert.equal(safeResourceFilePath("references/사용법.md"),true);
 const r=resource("skill","skill"),attachment=file("a","scripts/example.py",bytes);
 const exported=exportedAttachment([r],r.id,Object.assign(attachment,{storageKey:"PRIVATE_STORE"}));
 assert.match(exported.exportPath!,/^skills\/flowly-skill-001-skill\/scripts\/example.py$/);
 assert.doesNotMatch(JSON.stringify(exported),/PRIVATE_STORE|storageKey/);
 assert.throws(()=>exportedAttachment([r],r.id,{...attachment,path:"SKILL.md"}),/SKILL.md/);
});

test("attachment export requires configured storage, consistent bytes, current permission and version",async()=>{
 const f=fixture();
 await assert.rejects(buildExportManifest({...f.options,resolveResourceFiles:undefined}),e=>e instanceof ExportPackageError&&e.status===503);
 const payloads=await f.options.resolveResourceFiles();
 await assert.rejects(buildExportPackage({...f.options,resolveResourceFiles:async()=>[]}),/삭제되었거나 변경/);
 await assert.rejects(buildExportPackage({...f.options,resolveResourceFiles:async()=>[...payloads,payloads[0]]}),/삭제되었거나 변경/);
 await assert.rejects(buildExportPackage({...f.options,resolveResourceFiles:async()=>payloads.map((p,i)=>i? p:{...p,bytes:Buffer.from("changed")})}),/경로·크기·내용/);
 let calls=0;
 await assert.rejects(buildExportPackage({...f.options,resolveResources:async()=>++calls===1?f.resources:f.resources.map(r=>({...r,updatedAt:"2026-10-28T00:00:00.000Z"}))}),e=>e instanceof ExportPackageError&&e.status===409);
 calls=0;
 await assert.rejects(buildExportPackage({...f.options,user:bob,resolveResources:async()=>++calls===1?f.resources.map(r=>({...r,visibility:"selected" as const,allowedEmails:[bob.email]})):f.resources}),e=>e instanceof ExportPackageError&&e.status===403);
});

test("both packages preserve selected binary/Skill files, metadata, guides and immutable comparison hashes",async()=>{
 const f=fixture();
 for(const language of ["node","python"] as const){
  const files=unzipSync(await buildExportPackage({...f.options,language,kind:"agent"}));
  const manifest=JSON.parse(strFromU8(files["workflow.json"]));
  assert.deepEqual(manifest.resourcePackage,{version:1});
  assert.equal(manifest.version,1);
  const skill=manifest.resources[0],document=manifest.resources[1];
  assert.match(skill.files[0].exportPath,/^skills\/flowly-skill-001-skill-package\/scripts\/helper.py$/);
  assert.match(document.files[0].exportPath,/^inputs\/resources\/resource-002-document\/originals\/source.pdf$/);
  assert.deepEqual(Buffer.from(files[skill.files[0].exportPath]),f.code);
  assert.deepEqual(Buffer.from(files[document.files[0].exportPath]),f.pdf);
  assert.ok(files["RESOURCE_GUIDE.md"]);assert.ok(files["Agent.md"]);
  assert.match(strFromU8(files["CORE_TERMS.md"]),/블록 가이드/);
  assert.match(strFromU8(files["RESOURCE_GUIDE.md"]),/OS 보안 샌드박스가 아니며/);
  assert.match(buildCopyPrompt(manifest),/RESOURCE_GUIDE.md/);
  assert.equal(JSON.parse(strFromU8(files["agent-manifest.json"])).agents.length,0);
  const inventory=JSON.parse(strFromU8(files["PROJECT_FILES.json"]));
  assert.equal(inventory.files[document.files[0].exportPath],document.files[0].sha256);
  const imported=await readWorkflowImport("project.zip",zipSync(files));
  assert.equal(imported.integrity,"matched");
  assert.equal(imported.resourceChanges.length,2);
  assert.ok(imported.resourceChanges.every(candidate=>candidate.files.every(item=>item.state==="unchanged")));
  assert.equal(imported.resourceChanges[0].data.visibility,"private");
  assert.deepEqual(imported.resourceChanges[0].data.allowedEmails,[]);
 }
});

test("external resource changes stay distinct from runner edits and never restore ACL or run state",async()=>{
 const f=fixture(),entries=unzipSync(await buildExportPackage(f.options)),manifest=JSON.parse(strFromU8(entries["workflow.json"]));
 manifest.resources[0].content="수정된 작업 지침";manifest.resources[0].ownerId="attacker";manifest.resources[0].visibility="public";manifest.resources[0].allowedEmails=["nobody@example.test"];
 manifest.run={status:"succeeded",approval:true};
 const codePath=manifest.resources[0].files[0].exportPath;
 entries[codePath]=strToU8("print('changed resource code')\n");entries["runner.mjs"]=strToU8("// independently changed runner");
 entries[".env"]=strToU8("NEVER_IMPORT_SECRET");entries[".flowly-runs/private.json"]=strToU8('{"key":"NEVER_IMPORT_RUN"}');
 entries["workflow.json"]=strToU8(JSON.stringify(manifest));
 const imported=await readWorkflowImport("modified.zip",zipSync(entries)),candidate=imported.resourceChanges[0];
 assert.equal(candidate.files[0].state,"modified");assert.equal(candidate.files[0].file.sha256,await resourceFileHash(entries[codePath]));
 assert.deepEqual(imported.codeChanges,["runner.mjs"]);
 assert.ok(imported.changedFiles.includes(codePath));
 assert.equal(candidate.data.visibility,"private");assert.deepEqual(candidate.data.allowedEmails,[]);
 assert.doesNotMatch(JSON.stringify(imported),/attacker|nobody@example|NEVER_IMPORT_SECRET|NEVER_IMPORT_RUN|"approval":true/);
 const diff=importedResourceDiff(candidate,f.resources[0]);assert.ok(diff.fields.includes("content"));assert.deepEqual(diff.files,[{path:"scripts/helper.py",change:"modified"}]);
 const copy:Resource={...f.resources[0],...candidate.data,id:"my-copy",ownerId:user.userId,files:candidate.files.map(item=>item.file)};
 const rebound=rebindImportedWorkflow(imported,{[candidate.sourceResourceId]:copy.id},[copy,f.resources[1]]);
 assert.equal(rebound.definition.nodes[1].resourceId,copy.id);assert.equal(imported.workflow.definition.nodes[1].resourceId,f.resources[0].id);
});

test("JSON-only import, missing attachments and invalid package versions cannot silently pretend files were restored",async()=>{
 const f=fixture(),entries=unzipSync(await buildExportPackage(f.options)),manifest=JSON.parse(strFromU8(entries["workflow.json"]));
 const json=parseWorkflowImport(manifest);assert.equal(json.resourceChanges[0].files[0].state,"unavailable");assert.equal(json.resourceChanges[0].files[0].bytes,undefined);
 delete entries[manifest.resources[0].files[0].exportPath];
 assert.equal((await readWorkflowImport("missing.zip",zipSync(entries))).resourceChanges[0].files[0].state,"missing");
 assert.throws(()=>parseWorkflowImport({...manifest,resourcePackage:{version:2}}),/자료 묶음 버전/);
 assert.throws(()=>parseWorkflowImport({...manifest,resources:[...manifest.resources,manifest.resources[0]]}),/중복/);
 const unsafe=structuredClone(manifest);unsafe.resources[0].files[0].exportPath="runner.mjs";assert.throws(()=>parseWorkflowImport(unsafe),/경로/);
 const legacy=structuredClone(manifest);delete legacy.resourcePackage;assert.equal(parseWorkflowImport(legacy).resourceChanges.length,0);
});

test("Agentless text-resource ZIPs run, import changed content, rebind copies and run fresh Node/Python exports",async()=>{
 const folder=await mkdtemp(join(tmpdir(),"flowly-resource-roundtrip-"));
 const env:NodeJS.ProcessEnv={NODE_ENV:"test",...Object.fromEntries(["PATH","Path","SystemRoot","WINDIR","TEMP","TMP","PATHEXT"].flatMap(key=>process.env[key]?[[key,process.env[key]!]]:[]))};
 const python=process.platform==="win32"?"python":"python3";
 try{for(const language of ["node","python"] as const){
  const prompt=resource("instruction","prompt","처음 지시"),options={user,workflow:graph([prompt]),connections:[],resolveResources:async()=>[prompt],language,kind:"agent" as const,exportedAt:date};
  const entries=unzipSync(await buildExecutableExportPackage(options)),directory=join(folder,language);await mkdir(directory);await extractExportEntries(directory,entries);
  const run=(cwd:string)=>{const result=spawnSync(language==="node"?process.execPath:python,[...(language==="python"?["-X","utf8"]:[]),language==="node"?"agent.mjs":"agent.py","run","--input","사용자 입력"],{cwd,env,encoding:"utf8",timeout:30000,windowsHide:true});assert.equal(result.status,0,result.stderr||result.stdout);const value=JSON.parse(result.stdout);assert.equal(value.status,"succeeded");return value;};
  const before=run(directory);assert.match(before.result,/처음 지시/);
  const manifest=JSON.parse(strFromU8(entries["workflow.json"]));manifest.resources[0].content="수정된 지시";entries["workflow.json"]=strToU8(JSON.stringify(manifest));
  const imported=await readWorkflowImport("edited.zip",zipSync(entries)),copy:Resource={...prompt,...imported.resourceChanges[0].data,id:"new-resource"};
  const revised=rebindImportedWorkflow(imported,{instruction:copy.id},[copy]);revised.id="new-workflow";
  const afterEntries=unzipSync(await buildExecutableExportPackage({...options,workflow:revised,resolveResources:async()=>[copy]})),afterDirectory=join(directory,"revised");await mkdir(afterDirectory);await extractExportEntries(afterDirectory,afterEntries);
  const after=run(afterDirectory);assert.match(after.result,/수정된 지시/);assert.notEqual(after.id,before.id);
  assert.match(buildCopyPrompt(JSON.parse(strFromU8(afterEntries["workflow.json"]))),/수정된 지시/);
  assert.match(strFromU8(afterEntries["AI_PROMPT.md"]),/workflow.json/);
 }}finally{const inside=relative(resolve(tmpdir()),folder);assert.ok(inside&&!inside.startsWith("..")&&!isAbsolute(inside));await rm(folder,{recursive:true,force:true});}
});

