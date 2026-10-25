/** Primary audit of executable designs. Different signatures are not semantic proof. */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { compileDefinition } from "../domain/workflow";
import { validateGraph } from "../app/lib/model";
import { workflowDesigns } from "../domain/workflow-designs";
import { groupWorkflowIdentities, workflowIdentity } from "../domain/workflow-identity";
import { EXAMPLE_TARGET } from "../domain/example-types";
import type { WorkflowDesign } from "../domain/workflow-design";

// Matches build-workflow-designs.ts without importing the legacy compiler,
// which regenerates its authored-text index as an import side effect.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export async function auditWorkflowDesigns(designs: readonly WorkflowDesign[] = workflowDesigns) {
  const failures: { kind: string; ids: string[]; detail: string }[] = [];
  const ids = new Set<string>();
  const valid = [];
  const records = [];
  for (const design of designs) {
    if (!/^[-a-z0-9]+$/.test(design.id) || ids.has(design.id)) {
      failures.push({ kind: "id", ids: [design.id], detail: "Invalid or duplicate workflow ID" }); continue;
    }
    ids.add(design.id);
    try {
      const definition = compileDefinition(design.definition), errors = validateGraph(definition, design.resources);
      if (errors.length) throw new Error(errors.join(" / "));
      const identity = workflowIdentity(definition);
      if (design.scenarios.length < 2) throw new Error("Normal and boundary/failure scenarios are required");
      valid.push({ id: design.id, definition });
      records.push({ id: design.id, title: design.title, category: design.category, designHash: sha256(canonical(design)), topologyHash: sha256(identity.topology), executionHash: sha256(identity.execution), scenarios: design.scenarios.length, nodes: definition.nodes.length, edges: definition.edges.length });
    } catch (error) {
      failures.push({ kind: "graph", ids: [design.id], detail: error instanceof Error ? error.message : String(error) });
    }
  }
  const groups = groupWorkflowIdentities(valid).map(group => ({ topologyHash: sha256(group.topology), executionHash: sha256(group.execution), ids: group.ids, count: group.ids.length }));
  const duplicates = groups.filter(group => group.ids.length > 1);
  for (const group of duplicates) failures.push({ kind: "equivalent_execution", ids: group.ids, detail: "Same executable graph/configuration after excluding display text, prompts, document IDs and model names" });
  const topology = new Map<string, string[]>();
  for (const record of records) topology.set(record.topologyHash, [...(topology.get(record.topologyHash) ?? []), record.id]);
  const topologyGroups = [...topology].map(([topologyHash, groupIds]) => ({ topologyHash, ids: groupIds.sort(), count: groupIds.length }));
  const topologyDuplicates = topologyGroups.filter(group => group.count > 1);
  for (const group of topologyDuplicates) failures.push({ kind: "equivalent_topology", ids: group.ids, detail: "Same directed typed control structure; different settings are case variants rather than independent catalog designs" });
  const previous = JSON.parse(await readFile("examples/workflow-identity-before.json", "utf8")) as { projects: number; topologyGroups: number; executionGroups: number };
  const baseline = { projects: previous.projects, topologyGroups: previous.topologyGroups, executionGroups: previous.executionGroups, path: "examples/workflow-identity-before.json", status: "historical_scenarios_not_independent_implementations" };
  return {
    version: 2,
    source: "domain/workflow-designs/index.ts",
    scope: "Directed typed control graph, branch routes, explicit input mappings, nested definitions and execution configuration. ID/title/prompt/document/model-name variants do not count. Different signatures are not proof of useful or semantic uniqueness.",
    projects: designs.length,
    validProjects: records.length,
    target: EXAMPLE_TARGET,
    topologyGroups: topology.size,
    executionGroups: groups.length,
    remainingDesigns: Math.max(0, EXAMPLE_TARGET - Math.min(topology.size, groups.length)),
    fingerprint: sha256(canonical(records.map(({ id, designHash }) => ({ id, designHash })).sort((a, b) => a.id.localeCompare(b.id)))),
    status: failures.length ? "failed" : "passed",
    completionStatus: "not_determined_by_audit",
    externalCalls: 0,
    baseline,
    failures,
    duplicates,
    topologyDuplicates,
    groups,
    topology: topologyGroups,
    inventory: records,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await auditWorkflowDesigns();
  await writeFile("examples/catalog-audit.json", JSON.stringify(report, null, 2) + "\n");
  await writeFile("examples/catalog-audit-review.md", `# 실행 워크플로 중복 검사\n\n현재 개별 설계 ${report.projects}개: 구조 그룹 ${report.topologyGroups}개, 실행 설정 그룹 ${report.executionGroups}개, 같은 구조 중복 ${report.topologyDuplicates.length}건, 같은 실행 설정 중복 ${report.duplicates.length}건. 목표 ${report.target}개 중 ${report.remainingDesigns}개 재설계가 남았습니다. **감사 통과는 전체 구현 완료를 뜻하지 않습니다.**\n\n이전 ${report.baseline.projects}개는 시나리오 계약이며 구조 ${report.baseline.topologyGroups}개·실행 설정 ${report.baseline.executionGroups}개 그룹으로 묶였습니다. 이전 어휘 검사와 AI 계약 검토는 독립 실행 그래프의 증거가 아닙니다. 기준선은 examples/workflow-identity-before.json에 보존합니다.\n\nID·제목·설명·좌표·프롬프트·문서 ID·모델명은 제외합니다. 연결 방향, 분기, 입력 매핑, 중첩 작업, 조건 및 실행 설정을 비교합니다. 사용되지 않는 노드나 정확 비교 한도를 넘는 그래프는 거절합니다. 같은 구조의 설정 변형도 별도 독립 설계로 집계하지 않습니다. 서로 다른 서명이 유용성·의미 고유성을 증명하지는 않습니다.\n\n|실행 그룹|포함 설계|\n|---|---|\n${report.groups.map(group => `|${group.executionHash.slice(0, 12)}|${group.ids.join(", ")}|`).join("\n")}\n\n실패: ${report.failures.length}건. 외부 API 호출: 0회. 상세: examples/catalog-audit.json.\n`);
  console.log(JSON.stringify({ projects: report.projects, topologyGroups: report.topologyGroups, executionGroups: report.executionGroups, duplicates: report.duplicates.length, topologyDuplicates: report.topologyDuplicates.length, failures: report.failures, remainingDesigns: report.remainingDesigns, completionStatus: report.completionStatus, externalCalls: 0 }, null, 2));
  if (report.failures.length) process.exitCode = 1;
}
