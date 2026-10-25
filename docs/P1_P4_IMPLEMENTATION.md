# P1~P4 단계별 구현·설정·검증 기록

2026-10-24. P0 이후 입력 대기·재개와 AI 작업 문서 내보내기를 추가하고, 등록 계산 프로그램·작업 계약·기술/DB 통합의 대표 경로를 구현했다. 현재 팔레트는 **29종**, 개별 설계 카탈로그는 **108개**다. 기획 99개와 카탈로그는 서로 다른 목록이며, **99개 전체·P2~P4의 모든 기능·3,200개 독립 예제는 미완료**다. 예제별 분류는 [99개 대응표](EXAMPLE_99_IMPLEMENTATION_MAP.md), 제공 범위와 남은 구현은 [범위 검토](P1_P4_SCOPE_REVIEW.md)를 따른다.

확정 소스에서 108개 설계의 두 언어 ZIP 216개·검사 1,396건을 모두 새로 실행했다. 실패 0·이전 결과 재사용 0·외부 서비스 호출 0이다. 과거 [P0 결과](P0_EXPORT_PARITY.md)는 당시 기록으로 보존하며 이번 수치에 합산하지 않는다.

## 단계별 변경

| 단계 | 변경과 실제 동작 | 구현 위치 |
| --- | --- | --- |
| P1 · 입력과 재개 | 기존 입력 양식에 `mode=request` 추가. 지속 `waiting_input` 요청에 필드·소유자·해시·기한·스키마를 확인해 제출하고 같은 실행 ID로 재개. 중첩 요청·완료한 다른 단계·체크포인트 보존 | `runtime/advanced.ts`, `runtime/engine.ts`, `export-runtime/runner.py`, 운영/로컬 화면 도우미 |
| P1 · AI 작업 문서 | 동일한 권한 검증 manifest로 AI 프롬프트·AGENTS·Skill·시작 안내·그래프 설명 생성. 실제 하위 그래프·매핑·분기·작업 의존 관계·완료 조건·허용 도구·한도 포함 | `server/export-ai-documents.ts`, 공통 내보내기 자산, [P1_AI_EXPORTS.md](P1_AI_EXPORTS.md) |
| P2 · 등록 프로그램 | `program` 노드로 숫자 집계·스키마 검사·오류 필드 수정·출처 대조·완료 조건 검사·검색 순위 통합을 실제 계산. 임의 코드나 SQL 실행 없음 | `runtime/programs.ts`, `export-runtime/flowly_programs.py`, [P2_PROGRAMS.md](P2_PROGRAMS.md) |
| P3 · 작업 계약 | 등록 작업의 `dependsOn`, 정의·입력 해시, 필요한 선행 산출물 전달, 독립 `completion` 조건. 같은 계약의 완료 결과 재사용·불명확 쓰기 중단 | 공통 타입·그래프 검증, Node.js/Python 실행기, 작업 조정 설정 |
| P4 · 대표 통합 | 기술 근거→등록 구현 작업→시험→독립 검토→승인된 코드 적용→DB 변경/검증/복구. 시험/검토 실패이면 적용과 DB 진입 차단. 산출물 조건을 통과해야 목표 완료 | `domain/workflow-designs/p4-integrated-team.ts`, 검사 전용 `tests/p4-local-tools.py` |

입력 양식의 모드를 생략하면 기존 `initial` 동작을 유지한다. 그래프는 v5를 유지하며 기존 v1~v4 변환과 자료 CRUD·공유·현재 권한 검사·Vinext/Workers/D1·pnpm 구성을 보존했다. 일반 요청의 인증 헤더를 신뢰하거나 웹 모델 실행을 활성화하는 변경은 없다.

## 추가한 대표 설계와 보강 경로

