import { getAuthConfig } from "../../../../server/auth/environment";
import { finishOidc } from "../../../../server/auth/oidc";
import { issueSession, sessionCookie } from "../../../../server/auth/session";
import { authPage, authRedirect, unconfiguredPage } from "../../../../server/auth/http";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const config = getAuthConfig();
  if (!config.configured || config.mode !== "oidc") return unconfiguredPage(config);
  const clearFlow = sessionCookie(config, "", "oidc", 0);
  try {
    const result = await finishOidc(config, request);
    return authRedirect(result.returnTo, [sessionCookie(config, await issueSession(config, result.user)), clearFlow]);
  } catch {
    const response = authPage("SSO 로그인 확인 실패", "<p>로그인이 만료되었거나 검증된 이메일을 확인하지 못했어요. 처음부터 다시 로그인해 주세요. 문제가 계속되면 관리자에게 문의해 주세요.</p>", 401);
    response.headers.append("Set-Cookie", clearFlow);
    return response;
  }
}
