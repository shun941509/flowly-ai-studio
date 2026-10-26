/** 로그인 안내 HTML·리다이렉트·로컬 테스트 로그인의 HTTP 경계. 동적 값은 HTML 이스케이프하고 응답은 캐시하지 않는다. */
import { safeReturnPath, type AuthConfig } from "./config";
import { allowedRequestOrigin, issueSession, localTestAllowed, sameOriginMutation, sessionCookie, TEST_IDENTITIES } from "./session";

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
/** content는 호출자가 조립한 HTML이다. 사용자/설정 값을 삽입할 때는 escapeHtml을 거쳐야 한다. */
export function authPage(title: string, content: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Flowly</title><link rel="stylesheet" href="/flowly-auth.css"></head><body><main class="auth-card"><a class="auth-brand" href="/"><img src="/favicon.svg" alt="" width="32" height="32">Flowly</a><h1>${escapeHtml(title)}</h1>${content}<footer><a href="/">Flowly 홈으로</a></footer></main></body></html>`, {
    // Form POSTs under no-referrer send Origin:null in browsers. Keep same-origin
    // metadata so strict CSRF verification works without allowing null origins.
    status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "Referrer-Policy": "same-origin", "X-Content-Type-Options": "nosniff" },
  });
}
/** 인증 이동 응답에 여러 Set-Cookie를 개별 추가한다. 호출자는 이동 주소를 검증하거나 safeReturnPath로 제한한다. */
export function authRedirect(location: string, cookies: string[] = [], status = 303): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status, headers });
}
export function unconfiguredPage(config: AuthConfig): Response {
  return authPage("로그인 연결 필요", `<p>${escapeHtml(config.reason)}</p><p><a href="/demo">체험 워크스페이스 둘러보기</a></p>`, 503);
}
/** 로컬 테스트 모드·요청 주소를 확인한 뒤 고정 사용자 선택만 제공한다. */
export function testLoginPage(config: AuthConfig, request: Request): Response {
  if (!allowedRequestOrigin(config, request) || !localTestAllowed(config, new URL(request.url).host) || request.headers.has("x-forwarded-for")) return authPage("테스트 로그인 사용 불가", "<p>로컬 개발 환경에서만 사용할 수 있어요.</p>", 403);
  const returnTo = safeReturnPath(new URL(request.url).searchParams.get("return_to") || "/studio");
  return authPage("로컬 테스트 로그인", `<div class="auth-test-notice"><strong>로컬 개발 전용 · TEST</strong><p>실제 SSO 인증이 아닌 개발용 계정입니다. 이 서버는 로컬 주소로만 실행해 주세요.</p></div><p class="auth-description">화면과 공유 권한을 확인할 테스트 계정을 선택하세요.</p><form class="auth-accounts" method="post" action="/api/auth/test"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">${Object.entries(TEST_IDENTITIES).map(([id, user]) => `<button type="submit" name="identity" value="${id}"><span>${escapeHtml(user.displayName)}</span><small>${escapeHtml(user.email)}</small><span class="auth-account-arrow" aria-hidden="true">→</span></button>`).join("")}</form>`);
}
/** 동일 출처와 로컬 테스트 조건을 재검사한다. 요청에서 임의 사용자 정보를 받지 않고 고정 테스트 계정으로만 세션을 만든다. */
export async function testLogin(config: AuthConfig, request: Request): Promise<Response> {
  if (!sameOriginMutation(config, request) || !localTestAllowed(config, new URL(request.url).host) || request.headers.has("x-forwarded-for")) return authPage("로그인 요청 거절", "<p>허용되지 않은 테스트 로그인 요청이에요.</p>", 403);
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return authPage("입력 형식 오류", "<p>로그인 화면에서 계정을 선택해 주세요.</p>", 415);
  const raw = await request.text();
  if (raw.length > 2048) return authPage("입력 크기 오류", "<p>로그인 요청이 너무 커요.</p>", 413);
  const form = new URLSearchParams(raw);
  const identity = form.get("identity");
  if (!identity || !Object.hasOwn(TEST_IDENTITIES, identity)) return authPage("계정 선택 필요", "<p>제공된 테스트 계정을 선택해 주세요.</p>", 400);
  const user = TEST_IDENTITIES[identity as keyof typeof TEST_IDENTITIES];
  return authRedirect(safeReturnPath(form.get("return_to") || "/studio"), [sessionCookie(config, await issueSession(config, user))]);
}
