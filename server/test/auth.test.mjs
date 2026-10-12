import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { ENTRY, freePort, inProcessHome, runToEnd, serverEnv, startServer, testHome } from "./server-harness.mjs";

/**
 * The login: who gets past it, and what one cookie is worth. Every other test of
 * the server runs without a password; this one runs with it, in front of the
 * API and in front of the agent's browser, which the portal proxies and signs
 * into for whoever it let in.
 */
const PASSWORD = "correct horse battery";
const SECRET = "a-fixed-secret-for-the-tests";
const home = testHome("pithagoras-auth-");
const BROWSER_PASSWORD = "the-browsers-own-password";

// The same login in this process, on the server's own database, to make the cookies a server would not
// hand out: one that has run out. The password is moved in from the environment, as a server does it.
inProcessHome("pithagoras-auth-in-process-", home);
process.env.PORTAL_PASSWORD = PASSWORD;
process.env.PORTAL_SECRET = SECRET;
const auth = await import("../dist/auth.js");
const security = await import("../dist/http-security.js");
const kept = await import("../dist/password.js");

/** What `issueCookie` sets, taken from a response that is only listening. */
function issued({ secure = false } = {}) {
  let cookie;
  auth.issueCookie({ cookie: (name, value, options) => { cookie = { name, value, options }; }, req: { secure } });
  return cookie;
}

// --- the browser, stood in for: an https server of its own, as the container is ---

const tls = path.join(home, "tls");
mkdirSync(tls);
execFileSync("openssl", [
  "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-subj", "/CN=127.0.0.1",
  "-days", "1", "-keyout", path.join(tls, "key.pem"), "-out", path.join(tls, "cert.pem"),
], { stdio: "ignore" });
const cert = { key: readFileSync(path.join(tls, "key.pem")), cert: readFileSync(path.join(tls, "cert.pem")) };

/** What the stand-in browser was asked, and what it does with an upgrade. */
const browser = { requests: [], upgrades: [], received: "", mode: "accept", release: undefined, socketClosed: undefined };
const upstream = https.createServer(cert, (req, res) => {
  browser.requests.push({ url: req.url, headers: req.headers });
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("the desktop");
});
upstream.on("upgrade", async (req, socket, head) => {
  browser.upgrades.push({ url: req.url, headers: req.headers });
  socket.on("error", () => {});
  browser.socketClosed = new Promise((resolve) => socket.on("close", resolve));
  if (browser.mode === "refuse") return void socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
  if (browser.mode === "slow") await new Promise((resolve) => { browser.release = resolve; });
  browser.received = head.toString();
  socket.on("data", (d) => { browser.received += d; });
  // The greeting follows the headers at once, as a VNC server's does.
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nRFB 003.008\n");
});
const upstreamPort = await freePort();
upstream.listen(upstreamPort, "127.0.0.1");

let base;
let port;
let server;
before(async () => {
  ({ base, child: server, port } = await startServer(serverEnv(home, await freePort(), {
    PORTAL_PASSWORD: PASSWORD, PORTAL_ALLOW_NO_PASSWORD: "", PORTAL_SECRET: SECRET,
    BROWSER_HTTPS_PORT: String(upstreamPort), BROWSER_USER: "agent", BROWSER_PASSWORD,
  })));
});
after(() => upstream.close());

