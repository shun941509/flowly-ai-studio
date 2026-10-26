/**
 * 현재 실행기/설계 산출물을 만든 뒤 실제 내보내기 시나리오 하네스를 실행한다. 자식 환경은 허용한 운영 변수만 전달해 자격 증명을 상속하지 않는다.
 */
/** Build current artifacts before running all/filtered exported CLI scenarios. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root=fileURLToPath(new URL("../",import.meta.url));
const tsx=fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs",import.meta.url));
const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,PATHEXT:process.env.PATHEXT,NODE_ENV:"test",PYTHONUTF8:"1",PYTHONNOUSERSITE:"1"};
function run(script,args=[],typescript=false) {
  const filename=fileURLToPath(new URL(script,import.meta.url));
  const result=spawnSync(process.execPath,[...(typescript?[tsx]:[]),filename,...args],{cwd:root,env,stdio:"inherit",windowsHide:true});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}
const args=process.argv.slice(2);
if(!args.includes("--help")) {
  run("./build-export-runner.mjs");
  run("./build-workflow-designs.ts",[],true);
}
run("../tests/workflow-export-integration.ts",args,true);