| 예제 ID | 실제 연결·분기와 데이터 전달 |
| --- | --- |
| `p1-checkpoint-input-recovery` | 입력→접수 결과 저장→담당자/메모 보완 입력 대기→기존 결과와 보완 값 결합→출력. 별도 검사에서 저장 직후 프로세스를 실제 종료하고 동일 실행의 재개·중복 완료 방지 확인 |
| `p2-hybrid-rank-fusion` | 어휘/벡터 검색을 병렬 실행→자료 ID·버전·조각 기준 순위 통합→답변→인용 검사→공개 또는 근거 부족 경로 |
| `p2-structured-field-repair` | JSON 스키마 검사→오류가 있으면 Agent에 오류 필드 보완 요청→정상 필드 변경 거절→전체 재검사→수정 결과 또는 남은 오류 안내 |
| `p2-independent-cove` | 초안과 중립 확인 질문 생성→초안을 받지 않는 확인 Agent들이 근거 대조→각 인용 검사→모두 통과 시 수정→최종 인용 재검사 |
| `p4-approved-database-change` | 상태/버전 조회→백업·등록 변경 승인→검증→통과 또는 별도 승인 복구→복구 결과 확인 |
| `p4-goal-technical-team` | 기술 근거→개발→DB를 선행 작업 계약으로 연결. 시험/검토 실패 시 변경 차단. 근거 버전·시험 통과·DB 검증의 세 산출물로 최종 완료 판정 |

기존 대표 예제에는 필요한 보완 입력과 입력 대기·재개 검사 경로를 추가했다. 예제마다 모든 새 기능을 불필요하게 넣지 않으며, 동일 그래프의 이름만 바꿔 독립 예제로 집계하지 않는다. 그래프 소스가 존재하는 것과 실제 모델의 업무 정답률은 다른 검증 항목이다.

## 내보내기 구성과 사용자 설정 위치

두 언어 ZIP은 같은 manifest와 문서 생성 경로를 사용한다. 기존 실행기·`workflow.json`·`.env.example`·README·로컬 운영 도우미를 보존하고 다음 문서를 함께 제공한다.

| 파일 | 용도 |
| --- | --- |
| `START_HERE.md` | 시작 순서, 이 ZIP의 정확한 설정 이름과 명령 |
| `AI_PROMPT.md` | 외부 AI 작업 도구에 전달할 요청 |
| `AGENTS.md` | 허용 범위·승인·재개·결과 보고 규칙 |
| `WORKFLOW_GUIDE.md` | 실제 노드·매핑·분기·하위 흐름·의존 작업·완료 조건·자료 버전 |
| `skills/flowly-workflow/SKILL.md` | 실행기를 사용하는 작업 절차 |
| `skills/flowly-skill-NNN-ID/SKILL.md` | 실제 선택한 Skill의 원문과 출처 정보 |

Skill은 자동 설치하지 않는다. 외부 AI 도구가 자동 발견하지 않으면 시작 문서와 필요한 Skill 경로를 명시한다. Markdown이 실행기의 권한·승인·스키마·한도 검사를 대신하지 않는다. 등록 Skill의 본문은 안전한 파일 이름·YAML 문자열·JSON 코드 블록으로 보존하며 실행 정책을 변경하는 권한을 부여하지 않는다. 비공개 사고 원문 대신 관찰 가능한 도구 호출·결과·상태·간단한 결정 이유를 보고한다.

