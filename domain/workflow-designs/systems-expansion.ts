import type { Definition, FlowNode } from "../../app/lib/model";
import type { FormConfig, Json, PredicateConfig } from "../../runtime/types";
import type { WorkflowDesign, WorkflowScenario } from "../workflow-design";

// Small serialization helpers. Each graph below declares its own required paths.
type Link = [string, string, string?];
const bind = (nodeId: string, path = "data") => ({ nodeId, path });
const labels: Record<string, string> = { effect: "읽기·쓰기 종류", outcome: "관측한 실행 결과", idempotent: "서비스의 중복 방지 지원", attempt: "현재 시도 횟수", limit: "허용 한도", retryAfter: "재시도 대기 초", deadline: "남은 시간 초", method: "요청 방식", hasEtag: "ETag 존재", etag: "요청 ETag", currentEtag: "현재 ETag", hasDate: "조건 날짜 존재", modified: "최종 수정 시각", since: "요청 기준 시각", cursor: "다음 커서(종료는 빈 값)", hasRows: "페이지 내용 있음", errors: "오류 관측값", errorLimit: "오류 한도", latency: "지연 관측값", latencyLimit: "지연 한도", samples: "표본 수", minimum: "최소 표본 수", rollbackReady: "롤백 준비 완료", owner: "기록된 작업자", expectedOwner: "현재 작업자", epoch: "기록된 세대 번호", currentEpoch: "현재 세대 번호", now: "현재 시각", expires: "만료 시각", checkpoint: "체크포인트 존재", oldMajor: "기존 주 버전", newMajor: "새 주 버전", removedRequired: "필수 필드 삭제됨", changedType: "자료형 변경됨", addedRequired: "필수 필드 추가됨", addedOptional: "선택 필드 추가됨", state: "회로 상태", failures: "실패 횟수", retryAt: "시험 가능 시각", probeInFlight: "시험 요청 진행 중", timestamp: "이벤트 시각", eventId: "이벤트 식별자" };
const titles: Record<string, string> = { complete: "이미 완료됐는가", read: "읽기 요청인가", unknown: "쓰기 결과가 불명확한가", idempotent: "중복 방지 계약 확인", attempts: "시도 횟수 한도 검사", delay: "대기 시간 유효성", deadline: "마감 안에 재시도 가능한가", post: "쓰기 요청 분리", has_etag: "ETag 유무 확인", etag_equal: "ETag 직접 대조", has_date: "조건 날짜 유무 확인", modified: "수정 시각 비교", prior: "이전 커서 읽기", empty: "종료 커서 확인", repeat: "같은 커서가 반복됐는가", has_rows: "페이지 내용 확인", save: "처리한 커서 저장", saved: "저장 결과 표시", veto: "한도 초과가 하나라도 있는가", samples: "최소 표본 검사", rollback: "롤백 준비 확인", error_input: "오류 관측값", latency_input: "지연 관측값", error_ok: "오류 한도 비교", latency_ok: "지연 한도 비교", owner: "작업자 일치 검사", fence: "현재 세대 번호 검사", lease: "리스 만료 검사", checkpoint: "재개 지점 존재 확인", major: "주 버전 일치 확인", removed: "필수 필드 삭제 검사", type: "자료형 변경 검사", required: "필수 필드 추가 검사", optional: "선택 필드 추가 검사", closed: "닫힌 회로 확인", threshold: "실패 횟수 한도 비교", is_open: "열린 회로 확인", retry_time: "시험 가능 시각 비교", probe_state: "활성 시험 경로의 상태 합류", inflight: "진행 중 시험 중복 검사", read_mark: "이전 워터마크 읽기", found: "기존 워터마크 존재", newer: "이벤트가 더 최신인가", equal: "이벤트 시각이 같은가", late_review: "늦은 이벤트 별도 검토", new_mark: "갱신 대상 이벤트 합류", save_mark: "최신 워터마크 저장", mark_result: "갱신 시각 표시" };
const node = (id: string, type: FlowNode["type"], extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title: titles[id] ?? id, x: 0, y: 0, ...extra });
const form = (fields: [string, FormConfig["fields"][number]["type"], string[]?, boolean?][]) => node("input", "form", { title: "판정 정보 입력", form: { fields: fields.map(([key, type, options, required = true]) => ({ key, label: labels[key] ?? key, type, required, ...(options ? { options } : {}) })) } });
const condition = (id: string, from: string, predicate: PredicateConfig) => node(id, "condition", { predicate, inputBindings: { data: bind(from) } });
const message = (id: string, template: string, from?: string) => node(id, "transform", { title: template.slice(0, 25), transform: { mode: "template", template }, inputBindings: from ? { data: bind(from) } : {} });
const output = (id = "output") => node(id, "output", { title: "판정 결과" });
const review = (id: string, from: string) => node(id, "review", { title: "입력과 변경안 검토", inputBindings: { data: bind(from) }, review: { instructions: "입력과 판정 근거를 확인하세요. 실제 서비스 변경은 실행하지 않습니다.", allowEdit: false, timeoutMinutes: 60 } });
function graph(nodes: FlowNode[], links: Link[]): Definition {
  const depth = new Map<string, number>();
  for (let pass = 0; pass < nodes.length; pass++) for (const n of nodes) depth.set(n.id, Math.max(0, ...links.filter(e => e[1] === n.id).map(e => (depth.get(e[0]) ?? 0) + 1)));
  const lanes = new Map<number, number>();
  return { schemaVersion: 5, nodes: nodes.map(n => { const d = depth.get(n.id)!; const lane = lanes.get(d) ?? 0; lanes.set(d, lane + 1); return { ...n, x: 40 + lane * 300, y: 40 + d * 160 }; }), edges: links.map(([source, target, branch], i) => ({ id: `e${i}`, source, target, ...(branch ? { branch } : {}) })) };
}
function scenario(name: string, data: Record<string, Json>, contains: string, visited: string[], skipped: string[] = [], extra: Partial<WorkflowScenario> = {}): WorkflowScenario {
  return { name, input: JSON.stringify(data), status: "succeeded", contains: [contains], visited, skipped, ...extra };
}
function design(id: string, title: string, behavior: string, definition: Definition, scenarios: WorkflowScenario[]): WorkflowDesign {
  const checked = [...scenarios, { name: "손상된 JSON 입력 거절", input: "{", status: "failed" as const }];
  return { id, title, category: "시스템·실행 정책", description: behavior, behavior, definition, scenarios: checked, resources: [], inputExample: scenarios[0].input, expectedOutput: scenarios[0].contains?.join(" / ") ?? "입력에 따른 판정", acceptance: [behavior, "분기 결과에 해당하는 경로만 실행한다.", "판정은 입력된 관측값에만 적용하며 실제 인프라를 변경하지 않는다."], failureCases: checked.slice(1).map(s => s.name) };
}

