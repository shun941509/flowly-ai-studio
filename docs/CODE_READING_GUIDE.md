# 개발자를 위한 코드 읽기 안내

이 문서는 현재 소스를 따라 기능의 책임과 데이터 이동 경로를 찾기 위한 안내다. 기획 문서의 완료 표시나 과거 테스트 수치를 현재 구현의 증거로 대신하지 않는다. 처음의 주석 전용 단계와 이후 사용자가 승인한 자료·편집기 기능 구현 단계를 구분한다. 주석 전용 의미 동등성 기록은 [CODE_COMMENT_VERIFICATION.md](CODE_COMMENT_VERIFICATION.md), 새 자료 계약은 [RESOURCE_EXPERIENCE_CONTRACT.md](RESOURCE_EXPERIENCE_CONTRACT.md), 실행기 변경 검증은 [RESOURCE_RUNTIME_VERIFICATION.md](RESOURCE_RUNTIME_VERIFICATION.md)를 따른다.

## 먼저 읽을 순서

1. `AGENTS.md`, `CODEX_START.md`: 제품 경계와 개발 규칙.
2. `app/lib/model.ts`: 화면·설계의 기본 타입, JSON 파서, 그래프 검사, 미리보기.
3. `domain/workflow.ts`, `domain/schema.ts`: 설계 이관, 컴파일, 노드 입출력 전달 및 검사.
4. `app/ui/studio.tsx`, `app/ui/workbench.tsx`: 화면 상태와 편집 상태의 소유권.
5. `server/http.ts`, `server/auth/`, `server/repositories/`: 검증된 사용자와 현재 권한으로 저장/조회하는 경계.
6. `server/export-execution.ts`, `server/export-package.ts`, `server/export-ai-documents.ts`: 같은 설계에서 실행 프로젝트와 작업 지시를 만드는 경로.
7. `export-runtime/cli.ts`, `export-runtime/runner.ts`, `runtime/engine.ts`, `export-runtime/runner.py`: 내려받은 실행기의 진입점과 실제 실행.

## 폴더별 책임

| 영역 | 책임 | 읽을 때 주의할 점 |
|---|---|---|
| `app/ui/` | 한국어 화면, 편집기, 자료, 예제, 공유, 가져오기/내보내기 | 버튼 표시 여부는 서버 권한 검사를 대신하지 않는다. |
| `app/lib/` | 화면과 공유하는 모델, 시작 템플릿, 다운로드 클라이언트 | 미리보기 결과와 실제 실행 결과를 구분한다. |
| `domain/` | 그래프·설정·입출력·권한 정책·가이드·중복 판정 | 대부분 순수 로직이다. 자료 ID의 형식이 맞아도 현재 사용 권한은 별도다. |
| `server/` | 세션, 저장소, 권한 검사, 내보내기 조립 | 클라이언트 소유자/역할을 신뢰하지 않는다. |
| `runtime/` | 실행 상태, 제한된 Agent 반복, 도구 정책, 노드 실행 | 실제 연결 어댑터와 테스트 어댑터를 분리한다. |
| `export-runtime/` | 로컬 상태 저장, CLI, Python 실행기·운영 도우미·고정 도구·선택 Skill 감독 | 고정 도구 레지스트리와 사용자가 승인한 Skill 코드는 별도 경로다. 웹에서 업로드 코드를 실행하지 않는다. |
| `db/`, `drizzle/` | DB 접근 및 스키마/마이그레이션 | 기존 사용자 데이터를 보존하는 이관과 테스트 저장소를 구분한다. |
| `worker/` | Cloudflare Worker 요청/예약 처리 진입점 | 일반 Next.js 서버로 가정하지 않는다. |
| `scripts/` | 빌드, 생성물, 예제 감사, 오프라인 검증 | 일부 검사 명령은 생성 파일과 검증 배지를 갱신한다. |
| `tests/` | 단위·통합·내보낸 실행기 검증 | 테스트 대역 응답은 실제 모델의 정답률을 검증하지 않는다. |

## 화면에서 실행까지 추적하기