| 설정 | 사용자가 등록할 위치 |
| --- | --- |
| 웹 OpenAI 설정 | 등록하지 않음. 웹에서는 키를 받거나 OpenAI를 호출하지 않음 |
| 사내 MCP 공개 정의 | 웹의 **도구 및 자료 → MCP**에서 주소·연결 ID·도구 이름/효과/스키마·환경 변수 이름 등록. 비밀 값 제외 |
| OpenAI 키/모델 | ZIP을 푼 폴더에서 `.env.example`을 `.env`로 복사한 뒤 `OPENAI_API_KEY`, `FLOWLY_MODEL` 직접 편집 |
| 임베딩 모델 | 벡터 검색을 사용할 때 같은 `.env`의 `FLOWLY_EMBEDDING_MODEL`. 키는 `OPENAI_API_KEY` |
| 사내 MCP 주소/토큰 | 같은 `.env`에 ZIP이 명시한 `FLOWLY_MCP_ENDPOINT_…`, `FLOWLY_MCP_TOKEN_…`의 정확한 이름 사용 |
| P4 기술 변경 연결 | `FLOWLY_MCP_ENDPOINT_ENGINEERING`, `FLOWLY_MCP_TOKEN_ENGINEERING`. 사내 서비스가 내보낸 도구 입력·결과 계약을 실제 구현해야 함 |
| 선택한 파일/OCR | ZIP README와 `requirements-files.txt`의 로컬 라이브러리·엔진·언어 데이터. Node 파일 도우미는 `FLOWLY_PYTHON`으로 Python 경로 지정 |
| 웹 운영 인증·저장 | 기존 OIDC/Sites 검증 어댑터·세션 비밀·D1·배포 환경. 사용자 실행 키와 분리 |

모델·서비스 설정이 없으면 미설정으로 중단한다. `check`가 통과해도 실제 계정 연결 성공은 아니다. 실제 원격 점검은 사용자가 명시한 `probe`로만 수행한다. 회사 접근/통신 범위는 회사 네트워크가 담당하며 별도 사내 주소 허용 목록은 추가하지 않았다. 새로운 내보내기는 현재 자료 권한을 다시 검사하지만 이미 다운로드한 복사본을 원격으로 회수하지는 못한다.

```powershell
# Node.js 22.13 이상
node runner.mjs check
node runner.mjs run --input-file input.txt
node runner.mjs status <실행ID>
node runner.mjs submit <실행ID> <요청ID> --values-file values.json
node runner.mjs resume <실행ID>

# Python 3.11 이상: 별도로 받은 Python ZIP에서 실행
python runner.py check
python runner.py run --input-file input.txt
python runner.py status <실행ID>
python runner.py submit <실행ID> <요청ID> --values-file values.json
python runner.py resume <실행ID>
```

`submit`은 값 저장만 하고 `resume`이 후속 실행을 진행한다. 사람 검토는 `accept`/`reject`, 외부 변경 승인은 `approve`/`deny`로 구분한다. Node.js와 Python의 상태 폴더는 각각 `.flowly-runs`, `.flowly-python-runs`이며 서로의 실행 기록을 교환하지 않는다. 양쪽 ZIP의 `python flowly_local.py`에서도 보완 입력·검토·승인·재개를 처리할 수 있다.

## 검증 경계와 수정 사항

**이번 실제 외부 OpenAI 호출 0회, 원격 MCP 호출 0회다.** 기존 키를 조회·복사·등록·사용하지 않았다. 모델·임베딩·MCP 전송 경계에는 테스트 응답만 주입하며 다른 외부 연결을 차단한다. 제품 ZIP에는 테스트 응답·키·검사 전용 도우미를 포함하지 않는다.

- 등록 프로그램의 계산과 검사는 실제 Node.js/Python 구현으로 실행한다. 형식이 잘못된 입력·정상 필드 변경·출처 버전 충돌·빈 완료 조건을 성공으로 바꾸지 않는다.
- 입력 대기·기한·중첩 상위 상태·재개·완료한 단계 보존, 같은 계약의 하위 작업 재사용과 독립 완료 조건을 검사한다. 체크포인트 복구는 실제 프로세스 종료 후 같은 실행을 이어가는 경로를 포함한다.
- P4 테스트의 임시 작업 공간에서는 고정 Python 함수와 시험을 실제 실행하고 SQLite 백업·등록 변경·검증·복구를 수행한다. 결과 JSON만 성공으로 꾸미는 검사와 구분한다. 이 테스트 도우미는 범용 샌드박스나 제품 DB 서버가 아니며 제품 ZIP에 포함하지 않는다.
- 독립 검토에서 시험 실패/리뷰 거절 뒤 DB 변경이 진행할 수 있는 경로를 수정했다. 시험 결과를 모델 검토 전에 검사하고 DB 진입도 `testsPassed`로 검사한다. 변경 검증은 실제 스키마·행·합계·버전을, 복구 검증은 원래 스키마·행·합계·버전을 확인한다.
- 기한 안에 저장한 검토 결정을 기한 후 재개할 때 보존하는 두 실행기의 규칙을 맞췄다. 아직 대기 중인 입력의 만료는 중간 상위 실행까지 반영한다. 외부 변경 승인의 실행 만료 규칙은 별도 유지한다.
- 생성한 AI 안내에 새 작업 `dependsOn`과 완료 조건이 빠지지 않도록 실제 manifest와 일치하는 검사를 추가했다.

