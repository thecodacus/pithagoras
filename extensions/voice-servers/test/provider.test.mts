import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "../../../tests/helpers.mts";
import { formOf, serveVoiceServers, speechServer, wav } from "./portal.mts";

/**
 * The person's own servers as voice mode's source (`portal.voice.provide`): what is sent to them, exactly, and what
 * voice mode gets back, through the portal's own voice routes as voice mode reaches them, against a speech server on
 * the loopback that keeps every request.
 */

inProcessHome("pithagoras-voice-servers-provider-");
const upstream = await speechServer();
const RECOGNITION = `${upstream.at}/v1/audio/transcriptions`;
const DICTATION = `${upstream.at}/dictation`;
const SPEECH = `${upstream.at}/v1/audio/speech`;
// The person's own addresses as the upgrade leaves them (core's db.ts), where Kokoro spoke, for the half to take up as it starts.
const { handoffRoot, leaveHandoff } = await import(new URL("../../../core/server/dist/handoff.js", import.meta.url).href);
leaveHandoff("voice-addresses", (dir: string) => {
  const own = { whisperUrl: RECOGNITION, sttModel: null, breezeUrl: SPEECH, runtime: "kokoro", dictationUrl: null, dictationModel: null, language: "auto", kokoroVoice: "af_heart" };
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify(own));
  writeFileSync(path.join(dir, "handoff.json"), JSON.stringify({ format: 1, name: "voice-addresses", schema: 9, made: new Date().toISOString() }));
});
const { at, api, db } = await serveVoiceServers();
const { provider, state } = await import("../src/server/provider.ts");

const json = { "content-type": "application/json" };
const SAMPLES = Buffer.from([0, 0, 255, 127, 1, 0, 2, 0]);
const RECORDING = wav(Buffer.alloc(3200), 16000);

const put = async (settings: object) => assert.equal((await fetch(`${at}/settings`, { method: "PUT", headers: json, body: JSON.stringify(settings) })).status, 200);
const transcribe = (dictation = false) =>
  fetch(`${api}/sessions/talk/voice/transcribe${dictation ? "?purpose=dictation" : ""}`, { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array(RECORDING) });
const speech = (text: string) => fetch(`${api}/sessions/talk/voice/speech`, { method: "POST", headers: json, body: JSON.stringify({ text }) });
/** The requests the speech server got while `work` ran. */
const during = async (work: () => Promise<unknown>) => {
  const from = upstream.heard.length;
  await work();
  return upstream.heard.slice(from);
};
/** The servers answering as they do when all is well: a transcript at each recognition address, and a 24 kHz WAV for speech. */
const answering = () => {
  upstream.answers.set("/v1/audio/transcriptions", { type: "application/json", body: JSON.stringify({ text: " Heard you. " }) });
  upstream.answers.set("/dictation", { type: "application/json", body: JSON.stringify({ text: " Dictated. " }) });
  upstream.answers.set("/v1/audio/speech", { type: "application/octet-stream", body: wav(SAMPLES, 24000) });
};

db.createSession({ id: "talk", title: "Talk", workspace: process.env.WORKSPACE_ROOT!, executor: "host" });

test("the addresses the upgrade left are taken up as the half starts, and voice mode is then chosen to use them", async () => {
  assert.deepEqual(await (await fetch(`${at}/settings`)).json(), {
    sttUrl: RECOGNITION,
    ttsUrl: SPEECH,
    ttsModel: "kokoro",
    voices: [{ id: "af_heart", name: "af_heart" }],
    voice: "af_heart",
    chosen: false,
  });
  assert.equal(existsSync(path.join(handoffRoot(), "voice-addresses")), false);
  assert.equal((await fetch(`${at}/chosen`, { method: "PUT", headers: json, body: JSON.stringify({ chosen: true }) })).status, 200);
  assert.equal((await (await fetch(`${api}/voice`)).json()).provider, "pithagoras-voice-servers");
});

