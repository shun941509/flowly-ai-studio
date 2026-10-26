/**
 * 기술 근거·개발·DB 작업을 의존 계획으로 연결한 통합 팀 예제다. 실제 사내 서비스는 사용자가 구현/연결해야 하며 임의 SQL 실행 서버를 제공하는 패키지는 아니다.
 * 노드/연결/자료는 내려받을 설계이며 scenarios의 응답·상태 기대값은 테스트 전용이다.
 */
import type { Definition, FlowNode, Resource } from "../../app/lib/model";
import type { DataSchema, Json } from "../../runtime/types";
import type { WorkflowDesign, WorkflowScenario } from "../workflow-design";
import { serializeMcpRegistration } from "../mcp-registration";
import { layoutWorkflow } from "../workflow-layout";

const stamp = "2026-10-24T00:00:00Z";
const n = (id: string, type: FlowNode["type"], title: string, config: Partial<FlowNode> = {}): FlowNode => ({ id, type, title, x: 0, y: 0, ...config });
const b = (nodeId: string, path = "text") => ({ nodeId, path });
const graph = (nodes: FlowNode[], links: [string, string, string?][]): Definition => layoutWorkflow({ schemaVersion: 5, nodes, edges: links.map(([source, target, branch], i) => ({ id: `p4-e${i}`, source, target, ...(branch ? { branch } : {}) })) });
const objectSchema = (properties: Record<string, DataSchema>): DataSchema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const string: DataSchema = { type: "string" }, number: DataSchema = { type: "number" };
const toolSpecs: { name: string; effect: "read" | "write"; fields: Record<string, DataSchema> }[] = [
  { name: "inspect_code", effect: "read" as const, fields: { changeId: string } },
  { name: "prepare_code_change", effect: "read" as const, fields: { changeId: string, operation: string, sourceVersion: string } },
  { name: "apply_code_change", effect: "write" as const, fields: { changeId: string, artifactId: string } },
  { name: "verify_code", effect: "read" as const, fields: { changeId: string } },
  { name: "inspect_db", effect: "read" as const, fields: { changeId: string } },
  { name: "apply_migration", effect: "write" as const, fields: { changeId: string, expectedVersion: number } },
  { name: "verify_db", effect: "read" as const, fields: { changeId: string } },
  { name: "restore_db", effect: "write" as const, fields: { changeId: string, backupId: string } },
];
const service: Resource = { id: "p4-internal-engineering", ownerId: "flowly-examples", type: "mcp", name: "사내 기술 변경 MCP 계약", description: "미설정: 도구 및 자료에 사내 구현을 등록하고 내보낸 .env에서 주소·토큰을 설정합니다. 코드는 격리 작업 공간에서 시험하고 DB 변경은 백업·버전 확인을 포함해야 합니다.", url: "https://engineering.example.invalid/mcp", content: serializeMcpRegistration({ version: 1, connectionId: "p4-engineering", endpointEnv: "FLOWLY_MCP_ENDPOINT_ENGINEERING", tokenEnv: "FLOWLY_MCP_TOKEN_ENGINEERING", tools: toolSpecs.map(t => ({ name: t.name, description: `${t.name}: 고정된 변경 계약을 ${t.effect === "read" ? "조회·시험" : "승인 후 적용"}합니다. 임의 SQL·명령을 받지 않습니다.`, effect: t.effect, inputSchema: objectSchema(t.fields) })) }), visibility: "public", allowedEmails: [], sample: true, createdAt: stamp, updatedAt: stamp };
const handbook: Resource = { id: "p4-average-spec", ownerId: "flowly-examples", type: "document", name: "평균 계산과 스키마 변경 기준", description: "합성 예제의 버전 고정 기술 기준", url: "", content: "평균 계산은 숫자의 합을 개수로 나눈다. 빈 배열은 오류로 처리한다. 코드 평균 함수는 양수·음수·단일 원소·빈 배열 시험을 통과해야 한다. DB items의 quantity는 음수가 아니어야 하며 status 열을 추가하되 기존 3행을 보존한다. DB 변경 전에 버전 1의 백업을 만들고 검증에 실패하면 그 백업으로 복구한다.", visibility: "public", allowedEmails: [], sample: true, createdAt: stamp, updatedAt: stamp };
const select = (toolName: string) => ({ resourceId: service.id, connectionId: "p4-engineering", toolName });
const tool = (id: string, name: string, title: string, bindings: Record<string, string>, inputBindings: NonNullable<FlowNode["inputBindings"]>) => n(id, "tool", title, { allowedTools: [select(name)], tool: { arguments: {}, bindings }, inputBindings });
const pick = (id: string, title: string, fields: Record<string, string>, inputBindings: NonNullable<FlowNode["inputBindings"]>) => n(id, "transform", title, { transform: { mode: "pick", fields }, inputBindings });
const out = (id: string, from: string) => n(id, "output", "검증 산출물 전달", { inputBindings: { text: b(from), data: b(from, "data") } });
const input = () => n("input", "form", "변경 목표와 계약 ID", { form: { fields: [{ key: "request", label: "업무 목표", type: "text", required: true }, { key: "changeId", label: "등록된 변경 계약 ID", type: "text", required: true }] } });

