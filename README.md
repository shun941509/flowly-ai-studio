# Flowly · AI Workflow Studio

개발자가 소스를 분석할 때는 [코드 읽기 안내](docs/CODE_READING_GUIDE.md)를 먼저 확인하세요. 화면·도메인·권한·내보내기·Node.js/Python 실행기의 책임과 데이터 이동 경로를 정리했습니다.

**자료와 로컬 실행 계약 보강 (2026-10-27):** 자료의 선택적 `details`·첨부 파일, Prompt 변수 치환, 명시적으로 선택한 Skill 코드 실행, MCP 출력 스키마 검사, Document 원본·추출 텍스트·검색 연결을 추가했습니다. 기존 본문만 있는 자료와 워크플로 JSON v5·실행 manifest v1을 유지합니다. [공통 계약](docs/RESOURCE_EXPERIENCE_CONTRACT.md)과 [이번 실제 ZIP 검증 범위](docs/RESOURCE_RUNTIME_VERIFICATION.md)를 확인하세요. 아래 이전 검증 기록은 이번 변경의 검증과 구분합니다.

**디자인·운영용 내보내기 개선 (2026-10-26):** 설정창 스크롤·패널 조절·읽기 배율과 목록·예제·가이드를 정리했습니다. 내보낸 프로젝트는 운영 프로필과 로컬 운영 화면으로 시작하며 개발용 선택을 제공하지 않습니다. [변경 및 이번 검증 기록](docs/DESIGN_PRODUCTION_IMPLEMENTATION.md)을 확인하세요. 예제의 현재 검증 배지는 최신 패키지 증거에 따라 표시됩니다.

**2026-10-26 통합 업데이트:** [현재 통합 사용자 기능 명세](docs/INTEGRATED_USER_WORKFLOW.md)와 [검증 결과](docs/INTEGRATED_VERIFICATION.md)를 먼저 확인하세요. 가이드·편집기·예제 맞춤 설정, 워크플로 읽기/수정 공유, Cowork·Codex 작업 지시, Agent 없는 프로젝트 다운로드, 외부 수정본 가져오기, 로컬 실행 화면을 연결했습니다. 아래 이전 수치는 당시 검증 기록입니다.

일반 사용자를 위한 한국어 Agentic Workflow Builder입니다. 웹에서 노드·자료·공유·버전을 관리하고, **Node.js 또는 Python 실행 프로젝트를 내려받아 본인의 키로 실행**합니다. 웹에서는 OpenAI를 호출하거나 API 키를 받지 않습니다.

**범용 워크플로 조합**: 하위 흐름 시각 편집, 입출력 필드·형식 안내, 오류 블록 이동·정렬·초안 복구, 일하는 방식별 예제 탐색을 추가했습니다. AI 명령 프롬프트·Agent 다운로드와 Node.js·Python 실행기의 설계를 통일했습니다. [P0~P4 통합 구현 기록](docs/WORKFLOW_COMPOSITION_IMPLEMENTATION.md)과 [사용자 조합 실행 검증](docs/USER_COMPOSED_VERIFICATION.md)을 확인하세요.

편집기의 휠 확대·영역 선택·그룹 편집·단축키와 디자인을 개선하고 **AI 명령 프롬프트 복사**, **Agent 블록 유무와 관계없이 사용할 수 있는 Agent 다운로드**를 추가했습니다. [편집기·예제·내보내기 통합 기록](docs/EDITOR_EXPORT_INTEGRATION.md)에서 사용법·검증·설정 위치를 확인하세요.

동적 Sub-agent 생성, 로컬 RAG 수명주기와 ToT/GoT 후보 탐색을 추가했습니다. [후속 구현·검증 기록](docs/DYNAMIC_RAG_SEARCH_IMPLEMENTATION.md)에서 실제 범위와 설정 위치를 확인하세요.

