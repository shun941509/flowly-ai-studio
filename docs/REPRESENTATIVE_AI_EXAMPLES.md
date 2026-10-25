# 대표 AI 시스템 예제 6개

## 2026-10-24 보완 입력·AI 작업 문서 추가

대표 ④는 이제 정보 부족 안내를 출력하고 끝내는 대신, `waiting_input`으로 지속 저장합니다. 누락·공백 주문번호 또는 불명확한 문의를 보완하면 같은 실행 ID로 정책/배송 작업을 이어갑니다. 병렬 정책 조회가 먼저 끝났다면 재개 시 그 작업을 다시 실행하지 않습니다. 정상·분기·보완 입력을 포함한 18개 시나리오를 Node.js와 Python에서 확인합니다.

두 언어 ZIP에 `AI_PROMPT.md`, `AGENTS.md`, `WORKFLOW_GUIDE.md`, `START_HERE.md`, `skills/flowly-workflow/SKILL.md`와 사용한 등록 Skill을 함께 제공합니다. AI 도구에는 `AI_PROMPT.md`의 내용을 전달하고, 실제 제어·승인·복구는 같은 `workflow.json`을 읽는 실행기가 담당합니다.

입력 요청의 필드를 `values.json`에 작성한 후 다음 명령을 사용합니다. 명령의 ID는 실행기의 status 출력에서 확인합니다.

```powershell
node runner.mjs submit RUN_ID REQUEST_ID --values-file values.json
node runner.mjs resume RUN_ID
# Python ZIP
python runner.py submit RUN_ID REQUEST_ID --values-file values.json
python runner.py resume RUN_ID
```

`submit`은 입력만 저장합니다. `resume`이 후속 작업을 수행하며, 완료한 작업과 최초 입력을 보존합니다. 모델·MCP 설정은 사용자가 내보낸 폴더의 `.env`에 입력합니다. 웹에서는 OpenAI를 호출하지 않으며 아래 기대 동작과 테스트 응답을 실제 모델 답변으로 표시하지 않습니다. 이번 전체 검증과 신규 6개 설계는 [P1~P4 기록](P1_P4_IMPLEMENTATION.md)을 따릅니다.

이번 범위는 아래 여섯 개의 실제 Flowly 그래프와 Node.js·Python 내보내기입니다. 3,200개 전체 목표와 구분합니다. 웹은 설계·자료 관리·구조 검사·내보내기만 제공하며 OpenAI를 호출하지 않고 키를 받지 않습니다.

예제 프로젝트 화면의 **대표 예제 6개 보기**를 선택하세요. 각 카드에서 실제 노드·연결·분기, 중첩 작업을 펼쳐 보고 두 언어 ZIP을 받거나 비공개 사본을 만들 수 있습니다.

노드는 의존 관계에 따라 위에서 아래로 배치하고 분기는 별도 열로 나눕니다. 상세 화면은 기본 100% 크기로 스크롤하며 **전체 구조 보기**로 전환할 수 있습니다. 편집기에서는 **크게 보기 → 읽기 좋은 크기**로 설계 공간을 넓힐 수 있습니다. 기존에 저장한 배치는 자동으로 덮어쓰지 않으므로 **자동 정렬** 후 확인하고 저장하세요. 정렬은 실행 취소할 수 있으며 노드 연결·데이터 매핑·실행 순서는 바꾸지 않습니다.

