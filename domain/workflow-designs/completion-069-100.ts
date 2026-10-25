import type { Definition, FlowNode } from '../../app/lib/model';
import type { InputBinding, Json } from '../../runtime/types';
import type { WorkflowDesign, WorkflowScenario } from '../workflow-design';
import { layoutWorkflow } from '../workflow-layout';
import { allBlocksCompletion } from './completion-069-100-all-blocks';

type Step = string | { parallel: string[]; title: string } | { review: string } | { gate: string };
type Spec = { number: string; slug: string; title: string; purpose: string; steps: Step[]; input?: Record<string, Json>; bad?: Record<string, Json>; badAction?: string; action?: string; acceptance: string[] };
const bind = (nodeId: string, path = 'data'): InputBinding => ({ nodeId, path });
const node = (id: string, type: FlowNode['type'], title: string, extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title, x: 0, y: 0, ...extra });
const definition = (nodes: FlowNode[], edges: Definition['edges']) => layoutWorkflow({ schemaVersion: 5, nodes, edges });
const operation = (id: string, name: string, from: string, path = 'data') => node(id, 'program', name.replaceAll('_', ' '), { program: { name: 'completion', arguments: { operation: `operations.${name}` }, bindings: { arguments: 'arguments' } }, inputBindings: { arguments: bind(from, path) } });
const operationTask = (id: string, name: string) => definition([
  node(`${id}_input`, 'input', '독립 검증 입력'), operation(`${id}_operation`, name, `${id}_input`, 'record'), node(`${id}_output`, 'output', '실제 계산 근거', { inputBindings: { text: bind(`${id}_operation`, 'text'), data: bind(`${id}_operation`) } }),
], [{ id: `${id}_e1`, source: `${id}_input`, target: `${id}_operation` }, { id: `${id}_e2`, source: `${id}_operation`, target: `${id}_output` }]);

/** Each specification defines its own observable work and failure gates. The
 * builder only shares safe wiring, Korean failure reports and scenario plumbing. */
export function buildCompletion(spec: Spec): WorkflowDesign {
  const prefix = `c${spec.number}`, nodes: FlowNode[] = [], edges: Definition['edges'] = [];
  let serial = 0, current = `${prefix}_input`, path = 'text', branch: string | undefined;
  const id = (name: string) => `${prefix}_${name}_${serial++}`;
  const link = (source: string, target: string, route?: string) => edges.push({ id: id('edge'), source, target, ...(route ? { branch: route } : {}) });
  const add = (item: FlowNode, nextPath = 'data') => { nodes.push(item); link(current, item.id, branch); current = item.id; path = nextPath; branch = undefined; return item.id; };
  const held = (source: string, reason: string, route = 'no') => {
    const message = id('held'), output = id('held_output');
    nodes.push(node(message, 'transform', '검사 결과로 작업 보류', { inputBindings: {}, transform: { mode: 'template', template: JSON.stringify({ status: 'held', plan: spec.number, reason }) } }), node(output, 'output', '미완료 사유', { inputBindings: { text: bind(message, 'text') } }));
    link(source, message, route); link(message, output);
  };
  nodes.push(node(current, 'input', `${spec.title} 요청 JSON`));
  add(node(id('parse'), 'transform', '입력 자료 읽기', { transform: { mode: 'parse_json' } }));
  const parsed = current;
  const marker = `COMPLETED_${spec.number}_PLAN:`;
  const agent = add(node(id('agent'), 'agent', '근거와 작업 범위를 판단하는 Agent', {
    prompt: `${marker} ${spec.purpose}. 입력 record를 읽고 등록 작업만 선택하세요. 진행 가능하면 {proceed:true,action:"${spec.action ?? 'fix_average'}",reason:"짧은 근거"}, 불가능하면 proceed:false로 답하세요. 실제 검사 결과는 이후 프로그램이 계산합니다. 임의 코드·SQL·셸·주소·승인 정책을 만들지 마세요.`,
    allowedTools: [], format: 'JSON', inputBindings: { record: bind(parsed) }, limits: { maxTurns: 2, maxToolCalls: 1, maxTokens: 4000, maxDurationMs: 60000 },
    outputSchema: { type: 'object', properties: { text: { type: 'string' }, data: { type: 'object', properties: { proceed: { type: 'boolean' }, action: { type: 'string' }, reason: { type: 'string' } }, required: ['proceed', 'action', 'reason'], additionalProperties: false } }, required: ['text', 'data'] },
  }));
  const merged = add(node(id('proposal'), 'merge', '원래 입력과 제한된 제안 결합', { merge: { mode: 'object' }, inputBindings: { record: bind(parsed), proposal: bind(agent) } })); link(parsed, merged);
  add(node(id('proceed'), 'condition', 'Agent가 진행 가능한 범위인가', { predicate: { path: 'record.proposal.proceed', operator: 'eq', value: true }, inputBindings: { record: bind(merged) } }), 'record'); held(current, 'Agent가 허용된 작업 범위에서 진행을 보류했습니다.'); branch = 'yes';
  let firstReview: string | undefined;
  for (const step of spec.steps) {
    if (typeof step === 'string') { add(operation(id(step), step, current, path)); }
    else if ('gate' in step) {
      add(node(id('gate'), 'condition', step.gate, { predicate: { path: 'record.passed', operator: 'eq', value: true }, inputBindings: { record: bind(current, path) } }), 'record'); held(current, step.gate); branch = 'yes';
    } else if ('review' in step) {
      const review = add(node(id('review'), 'review', step.review, { review: { instructions: `${step.review}. 실제 계산의 근거·버전·대상을 확인합니다. 이 승인은 격리된 로컬 표본의 다음 단계에만 적용됩니다.`, allowEdit: false, timeoutMinutes: 30 }, inputBindings: { record: bind(current, path) } }), 'record'); firstReview ??= review; held(review, '검토자가 변경 진행을 거절했습니다.'); branch = 'yes';
    } else {
      const previous = current, previousPath = path, previousBranch = branch;
      const parallel = add(node(id('parallel'), 'parallel', step.title, { parallel: { concurrency: Math.min(4, step.parallel.length), tasks: step.parallel.map((name, i) => ({ id: `check_${i}`, name, definition: operationTask(`${prefix}_${serial}_${i}`, name) })) }, inputBindings: { record: bind(current, path) } }), 'results');
      const merge = add(node(id('observations'), 'merge', '독립 검사의 실제 근거 모으기', { merge: { mode: 'object' }, inputBindings: { record: bind(previous, previousPath), checks: bind(parallel, 'results') } })); link(previous, merge, previousBranch);
      add(operation(id('collect'), 'collect_evidence', merge));
    }
  }
  add(operation(id('final_verify'), 'final_verify', current, path));
  add(node(id('final_gate'), 'condition', '관측 원장을 독립적으로 확인', { predicate: { path: 'record.passed', operator: 'eq', value: true }, inputBindings: { record: bind(current) } }), 'record'); held(current, '관측 원장에 해결되지 않은 실패가 남았습니다.'); branch = 'yes';
  const output = add(node(id('output'), 'output', '검증된 실행 근거와 결과', { inputBindings: { text: bind(current, `${path}.evidence.status`), data: bind(current, path) } }), 'text');
  const initial = spec.input ?? {}, input = JSON.stringify(initial);
  const reply = (action = spec.action ?? 'fix_average', proceed = true) => ({ match: marker, text: JSON.stringify({ proceed, action, reason: '등록된 대상과 제한된 실행 범위를 확인했습니다.' }) });
  const normal: WorkflowScenario = { name: '실제 등록 연산과 관측 원장을 검증하고 재개해도 중복 실행하지 않음', input, status: 'succeeded', review: 'accept', modelReplies: [reply()], contains: ['verified'], visited: [output], resumeAgain: true };
  const bad: WorkflowScenario = { name: '핵심 입력·산출물 조건 불일치가 후속 실행을 차단', input: JSON.stringify({ ...initial, ...spec.bad }), status: 'succeeded', review: 'accept', modelReplies: [reply(spec.badAction ?? spec.action ?? 'fix_average')], contains: ['held'], skipped: [output] };
  const scenarios: WorkflowScenario[] = [normal, bad, { name: 'Agent의 작업 보류 판단은 실제 연산을 시작하지 않음', input, status: 'succeeded', modelReplies: [reply(undefined, false)], contains: ['held'], skipped: [output] }];
  if (firstReview) scenarios.push({ name: '정확한 관측 결과 검토 후 거절하면 변경과 완료 보고를 하지 않음', input, status: 'succeeded', review: 'reject', modelReplies: [reply()], contains: ['held'], skipped: [output] });
  return { id: `completed-${spec.number}-${spec.slug}`, title: `${spec.number} · ${spec.title}`, category: '등록 작업 기반 완성 예제', description: spec.purpose, behavior: spec.steps.map(s => typeof s === 'string' ? s : 'parallel' in s ? `병렬(${s.parallel.join(', ')})` : 'gate' in s ? s.gate : s.review).join(' → '), definition: definition(nodes, edges), resources: [], inputExample: input, expectedOutput: '실제 관측 원장의 verified 또는 조건 미달 held', acceptance: [...spec.acceptance, 'Agent 판단과 실제 프로그램 검증을 분리하며 검토·실패 분기 및 재개를 기록합니다.', '등록된 표본의 로컬 실행이며 임의 저장소·운영 DB·브라우저를 자동 연결하지 않습니다.'], failureCases: scenarios.slice(1).map(s => s.name), scenarios };
}