const login = (password = PASSWORD, at = base) =>
  fetch(`${at}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
/** The cookie a login set, as a request header. */
const cookieOf = (res) => (res.headers.getSetCookie()[0] ?? "").split(";")[0];
const signedIn = async () => cookieOf(await login());
const api = (cookie, route = "/api/settings") => fetch(base + route, { headers: cookie ? { Cookie: cookie } : {} });

// --- the API ---

test("what is behind the login answers 401 without it, and the 404 for a route that is not there comes after the login", async () => {
  assert.equal((await api(undefined, "/api/settings")).status, 401);
  assert.equal((await api(undefined, "/api/sessions")).status, 401);
  assert.equal((await api(undefined, "/api/browser")).status, 401);
  assert.equal((await api(undefined, "/api/no-such-route")).status, 401);
  const status = await (await api(undefined, "/api/auth/status")).json();
  assert.deepEqual(status, { authRequired: true, authed: false });
});

test("a wrong password gets no cookie, and the right one gets a cookie that works", async () => {
  const wrong = await login("not the password");
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.getSetCookie().length, 0);

  const right = await login();
  assert.equal(right.status, 200);
  const [set] = right.headers.getSetCookie();
  assert.match(set, /HttpOnly/i);
  assert.match(set, /SameSite=Lax/i);
  assert.doesNotMatch(set, /Secure/i, "plain HTTP: a Secure cookie would never be stored");
  const cookie = cookieOf(right);
  assert.equal((await api(cookie)).status, 200);
  assert.deepEqual(await (await api(cookie, "/api/auth/status")).json(), { authRequired: true, authed: true });
});

test("a cookie with a flipped signature, a stamp that has run out or another login's signature is refused", async () => {
  const [name, value] = (await signedIn()).split("=");
  const [expiry, mac] = value.split(".");
  const flipped = `${mac.slice(0, -1)}${mac.endsWith("0") ? "1" : "0"}`;
  assert.equal((await api(`${name}=${expiry}.${flipped}`)).status, 401, "flipped signature");
  assert.equal((await api(`${name}=${Number(expiry) + 1000}.${mac}`)).status, 401, "a later stamp than the one signed");
  assert.equal((await api(`${name}=${expiry}`)).status, 401, "no signature");
  assert.equal((await api(`${name}=garbage`)).status, 401);

  // One that was good once: made 31 days ago, so it has run out by now.
  const past = Date.now() - 31 * 24 * 60 * 60 * 1000;
  const clock = mock.method(Date, "now", () => past);
  const old = issued();
  clock.mock.restore();
  assert.equal((await api(`${old.name}=${old.value}`)).status, 401, "run out");
  const fresh = issued();
  assert.equal((await api(`${fresh.name}=${fresh.value}`)).status, 200, "the same login, made now");
});

test("signing out refuses the login it ended, also a copy of its cookie", async () => {
  const cookie = await signedIn();
  assert.equal((await api(cookie)).status, 200);
  const out = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie } });
  assert.equal(out.status, 200);
  assert.equal((await api(cookie)).status, 401, "the copy taken before");
  assert.equal((await api(await signedIn())).status, 200, "a new login is another one");
});

// --- choosing, changing and moving the password ---

/** Reads the JSON of a response; the status is for the caller's own assert. */
const post = (at, route, body, cookie) =>
  fetch(`${at}${route}`, { method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const statusAt = async (at, cookie) => (await fetch(`${at}/api/auth/status`, { headers: cookie ? { Cookie: cookie } : {} })).json();
const settingsAt = (at, cookie) => fetch(`${at}/api/settings`, { headers: cookie ? { Cookie: cookie } : {} });

/** A portal of its own, in a home of its own unless one is given: for the tests that change what the shared one must keep. */
async function portalOf(overrides = {}, at = testHome("pithagoras-auth-own-")) {
  const started = await startServer(serverEnv(at, await freePort(), { PORTAL_PASSWORD: "", PORTAL_ALLOW_NO_PASSWORD: "", PORTAL_SECRET: SECRET, ...overrides }));
  // Safe to call again once it has stopped: a test stops it where it restarts, and its `finally` does too.
  const stop = async () => {
    if (started.child.exitCode !== null || started.child.signalCode !== null) return;
    started.child.kill();
    await new Promise((resolve) => started.child.once("exit", resolve));
  };
  return { ...started, home: at, stop };
}

const RESET = fileURLToPath(new URL("../dist/reset-password.js", import.meta.url));
/** Runs the command that removes a lost password on `at`'s data, answering what it asks with `input`. */
function resetPassword(at, input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RESET], { env: serverEnv(at, 0, { PORTAL_ALLOW_NO_PASSWORD: "", ...env }), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

test("a password is kept as a salted scrypt hash that only that password matches, and the older salt:hash form is still read", async () => {
  const a = await kept.hashPassword("hunter2hunter2");
  const b = await kept.hashPassword("hunter2hunter2");
  assert.notEqual(a, b, "each has a salt of its own");
  assert.match(a, /^scrypt:65536:8:2:[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.equal(await kept.passwordMatches("hunter2hunter2", a), true);
  assert.equal(await kept.passwordMatches("hunter2hunter3", a), false);
  assert.equal(await kept.passwordMatches("", a), false);

  // What a portal from before this remembered of its password.
  const salt = crypto.randomBytes(16);
  const legacy = `${salt.toString("hex")}:${crypto.scryptSync("an old one", salt, 32).toString("hex")}`;
  assert.equal(await kept.passwordMatches("an old one", legacy), true);
  assert.equal(await kept.passwordMatches("another", legacy), false);
  // The cost is the one the string names: a hash made at Node's default, as this first was, still reads.
  const cheap = `scrypt:16384:8:1:${salt.toString("hex")}:${crypto.scryptSync("made cheaply", salt, 32).toString("hex")}`;
  assert.equal(await kept.passwordMatches("made cheaply", cheap), true);
  // And one that names a cost that would take gigabytes is a damaged row, not an allocation.
  assert.equal(await kept.passwordMatches("x", `scrypt:1073741824:8:1:${salt.toString("hex")}:${"ab".repeat(32)}`), false);
  // Nothing a damaged row could hold throws, or matches.
  for (const junk of ["", "x", ":", "a:b:c", "scrypt:1:2:3", "scrypt:16384:8:1:zz:zz", "scrypt:3:8:1:aa:bb"]) assert.equal(await kept.passwordMatches("x", junk), false, junk);

  assert.equal(kept.passwordProblem("long enough"), null);
  for (const bad of ["short", "1234567", "change-me", "", undefined, 12345678, null]) assert.match(kept.passwordProblem(bad), /at least 8|example/, String(bad));
});

test("a portal with no password waits on its setup screen, answers nothing else, and the first password chosen signs in", async () => {
  const p = await portalOf();
  try {
    assert.deepEqual(await statusAt(p.base), { authRequired: true, authed: false, setup: true });
    assert.match(p.log(), /No password is set yet/);
    assert.equal((await settingsAt(p.base)).status, 401);
    assert.equal((await post(p.base, "/api/auth/login", { password: "anything at all" })).status, 409, "nothing to sign in with yet");
    assert.equal((await post(p.base, "/api/auth/logout", {})).status, 200);

    // Too short, the example's, or not a string: told why, and still waiting.
    for (const bad of ["short", "1234567", "change-me", "", 12345678, undefined]) {
      const refused = await post(p.base, "/api/auth/setup", { password: bad });
      assert.equal(refused.status, 400, String(bad));
      assert.match((await refused.json()).error, /at least 8|example/);
    }
    assert.equal((await statusAt(p.base)).setup, true);

    const done = await post(p.base, "/api/auth/setup", { password: "a first password" });
    assert.equal(done.status, 200);
    const cookie = cookieOf(done);
    assert.equal((await settingsAt(p.base, cookie)).status, 200, "choosing it signs in");
    assert.deepEqual(await statusAt(p.base, cookie), { authRequired: true, authed: true });

    // Chosen once: nobody can choose another, and the normal login applies.
    assert.equal((await post(p.base, "/api/auth/setup", { password: "another password" })).status, 409);
    assert.equal((await post(p.base, "/api/auth/login", { password: "another password" })).status, 401);
    assert.equal((await settingsAt(p.base)).status, 401);
    assert.equal((await post(p.base, "/api/auth/login", { password: "a first password" })).status, 200);

    // Kept hashed, in the database, and still there when the portal is started again.
    const db = new Database(path.join(p.home, "portal.db"), { readonly: true });
    try {
      const rows = db.prepare("SELECT key, value FROM settings").all();
      assert.match(rows.find((r) => r.key === "portal_password").value, /^scrypt:/);
      assert.ok(rows.every((r) => !r.value.includes("a first password")), "the password itself is nowhere in it");
    } finally {
      db.close();
    }
    await p.stop();
    const again = await portalOf({}, p.home);
    try {
      assert.equal((await statusAt(again.base)).setup, undefined);
      assert.equal((await post(again.base, "/api/auth/login", { password: "a first password" })).status, 200);
      assert.equal((await settingsAt(again.base, cookie)).status, 200, "and the login made before the restart is still good");
    } finally {
      await again.stop();
    }
  } finally {
    await p.stop();
  }
});

test("two passwords chosen at the same moment: the first stands, and the other is told so", async () => {
  const p = await portalOf();
  try {
    const both = await Promise.all(["the first one", "the second one"].map((password) => post(p.base, "/api/auth/setup", { password })));
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
    const won = both[0].status === 200 ? "the first one" : "the second one";
    const lost = won === "the first one" ? "the second one" : "the first one";
    assert.equal((await post(p.base, "/api/auth/login", { password: won })).status, 200);
    assert.equal((await post(p.base, "/api/auth/login", { password: lost })).status, 401);
  } finally {
    await p.stop();
  }
});

test("changing the password needs the current one, applies from then on, and ends every other login", async () => {
  const p = await portalOf({ PORTAL_PASSWORD: PASSWORD });
  const change = (cookie, body) => post(p.base, "/api/auth/password", body, cookie);
  try {
    const mine = cookieOf(await login(PASSWORD, p.base));
    const other = cookieOf(await login(PASSWORD, p.base));
    assert.equal((await change(undefined, { current: PASSWORD, password: "a brand new one" })).status, 401, "nothing to change without a login");
    assert.equal((await change(mine, { current: "not it", password: "a brand new one" })).status, 403, "the wrong current password");
    assert.equal((await change(mine, { password: "a brand new one" })).status, 403, "none at all");
    assert.equal((await change(mine, { current: PASSWORD, password: "short" })).status, 400);
    assert.equal((await change(mine, { current: PASSWORD, password: "change-me" })).status, 400);
    assert.equal((await login("a brand new one", p.base)).status, 401, "none of those changed it");
    assert.equal((await settingsAt(p.base, other)).status, 200);

    const done = await change(mine, { current: PASSWORD, password: "a brand new one" });
    assert.equal(done.status, 200);
    const fresh = cookieOf(done);
    assert.equal((await settingsAt(p.base, fresh)).status, 200, "this browser stays signed in");
    assert.equal((await settingsAt(p.base, mine)).status, 401, "the login it had was made under the old password");
    assert.equal((await settingsAt(p.base, other)).status, 401, "so was the other browser's");
    assert.equal((await login(PASSWORD, p.base)).status, 401, "the old password no longer signs in");
    assert.equal((await login("a brand new one", p.base)).status, 200);

    // The variable of an install from before is not the password any more, however often the portal starts.
    await p.stop();
    const again = await portalOf({ PORTAL_PASSWORD: PASSWORD }, p.home);
    try {
      assert.match(again.log(), /PORTAL_PASSWORD is ignored/);
      assert.equal((await login(PASSWORD, again.base)).status, 401, "the old value of the variable does not sign in");
      assert.equal((await login("a brand new one", again.base)).status, 200);
      assert.equal((await settingsAt(again.base, fresh)).status, 200, "and the login of the change survives the restart");
    } finally {
      await again.stop();
    }
  } finally {
    await p.stop();
  }
});

test("the password of an install from before is moved into the database once, and the variable is ignored from then on", async () => {
  const p = await portalOf({ PORTAL_PASSWORD: "the one from .env" });
  try {
    assert.match(p.log(), /PORTAL_PASSWORD was moved into the portal's database/);
    assert.equal((await login("the one from .env", p.base)).status, 200);
    await p.stop();

    // Still in .env: said nothing more, as the database holds the same.
    const same = await portalOf({ PORTAL_PASSWORD: "the one from .env" }, p.home);
    assert.doesNotMatch(same.log(), /moved|ignored/);
    assert.equal((await login("the one from .env", same.base)).status, 200);
    await same.stop();

    // Taken out of .env: the database keeps it.
    const gone = await portalOf({}, p.home);
    assert.doesNotMatch(gone.log(), /moved|ignored/);
    assert.equal((await login("the one from .env", gone.base)).status, 200);
    await gone.stop();

    // A value that is not the password in the database is no password, and is said to be ignored.
    const other = await portalOf({ PORTAL_PASSWORD: "some other value" }, p.home);
    try {
      assert.match(other.log(), /PORTAL_PASSWORD is ignored/);
      assert.equal((await login("some other value", other.base)).status, 401);
      assert.equal((await login("the one from .env", other.base)).status, 200);
    } finally {
      await other.stop();
    }
  } finally {
    await p.stop();
  }
});

test("a PORTAL_PASSWORD shorter than the minimum is moved only by a portal that has been used, and is then flagged until it is changed", async () => {
  const home = testHome("pithagoras-auth-kept-");
  // An install from before the minimum: it has been used, under a password that is short.
  const before = await portalOf({ PORTAL_ALLOW_NO_PASSWORD: "1" }, home);
  assert.equal((await post(before.base, "/api/sessions", {})).status, 200);
  await before.stop();

  const old = await portalOf({ PORTAL_PASSWORD: "oldpass" }, home);
  try {
    assert.match(old.log(), /was moved/);
    // Said to a login, not to whoever asks: it would name the password to guess.
    assert.deepEqual(await statusAt(old.base), { authRequired: true, authed: false });
    const cookie = cookieOf(await login("oldpass", old.base));
    assert.deepEqual(await statusAt(old.base, cookie), { authRequired: true, authed: true, shortPassword: true });
    await old.stop();

    // The flag is kept with the password, not with the variable.
    const again = await portalOf({}, home);
    try {
      assert.match(again.log(), /shorter than 8 characters/);
      const next = cookieOf(await login("oldpass", again.base));
      assert.equal((await statusAt(again.base, next)).shortPassword, true);
      // A new one has to be long, and when it is, the flag goes.
      assert.equal((await post(again.base, "/api/auth/password", { current: "oldpass", password: "newpass" }, next)).status, 400);
      const changed = await post(again.base, "/api/auth/password", { current: "oldpass", password: "a long enough one" }, next);
      assert.equal(changed.status, 200);
      assert.deepEqual(await statusAt(again.base, cookieOf(changed)), { authRequired: true, authed: true });
    } finally {
      await again.stop();
    }
    const last = await portalOf({}, home);
    try {
      assert.doesNotMatch(last.log(), /shorter than 8/);
      assert.deepEqual(await statusAt(last.base, cookieOf(await login("a long enough one", last.base))), { authRequired: true, authed: true });
    } finally {
      await last.stop();
    }
  } finally {
    await old.stop();
  }
});

test("a PORTAL_PASSWORD that is the example or too short for a portal that is new is not the password: the setup screen is shown", async () => {
  for (const value of ["change-me", "short", "1234567"]) {
    const p = await portalOf({ PORTAL_PASSWORD: value });
    try {
      assert.match(p.log(), /not taken as the password/, value);
      assert.deepEqual(await statusAt(p.base), { authRequired: true, authed: false, setup: true }, value);
      assert.equal((await post(p.base, "/api/auth/login", { password: value })).status, 409, value);
    } finally {
      await p.stop();
    }
  }
});

test("a lost password is removed by the reset command, after asking, from a running portal too, and a restart does not bring the old variable back", async () => {
  const p = await portalOf({ PORTAL_PASSWORD: PASSWORD });
  try {
    const cookie = cookieOf(await login(PASSWORD, p.base));
    assert.equal((await settingsAt(p.base, cookie)).status, 200);

    // Anything but the word, or no answer at all, changes nothing.
    for (const input of ["no\n", "", "y\n"]) {
      const kept = await resetPassword(p.home, input);
      assert.equal(kept.code, 1, JSON.stringify(input));
      assert.match(kept.out, /Nothing was changed/);
      assert.equal((await settingsAt(p.base, cookie)).status, 200, JSON.stringify(input));
    }

    const done = await resetPassword(p.home, "reset\n");
    assert.equal(done.code, 0, done.out);
    assert.match(done.out, /Type reset to remove it/);
    // No restart: the running portal is waiting on its setup screen at once, and every login is gone.
    assert.deepEqual(await statusAt(p.base, cookie), { authRequired: true, authed: false, setup: true });
    assert.equal((await settingsAt(p.base, cookie)).status, 401);
    assert.equal((await post(p.base, "/api/auth/login", { password: PASSWORD })).status, 409);
    assert.match((await resetPassword(p.home, "reset\n")).out, /no password to remove/);

    // The variable is still in .env: it is not the password again after a restart.
    await p.stop();
    const again = await portalOf({ PORTAL_PASSWORD: PASSWORD }, p.home);
    try {
      assert.match(again.log(), /PORTAL_PASSWORD is ignored/);
      assert.equal((await statusAt(again.base)).setup, true);
      assert.equal((await post(again.base, "/api/auth/login", { password: PASSWORD })).status, 409);
      // And a new one is chosen on the setup screen, as on a new install.
      const chosen = await post(again.base, "/api/auth/setup", { password: "chosen after the reset" });
      assert.equal(chosen.status, 200);
      assert.equal((await settingsAt(again.base, cookieOf(chosen))).status, 200);
      assert.equal((await settingsAt(again.base, cookie)).status, 401, "the login from before the reset stays dead");
    } finally {
      await again.stop();
    }
  } finally {
    await p.stop();
  }

  const nothing = await resetPassword(testHome("pithagoras-auth-reset-empty-"), "reset\n");
  assert.equal(nothing.code, 1);
  assert.match(nothing.out, /no portal database/);
});

/** A stream open on a portal, read in the background: `ended` says whether the portal has closed it. */
async function openStream(at, cookie, route, method = "GET") {
  const res = await fetch(`${at}${route}`, { method, headers: { Cookie: cookie } });
  assert.equal(res.status, 200, route);
  const stream = { ended: false };
  (async () => {
    try { for await (const chunk of res.body) void chunk; } catch { /* reset */ }
    stream.ended = true;
  })();
  return stream;
}
// The command that removes a password is another process: the portal finds out on a timer of two seconds.
const ends = async (stream, what) => {
  for (let end = Date.now() + 10_000; !stream.ended && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stream.ended, true, `${what} was not ended`);
};
const staysOpen = async (stream, what) => {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal(stream.ended, false, what);
};

test("changing the password ends every event and terminal stream that was open under the old one, also those that share the cookie it was changed with", async () => {
  const p = await portalOf({ PORTAL_PASSWORD: PASSWORD });
  try {
    const mine = cookieOf(await login(PASSWORD, p.base));
    const other = cookieOf(await login(PASSWORD, p.base));
    const chat = (await (await post(p.base, "/api/sessions", {}, mine)).json()).id;
    const shell = (await (await post(p.base, "/api/terminal", {}, other)).json()).id;
    const streams = {
      // Two streams on one cookie: the browser's own, and one whoever copied the cookie opened. A cookie is a string, so
      // there is nothing to tell them apart by, and neither may outlive the password it was opened under.
      myEvents: await openStream(p.base, mine, `/api/sessions/${chat}/events`),
      copiedEvents: await openStream(p.base, mine, `/api/sessions/${chat}/events`),
      theirEvents: await openStream(p.base, other, `/api/sessions/${chat}/events`),
      theirTerminal: await openStream(p.base, other, `/api/terminal/${shell}/stream`),
    };
    const changed = await post(p.base, "/api/auth/password", { current: PASSWORD, password: "the brand new one" }, mine);
    assert.equal(changed.status, 200);
    for (const [name, stream] of Object.entries(streams)) await ends(stream, name);
    // The page opens them again with the cookie of the change, and what it opens from now on is under the new password.
    const again = await openStream(p.base, cookieOf(changed), `/api/sessions/${chat}/events`);
    await staysOpen(again, "a stream opened after the change");
    assert.equal((await fetch(`${p.base}/api/sessions/${chat}/events`, { headers: { Cookie: mine } })).status, 401);
    await fetch(`${p.base}/api/terminal/${shell}`, { method: "DELETE", headers: { Cookie: cookieOf(changed) } });
  } finally {
    await p.stop();
  }
});

test("changing the password ends the agent's browser streams, the changer's too, and a reset ends every stream", async () => {
  const p = await portalOf({ PORTAL_PASSWORD: PASSWORD, BROWSER_HTTPS_PORT: String(upstreamPort), BROWSER_USER: "agent", BROWSER_PASSWORD });
  const closes = (stream, what) => Promise.race([stream.closed, new Promise((_, no) => setTimeout(() => no(new Error(`${what} is still open`)), 5000))]);
  try {
    browser.mode = "accept";
    const mine = cookieOf(await login(PASSWORD, p.base));
    const other = cookieOf(await login(PASSWORD, p.base));
    const open = async (cookie) => {
      const stream = upgrade({ Cookie: cookie }, "", "/browser-ui/websockify", p.port);
      await until(() => stream.text().includes("RFB 003.008"), "the stream open");
      return stream;
    };
    const theirs = await open(other);
    const own = await open(mine);
    const copied = await open(mine);
    const changed = await post(p.base, "/api/auth/password", { current: PASSWORD, password: "the brand new one" }, mine);
    assert.equal(changed.status, 200);
    await closes(theirs, "the other login's stream");
    await closes(own, "the stream of the login that changed it");
    await closes(copied, "the stream another holder of that cookie opened");

    // Removed by the command, which is another process: every stream goes, one opened under the new password too.
    const chat = (await (await post(p.base, "/api/sessions", {}, cookieOf(changed))).json()).id;
    const events = await openStream(p.base, cookieOf(changed), `/api/sessions/${chat}/events`);
    const later = await open(cookieOf(changed));
    assert.equal((await resetPassword(p.home, "reset\n")).code, 0);
    await ends(events, "the event stream, after the reset");
    await closes(later, "the browser stream, after the reset");
  } finally {
    await p.stop();
  }
});

test("a password that is removed from a portal that also has PORTAL_ALLOW_NO_PASSWORD never opens it: it waits on the setup screen, on the address it was bound to", async () => {
  const p = await portalOf({ PORTAL_PASSWORD: PASSWORD, PORTAL_ALLOW_NO_PASSWORD: "1" });
  // An address of this machine that is not the loopback one, where there is one: the portal is bound to every address for its login.
  const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
  const where = [p.base, ...(lan ? [`http://${lan}:${p.port}`] : [])];
  try {
    for (const at of where) assert.equal((await settingsAt(at)).status, 401, `a login is asked for at ${at}`);
    const cookie = cookieOf(await login(PASSWORD, p.base));
    assert.equal((await settingsAt(p.base, cookie)).status, 200);

    // The command is told what a restart does here, and does not say there is a setup screen where there will be none.
    const asked = await resetPassword(p.home, "no\n", { PORTAL_ALLOW_NO_PASSWORD: "1" });
    assert.match(asked.out, /started again with no password runs with no login at all/);
    const done = await resetPassword(p.home, "reset\n", { PORTAL_ALLOW_NO_PASSWORD: "1" });
    assert.equal(done.code, 0, done.out);
    assert.match(done.out, /waiting on its setup screen[^]*before the portal is restarted/);

    for (const at of where) {
      assert.deepEqual(await statusAt(at), { authRequired: true, authed: false, setup: true }, at);
      assert.equal((await settingsAt(at)).status, 401, `still not open at ${at}`);
      assert.equal((await post(at, "/api/sessions", {})).status, 401, `nor to a request that changes things at ${at}`);
      assert.equal((await settingsAt(at, cookie)).status, 401, "and the login from before is gone");
    }
    assert.equal((await post(p.base, "/api/auth/login", { password: PASSWORD })).status, 409);
    // The setup screen is what is there, and works as it does on a new install.
    const chosen = await post(p.base, "/api/auth/setup", { password: "chosen after the reset" });
    assert.equal(chosen.status, 200);
    assert.equal((await settingsAt(p.base, cookieOf(chosen))).status, 200);
    assert.equal((await settingsAt(p.base)).status, 401);

    // Only a start with neither a password nor a way to choose one is open by choice, and that is loopback only.
    await resetPassword(p.home, "reset\n");
    await p.stop();
    const restarted = await portalOf({ PORTAL_ALLOW_NO_PASSWORD: "1" }, p.home);
    try {
      assert.deepEqual(await statusAt(restarted.base), { authRequired: false, authed: true });
      if (lan) await assert.rejects(fetch(`http://${lan}:${restarted.port}/api/auth/status`), "bound to this machine only");
    } finally {
      await restarted.stop();
    }
  } finally {
    await p.stop();
  }
});