const database = graph([
  n("db_input", "input", "DB 변경 계약 받기"),
  tool("db_inspect", "inspect_db", "현재 스키마·데이터 조회", { changeId: "changeId" }, { changeId: b("db_input", "changeId") }),
  tool("db_apply", "apply_migration", "백업 후 버전 결합 변경 · 승인 필요", { changeId: "changeId", expectedVersion: "state.version" }, { changeId: b("db_input", "changeId"), state: b("db_inspect", "data.structuredContent") }),
  tool("db_verify", "verify_db", "변경 후 스키마·데이터 독립 검사", { changeId: "changeId" }, { changeId: b("db_input", "changeId"), applied: b("db_apply", "data.structuredContent") }),
  n("db_valid", "condition", "실제 DB 검사 통과 여부", { predicate: { path: "state.verified", operator: "eq", value: true }, inputBindings: { state: b("db_verify", "data.structuredContent") } }),
  pick("db_success", "검증된 DB 버전과 결과", { verified: "state.verified", version: "state.version" }, { state: b("db_valid", "state") }), out("db_out", "db_success"),
  n("db_restore", "compensate", "검증 실패 시 백업 복구 · 별도 승인", { allowedTools: [select("restore_db")], compensation: { sourceNodeId: "db_apply", arguments: {}, bindings: { changeId: "changeId", backupId: "applied.backupId" } }, inputBindings: { changeId: b("db_input", "changeId"), applied: b("db_apply", "data.structuredContent"), state: b("db_valid", "state") } }),
  pick("db_recovered", "복구 결과와 미달성 목표 구분", { verified: "state.verified", restored: "recovery.restored", version: "recovery.version" }, { state: b("db_valid", "state"), recovery: b("db_restore", "data.structuredContent") }), out("db_recovery_out", "db_recovered"),
], [["db_input", "db_inspect"], ["db_input", "db_apply"], ["db_inspect", "db_apply"], ["db_apply", "db_verify"], ["db_input", "db_verify"], ["db_verify", "db_valid"], ["db_valid", "db_success", "yes"], ["db_success", "db_out"], ["db_valid", "db_restore", "no"], ["db_input", "db_restore"], ["db_apply", "db_restore"], ["db_valid", "db_recovered", "no"], ["db_restore", "db_recovered"], ["db_recovered", "db_recovery_out"]]);