const gate = (message: string): Step => ({ gate: message });
const review = (message: string): Step => ({ review: message });
const parallel = (title: string, ...names: string[]): Step => ({ parallel: names, title });
const code = { project: 'registered-average' };
const rows: Json[] = [{ id: 1, name: 'alpha', quantity: 3, updated: 1, held: false }, { id: 2, name: 'beta', quantity: 4, updated: 2, held: false }, { id: 3, name: 'gamma', quantity: 2, updated: 3, held: true }];

const specs: Spec[] = [
  { number: '069', slug: 'reproduce-repair', title: '실패 재현부터 실제 파일 패치·회귀 시험', purpose: '등록된 average 코드의 잘못된 분모를 재현하고 허용 패치를 고른 뒤 별도 Python 프로세스에서 회귀 시험합니다.', input: code, badAction: 'keep_legacy', steps: ['code_inspect', 'code_reproduce', gate('실제로 재현된 실패가 있어야 수정'), 'code_patch', 'code_test', gate('실제 재현·회귀 시험 통과'), review('패치와 시험 근거 검토'), 'code_build'], acceptance: ['실제 코드 AST 조사·파일 작성·독립 Python 시험·TAR 산출물을 연결합니다.', '수정하지 않은 후보는 시험에서 탈락하고 통합되지 않습니다.'] },
  { number: '070', slug: 'behavior-refactor', title: '출력 계약을 유지하는 리팩터링', purpose: '정상 기준 버전과 리팩터링 후보를 여러 길이·부호·빈 배열에서 대조하고 독립 회귀 시험과 함께 검증합니다.', input: { ...code, version: 'fixed' }, action: 'refactor_average', badAction: 'keep_legacy', steps: ['code_inspect', 'code_patch', parallel('차등 검사와 프로세스 시험', 'code_differential', 'code_test'), gate('차등·회귀 검사가 모두 통과'), review('행동 유지 근거 검토'), 'code_build'], acceptance: ['차등 계산과 별도 프로세스 회귀 시험을 실제 병렬 작업으로 분리합니다.', '기준 코드를 고친 것으로 추정하지 않고 입력별 출력을 대조합니다.'] },
  { number: '071', slug: 'offline-dependency-upgrade', title: '오프라인 의존성 잠금·업그레이드 검증', purpose: '번들된 등록 패키지의 의존성 버전을 해석하고 잠금 해시를 만들며 후보 파일·빌드·시험을 연결합니다.', input: { ...code, dependencyVersion: '2' }, bad: { dependencyVersion: '9' }, steps: ['code_inspect', 'code_dependencies', gate('등록 버전과 잠금 의존성 호환'), review('잠금 변경 검토'), 'code_patch', 'code_build', 'code_test', gate('잠금한 후보의 실제 시험 통과')], acceptance: ['외부 패키지 다운로드 없이 실제 고정 레지스트리의 호환성·lock hash를 계산합니다.', '등록되지 않은 업그레이드는 빌드 전에 보류합니다.'] },
  { number: '072', slug: 'mutation-test-gap', title: '요구 동작·결함 탐지 기반 테스트 보강', purpose: '양수·음수·단건·빈 입력의 요구 사항과 시험 입력을 연결하고 잘못된 분모 변이를 실제로 탐지합니다.', input: { ...code, testInputs: [[2, 4], [-4, -2], [7], []] }, bad: { testInputs: [[0, 0]] }, steps: ['code_inspect', 'code_mutation', gate('요구 동작과 변이 탐지가 모두 충족'), 'code_patch', parallel('시험과 경계값 차등 검사', 'code_test', 'code_differential'), gate('보강된 검증 모두 통과')], acceptance: ['줄 커버리지가 아닌 요구별 시험 존재와 실제 결함 탐지를 확인합니다.', '결함을 드러내지 않는 입력만 있으면 완료되지 않습니다.'] },
  { number: '073', slug: 'controlled-race-order', title: '경쟁 순서를 재현하고 원자 갱신 확인', purpose: '읽기·쓰기 순서를 고정한 여러 스케줄에서 손실 갱신을 검출하고 원자 증가의 동일 결과를 확인합니다.', input: { ...code, atomic: true }, bad: { atomic: false }, steps: ['code_inspect', parallel('서로 다른 결함 관점 검증', 'code_schedule', 'code_mutation'), gate('모든 제어 스케줄과 변이 시험 통과'), review('원자 연산 변경 검토'), 'code_patch', 'code_test'], acceptance: ['단순히 여러 Agent를 병렬 실행하는 대신 명시적인 read/write trace를 계산합니다.', '원자 연산을 제거한 스케줄은 결과 1과 기대 2의 차이를 드러냅니다.'] },
  { number: '074', slug: 'instrumented-performance', title: '결과 동등성과 연산량 회귀 분석', purpose: '동일 데이터에서 이중 비교와 집합 알고리즘의 출력·실제 연산 횟수를 비교하며 벽시계 성능과 구분합니다.', input: { ...code, optimized: true }, bad: { optimized: false }, steps: ['code_inspect', 'code_benchmark', gate('모든 크기에서 동일 결과와 연산량 개선'), 'code_patch', parallel('성능·정확성의 독립 재검사', 'code_benchmark', 'code_test', 'code_differential'), gate('개선 뒤 정확성까지 통과'), review('범위와 측정 한계 검토')], acceptance: ['크기별 실제 반복 연산량·개선 비율·분산 범위를 계산합니다.', '머신 시간 성능 개선으로 과장하지 않습니다.'] },
  { number: '075', slug: 'html-interaction-contract', title: '실제 브라우저 폼 상호작용·접근성 검사', purpose: '격리 HTML을 실제 Chrome에서 열고 빈 값·보완 값 제출, 라벨·ARIA·화면 근거를 확인합니다. 사용자 스크립트와 외부 요청은 차단합니다.', input: {}, bad: { html: '<form><input id="q"><button id="send">전송</button></form>' }, steps: ['ui_interaction', gate('라벨·필수값·제출 계약 충족'), review('HTML 상태와 접근성 근거 검토'), 'evidence_pin', 'evidence_revalidate'], acceptance: ['실제 Playwright 클릭·입력·submit 횟수·HTML 유효성·ARIA·스크린샷 hash를 수집합니다.', '회사 웹앱의 URL과 인증을 이용한 원격 검사는 등록 browser MCP 설정 대상입니다.'] },
  { number: '076', slug: 'reproducible-artifact', title: '격리 빌드의 결정적 산출물 검사', purpose: '동일 등록 소스와 잠금 파일을 순서를 바꿔 두 번 패키징하고 TAR 해시·파일 목록을 대조합니다.', input: { ...code }, bad: { expectedBuildHash: 'stale-build' }, steps: ['code_dependencies', gate('오프라인 잠금 해석'), 'code_inspect', 'code_patch', 'code_build', gate('정규화된 두 빌드의 해시 일치'), review('산출물과 잠금 해시 승인'), 'code_test'], acceptance: ['타임스탬프·파일 순서를 정규화한 실제 TAR bytes를 대조합니다.', '다른 빌드 해시를 지정하면 완료하지 않습니다.'] },
  { number: '077', slug: 'knowledge-lifecycle', title: '증분·시점·관계·수치·철회·복구 RAG', purpose: '동일 자료 세대 안에서 본문 변경·검색 평가·관계 확장·수치 근거·피드백·전체 세대 철회·복구를 연결합니다.', input: {}, bad: { feedbackRelevant: ['missing-document'] }, steps: ['rag_lifecycle', 'rag_incremental', gate('증분 세대 검색 평가'), 'rag_query', 'rag_feedback', gate('출처 피드백 기대 자료 충족'), review('자료 사용 철회 검토'), 'rag_revoke', 'rag_recover', 'rag_query'], acceptance: ['변경 자료와 재사용 자료를 본문 해시로 구분합니다.', '등록·수정·시점 검색·관계·수치·피드백·철회·복구가 한 실행 산출물과 원장으로 이어집니다.', '철회 후 이전 세대를 복구해도 제거한 출처와 관계는 살아나지 않습니다.'] },
  { number: '078', slug: 'evidence-impact-development', title: '지식 근거 변경 시 코드 검증 무효화', purpose: '기술 문서 버전·본문 해시를 고정하고 코드 패치·실행 시험 뒤 현재 자료와 다시 대조해 영향 산출물을 차단합니다.', input: { ...code }, bad: { currentDocuments: [{ id: 'average-contract', version: 2, text: 'changed calculation contract' }] }, steps: ['evidence_pin', 'code_inspect', 'code_patch', 'code_test', gate('실제 코드 시험 통과'), 'evidence_revalidate', gate('코드·시험·리뷰의 근거 버전이 현재와 일치'), review('고정된 기술 근거와 구현 승인'), 'code_build'], acceptance: ['자료 변경으로 implementation/tests/review/db_migration을 실제 무효화 대상으로 계산합니다.', '시험을 통과해도 근거가 바뀌면 후속 빌드를 보류합니다.'] },
  { number: '079', slug: 'database-inventory', title: 'DB 구조·행·관측 시점 진단', purpose: '격리 SQLite를 만들고 실제 스키마·행 수·무결성·행 해시를 수집하여 관측 시점 요구를 대조합니다.', input: { rows, requestedAt: 100, observedAt: 100 }, bad: { observedAt: 80 }, steps: ['db_inspect', gate('관측 시점과 실제 무결성 충족'), parallel('데이터 품질과 권한 독립 검사', 'db_quality', 'db_permissions'), gate('진단 대상의 품질·접근 기준 충족'), 'evidence_pin'], acceptance: ['실제 PRAGMA/SELECT 결과를 수집합니다.', '오래된 상태 보고를 현재 상태로 표시하지 않습니다.'] },
  { number: '080', slug: 'query-plan-comparison', title: '실제 SQLite 실행 계획과 결과 비교', purpose: '같은 데이터에서 원래 쿼리와 인덱스 후보를 실행해 결과 집합과 EXPLAIN 계획을 대조합니다.', input: { rows }, bad: { candidateMinimum: 9 }, steps: ['db_inspect', 'db_query_compare', gate('인덱스 사용과 동일 행 결과 확인'), review('쿼리 변경 근거 검토'), 'db_quality', gate('조회 대상의 데이터 품질 충족')], acceptance: ['SQL은 고정 등록문만 사용하며 사용자 SQL을 실행하지 않습니다.', '계획 개선처럼 보여도 반환 행이 달라지면 채택하지 않습니다.'] },
  { number: '081', slug: 'index-plan-rollback', title: '인덱스 후보·백업·승인·적용 검증', purpose: '실제 조회 계획을 비교한 다음 백업과 고정 인덱스 변경 계획을 묶어 검토·적용·검증합니다.', input: { rows, migration: 'index_quantity' }, bad: { candidateMinimum: 99 }, action: 'index_quantity', steps: ['db_inspect', 'db_query_compare', gate('조회 의미와 인덱스 효과 확인'), 'db_backup', 'db_plan', gate('백업에 결합된 변경 계획'), review('정확한 테이블·계획·백업 검토'), 'db_apply', 'db_verify', gate('변경 후 실제 무결성 확인')], acceptance: ['데이터 버전·백업 hash·변경 planHash를 결합합니다.', '변경된 입력으로 예전 계획을 적용할 수 없습니다.'] },
  { number: '082', slug: 'deadlock-target-release', title: '대기 그래프의 정확한 세션 조치', purpose: '실제 입력 대기 그래프에서 순환을 탐색하고 대상과 그래프 해시를 결합하여 검토 후 해당 간선만 제거합니다.', input: {}, bad: { targetSession: 'unrelated' }, steps: ['db_locks', gate('대기 순환에 포함된 정확한 대상'), review('대상 세션과 영향 검토'), 'db_lock_release', gate('허용 대상 간선 제거 확인'), 'evidence_pin', 'evidence_revalidate'], acceptance: ['세션 순환과 조치 대상을 프로그램으로 계산합니다.', '실제 회사 세션 취소는 별도 회사 MCP 계약이 필요합니다.'] },
  { number: '083', slug: 'schema-deploy-and-recover', title: '스키마 변경과 실제 백업 복구 확인', purpose: 'SQLite 백업 bytes와 행 해시를 만든 후 허용 DDL을 적용하고 검증된 복구본을 별도 검토합니다.', input: { rows, migration: 'add_status' }, bad: { observedAt: 1, requestedAt: 100 }, action: 'add_status', steps: ['db_inspect', gate('변경 전 관측 시점 확인'), 'db_backup', 'db_plan', review('스키마와 백업 결합 검토'), 'db_apply', 'db_verify', gate('적용 후 스키마와 무결성 확인'), 'db_quality'], acceptance: ['SQLite backup/serialize/deserialize와 ALTER TABLE을 실제 실행합니다.', '복구와 원래 목표 완료를 구분하여 originalGoalComplete:false를 기록합니다.'] },
  { number: '084', slug: 'full-backup-restoration', title: '전체 백업 바이트·복구 데이터 검증', purpose: '실제 SQLite backup으로 만든 파일 bytes를 복원하고 무결성·전체 행 해시를 독립 확인합니다.', input: { rows }, bad: { observedAt: 0 }, steps: ['db_inspect', gate('백업 대상의 시점·범위 확인'), 'db_backup', review('백업 해시와 복원 대상 확인'), 'db_restore', parallel('복원본 전체 행·품질 검증', 'db_restore_check', 'db_quality'), gate('모든 복원 근거 통과')], acceptance: ['백업 파일 hash와 모든 등록 행의 hash를 별개로 계산합니다.', '일부 쿼리 성공을 전체 운영 DB 복구 보장으로 과장하지 않습니다.'] },
  { number: '085', slug: 'quality-correction-ledger', title: '데이터 규칙·정정·재검사 원장', purpose: '실제 음수 수량 검사를 수행하고 백업에 결합한 고정 정정문을 검토 후 적용하여 다시 조회합니다.', input: { rows: [{ id: 1, name: 'alpha', quantity: -3, updated: 1, held: false }], migration: 'correct_negative' }, bad: { rows: [{ id: 1, name: '', quantity: -3, updated: 1, held: false }] }, action: 'correct_negative', steps: ['db_inspect', 'db_quality', 'db_backup', 'db_plan', review('정정 대상과 불변 조건 검토'), 'db_apply', 'db_quality', gate('정정 후 모든 품질 규칙 충족'), 'db_verify'], acceptance: ['SELECT 규칙·UPDATE 정정·재조회로 실제 수정 효과를 확인합니다.', '수량만 고쳐서는 해결되지 않는 빈 이름 오류는 완료를 막습니다.'] },
  { number: '086', slug: 'least-privilege-regression', title: '상속 권한·최소 권한·허용 거부 회귀', purpose: '역할 상속을 펼쳐 effective permission을 계산하고 reader의 쓰기 권한 제거 뒤 허용/거부 조건을 재검사합니다.', input: {roles:{reader:{inherits:[],allow:['select','update']},writer:{inherits:['reader'],allow:['update']}}}, bad: { roles: { reader: { inherits: [], allow: ['select','update'] }, writer: { inherits: [], allow: [] } } }, action:'restrict_reader', steps: ['db_permissions', review('reader 최소 권한 조정 검토'), 'db_permissions_restrict', 'db_permissions', gate('읽기 허용·쓰기 거부 회귀 확인'), 'evidence_pin', 'evidence_revalidate'], acceptance: ['순환 상속·미등록 권한을 거절합니다.', '실제 회사 DB 역할 변경은 별도 회사 MCP 연결 대상입니다.'] },
  { number: '087', slug: 'archive-before-delete', title: '보존 예외·복원 확인 후 삭제', purpose: '보존 기한과 법적 보류 플래그로 대상을 선정하고 JSON 아카이브 왕복 검증 후 해당 행만 삭제합니다.', input: { rows, migration: 'archive_expired', expectedCount: 1 }, bad: { cutoff: 0 }, action: 'archive_expired', steps: ['db_inspect', 'db_backup', 'db_archive', gate('복원 가능한 아카이브 대상 존재'), 'db_plan', review('보류 제외 대상과 아카이브 승인'), 'db_apply', 'db_verify', gate('보류 행 유지·삭제 개수 확인'), 'db_quality'], acceptance: ['보류 행은 선택·삭제 대상에서 제외합니다.', '아카이브 hash와 복원 검증이 없으면 삭제하지 않습니다.'] },
  { number: '088', slug: 'replica-consistent-point', title: '동일 시점 복제 데이터 대조', purpose: '원본과 복제본의 적용 지점·지연·행별 해시를 비교해 같은 시점에서만 동등성을 판단합니다.', input: {}, bad: { replicaPoint: 9 }, steps: ['db_replication', gate('원본과 복제본이 동일 적용 시점'), 'db_inspect', parallel('복제 대상 품질과 조회 의미 확인', 'db_quality', 'db_query_compare'), gate('복제 활용 전 독립 검사 통과'), review('관측 시점과 차이 목록 검토')], acceptance: ['행 ID별 값 차이와 누락을 계산합니다.', '시점이 다른 두 결과의 비교를 정상 복제로 결론내리지 않습니다.'] },
  { number: '089', slug: 'capacity-forecast-quality', title: '관측 품질을 검사하는 용량 추세', purpose: '간격·결측·증가율·잔차·한계까지 여유를 계산하고 선형 가정에 따른 추정임을 기록합니다.', input: {}, bad: { capacitySeries: [[0, 10], [1, 12], [4, 18]] }, steps: ['db_capacity', gate('규칙적인 관측과 남은 용량 확인'), 'evidence_pin', review('추세 가정과 잔차 범위 검토'), 'evidence_revalidate'], acceptance: ['수치 회귀와 잔차 RMSE를 실제 계산합니다.', '불규칙 관측을 그대로 정밀한 예측으로 보고하지 않습니다.'] },
  { number: '090', slug: 'relational-synthetic-data', title: '참조 무결성을 갖춘 합성 시험 자료', purpose: '실사용자 자료 없이 합성 고객·주문을 생성하고 외래키 대응·분포·비밀 유입 여부를 검사합니다.', input: {}, bad: { capacityLimit: 10 }, steps: ['db_synthetic', parallel('합성 자료 활용 환경 독립 확인', 'db_permissions', 'db_capacity'), gate('격리 배포 대상의 접근·용량 조건'), review('합성 데이터와 생성 범위 검토'), 'evidence_pin', 'evidence_revalidate', 'db_quality'], acceptance: ['example.invalid 주소의 합성 자료만 생성하고 원본 기록을 사용하지 않습니다.', 'customerId와 분포를 실제 계산합니다.'] },
  { number: '091', slug: 'integrated-db-manager', title: '진단·성능·품질·권한·백업 통합 DB 관리', purpose: '기초 상태에서 성능·품질·권한을 독립 검사하고 백업·검토·변경·검증·격리 복구를 연결합니다.', input: { rows, migration: 'add_status' }, bad: { candidateMinimum: 999 }, action: 'add_status', steps: ['db_inspect', parallel('성능·품질·권한 동시 진단', 'db_query_compare', 'db_quality', 'db_permissions'), gate('독립 관리 검사 모두 통과'), 'db_backup', 'db_plan', review('DB 변경 대상과 복구 근거 검토'), 'db_apply', parallel('변경 후 상태와 품질 재확인', 'db_verify', 'db_quality'), gate('변경 효과를 독립 확인'), 'db_permissions'], acceptance: ['스키마 경로만 이름을 바꾸지 않고 성능·품질·권한을 실제 선행 검사합니다.', '변경·복구마다 원장에 버전과 근거를 기록합니다.'] },
  { number: '092', slug: 'evidence-code-db', title: '근거·실행 코드·승인 DB 변경의 의존 계약', purpose: '기술 근거의 버전 고정과 실행 코드 시험을 통과해야 DB 변경으로 넘어가며 근거 변경 시 통합 작업을 막습니다.', input: { ...code, rows, migration: 'add_status' }, badAction: 'keep_legacy', action: 'fix_average', steps: ['evidence_pin', 'code_inspect', 'code_patch', parallel('코드 회귀와 변이 시험', 'code_test', 'code_mutation'), gate('코드 검증이 DB 단계의 선행 조건'), 'evidence_revalidate', gate('기술 자료 변경 영향 없음'), 'db_inspect', 'db_backup', 'db_plan', review('검증한 코드·근거·DB 계획 통합 승인'), 'db_apply', 'db_verify', gate('DB 적용 검증'), 'code_build'], acceptance: ['코드 실패 시 DB backup/apply 단계가 실행되지 않습니다.', '기술 근거·후보 hash·시험 산출물·DB 변경 계획을 하나의 원장으로 연결합니다.'] },
  { number: '093', slug: 'changed-goal-invalidation', title: '목표 변경 영향과 산출물 재사용', purpose: '목표 버전·입력 해시·단계 의존성을 비교해 영향받은 결정·보고 단계만 재실행하고 합계·평균은 보존합니다.', input: { values: [2, 4, 6], previousGoal: { version: 1, threshold: 3 }, goal: { version: 2, threshold: 5 } }, bad: { priorArtifacts: { sum: 900, mean: 300, decision: true, report: 'stale' } }, steps: ['evidence_pin', 'lineage_plan', review('무효화 대상과 보존 산출물 검토'), 'lineage_execute', gate('보존 결과가 현재 입력과 일치'), 'lineage_verify', gate('독립 완료 조건과 실제 재실행 집합 일치'), 'evidence_revalidate'], acceptance: ['목표 변화가 없는 합계·평균은 재실행하지 않고 새 임계값의 결정·보고만 갱신합니다.', '낡은 보존 산출물의 값이 현재 입력과 다르면 완료를 차단합니다.'] },
  { number: '096', slug: 'step-dependency-repair', title: '실패 단계 수정과 후속 결과 무효화', purpose: '실패한 평균 단계부터 결정·보고까지 의존 폐쇄를 계산하고 정상 합계는 재사용하며 독립 검증합니다.', input: { values: [2, 4, 6], previousGoal: { version: 1, threshold: 3 }, goal: { version: 1, threshold: 3 }, failedStep: 'mean' }, bad: { priorArtifacts: { sum: 900, mean: 300, decision: true, report: 'stale' } }, steps: ['lineage_plan', 'evidence_pin', 'lineage_execute', gate('수정 단계의 실제 값 검사'), review('실패 단계와 후속 무효화 범위 검토'), 'lineage_verify', gate('의존 산출물 모두 재검증')], acceptance: ['숨은 사고 원문 대신 입력·중간 산출물·검증 근거·짧은 선택 설명을 기록합니다.', '실패 단계와 그 후속만 재실행하며 잘못된 상위 보존값은 독립검사에서 차단합니다.'] },
];