const retryBase = { effect: "read", outcome: "failed", idempotent: false, attempt: 1, limit: 3, retryAfter: 2, deadline: 10 };
const retry = design("transport-retry-policy", "읽기 재시도와 결과 불명 쓰기를 분리", "성공은 종료하고, 실패한 읽기는 시도 횟수·대기 시간·마감 순서로 검사합니다. 결과 불명 쓰기는 중복 방지 계약이 없으면 재시도 후보로 보내지 않습니다.", graph([
  form([["effect", "select", ["read", "write"]], ["outcome", "select", ["completed", "failed", "unknown"]], ["idempotent", "boolean"], ["attempt", "number"], ["limit", "number"], ["retryAfter", "number"], ["deadline", "number"]]),
  condition("complete", "input", { path: "data.outcome", operator: "eq", value: "completed" }), message("done", "완료 결과 유지"),
  condition("read", "complete", { path: "data.effect", operator: "eq", value: "read" }),
  condition("unknown", "read", { path: "data.outcome", operator: "eq", value: "unknown" }),
  condition("idempotent", "unknown", { path: "data.idempotent", operator: "eq", value: true }),
  message("reconcile", "결과 확인 필요: 쓰기의 실제 결과와 재실행 조건을 별도로 확인하며 자동 재실행하지 않습니다."),
  condition("attempts", "read", { path: "data.attempt", operator: "lt", rightPath: "data.limit" }),
  condition("delay", "attempts", { path: "data.retryAfter", operator: "gte", value: 0 }),
  condition("deadline", "delay", { path: "data.retryAfter", operator: "lte", rightPath: "data.deadline" }),
  message("retry", "읽기 재시도 후보: {{data.retryAfter}}초 뒤, 실제 요청은 별도 실행", "deadline"), message("exhausted", "시도 한도 도달"), message("invalid", "Retry-After 음수 오류"), message("late", "마감 초과: 대기 후 재시도 금지"), review("write_review", "idempotent"), message("write_plan", "중복 방지 키를 유지한 쓰기 검토안 수락"), message("denied", "쓰기 재시도 검토 거절"), output(),
], [["input", "complete"], ["complete", "done", "yes"], ["complete", "read", "no"], ["read", "attempts", "yes"], ["read", "unknown", "no"], ["unknown", "idempotent", "yes"], ["unknown", "reconcile", "no"], ["idempotent", "reconcile", "no"], ["idempotent", "write_review", "yes"], ["write_review", "write_plan", "yes"], ["write_review", "denied", "no"], ["attempts", "delay", "yes"], ["attempts", "exhausted", "no"], ["delay", "deadline", "yes"], ["delay", "invalid", "no"], ["deadline", "retry", "yes"], ["deadline", "late", "no"], ...["done", "reconcile", "retry", "exhausted", "invalid", "late", "write_plan", "denied"].map(id => [id, "output"] as Link)]), [
  scenario("읽기만 재시도 후보", retryBase, "2초 뒤", ["retry"], ["unknown", "write_review"]),
  scenario("성공은 추가 판단 없음", { ...retryBase, outcome: "completed" }, "완료 결과 유지", ["done"], ["read", "attempts"]),
  scenario("불명 쓰기는 재조정", { ...retryBase, effect: "write", outcome: "unknown" }, "결과 확인 필요", ["reconcile"], ["attempts", "write_review"]),
  scenario("멱등 쓰기 검토 거절", { ...retryBase, effect: "write", outcome: "unknown", idempotent: true }, "검토 거절", ["write_review", "denied"], ["attempts"], { review: "reject" }),
  scenario("시도 횟수 경계", { ...retryBase, attempt: 3 }, "한도 도달", ["exhausted"], ["delay", "retry"]),
  scenario("음수 대기 거절", { ...retryBase, retryAfter: -1 }, "음수 오류", ["invalid"], ["deadline"]),
  scenario("마감 뒤 대기 거절", { ...retryBase, retryAfter: 11 }, "마감 초과", ["late"], ["retry"]),
  scenario("중복 방지 쓰기 검토 수락", { ...retryBase, effect: "write", outcome: "unknown", idempotent: true }, "검토안 수락", ["write_plan"], ["retry"], { review: "accept" }),
]);

