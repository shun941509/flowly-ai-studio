import type { Definition, FlowNode } from "../../app/lib/model";
import type { DataSchema, FormConfig, InputBinding, Json, PredicateConfig } from "../../runtime/types";
import type { WorkflowDesign, WorkflowScenario } from "../workflow-design";

// Serialization helpers only. The sixteen operational contracts below have
// explicitly authored control/data paths; no optional-node combinations are used.
type Link = [string, string, string?];
const b = (nodeId: string, path = "data"): InputBinding => ({ nodeId, path });
const n = (id: string, type: FlowNode["type"], title: string, extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title, description: title, x: 40, y: 40, ...extra });
const str: DataSchema = { type: "string" }, num: DataSchema = { type: "number" }, bool: DataSchema = { type: "boolean" };
const obj = (properties: Record<string, DataSchema>): DataSchema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items: DataSchema): DataSchema => ({ type: "array", items });
const labels: Record<string, string> = { eventId: "현재 기록 식별자", predecessorId: "바로 앞 기록 식별자", payload: "보존할 본문", cancelRequested: "취소 요청 있음", completionObserved: "완료 응답 관측됨", commit: "외부 저장 결과", receipt: "완료 영수증 식별자", desiredGeneration: "게시하려는 세대", publishedGeneration: "현재 게시된 세대", expected: "선언한 파일 수", actual: "관측된 파일 수", hashesVerified: "파일 해시 검증 완료", cliPresent: "명령행 설정 있음", cliValue: "명령행 설정 주소", envPresent: "환경 설정 있음", envValue: "환경 설정 주소", filePresent: "파일 설정 있음", fileValue: "파일 설정 주소", oldId: "이전 연결 식별자", newId: "새 연결 식별자", tested: "새 연결 시험 완료", trafficSwitched: "트래픽 전환 관측됨", oldRevoked: "이전 연결 폐기 관측됨", active: "현재 전체 사용 용량", limit: "전체 용량 한도", tenantActive: "현재 사용자 사용 용량", tenantLimit: "사용자 용량 한도", critical: "긴급 요청", overflowAllowed: "긴급 초과 정책 있음", episode: "알림 회차 식별자", event: "관측된 알림 상태", localLabel: "원래 현지 시각 표기", kind: "현지 시각 해석 상태", earlierEpoch: "앞 시각 후보 값", laterEpoch: "뒤 시각 후보 값", choice: "사용자의 후보 선택" };
const form = (fields: [string, FormConfig["fields"][number]["type"], string[]?, boolean?][]) => n("input", "form", "필수 입력과 자료형 확인", { form: { fields: fields.map(([key, type, options, required = true]) => ({ key, type, label: labels[key] ?? key, required, ...(options ? { options } : {}) })) } });
const input = () => n("input", "input", "검증할 JSON 기록");
const parse = (schema: DataSchema) => n("parse", "transform", "JSON 기록의 구조 검증", { transform: { mode: "parse_json" }, outputSchema: obj({ text: str, data: schema }) });
const conditionTitles: Record<string, string> = { active: "부모 기록 활성 여부", after_start: "구간 시작 이상인가", already: "이미 게시된 세대인가", approved: "변환 정의가 승인됐는가", available: "읽기 가능한 복제본이 있는가", bad_hash: "불일치한 파일 해시가 있는가", before_end: "구간 끝보다 이전인가", blocked: "차단할 변환 결과가 있는가", cancel: "취소 요청이 있는가", cli: "명령행 설정이 있는가", cli_value: "명령행 값이 비어 있지 않은가", committed: "커밋 기록이 확인됐는가", complete: "완료 근거 대조", critical: "긴급 요청인가", current: "최소 읽기 버전을 충족하는가", different: "서로 다른 연결 식별자인가", digest: "승인된 변환 해시와 일치하는가", duplicate: "현재 기록 ID가 반복됐는가", earlier: "앞 후보를 선택했는가", earlier_index: "현재 위치보다 이전 번호인가", env: "환경 설정이 있는가", env_value: "환경 값이 비어 있지 않은가", equal: "표본 값이 기대값과 같은가", equal_count: "실제 목록 수가 선언과 같은가", exists: "참조 부모가 존재하는가", expected_unit: "요구 단위가 지정됐는가", file: "파일 설정이 있는가", file_value: "파일 값이 비어 있지 않은가", gap: "존재하지 않는 시각인가", global_room: "전체 용량에 여유가 있는가", has_samples: "검증 표본이 있는가", hash: "백업 해시가 일치하는가", hashes: "파일 해시가 일치하는가", healthy: "복제본이 건강한가", insecure: "선택 주소에 평문 HTTP가 있는가", interval: "시작보다 끝이 뒤인가", isolated: "실시간 처리 구간과 분리되는가", kept: "변환 후에도 기록이 남는가", late_firing: "해결 뒤 늦은 발생인가", later: "뒤 후보를 선택했는가", linked: "저장된 머리와 앞 기록이 연결되는가", mismatch: "표본 불일치가 있는가", mixed: "다른 단위가 섞였는가", new_firing: "다른 회차의 발생인가", nonempty: "처리 목록이 비어 있지 않은가", one_value: "유일한 시각의 후보가 같은가", optional: "참조가 없는 선택 관계인가", order: "조각 위치 오류가 있는가", ordered: "두 후보 시각이 올바른 순서인가", overflow: "긴급 초과 정책이 있는가", position: "조각 번호가 실제 위치와 같은가", positive: "선언한 수가 양수인가", proven: "양쪽 계보 증거가 확인됐는가", quarantine: "격리할 참조가 있는가", registered: "원본 데이터셋이 등록됐는가", retained: "보관 하한 안의 구간인가", revoked: "이전 연결이 폐기됐는가", same: "현재 기억하는 회차인가", same_id: "변환 전후 식별자가 같은가", schema: "복원 스키마가 같은가", slot_free: "기억 중인 회차가 해결됐는가", source_id: "원본 식별자가 비어 있지 않은가", still_firing: "발생 상태가 반복됐는가", switched_after: "폐기 전에 전환이 관측됐는가", switched_before: "트래픽 전환이 완료됐는가", target_id: "변환 식별자가 비어 있지 않은가", tenant_room: "사용자 용량에 여유가 있는가", tested_after: "폐기 전에 새 연결을 시험했는가", tested_before: "새 연결 시험이 끝났는가", uncommitted: "아직 커밋되지 않았는가", unique: "유일하게 해석되는 시각인가", unit: "측정 단위가 요구 단위와 같은가", unknown: "외부 저장 결과가 불명확한가", valid_active: "전체 사용 용량이 0 이상인가", valid_fields: "필수 근거가 비어 있지 않은가", valid_global: "전체 용량 한도가 유효한가", valid_tenant: "사용자 한도가 유효한가", valid_tenant_active: "사용자 사용 용량이 0 이상인가", valid_version: "요구 버전이 유효한가", version: "요구한 원본 버전인가", was_active: "이전 회차가 발생 상태인가" };
const c = (id: string, from: string, predicate: PredicateConfig, bindings?: Record<string, InputBinding>) => n(id, "condition", conditionTitles[id] ?? "조건 확인", { predicate, inputBindings: bindings ?? { data: b(from) } });
const t = (id: string, template: string, bindings: Record<string, InputBinding> = {}) => n(id, "transform", template.slice(0, 32), { transform: { mode: "template", template }, inputBindings: bindings });
const pick = (id: string, fields: Record<string, string>, bindings: Record<string, InputBinding>) => n(id, "transform", "필요한 원본 필드와 검증 결과 선택", { transform: { mode: "pick", fields }, inputBindings: bindings });
const out = (id = "output", bindings?: Record<string, InputBinding>) => n(id, "output", "실제로 선택된 결과", bindings ? { inputBindings: bindings } : {});
const review = (id: string, bindings?: Record<string, InputBinding>) => n(id, "review", "입력과 검증 기록 검토", { review: { instructions: "실제 기록과 판정 범위를 확인하세요. 수락은 외부 시스템 변경을 실행하지 않습니다.", allowEdit: false, timeoutMinutes: 60 }, ...(bindings ? { inputBindings: bindings } : {}) });
// parse_json emits canonical JSON. These rules reject empty values of named
// fields (including array records); quoted text inside values is JSON-escaped.
const nonemptyFields = (from: string, fields: string[]) => n("nonempty_fields", "evaluate", "필수 근거의 빈 문자열 검사", { evaluation: { mode: "rules", rules: fields.map(field => ({ kind: "not_contains", value: `${JSON.stringify(field)}:""` })), threshold: 1, rubric: "" }, inputBindings: { text: b(from, "text"), data: b(from) } });
const valueGate = () => c("valid_fields", "nonempty_fields", { path: "passed", operator: "eq", value: true }, { passed: b("nonempty_fields", "evaluation.passed"), data: b("nonempty_fields") });
const graph = (nodes: FlowNode[], links: Link[]): Definition => ({ schemaVersion: 5, nodes: nodes.map((node, i) => ({ ...node, x: 40 + (i % 3) * 280, y: 40 + Math.floor(i / 3) * 170 })), edges: links.map(([source, target, branch], i) => ({ id: `e${i}`, source, target, ...(branch ? { branch } : {}) })) });
const finish = (...ids: string[]): Link[] => ids.map(id => [id, "output"]);
const s = (name: string, data: Json, contains: string, visited: string[], skipped: string[] = [], extra: Partial<WorkflowScenario> = {}): WorkflowScenario => ({ name, input: JSON.stringify(data), status: "succeeded", contains: [contains], visited, skipped, ...extra });
const design = (id: string, title: string, behavior: string, definition: Definition, scenarios: WorkflowScenario[]): WorkflowDesign => ({ id: `rel-${id}`, title, category: "운영·데이터 신뢰성", description: behavior, behavior, definition, resources: [], scenarios: [...scenarios, { name: "손상된 JSON은 실제 실패", input: "{", status: "failed" }], inputExample: scenarios[0].input, expectedOutput: scenarios[0].contains?.join(" / ") ?? "입력에 따른 검증 결과", acceptance: [behavior, "분기별 실행·건너뜀과 실제 출력 값을 검사한다.", "외부 서비스 호출과 인프라 변경을 실행하지 않는다."], failureCases: scenarios.slice(1).map(x => x.name) });

