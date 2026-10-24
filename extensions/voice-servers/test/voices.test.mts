import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "../../../tests/helpers.mts";
import { serveVoiceServers, wav } from "./portal.mts";

/**
 * The voice library (src/server/voices.ts), through the routes of Voice servers' page: the voices the person adds, in
 * its own folder, for its owner alone, each renamed, described anew or deleted, and what a voice must be.
 */

inProcessHome("pithagoras-voice-servers-library-");
const { at, data } = await serveVoiceServers();
const { openLibrary, listVoices } = await import("../src/server/voices.ts");

const json = { "content-type": "application/json" };
/** A clean recording of `seconds` of silence, as the page sends it: base64 of a mono 16 kHz 16-bit WAV. */
const recording = (seconds = 1) => wav(Buffer.alloc(32000 * seconds), 16000).toString("base64");
const add = (voice: unknown) => fetch(`${at}/voices`, { method: "POST", headers: json, body: JSON.stringify(voice) });
const patch = (id: string, change: unknown) => fetch(`${at}/voices/${id}`, { method: "PATCH", headers: json, body: JSON.stringify(change) });
const said = async (answer: Response) => [answer.status, (await answer.json()).error];
const mode = (file: string) => statSync(path.join(data, file)).mode & 0o777;
const listed = () => JSON.parse(readFileSync(path.join(data, "voices.json"), "utf8"));

test("a voice added is kept for its owner alone: the list in voices.json, by name, and a clone's recording beside it, played behind the routes", async () => {
  assert.deepEqual(await (await fetch(`${at}/voices`)).json(), []);
  const audio = recording();
  const clone = await (await add({ name: " Test clone ", kind: "clone", instruction: " Warm delivery ", transcript: " A reference line ", audio })).json();
  const designed = await (await add({ name: "A narrator", kind: "design", instruction: "Low, calm voice", transcript: "ignored", audio })).json();
  assert.match(clone.id, /^voice-[0-9a-f-]{36}$/);
  assert.deepEqual(clone, { id: clone.id, name: "Test clone", kind: "clone", instruction: "Warm delivery", transcript: "A reference line" });
  // A designed voice keeps no recording, and no words said in one.
  assert.deepEqual(designed, { id: designed.id, name: "A narrator", kind: "design", instruction: "Low, calm voice", transcript: "" });
  assert.deepEqual(listed(), [designed, clone], "sorted by name, and no recording in it");
  assert.deepEqual(await (await fetch(`${at}/voices`)).json(), [designed, clone]);
  const played = await fetch(`${at}/voices/${clone.id}/audio`);
  assert.deepEqual([played.status, played.headers.get("content-type"), played.headers.get("cache-control")], [200, "audio/wav", "no-store"]);
  assert.deepEqual(Buffer.from(await played.arrayBuffer()), Buffer.from(audio, "base64"));
  assert.deepEqual([mode("voices.json"), mode("voices"), mode(`voices/${clone.id}.wav`)], [0o600, 0o700, 0o600]);
  assert.equal(existsSync(path.join(data, "voices", `${designed.id}.wav`)), false);
  assert.equal((await fetch(`${at}/voices/${designed.id}/audio`)).status, 404);
  assert.equal((await fetch(`${at}/voices/voice-missing/audio`)).status, 404);
  // Read again as the half starts.
  openLibrary(data);
  assert.deepEqual(listVoices(), [designed, clone]);
});

test("a voice is refused with what is wrong with it, and nothing is kept of it", async () => {
  const before = listed();
  const good = { name: "Bad", kind: "clone", instruction: "Clear", transcript: "Hello", audio: recording() };
  for (const [value, message] of [
    [{ ...good, name: " " }, "Enter a voice name of 1–100 characters"],
    [{ ...good, name: "x".repeat(101) }, "Enter a voice name of 1–100 characters"],
    [{ ...good, kind: "robot" }, "Choose a designed voice or reference clone"],
    [{ ...good, instruction: "" }, "Describe the voice in 1–1000 characters"],
    [{ ...good, instruction: "x".repeat(1001) }, "Describe the voice in 1–1000 characters"],
    [{ ...good, transcript: "" }, "Enter the exact words spoken in the reference (up to 4,000 characters)"],
    [{ ...good, transcript: "x".repeat(4001) }, "Enter the exact words spoken in the reference (up to 4,000 characters)"],
    [{ ...good, audio: undefined }, "Upload a reference recording of 1–30 seconds"],
    [{ ...good, audio: "a".repeat(1300001) }, "Upload a reference recording of 1–30 seconds"],
    [{ ...good, audio: "YWJj" }, "Invalid reference WAV; upload a 1–30 second audio clip using Settings"],
    // Under a second; at another rate; in stereo.
    [{ ...good, audio: wav(Buffer.alloc(16000), 16000).toString("base64") }, "Invalid reference WAV; upload a 1–30 second audio clip using Settings"],
    [{ ...good, audio: wav(Buffer.alloc(48000), 24000).toString("base64") }, "Invalid reference WAV; upload a 1–30 second audio clip using Settings"],
    [{ ...good, audio: (() => { const stereo = wav(Buffer.alloc(64000), 16000); stereo.writeUInt16LE(2, 22); return stereo.toString("base64"); })() }, "Invalid reference WAV; upload a 1–30 second audio clip using Settings"],
    [{ ...good, audio: recording(31) }, "Upload a reference recording of 1–30 seconds"],
  ] as const) {
    assert.deepEqual(await said(await add(value)), [400, message], JSON.stringify(value).slice(0, 80));
  }
  assert.deepEqual(listed(), before);
  assert.deepEqual(await said(await fetch(`${at}/voices`, { method: "POST", headers: json, body: JSON.stringify({ ...good, audio: "a".repeat(2_200_000) }) })), [413, "request entity too large"]);
  // Thirty seconds is the longest a recording may be.
  const longest = await (await add({ ...good, name: "Longest", audio: recording(30) })).json();
  assert.equal(Buffer.from(await (await fetch(`${at}/voices/${longest.id}/audio`)).arrayBuffer()).length, 960044);
  assert.equal((await fetch(`${at}/voices/${longest.id}`, { method: "DELETE" })).status, 200);
});