// Direct dependency edges also gate activation in this DAG. Use a branch-contained
// subworkflow for recovery so data dependencies cannot activate a rejected branch.
const recovery = graph([
  n("recovery_input", "input", "실패 검사와 적용 기록"),
  tool("restore", "restore_db", "이전 버전 복구 · 별도 승인", { changeId: "changeId", backupId: "backupId" }, { changeId: b("recovery_input", "changeId"), backupId: b("recovery_input", "backupId") }),
  pick("recovery_result", "복구 결과 반환", { verified: "verified", restored: "state.restored", version: "state.version" }, { verified: b("recovery_input", "verified"), state: b("restore", "data.structuredContent") }), out("recovery_out", "recovery_result"),
], [["recovery_input", "restore"], ["recovery_input", "recovery_result"], ["restore", "recovery_result"], ["recovery_result", "recovery_out"]]);
// Consolidate all context into the condition before branching; each branch has
// exactly one controlling predecessor and cannot run from a side data edge.
database.nodes = database.nodes.filter(node => !["db_restore", "db_recovered", "db_recovery_out"].includes(node.id));
database.edges = database.edges.filter(edge => database.nodes.some(n => n.id === edge.source) && database.nodes.some(n => n.id === edge.target));
const gate = database.nodes.find(n => n.id === "db_valid")!;
gate.inputBindings = { state: b("db_verify", "data.structuredContent"), applied: b("db_apply", "data.structuredContent"), changeId: b("db_input", "changeId") };
database.edges.push({ id: "p4-db-context1", source: "db_apply", target: "db_valid" }, { id: "p4-db-context2", source: "db_input", target: "db_valid" });
database.nodes.push(n("db_recovery", "subworkflow", "검증 실패 시 승인된 복구", { subworkflow: { definition: recovery }, inputBindings: { changeId: b("db_valid", "changeId"), backupId: b("db_valid", "applied.backupId"), verified: b("db_valid", "state.verified") } }), out("db_recovery_out", "db_recovery"));
database.edges.push({ id: "p4-db-recover", source: "db_valid", target: "db_recovery", branch: "no" }, { id: "p4-db-restored", source: "db_recovery", target: "db_recovery_out" });

const knowledge = graph([
  n("knowledge_input", "input", "업무 목표 수신"),
  n("technical_search", "retrieval", "기술 기준의 근거 검색", { retrieval: { resourceIds: [handbook.id], topK: 2, chunkSize: 800 } }),
  pick("knowledge_artifact", "출처 버전과 원문 고정", { sourceVersion: "matches.0.version", sourceId: "matches.0.resourceId", excerpt: "matches.0.excerpt" }, { matches: b("technical_search", "matches") }), out("knowledge_out", "knowledge_artifact"),
], [["knowledge_input", "technical_search"], ["technical_search", "knowledge_artifact"], ["knowledge_artifact", "knowledge_out"]]);
const development = graph([
  n("dev_input", "input", "고정된 기술 근거와 작업 계약"),
  tool("code_inspect", "inspect_code", "현재 코드와 시험 결과 조사", { changeId: "changeId" }, { changeId: b("dev_input", "changeId") }),
  n("implementation", "ai", "기술 근거에 맞는 구현 작업 선택", { prompt: "P4_IMPLEMENT: 제공된 기술 근거와 코드 검사만 사용하세요. 등록된 fix_average 작업을 사용할 수 있으면 {\"operation\":\"fix_average\"} JSON을 반환하세요. 임의 코드나 명령을 만들지 마세요.", format: "JSON", inputBindings: { inspection: b("code_inspect", "data.structuredContent"), knowledge: b("dev_input", "artifacts.knowledge.data") } }),
  tool("code_trial", "prepare_code_change", "격리 작업 공간에서 구현·실제 시험", { changeId: "changeId", operation: "plan.operation", sourceVersion: "knowledge.sourceVersion" }, { changeId: b("dev_input", "changeId"), plan: b("implementation", "data"), knowledge: b("dev_input", "artifacts.knowledge.data") }),
  n("independent_review", "ai", "시험 산출물 독립 리뷰", { prompt: "P4_REVIEW: 전달된 시험 산출물만 검토하세요. testsPassed가 true이고 artifactId가 있으면 {\"accepted\":true}, 아니면 {\"accepted\":false}를 반환하세요. 실제 시험 결과를 대신 작성하지 마세요.", format: "JSON", inputBindings: { trial: b("code_trial", "data.structuredContent") } }),
  n("code_review_gate", "condition", "독립 리뷰 수락 여부", { predicate: { path: "decision.accepted", operator: "eq", value: true }, inputBindings: { decision: b("independent_review", "data"), trial: b("code_trial", "data.structuredContent"), changeId: b("dev_input", "changeId") } }),
  tool("code_apply", "apply_code_change", "검증 산출물 적용 · 승인 필요", { changeId: "changeId", artifactId: "trial.artifactId" }, { changeId: b("code_review_gate", "changeId"), trial: b("code_review_gate", "trial") }),
  tool("code_verify", "verify_code", "적용 코드의 시험 독립 재실행", { changeId: "changeId" }, { changeId: b("code_review_gate", "changeId"), applied: b("code_apply", "data.structuredContent") }),
  pick("code_artifact", "실제 시험과 코드 버전 전달", { testsPassed: "state.testsPassed", revision: "state.revision" }, { state: b("code_verify", "data.structuredContent") }), out("dev_out", "code_artifact"),
  n("code_rejected", "transform", "리뷰 거절을 완료로 표시하지 않기", { transform: { mode: "parse_json" }, inputBindings: { text: b("rejected_record") } }),
  n("rejected_record", "transform", "미적용 상태 기록", { transform: { mode: "template", template: '{"testsPassed":false,"revision":"unchanged"}' }, inputBindings: {} }), out("dev_rejected_out", "code_rejected"),
], [["dev_input", "code_inspect"], ["code_inspect", "implementation"], ["dev_input", "implementation"], ["implementation", "code_trial"], ["dev_input", "code_trial"], ["code_trial", "independent_review"], ["independent_review", "code_review_gate"], ["code_trial", "code_review_gate"], ["dev_input", "code_review_gate"], ["code_review_gate", "code_apply", "yes"], ["code_apply", "code_verify"], ["code_review_gate", "code_verify", "yes"], ["code_verify", "code_artifact"], ["code_artifact", "dev_out"], ["code_review_gate", "rejected_record", "no"], ["rejected_record", "code_rejected"], ["code_rejected", "dev_rejected_out"]]);

