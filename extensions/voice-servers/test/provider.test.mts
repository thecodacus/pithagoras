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

/** A voice added to the library, as the page adds it. */
const addVoice = async (voice: object) => {
  const answer = await fetch(`${at}/voices`, { method: "POST", headers: json, body: JSON.stringify(voice) });
  assert.equal(answer.status, 200);
  return (await answer.json()) as { id: string; name: string; kind: string; instruction: string; transcript: string; stored?: { url: string; at: string } };
};
const CLONE_WAV = wav(Buffer.alloc(32000), 16000);
const clone = await addVoice({ name: "My clone", kind: "clone", instruction: "Warm and slow", transcript: "These are the words I said.", audio: CLONE_WAV.toString("base64") });
const designed = await addVoice({ name: "Narrator", kind: "design", instruction: "A deep, calm narrator" });
const custom = async (on: boolean) => assert.equal((await fetch(`${at}/custom-voices`, { method: "PUT", headers: json, body: JSON.stringify({ on }) })).status, 200);
const server = async (speechServer: string) => assert.equal((await fetch(`${at}/speech-server`, { method: "PUT", headers: json, body: JSON.stringify({ speechServer }) })).status, 200);
const SERVER_VOICES = [{ id: "af_heart" }, { id: "bm_george", name: "George" }];
const LISTED = [{ id: "af_heart", name: "af_heart" }, { id: "bm_george", name: "George" }];
const SERVERS = ["fixed", "breeze-audiocpp", "breeze-tts", "chatterbox-audiocpp", "chatterbox-tts-server"];
/** The requests the speech server got for one phrase in `voice`, the last one's body as it came, and what voice mode was given. */
const sent = async (voice?: string) => {
  let answer: globalThis.Response | undefined;
  const heard = await during(async () => (answer = await provider.speak("Hello there", { voice, signal: new AbortController().signal })));
  const last = heard.at(-1)!;
  return { heard, last, raw: last.body.toString(), body: /json/.test(last.headers["content-type"] ?? "") ? JSON.parse(last.body.toString()) : undefined, answer: answer! };
};

test("with custom voices off, every phrase is sent as before, byte for byte, whatever speech server is saved, and the library is not offered", async () => {
  answering();
  await custom(false);
  for (const saved of SERVERS) {
    await put({ sttUrl: RECOGNITION, ttsUrl: SPEECH, ttsModel: "kokoro", language: "de", voices: SERVER_VOICES, voice: "af_heart" });
    await server(saved);
    assert.deepEqual(state(), { speaks: true, voices: LISTED }, saved);
    const george = await sent("bm_george");
    assert.deepEqual(george.heard.map((h) => [h.method, h.path, h.headers["content-type"]]), [["POST", "/v1/audio/speech", "application/json"]], saved);
    assert.equal(george.raw, '{"model":"kokoro","input":"Hello there","voice":"bm_george","response_format":"wav"}', saved);
    // A voice of the library is one it does not offer: the page's own, as for any voice it does not list.
    assert.equal((await sent(clone.id)).raw, '{"model":"kokoro","input":"Hello there","voice":"af_heart","response_format":"wav"}', saved);
    assert.equal((await sent(designed.id)).raw, '{"model":"kokoro","input":"Hello there","voice":"af_heart","response_format":"wav"}', saved);
    assert.equal((await sent()).raw, '{"model":"kokoro","input":"Hello there","voice":"af_heart","response_format":"wav"}', saved);
    await put({ sttUrl: RECOGNITION, ttsUrl: SPEECH, voices: [{ id: "bm_george" }] });
    assert.equal((await sent(clone.id)).raw, '{"input":"Hello there","response_format":"wav"}', saved);
    const played = await sent("bm_george");
    assert.equal(played.answer.headers.get("content-type"), "audio/wav");
    assert.deepEqual(Buffer.from(await played.answer.arrayBuffer()), wav(SAMPLES, 24000));
  }
  assert.equal(clone.stored, undefined, "nothing was stored on a server");
});

