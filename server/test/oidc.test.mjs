import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { ENTRY, freePort, runToEnd, serverEnv, startServer, testHome } from "./server-harness.mjs";

/**
 * Signing in through an OpenID Connect provider, against a fake one in this
 * process: its discovery document, its keys, its token and userinfo
 * endpoints. The test plays the browser — it follows the portal to the
 * provider, and comes back with a code the fake provider hands out for an ID
 * token the test made — so that every way an answer can be wrong is tried.
 */
for (const name of Object.keys(process.env)) if (name.startsWith("OIDC_")) delete process.env[name];
const { readOidcConfig, safeReturnTo, admitted } = await import("../dist/oidc.js");

const CLIENT_ID = "portal-client";
const CLIENT_SECRET = "the-clients-own-secret-0123456789";
const PASSWORD = "correct horse battery";
const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// --- the provider ---

const keyA = await generateKeyPair("RS256");
const keyB = await generateKeyPair("ES256");
const jwkOf = async (pair, kid, alg) => ({ ...(await exportJWK(pair.publicKey)), kid, alg, use: "sig" });
const provider = {
  keys: [await jwkOf(keyA, "key-a", "RS256")],
  /** What a code is redeemed for, and what the token endpoint was asked. */
  codes: new Map(),
  tokenRequests: [],
  userinfo: new Map(),
  meta: {},
  jwksFetches: 0,
};
const idp = http.createServer(async (req, res) => {
  const url = new URL(req.url, issuer);
  let body = "";
  for await (const chunk of req) body += chunk;
  const send = (status, value, type = "application/json") => { res.writeHead(status, { "content-type": type }); res.end(typeof value === "string" ? value : JSON.stringify(value)); };
  if (url.pathname === "/.well-known/openid-configuration") {
    return send(200, {
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
      userinfo_endpoint: `${issuer}/userinfo`, end_session_endpoint: `${issuer}/logout`,
      response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
      id_token_signing_alg_values_supported: ["RS256", "ES256"], token_endpoint_auth_methods_supported: ["client_secret_basic"],
      ...provider.meta,
    });
  }
  if (url.pathname === "/jwks") { provider.jwksFetches++; return send(200, { keys: provider.keys }); }
  if (url.pathname === "/token" && req.method === "POST") {
    const form = Object.fromEntries(new URLSearchParams(body));
    provider.tokenRequests.push({ form, authorization: req.headers.authorization });
    const grant = provider.codes.get(form.code);
    provider.codes.delete(form.code);
    const basic = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
    if (req.headers.authorization !== basic) return send(401, { error: "invalid_client" });
    if (!grant || form.grant_type !== "authorization_code" || form.redirect_uri !== grant.redirectUri) return send(400, { error: "invalid_grant" });
    // PKCE: the verifier must be the one the challenge was made from.
    if (crypto.createHash("sha256").update(form.code_verifier ?? "").digest("base64url") !== grant.challenge) return send(400, { error: "invalid_grant", error_description: "PKCE" });
    return send(200, { access_token: grant.accessToken, token_type: "Bearer", id_token: grant.idToken, refresh_token: "a-refresh-token-0123456789" });
  }
  if (url.pathname === "/userinfo") {
    const info = provider.userinfo.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    return info ? send(200, info) : send(401, { error: "invalid_token" });
  }
  send(404, { error: "not here" });
});
const idpPort = await freePort();
const issuer = `http://127.0.0.1:${idpPort}`;
await new Promise((resolve) => idp.listen(idpPort, "127.0.0.1", resolve));
after(() => idp.close());

// --- the portal ---

const oidcEnv = (portalPort, extra = {}) => ({
  OIDC_ISSUER: issuer, OIDC_CLIENT_ID: CLIENT_ID, OIDC_CLIENT_SECRET: CLIENT_SECRET,
  OIDC_REDIRECT_URL: `http://127.0.0.1:${portalPort}/api/auth/oidc/callback`, OIDC_NAME: "Example ID",
  OIDC_ALLOWED_EMAILS: "Allowed@Example.com", OIDC_ALLOWED_GROUPS: "portal admins", OIDC_ALLOWED_SUBJECTS: "subject-on-the-list",
  OIDC_END_SESSION: "1", PORTAL_ALLOW_NO_PASSWORD: "", PORTAL_SECRET: SECRET,
  ...extra,
});

