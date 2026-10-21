import { test, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { PASSWORD, kept, issued, base, sharedPortal, login, cookieOf, signedIn, api, post, statusAt, settingsAt, portalOf } from "./auth-harness.mjs";

/**
 * The login: who gets past it, and what one cookie is worth. Every other test of
 * the server runs without a password; this one runs with it. The tests of the
 * password moved from the environment are in auth-environment.test.mjs, those of
 * the streams a login ends and of starting in auth-streams.test.mjs, and those of
 * the throttle and of the login on an extension's streams in auth-throttle.test.mjs.
 */
sharedPortal();

// --- the API ---

test("what is behind the login answers 401 without it, and the 404 for a route that is not there comes after the login", async () => {
  assert.equal((await api(undefined, "/api/settings")).status, 401);
  assert.equal((await api(undefined, "/api/sessions")).status, 401);
  assert.equal((await api(undefined, "/api/x/test-streams/anything")).status, 401);
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