// A linked event is accepted only when its predecessor is the saved head. The
// single memory write stores the event and payload together, not two partial writes.
const journal = design("linked-journal-gap", "앞 기록이 빠진 이벤트를 저장 순서에서 격리", "마지막으로 수용한 기록 ID와 predecessorId를 대조합니다. 같은 ID는 중복 후보, 연결되지 않은 ID는 gap으로 분리하며 연결된 이벤트만 로컬 머리 기록으로 저장합니다. 이벤트 본문 처리나 전체 이력 저장은 하지 않습니다.", graph([
  form([["eventId", "text"], ["predecessorId", "text"], ["payload", "text"]]),
  n("head", "memory", "현재 연결 머리 읽기", { memory: { action: "read", key: "journal_head", defaultValue: { eventId: "GENESIS", predecessorId: "", payload: "" } }, inputBindings: { current: b("input") } }),
  c("duplicate", "head", { path: "current.eventId", operator: "eq", rightPath: "head.eventId" }, { current: b("head", "current"), head: b("head") }),
  t("repeat", "중복 ID 후보: 저장하지 않음"),
  c("linked", "duplicate", { path: "current.predecessorId", operator: "eq", rightPath: "head.eventId" }, { current: b("duplicate", "current"), head: b("duplicate", "head") }),
  n("save", "memory", "연결된 이벤트와 본문을 한 번에 저장", { memory: { action: "write", key: "journal_head", valuePath: "event" }, inputBindings: { event: b("linked", "current") } }),
  pick("accepted", { acceptedEvent: "data.eventId", preservedPayload: "data.payload" }, { data: b("save") }),
  pick("gap", { expectedPredecessor: "head.eventId", receivedPredecessor: "current.predecessorId", heldEvent: "current.eventId" }, { head: b("linked", "head"), current: b("linked", "current") }), out(),
], [["input", "head"], ["head", "duplicate"], ["duplicate", "repeat", "yes"], ["duplicate", "linked", "no"], ["linked", "save", "yes"], ["save", "accepted"], ["linked", "gap", "no"], ...finish("repeat", "accepted", "gap")]), [
  s("최초 연결 기록", { eventId: "E1", predecessorId: "GENESIS", payload: "첫 본문" }, "첫 본문", ["save"], ["gap"], { stateGroup: "journal", outputs: { save: { data: { eventId: "E1", predecessorId: "GENESIS", payload: "첫 본문" } } } }),
  s("중복 ID는 본문도 덮어쓰지 않음", { eventId: "E1", predecessorId: "GENESIS", payload: "바꾼 본문" }, "중복 ID", ["repeat"], ["linked", "save"], { stateGroup: "journal" }),
  s("중간 기록 누락", { eventId: "E3", predecessorId: "E2", payload: "셋째" }, "expectedPredecessor", ["gap"], ["save"], { stateGroup: "journal", outputs: { gap: { data: { expectedPredecessor: "E1", receivedPredecessor: "E2", heldEvent: "E3" } } } }),
  s("누락 후 올바른 다음 기록", { eventId: "E2", predecessorId: "E1", payload: "둘째" }, "둘째", ["save"], ["gap"], { stateGroup: "journal" }),
]);

const migrationRow = graph([
  n("row", "input", "원본·변환 결과 쌍"), c("source_id", "row", { path: "item.sourceId", operator: "ne", value: "" }, { item: b("row", "item") }), c("target_id", "source_id", { path: "item.targetId", operator: "ne", value: "" }, { item: b("source_id", "item") }), c("same_id", "target_id", { path: "item.sourceId", operator: "eq", rightPath: "item.targetId" }, { item: b("target_id", "item") }),
  c("kept", "same_id", { path: "item.dropped", operator: "eq", value: false }, { item: b("same_id", "item") }), t("row_ok", "ROW_READY"), t("row_bad", "ROW_BLOCKED"), out("row_out"),
], [["row", "source_id"], ["source_id", "target_id", "yes"], ["source_id", "row_bad", "no"], ["target_id", "same_id", "yes"], ["target_id", "row_bad", "no"], ["same_id", "row_bad", "no"], ["same_id", "kept", "yes"], ["kept", "row_ok", "yes"], ["kept", "row_bad", "no"], ["row_ok", "row_out"], ["row_bad", "row_out"]]);
const migration = design("migration-dry-run", "변환 전후 식별자와 유실을 검사한 뒤 마이그레이션 검토", "제공된 변환 전후 쌍을 실제로 순회합니다. 식별자 변경 또는 유실이 하나라도 있으면 검토를 막고, 비어 있지 않은 정상 목록만 사람이 검토합니다. 변환 자체나 DB 쓰기를 수행하지 않습니다.", graph([
  input(), parse(arr(obj({ sourceId: str, targetId: str, dropped: bool }))),
  n("rows", "loop", "변환 쌍마다 식별자와 유실 검사", { loop: { itemsPath: "items", maxItems: 20, concurrency: 2, definition: migrationRow }, inputBindings: { items: b("parse") } }),
  c("blocked", "rows", { path: "text", operator: "contains", value: "ROW_BLOCKED" }, { text: b("rows", "text"), count: b("rows", "count"), original: b("parse") }), t("unsafe", "변환 결함: 마이그레이션 검토 금지"),
  c("nonempty", "blocked", { path: "count", operator: "gt", value: 0 }, { count: b("blocked", "count"), original: b("blocked", "original") }), t("empty", "변환 쌍 없음: 검증 완료 아님"),
  review("review", { original: b("nonempty", "original") }), pick("accepted", { reviewedPairs: "original" }, { original: b("review", "original") }), t("declined", "마이그레이션 검토 거절"), out(),
], [["input", "parse"], ["parse", "rows"], ["parse", "blocked"], ["rows", "blocked"], ["blocked", "unsafe", "yes"], ["blocked", "nonempty", "no"], ["nonempty", "empty", "no"], ["nonempty", "review", "yes"], ["review", "accepted", "yes"], ["review", "declined", "no"], ...finish("unsafe", "empty", "accepted", "declined")]), [
  s("정상 변환 쌍 수락", [{ sourceId: "A", targetId: "A", dropped: false }], "reviewedPairs", ["row_ok", "review", "accepted"], ["unsafe"], { review: "accept", outputs: { accepted: { data: { reviewedPairs: [{ sourceId: "A", targetId: "A", dropped: false }] } } } }),
  s("변환 ID 변경 차단", [{ sourceId: "A", targetId: "B", dropped: false }], "변환 결함", ["row_bad", "unsafe"], ["review"]),
  s("변환 유실 차단", [{ sourceId: "A", targetId: "A", dropped: true }], "변환 결함", ["row_bad"], ["review"]),
  s("양쪽 빈 식별자는 일치 근거가 아님", [{ sourceId: "", targetId: "", dropped: false }], "변환 결함", ["row_bad"], ["same_id", "review"]),
  s("변환 후 식별자 빈값", [{ sourceId: "A", targetId: "", dropped: false }], "변환 결함", ["row_bad"], ["same_id", "review"]),
  s("빈 검증 목록", [], "검증 완료 아님", ["empty"], ["review"]),
  s("정상 쌍도 검토 거절", [{ sourceId: "A", targetId: "A", dropped: false }], "검토 거절", ["declined"], ["accepted"], { review: "reject" }),
]);