test("wrong current passwords sent to the change route are held back after ten, on a count of their own, and the right one is held back too", async () => {
  const p = await portalOf({ PORTAL_PASSWORD: PASSWORD });
  try {
    const cookie = cookieOf(await login(PASSWORD, p.base));
    const change = (current) => post(p.base, "/api/auth/password", { current, password: "a brand new one" }, cookie);
    for (let i = 1; i <= 10; i++) assert.equal((await change(`guess ${i}`)).status, 403, `guess ${i}`);
    const held = await change("guess 11");
    assert.equal(held.status, 429);
    assert.ok(Number(held.headers.get("retry-after")) > 0);
    // Whoever holds the cookie cannot walk on to the password by trying again, nor can the person with the right one until the window is over.
    assert.equal((await change(PASSWORD)).status, 429);
    assert.equal((await login(PASSWORD, p.base)).status, 200, "the login has a count of its own");
    // Nothing was changed by any of it.
    assert.equal((await login("a brand new one", p.base)).status, 401);
  } finally {
    await p.stop();
  }
});

test("PORTAL_ALLOW_NO_PASSWORD still runs without a login, and then there is no password to choose or change", async () => {
  const p = await portalOf({ PORTAL_ALLOW_NO_PASSWORD: "1" });
  try {
    assert.deepEqual(await statusAt(p.base), { authRequired: false, authed: true });
    assert.equal((await settingsAt(p.base)).status, 200);
    assert.equal((await post(p.base, "/api/auth/login", { password: "x" })).status, 200);
    assert.equal((await post(p.base, "/api/auth/setup", { password: "a first password" })).status, 409);
    assert.equal((await post(p.base, "/api/auth/password", { current: "x", password: "a first password" })).status, 409);
    assert.match(p.log(), /PORTAL_ALLOW_NO_PASSWORD is set/);
  } finally {
    await p.stop();
  }
  // A password the portal has, with the choice set as well, is a login like any other.
  const both = await portalOf({ PORTAL_ALLOW_NO_PASSWORD: "1", PORTAL_PASSWORD: PASSWORD });
  try {
    assert.deepEqual(await statusAt(both.base), { authRequired: true, authed: false });
    assert.equal((await settingsAt(both.base)).status, 401);
  } finally {
    await both.stop();
  }
});

