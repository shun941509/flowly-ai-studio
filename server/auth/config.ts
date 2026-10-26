/** 인증 환경값을 검증하고 사용 가능한 어댑터를 결정한다. 구성 검사는 SSO 서비스의 연결 성공을 의미하지 않는다. */
export type AuthMode = "unconfigured" | "test" | "oidc" | "sites";
/** 서버 전용 설정이다. sessionSecret·assertionSecret·clientSecret이 있으므로 객체 전체를 화면이나 로그에 노출하지 않는다. */
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
/** 인증 방식은 명시적인 서버 환경값으로만 정한다. 테스트 모드는 로컬 개발/테스트 주소에서만 구성 가능하다. */
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
/** 화면에는 구성 여부와 안내만 전달하고 비밀값은 반환하지 않는다. */
export function authDisplay(config: AuthConfig): AuthDisplay {
  return { mode: config.mode, configured: config.configured, reason: config.reason };
}

/** 외부 이동과 인증 경로의 반복 리다이렉트를 막기 위해 동일 사이트의 상대 경로만 허용한다. */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f]/.test(value)) return "/";
  try {
    const url = new URL(value, "https://flowly.invalid");
    if (url.origin !== "https://flowly.invalid" || url.pathname.startsWith("/api/auth/")
      || ["/signin-with-chatgpt", "/signout-with-chatgpt", "/callback"].includes(url.pathname)) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return "/"; }
}