const spot = graph([n("spot", "input", "복원 표본 쌍"), c("equal", "spot", { path: "item.actual", operator: "eq", rightPath: "item.expected" }, { item: b("spot", "item") }), t("match", "MATCH"), t("mismatch", "MISMATCH"), out("spot_out")], [["spot", "equal"], ["equal", "match", "yes"], ["equal", "mismatch", "no"], ["match", "spot_out"], ["mismatch", "spot_out"]]);
const recovery = design("restore-evidence-priority", "백업 무결성·스키마·복원 표본을 순서대로 검증", "관측된 해시가 다르면 표본을 검사하지 않습니다. 해시와 스키마가 일치한 경우에만 표본 값을 비교하며, 표본이 없거나 하나라도 다르면 복원 검증 통과를 표시하지 않습니다. 해시 계산과 실제 복원은 외부 단계입니다.", graph([
  input(), parse(obj({ actualHash: str, expectedHash: str, schema: str, expectedSchema: str, samples: arr(obj({ actual: str, expected: str })) })),
  nonemptyFields("parse", ["actualHash", "expectedHash", "schema", "expectedSchema"]), valueGate(), t("missing_evidence", "빈 해시·스키마 근거: 복원 검증 미설정"),
  c("hash", "valid_fields", { path: "data.actualHash", operator: "eq", rightPath: "data.expectedHash" }), t("corrupt", "백업 해시 불일치: 복원 검증 중단"),
  c("schema", "hash", { path: "data.schema", operator: "eq", rightPath: "data.expectedSchema" }), t("incompatible", "복원 대상 스키마 불일치"),
  n("samples", "loop", "복원된 표본을 기대값과 대조", { loop: { itemsPath: "items", maxItems: 20, concurrency: 2, definition: spot }, inputBindings: { items: b("schema", "data.samples") } }),
  c("has_samples", "samples", { path: "count", operator: "gt", value: 0 }, { count: b("samples", "count"), text: b("samples", "text") }), t("unverified", "표본 없음: 복원 검증 미완료"),
  c("mismatch", "has_samples", { path: "text", operator: "contains", value: "MISMATCH" }, { text: b("has_samples", "text"), count: b("has_samples", "count") }), t("bad_rows", "표본 불일치: 복원 검증 실패"), t("verified", "복원 표본 {{count}}개 일치: 실제 서비스 전환은 미실행", { count: b("mismatch", "count") }), out(),
], [["input", "parse"], ["parse", "nonempty_fields"], ["nonempty_fields", "valid_fields"], ["valid_fields", "missing_evidence", "no"], ["valid_fields", "hash", "yes"], ["hash", "corrupt", "no"], ["hash", "schema", "yes"], ["schema", "incompatible", "no"], ["schema", "samples", "yes"], ["samples", "has_samples"], ["has_samples", "unverified", "no"], ["has_samples", "mismatch", "yes"], ["mismatch", "bad_rows", "yes"], ["mismatch", "verified", "no"], ...finish("missing_evidence", "corrupt", "incompatible", "unverified", "bad_rows", "verified")]), [
  s("표본 일치", { actualHash: "h1", expectedHash: "h1", schema: "v2", expectedSchema: "v2", samples: [{ actual: "A", expected: "A" }] }, "1개 일치", ["verified"], ["bad_rows"], { outputs: { samples: { count: 1 } } }),
  s("해시가 먼저 실패", { actualHash: "h2", expectedHash: "h1", schema: "v1", expectedSchema: "v2", samples: [] }, "해시 불일치", ["corrupt"], ["schema", "samples"]),
  s("스키마 불일치", { actualHash: "h1", expectedHash: "h1", schema: "v1", expectedSchema: "v2", samples: [] }, "스키마 불일치", ["incompatible"], ["samples"]),
  s("표본 없는 백업", { actualHash: "h1", expectedHash: "h1", schema: "v2", expectedSchema: "v2", samples: [] }, "검증 미완료", ["unverified"], ["mismatch"]),
  s("일부 표본 불일치", { actualHash: "h1", expectedHash: "h1", schema: "v2", expectedSchema: "v2", samples: [{ actual: "A", expected: "B" }] }, "검증 실패", ["bad_rows"], ["verified"]),
  s("양쪽 빈 해시·스키마는 검증 근거가 아님", { actualHash: "", expectedHash: "", schema: "", expectedSchema: "", samples: [{ actual: "A", expected: "A" }] }, "검증 미설정", ["missing_evidence"], ["hash", "samples"]),
]);

const raceBase = { cancelRequested: true, completionObserved: true, commit: "committed", receipt: "R-17" };
const race = design("cancel-completion-race", "취소 요청과 완료 관측의 경합을 분리", "취소 요청 자체를 취소 완료로 보지 않습니다. 완료 관측과 커밋 기록이 일치하면 영수증을 보존하며, 기록 모순이나 결과 불명은 사람이 확인합니다. 실제 작업 취소는 실행하지 않습니다.", graph([
  form([["cancelRequested", "boolean"], ["completionObserved", "boolean"], ["commit", "select", ["none", "committed", "unknown"]], ["receipt", "text"]]),
  c("complete", "input", { path: "data.completionObserved", operator: "eq", value: true }), c("committed", "complete", { path: "data.commit", operator: "eq", value: "committed" }),
  pick("preserve", { completedReceipt: "data.receipt", cancellationRequested: "data.cancelRequested" }, { data: b("committed") }),
  review("inconsistent", { data: b("committed") }), t("checked", "완료 기록 모순을 검토함: 취소·완료 상태 미변경"), t("unchecked", "기록 모순 확인 거절: 상태 미확정"),
  c("cancel", "complete", { path: "data.cancelRequested", operator: "eq", value: true }), t("waiting", "취소 요청 없음: 완료 관측 대기"),
  c("uncommitted", "cancel", { path: "data.commit", operator: "eq", value: "none" }), t("stop_candidate", "커밋 전 중단 후보: 실제 취소는 별도 확인"),
  c("unknown", "uncommitted", { path: "data.commit", operator: "eq", value: "unknown" }), t("reconcile", "쓰기 결과 불명: 취소 성공으로 표시하지 않음"), t("too_late", "이미 커밋됨: 완료 영수증 재조회 필요"), out(),
], [["input", "complete"], ["complete", "committed", "yes"], ["committed", "preserve", "yes"], ["committed", "inconsistent", "no"], ["inconsistent", "checked", "yes"], ["inconsistent", "unchecked", "no"], ["complete", "cancel", "no"], ["cancel", "waiting", "no"], ["cancel", "uncommitted", "yes"], ["uncommitted", "stop_candidate", "yes"], ["uncommitted", "unknown", "no"], ["unknown", "reconcile", "yes"], ["unknown", "too_late", "no"], ...finish("preserve", "checked", "unchecked", "waiting", "stop_candidate", "reconcile", "too_late")]), [
  s("완료가 관측된 취소 경합", raceBase, "R-17", ["preserve"], ["cancel"], { outputs: { preserve: { data: { completedReceipt: "R-17", cancellationRequested: true } } } }),
  s("완료와 커밋 기록 모순 수락", { ...raceBase, commit: "none" }, "모순을 검토함", ["checked"], ["preserve"], { review: "accept" }),
  s("모순 검토 거절", { ...raceBase, commit: "unknown" }, "확인 거절", ["unchecked"], ["checked"], { review: "reject" }),
  s("취소 요청 없는 진행", { ...raceBase, completionObserved: false, cancelRequested: false }, "관측 대기", ["waiting"], ["uncommitted"]),
  s("커밋 전 요청", { ...raceBase, completionObserved: false, commit: "none" }, "중단 후보", ["stop_candidate"], ["unknown"]),
  s("결과 불명인 취소", { ...raceBase, completionObserved: false, commit: "unknown" }, "결과 불명", ["reconcile"], ["too_late"]),
  s("완료 응답만 유실", { ...raceBase, completionObserved: false }, "재조회 필요", ["too_late"], ["stop_candidate"]),
]);

const manifestFile = graph([n("file", "input", "파일별 관측 해시와 기대 해시"), c("hashes", "file", { path: "item.actualHash", operator: "eq", rightPath: "item.expectedHash" }, { item: b("file", "item") }), t("hash_ok", "HASH_OK"), t("hash_bad", "HASH_BAD"), out("file_out")], [["file", "hashes"], ["hashes", "hash_ok", "yes"], ["hashes", "hash_bad", "no"], ["hash_ok", "file_out"], ["hash_bad", "file_out"]]);
const batchBase = { desiredGeneration: "g2", publishedGeneration: "g1", expected: 2, files: [{ path: "a.txt", actualHash: "h1", expectedHash: "h1" }, { path: "b.txt", actualHash: "h2", expectedHash: "h2" }] };
const batch = design("manifest-publish-gate", "게시된 세대와 실제 manifest 항목을 대조하는 검토 관문", "이미 게시된 세대는 중복 후보를 만들지 않습니다. 새 세대는 실제 파일 목록을 순회해 해시를 대조하고 loop.count를 선언 개수와 비교합니다. 분수 건수와 빈 근거는 통과하지 못합니다. 파일 경로 유일성·해시 계산·실제 파일 게시를 수행하지 않는 관측 목록 검토입니다.", graph([
  input(), parse(obj({ desiredGeneration: str, publishedGeneration: str, expected: num, files: arr(obj({ path: str, actualHash: str, expectedHash: str })) })), nonemptyFields("parse", ["desiredGeneration", "publishedGeneration", "path", "actualHash", "expectedHash"]), valueGate(), t("no_evidence", "manifest 빈 근거: 게시 미설정"),
  c("already", "valid_fields", { path: "data.desiredGeneration", operator: "eq", rightPath: "data.publishedGeneration" }), t("no_op", "동일 세대 이미 게시됨: 추가 게시 없음"), c("positive", "already", { path: "data.expected", operator: "gt", value: 0 }),
  n("manifest", "loop", "각 파일의 해시를 대조하고 실제 목록 크기 산출", { loop: { itemsPath: "items", maxItems: 20, concurrency: 2, definition: manifestFile }, inputBindings: { items: b("positive", "data.files") } }),
  c("equal_count", "manifest", { path: "count", operator: "eq", rightPath: "original.expected" }, { count: b("manifest", "count"), text: b("manifest", "text"), original: b("positive") }),
  c("bad_hash", "equal_count", { path: "text", operator: "contains", value: "HASH_BAD" }, { text: b("equal_count", "text"), original: b("equal_count", "original") }),
  review("publish_review", { evidence: b("bad_hash", "text"), original: b("bad_hash", "original") }), t("candidate", "게시 검토 수락: {{generation}} · 실제 게시 미실행", { generation: b("publish_review", "original.desiredGeneration") }), t("rejected", "게시 검토 거절"), t("blocked", "manifest 검증 부족: 게시 보류"), out(),
], [["input", "parse"], ["parse", "nonempty_fields"], ["nonempty_fields", "valid_fields"], ["valid_fields", "no_evidence", "no"], ["valid_fields", "already", "yes"], ["already", "no_op", "yes"], ["already", "positive", "no"], ["positive", "blocked", "no"], ["positive", "manifest", "yes"], ["positive", "equal_count", "yes"], ["manifest", "equal_count"], ["equal_count", "blocked", "no"], ["equal_count", "bad_hash", "yes"], ["bad_hash", "blocked", "yes"], ["bad_hash", "publish_review", "no"], ["publish_review", "candidate", "yes"], ["publish_review", "rejected", "no"], ...finish("no_evidence", "no_op", "candidate", "rejected", "blocked")]), [
  s("새 세대의 증거 수락", batchBase, "g2", ["candidate", "hash_ok"], ["blocked"], { review: "accept", outputs: { manifest: { count: 2 }, publish_review: { original: batchBase } } }),
  s("같은 세대는 파일 검사 생략", { ...batchBase, publishedGeneration: "g2" }, "추가 게시 없음", ["no_op"], ["manifest", "publish_review"]),
  s("실제 목록 개수 불일치", { ...batchBase, files: batchBase.files.slice(0, 1) }, "게시 보류", ["blocked"], ["publish_review"]),
  s("분수 선언 건수 거절", { ...batchBase, expected: 1.5 }, "게시 보류", ["blocked"], ["bad_hash", "publish_review"]),
  s("빈 manifest", { ...batchBase, files: [], expected: 0 }, "게시 보류", ["blocked"], ["manifest"]),
  s("관측 해시 불일치", { ...batchBase, files: [{ path: "a.txt", actualHash: "changed", expectedHash: "h1" }, batchBase.files[1]] }, "게시 보류", ["hash_bad", "blocked"], ["publish_review"]),
  s("양쪽 빈 해시는 근거 아님", { ...batchBase, files: [{ path: "a.txt", actualHash: "", expectedHash: "" }] }, "게시 미설정", ["no_evidence"], ["manifest"]),
  s("증거 통과 뒤에도 거절 가능", batchBase, "검토 거절", ["rejected"], ["candidate"], { review: "reject" }),
]);

