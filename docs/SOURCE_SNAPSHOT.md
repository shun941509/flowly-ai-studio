# 기존 소스 스냅샷

기준일: 2026-10-21

- 제품: Flowly AI Workflow Studio
- 기준 커밋: `b84ee49d4c7b381095192f38a899fb21e8e11d5e`
- 기존 화면: https://flowly-ai-studio.shun94.chatgpt.site
- 이 패키지는 해당 커밋의 추적 파일과 새 개발 지침 파일을 포함한다.
- Git 이력, 설치된 의존성, 빌드 출력, 로컬 DB, 사용자 계정 데이터와 실행 로그는 포함하지 않는다.
- 앱의 실행 코드는 기준 커밋 그대로다. 이 패키지에서 새로 추가한 것은 개발 지침이다.

## 확인한 기존 기능과 근거

| 확인 내용 | 근거 파일 |
| --- | --- |
| React 19·TypeScript·Vinext·Workers, pnpm 버전 | `package.json` |
| SSO 로그인과 개인 워크스페이스 | `app/page.tsx`, `app/studio/page.tsx`, `app/chatgpt-auth.ts` |
| 브라우저 로컬 체험 | `app/demo/page.tsx`, `app/ui/studio.tsx` |
| DOM 노드와 SVG 선을 이용한 캔버스 | `app/ui/canvas.tsx` |
| MCP·Skill·Prompt·Document 관리와 공유 UI | `app/ui/resources.tsx` |
| 서버 자료 접근·소유자 검사 | `app/api/studio/route.ts`, `app/lib/model.ts` |
| 그래프 검증과 시뮬레이션 | `app/lib/model.ts`의 `validateGraph()`, `simulateFlow()` |
| D1·Drizzle 스키마 | `db/index.ts`, `db/schema.ts`, `drizzle/` |

현재 조건 노드는 최초 입력에 지정 문자열이 포함되는지 평가한다. 노드 출력 데이터를 기반으로 한 일반적인 분기 엔진은 아직 없다. 현재 순환 그래프는 검증에서 거부한다.

## 별도 배포 시 확인할 사항

1. **인증:** `oai-authenticated-user-id`, `oai-authenticated-user-email`은 기존 Sites 프록시가 제공하는 신뢰된 값이라는 전제가 있다. 일반 인터넷 요청의 같은 이름 헤더를 그대로 신뢰하면 안 된다.
2. **로그인 경로:** `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`은 기존 호스팅 인증 경로다. 소스만 다른 서버에 올린다고 자동으로 제공되지 않는다.
3. **DB:** `cloudflare:workers`의 `env.DB`에 의존한다. Node 서버 또는 다른 DB로 옮기면 DB 어댑터·마이그레이션·공유 쿼리를 조정한다.
4. **빌드:** 일반 Next.js 프로젝트로 취급하지 않는다. 현재 스크립트와 Vinext·Workers 실행 환경을 먼저 확인한다.
5. **호스팅 설정:** `.openai/hosting.json`에는 기존 프로젝트 설정이 포함된다. 다른 환경의 로컬 개발은 이 설정을 근거로 기존 사이트에 배포하지 않는다. 새 배포 대상을 명시적으로 정한다.
6. **실제 실행:** `preview.run`을 단순히 `run`으로 이름만 바꾸지 않는다. 별도 runtime과 실제 연동 검증이 필요하다.

## 검증 기록의 해석

기존 README에는 원래 환경에서 수행한 타입 검사·빌드·권한 API 검사·브라우저 검증 기록이 있다. 이 기록은 새 사용자의 Codex 환경에서 검증했다는 의미가 아니다. 또한 그 검증 과정의 임시 테스트 스크립트 전체가 저장소에 포함된 것은 아니다.

새 환경에서는 `docs/IMPLEMENTATION_PLAN.md`의 P0부터 실행 가능 여부를 다시 확인하고, 후속 기능의 회귀 테스트를 저장소에 남긴다.
