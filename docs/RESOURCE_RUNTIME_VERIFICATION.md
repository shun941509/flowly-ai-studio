# 자료 계약과 내려받은 실행기 검증

2026-10-27. 이 기록은 자료 확장·실행형 Skill·Document 검색 연결을 구현한 현재 변경의 검증이다. 이전 주석 전용 검사나 과거 예제 실행 기록을 재사용하지 않았다. 웹 통합·자료 저장소·권한·브라우저 검증은 통합 담당자의 별도 결과와 함께 확인한다.

## 구현한 실행 계약

- 기존 workflow JSON v5, 실행 manifest v1, 본문만 있는 자료를 유지하고 선택적인 `details`·`files`를 읽는다. 첨부의 웹 저장소 키를 로컬 실행기에 넘기지 않는다.
- Prompt는 선언한 변수만 한 번 치환한다. 앞 단계 연결 → 블록 직접 값 → 기본값 순서로 해석하고 필수 여부·자료형을 검사한다. 변수 내용 속 `{{다른변수}}`를 다시 해석하거나 `eval`하지 않는다. 화면과 Node는 `domain/resource-prompt.ts`, Python은 `resource_output()`을 사용한다.
- Skill 본문은 지침이다. `node.skillExecution.entryId`의 명시적 선택이 있을 때만 등록된 실행 파일을 사용한다. 본문·다른 실행 정의는 감독 요청에서 제외한다. 읽기 효과를 선언한 코드도 기존 쓰기 승인·기록·중복 방지 경로를 통과한다.
- `flowly_skills.py`가 Python/JavaScript 진입 파일과 동봉 첨부의 경로·크기·SHA-256, 의존성, 실행 시간·출력 한도를 확인한다. 두 실행기는 같은 감독 도우미를 사용하며 키·토큰 환경을 코드에 자동 상속하지 않는다. 선택한 Python 코드는 동봉한 상대 모듈을 가져올 수 있다.
- `skillRuntimeFingerprint`는 실행 당시 감독 코드의 바이트 해시다. 등록 첨부와 감독 코드가 바뀐 상태에서 기존 승인으로 재개하지 않는다. 코드를 수정하려면 새 자료 버전·새 내보내기·새 실행으로 검증한다.
- MCP는 출력 스키마가 있는 경우 기본 `structuredContent` 또는 선택한 전체 `result`를 검사한다. 원래 MCP 반환 래퍼를 유지하므로 다음 블록의 기본 경로는 `data.structuredContent.<필드>`다. 읽기 형식 오류는 구체적인 실패로 중단하며 쓰기 후 형식 오류는 결과 불명확으로 분류한다.
- Document 원본은 `inputs/resources/`에 보관한다. 자료 블록의 `document.originalPath` → 파일 입력 → 문서 내용 추출로 연결할 수 있다. `provided` 상태의 추출 텍스트를 lexical/vector 검색과 지식 색인 준비에도 사용한다. 기존 content-only 자료는 그대로 검색한다. 추출 대기·실패 원본은 자동 추출하거나 설명 본문으로 대체하지 않고 다음 설정을 안내한다.
- 지식 색인의 `documentsPath`로 명시적으로 문서 배열을 전달하면 앞 단계에서 추출한 텍스트를 사용할 수 있다. 이 경로는 원본 자료의 추출 상태를 자동 변경하지 않는다. Python의 기본 문서 배열을 불필요하게 먼저 계산하던 부분도 수정했다.
- Node/Python과 로컬 운영 입력의 길이를 0~20,000 UTF-16 코드 단위로 통일했다. 빈 문자열·공백을 공통 입력 단계에서 허용하며 개별 블록의 필수 입력·검색 질문 검사는 별도로 유지한다.

## 실제 수행한 검증

