# v5 누락 기능 구현 계약 (진행 중)

웹은 설계·미리보기·내보내기만 담당한다. 기존 키를 조회/사용하지 않는다. 실제 모델·검색·MCP 호출은 사용자가 내보낸 환경에 직접 설정한다. 개발 검증의 모의 제공자 결과와 실제 파일 처리를 구분한다.

## 분담

- 통합: runtime/types.ts, app/lib/model.ts, domain/*, server/export-package.ts, scripts/build-export-runner.mjs, 공용 Python 파일/트리거 도우미와 문서·통합 검사.
- Node 담당: runtime/engine.ts, runtime/data-nodes.ts, runtime/advanced.ts, runtime/adapters/*, export-runtime/*.ts(단 manifest.ts 제외), 전용 Node 테스트.
- Python 담당: export-runtime/runner.py 및 tests/test_export_python.py.
- UI 담당: app/ui/*, app/globals.css, app/lib/*templates.ts. 공유 model/types/schema는 통합 담당만 수정.

## 7종 새 노드 (총 28종)

각 설정 키는 node type의 camelCase이다. 기존 정의는 v1→v2→v3→v4→v5 명시 변환. 새 실행기의 공통 로컬 파일 도우미 `flowly_files.py`를 두 ZIP에 제공한다. Node의 파일 처리도 이 도우미를 호출하며 Python 3.11+가 필요하다. 기본 AI/데이터 흐름의 Node 단독 실행은 유지한다. PDF/DOCX/XLSX/OCR 의존성은 별도 requirements-files.txt로 제공하고 미설치 시 명시 실패한다. 웹에서 파일/모델을 처리하지 않는다.

- `file_input`, `fileInput:{path:string,maxBytes:number}`: path는 이전 입력의 경로(기본 file). 입력 JSON의 상대 파일명 또는 form data.file 사용. 허용 루트는 실행 폴더 inputs/. 절대경로·..·심볼릭 링크 탈출 금지. 최대 10MB. 결과 `{...input,file:{path,name,extension,size,sha256},text:name}`; 바이너리를 상태/ZIP에 넣지 않는다.
- `document_extract`, `documentExtract:{mode:'text'|'table'|'ocr',filePath:string,maxPages:number,language:string}`: filePath 기본 file, 최대100페이지. txt/md/csv/json/pdf/docx/xlsx와 png/jpeg/tiff 지원 범위를 형식별로 검사. 결과 `{...input,text,pages:[{page,text,source}],tables:[{page,sheet,rows}],source:{name,sha256}}`. 텍스트는 최대200,000자, 표 최대10,000셀. 손상·암호화·의존성 미설정은 명시 오류. OCR는 실제 로컬 OCR 엔진만.
- `guardrail`, `guardrail:{action:'mask'|'remove'|'block',categories:('email'|'phone'|'resident_id'|'card'|'secret')[]}`: 전체 입력의 문자열 값을 재귀 처리, 발견값 원문은 보고하지 않는다. 마스킹/제거 결과와 `{guardrail:{counts,changed}}` 반환. block은 정책 오류로 onError 우회 금지. 정규식 기반 탐지의 한계를 명시.
- `evaluate`, `evaluation:{mode:'rules'|'model',rules:{kind:'contains'|'not_contains'|'min_length'|'max_length'|'json',value:string}[],rubric:string,threshold:number}`: threshold 0..1. 규칙 또는 모델의 JSON `{score:0..1,reason:string}` 평가. `{...input,evaluation:{score,passed,checks,reason}}`, 원문 text 유지. 실제 제공자 토큰/시간은 기존 한도 기록 사용. 평가 결과로 조건 노드를 연결할 수 있다.
- `file_output`, `fileOutput:{format:'csv'|'xlsx'|'pdf'|'docx',filename:string,dataPath:string}`: outputs/ 아래 새 파일만 생성. filename은 안전한 파일명(경로 금지), run/node 범위 하위 폴더. CSV/XLSX는 객체 배열 또는 행 배열, DOCX/PDF는 text. 수식 삽입 방지. runId:nodeId 작업 원장과 hash 확인으로 재개 중복/덮어쓰기 방지. 로컬 산출물 생성은 설정된 출력 경계에서 실행하며 원격 외부 쓰기와 구분. 결과 `{...input,file:{path,name,extension,size,sha256},text:path}`.
- `trigger`, `trigger:{kind:'schedule'|'webhook'|'event',intervalSeconds:number,startAt:string,eventType:string}`: input/form을 대체하는 시작 노드. 시작 노드 정확히1. intervalSeconds 1..86400, startAt 빈값 또는 timezone 포함 ISO. `python flowly_triggers.py schedule --max-runs N --input-file ...`, `serve --port 8789`. Node/Python 공용 도우미가 해당 runner CLI를 실행한다. 기본 loopback, .env FLOWLY_TRIGGER_SECRET의 HMAC(timestamp + '.' + raw body), 5분 시간 창, eventId 중복 방지. event kind는 eventType 일치만 실행. SQLite 영속 receipt/실행 이력, 중첩 실행 방지, 불명확한 dispatch는 자동 재실행 금지. schedule은 UTC 시작/고정간격, missed tick 자동 몰아 실행하지 않음. Ctrl+C 정상 종료. 웹 테스트 Cron과 무관.
- `compensate`, `compensation:{sourceNodeId:string,arguments:Record<string,Json>,bindings:Record<string,string>}`: 같은 실행에서 완료된 외부 쓰기 호출이 있는 sourceNodeId에 대해서만 별도 허용 MCP 보상 도구1개 사용. 정확한 인자 새 승인 필요, 원장 재사용, 불명확한 원작업은 보상 자동 실행 금지. args의 bindings는 현재 입력 경로. source 미완료면 오류, 보상 실패도 기록. 임의 자동 rollback 없음.

## 기존 노드 확장

- Form field.type에 file 추가. 상대 파일 경로 문자열 검증, file_input 노드가 실제 읽기와 hash 확인. 웹은 로컬 경로를 설정하는 설명만 표시.
- RetrievalConfig mode?: 'lexical'|'vector'|'web', indexKey?:string. 기존 기본 lexical. vector는 고정 자료를 chunkSize로 나누고 OpenAI embeddings(text-embedding-3-small 기본, FLOWLY_EMBEDDING_MODEL 로컬 설정) 호출, 소유자/워크플로/자료hash/model 범위 캐시 후 코사인 검색. 인덱스가 없으면 실제 생성. query+doc 호출 모두 기존 토큰/호출/시간 예산에 산입. web은 OpenAI Responses web_search로 실제 검색하고 HTTPS 출처를 반환. mode web의 resourceIds=[] 허용.
- MemoryConfig backend?:'local'|'mcp', ttlSeconds?:number (1..31536000). local 만료 시 미발견으로 처리. mcp는 허용 도구1개 선택, 입력 `{namespace,key,action,value?,expiresAt?}`. namespace는 소유자+루트workflow를 해시해 강제, 사용자가 덮어쓰지 못함. 읽기는 read 도구, 쓰기/삭제는 write 도구·기존 승인 적용. 서버가 보장하는 TTL 계약을 문서화하고 응답의 expiresAt을 로컬에서도 확인한다. 미연결은 미설정 오류.
- OrchestrationConfig mode?:'plan'|'adaptive', maxRounds?:1..8. plan 기존 유지. adaptive는 완료한 결과를 보고 모델이 `{done:boolean,tasks:string[]}`를 선택. 허용된 task ID만, 라운드별 계획/결과 영속 저장, maxRounds/maxTasks/global budgets 준수. 완료된 작업 재실행은 새 round ID로 명시 기록, 기존 completed write 원장은 루트에서 유지.
- output 노드 `delivery?:{stream:boolean}`. stream=true면 해당 그래프의 모델 응답에 Responses SSE 사용. response.output_text.delta는 부분 이벤트, response.completed의 최종 응답/usage 확인 전 성공 금지. 오류/취소/중단 시 부분 결과를 최종 출력으로 삼지 않음. 내부 사고 원문 저장 금지. CLI 표준출력 최종JSON 보존, 부분 이벤트는 stderr(JSONL)로 전달.

## 공용 도우미 API

`flowly_files.py` stdin 1 JSON / stdout 1 JSON, 오류는 `{error:string,kind:'unconfigured'|'invalid'|'policy'}`와 exit1. 요청 `{operation:'input'|'extract'|'output'|'check',root:string,stateDirectory:string,runId:string,nodeId:string,config:object,input:object}`. root는 workflow.json 부모 디렉터리. 파일 도우미는 environment/모델 키를 읽지 않는다. 각 출력 file.path는 root 기준 상대경로다. 두 실행기 모두 안전한 argv로 subprocess stdin을 사용한다(셸 문자열 금지). 최대 출력2MB, deadline/종료 제어. 파일 해시는 extract 전에 다시 검사.

ModelAdapter에 optional embed/search와 next input의 onDelta를 통합 담당이 추가한다. RuntimeDependencies에는 optional files(request), vectorCache(key,value?), memory ttlSeconds 확장. 파일/트리거 도우미는 통합 담당 구현을 기다리고 나머지 엔진 작업은 병렬 진행한다.


## 2026-10-23: 조건 블록의 명시적 값 비교

v5의 선택 설정 `predicate`를 추가한다. 기존 `condition` 문자열 비교는 그대로 유지한다. `predicate`가 있으면 `{path, operator, value}` 또는 `{path, operator, rightPath}` 중 하나로 입력값을 직접 비교한다. 연산자는 `eq/ne/gt/gte/lt/lte/contains`다. `value`는 유한 숫자·문자열·불리언·null만 허용하고, 안전한 데이터 경로만 읽는다. 코드나 표현식 문자열은 실행하지 않는다.

숫자 크기 비교는 실제 숫자 두 개만 받으며 숫자로 보이는 문자열이나 불리언을 강제 변환하지 않는다. 누락 경로·복합 값·잘못된 자료형은 오류다. 결과는 입력 필드와 `matched`를 보존하며 기본 출력 스키마는 `matched:boolean`을 요구한다. 명시한 사용자 스키마는 유지한다. 조건 블록 외에는 이 설정을 거절한다. 두 내보내기 실행기에 동일하게 적용한다.

웹 미리보기는 실제 값 비교를 수행하지 않고 두 경로를 구조 미리보기로 표시한다. 기존 v1~v4 문서의 변환과 기존 문자열 조건 실행은 변경하지 않는다. 새 조건이 있는 문서는 현재 버전 실행기로 내보내야 한다.
