import test from "node:test";
import assert from "node:assert/strict";
import { authDisplay, parseAuthConfig, safeReturnPath } from "../server/auth/config";
import { authenticateHeaders, cookieName, issueSession, localTestAllowed, sameOriginMutation, seal, sessionCookie, TEST_IDENTITIES, unseal } from "../server/auth/session";
import { testLogin, testLoginPage } from "../server/auth/http";
import { userFromVerifiedClaims } from "../server/auth/oidc";

const secret = "test-only-secret-012345678901234567890123456789";
const values = { FLOWLY_AUTH_MODE: "test", FLOWLY_ENV: "test", FLOWLY_APP_ORIGIN: "http://127.0.0.1:3000", FLOWLY_SESSION_SECRET: secret };
const config = parseAuthConfig(values);
const headersFor = (token?: string) => new Headers({ host: "127.0.0.1:3000", ...(token ? { cookie: `${cookieName(config)}=${token}` } : {}) });
const now = 1_800_000_000_000;

test("unconfigured auth ignores spoofed Sites headers", async () => {
  const spoof = new Headers({ "oai-authenticated-user-id": "victim", "oai-authenticated-user-email": "victim@example.com" });
  assert.equal(await authenticateHeaders(parseAuthConfig({}), spoof), null);
  assert.equal(await authenticateHeaders(config, spoof), null);
  assert.equal(parseAuthConfig({ FLOWLY_AUTH_MODE: "sites" }).configured, false);
  assert.equal(JSON.stringify(authDisplay(config)).includes(secret), false);
});

test("test login requires explicit local development configuration", () => {
  assert.equal(config.configured, true);
  for (const override of [
    { FLOWLY_ENV: "production" }, { FLOWLY_ENV: "" }, { FLOWLY_APP_ORIGIN: "https://app.example.com" },
    { FLOWLY_APP_ORIGIN: "http://127.0.0.1:3000/path" }, { FLOWLY_SESSION_SECRET: "short" },
  ]) assert.equal(parseAuthConfig({ ...values, ...override }).configured, false);
  assert.equal(localTestAllowed(config, "app.example.com"), false);
  assert.equal(localTestAllowed(config, "127.0.0.1:3000"), true);
});

test("server-issued sessions isolate all three users and reject modifications or expiry", async () => {
  for (const user of Object.values(TEST_IDENTITIES)) {
    const token = await issueSession(config, user, now);
    assert.equal((await authenticateHeaders(config, headersFor(token), now + 1000))?.userId, user.userId);
    assert.equal(await authenticateHeaders(config, headersFor(`${token}x`), now + 1000), null);
    assert.equal(await authenticateHeaders(config, headersFor(token), now + 8 * 3600 * 1000), null);
    const otherConfig = parseAuthConfig({ ...values, FLOWLY_APP_ORIGIN: "http://localhost:3000" });
    assert.equal(await authenticateHeaders(otherConfig, new Headers({ host: "localhost:3000", cookie: `flowly_session=${token}` }), now), null);
    assert.equal(await unseal(token, `${secret}wrong`, now), null);
  }
});

test("test sessions cannot authenticate arbitrary users or proxy traffic", async () => {
  const arbitrary = await issueSession(config, { ...TEST_IDENTITIES.alice, userId: "victim" }, now);
  assert.equal(await authenticateHeaders(config, headersFor(arbitrary), now), null);
  const valid = headersFor(await issueSession(config, TEST_IDENTITIES.alice, now));
  valid.set("x-forwarded-for", "203.0.113.1");
  assert.equal(await authenticateHeaders(config, valid, now), null);
  const repeated = headersFor();
  repeated.set("cookie", "flowly_session=first; flowly_session=second");
  assert.equal(await authenticateHeaders(config, repeated, now), null);
});