test("a voice is renamed, or described anew, or both, and its recording and words stay as they are", async () => {
  const voice = await (await add({ name: "Editable", kind: "clone", instruction: "Warm delivery", transcript: "A reference line", audio: recording() })).json();
  const before = readFileSync(path.join(data, "voices", `${voice.id}.wav`));
  const renamed = await patch(voice.id, { name: "  A  " });
  assert.equal(renamed.status, 200);
  assert.deepEqual(await renamed.json(), { ...voice, name: "A" });
  assert.equal(listed()[0].id, voice.id, "sorted by its new name");
  assert.deepEqual(await (await patch(voice.id, { instruction: " Bright and quick " })).json(), { ...voice, name: "A", instruction: "Bright and quick" });
  assert.deepEqual(await (await patch(voice.id, { name: "Zebra", instruction: "Slow" })).json(), { ...voice, name: "Zebra", instruction: "Slow" });
  assert.deepEqual(listed().find((v: { id: string }) => v.id === voice.id), { ...voice, name: "Zebra", instruction: "Slow" });
  assert.deepEqual(readFileSync(path.join(data, "voices", `${voice.id}.wav`)), before);
  for (const [change, error] of [
    [{}, "Give the voice a new name or description"],
    [{ transcript: "Other words" }, "Give the voice a new name or description"],
    [{ name: "" }, "Enter a voice name of 1–100 characters"],
    [{ name: 7 }, "Enter a voice name of 1–100 characters"],
    [{ instruction: "  " }, "Describe the voice in 1–1000 characters"],
    // A change refused in part is not made in part.
    [{ name: "Good name", instruction: "x".repeat(1001) }, "Describe the voice in 1–1000 characters"],
  ] as const) {
    assert.deepEqual(await said(await patch(voice.id, change)), [400, error], JSON.stringify(change));
  }
  assert.deepEqual(listed().find((v: { id: string }) => v.id === voice.id), { ...voice, name: "Zebra", instruction: "Slow" });
  assert.deepEqual(await said(await patch("voice-missing", { name: "Ghost" })), [404, "Voice not found"]);
});

test("deleting a voice removes its recording, and the page's choice of it goes back to the server's own", async () => {
  const voice = await (await add({ name: "Doomed", kind: "clone", instruction: "Plain voice", transcript: "Words.", audio: recording() })).json();
  const settings = (await import("../src/server/store.ts"));
  // Chosen on the page as its own voice, as custom voices allow.
  settings.saveSettings({ sttUrl: "http://127.0.0.1:8178/inference", customVoices: true, speechServer: "breeze-tts", voice: voice.id });
  const answer = await fetch(`${at}/voices/${voice.id}`, { method: "DELETE" });
  assert.deepEqual([answer.status, await answer.json()], [200, { ok: true }]);
  assert.equal(listed().some((v: { id: string }) => v.id === voice.id), false);
  assert.equal(existsSync(path.join(data, "voices", `${voice.id}.wav`)), false);
  assert.deepEqual(settings.settings(), { sttUrl: "http://127.0.0.1:8178/inference", customVoices: true, speechServer: "breeze-tts" });
  assert.deepEqual(await said(await fetch(`${at}/voices/${voice.id}`, { method: "DELETE" })), [404, "Voice not found"]);
  // An id is only ever a voice of the list: one that is not, as a path, names no file.
  assert.equal((await fetch(`${at}/voices/..%2Fsettings.json/audio`)).status, 404);
});
