# 195개 도구·100개 기획 통합 구현 및 검증

기준일: 2026-10-25. 이번 요청은 P0~P4를 하나의 통합 범위로 처리했다. 공통 계약·화면과 메모리, Python 계산, 실행기·내보내기, 예제 설계를 분담하고 공유 타입과 파일 책임을 조율했다. 웹은 OpenAI를 호출하지 않으며 실제 OpenAI·사내 MCP 서비스를 사용하지 않았다.

## 구현 내용

| 범위 | 반영 사항 | 확인할 소스 |
| --- | --- | --- |
| 공통 명세 | 195개 고정 ID·13개 기능군·기획 100개 양방향 대응, 입력 스키마·예시·패키지·모델 요구사항 | `domain/tool-catalog.json`, `export-runtime/tool-contracts.json`, `docs/EXAMPLE_100_IMPLEMENTATION_MAP.md` |
| 실제 도구 | 검색·전처리·수치 계산·통계/학습·평가·영상·음성·개인정보·제한된 자동화. 고정 함수만 호출하고 크기/시간/출력 한도 적용 | `export-runtime/flowly_tools.py`, `toolpacks_scientific.py`, `toolpacks_media.py` |
| 실행기 | 프로그램의 고정 `toolId`, Agent의 명시적 `pythonTools`, 기존 MCP와 합산한 허용 도구 한도. Node/Python이 같은 계산 구현 사용 | `runtime/python-tools.ts`, `runtime/engine.ts`, `export-runtime/python-tools.ts`, `runner.py` |
| 재개 | 도구 코드·계약·목록과 로컬 도구 설정 지문 고정, 완료 호출 재사용, 모델 호출 전 준비 상태 확인 | `export-runtime/runner.ts`, `runner.py` |
| 기억 | 기존 워크플로 범위 유지 + 현재 최상위 실행/하위 작업 범위, `expectedRevisionPath` 비교 후 갱신, 경쟁 쓰기·무검사 덮어쓰기 차단 | `runtime/engine.ts`, `export-runtime/store.ts`, `runner.py` |
| 화면 | 검색/기능군별 도구팩, 입력 예시, Document 설정 자료와 공유, Agent 허용 목록, 프로그램 선택·입력 편집, 100개 기획 연결 화면 | `app/ui/python-tools.tsx`, `planned-examples.tsx`, `program-nodes.tsx` |
| 내보내기 | 양쪽 ZIP에 선택 도구 manifest·계약·공통 작업 코드·선택 패키지 요구사항. AI 프롬프트·AGENTS·Skill에 실제 그래프/도구 계약 반영 | `server/export-package.ts`, `export-ai-documents.ts` |

Document 설정은 기존 CRUD/공유 권한을 재사용한다. 자료를 프로그램으로 추가할 때 원본 자료 ID를 유지하여 새 내보내기에서 현재 사용 권한을 검사한다. 설정 복사본이 원본 수정에 자동 동기화되거나 이미 내보낸 오프라인 자료가 원격 철회된다고 안내하지 않는다.

## 도구와 예제의 집계 기준

[도구 195개 대응표](TOOL_CANDIDATE_MAP.md)와 [기획 100개 대응표](EXAMPLE_100_IMPLEMENTATION_MAP.md)는 별도 목록이다. 추천 도구가 연결된 사실은 그 예제에 추천된 모든 도구를 자동 허용한다는 뜻이 아니다. 예제의 업무 범위와 남은 보강점도 함께 표시한다. 현재 개별 그래프 수와 최신 두 언어 검증 수는 [실행 카탈로그 집계](EXAMPLE_CATALOG_INVENTORY.md) 및 `examples/workflow-verification.json`을 기준으로 한다.

새 예제는 실제 노드·조건·매핑·하위 작업·승인 경로가 다르게 설계되어 있다. 기존 RAG 수명주기 및 ToT/GoT 예제에도 Agent가 실제 관측 결과를 검토하고 결과 공개 여부를 결정하는 경로를 추가했다. Agent가 검토하지 않는 단순 계산을 AI Agent 예제로 표시하지 않는다.

이번에 고유한 통합 그래프 29개를 추가하여 보존된 실행 설계는 143개다. 공개 기본 목록은 명시적 Agent를 포함한 72개이며, Agent 없는 보조 흐름 71개는 별도 탭으로 분리했다. 기획 100개는 **구현됨 16·보강 필요 57·신규 개발 21·후순위 6**으로 표시한다. 도구팩과 대표 실행 경로를 추가한 것을 기획 100개 전체의 완성으로 표시하지 않는다.