| 예제 | 실제 실행 흐름 | 실패·대체 경로 |
| --- | --- | --- |
| 대표 ① 병렬 제안서 검토 (`showcase-parallel-proposal`) | 동일 제안서 → 사업·기술·운영 Agent 동시 3개 → 각 역할의 구조화 결과 → 필수 검토·근거 확인 → 종합 | 복구 가능한 하위 오류는 누락된 역할로 보존하고 다른 결과도 유지. 필수 검토 누락·빈 보고서는 보류. 시간·예산·권한 오류는 안전 중단 |
| 대표 ② 근거 확인 RAG (`showcase-rag-evidence`) | 문서 분할·임베딩·로컬 색인 → 질문 검색 → 유사도 검사 → 답변 → 실제 출처 ID·비어 있지 않은 인용문 검사 | 첫 근거가 부족하면 질문을 한 번 재작성하여 추가 검색. 재검색 부족·잘못된 인용은 답변 보류 |
| 대표 ③ Agent Harness (`showcase-agent-harness`) | 허용된 읽기 도구를 Agent가 선택 → 실제 도구 관찰 결과 → 구조화 응답 검사 → 답변 | 도구 결과 없이 답변 완료 불가. 형식 오류는 한 번만 재조회·수정. 허용 외 도구 차단, 호출·판단·시간·토큰 한도 적용 |
| 대표 ④ 문의 작업 조정 (`showcase-request-orchestration`) | 구조화 문의 → 조정 Agent → 허용 목록의 정책/배송/복합/추가 질문 선택 → 선택된 작업 실행 → 준비된 결과만 종합 | 복합 작업은 정책 검색·배송 조회 동시 실행. 미등록 계획·잘못된 도구 응답 차단, 주문번호 불일치 시 타 주문 정보 미출력 |
| 대표 ⑤ 작성·검토 협업 (`showcase-multi-agent-editorial`) | 원자료 → 조사 → 작성 → 검토 → 통과 시 출력 / 실패 시 수정 → 최종 검사 | 수정은 한 번만. 미해결 지적은 원자료·수정본·초기 및 남은 지적과 함께 사람 검토. 빈 문서는 통과 판정이어도 보류 |
| 대표 ⑥ 승인 후 서비스 등록 (`showcase-approved-publishing`) | 요청 → 등록 초안 → 필수 항목 검사 → 사람 내용 검토 → 정확한 쓰기 인자 승인 → MCP 등록 → 실제 등록 ID | 검토·변경 승인 각각 거절 가능. 대기 상태 지속 저장, 새 프로세스에서 재개. 완료된 쓰기 재실행 방지, 응답 유실은 결과 확인 필요로 중단 |

## 실행 환경 설정

모델·서비스 키는 ZIP에 들어 있지 않습니다. ZIP을 새 폴더에 풀고 `.env.example`을 `.env`로 복사한 다음 로컬 편집기에서 본인 값을 입력합니다. 채팅이나 웹 화면에 키를 붙여 넣지 마세요.

- 모든 예제: `OPENAI_API_KEY`, `FLOWLY_MODEL`.
- RAG: `FLOWLY_EMBEDDING_MODEL` (예제 환경 파일에 기본값 안내).
- Harness: `FLOWLY_MCP_ENDPOINT_KNOWLEDGE`, `FLOWLY_MCP_TOKEN_KNOWLEDGE`.
- 문의 조정: `FLOWLY_MCP_ENDPOINT_SHIPPING`, `FLOWLY_MCP_TOKEN_SHIPPING`.
- 서비스 등록: `FLOWLY_MCP_ENDPOINT_PUBLISHING`, `FLOWLY_MCP_TOKEN_PUBLISHING`.

사내 접근과 외부 통신 차단은 회사 네트워크에서 담당합니다. 웹과 내보낸 실행기에 별도 사내 IP/도메인 허용 목록을 두지 않습니다. HTTP/HTTPS 사내 호스트·IP·포트를 사용할 수 있으며, 주소에는 인증 정보·쿼리·프래그먼트를 넣지 않습니다. 내보내기 정의의 기본 example.com 주소는 준비용 표시이며, 실행기는 명시적인 로컬 주소 설정 없이는 시작하지 않습니다. 아래 도구 계약을 지원하는 사내 MCP가 필요합니다. 주소와 토큰만 설정한다고 서로 다른 도구를 자동 변환하지는 않습니다.

**도구 및 자료 → MCP 추가/수정**에서 연결 ID, 사내 주소, 주소 환경 변수 이름, 토큰 환경 변수 이름(인증이 없으면 비움), 도구 이름·읽기/쓰기·입력 JSON 스키마를 등록합니다. 토큰 값은 등록하지 않습니다. 예제를 복사하면 MCP 자료도 내 비공개 사본으로 등록됩니다. 사내 도구가 예제와 다른 이름/입력/응답을 쓰면 자료의 도구 정의와 워크플로의 허용 도구·입력 매핑·응답 필드도 함께 수정하세요.

웹 내보내기는 현재 세션 사용자의 자료 권한을 다시 검사하고 등록한 도구 중 선택한 것만 복사합니다. 공유받은 정의는 사용할 수 있지만 원본 수정·삭제는 소유자만 가능합니다. 기본 공개 외부 MCP를 자동으로 연결하지 않습니다. 서버의 예전 `FLOWLY_CONNECTIONS_JSON`은 웹 내보내기 연결 출처로 사용하지 않습니다.