```text
화면 편집
  → Definition / 노드 설정
  → parseDefinition / compileDefinition / 사전 검사
  → API의 세션·워크플로·자료 권한 검사
  → 공통 내보내기 설계와 자료 스냅샷
  → 작업 지시 문서 + workflow.json + 실행기 ZIP
  → 사용자 PC의 환경 설정
  → Node.js 또는 Python 실행
  → 상태·출력·승인·체크포인트 기록
```

웹은 설계·자료 관리·검사·미리보기·내보내기를 담당한다. 실제 모델/MCP는 내보낸 환경의 설정으로 연결한다. `runtime/adapters/openai.ts`가 저장소에 있다는 사실만으로 웹에서 모델 호출이 허용되는 것은 아니다. 실제 호출 가능 여부는 진입점, 설정, 어댑터 선택 경로와 격리 테스트까지 확인한다.

### 편집기·중첩 편집·초안

- `app/ui/canvas.tsx`와 `domain/editor-operations.ts`: 화면 좌표/설계 좌표 변환, 확대, 선택, 이동, 복사와 이력.
- `domain/editor-composition.ts`: 미완성 설계의 연결 검사, 정렬, 부모 설계에 자식 적용, 사용자별 초안.
- `app/ui/nested-editor.tsx`, `domain/nested-editing.ts`: 적용 전 하위 편집 상태. 자식 경로는 부모 노드 ID와 `childIndex`로 식별한다.
- `app/ui/editor-diagnostics.tsx`, `domain/data-contract.ts`: 오류 위치, 입력 매핑, 출력 필드 안내.

중첩 설계 교체는 내용이 같은 형제까지 바꾸지 않도록 객체 참조를 사용한다. 좌표 정렬은 실행 연결을 변경하지 않는다. 서버 저장본과 브라우저의 복구 초안은 별개이며 저장 응답 도착 전에 추가로 편집한 상태가 덮이지 않는지 확인해야 한다.

### 실제 값이 어떻게 전달되는지

`domain/workflow.ts`의 `compileDefinition()`은 이전 JSON을 현재 계약으로 맞추고 연결을 검사한다. `resolveNodeInput()`은 직접 연결된 선행 노드의 실제 출력에서 `inputBindings`에 지정한 경로만 읽는다. 건너뛴 분기는 값을 제공하지 않는다.

`domain/data-contract.ts`의 출력 필드는 편집 편의를 위한 안내다. 배열의 `.0` 경로가 보여도 실제 목록이 비어 있을 수 있다. 자료형은 실행 시 `assertSchema()`로 다시 검사한다. `required`는 필드 존재 검사이며 빈 문자열의 업무적 적합성까지 자동 판정하지 않는다.

### 권한과 자료

`server/auth/`는 세션의 신뢰 경계를, `domain/workflow-access.ts`는 읽기·수정·삭제·공유 관리 정책을 정의한다. 저장/조회 API에서는 현재 세션으로 이 정책을 적용한다. 편집 권한에 읽기는 포함되지만 워크플로 삭제와 권한 관리는 소유자에게만 허용된다.

자료는 `server/repositories/resources.ts`의 별도 권한 검사 대상이다. 워크플로 공유가 자료 본문·외부 자격 증명 공유를 뜻하지 않는다. MCP 등록 정의는 환경 변수 **이름**과 도구 계약을 다루며 실제 키/토큰 값은 내보낸 사용자 환경에 둔다. 다운로드된 오프라인 자료 사본을 나중의 웹 권한 철회로 회수할 수 있다고 가정해서는 안 된다.

자료의 기본 `content`를 보존하면서 선택적인 `Resource.details`·`Resource.files`를 추가했다. 워크플로 JSON v5·실행 manifest v1과 자료 상세 version=1은 서로 다른 버전 계약이다. `domain/resource-contract.ts`가 공통 타입·크기 제한, `domain/resource-validation.ts`가 웹 저장·Node 실행기 검사, `export-runtime/runner.py`의 `validate_resource_extensions()`가 Python 대응 검사를 맡는다. 첨부 저장소와 현재 접근 권한은 `server/resource-files.ts`, `server/repositories/resources.ts`, `server/repositories/resource-history.ts`에서 확인한다. ZIP의 `exportPath`는 웹 저장소 키가 아니다.

