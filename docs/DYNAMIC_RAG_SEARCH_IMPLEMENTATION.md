# 동적 Agent·RAG 수명주기·ToT/GoT 후속 구현

2026-10-24. P0 및 P1~P4 대표 경로에 이어 추가한 수직 기능이다. 99개 전체 또는 3,200개 예제 완료를 뜻하지 않는다. 웹은 설계·미리보기·자료 관리·내보내기만 수행하며 OpenAI를 호출하지 않는다.

## 단계별 변경

| 순서 | 사용자가 할 수 있는 일 | 실제 실행 계약 |
| --- | --- | --- |
| P3-1 동적 Sub-agent | 작업 조정의 동적 방식을 선택하고 Agent 작업 틀을 등록 | 모델은 역할·목표·형식에 맞는 입력·선행 관계를 생성한다. 등록된 틀의 도구·자료·권한만 상속하고 최대 8개 생성·동시 4개, 부모 예산을 적용한다. 계획과 계약을 저장한 뒤 실행하며 입력/승인 대기 후 같은 하위 실행을 재개한다. |
| P3-2 지식 수명주기 | 새 ‘지식 색인 관리’에서 준비·평가·발행·검색·철회·복구·상태 조회 선택 | 변경 본문 조각만 임베딩하며 같은 조각은 재사용한다. 실제 검색 평가를 통과한 세대만 발행·복구한다. 리비전 비교와 원자적 파일 교체로 충돌을 거절한다. 철회는 모든 보관 세대와 벡터에 적용된다. |
| P4 후보 탐색 | 새 ‘후보 탐색’에서 트리(ToT) 또는 그래프(GoT) 방식 선택 | 트리는 분기·가지치기·되돌림을, 그래프는 다중 부모 병합·수정·자손 무효화를 수행한다. 후보와 제공자 응답을 저장하며 중단 후 복구한다. 원본 정수 항목의 합계를 실행기가 검산하고 종료를 판단한다. |

새 노드는 두 종류이며 팔레트는 31종이다. 동적 Sub-agent는 기존 작업 조정 설정으로 제공한다. ToT와 GoT는 같은 후보 탐색 상태 계약의 두 방식이다. 기존 v1~v5 변환과 v5 문서 호환성을 유지한다.

## 독립 예제와 분기

| 기획 ID | 실제 설계 ID | 고유 흐름 |
| --- | --- | --- |
| 031 | `dynamic-subagent-task-team` | 목표 → 역할 2/3개 생성 → 두 분석 역할 병렬 → 필요 시 한 역할 보완 입력 → 선행 결과를 받는 판단 역할 → 독립 완료 검사 |
| 052 | `p3-rag-incremental` | 자료 변경 → 변경 조각 임베딩 → 검색 평가 → 원자적 발행 → 출처·버전 포함 검색. 다음 실행에서 변경분/동일 본문 재사용 검사 |
| 053 | `p3-rag-local-revocation` | 최초 준비·발행 경로 / 철회 경로 분리 → 전 세대 제거 → 재조회 → 색인 상태 결합. 허용하지 않은 ID 거절 |
| 059 | `p3-rag-generation-recovery` | 갱신 / 복구 요청 분기 → 평가 성공 시 발행, 실패 시 활성 세대 유지 / 과거 발행 세대 재평가 후 복구 |
| 097 | `p4-tree-candidate-backtracking` | 원본 항목 → 후보 트리 → 초과·막힘 되돌림과 가지치기 → 실제 합계 성공/미해결 분기 |
| 098 | `p4-graph-candidate-lineage` | 원본 항목 → 여러 부모 후보 병합 → 조상 수정·자손 무효화 → 계보 사람 검토 → 수락/거절·성공/미해결 분기 |

이름·프롬프트만 바꾼 변형으로 세지 않는다. 원본 그래프는 `domain/workflow-designs/`, 시나리오와 언어별 ZIP 실행 증거는 `examples/workflow-verification.json`에 기록한다.

## 내보내기와 설정 위치