const cacheBase = { method: "GET", hasEtag: true, etag: "v2", currentEtag: "v2", hasDate: true, modified: 100, since: 200 };
const cache = design("conditional-cache-precedence", "ETag 우선순위가 있는 조건부 읽기", "정규화한 단일 ETag와 숫자 시각을 받는 판정 예제입니다. GET·HEAD의 ETag가 있으면 날짜 조건을 생략하고 없을 때만 시각을 비교합니다. HTTP 헤더 파서나 웹 서버는 아니며 약한 태그·목록·별표 해석은 포함하지 않습니다.", graph([
  form([["method", "select", ["GET", "HEAD", "POST"]], ["hasEtag", "boolean"], ["etag", "text"], ["currentEtag", "text"], ["hasDate", "boolean"], ["modified", "number"], ["since", "number"]]),
  condition("post", "input", { path: "data.method", operator: "eq", value: "POST" }), message("unsupported", "쓰기 요청은 별도 사전 조건 정책 필요"),
  condition("has_etag", "post", { path: "data.hasEtag", operator: "eq", value: true }), condition("etag_equal", "has_etag", { path: "data.etag", operator: "eq", rightPath: "data.currentEtag" }),
  condition("has_date", "has_etag", { path: "data.hasDate", operator: "eq", value: true }), condition("modified", "has_date", { path: "data.modified", operator: "lte", rightPath: "data.since" }),
  message("not_modified", "304: 본문 없음"),
  message("fetch", "200: 현재 표현을 가져올 필요가 있습니다. 이 예제는 HTTP를 호출하지 않습니다."), output(),
], [["input", "post"], ["post", "unsupported", "yes"], ["post", "has_etag", "no"], ["has_etag", "etag_equal", "yes"], ["has_etag", "has_date", "no"], ["etag_equal", "not_modified", "yes"], ["etag_equal", "fetch", "no"], ["has_date", "modified", "yes"], ["has_date", "fetch", "no"], ["modified", "not_modified", "yes"], ["modified", "fetch", "no"], ["unsupported", "output"], ["not_modified", "output"], ["fetch", "output"]]), [
  scenario("ETag 일치 시 날짜 생략", cacheBase, "304", ["etag_equal", "not_modified"], ["has_date", "fetch"]),
  scenario("ETag 불일치는 날짜보다 우선", { ...cacheBase, etag: "v1" }, "200", ["fetch"], ["modified", "not_modified"]),
  scenario("ETag 없을 때 날짜 경계", { ...cacheBase, hasEtag: false, since: 100 }, "304", ["has_date", "modified"], ["etag_equal"]),
  scenario("변경된 날짜", { ...cacheBase, hasEtag: false, since: 99 }, "200", ["fetch"], ["not_modified"]),
  scenario("검증자 없는 읽기", { ...cacheBase, hasEtag: false, hasDate: false }, "200", ["fetch"], ["modified", "etag_equal"]),
  scenario("쓰기 조건 분리", { ...cacheBase, method: "POST" }, "별도 사전 조건", ["unsupported"], ["has_etag"]),
]);

