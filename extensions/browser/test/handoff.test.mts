import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { takeHandoff } from "../src/server/handoff.ts";
import { setPortal } from "../src/server/host.ts";
import { openStore, putSettings } from "../src/server/store.ts";
import { scratch } from "../../../tests/helpers.mts";

/**
 * Taking up what the portal kept of the browser when Browser became an extension: its settings and the local Chrome's
 * profile, from a hand-off folder as the upgrade leaves it (core's side is in schema-fingerprint.test.mjs), over a
 * stand-in for the portal whose `handoffs` give the folder from where Browser's data folder has it.
 */

/** Browser's data folder, its store open, and the portal it is given. `take` gives what is in <data>/handoff/<name>. */
function browser() {
  const data = realpathSync(scratch("browser-handoff-"));
  const logged: string[] = [];
  const kept = (name: string) => path.join(data, "handoff", name);
  setPortal({
    log: (line: string) => logged.push(line),
    dataDir: () => data,
    handoffs: {
      take: (name: string) => (existsSync(kept(name)) ? kept(name) : undefined),
      done: (name: string) => rmSync(kept(name), { recursive: true, force: true }),
    },
  } as any);
  openStore(data);
  const stored = () => JSON.parse(readFileSync(path.join(data, "settings.json"), "utf8"));
  return { data, logged, handoff: kept("browser"), stored };
}

const SETTINGS = { browser_user: null, browser_password: "kept-secret", browser_port: null, browser_https_port: "4443", browser_cursor: "0", browser_tools: "1" };

/** A hand-off as the upgrade leaves it, with a local profile where `profile` says what is in it. */
function leave(dir: string, settings: Record<string, string | null> = SETTINGS, { format = 1, profile }: { format?: number; profile?: Record<string, string> } = {}) {
  mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(profile ?? {})) {
    mkdirSync(path.dirname(path.join(dir, "profile", rel)), { recursive: true });
    writeFileSync(path.join(dir, "profile", rel), text);
  }
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
  writeFileSync(path.join(dir, "handoff.json"), JSON.stringify({ format, name: "browser", schema: 8, made: new Date().toISOString() }));
}

test("what the portal kept is taken up: the settings in Browser's store, the profile in Browser's folder, and the hand-off is done with", () => {
  const { data, logged, handoff, stored } = browser();
  leave(handoff, SETTINGS, { profile: { "Default/Cookies": "logins" } });
  takeHandoff();
  // The password the container was made with, and the proxy opens its UI with; the cursor that was off, and the tools that were connected.
  assert.deepEqual(stored(), { password: "kept-secret", httpsPort: "4443", cursor: false, connected: true });
  assert.equal(statSync(path.join(data, "settings.json")).mode & 0o777, 0o600, "for its owner alone");
  assert.equal(readFileSync(path.join(data, "profile", "Default", "Cookies"), "utf8"), "logins");
  assert.equal(existsSync(handoff), false);
  assert.match(logged.join("\n"), /took up what the portal kept of the browser: the settings password, httpsPort, cursor, connected and the local Chrome's profile/);
});

test("a setting said since, while the hand-off waited, is the person's latest word; one that was not set is not set", () => {
  const { handoff, stored } = browser();
  putSettings({ password: "said-since", connected: false });
  leave(handoff, { ...SETTINGS, browser_cursor: null, browser_tools: "0" });
  takeHandoff();
  assert.deepEqual(stored(), { password: "said-since", connected: false, httpsPort: "4443" });
});

test("tools that were switched off stay off, and a cursor that was on is on", () => {
  const { handoff, stored } = browser();
  leave(handoff, { ...SETTINGS, browser_cursor: "1", browser_tools: "0" });
  takeHandoff();
  assert.deepEqual(stored(), { password: "kept-secret", httpsPort: "4443", cursor: true, connected: false });
});

test("a profile Browser has already stays the browser's, and the one handed over is kept beside it", () => {
  const { data, handoff, logged } = browser();
  mkdirSync(path.join(data, "profile"));
  writeFileSync(path.join(data, "profile", "mine"), "since");
  leave(handoff, { ...SETTINGS, browser_password: null, browser_https_port: null, browser_cursor: null, browser_tools: null }, { profile: { "Default/Cookies": "logins" } });
  const { made } = JSON.parse(readFileSync(path.join(handoff, "handoff.json"), "utf8"));
  takeHandoff();
  assert.deepEqual(readdirSync(path.join(data, "profile")), ["mine"]);
  const beside = `profile-handed-over-${made.replace(/:/g, "-")}`;
  assert.equal(readFileSync(path.join(data, beside, "Default", "Cookies"), "utf8"), "logins", "not lost with the hand-off");
  assert.equal(existsSync(handoff), false);
  assert.equal(existsSync(path.join(data, "settings.json")), false, "nothing to keep, so nothing written");
  assert.match(logged.join("\n"), new RegExp(`took up what the portal kept of the browser: the local Chrome's profile, kept as ${beside.replace(/\./g, "\\.")} beside the one Browser had$`, "m"));
});

test("nothing at all is a hand-off with nothing to take, and no hand-off says nothing", () => {
  const { data, handoff, logged } = browser();
  leave(handoff, { ...SETTINGS, browser_password: null, browser_https_port: null, browser_cursor: null, browser_tools: null });
  takeHandoff();
  assert.equal(existsSync(path.join(data, "settings.json")), false, "nothing to keep, so nothing written");
  assert.deepEqual(readdirSync(data).filter((name) => name.startsWith("profile")), []);
  assert.match(logged.join("\n"), /took up what the portal kept of the browser$/m);

  logged.length = 0;
  takeHandoff();
  assert.deepEqual(logged, []);
});

test("a hand-off in a format this version does not read is kept for the next start, and said", () => {
  const { handoff, logged, data } = browser();
  leave(handoff, SETTINGS, { format: 2 });
  takeHandoff();
  assert.equal(existsSync(handoff), true);
  assert.equal(existsSync(path.join(data, "settings.json")), false);
  assert.match(logged.join("\n"), /could not take up what the portal kept of the browser, which is kept for the next start: it is in a format this version of Browser does not read \(2\)/);
});
