import "./build-export-runner.mjs";
import "./build-framework-packs.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const result=spawnSync(process.execPath,[fileURLToPath(new URL("../node_modules/typescript/bin/tsc",import.meta.url)),"--noEmit","--incremental","false"],{stdio:"inherit",windowsHide:true});
if(result.error)throw result.error;
process.exitCode=result.status??1;
