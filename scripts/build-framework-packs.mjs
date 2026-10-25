import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile, lstat, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root=fileURLToPath(new URL("../examples/frameworks/",import.meta.url));
await mkdir(root,{recursive:true});
const packs=[];
const realRoot=await realpath(root);
for(const name of (await readdir(root)).sort()) {
  const directory=resolve(root,name);if(!(await lstat(directory)).isDirectory())continue;
  const realDirectory=await realpath(directory);if(!realDirectory.startsWith(realRoot+sep))throw new Error("Package directory escapes root");
  const manifest=JSON.parse(await readFile(resolve(directory,"manifest.json"),"utf8"));
  if(manifest.id!==name||!/^[-a-z0-9]+$/.test(name)||!["native","platform"].includes(manifest.kind)||!Array.isArray(manifest.files)||manifest.files.length>40)throw new Error(`Invalid framework manifest: ${name}`);
  const files={};
  for(const filename of manifest.files) {
    if(typeof filename!=="string"||filename.startsWith("/")||filename.includes("\\")||filename.split("/").some(p=>!p||p===".."||p==="."||p==="node_modules"||(p.startsWith(".")&&![".env.example",".gitignore"].includes(p)))||(/(^|\/)\.env/.test(filename)&&filename!==".env.example"))throw new Error(`Unsafe package path: ${name}/${filename}`);
    const path=resolve(directory,filename);if(!path.startsWith(directory+sep)||(await lstat(path)).isSymbolicLink()||!(await realpath(path)).startsWith(realDirectory+sep))throw new Error("Unsafe package file");
    const content=await readFile(path,"utf8");
    if(content.length>1_000_000||/sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{35,}/.test(content)||/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content))throw new Error(`Possible secret/oversized file: ${filename}`);
    files[filename]=content;
  }
  if(!files[manifest.entrypoint]||!files["README.md"])throw new Error(`Missing entrypoint/readme: ${name}`);
  const metadata=Object.fromEntries(["id","framework","language","kind","projectId","title","description","entrypoint","verification"].map(key=>[key,manifest[key]]));
  packs.push({...metadata,files});
}
const output=fileURLToPath(new URL("../server/generated/framework-packs.ts",import.meta.url));await mkdir(dirname(output),{recursive:true});
await writeFile(output,`// Generated from explicitly allowed example files. Do not edit.\nimport type { FrameworkVariant } from '../../domain/example-types';\nexport const frameworkPacks: (FrameworkVariant & {files:Record<string,string>})[] = ${JSON.stringify(packs)};\n`);
const compiled=spawnSync(process.execPath,[fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs",import.meta.url)),fileURLToPath(new URL("./build-workflow-designs.ts",import.meta.url))],{stdio:"inherit",windowsHide:true});
if(compiled.status!==0)throw new Error("Executable workflow compilation failed");
const badges=spawnSync(process.execPath,[fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs",import.meta.url)),fileURLToPath(new URL("./build-workflow-badges.ts",import.meta.url))],{stdio:"inherit",windowsHide:true});
if(badges.status!==0)throw new Error("Current workflow evidence validation failed");
console.log(`Bundled ${packs.length} framework variants. External model calls: 0.`);
