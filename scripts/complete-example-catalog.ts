/**
 * 감사와 현재 실행 증거를 합쳐 예제 인벤토리/문서를 갱신한다. 일부 검증 통과와 전체 목표 달성을 구분하고 미달이면 종료 코드로 알린다.
 */
/** Count executable designs, never the legacy prompt-only scenario inventory. */
import { readFile, writeFile } from "node:fs/promises";
import { auditWorkflowDesigns, sha256 } from "./audit-examples";
import { catalogEvidenceFingerprint } from "./catalog-evidence.mjs";
import { workflowDesigns } from "../domain/workflow-designs";
import { reusable, type EvidenceEntry } from "../tests/workflow-export-integration";
import { hasExplicitAgent } from "../domain/example-publication";
import { summarizeCatalogPublication } from "./catalog-publication-summary";

type Evidence = { version: number; fingerprint: string; scope: string; projects: EvidenceEntry[]; checks: number; failures: { id: string; message: string }[]; externalCalls: number };
const audit = await auditWorkflowDesigns();
const problems: string[] = audit.failures.map(failure => `${failure.kind}: ${failure.ids.join(", ")}: ${failure.detail}`);
let evidence: Evidence | undefined;
let evidenceCurrent = false;
const runtimeFingerprint = await catalogEvidenceFingerprint();
try {
  const value = JSON.parse(await readFile("examples/workflow-verification.json", "utf8")) as Evidence;
  if (value.version !== 1 || typeof value.fingerprint !== "string" || !Array.isArray(value.projects) || !Array.isArray(value.failures) || !Number.isInteger(value.checks) || value.checks < 0 || value.externalCalls !== 0) throw new Error("현재 로컬 검증 기록 형식이 아닙니다.");
  if (value.failures.some(failure => !failure || typeof failure.id !== "string" || typeof failure.message !== "string")) throw new Error("실패 기록 형식이 올바르지 않습니다.");
  if (value.projects.some(entry => !entry || typeof entry.id !== "string" || typeof entry.designHash !== "string" || typeof entry.executionHash !== "string" || !Array.isArray(entry.checks) || entry.checks.some(check => !check || !["node", "python"].includes(check.language) || typeof check.scenario !== "string" || typeof check.status !== "string" || !Number.isInteger(check.modelCalls) || check.modelCalls < 0))) throw new Error("프로젝트별 실행 증거 형식이 올바르지 않습니다.");
  if (new Set(value.projects.map(entry => entry?.id)).size !== value.projects.length) throw new Error("검증 기록에 중복 ID가 있습니다.");
  evidence = value;
  evidenceCurrent = value.fingerprint === runtimeFingerprint;
  if (!evidenceCurrent) problems.push("실행기/검증 코드 지문이 바뀌어 이전 실행 증거가 만료됐습니다.");
  if (value.failures.length) problems.push(`내보내기 실행 검증 실패 ${value.failures.length}건이 남았습니다.`);
} catch (error) {
  problems.push(`현재 워크플로 실행 증거를 사용할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`);
}
const checked = new Map((evidence?.projects ?? []).map(entry => [entry.id, entry]));
const failedIds = new Set(evidence?.failures.map(failure => failure.id) ?? []);
const inventory = [];
for (const record of audit.inventory) {
  const design = workflowDesigns.find(item => item.id === record.id)!;
  const entry = checked.get(record.id);
  const issues: string[] = [];
  if (failedIds.has(record.id)) issues.push("현재 검증 보고서에 이 설계의 실패 기록이 남아 있습니다.");
  const artifacts: { language: string; path: string; bytes: number; sha256: string }[] = [];
  if (!evidenceCurrent || !entry) issues.push("현재 지문의 Node.js/Python 실행 증거가 없습니다.");
  if (entry && evidenceCurrent) {
    if (!(await reusable(entry, design, record, "outputs/workflows"))) issues.push("설정 검사·전체 시나리오·ZIP을 포함한 현재 두 언어 증거가 일치하지 않습니다.");
    if (entry.designHash !== record.designHash || entry.executionHash !== record.executionHash) issues.push("설계/실행 그래프 해시가 바뀌었습니다.");
    if (entry.node !== true || entry.python !== true) issues.push("두 언어 실행을 모두 통과하지 않았습니다.");
    if (!Array.isArray(entry.checks) || entry.checks.length !== design.scenarios.length * 2) issues.push("정상·경계 시나리오 실행 기록이 부족합니다.");
    else {
      for (const language of ["node", "python"] as const) for (const scenario of design.scenarios) {
        const matching = entry.checks.filter(check => check.language === language && check.scenario === scenario.name);
        if (matching.length !== 1 || matching[0].status !== scenario.status || !Number.isInteger(matching[0].modelCalls) || matching[0].modelCalls < 0) issues.push(`${language}/${scenario.name}: 시나리오 증거가 없거나 기대 상태와 다릅니다.`);
      }
    }
    for (const language of ["node", "python"] as const) {
      const path = `outputs/workflows/${record.id}-${language}.zip`;
      try {
        const bytes = await readFile(path), hash = sha256(bytes);
        if (!entry.zipHashes || entry.zipHashes[language] !== hash) throw new Error("ZIP 해시가 실행 증거와 다릅니다.");
        artifacts.push({ language, path, bytes: bytes.length, sha256: hash });
      } catch (error) { issues.push(`${language}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  const verified = issues.length === 0;
  const hasAgent=hasExplicitAgent(design.definition);
  inventory.push({ ...record, hasAgent, classification: hasAgent ? "agent" : "supporting", verified, issues, checks: verified ? entry!.checks.length + 2 : 0, artifacts: verified ? artifacts : [] });
  if (!verified) problems.push(`${record.id}: ${issues.join(" / ")}`);
}
const verified = inventory.filter(item => item.verified);
const counts=summarizeCatalogPublication(inventory,audit.target);
if(!counts.publication.targetReached)problems.push(`AI Agent 예제 ${counts.publication.agentExamples}개(구조 ${counts.publication.agentTopologyGroups}개·실행 설정 ${counts.publication.agentExecutionGroups}개)/${audit.target}개 목표: ${counts.publication.remainingAgentExamples}개가 남았습니다. 보조 흐름 ${counts.publication.supportingFlows}개는 목표 수에 더하지 않습니다.`);
const localChecks = verified.reduce((sum, item) => sum + item.checks, 0);
// Each CLI has one configuration check plus its recorded scenario checks.
if (evidenceCurrent && evidence && evidence.failures.length === 0 && evidence.projects.length === inventory.length && localChecks !== evidence.checks) problems.push("실행 증거의 전체 검사 수와 프로젝트별 집계가 다릅니다.");
if (evidence?.projects.some(entry => !audit.inventory.some(item => item.id === entry.id))) problems.push("실행 증거에 현재 설계 목록에 없는 ID가 있습니다.");
const sourceEvidenceComplete=evidenceCurrent&&!!evidence&&evidence.failures.length===0&&verified.length===audit.projects&&evidence.projects.length===inventory.length&&localChecks===evidence.checks&&evidence.projects.every(entry=>audit.inventory.some(item=>item.id===entry.id));
const complete = problems.length === 0 && sourceEvidenceComplete && counts.publication.targetReached;
const report = {
  version: 3,
  generatedAt: new Date().toISOString(),
  status: complete ? "complete" : "incomplete",
  scope: "Source graph regression coverage and explicitly classified Agent publication target are separate; no semantic uniqueness, human review or live model quality claim",
  countingContract: "Legacy projects/topologyGroups/executionGroups/verifiedProjects count all source graphs. target/remainingDesigns count only structurally distinct explicit-Agent examples. Prefer source/publication fields.",
  source: counts.source,
  publication: counts.publication,
  sourceEvidenceComplete,
  projects: audit.projects,
  target: audit.target,
  topologyGroups: audit.topologyGroups,
  executionGroups: audit.executionGroups,
  remainingDesigns: counts.publication.remainingAgentExamples,
  verifiedProjects: verified.length,
  exportedZips: verified.reduce((sum, item) => sum + item.artifacts.length, 0),
  localChecks,
  independentGraphReviewAttested: false,
  humanReviewed: false,
  actualModelCalls: 0,
  actualRemoteMcpCalls: 0,
  liveAnswerQualityVerified: false,
  sourceFingerprint: audit.fingerprint,
  runtimeFingerprint,
  evidenceCurrent,
  baseline: audit.baseline,
  supersedes: { status: "invalidated", files: ["examples/catalog-verification.json", "examples/catalog-review.json", "examples/catalog-reviews/", "outputs/catalog/"], reason: "These tested/reviewed scenario text contracts built from shared patterns; they do not certify independent executable workflows or current exports." },
  problems,
  inventory,
};
await writeFile("examples/catalog-inventory.json", JSON.stringify(report, null, 2) + "\n");
await writeFile("docs/EXAMPLE_CATALOG_INVENTORY.md", `# AI Agent 예제와 소스 검증 집계 — ${complete ? "수량·로컬 실행 기준 충족" : "미완료"}\n\n갱신: ${report.generatedAt}\n\n현재 소스는 **${report.source.graphs}개 그래프**(구조 ${report.source.topologyGroups}개·실행 설정 ${report.source.executionGroups}개)입니다. 기본 공개 AI Agent 예제 **${report.publication.agentExamples}개**와 별도 보조 흐름 **${report.publication.supportingFlows}개**로 구분합니다. AI Agent 예제 목표 ${report.target.toLocaleString("ko-KR")}개까지 **${report.publication.remainingAgentExamples.toLocaleString("ko-KR")}개가 남았습니다**. 보조 흐름은 이 목표 수에 더하지 않습니다. 기존 문구 중심 시나리오 3,200개를 독립 워크플로 완료로 집계한 주장은 철회합니다.\n\n현재 소스·실행기 지문과 ZIP 해시까지 맞는 두 언어 검증은 소스 그래프 **${report.source.verifiedGraphs}개**입니다. 이 중 AI Agent 예제 **${report.publication.verifiedAgentExamples}개**, 보조 흐름 **${report.publication.verifiedSupportingFlows}개**이며, ZIP **${report.exportedZips}개**, 로컬 검사 **${report.localChecks}개**입니다. 현재 전체 소스 증거: **${report.sourceEvidenceComplete ? "현재 소스 전체 일치" : "진행 중·실패·만료 또는 누락"}**. 전체 소스 검증과 3,200개 목표 달성은 서로 다른 판정입니다. 검증 대기·실패·만료 항목은 이 수에 더하지 않습니다.\n\n## 이전 집계의 범위\n\n기존 ${report.baseline.projects}개 시나리오를 비교하면 구조 ${report.baseline.topologyGroups}개·실행 설정 ${report.baseline.executionGroups}개 그룹입니다. examples/workflow-identity-before.json에 전체 그룹과 ID를 보존합니다. 이전 catalog-verification.json, catalog-review.json, catalog-reviews/와 outputs/catalog/는 당시 문구 계약 검사 기록이며 현재 독립 워크플로 완료 증거로 사용하지 않습니다.\n\n## 현재 설계\n\n|설계|공개 분류|정상·경계 시나리오 수|현재 두 언어 검증|\n|---|---|---:|---|\n${inventory.map(item => `|${item.id}|${item.hasAgent ? "AI Agent" : "보조 흐름"}|${item.scenarios}|${item.verified ? "통과" : "대기/실패/만료"}|`).join("\n")}\n\n## 검사 기준과 한계\n\n- 원본: domain/workflow-designs/의 개별 정의. 제목·프롬프트·문서·모델명만 다른 변형은 독립 구현 수에서 제외합니다.\n- 구조/설정: domain/workflow-identity.ts와 examples/catalog-audit.json. 서로 다른 서명만으로 유용성·의미 고유성이 증명되지는 않습니다.\n- 실행: examples/workflow-verification.json. 실제 Node.js/Python ZIP의 CLI에서 분기·입출력·오류·상태 시나리오를 검사하며 모델·임베딩·MCP HTTP 응답을 ZIP 밖의 테스트 경계에서 주입합니다.\n- 산출물: outputs/workflows/. 현재 설계·실행 해시, 실행기 지문, 시나리오 기록, 두 ZIP의 SHA-256을 대조합니다.\n- 실제 OpenAI·원격 MCP 호출 0회. 실제 모델 정답률과 실계정 연결은 미검증입니다. 테스트 응답을 실제 AI 결과로 제공하지 않습니다.\n- 새 그래프에 대한 독립 검토나 인간 검수 완료를 이 자동 집계가 인증하지 않습니다.\n\n## 완료 판정\n\n상태: **${report.status}**. pnpm catalog:complete는 부분 집계를 기록하더라도 명시적 Agent를 포함한 ${report.target}개 서로 다른 구조·실행 설정 그룹과 현재 전체 소스의 두 언어 증거를 갖추지 못하면 종료 코드 1을 반환합니다.\n\n${problems.length ? problems.map(problem => `- ${problem}`).join("\n") : "구조·수량·현재 로컬 실행 증거의 검사 조건을 충족했습니다. 의미 고유성과 실제 모델 품질은 별도 검토 대상입니다."}\n`);
console.log(JSON.stringify({ status: report.status, source: report.source, publication: report.publication, sourceEvidenceComplete: report.sourceEvidenceComplete, exportedZips: report.exportedZips, localChecks: report.localChecks, remainingDesigns: report.remainingDesigns, problems: report.problems, externalCalls: 0 }, null, 2));
if (!complete) process.exitCode = 1;
