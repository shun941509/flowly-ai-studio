import type { Definition, FlowNode } from "../../app/lib/model";
import type { DataSchema, InputBinding } from "../../runtime/types";
import type { WorkflowDesign, WorkflowScenario } from "../workflow-design";
import { layoutWorkflow } from "../workflow-layout";

// These two authored projects demonstrate different execution contracts: a
// concurrent fan-out with missing-review gates, and a sequential editorial team.
const b = (nodeId: string, path = "text"): InputBinding => ({ nodeId, path });
const n = (id: string, type: FlowNode["type"], title: string, extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title, x: 240, y: 0, ...extra });
const graph = (nodes: FlowNode[], links: [string, string, string?][]): Definition => layoutWorkflow({ schemaVersion: 5, nodes, edges: links.map(([source, target, branch], index) => ({ id: `edge_${index}`, source, target, ...(branch ? { branch } : {}) })) });
const str: DataSchema = { type: "string" }, bool: DataSchema = { type: "boolean" };
const obj = (properties: Record<string, DataSchema>): DataSchema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const jsonSchema = (data: DataSchema) => obj({ text: str, data });
const modelLimits = { maxTurns: 1, maxToolCalls: 1, maxTokens: 4000, maxDurationMs: 45000 };
const agent = (id: string, title: string, prompt: string, data: DataSchema, extra: Partial<FlowNode> = {}) => n(id, "agent", title, { prompt, allowedTools: [], format: "JSON", outputSchema: jsonSchema(data), limits: modelLimits, ...extra });
const text = (id: string, title: string, template: string, inputBindings?: Record<string, InputBinding>) => n(id, "transform", title, { transform: { mode: "template", template }, inputBindings });
const condition = (id: string, title: string, path: string, value: string | boolean, inputBindings: Record<string, InputBinding>, operator: "eq" | "ne" = "eq") => n(id, "condition", title, { predicate: { path, operator, value }, inputBindings });
const out = (id: string, title: string, source: string, path = "text", extra: Record<string, InputBinding> = {}) => n(id, "output", title, { inputBindings: { text: b(source, path), ...extra } });

const proposalSchema = obj({ verdict: str, evidence: str, risk: str, questions: str });
function proposalTask(id: string, name: string, focus: string) {
  const input = `${id}_input`, review = `${id}_agent`, nonempty = `${id}_evidence`, result = `${id}_result`;
  const missing = `${id}_missing`, missingData = `${id}_missing_data`, missingOut = `${id}_missing_out`;
  return { id, name, definition: graph([
    n(input, "input", `${name}에 원문 전달`),
    agent(review, `${name} Agent`, `SHOWCASE_PROPOSAL_${id.toUpperCase()}: proposal의 원문을 ${focus} 관점에서 검토하세요. {verdict:string,evidence:string,risk:string,questions:string} JSON만 반환하세요. evidence에는 원문에서 확인한 구체적인 사실을 적으세요. 알려지지 않은 수치와 효과를 만들지 말고 risk와 questions에 남기세요. 이는 검토 의견이며 사업 실행 승인이 아닙니다.`, proposalSchema, { onError: "branch", inputBindings: { proposal: b(input, "proposal") } }),
    condition(nonempty, `${name} 근거가 비어 있지 않은가`, "data.evidence", "", { text: b(review), data: b(review, "data") }, "ne"),
    out(result, `${name} 검토 결과`, nonempty, "text", { available: b(nonempty, "matched"), review: b(nonempty, "data") }),
    // A constant JSON status normalizes recoverable model errors into a typed
    // child result. It is never substituted for an actual model review.
    text(missing, `${name} 누락 상태 만들기`, JSON.stringify({ available: false, role: name, reason: "연결 또는 응답 형식 오류로 필수 검토 누락" })),
    n(missingData, "transform", `${name} 누락 상태 읽기`, { transform: { mode: "parse_json" } }),
    out(missingOut, `${name} 누락 기록`, missingData, "text", { available: b(missingData, "data.available"), role: b(missingData, "data.role"), error: b(review, "error") }),
  ], [[input, review], [review, nonempty, "success"], [nonempty, result, "yes"], [nonempty, result, "no"], [review, missing, "error"], [missing, missingData], [missingData, missingOut], [review, missingOut, "error"]]) };
}