function dynamicIntegration(): WorkflowDesign {
  const prefix = 'c094';
  const capability = (role: 'knowledge'|'development'|'database', names: string[]): Definition => {
    const p = `${prefix}_${role}`, nodes: FlowNode[] = [node(`${p}_input`, 'input', '역할·목표·선행 산출물'), node(`${p}_agent`, 'agent', `${role} 전문 Agent`, { allowedTools: [], prompt: `COMPLETED_094_${role.toUpperCase()}: assignment 목표와 upstream 근거를 확인하고 {proceed:true,action:"${role === 'database' ? 'add_status' : 'fix_average'}",reason:"간단한 결정"} JSON으로 제한된 작업을 제안하세요. 도구의 계산 결과를 미리 만들지 마세요.`, format: 'JSON', inputBindings: { assignment: bind(`${p}_input`, 'assignment'), upstream: bind(`${p}_input`, 'artifacts') }, outputSchema: { type:'object', properties:{text:{type:'string'},data:{type:'object',properties:{proceed:{type:'boolean'},action:{type:'string'},reason:{type:'string'}},required:['proceed','action','reason'],additionalProperties:false}},required:['text','data'] } }), node(`${p}_merge`, 'merge', '입력과 실제 선행 근거 결합', { merge: { mode: 'object' }, inputBindings: { record: bind(`${p}_input`, 'assignment.input'), proposal: bind(`${p}_agent`), upstream: bind(`${p}_input`, 'artifacts') } })];
    const edges: Definition['edges'] = [{id:`${p}_e1`,source:`${p}_input`,target:`${p}_agent`},{id:`${p}_e2`,source:`${p}_agent`,target:`${p}_merge`},{id:`${p}_e3`,source:`${p}_input`,target:`${p}_merge`}];
    const decision = `${p}_decision`, pass = `${p}_permitted`, held = `${p}_held`;
    nodes.push(node(decision,'condition','역할 Agent가 허용한 작업인가',{predicate:{path:'record.proposal.proceed',operator:'eq',value:true},inputBindings:{record:bind(`${p}_merge`)}}),node(pass,'transform','허용된 역할 입력 전달',{transform:{mode:'pick',fields:{record:'record.record',proposal:'record.proposal',upstream:'record.upstream'}},inputBindings:{record:bind(decision,'record')}}),node(held,'output','역할 실행 보류',{inputBindings:{text:bind(decision,'record.proposal.reason'),data:bind(decision,'record')}}));
    edges.push({id:`${p}_decision_in`,source:`${p}_merge`,target:decision},{id:`${p}_allowed`,source:decision,target:pass,branch:'yes'},{id:`${p}_denied`,source:decision,target:held,branch:'no'});
    const roleAgent=nodes.find(n=>n.id===`${p}_agent`)!;
    roleAgent.inputBindings={assignment:bind(`${p}_input`,'assignment'),...(role==='development'?{sourceVersion:bind(`${p}_input`,'artifacts.knowledge.data.evidenceHash')}:role==='database'?{candidateHash:bind(`${p}_input`,'artifacts.development.data.candidateHash'),tested:bind(`${p}_input`,'artifacts.development.data.testEvidence.passed')}:{})};
    let previous = pass;
    for (const [i, name] of names.entries()) {
      if(name==='db_apply'){
        const review=`${p}_change_review`,accepted=`${p}_change_permitted`,rejected=`${p}_change_rejected`;
        nodes.push(node(review,'review','정확한 DB 변경 계획 승인',{review:{instructions:'시험한 후보 hash·기술 근거·백업 hash·고정 DB 변경 계획을 확인한 후 격리 DB 적용을 승인합니다.',allowEdit:false,timeoutMinutes:30},inputBindings:{record:bind(previous)}}),node(accepted,'transform','승인된 계획 전달',{transform:{mode:'pick',fields:{record:'record'}},inputBindings:{record:bind(review,'record')}}),node(rejected,'output','DB 적용 거절',{inputBindings:{text:bind(review,'record.planHash'),data:bind(review,'approved')}}));
        edges.push({id:`${review}_in`,source:previous,target:review},{id:`${review}_yes`,source:review,target:accepted,branch:'yes'},{id:`${review}_no`,source:review,target:rejected,branch:'no'});previous=accepted;
      }
      const next = `${p}_${i}_${name}`; nodes.push(operation(next, name, previous)); edges.push({id:`${p}_op${i}`,source:previous,target:next}); previous = next; if (['integration_contract','code_test'].includes(name)) { const gate = `${next}_gate`, hold = `${next}_hold`; nodes.push(node(gate,'condition','선행 계약을 실제 검사',{predicate:{path:'record.passed',operator:'eq',value:true},inputBindings:{record:bind(previous)}}),node(hold,'output','미충족 근거 전달',{inputBindings:{text:bind(gate,'record.evidence'),data:bind(gate,'record')}}));edges.push({id:`${gate}_in`,source:previous,target:gate},{id:`${gate}_no`,source:gate,target:hold,branch:'no'}); const passthrough=`${next}_pass`;nodes.push(node(passthrough,'transform','검증된 계약 전달',{transform:{mode:'pick',fields:{record:'record'}},inputBindings:{record:bind(gate,'record')}}));edges.push({id:`${gate}_yes`,source:gate,target:passthrough,branch:'yes'});previous=passthrough; } }
    const out = `${p}_out`; nodes.push(node(out,'output','등록 작업과 검증 근거',{inputBindings:{text:bind(previous,'text'),data:bind(previous)}}));edges.push({id:`${p}_outedge`,source:previous,target:out});
    return definition(nodes,edges);
  };
  const knowledge = capability('knowledge',['evidence_pin','rag_lifecycle','rag_incremental','rag_query']);
  const development = capability('development',['integration_contract','code_inspect','code_patch','code_test','evidence_revalidate','code_build']);
  const database = capability('database',['integration_contract','db_inspect','db_backup','db_plan','db_apply','db_verify']);
  const tasks = [{id:'knowledge_template',name:'기술 근거 관리',definition:knowledge},{id:'development_template',name:'실제 코드 구현·시험',definition:development},{id:'database_template',name:'격리 DB 변경·검증',definition:database}];
  const plan = [{id:'knowledge',templateId:'knowledge_template',role:'근거 관리',goal:'자료 세대와 출처를 확인',input:{role:'knowledge'},dependsOn:[]},{id:'development',templateId:'development_template',role:'구현과 시험',goal:'고정된 근거에 맞는 코드 검증',input:{role:'development',project:'registered-average'},dependsOn:['knowledge']},{id:'database',templateId:'database_template',role:'DB 통합',goal:'시험된 후보 이후 격리 DB 검증',input:{role:'database',migration:'add_status'},dependsOn:['development']}];
  const nodes = [node('c094_input','input','지식·개발·DB 통합 목표'),node('c094_spawn','orchestrator','등록된 기능으로 필요한 역할 생성',{prompt:'COMPLETED_094_PLAN: 기술 지식→개발→DB 의존 관계로 knowledge/development/database ID의 세 역할을 생성하세요. 등록된 각 templateId와 role 입력을 사용합니다. 각 하위 작업의 실제 산출물이 완료 조건을 통과해야 합니다.',orchestration:{mode:'dynamic',maxTasks:3,tasks,dynamic:{maxAgents:3,concurrency:2,templates:tasks.map((task,i)=>({taskId:task.id,agentNodeId:`c094_${['knowledge','development','database'][i]}_agent`,inputSchema:{type:'object',properties:{role:{type:'string'},project:{type:'string'},migration:{type:'string'}},required:['role'],additionalProperties:false}}))},completion:[{path:'summary.completedCount',operator:'eq',value:3},{path:'artifacts.development.data.passed',operator:'eq',value:true},{path:'artifacts.database.data.passed',operator:'eq',value:true}]} }),node('c094_review','review','완료 조건과 기술·DB 결과 검토',{review:{instructions:'생성된 역할 계약·실제 시험 결과·DB 버전을 검토합니다.',allowEdit:false,timeoutMinutes:30}}),node('c094_output','output','동적 통합 실행 결과')];
  nodes.push(node('c094_rejected','output','검토 거절로 통합 완료 보류',{inputBindings:{text:bind('c094_review','text')}}));
  const edges: Definition['edges'] = [{id:'c094_e1',source:'c094_input',target:'c094_spawn'},{id:'c094_e2',source:'c094_spawn',target:'c094_review'},{id:'c094_e3',source:'c094_review',target:'c094_output',branch:'yes'},{id:'c094_e4',source:'c094_review',target:'c094_rejected',branch:'no'}];
  const replies = [{match:'COMPLETED_094_PLAN:',text:JSON.stringify({agents:plan})},...['knowledge','development','database'].map(role=>({match:`COMPLETED_094_${role.toUpperCase()}:`,text:JSON.stringify({proceed:true,action:role==='database'?'add_status':'fix_average',reason:'등록 역할에서 근거를 계산합니다.'})}))];
  return {id:'completed-094-dynamic-integrated-company',title:'094 · 동적 역할 생성과 지식·개발·DB 계약',category:'등록 작업 기반 완성 예제',description:'Agent가 등록된 세 기능에서 역할을 생성하며 실제 근거 고정·Python 시험·SQLite 변경의 의존 산출물 계약을 확인합니다.',behavior:'동적 계획→지식 세대·출처→의존 개발 Agent와 실제 시험→의존 DB Agent와 변경 검증→독립 완료 조건→검토',definition:definition(nodes,edges),resources:[],inputExample:'기술 지식 근거로 평균 기능을 수정하고 격리 DB 스키마를 검증하세요.',expectedOutput:'세 역할과 실제 시험·DB 검증 근거',acceptance:['임의 역할 템플릿·권한·코드를 추가할 수 없습니다.','개발 작업은 고정 근거, DB 작업은 실제 통과 시험과 후보 hash를 요구합니다.','생성 계획과 자식 입력·정의 hash는 기존 지속 실행 엔진이 보존합니다.'],failureCases:['순환 또는 허용되지 않은 역할 계획은 거절합니다.','코드 시험 미통과 시 DB 변경 완료 조건이 성립하지 않습니다.'],scenarios:[{name:'동적 세 역할의 실제 근거·코드·DB 계약을 실행하고 재개',input:'통합 목표',status:'succeeded',review:'accept',modelReplies:replies,contains:['database'],resumeAgain:true},{name:'생성 역할의 순환 의존은 실행 전에 거절',input:'통합 목표',status:'failed',modelReplies:[{match:'COMPLETED_094_PLAN:',text:JSON.stringify({agents:plan.map(p=>p.id==='knowledge'?{...p,dependsOn:['database']}:p)})}],completedCounts:{c094_knowledge_agent:0}},{name:'개발 후보가 시험에 실패하면 DB 실제 변경을 막음',input:'통합 목표',status:'failed',modelReplies:replies.map(r=>r.match==='COMPLETED_094_DEVELOPMENT:'?{...r,text:JSON.stringify({proceed:true,action:'keep_legacy',reason:'부정 경계 검증'})}:r),completedCounts:{c094_database_4_db_apply:0}},{name:'정확한 DB 계획 승인을 거절하면 적용하지 않고 통합 완료를 차단',input:'통합 목표',status:'failed',review:'reject',modelReplies:replies,completedCounts:{c094_database_4_db_apply:0}},{name:'역할 Agent의 보류 판단은 해당 역할과 후속 DB 변경을 차단',input:'통합 목표',status:'failed',modelReplies:replies.filter(r=>r.match!=='COMPLETED_094_DATABASE:').map(r=>r.match==='COMPLETED_094_DEVELOPMENT:'?{...r,text:JSON.stringify({proceed:false,action:'fix_average',reason:'근거 보완 필요'})}:r),completedCounts:{c094_development_2_code_patch:0,c094_database_4_db_apply:0}}]};
}

