import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "../../../tests/helpers.mts";
import { serveVoice } from "./portal.mts";
import { PCM, wav24k } from "./service.mts";

/**
 * How the voice service listens and speaks for voice mode (src/server/speech.ts): what each engine of its container is
 * sent for a recording and for a phrase, with the voice library and the settings of its page, through the portal's own
 * voice routes as voice mode reaches it, and what voice mode is answered. The engines are service.mts's.
 */

inProcessHome("pithagoras-voice-speech-");
const { machine, at, api, db } = await serveVoice();
const { addVoice } = await import("../src/server/voices.ts");
const { checkSpeech, putSettings } = await import("../src/server/store.ts");
const { state: offers } = await import("../src/server/provider.ts");
const { samplesWav } = await import("../src/web/audio.ts");
const { CHATTERBOX_LANGUAGES, INPUT_LANGUAGES } = await import("../src/languages.ts");
const { createAgent, setVoice } = await import(new URL("../../../core/server/dist/agents.js", import.meta.url).href);

const json = { "content-type": "application/json" };
/** Voice running for these engines, as voice mode's source, with nothing set on its page. */
async function engines(recipe: string) {
  machine.putVoice({ Labels: { "pithagoras.addon": "voice", "pithagoras.voice-network": "shared-v1", "pithagoras.voice-recipe": recipe }, HostConfig: { NetworkMode: "container:portal-one" }, State: "running" });
  assert.equal((await (await fetch(`${at}/state`)).json()).state, "running");
}
const reset = () => {
  machine.reset();
  machine.hostGpus(null);
  db.putSetting("voice", JSON.stringify({ provider: "pithagoras-voice" }));
};
/** The settings of the page, as it saves them. */
const setSpeech = (patch: Record<string, unknown>) => fetch(`${at}/speech`, { method: "PUT", headers: json, body: JSON.stringify(patch) });
/** A phrase voice mode asks for, in the chat `session`. */
const speak = (text: string, session = "talk", signal?: AbortSignal) => fetch(`${api}/sessions/${session}/voice/speech`, { method: "POST", headers: json, body: JSON.stringify({ text }), signal });
/** A recording voice mode sends, as voice mode or as dictation. */
const transcribe = (query = "") => fetch(`${api}/sessions/talk/voice/transcribe${query}`, { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array(wav24k(Buffer.alloc(32))) });
/** What the speech engine was last asked. */
const asked = () => machine.voiceProcesses.spoken.at(-1)!;
/** What recognition was last sent. */
const sent = () => machine.voiceProcesses.heard.at(-1)!;
const recording = async () => Buffer.from(await samplesWav(new Float32Array(16000)).arrayBuffer()).toString("base64");
db.createSession({ id: "talk", title: "Talk", workspace: process.env.WORKSPACE_ROOT!, executor: "host" });

test("recognition is sent the recording, the language set and, for audio.cpp, its model, and voice mode the words", async () => {
  reset();
  await engines("breeze+whisper:base");
  const answer = await transcribe();
  assert.deepEqual([answer.status, await answer.json()], [200, { text: "Heard you." }]);
  assert.equal(sent().url, "http://127.0.0.1:8188/inference");
  assert.equal((sent().form.get("file") as File).name, "recording.wav");
  assert.deepEqual([sent().form.get("response_format"), sent().form.get("language"), sent().form.get("model")], ["json", "auto", null]);
  for (const language of ["en", "hi", "bn"]) {
    assert.equal((await setSpeech({ language })).status, 200);
    assert.equal((await transcribe("?purpose=dictation")).status, 200);
    assert.equal(sent().form.get("language"), language);
  }
  const refused = await setSpeech({ language: "invalid" });
  assert.deepEqual([refused.status, (await refused.json()).error], [400, "Choose a supported input language"]);
  // Qwen3-ASR in audio.cpp, on the GPU beside the speech engine, and on the CPU.
  await engines("breeze+qwen3-asr:0.6b");
  await transcribe();
  assert.deepEqual([sent().url, sent().form.get("model"), sent().form.get("language")], ["http://127.0.0.1:7862/v1/audio/transcriptions", "qwen3-asr", "bn"]);
  await engines("breeze+qwen3-asr:0.6b@cpu");
  await transcribe();
  assert.equal(sent().url, "http://127.0.0.1:7863/v1/audio/transcriptions");
});

