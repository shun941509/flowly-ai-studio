/** Test-only, independently composed graphs. These are never public example counts. */
import type { Definition, FlowNode, Resource, Workflow } from "../../app/lib/model";
import type { DataSchema, InputBinding, Json } from "../../runtime/types";
import type { WorkflowScenario } from "../../domain/workflow-design";
import type { ExportConnection } from "../../server/export-package";

export const composedOwner = { userId: "composed-user", email: "composed@example.test", displayName: "조합 검증 사용자" };
const string: DataSchema = { type: "string" }, number: DataSchema = { type: "number" }, boolean: DataSchema = { type: "boolean" };
const object = (properties: Record<string, DataSchema>): DataSchema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const bind = (nodeId: string, path = "text"): InputBinding => ({ nodeId, path });
const node = (id: string, type: FlowNode["type"], extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title: id, x: 0, y: 0, ...extra });
const graph = (nodes: FlowNode[], links?: [string, string, string?][]): Definition => ({ schemaVersion: 5, nodes, edges: (links ?? nodes.slice(1).map((n, i) => [nodes[i].id, n.id] as [string, string])).map(([source, target, branch], i) => ({ id: `edge_${i}`, source, target, ...(branch ? { branch } : {}) })) });
const input = (id = "input") => node(id, "input");
const output = (id: string, source: string, extra: Record<string, InputBinding> = {}) => node(id, "output", { inputBindings: { text: bind(source), ...extra } });
const agent = (id: string, tag: string, bindings: Record<string, InputBinding>, schema?: DataSchema) => node(id, "agent", { prompt: `${tag}: 관측된 입력만 사용하고 작업별 계약을 따르세요.`, inputBindings: bindings, allowedTools: [], ...(schema ? { format: "JSON", outputSchema: object({ text: string, data: schema }) } : {}) });
const text = (id: string, template: string, bindings: Record<string, InputBinding> = {}) => node(id, "transform", { inputBindings: bindings, transform: { mode: "template", template } });
const gate = (id: string, path: string, value: string | boolean | number, bindings: Record<string, InputBinding>) => node(id, "condition", { predicate: { path, operator: "eq", value }, inputBindings: bindings });
const reply = (match: string, value: Json, inputContains?: string[]) => ({ match: `${match}:`, text: typeof value === "string" ? value : JSON.stringify(value), ...(inputContains ? { inputContains } : {}) });

export type ComposedCase = { id: string; description: string; workflow: Workflow; resources: Resource[]; connections: ExportConnection[]; scenarios: WorkflowScenario[] };
const fixture = (id: string, description: string, definition: Definition, scenarios: WorkflowScenario[], resources: Resource[] = [], connections: ExportConnection[] = []): ComposedCase => ({ id, description, workflow: { id: `user-${id}`, name: description, description: "독립 사용자 조합 검증 전용; 공개 예제에 포함하지 않음", updatedAt: "2026-10-25T00:00:00.000Z", definition }, resources, connections, scenarios });

