import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { takeHandoff } from "../src/server/handoff.ts";
import { setPortal } from "../src/server/host.ts";
import { openStore, putSettings } from "../src/server/store.ts";
import { addVoices, keepRecording, listVoices, openLibrary, voiceAudio } from "../src/server/voices.ts";
import { renamesOnDisk, scratch } from "../../../tests/helpers.mts";

/**
 * Taking up what the portal kept of the voice service when Voice became an extension: its voice library and its
 * settings, from a hand-off folder "voice-service" as the upgrade leaves it (core's side is in
 * schema-fingerprint.test.mjs), over a stand-in for the portal whose `handoffs` give the folder from where Voice's data
 * folder has it.
 */

/** Voice's data folder, its store and library open, and the portal it is given. `take` gives what is in <data>/handoff/<name>. */
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
  openLibrary(data);
  const stored = () => JSON.parse(readFileSync(path.join(data, "settings.json"), "utf8"));
  return { data, logged, handoff: kept("voice-service"), stored, said: () => logged.join("\n") };
}

const ARIA = "voice-db42d4ce-9a43-4ce1-9dd2-cc8596d3305e";
const CALM = "voice-d36b934e-0000-4000-8000-000000000000";
/** A recording as a clone keeps it: what matters here is that its bytes arrive as they were. */
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40, 7), Buffer.from(Array.from({ length: 2000 }, (_, i) => i % 256))]);
const DEFAULT_TEXT = "A warm, clear English voice with a calm, conversational delivery.";

/** As friday's portal kept them: a card chosen on the page, no setup under way, the speech model let go of when idle, and Aria chosen. */
const SETTINGS = { gpu: "GPU-648bf6c5-346e-81f5-f155-dc8061172da3", setupPending: null, lazyLoad: true, voice: ARIA, instruction: DEFAULT_TEXT, cfgScale: 1, exaggeration: 0.5, kokoroVoice: "af_heart", speed: 1, language: "en" };
/** The library as the portal kept it, in the order of its table: Aria, a clone, and Calm, designed. */
const VOICES = [
  { id: ARIA, name: "Aria", kind: "clone", instruction: "Warm and bright.", transcript: "Hello, I am Aria.", audio: "voices/0.wav" },
  { id: CALM, name: "Calm", kind: "design", instruction: "A calm voice.", transcript: "", audio: null },
];

/** A hand-off as the upgrade leaves it: the recordings, the list, the settings, and what it is, last. */
function leave(dir: string, { settings = SETTINGS as Record<string, unknown>, voices = VOICES as Record<string, unknown>[], recordings = { "0.wav": WAV } as Record<string, Buffer>, format = 1 } = {}) {
  mkdirSync(path.join(dir, "voices"), { recursive: true });
  for (const [name, bytes] of Object.entries(recordings)) writeFileSync(path.join(dir, "voices", name), bytes);
  writeFileSync(path.join(dir, "voices.json"), JSON.stringify(voices));
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
  writeFileSync(path.join(dir, "handoff.json"), JSON.stringify({ format, name: "voice-service", schema: 9, made: new Date().toISOString() }));
}
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const mode = (file: string) => statSync(file).mode & 0o777;

test("what the portal kept is taken up: the library with each clone's recording as it was, then the settings, and the hand-off is done with", () => {
  const { data, handoff, stored, said } = voice();
  leave(handoff);
  takeHandoff();
  assert.deepEqual(listVoices(), [
    { id: ARIA, name: "Aria", kind: "clone", instruction: "Warm and bright.", transcript: "Hello, I am Aria." },
    { id: CALM, name: "Calm", kind: "design", instruction: "A calm voice.", transcript: "" },
  ]);
  assert.equal(sha256(voiceAudio(ARIA)), sha256(WAV));
  assert.deepEqual(readdirSync(path.join(data, "voices")), [`${ARIA}.wav`]);
  assert.deepEqual([mode(path.join(data, "voices")), mode(path.join(data, "voices", `${ARIA}.wav`)), mode(path.join(data, "voices.json")), mode(path.join(data, "settings.json"))], [0o700, 0o600, 0o600, 0o600]);
  const { setupPending, ...rest } = SETTINGS;
  assert.deepEqual(stored(), rest);
  assert.equal(existsSync(handoff), false);
  assert.equal(said(), "took up what the portal kept of the voice service: the settings gpu, lazyLoad, voice, instruction, cfgScale, exaggeration, kokoroVoice, speed, language; the voices Aria, Calm");
  // A setup that had not come up yet is still to come up, and a speech model kept loaded is kept loaded.
  const pending = voice();
  leave(pending.handoff, { settings: { ...SETTINGS, gpu: null, setupPending: "1", lazyLoad: false }, voices: [], recordings: {} });
  takeHandoff();
  assert.equal(pending.stored().setupPending, true);
  assert.equal(pending.stored().lazyLoad, false);
});

test("each file the take-up writes is on disk before it is put in place, and so before the hand-off, the only other copy, is done with", () => {
  const { data, handoff } = voice();
  leave(handoff);
  const renamed = renamesOnDisk(takeHandoff);
  assert.deepEqual(renamed, [
    { to: path.join(data, "voices", `${ARIA}.wav`), synced: true },
    { to: path.join(data, "voices.json"), synced: true },
    { to: path.join(data, "settings.json"), synced: true },
  ]);
  assert.equal(existsSync(handoff), false);
});