test("on, with a server of fixed voices, nothing changes either: its ids are offered, and the library is not", async () => {
  answering();
  await server("fixed");
  await custom(true);
  await put({ sttUrl: RECOGNITION, ttsUrl: SPEECH, ttsModel: "kokoro", voices: SERVER_VOICES, voice: "af_heart" });
  assert.deepEqual(state(), { speaks: true, voices: LISTED });
  assert.equal((await sent("bm_george")).raw, '{"model":"kokoro","input":"Hello there","voice":"bm_george","response_format":"wav"}');
  assert.equal((await sent(clone.id)).raw, '{"model":"kokoro","input":"Hello there","voice":"af_heart","response_format":"wav"}');
});

test("Breeze-TTS-2 in audio.cpp is sent what the voice service sends it: streamed PCM, a description as the instruction, and a clone's recording with its words", async () => {
  await custom(true);
  await put({ sttUrl: RECOGNITION, ttsUrl: SPEECH, ttsModel: "breeze", voices: SERVER_VOICES });
  await server("breeze-audiocpp");
  // Breeze speaks with every voice of the library, and with none of the ids listed for fixed voices.
  assert.deepEqual(state(), { speaks: true, voices: [{ id: clone.id, name: "My clone" }, { id: designed.id, name: "Narrator" }] });
  upstream.answers.set("/v1/audio/speech", { type: "application/octet-stream", body: SAMPLES });
  const stream = { stream: true, stream_format: "audio", response_format: "pcm" };
  const tuning = { guidance_scale: "4", seed: "42", stream_frames_per_event: "8", stream_lookahead_margin: "4" };
  const cloned = await sent(clone.id);
  assert.deepEqual(cloned.body, {
    model: "breeze",
    input: "Hello there",
    ...stream,
    options: { instruction: "Warm and slow", ...tuning },
    voice_ref: { type: "base64", data: CLONE_WAV.toString("base64") },
    reference_text: "These are the words I said.",
  });
  // Raw PCM as it streams, labelled so for voice mode; audio.cpp sends no rate, which is 24 kHz.
  assert.equal(cloned.answer.headers.get("content-type"), "audio/pcm");
  assert.equal(cloned.answer.headers.get("x-sample-rate"), "24000");
  assert.deepEqual(Buffer.from(await cloned.answer.arrayBuffer()), SAMPLES);
  assert.deepEqual((await sent(designed.id)).body, { model: "breeze", input: "Hello there", ...stream, options: { instruction: "A deep, calm narrator", ...tuning } });
  // None, or an id it does not offer, is the server's own.
  assert.deepEqual((await sent("bm_george")).body, { model: "breeze", input: "Hello there", ...stream, options: tuning });
  assert.deepEqual((await sent()).body, { model: "breeze", input: "Hello there", ...stream, options: tuning });
  // Chosen on the page, a voice of the library is what an agent without one speaks with.
  await put({ sttUrl: RECOGNITION, ttsUrl: SPEECH, ttsModel: "breeze", voice: designed.id });
  assert.equal((await sent()).body.options.instruction, "A deep, calm narrator");
  // Voice mode plays it as it comes.
  const played = await speech("Hello");
  assert.deepEqual([played.status, played.headers.get("content-type")], [200, "audio/pcm"]);
  assert.deepEqual(Buffer.from(await played.arrayBuffer()), SAMPLES);
});

test("Breeze-TTS's own server is sent its form: the text, the description, guidance and seed, and a clone's recording as a file with its words", async () => {
  await custom(true);
  await put({ sttUrl: RECOGNITION, ttsUrl: SPEECH });
  await server("breeze-tts");
  upstream.answers.set("/v1/audio/speech", { type: "audio/pcm", headers: { "x-sample-rate": "24000" }, body: SAMPLES });
  const cloned = await sent(clone.id);
  assert.match(cloned.last.headers["content-type"]!, /^multipart\/form-data; boundary=/);
  assert.deepEqual(await formOf(cloned.last), {
    text: "Hello there",
    instruction: "Warm and slow",
    cfg_scale: "4",
    seed: "42",
    ref_audio: { name: "reference.wav", type: "audio/wav", bytes: CLONE_WAV },
    ref_text: "These are the words I said.",
  });
  assert.equal(cloned.answer.headers.get("content-type"), "audio/pcm");
  assert.deepEqual(Buffer.from(await cloned.answer.arrayBuffer()), SAMPLES);
  assert.deepEqual(await formOf((await sent(designed.id)).last), { text: "Hello there", instruction: "A deep, calm narrator", cfg_scale: "4", seed: "42" });
  assert.deepEqual(await formOf((await sent()).last), { text: "Hello there", cfg_scale: "4", seed: "42" });
});

