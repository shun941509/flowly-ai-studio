# 예제 카탈로그 계약

웹은 설계·복제·내보내기만 제공한다. 모델 키를 받지 않으며 모델 SDK를 웹에 설치하거나 실행하지 않는다. 기존 Flowly 내보내기와 SDK 고유 프로젝트를 구분한다.

- 프로젝트: 다른 공개 예제와 실행 구조가 다르고, 별도로 작성한 제어 흐름·입력 매핑·조건·동작 설정과 정상·경계·실패 시나리오를 가진 업무 단위. 서로 다른 문제 설명이나 같은 구조의 설정 변경만으로는 공개하거나 독립 구현으로 집계하지 않는다.
- 변형: 같은 프로젝트의 프레임워크·언어 구현. 프로젝트 수에 가산하지 않는다.
- 목표: 고유 프로젝트 3,200개 이상. 작성하지 않은 프로젝트, 검수 대기 조합, 단순 모델·언어·산업명 치환은 완료 집계하지 않는다.
- 합성 자료는 예제 자료로 표시한다. 실제 고객·직원·조직 자료를 포함하지 않는다.
- 검증은 스키마 / Node 실행 계약 / Python 실행 계약 / SDK 오프라인 실행 / 실제 외부 모델 연결을 분리한다.

## HTTP

모든 `/api/examples` 요청은 서버 세션 검증이 필요하다. POST는 동일 출처 JSON만 받는다. GET 목록은 `q`, `framework`, `category`, `page`, `pageSize`(최대48)를 지원한다. 서버는 목록에 그래프와 패키지 소스를 보내지 않는다.

예제 목록·검색·필터는 `domain/generated/workflow-designs.json`의 개별 실행 설계만 대상으로 한다. 현재 공개 수·구조 그룹·두 언어 검증 수는 `EXAMPLE_CATALOG_INVENTORY.md`와 목록 API의 stats에 기록한다. 이전 업무 사례 탭은 제공하지 않고 `GET ?view=cases`는 410을 반환한다. 공개 정의가 없는 재설계 대기 원본 ID는 `GET ?id=…`, `POST {action:"instantiate",id}`, `POST {action:"download-project",id,language}`에서 모두 404다. 개별 그래프로 재구현한 ID는 정상 접근할 수 있다. 기존 사용자의 워크플로·자료 사본이나 저장 이력을 삭제·변경하지 않는다.

`GET ?id=…`는 `{project}`를 반환한다. `project.workflow`는 기존 Workflow 타입이며 definition.schemaVersion은5다. `POST {action:"instantiate",id}`는 서버의 원본 예제에서 새 ID의 비공개 자료와 워크플로를 한 D1 트랜잭션으로 저장한다. 클라이언트가 소유자·자료·그래프를 제출하지 않는다.

`POST {action:"download",variantId}`는 빌드 시 허용한 SDK 프로젝트 파일만 ZIP에 넣는다. 경로 탐색·비밀 파일·node_modules는 포함하지 않는다. 지원 언어가 다른 SDK를 네이티브 Node/Python 둘 다라고 표시하지 않는다. Dify는 플랫폼용 DSL과 API 클라이언트이며 독립 실행 SDK가 아니다.

`POST {action:"download-project",id,language:"node"|"python"}`는 서버의 해당 합성 예제만 실제 Flowly 실행 프로젝트로 내보낸다. 언어는 정확한 문자열만 허용하고 배열·객체·숫자는 거절한다. 클라이언트가 제출한 그래프·소유자·키는 사용하지 않는다. 세션과 동일 출처를 검사하며, 사용자 자료나 다른 사용자의 연결은 포함하지 않는다. 편집기를 거치지 않아도 각 예제를 다운로드할 수 있다.