2026-10-25 통합 작업에서 **195개 도구 후보·13개 기능군을 기획 100개 예제에 연결**하고, 등록 Python 도구를 프로그램 블록과 Agent 허용 도구로 사용할 수 있게 했습니다. [통합 기능 명세](docs/INTEGRATED_TOOL_SPEC.md), [100개 대응표](docs/EXAMPLE_100_IMPLEMENTATION_MAP.md), [변경·검증 기록](docs/INTEGRATED_TOOLS_IMPLEMENTATION.md)을 확인하세요. 후보 수·기획 수·개별 구현 수는 별도 집계입니다.

## 첫 사용

남아 있던 **보강 57개·신규 21개·후순위 6개**에는 각각 독립적인 Agent 워크플로를 추가했습니다. 현재 100개 기획의 실제 수용 범위와 필요한 설정은 [100개 수용 명세](docs/EXAMPLE_100_ACCEPTANCE_SPEC.md), 통합 실행기 변경과 검증 근거는 [84개 통합 기록](docs/REMAINING_84_IMPLEMENTATION.md)에 정리했습니다. 로컬 계산·분기·승인·복구를 검증하며 회사 시스템 연결과 실제 모델 답변 품질은 별도입니다.

**[대표 AI 시스템 예제 6개](docs/REPRESENTATIVE_AI_EXAMPLES.md)**: 병렬 제안서 검토, 근거 확인 RAG, 읽기 도구 Harness, 문의 작업 조정, 작성·검토 협업, 승인 후 서비스 등록. 예제 프로젝트 화면의 **대표 예제 6개 보기**에서 실제 연결 구조와 하위 흐름을 확인하고 Node.js·Python ZIP을 받을 수 있습니다. 모델과 MCP는 사용자가 내보낸 환경에 설정합니다.

통합 제품·예제 명세는 [EXAMPLE_PLATFORM_SPEC.md](docs/EXAMPLE_PLATFORM_SPEC.md), 검증 범위는 [EXAMPLE_VALIDATION.md](docs/EXAMPLE_VALIDATION.md)를 확인하세요. **예제 프로젝트** 메뉴에는 **개별 설계하고 실행 구조를 비교한 워크플로만** 제공합니다. 입력·자료·분기·매핑을 살펴보고 Node.js/Python ZIP을 직접 받거나 비공개 사본을 만들 수 있습니다. 기존 기본 시작점 27개와 9개 프레임워크의 11개 SDK/플랫폼 변형은 이 수에 더하지 않습니다.

이전 기획 **99개 예제의 소스 대응표와 우선순위**는 [EXAMPLE_99_IMPLEMENTATION_MAP.md](docs/EXAMPLE_99_IMPLEMENTATION_MAP.md), P0 기록은 [P0_EXPORT_PARITY.md](docs/P0_EXPORT_PARITY.md), 당시 P1~P4 변경은 [P1_P4_IMPLEMENTATION.md](docs/P1_P4_IMPLEMENTATION.md)에 보존합니다. 기획 99개는 당시 카탈로그 114개와 다른 목록입니다. 이 기록의 미완료 분류는 과거 시점이며 현재 범위는 위 100개 수용 명세를 따릅니다.

[현재 집계](docs/EXAMPLE_CATALOG_INVENTORY.md): **3,200개 독립 구현 목표는 미완료입니다.** 구현 수·현재 두 언어 검증 수·남은 수는 이 집계와 예제 화면에 표시합니다. 이전 3,200개는 문구 중심의 시나리오 계약으로, 비교 결과 구조 6개·실행 설정 8개 그룹에 해당했습니다. 이전 ZIP·검사·AI 계약 검토를 독립 워크플로 완료 증거로 사용하지 않습니다. 실제 모델의 업무 정답률과 실계정 연결은 미검증입니다.