Node.js는 실행 번들에 기능을 포함한다. Python은 필요한 경우에만 `flowly_dynamic.py`, `flowly_knowledge.py`, `flowly_search.py`를 포함한다. 도우미 누락 시 다운로드 또는 실행 검사를 실패시킨다. 웹 저장소나 DB 구조를 다른 언어로 전환하지 않았다.

두 ZIP의 `AI_PROMPT.md`, `AGENTS.md`, `WORKFLOW_GUIDE.md`, `skills/flowly-workflow/SKILL.md`는 같은 manifest의 새 노드 설정·허용 자료·작업 틀·완료 조건을 포함한다. 지침 자체가 실행기·승인 검사를 대체하지 않는다.

- `.env.example`을 `.env`로 복사한다. 모델을 쓰는 흐름에는 `OPENAI_API_KEY`, 답변 모델을 쓰는 흐름에는 `FLOWLY_MODEL`, 임베딩에는 `FLOWLY_EMBEDDING_MODEL`을 설정한다. 단어 검색 수명주기는 모델 키가 필요 없다.
- MCP 정의는 웹 ‘도구 및 자료’에 등록한다. 내보낸 README에 표시되는 `FLOWLY_MCP_ENDPOINT_…`와 필요한 `FLOWLY_MCP_TOKEN_…`를 사용자 실행 환경에 직접 설정한다. 주소 허용 목록을 추가하지 않았다.
- 실행 상태 폴더에는 작업 계획·하위 실행·후보 탐색 상태와 사용자/최상위 워크플로/색인별 지식 세대를 저장한다. 같은 상태 폴더와 워크플로 ID를 유지해야 후속 실행에서 색인을 이어 쓴다.
- 설정이 없으면 미설정으로 중단한다. 테스트 제공자와 응답은 제품 ZIP에 포함하지 않는다.

## 검증 기록

최종 명령별 결과와 현재 소스 지문은 아래 검증 완료 기록 및 `examples/workflow-verification.json`을 따른다. 모델·임베딩·MCP 경계에는 ZIP 밖의 명시적 테스트 응답을 주입하며 실제 파일·CLI·분기·계산·상태 저장·복구를 실행한다. 실제 OpenAI·MCP 서비스 호출은 0회다.

핵심 회귀: `dynamic-agents.test.ts`, `dynamic-export.test.ts`, `test_export_dynamic.py`, `knowledge.test.ts`, `knowledge-export.test.ts`, `test_export_knowledge.py`, `search.test.ts`, `search-export.test.ts`, `test_export_search.py`. 후보 탐색 ZIP 시험은 프로세스를 exit 86으로 중단하고 잠금 복구 후 같은 ID를 재개하여 저장한 응답을 다시 호출하지 않는지도 검사한다.

### 최종 검증 완료 기록