const scoreChild = (id: string, tag: string) => graph([input(`${id}_in`), agent(`${id}_agent`, tag, { request: bind(`${id}_in`) }, object({ score: number, reason: string })), output(`${id}_out`, `${id}_agent`, { score: bind(`${id}_agent`, "data.score") })]);
const nestedLeft = graph([input("left_in"), node("left_nested", "subworkflow", { subworkflow: { definition: scoreChild("left", "UC_LEFT") } }), output("left_end", "left_nested", { score: bind("left_nested", "score") })]);
const parallel = fixture("parallel-predicate", "중첩 분석과 독립 대안을 병렬 실행하고 실제 점수로 선택", graph([
  input(), node("analyses", "parallel", { parallel: { concurrency: 2, tasks: [{ id: "left", name: "중첩 분석", definition: nestedLeft }, { id: "right", name: "독립 대안", definition: scoreChild("right", "UC_RIGHT") }] } }),
  node("collect", "merge", { merge: { mode: "object" }, inputBindings: { primary: bind("analyses", "results.0.output.score"), alternative: bind("analyses", "results.1.output.score") } }),
  node("choose", "condition", { predicate: { path: "data.primary", operator: "gte", rightPath: "data.alternative" }, inputBindings: { data: bind("collect", "data") } }),
  text("primary", "선택=주안;점수={{data.primary}}/{{data.alternative}}", { data: bind("choose", "data") }), text("alternative", "선택=대안;점수={{data.primary}}/{{data.alternative}}", { data: bind("choose", "data") }), node("answer", "output"),
], [["input", "analyses"], ["analyses", "collect"], ["collect", "choose"], ["choose", "primary", "yes"], ["choose", "alternative", "no"], ["primary", "answer"], ["alternative", "answer"]]), [
  { name: "병렬 점수가 주안 선택으로 전달", input: "지역 역사 전시를 기획", modelReplies: [{ ...reply("UC_LEFT", { score: 8, reason: "원자료 보존" }, ["지역 역사"]), delayMs: 900 }, { ...reply("UC_RIGHT", { score: 5, reason: "체험 중심" }, ["지역 역사"]), delayMs: 900 }], parallelMatches: ["UC_LEFT:", "UC_RIGHT:"], status: "succeeded", contains: ["선택=주안;점수=8/5"], outputs: { collect: { data: { primary: 8, alternative: 5 } } }, visited: ["left_nested", "primary"], skipped: ["alternative"], completedCounts: { left_agent: 1, right_agent: 1 }, resumeAgain: true },
  { name: "같은 설계에서 입력 평가 차이로 대안 분기", input: "야외 체험 전시를 기획", modelReplies: [reply("UC_LEFT", { score: 3, reason: "실내 제약" }), reply("UC_RIGHT", { score: 9, reason: "야외 적합" })], status: "succeeded", contains: ["선택=대안;점수=3/9"], visited: ["alternative"], skipped: ["primary"] },
]);

const form = fixture("supplemental-input", "먼저 조사한 결과를 보존하면서 보완 입력을 기다리고 이어서 작성", graph([
  input(), agent("prepare", "UC_PREPARE", { request: bind("input") }),
  node("details", "form", { form: { mode: "request", instructions: "독자와 분량을 정해주세요.", timeoutMinutes: 60, fields: [{ key: "audience", label: "독자", type: "text", required: true }, { key: "pages", label: "쪽수", type: "number", required: true }] }, inputBindings: { research: bind("prepare") } }),
  agent("write", "UC_WRITE", { research: bind("prepare"), audience: bind("details", "data.audience"), pages: bind("details", "data.pages") }), output("answer", "write"),
], [["input", "prepare"], ["prepare", "details"], ["prepare", "write"], ["details", "write"], ["write", "answer"]]), [
  { name: "입력 대기 재조회와 잘못된 제출 거절 뒤 재개", input: "별 관측 안내서", modelReplies: [reply("UC_PREPARE", "관측지=도시 공원;준비=별자리 지도"), reply("UC_WRITE", "초등학생용 4쪽 관측 안내서", ["도시 공원", "초등학생", "4"])], inputSubmissions: [{ nodeId: "details", values: { audience: "초등학생", pages: 4 }, invalidValues: [{ audience: "초등학생", pages: "four" }, { pages: 4 }], repeat: true }], status: "succeeded", contains: ["초등학생용 4쪽"], completedCounts: { prepare: 1, details: 1, write: 1 }, modelCallCounts: { "UC_PREPARE:": 1, "UC_WRITE:": 1 }, resumeAgain: true },
  { name: "미제출은 성공 응답 없이 입력 대기 지속", input: "별 관측 안내서", modelReplies: [reply("UC_PREPARE", "관측 근거 준비됨")], status: "waiting_input", completedCounts: { prepare: 1, details: 0, write: 0 }, modelCallCounts: { "UC_PREPARE:": 1 } },
]);