test("the portal listens on every interface once it has a login or is waiting for one, and on this machine only where it is open by choice", () => {
  const { allowNoPassword, bindHost } = security;
  // Open by choice is only ever what PORTAL_ALLOW_NO_PASSWORD says, never what an empty or missing password falls back to.
  const choice = (value) => {
    const was = process.env.PORTAL_ALLOW_NO_PASSWORD;
    process.env.PORTAL_ALLOW_NO_PASSWORD = value;
    try { return allowNoPassword(); } finally { if (was === undefined) delete process.env.PORTAL_ALLOW_NO_PASSWORD; else process.env.PORTAL_ALLOW_NO_PASSWORD = was; }
  };
  assert.deepEqual(["", "0", "no", "1", "true", "YES"].map(choice), [false, false, false, true, true, true]);
  assert.equal(bindHost(true, undefined), "0.0.0.0");
  assert.equal(bindHost(false, undefined), "127.0.0.1");
  assert.equal(bindHost(false, "1"), "0.0.0.0");
});

test("the cookie is Secure where the portal serves TLS, and only there", () => {
  assert.equal(issued().options.secure, false);
  assert.equal(issued({ secure: true }).options.secure, true, "a request that came in over TLS");
  process.env.PORTAL_TLS_CERT = path.join(tls, "cert.pem");
  process.env.PORTAL_TLS_KEY = path.join(tls, "key.pem");
  try {
    assert.equal(issued().options.secure, true);
    let cleared;
    auth.signOut({ cookies: {} }, { clearCookie: (name, options) => { cleared = options; }, req: { secure: false } });
    assert.equal(cleared.secure, true, "clearing it has to match how it was set");
  } finally {
    delete process.env.PORTAL_TLS_CERT;
    delete process.env.PORTAL_TLS_KEY;
  }
  assert.equal(issued().options.secure, false);
});

