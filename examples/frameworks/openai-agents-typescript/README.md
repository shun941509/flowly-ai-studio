# 도구로 근거를 확인하는 배송 안내 · OpenAI Agents SDK

프로젝트 `shipment-lookup`의 TypeScript SDK 변형입니다. Python 변형과 동일 프로젝트로 집계합니다. Agent → 읽기 전용 배송 조회 → 도구 결과를 모델에 전달 → 답변을 실제 SDK Runner가 실행합니다. SDK 함수 도구이며 MCP 서버와는 구별합니다.

```powershell
# Node.js 22.13 이상, pnpm 11.25.0
pnpm --ignore-workspace install --frozen-lockfile --ignore-scripts
pnpm --ignore-workspace typecheck
pnpm --ignore-workspace test
Copy-Item .env.example .env
pnpm --ignore-workspace check
pnpm --ignore-workspace start "주문 ORD-2026-001의 배송 상태와 예상일을 알려주세요"
```

로컬 편집기에서 `.env`에 본인 `OPENAI_API_KEY`와 사용 가능한 `FLOWLY_MODEL`을 입력하세요. 함수 호출 지원 모델을 선택하세요. 키는 Flowly 웹·채팅·Git·워크플로 JSON에 넣지 않습니다. `check`는 설정 존재만 확인하며 원격 인증 성공을 뜻하지 않습니다. `start`는 실제 OpenAI를 호출하고 비용이 발생할 수 있습니다. 미설정이면 중단합니다. 추적 업로드는 비활성화했습니다.

`fixtures/shipments.json`은 직접 작성한 CC0-1.0 합성 자료입니다. 실제 파일의 상태와 예정일을 조회하되 실서비스 최신 배송 정보라고 주장하지 않습니다. ORD-2026-001의 결과는 운송 중, 예정일 2026-10-24, 근거 SHIP-001입니다. 없는 주문은 not_found이며 상태 변경을 제공하지 않습니다.

한도: 입력 4,000자, 모델 최대 4턴, 도구 최대 3회, 60초, 출력 800토큰/턴. 현재 결과의 근거 포함은 모델 지침과 테스트로 확인하며 모든 모델의 사실 정확성을 보장하지 않습니다.

실제 SDK를 설치하여 타입 검사와 오프라인 테스트 2개를 통과했습니다. 테스트는 SDK Model에 결정적 응답을 주입하고 실제 도구 호출·다음 턴 전달을 확인합니다. 실제 AI 응답 검증이 아닙니다. 실제 OpenAI/MCP 호출 0회. 사용자 모델 설정과 실계정 검증이 남았습니다.

공식 문서: https://openai.github.io/openai-agents-js/guides/models/