const review = fixture("independent-revision", "독립 검토가 실패하면 작성자에게 수정 후 별도 규칙으로 재검증", graph([
  input(), agent("draft", "UC_DRAFT", { request: bind("input") }), agent("reviewer", "UC_REVIEW", { draft: bind("draft") }, object({ accepted: boolean, issue: string })),
  gate("accepted", "accepted", true, { accepted: bind("reviewer", "data.accepted"), issue: bind("reviewer", "data.issue"), draft: bind("draft") }),
  text("direct", "초안 통과: {{draft}}", { draft: bind("accepted", "draft") }), agent("revise", "UC_REVISE", { draft: bind("accepted", "draft"), issue: bind("accepted", "issue") }),
  node("check_revision", "evaluate", { evaluation: { mode: "rules", rules: [{ kind: "contains", value: "검증근거:관측기록" }], rubric: "", threshold: 1 }, inputBindings: { text: bind("revise") } }),
  gate("revision_valid", "passed", true, { passed: bind("check_revision", "evaluation.passed"), text: bind("revise") }), text("revised", "수정 통과: {{text}}", { text: bind("revision_valid") }), text("held", "검증 실패: 공개하지 않음"), node("answer", "output"),
], [["input", "draft"], ["draft", "reviewer"], ["draft", "accepted"], ["reviewer", "accepted"], ["accepted", "direct", "yes"], ["accepted", "revise", "no"], ["revise", "check_revision"], ["revise", "revision_valid"], ["check_revision", "revision_valid"], ["revision_valid", "revised", "yes"], ["revision_valid", "held", "no"], ["direct", "answer"], ["revised", "answer"], ["held", "answer"]]), [
  { name: "독립 검토 지적이 수정 Agent에 전달되고 규칙 통과", input: "정원 관측 기록 설명", modelReplies: [reply("UC_DRAFT", "모든 꽃이 봄에 핀다"), reply("UC_REVIEW", { accepted: false, issue: "표본과 근거가 빠짐" }, ["모든 꽃"]), reply("UC_REVISE", "우리 정원의 표본만 관찰함;검증근거:관측기록", ["표본과 근거", "모든 꽃"])], status: "succeeded", contains: ["수정 통과", "검증근거:관측기록"], visited: ["revise", "check_revision", "revised"], skipped: ["direct", "held"], completedCounts: { draft: 1, reviewer: 1, revise: 1 }, resumeAgain: true },
  { name: "수정 Agent의 완료 주장만으로 검증을 통과하지 않음", input: "정원 관측 기록 설명", modelReplies: [reply("UC_DRAFT", "일반화된 문장"), reply("UC_REVIEW", { accepted: false, issue: "근거 없음" }), reply("UC_REVISE", "수정 완료했습니다")], status: "succeeded", contains: ["검증 실패: 공개하지 않음"], visited: ["held"], skipped: ["direct", "revised"] },
  { name: "이미 적합한 초안은 수정 Agent 실행을 생략", input: "정원 관측 기록 설명", modelReplies: [reply("UC_DRAFT", "표본 세 꽃의 관측기록"), reply("UC_REVIEW", { accepted: true, issue: "" })], status: "succeeded", contains: ["초안 통과"], visited: ["direct"], skipped: ["revise", "check_revision", "revised", "held"], completedCounts: { revise: 0 } },
]);

