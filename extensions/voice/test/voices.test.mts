import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "../../../tests/helpers.mts";
import { serveVoice } from "./portal.mts";

/**
 * The voice library (src/server/voices.ts): the voices the person adds on the service's page, in Voice's own folder,
 * for its owner alone. What a voice must be, with the messages the portal had for it, and what goes when one is deleted.
 */

inProcessHome("pithagoras-voice-library-");
const { at, data } = await serveVoice();
const { addVoice, addVoices, deleteVoice, findVoice, keepRecording, listVoices, openLibrary, updateVoice, voiceAudio, VoiceNotFound } = await import("../src/server/voices.ts");
const { putSettings, setting } = await import("../src/server/store.ts");
const { samplesWav } = await import("../src/web/audio.ts");
const core = (file: string) => new URL(`../../../core/server/dist/${file}`, import.meta.url).href;
const { createAgent, getAgent } = await import(core("agents.js"));
const { getDb } = await import(core("db.js"));

/** A clean recording of `seconds` of silence, as the page sends it: base64 of a mono 16 kHz 16-bit WAV. */
const recording = async (seconds = 1) => Buffer.from(await samplesWav(new Float32Array(16000 * seconds)).arrayBuffer()).toString("base64");
const mode = (file: string) => statSync(path.join(data, file)).mode & 0o777;
const listed = () => JSON.parse(readFileSync(path.join(data, "voices.json"), "utf8"));

test("a voice added is kept for its owner alone: the list in voices.json, by name, and a clone's recording beside it", async () => {
  const audio = await recording();
  const clone = addVoice({ name: " Test clone ", kind: "clone", instruction: " Warm delivery ", transcript: " A reference line ", audio });
  const designed = addVoice({ name: "A narrator", kind: "design", instruction: "Low, calm voice" });
  assert.match(clone.id, /^voice-[0-9a-f-]{36}$/);
  assert.deepEqual(clone, { id: clone.id, name: "Test clone", kind: "clone", instruction: "Warm delivery", transcript: "A reference line" });
  assert.deepEqual(listed(), [designed, clone], "sorted by name, and no recording in it");
  assert.deepEqual(voiceAudio(clone.id), Buffer.from(audio, "base64"));
  assert.equal(voiceAudio(clone.id).length, 32044);
  assert.deepEqual([mode("voices.json"), mode("voices"), mode(`voices/${clone.id}.wav`)], [0o600, 0o700, 0o600]);
  // A designed voice has no recording.
  assert.equal(existsSync(path.join(data, "voices", `${designed.id}.wav`)), false);
  assert.throws(() => voiceAudio(designed.id), VoiceNotFound);
  // Read again as the half starts.
  openLibrary(data);
  assert.deepEqual(listVoices(), [designed, clone]);
});

test("a voice is refused with what is wrong with it, and nothing is kept of it", async () => {
  const before = listed();
  const good = { name: "Bad", kind: "clone", instruction: "Clear", transcript: "Hello", audio: await recording() };
  for (const [value, message] of [
    [{ ...good, name: " " }, /Enter a voice name of 1–100 characters/],
    [{ ...good, name: "x".repeat(101) }, /1–100 characters/],
    [{ ...good, kind: "robot" }, /Choose a designed voice or reference clone/],
    [{ ...good, instruction: "" }, /Describe the voice in 1–1000 characters/],
    [{ ...good, transcript: "" }, /Enter the exact words spoken in the reference/],
    [{ ...good, transcript: "x".repeat(4001) }, /up to 4,000 characters/],
    [{ ...good, audio: undefined }, /Upload a reference recording of 1–30 seconds/],
    [{ ...good, audio: "a".repeat(1300001) }, /Upload a reference recording of 1–30 seconds/],
    [{ ...good, audio: "YWJj" }, /Invalid reference WAV/],
    // Under a second, and over thirty.
    [{ ...good, audio: Buffer.from(await samplesWav(new Float32Array(8000)).arrayBuffer()).toString("base64") }, /Invalid reference WAV/],
    [{ ...good, audio: await recording(31) }, /Upload a reference recording of 1–30 seconds/],
  ] as const) assert.throws(() => addVoice(value), message as RegExp);
  assert.deepEqual(listed(), before);
  // Thirty seconds is the longest a recording may be.
  const longest = addVoice({ ...good, name: "Longest", audio: await recording(30) });
  assert.equal(voiceAudio(longest.id).length, 960044);
  deleteVoice(longest.id);
});