const pagination = design("cursor-progress-checkpoint", "커서가 전진한 페이지에만 체크포인트 기록", "첫 커서와 이전 커서를 지속 저장해 비교합니다. 빈 커서는 종료, 반복 커서는 중단, 다른 커서는 처리 후 저장합니다. 내용 없는 페이지는 커서를 갱신하지 않고 확인을 요청합니다.", graph([
  form([["cursor", "text", undefined, false], ["hasRows", "boolean"]]), node("prior", "memory", { memory: { action: "read", key: "cursor", defaultValue: "" }, inputBindings: { current: bind("input"), text: bind("input", "text") } }),
  node("empty", "condition", { predicate: { path: "current.cursor", operator: "eq", value: "" }, inputBindings: { current: bind("prior", "current"), previous: bind("prior"), text: bind("prior", "text") } }), message("end", "페이지 종료: 다음 커서 없음"),
  node("repeat", "condition", { predicate: { path: "current.cursor", operator: "eq", rightPath: "previous" }, inputBindings: { current: bind("empty", "current"), previous: bind("empty", "previous"), text: bind("empty", "text") } }), message("stalled", "커서 반복: 다음 페이지 호출 중단"),
  node("has_rows", "condition", { predicate: { path: "current.hasRows", operator: "eq", value: true }, inputBindings: { current: bind("repeat", "current"), text: bind("repeat", "text") } }), message("inconsistent", "내용 없는 페이지: 커서 갱신 보류"),
  node("save", "memory", { memory: { action: "write", key: "cursor", valuePath: "current.cursor" }, inputBindings: { current: bind("has_rows", "current"), text: bind("has_rows", "text") } }), node("saved", "transform", { transform: { mode: "template", template: "처리 완료 커서: {{data}}" }, inputBindings: { data: bind("save") } }), output(),
], [["input", "prior"], ["prior", "empty"], ["empty", "end", "yes"], ["empty", "repeat", "no"], ["repeat", "stalled", "yes"], ["repeat", "has_rows", "no"], ["has_rows", "save", "yes"], ["has_rows", "inconsistent", "no"], ["save", "saved"], ...["end", "stalled", "inconsistent", "saved"].map(id => [id, "output"] as Link)]), [
  scenario("첫 페이지 커서 저장", { cursor: "page-2", hasRows: true }, "처리 완료 커서: page-2", ["save"], ["stalled"], { stateGroup: "cursor" }),
  scenario("같은 커서 재수신 중단", { cursor: "page-2", hasRows: true }, "커서 반복", ["stalled"], ["save"], { stateGroup: "cursor" }),
  scenario("다른 커서 전진", { cursor: "page-3", hasRows: true }, "처리 완료 커서: page-3", ["save"], ["stalled"], { stateGroup: "cursor" }),
  scenario("빈 페이지 커서 보류", { cursor: "page-4", hasRows: false }, "갱신 보류", ["inconsistent"], ["save"], { stateGroup: "cursor" }),
  scenario("종료 커서", { cursor: "", hasRows: false }, "페이지 종료", ["end"], ["repeat", "save"]),
]);

