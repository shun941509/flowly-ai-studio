import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { configureToolEnvironment } from "./tool-environment.mjs";

// The pinned Cloudflare Vite module runner starts slowly in this Windows setup.
// Keep the same Vinext/Workers build and D1; rebuild source and let Wrangler reload.
const root=fileURLToPath(new URL("../",import.meta.url));
configureToolEnvironment(root);
let building=false,pending=false,server,timer,stopping=false;
const watchers=[];
function run(args) {
  return new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{cwd:root,stdio:"inherit",windowsHide:true});child.on("error",reject);child.on("exit",code=>resolve(code??1));});
}
async function build() {
  if(building){pending=true;return;}
  building=true;
  await stopServer(); // Windows holds the generated output directory open.
  const code=await run(["scripts/run-framework.mjs","build"]);
  building=false;
  if(code===0&&!server&&!stopping) {
    // With Worker assets, Miniflare's /cdn-cgi trigger targets the assets router.
    // --bundle overrides the Vite output's no_bundle setting so this middleware
    // exposes /__scheduled and dispatches the actual user handler.
    server=spawn(process.execPath,["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","dev","--config","dist/server/wrangler.json","--local","--bundle","--test-scheduled","--persist-to",".wrangler/state","--ip","127.0.0.1","--port","5173","--inspector-port","0","--log-level","warn"],{cwd:root,stdio:"inherit",windowsHide:true});
    const current=server;
    server.on("error",error=>{console.error(error.message);void stop();});
    server.on("exit",()=>{if(server===current&&!stopping)void stop();});
    console.log("Flowly 로컬 개발: http://127.0.0.1:5173 · 소스 변경 시 전체 재빌드 후 Worker가 다시 로드됩니다.");
  }
  if(code!==0)console.error("빌드에 실패했습니다. 소스를 수정하면 다시 빌드합니다.");
  if(pending&&!stopping){pending=false;await build();}
}
function changed(){clearTimeout(timer);timer=setTimeout(()=>void build().catch(error=>console.error(error.message)),600);}
async function stopServer(){
  const current=server;server=undefined;if(!current)return;
  if(process.platform==="win32")await new Promise(resolve=>{const killer=spawn("taskkill",["/PID",String(current.pid),"/T","/F"],{stdio:"ignore",windowsHide:true});killer.on("exit",resolve);killer.on("error",resolve);});
  else {current.kill("SIGTERM");await new Promise(resolve=>current.once("exit",resolve));}
}
async function stop(){stopping=true;clearTimeout(timer);for(const watcher of watchers)watcher.close();await stopServer();process.exitCode=0;}
process.on("SIGINT",stop);process.on("SIGTERM",stop);
for(const dir of ["app","components","db","domain","export-runtime","hooks","lib","public","runtime","server","worker"])watchers.push(watch(new URL(`../${dir}/`,import.meta.url),{recursive:true},(_event,filename)=>{if(dir==="server"&&String(filename).startsWith("generated"))return;changed();}));
for(const file of ["vite.config.ts","wrangler.jsonc","package.json"])watchers.push(watch(new URL(`../${file}`,import.meta.url),changed));
await build();
