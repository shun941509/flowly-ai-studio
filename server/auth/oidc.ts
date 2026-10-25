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