const proposalInput = "제안 P-17: 내부 문서 검색 도입. 초기 예산 800만원, 운영자 1명, 시범 기간 4주. 사용자 수요와 문서 갱신 담당자는 아직 미확인.";
const goodReviews = [
  { match: "SHOWCASE_PROPOSAL_BUSINESS:", text: JSON.stringify({ verdict: "수요 확인 필요", evidence: "초기 예산 800만원", risk: "사용자 수요 미확인", questions: "사용 빈도 조사 필요" }), inputContains: [proposalInput], delayMs: 120 },
  { match: "SHOWCASE_PROPOSAL_TECHNICAL:", text: JSON.stringify({ verdict: "시범 구현 가능성 검토", evidence: "시범 기간 4주", risk: "자료 갱신 담당자 미확인", questions: "색인 갱신 주기는?" }), inputContains: [proposalInput], delayMs: 120 },
  { match: "SHOWCASE_PROPOSAL_OPERATIONAL:", text: JSON.stringify({ verdict: "운영 보완 필요", evidence: "운영자 1명", risk: "단독 운영 부담", questions: "대체 담당자는?" }), inputContains: [proposalInput], delayMs: 120 },
];
const reportReply = { match: "SHOWCASE_PROPOSAL_SYNTHESIS:", text: JSON.stringify({ report: "수요·갱신 책임·대체 운영 담당자를 확인한 뒤 시범 도입을 결정하세요. 검토 세 건을 종합했으며 도입을 승인하지 않았습니다.", conflict: false }), inputContains: [proposalInput, "수요 확인 필요", "시범 구현 가능성 검토", "운영 보완 필요", "사용 빈도 조사 필요"] };
const proposalDefinition = graph([
  n("proposal_input", "input", "검토할 제안서 원문"),
  n("proposal_reviews", "parallel", "사업·기술·운영 동시 검토", { inputBindings: { proposal: b("proposal_input") }, limits: { maxTurns: 6, maxToolCalls: 3, maxTokens: 6000, maxDurationMs: 90000 }, parallel: { concurrency: 3, tasks: [proposalTask("business", "사업성", "수요·예산·효과"), proposalTask("technical", "기술", "구현 범위·기간·자료 갱신"), proposalTask("operational", "운영 위험", "담당 인력·인수인계·운영 부담")] } }),
  condition("business_present", "사업성 필수 검토 확보", "results.0.output.available", true, { results: b("proposal_reviews", "results"), text: b("proposal_reviews"), proposal: b("proposal_input") }),
  condition("technical_present", "기술 필수 검토 확보", "results.1.output.available", true, { results: b("business_present", "results"), text: b("business_present"), proposal: b("business_present", "proposal") }),
  condition("operational_present", "운영 필수 검토 확보", "results.2.output.available", true, { results: b("technical_present", "results"), text: b("technical_present"), proposal: b("technical_present", "proposal") }),
  // The active failing gate contributes the common results array. No required
  // binding points at a different, possibly skipped gate.
  n("proposal_missing", "merge", "실제 누락 지점의 검토 결과 모으기", { merge: { mode: "text", separator: "\n", deduplicate: true }, inputBindings: { business: b("business_present", "results"), technical: b("technical_present", "results"), operational: b("operational_present", "results") } }),
  text("proposal_hold_notice", "필수 검토 누락으로 판정 보류", "필수 검토가 누락되어 종합 판정을 보류했습니다. available=false인 역할을 확인하고 다시 실행하세요. 완료된 역할의 검토는 아래에 보존합니다.\n{{text}}", { text: b("proposal_missing") }),
  agent("proposal_synthesis", "근거·충돌·질문 종합", "SHOWCASE_PROPOSAL_SYNTHESIS: proposal의 원문과 businessReview·technicalReview·operationalReview의 사업성·기술·운영 검토를 함께 읽으세요. {report:string,conflict:boolean} JSON을 반환하세요. 의견 충돌, 누락된 사업 조건과 추가 질문을 보존하세요. 결과는 검토 보고서이며 사업 도입이나 외부 변경을 승인하지 않습니다.", obj({ report: str, conflict: bool }), { inputBindings: { proposal: b("operational_present", "proposal"), businessReview: b("operational_present", "results.0.output.review"), technicalReview: b("operational_present", "results.1.output.review"), operationalReview: b("operational_present", "results.2.output.review") } }),
  condition("proposal_nonempty", "종합 보고서가 비어 있지 않은가", "data.report", "", { data: b("proposal_synthesis", "data") }, "ne"),
  text("proposal_empty", "빈 보고서 확정 중단", "종합 보고서가 비어 있어 확정하지 않았습니다. 완료된 역할별 검토를 확인하고 다시 실행하세요.", {}),
  out("proposal_empty_out", "보고서 생성 보류", "proposal_empty"),
  condition("proposal_conflict", "검토 의견 간 충돌", "data.conflict", true, { data: b("proposal_nonempty", "data") }),
  text("proposal_conflict_notice", "충돌을 남긴 보고서", "검토 의견에 충돌이 있어 담당자 확인이 필요합니다.\n{{report}}", { report: b("proposal_conflict", "data.report") }),
  out("proposal_report", "종합 검토 보고서", "proposal_conflict", "data.report"),
  out("proposal_conflict_out", "충돌 확인 요청", "proposal_conflict_notice"),
  out("proposal_hold_out", "누락 역할과 완료된 검토", "proposal_hold_notice"),
], [["proposal_input", "proposal_reviews"], ["proposal_input", "business_present"], ["proposal_reviews", "business_present"], ["business_present", "technical_present", "yes"], ["technical_present", "operational_present", "yes"], ["business_present", "proposal_missing", "no"], ["technical_present", "proposal_missing", "no"], ["operational_present", "proposal_missing", "no"], ["operational_present", "proposal_synthesis", "yes"], ["proposal_synthesis", "proposal_nonempty"], ["proposal_nonempty", "proposal_empty", "no"], ["proposal_empty", "proposal_empty_out"], ["proposal_nonempty", "proposal_conflict", "yes"], ["proposal_conflict", "proposal_conflict_notice", "yes"], ["proposal_conflict", "proposal_report", "no"], ["proposal_conflict_notice", "proposal_conflict_out"], ["proposal_missing", "proposal_hold_notice"], ["proposal_hold_notice", "proposal_hold_out"]]);