const deployBase = { errors: 1, errorLimit: 2, latency: 180, latencyLimit: 200, samples: 100, minimum: 100, rollbackReady: true };
const deploy = design("canary-veto-review", "카나리 배포의 거부 조건과 증거 부족 분리", "오류율과 지연을 병렬 검사하고 어느 하나라도 한도를 넘으면 보류합니다. 지표가 정상이어도 표본이 부족하면 관찰을 유지하고, 롤백 준비까지 확인한 경우만 사람 검토로 전달합니다.", graph([
  form([["errors", "number"], ["errorLimit", "number"], ["latency", "number"], ["latencyLimit", "number"], ["samples", "number"], ["minimum", "number"], ["rollbackReady", "boolean"]]),
  node("checks", "parallel", { title: "오류와 지연 독립 검사", inputBindings: { data: bind("input") }, parallel: { concurrency: 2, tasks: [
    { id: "errors", name: "오류 한도", definition: graph([node("error_input", "input"), condition("error_ok", "error_input", { path: "data.errors", operator: "lte", rightPath: "data.errorLimit" }), message("error_pass", "errors=passed"), message("error_fail", "errors=failed"), output("error_out")], [["error_input", "error_ok"], ["error_ok", "error_pass", "yes"], ["error_ok", "error_fail", "no"], ["error_pass", "error_out"], ["error_fail", "error_out"]]) },
    { id: "latency", name: "지연 한도", definition: graph([node("latency_input", "input"), condition("latency_ok", "latency_input", { path: "data.latency", operator: "lte", rightPath: "data.latencyLimit" }), message("latency_pass", "latency=passed"), message("latency_fail", "latency=failed"), output("latency_out")], [["latency_input", "latency_ok"], ["latency_ok", "latency_pass", "yes"], ["latency_ok", "latency_fail", "no"], ["latency_pass", "latency_out"], ["latency_fail", "latency_out"]]) },
  ] } }),
  node("veto", "condition", { predicate: { path: "text", operator: "contains", value: "failed" }, inputBindings: { text: bind("checks", "text"), data: bind("input") } }), message("hold", "배포 보류: 한도 초과 지표 있음"), condition("samples", "veto", { path: "data.samples", operator: "gte", rightPath: "data.minimum" }), message("observe", "표본 부족: 현재 단계에서 관찰 유지"), condition("rollback", "samples", { path: "data.rollbackReady", operator: "eq", value: true }), message("prepare", "롤백 준비 필요"), review("release_review", "rollback"), message("candidate", "확대 배포 검토 수락: 실제 배포는 실행하지 않음"), message("rejected", "확대 배포 검토 거절"), output(),
], [["input", "checks"], ["input", "veto"], ["checks", "veto"], ["veto", "hold", "yes"], ["veto", "samples", "no"], ["samples", "observe", "no"], ["samples", "rollback", "yes"], ["rollback", "prepare", "no"], ["rollback", "release_review", "yes"], ["release_review", "candidate", "yes"], ["release_review", "rejected", "no"], ...["hold", "observe", "prepare", "candidate", "rejected"].map(id => [id, "output"] as Link)]), [
  scenario("경계 표본과 정상 지표", deployBase, "검토 수락", ["error_pass", "latency_pass", "candidate"], ["hold", "observe"], { review: "accept" }),
  scenario("한 항목의 실패가 우선", { ...deployBase, latency: 201, samples: 1 }, "한도 초과", ["latency_fail", "hold"], ["samples", "release_review"]),
  scenario("오류율 초과", { ...deployBase, errors: 3 }, "한도 초과", ["error_fail", "hold"], ["release_review"]),
  scenario("표본 부족 경로", { ...deployBase, samples: 99 }, "표본 부족", ["observe"], ["rollback", "release_review"]),
  scenario("롤백 미준비", { ...deployBase, rollbackReady: false }, "롤백 준비", ["prepare"], ["release_review"]),
  scenario("사람 검토 거절", deployBase, "검토 거절", ["rejected"], ["candidate"], { review: "reject" }),
]);