const gather = graph([input("gather_input"), agent("gather_agent", "UC_GATHER", { request: bind("gather_input") }, object({ topic: string, evidence: string })), output("gather_output", "gather_agent", { topic: bind("gather_agent", "data.topic"), evidence: bind("gather_agent", "data.evidence") })]);
const deliver = graph([input("deliver_input"), agent("deliver_agent", "UC_DELIVER", { sources: bind("deliver_input", "artifacts.gather"), request: bind("deliver_input") }, object({ ready: boolean, summary: string })), output("deliver_output", "deliver_agent", { ready: bind("deliver_agent", "data.ready"), summary: bind("deliver_agent", "data.summary") })]);
const orchestration = fixture("dependency-completion", "등록 작업을 의존 순서로 실행하고 최종 산출물로 완료 판단", graph([
  input(), node("coordinate", "orchestrator", { prompt: "UC_PLAN: gather의 결과를 확보한 뒤 deliver에 전달하세요.", orchestration: { mode: "plan", maxTasks: 2, tasks: [{ id: "gather", name: "자료 확보", definition: gather }, { id: "deliver", name: "설명 작성", definition: deliver, dependsOn: ["gather"] }], completion: [{ path: "artifacts.deliver.ready", operator: "eq", value: true }] } }),
  text("report", "전달 완료: {{summary}}", { summary: bind("coordinate", "artifacts.deliver.summary") }), output("answer", "report"),
]), [
  { name: "의존 산출물을 받아 독립 완료 조건 충족", input: "수질 관찰 학습 자료", modelReplies: [reply("UC_PLAN", { tasks: ["gather", "deliver"] }), reply("UC_GATHER", { topic: "수질", evidence: "관측일=10월;표본=3" }), reply("UC_DELIVER", { ready: true, summary: "세 표본의 한계를 설명" }, ["관측일=10월;표본=3"])], status: "succeeded", contains: ["전달 완료: 세 표본"], completedCounts: { gather_agent: 1, deliver_agent: 1 }, resumeAgain: true },
  { name: "조정자가 종료해도 산출물 완료 조건이 거짓이면 실패", input: "수질 관찰 학습 자료", modelReplies: [reply("UC_PLAN", { tasks: ["gather", "deliver"] }), reply("UC_GATHER", { topic: "수질", evidence: "관측 없음" }), reply("UC_DELIVER", { ready: false, summary: "추가 자료 필요" }, ["관측 없음"])], status: "failed", completedCounts: { report: 0, answer: 0, gather_agent: 1, deliver_agent: 1 } },
]);

const item = graph([input("item_input"), agent("item_agent", "UC_ITEM", { item: bind("item_input", "item") }), output("item_output", "item_agent")]);
const loop = fixture("bounded-memory-resume", "목록을 제한된 반복으로 처리하고 기억한 결과를 입력 대기 뒤 재사용", graph([
  input(), node("parse", "transform", { transform: { mode: "parse_json" } }), node("items", "loop", { inputBindings: { items: bind("parse", "data") }, loop: { itemsPath: "items", maxItems: 3, concurrency: 1, definition: item } }),
  node("remember", "memory", { memory: { action: "write", key: "composed_items", scope: "run", valuePath: "results" }, inputBindings: { results: bind("items", "results") } }),
  node("confirm", "form", { form: { mode: "request", fields: [{ key: "label", label: "묶음 이름", type: "text", required: true }], instructions: "처리 결과의 묶음 이름을 입력하세요.", timeoutMinutes: 60 }, inputBindings: {} }),
  node("recall", "memory", { memory: { action: "read", key: "composed_items", scope: "run", defaultValue: [] }, inputBindings: {} }),
  text("render", "묶음={{label}};첫결과={{rows.0.output.text}};둘째결과={{rows.1.output.text}}", { label: bind("confirm", "data.label"), rows: bind("recall", "data") }), output("answer", "render"),
], [["input", "parse"], ["parse", "items"], ["items", "remember"], ["remember", "confirm"], ["confirm", "recall"], ["confirm", "render"], ["recall", "render"], ["render", "answer"]]), [
  { name: "각 항목 한 번 처리 후 체크포인트 재개로 기억 읽기", input: '["별","달"]', modelReplies: [{ ...reply("UC_ITEM", "별 정리", ["별"]), occurrence: 1 }, { ...reply("UC_ITEM", "달 정리", ["달"]), occurrence: 2 }], inputSubmissions: [{ nodeId: "confirm", values: { label: "밤하늘" }, repeat: true }], status: "succeeded", contains: ["묶음=밤하늘;첫결과=별 정리;둘째결과=달 정리"], completedCounts: { item_agent: 2, remember: 1, recall: 1 }, modelCallCounts: { "UC_ITEM:": 2 }, resumeAgain: true },
  { name: "목록 한도 초과는 항목 Agent 실행 전에 중단", input: '["별","달","해","구름"]', status: "failed", completedCounts: { item_agent: 0, remember: 0, confirm: 0 }, modelCallCounts: {} },
]);