const referenceRow = graph([n("ref_row", "input", "행의 참조 관측값"), c("optional", "ref_row", { path: "item.hasReference", operator: "eq", value: false }, { item: b("ref_row", "item") }), t("unlinked", "UNLINKED_ALLOWED"), c("exists", "optional", { path: "item.parentExists", operator: "eq", value: true }, { item: b("optional", "item") }), t("missing", "QUARANTINE"), c("active", "exists", { path: "item.parentActive", operator: "eq", value: true }, { item: b("exists", "item") }), t("valid", "REFERENCE_VALID"), t("inactive", "PARENT_INACTIVE"), out("ref_out")], [["ref_row", "optional"], ["optional", "unlinked", "yes"], ["optional", "exists", "no"], ["exists", "missing", "no"], ["exists", "active", "yes"], ["active", "valid", "yes"], ["active", "inactive", "no"], ["unlinked", "ref_out"], ["missing", "ref_out"], ["valid", "ref_out"], ["inactive", "ref_out"]]);
const references = design("reference-row-quarantine", "선택 참조·끊어진 참조·비활성 부모를 행별 분리", "참조 없는 행은 부모 검사를 생략하고, 참조가 있는 행은 존재와 활성 상태를 나눠 검사합니다. 끊어진 참조가 있으면 검토하되 수락해도 원본의 참조를 수정하거나 격리를 해제하지 않습니다.", graph([
  input(), parse(arr(obj({ id: str, hasReference: bool, parentExists: bool, parentActive: bool }))), n("rows", "loop", "행별 참조 상태 판정", { loop: { itemsPath: "items", maxItems: 20, concurrency: 2, definition: referenceRow }, inputBindings: { items: b("parse") } }),
  c("quarantine", "rows", { path: "text", operator: "contains", value: "QUARANTINE" }, { text: b("rows", "text"), results: b("rows", "results"), original: b("parse") }), review("review", { original: b("quarantine", "original"), results: b("quarantine", "results"), text: b("quarantine", "text") }), t("noted", "끊어진 참조 검토 기록: 격리 유지"), t("declined", "참조 검토 거절: 격리 유지"), pick("classified", { rows: "original", classifications: "results" }, { original: b("quarantine", "original"), results: b("quarantine", "results") }), out(),
], [["input", "parse"], ["parse", "rows"], ["parse", "quarantine"], ["rows", "quarantine"], ["quarantine", "review", "yes"], ["quarantine", "classified", "no"], ["review", "noted", "yes"], ["review", "declined", "no"], ...finish("noted", "declined", "classified")]), [
  s("선택 참조와 유효 참조", [{ id: "A", hasReference: false, parentExists: false, parentActive: false }, { id: "B", hasReference: true, parentExists: true, parentActive: true }], "REFERENCE_VALID", ["unlinked", "valid", "classified"], ["review"], { outputs: { rows: { count: 2 } } }),
  s("존재하지만 비활성인 부모", [{ id: "A", hasReference: true, parentExists: true, parentActive: false }], "PARENT_INACTIVE", ["inactive", "classified"], ["review"]),
  s("끊어진 참조 확인 수락", [{ id: "A", hasReference: true, parentExists: false, parentActive: false }], "격리 유지", ["missing", "noted"], ["classified"], { review: "accept", outputs: { review: { original: [{ id: "A", hasReference: true, parentExists: false, parentActive: false }] } } }),
  s("끊어진 참조 검토 거절", [{ id: "A", hasReference: true, parentExists: false, parentActive: false }], "검토 거절", ["declined"], ["noted"], { review: "reject" }),
  s("빈 행은 검토를 만들지 않음", [], "classifications", ["classified"], ["review"], { outputs: { rows: { count: 0 } } }),
]);

const unitRow = graph([n("measurement", "input", "현재 측정값과 요구 단위"), c("unit", "measurement", { path: "item.unit", operator: "eq", rightPath: "expectedUnit" }, { item: b("measurement", "item"), expectedUnit: b("measurement", "expectedUnit") }), t("same", "UNIT_OK"), t("mixed", "UNIT_MISMATCH"), out("unit_out")], [["measurement", "unit"], ["unit", "same", "yes"], ["unit", "mixed", "no"], ["same", "unit_out"], ["mixed", "unit_out"]]);
const units = design("measurement-unit-contract", "단위가 섞인 측정값의 일괄 전달을 차단", "숫자 형식과 단위 일치를 별도로 검사합니다. 한 건이라도 다른 단위면 전체 목록의 후속 계산을 막고, 모두 일치한 비어 있지 않은 목록만 원래 값 그대로 전달합니다. 단위 변환과 합계 계산은 하지 않습니다.", graph([
  input(), parse(obj({ expectedUnit: str, measurements: arr(obj({ id: str, unit: str, value: num })) })), c("expected_unit", "parse", { path: "data.expectedUnit", operator: "ne", value: "" }), t("no_unit", "요구 단위 미설정: 동일한 빈값을 단위 일치로 보지 않음"), n("units", "loop", "모든 측정 단위를 요구 단위와 비교", { loop: { itemsPath: "items", maxItems: 20, concurrency: 2, definition: unitRow }, inputBindings: { items: b("expected_unit", "data.measurements"), expectedUnit: b("expected_unit", "data.expectedUnit") } }),
  c("nonempty", "units", { path: "count", operator: "gt", value: 0 }, { count: b("units", "count"), text: b("units", "text"), original: b("expected_unit") }), t("empty", "측정값 없음: 계산 입력 미생성"),
  c("mixed", "nonempty", { path: "text", operator: "contains", value: "UNIT_MISMATCH" }, { text: b("nonempty", "text"), original: b("nonempty", "original") }), t("reject", "단위 혼입: 변환 규칙 확인 전 전체 전달 차단"), pick("ready", { unit: "original.expectedUnit", readings: "original.measurements" }, { original: b("mixed", "original") }), out(),
], [["input", "parse"], ["parse", "expected_unit"], ["expected_unit", "no_unit", "no"], ["expected_unit", "units", "yes"], ["expected_unit", "nonempty", "yes"], ["units", "nonempty"], ["nonempty", "empty", "no"], ["nonempty", "mixed", "yes"], ["mixed", "reject", "yes"], ["mixed", "ready", "no"], ...finish("no_unit", "empty", "reject", "ready")]), [
  s("같은 단위와 음수 관측값 보존", { expectedUnit: "C", measurements: [{ id: "T1", unit: "C", value: -3 }] }, "T1", ["ready"], ["reject"], { outputs: { ready: { data: { unit: "C", readings: [{ id: "T1", unit: "C", value: -3 }] } } } }),
  s("다른 단위 하나가 전체 전달 차단", { expectedUnit: "C", measurements: [{ id: "T1", unit: "C", value: 0 }, { id: "T2", unit: "F", value: 32 }] }, "단위 혼입", ["mixed", "reject"], ["ready"]),
  s("빈 측정 목록", { expectedUnit: "C", measurements: [] }, "측정값 없음", ["empty"], ["mixed"]),
  s("문자 숫자는 실패", { expectedUnit: "C", measurements: [{ id: "T1", unit: "C", value: "3" }] }, "", [], [], { status: "failed", contains: [] }),
  s("양쪽 단위가 빈값", { expectedUnit: "", measurements: [{ id: "T1", unit: "", value: 3 }] }, "단위 미설정", ["no_unit"], ["units"]),
]);

