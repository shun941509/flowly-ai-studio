/** Flowly 세션 종료 화면과 POST 처리. SSO 공급자 계정의 로그인 종료 여부와 로컬 쿠키 삭제를 구분한다. */
import { getAuthConfig } from "../../../../server/auth/environment";
import { safeReturnPath } from "../../../../server/auth/config";
import { sameOriginMutation, sessionCookie } from "../../../../server/auth/session";
import { authPage, authRedirect, escapeHtml } from "../../../../server/auth/http";

export const dynamic = "force-dynamic";
/** GET은 확인 화면만 제공한다. 실제 세션 종료는 동일 출처를 검사하는 POST로 수행한다. */
export function GET(request: Request) {
  const returnTo = safeReturnPath(new URL(request.url).searchParams.get("return_to"));
  return authPage("로그아웃", `<p>이 브라우저의 Flowly 세션을 종료할까요?</p><form method="post" action="/api/auth/signout"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><button type="submit">로그아웃</button></form><p>SSO 공급자 계정의 로그인은 유지될 수 있어요.</p>`);
}
/** 테스트/OIDC는 세션·flow 쿠키를 만료시키고 Sites는 기존 로그아웃 경로로 위임한다. */
export async function POST(request: Request) {
  const config = getAuthConfig();
  if (!sameOriginMutation(config, request)) return authPage("요청 거절", "<p>Flowly 화면에서 다시 로그아웃해 주세요.</p>", 403);
  const raw = await request.text();
  if (raw.length > 2048) return authPage("요청 오류", "<p>요청이 너무 커요.</p>", 413);
  const returnTo = safeReturnPath(new URLSearchParams(raw).get("return_to"));
  if (config.mode === "sites") return authRedirect(`/signout-with-chatgpt?return_to=${encodeURIComponent(returnTo)}`);
  return authRedirect(returnTo, [sessionCookie(config, "", "session", 0), sessionCookie(config, "", "oidc", 0)]);
}