test("Breeze busy with a phrase before is asked again until it answers, and an answer that is not 24 kHz PCM is refused", async () => {
  await custom(true);
  await put({ sttUrl: RECOGNITION, ttsUrl: SPEECH, ttsModel: "breeze" });
  const signal = new AbortController().signal;
  for (const saved of ["breeze-audiocpp", "breeze-tts", "chatterbox-audiocpp"]) {
    if (saved === "chatterbox-audiocpp") await put({ sttUrl: RECOGNITION, ttsUrl: SPEECH, ttsModel: "chatterbox", language: "en" });
    await server(saved);
    const answer = saved === "chatterbox-audiocpp" ? { type: "audio/wav", body: wav(SAMPLES, 24000) } : { type: "audio/pcm", body: SAMPLES };
    upstream.answers.set("/v1/audio/speech", { status: 409, body: "busy", next: answer });
    let spoken: globalThis.Response | undefined;
    const asked = await during(async () => (spoken = await provider.speak("Hello", { signal })));
    assert.equal(asked.length, 2, saved);
    assert.deepEqual(asked[0].body.length, asked[1].body.length, saved);
    assert.equal(spoken!.status, 200, saved);
  }
  await server("breeze-audiocpp");
  await put({ sttUrl: RECOGNITION, ttsUrl: SPEECH, ttsModel: "breeze" });
  upstream.answers.set("/v1/audio/speech", { type: "audio/wav", body: wav(SAMPLES, 24000) });
  await assert.rejects(provider.speak("Hello", { signal }), { message: "The speech server answered audio/wav, not the PCM Breeze streams" });
  upstream.answers.set("/v1/audio/speech", { type: "audio/pcm", headers: { "x-sample-rate": "48000" }, body: SAMPLES });
  await assert.rejects(provider.speak("Hello", { signal }), { message: "The speech server answered audio at 48000 Hz: voice mode plays 24 kHz" });
  upstream.answers.set("/v1/audio/speech", { status: 400, body: JSON.stringify({ error: "speech streaming requires a model configured with mode=streaming" }) });
  await assert.rejects(provider.speak("Hello", { signal }), { message: "The speech server answered HTTP 400" });
  // A server with fixed voices is asked once: a 409 there is its answer.
  await server("fixed");
  upstream.answers.set("/v1/audio/speech", { status: 409, body: "busy", next: { type: "audio/wav", body: wav(SAMPLES, 24000) } });
  const once = await during(() => assert.rejects(provider.speak("Hello", { signal }), { message: "The speech server answered HTTP 409" }));
  assert.equal(once.length, 1);
});

test("Chatterbox in audio.cpp is sent what the voice service sends it: a WAV in the input language, cloned from the recording, and it offers the clones alone", async () => {
  answering();
  await custom(true);
  await put({ sttUrl: RECOGNITION, ttsUrl: SPEECH, ttsModel: "chatterbox", language: "de" });
  await server("chatterbox-audiocpp");
  assert.deepEqual(state(), { speaks: true, voices: [{ id: clone.id, name: "My clone" }] });
  await put({ sttUrl: RECOGNITION, ttsUrl: SPEECH, ttsModel: "chatterbox", language: "de", voice: clone.id });
  const tuning = { exaggeration: "0.5", seed: "42" };
  const cloned = await sent(clone.id);
  assert.deepEqual(cloned.body, { model: "chatterbox", input: "Hello there", language: "de", response_format: "wav", options: tuning, voice_ref: { type: "base64", data: CLONE_WAV.toString("base64") } });
  assert.equal(cloned.answer.headers.get("content-type"), "audio/wav");
  // A designed voice it cannot speak: the page's own, the clone.
  assert.deepEqual((await sent(designed.id)).body, cloned.body);
  await put({ sttUrl: RECOGNITION, ttsUrl: SPEECH, ttsModel: "chatterbox", language: "de" });
  assert.deepEqual((await sent()).body, { model: "chatterbox", input: "Hello there", language: "de", response_format: "wav", options: tuning });
});