`domain/resource-prompt.ts`의 `resolveResourcePrompt()`는 화면과 Node 실행기가 공유하는 순수 치환 함수다. 앞 단계 연결·명시 값·기본값 순서로 필수 변수와 자료형을 검사하고 단일 치환만 한다. Python의 `resource_output()`이 같은 계약을 수행한다. `runtime/resource-materials.ts`는 실제 `resource`·`prompt`·`document` 출력 필드와 선택 Skill 실행 계약을 만든다.

Skill `content`는 `SKILL.md` 정본이다. 본문만 연결한 Skill은 작업 지침으로 전달하며, `node.skillExecution.entryId`가 지정된 경우에만 실행한다. `skillToolDefinition()`은 읽기 선언 코드도 `effect: write`로 고정하여 기존 승인·도구 기록·중복 방지 경로를 통과시킨다. `flowly_skills.py`는 선택된 실행 정의와 등록 첨부 해시를 확인하고 Python `.py`/JavaScript `.mjs`를 JSON 표준 입출력으로 실행한다. 본문은 감독 프로세스에 정책으로 전달하지 않는다. Node의 `pythonToolWorker()`와 Python의 `python_tool_worker()`가 프로세스 그룹/Windows Job Object·최소 환경·취소를 담당한다. 고정 Python 도구 레지스트리(`runtime/python-tools.ts`, `flowly_tools.py`)와 이 사용자 코드 실행 경로를 혼동하지 않는다. 이 방식은 OS 보안 샌드박스가 아니다.

Document 원본은 `inputs/resources/`의 해시 검사된 파일로 내보낸다. 자료 블록의 `document.originalPath` → 파일 입력의 `file` → 문서 내용 추출을 따라가면 원본과 추출 결과를 구분할 수 있다. `domain/resource-document.ts`의 `resourceSearchText()`는 제공된 추출 텍스트를 검색/색인에 우선 사용하고, 추출 대기·실패 원본을 설명 본문으로 대체하지 않는다. Python의 `resource_search_text()`와 `flowly_knowledge.py`의 `resource_text()`를 함께 검토한다. 지식 색인의 명시적인 `documentsPath`는 앞 단계 추출 결과를 새 문서 배열로 전달하는 별도 경로이며 자동 원본 추출이나 자동 발행을 뜻하지 않는다.

MCP `outputSchema`가 있으면 `outputTarget`(기본 `structuredContent`, 선택 `result`)을 실제 호출 후 검사한다. `data`에는 전체 MCP 결과가 유지되므로 `data.structuredContent.<필드>` 매핑을 바꾸지 않는다. 읽기 출력 형식 오류는 구체적인 오류로 중단하고, 쓰기 후 형식 오류는 부작용이 이미 생겼을 수 있어 `unknown_outcome`이다. 로컬 운영의 명시적 MCP probe는 `tools/list`의 출력 스키마를 비교하지만 이번 검증에서는 실제 서비스에 접속하지 않았다.

### 승인·보완 입력·재개

- `runtime/engine.ts`, `runtime/policy.ts`: 현재 상태, 한도, 도구 정책과 승인 경계.
- `runtime/advanced.ts`: 하위 작업·검토·보완 입력 같은 복합 노드 처리.
- `export-runtime/store.ts`, `server/repositories/runtime.ts`: 서로 다른 환경의 지속 저장·잠금·체크포인트.
- `export-runtime/runner.py`, `export-runtime/flowly_ops.py`, `export-runtime/flowly_local.py`: Python 실행과 로컬 운영 화면의 대응 흐름.

승인/거절/입력 제출은 의사를 기록하는 단계이며, 실제 작업 재개와 구분한다. 승인 대상과 인자가 달라지면 이전 승인을 재사용해서는 안 된다. 결과가 불명확한 외부 쓰기는 읽기 재시도처럼 자동 반복하면 중복 부작용이 생길 수 있으므로 해당 상태 분기를 먼저 읽는다.

### 내보내기·외부 수정본 가져오기

`server/export-package.ts`의 `buildExportManifest()`가 공통 설계 manifest를 만들고, `server/export-execution.ts`는 실행기·AI 작업 지시·Agent 패키지의 진입점 파일명과 실행 명령을 통일한다. `server/export-ai-documents.ts`의 문자열은 사용자에게 전달되는 실제 산출물이다. 코드 주석과 혼동해서 임의 수정하지 않는다.

