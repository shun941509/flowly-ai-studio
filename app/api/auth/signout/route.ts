import { getAuthConfig } from "../../../../server/auth/environment";
import { safeReturnPath } from "../../../../server/auth/config";
import { sameOriginMutation, sessionCookie } from "../../../../server/auth/session";
import { authPage, authRedirect, escapeHtml } from "../../../../server/auth/http";

export const dynamic = "force-dynamic";
export function GET(request: Request) {
  const returnTo = safeReturnPath(new URL(request.url).searchParams.get("return_to"));
  return authPage("로그아웃", `<p>이 브라우저의 Flowly 세션을 종료할까요?</p><form method="post" action="/api/auth/signout"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><button type="submit">로그아웃</button></form><p>SSO 공급자 계정의 로그인은 유지될 수 있어요.</p>`);
}
export async function POST(request: Request) {
  const config = getAuthConfig();
  if (!sameOriginMutation(config, request)) return authPage("요청 거절", "<p>Flowly 화면에서 다시 로그아웃해 주세요.</p>", 403);
  const raw = await request.text();
  if (raw.length > 2048) return authPage("요청 오류", "<p>요청이 너무 커요.</p>", 413);
  const returnTo = safeReturnPath(new URLSearchParams(raw).get("return_to"));
  if (config.mode === "sites") return authRedirect(`/signout-with-chatgpt?return_to=${encodeURIComponent(returnTo)}`);
  return authRedirect(returnTo, [sessionCookie(config, "", "session", 0), sessionCookie(config, "", "oidc", 0)]);
}