test("only what Voice lacks is taken: a voice whose id its library has, and a setting said since, are the person's latest word", () => {
  const { handoff, stored, said } = voice();
  keepRecording(ARIA, Buffer.from("RIFF newer"));
  addVoices([{ id: ARIA, name: "Aria", kind: "clone", instruction: "Said since.", transcript: "Hello again." }]);
  putSettings({ gpu: "GPU-other", voice: "design", language: "de" });
  leave(handoff);
  takeHandoff();
  assert.deepEqual(listVoices().map((v) => [v.id, v.instruction]), [[ARIA, "Said since."], [CALM, "A calm voice."]]);
  assert.deepEqual(voiceAudio(ARIA), Buffer.from("RIFF newer"));
  assert.deepEqual([stored().gpu, stored().voice, stored().language, stored().cfgScale], ["GPU-other", "design", "de", 1]);
  assert.match(said(), /the settings lazyLoad, instruction, cfgScale, exaggeration, kokoroVoice, speed; the voices Calm$/);
});

test("what cannot be used is left out and named, and the rest is taken: no file is made of a name it was given", () => {
  const { data, handoff, stored, said } = voice();
  const good = { id: "voice-good", name: "Good", kind: "clone", instruction: "Fine.", transcript: "Words.", audio: "voices/5.wav" };
  leave(handoff, {
    voices: [
      { ...good, id: "../escape", name: "Escape", audio: "voices/0.wav" },
      { ...good, id: "voice-robot", name: "Robot", kind: "robot", audio: null },
      { ...good, id: "voice-silent", name: "Silent", audio: null },
      { ...good, id: "voice-lost", name: "Lost", audio: "voices/9.wav" },
      { ...good, id: "voice-outside", name: "Outside", audio: "../settings.json" },
      good,
    ],
    recordings: { "0.wav": WAV, "5.wav": WAV },
    settings: { gpu: 5, setupPending: null, lazyLoad: "yes", voice: "voice-gone", instruction: "", cfgScale: 2, exaggeration: 0.3, kokoroVoice: "jf_alpha", speed: 1.15, language: "xx" },
  });
  takeHandoff();
  assert.deepEqual(listVoices().map((v) => v.id), ["voice-good"]);
  assert.deepEqual(readdirSync(path.join(data, "voices")), ["voice-good.wav"]);
  assert.equal(existsSync(path.join(data, "escape.wav")), false);
  assert.deepEqual(stored(), { exaggeration: 0.3, speed: 1.15 });
  assert.equal(existsSync(handoff), false);
  assert.equal(said(), "took up what the portal kept of the voice service: the settings exaggeration, speed; the voices Good; left out: the voice Escape, the voice Robot, the voice Silent, the voice Lost, the voice Outside, the setting gpu, the setting lazyLoad, the setting voice, the setting instruction, the setting cfgScale, the setting kokoroVoice, the setting language");
});

test("a voice chosen is taken once the library has it, from the same hand-off", () => {
  const { handoff, stored } = voice();
  leave(handoff, { settings: { ...SETTINGS, voice: CALM } });
  takeHandoff();
  assert.equal(stored().voice, CALM);
});

test("a hand-off in another format, or one that cannot be read, is kept for a later Voice, and said", () => {
  const { handoff, said, data } = voice();
  leave(handoff, { format: 2 });
  takeHandoff();
  assert.equal(existsSync(path.join(handoff, "handoff.json")), true);
  assert.equal(existsSync(path.join(data, "settings.json")), false);
  assert.deepEqual(listVoices(), []);
  assert.match(said(), /could not take up what the portal kept of the voice service, which is kept for the next start: it is in a format this version of Voice does not read \(2\)/);
  // A list cut short: kept too.
  leave(handoff);
  writeFileSync(path.join(handoff, "voices.json"), "[");
  takeHandoff();
  assert.equal(existsSync(path.join(handoff, "voices.json")), true);
  assert.deepEqual(listVoices(), []);
});

test("a start that stopped part way takes up the rest at the next, and nothing twice", () => {
  const { data, handoff, stored, said } = voice();
  leave(handoff);
  // The settings cannot be written: the voices are in the library by then, and the hand-off is kept.
  mkdirSync(path.join(data, "settings.json"));
  takeHandoff();
  assert.deepEqual(listVoices().map((v) => v.id), [ARIA, CALM]);
  assert.equal(existsSync(handoff), true);
  assert.match(said(), /could not take up what the portal kept of the voice service, which is kept for the next start/);
  rmSync(path.join(data, "settings.json"), { recursive: true });
  // The next start, as the half reads its folder.
  openStore(data);
  openLibrary(data);
  takeHandoff();
  assert.deepEqual(listVoices().map((v) => v.id), [ARIA, CALM]);
  assert.equal(stored().voice, ARIA);
  assert.equal(existsSync(handoff), false);
  assert.match(said(), /took up what the portal kept of the voice service: the settings gpu, lazyLoad, voice, instruction, cfgScale, exaggeration, kokoroVoice, speed, language$/);
});

test("nothing handed over is nothing done, and the hand-off of an earlier version of this upgrade is not read", () => {
  const { logged, data } = voice();
  const old = path.join(data, "handoff", "voice");
  mkdirSync(old, { recursive: true });
  writeFileSync(path.join(old, "handoff.json"), JSON.stringify({ format: 1, name: "voice", schema: 9 }));
  takeHandoff();
  assert.deepEqual(logged, []);
  assert.equal(existsSync(path.join(data, "settings.json")), false);
  assert.equal(existsSync(path.join(old, "handoff.json")), true);
});
