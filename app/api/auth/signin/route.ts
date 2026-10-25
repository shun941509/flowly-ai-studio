import { getAuthConfig } from "../../../../server/auth/environment";
import { safeReturnPath } from "../../../../server/auth/config";
import { allowedRequestOrigin } from "../../../../server/auth/session";
import { authPage, authRedirect, testLoginPage, unconfiguredPage } from "../../../../server/auth/http";
import { startOidc } from "../../../../server/auth/oidc";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const config = getAuthConfig();
  if (!config.configured) return unconfiguredPage(config);
  if (!allowedRequestOrigin(config, request)) return authPage("주소 확인 필요", "<p>설정된 서비스 주소에서 로그인해 주세요.</p>", 400);
  const returnTo = safeReturnPath(new URL(request.url).searchParams.get("return_to") || "/studio");
  if (config.mode === "test") return testLoginPage(config, request);
  if (config.mode === "sites") return authRedirect(`/signin-with-chatgpt?return_to=${encodeURIComponent(returnTo)}`);
  try {
    const login = await startOidc(config, returnTo);
    return authRedirect(login.location, [login.cookie]);
  } catch {
    return authPage("SSO 연결 실패", "<p>로그인 서비스에 연결하지 못했어요. 잠시 후 다시 시도하거나 관리자에게 연결 설정을 확인해 주세요.</p>", 502);
  }
}