재설계 대기 원본은 저장소의 JSON 아카이브에 보존하며, 예제 화면·검색·상세·복제·다운로드 API에는 제공하지 않습니다. 기존에 사용자가 복제한 워크플로와 자료는 그대로 유지합니다. 새 예제는 실제 제어 흐름과 데이터 전달의 차이, 정상·경계 동작의 증거를 갖춰야 합니다. 같은 구조에서 설정만 바꾸거나 불필요한 노드를 추가해 프로젝트 수를 늘리지 않습니다.

1. 로그인 후 템플릿을 선택하거나 빈 캔버스에서 흐름을 만듭니다. MCP는 **도구 및 자료**에서 사내 주소·연결 ID·도구 정의와 환경 변수 이름을 등록합니다. 사용자 접근과 통신 범위는 회사 네트워크가 담당하며 앱에 별도 사내 주소 허용 목록을 추가하지 않습니다.
2. **미리보기**로 구조를 확인합니다. 미리보기는 외부 모델·MCP를 호출하지 않습니다.
3. **실행 프로젝트 내보내기**에서 Node.js·Python ZIP, **AI 명령 프롬프트** 미리보기·복사, **Agent 다운로드**를 선택합니다. Agent 블록 없이도 다운로드할 수 있고 실행 언어도 선택합니다. 저장한 발행 버전도 같은 방식으로 내보냅니다. 개발/운영 선택은 없으며 새 로컬 프로필은 `production`, 설정 파일은 `.env`입니다. `START_HERE.md`의 로컬 운영 화면 시작 안내를 먼저 따르세요.
4. ZIP을 풀고 `.env.example`을 `.env`로 복사합니다. 모델이 필요한 경우 본인의 `OPENAI_API_KEY`와 사용 가능한 `FLOWLY_MODEL`을 로컬 편집기에서 직접 지정합니다. 예시 모델은 `gpt-5.4-mini`이며 Responses 함수 호출과 `reasoning.effort=none`을 지원하는 모델을 사용합니다. MCP 주소는 `FLOWLY_MCP_ENDPOINT_…`, 토큰은 `FLOWLY_MCP_TOKEN_…`에 입력합니다. 각 ZIP의 README에 정확한 변수 이름이 안내됩니다. 등록한 도구 정의와 내보낸 실행 환경의 자격 증명은 분리됩니다.
5. 내려받은 폴더에서 실행합니다.

```powershell
# Node.js 22.13 이상
node runner.mjs check
node runner.mjs run --input "사내 규정에서 회의실 예약 취소 기준을 알려 줘"

# 또는 Python 3.11 이상
python runner.py check
python runner.py run --input "사내 규정에서 회의실 예약 취소 기준을 알려 줘"

# 두 경로의 ZIP에 포함된 로컬 운영 화면 (Python 필요)
python flowly_local.py
```

예제 목록의 직접 다운로드와 편집기의 내보내기는 같은 실행기와 운영 도우미를 포함하고, 선택한 노드에 필요한 파일 처리·자동 시작 도우미도 함께 제공합니다. `python flowly_local.py`를 실행하고 터미널에 표시한 접근 토큰 포함 주소로 엽니다. 설정 확인·실제 연결 점검·대기열·실행 상태·보완 입력·검토/승인·재개·평가·백업을 제공합니다. `check`의 준비됨은 로컬 설정 확인이며 실제 계정 연결 성공이 아닙니다. 명시적인 `probe`가 실제 원격 연결을 점검합니다. Node.js ZIP도 파일 처리·자동 시작·운영 도우미를 사용할 때는 Python이 필요합니다. 파일 형식·OCR에 필요한 추가 의존성은 ZIP의 README와 `requirements-files.txt`를 따릅니다.