const configBase = { cliPresent: true, cliValue: "https://cli.test", envPresent: true, envValue: "https://env.test", filePresent: true, fileValue: "https://file.test" };
const config = design("configuration-precedence", "설정 출처 우선순위와 선택한 주소 검사", "CLI·환경·파일 순서로 실제 값을 하나 선택하고 선택된 출처를 남깁니다. 어느 출처도 없으면 미설정이며 선택한 주소에 평문 HTTP가 포함되면 보류합니다. 실제 환경 변수나 파일을 읽거나 연결하지 않는 입력 계약 예제입니다.", graph([
  form([["cliPresent", "boolean"], ["cliValue", "text", undefined, false], ["envPresent", "boolean"], ["envValue", "text", undefined, false], ["filePresent", "boolean"], ["fileValue", "text", undefined, false]]),
  c("cli", "input", { path: "data.cliPresent", operator: "eq", value: true }), c("cli_value", "cli", { path: "data.cliValue", operator: "ne", value: "" }), pick("from_cli", { value: "data.cliValue" }, { data: b("cli_value") }),
  c("env", "cli", { path: "data.envPresent", operator: "eq", value: true }), c("env_value", "env", { path: "data.envValue", operator: "ne", value: "" }), pick("from_env", { value: "data.envValue" }, { data: b("env_value") }),
  c("file", "env", { path: "data.filePresent", operator: "eq", value: true }), c("file_value", "file", { path: "data.fileValue", operator: "ne", value: "" }), pick("from_file", { value: "data.fileValue" }, { data: b("file_value") }), t("missing", "미설정: 주소 출처 없음"), t("empty_value", "선택된 설정 값이 비어 있음: 하위 출처로 자동 대체하지 않음"),
  n("selected", "merge", "선택된 출처와 값을 같은 레코드로 모음", { merge: { mode: "object" }, inputBindings: { cli: b("from_cli"), env: b("from_env"), file: b("from_file") } }),
  c("insecure", "selected", { path: "text", operator: "contains", value: "http://" }, { text: b("selected", "text"), data: b("selected") }), t("blocked", "선택 주소에 평문 HTTP 포함: 연결 보류"), out("selected_out", { text: b("insecure", "text"), data: b("insecure") }), out(),
], [["input", "cli"], ["cli", "cli_value", "yes"], ["cli_value", "from_cli", "yes"], ["cli_value", "empty_value", "no"], ["cli", "env", "no"], ["env", "env_value", "yes"], ["env_value", "from_env", "yes"], ["env_value", "empty_value", "no"], ["env", "file", "no"], ["file", "file_value", "yes"], ["file_value", "from_file", "yes"], ["file_value", "empty_value", "no"], ["file", "missing", "no"], ["from_cli", "selected"], ["from_env", "selected"], ["from_file", "selected"], ["selected", "insecure"], ["insecure", "blocked", "yes"], ["insecure", "selected_out", "no"], ...finish("blocked", "missing", "empty_value")]), [
  s("CLI 우선 선택", configBase, "https://cli.test", ["from_cli", "selected_out"], ["env", "from_env"], { excludes: ["https://env.test"], outputs: { selected: { data: { cli: { value: "https://cli.test" } } } } }),
  s("환경 설정으로 대체", { ...configBase, cliPresent: false, cliValue: "" }, "https://env.test", ["from_env"], ["file"]),
  s("파일 설정만 남음", { ...configBase, cliPresent: false, cliValue: "", envPresent: false, envValue: "" }, "https://file.test", ["from_file"], ["missing"]),
  s("모든 출처 없음", { cliPresent: false, envPresent: false, filePresent: false }, "미설정", ["missing"], ["selected"]),
  s("우선 선택 주소만 검사", { ...configBase, cliValue: "http://cli.test" }, "연결 보류", ["blocked"], ["selected_out", "env"]),
  s("빈 CLI는 하위 값을 조용히 사용하지 않음", { ...configBase, cliValue: "" }, "비어 있음", ["empty_value"], ["env", "selected"]),
  s("빈 환경 설정", { ...configBase, cliPresent: false, envValue: "" }, "비어 있음", ["empty_value"], ["file", "selected"]),
  s("빈 파일 설정", { ...configBase, cliPresent: false, envPresent: false, fileValue: "" }, "비어 있음", ["empty_value"], ["selected"]),
]);

const rotationBase = { oldId: "key-old", newId: "key-new", tested: true, trafficSwitched: false, oldRevoked: false };
const rotation = design("credential-rotation-stages", "비밀 값 없이 자격 증명 교체의 단계 순서 검토", "식별자만 받아 새 연결 시험·트래픽 전환·이전 연결 폐기 순서를 구분합니다. 검증 전에 이전 연결을 폐기한 관측은 장애 점검 대상으로 분리합니다. 비밀 값을 읽거나 키 생성·전환·폐기를 실행하지 않습니다.", graph([
  form([["oldId", "text"], ["newId", "text"], ["tested", "boolean"], ["trafficSwitched", "boolean"], ["oldRevoked", "boolean"]]),
  c("different", "input", { path: "data.oldId", operator: "ne", rightPath: "data.newId" }), t("same", "서로 같은 식별자: 교체 단계 판단 불가"),
  c("revoked", "different", { path: "data.oldRevoked", operator: "eq", value: true }), c("tested_after", "revoked", { path: "data.tested", operator: "eq", value: true }), c("switched_after", "tested_after", { path: "data.trafficSwitched", operator: "eq", value: true }), t("finished", "교체 관측 기록 완료: 실제 연결 상태는 별도 확인"), t("incident", "이전 연결이 먼저 폐기됨: 접근 장애 점검 필요"),
  c("tested_before", "revoked", { path: "data.tested", operator: "eq", value: true }), t("test_first", "새 연결 시험 먼저: 비밀 값은 이 입력에 넣지 마세요"), c("switched_before", "tested_before", { path: "data.trafficSwitched", operator: "eq", value: true }),
  review("switch_review", { data: b("switched_before") }), t("switch_candidate", "트래픽 전환 검토안 수락: 실제 전환 미실행"),
  review("revoke_review", { data: b("switched_before") }), t("revoke_candidate", "이전 연결 폐기 검토안 수락: 실제 폐기 미실행"), t("denied", "교체 단계 검토 거절"), out(),
], [["input", "different"], ["different", "same", "no"], ["different", "revoked", "yes"], ["revoked", "tested_after", "yes"], ["tested_after", "incident", "no"], ["tested_after", "switched_after", "yes"], ["switched_after", "finished", "yes"], ["switched_after", "incident", "no"], ["revoked", "tested_before", "no"], ["tested_before", "test_first", "no"], ["tested_before", "switched_before", "yes"], ["switched_before", "switch_review", "no"], ["switched_before", "revoke_review", "yes"], ["switch_review", "switch_candidate", "yes"], ["switch_review", "denied", "no"], ["revoke_review", "revoke_candidate", "yes"], ["revoke_review", "denied", "no"], ...finish("same", "finished", "incident", "test_first", "switch_candidate", "revoke_candidate", "denied")]), [
  s("시험 완료 후 전환 검토", rotationBase, "전환 검토안 수락", ["switch_candidate"], ["revoke_review"], { review: "accept" }),
  s("동일 식별자 차단", { ...rotationBase, newId: "key-old" }, "같은 식별자", ["same"], ["revoked"]),
  s("새 연결 미시험", { ...rotationBase, tested: false }, "시험 먼저", ["test_first"], ["switch_review"]),
  s("검증 전 이전 연결 폐기", { ...rotationBase, tested: false, oldRevoked: true }, "장애 점검", ["incident"], ["switched_after"]),
  s("전환 전 이전 연결 폐기", { ...rotationBase, oldRevoked: true }, "장애 점검", ["incident"], ["finished"]),
  s("전환 완료 후 폐기 검토", { ...rotationBase, trafficSwitched: true }, "폐기 검토안 수락", ["revoke_candidate"], ["switch_review"], { review: "accept" }),
  s("관측상 단계 완료", { ...rotationBase, trafficSwitched: true, oldRevoked: true }, "관측 기록 완료", ["finished"], ["tested_before"]),
  s("전환 검토 거절", rotationBase, "검토 거절", ["denied"], ["switch_candidate"], { review: "reject" }),
  s("폐기 검토 거절", { ...rotationBase, trafficSwitched: true }, "검토 거절", ["denied"], ["revoke_candidate"], { review: "reject" }),
]);