test("a voice's description can be changed, and only the description", async () => {
  const voice = addVoice({ name: "Editable", kind: "clone", instruction: "Warm delivery", transcript: "A reference line", audio: await recording() });
  const before = voiceAudio(voice.id);
  const row = updateVoice(voice.id, { instruction: "  Bright and quick  " });
  assert.deepEqual(row, { ...voice, instruction: "Bright and quick" });
  assert.deepEqual(findVoice(voice.id), row);
  assert.deepEqual(listed().find((v: { id: string }) => v.id === voice.id), row);
  assert.deepEqual(voiceAudio(voice.id), before);
  for (const instruction of ["", "  ", "x".repeat(1001), null, 7]) assert.throws(() => updateVoice(voice.id, { instruction }), /1–1000 characters/);
  assert.throws(() => updateVoice(voice.id, undefined), /1–1000 characters/);
  assert.equal(findVoice(voice.id)!.instruction, "Bright and quick");
  assert.equal(updateVoice(voice.id, { instruction: "x".repeat(1000) }).instruction.length, 1000);
  // A voice that is not there says so, and nothing is added.
  const count = listVoices().length;
  assert.throws(() => updateVoice("voice-missing", { instruction: "Clear" }), VoiceNotFound);
  assert.throws(() => deleteVoice("voice-missing"), VoiceNotFound);
  assert.equal(listVoices().length, count);
});

test("deleting a voice removes its recording, gives the page's choice back to the designed voice, and leaves an agent's voice as it is", async () => {
  const voice = addVoice({ name: "Doomed", kind: "clone", instruction: "Plain voice", transcript: "Words.", audio: await recording() });
  const other = addVoice({ name: "Kept", kind: "design", instruction: "Plain voice" });
  const agent = createAgent({ name: "Herald" });
  // As an agent's voice is kept: an id of the voices voice mode's source offers.
  getDb().prepare("UPDATE agents SET voice = ? WHERE id = ?").run(voice.id, agent.id);
  putSettings({ voice: voice.id });
  const answer = await fetch(`${at}/voices/${voice.id}`, { method: "DELETE" });
  assert.deepEqual([answer.status, await answer.json()], [200, { ok: true }]);
  assert.equal(findVoice(voice.id), undefined);
  assert.equal(existsSync(path.join(data, "voices", `${voice.id}.wav`)), false);
  assert.equal(setting("voice"), "design");
  assert.equal(getAgent(agent.id).voice, voice.id, "it speaks with the service's own choice");
  // Another voice deleted leaves the page's choice as it is.
  putSettings({ voice: "design" });
  deleteVoice(other.id);
  assert.equal(setting("voice"), "design");
  assert.equal((await fetch(`${at}/voices/${voice.id}`, { method: "DELETE" })).status, 404);
});

test("an id is put in the list, and made a file name, only where it is a word of letters, digits, _ and -", async () => {
  const before = listed();
  const wav = Buffer.from(await recording(), "base64");
  for (const id of ["../outside", "voice/inside", "", "x".repeat(101), "voice one"]) {
    assert.throws(() => keepRecording(id, wav), /is not a voice id/, id);
    assert.throws(() => addVoices([{ id, name: "Odd", kind: "design", instruction: "Plain", transcript: "" }]), /is not a voice id/, id);
  }
  assert.equal(existsSync(path.join(data, "outside.wav")), false);
  assert.deepEqual(listed(), before);
  // A voice of the portal's, as it named them, is one.
  keepRecording("voice-db42d4ce-9a43-4ce1-9dd2-cc8596d3305e", wav);
  addVoices([{ id: "voice-db42d4ce-9a43-4ce1-9dd2-cc8596d3305e", name: "Aria", kind: "clone", instruction: "Warm.", transcript: "Hello." }]);
  assert.deepEqual(voiceAudio("voice-db42d4ce-9a43-4ce1-9dd2-cc8596d3305e"), wav);
});