| 실행한 명령 또는 검사 | 결과 |
| --- | --- |
| `pnpm typecheck` | 통과. 기존 버전 변환·새 설정·두 실행기 공유 계약의 타입 검사 |
| `pnpm lint` | 통과 |
| `pnpm test` | TypeScript 513개 통과, 실패 0 |
| `.venv-files/Scripts/python.exe -X utf8 -m unittest discover -s tests -p 'test_export_*.py'` | Python 212개 통과, 실패 0 |
| `pnpm test:examples --resume --workers 4` 및 수정한 두 탐색 예제의 선택 재검증 | 현재 지문의 114개 예제·228개 ZIP·1,468개 검사 통과, 실패 0. 새 6개는 정상·경계 시나리오 30개를 두 언어로 실행하고 설정 검사 12개를 더한 72개 검사 |
| `pnpm catalog:audit` | 구조 114그룹·실행 설정 114그룹, 중복 0·실패 0. 구조 서명 비교이며 사람의 업무 다양성 심사를 대신하지 않음 |
| `pnpm catalog:complete` | 현재 114개·228개 ZIP·1,468개 검사와 증거 해시 일치. 기존 3,200개 목표에 3,086개가 남아 의도대로 종료 코드 1. 실행 실패가 아닌 목표 미완료 판정 |
| `pnpm exec tsx --test tests/example-catalog.test.ts` | 최종 생성 카탈로그의 7개 회귀 검사 통과 |
| `pnpm build` | Vinext/Workers 빌드 통과, 현재 두 언어 검증 표시 114/114 반영 |
| `pnpm exec tsx tests/example-http-integration.ts` | 최종 서버의 24개 HTTP/D1 검사 그룹 통과. 전체 목록·실제 ZIP·세 사용자 격리·웹 실제 실행 차단 |
| `pnpm exec tsx tests/stateful-http-integration.ts` | 최종 서버의 8개 검사 그룹 통과. 새 6개/12 ZIP의 그래프·Python 도우미·AI 문서, 지식 자료 ID 변환, 소유자만 수정/삭제, 지정/전체 공유 및 철회 후 새 내보내기 거절 |
| `pnpm exec tsx tests/input-http-integration.ts` | 중첩 보완 입력·완료 작업 보존·취소·공유 철회 재검사 6개 그룹 통과 |
| `pnpm exec tsx tests/internal-mcp-http-integration.ts` | 사내 HTTP/포트 등록·도구 계약·세 사용자 권한·철회·웹 실제 실행 차단 통과 |
| 실제 브라우저 확인 | 지식 색인 관리·후보 탐색 설정, 동적 Agent 작업 틀 추가, 새 예제 상세·하위 구성 확인. 최종 목록의 114개 로컬 실행 확인 표시와 실제 API 미검증 표시 확인. [화면 기록](../outputs/stateful-ui.png) |

전체 검사에서 발견한 두 탐색 예제의 보류/검토 거절 안내 노드는 `inputBindings: {}`를 명시하도록 수정했다. 고정 안내문에 필요하지 않은 이전 `text` 기본 매핑이 삽입되어 실패하던 문제를 해결했으며, 해당 보류·거절 경로도 두 실제 CLI에서 다시 통과했다. 동적 예제의 전체 모델 호출 횟수와 탐색 예제의 기대 출력 선언도 실제 출력 계약에 맞췄다. 검증 하네스나 실행기의 성공 기준을 완화하지 않았다.

최종 실행기/검증 지문은 `e1d6ba9850a34eebc8ab8ccc1c4ada4280e30ef3afb6c4bb4452e2ddf2715df6`다. `examples/workflow-verification.json`은 예제별 설계/실행/ZIP 해시와 시나리오 결과를 보존한다. `examples/catalog-inventory.json`과 [카탈로그 집계](EXAMPLE_CATALOG_INVENTORY.md)는 3,200개 목표가 아직 미완료임을 표시한다. 상세 로그는 `outputs/stateful-*.log`에 있다.

99개 기획 대응표는 **구현됨 17 · 보강 필요 35 · 신규 개발 32 · 후순위 15**로 갱신했다. 이 목록과 소스 카탈로그 114개는 서로 다른 집합이다. 이번 개발·검증의 **실제 OpenAI·원격 MCP 서비스 호출은 모두 0회**다. 제품 ZIP에는 테스트 경계·응답·실제 자격 증명을 넣지 않았다.

## 남은 범위

- 동적 역할 생성과 실패 작업의 자동 재배정은 별개다. 실패 의존 결과의 자동 무효화·분산 점유·다중 서버 스케줄러는 남아 있다.
- RAG는 로컬 색인의 수명주기다. 외부 벡터 DB, 관계 그래프 참조의 삭제 전파, 원격 다운로드 사본 회수, 장기 보관 정리 정책은 구현 범위 밖이다. 철회해도 과거 실행 보고서·내보낸 원본 자료는 별도로 관리해야 한다.
- ToT/GoT는 현재 **양의 정수 항목 조합의 목표 합계**라는 등록 문제 계약을 검증한다. 일반 업무 문제에 자동 적용되는 의미 검증기나 실제 모델의 문제 해결 품질은 검증하지 않았다.
- 실제 모델·사내 MCP·운영 SSO 연결은 사용자 설정 후 별도로 확인해야 한다. 이번 개발에서 자격 증명을 읽거나 등록하지 않았다.