const leaseBase = { owner: "worker-a", expectedOwner: "worker-a", epoch: 7, currentEpoch: 7, now: 100, expires: 200, checkpoint: true };
const lease = design("fenced-checkpoint-resume", "소유자·펜싱 번호·리스 기한을 통과한 체크포인트만 재개", "소유자와 현재 세대 번호를 먼저 대조하고 기한이 지난 실행은 재개하지 않습니다. 유효한 리스라도 체크포인트가 없으면 신규 실행 경로로 구분합니다. 소유자 검사는 입력 시뮬레이션이며 인증 수단이 아닙니다.", graph([
  form([["owner", "text"], ["expectedOwner", "text"], ["epoch", "number"], ["currentEpoch", "number"], ["now", "number"], ["expires", "number"], ["checkpoint", "boolean"]]),
  condition("owner", "input", { path: "data.owner", operator: "eq", rightPath: "data.expectedOwner" }), message("owner_denied", "소유 작업자 불일치: 실행 금지"), output("owner_out"),
  condition("fence", "owner", { path: "data.epoch", operator: "eq", rightPath: "data.currentEpoch" }), message("stale", "펜싱 번호 불일치: 오래된 실행 차단"), output("stale_out"),
  condition("lease", "fence", { path: "data.now", operator: "lt", rightPath: "data.expires" }), message("expired", "리스 만료: 재획득 후 다시 검사"),
  condition("checkpoint", "lease", { path: "data.checkpoint", operator: "eq", value: true }), message("resume", "검증된 체크포인트 재개 후보 · 세대 {{data.epoch}}", "checkpoint"), message("new", "체크포인트 없음: 새 실행 후보"), output("execution_out"),
], [["input", "owner"], ["owner", "owner_denied", "no"], ["owner_denied", "owner_out"], ["owner", "fence", "yes"], ["fence", "stale", "no"], ["stale", "stale_out"], ["fence", "lease", "yes"], ["lease", "expired", "no"], ["lease", "checkpoint", "yes"], ["checkpoint", "resume", "yes"], ["checkpoint", "new", "no"], ["expired", "execution_out"], ["resume", "execution_out"], ["new", "execution_out"]]), [
  scenario("유효 리스 재개", leaseBase, "세대 7", ["resume"], ["new", "expired"]),
  scenario("소유자 불일치", { ...leaseBase, owner: "worker-b" }, "소유 작업자 불일치", ["owner_denied"], ["fence"]),
  scenario("이전 세대 차단", { ...leaseBase, epoch: 6 }, "펜싱 번호 불일치", ["stale"], ["lease"]),
  scenario("만료 시각 경계", { ...leaseBase, now: 200 }, "리스 만료", ["expired"], ["checkpoint"]),
  scenario("체크포인트 없는 실행", { ...leaseBase, checkpoint: false }, "새 실행 후보", ["new"], ["resume"]),
]);

const schemaBase = { oldMajor: 2, newMajor: 2, removedRequired: false, changedType: false, addedRequired: false, addedOptional: true };
const schema = design("consumer-contract-change", "검토된 변경 플래그로 소비자 계약 분기", "요청·응답 방향을 검토해 입력한 변경 플래그와 추가 선택 필드를 허용하는 소비자 정책을 전제로 합니다. 같은 주 버전에서 필수 삭제·타입 변경·필수 추가를 모두 차단하는 보수적 규칙이며, 선택 추가만 호환 후보로 분류합니다. 스키마 차이나 보편적 API 호환성을 계산하지 않습니다. 주 버전 변경은 별도 검토합니다.", graph([
  { ...form([["oldMajor", "number"], ["newMajor", "number"], ["removedRequired", "boolean"], ["changedType", "boolean"], ["addedRequired", "boolean"], ["addedOptional", "boolean"]]), description: "요청/응답 방향과 unknown-field 허용 정책을 먼저 확인해 변경 플래그를 입력하세요. 이 예제는 추가 선택 필드를 허용하며 필수 삭제·타입 변경·필수 추가를 모두 차단하는 사전 정의 정책입니다." },
  condition("major", "input", { path: "data.oldMajor", operator: "eq", rightPath: "data.newMajor" }), review("migration", "major"), message("migration_plan", "주 버전 변경: 마이그레이션 계획 검토됨"), message("migration_denied", "마이그레이션 검토 거절"),
  condition("removed", "major", { path: "data.removedRequired", operator: "eq", value: true }), message("breaking", "호환 불가: 필수 삭제·타입 변경·필수 추가 중 하나 존재"),
  condition("type", "removed", { path: "data.changedType", operator: "eq", value: true }), condition("required", "type", { path: "data.addedRequired", operator: "eq", value: true }), condition("optional", "required", { path: "data.addedOptional", operator: "eq", value: true }),
  message("compatible", "선택 필드 추가: 후방 호환 후보"), message("unchanged", "검토 항목에서 계약 변경 없음"), output(),
], [["input", "major"], ["major", "migration", "no"], ["migration", "migration_plan", "yes"], ["migration", "migration_denied", "no"], ["major", "removed", "yes"], ["removed", "breaking", "yes"], ["removed", "type", "no"], ["type", "breaking", "yes"], ["type", "required", "no"], ["required", "breaking", "yes"], ["required", "optional", "no"], ["optional", "compatible", "yes"], ["optional", "unchanged", "no"], ...["migration_plan", "migration_denied", "breaking", "compatible", "unchanged"].map(id => [id, "output"] as Link)]), [
  scenario("선택 필드 추가", schemaBase, "후방 호환 후보", ["compatible"], ["migration", "breaking"]),
  scenario("필수 삭제가 우선", { ...schemaBase, removedRequired: true }, "호환 불가", ["breaking"], ["type", "optional"]),
  scenario("타입 변경", { ...schemaBase, changedType: true }, "호환 불가", ["breaking"], ["required"]),
  scenario("필수 필드 추가", { ...schemaBase, addedRequired: true }, "호환 불가", ["breaking"], ["optional"]),
  scenario("변경 없음", { ...schemaBase, addedOptional: false }, "계약 변경 없음", ["unchanged"], ["compatible"]),
  scenario("새 주 버전 검토", { ...schemaBase, newMajor: 3 }, "계획 검토됨", ["migration_plan"], ["removed"], { review: "accept" }),
  scenario("주 버전 검토 거절", { ...schemaBase, newMajor: 3 }, "검토 거절", ["migration_denied"], ["removed"], { review: "reject" }),
]);

