import { test } from "node:test";
import assert from "node:assert/strict";
import { testHome } from "./server-harness.mjs";
import { PASSWORD, login, cookieOf, post, statusAt, settingsAt, portalOf, resetPassword } from "./auth-harness.mjs";

/**
 * The password of an install from before, which was in the environment and is moved into the
 * database, and the one that is lost and removed by the command (see auth.test.mjs for the login).
 */

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