## 사용자가 설정할 위치

1. 웹의 **도구 및 자료**에 회사 MCP 정의·입출력·읽기/변경 구분을 등록한다. 연결 자격 증명은 정의에 넣지 않는다.
2. 내보낸 ZIP에서 `.env.example`을 `.env`로 복사한다. 모델이 필요한 흐름은 `OPENAI_API_KEY`·`FLOWLY_MODEL`, MCP는 README에 표시한 연결별 주소·토큰 변수에 직접 입력한다.
3. Python 도구를 선택한 경우 `requirements-tools.txt`에 선택된 패키지를 사내 저장소에서 설치한다. Node.js 실행기는 `.env`의 `FLOWLY_PYTHON`으로 그 Python을 지정한다. Python 실행기는 같은 가상 환경 Python으로 실행한다.
4. 로컬 모델은 `models/` 아래에 준비하고 `FLOWLY_TOOL_MODELS` JSON 객체에 도구 ID별 상대경로를 설정한다. 워터마크/콘텐츠 자격 증명의 HMAC 키는 선택한 기능에만 안내되는 `.env` 변수에 둔다.
5. `node runner.mjs check` 또는 `python runner.py check`로 미설정 항목을 확인한다. `check`는 외부 서비스 접속 성공을 증명하지 않는다. 이후 실제 사용자가 `run`으로 서비스에 연결한다.

키·사용자 모델·테스트 응답은 제품 ZIP에 포함하지 않는다. `AI_PROMPT.md`, `AGENTS.md`, `skills/flowly-workflow/SKILL.md`, `START_HERE.md`, `WORKFLOW_GUIDE.md`는 같은 내보내기 manifest에서 생성한다. 외부 AI 도구에 시작 문서를 읽도록 지정할 수 있으며 문서만으로 실행기의 권한·승인·한도를 해제할 수 없다.

## 검증 범위

검증은 실제 ZIP을 풀고 별도 Node.js/Python 프로세스를 실행한다. 계산과 저장은 실제 로컬 코드를 사용하며 모델·MCP만 명시적 테스트 경계에서 응답한다. 외부 API를 호출했다고 표시하지 않는다. 명령과 최종 결과는 아래 검증 기록에 갱신한다.

검증 중 Python 도우미를 취소해도 하위 프로세스가 남거나 파이프 읽기가 끝나지 않을 수 있는 문제를 수정했다. Windows Job Object와 POSIX 프로세스 그룹으로 작업 프로세스를 묶고 종료를 제한 시간 안에 처리한다. Python 출력 크기와 스트림 종료 대기도 제한한다. 독립 회귀 검사는 실제 임시 하위 프로세스의 종료까지 확인한다.

전체 병렬 검증에서는 Python 테스트 경계가 같은 Agent 호출 순번을 중복 예약하는 경쟁 조건도 발견했다. 제품의 실패 처리는 유지하면서 테스트 응답 선택·검증·예약을 원자적으로 처리하도록 보완했다. 두 병렬 호출이 수정 전에는 `[1,1]`, 수정 후에는 `[1,2]`를 기록하는 독립 회귀 검사로 확인했다. 최종 실행 증거는 경계 수정 후 새 지문으로 다시 생성한 결과만 사용한다.

최종 전체 검증은 143개 설계 모두 통과했다. 286개 ZIP을 새로 생성하고 SHA-256을 재확인했으며 이전 실행 증거는 재사용하지 않았다. 총 1,706개 검사(시나리오 1,420개·설정 검사 286개), 실패 0개다. 모델·MCP 경계는 명시적 테스트 응답이며 실제 서비스 품질을 검증한 결과는 아니다.