let base;
let log = "";
before(async () => {
  const port = await freePort();
  const started = await startServer(serverEnv(testHome("pithagoras-oidc-"), port, oidcEnv(port, { PORTAL_PASSWORD: PASSWORD })));
  base = started.base;
  started.child.stdout.on("data", (d) => { log += d; });
  started.child.stderr.on("data", (d) => { log += d; });
});

const cookieNamed = (res, name) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
const AUTH = "pi_portal_auth";
const STATE = "pi_portal_auth_oidc";

/** The browser pressing the button: where the portal sends it, and the state cookie it is given. */
async function begin(returnTo, at = base) {
  const res = await fetch(`${at}/api/auth/oidc/start${returnTo === undefined ? "" : `?returnTo=${encodeURIComponent(returnTo)}`}`, { redirect: "manual" });
  assert.equal(res.status, 303);
  const to = new URL(res.headers.get("location"));
  const set = cookieNamed(res, STATE);
  assert.ok(set, "the state cookie is set");
  return { to, set, cookie: set.split(";")[0], state: to.searchParams.get("state"), nonce: to.searchParams.get("nonce") };
}

const now = () => Math.floor(Date.now() / 1000);
const claimsFor = (flow, extra = {}) => ({
  iss: issuer, aud: CLIENT_ID, sub: "some-user", nonce: flow.nonce, iat: now(), exp: now() + 300,
  email: "allowed@example.com", email_verified: true, ...extra,
});
const sign = (claims, { key = keyA.privateKey, kid = "key-a", alg = "RS256" } = {}) =>
  new SignJWT(claims).setProtectedHeader({ alg, kid, typ: "JWT" }).sign(key);

let codes = 0;
/** The browser coming back from the provider with a code for `idToken`. `query` and `cookie` change what it brings. */
async function finish(flow, idToken, { query = {}, cookie = flow.cookie, accessToken, at = base } = {}) {
  const code = `code-${++codes}`;
  provider.codes.set(code, { idToken, accessToken, challenge: flow.to.searchParams.get("code_challenge"), redirectUri: flow.to.searchParams.get("redirect_uri") });
  const params = new URLSearchParams({ code, state: flow.state, ...query });
  for (const [k, v] of Object.entries(query)) if (v === undefined) params.delete(k);
  return fetch(`${at}/api/auth/oidc/callback?${params}`, { redirect: "manual", headers: cookie ? { Cookie: cookie } : {} });
}

const api = (cookie) => fetch(`${base}/api/settings`, { headers: cookie ? { Cookie: cookie } : {} });

/** A whole sign-in that works. It also clears this address's count of failed attempts, as any login that works does. */
async function signIn(extra = {}) {
  const flow = await begin();
  const res = await finish(flow, await sign(claimsFor(flow, extra)));
  assert.equal(res.status, 303, await res.clone().text());
  return cookieNamed(res, AUTH).split(";")[0];
}

/** A callback the portal refused: the status, the page's words, and no login. */
async function refused(res, status, words, what = "") {
  assert.equal(res.status, status, what);
  assert.equal(cookieNamed(res, AUTH), undefined, `no login cookie ${what}`);
  const page = await res.text();
  if (words) assert.match(page, words, what);
  // Back to nought, so that the next refusal is not the throttle's.
  await signIn();
}

// --- what the portal is told, and says ---