const proposalScenarios: WorkflowScenario[] = [
  { name: "세 Agent의 실제 검토가 모두 종합 입력에 전달", input: proposalInput, status: "succeeded", modelReplies: [...goodReviews, reportReply], parallelMatches: goodReviews.map(reply => reply.match), contains: ["수요·갱신 책임·대체 운영 담당자", "도입을 승인하지 않았습니다"], visited: ["business_agent", "technical_agent", "operational_agent", "proposal_synthesis", "proposal_report"], skipped: ["proposal_missing", "proposal_conflict_notice"], outputs: { proposal_reviews: { count: 3 } } },
  { name: "사업성 JSON 오류는 다른 검토를 보존하고 판정 보류", input: proposalInput, status: "succeeded", modelReplies: [{ ...goodReviews[0], text: "JSON 아닌 응답" }, ...goodReviews.slice(1)], contains: ["종합 판정을 보류", "사업성", "필수 검토 누락", "시범 구현 가능성 검토", "운영 보완 필요"], visited: ["business_missing_out", "technical_result", "operational_result", "proposal_hold_out"], skipped: ["proposal_synthesis"] },
  { name: "기술 검토 필수 필드 누락을 식별", input: proposalInput, status: "succeeded", modelReplies: [goodReviews[0], { ...goodReviews[1], text: '{"verdict":"자료형 위반"}' }, goodReviews[2]], contains: ["종합 판정을 보류", "기술", "필수 검토 누락", "수요 확인 필요", "운영 보완 필요"], visited: ["technical_missing_out", "proposal_hold_out"], skipped: ["proposal_synthesis"] },
  { name: "운영 검토의 빈 근거도 필수 검토 누락", input: proposalInput, status: "succeeded", modelReplies: [goodReviews[0], goodReviews[1], { ...goodReviews[2], text: '{"verdict":"문제없음","evidence":"","risk":"미확인","questions":"담당자 확인"}' }], contains: ["종합 판정을 보류", '"available":false', "담당자 확인"], visited: ["operational_result", "proposal_hold_out"], skipped: ["proposal_synthesis"] },
  { name: "의견 충돌은 승인으로 숨기지 않고 표시", input: proposalInput, status: "succeeded", modelReplies: [...goodReviews, { ...reportReply, text: '{"report":"사업은 즉시 시범 도입, 운영은 대체 담당자 지정 후 시작이라는 조건이 충돌합니다.","conflict":true}' }], contains: ["담당자 확인이 필요", "조건이 충돌"], visited: ["proposal_conflict_out"], skipped: ["proposal_report"] },
  { name: "종합 보고서 형식 위반은 성공 출력 금지", input: proposalInput, status: "failed", modelReplies: [...goodReviews, { ...reportReply, text: '{"report":"누락된 충돌 판정"}' }], excludes: ["누락된 충돌 판정"] },
  { name: "충돌 없음 판정이어도 빈 종합 보고서는 확정하지 않음", input: proposalInput, status: "succeeded", modelReplies: [...goodReviews, { ...reportReply, text: '{"report":"","conflict":false}' }], contains: ["종합 보고서가 비어 있어 확정하지 않았습니다"], visited: ["proposal_empty_out"], skipped: ["proposal_report", "proposal_conflict_out"] },
];