// --- starting ---

test("a secret that is a shell command, as a .env written from the old guide holds, is warned about", async () => {
  // Only the module that holds the secret is loaded, so that it ends once it has said so.
  const start = (secret) => runToEnd(["--input-type=module", "-e", `await import(${JSON.stringify(new URL("../dist/auth.js", import.meta.url).href)});`], serverEnv(testHome("pithagoras-auth-secret-"), 0, { PORTAL_SECRET: secret }), { ms: 20_000 });
  const copied = await start("$(openssl rand -hex 32)");
  assert.match(copied.err, /PORTAL_SECRET is a shell command/);
  const real = await start("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  assert.doesNotMatch(real.err, /PORTAL_SECRET/);
});

test("the example environment file ships no password for anyone to find, and none to set", () => {
  // `cp .env.example .env` and `docker compose up` is the quick start: the password is chosen in the browser.
  const example = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
  assert.doesNotMatch(example, /PORTAL_PASSWORD/);
});

// --- the login throttle ---

const attempts = (limiter, address, times) => {
  let through = 0;
  let refused = 0;
  const res = { setHeader() {}, status() { refused++; return this; }, json() {}, on() {} };
  for (let i = 0; i < times; i++) limiter({ socket: { remoteAddress: address } }, res, () => through++);
  return { through, refused };
};

test("an IPv6 /64 is one address to the throttle, and a mapped IPv4 address is the IPv4 one", () => {
  const { throttleKey } = security;
  assert.equal(throttleKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), throttleKey("2001:db8:1:2::1"));
  assert.equal(throttleKey("2001:db8:1:2::1"), throttleKey("2001:0db8:0001:0002:ffff::"));
  assert.notEqual(throttleKey("2001:db8:1:2::1"), throttleKey("2001:db8:1:3::1"));
  assert.equal(throttleKey("::1"), throttleKey("0:0:0:0:5::7"));
  assert.equal(throttleKey("::ffff:10.0.0.7"), "10.0.0.7");
  assert.equal(throttleKey("192.0.2.5"), "192.0.2.5");
  assert.equal(throttleKey(undefined), "unknown");

  // Eleven attempts, each from another address of one block: the eleventh is refused.
  const limiter = security.loginThrottle();
  const block = Array.from({ length: 11 }, (_, i) => `2001:db8:5:6:${i.toString(16)}::1`);
  const seen = block.map((address) => attempts(limiter, address, 1));
  assert.equal(seen.filter((r) => r.refused).length, 1, "the one that was one too many");
  assert.equal(attempts(limiter, "2001:db8:5:7::1", 1).through, 1, "the next block is not affected");
});

