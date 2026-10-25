import type { Definition, FlowNode, Resource } from "../../app/lib/model";
import type { DataSchema, InputBinding, Json } from "../../runtime/types";
import type { WorkflowDesign, WorkflowScenario } from "../workflow-design";
import { layoutWorkflow } from "../workflow-layout";

const node = (id: string, type: FlowNode["type"], title: string, extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title, x: 0, y: 0, ...extra });
const bind = (nodeId: string, path = "text"): InputBinding => ({ nodeId, path });
const output = (id: string) => node(id, "output", "결과 확인");
const message = (id: string, title: string, text: string) => node(id, "transform", title, { transform: { mode: "template", template: text }, inputBindings: {} });
function graph(nodes: FlowNode[], links: [string, string, string?][]): Definition {
  return layoutWorkflow({ schemaVersion: 5, nodes, edges: links.map(([source, target, branch], index) => ({ id: `control-edge-${index}`, source, target, ...(branch ? { branch } : {}) })) });
}
function connection(id: string, key: string, name: string, description: string, url: string): Resource {
  return { id, ownerId: "flowly-examples", name, type: "mcp", description, content: JSON.stringify({ flowlyConnectionTemplate: key, description }), url, visibility: "public", allowedEmails: [], sample: true, createdAt: "2026-10-23T00:00:00Z", updatedAt: "2026-10-23T00:00:00Z" };
}
const knowledge = connection("showcase-knowledge-mcp", "showcase-knowledge", "읽기 전용 근거 조회 연결", "미설정: 내보낸 환경에서 lookup_reference(query) 읽기 도구를 제공하는 실제 MCP 주소와 본인의 토큰을 설정하세요. 예제 주소로는 실행되지 않습니다.", "https://knowledge.example.invalid/mcp");
const publishing = connection("showcase-publishing-mcp", "showcase-publishing", "승인 후 등록하는 서비스 연결", "미설정: 내보낸 환경에서 create_record(title, body) 변경 도구를 제공하는 실제 MCP 주소와 본인의 토큰을 설정하세요. 실행 전에 정확한 인자를 승인해야 합니다.", "https://publishing.example.invalid/mcp");
const lookup = { resourceId: knowledge.id, connectionId: "showcase-knowledge", toolName: "lookup_reference" };
const publish = { resourceId: publishing.id, connectionId: "showcase-publishing", toolName: "create_record" };
const answerSchema: DataSchema = { type: "object", properties: { data: { type: "object", properties: { answer: { type: "string" }, sourceId: { type: "string" } }, required: ["answer", "sourceId"], additionalProperties: false } }, required: ["data"] };
const answerChecks: FlowNode["evaluation"] = { mode: "rules", rules: [{ kind: "not_blank", value: "data.answer" }, { kind: "not_blank", value: "data.sourceId" }], rubric: "답변과 출처가 공백뿐인 문자열인지 검사합니다. 사실 정확도 검사는 별도입니다.", threshold: 1 };
const recordSchema: DataSchema = { type: "object", properties: { data: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title", "body"], additionalProperties: false } }, required: ["data"] };
const limitedAgent = (id: string, title: string, prompt: string, extra: Partial<FlowNode> = {}) => node(id, "agent", title, { prompt, allowedTools: [], limits: { maxTurns: 3, maxToolCalls: 2, maxTokens: 7000, maxDurationMs: 30000 }, ...extra });
const referenceResult: Record<string, Json> = { structuredContent: { text: "예약은 시작 10분 전까지 취소할 수 있습니다.", sourceId: "policy-cancel-2026" }, content: [{ type: "text", text: "예약은 시작 10분 전까지 취소할 수 있습니다. 출처: policy-cancel-2026" }] };
const recordResult: Record<string, Json> = { structuredContent: { recordId: "record-test-41", title: "회의 일정 안내", body: "내일 오전 10시에 회의를 시작합니다." }, content: [{ type: "text", text: "record-test-41" }] };
const request = "회의실 예약 취소 기준을 알려 주세요.";
const goodAnswer = JSON.stringify({ answer: "예약은 시작 10분 전까지 취소할 수 있습니다.", sourceId: "policy-cancel-2026" });
const draft = JSON.stringify({ title: "회의 일정 안내", body: "내일 오전 10시에 회의를 시작합니다." });
const readStep = (match: string, occurrence = 1) => ({ match, occurrence, toolCall: { name: "lookup_reference", args: { query: request } }, allowedTools: ["lookup_reference"] });
const readAnswer = (match: string, text: string, occurrence = 2) => ({ match, occurrence, text, observationContains: ["예약은 시작 10분 전까지", "policy-cancel-2026"], allowedTools: ["lookup_reference"] });
const readFixture = (count = 1) => ({ name: "lookup_reference", args: { query: request }, result: referenceResult, count });
const writeFixture = { name: "create_record", args: { title: "회의 일정 안내", body: "내일 오전 10시에 회의를 시작합니다." }, result: recordResult };
const blankAnswers = [
  { label: "빈 답변", value: { answer: "", sourceId: "policy-cancel-2026" } },
  { label: "공백 답변", value: { answer: " \t\n\u00a0\ufeff", sourceId: "policy-cancel-2026" } },
  { label: "빈 출처", value: { answer: "예약 취소 안내", sourceId: "" } },
  { label: "공백 출처", value: { answer: "예약 취소 안내", sourceId: " \r\n\u3000" } },
];
const draftReply = { match: "PUBLISH_DRAFT:", text: draft, inputContains: ["내일 오전 10시"] };

const harness: WorkflowDesign = {
  id: "showcase-agent-harness", title: "대표 ③ · 읽기 전용 도구와 제한된 수정 Harness", category: "대표 AI 시스템",
  description: "Agent가 허용된 읽기 도구로 근거를 찾고 JSON 스키마를 검사합니다. 잘못된 형식이나 빈 답변·출처는 한 번 수정하며, 허용하지 않은 도구와 반복 한도 초과를 실제 실행 엔진이 차단합니다.",
  behavior: "요청 → 읽기 도구를 선택하는 Agent → 스키마·공백 검사 → 정상 답변 또는 한 번의 재조회·수정 → 형식 검사 결과. Harness는 노드별 한도·허용 도구·기록·체크포인트로 적용됩니다. 스키마 검사는 사실 정확도를 보장하지 않으며 실제 모델 품질은 별도 검증 대상입니다.",
  definition: graph([
    node("input", "input", "조사할 질문"),
    limitedAgent("research", "읽기 전용 근거 조사 Agent", "HARNESS_RESEARCH: lookup_reference로 질문의 근거를 조회하세요. 도구 관찰 결과에 있는 사실만 사용하여 {answer:string,sourceId:string} JSON을 반환하세요. 도구 사용 실패 또는 근거 부족을 성공으로 만들지 마세요.", { allowedTools: [lookup], requireToolResult: true, format: "JSON", outputSchema: answerSchema, onError: "branch" }),
    node("candidate", "transform", "질문과 검증 결과 연결", { transform: { mode: "pick", fields: { question: "question", response: "response" } }, inputBindings: { question: bind("input"), response: bind("research") } }),
    node("initial_valid", "condition", "응답 스키마 통과 여부", { predicate: { path: "data.response", operator: "ne", value: "" }, inputBindings: { data: bind("candidate", "data") } }),
    node("parsed", "transform", "검증된 답변 필드 읽기", { transform: { mode: "parse_json" }, inputBindings: { text: bind("initial_valid", "data.response") } }),
    node("initial_nonempty", "evaluate", "답변·출처의 공백 검사", { evaluation: answerChecks, inputBindings: { data: bind("parsed", "data"), question: bind("initial_valid", "data.question") } }),
    node("initial_fields_valid", "condition", "답변과 출처가 모두 있는가", { predicate: { path: "passed", operator: "eq", value: true }, inputBindings: { passed: bind("initial_nonempty", "evaluation.passed"), data: bind("initial_nonempty", "data"), question: bind("initial_nonempty", "question") } }),
    { ...message("answer", "근거가 포함된 답변", "{{data.answer}}\n출처: {{data.sourceId}}"), inputBindings: { data: bind("initial_fields_valid", "data") } }, output("answer_out"),
    limitedAgent("repair", "한 번만 재조회하여 형식 수정", "HARNESS_REPAIR: 앞선 응답이 JSON 스키마 또는 필수 내용 검사를 통과하지 못했습니다. 입력의 question 또는 context_question에 있는 원래 질문을 lookup_reference로 다시 확인하고 {answer:string,sourceId:string} JSON만 반환하세요. 답변과 출처는 공백이 아닌 내용이 필요합니다. 이번 수정 후 추가 자동 수정은 없습니다.", { inputBindings: { question: bind("initial_valid", "data.question"), context_question: bind("initial_fields_valid", "question") }, allowedTools: [lookup], requireToolResult: true, format: "JSON", outputSchema: answerSchema, onError: "branch" }),
    node("repair_nonempty", "evaluate", "수정 답변·출처의 공백 검사", { evaluation: answerChecks, inputBindings: { data: bind("repair", "data") } }),
    node("repair_fields_valid", "condition", "수정 답변과 출처가 모두 있는가", { predicate: { path: "passed", operator: "eq", value: true }, inputBindings: { passed: bind("repair_nonempty", "evaluation.passed"), data: bind("repair_nonempty", "data") } }),
    { ...message("repaired", "수정된 답변과 출처", "{{data.answer}}\n출처: {{data.sourceId}}\n응답 형식을 한 번 수정했습니다."), inputBindings: { data: bind("repair_fields_valid", "data") } }, output("repaired_out"),
    message("repair_failed", "자동 수정 종료", "응답 형식을 한 번 수정했지만 검사를 통과하지 못했습니다. 답변을 확정하지 않았습니다. 실행 기록을 확인하고 입력 또는 모델 설정을 점검해 주세요."), output("failed_out"),
  ], [["input", "research"], ["input", "candidate"], ["research", "candidate", "success"], ["research", "candidate", "error"], ["candidate", "initial_valid"], ["initial_valid", "parsed", "yes"], ["initial_valid", "initial_nonempty", "yes"], ["parsed", "initial_nonempty"], ["initial_nonempty", "initial_fields_valid"], ["initial_fields_valid", "answer", "yes"], ["initial_fields_valid", "repair", "no"], ["answer", "answer_out"], ["initial_valid", "repair", "no"], ["repair", "repair_nonempty", "success"], ["repair_nonempty", "repair_fields_valid"], ["repair_fields_valid", "repaired", "yes"], ["repair_fields_valid", "repair_failed", "no"], ["repaired", "repaired_out"], ["repair", "repair_failed", "error"], ["repair_failed", "failed_out"]]),
  resources: [knowledge], inputExample: request, expectedOutput: "조회된 근거와 출처가 포함된 답변 또는 한도·형식 실패에 대한 명시적 종료 상태",
  acceptance: ["Agent가 실제 허용 도구 목록에서 읽기 도구를 선택하고 도구 관찰 결과를 다음 모델 호출에 전달한다.", "이 Agent에서 성공한 도구 결과가 없으면 답변을 확정하지 않고 한도 내에서 도구 사용을 다시 요청한다. 실패·거절·다른 노드의 결과는 대체 증거가 아니다.", "각 Agent는 판단 3회·도구 호출 2회·30초 이하이며 전체 실행 한도도 함께 적용한다.", "JSON 응답 스키마 오류 또는 빈 문자열·공백뿐인 답변·출처는 원래 질문을 전달하여 한 번만 수정한다. 수정 결과에도 같은 검사를 적용한다.", "허용되지 않은 도구는 호출하지 않으며 반복 한도를 넘으면 추가 호출 없이 종료한다.", "웹에서는 모델을 호출하지 않으며 내보낸 환경의 모델·MCP 미설정 상태는 성공으로 표시하지 않는다."],
  failureCases: ["모델·읽기 연결 미설정", "허용되지 않은 도구 요청", "도구 호출 한도 초과", "최초 응답 스키마 실패", "한 번 수정한 뒤에도 스키마 실패", "초기·수정 답변 또는 출처가 빈 문자열·공백뿐인 경우"],
  scenarios: [
    { name: "읽기 도구 결과를 받은 뒤 정상 답변", input: request, modelReplies: [readStep("HARNESS_RESEARCH:"), readAnswer("HARNESS_RESEARCH:", goodAnswer)], toolReplies: [readFixture()], toolCallCounts: { lookup_reference: 1 }, status: "succeeded", contains: ["시작 10분 전", "policy-cancel-2026"], visited: ["research", "parsed", "answer"], skipped: ["repair", "repair_failed"] },
    { name: "도구 없는 첫 답변을 거절하고 실제 조회 후에만 확정", input: request, modelReplies: [{ match: "HARNESS_RESEARCH:", occurrence: 1, text: '{"answer":"조회 없이 만든 주장","sourceId":"invented"}', allowedTools: ["lookup_reference"] }, readStep("HARNESS_RESEARCH:", 2), readAnswer("HARNESS_RESEARCH:", goodAnswer, 3)], toolReplies: [readFixture()], toolCallCounts: { lookup_reference: 1 }, status: "succeeded", contains: ["시작 10분 전", "policy-cancel-2026"], excludes: ["조회 없이 만든 주장", "invented"], skipped: ["repair"] },
    { name: "계속 도구 없이 답하면 판단 한도에서 중단", input: request, modelReplies: [1, 2, 3].map(occurrence => ({ match: "HARNESS_RESEARCH:", occurrence, text: goodAnswer, allowedTools: ["lookup_reference"] })), toolCallCounts: { lookup_reference: 0 }, status: "budget_exceeded", errorContains: ["한도"], resumeAgain: true },
    { name: "수정 Agent는 이전 Agent의 도구 결과로 조회를 생략할 수 없음", input: request, modelReplies: [readStep("HARNESS_RESEARCH:"), readAnswer("HARNESS_RESEARCH:", '{"answer":"출처 누락"}'), ...[1, 2, 3].map(occurrence => ({ match: "HARNESS_REPAIR:", occurrence, text: goodAnswer, allowedTools: ["lookup_reference"] }))], toolReplies: [readFixture()], toolCallCounts: { lookup_reference: 1 }, status: "budget_exceeded", errorContains: ["한도"], resumeAgain: true },
    { name: "스키마 실패 후 원래 질문으로 한 번 수정", input: request, modelReplies: [readStep("HARNESS_RESEARCH:"), readAnswer("HARNESS_RESEARCH:", '{"answer":"출처 필드 누락"}'), { ...readStep("HARNESS_REPAIR:"), inputContains: [request] }, readAnswer("HARNESS_REPAIR:", goodAnswer)], toolReplies: [readFixture(2)], toolCallCounts: { lookup_reference: 2 }, status: "succeeded", contains: ["시작 10분 전", "한 번 수정"], visited: ["repair", "repaired"], skipped: ["parsed", "answer", "repair_failed"] },
    { name: "두 번째 형식 실패는 추가 수정 없이 종료", input: request, modelReplies: [readStep("HARNESS_RESEARCH:"), readAnswer("HARNESS_RESEARCH:", "JSON 아님"), readStep("HARNESS_REPAIR:"), readAnswer("HARNESS_REPAIR:", '{"sourceId":"policy-cancel-2026"}')], toolReplies: [readFixture(2)], toolCallCounts: { lookup_reference: 2 }, status: "succeeded", contains: ["답변을 확정하지 않았습니다"], excludes: ["출처: policy-cancel-2026"], visited: ["repair_failed"], skipped: ["answer", "repaired"] },
    ...blankAnswers.map(({ label, value }): WorkflowScenario => ({ name: `${label}: 정상 답변으로 보내지 않고 한 번 수정`, input: request, modelReplies: [readStep("HARNESS_RESEARCH:"), readAnswer("HARNESS_RESEARCH:", JSON.stringify(value)), { ...readStep("HARNESS_REPAIR:"), inputContains: [request] }, readAnswer("HARNESS_REPAIR:", goodAnswer)], toolReplies: [readFixture(2)], toolCallCounts: { lookup_reference: 2 }, status: "succeeded", contains: ["시작 10분 전", "한 번 수정"], visited: ["initial_nonempty", "repair", "repair_nonempty", "repaired"], skipped: ["answer", "repair_failed"] })),
    ...blankAnswers.map(({ label, value }): WorkflowScenario => ({ name: `수정 후에도 ${label}이면 답변 확정 없이 종료`, input: request, modelReplies: [readStep("HARNESS_RESEARCH:"), readAnswer("HARNESS_RESEARCH:", "JSON 아님"), readStep("HARNESS_REPAIR:"), readAnswer("HARNESS_REPAIR:", JSON.stringify(value))], toolReplies: [readFixture(2)], toolCallCounts: { lookup_reference: 2 }, status: "succeeded", contains: ["답변을 확정하지 않았습니다"], excludes: ["출처:"], visited: ["repair_nonempty", "repair_failed"], skipped: ["answer", "repaired"] })),
    { name: "허용되지 않은 변경 도구는 차단하고 읽기만 수행", input: request, modelReplies: [{ match: "HARNESS_RESEARCH:", occurrence: 1, toolCall: { name: "delete_records", args: {} }, allowedTools: ["lookup_reference"] }, { ...readStep("HARNESS_RESEARCH:", 2), observationContains: ["허용되지"] }, readAnswer("HARNESS_RESEARCH:", goodAnswer, 3)], toolReplies: [readFixture()], toolCallCounts: { lookup_reference: 1, delete_records: 0 }, status: "succeeded", contains: ["시작 10분 전"], skipped: ["repair"] },
    { name: "계속 조회하는 Agent는 도구 2회 한도에서 중단", input: request, modelReplies: [readStep("HARNESS_RESEARCH:", 1), readStep("HARNESS_RESEARCH:", 2), readStep("HARNESS_RESEARCH:", 3)], toolReplies: [readFixture(2)], toolCallCounts: { lookup_reference: 2 }, status: "budget_exceeded", errorContains: ["한도"], resumeAgain: true },
    { name: "도구 인자 스키마 오류는 실제 도구 호출 없이 수정 경로", input: request, modelReplies: [{ match: "HARNESS_RESEARCH:", toolCall: { name: "lookup_reference", args: { query: 9 } }, allowedTools: ["lookup_reference"] }, readStep("HARNESS_REPAIR:"), readAnswer("HARNESS_REPAIR:", goodAnswer)], toolReplies: [readFixture()], toolCallCounts: { lookup_reference: 1 }, status: "succeeded", contains: ["한 번 수정"], visited: ["repair"], skipped: ["answer"] },
  ] satisfies WorkflowScenario[],
};

const approvedPublishing: WorkflowDesign = {
  id: "showcase-approved-publishing", title: "대표 ⑥ · 내용 검토와 변경 승인을 분리한 서비스 등록", category: "대표 AI 시스템",
  description: "Agent가 만든 등록 내용을 검사하고 사람이 검토합니다. 검토를 수락한 뒤에도 별도 외부 변경 승인이 있어야 실제 MCP 등록 도구를 실행합니다. 재개 시 완료된 등록을 반복하지 않습니다.",
  behavior: "요청 → 구조화된 등록 초안 → 필수 항목·빈 문자열 검사 → 사람 내용 검토 → 정확한 도구 인자 승인 → 실제 MCP 등록 → 서비스 응답 표시. 검토 거절·변경 승인 거절·응답 유실은 서로 다른 경로와 상태로 기록합니다. 변경 결과가 불명확하면 자동 재시도하지 않습니다.",
  definition: graph([
    node("input", "form", "등록할 내용 요청", { form: { fields: [{ key: "request", label: "등록 내용과 대상에 대한 요청", type: "text", required: true }] } }),
    limitedAgent("draft", "등록 내용 초안 Agent", "PUBLISH_DRAFT: 요청을 바탕으로 {title:string,body:string} JSON만 작성하세요. 제목과 본문을 비우지 마세요. 외부 서비스에는 아직 등록하지 않습니다.", { format: "JSON", outputSchema: recordSchema, onError: "branch", limits: { maxTurns: 1, maxToolCalls: 1, maxTokens: 5000, maxDurationMs: 30000 } }),
    node("fields", "transform", "등록 필드만 선택", { transform: { mode: "pick", fields: { title: "data.title", body: "data.body" } }, inputBindings: { data: bind("draft", "data") } }),
    node("nonempty", "evaluate", "빈 제목과 본문 차단", { evaluation: { mode: "rules", rules: [{ kind: "not_contains", value: '"title":""' }, { kind: "not_contains", value: '"body":""' }], rubric: "필수 필드의 빈 문자열 검사이며 내용의 사실 정확도는 사람이 검토합니다.", threshold: 1 }, inputBindings: { text: bind("fields"), data: bind("fields", "data") } }),
    node("valid", "condition", "등록 내용 검사 통과", { predicate: { path: "passed", operator: "eq", value: true }, inputBindings: { passed: bind("nonempty", "evaluation.passed"), text: bind("nonempty"), data: bind("nonempty", "data") } }),
    node("review", "review", "등록할 제목과 본문 검토", { review: { instructions: "표시된 제목과 본문을 검토하세요. 수락은 내용 확인이며 외부 변경 승인이 아닙니다. 다음 단계에서 정확한 도구와 인자를 별도로 승인해야 실제로 등록됩니다. 수정이 필요하면 거절 후 새 요청을 시작하세요.", allowEdit: false, timeoutMinutes: 60 }, inputBindings: { text: bind("valid"), data: bind("valid", "data") } }),
    node("publish", "tool", "승인 후 외부 서비스 등록", { allowedTools: [publish], tool: { arguments: {}, bindings: { title: "data.title", body: "data.body" } }, inputBindings: { data: bind("review", "data") }, outputSchema: { type: "object", properties: { data: { type: "object", properties: { structuredContent: { type: "object", properties: { recordId: { type: "string" } }, required: ["recordId"] } }, required: ["structuredContent"] } }, required: ["data"] } }),
    node("record_id_present", "condition", "서비스 등록 ID가 비어 있지 않은가", { predicate: { path: "data.structuredContent.recordId", operator: "ne", value: "" }, inputBindings: { data: bind("publish", "data"), text: bind("publish") } }),
    { ...message("receipt", "서비스가 반환한 등록 결과", "서비스가 반환한 등록 ID: {{data.structuredContent.recordId}}\n완료된 호출 기록을 저장했습니다. 같은 실행을 재개해도 등록을 반복하지 않습니다."), inputBindings: { data: bind("record_id_present", "data") } }, output("published_out"),
    message("receipt_missing", "등록 결과를 서비스에서 확인", "서비스 응답의 등록 ID가 비어 있어 등록 완료를 확인하지 못했습니다. 서비스에서 실제 결과를 확인하세요. 호출 기록을 보존하며 같은 실행을 재개해도 자동 재등록하지 않습니다."), output("receipt_missing_out"),
    message("review_denied", "검토 거절로 등록 중지", "내용 검토를 거절했습니다. 외부 서비스에 등록하지 않았습니다."), output("review_denied_out"),
    message("invalid", "등록 내용 보완 요청", "제목과 본문이 있는 JSON 등록 내용이 필요합니다. 내용 검사를 통과하지 못하여 검토·승인·외부 등록을 시작하지 않았습니다."), output("invalid_out"),
  ], [["input", "draft"], ["draft", "fields", "success"], ["draft", "invalid", "error"], ["fields", "nonempty"], ["nonempty", "valid"], ["valid", "review", "yes"], ["valid", "invalid", "no"], ["review", "publish", "yes"], ["review", "review_denied", "no"], ["review_denied", "review_denied_out"], ["publish", "record_id_present"], ["record_id_present", "receipt", "yes"], ["record_id_present", "receipt_missing", "no"], ["receipt", "published_out"], ["receipt_missing", "receipt_missing_out"], ["invalid", "invalid_out"]]),
  resources: [publishing], inputExample: '{"request":"내일 오전 10시에 시작하는 회의 안내를 등록해 주세요."}', expectedOutput: "사람 검토와 외부 변경 승인 후 서비스가 반환한 실제 등록 ID. 미승인·거절·결과 불명확 상태는 완료로 표시하지 않습니다.",
  acceptance: ["모델은 초안만 만들고 외부 변경 도구를 선택할 수 없다.", "스키마 및 빈 제목·본문 검사 실패 시 외부 호출은 0회다. 자동 검사는 빈 문자열을 검사하며 공백만 있는 내용과 의미의 적절성은 사람이 검토한다.", "내용 검토 수락과 외부 변경 승인을 별도로 저장하며 두 단계가 모두 통과해야 호출한다.", "승인 대상은 실행·사용자·도구·정규화한 인자 해시·만료 시각에 결합된다.", "등록 ID가 빈 문자열이면 등록 완료 안내 대신 서비스에서 직접 확인할 결과를 반환한다. ID의 서비스상 유효성은 별도 조회하지 않는다.", "재시작·동일 승인·완료 후 재개는 등록을 반복하지 않으며 응답 유실은 확인 필요 상태로 멈춘다."],
  failureCases: ["모델·쓰기 연결 미설정", "초안 필수 항목 누락", "빈 제목 또는 본문", "사람 검토 거절", "외부 변경 승인 거절", "승인 이후 쓰기 응답 유실", "서비스의 등록 ID 응답 형식 오류"],
  scenarios: [
    { name: "내용 검토 전에는 외부 쓰기 0회", input: '{"request":"내일 오전 10시 회의 안내"}', modelReplies: [draftReply], toolCallCounts: { create_record: 0 }, status: "waiting_review", visited: ["draft", "fields", "nonempty", "valid"] },
    { name: "내용 검토 수락만으로 등록하지 않고 별도 승인 대기", input: '{"request":"내일 오전 10시 회의 안내"}', modelReplies: [draftReply], review: "accept", toolCallCounts: { create_record: 0 }, status: "waiting_approval", visited: ["review"] },
    { name: "두 단계 승인 후 재시작과 재개에도 정확히 한 번 등록", input: '{"request":"내일 오전 10시 회의 안내"}', modelReplies: [draftReply], review: "accept", approval: "approve", toolReplies: [writeFixture], toolCallCounts: { create_record: 1 }, resumeAgain: true, status: "succeeded", contains: ["record-test-41"], visited: ["publish", "receipt"], skipped: ["invalid", "review_denied"] },
    { name: "내용 검토 거절은 변경 승인과 등록 모두 생략", input: '{"request":"내일 오전 10시 회의 안내"}', modelReplies: [draftReply], review: "reject", toolCallCounts: { create_record: 0 }, status: "succeeded", contains: ["등록하지 않았습니다"], visited: ["review_denied"], skipped: ["publish", "receipt"] },
    { name: "외부 변경 승인 거절은 쓰기 없이 실패로 종료", input: '{"request":"내일 오전 10시 회의 안내"}', modelReplies: [draftReply], review: "accept", approval: "deny", toolCallCounts: { create_record: 0 }, resumeAgain: true, status: "failed", errorContains: ["거절"] },
    { name: "등록 응답 유실은 확인 필요 상태이며 재개로 재시도하지 않음", input: '{"request":"내일 오전 10시 회의 안내"}', modelReplies: [draftReply], review: "accept", approval: "approve", toolReplies: [{ name: "create_record", args: writeFixture.args, error: "disconnect" }], toolCallCounts: { create_record: 1 }, resumeAgain: true, status: "unknown_outcome", errorContains: ["확인"] },
    { name: "초안 필수 본문 누락은 검토 이전에 차단", input: '{"request":"내일 오전 10시 회의 안내"}', modelReplies: [{ ...draftReply, text: '{"title":"회의 일정 안내"}' }], toolCallCounts: { create_record: 0 }, status: "succeeded", contains: ["내용 검사를 통과하지 못하여"], visited: ["invalid"], skipped: ["review", "publish"] },
    { name: "빈 제목은 스키마가 맞아도 등록하지 않음", input: '{"request":"내일 오전 10시 회의 안내"}', modelReplies: [{ ...draftReply, text: '{"title":"","body":"회의 안내"}' }], toolCallCounts: { create_record: 0 }, status: "succeeded", contains: ["내용 검사를 통과하지 못하여"], skipped: ["review", "publish"] },
    { name: "등록 ID가 없는 서비스 응답은 성공으로 표시하지 않음", input: '{"request":"내일 오전 10시 회의 안내"}', modelReplies: [draftReply], review: "accept", approval: "approve", toolReplies: [{ ...writeFixture, result: { structuredContent: {}, content: [] } }], toolCallCounts: { create_record: 1 }, resumeAgain: true, status: "failed" },
    { name: "빈 등록 ID는 완료 안내 대신 서비스 확인 요청하며 재등록하지 않음", input: '{"request":"내일 오전 10시 회의 안내"}', modelReplies: [draftReply], review: "accept", approval: "approve", toolReplies: [{ ...writeFixture, result: { structuredContent: { recordId: "" }, content: [] } }], toolCallCounts: { create_record: 1 }, resumeAgain: true, status: "succeeded", contains: ["등록 완료를 확인하지 못했습니다", "자동 재등록하지 않습니다"], excludes: ["서비스가 반환한 등록 ID:"], visited: ["receipt_missing"], skipped: ["receipt", "published_out"] },
  ] satisfies WorkflowScenario[],
};

export const representativeControlDesigns: WorkflowDesign[] = [harness, approvedPublishing];
