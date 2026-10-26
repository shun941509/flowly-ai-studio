/**
 * 현재 소스 지문·설계·시나리오·두 언어 ZIP 해시가 맞는 실행 증거만 공개 검증 배지로 반영한다. 과거 통과 기록을 그대로 재사용하지 않는다.
 */
/** Publish a local-validation badge only for current, complete two-language evidence. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workflowDesigns } from "../domain/workflow-designs";
import published from "../domain/generated/workflow-designs.json";
import { isCurrentCheckpoint, reusable } from "../tests/workflow-export-integration";
import { catalogEvidenceFingerprint } from "./catalog-evidence.mjs";

export async function currentVerifiedWorkflowIds() {
  let value: unknown;
  try { value = JSON.parse(await readFile("examples/workflow-verification.json", "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (!isCurrentCheckpoint(value, await catalogEvidenceFingerprint())) return [];
  if (new Set(value.projects.map(p => p.id)).size !== value.projects.length) throw new Error("Duplicate workflow evidence IDs");
  const entries = new Map(value.projects.map(p => [p.id, p]));
  const records = new Map(published.map(p => [p.id, p]));
  const failed = new Set(value.failures.map(f => f.id));
  const verified: string[] = [];
  for (const design of workflowDesigns) {
    const entry = entries.get(design.id), record = records.get(design.id);
    if (entry && record && !failed.has(design.id) && await reusable(entry, design, record, resolve("outputs/workflows"))) verified.push(design.id);
  }
  return verified;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const verified = await currentVerifiedWorkflowIds();
  await writeFile("server/generated/catalog-verification.ts", `// Current source, scenarios, configuration and both ZIP hashes were checked. No live-model claim.\nexport const catalogVerification:string[]=${JSON.stringify(verified)};\nexport const catalogReviewed:string[]=[];\n`);
  console.log(`Current two-language workflow evidence: ${verified.length}/${workflowDesigns.length}.`);
}