test("when the throttle is full, the oldest entry makes room and a new address still gets its attempts", () => {
  const limiter = security.loginThrottle();
  for (let i = 0; i < 4096; i++) attempts(limiter, `10.${i >> 8}.${i & 255}.1`, 1);
  // Every one of the 4096 has an attempt on record: the owner, from a 4097th
  // address, must not be locked out because of them.
  assert.deepEqual(attempts(limiter, "198.51.100.9", 1), { through: 1, refused: 0 });
  // And the first of them was the one that made room.
  assert.deepEqual(attempts(limiter, "10.0.0.1", 10), { through: 10, refused: 0 });
});

test("a locked address stays locked however many others pass through a full throttle", () => {
  const limiter = security.loginThrottle();
  const attacker = "2001:db8:0:1::1";
  assert.deepEqual(attempts(limiter, attacker, 10), { through: 10, refused: 0 });
  assert.equal(attempts(limiter, attacker, 1).refused, 1, "locked after ten");
  // 4096 other blocks fail once each: the map is full and the attacker is its oldest entry.
  for (let i = 0; i < 4096; i++) attempts(limiter, `2001:db8:1:${i.toString(16)}::1`, 1);
  assert.equal(attempts(limiter, attacker, 1).refused, 1, "evicting the lock would be ten more guesses for 4096 others");
  // The ones that failed once are what makes room, so a newcomer still gets in.
  assert.deepEqual(attempts(limiter, "198.51.100.9", 1), { through: 1, refused: 0 });
});

test("when every entry of a full throttle is locked, a newcomer is refused rather than a lock dropped", () => {
  const limiter = security.loginThrottle();
  for (let i = 0; i < 4096; i++) attempts(limiter, `10.${i >> 8}.${i & 255}.1`, 10);
  assert.equal(attempts(limiter, "198.51.100.9", 1).refused, 1);
  assert.equal(attempts(limiter, "10.0.0.1", 1).refused, 1, "and nobody's lock is gone");
});