test("Chatterbox-TTS-Server is given a clone's recording once, to keep, and then each phrase names it; one it no longer has is given again", async () => {
  answering();
  await custom(true);
  await put({ sttUrl: RECOGNITION, ttsUrl: SPEECH, ttsModel: "chatterbox", language: "de" });
  await server("chatterbox-tts-server");
  assert.deepEqual(state(), { speaks: true, voices: [{ id: clone.id, name: "My clone" }] });
  const name = `${clone.id}.wav`;
  upstream.answers.set("/upload_reference", { type: "application/json", body: JSON.stringify({ message: "Processed 1 file(s).", uploaded_files: [name], all_reference_files: [name], errors: [] }) });
  const phrase = `{"model":"chatterbox","input":"Hello there","voice":"${name}","language":"de","response_format":"wav"}`;
  const first = await sent(clone.id);
  assert.deepEqual(first.heard.map((h) => [h.method, h.path]), [["POST", "/upload_reference"], ["POST", "/v1/audio/speech"]]);
  assert.deepEqual(await formOf(first.heard[0]), { files: { name, type: "audio/wav", bytes: CLONE_WAV } });
  assert.equal(first.raw, phrase);
  assert.equal(first.answer.headers.get("content-type"), "audio/wav");
  const kept = (await (await fetch(`${at}/voices`)).json()).find((v: { id: string }) => v.id === clone.id);
  assert.equal(kept.stored.url, `${upstream.at}/upload_reference`);
  assert.ok(Date.now() - Date.parse(kept.stored.at) < 60_000);
  // Stored: each phrase names it, and nothing more.
  const next = await sent(clone.id);
  assert.deepEqual(next.heard.map((h) => h.path), ["/v1/audio/speech"]);
  // The server no longer has it, installed anew say: given again, and the phrase asked again.
  upstream.answers.set("/v1/audio/speech", { status: 404, type: "application/json", body: JSON.stringify({ detail: `Voice file '${name}' not found.` }), next: { type: "audio/wav", body: wav(SAMPLES, 24000) } });
  const again = await sent(clone.id);
  assert.deepEqual(again.heard.map((h) => h.path), ["/v1/audio/speech", "/upload_reference", "/v1/audio/speech"]);
  assert.equal(again.raw, phrase);
  // At another address it is not stored yet.
  await put({ sttUrl: RECOGNITION, ttsUrl: `${upstream.at}/other/v1/audio/speech`, ttsModel: "chatterbox", language: "de" });
  upstream.answers.set("/other/upload_reference", { type: "application/json", body: JSON.stringify({ uploaded_files: [name], errors: [] }) });
  upstream.answers.set("/other/v1/audio/speech", { type: "audio/wav", body: wav(SAMPLES, 24000) });
  assert.deepEqual((await sent(clone.id)).heard.map((h) => h.path), ["/other/upload_reference", "/other/v1/audio/speech"]);
  // A server that refuses it is said so, with its own words, and nothing is spoken.
  await put({ sttUrl: RECOGNITION, ttsUrl: `${upstream.at}/third/v1/audio/speech`, ttsModel: "chatterbox", language: "de" });
  upstream.answers.set("/third/upload_reference", { status: 400, type: "application/json", body: JSON.stringify({ uploaded_files: [], errors: [{ filename: name, error: "Audio too long" }] }) });
  const refused = await during(() => assert.rejects(provider.speak("Hello", { voice: clone.id, signal: new AbortController().signal }), { message: "The speech server did not store “My clone”: Audio too long" }));
  assert.deepEqual(refused.map((h) => h.path), ["/third/upload_reference"]);
  // The server's own: no voice, and nothing stored.
  await put({ sttUrl: RECOGNITION, ttsUrl: SPEECH, ttsModel: "chatterbox" });
  const own = await sent();
  assert.deepEqual(own.heard.map((h) => h.path), ["/v1/audio/speech"]);
  assert.equal(own.raw, '{"model":"chatterbox","input":"Hello there","response_format":"wav"}');
});