// A model reviewer cannot promote a failing test artifact to an applicable change.
development.nodes.push(n("trial_pass", "condition", "실제 시험 통과를 먼저 검사", { predicate: { path: "trial.testsPassed", operator: "eq", value: true }, inputBindings: { trial: b("code_trial", "data.structuredContent"), changeId: b("dev_input", "changeId") } }));
development.edges = development.edges.filter(edge => !(edge.source === "code_trial" && ["independent_review", "code_review_gate"].includes(edge.target)) && !(edge.source === "dev_input" && edge.target === "code_review_gate"));
development.edges.push({ id: "p4-trial-input", source: "code_trial", target: "trial_pass" }, { id: "p4-trial-context", source: "dev_input", target: "trial_pass" }, { id: "p4-trial-review", source: "trial_pass", target: "independent_review", branch: "yes" }, { id: "p4-trial-gate", source: "trial_pass", target: "code_review_gate", branch: "yes" }, { id: "p4-trial-failed", source: "trial_pass", target: "rejected_record", branch: "no" });
development.nodes.find(node => node.id === "independent_review")!.inputBindings = { trial: b("trial_pass", "trial") };
development.nodes.find(node => node.id === "code_review_gate")!.inputBindings = { decision: b("independent_review", "data"), trial: b("trial_pass", "trial"), changeId: b("trial_pass", "changeId") };
const gatedDatabase = graph([
  n("dependent_input", "input", "선행 개발팀의 검증 산출물"),
  n("dependency_pass", "condition", "코드 시험 통과 후에만 DB 작업", { predicate: { path: "artifacts.development.data.testsPassed", operator: "eq", value: true }, inputBindings: { artifacts: b("dependent_input", "artifacts"), changeId: b("dependent_input", "changeId") } }),
  n("approved_database", "subworkflow", "DB 변경 및 독립 검증", { subworkflow: { definition: layoutWorkflow(database, { recursive: true }) }, inputBindings: { changeId: b("dependency_pass", "changeId") } }), out("dependent_out", "approved_database"),
  n("blocked_database", "transform", "개발 미완료로 DB 작업 보류", { transform: { mode: "template", template: '{"verified":false,"reason":"development_not_verified"}' }, inputBindings: {} }),
  n("blocked_artifact", "transform", "미실행 산출물", { transform: { mode: "parse_json" } }), out("blocked_out", "blocked_artifact"),
], [["dependent_input", "dependency_pass"], ["dependency_pass", "approved_database", "yes"], ["approved_database", "dependent_out"], ["dependency_pass", "blocked_database", "no"], ["blocked_database", "blocked_artifact"], ["blocked_artifact", "blocked_out"]]);