```powershell
pnpm exec tsx --test tests/resource-runtime-export.test.ts
pnpm exec tsx --test --test-name-pattern 'Node and Python reject' tests/resource-runtime-export.test.ts
pnpm exec tsx --test tests/knowledge.test.ts tests/knowledge-export.test.ts
python -m py_compile export-runtime/runner.py export-runtime/flowly_skills.py export-runtime/flowly_ops.py export-runtime/flowly_local.py export-runtime/flowly_knowledge.py
pnpm exec eslint domain/resource-document.ts domain/resource-prompt.ts runtime/resource-materials.ts runtime/data-nodes.ts runtime/knowledge.ts runtime/engine.ts runtime/types.ts export-runtime/runner.ts export-runtime/manifest.ts export-runtime/python-tools.ts export-runtime/resource-files.ts tests/resource-runtime-export.test.ts
```

실제 ZIP 실행 묶음은 `node:test` 집계 **37개 통과, 실패 0개**였다(약 82.2초). 이 수는 단위/파서 검사 2개, ZIP 상위 검사 1개, 언어별 17개 하위 검사 34개의 합이며 서로 다른 예제 프로젝트 수가 아니다. 이후 하위 필드·길이 거절 사례를 21개로 보강한 파서 검사를 별도로 다시 실행해 통과했다. Python 구문 검사와 변경 TypeScript 12파일 ESLint도 통과했다. 전체 타입 검사·빌드·기존 회귀 묶음 결과는 통합 기록에서 별도로 보고한다.

Document 검색 연결 변경 뒤 기존 지식 색인 단위·실제 ZIP 회귀도 **39개 통과, 실패 0개**였다(약 26.8초). 증분 색인·철회·세대 전환/복구·동시 리비전 충돌을 포함하며 모델/임베딩 응답은 기존 명시적 테스트 경계다. 로그는 `outputs/resource-knowledge-regression.log`에 기록했다.

ZIP은 `buildExportPackage()`로 생성하고 임시 폴더에 실제 압축 해제했다. Node는 번들된 `runner.mjs`, Python은 내려받은 `runner.py`를 별도 프로세스로 실행했다. 테스트 전용 응답·네트워크 차단 파일은 제품 ZIP에 포함하지 않는다. 실행 로그는 `outputs/resource-runtime-test.log`에 기록했다.

| 검증 묶음 | Node.js | Python | 확인한 내용 |
|---|---|---|---|
| 입력 길이 | 통과 | 통과 | 빈 문자열·공백·이모지 10,000개 허용, 20,000 UTF-16 단위 초과 거절 |
| 승인한 Python Skill | 통과 | 통과 | 실제 계산·파일 부작용·승인 후 재개·완료 재개 시 중복 실행 없음 |
| 승인한 JavaScript Skill | 통과 | 통과 | 실제 `.mjs` 실행과 동일 입력/결과, 모델/MCP 비밀 환경 미상속 |
| Skill 거절 | 통과 | 통과 | 승인 거절 후 코드 호출 0회 |
| 지침 전용 Skill | 통과 | 통과 | 실행 코드가 첨부되어 있어도 명시 선택 없이는 호출/승인 0회 |
| Python 동봉 모듈 | 통과 | 통과 | 해시 검사된 보조 `.py`를 실제 import하여 결과 생성 |
| 실행 취소 | 통과 | 통과 | 코드 시작을 확인한 후 취소, 결과 불명확 유지, 지연 부작용 파일 미생성 |
| 파일 변조 | 통과 | 통과 | 승인 대기 중 진입 파일 변경 후 승인·재개 차단 |
| 실행 시간 초과 | 통과 | 통과 | 결과 불명확, 한 번 호출, 재개해도 자동 재시도 없음 |
| 출력 크기 초과 | 통과 | 통과 | 같은 불명확/중복 방지 경계 적용 |
| Skill 출력 스키마 오류 | 통과 | 통과 | 같은 불명확/중복 방지 경계 적용 |
| Document 원본·추출 | 통과 | 통과 | 동봉한 UTF-8 원본을 기존 파일 도우미로 실제 읽고 텍스트 추출 |
| Document lexical 검색 | 통과 | 통과 | 추출본 우선, 기존 content 유지, pending 상태의 구체적 안내 |
| Document vector 검색 | 통과 | 통과 | 명시적 임베딩 테스트 응답으로 추출 텍스트가 실제 요청에 전달됨 확인 |
| 지식 색인 수명주기 | 통과 | 통과 | 추출본으로 준비 → 평가 → 발행 → 조회 실행 |
| pending 지식 입력 | 통과 | 통과 | 기본 선택은 안내와 함께 중단, 명시 문서 입력은 실행 가능 |
| MCP 출력 계약 | 통과 | 통과 | 명시적 테스트 응답의 올바른 값 전달과 잘못된 자료형 차단 |