const breaker = design("circuit-breaker-probe", "회로 차단 상태별 시험 요청 판단", "닫힌 회로는 실패 횟수 한도, 열린 회로는 재시도 가능 시각을 검사합니다. 반열림은 이미 진행 중인 시험 요청이 있으면 추가 요청을 막고, 없을 때만 단일 시험 후보를 만듭니다.", graph([
  form([["state", "select", ["closed", "open", "half_open"]], ["failures", "number"], ["limit", "number"], ["now", "number"], ["retryAt", "number"], ["probeInFlight", "boolean"]]),
  condition("closed", "input", { path: "data.state", operator: "eq", value: "closed" }), condition("threshold", "closed", { path: "data.failures", operator: "gte", rightPath: "data.limit" }), message("open", "회로 개방 후보: 일반 요청 차단"), message("allow", "닫힌 회로: 일반 요청 후보"),
  condition("is_open", "closed", { path: "data.state", operator: "eq", value: "open" }), condition("retry_time", "is_open", { path: "data.now", operator: "gte", rightPath: "data.retryAt" }), message("wait", "열린 회로: 재시도 시각까지 대기"),
  node("probe_state", "merge", { merge: { mode: "array" }, inputBindings: { elapsed: bind("retry_time"), half: bind("is_open") } }),
  node("inflight", "condition", { predicate: { path: "data.0.probeInFlight", operator: "eq", value: true }, inputBindings: { data: bind("probe_state") } }), message("busy", "시험 요청 진행 중: 중복 시험 금지"), message("probe", "단일 시험 요청 후보: 결과 후 상태 전이 필요"), output(),
], [["input", "closed"], ["closed", "threshold", "yes"], ["threshold", "open", "yes"], ["threshold", "allow", "no"], ["closed", "is_open", "no"], ["is_open", "retry_time", "yes"], ["is_open", "probe_state", "no"], ["retry_time", "probe_state", "yes"], ["retry_time", "wait", "no"], ["probe_state", "inflight"], ["inflight", "busy", "yes"], ["inflight", "probe", "no"], ...["open", "allow", "wait", "busy", "probe"].map(id => [id, "output"] as Link)]), [
  scenario("닫힌 회로 요청", { state: "closed", failures: 0, limit: 3, now: 20, retryAt: 20, probeInFlight: false }, "일반 요청 후보", ["allow"], ["is_open"]),
  scenario("실패 한도 개방", { state: "closed", failures: 3, limit: 3, now: 20, retryAt: 20, probeInFlight: false }, "회로 개방 후보", ["open"], ["is_open"]),
  scenario("열린 회로 대기", { state: "open", failures: 3, limit: 3, now: 19, retryAt: 20, probeInFlight: false }, "시각까지 대기", ["wait"], ["inflight"]),
  scenario("재시도 시각 도달", { state: "open", failures: 3, limit: 3, now: 20, retryAt: 20, probeInFlight: false }, "단일 시험", ["probe"], ["wait"]),
  scenario("반열림 중복 시험 차단", { state: "half_open", failures: 3, limit: 3, now: 20, retryAt: 20, probeInFlight: true }, "중복 시험 금지", ["busy"], ["retry_time"]),
]);

