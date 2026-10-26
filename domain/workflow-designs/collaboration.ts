/**
 * 순차 팀·선택 작업·병렬 조사 등 여러 Agent의 협업 설계다. previous 및 하위 결과 매핑으로 역할 사이에 실제로 전달되는 값을 확인할 수 있다.
 * 노드/연결/자료는 내려받을 설계이며 scenarios의 응답·상태 기대값은 테스트 전용이다.
 */
import type { Definition, FlowEdge, FlowNode, Resource } from "../../app/lib/model";
import type { WorkflowDesign } from "../workflow-design";

// These are seven authored control/data-flow designs. Helpers below only build
// graph syntax; no scenario is produced by changing a domain or framework name.
const n = (id: string, type: FlowNode["type"], title: string, extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title, x: 240, y: 40, ...extra });
const e = (source: string, target: string, branch?: string): FlowEdge => ({ id: `${source}-${target}${branch ? `-${branch}` : ""}`, source, target, ...(branch ? { branch } : {}) });
const graph = (nodes: FlowNode[], edges: FlowEdge[]): Definition => ({ schemaVersion: 5, nodes, edges });
const line = (nodes: FlowNode[]): Definition => graph(nodes.map((node, i) => ({ ...node, y: 40 + i * 180 })), nodes.slice(1).map((node, i) => e(nodes[i].id, node.id)));
const modelLimits = { maxTurns: 2, maxToolCalls: 1, maxTokens: 2500, maxDurationMs: 60000 };
const groupLimits = { maxTurns: 8, maxToolCalls: 6, maxTokens: 8000, maxDurationMs: 120000 };
const doc = (id: string, name: string, content: string): Resource => ({ id, name, content, type: "document", ownerId: "flowly-examples", description: "직접 작성한 합성 자료입니다. 실제 서비스 기록이 아닙니다.", url: "", visibility: "public", allowedEmails: [], createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z", sample: true });

const incidentFacts = doc("collab-incident-facts", "PAY-17 합성 장애 기록", "PAY-17: p95 지연 2200ms, 정상 기준 500ms, 대기열 82건. 제안은 재시도 큐와 결제 제공자의 응답 확인이다. 새 측정이나 정상 복구 확인 기록은 없다. 원인과 복구 성공은 미확인이다.");
const incidentDefinition = line([
  n("incident_input", "input", "장애 검토 요청"),
  n("incident_facts", "resource", "관측 기록 가져오기", { resourceId: incidentFacts.id }),
  n("incident_team", "agent_team", "분석 후 독립 검토", { limits: groupLimits, team: { mode: "sequential", concurrency: 1, tasks: [
    { id: "analysis", name: "측정과 조치 초안", definition: line([
      n("analysis_input", "input", "요청과 측정 기록"),
      n("incident_analysis", "agent", "사실과 제안 분리", { prompt: "장애 초안 작성자입니다. 입력의 측정값·정상 기준·대기열 수와 제안 조치를 나누어 작성하세요. 측정되지 않은 원인이나 복구 성공을 만들지 마세요. 합성 기록이라고 밝히세요.", allowedTools: [], limits: modelLimits }),
      n("analysis_output", "output", "검토할 초안"),
    ]) },
    { id: "challenge", name: "초안의 미확인 주장 검토", definition: line([
      n("challenge_input", "input", "원기록과 이전 초안"),
      n("incident_challenge", "agent", "근거 없는 복구 주장 제거", { prompt: "장애 초안 검토자입니다. source의 원기록과 draft의 앞 역할 초안을 대조하세요. 확인되지 않은 원인·개선 효과·복구 완료 주장은 제거하고 최종 검토문만 작성하세요. 초안 문구를 사실로 신뢰하지 마세요. 2200ms·500ms·82건은 제공된 관측값이며 복구는 미확인입니다.", inputBindings: { source: { nodeId: "challenge_input", path: "text" }, draft: { nodeId: "challenge_input", path: "previous.text" } }, allowedTools: [], limits: modelLimits }),
      n("challenge_output", "output", "검토 완료 초안"),
    ]) },
  ] } }),
  n("incident_output", "output", "검토자의 답변", { inputBindings: { text: { nodeId: "incident_team", path: "results.1.output.text" } } }),
]);

const purchaseFacts = doc("collab-purchase-facts", "PO-104 합성 구매 제약", "PO-104 계약 납기 2026-11-05, 예상 납기 2026-11-08, 예상 지연 3일, 수량 200개다. 공급사 일정은 확약 전이다. 대체 공급사의 단가·규격·수량·납기는 미확인이다. 주문 변경이나 취소는 실행하지 않는다.");
const purchaseDefinition = graph([
  n("purchase_input", "input", "구매 검토 범위", { y: 40 }),
  n("purchase_facts", "resource", "구매 기록", { y: 220, resourceId: purchaseFacts.id }),
  n("purchase_plan", "orchestrator", "필요한 검토만 선택", { y: 400, prompt: "구매 검토의 작업 선택 담당입니다. 납기만 요청하면 delivery만, 대체 조건도 요청하면 delivery와 alternative를 선택하세요. 제공 작업 밖 발주·취소·송금 작업을 선택하지 마세요.", onError: "branch", limits: groupLimits, orchestration: { mode: "plan", maxTasks: 2, tasks: [
    { id: "delivery", name: "계약 납기와 예상 일정", definition: line([
      n("delivery_input", "input", "구매 기록과 요청"),
      n("delivery_agent", "agent", "납기 차이 검토", { prompt: "구매 납기 검토 담당입니다. 계약일과 예상일을 비교하고 지연 일수와 공급사 확약 여부만 답하세요. 예상일을 확정 납기로 바꾸지 마세요.", limits: modelLimits, allowedTools: [] }),
      n("delivery_output", "output", "납기 검토 결과"),
    ]) },
    { id: "alternative", name: "대체 공급사 확인 조건", definition: line([
      n("alternative_input", "input", "대체 검토 요청"),
      n("alternative_agent", "agent", "미확인 대체 조건", { prompt: "대체 공급사 검토 담당입니다. 자료에 없는 공급사 정보를 만들지 말고 단가·규격·수량·납기에서 구매 담당자가 추가 확인할 조건만 작성하세요. 발주 결정과 외부 변경을 수행하지 마세요.", limits: modelLimits, allowedTools: [] }),
      n("alternative_output", "output", "대체 조건 확인 목록"),
    ]) },
  ] } }),
  n("purchase_summary", "transform", "선택한 검토 묶기", { x: 160, y: 600, transform: { mode: "template", template: "실행한 검토 수: {{count}}\n{{text}}\n발주·계약 변경은 실행하지 않았습니다." }, inputBindings: { count: { nodeId: "purchase_plan", path: "count" }, text: { nodeId: "purchase_plan", path: "text" } } }),
  n("purchase_error", "error", "허용되지 않은 선택 안내", { x: 620, y: 600, error: { template: "검토 계획을 실행하지 못했습니다. {{error.message}} 허용된 납기·대체 조건 검토를 다시 선택하세요." }, inputBindings: { error: { nodeId: "purchase_plan", path: "error" } } }),
  n("purchase_output", "output", "구매 검토 결과", { x: 160, y: 800 }),
  n("purchase_error_output", "output", "계획 오류", { x: 620, y: 800 }),
], [e("purchase_input", "purchase_facts"), e("purchase_facts", "purchase_plan"), e("purchase_plan", "purchase_summary", "success"), e("purchase_plan", "purchase_error", "error"), e("purchase_summary", "purchase_output"), e("purchase_error", "purchase_error_output")]);

const releaseDefinition = graph([
  n("release_input", "form", "필수 검사 결과", { y: 40, form: { fields: [
    { key: "unit", label: "단위 테스트", type: "select", required: true, options: ["passed", "failed", "missing"] },
    { key: "backup", label: "마이그레이션 백업", type: "select", required: true, options: ["passed", "failed", "missing"] },
    { key: "accessibility", label: "접근성 검사", type: "select", required: true, options: ["passed", "failed", "missing"] },
  ] } }),
  n("release_checks", "parallel", "세 가지 검사 독립 수집", { y: 220, inputBindings: { data: { nodeId: "release_input", path: "data" } }, parallel: { concurrency: 3, tasks: [
    { id: "unit", name: "단위 테스트", definition: line([n("unit_input", "input", "검사 기록"), n("unit_status", "transform", "단위 검사 상태", { transform: { mode: "template", template: "단위 테스트={{data.unit}}" }, inputBindings: { data: { nodeId: "unit_input", path: "data" } } }), n("unit_output", "output", "단위 검사")]) },
    { id: "backup", name: "백업 준비", definition: line([n("backup_input", "input", "백업 기록"), n("backup_status", "transform", "백업 상태", { transform: { mode: "template", template: "마이그레이션 백업={{data.backup}}" }, inputBindings: { data: { nodeId: "backup_input", path: "data" } } }), n("backup_output", "output", "백업 검사")]) },
    { id: "accessibility", name: "접근성 검사", definition: line([n("accessibility_input", "input", "접근성 기록"), n("accessibility_status", "transform", "접근성 상태", { transform: { mode: "template", template: "접근성 검사={{data.accessibility}}" }, inputBindings: { data: { nodeId: "accessibility_input", path: "data" } } }), n("accessibility_output", "output", "접근성 검사")]) },
  ] } }),
  n("release_evaluate", "evaluate", "실패와 누락 모두 확인", { y: 400, evaluation: { mode: "rules", rules: [{ kind: "not_contains", value: "failed" }, { kind: "not_contains", value: "missing" }], threshold: 1, rubric: "모든 필수 상태가 passed여야 합니다." } }),
  n("release_gate", "condition", "모든 필수 검사 통과", { y: 580, predicate: { path: "evaluation.passed", operator: "eq", value: true }, inputBindings: { text: { nodeId: "release_evaluate", path: "text" }, evaluation: { nodeId: "release_evaluate", path: "evaluation" } } }),
  n("release_ready", "transform", "통과 사실만 기록", { x: 80, y: 770, transform: { mode: "template", template: "필수 검사 모두 통과\n{{text}}\n배포 승인은 별도이며 배포를 실행하지 않았습니다." } }),
  n("release_hold", "agent", "보류 사유 설명", { x: 600, y: 770, prompt: "릴리스 보류 설명 담당입니다. 입력에서 failed와 missing 항목을 각각 실패와 누락으로 설명하세요. passed 항목도 보존하고 미제공 실패 원인이나 복구 방법을 만들지 마세요. 평균 점수로 승인하지 말고 배포를 실행하지 않았음을 밝히세요.", limits: modelLimits, allowedTools: [] }),
  n("release_ready_output", "output", "검사 통과 기록", { x: 80, y: 970 }),
  n("release_hold_output", "output", "출시 보류 사유", { x: 600, y: 970 }),
], [e("release_input", "release_checks"), e("release_checks", "release_evaluate"), e("release_evaluate", "release_gate"), e("release_gate", "release_ready", "yes"), e("release_gate", "release_hold", "no"), e("release_ready", "release_ready_output"), e("release_hold", "release_hold_output")]);

const meetingDefinition = graph([
  n("meeting_input", "input", "회의 발언", { y: 40 }),
  n("meeting_classify", "classify", "명시적 합의 확인", { y: 220, prompt: "회의 합의 분류 담당입니다. 합의·결정이 명시된 발언이 있으면 agreed, 제안이나 요청뿐이면 proposal_only입니다. 침묵이나 담당자 언급만으로 합의를 추정하지 마세요.", classification: { labels: [{ id: "agreed", name: "명시적 합의 있음", description: "합의 또는 결정 내용이 명시됨" }, { id: "proposal_only", name: "제안만 있음", description: "합의 없이 제안·요청만 있음" }] }, limits: modelLimits }),
  n("meeting_draft", "agent", "결정과 미합의 초안", { x: 120, y: 420, prompt: "회의 결정 초안 담당입니다. 입력에서 합의된 담당자·기한·작업과 아직 제안인 내용을 나눠 작성하세요. 출시 제안을 확정 일정으로 바꾸지 마세요. 담당자 확인 전 초안이며 외부에 발송하지 않습니다.", limits: modelLimits, allowedTools: [] }),
  n("meeting_review", "review", "회의 담당자 확인", { x: 120, y: 610, review: { instructions: "실제 합의 발언·담당자·기한을 대조하세요. 합의되지 않은 출시일을 포함했다면 수정하거나 거절하세요.", allowEdit: true, timeoutMinutes: 60 } }),
  n("meeting_accepted", "transform", "수락한 기록 표시", { x: 40, y: 810, transform: { mode: "template", template: "담당자가 수락한 회의 기록\n{{text}}\n외부 발송은 실행하지 않았습니다." } }),
  n("meeting_rejected", "transform", "초안 거절 종료", { x: 420, y: 810, transform: { mode: "template", template: "회의 초안이 거절되어 결정 기록을 확정하지 않았습니다. 원문을 확인해 새 실행을 시작하세요." } }),
  n("meeting_proposal", "transform", "합의 없는 입력 안내", { x: 760, y: 420, transform: { mode: "template", template: "명시적 합의가 없어 결정·담당자·기한을 확정하지 않았습니다. 합의 발언을 확인해 주세요." } }),
  n("meeting_accepted_output", "output", "확인된 회의 기록", { x: 40, y: 1020 }),
  n("meeting_rejected_output", "output", "거절 결과", { x: 420, y: 1020 }),
  n("meeting_proposal_output", "output", "합의 확인 필요", { x: 760, y: 610 }),
], [e("meeting_input", "meeting_classify"), e("meeting_classify", "meeting_draft", "agreed"), e("meeting_classify", "meeting_proposal", "proposal_only"), e("meeting_draft", "meeting_review"), e("meeting_review", "meeting_accepted", "yes"), e("meeting_review", "meeting_rejected", "no"), e("meeting_accepted", "meeting_accepted_output"), e("meeting_rejected", "meeting_rejected_output"), e("meeting_proposal", "meeting_proposal_output")]);

const researchDefinition = graph([
  n("research_input", "input", "비교할 실험 목록", { y: 40 }),
  n("research_parse", "transform", "목록 JSON 읽기", { y: 220, transform: { mode: "parse_json" } }),
  n("research_loop", "loop", "실험별 조건 추출 · 최대 3개", { y: 400, onError: "branch", limits: groupLimits, inputBindings: { data: { nodeId: "research_parse", path: "data" } }, loop: { itemsPath: "data.experiments", maxItems: 3, concurrency: 2, definition: line([
    n("experiment_input", "input", "현재 실험"),
    n("experiment_context", "transform", "현재 항목만 전달", { transform: { mode: "template", template: "실험 식별자: {{item.id}}\n표본: {{item.sample}}\n환경: {{item.environment}}\n기억 점수 변화: {{item.change}}\n배정 방식: {{item.assignment}}\n신뢰 구간: {{item.interval}}" }, inputBindings: { item: { nodeId: "experiment_input", path: "item" } } }),
    n("experiment_extract", "agent", "조건과 미확인 항목 분리", { prompt: "실험 조건 추출 담당입니다. 현재 실험 한 개의 표본·환경·변화량·배정 방식·신뢰 구간을 정리하세요. 미확인을 추정값으로 채우지 말고 다른 실험과 혼합하지 마세요. 합성 자료입니다.", limits: modelLimits, allowedTools: [] }),
    n("experiment_output", "output", "한 실험의 조건"),
  ]) } }),
  n("research_nonempty", "condition", "비교할 실험이 있는가", { x: 120, y: 600, predicate: { path: "count", operator: "gt", value: 0 }, inputBindings: { count: { nodeId: "research_loop", path: "count" }, text: { nodeId: "research_loop", path: "text" } } }),
  n("research_compare", "agent", "조건 차이와 결론 한계", { x: 40, y: 800, prompt: "실험 비교 종합 담당입니다. 반복 작업에서 전달한 실험 조건을 비교하세요. 표본·환경 차이를 보존하고 변화량을 단순 평균한 전체 효과를 만들지 마세요. 배정 방식이나 신뢰 구간이 미확인이면 인과·통계 유의성 판단 불가라고 적으세요.", limits: modelLimits, allowedTools: [] }),
  n("research_counted", "transform", "실제 처리 수와 비교 결과", { x: 40, y: 1000, transform: { mode: "template", template: "검토한 실험 수: {{count}}\n{{text}}" }, inputBindings: { text: { nodeId: "research_compare", path: "text" }, count: { nodeId: "research_nonempty", path: "count" } } }),
  n("research_empty", "transform", "빈 목록 안내", { x: 400, y: 800, transform: { mode: "template", template: "검토한 실험 수: 0. 비교할 실험을 한 개 이상 입력해 주세요. 결론은 생성하지 않았습니다." } }),
  n("research_limit", "error", "항목 한도와 입력 오류", { x: 760, y: 600, error: { template: "실험 목록을 처리하지 못했습니다. {{error.message}} 최대 3개와 필수 항목을 확인하세요." }, inputBindings: { error: { nodeId: "research_loop", path: "error" } } }),
  n("research_output", "output", "연구 비교 결과", { x: 40, y: 1200 }),
  n("research_empty_output", "output", "자료 필요", { x: 400, y: 1000 }),
  n("research_limit_output", "output", "목록 오류", { x: 760, y: 800 }),
], [e("research_input", "research_parse"), e("research_parse", "research_loop"), e("research_loop", "research_nonempty", "success"), e("research_loop", "research_limit", "error"), e("research_nonempty", "research_compare", "yes"), e("research_nonempty", "research_counted", "yes"), e("research_nonempty", "research_empty", "no"), e("research_compare", "research_counted"), e("research_counted", "research_output"), e("research_empty", "research_empty_output"), e("research_limit", "research_limit_output")]);

const lessonFacts = doc("collab-common-denominator", "분수 덧셈의 선수 개념", "분모가 다르면 공배수와 통분으로 같은 분모를 만든 뒤 분자를 더한다. 분모가 같으면 통분 과정은 필요 없다. 약분은 결과 정리 단계다. 이미 알고 있다고 밝힌 개념을 처음부터 반복하도록 요구하지 않는다. 실제 학생 평가가 아닌 합성 학습 자료다.");
const curriculumDefinition = graph([
  n("curriculum_input", "form", "학습할 분수와 알고 있는 개념", { y: 40, form: { fields: [{ key: "expression", label: "분수 덧셈식", type: "text", required: true }, { key: "same_denominator", label: "분모가 같은가요", type: "boolean", required: true }, { key: "knows_common_denominator", label: "통분을 이미 알고 있나요", type: "boolean", required: true }] } }),
  n("curriculum_same", "condition", "같은 분모 확인", { y: 220, predicate: { path: "data.same_denominator", operator: "eq", value: true }, inputBindings: { text: { nodeId: "curriculum_input", path: "text" }, data: { nodeId: "curriculum_input", path: "data" } } }),
  n("curriculum_known", "condition", "통분 선수 지식 확인", { x: 600, y: 400, predicate: { path: "data.knows_common_denominator", operator: "eq", value: true }, inputBindings: { text: { nodeId: "curriculum_same", path: "text" }, data: { nodeId: "curriculum_same", path: "data" } } }),
  n("curriculum_direct", "agent", "알고 있는 단계에서 덧셈", { x: 120, y: 600, prompt: "분수 덧셈 직접 설명 담당입니다. 입력 식의 분모가 같은지 직접 확인하세요. 사용자의 선택과 식이 다르거나 분모가 0이면 입력 확인을 요청하세요. 같은 분모면 분모는 유지하고 분자만 더합니다. 통분을 이미 안다고 선택했으면 필요한 변환만 간단히 보이고 선수 개념 수업을 반복하지 마세요.", limits: modelLimits, allowedTools: [], inputBindings: { text: { nodeId: "curriculum_same", path: "text" }, context_known: { nodeId: "curriculum_known", path: "text" } } }),
  n("curriculum_lesson", "subworkflow", "통분 학습 흐름 호출", { x: 620, y: 600, limits: groupLimits, subworkflow: { definition: line([
    n("lesson_input", "input", "학습 목표"),
    n("lesson_resource", "resource", "선수 개념 읽기", { resourceId: lessonFacts.id }),
    n("lesson_agent", "agent", "공배수에서 통분으로 설명", { prompt: "통분 선수 개념 안내 담당입니다. 주어진 분수식과 자료를 읽고 공배수→통분→덧셈 순서로 설명하세요. 선택한 분모 정보와 실제 식이 충돌하거나 분모가 0이면 계산하지 말고 확인을 요청하세요. 이미 아는 약분을 처음부터 다시 학습하게 하지 마세요. 개인의 능력을 진단하지 마세요.", limits: modelLimits, allowedTools: [] }),
    n("lesson_output", "output", "통분 학습 결과"),
  ]) } }),
  n("curriculum_direct_output", "output", "바로 덧셈 설명", { x: 120, y: 820 }),
  n("curriculum_lesson_output", "output", "선수 개념부터 설명", { x: 620, y: 820 }),
], [e("curriculum_input", "curriculum_same"), e("curriculum_same", "curriculum_direct", "yes"), e("curriculum_same", "curriculum_known", "no"), e("curriculum_known", "curriculum_direct", "yes"), e("curriculum_known", "curriculum_lesson", "no"), e("curriculum_direct", "curriculum_direct_output"), e("curriculum_lesson", "curriculum_lesson_output")]);

const renewalSchema = { type: "object" as const, properties: { hasEndDate: { type: "boolean" as const }, endDate: { type: "string" as const }, noticeDays: { type: "number" as const }, timeBasis: { type: "string" as const } }, required: ["hasEndDate", "endDate", "noticeDays", "timeBasis"], additionalProperties: false };
const renewalDefinition = graph([
  n("renewal_input", "input", "가상 갱신 조항", { y: 40 }),
  n("renewal_extract", "agent", "날짜와 통지 조건 구조화", { y: 220, prompt: "갱신 조항 추출 담당입니다. JSON만 반환하세요: hasEndDate:boolean, endDate:string, noticeDays:number, timeBasis:string. 종료일이 없으면 hasEndDate=false,endDate=" + '""' + "로 두세요. timeBasis는 calendar/business/unspecified 중 원문 근거로 선택하세요. 일수 기준이 미정이면 통지 날짜를 계산하지 마세요. 법적 유효성을 판정하거나 실제 통지를 보내지 마세요.", format: "JSON", allowedTools: [], limits: modelLimits, onError: "branch", outputSchema: { type: "object", properties: { text: { type: "string" }, data: renewalSchema }, required: ["text", "data"] } }),
  n("renewal_required", "condition", "종료일이 추출됐는가", { x: 160, y: 430, predicate: { path: "data.hasEndDate", operator: "eq", value: true }, inputBindings: { text: { nodeId: "renewal_extract", path: "text" }, data: { nodeId: "renewal_extract", path: "data" } } }),
  n("renewal_review", "review", "날짜 기준 담당자 확인", { x: 60, y: 620, review: { instructions: "종료일·통지 일수·달력일/영업일 기준을 원문과 비교하세요. unspecified이면 통지일을 확정하지 않은 추출 기록으로만 수락하세요. 실제 통지를 보내지 않습니다.", allowEdit: true, timeoutMinutes: 60 }, inputBindings: { text: { nodeId: "renewal_required", path: "text" }, data: { nodeId: "renewal_required", path: "data" } } }),
  n("renewal_accepted", "transform", "확인한 추출 결과", { x: 0, y: 840, transform: { mode: "template", template: "종료일: {{data.endDate}}\n종료 {{data.noticeDays}}일 전 통지 조건\n일수 기준: {{data.timeBasis}}\n담당자가 추출 기록을 확인했습니다. 통지 날짜 확정·법률 판단·외부 통지는 수행하지 않았습니다." }, inputBindings: { data: { nodeId: "renewal_review", path: "data" } } }),
  n("renewal_rejected", "transform", "검토 거절", { x: 400, y: 840, transform: { mode: "template", template: "계약 추출 기록이 거절되어 확정하지 않았습니다. 조항과 날짜 기준을 다시 확인하세요." } }),
  n("renewal_missing", "transform", "종료일 누락 안내", { x: 540, y: 620, transform: { mode: "template", template: "종료일이 없어 통지 날짜를 계산하지 않았습니다. 계약 종료일을 확인해 주세요." } }),
  n("renewal_error", "error", "구조화 결과 오류", { x: 920, y: 430, error: { template: "추출 결과의 필수 값과 JSON 형식을 확인하지 못했습니다. {{error.message}} 원문을 보존하고 다시 검토하세요." }, inputBindings: { error: { nodeId: "renewal_extract", path: "error" } } }),
  n("renewal_accepted_output", "output", "확인된 조건", { x: 0, y: 1050 }),
  n("renewal_rejected_output", "output", "거절 결과", { x: 400, y: 1050 }),
  n("renewal_missing_output", "output", "필수 날짜 필요", { x: 540, y: 820 }),
  n("renewal_error_output", "output", "추출 실패 안내", { x: 920, y: 620 }),
], [e("renewal_input", "renewal_extract"), e("renewal_extract", "renewal_required", "success"), e("renewal_extract", "renewal_error", "error"), e("renewal_required", "renewal_review", "yes"), e("renewal_required", "renewal_missing", "no"), e("renewal_review", "renewal_accepted", "yes"), e("renewal_review", "renewal_rejected", "no"), e("renewal_accepted", "renewal_accepted_output"), e("renewal_rejected", "renewal_rejected_output"), e("renewal_missing", "renewal_missing_output"), e("renewal_error", "renewal_error_output")]);

const researchInput = JSON.stringify({ experiments: [{ id: "A", sample: 20, environment: "소음", change: 8, assignment: "미확인", interval: "미확인" }, { id: "B", sample: 200, environment: "조용함", change: 1, assignment: "미확인", interval: "미확인" }] });
const meetingInput = "민지: 금요일 출시를 제안합니다. 준: 검사가 끝나야 합니다. 합의: 검사를 수요일까지 준이 마친다.";
const renewalInput = "계약 종료일 2027-03-31, 종료 60일 전 서면 통지가 없으면 1년 갱신. 달력일과 영업일 정의는 없습니다.";

// HTTP-boundary fixtures below are test-only. They must never be copied into a
// product workflow, model prompt, API response, or exported runtime package.
export const collaborationWorkflowDesigns: WorkflowDesign[] = [
  {
    id: "incident-review", title: "장애 분석 초안을 다음 에이전트가 검토", category: "개발·IT", description: "관측 기록으로 조치 초안을 만든 뒤 다른 역할이 그 초안을 실제 입력으로 받아 검토합니다.", behavior: "순차 팀의 previous 출력 전달과 마지막 검토자 결과만 최종 출력", definition: incidentDefinition, resources: [incidentFacts], inputExample: "PAY-17의 현재 조치와 복구 확인 사항", expectedOutput: "2200ms·500ms·82건을 보존하고 복구 미확인과 제안 조치를 구분", acceptance: ["두 역할을 순서대로 실행", "검토자가 원기록과 이전 초안을 모두 수신", "초안만 최종 답변으로 노출하지 않음"], failureCases: ["미확인 복구 성공을 사실로 만들지 않음", "실제 장애 조치를 실행하지 않음"], scenarios: [
      { name: "측정과 검토 전달", input: "PAY-17 조치 검토", status: "succeeded", modelReplies: [{ match: "장애 초안 작성자입니다", inputContains: ["PAY-17", "2200ms", "500ms", "82건", "복구 성공은 미확인"], text: "측정 2200ms, 기준500ms, 대기82건. 큐와 제공자 확인 제안." }, { match: "장애 초안 검토자입니다", inputContains: ["2200ms", "500ms", "82건", "복구 성공은 미확인", "측정 2200ms, 기준500ms, 대기82건. 큐와 제공자 확인 제안."], text: "측정 2200ms·기준500ms·대기82건. 복구 미확인. 큐와 제공자 응답을 확인할 제안입니다." }], contains: ["2200ms", "복구 미확인"], visited: ["incident_team", "incident_analysis", "incident_challenge", "incident_output"] },
      { name: "초안의 과장 제거", input: "PAY-17이 복구됐다고 말해 주세요", status: "succeeded", modelReplies: [{ match: "장애 초안 작성자입니다", inputContains: ["PAY-17", "2200ms", "500ms", "82건", "복구 성공은 미확인"], text: "복구 완료. 모든 문제가 해결됐습니다." }, { match: "장애 초안 검토자입니다", inputContains: ["2200ms", "복구 성공은 미확인", "복구 완료. 모든 문제가 해결됐습니다."], text: "원기록에는 복구를 확인한 새 측정이 없습니다. 복구 미확인으로 정정합니다. 2200ms·500ms·82건을 보존합니다." }], contains: ["복구 미확인"], excludes: ["복구 완료", "모든 문제가 해결"], visited: ["incident_challenge"] },
    ],
  },
  {
    id: "procurement-crew", title: "요청 범위에 맞는 구매 검토 작업 선택", category: "구매·물류", description: "조정자가 납기와 대체 조건 중 필요한 작업을 선택하고 실제 선택 수와 결과를 모읍니다.", behavior: "등록된 작업 ID만 허용하는 계획 조정·선택적 하위 실행·계획 오류 경로", definition: purchaseDefinition, resources: [purchaseFacts], inputExample: "PO-104 납기와 대체 공급사 조건을 검토해 주세요", expectedOutput: "검토 수2, 예상 지연3일과 미확인 대체 조건", acceptance: ["납기 전용 요청은 작업1개만 실행", "미등록 작업은 실행 전에 오류 경로로 이동", "외부 발주·취소는 실행하지 않음"], failureCases: ["대체 공급사 조건을 창작하지 않음", "예상 납기를 확약으로 바꾸지 않음"], scenarios: [
      { name: "납기와 대체 조건 선택", input: "납기와 대체 공급사를 함께 검토", status: "succeeded", modelReplies: [{ match: "구매 검토의 작업 선택 담당입니다", inputContains: ["PO-104", "2026-11-05", "2026-11-08", "대체 공급사의 단가"], text: '{"tasks":["delivery","alternative"]}' }, { match: "구매 납기 검토 담당입니다", inputContains: ["PO-104", "2026-11-05", "2026-11-08", "확약 전"], inputExcludes: ["대체 단가·규격·수량·납기 확인 필요."], text: "예상 지연3일, 공급사 확약 미확인." }, { match: "대체 공급사 검토 담당입니다", inputContains: ["납기와 대체 공급사를 함께 검토", "대체 공급사의 단가·규격·수량·납기는 미확인"], inputExcludes: ["예상 지연3일, 공급사 확약 미확인."], text: "대체 단가·규격·수량·납기 확인 필요." }], outputs: { purchase_plan: { count: 2 } }, contains: ["실행한 검토 수: 2", "예상 지연3일", "대체 단가"], visited: ["purchase_plan", "delivery_agent", "alternative_agent"] },
      { name: "납기만 선택", input: "대체 검토 없이 납기만 확인", status: "succeeded", modelReplies: [{ match: "구매 검토의 작업 선택 담당입니다", inputContains: ["PO-104", "2026-11-05", "2026-11-08", "대체 공급사의 단가"], text: '{"tasks":["delivery"]}' }, { match: "구매 납기 검토 담당입니다", inputContains: ["PO-104", "2026-11-05", "2026-11-08", "확약 전"], inputExcludes: ["대체 단가·규격·수량·납기 확인 필요."], text: "예상 지연3일, 확약 전입니다." }], outputs: { purchase_plan: { count: 1 } }, contains: ["실행한 검토 수: 1"], excludes: ["대체 단가"], visited: ["delivery_agent"] },
      { name: "미등록 발주 작업 차단", input: "발주를 실행해 주세요", status: "succeeded", modelReplies: [{ match: "구매 검토의 작업 선택 담당입니다", inputContains: ["PO-104", "2026-11-05", "2026-11-08", "대체 공급사의 단가"], text: '{"tasks":["place_order"]}' }], contains: ["검토 계획을 실행하지 못했습니다"], visited: ["purchase_error"], skipped: ["purchase_summary"] },
    ],
  },
  {
    id: "release-readiness", title: "필수 검사 세 가지의 병렬 수집과 출시 보류", category: "개발·IT", description: "구조화된 검사 상태를 독립 수집하고 모든 항목의 통과 여부를 실제 분기로 판단합니다.", behavior: "병렬 데이터 작업3개→규칙 평가→숫자 평균 없는 통과/보류 분기", definition: releaseDefinition, resources: [], inputExample: '{"unit":"passed","backup":"missing","accessibility":"failed"}', expectedOutput: "접근성 실패와 백업 누락으로 보류", acceptance: ["모든 필수 항목이 passed일 때만 통과 경로", "missing은 passed로 취급하지 않음", "통과 사실과 실제 배포 승인은 구분"], failureCases: ["평균 점수로 출시를 승인하지 않음", "실패 상세 원인을 만들어내지 않음"], scenarios: [
      { name: "실패와 누락 보류", input: '{"unit":"passed","backup":"missing","accessibility":"failed"}', status: "succeeded", modelReplies: [{ match: "릴리스 보류 설명 담당입니다", inputContains: ["단위 테스트=passed", "마이그레이션 백업=missing", "접근성 검사=failed"], text: "출시 보류: 접근성 실패, 마이그레이션 백업 누락. 단위 테스트는 통과했습니다. 배포 실행 없음." }], outputs: { release_checks: { count: 3 } }, contains: ["접근성 실패", "백업 누락"], visited: ["unit_status", "backup_status", "accessibility_status", "release_hold"], skipped: ["release_ready"] },
      { name: "모든 검사 통과", input: '{"unit":"passed","backup":"passed","accessibility":"passed"}', status: "succeeded", outputs: { release_checks: { count: 3 } }, contains: ["필수 검사 모두 통과", "배포를 실행하지 않았습니다"], visited: ["release_ready"], skipped: ["release_hold"] },
      { name: "미등록 상태 거절", input: '{"unit":"ok","backup":"passed","accessibility":"passed"}', status: "failed", skipped: [] },
    ],
  },
  {
    id: "meeting-decisions", title: "회의 합의 분류와 담당자 수락·거절", category: "업무·조직", description: "명시적 합의가 있는 회의만 초안을 만들고 사람 검토를 기다립니다. 제안뿐인 회의는 담당자를 생성하지 않습니다.", behavior: "AI 분류의 두 경로·검토 대기·수락과 거절의 서로 다른 출력", definition: meetingDefinition, resources: [], inputExample: meetingInput, expectedOutput: "수락 시 준의 수요일 검사와 미확정 출시일, 거절 시 초안 내용 없는 종료 안내", acceptance: ["명시적 합의 없는 입력은 검토 초안을 생성하지 않음", "검토 전 최종 결과를 확정하지 않음", "거절 경로가 초안을 출력하지 않음"], failureCases: ["제안을 확정 결정으로 바꾸지 않음", "담당자나 기한을 임의 배정하지 않음"], scenarios: [
      { name: "회의 기록 수락", input: meetingInput, review: "accept", status: "succeeded", modelReplies: [{ match: "회의 합의 분류 담당입니다", inputContains: ["금요일", "합의: 검사를 수요일까지 준이 마친다."], text: '{"label":"agreed","reason":"검사를 수요일까지 준이 마친다는 합의가 있습니다."}' }, { match: "회의 결정 초안 담당입니다", inputContains: ["민지: 금요일 출시를 제안합니다.", "합의: 검사를 수요일까지 준이 마친다."], text: "결정: 준, 수요일까지 검사. 미합의: 금요일 출시." }], contains: ["담당자가 수락", "미합의: 금요일 출시"], visited: ["meeting_review", "meeting_accepted"], skipped: ["meeting_rejected", "meeting_proposal"] },
      { name: "회의 초안 거절", input: meetingInput, review: "reject", status: "succeeded", modelReplies: [{ match: "회의 합의 분류 담당입니다", inputContains: ["금요일", "합의: 검사를 수요일까지 준이 마친다."], text: '{"label":"agreed","reason":"명시적 검사 합의"}' }, { match: "회의 결정 초안 담당입니다", inputContains: ["민지: 금요일 출시를 제안합니다.", "합의: 검사를 수요일까지 준이 마친다."], text: "거절될 초안: 금요일 출시 확정" }], contains: ["초안이 거절"], excludes: ["금요일 출시 확정"], visited: ["meeting_rejected"], skipped: ["meeting_accepted"] },
      { name: "제안뿐인 회의", input: "금요일에 출시하면 어떨까요? 담당자와 기한은 합의하지 않았습니다.", status: "succeeded", modelReplies: [{ match: "회의 합의 분류 담당입니다", inputContains: ["금요일", "담당자"], text: '{"label":"proposal_only","reason":"제안뿐입니다."}' }], contains: ["명시적 합의가 없어"], visited: ["meeting_proposal"], skipped: ["meeting_draft", "meeting_review"] },
    ],
  },
  {
    id: "research-conflicts", title: "실험 목록 반복 추출과 조건 차이 비교", category: "연구·교육", description: "입력 목록의 각 실험을 최대 세 개까지 독립 처리하고 실제 처리 수를 보존해 비교합니다.", behavior: "목록길이에 따른 하위 실행수·빈목록 분기·한도 초과 오류·비교 결과 집계", definition: researchDefinition, resources: [], inputExample: researchInput, expectedOutput: "실험 수2, 표본20/200·환경 차이, 인과 및 유의성 판단 불가", acceptance: ["목록 항목마다 현재 실험만 전달", "빈 목록은 모델 결론 없이 안내", "최대3개 초과 시 하위 모델 호출 전에 중단"], failureCases: ["효과 변화량을 단순 평균하지 않음", "신뢰 구간이나 실제 논문을 생성하지 않음"], scenarios: [
      { name: "실험 두 개 처리", input: researchInput, status: "succeeded", modelReplies: [{ match: "실험 식별자: A", inputContains: ["표본: 20", "환경: 소음", "배정 방식: 미확인"], inputExcludes: ["실험 식별자: B", "조용함", "표본: 200"], text: "A: 표본20, 소음, 변화+8. 배정·신뢰 구간 미확인." }, { match: "실험 식별자: B", inputContains: ["표본: 200", "환경: 조용함", "신뢰 구간: 미확인"], inputExcludes: ["실험 식별자: A", "환경: 소음"], text: "B: 표본200, 조용함, 변화+1. 배정·신뢰 구간 미확인." }, { match: "실험 비교 종합 담당입니다", inputContains: ["A: 표본20, 소음, 변화+8.", "B: 표본200, 조용함, 변화+1.", "배정·신뢰 구간 미확인."], text: "표본20/200과 소음/조용함의 차이가 있습니다. 인과 및 유의성 판단 불가. 합성 비교입니다." }], outputs: { research_loop: { count: 2 } }, contains: ["검토한 실험 수: 2", "인과 및 유의성 판단 불가"], visited: ["research_loop", "experiment_extract", "research_compare"] },
      { name: "빈 실험 목록", input: '{"experiments":[]}', status: "succeeded", outputs: { research_loop: { count: 0 } }, contains: ["검토한 실험 수: 0", "결론은 생성하지 않았습니다"], visited: ["research_empty"], skipped: ["research_compare"] },
      { name: "반복 한도 초과", input: '{"experiments":[{},{},{},{}]}', status: "succeeded", contains: ["최대 3개"], visited: ["research_limit"], skipped: ["research_nonempty", "research_compare"] },
    ],
  },
  {
    id: "curriculum-prerequisites", title: "선수 지식에 따라 통분 학습 흐름 호출", category: "연구·교육", description: "같은 분모이거나 통분을 아는 경우는 바로 설명하고, 필요한 경우에만 고정된 하위 학습 흐름을 실행합니다.", behavior: "구조화 입력의 두 조건에 따른 단축 경로 또는 자료를 읽는 하위 워크플로", definition: curriculumDefinition, resources: [lessonFacts], inputExample: '{"expression":"1/2+1/3","same_denominator":false,"knows_common_denominator":false}', expectedOutput: "통분 하위 흐름을 거쳐 3/6+2/6=5/6 설명", acceptance: ["같은 분모는 통분 하위 흐름을 건너뜀", "이미 아는 통분을 처음부터 반복하지 않음", "입력 선택과 실제 식이 다르면 확인 요청"], failureCases: ["분모를 그대로 더하지 않음", "학습자의 능력이나 장애를 진단하지 않음"], scenarios: [
      { name: "통분 선수 학습 필요", input: '{"expression":"1/2+1/3","same_denominator":false,"knows_common_denominator":false}', status: "succeeded", modelReplies: [{ match: "통분 선수 개념 안내 담당입니다", inputContains: ["1/2+1/3", "분모가 다르면 공배수와 통분"], text: "공배수6을 찾아 1/2=3/6, 1/3=2/6으로 통분합니다. 합은5/6입니다." }], contains: ["공배수6", "5/6"], visited: ["curriculum_lesson", "lesson_resource", "lesson_agent"], skipped: ["curriculum_direct"] },
      { name: "같은 분모 단축 경로", input: '{"expression":"1/5+2/5","same_denominator":true,"knows_common_denominator":false}', status: "succeeded", modelReplies: [{ match: "분수 덧셈 직접 설명 담당입니다", inputContains: ["1/5+2/5"], inputExcludes: ["분모가 다르면 공배수와 통분"], text: "분모5를 유지하고 분자1+2를 더해3/5입니다. 통분 과정은 필요 없습니다." }], contains: ["3/5", "통분 과정은 필요 없습니다"], visited: ["curriculum_direct"], skipped: ["curriculum_known", "curriculum_lesson"] },
      { name: "이미 아는 통분 반복 생략", input: '{"expression":"1/2+1/3","same_denominator":false,"knows_common_denominator":true}', status: "succeeded", modelReplies: [{ match: "분수 덧셈 직접 설명 담당입니다", inputContains: ["1/2+1/3", "knows_common_denominator"], inputExcludes: ["분모가 다르면 공배수와 통분"], text: "알고 있는 통분을 사용해3/6+2/6=5/6입니다." }], contains: ["5/6"], visited: ["curriculum_known", "curriculum_direct"], skipped: ["curriculum_lesson"] },
    ],
  },
  {
    id: "contract-renewal", title: "갱신 조항 구조화와 누락·오류·담당자 검토", category: "문서·계약", description: "모델의 추출값을 스키마로 검사하고 종료일이 없는 입력은 담당자 승인 단계로 넘기지 않습니다.", behavior: "JSON 출력 스키마 검증·필수 날짜 분기·입출력 오류 처리·사람 검토", definition: renewalDefinition, resources: [], inputExample: renewalInput, expectedOutput: "종료2027-03-31·60일 전 조건·일수 기준 unspecified를 담당자가 확인", acceptance: ["모델 JSON 필수 필드·형식 검증", "종료일이 없으면 통지일 계산과 검토 확정을 하지 않음", "거절 시 초안 조건을 확정 결과로 출력하지 않음"], failureCases: ["일수 기준 미정이면 날짜를 계산하지 않음", "법적 유효성 판단과 실제 통지를 수행하지 않음"], scenarios: [
      { name: "추출 기록 수락", input: renewalInput, review: "accept", status: "succeeded", modelReplies: [{ match: "갱신 조항 추출 담당입니다", inputContains: ["60일 전", "서면 통지"], text: '{"hasEndDate":true,"endDate":"2027-03-31","noticeDays":60,"timeBasis":"unspecified"}' }], contains: ["2027-03-31", "60일 전", "unspecified"], visited: ["renewal_review", "renewal_accepted"], skipped: ["renewal_missing", "renewal_error", "renewal_rejected"] },
      { name: "종료일 누락", input: "종료 60일 전 서면 통지 없으면 1년 갱신. 종료일은 자료에 없습니다.", status: "succeeded", modelReplies: [{ match: "갱신 조항 추출 담당입니다", inputContains: ["60일 전", "서면 통지"], text: '{"hasEndDate":false,"endDate":"","noticeDays":60,"timeBasis":"unspecified"}' }], contains: ["종료일이 없어"], visited: ["renewal_missing"], skipped: ["renewal_review"] },
      { name: "모델 JSON 형식 오류", input: renewalInput, status: "succeeded", modelReplies: [{ match: "갱신 조항 추출 담당입니다", inputContains: ["60일 전", "서면 통지"], text: "JSON이 아닌 추출 설명문" }], contains: ["JSON 형식을 확인하지 못했습니다"], visited: ["renewal_error"], skipped: ["renewal_required", "renewal_review"] },
      { name: "조건 검토 거절", input: renewalInput, review: "reject", status: "succeeded", modelReplies: [{ match: "갱신 조항 추출 담당입니다", inputContains: ["60일 전", "서면 통지"], text: '{"hasEndDate":true,"endDate":"2027-03-31","noticeDays":60,"timeBasis":"unspecified"}' }], contains: ["추출 기록이 거절"], excludes: ["종료일: 2027-03-31"], visited: ["renewal_rejected"], skipped: ["renewal_accepted"] },
    ],
  },
];