const request = JSON.stringify({ request: "평균 계산을 수정하고 DB status 열을 추가한 뒤 검증하세요.", changeId: "average-v2" });
type Fixture = NonNullable<WorkflowScenario["toolReplies"]>[number];
const fixture = (name: string, args: Record<string, Json>, localOperation = name): Fixture => ({ name, args, localOperation });
const dbFixtures = (corrupt = false): Fixture[] => [fixture("inspect_db", { changeId: "average-v2" }), fixture("apply_migration", { changeId: "average-v2", expectedVersion: 1 }), fixture("verify_db", { changeId: "average-v2" }, corrupt ? "verify_db_corrupt" : "verify_db"), ...(corrupt ? [fixture("restore_db", { changeId: "average-v2", backupId: "before-average-v2" })] : [])];
const devFixtures: Fixture[] = [fixture("inspect_code", { changeId: "average-v2" }), fixture("prepare_code_change", { changeId: "average-v2", operation: "fix_average", sourceVersion: stamp }), fixture("apply_code_change", { changeId: "average-v2", artifactId: "average-v2" }), fixture("verify_code", { changeId: "average-v2" })];
const counts = (fixtures: Fixture[]) => Object.fromEntries(fixtures.map(f => [f.name, 1]));
const base = { category: "통합 실행 검증", resources: [service, handbook], inputExample: request, acceptance: ["웹에서는 OpenAI를 호출하지 않는다.", "등록된 사내 MCP 계약만 사용하고 실제 주소와 토큰은 내보낸 .env에 설정한다.", "변경 도구는 승인 전 0회, 승인 후 1회만 호출하며 동일 실행 재개 시 반복하지 않는다.", "성공 여부는 모델의 선언 대신 독립 도구의 실제 검사 결과로 판단한다."], failureCases: ["미설정", "승인 거절", "시험 실패", "검증 실패 후 승인된 복구", "변경 응답 유실 시 결과 불명과 자동 재실행 금지"] };
export const p4IntegratedDesigns: WorkflowDesign[] = [
  { ...base, id: "p4-approved-database-change", title: "승인된 DB 변경·검증·복구", description: "등록된 변경 계약으로 DB 상태를 조회하고 백업·변경을 승인한 뒤 독립 검사합니다. 실패 시 별도 승인으로 복구합니다.", behavior: "조회 → 버전 결합 변경 승인 → 실제 검증 → 통과 결과 / 복구 승인 → 원래 버전 확인. 임의 SQL 실행 기능은 제공하지 않습니다.", definition: graph([input(), n("database", "subworkflow", "DB 변경 수명주기", { subworkflow: { definition: layoutWorkflow(database, { recursive: true }) }, inputBindings: { changeId: b("input", "data.changeId") } }), out("output", "database")], [["input", "database"], ["database", "output"]]), expectedOutput: "검증된 버전 2 또는 실제 복구된 버전 1과 verified=false", scenarios: [
    { name: "SQLite 백업·스키마 변경·행 보존 실제 검증", input: request, approval: "approve", status: "succeeded", toolReplies: dbFixtures(), toolCallCounts: counts(dbFixtures()), contains: ['"verified":true', '"version":2'], skipped: ["db_recovery"], resumeAgain: true },
    { name: "승인 거절은 DB 변경 0회", input: request, approval: "deny", status: "failed", toolReplies: [dbFixtures()[0]], toolCallCounts: { inspect_db: 1 }, errorContains: ["거절"] },
    { name: "데이터 품질 실패 후 백업으로 실제 복구", input: request, approval: "approve", status: "succeeded", toolReplies: dbFixtures(true), toolCallCounts: counts(dbFixtures(true)), contains: ['"restored":true', '"version":1', '"verified":false'], skipped: ["db_success"], resumeAgain: true },
    { name: "DB 커밋 후 응답 유실은 재실행하지 않음", input: request, approval: "approve", status: "unknown_outcome", toolReplies: [dbFixtures()[0], { ...dbFixtures()[1], error: "disconnect" }], toolCallCounts: { inspect_db: 1, apply_migration: 1 }, resumeAgain: true },
  ] },
  { ...base, id: "p4-goal-technical-team", title: "기술 근거·코드·DB 목표 통합 팀", description: "기술 근거 버전을 고정해 구현·시험·리뷰·승인된 코드 적용과 DB 변경을 연결하고, 세 작업의 산출물로 완료를 판정합니다.", behavior: "목표 → 의존 계획(기술 근거 → 개발 → DB) → 각 팀의 실제 산출물 전달 → 독립 완료 조건. 내보내기에는 사내 도구 계약만 포함되며 자체 범용 코드 샌드박스나 DB 서버는 포함되지 않습니다.", definition: graph([input(), n("goal", "orchestrator", "목표와 산출물 계약 조정", { prompt: "P4_GOAL: 요청을 달성하려면 knowledge, development, database 순서로 실행하세요. 선행 작업을 생략하거나 순서를 바꾸지 마세요.", orchestration: { mode: "plan", maxTasks: 3, tasks: [{ id: "knowledge", name: "사내 기술 근거", definition: knowledge }, { id: "development", name: "구현·시험·독립 리뷰", dependsOn: ["knowledge"], definition: development }, { id: "database", name: "승인된 DB 변경·검증", dependsOn: ["development"], definition: gatedDatabase }], completion: [{ path: "artifacts.knowledge.data.sourceVersion", operator: "eq", value: stamp }, { path: "artifacts.development.data.testsPassed", operator: "eq", value: true }, { path: "artifacts.database.data.verified", operator: "eq", value: true }] }, inputBindings: { text: b("input", "data.request"), changeId: b("input", "data.changeId") } }), n("output", "output", "완료 조건을 통과한 팀별 산출물")], [["input", "goal"], ["goal", "output"]]), expectedOutput: "기술 근거 버전, 코드 시험 통과, DB 검증 통과의 세 산출물", scenarios: [
    { name: "기술 근거에서 실제 코드 시험·승인된 DB까지", input: request, approval: "approve", status: "succeeded", modelReplies: [{ match: "P4_GOAL:", text: '{"tasks":["knowledge","development","database"]}' }, { match: "P4_IMPLEMENT:", text: '{"operation":"fix_average"}', inputContains: [stamp, "평균 계산", '"testsPassed":false'] }, { match: "P4_REVIEW:", text: '{"accepted":true}', inputContains: ['"testsPassed":true', '"artifactId":"average-v2"'], inputExcludes: ["P4_IMPLEMENT:"] }], toolReplies: [...devFixtures, ...dbFixtures()], toolCallCounts: counts([...devFixtures, ...dbFixtures()]), contains: ['"sourceVersion"', '"testsPassed":true', '"verified":true'], resumeAgain: true },
    { name: "독립 리뷰 거절은 코드 적용과 DB 작업 모두 보류", input: request, approval: "approve", status: "failed", modelReplies: [{ match: "P4_GOAL:", text: '{"tasks":["knowledge","development","database"]}' }, { match: "P4_IMPLEMENT:", text: '{"operation":"fix_average"}' }, { match: "P4_REVIEW:", text: '{"accepted":false}' }], toolReplies: devFixtures.slice(0,2), toolCallCounts: counts(devFixtures.slice(0,2)), errorContains: ["완료 조건"], skipped: ["code_apply", "approved_database"], visited: ["blocked_artifact"] },
    { name: "실제 시험 실패는 모델 리뷰 이전에 적용 차단", input: request, approval: "approve", status: "failed", modelReplies: [{ match: "P4_GOAL:", text: '{"tasks":["knowledge","development","database"]}' }, { match: "P4_IMPLEMENT:", text: '{"operation":"fix_average"}' }], toolReplies: [devFixtures[0], { ...devFixtures[1], localOperation: "prepare_code_change_failing" }], toolCallCounts: counts(devFixtures.slice(0,2)), errorContains: ["완료 조건"], skipped: ["independent_review", "code_apply", "approved_database"] },
    { name: "선행 기술 근거를 생략한 계획은 실행 전 차단", input: request, status: "failed", modelReplies: [{ match: "P4_GOAL:", text: '{"tasks":["development","database"]}' }], toolCallCounts: {} },
    { name: "DB 복구에 성공해도 원래 목표 완료로 위장하지 않음", input: request, approval: "approve", status: "failed", modelReplies: [{ match: "P4_GOAL:", text: '{"tasks":["knowledge","development","database"]}' }, { match: "P4_IMPLEMENT:", text: '{"operation":"fix_average"}' }, { match: "P4_REVIEW:", text: '{"accepted":true}' }], toolReplies: [...devFixtures, ...dbFixtures(true)], toolCallCounts: counts([...devFixtures, ...dbFixtures(true)]), errorContains: ["완료 조건"], visited: ["recovery_result"] },
  ] },
];