const watermark = design("event-watermark-quarantine", "이벤트 시각을 체크포인트와 비교해 격리", "처음 수신한 시각을 저장하고, 이후 같은 시각은 중복 후보로 분리합니다. 오래된 이벤트는 별도 검토에서 수락해도 최신 워터마크를 뒤로 돌리지 않으며, 더 최신인 이벤트만 갱신합니다.", graph([
  form([["timestamp", "number"], ["eventId", "text"]]), node("read_mark", "memory", { memory: { action: "read", key: "watermark", defaultValue: 0 }, inputBindings: { current: bind("input") } }),
  node("found", "condition", { predicate: { path: "found", operator: "eq", value: true }, inputBindings: { current: bind("read_mark", "current"), mark: bind("read_mark"), found: bind("read_mark", "found") } }),
  node("newer", "condition", { predicate: { path: "current.timestamp", operator: "gt", rightPath: "mark" }, inputBindings: { current: bind("found", "current"), mark: bind("found", "mark") } }),
  node("equal", "condition", { predicate: { path: "current.timestamp", operator: "eq", rightPath: "mark" }, inputBindings: { current: bind("newer", "current"), mark: bind("newer", "mark") } }),
  node("duplicate", "transform", { title: "동일 시각 사건 식별자 표시", transform: { mode: "template", template: "동일 시각: 이벤트 {{eventId}}의 ID 중복 여부를 별도 확인" }, inputBindings: { eventId: bind("equal", "current.eventId") } }),
  node("late_review", "review", { review: { instructions: "늦은 이벤트를 별도로 수용할지 검토하세요. 수락해도 최신 워터마크는 유지합니다.", allowEdit: false, timeoutMinutes: 60 }, inputBindings: { current: bind("equal", "current"), mark: bind("equal", "mark") } }),
  node("late_accept", "transform", { title: "수락한 늦은 사건 기록", transform: { mode: "template", template: "늦은 이벤트 {{eventId}} 별도 수용: 워터마크 유지" }, inputBindings: { eventId: bind("late_review", "current.eventId") } }),
  node("late_reject", "transform", { title: "격리 유지할 사건 기록", transform: { mode: "template", template: "늦은 이벤트 {{eventId}} 격리 유지" }, inputBindings: { eventId: bind("late_review", "current.eventId") } }),
  node("new_mark", "merge", { merge: { mode: "array" }, inputBindings: { first: bind("found", "current"), next: bind("newer", "current") } }), node("save_mark", "memory", { memory: { action: "write", key: "watermark", valuePath: "data.0.timestamp" }, inputBindings: { data: bind("new_mark") } }), node("mark_result", "transform", { transform: { mode: "template", template: "워터마크 갱신: {{mark}}" }, inputBindings: { mark: bind("save_mark") } }), output(),
], [["input", "read_mark"], ["read_mark", "found"], ["found", "new_mark", "no"], ["found", "newer", "yes"], ["newer", "new_mark", "yes"], ["newer", "equal", "no"], ["equal", "duplicate", "yes"], ["equal", "late_review", "no"], ["late_review", "late_accept", "yes"], ["late_review", "late_reject", "no"], ["new_mark", "save_mark"], ["save_mark", "mark_result"], ...["duplicate", "late_accept", "late_reject", "mark_result"].map(id => [id, "output"] as Link)]), [
  scenario("최초 워터마크", { timestamp: 100, eventId: "a" }, "갱신: 100", ["save_mark"], ["newer"], { stateGroup: "events" }),
  scenario("같은 시각 별도 확인", { timestamp: 100, eventId: "b" }, "동일 시각: 이벤트 b의 ID 중복 여부를 별도 확인", ["duplicate"], ["save_mark"], { stateGroup: "events" }),
  scenario("오래된 이벤트 검토 수락", { timestamp: 90, eventId: "c" }, "늦은 이벤트 c 별도 수용: 워터마크 유지", ["late_accept"], ["save_mark"], { stateGroup: "events", review: "accept" }),
  scenario("수락 후에도 과거 시각 격리", { timestamp: 95, eventId: "d" }, "늦은 이벤트 d 격리 유지", ["late_reject"], ["save_mark"], { stateGroup: "events", review: "reject" }),
  scenario("더 최신 시각 갱신", { timestamp: 101, eventId: "e" }, "갱신: 101", ["save_mark"], ["late_review"], { stateGroup: "events" }),
]);

export const systemsWorkflowDesigns: WorkflowDesign[] = [retry, cache, pagination, deploy, lease, schema, breaker, watermark];