function sharedBoard(): WorkflowDesign {
  const base = buildCompletion({number:'100',slug:'persistent-claimed-board',title:'공유 보드의 역할 선택·선점·독립 검증',purpose:'저장된 보드 revision과 선행 산출물을 Agent가 읽고 분석 또는 독립 검증 역할을 선택한 뒤 실제 계산과 결과만 조건부 갱신합니다. 한 실행은 한 역할을 수행하고 다음 실행은 보존한 보드에서 이어갑니다.',input:{expectedRevision:0,values:[2,4,6]},bad:{expectedRevision:7},action:'analysis',steps:['board_claim',gate('현재 revision과 미선점 작업 확인'),'board_work','board_commit',gate('소유자·입력·계산 결과 검증')],acceptance:['보드 쓰기는 저장소의 expectedRevision 조건부 갱신을 사용합니다.','Agent가 현재 보드의 analysis/verification 역할을 선택하며 검증 역할은 완료된 분석 산출물의 hash·revision을 요구합니다.','선점 완료 작업은 재실행하지 않고 stale writer는 보류됩니다.']});
  const nodes=base.definition.nodes,edges=base.definition.edges;
  const read=node('c100_board_read','memory','지속 보드 최신 revision 읽기',{memory:{action:'read',key:'completed_100_board',scope:'workflow',defaultValue:{revision:0,tasks:{analysis:{status:'pending'},verification:{status:'pending'}},artifacts:{}}},inputBindings:{}});
  const agent=nodes.find(n=>n.type==='agent')!,agentInput=edges.find(e=>e.target===agent.id)!;
  edges.splice(edges.indexOf(agentInput),1);
  edges.push({...agentInput,target:read.id},{id:'c100_board_agent',source:read.id,target:agent.id},{...agentInput,id:'c100_request_agent'});
  agent.inputBindings={...agent.inputBindings,board:bind(read.id)};
  agent.prompt='COMPLETED_100_PLAN: 현재 board를 먼저 확인하세요. analysis가 pending이면 action:"analysis", analysis가 completed이고 verification이 pending이면 action:"verification"을 선택하세요. 모든 역할이 완료됐거나 권한이 없으면 proceed:false입니다. {proceed:boolean,action:string,reason:string} JSON만 반환하세요. 실제 계산·검증·CAS는 등록 프로그램이 수행합니다.';
  const proposal=nodes.find(n=>n.type==='merge')!;
  proposal.inputBindings!.board=bind(read.id);
  nodes.push(read);edges.push({id:'c100_board_proposal',source:read.id,target:proposal.id});
  for(const [op,name] of [['board_work','claim'],['final_verify','commit']] as const){
    const target=nodes.find(n=>n.program?.arguments.operation===`operations.${op}`)!;
    const sourceBinding=target.inputBindings!.arguments,incomingEdge=edges.find(e=>e.target===target.id)!;
    edges.splice(edges.indexOf(incomingEdge),1);
    const write=node(`c100_${name}_write`,'memory',name==='claim'?'작업 선점 CAS 저장':'검증 산출물 CAS 저장',{memory:{action:'write',key:'completed_100_board',scope:'workflow',expectedRevisionPath:'expected',valuePath:'value'},inputBindings:{value:bind(sourceBinding.nodeId,`${sourceBinding.path}.board`),expected:bind(sourceBinding.nodeId,`${sourceBinding.path}.expectedRevision`)}});
    const restore=node(`c100_${name}_context`,'merge','저장된 버전과 작업 근거 전달',{merge:{mode:'object'},inputBindings:{record:sourceBinding,stored:bind(write.id)}});
    nodes.push(write,restore);edges.push({...incomingEdge,target:write.id},{id:`c100_${name}_saved`,source:write.id,target:restore.id},{...incomingEdge,id:`c100_${name}_context_source`,target:restore.id},{id:`c100_${name}_next`,source:restore.id,target:target.id});target.inputBindings={arguments:bind(restore.id)};
  }
  base.definition=layoutWorkflow(base.definition);
  base.scenarios[0].stateGroup='shared-board';
  base.scenarios.push({...base.scenarios[0],name:'다음 실행의 Agent가 보존된 분석 산출물을 읽어 독립 검증 역할을 선택',input:JSON.stringify({expectedRevision:2,values:[2,4,6]}),modelReplies:[{match:'COMPLETED_100_PLAN:',text:JSON.stringify({proceed:true,action:'verification',reason:'분석 완료 산출물을 독립 검증'})}],outputs:{c100_board_read:{found:true}}});
  base.scenarios.push({...base.scenarios[1],name:'선행 분석 없이 검증 역할을 먼저 선택하면 선점을 거절',input:base.inputExample,modelReplies:[{match:'COMPLETED_100_PLAN:',text:JSON.stringify({proceed:true,action:'verification',reason:'선행 조건 부정 검사'})}]});
  base.scenarios.push({...base.scenarios[1],name:'다음 프로세스에서 이전 revision으로 선점하면 완료 보드를 덮어쓰지 않음',input:base.inputExample,stateGroup:'shared-board',outputs:{c100_board_read:{found:true}}});
  return base;
}

