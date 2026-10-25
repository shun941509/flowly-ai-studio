# 문의 종류별 근거 문서 라우팅 · LangGraph

프로젝트 `knowledge-routing`의 TypeScript 변형입니다. 모델이 access/leave/unknown을 분류하면 실제 LangGraph 조건 경로가 정책 파일 조회 또는 담당자 안내를 선택합니다. Python 변형과 같은 프로젝트이며 중복 집계하지 않습니다.

Node.js 22.13 이상, pnpm 11.25.0을 사용합니다.

```powershell
pnpm --ignore-workspace install --frozen-lockfile --ignore-scripts
pnpm --ignore-workspace typecheck
pnpm --ignore-workspace test
Copy-Item .env.example .env
pnpm --ignore-workspace check
pnpm --ignore-workspace start "급여 파일 접근 권한이 없어요"
```

`.env`를 로컬 편집기에서 열고 본인의 `OPENAI_API_KEY`, 사용 가능한 `FLOWLY_MODEL`을 입력하세요. 구조화 출력을 지원하는 모델이 필요합니다. 키를 Flowly 웹·채팅·Git·워크플로 JSON에 넣지 마세요. `check`는 설정 존재만 확인합니다. `start`는 실제 모델을 호출하며 비용이 발생할 수 있습니다. 키가 없으면 미설정으로 중단합니다.

예제 결과는 category=access, ACC-01 정책에 따른 관리자 승인 안내입니다. 알 수 없는 질문은 담당자에게 문의하도록 안내합니다. `fixtures/policies.json`은 직접 작성한 CC0-1.0 합성 자료이며 실제 회사 정책이 아닙니다. 조회는 로컬 파일을 읽고 외부 쓰기나 MCP 호출을 하지 않습니다.

한도: 입력 4,000자, 그래프 재귀 8, 분류 모델 1회, 요청 60초, 응답 200토큰. 실제 모델의 분류 품질은 미검증입니다.

정적 타입 검사와 SDK 그래프 조건 경로·근거 전달·스키마 거절 오프라인 테스트 3개를 통과했습니다. 테스트에는 명시적인 결정적 분류기를 주입하며 실제 AI 결과로 표시하지 않습니다. 실제 OpenAI/MCP 호출 0회입니다. 모델 키·모델명과 실계정 검증이 남았습니다.

공식 문서: https://docs.langchain.com/oss/javascript/langgraph/quickstart
