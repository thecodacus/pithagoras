import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { takeHandoff } from "../src/server/handoff.ts";
import { setPortal } from "../src/server/host.ts";
import { openStore, saveSettings } from "../src/server/store.ts";
import { renamesOnDisk, scratch } from "../../../tests/helpers.mts";

/**
 * Taking up the person's own addresses for voice mode, as the portal kept them before voice mode's sources were
 * extensions: from a hand-off folder as the upgrade leaves it (core's side is in schema-fingerprint.test.mjs), over a
 * stand-in for the portal whose `handoffs` give the folder from where Voice servers' data folder has it.
 */

/** Voice servers' data folder, its store open, and the portal it is given. `take` gives what is in <data>/handoff/<name>. */
function voiceServers() {
  const data = realpathSync(scratch("voice-servers-handoff-"));
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
  return { data, logged, handoff: kept("voice-addresses"), stored };
}

/** What the upgrade leaves of the person's own addresses: each field as the portal stored it, null where it had none. */
const own = (fields: Record<string, string | null> = {}) => ({
  whisperUrl: "http://127.0.0.1:8178/inference",
  sttModel: "large-v3",
  breezeUrl: "http://127.0.0.1:7871/v1/audio/speech",
  runtime: "kokoro",
  dictationUrl: "http://127.0.0.1:8179/inference",
  dictationModel: "accurate",
  language: "de",
  kokoroVoice: "bm_george",
  ...fields,
});

/** A hand-off as the upgrade leaves it. */
function leave(dir: string, settings: Record<string, unknown> = own(), format = 1) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
  writeFileSync(path.join(dir, "handoff.json"), JSON.stringify({ format, name: "voice-addresses", schema: 9, made: new Date().toISOString() }));
}

const RECOGNITION = { sttUrl: "http://127.0.0.1:8178/inference", sttModel: "large-v3", dictationUrl: "http://127.0.0.1:8179/inference", dictationModel: "accurate", language: "de" };

test("where Kokoro spoke, the addresses are taken with its speech, its model and its voice, and the hand-off is done with", () => {
  const { data, logged, handoff, stored } = voiceServers();
  leave(handoff);
  takeHandoff();
  assert.deepEqual(stored(), {
    ...RECOGNITION,
    ttsUrl: "http://127.0.0.1:7871/v1/audio/speech",
    ttsModel: "kokoro",
    voices: [{ id: "bm_george", name: "bm_george" }],
    voice: "bm_george",
  });
  assert.equal(statSync(path.join(data, "settings.json")).mode & 0o777, 0o600, "for its owner alone");
  assert.equal(existsSync(handoff), false);
  assert.deepEqual(logged, ["took up the addresses the portal kept for voice mode: the settings sttUrl, sttModel, dictationUrl, dictationModel, language, ttsUrl, ttsModel, voices, voice"]);
});

test("the settings taken are on disk before they are put in place, and so before the hand-off, the only other copy, is done with", () => {
  const { data, handoff } = voiceServers();
  leave(handoff);
  assert.deepEqual(renamesOnDisk(takeHandoff), [{ to: path.join(data, "settings.json"), synced: true }]);
  assert.equal(existsSync(handoff), false);
});

test("where Breeze, Breeze on audio.cpp or Chatterbox spoke, recognition alone is taken, and the log says why", () => {
  for (const runtime of ["breeze", "audio-cpp", "chatterbox"]) {
    const { logged, handoff, stored } = voiceServers();
    leave(handoff, own({ runtime }));
    takeHandoff();
    assert.deepEqual(stored(), RECOGNITION, runtime);
    assert.deepEqual(logged, [
      `speech at http://127.0.0.1:7871/v1/audio/speech spoke ${runtime}, which Voice servers does not speak: it listens there and does not speak; the Voice service extension speaks Breeze and Chatterbox`,
      "took up the addresses the portal kept for voice mode: the settings sttUrl, sttModel, dictationUrl, dictationModel, language",
    ]);
  }
  // Recognition alone had no speech to take.
  const { logged, handoff, stored } = voiceServers();
  leave(handoff, own({ runtime: "none" }));
  takeHandoff();
  assert.deepEqual(stored(), RECOGNITION);
  assert.equal(logged.length, 1);
});

test("a setting said since, while the hand-off waited, is the person's latest word; auto detection is no language", () => {
  const { handoff, stored } = voiceServers();
  saveSettings({ sttUrl: "http://speech.example.test/v1/audio/transcriptions", voices: [{ id: "af_heart", name: "Heart" }] });
  leave(handoff, own({ language: "auto" }));
  takeHandoff();
  assert.deepEqual(stored(), {
    sttUrl: "http://speech.example.test/v1/audio/transcriptions",
    voices: [{ id: "af_heart", name: "Heart" }],
    sttModel: "large-v3",
    dictationUrl: "http://127.0.0.1:8179/inference",
    dictationModel: "accurate",
    ttsUrl: "http://127.0.0.1:7871/v1/audio/speech",
    ttsModel: "kokoro",
    voice: "bm_george",
  });
  assert.equal(existsSync(handoff), false);
});

test("a side the portal kept nothing of the person's own for is null, and nothing of it is taken", () => {
  const { logged, handoff, stored } = voiceServers();
  // The service listened and spoke; the person's own dictation pair was beside it.
  leave(handoff, own({ whisperUrl: null, sttModel: null, breezeUrl: null, runtime: null, language: null, kokoroVoice: null }));
  takeHandoff();
  assert.deepEqual(stored(), { dictationUrl: "http://127.0.0.1:8179/inference", dictationModel: "accurate" });
  assert.deepEqual(logged, ["took up the addresses the portal kept for voice mode: the settings dictationUrl, dictationModel"]);
  // Kokoro with no voice kept speaks in its own.
  const kokoro = voiceServers();
  leave(kokoro.handoff, own({ kokoroVoice: null }));
  takeHandoff();
  assert.deepEqual(kokoro.stored(), { ...RECOGNITION, ttsUrl: "http://127.0.0.1:7871/v1/audio/speech", ttsModel: "kokoro" });
});

test("a hand-off in another format, or one that cannot be read, is kept for a later Voice servers, and said", () => {
  const { handoff, logged, data } = voiceServers();
  leave(handoff, own(), 2);
  takeHandoff();
  assert.equal(existsSync(path.join(handoff, "handoff.json")), true);
  assert.equal(existsSync(path.join(data, "settings.json")), false);
  assert.deepEqual(logged, ["could not take up the addresses the portal kept for voice mode, which are kept for the next start: it is in a format this version of Voice servers does not read (2)"]);
  // A settings file cut short: kept too.
  leave(handoff);
  writeFileSync(path.join(handoff, "settings.json"), "{");
  takeHandoff();
  assert.equal(existsSync(path.join(handoff, "settings.json")), true);
  assert.equal(existsSync(path.join(data, "settings.json")), false);
});

test("nothing handed over is nothing done", () => {
  const { logged, data } = voiceServers();
  takeHandoff();
  assert.deepEqual(logged, []);
  assert.equal(existsSync(path.join(data, "settings.json")), false);
});