const editorialInput = JSON.stringify({ topic: "도서관 야간 이용 안내", sources: "안내 A: 야간 개방은 화요일과 목요일 18~21시. 안내 B: 첫 시범 운영은 4주이며 예약은 무료이다. 주말 운영 근거는 없다." });
const researchReply = { match: "SHOWCASE_EDITORIAL_RESEARCH:", text: '{"evidence":"화·목 18~21시, 4주 시범 운영, 무료 예약","unverified":"주말 운영 근거 없음"}', inputContains: ["도서관 야간 이용 안내", "화요일과 목요일 18~21시", "주말 운영 근거는 없다"] };
const writerReply = { match: "SHOWCASE_EDITORIAL_WRITE:", text: '{"draft":"도서관은 화·목 18~21시 무료 예약으로 4주간 야간 개방합니다. 주말 운영은 미확인입니다."}', inputContains: ["화·목 18~21시, 4주 시범 운영, 무료 예약", "주말 운영 근거 없음", "안내 A"] };
const passCritique = { match: "SHOWCASE_EDITORIAL_CRITIQUE:", text: '{"passed":true,"issues":"제공된 근거 범위 내이며 주말 미확인 표시 유지"}', inputContains: ["도서관은 화·목", "4주 시범 운영", "안내 B"] };
const failCritique = { ...passCritique, text: '{"passed":false,"issues":"무료 예약과 무료 이용을 구분하고 시범 종료 후 운영을 확정하지 마세요."}' };
const reviseReply = { match: "SHOWCASE_EDITORIAL_REVISE:", text: '{"draft":"화·목 18~21시에 4주간 시범 개방하며 예약은 무료입니다. 이용료·시범 이후·주말 운영은 별도 확인이 필요합니다."}', inputContains: ["도서관은 화·목", "무료 예약과 무료 이용을 구분", "안내 A", "주말 운영 근거 없음"] };
const verifyReply = { match: "SHOWCASE_EDITORIAL_VERIFY:", text: '{"passed":true,"issues":"예약 무료와 미확인 조건을 구분했습니다."}', inputContains: ["이용료·시범 이후·주말 운영은 별도 확인", "무료 예약과 무료 이용을 구분", "화·목 18~21시, 4주 시범 운영, 무료 예약", "안내 A"] };