두 ZIP에는 **AI 명령 프롬프트·AGENTS.md·Skill**과 `START_HERE.md`·`WORKFLOW_GUIDE.md`도 들어갑니다. 실제 내보낸 그래프의 매핑·분기·선행 작업·완료 조건·허용 도구를 문서로 제공합니다. 외부 AI 도구에서 시작 안내를 읽도록 지정할 수 있으며, Skill을 자동 설치하지 않습니다. [AI 작업 문서 안내](docs/P1_AI_EXPORTS.md)를 확인하세요.

실행 중 `waiting_input`이면 `status`에서 요청 ID를 확인하고 `node runner.mjs submit <실행ID> <요청ID> --values-file values.json`으로 보완 값을 저장한 뒤 `resume <실행ID>`로 이어갑니다. Python은 `python runner.py`로 같은 명령을 사용합니다. 저장만으로 다음 도구를 실행하지 않으며 완료한 단계는 보존합니다.

키를 웹·채팅·워크플로 JSON에 넣지 마세요. 이 개발 작업에서는 기존 OpenAI 키를 조회·복사·등록·사용하지 않았습니다. 실제 모델 실행에는 비용이 발생할 수 있고 입력·자료·도구 결과가 해당 모델과 서비스에 전송됩니다. 키가 없으면 미설정으로 중단하며 가짜 답변을 만들지 않습니다.

## 노드와 설정

**31종 노드, 27개 템플릿, 핵심 용어 41개**를 제공합니다. 별도 노드와 공통 설정을 구별한 전체 명세는 [FEATURE_SPEC.md](docs/FEATURE_SPEC.md)에 있습니다.

- 입력·입력 양식·자동 시작·파일 입력·자료·작업 지침
- AI 답변·Agent·AI 분류·문서 검색·지식 색인 관리·후보 탐색
- 조건·병렬 작업·에이전트 팀·작업 조정·하위 워크플로·반복 처리·결과 모으기
- 도구 실행·값 변환·계산·검증 프로그램·문서 내용 추출·민감정보 필터·답변 평가·사람 검토·오류 처리·기억·보상 작업
- 답변 출력·파일 출력

OCR와 표 추출은 문서 처리의 방식, 벡터/RAG/웹 검색은 검색 방식, 적응형 계획은 작업 조정 설정, 원격 기억·TTL은 기억 설정, 스트리밍은 답변 출력 설정입니다. 같은 기능을 서로 다른 이름의 중복 노드로 만들지 않습니다.

보완 입력은 기존 입력 양식의 `request` 방식입니다. 작업 조정에는 등록한 작업의 `dependsOn`과 산출물에 대한 독립 완료 조건을 추가했습니다. **계산·검증 프로그램**은 숫자 집계·스키마 검사·오류 필드 수정·출처 대조·완료 조건 검사·검색 순위 통합의 기존 6종과 등록된 Python 도구 선택을 지원합니다. 도구별 준비 조건과 구현 범위를 표시하며 임의 코드나 SQL은 실행하지 않습니다. 기존 [프로그램 계약](docs/P2_PROGRAMS.md)과 새 [도구 대응표](docs/TOOL_CANDIDATE_MAP.md)를 확인하세요.

**도구 및 자료 → Python 도구팩**에서 입력 예시가 포함된 설정을 Document로 등록해 기존 공유 권한을 사용할 수 있습니다. Agent 설정에서는 호출을 허용할 Python 도구를 직접 선택합니다. Node.js ZIP도 이 기능에는 Python이 필요합니다. 내보낸 `requirements-tools.txt`의 패키지를 사내 저장소에서 설치하고, Node.js는 `.env`의 `FLOWLY_PYTHON`에 해당 Python 경로를 지정합니다. 모델 도구는 `models/` 아래 로컬 모델과 `FLOWLY_TOOL_MODELS`의 도구 ID별 상대경로가 필요합니다. `check`는 준비 상태를 확인하며 모델을 다운로드하지 않습니다.