## 최종 통합 검증 표

전체 실행 기록은 `examples/workflow-verification.json`, 현재 ZIP은 `outputs/workflows/`에 있다. 아래 집중 검사 항목은 전체 테스트에 포함되므로 별도 합산하지 않는다. 로컬 웹의 보완 입력 HTTP 검사는 아래 명령으로 별도 실행했다.

| 검사 | 최종 결과 |
| --- | --- |
| `pnpm typecheck` | 통과. 생성 실행기·프레임워크 자산·TypeScript 검사 |
| `pnpm lint` | 통과 |
| `pnpm test` | 431개 통과, 실패/건너뜀 0. `outputs/p1-p4-node-tests.log` |
| Python `test_export_*.py` 전체 회귀 | 193개 통과, 실패/오류/건너뜀 0. `.venv-files/Scripts/python.exe -X utf8 -m unittest discover -s tests -p "test_export_*.py"` |
| `pnpm build` 및 생성 실행기/도우미 일치 | Vinext/Workers 빌드 통과. 실제 제품 ZIP 자산 일치 검사 통과 |
| 입력 대기·보완 입력·기한·중첩 재개·프로세스 종료 복구 | 통과. 두 실제 CLI 프로세스를 저장 직후 종료하고 같은 실행 ID 복구·완료 단계 1회 확인 |
| AI 문서/Skill 경로·선택 자료·비밀 제외·양쪽 ZIP 구성 | 통과. 중첩 경로 탈출 거절·manifest 계약 일치·실제 문서의 실행 명령 검사 포함 |
| 여섯 프로그램의 실제 양쪽 ZIP 결과·오류 일치 | 16개 시나리오 × 두 언어 실제 CLI 32개 통과 |
| 작업 의존 관계·완료 조건·완료 쓰기 재사용 | 실제 ZIP 12개 시나리오 통과. 역순/누락 의존성 거절·완료 거짓 선언 차단·완료 작업 재사용 검사 |
| 카탈로그 108개 Node.js/Python 실제 ZIP 시나리오 | `pnpm test:examples --resume --workers 4`: 216 ZIP·1,396개 검사 통과, 실패 0·재사용 0 |
| P4 시험 실패·리뷰 거절·변경 승인·DB 검증/복구 | DB 4개·통합 5개 시나리오 × 두 언어 18개 통과. 승인 거절·실패·응답 유실·복구 포함 |
| 웹 OpenAI live 차단 | 실제 HTTP 핸들러와 이전 live 큐 차단 회귀 통과. 모델 dispatch·네트워크 0 |
| `pnpm exec tsx tests/input-http-integration.ts` | 실제 로컬 HTTP/D1 6개 통과. 세 사용자·본문 신원 위조·잘못된 값·동일 제출·명시적 재개·깊은 중첩·취소·공유 철회 |
| 브라우저 화면 검증 | 1280×720에서 보완 입력·연결/정렬·프로그램 6종·의존 관계/완료 조건·AI 문서 내보내기 안내 확인. 두 QA 탭 오류/경고 0. 모바일 뷰포트는 이번 검사에서 미검증 |
| `pnpm exec tsx tests/example-http-integration.ts` | 최종 빌드에서 24개 그룹 통과. 현재 108개 검증 표시·12개 대표 ZIP·세 사용자 복제/격리·등록 MCP 매핑·웹 live 거절 |
| `pnpm exec tsx tests/internal-mcp-http-integration.ts` | 사내 HTTP:포트 등록·3사용자 공유/소유권·두 언어 등록 도구 내보내기·위조 연결 무시·철회·웹 live 거절 통과 |
| 실제 외부 API 호출 | OpenAI 0회·원격 MCP 0회 |

