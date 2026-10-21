import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runToEnd, serverEnv, testHome } from "./server-harness.mjs";
import { PASSWORD, auth, security, issued, tls, login, cookieOf, post, statusAt, settingsAt, portalOf, resetPassword, openStream, ends, staysOpen, withStreams, opened } from "./auth-harness.mjs";

/**
 * What a change or a reset of the password ends: the streams open under the old one. A portal that
 * is open by choice or has no password yet, and how the portal starts with its secret (see auth.test.mjs).
 */

test("changing the password ends every event and terminal stream that was open under the old one, also those that share the cookie it was changed with", async () => {
  // With the terminal, an extension a portal starts with.
  const p = await portalOf({ PORTAL_PASSWORD: PASSWORD, PORTAL_DEFAULT_EXTENSIONS: "on" });
  try {
    const mine = cookieOf(await login(PASSWORD, p.base));
    const other = cookieOf(await login(PASSWORD, p.base));
    const chat = (await (await post(p.base, "/api/sessions", {}, mine)).json()).id;
    // The terminal is an extension a fresh portal installs: its stream is ended through the portal's endWithLogin.
    const TERMINAL = "/api/x/pithagoras-terminal/terminal";
    let opened;
    for (const end = Date.now() + 30_000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) {
      opened = await post(p.base, TERMINAL, {}, other);
      if (opened.ok) break;
    }
    assert.equal(opened?.status, 200, "the terminal's server half is running");
    const shell = (await opened.json()).id;
    const streams = {
      // Two streams on one cookie: the browser's own, and one whoever copied the cookie opened. A cookie is a string, so
      // there is nothing to tell them apart by, and neither may outlive the password it was opened under.
      myEvents: await openStream(p.base, mine, `/api/sessions/${chat}/events`),
      copiedEvents: await openStream(p.base, mine, `/api/sessions/${chat}/events`),
      theirEvents: await openStream(p.base, other, `/api/sessions/${chat}/events`),
      theirTerminal: await openStream(p.base, other, `${TERMINAL}/${shell}/stream`),
    };
    const changed = await post(p.base, "/api/auth/password", { current: PASSWORD, password: "the brand new one" }, mine);
    assert.equal(changed.status, 200);
    for (const [name, stream] of Object.entries(streams)) await ends(stream, name);
    // The page opens them again with the cookie of the change, and what it opens from now on is under the new password.
    const again = await openStream(p.base, cookieOf(changed), `/api/sessions/${chat}/events`);
    await staysOpen(again, "a stream opened after the change");
    assert.equal((await fetch(`${p.base}/api/sessions/${chat}/events`, { headers: { Cookie: mine } })).status, 401);
    await fetch(`${p.base}${TERMINAL}/${shell}`, { method: "DELETE", headers: { Cookie: cookieOf(changed) } });
  } finally {
    await p.stop();
  }
});

test("changing the password ends an extension's streams, the changer's too, and a reset ends every stream", async () => {
  const at = testHome("pithagoras-auth-own-");
  const p = await portalOf({ PORTAL_PASSWORD: PASSWORD, ...withStreams(at) }, at);
  const closes = (stream, what) => Promise.race([stream.closed, new Promise((_, no) => setTimeout(() => no(new Error(`${what} is still open`)), 5000))]);
  try {
    const mine = cookieOf(await login(PASSWORD, p.base));
    const other = cookieOf(await login(PASSWORD, p.base));
    const open = (cookie) => opened({ Cookie: cookie }, p.port);
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
    await closes(later, "the extension's stream, after the reset");
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
  const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
  assert.doesNotMatch(example, /PORTAL_PASSWORD/);
});