const editorialDefinition = graph([
  n("editorial_input", "form", "주제와 원자료 입력", { form: { fields: [{ key: "topic", label: "작성할 주제", type: "text", required: true }, { key: "sources", label: "검토할 원자료와 출처 설명", type: "text", required: true }] } }),
  agent("editorial_research", "조사 Agent · 근거와 미확인 분리", "SHOWCASE_EDITORIAL_RESEARCH: 제공된 topic과 sources만 분석해 {evidence:string,unverified:string} JSON을 만드세요. 원자료의 출처와 확인한 사실, 미확인 항목을 구분하세요. 외부 검색을 수행했다고 말하지 마세요.", obj({ evidence: str, unverified: str }), { inputBindings: { topic: b("editorial_input", "data.topic"), sources: b("editorial_input", "data.sources") } }),
  agent("editorial_write", "작성 Agent · 근거로 초안 작성", "SHOWCASE_EDITORIAL_WRITE: topic, sources, evidence를 사용해 {draft:string} JSON의 안내문을 작성하세요. evidence.unverified의 미확인 사항을 사실로 바꾸지 마세요. 출처에 없는 비용·일정·정책을 추정하지 마세요.", obj({ draft: str }), { inputBindings: { topic: b("editorial_input", "data.topic"), sources: b("editorial_input", "data.sources"), evidence: b("editorial_research", "data") } }),
  agent("editorial_critique", "검토 Agent · 원자료와 초안 대조", "SHOWCASE_EDITORIAL_CRITIQUE: sources의 원문과 evidence를 draft와 대조하세요. {passed:boolean,issues:string} JSON을 반환하세요. 근거 없는 주장, 누락, 모순 또는 빈 초안이면 passed=false로 하고 수정할 문장과 이유를 구체적으로 적으세요. passed=true는 제공 자료와의 검토 통과이며 외부 사실 검증을 뜻하지 않습니다.", obj({ passed: bool, issues: str }), { inputBindings: { sources: b("editorial_input", "data.sources"), evidence: b("editorial_research", "data"), draft: b("editorial_write", "data.draft") } }),
  condition("editorial_passed", "초안 검토 통과", "assessment.passed", true, { assessment: b("editorial_critique", "data"), draft: b("editorial_write", "data.draft"), sources: b("editorial_input", "data.sources"), evidence: b("editorial_research", "data") }),
  condition("editorial_direct_nonempty", "검토 통과 원초안이 비어 있지 않은가", "draft", "", { draft: b("editorial_passed", "draft") }, "ne"),
  out("editorial_direct", "검토를 통과한 원초안", "editorial_direct_nonempty", "draft"),
  agent("editorial_revise", "수정 Agent · 지적한 내용 반영", "SHOWCASE_EDITORIAL_REVISE: sources와 evidence에 맞춰 draft를 고치고 {draft:string} JSON을 반환하세요. assessment.issues의 실제 지적을 반영하고 새 사실을 만들지 마세요. 미확인 사항은 미확인으로 유지하세요.", obj({ draft: str }), { inputBindings: { draft: b("editorial_passed", "draft"), sources: b("editorial_passed", "sources"), evidence: b("editorial_passed", "evidence"), assessment: b("editorial_passed", "assessment") } }),
  agent("editorial_verify", "최종 검사 Agent · 수정 반영 확인", "SHOWCASE_EDITORIAL_VERIFY: revised의 수정본이 assessment.issues를 해결했고 sources와 evidence 범위를 벗어나지 않았는지 다시 확인하세요. {passed:boolean,issues:string} JSON을 반환하세요. 수정되지 않은 지적·새 주장·빈 문서면 passed=false입니다. 자동 수정은 이번 한 번만 허용됩니다.", obj({ passed: bool, issues: str }), { inputBindings: { revised: b("editorial_revise", "data.draft"), sources: b("editorial_passed", "sources"), evidence: b("editorial_passed", "evidence"), assessment: b("editorial_passed", "assessment") } }),
  condition("editorial_final_passed", "수정본 최종 검사 통과", "assessment.passed", true, { assessment: b("editorial_verify", "data"), draft: b("editorial_revise", "data.draft"), sources: b("editorial_passed", "sources"), originalIssues: b("editorial_passed", "assessment.issues"), evidence: b("editorial_passed", "evidence") }),
  condition("editorial_revised_nonempty", "검토 통과 수정본이 비어 있지 않은가", "draft", "", { draft: b("editorial_final_passed", "draft") }, "ne"),
  out("editorial_revised", "검사를 통과한 수정본", "editorial_revised_nonempty", "draft"),
  text("editorial_empty", "빈 문서 확정 중단", "문서가 비어 있어 확정하지 않았습니다. 검토 Agent의 통과 판정을 그대로 사용하지 않고 작성 내용을 확인하도록 보류했습니다.", {}),
  out("editorial_empty_out", "문서 생성 보류", "editorial_empty"),
  n("editorial_human", "review", "남은 지적을 사람에게 전달", { inputBindings: { text: b("editorial_final_passed", "draft"), sources: b("editorial_final_passed", "sources"), evidence: b("editorial_final_passed", "evidence"), unresolved: b("editorial_final_passed", "assessment.issues"), originalIssues: b("editorial_final_passed", "originalIssues") }, review: { instructions: "원자료·추출 근거·초기 지적·수정본·남은 지적을 함께 확인하세요. 자동 검사는 통과하지 못했습니다. 내용 수락 또는 거절을 선택하며 이 단계에서 원자료를 바꾸지 않습니다.", allowEdit: false, timeoutMinutes: 60 } }),
  text("editorial_human_accept", "사람 확인과 남은 지적 기록", "사람이 확인하여 수락한 문서입니다. 자동 검사는 통과하지 못했으며 아래 지적을 기록합니다.\n남은 지적: {{unresolved}}\n{{text}}", { text: b("editorial_human"), unresolved: b("editorial_human", "unresolved") }),
  text("editorial_human_reject", "미해결 문서 확정 중단", "수정본이 거절되어 최종 문서를 확정하지 않았습니다. 원자료와 지적 사항을 보완해 다시 실행하세요."),
  out("editorial_accepted", "사람이 수락한 문서와 지적", "editorial_human_accept"), out("editorial_rejected", "거절 결과", "editorial_human_reject"),
], [["editorial_input", "editorial_research"], ["editorial_input", "editorial_write"], ["editorial_research", "editorial_write"], ["editorial_input", "editorial_critique"], ["editorial_research", "editorial_critique"], ["editorial_write", "editorial_critique"], ["editorial_critique", "editorial_passed"], ["editorial_input", "editorial_passed"], ["editorial_research", "editorial_passed"], ["editorial_write", "editorial_passed"], ["editorial_passed", "editorial_direct_nonempty", "yes"], ["editorial_direct_nonempty", "editorial_direct", "yes"], ["editorial_direct_nonempty", "editorial_empty", "no"], ["editorial_passed", "editorial_revise", "no"], ["editorial_passed", "editorial_verify", "no"], ["editorial_revise", "editorial_verify"], ["editorial_passed", "editorial_final_passed", "no"], ["editorial_revise", "editorial_final_passed"], ["editorial_verify", "editorial_final_passed"], ["editorial_final_passed", "editorial_revised_nonempty", "yes"], ["editorial_revised_nonempty", "editorial_revised", "yes"], ["editorial_revised_nonempty", "editorial_empty", "no"], ["editorial_empty", "editorial_empty_out"], ["editorial_final_passed", "editorial_human", "no"], ["editorial_human", "editorial_human_accept", "yes"], ["editorial_human", "editorial_human_reject", "no"], ["editorial_human_accept", "editorial_accepted"], ["editorial_human_reject", "editorial_rejected"]]);