로컬 기억은 다음 실행에도 유지하거나 이번 실행과 하위 Agent끼리만 공유할 수 있습니다. 버전 검사 쓰기는 읽은 `revision`이 그대로일 때만 다음 버전 객체를 저장합니다. 충돌하면 오류 경로로 보내며, 같은 상태 폴더 안의 저장을 직렬화합니다. 분산 서버 간 잠금 기능을 뜻하지 않습니다.

캔버스 추가·이동·복제·삭제·연결선·되돌리기·확대·전체 흐름 맞춤과 **크게 보기**를 제공합니다. JSON v1~v4는 명시적 변환으로 v5에서 읽습니다. 하위 흐름은 깊이 3·전체 120노드, 명시적 병렬 작업은 최대 동시 4개이며 외부 DAG는 순환하지 않습니다.

## 자료·버전·운영

`도구 및 자료`에서 등록한 내용은 다음 계약으로 내려받은 실행기에 전달됩니다. 웹에서는 모델·MCP·첨부 코드를 실행하지 않습니다.

| 자료 | 내려받은 실행기의 동작 | 준비할 내용 |
|---|---|---|
| Prompt | `{{name}}`에 앞 단계 연결 → 블록의 직접 입력 → 기본값 순서로 값을 채우고 필수 값·자료형을 검사합니다. 입력 속 치환 구문은 다시 해석하지 않습니다. | 변수 정의와 블록의 값/연결. 확장 설정 없는 기존 본문은 그대로 전달합니다. |
| Skill | 본문은 `SKILL.md` 정본입니다. 첨부만으로 실행하지 않고, Skill 블록에서 실행 정의를 명시적으로 선택했을 때 Python/JavaScript 코드를 승인 후 실행합니다. | `scripts/*.py` 또는 `scripts/*.mjs`, JSON 객체 입력·JSON 결과, 의존성, 시간·출력 한도. |
| MCP | 선택한 도구의 입력을 검사하고 출력 스키마가 있으면 `structuredContent` 또는 전체 `result`를 검사합니다. 반환 래퍼는 기존과 같습니다. | 실제 MCP 주소·인증은 로컬 `.env`. 기본 결과 경로는 `data.structuredContent.<필드>`입니다. |
| Document | 원본 파일은 `inputs/resources/`에 보존합니다. 자료 블록의 `document.originalPath`를 파일 입력 → 문서 내용 추출에 연결할 수 있습니다. `provided` 상태의 추출 텍스트는 문서 검색·지식 색인 준비에서도 사용합니다. | 원본/추출 상태를 구분합니다. 추출 대기·실패 원본은 자동 추출하거나 설명 본문을 대신 색인하지 않습니다. |

실행형 Skill에는 양 ZIP 모두 Python 3.11 이상의 감독 도우미가 필요합니다. JavaScript에는 Node.js 22 이상이 추가로 필요하며 내장 모듈·동봉 파일을 사용합니다. Python은 설치한 패키지와 동봉 모듈을 사용할 수 있습니다. 자동 설치·언어 변환을 하지 않습니다. Node 실행기는 `.env`의 `FLOWLY_PYTHON`으로 Python 경로를 선택하고, Python 프로젝트는 필요한 패키지를 설치한 Python으로 실행하세요.

Skill 실행은 작업 효과를 읽기로 선언해도 승인 대상입니다. 본문이 승인·권한 정책을 변경할 수 없으며 키·토큰 환경을 코드에 자동 상속하지 않습니다. 등록 파일의 경로·크기·해시와 감독 코드를 실행/재개 전에 확인합니다. 코드 실행 시간·출력 한도, 취소, 결과 형식 오류로 부작용을 확인하지 못하면 `unknown_outcome`으로 멈추고 자동 반복하지 않습니다. 이 기능은 OS 보안 샌드박스가 아니므로 사용자가 승인할 코드를 검토해야 합니다.