const fragmentRow = graph([n("fragment", "input", "목록 위치와 조각 번호"), c("position", "fragment", { path: "item.index", operator: "eq", rightPath: "index" }, { item: b("fragment", "item"), index: b("fragment", "index") }), t("aligned", "POSITION_OK"), c("earlier_index", "position", { path: "item.index", operator: "lt", rightPath: "index" }, { item: b("position", "item"), index: b("position", "index") }), t("prior_index", "POSITION_BAD_PRIOR: 이전 번호 재수신·역순 확인"), t("future_index", "POSITION_BAD_FUTURE: 앞 조각 누락·선수신 확인"), out("fragment_out")], [["fragment", "position"], ["position", "aligned", "yes"], ["position", "earlier_index", "no"], ["earlier_index", "prior_index", "yes"], ["earlier_index", "future_index", "no"], ["aligned", "fragment_out"], ["prior_index", "fragment_out"], ["future_index", "fragment_out"]]);
const fragments = design("fragment-position-validation", "누락·중복·순서가 틀린 조각 목록의 재조립을 보류", "각 조각 번호를 실제 배열 위치와 대조하고 선언된 총 개수와도 비교합니다. 불일치는 이전 번호 재수신과 앞 조각 누락 가능성을 구분해 위치별 진단을 반환합니다. 순서를 임의로 바꾸거나 누락 내용을 만들지 않으며, 통과한 원문 조각만 순서대로 반환합니다. 바이너리 결합은 하지 않습니다.", graph([
  input(), parse(obj({ expectedCount: num, fragments: arr(obj({ index: num, body: str })) })), c("positive", "parse", { path: "data.expectedCount", operator: "gt", value: 0 }), t("invalid", "총 조각 수는 양수여야 함"),
  n("positions", "loop", "실제 위치별 조각 번호 검사", { loop: { itemsPath: "items", maxItems: 20, concurrency: 2, definition: fragmentRow }, inputBindings: { items: b("positive", "data.fragments") } }),
  c("complete", "positions", { path: "count", operator: "eq", rightPath: "original.expectedCount" }, { count: b("positions", "count"), text: b("positions", "text"), original: b("positive") }), t("missing", "총 개수 불일치: 조각 전달 보류"),
  c("order", "complete", { path: "text", operator: "contains", value: "POSITION_BAD" }, { text: b("complete", "text"), original: b("complete", "original") }), t("bad", "조각 위치 불일치: 위치별 진단\n{{text}}", { text: b("order", "text") }), pick("ready", { orderedFragments: "original.fragments", count: "original.expectedCount" }, { original: b("order", "original") }), out(),
], [["input", "parse"], ["parse", "positive"], ["positive", "invalid", "no"], ["positive", "positions", "yes"], ["positive", "complete", "yes"], ["positions", "complete"], ["complete", "missing", "no"], ["complete", "order", "yes"], ["order", "bad", "yes"], ["order", "ready", "no"], ...finish("invalid", "missing", "bad", "ready")]), [
  s("정확한 두 조각", { expectedCount: 2, fragments: [{ index: 0, body: "첫" }, { index: 1, body: "둘" }] }, "orderedFragments", ["ready"], ["bad"], { outputs: { ready: { data: { orderedFragments: [{ index: 0, body: "첫" }, { index: 1, body: "둘" }], count: 2 } } } }),
  s("선언 수보다 누락", { expectedCount: 2, fragments: [{ index: 0, body: "첫" }] }, "총 개수 불일치", ["missing"], ["order"]),
  s("중복 번호로 개수만 맞춘 목록", { expectedCount: 2, fragments: [{ index: 0, body: "첫" }, { index: 0, body: "중복" }] }, "POSITION_BAD_PRIOR", ["prior_index", "bad"], ["ready"]),
  s("뒤바뀐 조각은 앞뒤 진단 모두 남김", { expectedCount: 2, fragments: [{ index: 1, body: "둘" }, { index: 0, body: "첫" }] }, "POSITION_BAD_FUTURE", ["future_index", "prior_index", "bad"], ["ready"], { contains: ["POSITION_BAD_FUTURE", "POSITION_BAD_PRIOR"] }),
  s("0개 선언은 재조립 아님", { expectedCount: 0, fragments: [] }, "양수", ["invalid"], ["positions"]),
]);

const replicaRow = graph([n("replica", "input", "복제본 관측과 최소 읽기 버전"), c("healthy", "replica", { path: "item.healthy", operator: "eq", value: true }, { item: b("replica", "item"), required: b("replica", "required") }), t("down", "REPLICA_DOWN"), c("current", "healthy", { path: "item.version", operator: "gte", rightPath: "required" }, { item: b("healthy", "item"), required: b("healthy", "required") }), t("eligible", "READ_ELIGIBLE"), t("stale", "REPLICA_STALE"), out("replica_out")], [["replica", "healthy"], ["healthy", "down", "no"], ["healthy", "current", "yes"], ["current", "eligible", "yes"], ["current", "stale", "no"], ["down", "replica_out"], ["eligible", "replica_out"], ["stale", "replica_out"]]);
const replicas = design("replica-read-version", "건강 상태와 최소 읽기 버전을 모두 만족하는 복제본 확인", "주어진 단조 증가 버전 번호를 최소 요구 버전과 비교합니다. 건강하지 않은 복제본은 버전을 신뢰하지 않으며, 각 관측 기록과 판정을 같은 순서로 반환합니다. 실제 읽기 라우팅과 복제 지연 측정은 하지 않습니다.", graph([
  input(), parse(obj({ requiredVersion: num, replicas: arr(obj({ id: str, healthy: bool, version: num })) })), c("valid_version", "parse", { path: "data.requiredVersion", operator: "gte", value: 0 }), t("invalid", "요구 버전은 음수일 수 없음"),
  n("replicas", "loop", "복제본별 건강·버전 검사", { loop: { itemsPath: "items", maxItems: 20, concurrency: 2, definition: replicaRow }, inputBindings: { items: b("valid_version", "data.replicas"), required: b("valid_version", "data.requiredVersion") } }),
  c("available", "replicas", { path: "text", operator: "contains", value: "READ_ELIGIBLE" }, { text: b("replicas", "text"), results: b("replicas", "results"), original: b("valid_version") }), pick("candidates", { observations: "original.replicas", decisions: "results", requiredVersion: "original.requiredVersion" }, { original: b("available", "original"), results: b("available", "results") }), t("wait", "요구 버전의 건강한 복제본 없음: 읽기 대기"), out(),
], [["input", "parse"], ["parse", "valid_version"], ["valid_version", "invalid", "no"], ["valid_version", "replicas", "yes"], ["valid_version", "available", "yes"], ["replicas", "available"], ["available", "candidates", "yes"], ["available", "wait", "no"], ...finish("invalid", "candidates", "wait")]), [
  s("최소 버전과 같은 복제본 사용 가능", { requiredVersion: 7, replicas: [{ id: "r1", healthy: true, version: 7 }, { id: "r2", healthy: true, version: 6 }] }, "READ_ELIGIBLE", ["eligible", "stale", "candidates"], ["wait"], { outputs: { replicas: { count: 2 } } }),
  s("높은 버전이어도 장애 복제본 제외", { requiredVersion: 7, replicas: [{ id: "r1", healthy: false, version: 9 }] }, "읽기 대기", ["down", "wait"], ["current"]),
  s("모두 오래된 복제본", { requiredVersion: 7, replicas: [{ id: "r1", healthy: true, version: 6 }] }, "읽기 대기", ["stale", "wait"], ["candidates"]),
  s("복제본 목록 없음", { requiredVersion: 0, replicas: [] }, "읽기 대기", ["wait"], ["candidates"]),
  s("음수 요구 버전 거절", { requiredVersion: -1, replicas: [] }, "음수", ["invalid"], ["replicas"]),
]);

const queueBase = { active: 2, limit: 3, tenantActive: 1, tenantLimit: 2, critical: false, overflowAllowed: false };
const queue = design("queue-capacity-exception", "전체 용량·사용자 몫·긴급 예외를 구분한 대기열 판정", "일반 여유가 있어도 사용자별 한도를 넘으면 대기합니다. 전체가 찬 경우에는 긴급 표시와 명시된 초과 정책을 모두 만족해야 사람 검토를 요청합니다. 큐 삽입이나 작업 실행은 하지 않습니다.", graph([
  form([["active", "number"], ["limit", "number"], ["tenantActive", "number"], ["tenantLimit", "number"], ["critical", "boolean"], ["overflowAllowed", "boolean"]]),
  c("valid_global", "input", { path: "data.limit", operator: "gt", value: 0 }), c("valid_tenant", "valid_global", { path: "data.tenantLimit", operator: "gt", value: 0 }), c("valid_active", "valid_tenant", { path: "data.active", operator: "gte", value: 0 }), c("valid_tenant_active", "valid_active", { path: "data.tenantActive", operator: "gte", value: 0 }), t("invalid", "용량 한도는 양수, 사용 용량은 0 이상이어야 함"),
  c("global_room", "valid_tenant_active", { path: "data.active", operator: "lt", rightPath: "data.limit" }), c("tenant_room", "global_room", { path: "data.tenantActive", operator: "lt", rightPath: "data.tenantLimit" }), t("admit", "일반 용량 후보: 실제 큐 삽입 미실행"), t("tenant_wait", "사용자 몫 소진: 공정 대기"),
  c("critical", "global_room", { path: "data.critical", operator: "eq", value: true }), t("normal_wait", "전체 용량 소진: 일반 대기"), c("overflow", "critical", { path: "data.overflowAllowed", operator: "eq", value: true }), t("no_exception", "긴급 요청도 초과 허용 정책 없음"),
  review("exception", { data: b("overflow") }), t("exception_plan", "긴급 초과 검토 수락: 실행 용량 변경 미실행"), t("denied", "긴급 초과 검토 거절"), out(),
], [["input", "valid_global"], ["valid_global", "invalid", "no"], ["valid_global", "valid_tenant", "yes"], ["valid_tenant", "invalid", "no"], ["valid_tenant", "valid_active", "yes"], ["valid_active", "invalid", "no"], ["valid_active", "valid_tenant_active", "yes"], ["valid_tenant_active", "invalid", "no"], ["valid_tenant_active", "global_room", "yes"], ["global_room", "tenant_room", "yes"], ["tenant_room", "admit", "yes"], ["tenant_room", "tenant_wait", "no"], ["global_room", "critical", "no"], ["critical", "normal_wait", "no"], ["critical", "overflow", "yes"], ["overflow", "no_exception", "no"], ["overflow", "exception", "yes"], ["exception", "exception_plan", "yes"], ["exception", "denied", "no"], ...finish("invalid", "admit", "tenant_wait", "normal_wait", "no_exception", "exception_plan", "denied")]), [
  s("전체와 사용자 여유", queueBase, "일반 용량 후보", ["admit"], ["critical"]),
  s("사용자 몫 경계", { ...queueBase, tenantActive: 2 }, "공정 대기", ["tenant_wait"], ["admit"]),
  s("전체 용량 경계", { ...queueBase, active: 3 }, "일반 대기", ["normal_wait"], ["tenant_room"]),
  s("긴급이지만 정책 없음", { ...queueBase, active: 3, critical: true }, "정책 없음", ["no_exception"], ["exception"]),
  s("명시된 긴급 초과 검토", { ...queueBase, active: 3, critical: true, overflowAllowed: true }, "검토 수락", ["exception_plan"], ["denied"], { review: "accept" }),
  s("긴급 초과 검토 거절", { ...queueBase, active: 3, critical: true, overflowAllowed: true }, "검토 거절", ["denied"], ["exception_plan"], { review: "reject" }),
  s("0 전체 한도는 미설정", { ...queueBase, limit: 0 }, "양수", ["invalid"], ["valid_tenant"]),
  s("0 사용자 한도", { ...queueBase, tenantLimit: 0 }, "양수", ["invalid"], ["global_room"]),
  s("전체 사용 용량 음수", { ...queueBase, active: -1 }, "0 이상", ["invalid"], ["global_room", "admit"]),
  s("사용자 사용 용량 음수", { ...queueBase, tenantActive: -1 }, "0 이상", ["invalid"], ["global_room", "admit"]),
]);