const unresolvedReply = { ...verifyReply, text: '{"passed":false,"issues":"이용료 정보가 원자료에 없어 담당자 확인이 필요합니다."}' };
const editorialScenarios: WorkflowScenario[] = [
  { name: "조사·작성·검토 통과 시 수정 Agent 생략", input: editorialInput, status: "succeeded", modelReplies: [researchReply, writerReply, passCritique], contains: ["도서관은 화·목 18~21시", "주말 운영은 미확인"], visited: ["editorial_direct"], skipped: ["editorial_revise", "editorial_verify", "editorial_human"] },
  { name: "실제 초안과 지적을 전달해 한 번 수정 후 재검사", input: editorialInput, status: "succeeded", modelReplies: [researchReply, writerReply, failCritique, reviseReply, verifyReply], contains: ["예약은 무료", "이용료·시범 이후·주말 운영은 별도 확인"], visited: ["editorial_revise", "editorial_verify", "editorial_revised"], skipped: ["editorial_direct", "editorial_human"] },
  { name: "수정 후에도 남은 지적은 원자료와 함께 사람 검토 대기", input: editorialInput, status: "waiting_review", modelReplies: [researchReply, writerReply, failCritique, reviseReply, unresolvedReply], outputs: { editorial_final_passed: { matched: false } } },
  { name: "미해결 문서는 사람 수락이어도 자동 통과로 표시하지 않음", input: editorialInput, review: "accept", status: "succeeded", modelReplies: [researchReply, writerReply, failCritique, reviseReply, unresolvedReply], contains: ["사람이 확인하여 수락", "자동 검사는 통과하지 못했으며", "이용료 정보가 원자료에 없어", "예약은 무료"], visited: ["editorial_accepted"], skipped: ["editorial_revised", "editorial_rejected"] },
  { name: "미해결 문서 거절은 초안을 확정 결과로 내보내지 않음", input: editorialInput, review: "reject", status: "succeeded", modelReplies: [researchReply, writerReply, failCritique, reviseReply, unresolvedReply], contains: ["최종 문서를 확정하지 않았습니다"], excludes: ["화·목 18~21시"], visited: ["editorial_rejected"], skipped: ["editorial_accepted", "editorial_revised"] },
  { name: "조사 JSON 형식 오류에서 후속 작성 중단", input: editorialInput, status: "failed", modelReplies: [{ ...researchReply, text: "잘못된 조사 응답" }], excludes: ["잘못된 조사 응답"] },
  { name: "검토 passed 문자열은 참으로 취급하지 않음", input: editorialInput, status: "failed", modelReplies: [researchReply, writerReply, { ...passCritique, text: '{"passed":"true","issues":"잘못된 자료형"}' }], excludes: ["도서관은 화·목"] },
  { name: "최종 검사 판정 누락이면 수정본 성공 출력 금지", input: editorialInput, status: "failed", modelReplies: [researchReply, writerReply, failCritique, reviseReply, { ...verifyReply, text: '{"issues":"판정 없음"}' }], excludes: ["예약은 무료"] },
  { name: "원자료 미입력은 모델 호출 전 실패", input: '{"topic":"도서관 야간 이용 안내","sources":""}', status: "failed" },
  { name: "검토 통과 판정이어도 빈 원초안을 확정하지 않음", input: editorialInput, status: "succeeded", modelReplies: [researchReply, { ...writerReply, text: '{"draft":""}' }, { ...passCritique, inputContains: ['"draft":""', "안내 B"] }], contains: ["문서가 비어 있어 확정하지 않았습니다"], visited: ["editorial_empty_out"], skipped: ["editorial_direct", "editorial_revise"] },
  { name: "최종 검사 통과 판정이어도 빈 수정본을 확정하지 않음", input: editorialInput, status: "succeeded", modelReplies: [researchReply, writerReply, failCritique, { ...reviseReply, text: '{"draft":""}' }, { ...verifyReply, inputContains: ['"revised":""', "무료 예약과 무료 이용을 구분", "안내 A"] }], contains: ["문서가 비어 있어 확정하지 않았습니다"], visited: ["editorial_empty_out"], skipped: ["editorial_direct", "editorial_revised", "editorial_human"] },
];