| 명령/증거 | 결과와 범위 |
| --- | --- |
| `pnpm exec tsx tests/workflow-export-integration.ts` | 143/143개 설계, 양쪽 ZIP 286개, 1,706개 검사 통과. 정상·분기·오류·승인·입력 대기·재개 등 각 설계에 선언된 시나리오 검사. [전체 증거](../examples/workflow-verification.json) |
| `work/tools-env/Scripts/python.exe -m unittest discover -s tests -p test_toolpacks.py -v` | 35개 통과. 실제 180개 도구 ID 실행, 15개는 추가 설정 필요. [정확한 ID·사유·환경](../examples/toolpack-verification.json) |
| `pnpm exec tsx --test tests/python-tools-export.test.ts` | 27개 통과·2개 건너뜀. 실제 양쪽 ZIP의 도구 호출·Agent 허용 목록·한도·준비 검사·재개 지문. 2개는 Playwright 미설정 RPA 검사 |
| `pnpm exec tsx --test tests/memory-versioning.test.ts` | 11개 통과. 두 실제 ZIP의 현재 실행/워크플로 범위, 하위 흐름, 버전 충돌·재개 |
| `pnpm exec tsx --test tests/export-advanced-node.test.ts tests/knowledge.test.ts tests/knowledge-export.test.ts` | 43개 통과. 기억과 RAG 증분·철회·색인 복구 회귀 |
| `pnpm exec tsx --test tests/python-tool-worker-tree.test.ts` + Python `test_toolpack_worker_tree.py` | Node 2개·Python 3개 통과. 취소·시간 초과·부모 종료 이후 손자 프로세스 정리 |
| `python -m unittest discover -s tests -p test_workflow_boundary_concurrency.py -v` | 1개 통과. 병렬 모델 테스트 응답의 순번 선택·예약 경쟁 조건 회귀 |
| `pnpm test:integration` | 로컬 HTTP/D1 20개 통과. 3사용자 세션·자료 권한·공유 철회·승인·재개·웹 live 차단. Python 설정 Document의 양쪽 ZIP 권한 재검사 포함 |
| `pnpm exec tsx tests/example-http-integration.ts` | Agent 72/보조 71 분리, 143개 원본 보존, 대표 6개 양쪽 ZIP·11개 프레임워크 패키지·3사용자 비공개 복제 확인 |
| `pnpm exec tsx --test tests/catalog-inventory.test.ts` | 2개 통과. 소스 그래프와 공개 Agent/보조 흐름의 집계 분리 |
| `pnpm catalog:complete` | 현재 소스 전체 증거 일치. 종료 코드 1은 과거 목표 3,200개 중 공개 Agent 예제 72개로 아직 3,128개가 남았기 때문이며 실행 실패가 아님 |
| `pnpm typecheck` / `pnpm lint` | 최종 소스 통과. 타입 오류 0개, lint 오류·경고 0개 |
| `pnpm build` | 최종 Vinext/Workers/D1 경로 빌드 통과. 일부 클라이언트 청크 500kB 초과, Node module.register 폐기 예정, Vinext 경로 정적 분류 안내 출력. 빌드 전후 실행기 지문 일치 |
| 최종 빌드 웹 화면 | 도구 195개 검색·사용 범위·설정 자료 폼, Agent 72개/보조 71개/기획 100개와 Agent 72개의 두 언어 실행 확인 표시 확인. `outputs/integrated-tools-ui.png`, `outputs/integrated-catalog-ui.png`에 화면 기록 |

패키지 검증에 필요한 의존성은 Git 제외 `work/tools-env` 가상 환경에 설치했다. 패키지 다운로드와 로컬 HTTP 검사는 있었으나 실제 OpenAI·원격 MCP 호출은 **0회**다. 실계정 키를 읽거나 등록하거나 사용하지 않았다.

최종 실행기·검증 경계 지문: `0577f319eb35f15d9e9decba0728409de4047c3f4a22e6186398c2b50af2ec19`.

## 제한 사항

- 195개 도구는 각 계약에 기재된 범위의 구현이다. 모델 파일·추가 엔진·패키지가 필요한 기능은 미설정 상태로 중단한다.
- 객체 탐지·화자 분리 등은 계약에 표시한 기초 알고리즘 범위다. 일반 데스크톱 제어·C2PA 인증·완전한 개인정보 탐지로 표시하지 않는다.
- 로컬 메모리 버전 검사는 같은 상태 폴더의 직렬화와 충돌 감지다. 분산 노드 간 작업 점유나 자동 상태 병합은 포함하지 않는다.
- 도구 실행 코드와 설정은 재개 시 검사한다. 대용량 모델 파일 내용과 설치 라이브러리 버전을 자동 고정하지 않는다.
- Node.js/Python의 실행 기록 형식은 서로 다르다. 한 언어의 상태 폴더를 다른 언어로 재개하지 않는다.
- 실제 모델 품질, 사내 MCP 구현·권한·DB/코드 작업의 운영 결과, SSO 왕복과 운영 배포는 이번 로컬 검증의 대상이 아니다.
