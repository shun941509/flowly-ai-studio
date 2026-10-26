# 자료·편집기·내보내기 통합 계약

2026-10-27. 사용자가 첨부 기능 구현과 코드 주석을 함께 진행하도록 확정했다. 이전 주석 단계의 검증은 별도 기준 기록이며 이후 기능 변경의 검증을 대신하지 않는다.

## 파일 책임

- 통합(root): 공유 타입/스키마/마이그레이션, 자료 상세·파일 저장·권한·버전 API, `app/ui/resources.tsx`, 통합 연결과 검증.
- A: 공통 Modal/FilePicker/선택 목록, 편집기·예제·가이드·CSS. `studio.tsx` 가져오기 콜백의 기능 변경은 통합 담당과 합의한다.
- B: 실행 패키지·AI 문서·외부 수정본 파서 및 화면. API 권한과 파일 저장은 통합 담당의 함수를 사용한다.
- C: Node.js/Python Prompt·MCP 출력·선택 Skill 실행·Document 파일 전달·로컬 운영·관련 검증.

## 공통 자료 계약

`domain/resource-contract.ts`가 타입과 크기 제한의 원본이다. 기존 Resource에 선택적인 `details`, `files`를 추가한다. 기존 실행 manifest v1과 워크플로 JSON v5는 유지하고 자료 확장 자체에 version=1을 둔다. 지원하지 않는 확장 버전/필드는 무시하지 않고 오류로 처리한다.

자료 본문 `content`가 Skill 지침의 정본이다. `SKILL.md`는 이 본문에서 내보내며 첨부 목록의 중복 정본을 허용하지 않는다. 웹에서 SKILL.md를 불러오면 본문 편집기로 읽는다. `scripts/`, `references/`, `assets/` 등 안전한 상대 경로의 파일은 별도 첨부다.

첨부는 불변 ID·상대 경로·MIME·바이트·SHA-256을 갖는다. 웹 저장소 키는 서버 전용이며 ZIP에는 노출하지 않는다. 파일 바이트는 권한 검사된 별도 조회로 ZIP에 넣고 manifest에는 내보낸 경로를 기록한다.

Prompt는 `{{name}}`의 단일 치환을 사용한다. 앞 단계 값 매핑, 노드의 명시 값, 기본값 순으로 해석하고 필수/자료형을 검사한다. 중첩 치환/eval을 하지 않는다. 확장 없는 기존 Prompt 본문은 종전대로 전달한다.

Skill의 실행 정의만으로 자동 실행하지 않는다. `node.skillExecution.entryId`의 명시 선택이 있어야 실행한다. Python/JavaScript 파일을 JSON 표준 입출력으로 실행하고 모든 코드 실행을 기존 쓰기 승인·호출 기록·한도·재개 경로에 결합한다. 코드 내용의 부작용을 자동 판별했다고 표시하지 않는다. OS 보안 샌드박스라고 주장하지 않는다.

MCP는 선택적인 `outputSchema`, `outputTarget: structuredContent | result`를 추가하며 기본 대상은 structuredContent다. 출력 선언 없는 기존 도구는 원래 응답을 보존한다. 실제 다음 블록 경로는 기존 `{text,data: MCP 결과}`를 따른다.

Document 등록·원본 첨부·추출 텍스트·검색 선택·색인은 별도 상태다. 내보낸 파일 경로를 기존 파일 입력/문서 처리 블록에 연결한다. 웹에서 모델·임베딩·MCP·업로드 코드를 실행하지 않는다.

## 파일 저장과 변경

운영은 Workers의 R2 바인딩을 사용하는 어댑터로 제공한다. 명시적인 로컬 테스트 모드에서는 D1 파일 어댑터로 검증할 수 있다. 운영 파일 저장소가 없으면 미설정으로 표시하며 파일을 메모리에만 저장했다고 성공 처리하지 않는다.

자료 버전은 본문·details·첨부 ID 목록의 스냅샷이다. 복구도 현재 권한과 baseUpdatedAt를 확인한 새 버전 저장이다. 공유받은 자료의 원본을 변경하지 않는다. 이전 첨부는 소유자의 버전 복구를 위해 보존하되 공유 사용자는 현재 공개된 첨부만 읽는다.

수정본 가져오기는 `resource.import`의 sourceResourceId/baseUpdatedAt/mode(copy|version)/data를 사용한다. 파일 변경은 먼저 현재 세션의 임시 업로드로 준비한다. 서버가 현재 읽기 권한, 원본 수정 권한, 충돌과 파일 소유권을 재검사한다. 성공한 자료 ID를 워크플로 재연결에 사용하고 설계 저장은 기존 workflow.import 경로를 재사용한다.

## 공통 UI 계약

- Modal: `size=confirm|standard|editor|guide|example|compare`, 기존 wide 호환.
- FilePicker: label/accept/multiple/disabled/files/error/help/onFiles. 키보드 선택·이름/크기/오류를 제공한다.
- 검색 선택: 값 ID 목록을 유지하며 검색/종류 필터/선택만 보기/누락 선택 안내를 제공한다. 단일 선택 의미는 바꾸지 않는다.
- 공통 블록 설명은 `domain/workflow-guide.ts`에서 화면·문서가 재사용한다.

## 검증 경계

실제 서비스와 자격 증명 없이 실제 ZIP을 실행한다. Prompt/계산/파일/Skill 코드는 실제 구현을 실행하고 모델·MCP 응답만 테스트 대역으로 제공한다. 웹의 실제 모델 실행 차단, 현재 자료 권한, 파일 경로/해시, 승인/재개, 자료 버전 충돌과 왕복 내보내기를 검증한다.
