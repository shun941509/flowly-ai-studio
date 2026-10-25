import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
export async function catalogEvidenceFingerprint() {
  const root=fileURLToPath(new URL("../",import.meta.url));
  // Hash the bytes actually embedded in downloaded ZIPs as well as their sources.
  // A bundler/helper/dependency change can alter these without changing a TS file.
  const files=["tests/workflow-export-integration.ts","tests/export-zip.ts","tests/workflow-node-preload.mjs","tests/workflow-python-boundary.py","tests/p4-local-tools.py","server/generated/export-runner.ts","server/example-catalog.ts","server/example-export.ts","server/example-connections.ts","server/export-package.ts","server/export-ai-documents.ts","server/export-agent-package.ts","server/export-assets.ts","app/lib/model.ts","tests/example-export-integration.ts","tests/example-node-preload.mjs","tests/example-export-python.py","domain/tool-catalog.json","domain/completion-operations.json","export-runtime/tool-contracts.json"];
  // Authored contracts are hashed individually. A new batch does not invalidate
  // previously executed artifacts; any compiler/runtime/harness edit does.
  files.push("tests/seed-workflow-memory.py");
  files.push("server/export-execution.ts");
  async function walk(folder) { for(const entry of await readdir(join(root,folder),{withFileTypes:true})) {const child=join(folder,entry.name);if(entry.isDirectory()&&entry.name!=="__pycache__"&&!["domain/catalog","domain/workflow-designs"].includes(child.replaceAll("\\","/")))await walk(child);else if(entry.isFile()&&/\.(ts|py)$/.test(entry.name))files.push(child);} }
  for(const folder of ["domain","runtime","export-runtime"])await walk(folder);
  const hash=createHash("sha256");for(const file of files.sort())hash.update(relative(root,join(root,file)).replaceAll("\\","/")).update(await readFile(join(root,file)));
  return hash.digest("hex");
}
