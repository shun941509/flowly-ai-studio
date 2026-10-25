# 내보낸 프로젝트의 로컬 운영

웹은 모델을 호출하지 않습니다. 이 문서의 도구는 내려받은 폴더에서 사용자가 직접 실행합니다. Python 3.11 이상이 필요하며, Node 프로젝트는 Node.js 실행기도 필요합니다. 직접 실행할 때는 START_HERE.md의 명령을 따릅니다. Agent 다운로드는 Agent 전용 진입점을, 일반 실행 프로젝트는 기본 실행기를 사용합니다. 운영 화면·작업 처리기·자동 시작 도우미도 같은 진입점을 선택하며 Agent 구성이 변경되면 중단합니다.

`flowly_ops.py`는 운영 상태를 `.flowly-ops/operations.sqlite`에, 각 프로필의 실행 상태를 `.flowly-profiles/<프로필>/runs`에 저장합니다. 외부 제공자 자격 증명은 사용자가 지정한 `.env`에서만 읽습니다. 부모 프로세스의 API 키 환경 변수는 실행기에 상속하지 않습니다. 프로젝트 폴더와 하위 폴더는 신뢰하는 사용자만 수정할 수 있게 관리하세요.

## 실행 방법

요청 JSON을 `operation.json`에 저장합니다. 요청 파일은 프로젝트 내부의 상대 경로이며 1MB 이하여야 합니다.

```powershell
python flowly_ops.py request --root . --request-file operation.json
python flowly_ops.py worker --root . --once
python flowly_local.py --root .
```

마지막 명령은 별도로 제공되는 로컬 관리 화면입니다. `worker --once`는 대기 작업 하나를 처리하고 종료합니다. `--once`를 생략한 worker는 명시적으로 중지할 때까지 대기열을 처리합니다. 결과는 표준출력 JSON 한 개로 반환합니다. 요청은 표준입력 JSON으로도 전달할 수 있습니다.

## 프로필과 지속 대기열

기본 프로필은 `development`, 환경 파일은 `.env`입니다. 환경 파일 내용은 관리 화면이나 프로필 목록에 표시하지 않습니다.

```json
{"action":"profiles.set","name":"production","env":".env.production","production":true,"confirmProduction":true}
```

프로필의 상태 경로는 자동으로 격리됩니다. `production` 프로필의 실행·재개·승인·평가·프로브 요청에는 `confirmProduction:true`가 필요합니다. 대기 또는 실행 중인 작업이 있으면 프로필을 바꿀 수 없습니다.

```json
{"action":"jobs.enqueue","profile":"development","input":"확인할 내용","priority":0}
```

대기열은 우선순위가 높은 작업부터, 같은 우선순위에서는 접수 순서대로 실행합니다. 입력 우선순위 범위는 -100~100이며, 오래 기다린 작업에는 5분마다 1점을 더합니다(최대 유효 우선순위 200). 낮은 우선순위가 계속 밀리는 것을 방지합니다. 프로젝트마다 worker 하나만 허용하며, 노드 안의 병렬 처리는 실행기의 최대 4개 하위 작업 한도를 따릅니다. 입력은 제한된 임시 파일로 전달하고 처리 후 제거합니다.

```json
{"action":"jobs.list"}
{"action":"jobs.cancel","jobId":"목록에서 받은 작업 ID"}
{"action":"runs.list","profile":"development"}
{"action":"runs.status","profile":"development","runId":"실행 ID"}
{"action":"runs.decision","profile":"development","runId":"실행 ID","decision":"approve","decisionId":"승인 ID"}
{"action":"runs.resume","profile":"development","runId":"실행 ID"}
```

결정은 `approve`, `deny`, `accept`, `reject` 중 하나입니다. 수정 가능한 검토를 수락할 때는 `editedInput` 객체를 추가할 수 있습니다. 결정은 저장만 하며, 명시적인 재개 요청 후 worker를 실행해야 이어집니다. 재개 요청은 실행 기록의 `queued` 상태에만 허용합니다. 실행기가 중간 저장 지점에서 `queued`를 반환하면 대기열 작업은 `paused`로 표시하여 자동 반복하지 않습니다. 새 실행에 저장된 모델명과 임베딩 모델명을 재개 시 확인하므로 모델 설정이 바뀌면 원래 설정을 복구하거나 새 실행을 시작해야 합니다. 같은 모델의 키 교체는 허용합니다.

