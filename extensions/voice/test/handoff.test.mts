import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { takeHandoff } from "../src/server/handoff.ts";
import { setPortal } from "../src/server/host.ts";
import { openStore, putSettings } from "../src/server/store.ts";
import { scratch } from "../../../tests/helpers.mts";

/**
 * Taking up what the portal kept of the voice service when Voice became an extension: its settings, from a hand-off
 * folder as the upgrade leaves it (core's side is in schema-fingerprint.test.mjs), over a stand-in for the portal whose
 * `handoffs` give the folder from where Voice's data folder has it.
 */

/** Voice's data folder, its store open, and the portal it is given. `take` gives what is in <data>/handoff/<name>. */
function voice() {
  const data = realpathSync(scratch("voice-handoff-"));
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
  return { data, logged, handoff: kept("voice"), stored };
}

/** As friday's portal kept them: a card chosen on the page, no setup under way, and the speech model let go of when idle. */
const SETTINGS = { gpu: "GPU-648bf6c5-346e-81f5-f155-dc8061172da3", setupPending: null, lazyLoad: true };

/** A hand-off as the upgrade leaves it. */
function leave(dir: string, settings: Record<string, unknown> = SETTINGS, format = 1) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
  writeFileSync(path.join(dir, "handoff.json"), JSON.stringify({ format, name: "voice", schema: 9, made: new Date().toISOString() }));
}

test("what the portal kept is taken up into Voice's store, and the hand-off is done with", () => {
  const { data, logged, handoff, stored } = voice();
  leave(handoff);
  takeHandoff();
  assert.deepEqual(stored(), { gpu: SETTINGS.gpu, lazyLoad: true });
  assert.equal(statSync(path.join(data, "settings.json")).mode & 0o777, 0o600, "for its owner alone");
  assert.equal(existsSync(handoff), false);
  assert.match(logged.join("\n"), /took up what the portal kept of the voice service: the settings gpu, lazyLoad/);
  // A setup that had not come up yet is still to come up, and a speech model kept loaded is kept loaded.
  const pending = voice();
  leave(pending.handoff, { gpu: null, setupPending: "1", lazyLoad: false });
  takeHandoff();
  assert.deepEqual(pending.stored(), { setupPending: true, lazyLoad: false });
});

test("a setting said since, while the hand-off waited, is the person's latest word; one that was not set is not set", () => {
  const { handoff, stored } = voice();
  putSettings({ gpu: "GPU-other" });
  leave(handoff, { gpu: SETTINGS.gpu, setupPending: null, lazyLoad: null });
  takeHandoff();
  assert.deepEqual(stored(), { gpu: "GPU-other" });
  assert.equal(existsSync(handoff), false);
});

test("a hand-off in another format, or one that cannot be read, is kept for a later Voice, and said", () => {
  const { handoff, logged, data } = voice();
  leave(handoff, SETTINGS, 2);
  takeHandoff();
  assert.equal(existsSync(path.join(handoff, "handoff.json")), true);
  assert.equal(existsSync(path.join(data, "settings.json")), false);
  assert.match(logged.join("\n"), /could not take up what the portal kept of the voice service, which is kept for the next start: it is in a format this version of Voice does not read \(2\)/);
  // A settings file cut short: kept too.
  leave(handoff);
  writeFileSync(path.join(handoff, "settings.json"), "{");
  takeHandoff();
  assert.equal(existsSync(path.join(handoff, "settings.json")), true);
});

test("nothing handed over is nothing done", () => {
  const { logged, data } = voice();
  takeHandoff();
  assert.deepEqual(logged, []);
  assert.equal(existsSync(path.join(data, "settings.json")), false);
});