const backfillRow = graph([n("row", "input", "행의 시각과 반열린 구간"), c("after_start", "row", { path: "item.time", operator: "gte", rightPath: "start" }, { item: b("row", "item"), start: b("row", "start"), end: b("row", "end") }), t("before", "BEFORE_RANGE"), c("before_end", "after_start", { path: "item.time", operator: "lt", rightPath: "end" }, { item: b("after_start", "item"), end: b("after_start", "end") }), t("inside", "IN_BACKFILL_RANGE"), t("after", "AT_OR_AFTER_END"), out("row_out")], [["row", "after_start"], ["after_start", "before", "no"], ["after_start", "before_end", "yes"], ["before_end", "inside", "yes"], ["before_end", "after", "no"], ["before", "row_out"], ["inside", "row_out"], ["after", "row_out"]]);
const backfillBase = { start: 100, end: 200, retentionStart: 90, liveStart: 200, rows: [{ time: 100, value: "start" }, { time: 200, value: "end" }] };
const backfill = design("backfill-range-contract", "보관 범위와 실시간 구간을 침범하지 않는 과거 처리 검토", "같은 단위의 숫자 시각을 받아 [start,end) 구간을 검증합니다. 보관 하한과 실시간 시작점을 넘지 않는 경우만 행별 포함 여부를 계산합니다. 데이터 재처리와 날짜·시간대 변환은 하지 않습니다.", graph([
  input(), parse(obj({ start: num, end: num, retentionStart: num, liveStart: num, rows: arr(obj({ time: num, value: str })) })), c("interval", "parse", { path: "data.start", operator: "lt", rightPath: "data.end" }), t("invalid", "빈 구간 또는 역전된 구간"), c("retained", "interval", { path: "data.start", operator: "gte", rightPath: "data.retentionStart" }), t("expired", "보관 하한 이전: 원본 확보 필요"), c("isolated", "retained", { path: "data.end", operator: "lte", rightPath: "data.liveStart" }), t("overlap", "실시간 처리 구간 침범: 범위 분리 필요"),
  n("rows", "loop", "시작 포함·끝 제외를 행마다 검사", { loop: { itemsPath: "items", maxItems: 20, concurrency: 2, definition: backfillRow }, inputBindings: { items: b("isolated", "data.rows"), start: b("isolated", "data.start"), end: b("isolated", "data.end") } }), pick("report", { originalRows: "data.rows", classifications: "results", start: "data.start", endExclusive: "data.end" }, { data: b("isolated"), results: b("rows", "results") }), out(),
], [["input", "parse"], ["parse", "interval"], ["interval", "invalid", "no"], ["interval", "retained", "yes"], ["retained", "expired", "no"], ["retained", "isolated", "yes"], ["isolated", "overlap", "no"], ["isolated", "rows", "yes"], ["isolated", "report", "yes"], ["rows", "report"], ...finish("invalid", "expired", "overlap", "report")]), [
  s("시작 포함 끝 제외", backfillBase, "AT_OR_AFTER_END", ["inside", "after", "report"], ["overlap"], { outputs: { rows: { count: 2 } } }),
  s("시작보다 이른 행", { ...backfillBase, rows: [{ time: 99, value: "before" }] }, "BEFORE_RANGE", ["before"], ["before_end"]),
  s("빈 구간", { ...backfillBase, end: 100 }, "빈 구간", ["invalid"], ["retained"]),
  s("보관 하한 침범", { ...backfillBase, start: 89 }, "원본 확보", ["expired"], ["isolated"]),
  s("실시간 구간 침범", { ...backfillBase, end: 201 }, "범위 분리", ["overlap"], ["rows"]),
  s("범위 안 행이 없어도 목록 그대로", { ...backfillBase, rows: [] }, "classifications", ["report"], ["overlap"], { outputs: { rows: { count: 0 } } }),
]);

const alerts = design("alert-episode-lifecycle", "마지막 알림 회차의 발생·중복·해결을 구별", "마지막 회차 한 개의 상태만 로컬 기억에 저장합니다. 현재 기억하는 회차가 해결됐다면 그 회차의 늦은 발생을 막고, 다른 회차의 해결 신호는 현재 상태를 지우지 않습니다. 새 회차가 기록되면 더 이전 회차의 중복 검출은 보장하지 않습니다. 알림 전송이나 전체 회차 이력 시스템은 아닙니다.", graph([
  form([["episode", "text"], ["event", "select", ["firing", "clear"]]]), n("prior", "memory", "마지막 알림 회차와 상태 읽기", { memory: { action: "read", key: "alert_episode", defaultValue: { episode: "", event: "clear" } }, inputBindings: { current: b("input") } }),
  c("same", "prior", { path: "current.episode", operator: "eq", rightPath: "previous.episode" }, { current: b("prior", "current"), previous: b("prior") }), c("was_active", "same", { path: "previous.event", operator: "eq", value: "firing" }, { current: b("same", "current"), previous: b("same", "previous") }),
  c("still_firing", "was_active", { path: "current.event", operator: "eq", value: "firing" }, { current: b("was_active", "current") }), t("duplicate", "발생 중복: 상태와 알림 추가 없음"),
  c("late_firing", "was_active", { path: "current.event", operator: "eq", value: "firing" }, { current: b("was_active", "current") }), t("late", "해결된 회차의 늦은 발생: 재개하지 않음"), t("already_clear", "해결 중복: 상태 변경 없음"),
  c("new_firing", "same", { path: "current.event", operator: "eq", value: "firing" }, { current: b("same", "current"), previous: b("same", "previous") }), t("orphan", "다른 회차의 해결 신호: 현재 상태 보존"), c("slot_free", "new_firing", { path: "previous.event", operator: "eq", value: "clear" }, { current: b("new_firing", "current"), previous: b("new_firing", "previous") }), t("busy", "다른 활성 회차 있음: 별도 장애 기록 필요"),
  n("next", "merge", "새 발생 또는 현재 해결의 활성 기록 선택", { merge: { mode: "array" }, inputBindings: { cleared: b("still_firing", "current"), opened: b("slot_free", "current") } }),
  n("save", "memory", "확정된 회차 상태를 하나의 레코드로 저장", { memory: { action: "write", key: "alert_episode", valuePath: "data.0" }, inputBindings: { data: b("next") } }), t("saved", "회차 {{data.episode}} 상태 저장: {{data.event}}", { data: b("save") }), out(),
], [["input", "prior"], ["prior", "same"], ["same", "was_active", "yes"], ["was_active", "still_firing", "yes"], ["still_firing", "duplicate", "yes"], ["still_firing", "next", "no"], ["was_active", "late_firing", "no"], ["late_firing", "late", "yes"], ["late_firing", "already_clear", "no"], ["same", "new_firing", "no"], ["new_firing", "orphan", "no"], ["new_firing", "slot_free", "yes"], ["slot_free", "busy", "no"], ["slot_free", "next", "yes"], ["next", "save"], ["save", "saved"], ...finish("duplicate", "late", "already_clear", "orphan", "busy", "saved")]), [
  s("처음 발생", { episode: "A", event: "firing" }, "상태 저장: firing", ["save"], ["busy"], { stateGroup: "alerts", outputs: { save: { data: { episode: "A", event: "firing" } } } }),
  s("같은 발생 중복", { episode: "A", event: "firing" }, "발생 중복", ["duplicate"], ["save"], { stateGroup: "alerts" }),
  s("다른 활성 회차 보류", { episode: "B", event: "firing" }, "별도 장애", ["busy"], ["save"], { stateGroup: "alerts" }),
  s("다른 회차 해결은 현재 상태 보존", { episode: "B", event: "clear" }, "현재 상태 보존", ["orphan"], ["save"], { stateGroup: "alerts" }),
  s("현재 회차 해결", { episode: "A", event: "clear" }, "상태 저장: clear", ["save"], ["orphan"], { stateGroup: "alerts" }),
  s("해결 중복", { episode: "A", event: "clear" }, "해결 중복", ["already_clear"], ["save"], { stateGroup: "alerts" }),
  s("해결 뒤 늦은 발생", { episode: "A", event: "firing" }, "재개하지 않음", ["late"], ["save"], { stateGroup: "alerts" }),
  s("다음 회차는 새로 저장", { episode: "B", event: "firing" }, "회차 B", ["save"], ["busy"], { stateGroup: "alerts", outputs: { prior: { data: { episode: "A", event: "clear" } } } }),
  s("두 번째 회차 해결", { episode: "B", event: "clear" }, "상태 저장: clear", ["save"], ["late"], { stateGroup: "alerts" }),
  s("기억에서 밀린 이전 회차 중복은 검출하지 못함", { episode: "A", event: "firing" }, "회차 A", ["save"], ["late"], { stateGroup: "alerts", outputs: { prior: { data: { episode: "B", event: "clear" } } } }),
]);