function withFailureRecovery(design:WorkflowDesign):WorkflowDesign {
  if(!['083','091','092'].includes(design.id.slice(10,13)))return design;
  const number=design.id.slice(10,13),nodes=design.definition.nodes,edges=design.definition.edges;
  const targetTitle=number==='083'?'적용 후 스키마와 무결성 확인':number==='091'?'변경 효과를 독립 확인':'DB 적용 검증';
  const source=nodes.find(n=>n.type==='condition'&&n.title===targetTitle)!;
  const failedEdge=edges.find(e=>e.source===source.id&&e.branch==='no')!;
  const heldTarget=failedEdge.target;
  const reviewId=`c${number}_recovery_review`,restoreId=`c${number}_restore`,verifyId=`c${number}_restore_verify`,gateId=`c${number}_restore_gate`,messageId=`c${number}_recovered`,outId=`c${number}_recovered_output`;
  failedEdge.target=reviewId;
  nodes.push(node(reviewId,'review','실패한 변경을 고정 백업으로 복구할지 검토',{review:{instructions:'원래 변경 검증은 실패했습니다. 기록된 백업 hash와 전체 행 hash를 확인한 뒤 격리 복구를 승인합니다.',allowEdit:false,timeoutMinutes:30},inputBindings:{record:bind(source.id,'record')}}),operation(restoreId,'db_restore',reviewId,'record'),operation(verifyId,'db_restore_check',restoreId),node(gateId,'condition','복구된 전체 행과 원래 백업 hash 대조',{predicate:{path:'record.passed',operator:'eq',value:true},inputBindings:{record:bind(verifyId)}}),node(messageId,'transform','복구와 목표 완료를 구분',{inputBindings:{},transform:{mode:'template',template:'recovered / originalGoalComplete:false / 전체 백업 행 검증 완료'}}),node(outId,'output','실패·복구 보고',{inputBindings:{text:bind(messageId,'text'),data:bind(gateId,'record')}}));
  edges.push({id:`${reviewId}_no`,source:reviewId,target:heldTarget,branch:'no'},{id:`${reviewId}_yes`,source:reviewId,target:restoreId,branch:'yes'},{id:`${restoreId}_verify`,source:restoreId,target:verifyId},{id:`${verifyId}_gate`,source:verifyId,target:gateId},{id:`${gateId}_no`,source:gateId,target:heldTarget,branch:'no'},{id:`${gateId}_yes`,source:gateId,target:messageId,branch:'yes'},{id:`${messageId}_out`,source:messageId,target:outId},{id:`${gateId}_out`,source:gateId,target:outId,branch:'yes'});
  const normal=design.scenarios[0];
  design.scenarios.push({...normal,name:'적용 후 행 수 검증 실패는 별도 검토 후 실제 백업 복구·독립 검증',input:JSON.stringify({...JSON.parse(normal.input),expectedCount:2}),contains:['recovered','originalGoalComplete:false'],visited:[restoreId,verifyId,outId],skipped:normal.visited,resumeAgain:true});
  // Recovery is a separately reviewable reusable subworkflow, preserving the
  // editor's 40-node limit and its independent failure/decision boundaries.
  const heldOut=edges.find(e=>e.source===heldTarget)!.target;
  const nestedIds=new Set([reviewId,restoreId,verifyId,gateId,messageId,outId,heldTarget,heldOut]);
  const nestedNodes=nodes.filter(n=>nestedIds.has(n.id));
  const nestedEdges=edges.filter(e=>nestedIds.has(e.source)&&nestedIds.has(e.target));
  const recoveryInput=`c${number}_recovery_input`,recovery=`c${number}_recovery`,recoveryOutput=`c${number}_recovery_result`;
  nestedNodes.push(node(recoveryInput,'input','실패한 변경과 고정 백업'));
  nestedNodes.find(n=>n.id===reviewId)!.inputBindings={record:bind(recoveryInput,'record')};
  nestedEdges.push({id:`${recoveryInput}_review`,source:recoveryInput,target:reviewId});
  design.definition={...design.definition,nodes:[...nodes.filter(n=>!nestedIds.has(n.id)),node(recovery,'subworkflow','검토·복구·독립 검증 하위 작업',{subworkflow:{definition:definition(nestedNodes,nestedEdges)},inputBindings:{record:bind(source.id,'record')}}),node(recoveryOutput,'output','복구 보고',{inputBindings:{text:bind(recovery,'text')}})],edges:[...edges.filter(e=>!nestedIds.has(e.source)&&!nestedIds.has(e.target)),{id:`${source.id}_recovery`,source:source.id,target:recovery,branch:'no'},{id:`${recovery}_output`,source:recovery,target:recoveryOutput}]};
  design.definition=layoutWorkflow(design.definition);
  design.acceptance.push('적용 후 검사 실패 분기에서 별도 복구 검토→실제 백업 복원→전체 행 hash 재검증을 수행하며 원래 목표 미완료를 보고합니다.');
  return design;
}