const mcp: Resource = { id: "composed-mcp", ownerId: composedOwner.userId, type: "mcp", name: "사용자 등록 연결", description: "검증용 정의, 실제 네트워크 호출 없음", content: "읽기와 기록 도구", url: "https://user-registered.invalid/mcp", visibility: "private", allowedEmails: [], createdAt: "2026-10-25", updatedAt: "2026-10-25" };
const connection: ExportConnection = { id: "composed", ownerId: composedOwner.userId, resourceId: mcp.id, name: "사용자 연결", endpoint: mcp.url, tokenEnv: "FLOWLY_MCP_TOKEN_COMPOSED", tools: ["lookup", "store"].map(name => ({ resourceId: mcp.id, connectionId: "composed", toolName: name, name, description: name, effect: name === "lookup" ? "read" : "write", supportsIdempotency: name === "store", inputSchema: object({ value: string }) })) };
const work = agent("acting_agent", "UC_ACT", { request: bind("service_input") }); work.requireToolResult = true; work.allowedTools = connection.tools.map(({ resourceId, connectionId, toolName }) => ({ resourceId, connectionId, toolName }));
const service = graph([input("service_input"), work, output("service_output", "acting_agent")]);
const tools = fixture("nested-approved-tools", "중첩 Agent가 읽은 근거로 변경을 요청하고 사용자 결정 후 재개", graph([input(), node("service", "subworkflow", { subworkflow: { definition: service } }), output("answer", "service")]), ["approve", "deny"].map(decision => ({
  name: decision === "approve" ? "읽기 후 승인 전 쓰기 0회, 승인 재개 후 정확히 1회" : "읽기는 유지하고 거절한 쓰기는 0회", input: "관찰 노트의 현재 버전을 읽고 정리 기록", status: "succeeded" as const, approval: decision as "approve" | "deny", resumeAgain: true,
  modelReplies: [
    { match: "UC_ACT:", occurrence: 1, inputContains: ["관찰 노트"], allowedTools: ["lookup", "store"], toolCall: { name: "lookup", args: { value: "note" } } },
    { match: "UC_ACT:", occurrence: 2, observationContains: ["version=7"], allowedTools: ["lookup", "store"], toolCall: { name: "store", args: { value: "note-version-7" } } },
    { match: "UC_ACT:", occurrence: 3, observationContains: [decision === "approve" ? "recorded-version-7" : "거절"], allowedTools: ["lookup", "store"], text: decision === "approve" ? "버전 7 기록 완료" : "변경 거절 확인, 원본 유지" },
  ], toolReplies: [{ name: "lookup", args: { value: "note" }, result: { content: [{ type: "text", text: "version=7" }] } }, ...(decision === "approve" ? [{ name: "store", args: { value: "note-version-7" }, result: { content: [{ type: "text", text: "recorded-version-7" }] } }] : [])], toolCallCounts: { lookup: 1, store: decision === "approve" ? 1 : 0 }, modelCallCounts: { "UC_ACT:": 3 }, completedCounts: { acting_agent: 1, service: 1 }, contains: [decision === "approve" ? "버전 7 기록 완료" : "변경 거절 확인"],
})), [mcp], [connection]);

export const userComposedCases: ComposedCase[] = [parallel, form, review, orchestration, loop, tools];