const lineageSource = graph([n("source", "input", "원본 데이터셋의 등록·버전 기록"), c("registered", "source", { path: "data.sourceRegistered", operator: "eq", value: true }), c("version", "registered", { path: "data.actualVersion", operator: "eq", rightPath: "data.requiredVersion" }), t("source_ok", "SOURCE_PROVEN"), t("source_bad", "SOURCE_UNPROVEN"), out("source_out")], [["source", "registered"], ["registered", "source_bad", "no"], ["registered", "version", "yes"], ["version", "source_ok", "yes"], ["version", "source_bad", "no"], ["source_ok", "source_out"], ["source_bad", "source_out"]]);
const lineageTransform = graph([n("transform", "input", "변환 정의의 승인·해시 기록"), c("approved", "transform", { path: "data.transformApproved", operator: "eq", value: true }), c("digest", "approved", { path: "data.actualDigest", operator: "eq", rightPath: "data.approvedDigest" }), t("transform_ok", "TRANSFORM_PROVEN"), t("transform_bad", "TRANSFORM_UNPROVEN"), out("transform_out")], [["transform", "approved"], ["approved", "transform_bad", "no"], ["approved", "digest", "yes"], ["digest", "transform_ok", "yes"], ["digest", "transform_bad", "no"], ["transform_ok", "transform_out"], ["transform_bad", "transform_out"]]);
const lineageBase = { source: "source-A", target: "target-B", sourceRegistered: true, actualVersion: "v2", requiredVersion: "v2", transformApproved: true, actualDigest: "d1", approvedDigest: "d1" };
const lineage = design("lineage-edge-evidence", "원본 버전과 변환 승인으로 계보 연결 한 개 검증", "원본 등록·버전과 변환 승인·해시를 독립 검사합니다. 양쪽 증거가 모두 통과한 경우에만 입력한 source→target 연결의 검증 기록을 반환합니다. 전체 계보 탐색·해시 계산·데이터 변환은 수행하지 않습니다.", graph([
  input(), parse(obj({ source: str, target: str, sourceRegistered: bool, actualVersion: str, requiredVersion: str, transformApproved: bool, actualDigest: str, approvedDigest: str })), nonemptyFields("parse", ["source", "target", "actualVersion", "requiredVersion", "actualDigest", "approvedDigest"]), valueGate(),
  n("evidence", "parallel", "원본 증거와 변환 증거를 각각 검사", { inputBindings: { data: b("valid_fields") }, parallel: { concurrency: 2, tasks: [{ id: "source", name: "원본", definition: lineageSource }, { id: "transform", name: "변환", definition: lineageTransform }] } }),
  n("both", "evaluate", "양쪽 증거가 모두 확인됐는지 검사", { evaluation: { mode: "rules", rules: [{ kind: "contains", value: "SOURCE_PROVEN" }, { kind: "contains", value: "TRANSFORM_PROVEN" }], threshold: 1, rubric: "" }, inputBindings: { text: b("evidence", "text"), original: b("valid_fields") } }),
  c("proven", "both", { path: "passed", operator: "eq", value: true }, { passed: b("both", "evaluation.passed"), original: b("both", "original"), evidence: b("both", "text") }), pick("edge", { source: "original.source", target: "original.target", version: "original.actualVersion", digest: "original.actualDigest", evidence: "evidence" }, { original: b("proven", "original"), evidence: b("proven", "evidence") }), t("broken", "계보 연결 증거 부족: 검증된 연결로 표시하지 않음"), out(),
], [["input", "parse"], ["parse", "nonempty_fields"], ["nonempty_fields", "valid_fields"], ["valid_fields", "broken", "no"], ["valid_fields", "evidence", "yes"], ["valid_fields", "both", "yes"], ["evidence", "both"], ["both", "proven"], ["proven", "edge", "yes"], ["proven", "broken", "no"], ...finish("edge", "broken")]), [
  s("원본과 변환 모두 입증", lineageBase, "target-B", ["edge", "source_ok", "transform_ok"], ["broken"]),
  s("원본 미등록", { ...lineageBase, sourceRegistered: false }, "증거 부족", ["source_bad", "broken"], ["version", "edge"]),
  s("원본 버전 변경", { ...lineageBase, actualVersion: "v3" }, "증거 부족", ["source_bad"], ["edge"]),
  s("변환 미승인", { ...lineageBase, transformApproved: false }, "증거 부족", ["transform_bad"], ["digest", "edge"]),
  s("승인 뒤 변환 내용 변경", { ...lineageBase, actualDigest: "d2" }, "증거 부족", ["transform_bad"], ["edge"]),
  s("빈 버전과 해시는 승인 근거가 아님", { ...lineageBase, actualVersion: "", requiredVersion: "", actualDigest: "", approvedDigest: "" }, "증거 부족", ["broken"], ["evidence", "edge"]),
]);

const timeBase = { localLabel: "2030-11-03 01:30", kind: "ambiguous", earlierEpoch: 100, laterEpoch: 200, choice: "earlier" };
const timeChoice = design("ambiguous-time-choice", "중복·존재하지 않는 현지 시각의 후보 선택 계약", "외부 시간대 해석기가 제공한 후보 숫자 시각을 검사합니다. 유일한 시각은 두 후보가 같아야 하며 중복 시각은 먼저/나중 선택을 요구합니다. 존재하지 않는 시각은 일정을 만들지 않습니다. 실제 시간대 변환이나 일정 등록은 수행하지 않습니다.", graph([
  form([["localLabel", "text"], ["kind", "select", ["unique", "ambiguous", "nonexistent"]], ["earlierEpoch", "number"], ["laterEpoch", "number"], ["choice", "select", ["earlier", "later", "none"]]]),
  c("unique", "input", { path: "data.kind", operator: "eq", value: "unique" }), c("one_value", "unique", { path: "data.earlierEpoch", operator: "eq", rightPath: "data.laterEpoch" }), pick("single", { selectedEpoch: "data.earlierEpoch", localLabel: "data.localLabel" }, { data: b("one_value") }), t("inconsistent", "시간 후보 계약 모순: 원 해석기 결과 재확인"),
  c("gap", "unique", { path: "data.kind", operator: "eq", value: "nonexistent" }), t("nonexistent", "존재하지 않는 현지 시각: 일정 후보 없음"),
  c("ordered", "gap", { path: "data.earlierEpoch", operator: "lt", rightPath: "data.laterEpoch" }), c("earlier", "ordered", { path: "data.choice", operator: "eq", value: "earlier" }), pick("first", { selectedEpoch: "data.earlierEpoch", localLabel: "data.localLabel" }, { data: b("earlier") }),
  c("later", "earlier", { path: "data.choice", operator: "eq", value: "later" }), pick("second", { selectedEpoch: "data.laterEpoch", localLabel: "data.localLabel" }, { data: b("later") }), t("needs_choice", "같은 현지 시각의 두 후보: 먼저 또는 나중을 선택하세요"), out(),
], [["input", "unique"], ["unique", "one_value", "yes"], ["one_value", "single", "yes"], ["one_value", "inconsistent", "no"], ["unique", "gap", "no"], ["gap", "nonexistent", "yes"], ["gap", "ordered", "no"], ["ordered", "inconsistent", "no"], ["ordered", "earlier", "yes"], ["earlier", "first", "yes"], ["earlier", "later", "no"], ["later", "second", "yes"], ["later", "needs_choice", "no"], ...finish("single", "inconsistent", "nonexistent", "first", "second", "needs_choice")]), [
  s("중복 시각의 앞 후보", timeBase, "100", ["first"], ["later"], { outputs: { first: { data: { selectedEpoch: 100, localLabel: "2030-11-03 01:30" } } } }),
  s("중복 시각의 뒤 후보", { ...timeBase, choice: "later" }, "200", ["second"], ["first"], { outputs: { second: { data: { selectedEpoch: 200, localLabel: "2030-11-03 01:30" } } } }),
  s("선택 누락은 임의 선택 안 함", { ...timeBase, choice: "none" }, "선택하세요", ["needs_choice"], ["first", "second"]),
  s("존재하지 않는 시각", { ...timeBase, kind: "nonexistent" }, "일정 후보 없음", ["nonexistent"], ["ordered"]),
  s("유일한 시각 후보", { ...timeBase, kind: "unique", laterEpoch: 100 }, "100", ["single"], ["gap"]),
  s("유일하다는 주장과 두 값이 모순", { ...timeBase, kind: "unique" }, "계약 모순", ["inconsistent"], ["single"]),
  s("중복 후보의 순서 모순", { ...timeBase, earlierEpoch: 200, laterEpoch: 100 }, "계약 모순", ["inconsistent"], ["earlier"]),
]);

export const reliabilityWorkflowDesigns: WorkflowDesign[] = [journal, migration, recovery, race, batch, references, units, config, rotation, fragments, replicas, queue, backfill, alerts, lineage, timeChoice];
