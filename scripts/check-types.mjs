/**
 * 내보내기/예제 생성물을 먼저 갱신한 뒤 설치된 TypeScript로 전체 타입을 검사한다. 단순 tsc 실행과 달리 생성 파일 갱신 부작용이 있다.
 */
import "./build-export-runner.mjs";
import "./build-framework-packs.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const result=spawnSync(process.execPath,[fileURLToPath(new URL("../node_modules/typescript/bin/tsc",import.meta.url)),"--noEmit","--incremental","false"],{stdio:"inherit",windowsHide:true});
if(result.error)throw result.error;
process.exitCode=result.status??1;