취소는 실행기의 안전 지점과 HTTP 중단 신호로 전달합니다. 외부 변경을 이미 보내던 중 취소되거나 프로세스가 강제 종료되면 `unknown_outcome`을 유지합니다. 외부 서비스에서 결과를 확인하기 전에는 자동 재시도하지 않습니다. 모델·도구 제한 시간과 승인 정책은 원래 실행기가 계속 적용합니다.

## 오프라인 점검과 실제 연결 점검

```json
{"action":"check","profile":"development"}
{"action":"probe","profile":"development","target":"all","confirm":true}
```

`check`는 네트워크를 호출하지 않습니다. `probe`는 사용자가 명시적으로 요청할 때 실제 네트워크를 호출하며 모델 사용료가 발생할 수 있습니다. `target`은 `openai`, `embeddings`, `mcp`, `all`입니다.

- OpenAI: 고정된 Responses 주소로 출력 한도 16토큰의 최소 요청 한 번을 보냅니다. 모델 응답 본문은 반환하거나 저장하지 않습니다.
- 임베딩: `embeddings`를 지정하거나 `all` 점검 대상에 벡터 검색 블록이 있으면 고정된 Embeddings 주소로 작은 입력 한 번을 보냅니다. 중첩 워크플로의 검색 블록도 포함하며 여러 블록이 있어도 점검 호출은 한 번입니다. 실제 모델명·벡터 순서·유한한 숫자 벡터·0이 아닌 크기·사용 토큰을 확인합니다. 벡터 원문은 반환하거나 저장하지 않습니다. `OPENAI_API_KEY`만 필요하며 답변용 `FLOWLY_MODEL`은 요구하지 않습니다. `FLOWLY_EMBEDDING_MODEL`을 생략하면 실행기와 동일하게 `text-embedding-3-small`을 사용하고 `modelSource:default`로 표시합니다. 빈 모델값이나 키 누락은 `unconfigured`와 `missingEnv`로 표시합니다.
- MCP: 패키지에 포함된 본인 소유의 승인된 HTTPS 443 연결에 초기 협상, 초기화 알림, 도구 목록 조회를 수행합니다. 선택한 도구의 입력 스키마와 읽기 전용 표시를 비교합니다. 도구 실행(`tools/call`)은 하지 않습니다. 목록 페이지는 최대 10개입니다.
- `remoteCalls`에는 종류별 전송 시도 수가 표시됩니다. 통신 실패도 시도 수에 포함됩니다. 자격 증명이나 원격 오류 본문을 출력하지 않습니다. `connected`는 이 제한된 점검만 성공했다는 뜻이며 전체 워크플로의 정확성이나 외부 쓰기 권한을 보장하지 않습니다.

## 평가 자료와 버전 비교

평가 자료는 프로젝트 내부 JSON 파일입니다. 최대 100개 사례를 순차 실행하며 자동 승인하지 않습니다. 모델이 있는 흐름은 실제 모델을 호출하므로 사용자 환경 설정이 필요합니다.

```json
{"cases":[
  {"id":"greeting","input":"안녕하세요","contains":["안녕"]},
  {"id":"exact","input":"확인","expected":"확인"}
]}
```

```json
{"action":"evaluate","profile":"development","dataset":"cases.json"}
{"action":"compare","evaluationId":"이번 평가의 id","baselineId":"이전 평가의 id"}
{"action":"compare","evaluationId":"이번 평가의 id","baselineFile":"previous-evaluation.json"}
```

평가 반환의 `id`를 비교 요청의 `evaluationId`로 사용합니다. 저장된 `.flowly-ops/evaluations/<id>.json`을 다른 버전 프로젝트로 복사하면 `baselineFile`로 비교할 수 있습니다. 결과에는 사례별 상태·실행 ID·통과 여부·사용량·고정 모델명·수동 비용 추정을 보관하며 입력·정답·모델 원문을 다시 복사하지 않습니다. 모델 결과 자체는 원래 실행 기록에 남습니다. 합계에는 실행/실패 수, 통과율/실패율, 총 토큰, 실제 활성 시간 합계와 설정된 단가의 비용 범위가 포함됩니다. 비교에는 품질·실패율·토큰·시간의 차이와 동일 통화의 완전한 비용 추정이 있는 경우 비용 차이가 포함됩니다. 단가가 없거나 모델이 혼합되어 있으면 비용 미설정 또는 일부 추정으로 표시하고 차액을 만들지 않습니다. 승인·검토·불명확 상태를 만나면 평가는 `blocked`로 멈춥니다. 다른 대기 작업이 있으면 먼저 처리해야 합니다. 비교는 같은 사례 ID의 통과 여부를 대조하며 `expected` 일치 또는 `contains` 포함 검사 범위의 회귀 검사입니다.