각 예제 ZIP은 `runner.mjs` 또는 `runner.py`, 실행 정의·자료, 빈 비밀 설정 예제와 함께 `input.txt`, `EXAMPLE.md`, `example-contract.json`을 포함한다. 계약 파일의 기대 출력은 평가 기준이며 모델 실행 결과가 아니다. 실제 실행은 로컬에서 키를 설정한 다음 `run --input-file input.txt`로 시작한다. 테스트 어댑터는 ZIP에 넣지 않는다.

## 대량 작성 및 증거

**2026-10-23 정정: 3,200개 독립 워크플로 구현 완료 주장을 철회한다.** 기존 `domain/example-core.json`, `domain/catalog/{business,technical,operations}/*.json`은 저장소의 시나리오 계약 원본 아카이브로만 보존한다. 재설계하지 않은 항목을 사례 탭이나 예제 API로 제공하지 않는다. 이전 공통 팩토리의 실제 그래프를 비교한 결과 3,200개 계약은 구조 6개·실행 설정 8개 그룹이었다. 기준선과 전체 그룹 ID는 `examples/workflow-identity-before.json`에 기록한다. 어휘 유사도 검사와 독립 AI의 계약 검토는 독립 실행 그래프의 증거가 아니다.

현재 실행 원본은 `domain/workflow-designs/`의 개별 정의와 `index.ts`다. 업무·자료 검색·팀·기억·실행 정책별 배치를 직접 설계하며 새 업무도 포함한다. 따라서 아카이브의 미전환 수와 3,200개까지 남은 수가 같지는 않다. `pnpm exec tsx scripts/build-workflow-designs.ts`는 그래프 검증·구조와 실행 설정 중복 검사 후 공개 정의와 설계/구조/실행 해시를 `domain/generated/workflow-designs.json`에 기록한다. 과거 `catalog:build`는 시나리오 JSON 색인을 만드는 명령이므로 개별 실행 설계의 완료 명령으로 사용하지 않는다.

공개할 새 예제는 실제 제어와 데이터 전달이 기존 설계와 어떻게 다른지 설명하고, 그 차이가 실행 결과에 드러나는 정상·경계 시나리오를 두 언어에서 검증해야 한다. 이름·업종·모델·프롬프트만 교체하거나 같은 구조의 설정만 바꾸는 것을 금지한다. 사용되지 않는 노드뿐 아니라 결과·분기·상태에 기여하지 않는 연결된 노드, 불필요한 변환·분기·중첩을 추가해 구조만 다르게 보이게 하는 것도 금지한다. 구조 서명 차이는 필요 조건이며 이런 실질 차이의 검토를 대신하지 않는다.

`pnpm catalog:audit`의 주 검사는 개별 실행 그래프를 대상으로 한다. `domain/workflow-identity.ts`는 노드 ID·제목·설명·좌표·프롬프트·문서 ID·모델명·노드/연결 배열 순서 차이를 제거하고 연결 방향, 분기 경로, 입력 매핑, 중첩 하위 작업, 조건·변환·기억 등 설정을 비교한다. 사용되지 않는 노드, 순환, 잘못된 참조와 정확 비교 한도를 넘는 그래프는 거절한다. 출력은 `examples/catalog-audit.json`과 `catalog-audit-review.md`이며 구조 그룹과 실행 설정 그룹을 따로 기록한다. 서로 다른 서명은 유용성·의미 고유성이나 모델 응답 차이의 증명이 아니다. 감사 성공도 전체 수량 목표의 완료를 뜻하지 않는다.

`pnpm exec tsx tests/workflow-export-integration.ts`는 실제 ZIP을 풀어 두 언어의 CLI, 설정 없음, 분기·자료 전달·반복·오류·검토/재개·실행 간 기억 시나리오를 검사한다. 모델이 필요 없는 그래프는 키 없이 준비되며 모델이 필요한 그래프는 미설정으로 표시한다. Node/Python 모두 실제 CLI 자식 프로세스·인자 처리·파일 저장을 사용하고 모델 HTTP 응답만 테스트에서 주입하며 네트워크를 차단한다. 테스트 도우미·응답·키는 배포 ZIP에 넣지 않는다. 이 검사는 실제 모델 정답률 검증이 아니다.

