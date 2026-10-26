/** OIDC 로그인 왕복과 검증된 사용자 매핑을 담당한다. 원격 토큰은 이 경계 밖으로 반환하지 않는다. */
import * as oauth from "oauth4webapi";
import { safeReturnPath, type AuthConfig } from "./config";
import { cookieName, readCookie, seal, sessionCookie, sessionScope, unseal, type AuthUser } from "./session";

const redirectUri = (config: AuthConfig) => `${config.appOrigin}/api/auth/callback`;
async function discover(config: AuthConfig) {
  if (config.mode !== "oidc" || !config.configured) throw new Error("OIDC is not configured");
  const issuer = new URL(config.issuer);
  const response = await oauth.discoveryRequest(issuer, { signal: AbortSignal.timeout(10000) });
  return oauth.processDiscoveryResponse(issuer, response);
}

/** PKCE·state·nonce를 생성하고 10분짜리 서명 쿠키에 묶어 콜백 요청을 최초 로그인과 연결한다. */
export async function startOidc(config: AuthConfig, returnTo: string) {
  const as = await discover(config);
  if (!as.authorization_endpoint) throw new Error("OIDC authorization endpoint is missing");
  const authorization = new URL(as.authorization_endpoint);
  if (authorization.protocol !== "https:" || authorization.username || authorization.password) throw new Error("Invalid authorization endpoint");
  const verifier = oauth.generateRandomCodeVerifier();
  const state = oauth.generateRandomState();
  const nonce = oauth.generateRandomNonce();
  const flow = await seal({ kind: "oidc_flow", scope: sessionScope(config), verifier, state, nonce,
    returnTo: safeReturnPath(returnTo), exp: Date.now() + 10 * 60 * 1000 }, config.sessionSecret);
  authorization.searchParams.set("client_id", config.clientId);
  authorization.searchParams.set("redirect_uri", redirectUri(config));
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("scope", "openid email profile");
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("nonce", nonce);
  authorization.searchParams.set("code_challenge_method", "S256");
  authorization.searchParams.set("code_challenge", await oauth.calculatePKCECodeChallenge(verifier));
  return { location: authorization.href, cookie: sessionCookie(config, flow, "oidc", 600) };
}

/** 콜백 origin, flow 쿠키, state, PKCE, nonce, ID token 서명을 검증한 뒤 로컬 사용자 정보만 반환한다. */
export async function finishOidc(config: AuthConfig, request: Request): Promise<{ user: AuthUser; returnTo: string }> {
  if (new URL(request.url).origin !== config.appOrigin) throw new Error("Unexpected callback origin");
  const flow = await unseal(readCookie(request.headers, cookieName(config, "oidc")), config.sessionSecret);
  if (!flow || flow.kind !== "oidc_flow" || flow.scope !== sessionScope(config)
    || typeof flow.state !== "string" || typeof flow.nonce !== "string" || typeof flow.verifier !== "string") throw new Error("The login attempt expired");
  const as = await discover(config);
  const client: oauth.Client = { client_id: config.clientId };
  const params = oauth.validateAuthResponse(as, client, new URL(request.url), flow.state);
  const response = await oauth.authorizationCodeGrantRequest(as, client, oauth.ClientSecretPost(config.clientSecret),
    params, redirectUri(config), flow.verifier, { signal: AbortSignal.timeout(10000) });
  const tokens = await oauth.processAuthorizationCodeResponse(as, client, response, { expectedNonce: flow.nonce, requireIdToken: true });
  await oauth.validateApplicationLevelSignature(as, response, { signal: AbortSignal.timeout(10000) });
  const claims = oauth.getValidatedIdTokenClaims(tokens);
  if (!claims) throw new Error("ID token is missing");
  const user = await userFromVerifiedClaims(config.issuer, claims);
  // Provider tokens stay within this request; only the normalized identity enters our session.
  return { user, returnTo: safeReturnPath(typeof flow.returnTo === "string" ? flow.returnTo : "/studio") };
}

/** Only call with the validated ID-token claims returned by oauth4webapi. */
/** 이미 검증된 claim만 입력받는다. issuer+sub의 해시를 사용자 ID로 삼아 이메일이 바뀌어도 소유권 식별을 유지한다. */
export async function userFromVerifiedClaims(issuer: string, claims: Record<string, unknown>): Promise<AuthUser> {
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 500
    || claims.email_verified !== true || typeof claims.email !== "string"
    || claims.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)) {
    throw new Error("A verified SSO email is required");
  }
  const identity = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([issuer, claims.sub])));
  const userId = `oidc:${Array.from(new Uint8Array(identity), byte => byte.toString(16).padStart(2, "0")).join("")}`;
  const email = claims.email.trim().toLowerCase();
  const fullName = typeof claims.name === "string" ? claims.name.trim().slice(0, 200) || null : null;
  return { userId, email, displayName: fullName || email, fullName, emailVerified: true, authProvider: "oidc" };
}