Prompt 단위 검사는 값 연결 우선순위·기본값·필수 누락·자료형 오류·미선언 변수·없는 입력 경로·한 번만 치환·기존 본문 호환을 확인했다. 파서 대응 검사는 자료 상세 버전/상위 필드, 설명/예시 길이, 사용자 검증 metadata, Prompt 하위 필드/이름/설명/샘플 타입, Skill 하위 필드/종류별 실행 정의, Document 하위 필드/원본 ID/추출 텍스트를 검사했다.

## 실제 서비스 호출 여부

이번 검증의 실제 OpenAI·임베딩·MCP 서비스 호출과 실계정 자격 증명 사용은 **0회**다. MCP와 임베딩이 필요한 검사에서만 기존 명시적 테스트 경계로 응답을 제공하고 외부 네트워크 접근을 차단했다. Python/JavaScript 코드, 파일 읽기·쓰기·추출, 로컬 색인, 승인과 재개, 실행기 프로세스는 실제 구현을 실행했다. 이 결과를 실제 모델의 업무 정답률이나 실계정 서비스 연결 성공으로 해석하지 않는다.

## 사용자 설정과 제한

1. 모델을 쓰는 흐름은 내려받은 `.env`에 `OPENAI_API_KEY`·`FLOWLY_MODEL`을, MCP는 ZIP에 안내한 `FLOWLY_MCP_ENDPOINT_…`·`FLOWLY_MCP_TOKEN_…`을 설정한다. Flowly 웹에 키를 넣지 않는다.
2. 선택 Skill 코드의 감독에는 Node/Python ZIP 모두 Python 3.11 이상이 필요하다. JavaScript Skill은 Node.js 22 이상이 추가로 필요하며 Node 실행기 자체는 프로젝트의 기존 최소 버전 22.13을 따른다. Node의 `FLOWLY_PYTHON` 또는 Python 실행에 사용할 가상 환경을 지정한다.
3. Python의 선언 의존성은 사용자가 직접 설치한다. JavaScript의 외부 npm 패키지 설치/번들링은 지원하지 않으며 내장 모듈과 동봉 파일을 사용한다. 코드나 Skill 본문을 자동으로 설치·변환하지 않는다.
4. 코드의 stdout은 JSON 결과 하나여야 한다. `maxOutputBytes`는 stdout+stderr 한도다. 기존 공통 노드 JSON 입출력 200KB, 지식 색인 갱신 문서당 40,000자와 같은 별도 한도도 적용된다.
5. Skill 감독은 OS 보안 샌드박스가 아니다. 사용자가 승인한 코드의 파일·네트워크 접근은 사용자 PC와 회사 환경 정책을 따른다. 임의 코드의 실제 부작용을 자동 판정했다고 주장하지 않는다. 웹 자료 공유 권한을 로컬 복사본에서 원격 철회하는 기능도 아니다.

이번 검사의 Document 실제 파일은 UTF-8 텍스트다. PDF·Word·Excel·OCR의 현재 변경 후 전체 재검증, 외부 설치 패키지의 모든 버전 조합, 실제 OpenAI/MCP 계정, 다른 OS의 프로세스 종료 동작, 임의 사용자 코드의 안전성·업무 정확성은 이 기록의 검증 범위에 포함하지 않는다. 문서·Skill 첨부의 운영 저장소/권한·수정본 왕복과 전체 웹 흐름은 별도 통합 검증 결과를 확인한다.
