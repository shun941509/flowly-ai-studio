# 추가 노드 v4 구현 계약

기존 v1~v3 정의를 읽고 v4로 명시적으로 변환한다. 웹은 설계·미리보기·내보내기만 수행하고 모델 키를 취급하지 않는다. 아래 기능은 Node.js 및 Python 내보내기에서 동일하게 실행한다.

## 정의

- `CompositeTask = { id: string, name: string, definition: Definition }`. 각 정의는 입력 1개와 출력 1개 이상의 DAG다. 작업 ID는 안전한 ASCII 식별자다. 중첩 깊이 최대 3, 전체 노드 최대 120, 개별 그래프 40개. 작업 목록 1~8개.
- 전체 내보내기에 포함되는 자료·서비스 연결은 각각 최대 100개다. 중첩 정의의 참조를 합산해 웹 사전 점검·서버·Node/Python 실행기에서 같은 한도를 적용한다.
- `parallel: { tasks: CompositeTask[], concurrency: number }`: 동시 작업 1~4개. 동일한 매핑 입력을 독립 작업에 전달하고 모든 결과를 순서대로 모은다.
- `team: { tasks: CompositeTask[], mode: "sequential" | "parallel", concurrency: number }`: 역할별 작업. 각 작업은 agent 노드를 포함한다. 순차 모드는 다음 역할의 입력에 `previous`(직전 출력), `results`(누적 출력 배열)를 추가한다. 첫 역할과 병렬 역할에는 `previous:null`, `results:[]`를 제공한다. 병렬은 동일 입력으로 독립 실행한다.
- `orchestration: { tasks: CompositeTask[], maxTasks: number }`: `orchestrator` 노드의 prompt와 현재 입력으로 모델이 `{ "tasks": ["task_id", ...] }`를 한 번 선택한다. 1~maxTasks, 중복·미등록 ID 금지. 계획을 저장하고 선택한 작업만 순서대로 실행한다. 임의 코드·새 도구·무제한 재계획은 허용하지 않는다.
- `subworkflow: { definition: Definition }`: 저장 당시 정의 복사본 실행. 원본 변경은 자동 반영하지 않는다.
- `loop: { definition: Definition, itemsPath: string, maxItems: number, concurrency: number }`: 입력 경로의 배열에 대해 `{ ...input, item, index }`를 전달한다. 최대 항목 수 1~20. 초과하면 자르지 않고 실패. 빈 배열은 빈 결과로 성공.
- `review: { instructions: string, allowEdit: boolean, timeoutMinutes: number }`: 1~1440분. 입력 해시·실행·사용자·노드에 결합한 검토 요청을 지속 저장하고 `waiting_review` 상태로 중단한다. accept/reject 후 resume. 편집은 allowEdit일 때 입력 JSON 객체 교체만 허용. 출력은 `{ ...검토한입력, approved: boolean }`; `yes`/`no` 연결 필수. 외부 변경 승인을 대체하지 않는다.
- `classification: { labels: { id: string, name: string, description: string }[] }`: 2~8개. classify 노드 prompt와 입력으로 모델이 `{ "label": "id", "reason": "짧은 설명" }`를 반환한다. 등록 ID만 허용. 출력 `{ ...input, label, reason }`, 해당 ID 연결만 활성화.
- `form: { fields: { key: string, label: string, type: "text" | "number" | "boolean" | "date" | "select", required: boolean, options?: string[] }[] }`: 1~20개. input을 대신하는 시작 노드. CLI --input/--input-file의 JSON 객체를 검증. 미등록 필드·잘못된 날짜·자료형·선택값 거부. 출력 `{ text: JSON문자열, data: 객체 }`. 파일 바이너리 업로드는 지원하지 않는다.
- `memory: { action: "read" | "write" | "delete", key: string, valuePath?: string, defaultValue?: Json }`: 소유자+워크플로 범위의 로컬 상태 디렉터리 저장. write의 valuePath 필수. 출력 `{ ...input, data: 값 또는 null, found: boolean }`. 실행/노드별 작업 ID로 재개 시 결과를 재사용. 저장 어댑터 없으면 미설정 실패.
- `error: { template: string }`: 오류 처리 노드. 입력 error(객체)와 text 등을 템플릿 치환한 `{ ...input, text }`. 기본 템플릿 `작업을 완료하지 못했어요: {{error.message}}`.
- 모든 일반 처리 노드의 `onError?: "stop" | "branch"`. branch일 때 success/error 연결 필수, 정상 출력은 success, 복구 가능한 노드 처리 실패는 `{ text: "", error: { message, nodeId } }`를 error로 전달. 권한·저장·취소·한도·승인 만료·불명확한 쓰기 결과는 오류 분기로 우회하지 않는다.

## 실행·출력 계약

`FlowEdge.branch`는 안전한 문자열 ID. condition/review는 yes/no, classify는 labels.id, onError=branch는 success/error. 다른 노드는 라벨 없음. `checkpoint.routes`에 문자열 분기 저장, 기존 boolean branches 호환. 입력 매핑은 활성 연결만 반영한다.

묶음 노드 결과는 `{ text: 결과 text를 줄바꿈으로 연결, results: [{taskId, output}], count }`. subworkflow는 마지막 활성 output 노드의 전체 출력을 반환한다. loop taskId는 문자열 index. 하위 입력 노드는 JSON 문자열로 축소하지 않고 `initialInput` 객체를 전달한다.

`checkpoint.groups[nodeId] = { children: RuntimeRun[], taskIds: string[], plan?: string[], accounted?: {turns,toolCalls,tokens} }`. 하위 실행 ID·한도·입력·계획은 시작 전에 저장한다. 동시 실행은 별도 하위 체크포인트, 부모 저장 직렬화. 부모 남은 호출/토큰 한도를 하위에 보수적으로 나누어 초과 예약을 막는다. 부모 취소·권한 재검사를 하위에도 적용한다. 승인·검토는 하위 실행을 재귀적으로 찾아서 처리하고 공개 상태에 함께 표시한다. 완료된 하위 실행을 재생하지 않는다.

`RuntimeRun.initialInput?: Record<string,Json>`; `RuntimeRun.reviews?: Review[]`; Review 필드는 id,runId,nodeId,userId,inputHash,input,expiresAt,status(pending/accepted/rejected),output?,decidedAt?. pending 검토 시간은 activeMs에 포함하지 않는다.

`input`, `review`, `classify`, `memory`의 기본 출력 스키마는 객체다. 하위 입력을 구조화된 객체 그대로 보존하기 위해 text를 강제하지 않는다. 사용자가 명시한 입력·출력 스키마는 계속 검증한다. 복구 가능한 처리 오류만 `errorRecoverable:true`로 저장하며 권한·저장·불명확한 쓰기 결과는 포함하지 않는다. 완료·취소·실패한 부모 실행을 오래된 승인/검토 결정으로 재활성화하지 않는다.

CLI `accept RUN REVIEW [--edited-input-file path]`, `reject RUN REVIEW`는 결정만 저장하고 `resume RUN`으로 계속한다. status/report에 하위 작업 및 검토 내역을 표시한다. .env 없는 비모델 흐름 실행 유지. 모델 필요 여부·도구 선택·자료 권한 검사·키 제거는 중첩 정의 전체를 검사한다.