`domain/workflow-import.ts`는 웹 JSON과 실행 ZIP의 설계를 읽고 변경 목록을 만든다. 외부 파일에 들어 있는 사용자·권한을 신뢰하거나 자료 본문을 곧바로 덮어쓰지 않는다. 자료 묶음 표식이 있는 ZIP의 변경된 본문·첨부를 검토하고 새 사본/새 버전으로 가져오는 서버 경계를 거친다. `rebindImportedWorkflow()`로 현재 자료 목록에 연결하고 서버가 저장 권한을 다시 검사한다. ZIP 해시 일치는 패키지 내부 비교 결과이며 발행자 서명 검증이 아니다. 변경된 Python/JavaScript 코드를 자동으로 캔버스에 역변환했다고 보고하지 않는다.

### 예제 정의와 검증 증거

`domain/workflow-designs/index.ts`가 개별 작성 설계를 합친다. 각 파일은 `definition`, `resources`, `scenarios`를 함께 읽는다. 앞의 두 항목은 프로젝트 구성이고, `scenarios`의 모델/MCP 응답·상태 기대값은 테스트 전용이다.

`domain/workflow-identity.ts`는 이름·프롬프트·좌표만 바꾼 예제를 새 구조로 세지 않도록 한다. 서로 다른 구조 서명이 업무 품질이나 AI 결과의 의미적 차이를 보장하지는 않는다. 전체 소스 그래프 수, 명시적 Agent 예제 수, 현재 두 언어 검증 수를 구분한다.

## 생성 파일과 직접 수정할 파일

| 생성물 | 수정할 원본/생성 명령 |
|---|---|
| `server/generated/export-runner.ts` | `runtime/`, `export-runtime/` → `node scripts/build-export-runner.mjs` |
| `domain/generated/workflow-designs.json` | `domain/workflow-designs/` → `pnpm workflow:build` |
| `server/generated/framework-packs.ts` | `examples/frameworks/`의 허용 파일 → `node scripts/build-framework-packs.mjs` |
| `server/generated/catalog-verification.ts` | 현재 검증 증거 → `pnpm exec tsx scripts/build-workflow-badges.ts` |
| `domain/catalog/index.ts` | 작성된 `domain/catalog/` JSON → `pnpm catalog:build` |

생성 파일의 주석만 직접 고치면 다음 빌드에서 사라진다. 벤더 UI와 `scripts/vite/sites-vite-plugin.ts`의 원본·라이선스도 별도로 유지한다.

`scripts/catalog-evidence.mjs`는 소스와 생성물의 **바이트**를 해시한다. 주석만 바꿔도 이전 증거가 만료될 수 있다. 이를 숨기려고 지문 계산을 약화하지 않고 현재 산출물을 다시 검사한다.

## 검사 명령과 결과 해석

```powershell
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm exec tsx --test tests/resource-runtime-export.test.ts
node scripts/verify-examples.mjs --help
```

예제 검사 옵션은 도움말에서 확인한다. 실제 ZIP 실행 검증은 명시적인 모델/MCP 테스트 경계와 제한된 자식 환경을 사용한다. `pnpm test:integration`은 별도의 로컬 웹/DB 준비 상태를 확인한 뒤 실행해야 한다.

테스트 성공, 실제 외부 연결 성공, 실제 모델 답변 품질은 서로 다른 결과다. `catalog:complete`도 부분 집계 파일을 남길 수 있으나 전체 목표가 미달하면 실패 코드를 반환한다.

## 주석 작성 원칙

- 파일 첫머리에 역할과 다른 계층과의 경계를 설명한다.
- 주요 함수에는 입력/반환 또는 예외, 상태 변경, 호출 측의 책임을 설명한다.
- 승인·권한·버전·재개·중복 방지·중첩 편집은 처리 이유를 남긴다.
- 단순 대입을 한국어로 되풀이하거나 미구현 기능을 완료처럼 쓰지 않는다.
- TypeScript 지시문, CSS/JS 문자열, SQL, 내보낼 HTML/문서, Python docstring은 일반 주석과 구분한다. 이번 Python 설명은 `#` 주석으로 추가해 기존 docstring을 유지한다.

이번 작업의 변경 범위와 검사 결과는 [코드 주석 검증 기록](CODE_COMMENT_VERIFICATION.md)에 정리한다.
