export type AuthMode = "unconfigured" | "test" | "oidc" | "sites";
export type AuthConfig = {
  mode: AuthMode;
  environment: string;
  appOrigin: string;
  sessionSecret: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  sitesAssertionSecret: string;
  configured: boolean;
  reason: string;
};

export function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Reads explicit server configuration only; request headers cannot select an adapter. */
export function parseAuthConfig(values: Record<string, unknown>): AuthConfig {
  const value = (key: string) => typeof values[key] === "string" ? String(values[key]).trim() : "";
  const selected = value("FLOWLY_AUTH_MODE");
  const mode: AuthMode = selected === "oidc" || selected === "test" || selected === "sites" ? selected : "unconfigured";
  const result: AuthConfig = {
    mode, environment: value("FLOWLY_ENV") || "production",
    appOrigin: value("FLOWLY_APP_ORIGIN"), sessionSecret: value("FLOWLY_SESSION_SECRET"),
    issuer: value("OIDC_ISSUER"), clientId: value("OIDC_CLIENT_ID"), clientSecret: value("OIDC_CLIENT_SECRET"),
    sitesAssertionSecret: value("FLOWLY_SITES_ASSERTION_SECRET"), configured: false,
    reason: "SSO가 아직 연결되지 않았어요. 관리자에게 로그인 설정을 요청하거나 체험 화면을 이용해 주세요.",
  };
  if (mode === "unconfigured") return result;
  let origin: URL;
  try {
    origin = new URL(result.appOrigin);
    if (origin.origin !== result.appOrigin || origin.username || origin.password) return result;
  } catch { return result; }
  if (mode === "test") {
    if (!["development", "test"].includes(result.environment) || !isLoopback(origin.hostname)
      || !["http:", "https:"].includes(origin.protocol) || result.sessionSecret.length < 32) {
      result.reason = "테스트 로그인에는 로컬 개발 환경, 로컬 주소, 세션 서명 키 설정이 필요해요.";
      return result;
    }
  } else {
    if (origin.protocol !== "https:") return result;
    if (mode === "sites") {
      if (result.sitesAssertionSecret.length < 32) return result;
    } else {
      if (result.sessionSecret.length < 32 || !result.clientId || !result.clientSecret) return result;
      try {
        const issuer = new URL(result.issuer);
        if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash) return result;
      } catch { return result; }
    }
  }
  result.configured = true;
  result.reason = mode === "test" ? "로컬 개발용 테스트 계정이에요. 실제 SSO 인증이 아니에요." : "SSO로 로그인하면 개인 작업 공간을 사용할 수 있어요.";
  return result;
}

export type AuthDisplay = Pick<AuthConfig, "mode" | "configured" | "reason">;
export function authDisplay(config: AuthConfig): AuthDisplay {
  return { mode: config.mode, configured: config.configured, reason: config.reason };
}

export function safeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f]/.test(value)) return "/";
  try {
    const url = new URL(value, "https://flowly.invalid");
    if (url.origin !== "https://flowly.invalid" || url.pathname.startsWith("/api/auth/")
      || ["/signin-with-chatgpt", "/signout-with-chatgpt", "/callback"].includes(url.pathname)) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return "/"; }
}