test("a clone added for Chatterbox-TTS-Server is stored there at once, and again on demand; one it could not store is kept, with why", async () => {
  answering();
  await custom(true);
  await put({ sttUrl: RECOGNITION, ttsUrl: SPEECH, ttsModel: "chatterbox" });
  await server("chatterbox-tts-server");
  upstream.answers.set("/upload_reference", { type: "application/json", body: JSON.stringify({ uploaded_files: [], errors: [] }), next: { type: "application/json", body: "{}" } });
  let added: Awaited<ReturnType<typeof addVoice>> & { storeError?: string } = undefined!;
  const asked = await during(async () => (added = await addVoice({ name: "Second", kind: "clone", instruction: "Plain", transcript: "Words.", audio: CLONE_WAV.toString("base64") })));
  assert.deepEqual(asked.map((h) => h.path), ["/upload_reference"]);
  assert.equal(added.storeError, "The speech server did not store “Second”: it did not list it as stored");
  assert.equal(added.stored, undefined);
  const name = `${added.id}.wav`;
  upstream.answers.set("/upload_reference", { type: "application/json", body: JSON.stringify({ uploaded_files: [name], errors: [] }) });
  const stored = await fetch(`${at}/voices/${added.id}/store`, { method: "POST" });
  assert.equal(stored.status, 200);
  assert.equal((await stored.json()).stored.url, `${upstream.at}/upload_reference`);
  const third = await addVoice({ name: "Third", kind: "clone", instruction: "Plain", transcript: "Words.", audio: CLONE_WAV.toString("base64") });
  assert.equal(third.stored, undefined, "the server listed another file");
  const said = async (answer: Response) => [answer.status, (await answer.json()).error];
  upstream.answers.set("/upload_reference", { status: 500, body: "" });
  assert.deepEqual(await said(await fetch(`${at}/voices/${added.id}/store`, { method: "POST" })), [502, "The speech server did not store “Second”: HTTP 500"]);
  assert.deepEqual(await said(await fetch(`${at}/voices/${designed.id}/store`, { method: "POST" })), [400, "Only a clone has a recording to store on the speech server"]);
  assert.deepEqual(await said(await fetch(`${at}/voices/voice-missing/store`, { method: "POST" })), [404, "Voice not found"]);
  await put({ sttUrl: RECOGNITION, ttsUrl: `${upstream.at}/tts`, ttsModel: "chatterbox", language: "de" });
  assert.deepEqual(await said(await fetch(`${at}/voices/${added.id}/store`, { method: "POST" })), [400, "Chatterbox-TTS-Server takes a recording at /upload_reference beside a speech synthesis URL that ends in /v1/audio/speech"]);
  await server("chatterbox-audiocpp");
  assert.deepEqual(await said(await fetch(`${at}/voices/${added.id}/store`, { method: "POST" })), [400, "The speech server keeps no voices of its own: each phrase carries what it needs"]);
  // Deleting a voice asks nothing of the server, which cannot delete one.
  await server("chatterbox-tts-server");
  const deleted = await during(async () => {
    for (const id of [added.id, third.id]) assert.equal((await fetch(`${at}/voices/${id}`, { method: "DELETE" })).status, 200);
  });
  assert.deepEqual(deleted, []);
});

test("an agent given a voice of the library keeps it while custom voices are off, and speaks with the page's voice until they are on again", async () => {
  answering();
  await custom(true);
  await put({ sttUrl: RECOGNITION, ttsUrl: SPEECH, ttsModel: "chatterbox", language: "de", voices: SERVER_VOICES });
  await server("chatterbox-audiocpp");
  const { defaultAgent, setVoice, getAgent } = await import(new URL("../../../core/server/dist/agents.js", import.meta.url).href);
  const agent = defaultAgent();
  // As the Agents page chooses it: one of the voices offered now.
  setVoice(agent.id, clone.id, state()!.voices.map((v) => v.id));
  const spoken = async () => {
    const [heard] = await during(async () => assert.equal((await speech("Hello")).status, 200));
    return JSON.parse(heard.body.toString());
  };
  assert.equal((await spoken()).voice_ref.data, CLONE_WAV.toString("base64"));
  await custom(false);
  await put({ sttUrl: RECOGNITION, ttsUrl: SPEECH, ttsModel: "kokoro", language: "de", voices: SERVER_VOICES, voice: "af_heart" });
  assert.deepEqual(await spoken(), { model: "kokoro", input: "Hello", voice: "af_heart", response_format: "wav" });
  assert.equal(getAgent(agent.id).voice, clone.id);
  await custom(true);
  assert.equal((await spoken()).voice_ref.data, CLONE_WAV.toString("base64"));
  setVoice(agent.id, "", state()!.voices.map((v) => v.id));
});

test("no request to a server carries a key", () => {
  assert.ok(upstream.heard.length > 10);
  assert.deepEqual(upstream.heard.filter((heard) => "authorization" in heard.headers), []);
});
