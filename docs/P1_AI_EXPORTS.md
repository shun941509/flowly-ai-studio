# P1 · AI 작업 문서 내보내기

2026-10-24. Node.js·Python 실행 ZIP을 만들 때, 권한 검사와 정의 검증을 통과한 **동일한 manifest**에서 AI 작업 문서를 생성한다. 별도의 추정 그래프나 사용자가 선택하지 않은 자료를 추가하지 않는다.

## 포함 파일

| 파일 | 내용 |
| --- | --- |
| `START_HERE.md` | 사용 순서, 정확한 환경 변수 이름, Skill 목록, 대기·재개 명령 |
| `AI_PROMPT.md` | 외부 AI 작업 도구에 전달할 실행 요청 |
| `AGENTS.md` | 실행 범위, 자료와 권한의 구별, 승인·재개와 결과 보고 원칙 |
| `WORKFLOW_GUIDE.md` | 실제 노드 설정·입출력 매핑·분기·상위 및 하위 연결·자료 버전·허용 도구·한도 |
| `skills/flowly-workflow/SKILL.md` | 이 ZIP의 실행기를 사용하는 작업 절차 |
| `skills/flowly-skill-NNN-ID/SKILL.md` | 실제 선택한 각 Skill의 내용과 자료 ID·버전 |

기존 `workflow.json`, 실행기, `.env.example`, README 및 조건별 도우미를 보존한다. 예제 직접 다운로드와 편집기 내보내기 모두 같은 문서 생성기를 거친다. 전역 Skill 폴더에 설치하거나 외부 AI 도구 설정을 변경하지 않는다.

`WORKFLOW_GUIDE.md`의 위상 수준은 선행 관계 설명이다. 같은 수준의 노드가 자동 병렬이라는 뜻은 아니며, 실제 동시 실행은 설계의 병렬·팀·반복 설정을 따른다. 노드 위치 좌표는 설명에서 제외하고 실행 설정은 보존한다.

## 설정과 실행

키는 사용자가 ZIP을 푼 폴더의 `.env`에 직접 입력한다. 모델 노드가 있으면 `OPENAI_API_KEY`·`FLOWLY_MODEL`, MCP 연결은 해당 ZIP에 명시된 `FLOWLY_MCP_ENDPOINT_…`·`FLOWLY_MCP_TOKEN_…` 이름을 사용한다. 문서 생성기는 환경 변수 값을 읽지 않는다. 웹에서 OpenAI를 호출하거나 실제 연결 점검을 하지 않는다.

```powershell
node runner.mjs check
node runner.mjs run --input-file input.txt
node runner.mjs status <실행ID>
node runner.mjs submit <실행ID> <요청ID> --values-file values.json
node runner.mjs resume <실행ID>

# Python ZIP의 같은 명령
python runner.py check
python runner.py run --input-file input.txt
python runner.py status <실행ID>
python runner.py submit <실행ID> <요청ID> --values-file values.json
python runner.py resume <실행ID>
```

`submit`은 보완 입력을 저장하고 `resume`이 동일한 실행을 이어간다. 사람 검토는 `accept`·`reject`, 외부 변경 승인은 `approve`·`deny`로 구별한다. 문서는 이 계약을 안내하며 실제 입력 대기·재개의 검증은 해당 런타임 검사 결과로 별도 확인한다.

Markdown 문서는 보안 정책 실행기가 아니다. 문서를 읽는 AI 도구마다 AGENTS.md와 Skill 발견 방식이 다르므로 자동 인식되지 않으면 경로를 명시한다. 실행기의 권한·스키마·한도·승인 검사와 체크포인트가 실제 동작을 통제한다. 내부 사고 원문은 요구하지 않고 도구 호출·입출력·상태·간단한 결정 설명을 보고한다.

## 경계와 검증

- 현재 읽기 권한을 확인한 Skill만 포함한다. 공유 대상 이메일과 서버 비밀 설정은 새 문서에 넣지 않는다. 사용자가 자료 자체에 비밀을 적어 둔 경우 이를 자동으로 탐지·삭제한다고 주장하지 않는다.
- 자료 이름·ID로 파일 경로를 직접 만들지 않는다. ASCII 안전 이름과 고유 번호를 사용하고 YAML 문자열을 이스케이프한다. 등록 내용은 길이가 안전한 JSON 코드 블록으로 보존하며 상위 실행 지침으로 승격하지 않는다.
- `tests/export-zip.ts`는 모든 항목 경로를 검증한 뒤 새 테스트 폴더에 추출한다. 상대경로 이탈·절대경로·역슬래시·드라이브 구분자·제어 문자를 거절하고 중첩 폴더를 지원한다.
- 문서 생성기와 추출 도우미를 예제 검증 지문에 포함한다. 이전 ZIP 결과로 새로운 문서 묶음을 검증 완료 처리하지 않는다.

실행한 집중 검사: `node --import tsx --test tests/export-ai-documents.test.ts tests/export-package.test.ts` — 16개 통과. 문서의 중첩 그래프·매핑·분기·선택 자료 일치, 중복 이름과 위험 경로, 실제 변수 이름과 비밀 필드 제외, 두 언어 ZIP 구성을 검사했다. Node.js·Python의 실제 ZIP을 각각 풀어 `check`·`run`·`status`·`report`를 실행했으며 입력을 가공한 최종 답변과 HTML 보고서, 모델·도구 호출 수 0을 확인했다. 해당 변경 파일의 ESLint도 통과했다.

실제 OpenAI·MCP 호출은 **0회**다. 현재 검증은 문서 구조와 실행기 명령의 계약 검증이며 외부 AI 도구의 자율적인 업무 품질, 사용자 키 유효성, 사내 서비스 호환성을 검증한 것이 아니다.