test("a recording is sent as the form OpenAI's and whisper.cpp's recognition take, with only what is set", async () => {
  answering();
  await put({ sttUrl: RECOGNITION });
  let answered: Response | undefined;
  const [bare] = await during(async () => (answered = await transcribe()));
  assert.equal(answered!.status, 200);
  assert.deepEqual(await answered!.json(), { text: "Heard you." });
  assert.equal(bare.method, "POST");
  assert.equal(bare.path, "/v1/audio/transcriptions");
  assert.match(bare.headers["content-type"]!, /^multipart\/form-data; boundary=/);
  assert.deepEqual(await formOf(bare), { file: { name: "recording.wav", type: "audio/wav", bytes: RECORDING }, response_format: "json" });
  // A model and a language are sent where they are set.
  await put({ sttUrl: RECOGNITION, sttModel: "whisper-1", language: "de" });
  const [full] = await during(() => transcribe());
  assert.deepEqual(await formOf(full), { file: { name: "recording.wav", type: "audio/wav", bytes: RECORDING }, response_format: "json", model: "whisper-1", language: "de" });
});

test("dictation goes to its own address and model where they are set, each on its own, and to voice mode's otherwise", async () => {
  answering();
  /** Where a recording went, and the model it named. */
  const sent = async (dictation = false) => {
    const [heard] = await during(async () => assert.equal((await transcribe(dictation)).status, 200));
    return [heard.path, (await formOf(heard)).model];
  };
  await put({ sttUrl: RECOGNITION, sttModel: "fast", dictationUrl: DICTATION, dictationModel: "accurate" });
  assert.deepEqual(await sent(), ["/v1/audio/transcriptions", "fast"]);
  assert.deepEqual(await sent(true), ["/dictation", "accurate"]);
  // A dictation model with no address of its own goes to voice mode's address.
  await put({ sttUrl: RECOGNITION, sttModel: "fast", dictationModel: "accurate" });
  assert.deepEqual(await sent(true), ["/v1/audio/transcriptions", "accurate"]);
  await put({ sttUrl: RECOGNITION, sttModel: "fast", dictationUrl: DICTATION });
  assert.deepEqual(await sent(true), ["/dictation", "fast"]);
  // Only dictation names a model: voice mode sends none.
  await put({ sttUrl: RECOGNITION, dictationModel: "accurate" });
  assert.deepEqual(await sent(), ["/v1/audio/transcriptions", undefined]);
  assert.deepEqual(await sent(true), ["/v1/audio/transcriptions", "accurate"]);
});

test("a phrase is sent as OpenAI's speech takes it, asking for WAV, and the answer is labelled WAV", async () => {
  answering();
  await put({ sttUrl: RECOGNITION, ttsUrl: SPEECH, ttsModel: "kokoro", voices: [{ id: "af_heart" }, { id: "bm_george", name: "George" }], voice: "af_heart" });
  const signal = new AbortController().signal;
  /** What the speech server was sent for one phrase, and what voice mode was given. */
  const spoken = async (voice?: string) => {
    let answer: globalThis.Response | undefined;
    const [heard] = await during(async () => (answer = await provider.speak("Hello there", { voice, signal })));
    return { sent: JSON.parse(heard.body.toString()), headers: heard.headers, type: answer!.headers.get("content-type"), bytes: Buffer.from(await answer!.arrayBuffer()) };
  };
  const george = await spoken("bm_george");
  assert.deepEqual(george.sent, { model: "kokoro", input: "Hello there", voice: "bm_george", response_format: "wav" });
  assert.equal(george.headers["content-type"], "application/json");
  // Whatever the server called it.
  assert.equal(george.type, "audio/wav");
  assert.deepEqual(george.bytes, wav(SAMPLES, 24000));
  // A voice it does not list, or none: the one chosen on the page.
  assert.equal((await spoken("af_sky")).sent.voice, "af_heart");
  assert.equal((await spoken()).sent.voice, "af_heart");
  // No model, and no voice chosen: neither is sent, and the server speaks in its own.
  await put({ sttUrl: RECOGNITION, ttsUrl: SPEECH, voices: [{ id: "bm_george" }] });
  assert.deepEqual((await spoken("af_sky")).sent, { input: "Hello there", response_format: "wav" });
  assert.deepEqual((await spoken("bm_george")).sent, { input: "Hello there", voice: "bm_george", response_format: "wav" });
  await put({ sttUrl: RECOGNITION });
  await assert.rejects(provider.speak("Hello", { signal }), { message: "No speech synthesis address is set" });
});

