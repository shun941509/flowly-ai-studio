# 출시 준비 검사와 보류 원인 안내 · Mastra

프로젝트 `release-readiness`. 실제 Mastra Agent와 createTool을 사용하여 릴리스 검사 스냅샷을 조회합니다. 필수 검사 누락이나 실패가 있으면 보류 이유를 설명합니다. 실제 배포나 승인 실행은 하지 않습니다.

```powershell
# Node.js 22.13 이상, pnpm 11.25.0
pnpm --ignore-workspace install --frozen-lockfile --ignore-scripts
pnpm --ignore-workspace typecheck
pnpm --ignore-workspace test
Copy-Item .env.example .env
pnpm --ignore-workspace check
pnpm --ignore-workspace start "release-2026-10 후보의 필수 검사 결과와 출시 보류 이유를 정리해 주세요"
```

`.env`에 본인 `OPENAI_API_KEY`, 함수 호출을 지원하는 `FLOWLY_MODEL`을 로컬 편집기로 설정하세요. FLOWLY_MODEL에는 모델 이름만 넣습니다. 코드가 openai/ 접두어를 붙입니다. 키는 웹·채팅·Git·워크플로 JSON에 넣지 않습니다. `check`는 설정 존재 확인이며 `start`는 실제 모델 API를 호출하여 비용이 발생할 수 있습니다. 미설정 상태에서 가짜 답변을 반환하지 않습니다.

`fixtures/releases.json`은 직접 작성한 CC0-1.0 합성 데이터입니다. 예제는 migration-backup 누락과 accessibility 실패로 hold, 근거 REL-001입니다. 실서비스 현재 검사 결과가 아닙니다. 없는 릴리스는 unknown이며 변경 작업을 하지 않습니다. SDK 함수 도구이며 MCP 서버 연결은 별도입니다.

한도는 4,000자 입력·4단계·도구 3회·60초·출력 800토큰/단계입니다. 실제 SDK Agent에 공식 AI SDK MockLanguageModelV4를 주입한 오프라인 테스트 2개와 타입 검사를 통과했습니다. 실제 도구 실행과 다음 턴 전달을 확인했으며 모델 응답 자체는 테스트 데이터입니다. 실제 OpenAI/MCP 호출 0회. 사용자 키·모델명과 실계정 검증이 남았습니다.

공식 문서: https://mastra.ai/docs/agents/overview