test("addresses that stop at nine and let 4096 others push them out are held to the window's budget", () => {
  const limiter = security.loginThrottle();
  // 4097 addresses take turns, each with nine wrong logins and then out of the way: none is ever locked, and
  // each comes back to a count of nothing. Without a budget for the window every round is as free as the first.
  let through = 0;
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 4097; i++) through += attempts(limiter, `2001:db8:${(i + 1).toString(16)}::1`, 9).through;
  }
  // The window's budget, the last attempt of each one in the map at that moment, and the nine of the one that found it spent.
  assert.ok(through <= 4096 * 10 + 4096 + 9, `${through} guesses in one window`);
  // And a newcomer is told to wait, which the window's end undoes.
  assert.equal(attempts(limiter, "198.51.100.9", 1).refused, 1);
});

test("the window's budget is a fresh one when the window is over", () => {
  let clock = 1_000_000;
  const limiter = security.loginThrottle(() => clock);
  for (let i = 0; i < 4097; i++) attempts(limiter, `10.${i >> 8}.${i & 255}.1`, 9);
  for (let i = 0; i < 500; i++) attempts(limiter, `172.16.${i >> 8}.${i & 255}`, 9);
  assert.equal(attempts(limiter, "198.51.100.9", 1).refused, 1, "the budget is spent");
  clock += 15 * 60_000 + 1;
  assert.deepEqual(attempts(limiter, "198.51.100.9", 1), { through: 1, refused: 0 }, "and it is new once the window is over");
});

// --- the agent's browser ---

/** A request for the upgrade to a stream, as a browser makes it, with `after` as the bytes the page sends first. */
function upgrade(headers = {}, after = "", url = "/browser-ui/websockify", at = port) {
  const socket = net.connect(at, "127.0.0.1");
  let text = "";
  socket.on("data", (d) => { text += d; });
  // Refused and closed on is what some of these are about; the answer is what is read.
  socket.on("error", () => {});
  const lines = [
    `GET ${url} HTTP/1.1`, `Host: 127.0.0.1:${at}`, "Connection: Upgrade", "Upgrade: websocket",
    "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
  ];
  // One write, so that what follows the headers arrives with them, as it does from a browser.
  socket.write(`${lines.join("\r\n")}\r\n\r\n${after}`);
  const closed = new Promise((resolve) => socket.once("close", resolve));
  return { socket, text: () => text, closed };
}
const until = async (check, what) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.fail(`never: ${what}`);
};
const basic = (user, password) => "Basic " + Buffer.from(`${user}:${password}`).toString("base64");

test("the browser page and its stream are behind the login: nothing reaches the browser without it", async () => {
  browser.requests.length = browser.upgrades.length = 0;
  const page = await fetch(`${base}/browser-ui/`);
  assert.equal(page.status, 401);
  assert.doesNotMatch(await page.text(), /the desktop/);

  const stream = upgrade();
  await until(() => stream.text().includes("\r\n\r\n"), "an answer");
  assert.match(stream.text(), /^HTTP\/1\.1 401 /);
  stream.socket.destroy();
  const wrong = upgrade({ Cookie: `${issued().name}=9999999999999.00` });
  await until(() => wrong.text().includes("\r\n\r\n"), "an answer to a made-up cookie");
  assert.match(wrong.text(), /^HTTP\/1\.1 401 /);
  wrong.socket.destroy();

  assert.deepEqual([browser.requests.length, browser.upgrades.length], [0, 0], "the browser was never asked");
});

test("an upgrade that is not the browser's is answered and closed, not held open for whoever sent it", async () => {
  browser.upgrades.length = 0;
  // Nothing else takes upgrades, so each of these is the portal's to answer: the page, the API, and the browser's prefix in other letters.
  for (const url of ["/", "/api/sessions", "/browser-uifoo", "/BROWSER-UI/websockify"]) {
    const stream = upgrade({}, "", url);
    await until(() => stream.text().includes("\r\n\r\n"), `an answer to ${url}`);
    assert.match(stream.text(), url.startsWith("/BROWSER") ? /^HTTP\/1\.1 401 / : /^HTTP\/1\.1 404 /, url);
    // Closed from the portal's side too, with the client still connected.
    await Promise.race([stream.closed, new Promise((_, reject) => setTimeout(() => reject(new Error(`${url} was left open`)), 3000))]);
  }
  assert.equal(browser.upgrades.length, 0, "and nothing went to the browser");
});

/** Whether the server process itself still holds the connection a client opened from `clientPort`, which is what a left-open one costs it. */
function heldByServer(clientPort) {
  const hex = (n) => n.toString(16).toUpperCase().padStart(4, "0");
  let inode;
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of readFileSync(file, "utf8").split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length > 9 && f[1].endsWith(`:${hex(port)}`) && f[2].endsWith(`:${hex(clientPort)}`)) inode = f[9];
    }
  }
  // A connection nobody holds any more is listed with no inode: the kernel's, waiting out its own timeout.
  if (!inode || inode === "0") return false;
  return readdirSync(`/proc/${server.pid}/fd`).some((fd) => {
    try {
      return readlinkSync(`/proc/${server.pid}/fd/${fd}`) === `socket:[${inode}]`;
    } catch {
      return false;
    }
  });
}