test("voice mode plays a 24 kHz WAV, and refuses one at another rate", async () => {
  answering();
  await put({ sttUrl: RECOGNITION, ttsUrl: SPEECH });
  const played = await speech("Hello");
  assert.equal(played.status, 200);
  assert.equal(played.headers.get("content-type"), "audio/pcm");
  assert.equal(played.headers.get("x-sample-rate"), "24000");
  assert.deepEqual(Buffer.from(await played.arrayBuffer()), SAMPLES);
  upstream.answers.set("/v1/audio/speech", { type: "audio/wav", body: wav(SAMPLES, 22050) });
  const refused = await speech("Hello");
  assert.deepEqual([refused.status, await refused.json()], [502, { error: "Expected mono 24 kHz 16-bit audio from Voice servers" }]);
});

test("a server that fails, or answers without a transcript, is said so", async () => {
  answering();
  await put({ sttUrl: RECOGNITION, ttsUrl: SPEECH });
  const failed = async (answer: Response) => [answer.status, (await answer.json()).error];
  upstream.answers.set("/v1/audio/transcriptions", { status: 500, body: "" });
  assert.deepEqual(await failed(await transcribe()), [502, "The speech recognition server answered HTTP 500"]);
  upstream.answers.set("/v1/audio/transcriptions", { type: "application/json", body: JSON.stringify({ detail: "no speech" }) });
  assert.deepEqual(await failed(await transcribe()), [502, "The speech recognition server gave no transcript"]);
  upstream.answers.set("/v1/audio/transcriptions", { type: "text/plain", body: "Heard you." });
  assert.deepEqual(await failed(await transcribe()), [502, "The speech recognition server gave no transcript"]);
  upstream.answers.set("/v1/audio/speech", { status: 503, body: "" });
  assert.deepEqual(await failed(await speech("Hello")), [502, "The speech server answered HTTP 503"]);
});

test("what it offers is read from the settings alone: recognition with an address for it, and speech with one for that", async () => {
  const voice = async () => {
    const { label, ready, speech, voices } = await (await fetch(`${api}/voice`)).json();
    return { label, ready, speech, voices };
  };
  const asked = await during(async () => {
    await put({});
    assert.equal(state(), undefined);
    assert.deepEqual(await voice(), { label: "Voice servers", ready: false, speech: true, voices: [] });
    await put({ sttUrl: RECOGNITION });
    assert.deepEqual(state(), { speaks: false, voices: [] });
    assert.deepEqual(await voice(), { label: "Voice servers", ready: true, speech: false, voices: [] });
    const alone = await speech("Hello");
    assert.deepEqual([alone.status, (await alone.json()).error], [409, "Voice mode's source recognises speech alone: replies are not spoken"]);
    // The voices typed in are the person's own, and shown by the names they gave them.
    await put({ sttUrl: RECOGNITION, ttsUrl: SPEECH, voices: [{ id: "af_heart" }, { id: "bm_george", name: "George" }] });
    const voices = [{ id: "af_heart", name: "af_heart" }, { id: "bm_george", name: "George" }];
    assert.deepEqual(state(), { speaks: true, voices });
    assert.deepEqual(await voice(), { label: "Voice servers", ready: true, speech: true, voices });
  });
  assert.deepEqual(asked, [], "no server is asked");
});

test("no request to a server carries a key", () => {
  assert.ok(upstream.heard.length > 10);
  assert.deepEqual(upstream.heard.filter((heard) => "authorization" in heard.headers), []);
});