원본 첨부·추출 텍스트·검색 자료 선택·색인 발행은 별도 상태입니다. 지식 색인의 `documentsPath`로 명시적 문서 배열을 전달하면 로컬 추출 결과를 사용할 수 있습니다. 자료 전체 텍스트를 자동으로 임베딩하거나 색인을 발행하지 않습니다. 기존 공통 노드 JSON 입출력은 200KB, 지식 색인 갱신 문서는 문서당 40,000자 한도가 적용됩니다. 코드의 `maxOutputBytes`는 표준출력·오류출력의 별도 상한입니다.

- MCP·Skill·Prompt·Document CRUD, 나만/지정 사용자/전체 사용자 공유, 원본 수정·삭제는 소유자만 허용
- 읽기 권한 내 자료 댓글, 공유 철회 재검사, 계정별 저장과 데모 분리
- 불변 발행 버전·diff·초안 복원·지정 버전 ZIP, 저장 충돌 감지와 입력 보존
- 사용자 범위 감사 기록: 자료·공유·워크플로·발행·복원·댓글·내보내기 metadata
- 실제 입출력 매핑·스키마·한도·관찰 가능한 이벤트·체크포인트·보완 입력·승인/거절/재개
- 로컬 프로필·지속 우선순위 큐·취소·시각적 기록·평가 사례/전후 비교·단가 추정/수동 청구 비교·보관 정리·백업/복원

내보내기 API는 검증한 세션과 현재 자료 권한·본인 연결을 검사합니다. 자료 내용과 선택 도구 정의를 복사하며 서버 키나 공유 대상 이메일 목록은 제외합니다. **내려받은 복사본에 이후 공유 철회가 원격 적용되지는 않습니다.**

외부 쓰기는 정확한 도구·인자·사용자·기한에 묶인 승인을 사용합니다. 보상 작업도 별도 승인합니다. 결과가 불명확하면 자동 재시도하지 않습니다. 민감정보 필터는 선택한 패턴을 처리하며 모든 개인정보 탐지나 앞 단계 기록 삭제를 보장하지 않습니다.

## 파일·검색·트리거 준비

파일 처리의 입력은 `inputs/` 아래 상대경로, 출력은 `outputs/` 아래 실행별 폴더입니다. PDF·Word·Excel·CSV·텍스트·표·이미지/PDF OCR과 PDF·Word·Excel·CSV 생성을 지원합니다. 원문 변경·경로 이탈·정션·기존 출력 덮어쓰기를 검사합니다. Word 인쇄 페이지는 계산하지 않습니다.

파일을 쓰는 ZIP에는 `flowly_files.py`와 `requirements-files.txt`가 포함됩니다. Node의 파일 노드도 이 Python 도우미를 사용합니다. 기본 Node 데이터/모델 실행은 Python 없이 동작합니다.

```powershell
python -m venv .venv-files
.venv-files\Scripts\python -m pip install -r requirements-files.txt
```

Node 파일 처리에는 `.env`의 `FLOWLY_PYTHON`을 이 가상 환경 Python의 절대경로로 지정합니다. OCR에는 별도 Tesseract/tesserocr와 `tessdata/kor.traineddata`, `eng.traineddata`가 필요합니다. ZIP README가 설치 위치를 안내하고 `check`가 누락 상태를 표시합니다.

벡터 검색은 실제 임베딩 API와 로컬 색인을 사용합니다. 웹 검색은 실제 Responses 검색과 HTTPS 근거를 요구합니다. MCP 기억 도구는 지정한 namespace/key/action/value/expiresAt 계약을 지원해야 합니다. 실제 서비스 연결과 계정 권한은 사용자가 설정합니다.

자동 시작 노드는 내보낸 `flowly_triggers.py`를 직접 시작해야 동작합니다. 예약·서명 웹훅/이벤트·중복 방지·재시작 기록을 제공합니다. 리스너는 127.0.0.1만 열며 외부 수신 프록시는 별도 구성합니다. 웹의 개발용 Cron은 실제 모델 예약 실행으로 쓰지 않습니다.