test("clients that reset the connection while an upgrade is refused do not take the portal down", async () => {
  // Written, and reset as soon as the bytes are out: the answer the portal then writes meets a closed connection.
  const resets = [];
  for (const url of ["/", "/browser-ui/websockify", "/browser-ui/websockify"]) {
    for (let i = 0; i < 30; i++) {
      resets.push(new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1");
        socket.on("error", () => {});
        socket.on("close", resolve);
        socket.write(
          [`GET ${url} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "", ""].join("\r\n"),
          () => socket.resetAndDestroy(),
        );
      }));
    }
  }
  await Promise.all(resets);
  // Whatever the portal did with them, it is the same portal, and it answers.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(server.exitCode, null, "the portal is still running");
  assert.equal((await fetch(`${base}/api/auth/status`)).status, 200);
});

test("a refused upgrade whose client keeps its side open is let go of after a few seconds", { skip: process.platform !== "linux" }, async () => {
  const client = net.connect({ port, host: "127.0.0.1", allowHalfOpen: true });
  let text = "";
  client.on("data", (d) => { text += d; });
  client.on("error", () => {});
  client.write([`GET /api/sessions HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "", ""].join("\r\n"));
  try {
    await until(() => text.includes("\r\n\r\n"), "an answer");
    assert.match(text, /^HTTP\/1\.1 404 /);
    // Answered and closed on the portal's side; ours is never closed. The portal has it until it gives up.
    assert.equal(heldByServer(client.localPort), true, "the portal still has the connection just after the answer");
    // It gives up after five seconds; a loaded machine may be later than that.
    for (let end = Date.now() + 20_000; heldByServer(client.localPort) && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(heldByServer(client.localPort), false, "and no longer once it has given up");
  } finally {
    client.destroy();
  }
});

test("signed in, the page is the browser's, with the browser's own login added and the portal's left out", async () => {
  browser.requests.length = 0;
  const cookie = await signedIn();
  const page = await fetch(`${base}/browser-ui/vnc.html?x=1`, { headers: { Cookie: `${cookie}; other=1`, Authorization: basic("someone", "else") } });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "the desktop");
  assert.equal(page.headers.get("content-security-policy"), "frame-ancestors 'self'", "only the portal's own pages may frame it");
  const [seen] = browser.requests;
  assert.equal(seen.url, "/vnc.html?x=1");
  assert.equal(seen.headers.authorization, basic("agent", BROWSER_PASSWORD), "the client's own credentials are not passed on");
  assert.equal(seen.headers.cookie, undefined, "the portal's login stays with the portal");
});

test("a stream of another site's page is refused, and the one of the portal's own is passed on, each side's first bytes to the other", async () => {
  const cookie = await signedIn();
  browser.upgrades.length = 0;
  const foreign = upgrade({ Cookie: cookie, Origin: "https://elsewhere.example" });
  await until(() => foreign.text().includes("\r\n\r\n"), "an answer to another site's page");
  assert.match(foreign.text(), /^HTTP\/1\.1 403 /);
  foreign.socket.destroy();
  assert.equal(browser.upgrades.length, 0);

  browser.mode = "accept";
  const mine = upgrade({ Cookie: `${cookie}; other=1`, Origin: `http://127.0.0.1:${port}`, Authorization: basic("someone", "else") }, "client-first");
  await until(() => mine.text().includes("RFB 003.008"), "the container's greeting reaching the page");
  assert.match(mine.text(), /^HTTP\/1\.1 101 /);
  await until(() => browser.received.includes("client-first"), "the page's first bytes reaching the container");
  assert.doesNotMatch(mine.text(), /client-first/, "not sent back to where they came from");
  assert.doesNotMatch(browser.received, /RFB/, "nor the container's");
  const [seen] = browser.upgrades;
  assert.equal(seen.url, "/websockify");
  assert.equal(seen.headers.authorization, basic("agent", BROWSER_PASSWORD));
  assert.equal(seen.headers.cookie, undefined);
  mine.socket.destroy();
  await browser.socketClosed;
});

test("behind a reverse proxy that rewrites Host, the page of the host it was asked for is accepted, and another site's still is not", async () => {
  const cookie = await signedIn();
  browser.mode = "accept";
  browser.upgrades.length = 0;
  // Host is the portal's own address behind the proxy; the page's origin is what the visitor typed.
  const asked = { Cookie: cookie, "X-Forwarded-Host": "portal.example" };
  const mine = upgrade({ ...asked, Origin: "https://portal.example" });
  await until(() => mine.text().includes("RFB 003.008"), "the stream of the page behind the proxy");
  assert.match(mine.text(), /^HTTP\/1\.1 101 /);
  mine.socket.destroy();
  await browser.socketClosed;

  // The default port of the scheme is the same host, and a list of proxies names the visitor's first.
  const withPort = upgrade({ Cookie: cookie, "X-Forwarded-Host": "portal.example:443, inner.proxy:8080", Origin: "https://portal.example" });
  await until(() => withPort.text().includes("RFB 003.008"), "the stream with the port spelled out");
  withPort.socket.destroy();
  await browser.socketClosed;

  browser.upgrades.length = 0;
  for (const origin of ["https://elsewhere.example", "https://portal.example.elsewhere.example", "null"]) {
    const foreign = upgrade({ ...asked, Origin: origin });
    await until(() => foreign.text().includes("\r\n\r\n"), `an answer to ${origin}`);
    assert.match(foreign.text(), /^HTTP\/1\.1 403 /, origin);
    foreign.socket.destroy();
  }
  // A forwarded host that is no address does not stand for anything.
  const tricked = upgrade({ Cookie: cookie, "X-Forwarded-Host": "elsewhere.example@portal.example", Origin: "https://elsewhere.example" });
  await until(() => tricked.text().includes("\r\n\r\n"), "an answer to a made-up host");
  assert.match(tricked.text(), /^HTTP\/1\.1 403 /);
  tricked.socket.destroy();
  assert.equal(browser.upgrades.length, 0, "the browser was never asked");
});

test("a stream the browser refuses is answered, not left waiting", async () => {
  const cookie = await signedIn();
  browser.mode = "refuse";
  try {
    const stream = upgrade({ Cookie: cookie });
    await until(() => stream.text().includes("\r\n\r\n"), "an answer");
    assert.match(stream.text(), /^HTTP\/1\.1 401 /);
    stream.socket.destroy();
  } finally {
    browser.mode = "accept";
  }
});

test("a visitor who leaves during the handshake takes the portal's request to the browser with them", async () => {
  const cookie = await signedIn();
  browser.mode = "slow";
  browser.upgrades.length = 0;
  try {
    const stream = upgrade({ Cookie: cookie });
    await until(() => browser.release, "the browser being asked");
    // Gone as a closed tab or a lost connection is: not with a goodbye.
    stream.socket.resetAndDestroy();
    // Without being answered: the portal lets go of the request when its visitor has gone.
    await Promise.race([browser.socketClosed, new Promise((_, no) => setTimeout(() => no(new Error("the browser is still being asked for a stream nobody is waiting for")), 3000))]);
  } finally {
    browser.release?.();
    browser.release = undefined;
    browser.mode = "accept";
  }
  assert.equal((await api(cookie)).status, 200, "and the portal is still there");
});