function explicitLineageBranches(design:WorkflowDesign):WorkflowDesign {
  const number=design.id.slice(10,13);if(!['093','096'].includes(number))return design;
  const target=design.definition.nodes.find(n=>n.program?.arguments.operation==='operations.lineage_execute')!;
  const p=`c${number}_lineage`,nodes=[node(`${p}_input`,'input','목표·입력·무효화 계획')],edges:Definition['edges']=[];
  let previous=`${p}_input`,path='record';
  for(const step of ['sum','mean','decision','report']){
    const check=`${p}_${step}_changed`,execute=`${p}_${step}_execute`,reuse=`${p}_${step}_reuse`,join=`${p}_${step}_join`;
    nodes.push(node(check,'condition',`${step} 산출물이 무효화됐는가`,{predicate:{path:`record.lineage.changed.${step}`,operator:'eq',value:true},inputBindings:{record:bind(previous,path)}}),operation(execute,`lineage_execute_${step}`,check,'record'),operation(reuse,`lineage_reuse_${step}`,check,'record'),node(join,'merge','선택된 단계 산출물 전달',{merge:{mode:'object'},inputBindings:{executed:bind(execute),reused:bind(reuse)}}));
    edges.push({id:`${check}_in`,source:previous,target:check},{id:`${check}_yes`,source:check,target:execute,branch:'yes'},{id:`${check}_no`,source:check,target:reuse,branch:'no'},{id:`${execute}_join`,source:execute,target:join},{id:`${reuse}_join`,source:reuse,target:join});
    // Normalize the active branch so later conditions inspect one explicit path.
    const normalized=`${p}_${step}_state`;nodes.push(operation(normalized,'lineage_snapshot',join));edges.push({id:`${join}_state`,source:join,target:normalized});
    previous=normalized;path='data';
  }
  const output=`${p}_output`;nodes.push(node(output,'output','갱신·보존한 산출물과 버전',{inputBindings:{text:bind(previous,'text'),data:bind(previous)}}));edges.push({id:`${output}_edge`,source:previous,target:output});
  target.type='subworkflow';target.subworkflow={definition:definition(nodes,edges)};delete target.program;target.inputBindings={record:target.inputBindings!.arguments};
  design.definition=layoutWorkflow(design.definition);
  design.acceptance.push('의존 단계별 변경/보존 조건 분기가 캔버스에 표시되며 실제 해당 실행 노드만 활성화됩니다.');
  design.scenarios[0].visited=[...(design.scenarios[0].visited??[]),`${p}_decision_execute`,`${p}_report_execute`,`${p}_sum_reuse`];
  design.scenarios[0].skipped=[`${p}_sum_execute`,...(number==='093'?[`${p}_mean_execute`]:[])];
  return design;
}

export const completion069To100Designs: WorkflowDesign[] = [...specs.map(spec=>explicitLineageBranches(withFailureRecovery(buildCompletion(spec)))),dynamicIntegration(),sharedBoard(),allBlocksCompletion];
export const completion069To100Specs = specs;