test("the settings are read as the deployment gives them, and one that cannot be right is said at start", () => {
  const env = { OIDC_ISSUER: "https://id.example.com/realms/home", OIDC_CLIENT_ID: "portal", PORTAL_PUBLIC_URL: "https://portal.example.com/" };
  const config = readOidcConfig(env);
  assert.equal(config.redirectUrl.href, "https://portal.example.com/api/auth/oidc/callback", "derived from the public URL");
  assert.equal(config.scopes, "openid email profile");
  assert.equal(config.name, "SSO");
  assert.equal(config.only, false);
  assert.equal(config.clientSecret, undefined, "a public client");
  assert.equal(readOidcConfig({}), null);
  const wrong = (extra, message) => assert.throws(() => readOidcConfig({ ...env, ...extra }), message);
  wrong({ OIDC_ISSUER: "http://id.example.com" }, /must be an https URL/);
  wrong({ OIDC_ISSUER: "not a url" }, /not a URL/);
  wrong({ OIDC_CLIENT_ID: "" }, /OIDC_CLIENT_ID is not/);
  wrong({ PORTAL_PUBLIC_URL: "" }, /set OIDC_REDIRECT_URL/);
  wrong({ OIDC_REDIRECT_URL: "https://portal.example.com/somewhere-else" }, /followed by \/api\/auth\/oidc\/callback/);
  wrong({ OIDC_SCOPES: "email profile" }, /must include openid/);
  // Without a provider, OIDC_ONLY would leave a portal with no login at all.
  assert.throws(() => readOidcConfig({ OIDC_ONLY: "1" }), /OIDC_ONLY is set but OIDC_ISSUER is not/);
  // Plain http for a provider on this machine, to try it out.
  assert.equal(readOidcConfig({ ...env, OIDC_ISSUER: "http://127.0.0.1:9000" }).issuer, "http://127.0.0.1:9000");
});

test("where a login goes on to is a page of the portal's own, never another origin or an API route", () => {
  assert.equal(safeReturnTo("/sessions/abc?tab=files"), "/sessions/abc?tab=files");
  // Dot segments collapse into `//` once the path is read, so the result is checked as well as what was asked.
  for (const elsewhere of ["//evil.example/x", "/.//evil.example", "/a/..//evil.example/x", "/%2e//evil.example", "/./api/settings", "/API/settings", "/Api", "/\\evil.example", "https://evil.example/", "evil.example", "/\t/evil.example", "/api/settings", "/api", "", undefined, ["/x"], `/${"a".repeat(3000)}`]) {
    assert.equal(safeReturnTo(elsewhere), "/", JSON.stringify(elsewhere));
  }
});

test("the allow-list lets in what it names, and an email only once the provider has verified it", () => {
  const config = readOidcConfig({ ...oidcEnv(1), OIDC_ISSUER: "https://id.example.com" });
  assert.equal(admitted({ sub: "subject-on-the-list" }, config), "subject");
  assert.equal(admitted({ sub: "x", email: "ALLOWED@example.com", email_verified: true }, config), "email");
  assert.equal(admitted({ sub: "x", email: "allowed@example.com", email_verified: false }, config), null);
  assert.equal(admitted({ sub: "x", email: "allowed@example.com", email_verified: "true" }, config), null, "a string is not a verification");
  assert.equal(admitted({ sub: "x", email: "allowed@example.com" }, config), null);
  assert.equal(admitted({ sub: "x", groups: ["others", "portal admins"] }, config), "group");
  assert.equal(admitted({ sub: "x", groups: "portal admins" }, config), "group");
  assert.equal(admitted({ sub: "x", groups: ["Portal Admins"] }, config), null, "a group's name is compared as it is");
  const nobody = readOidcConfig({ ...oidcEnv(1), OIDC_ISSUER: "https://id.example.com", OIDC_ALLOWED_EMAILS: "", OIDC_ALLOWED_GROUPS: "", OIDC_ALLOWED_SUBJECTS: "" });
  assert.equal(admitted({ sub: "subject-on-the-list", email: "allowed@example.com", email_verified: true, groups: ["portal admins"] }, nobody), null);
});

test("the login page is told about the provider, and the password still works beside it", async () => {
  assert.deepEqual(await (await fetch(`${base}/api/auth/status`)).json(), { authRequired: true, authed: false, oidc: { name: "Example ID", only: false } });
  const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(res.status, 200);
  assert.equal((await api(cookieNamed(res, AUTH).split(";")[0])).status, 200);
});