test("test sign-in only accepts fixed identities and same-origin forms", async () => {
  const makeRequest = (body: string, origin = config.appOrigin) => new Request(`${config.appOrigin}/api/auth/test`, {
    method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body,
  });
  const result = await testLogin(config, makeRequest("identity=alice&return_to=%2Fstudio"));
  assert.equal(result.status, 303);
  assert.equal(result.headers.get("location"), "/studio");
  assert.match(result.headers.get("set-cookie") || "", /HttpOnly; SameSite=Lax/);
  assert.equal((await testLogin(config, makeRequest("identity=victim"))).status, 400);
  assert.equal((await testLogin(config, makeRequest("identity=alice", "https://evil.example"))).status, 403);
  assert.equal((await testLogin(config, makeRequest("identity=alice", ""))).status, 403);
  assert.equal((await testLogin(parseAuthConfig({ ...values, FLOWLY_ENV: "production" }), makeRequest("identity=alice"))).status, 403);
  assert.equal(testLoginPage(config, new Request("https://evil.example/api/auth/test")).status, 403);
  assert.equal(testLoginPage(config, new Request(`${config.appOrigin}/api/auth/test`)).headers.get("referrer-policy"), "same-origin");
  assert.equal(sameOriginMutation(config, makeRequest("identity=alice")), true);
});

test("unsafe return paths cannot redirect off-site or enter an auth loop", () => {
  for (const value of ["https://evil.example", "//evil.example", "/\\evil.example", "/api/auth/signin", "/callback", "/signin-with-chatgpt", "/\nevil"]) assert.equal(safeReturnPath(value), "/");
  assert.equal(safeReturnPath("/studio?view=history#runs"), "/studio?view=history#runs");
});

test("Sites adapter requires a short-lived signed verified identity assertion", async () => {
  const sites = parseAuthConfig({ FLOWLY_AUTH_MODE: "sites", FLOWLY_APP_ORIGIN: "https://app.example.com", FLOWLY_SITES_ASSERTION_SECRET: secret });
  const user = { ...TEST_IDENTITIES.alice, userId: "sites:alice", authProvider: "sites" as const };
  const body = { kind: "sites_assertion", aud: sites.appOrigin, iat: now, exp: now + 60000, user };
  const call = async (payload: Record<string, unknown>) => authenticateHeaders(sites, new Headers({ "x-flowly-sites-assertion": await seal(payload, secret) }), now + 1000);
  assert.equal((await call(body))?.userId, "sites:alice");
  assert.equal(await call({ ...body, aud: "https://other.example.com" }), null);
  assert.equal(await call({ ...body, exp: now + 60001 }), null);
  assert.equal(await call({ ...body, user: { ...user, emailVerified: false } }), null);
  assert.equal(await authenticateHeaders(sites, new Headers({ "oai-authenticated-user-id": "alice", "oai-authenticated-user-email": "alice@flowly.test" }), now), null);
});

test("OIDC identity is issuer+subject scoped and requires verified email", async () => {
  const claims = { sub: "1234", email: "Alice@Example.com", email_verified: true, name: "Alice" };
  const first = await userFromVerifiedClaims("https://issuer.example", claims);
  assert.equal(first.email, "alice@example.com");
  assert.equal(first.authProvider, "oidc");
  assert.notEqual((await userFromVerifiedClaims("https://another.example", claims)).userId, first.userId);
  assert.notEqual((await userFromVerifiedClaims("https://issuer.example", { ...claims, sub: "different" })).userId, first.userId);
  for (const value of [false, "true", undefined]) await assert.rejects(userFromVerifiedClaims("https://issuer.example", { ...claims, email_verified: value }));
  await assert.rejects(userFromVerifiedClaims("https://issuer.example", { ...claims, email: "not-an-email" }));
  const oidc = parseAuthConfig({ FLOWLY_AUTH_MODE: "oidc", FLOWLY_APP_ORIGIN: "https://app.example.com", FLOWLY_SESSION_SECRET: secret, OIDC_ISSUER: "https://issuer.example", OIDC_CLIENT_ID: "client", OIDC_CLIENT_SECRET: "secret" });
  assert.equal(oidc.configured, true);
  assert.match(sessionCookie(oidc, "token"), /^__Host-flowly_session=token;.*; Secure$/);
});