현재 실행 증거는 `examples/workflow-verification.json` version 1이다. 최상위 `fingerprint`, `projects`, `checks`, `failures`, `externalCalls`와 프로젝트별 `id`, `designHash`, `executionHash`, `node`, `python`, `zipHashes`, 시나리오별 `checks`를 기록한다. 현재 설계/실행 해시 또는 실행기·검증 지문이 다르면 증거를 재사용하지 않는다. 검증한 두 언어 ZIP은 `outputs/workflows/{id}-{node|python}.zip`에 저장한다.

대량 검증은 `pnpm test:examples --resume --workers 2`로 이어 실행한다. `--ids id1,id2`, `--prefix`, `--limit`, `--timeout-ms`로 범위를 좁힐 수 있다. 범위 필터는 각 프로젝트의 두 언어와 전체 시나리오를 유지한다. 중단 후 재개는 현재 실행기 지문·개별 설계/실행 해시·설정 검사·모든 시나리오·실제 ZIP 해시가 일치한 경우에만 이전 성공을 재사용한다. 보고서와 출력 폴더를 잠가 동시 실행 간 덮어쓰기를 막고, 실패한 CLI 인자·결과·상태는 해당 `.validation-*` 폴더에 보존한다. 개인 키가 없는 격리된 테스트 프로세스에서만 이 파일을 만든다.

사람 검토를 수정하는 시나리오는 `reviewEdits`로 검토 노드별 입력을 지정하며 실제 CLI의 `--edited-input-file`로 전달한다. 사용되지 않은 수정 키와 거절에 붙은 수정은 검증 실패다. `stateGroup`은 여러 실행 사이의 저장·유지·삭제를 검증한다. 이 테스트 설정과 응답은 공개 그래프 및 ZIP에 포함하지 않는다.

`pnpm catalog:complete`는 현재 정의를 다시 감사하고, 설계·실행 해시, 실행기 지문, 모든 정상·경계 시나리오 기록과 두 언어 ZIP의 SHA-256을 대조한다. 구조나 실행 설정이 같은 설계는 공개 예제와 독립 구현 집계에서 제외할 변형이다. 구조/실행 설정 어느 쪽이든 중복이 있거나, 각 그룹이 3,200개보다 적거나, 증거가 빠지면 **종료 코드 1**을 반환한다. 부분 집계는 `status: incomplete`로 `examples/catalog-inventory.json`과 `docs/EXAMPLE_CATALOG_INVENTORY.md`에 기록한다. 부분 보고를 작성했다는 사실을 완료로 표시하지 않는다.

기존 `catalog-verification.json`, `catalog-review.json`, `catalog-reviews/`, `outputs/catalog/`는 이전 시나리오 계약 검사 기록이다. 새 실행 그래프에 대한 검증·독립 검토·완료 배지로 승계하지 않는다. 새 그래프의 독립 검토와 인간 검수를 자동 집계가 인증하지 않으며, 의미 고유성 및 실제 모델의 정답률은 별도 평가가 필요하다. 웹은 계속 OpenAI를 호출하지 않고 사용자가 내려받은 프로젝트에 본인의 키를 직접 설정한다.

## 패키지

`examples/frameworks/<id>/manifest.json`: id, framework, language, kind(native/platform), projectId, title, description, entrypoint, files(상대경로 허용 목록), verification(static/offline/live).

빌드 산출물은 `server/generated/framework-packs.ts`. 런타임은 파일시스템에서 읽거나 임의 패키지를 설치하지 않는다. 패키지는 잠금/고정 의존성, 예제 입력, 실제 SDK 진입점, 명시적 오프라인 테스트, 한국어 설정 안내를 가진다.