## 웹앱 로컬 개발

React 19·TypeScript·Vinext·Workers·Drizzle·D1과 기존 pnpm 잠금 파일을 유지합니다. 일반 Next.js 배포나 다른 DB로 전환하지 않았습니다.

```powershell
pnpm install --frozen-lockfile
pnpm setup:local
pnpm db:migrate:local
pnpm dev
```

[127.0.0.1:5173](http://127.0.0.1:5173)에서 로컬 테스트 계정을 선택합니다. `setup:local`은 로컬 인증 설정과 무작위 세션 키만 준비합니다. `/demo`는 브라우저 저장소를 쓰며 계정 데이터와 분리됩니다. `pnpm start`는 현재 빌드를 실행하고 `pnpm dev`는 변경 시 재빌드합니다.

기본 인증은 미설정이며 OIDC는 PKCE·state·nonce·서명·검증 이메일을 확인합니다. 일반 인증 헤더를 신뢰하지 않습니다. 실제 운영에는 OIDC/Sites 신뢰 프록시·D1·인증 비밀·배포 설정이 필요합니다. 기존 소스 스냅샷과 pnpm 잠금 파일을 유지했으며, 이번 개발 작업에서는 커밋·배포를 수행하지 않았습니다.

## 검증

```powershell
pnpm typecheck
pnpm lint
pnpm test
python -X utf8 -m unittest discover -s tests -p test_export_python.py
python -X utf8 -m unittest discover -s tests -p test_export_ops.py
python -X utf8 -m unittest discover -s tests -p test_export_triggers.py
python -X utf8 -m unittest discover -s tests -p test_export_local.py
.venv-files\Scripts\python -X utf8 -m unittest discover -s tests -p test_export_files.py
pnpm build
# 로컬 웹 서버 실행 후 다운로드한 실제 ZIP 검증
pnpm exec tsx tests/export-v5-integration.ts --http
pnpm exec tsx tests/export-operations-integration.ts --http
```

v5에서는 양쪽 실제 ZIP의 파일·한국어 OCR·예약·큐·평가·백업/복원을 검증합니다. 모델·임베딩·웹 검색·MCP·보상은 모의 제공자/HTTP 계약과 미설정 차단을 검증하며, **이번 단계 실제 OpenAI·MCP·외부 쓰기 호출은 0회**입니다. 실계정 모델을 포함한 전체 실행·실제 SSO·운영 배포는 미검증입니다. 이전 공개 MCP 읽기 이력은 이번 호출과 구분합니다.

전체 결과·명령·제약은 [IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md), 상세 운영 명령은 [OPERATIONS.md](export-runtime/OPERATIONS.md), 인증·연결 설정은 [LOCAL_RUNTIME.md](docs/LOCAL_RUNTIME.md)를 확인하세요.

이번 P1~P4 검사는 보완 입력·중첩 재개·AI 문서 묶음·등록 프로그램·작업 의존 관계와 완료 조건·대표 기술/DB 흐름을 대상으로 합니다. P4 테스트에서는 임시 폴더의 고정 Python 시험과 SQLite 변경·복구를 실제 수행하고 모델·MCP 전송 경계만 대체합니다. 테스트 도우미는 제품 ZIP에 포함되지 않으며 실제 사용에는 등록된 사내 MCP 구현이 필요합니다. 이번에도 **실제 OpenAI·MCP 호출은 0회**이며 최종 통합 검증 결과는 [P1~P4 기록](docs/P1_P4_IMPLEMENTATION.md)을 확인하세요.

자료·첨부·Prompt 변수·승인된 Skill 코드와 편집기 통합 변경 및 설정은 [자료 통합 구현 기록](docs/RESOURCE_EXPERIENCE_IMPLEMENTATION.md)을 확인하세요. 기존 주석 단계의 결과와 현재 기능 검증을 구분합니다.