| MCP 도구 | 효과 | 인자 | 응답의 structuredContent |
| --- | --- | --- | --- |
| `lookup_reference` | 읽기 | `{query: string}` | `{text: string, sourceId: string}` |
| `lookup_shipment` | 읽기 | `{orderId: string}` | `{found: boolean, orderId: string, status: string, eta: string}` |
| `create_record` | 외부 변경·승인 필수 | `{title: string, body: string}` | `{recordId: string}` 필수, title/body는 선택 |

MCP는 기존 실행기의 Streamable HTTP 계약을 사용합니다. 공개 정의는 외부 계정 권한을 공유하지 않습니다. 서비스가 중복 요청 키를 처리한다고 가정하지 않으며, 불명확한 쓰기를 자동 재시도하지 않습니다. 실행 시작 시 서비스 주소를 고정하여 승인 후 다른 주소로 재개하는 것을 차단합니다.

```powershell
# Node.js ZIP
node runner.mjs check
node runner.mjs run --input-file input.txt

# Python ZIP
python runner.py check
python runner.py run --input-file input.txt
```

`check`는 설정 존재·형식 검사이며 실제 연결 성공이나 계정 권한 검증은 아닙니다. 실행할 때만 모델·서비스 요청이 발생합니다. 각 ZIP의 `EXAMPLE.md`, `example-contract.json`, `input.txt`에 입력과 기대 조건을 제공합니다. 기대 조건은 이미 생성된 실제 모델 결과가 아닙니다.

내용 검토는 `accept/reject`, 외부 변경 승인은 `approve/deny`입니다. 결정 명령은 외부 호출 없이 저장만 하고, `resume`으로 실행합니다. 실행·검토·승인 ID는 CLI 출력에서 확인합니다.

```powershell
node runner.mjs accept <실행ID> <검토ID>
node runner.mjs resume <실행ID>
node runner.mjs approve <실행ID> <승인ID>
node runner.mjs resume <실행ID>
```

Python은 위 명령의 `node runner.mjs`를 `python runner.py`로 바꿉니다.

## 기능 경계

- RAG 색인은 첫 검색에서 실제로 생성하며 이후 동일 문서·버전·임베딩 모델이면 지속 캐시를 재사용합니다. 별도 장식용 색인 노드를 추가하지 않았습니다. 색인 재생성은 문서 변경으로 검증합니다.
- 유사도 임계값과 인용문 존재 검사는 답변의 의미적 사실성을 증명하지 않습니다. 업무 자료에 맞는 실제 모델 품질 검사가 별도로 필요합니다.
- Harness의 답변·출처 ID는 공백을 제거한 뒤 비어 있지 않아야 합니다. 다른 예제의 단순 빈 문자열 검사는 의미적 품질을 보장하지 않습니다.
- Harness는 Agent 설정과 공통 실행 엔진으로 적용합니다. 외부 그래프는 DAG이며 Agent 내부 재시도는 한도 안에서만 수행합니다.
- 예제 자료는 직접 작성한 합성 문서입니다. 배송·등록·근거 조회 결과를 제품 코드 안에서 만들어내지 않습니다. 미설정은 미설정으로 중단합니다.
- 내보낸 자료는 오프라인 사본입니다. 웹의 공유 철회는 새 조회·새 내보내기에 재검사하지만 이미 받은 사본을 회수할 수는 없습니다.

## 검증

실제 생성 ZIP을 풀어 별도의 Node.js/Python CLI 프로세스로 실행합니다. 모델·임베딩·MCP HTTP 응답은 ZIP 바깥의 테스트 경계에서 주입하고 외부 네트워크와 기존 자격 증명 상속을 차단합니다. 그래프 엔진, 데이터 전달, 검색·색인, 저장, 승인과 재개는 실제 코드가 수행합니다. 테스트 응답은 제품 ZIP에 포함하지 않습니다.

검사 항목: 정상/부족/오류 분기, 모델의 실제 입력과 도구 관찰 데이터, 동시 실행 시간 중첩, 임베딩 캐시 호출 수, 현재 주문번호 대조, 빈 출력 거절, 도구 한도, 승인 전 쓰기 0회, 결정 명령의 호출 0회, 새 프로세스 재개, 완료·결과 불명확 상태의 재개 시 쓰기 추가 0회, 복사 후 자료 ID·소유권.

최종 명령과 결과는 EXAMPLE_VALIDATION.md의 대표 예제 절과 examples/workflow-verification.json을 따릅니다. 실제 OpenAI·원격 MCP·외부 쓰기 호출 여부는 로컬 테스트 통과와 구분하여 기록합니다.