// --- the flow ---

test("the button sends the browser to the provider with PKCE, state and nonce, and the answer signs it in", async () => {
  const flow = await begin("/sessions/s1?tab=files");
  assert.equal(flow.to.origin + flow.to.pathname, `${issuer}/authorize`);
  const q = Object.fromEntries(flow.to.searchParams);
  assert.equal(q.response_type, "code");
  assert.equal(q.client_id, CLIENT_ID);
  assert.match(q.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/api\/auth\/oidc\/callback$/);
  assert.equal(q.scope, "openid email profile");
  assert.equal(q.code_challenge_method, "S256");
  assert.match(q.code_challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.match(q.state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(q.nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(q.state, q.nonce);
  assert.match(flow.set, /HttpOnly/i);
  assert.match(flow.set, /SameSite=Lax/i);
  assert.match(flow.set, /Path=\/api\/auth\/oidc\//);
  // Sealed: what the answer must match is not readable in the cookie.
  assert.ok(!flow.set.includes(q.state) && !flow.set.includes(q.nonce));

  const asked = provider.tokenRequests.length;
  const res = await finish(flow, await sign(claimsFor(flow)));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/sessions/s1?tab=files");
  const set = cookieNamed(res, AUTH);
  assert.match(set, /HttpOnly/i);
  assert.match(set, /SameSite=Lax/i);
  assert.doesNotMatch(set, /Secure/i, "plain HTTP");
  assert.match(cookieNamed(res, STATE), /Expires=Thu, 01 Jan 1970/, "the state cookie is cleared");
  const cookie = set.split(";")[0];
  assert.equal((await api(cookie)).status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/auth/status`, { headers: { Cookie: cookie } })).json(), { authRequired: true, authed: true, oidc: { name: "Example ID", only: false } });

  // The provider was asked as a confidential client, with the verifier of the challenge (the fake provider checks it).
  const [request] = provider.tokenRequests.slice(asked);
  assert.equal(request.form.redirect_uri, q.redirect_uri);
  assert.equal(request.form.client_secret, undefined, "the secret goes in the header, not the body");
  assert.ok(request.authorization.startsWith("Basic "));
});

test("an ID token for another client, from another issuer, with another nonce, or run out is refused", async () => {
  const cases = [
    ["another audience", { aud: "someone-else" }],
    ["another issuer", { iss: "https://evil.example" }],
    ["another nonce", { nonce: "not-the-one" }],
    ["run out", { iat: now() - 400, exp: now() - 120 }],
    ["made long ago", { iat: now() - 3600, exp: now() + 300 }],
    ["made in the future", { iat: now() + 600, exp: now() + 900 }],
    ["no nonce", { nonce: undefined }],
    ["no subject", { sub: undefined }],
    ["several audiences, given to another party", { aud: [CLIENT_ID, "other"], azp: "other" }],
  ];
  for (const [what, extra] of cases) {
    const flow = await begin();
    const claims = Object.fromEntries(Object.entries(claimsFor(flow, extra)).filter(([, v]) => v !== undefined));
    await refused(await finish(flow, await sign(claims)), 401, /could not be verified/, what);
  }
});

test("an unsigned token, alg none, one signed with the client secret and one signed with a key the provider never published are refused", async () => {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  let flow = await begin();
  await refused(await finish(flow, `${b64({ alg: "none", typ: "JWT" })}.${b64(claimsFor(flow))}.`), 401);
  flow = await begin();
  await refused(await finish(flow, `${b64({ alg: "RS256", kid: "key-a" })}.${b64(claimsFor(flow))}.`), 401);
  flow = await begin();
  const hmac = await new SignJWT(claimsFor(flow)).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(CLIENT_SECRET));
  await refused(await finish(flow, hmac), 401);
  flow = await begin();
  const stranger = await generateKeyPair("RS256");
  await refused(await finish(flow, await sign(claimsFor(flow), { key: stranger.privateKey, kid: "key-a" })), 401);
  flow = await begin();
  await refused(await finish(flow, await sign(claimsFor(flow), { key: stranger.privateKey, kid: "unknown-key" })), 401);
});

test("an email the provider has not verified, or an account outside the allow-list, gets no login", async () => {
  let flow = await begin();
  await refused(await finish(flow, await sign(claimsFor(flow, { email_verified: false }))), 403, /not one that may use this portal/);
  flow = await begin();
  await refused(await finish(flow, await sign(claimsFor(flow, { email: "stranger@example.com" }))), 403);
  // Allowed by its group, or by its subject, whatever its email.
  assert.ok(await signIn({ email: "stranger@example.com", groups: ["portal admins"] }));
  assert.ok(await signIn({ sub: "subject-on-the-list", email: undefined, email_verified: undefined }));
});

test("claims the ID token leaves out are asked of the userinfo endpoint, for the same subject only", async () => {
  provider.userinfo.set("token-1", { sub: "some-user", email: "allowed@example.com", email_verified: true });
  let flow = await begin();
  let res = await finish(flow, await sign(claimsFor(flow, { email: undefined, email_verified: undefined })), { accessToken: "token-1" });
  assert.equal(res.status, 303);
  assert.ok(cookieNamed(res, AUTH));

  provider.userinfo.set("token-2", { sub: "another-user", email: "allowed@example.com", email_verified: true });
  flow = await begin();
  res = await finish(flow, await sign(claimsFor(flow, { email: undefined, email_verified: undefined })), { accessToken: "token-2" });
  await refused(res, 502);
});

test("an account the ID token lets in already is not turned away by a userinfo endpoint that fails", async () => {
  // Groups are listed and the token has none, but its verified email is on the list: the userinfo endpoint is not asked.
  const flow = await begin();
  const res = await finish(flow, await sign(claimsFor(flow)), { accessToken: "a-token-the-userinfo-endpoint-refuses" });
  assert.equal(res.status, 303, await res.clone().text());
  assert.ok(cookieNamed(res, AUTH));
});

test("an answer is taken once: the same state again is refused, without asking the provider", async () => {
  const flow = await begin();
  const token = await sign(claimsFor(flow));
  assert.equal((await finish(flow, token)).status, 303);
  const asked = provider.tokenRequests.length;
  // The same answer and the same cookie, as a copy of both would be.
  await refused(await finish(flow, token), 400, /used already/);
  assert.equal(provider.tokenRequests.length, asked + 1, "only the sign-in that clears the count asked the provider");
});

test("an answer without the state cookie, with another browser's state, or with a cookie that was changed is refused", async () => {
  let flow = await begin();
  await refused(await finish(flow, await sign(claimsFor(flow)), { cookie: null }), 400, /not started in this browser/);
  // Somebody else's answer, brought to this browser: the login CSRF that state is for.
  const theirs = await begin();
  const mine = await begin();
  await refused(await finish({ ...theirs, cookie: mine.cookie }, await sign(claimsFor(theirs))), 400, /does not belong to this browser/);
  flow = await begin();
  const [name, value] = flow.cookie.split("=");
  const changed = `${name}=${value.slice(0, 20)}${value[20] === "A" ? "B" : "A"}${value.slice(21)}`;
  await refused(await finish(flow, await sign(claimsFor(flow)), { cookie: changed }), 400);
  flow = await begin();
  await refused(await finish(flow, await sign(claimsFor(flow)), { query: { state: undefined } }), 400);
});

test("a provider's refusal, and an answer that names another issuer, are said and give no login", async () => {
  let flow = await begin();
  await refused(await finish(flow, "", { query: { error: "access_denied", error_description: "<b>no</b>" } }), 401, /refused the sign-in \(access_denied\)/);
  flow = await begin();
  await refused(await finish(flow, await sign(claimsFor(flow)), { query: { iss: "https://evil.example" } }), 400, /did not come from/);
  // The one it is: accepted.
  flow = await begin();
  assert.equal((await finish(flow, await sign(claimsFor(flow)), { query: { iss: issuer } })).status, 303);
});

test("a login goes on to the page it was asked from, and never to another origin", async () => {
  for (const [asked, landed] of [["/sessions?x=1", "/sessions?x=1"], ["//evil.example/", "/"], ["/.//evil.example", "/"], ["https://evil.example/", "/"], ["/\\evil.example", "/"], [undefined, "/"]]) {
    const flow = await begin(asked);
    const res = await finish(flow, await sign(claimsFor(flow)));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), landed, String(asked));
  }
});

test("a provider that changes its keys is followed, and a token signed with the key it retired is then refused", async () => {
  provider.keys = [await jwkOf(keyB, "key-b", "ES256")];
  // The portal waits a moment between two fetches of the keys.
  await new Promise((r) => setTimeout(r, 1_200));
  const fetched = provider.jwksFetches;
  const flow = await begin();
  const res = await finish(flow, await sign(claimsFor(flow), { key: keyB.privateKey, kid: "key-b", alg: "ES256" }));
  assert.equal(res.status, 303, await res.clone().text());
  assert.ok(provider.jwksFetches > fetched, "the keys were fetched again");
  const old = await begin();
  const answer = await finish(old, await sign(claimsFor(old)));
  assert.equal(answer.status, 401);
  assert.equal(cookieNamed(answer, AUTH), undefined);
  // The rest of the tests sign with the first key again.
  provider.keys = [await jwkOf(keyA, "key-a", "RS256"), await jwkOf(keyB, "key-b", "ES256")];
  await new Promise((r) => setTimeout(r, 1_200));
  await signIn();
});

test("a sign-in started at another name of the portal starts again at the redirect URL's, where the state cookie will be sent", async () => {
  const port = new URL(base).port;
  // fetch keeps the Host header to itself, so the request is made as a browser at another name would make it.
  const atAnotherName = (route) => new Promise((resolve, reject) => {
    http.get(`${base}${route}`, { headers: { Host: `portal-by-another-name:${port}` } }, (r) => { r.resume(); resolve(r); }).on("error", reject);
  });
  const stateCookie = (r) => (r.headers["set-cookie"] ?? []).find((c) => c.startsWith(`${STATE}=`));
  const res = await atAnotherName(`/api/auth/oidc/start?returnTo=${encodeURIComponent("/sessions")}`);
  assert.equal(res.statusCode, 303);
  assert.equal(stateCookie(res), undefined, "no state cookie for the host the provider does not send the browser back to");
  const to = new URL(res.headers.location);
  assert.equal(to.hostname, "127.0.0.1", "the configured address, not the one the request named");
  assert.equal(to.pathname, "/api/auth/oidc/start");
  assert.equal(to.searchParams.get("returnTo"), "/sessions");
  // Once moved, it goes on, also where a proxy in front still says another name.
  const moved = await atAnotherName("/api/auth/oidc/start?returnTo=%2F&moved=1");
  assert.equal(new URL(moved.headers.location).origin, issuer);
  assert.ok(stateCookie(moved));
  // One without a Host header at all, as HTTP/1.0 may send, is sent there too, rather than failing.
  const bare = await new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), "127.0.0.1", () => socket.end("GET /api/auth/oidc/start?returnTo=%2Fsessions HTTP/1.0\r\n\r\n"));
    let answer = "";
    socket.on("data", (d) => { answer += d; });
    socket.on("end", () => resolve(answer));
    socket.on("error", reject);
  });
  assert.match(bare, /^HTTP\/1\.1 303 /, bare.split("\r\n")[0]);
  assert.match(bare, /\r\nLocation: http:\/\/127\.0\.0\.1:\d+\/api\/auth\/oidc\/start\?returnTo=%2Fsessions&moved=1\r\n/i);
  // A callback without the cookie says where to open the portal.
  const flow = await begin();
  await refused(await finish(flow, await sign(claimsFor(flow)), { cookie: null }), 400, /Open the portal at http:\/\/127\.0\.0\.1:\d+ and start it again/);
});

test("signing out ends the login and names the provider's end of the session", async () => {
  const cookie = await signIn();
  const out = await (await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie } })).json();
  assert.equal(out.ok, true);
  const to = new URL(out.endSession);
  assert.equal(to.origin + to.pathname, `${issuer}/logout`);
  assert.equal(to.searchParams.get("client_id"), CLIENT_ID);
  assert.match(to.searchParams.get("post_logout_redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal((await api(cookie)).status, 401);
});

test("neither the client secret nor a token reaches the log", () => {
  assert.match(log, /signed in through Example ID/);
  assert.match(log, /sign-in through Example ID refused/);
  assert.ok(!log.includes(CLIENT_SECRET), "the client secret");
  assert.ok(!log.includes("a-refresh-token"), "the refresh token");
  assert.ok(!log.includes("token-1"), "an access token");
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\./.test(log), "an ID token");
});

// The last of the shared portal's tests: it leaves this address locked out.
test("failed answers are throttled like wrong passwords", async () => {
  let last;
  for (let i = 0; i < 11; i++) {
    const flow = await begin();
    last = await finish(flow, await sign(claimsFor(flow, { aud: "someone-else" })));
  }
  assert.equal(last.status, 429);
  const flow = await begin();
  assert.equal((await finish(flow, await sign(claimsFor(flow)))).status, 429, "a good answer too, until the window is over");
});

// --- starting ---

const startWith = (extra) => runToEnd([ENTRY], serverEnv(testHome("pithagoras-oidc-start-"), 0, oidcEnv(1, extra)), { ms: 20_000 });

test("a provider that does not answer, calls itself by another name or is plain http elsewhere stops the portal at start", async () => {
  const down = await startWith({ OIDC_ISSUER: `http://127.0.0.1:${await freePort()}` });
  assert.equal(down.code, 1);
  assert.match(down.err, /discovery document .* could not be read/);
  const renamed = await startWith({ OIDC_ISSUER: `${issuer}/` });
  assert.equal(renamed.code, 1);
  assert.match(renamed.err, /calls itself "http:\/\/127\.0\.0\.1:\d+", not/);
  const plain = await startWith({ OIDC_ISSUER: "http://id.example.com" });
  assert.equal(plain.code, 1);
  assert.match(plain.err, /must be an https URL/);
  const only = await runToEnd([ENTRY], serverEnv(testHome("pithagoras-oidc-start-"), 0, { OIDC_ONLY: "1", PORTAL_PASSWORD: PASSWORD, PORTAL_ALLOW_NO_PASSWORD: "" }), { ms: 20_000 });
  assert.equal(only.code, 1);
  assert.match(only.err, /OIDC_ONLY is set but OIDC_ISSUER is not/);
});

test("a provider that offers no PKCE, or signs only with a shared secret, stops the portal at start", async () => {
  try {
    provider.meta = { code_challenge_methods_supported: ["plain"] };
    assert.match((await startWith({})).err, /does not offer PKCE with S256/);
    provider.meta = { id_token_signing_alg_values_supported: ["HS256", "none"] };
    assert.match((await startWith({})).err, /signs ID tokens with HS256, none/);
  } finally {
    provider.meta = {};
  }
});

test("with single sign-on alone the portal starts with no password, OIDC_ONLY refuses the password, and an empty allow-list is said", async () => {
  const port = await freePort();
  const { child, base: there } = await startServer(serverEnv(testHome("pithagoras-oidc-only-"), port, oidcEnv(port, {
    OIDC_ONLY: "1", PORTAL_PASSWORD: PASSWORD, OIDC_ALLOWED_EMAILS: "", OIDC_ALLOWED_GROUPS: "", OIDC_ALLOWED_SUBJECTS: "",
  })));
  assert.deepEqual(await (await fetch(`${there}/api/auth/status`)).json(), { authRequired: true, authed: false, oidc: { name: "Example ID", only: true } });
  const res = await fetch(`${there}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(res.status, 403);
  assert.equal(res.headers.getSetCookie().length, 0);
  assert.equal((await fetch(`${there}/api/settings`)).status, 401);
  child.kill();
  await new Promise((r) => child.once("exit", r));
  const warned = await runToEnd([ENTRY], serverEnv(testHome("pithagoras-oidc-start-"), 0, oidcEnv(1, { OIDC_ALLOWED_EMAILS: "", OIDC_ALLOWED_GROUPS: "", OIDC_ALLOWED_SUBJECTS: "" })), { ms: 10_000 });
  // It started with no password, and was stopped by the timer.
  assert.match(warned.out, /pithagoras listening/, warned.err);
  assert.match(warned.err, /lets nobody in/);
  assert.match(warned.out, /auth: +single sign-on/);
});

test("a provider that says it names itself in every answer (RFC 9207) has an answer without its name refused", async () => {
  provider.meta = { authorization_response_iss_parameter_supported: true };
  const port = await freePort();
  let started;
  try {
    started = await startServer(serverEnv(testHome("pithagoras-oidc-iss-"), port, oidcEnv(port)));
  } finally {
    provider.meta = {};
  }
  const at = started.base;
  let flow = await begin(undefined, at);
  const without = await finish(flow, await sign(claimsFor(flow)), { at });
  assert.equal(without.status, 400);
  assert.equal(cookieNamed(without, AUTH), undefined);
  assert.match(await without.text(), /did not come from/);
  flow = await begin(undefined, at);
  assert.equal((await finish(flow, await sign(claimsFor(flow)), { at, query: { iss: issuer } })).status, 303);
  started.child.kill();
  await new Promise((r) => started.child.once("exit", r));
});

test("with no password to sign in with, a secret that is the guide's old command or short stops the portal at start", async () => {
  for (const secret of ["$(openssl rand -hex 32)", "short-secret"]) {
    const refusedStart = await startWith({ PORTAL_SECRET: secret, PORTAL_PASSWORD: "" });
    assert.equal(refusedStart.code, 1, secret);
    assert.match(refusedStart.err, /the secret is all the login cookie rests on/, secret);
    const only = await startWith({ PORTAL_SECRET: secret, PORTAL_PASSWORD: PASSWORD, OIDC_ONLY: "1" });
    assert.equal(only.code, 1, `${secret}, OIDC_ONLY`);
  }
  // A password in the key, as before single sign-on: the old command is warned about, and the portal starts.
  const port = await freePort();
  const { child } = await startServer(serverEnv(testHome("pithagoras-oidc-secret-"), port, oidcEnv(port, { PORTAL_SECRET: "$(openssl rand -hex 32)", PORTAL_PASSWORD: PASSWORD })));
  child.kill();
  await new Promise((r) => child.once("exit", r));
});

test("switching OIDC_ONLY on ends the logins the password gave", async () => {
  const home = testHome("pithagoras-oidc-switch-");
  const run = async (extra) => {
    const port = await freePort();
    return startServer(serverEnv(home, port, oidcEnv(port, { PORTAL_PASSWORD: PASSWORD, ...extra })));
  };
  const stop = async ({ child }) => { child.kill(); await new Promise((r) => child.once("exit", r)); };
  const first = await run({});
  const res = await fetch(`${first.base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = cookieNamed(res, AUTH).split(";")[0];
  assert.equal((await fetch(`${first.base}/api/settings`, { headers: { Cookie: cookie } })).status, 200);
  await stop(first);
  // A restart that changes nothing keeps it.
  const same = await run({});
  assert.equal((await fetch(`${same.base}/api/settings`, { headers: { Cookie: cookie } })).status, 200, "same settings");
  await stop(same);
  const only = await run({ OIDC_ONLY: "1" });
  assert.equal((await fetch(`${only.base}/api/settings`, { headers: { Cookie: cookie } })).status, 401, "the password is no way in any more");
  await stop(only);
});
