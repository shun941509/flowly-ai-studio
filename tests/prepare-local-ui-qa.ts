import { extractExportEntries } from "./export-zip";
/** Prepare an isolated, model-free native export for interactive browser QA. */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { unzipSync } from "fflate";
import { templateWorkflow } from "../app/lib/model";
import { buildExportPackage } from "../server/export-package";
import { exportRunnerSource, exportOperationsSource, exportLocalSource, exportOperationsGuide } from "../server/generated/export-runner";
const folder=resolve("outputs",`local-ui-qa-${Date.now()}`);
const workflow=templateWorkflow("human-review");workflow.name="로컬 검토 화면 QA";
const bytes=await buildExportPackage({user:{userId:"local-ui-qa",email:"qa@example.com",displayName:"로컬 QA"},workflow,connections:[],resolveResources:async()=>[],runnerSource:exportRunnerSource,operations:{ops:exportOperationsSource,local:exportLocalSource,guide:exportOperationsGuide}});
await mkdir(folder,{recursive:true});await extractExportEntries(folder,unzipSync(bytes));
console.log(folder);