export const representativeCollaborationDesigns: WorkflowDesign[] = [
  { id: "showcase-parallel-proposal", title: "대표 1 · 세 Agent가 병렬 검토하는 제안서", category: "대표 AI 시스템", description: "원문을 사업성·기술·운영 Agent에 동시에 전달하고 필수 검토가 모두 모였을 때만 종합합니다.", behavior: "세 역할을 동시성 3으로 실행합니다. 연결·응답 형식 오류 또는 빈 근거는 누락 역할로 보존하고 종합 판정을 보류합니다. 세 검토 확보 후에만 충돌과 추가 질문을 종합합니다. 시간·예산·권한 오류는 실행을 중단하며 도입이나 외부 변경을 승인하지 않습니다.", definition: proposalDefinition, resources: [], inputExample: proposalInput, expectedOutput: "사업·기술·운영 검토를 종합한 보고서 또는 누락 역할과 완료된 검토가 담긴 보류 안내", acceptance: ["세 하위 Agent가 동일한 원문을 받고 동시성 3으로 실행", "필수 검토 누락 시 다른 역할의 완료된 결과를 보존하고 종합 모델 호출 없음", "빈 evidence도 누락 처리하며 JSON 오류를 실제 검토로 가장하지 않음", "모든 검토가 있을 때만 종합하고 충돌이면 담당자 확인 표시", "웹에서 모델 호출 없이 두 내보내기 실행기에서 수행"], failureCases: proposalScenarios.slice(1).map(item => item.name), scenarios: proposalScenarios },
  { id: "showcase-multi-agent-editorial", title: "대표 5 · 조사·작성·검토·수정 에이전트 협업", category: "대표 AI 시스템", description: "원자료를 조사한 근거로 초안을 만들고 검토 지적이 있을 때만 수정·재검사합니다.", behavior: "제공된 원자료 안에서 조사→작성→검토를 실행합니다. 통과하면 원초안을 반환하고, 미통과면 원문·근거·초안·실제 지적을 수정 Agent에 넘겨 한 번 고칩니다. 최종 검사가 미해결이면 근거와 지적을 함께 저장해 사람 검토를 기다립니다. 외부 검색이나 외부 게시를 수행하지 않습니다.", definition: editorialDefinition, resources: [], inputExample: editorialInput, expectedOutput: "검토를 통과한 원초안·수정본, 또는 미해결 지적과 원자료가 담긴 사람 검토 요청", acceptance: ["작성자는 실제 조사 결과와 원자료를, 검토자는 실제 초안과 같은 근거를 받음", "검토 통과 시 수정·재검사 모델을 호출하지 않음", "수정은 한 번이며 수정본과 초기 지적을 최종 검사에 전달", "미해결 검토에 원문·근거·수정본·초기 및 남은 지적 보존", "사람 수락을 자동 검증 통과로 표시하지 않고 거절 시 문서를 확정하지 않음"], failureCases: editorialScenarios.slice(1).map(item => item.name), scenarios: editorialScenarios },
];