test("Breeze speaks a voice of the library with its recording, its words and its description, a changed description from the next phrase, and its PCM as PCM", async () => {
  reset();
  await engines("breeze+whisper:base");
  const audio = await recording();
  const clone = addVoice({ name: "Custom narrator", kind: "clone", instruction: "Warm narrator.", transcript: "My reference words.", audio });
  assert.equal((await setSpeech({ voice: clone.id, cfgScale: 1 })).status, 200);
  const response = await speak("Custom voice response.");
  assert.equal(response.status, 200);
  assert.deepEqual([response.headers.get("content-type"), response.headers.get("x-sample-rate")], ["audio/pcm", "24000"]);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PCM, "audio.cpp's octet-stream, played as PCM");
  assert.equal(asked().url, "http://127.0.0.1:7862/v1/audio/speech");
  assert.deepEqual(asked().body, {
    model: "breeze", input: "Custom voice response.", stream: true, stream_format: "audio", response_format: "pcm",
    options: { instruction: "Warm narrator.", guidance_scale: "1", seed: "42", stream_frames_per_event: "8", stream_lookahead_margin: "4" },
    voice_ref: { type: "base64", data: audio }, reference_text: "My reference words.",
  });
  const edited = await fetch(`${at}/voices/${clone.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ instruction: "  A slow, low voice.  " }) });
  assert.equal(edited.status, 200);
  await (await speak("Edited voice response.")).arrayBuffer();
  assert.equal(asked().body.options.instruction, "A slow, low voice.");
  assert.deepEqual([asked().body.voice_ref, asked().body.reference_text], [{ type: "base64", data: audio }, "My reference words."]);
  // The designed voice speaks as it is described on the page, with no recording.
  assert.equal((await setSpeech({ voice: "design", instruction: "A calm English voice.", cfgScale: 4 })).status, 200);
  await (await speak("Designed.")).arrayBuffer();
  assert.deepEqual([asked().body.options.instruction, asked().body.options.guidance_scale, asked().body.voice_ref], ["A calm English voice.", "4", undefined]);
  // An agent with a voice of the library speaks with it; the chat is with the agent whose home it is in.
  const agent = createAgent({ name: "Herald" });
  setVoice(agent.id, clone.id, offers()!.voices.map((v) => v.id));
  db.createSession({ id: "herald-chat", title: "Herald", workspace: agent.home, executor: "host" });
  await (await speak("Hello.", "herald-chat")).arrayBuffer();
  assert.equal(asked().body.reference_text, "My reference words.", "the agent's clone, not the designed voice of the page");
  // An agent whose voice is the designed one speaks with it, though the page's own voice is a clone.
  assert.equal((await setSpeech({ voice: clone.id })).status, 200);
  const designer = createAgent({ name: "Designer" });
  setVoice(designer.id, "design", offers()!.voices.map((v) => v.id));
  db.createSession({ id: "designer-chat", title: "Designer", workspace: designer.home, executor: "host" });
  await (await speak("Designed.", "designer-chat")).arrayBuffer();
  assert.deepEqual([asked().body.options.instruction, asked().body.voice_ref, asked().body.reference_text], ["A calm English voice.", undefined, undefined]);
  // A voice chosen on the page that has gone since is the designed one.
  putSettings({ voice: "voice-gone" });
  await (await speak("Gone.")).arrayBuffer();
  assert.deepEqual([asked().body.options.instruction, asked().body.voice_ref], ["A calm English voice.", undefined]);
});

test("what Breeze answers that voice mode cannot play is refused with its name, and so is an error of the engine", async () => {
  reset();
  await engines("breeze+whisper:base");
  for (const [answer, error] of [
    [() => new Response("not here", { status: 503 }), "Breeze returned HTTP 503"],
    [() => Response.json({ detail: "not audio" }), "Expected PCM audio from the Breeze API"],
    [() => new Response(PCM, { headers: { "content-type": "audio/pcm", "x-sample-rate": "16000" } }), "Unsupported Breeze sample rate: 16000"],
  ] as const) {
    machine.voiceProcesses.speak = answer;
    const refused = await speak("Hello.");
    assert.deepEqual([refused.status, (await refused.json()).error], [502, error]);
  }
});

test("PCM reaches the page as the engine makes it, and the page going away stops the engine's phrase", async () => {
  reset();
  await engines("breeze+whisper:base");
  let release!: () => void;
  let stopped!: () => void;
  const engineStopped = new Promise<void>((resolve) => { stopped = resolve; });
  machine.voiceProcesses.speak = (_body, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0, 0]));
      release = () => { controller.enqueue(new Uint8Array([255, 127])); controller.close(); };
      // As fetch ends a body whose request was given up.
      init?.signal?.addEventListener("abort", () => { stopped(); controller.error(new Error("aborted")); });
    },
  }), { headers: { "content-type": "audio/pcm", "x-sample-rate": "24000" } });
  const response = await speak("Streamed.");
  const reader = response.body!.getReader();
  assert.deepEqual((await reader.read()).value, new Uint8Array([0, 0]));
  release();
  assert.deepEqual((await reader.read()).value, new Uint8Array([255, 127]));
  assert.equal((await reader.read()).done, true);
  const page = new AbortController();
  const next = await speak("Streamed again.", "talk", page.signal);
  await next.body!.getReader().read();
  page.abort();
  await Promise.race([engineStopped, new Promise((_, reject) => setTimeout(() => reject(new Error("the engine was not stopped")), 2000).unref())]);
});

test("an engine busy with a phrase before is asked again until it answers", async () => {
  reset();
  await engines("breeze+whisper:base");
  let attempts = 0;
  machine.voiceProcesses.speak = () => (++attempts <= 2 ? Response.json({ detail: "busy" }, { status: 409 }) : new Response(PCM, { headers: { "content-type": "application/octet-stream" } }));
  const response = await speak("Busy.");
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PCM);
  assert.equal(attempts, 3);
});

test("Chatterbox clones a voice of the library, writes numbers out, and speaks only with a clone", async () => {
  reset();
  await engines("chatterbox+qwen3-asr:1.7b");
  const audio = await recording();
  const clone = addVoice({ name: "Reference", kind: "clone", instruction: "A calm voice.", transcript: "Reference voice.", audio });
  const designed = addVoice({ name: "Described", kind: "design", instruction: "A bright voice." });
  assert.equal((await setSpeech({ voice: clone.id, language: "de", exaggeration: 0.3 })).status, 200);
  const response = await speak("Der Build nutzt 4070 Megabyte.");
  assert.equal(response.status, 200);
  assert.deepEqual([response.headers.get("content-type"), response.headers.get("x-sample-rate")], ["audio/pcm", "24000"]);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PCM, "its WAV, played as PCM");
  assert.deepEqual(asked().body, {
    model: "chatterbox", input: "Der Build nutzt viertausendsiebzig Megabyte.", language: "de", response_format: "wav",
    options: { exaggeration: "0.3", seed: "42" }, voice_ref: { type: "base64", data: audio },
  });
  // Recognition is told the language too.
  await transcribe();
  assert.deepEqual([sent().form.get("model"), sent().form.get("language")], ["qwen3-asr", "de"]);
  // Refused on save, not on every phrase of a conversation: no designed voice, no detection, and its languages only.
  for (const [patch, error] of [
    [{ voice: "design" }, "Chatterbox speaks with a reference clone: choose a voice with a recording"],
    [{ voice: designed.id }, "Chatterbox speaks with a reference clone: choose a voice with a recording"],
    [{ language: "auto" }, "Chatterbox needs an input language: auto-detect selects no voice"],
    [{ language: "ru" }, `Chatterbox speaks: ${CHATTERBOX_LANGUAGES.join(", ")}`],
    [{ exaggeration: 5 }, "Expressiveness must be between 0 and 2"],
  ] as const) {
    const refused = await setSpeech(patch);
    assert.deepEqual([refused.status, (await refused.json()).error], [400, error], JSON.stringify(patch));
  }
  assert.equal((await setSpeech({ language: "nl" })).status, 200);
  // A voice that is no clone, said past the page, is said where a phrase is asked for.
  putSettings({ voice: designed.id });
  const refused = await speak("Hallo.");
  assert.deepEqual([refused.status, (await refused.json()).error], [502, "Chatterbox speaks with a reference clone: choose a voice with a recording on the Voice service page"]);
});

test("Kokoro speaks with a voice of its own, at the speed chosen, and an agent with one of its voices", async () => {
  reset();
  await engines("kokoro@cpu+whisper:base");
  const audio = await recording();
  const clone = addVoice({ name: "Library clone", kind: "clone", instruction: "Warm.", transcript: "Library words.", audio });
  assert.equal((await setSpeech({ voice: clone.id, kokoroVoice: "bf_emma", speed: 1.15 })).status, 200);
  const response = await speak("It costs 12 dollars.");
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PCM);
  // On the CPU, in the CPU process. The voice names the language, and the voice of the library is not sent.
  assert.equal(asked().url, "http://127.0.0.1:7863/v1/audio/speech");
  assert.deepEqual(asked().body, { model: "kokoro", input: "It costs 12 dollars.", voice: "bf_emma", speed: 1.15, response_format: "wav", options: { seed: "42" } });
  // An agent with one of Kokoro's voices speaks with it; one with a voice of the library speaks as the page says.
  const agent = createAgent({ name: "Kokoro agent" });
  setVoice(agent.id, "am_onyx", offers()!.voices.map((v) => v.id));
  db.createSession({ id: "kokoro-chat", title: "Kokoro", workspace: agent.home, executor: "host" });
  await (await speak("Hi.", "kokoro-chat")).arrayBuffer();
  assert.equal(asked().body.voice, "am_onyx");
  db.getDb().prepare("UPDATE agents SET voice = ? WHERE id = ?").run(clone.id, agent.id);
  await (await speak("Hi.", "kokoro-chat")).arrayBuffer();
  assert.equal(asked().body.voice, "bf_emma");
  // On Breeze, an agent's Kokoro voice is not taken for one of the library: the page's voice speaks.
  db.getDb().prepare("UPDATE agents SET voice = ? WHERE id = ?").run("am_onyx", agent.id);
  await engines("breeze+whisper:base");
  await (await speak("Hi.", "kokoro-chat")).arrayBuffer();
  assert.deepEqual([asked().body.model, asked().body.reference_text], ["breeze", "Library words."]);
  // Only its packaged voices, without the Japanese ones it cannot read, and the speeds the page offers.
  for (const [patch, error] of [[{ kokoroVoice: "jf_alpha" }, "Choose one of Kokoro's voices"], [{ speed: 3 }, "Choose a supported speaking speed"]] as const) {
    const refused = await setSpeech(patch);
    assert.deepEqual([refused.status, (await refused.json()).error], [400, error]);
  }
  reset();
  const { kokoroVoice, speed } = await (await fetch(`${at}/speech`)).json();
  assert.deepEqual([kokoroVoice, speed], ["af_heart", 1]);
});

test("a voice that is not in the library is refused rather than spoken in another", () => {
  assert.throws(() => checkSpeech({ voice: "missing" }), /Voice not found/);
  assert.throws(() => checkSpeech({ voice: "../other" }), /Voice not found/);
  assert.throws(() => checkSpeech({ voice: 7 }), /Choose a speaking voice/);
  assert.deepEqual(checkSpeech({ voice: "design" }), { voice: "design" });
});

test("every language a runtime accepts is one the page offers", () => {
  for (const code of CHATTERBOX_LANGUAGES) assert.ok(INPUT_LANGUAGES.some(([value]) => value === code), `${code} is missing from the input languages`);
  assert.equal(checkSpeech({ language: "sw" }).language, "sw");
});
