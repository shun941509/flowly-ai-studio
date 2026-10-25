import { isLoopback, type AuthConfig } from "./config";

export type AuthUser = {
  userId: string; displayName: string; email: string; fullName: string | null;
  emailVerified: true; authProvider: "test" | "oidc" | "sites";
};
export const TEST_IDENTITIES = {
  alice: { userId: "test:alice", displayName: "앨리스 · 테스트", email: "alice@flowly.test", fullName: "앨리스", emailVerified: true, authProvider: "test" },
  bob: { userId: "test:bob", displayName: "밥 · 테스트", email: "bob@flowly.test", fullName: "밥", emailVerified: true, authProvider: "test" },
  carol: { userId: "test:carol", displayName: "캐럴 · 테스트", email: "carol@flowly.test", fullName: "캐럴", emailVerified: true, authProvider: "test" },
} as const satisfies Record<string, AuthUser>;

const encoder = new TextEncoder();
function base64url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid signature encoding");
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
}
async function key(secret: string) {
  if (secret.length < 32) throw new Error("Session signing is not configured");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Fixed HMAC-SHA256 format. Tokens carry no provider credentials or API keys. */
export async function seal(payload: Record<string, unknown>, secret: string): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(body));
  return `${body}.${base64url(new Uint8Array(signature))}`;
}

export async function unseal(token: string | null, secret: string, now = Date.now()): Promise<Record<string, unknown> | null> {
  if (!token || token.length > 12000 || secret.length < 32) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 2 || !await crypto.subtle.verify("HMAC", await key(secret), fromBase64url(parts[1]), encoder.encode(parts[0]))) return null;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(fromBase64url(parts[0])));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const body = parsed as Record<string, unknown>;
    if (typeof body.exp !== "number" || !Number.isFinite(body.exp) || body.exp <= now) return null;
    return body;
  } catch { return null; }
}

export function cookieName(config: AuthConfig, kind: "session" | "oidc" = "session") {
  return `${config.appOrigin.startsWith("https://") ? "__Host-" : ""}flowly_${kind}`;
}
export function readCookie(headers: Headers, name: string): string | null {
  const values = (headers.get("cookie") || "").split(";").map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : null;
}
export function sessionCookie(config: AuthConfig, token: string, kind: "session" | "oidc" = "session", maxAge = 28800): string {
  return `${cookieName(config, kind)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.appOrigin.startsWith("https://") ? "; Secure" : ""}`;
}
export function sessionScope(config: AuthConfig): string {
  return JSON.stringify([config.mode, config.appOrigin, config.issuer, config.clientId]);
}
function validUser(value: unknown, provider: AuthUser["authProvider"]): value is AuthUser {
  if (!value || typeof value !== "object") return false;
  const user = value as Record<string, unknown>;
  return typeof user.userId === "string" && user.userId.length > 0 && user.userId.length <= 300
    && typeof user.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email) && user.email.length <= 254
    && typeof user.displayName === "string" && user.displayName.length <= 200
    && (user.fullName === null || typeof user.fullName === "string" && user.fullName.length <= 200)
    && user.emailVerified === true && user.authProvider === provider;
}

export function allowedRequestOrigin(config: AuthConfig, request: Request): boolean {
  return config.configured && new URL(request.url).origin === config.appOrigin;
}
export function sameOriginMutation(config: AuthConfig, request: Request): boolean {
  return allowedRequestOrigin(config, request) && request.headers.get("origin") === config.appOrigin
    && !["cross-site", "none"].includes(request.headers.get("sec-fetch-site") || "same-origin");
}
export function localTestAllowed(config: AuthConfig, requestHost: string): boolean {
  if (config.mode !== "test" || !config.configured || !["development", "test"].includes(config.environment)) return false;
  try {
    const origin = new URL(config.appOrigin);
    return isLoopback(origin.hostname) && requestHost === origin.host;
  } catch { return false; }
}

export async function issueSession(config: AuthConfig, user: AuthUser, now = Date.now()): Promise<string> {
  if (!config.configured || !validUser(user, config.mode as AuthUser["authProvider"])) throw new Error("Invalid session identity");
  return seal({ kind: "session", scope: sessionScope(config), user, iat: now, exp: now + 8 * 60 * 60 * 1000 }, config.sessionSecret);
}

export async function authenticateHeaders(config: AuthConfig, headers: Headers, now = Date.now()): Promise<AuthUser | null> {
  if (!config.configured) return null;
  // Raw oai-authenticated-* headers are NEVER an authentication mechanism.
  if (config.mode === "sites") {
    const assertion = await unseal(headers.get("x-flowly-sites-assertion"), config.sitesAssertionSecret, now);
    if (!assertion || assertion.kind !== "sites_assertion" || assertion.aud !== config.appOrigin
      || typeof assertion.iat !== "number" || assertion.iat > now + 5000 || assertion.iat < now - 60000
      || Number(assertion.exp) > assertion.iat + 60000 || !validUser(assertion.user, "sites")) return null;
    return assertion.user;
  }
  if (config.mode === "test" && (!localTestAllowed(config, headers.get("host") || "") || headers.has("x-forwarded-for"))) return null;
  const session = await unseal(readCookie(headers, cookieName(config)), config.sessionSecret, now);
  if (!session || session.kind !== "session" || session.scope !== sessionScope(config)
    || typeof session.iat !== "number" || session.iat > now + 5000 || Number(session.exp) > session.iat + 8 * 60 * 60 * 1000
    || !validUser(session.user, config.mode as AuthUser["authProvider"])) return null;
  const user = session.user;
  if (config.mode === "test" && !Object.values(TEST_IDENTITIES).some(identity => identity.userId === user.userId && identity.email === user.email)) return null;
  return user;
}