현재 실행기 지문: `2d6e1bbdf14b9942e9e0d5a32d82397b9492baa76708e31fad651d19cb8f18a1`. 개별 설계 해시·시나리오·216개 ZIP 해시를 다시 대조했다. `pnpm catalog:audit`는 구조/실행 설정 각각 108개, 중복 0이다. `pnpm catalog:complete`는 현재 검증 108개·216 ZIP·1,396건의 일치를 확인하고 **3,200개 목표 대비 3,092개 부족만을 이유로 종료 코드 1**을 반환했다. 이 목표 검사를 99개 기획 완료 검사로 사용하지 않는다.

전체 테스트에서 기존 대표 예제 단위 하네스가 새 `waiting_input`을 바로 성공과 비교하던 누락을 발견했다. 제출/재개와 완료 횟수 검사를 추가한 후 431개 전체를 다시 실행해 통과했다. 보완 입력 API는 DB에 남은 과거 이메일 대신 현재 요청에서 검증된 사용자 정보를 권한 검사에 전달한다. HTTP 검사가 만든 자료는 삭제했으며 실행 기록은 테스트 모드로 남는다.

브라우저 증거: `docs/qa/p1-supplemental-input-desktop.png`, `p3-completion-conditions-desktop.png`, `p1-ai-export-guide-desktop.png`, `p2-example-ai-export-desktop.png`. 기존 사용자 편집 탭은 조작하지 않고 별도 데모/테스트 계정 탭에서 확인했으며 계정 워크플로를 저장하지 않았다. 최종 Guide는 29종 블록·41개 용어다.

최종 빌드를 `http://127.0.0.1:5173`에서 실행 중이며 108개 현재 검증 표시를 HTTP로 확인했다. 최종 빌드의 Vinext 정적 라우트 분류 안내는 비차단이며 빌드는 정상 종료했다.

## 남은 범위

- P2~P4의 나머지 기획 예제마다 고유한 입력·출력·성공/실패 경로를 구현하고 양쪽 ZIP으로 검증해야 한다. 현재 노드 조합 가능 여부가 해당 예제의 완성을 뜻하지 않는다.
- 실행 중 임의의 새 역할·작업 계약 생성, 작업별 분산 점유/lease, 자료 버전 변경에 따른 종속 결과 무효화는 별도 개발 범위다. 현재 P3는 사전 등록된 작업과 동일 정의·입력의 완료 결과 재사용이다.
- RAG 증분 갱신·삭제/사용 철회·시점 검색·색인 세대 전환/복구와 전체 지식 수명주기, 범용 코드 샌드박스·DB 운영 서비스, ToT/GoT의 후보 경로 관리·되돌림·계보, 아바타 등은 남아 있다.
- 실제 OpenAI 응답 품질·사내 MCP 서비스 호환성·실계정 쓰기와 복구·SSO 왕복·운영 부하/장애 복구는 사용자 환경에서 별도로 검증해야 한다. 실제 서비스 미설정 상태를 성공으로 표시하지 않는다.

설정과 운영의 전체 안내는 [LOCAL_RUNTIME.md](LOCAL_RUNTIME.md), 노드/설정 구분은 [FEATURE_SPEC.md](FEATURE_SPEC.md), 이전 단계 기록은 [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)를 참고한다.
