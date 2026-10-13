import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort, serverEnv, startServer, testHome } from "./server-harness.mjs";

/**
 * Signing in through an OpenID Connect provider, against a fake one in this
 * process: its discovery document, its keys, its token and userinfo
 * endpoints (the last is there to show that the portal does not ask it). The test plays the browser — it follows the portal to the
 * provider, and comes back with a code the fake provider hands out for an ID
 * token the test made — so that every way an answer can be wrong is tried.
 * Who may sign in is the provider's to say: the portal keeps no list of its own,
 * and lets in every account whose ID token checks out.
 * The portal is set up for it the way a person does it: signed in with the
 * password, under Settings → Authentication.
 */
const { parseOidcConfig, keptForm, safeReturnTo } = await import("../dist/oidc.js");

const CLIENT_ID = "portal-client";
const CLIENT_SECRET = "the-clients-own-secret-0123456789";
const ACCESS_TOKEN = "the-access-token-0123456789";
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
  userinfoCalls: 0,
  meta: {},
  jwksFetches: 0,
};
const idp = http.createServer(async (req, res) => {
  const url = new URL(req.url, issuer);
  let body = "";
  for await (const chunk of req) body += chunk;
  const send = (status, value, type = "application/json") => { res.writeHead(status, { "content-type": type }); res.end(typeof value === "string" ? value : JSON.stringify(value)); };
  if (url.pathname === "/.well-known/openid-configuration") {
    // The same provider under a second name, as one that was given a new host name is.
    const at = (req.headers.host ?? "").startsWith("localhost:") ? `http://localhost:${idpPort}` : issuer;
    return send(200, {
      issuer: at, authorization_endpoint: `${at}/authorize`, token_endpoint: `${at}/token`, jwks_uri: `${at}/jwks`,
      userinfo_endpoint: `${at}/userinfo`, end_session_endpoint: `${at}/logout`,
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
    return send(200, { access_token: ACCESS_TOKEN, token_type: "Bearer", id_token: grant.idToken, refresh_token: "a-refresh-token-0123456789" });
  }
  if (url.pathname === "/userinfo") { provider.userinfoCalls++; return send(401, { error: "invalid_token" }); }
  send(404, { error: "not here" });
});
const idpPort = await freePort();
const issuer = `http://127.0.0.1:${idpPort}`;
await new Promise((resolve) => idp.listen(idpPort, "127.0.0.1", resolve));
after(() => idp.close());

// --- the portal ---

/** What single sign-on under Settings → Authentication is saved with, for a portal on `portalPort`. */
const ssoSettings = (portalPort, extra = {}) => ({
  issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
  redirectUrl: `http://127.0.0.1:${portalPort}/api/auth/oidc/callback`, name: "Example ID",
  endSession: true, ...extra,
});
const portalEnv = { PORTAL_PASSWORD: PASSWORD, PORTAL_ALLOW_NO_PASSWORD: "", PORTAL_SECRET: SECRET };

const passwordLogin = (at, password = PASSWORD) =>
  fetch(`${at}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });

/** Saves the settings as the page does: with the current password, as a login. Answers the response and the cookie it signs this browser in with. */
async function saveSso(at, cookie, settings, { only, current = PASSWORD } = {}) {
  const res = await fetch(`${at}/api/auth/sso`, {
    method: "PUT", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ current, settings, ...(only === undefined ? {} : { only }) }),
  });
  const set = res.headers.getSetCookie().find((c) => c.startsWith("pi_portal_auth="));
  return { res, body: await res.json(), cookie: set ? set.split(";")[0] : cookie };
}

/** A portal with the password moved in from the environment, set up for the fake provider. */
async function ssoPortal(prefix, extra = {}, { only } = {}) {
  const home = testHome(prefix);
  const port = await freePort();
  const started = await startServer(serverEnv(home, port, portalEnv));
  const signedIn = (await passwordLogin(started.base)).headers.getSetCookie()[0].split(";")[0];
  const saved = await saveSso(started.base, signedIn, ssoSettings(port, extra), { only });
  assert.equal(saved.res.status, 200, JSON.stringify(saved.body));
  return { ...started, home, port, admin: saved.cookie };
}

let base;
let home;
let portalPort;
let log = "";
before(async () => {
  const started = await ssoPortal("pithagoras-oidc-");
  ({ base, home, port: portalPort } = started);
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
  email: "someone@example.com", email_verified: true, ...extra,
});
const sign = (claims, { key = keyA.privateKey, kid = "key-a", alg = "RS256" } = {}) =>
  new SignJWT(claims).setProtectedHeader({ alg, kid, typ: "JWT" }).sign(key);

let codes = 0;
/** The browser coming back from the provider with a code for `idToken`. `query` and `cookie` change what it brings. */
async function finish(flow, idToken, { query = {}, cookie = flow.cookie, at = base } = {}) {
  const code = `code-${++codes}`;
  provider.codes.set(code, { idToken, challenge: flow.to.searchParams.get("code_challenge"), redirectUri: flow.to.searchParams.get("redirect_uri") });
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

test("the settings are read as the page sends them, and ones that cannot be right are said", () => {
  const ok = { issuer: "https://id.example.com/realms/home", clientId: "portal", redirectUrl: "https://portal.example.com/api/auth/oidc/callback" };
  const config = parseOidcConfig(ok, false);
  assert.equal(config.redirectUrl.href, "https://portal.example.com/api/auth/oidc/callback");
  assert.equal(config.scopes, "openid email profile");
  assert.equal(config.name, "SSO");
  assert.equal(config.only, false);
  assert.equal(config.clientSecret, undefined, "a public client");
  assert.equal(parseOidcConfig(ok, true).only, true);
  const wrong = (extra, message) => assert.throws(() => parseOidcConfig({ ...ok, ...extra }, false), message);
  wrong({ issuer: "http://id.example.com" }, /must be an https URL/);
  wrong({ issuer: "not a url" }, /not a URL/);
  wrong({ issuer: "" }, /issuer is required/);
  wrong({ clientId: "" }, /client ID is required/);
  wrong({ redirectUrl: "" }, /redirect URL is required/);
  wrong({ redirectUrl: "https://portal.example.com/somewhere-else" }, /followed by \/api\/auth\/oidc\/callback/);
  wrong({ scopes: "email profile" }, /must include openid/);
  wrong({ endSession: "yes" }, /on or off/);
  assert.throws(() => parseOidcConfig(null, false), /not an object/);
  // Plain http for a provider on this machine, to try it out.
  assert.equal(parseOidcConfig({ ...ok, issuer: "http://127.0.0.1:9000" }, false).issuer, "http://127.0.0.1:9000");
  // Settings kept by a portal that still had a list of who may sign in read as before, and are kept without it.
  const old = { ...ok, allowedEmails: ["a@example.com"], allowedGroups: ["admins"], groupsClaim: "roles", allowedSubjects: ["x"] };
  assert.deepEqual(keptForm(parseOidcConfig(old, false)), keptForm(config));
  for (const key of ["allowedEmails", "allowedGroups", "groupsClaim", "allowedSubjects"]) assert.ok(!(key in keptForm(config)), key);
});

test("where a login goes on to is a page of the portal's own, never another origin or an API route", () => {
  assert.equal(safeReturnTo("/sessions/abc?tab=files"), "/sessions/abc?tab=files");
  // Dot segments collapse into `//` once the path is read, so the result is checked as well as what was asked.
  for (const elsewhere of ["//evil.example/x", "/.//evil.example", "/a/..//evil.example/x", "/%2e//evil.example", "/./api/settings", "/API/settings", "/Api", "/\\evil.example", "https://evil.example/", "evil.example", "/\t/evil.example", "/api/settings", "/api", "", undefined, ["/x"], `/${"a".repeat(3000)}`]) {
    assert.equal(safeReturnTo(elsewhere), "/", JSON.stringify(elsewhere));
  }
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

test("any account the provider signs in gets a login: the portal keeps no list of who may, and asks for no more than the ID token", async () => {
  const calls = provider.userinfoCalls;
  // An email nobody has verified, none at all, groups and a subject the portal has never heard of, and a token carrying nothing but the required claims.
  for (const extra of [
    { email: "stranger@example.com", email_verified: false },
    { email: "stranger@example.com", email_verified: undefined },
    { email: undefined, email_verified: undefined },
    { sub: "a-subject-nobody-named", groups: ["some group"] },
    { sub: "another-account", email: undefined, email_verified: undefined, groups: undefined },
  ]) {
    const flow = await begin();
    const claims = Object.fromEntries(Object.entries(claimsFor(flow, extra)).filter(([, v]) => v !== undefined));
    const res = await finish(flow, await sign(claims));
    assert.equal(res.status, 303, `${JSON.stringify(extra)}: ${await res.clone().text()}`);
    assert.equal((await api(cookieNamed(res, AUTH).split(";")[0])).status, 200, JSON.stringify(extra));
  }
  assert.equal(provider.userinfoCalls, calls, "the userinfo endpoint is not asked for claims");
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
  assert.ok(!log.includes(ACCESS_TOKEN), "an access token");
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\./.test(log), "an ID token");
});

const getSso = (cookie, at = base) => fetch(`${at}/api/auth/sso`, { headers: cookie ? { Cookie: cookie } : {} });

test("the settings page is never sent the client secret, and saving asks for the current password", async () => {
  let admin = await signIn();
  assert.equal((await getSso(undefined)).status, 401);
  const shown = await (await getSso(admin)).json();
  assert.equal(shown.mode, "password");
  assert.equal(shown.callbackPath, "/api/auth/oidc/callback");
  assert.equal(shown.settings.hasSecret, true);
  assert.equal(shown.settings.clientSecret, undefined);
  assert.ok(!JSON.stringify(shown).includes(CLIENT_SECRET));
  // No list of who may sign in, nor the claim it was read from.
  assert.deepEqual(Object.keys(shown.settings).sort(), ["clientId", "endSession", "hasSecret", "issuer", "name", "redirectUrl", "scopes"]);

  for (const current of ["", "not the password"]) {
    const { res } = await saveSso(base, admin, ssoSettings(portalPort, { name: "Changed" }), { current });
    assert.equal(res.status, 403, String(current));
  }
  assert.equal((await (await getSso(admin)).json()).settings.name, "Example ID", "nothing was saved");

  // Left out, the secret kept is used again: the provider still takes this client's sign-ins.
  const { clientSecret, ...withoutSecret } = ssoSettings(portalPort);
  let saved = await saveSso(base, admin, withoutSecret);
  assert.equal(saved.res.status, 200);
  assert.equal(saved.body.settings.hasSecret, true);
  admin = saved.cookie;
  await signIn();
  // The same provider and client with a space pasted along: still the same, and the secret is kept.
  saved = await saveSso(base, admin, { ...withoutSecret, issuer: `${issuer} `, clientId: ` ${CLIENT_ID}` });
  assert.equal(saved.res.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.settings.hasSecret, true);
  assert.equal(saved.body.settings.issuer, issuer, "kept trimmed");
  admin = saved.cookie;
  await signIn();
  // But never for another provider or client: it would be sent to them. Nor is it taken as "none", which would make
  // the client a public one the provider refuses: the save says to type it again, or to take it away on purpose.
  const otherIssuer = `http://localhost:${idpPort}`;
  for (const other of [{ clientId: "another-client" }, { issuer: otherIssuer }]) {
    const refusedSave = await saveSso(base, admin, { ...withoutSecret, ...other });
    assert.equal(refusedSave.res.status, 400, JSON.stringify(other));
    assert.match(refusedSave.body.error, /Type the client secret again, or remove it/);
  }
  assert.equal((await (await getSso(admin)).json()).settings.issuer, issuer, "nothing was kept");
  saved = await saveSso(base, admin, { ...withoutSecret, issuer: otherIssuer, clientSecret: null });
  assert.equal(saved.res.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.settings.hasSecret, false);
  saved = await saveSso(base, saved.cookie, ssoSettings(portalPort));
  assert.equal(saved.body.settings.hasSecret, true);
  void clientSecret;
});

test("settings that cannot be right, or a provider that does not answer to them, are refused with the reason and nothing is kept", async () => {
  const admin = await signIn();
  const refusedWith = async (settings, words) => {
    const { res, body } = await saveSso(base, admin, settings);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(body.error, words);
  };
  await refusedWith(ssoSettings(portalPort, { redirectUrl: `http://127.0.0.1:${portalPort}/elsewhere` }), /followed by \/api\/auth\/oidc\/callback/);
  await refusedWith(ssoSettings(portalPort, { issuer: "http://id.example.com" }), /must be an https URL/);
  await refusedWith(ssoSettings(portalPort, { issuer: `http://127.0.0.1:${await freePort()}` }), /discovery document .* could not be read/);
  await refusedWith(ssoSettings(portalPort, { issuer: `${issuer}/` }), /calls itself "http:\/\/127\.0\.0\.1:\d+", not/);
  try {
    provider.meta = { code_challenge_methods_supported: ["plain"] };
    await refusedWith(ssoSettings(portalPort), /does not offer PKCE with S256/);
    provider.meta = { id_token_signing_alg_values_supported: ["HS256", "none"] };
    await refusedWith(ssoSettings(portalPort), /signs ID tokens with HS256, none/);
  } finally {
    provider.meta = {};
  }
  // The admin's login still holds: nothing changed.
  assert.equal((await api(admin)).status, 200);
});

test("a change to the provider ends every other login, and the one who saved it is signed in again; the button's name changes nothing", async () => {
  const other = await signIn();
  const admin = await signIn();
  let saved = await saveSso(base, admin, ssoSettings(portalPort, { name: "Another name" }));
  assert.equal((await api(other)).status, 200, "another name for the button");
  saved = await saveSso(base, saved.cookie, ssoSettings(portalPort, { name: "Example ID" }));
  assert.equal((await api(other)).status, 200, "the same settings again");
  // The same provider under its second name: another issuer.
  saved = await saveSso(base, saved.cookie, ssoSettings(portalPort, { issuer: `http://localhost:${idpPort}` }));
  assert.equal(saved.res.status, 200, JSON.stringify(saved.body));
  assert.equal((await api(other)).status, 401, "another issuer");
  assert.equal((await api(admin)).status, 401, "the cookie it saved with too");
  assert.equal((await api(saved.cookie)).status, 200, "signed in again with the change");
  saved = await saveSso(base, saved.cookie, ssoSettings(portalPort));
  assert.equal(saved.res.status, 200);
  // A new client at the same provider is the way to start over with a narrower set of accounts: it ends the logins too.
  const fromTheOldClient = await signIn();
  saved = await saveSso(base, saved.cookie, ssoSettings(portalPort, { clientId: "a-narrower-client", clientSecret: null }));
  assert.equal(saved.res.status, 200, JSON.stringify(saved.body));
  assert.equal((await api(fromTheOldClient)).status, 401, "another client ID");
  assert.equal((await api(saved.cookie)).status, 200, "signed in again with the change");
  saved = await saveSso(base, saved.cookie, ssoSettings(portalPort));
  assert.equal(saved.res.status, 200);
});

test("a provider that says it names itself in every answer (RFC 9207) has an answer without its name refused", async () => {
  let admin = await signIn();
  provider.meta = { authorization_response_iss_parameter_supported: true };
  try {
    admin = (await saveSso(base, admin, ssoSettings(portalPort))).cookie;
  } finally {
    provider.meta = {};
  }
  let flow = await begin();
  const without = await finish(flow, await sign(claimsFor(flow)));
  assert.equal(without.status, 400);
  assert.equal(cookieNamed(without, AUTH), undefined);
  assert.match(await without.text(), /did not come from/);
  flow = await begin();
  assert.equal((await finish(flow, await sign(claimsFor(flow)), { query: { iss: issuer } })).status, 303);
  // The provider as it was, read again.
  assert.equal((await saveSso(base, admin, ssoSettings(portalPort))).res.status, 200);
});

const SSO_ONLY_OFF = fileURLToPath(new URL("../dist/sso-only-off.js", import.meta.url));
const RESET = fileURLToPath(new URL("../dist/reset-password.js", import.meta.url));
/** Runs one of the server's commands on `at`'s data, answering what it asks with `input`. */
function command(file, at, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { env: serverEnv(at, 0, { PORTAL_ALLOW_NO_PASSWORD: "" }), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

test("OIDC only hides and refuses the password and ends what it signed in; the server command switches it back on after asking", async () => {
  const byPassword = cookieNamed(await passwordLogin(base), AUTH).split(";")[0];
  const saved = await saveSso(base, await signIn(), ssoSettings(portalPort), { only: true });
  assert.equal(saved.res.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.only, true);
  assert.deepEqual(await (await fetch(`${base}/api/auth/status`)).json(), { authRequired: true, authed: false, oidc: { name: "Example ID", only: true } });
  const refusedLogin = await passwordLogin(base);
  assert.equal(refusedLogin.status, 403);
  assert.equal(refusedLogin.headers.getSetCookie().length, 0);
  assert.match((await refusedLogin.json()).error, /switched off\. Sign in with Example ID/);
  assert.equal((await api(byPassword)).status, 401, "a login the password gave");
  assert.equal((await api(saved.cookie)).status, 200);
  const bySso = await signIn();
  assert.equal((await api(bySso)).status, 200, "the provider still signs in");
  // The password itself stays: it is what saving the settings asks for.
  assert.equal((await (await getSso(bySso)).json()).only, true);

  const no = await command(SSO_ONLY_OFF, home, "no\n");
  assert.equal(no.code, 1);
  assert.match(no.out, /signs in through its single sign-on provider only/);
  assert.match(no.out, /Nothing was changed/);
  assert.equal((await passwordLogin(base)).status, 403);

  const yes = await command(SSO_ONLY_OFF, home, "on\n");
  assert.equal(yes.code, 0, yes.out);
  assert.match(yes.out, /The password login is on again/);
  // The running portal takes it at once, and every login ends with it.
  assert.equal((await api(bySso)).status, 401);
  assert.equal((await passwordLogin(base)).status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/auth/status`)).json(), { authRequired: true, authed: false, oidc: { name: "Example ID", only: false } });
  const again = await command(SSO_ONLY_OFF, home, "on\n");
  assert.equal(again.code, 0);
  assert.match(again.out, /nothing to switch back on/);
});

test("a save that leaves OIDC only out keeps it as it is, and only an explicit off switches the password login back on", async () => {
  let saved = await saveSso(base, await signIn(), ssoSettings(portalPort), { only: true });
  assert.equal(saved.body.only, true);
  const bySso = await signIn();
  try {
    // What a script does to rename the button: it sends the settings back and does not mention `only`.
    saved = await saveSso(base, saved.cookie, ssoSettings(portalPort, { name: "Renamed" }));
    assert.equal(saved.res.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.only, true);
    assert.equal((await getSso(saved.cookie).then((r) => r.json())).only, true);
    assert.equal((await passwordLogin(base)).status, 403, "the password login stays off");
    assert.equal((await api(bySso)).status, 200, "nothing about the sign-in changed, so the logins hold");
  } finally {
    saved = await saveSso(base, saved.cookie, ssoSettings(portalPort), { only: false });
  }
  assert.equal(saved.body.only, false);
  assert.equal((await passwordLogin(base)).status, 200);
});

test("saving counts wrong passwords like the sign-in does, and settings refused after the right one not at all", async () => {
  let admin = await signIn();
  // Trial and error with the settings: the password is right each time.
  for (let i = 0; i < 12; i++) {
    const { res } = await saveSso(base, admin, ssoSettings(portalPort, { redirectUrl: `http://127.0.0.1:${portalPort}/elsewhere` }));
    assert.equal(res.status, 400, `try ${i + 1}`);
  }
  const good = await saveSso(base, admin, ssoSettings(portalPort));
  assert.equal(good.res.status, 200, JSON.stringify(good.body));
  admin = good.cookie;
  // Guesses at the password are another thing: the eleventh is not even looked at, nor is the right one after it.
  let last;
  for (let i = 0; i < 11; i++) last = await saveSso(base, admin, ssoSettings(portalPort), { current: `guess ${i}` });
  assert.equal(last.res.status, 429);
  assert.equal((await saveSso(base, admin, ssoSettings(portalPort))).res.status, 429);
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

// --- other portals ---

test("without the portal's password single sign-on does not apply: not on the setup screen, and not where there is no login", async () => {
  const p = await ssoPortal("pithagoras-oidc-setup-");
  try {
    assert.equal((await command(RESET, p.home, "reset\n")).code, 0);
    assert.deepEqual(await (await fetch(`${p.base}/api/auth/status`)).json(), { authRequired: true, authed: false, setup: true });
    const start = await fetch(`${p.base}/api/auth/oidc/start`, { redirect: "manual" });
    assert.equal(start.status, 404);
    assert.match(await start.text(), /not set up on this portal/);
    // A new password, and the provider is offered again, with the settings kept.
    const chosen = await fetch(`${p.base}/api/auth/setup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "a new long password" }) });
    assert.equal(chosen.status, 200);
    const admin = chosen.headers.getSetCookie()[0].split(";")[0];
    assert.deepEqual((await (await fetch(`${p.base}/api/auth/status`)).json()).oidc, { name: "Example ID", only: false });
    // Taken out: the page shows no button, and the routes say so.
    const removed = await saveSso(p.base, admin, null, { current: "a new long password" });
    assert.equal(removed.res.status, 200);
    assert.equal((await (await fetch(`${p.base}/api/auth/status`)).json()).oidc, undefined);
    assert.equal((await fetch(`${p.base}/api/auth/oidc/start`, { redirect: "manual" })).status, 404);
    assert.equal((await fetch(`${p.base}/api/settings`, { headers: { Cookie: removed.cookie } })).status, 200, "the one who took it out stays signed in");
  } finally {
    p.child.kill();
  }

  // A portal with no login at all, by PORTAL_ALLOW_NO_PASSWORD: there is nothing to set up.
  const port = await freePort();
  const open = await startServer(serverEnv(testHome("pithagoras-oidc-open-"), port));
  try {
    assert.equal((await (await getSso(undefined, open.base)).json()).mode, "open");
    const { res } = await saveSso(open.base, "", ssoSettings(port), { current: "anything" });
    assert.equal(res.status, 409);
  } finally {
    open.child.kill();
  }
});