## 수동 단가와 청구 CSV

공식 최신 가격이나 계정 청구를 자동 조회하지 않습니다. 사용자가 직접 단가와 기준일을 등록합니다.

```json
{"action":"prices.set","model":"사용하는-모델-ID","inputPerMillion":1,"outputPerMillion":3,"currency":"USD","asOf":"2026-10-22"}
{"action":"prices.estimate","profile":"development","runId":"실행 ID"}
```

실행 당시 고정한 모델명을 우선 사용합니다. 입력·출력 토큰 비율을 따로 저장하지 않으므로 전체 토큰에 입력/출력 단가를 각각 적용한 최소~최대 범위만 제공합니다. 실제 청구액이 아닙니다. 임베딩과 답변 모델을 함께 사용한 실행은 토큰별 모델 분리가 없어 `mixed_models`로 표시합니다. 과거 모델 기록이 없는 실행은 명시적인 `model` 지정이 필요합니다. 검색·도구 별도 요금, 실패 시 보수적으로 예약한 토큰, 캐시 할인은 정확히 정산하지 않습니다.

청구 CSV 형식은 다음과 같습니다. 금액은 사용자가 제공자의 내역에서 직접 확인해서 입력합니다.

```csv
start,end,model,amount,currency
2026-10-01,2026-10-31,사용하는-모델-ID,0.01,USD
```

```json
{"action":"bills.import","path":"billing.csv"}
{"action":"bills.compare","profile":"development","model":"사용하는-모델-ID","start":"2026-10-01","end":"2026-10-31"}
```

비교는 해당 프로필·고정 모델·UTC 실행 시작일 범위의 실행 추정을 합산합니다. 같은 기간·모델 CSV 행의 합계와 비교하되 다른 프로젝트/프로필 사용료나 제공자의 집계 기준이 포함될 수 있습니다. 통화가 다르거나 단가가 없으면 차액을 만들지 않습니다. 동일한 CSV 행을 다시 가져오면 중복 저장하지 않습니다. 단일 실행만 비교하려면 `runId`를 추가할 수 있으나 기간 전체 청구와 집계 범위가 다를 수 있습니다.

## 백업·복원·보존

```json
{"action":"backup","profile":"development","scopes":["state","outputs","reports"]}
{"action":"restore","profile":"development","backupId":"반환된 백업 ID","confirm":true}
{"action":"prune","profile":"development","scopes":["state"],"olderThanDays":30,"confirm":true}
```

백업은 `.flowly-ops/backups`에 저장합니다. `state`는 선택 프로필의 실행 상태입니다. `outputs`, `reports`는 프로젝트 공용 폴더이므로 다른 실행에서도 사용할 수 있다는 점을 확인하세요. 공용 폴더를 관리할 때는 등록된 모든 프로필과 기본 native 상태 폴더의 실행기 잠금을 잡습니다. 관리 중에는 새 대기 작업을 실행하지 않습니다. 별도 사용자 지정 상태 경로로 수동 실행한 프로세스는 작업 전에 직접 중지하세요. 관리 대상은 파일 최대 5,000개, 전체 100MB, 개별 16MB입니다.

환경 파일·키 파일·현재 설정된 비밀 값이 포함된 파일은 백업하지 않습니다. 운영 SQLite 대기열과 프로필 환경 파일은 실행 상태 백업 범위에 포함되지 않습니다. 백업은 암호화하지 않으므로 업무 자료가 들어 있는 백업의 접근 권한을 별도로 관리하세요.

복원은 같은 패키지·프로필의 백업만 허용하고 파일별 SHA-256을 확인합니다. 기존 파일을 덮어쓰지 않습니다. **외부 쓰기 도구가 하나라도 포함된 프로젝트의 복원 실행은 조회 전용(`restoredReadOnly`)으로 표시합니다.** 과거 승인 대기 원장으로 되돌아가 같은 외부 작업을 다시 보내지 않도록 Node/Python 실행기 모두 승인·검토 결정·재개를 차단합니다. 상태와 보고서는 조회할 수 있습니다. 외부 결과를 확인한 뒤 필요하면 새 실행을 시작하세요. 읽기/데이터 전용 프로젝트의 복원에는 이 제한을 붙이지 않습니다.

보존 정리는 지정 기간보다 오래된 파일만 제거합니다. 상태 범위에서는 완료·실패·취소·만료·한도 도달 실행만 대상이며 승인 대기·검토 대기·불명확 결과와 메모리/벡터 원장은 보존합니다. 원격 공유 철회가 이미 내보낸 사본에 소급 적용되지는 않습니다.
