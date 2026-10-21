import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { takeHandoff } from "../src/server/handoff.ts";
import { setPortal } from "../src/server/host.ts";
import { openStore, putSettings } from "../src/server/store.ts";
import { scratch } from "../../../tests/helpers.mts";

/**
 * Taking up what the portal kept of Understory when Understory became an extension: its four settings, from a hand-off
 * folder as the upgrade leaves it (core's side is in schema-fingerprint.test.mjs), over a stand-in for the portal whose
 * `handoffs` give the folder from where Understory's data folder has it.
 */

/** Understory's data folder, its store open, and the portal it is given. `take` gives what is in <data>/handoff/<name>. */
function understory() {
  const data = realpathSync(scratch("understory-handoff-"));
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
  return { data, logged, handoff: kept("understory"), stored };
}

const CONFIG = { llm: { source: "custom", baseUrl: "http://gpu:8080/v1", model: "qwen", format: "openai", apiKey: "sk-own" }, dreamInterval: "", dreamAt: "03:00" };
const LAST = { at: "2026-10-22T21:30:00.000Z", ok: true, ran: false, said: "Nothing to do" };
/** As a portal that ran Understory kept them: each as it was stored, text. */
const SETTINGS = { understory_config: JSON.stringify(CONFIG), understory_token: "t".repeat(48), understory_llm_token: "l".repeat(48), understory_last_dream: JSON.stringify(LAST) };

/** A hand-off as the upgrade leaves it. */
function leave(dir: string, settings: Record<string, unknown> = SETTINGS, format = 1) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
  writeFileSync(path.join(dir, "handoff.json"), JSON.stringify({ format, name: "understory", schema: 10, made: new Date().toISOString() }));
}

test("what the portal kept is taken up into Understory's store, and the hand-off is done with", () => {
  const { data, logged, handoff, stored } = understory();
  leave(handoff);
  takeHandoff();
  assert.deepEqual(stored(), { config: CONFIG, token: SETTINGS.understory_token, llmToken: SETTINGS.understory_llm_token, lastDream: LAST });
  assert.equal(statSync(path.join(data, "settings.json")).mode & 0o777, 0o600, "for its owner alone: it holds the tokens and a key");
  assert.equal(existsSync(handoff), false);
  assert.match(logged.join("\n"), /took up what the portal kept of Understory: the settings config, token, llmToken, lastDream/);
});

test("a setting said since, while the hand-off waited, is the person's latest word; one not set, or not JSON where it is JSON, is not taken", () => {
  const { handoff, stored } = understory();
  putSettings({ token: "mine" });
  leave(handoff, { understory_config: "{ not json", understory_token: "t".repeat(48), understory_llm_token: null, understory_last_dream: null });
  takeHandoff();
  assert.deepEqual(stored(), { token: "mine" });
  assert.equal(existsSync(handoff), false);
});

test("a hand-off in another format, or one that cannot be read, is kept for a later Understory, and said", () => {
  const { handoff, logged, data } = understory();
  leave(handoff, SETTINGS, 2);
  takeHandoff();
  assert.equal(existsSync(path.join(handoff, "handoff.json")), true);
  assert.equal(existsSync(path.join(data, "settings.json")), false);
  assert.match(logged.join("\n"), /could not take up what the portal kept of Understory, which is kept for the next start: it is in a format this version of Understory does not read \(2\)/);
  // A settings file cut short: kept too.
  leave(handoff);
  writeFileSync(path.join(handoff, "settings.json"), "{");
  takeHandoff();
  assert.equal(existsSync(path.join(handoff, "settings.json")), true);
});
