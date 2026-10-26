/** 로컬 테스트 로그인 전용 라우트. 환경·호스트·동일 출처 검사는 공통 auth/http 함수에서 수행하며 운영 우회 로그인을 제공하지 않는다. */
import { getAuthConfig } from "../../../../server/auth/environment";
import { testLogin, testLoginPage } from "../../../../server/auth/http";

export const dynamic = "force-dynamic";
export function GET(request: Request) { return testLoginPage(getAuthConfig(), request); }
export function POST(request: Request) { return testLogin(getAuthConfig(), request); }
