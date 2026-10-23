import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { inProcessHome } from "./server-harness.mjs";

/**
 * Voice mode listens and speaks through the extension chosen as its source (`portal.voice.choose`), which offers it
 * recognition, speech and its voices (`portal.voice.provide`): here the stand-in tests/fixtures/extensions/speaker,
 * which answers in its own process.
 */
const home = inProcessHome("voice-providers-");
// The leases run out by the clock they are made with: one the tests can move on, set before they are made.
const realNow = Date.now;
let later = 0;
Date.now = () => realNow() + later;
// The voice routes look at the leases every 30 seconds: a timer the tests move on, set before the routes make it.
mock.timers.enable({ apis: ["setInterval"] });

const { default: express } = await import("express");
const host = await import("../dist/extension-host.js");
const { voiceRouter, providerUse, providerCall } = await import("../dist/api/voice.js");
const { agentsRouter } = await import("../dist/api/agents.js");
const { createSession, getSetting, putSetting, voiceSpeaks } = await import("../dist/db.js");
const { createAgent } = await import("../dist/agents.js");
const { AudioRule } = await import("../dist/pi/voice-first.js");

const SPEAKER = fileURLToPath(new URL("../../../tests/fixtures/extensions/speaker/server.js", import.meta.url));
let revs = 0;
/** The stand-in's server half under a name, started anew each time it is given: another module, as an update would be. */
const speaker = (name = "test-speaker") => ({ name, version: "0.1.0", file: SPEAKER, rev: `${statSync(SPEAKER).size.toString(36)}-${++revs}` });

const app = express();
// As the portal does: one parser for everything but what reads its own.
const json = express.json();
app.use((req, res, next) => (req.path.startsWith("/api/x/") ? next() : json(req, res, next)));
app.use("/api/x", host.extensionRoutes);
app.use("/api", agentsRouter());
app.use("/api", voiceRouter());
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
test.after(async () => {
  await host.stopServerHalves();
  server.closeAllConnections();
  server.close();
  Date.now = realNow;
  mock.timers.reset();
});
const at = (p) => `http://127.0.0.1:${server.address().port}${p}`;
const send = (method, p, body) => fetch(at(p), { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const voice = async () => (await fetch(at("/api/voice"))).json();
const asked = async (name = "test-speaker") => (await fetch(at(`/api/x/${name}/state`))).json();
const set = (settings, name = "test-speaker") => send("PUT", `/api/x/${name}/settings`, settings);
const choose = (chosen, name = "test-speaker") => send("POST", `/api/x/${name}/choose`, { chosen });
const chosen = async (name = "test-speaker") => (await (await fetch(at(`/api/x/${name}/chosen`))).json()).chosen;
const stopUsing = () => fetch(at("/api/voice/provider"), { method: "DELETE" });
// A WAV of silence, as the page records one.
const recording = () => {
  const wav = Buffer.alloc(76);
  wav.write("RIFF"); wav.writeUInt32LE(68, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(32, 40);
  return wav;
};
const transcribe = (query = "", signal) => fetch(at(`/api/sessions/talk/voice/transcribe${query}`), { method: "POST", headers: { "content-type": "audio/wav" }, body: recording(), signal });
const speak = (session = "talk", signal) => fetch(at(`/api/sessions/${session}/voice/speech`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Hello there." }), signal });
const lease = (client, active) => send("POST", "/api/sessions/talk/voice/connection", { client, active });
const agentVoice = (id, value) => send("PUT", `/api/agents/${id}/voice`, { voice: value });
const NOT_RUNNING = "Voice mode listens and speaks through test-speaker, which is not running: install or start it in Settings → Extensions, or stop using it in Settings → Defaults → Voice mode";
const NO_SOURCE = "Voice mode has no source: choose one on the page of an extension that provides it, in Settings → Extensions";
const NOT_OFFERED = "Choose one of the voices voice mode's source offers now, or none";
const CONVERSATION_OFF = "Voice conversations are switched off in Settings → Defaults → Voice mode: dictation still works";
/** Waits for `ready`, and fails rather than waiting for ever. */
async function until(ready, what) {
  for (let i = 0; !(await ready()); i++) {
    assert.ok(i < 200, `waited 2 s for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
/** What console.error said while `work` ran, a line each. */
async function logged(work) {
  const lines = [];
  const error = console.error;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    await work();
  } finally {
    console.error = error;
  }
  return lines;
}

const work = path.join(process.env.WORKSPACE_ROOT, "talk");
mkdirSync(work, { recursive: true });
createSession({ id: "talk", title: "Talk", workspace: work, executor: "host" });
await host.syncServerHalves([speaker()]);

test("with no source voice mode is off: a session's voice routes say so, and nothing speaks", async () => {
  const shown = await voice();
  assert.deepEqual([shown.provider, shown.label, shown.ready, shown.speech, shown.voices, shown.enabled], ["", undefined, false, true, [], false]);
  for (const answer of [await transcribe(), await speak(), await lease("none", true)]) {
    assert.equal(answer.status, 409);
    assert.equal((await answer.json()).error, NO_SOURCE);
  }
  assert.equal(voiceSpeaks(), false);
  assert.equal(await chosen(), false);
  assert.deepEqual(await asked(), { uses: [], heard: [], spoken: [], aborted: 0, cancelled: 0 });
});

test("an extension makes itself the source and says whether it is; Stop using in Settings takes it away", async () => {
  assert.equal((await choose(true)).status, 200);
  const shown = await voice();
  assert.deepEqual(
    [shown.provider, shown.label, shown.ready, shown.speech, shown.voices, shown.enabled],
    ["test-speaker", "Speaker", true, true, [{ id: "speaker-warm", name: "Warm" }], true],
  );
  assert.equal(await chosen(), true);
  assert.equal(voiceSpeaks(), true);
  const stopped = await stopUsing();
  assert.equal(stopped.status, 200);
  assert.deepEqual([(await stopped.json()).provider, await chosen(), voiceSpeaks()], ["", false, false]);
  await choose(true);
});

test("a recording reaches the source with its purpose, and its words come back trimmed, timed as recognition", async () => {
  const heard = await transcribe();
  assert.deepEqual(await heard.json(), { text: "Heard by the speaker." });
  assert.match(heard.headers.get("server-timing"), /^stt;dur=[\d.]+$/);
  assert.equal((await transcribe("?purpose=dictation")).status, 200);
  assert.deepEqual((await asked()).heard, [{ purpose: "voice", bytes: 76 }, { purpose: "dictation", bytes: 76 }]);
  const bad = await fetch(at("/api/sessions/talk/voice/transcribe"), { method: "POST", headers: { "content-type": "audio/wav" }, body: "not a recording" });
  assert.deepEqual([bad.status, (await bad.json()).error], [400, "A WAV recording is required"]);
  assert.equal((await asked()).heard.length, 2, "and the source is not asked");
});

test("speech is passed on as 24 kHz PCM, as the source streams it or from the WAV it answers, in the agent's voice or the source's own choice", async () => {
  const played = async (answer) => {
    assert.equal(answer.status, 200);
    assert.deepEqual(
      ["content-type", "x-sample-rate", "x-sample-format", "cache-control", "x-voice-streaming"].map((name) => answer.headers.get(name)),
      ["audio/pcm", "24000", "s16le", "no-store", null],
    );
    assert.match(answer.headers.get("server-timing"), /^tts_headers;dur=[\d.]+$/);
    assert.deepEqual([...new Uint8Array(await answer.arrayBuffer())], [0, 0, 255, 127]);
  };
  await played(await speak());
  await set({ answer: "wav" });
  await played(await speak());
  await set({ answer: "pcm" });
  assert.deepEqual((await asked()).spoken, [{ text: "Hello there.", voice: null }, { text: "Hello there.", voice: null }]);
  // An agent's voice is the id it keeps, which the source is given.
  const agent = createAgent({ name: "Speaker agent" });
  assert.equal((await agentVoice(agent.id, "speaker-warm")).status, 200);
  createSession({ id: "agent-talk", title: "Agent talk", workspace: agent.home, executor: "host" });
  await played(await speak("agent-talk"));
  assert.deepEqual((await asked()).spoken.at(-1), { text: "Hello there.", voice: "speaker-warm" });
  assert.equal((await asked()).cancelled, 0, "nothing played is cancelled");
});

test("what voice mode cannot play is a 502 that names the source, and what it answered is let go of", async () => {
  for (const [answer, error, cancels] of [
    ["pcm48k", "Speaker answered audio at 48000 Hz: voice mode plays 24 kHz", 1],
    ["wav22k", "Expected mono 24 kHz 16-bit audio from Speaker", 1],
    ["text", "Speaker answered text/plain: voice mode plays audio/pcm or audio/wav", 1],
    ["notOk", "Speaker answered HTTP 500", 1],
    ["notResponse", "Speaker gave no audio", 0],
    ["throws", "The speaker lost its voice", 0],
  ]) {
    await set({ answer });
    const before = (await asked()).cancelled;
    const refused = await speak();
    assert.deepEqual([refused.status, (await refused.json()).error], [502, error], answer);
    assert.equal((await asked()).cancelled - before, cancels, answer);
  }
  await set({ answer: "throws" });
  const deaf = await transcribe();
  assert.deepEqual([deaf.status, (await deaf.json()).error], [502, "The speaker could not hear"]);
  await set({ answer: "pcm" });
});

test("a request that is closed ends the signal the source was given, and a source that does not answer is let go of after the limit", async () => {
  await set({ answer: "hangs" });
  const before = await asked();
  const gone = new AbortController();
  // Long enough for the signal to be seen to end by the close, and not so long that the test waits for the limit after.
  providerCall.limitMs = 5000;
  try {
    const asking = speak("talk", gone.signal).catch(() => {});
    await until(async () => (await asked()).spoken.length > before.spoken.length, "the phrase to be asked for");
    gone.abort();
    await asking;
    await until(async () => (await asked()).aborted > before.aborted, "the signal to end");
    // A recording the page gave up on, as at barge-in or End: recognising it ends too.
    const ended = (await asked()).aborted;
    const left = new AbortController();
    const hearing = transcribe("", left.signal).catch(() => {});
    await until(async () => (await asked()).heard.length > before.heard.length, "the recording to be sent");
    left.abort();
    await hearing;
    await until(async () => (await asked()).aborted > ended, "the signal to end");
    providerCall.limitMs = 50;
    const spoken = await speak();
    assert.deepEqual([spoken.status, (await spoken.json()).error], [502, "It had not finished speaking after 0.05 seconds"]);
    const heard = await transcribe();
    assert.deepEqual([heard.status, (await heard.json()).error], [502, "It had not finished recognising speech after 0.05 seconds"]);
  } finally {
    providerCall.limitMs = 120_000;
  }
  await set({ answer: "pcm" });
});

test("a source that recognises speech alone: dictation works, and replies are not spoken", async () => {
  await set({ speaks: false });
  assert.equal((await voice()).speech, false);
  assert.equal(voiceSpeaks(), false);
  const spoken = await speak();
  assert.deepEqual([spoken.status, (await spoken.json()).error], [409, "Voice mode's source recognises speech alone: replies are not spoken"]);
  assert.equal((await transcribe("?purpose=dictation")).status, 200);
  await set({ speaks: true });
  assert.equal(voiceSpeaks(), true);
});

test("voice mode says that its source is not running, rather than use anything else; what it says it offers is checked", async () => {
  const check = async () => {
    for (const answer of [await transcribe(), await transcribe("?purpose=dictation"), await speak(), await lease("waiting", true)]) {
      assert.equal(answer.status, 503);
      assert.equal((await answer.json()).error, NOT_RUNNING);
    }
    // Voice mode is still offered: starting it says why it cannot. Nothing speaks meanwhile.
    const shown = await voice();
    assert.deepEqual([shown.ready, shown.speech, shown.voices], [false, true, []]);
    assert.equal(voiceSpeaks(), false);
  };
  // It cannot say what it offers: the settings are read all the same, and what it said is logged.
  await set({ stateThrows: true });
  let lines = await logged(check);
  assert.ok(lines.some((line) => line.includes("[extension test-speaker] saying what it offers voice mode failed") && line.includes("The speaker lost track of its engines")), lines.join("\n"));
  await set({ stateThrows: false });
  // What it says is not an answer: the same, and what it said is logged.
  for (const stateAnswers of [
    { speaks: "yes", voices: [] },
    { speaks: true },
    { speaks: true, voices: [{ id: "", name: "Nameless" }] },
    { speaks: true, voices: [{ id: "calm" }] },
    { speaks: true, voices: [{ id: "calm", name: "Calm", builtIn: "yes" }] },
    "here",
  ]) {
    await set({ stateAnswers });
    lines = await logged(check);
    assert.ok(lines.some((line) => line.includes("[extension test-speaker] saying what it offers voice mode failed") && line.includes(`state answered ${JSON.stringify(stateAnswers)}`)), lines.join("\n"));
  }
  // A voice of its own, which the portal shows in the source's own words, is said so; one the person named is not.
  const offered = [{ id: "design", name: "Designed voice", builtIn: true }, { id: "calm", name: "Calm" }];
  await set({ stateAnswers: { speaks: true, voices: offered } });
  assert.deepEqual([(await voice()).ready, (await voice()).voices], [true, offered]);
  await set({ stateAnswers: null });
  // Its engines are down: it offers nothing.
  await set({ ready: false });
  await check();
  await set({ ready: true });
  // Its server half is not running at all: it is still the source, by name.
  await host.syncServerHalves([]);
  assert.deepEqual([(await voice()).provider, (await voice()).label], ["test-speaker", undefined]);
  await check();
  // Back, it is used again.
  await host.syncServerHalves([speaker()]);
  assert.equal((await transcribe()).status, 200);
});

test("the source is told voice mode is in use at the first lease, and that it is not after the last, also one that ran out", async () => {
  const uses = async () => (await asked()).uses;
  assert.deepEqual(await (await lease("a", true)).json(), { ok: true });
  assert.deepEqual(await uses(), [true]);
  // A second tab, and each tab's heartbeat: it is told once.
  await lease("b", true);
  await lease("a", true);
  assert.deepEqual(await uses(), [true]);
  await lease("a", false);
  assert.deepEqual(await uses(), [true]);
  await lease("b", false);
  assert.deepEqual(await uses(), [true, false]);
  // A tab that went without saying so: its lease runs out, and the look at the leases every 30 seconds finds that.
  await lease("c", true);
  assert.deepEqual(await uses(), [true, false, true]);
  later += 76_000;
  mock.timers.tick(30_000);
  await until(async () => (await uses()).length === 4, "the lease that ran out to be given back");
  assert.deepEqual(await uses(), [true, false, true, false]);
  // What it fails at as voice mode begins is the page's error, and it is asked again at the next lease.
  await set({ fails: true });
  const failed = await lease("d", true);
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).error, "The speaker could not load its model");
  await set({ fails: false });
  await lease("d", true);
  assert.deepEqual(await uses(), [true, false, true, false, true]);
  await lease("d", false);
  // One that never answers holds up no voice session for longer than the limit: its lease is refused, and the leases go on.
  providerUse.limitMs = 50;
  try {
    await set({ hangs: true });
    const hung = await lease("e", true);
    assert.equal(hung.status, 503);
    assert.match((await hung.json()).error, /had not finished getting ready for voice mode/);
  } finally {
    providerUse.limitMs = 120_000;
  }
  await set({ hangs: false });
  assert.deepEqual(await (await lease("e", true)).json(), { ok: true });
  assert.deepEqual(await (await lease("e", false)).json(), { ok: true });
});

test("a server half started anew while voice mode is in use is told so again, and is the one told that it is no longer used", async () => {
  const told = globalThis.speakerTold;
  told.length = 0;
  const first = globalThis.speakerInstances;
  await lease("d", true);
  // Started anew by the next heartbeat: the one before is gone and is not asked.
  await host.syncServerHalves([speaker()]);
  const second = globalThis.speakerInstances;
  await lease("d", true);
  await lease("d", false);
  // Started anew after it was told, and the last lease ends before a heartbeat: the one there now is told.
  await lease("d", true);
  await host.syncServerHalves([speaker()]);
  const third = globalThis.speakerInstances;
  await lease("d", false);
  assert.deepEqual(told, [`test-speaker#${first} true`, `test-speaker#${second} true`, `test-speaker#${second} false`, `test-speaker#${second} true`, `test-speaker#${third} false`]);
});

test("a lease asked for while there was a source, and none by the time it is its turn, is refused and holds nothing", async () => {
  // The first lease waits on the source getting ready; the second, asked for meanwhile, waits behind it.
  await set({ hangs: true });
  providerUse.limitMs = 300;
  try {
    const first = lease("r1", true);
    const second = lease("r2", true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await stopUsing()).status, 200);
    assert.equal((await first).status, 503);
    assert.equal((await second).status, 503);
  } finally {
    providerUse.limitMs = 120_000;
  }
  await set({ hangs: false });
  await choose(true);
  // Neither holds a lease: the last one now is the last one there is.
  const before = (await asked()).uses.length;
  await lease("r3", true);
  await lease("r3", false);
  assert.deepEqual((await asked()).uses.slice(before), [true, false]);
});

test("an extension stops being the source only where it is; a source that is not running stays chosen", async () => {
  await host.syncServerHalves([speaker(), speaker("other-speaker")]);
  await choose(true);
  await choose(false, "other-speaker");
  assert.deepEqual([(await voice()).provider, await chosen(), await chosen("other-speaker")], ["test-speaker", true, false]);
  await choose(true, "other-speaker");
  assert.deepEqual([(await voice()).provider, await chosen(), await chosen("other-speaker")], ["other-speaker", false, true]);
  await choose(false);
  assert.equal((await voice()).provider, "other-speaker");
  await choose(false, "other-speaker");
  assert.deepEqual([(await voice()).provider, (await voice()).enabled], ["", false]);
  await choose(true, "other-speaker");
  await host.syncServerHalves([speaker()]);
  assert.deepEqual([(await voice()).provider, (await voice()).ready], ["other-speaker", false]);
  await choose(true);
});

test("the source changing while voice mode is in use: the one before is told it is no longer used, at the next heartbeat or when the lease runs out", async () => {
  const told = globalThis.speakerTold;
  const mainSpeaker = speaker();
  await host.syncServerHalves([mainSpeaker]);
  const one = globalThis.speakerInstances;
  await host.syncServerHalves([mainSpeaker, speaker("other-speaker")]);
  const other = globalThis.speakerInstances;
  told.length = 0;
  await choose(true);
  await lease("x", true);
  // Another extension chosen meanwhile: it is told at the next heartbeat, and the one before that it is no longer used.
  await choose(true, "other-speaker");
  await lease("x", true);
  // That one started anew: only the one there now is told.
  await host.syncServerHalves([mainSpeaker, speaker("other-speaker")]);
  const again = globalThis.speakerInstances;
  await lease("x", true);
  assert.deepEqual(told, [`test-speaker#${one} true`, `other-speaker#${other} true`, `test-speaker#${one} false`, `other-speaker#${again} true`]);
  // Stopped using meanwhile: the session's voice routes are closed, and the lease runs out.
  await stopUsing();
  assert.equal((await lease("x", true)).status, 409);
  later += 76_000;
  mock.timers.tick(30_000);
  await until(() => told.length === 5, "the lease that ran out to be given back");
  assert.equal(told[4], `other-speaker#${again} false`);
  await choose(true);
});

test("a save of voice mode's settings keeps the source and every setting it does not name, and Stop using does too", async () => {
  const saved = () => JSON.parse(getSetting("voice"));
  // As the upgrade keeps them where it could not leave them yet: fields voice mode does not read any more.
  putSetting("voice", JSON.stringify({ ...saved(), whisperUrl: "http://kept.example.test/inference", enabled: true }));
  const answer = await send("PUT", "/api/voice", { provider: "other-speaker", responseInstructions: "Answer briefly." });
  assert.equal(answer.status, 200);
  const shown = await answer.json();
  assert.deepEqual([shown.provider, shown.responseInstructions, shown.whisperUrl], ["test-speaker", "Answer briefly.", undefined]);
  assert.deepEqual([saved().provider, saved().responseInstructions, saved().whisperUrl, saved().enabled], ["test-speaker", "Answer briefly.", "http://kept.example.test/inference", true]);
  const refused = await send("PUT", "/api/voice", { vad: { redemptionMs: 0 } });
  assert.equal(refused.status, 400);
  assert.equal(saved().responseInstructions, "Answer briefly.", "a refused save changes nothing");
  await stopUsing();
  assert.deepEqual([saved().provider, saved().whisperUrl], ["", "http://kept.example.test/inference"]);
  putSetting("voice", JSON.stringify({ provider: "" }));
  await choose(true);
});

test("voice conversations switched off leave dictation alone: voice mode's lease and speech are refused, nothing speaks, and a lease is still given back", async () => {
  const saved = () => JSON.parse(getSetting("voice"));
  const uses = async () => (await asked()).uses;
  // The rule for spoken replies as a conversation that has had none has it: while voice mode can speak.
  const rule = () => {
    const audio = new AudioRule(undefined, undefined, voiceSpeaks);
    audio.set(false);
    return audio.lines().length;
  };
  // On where nothing is saved of it, as every setup was before there was a switch.
  assert.equal(saved().conversation, undefined);
  assert.deepEqual([(await voice()).conversation, voiceSpeaks(), rule()], [true, true, 1]);
  // A voice session that is on as they are switched off.
  await lease("held", true);
  const before = (await uses()).length;
  const off = await send("PUT", "/api/voice", { conversation: false });
  assert.equal(off.status, 200);
  assert.deepEqual([(await off.json()).conversation, saved().conversation, saved().provider], [false, false, "test-speaker"]);
  assert.deepEqual([voiceSpeaks(), rule()], [false, 0]);
  for (const answer of [await speak(), await lease("held", true), await lease("new", true)]) {
    assert.deepEqual([answer.status, (await answer.json()).error], [409, CONVERSATION_OFF]);
  }
  // Its End still gives the lease back, and the source hears at once that voice mode is no longer used.
  assert.deepEqual(await (await lease("held", false)).json(), { ok: true });
  assert.deepEqual((await uses()).slice(before), [false]);
  // Dictation is heard as before.
  const heard = await transcribe("?purpose=dictation");
  assert.deepEqual([heard.status, await heard.json()], [200, { text: "Heard by the speaker." }]);
  assert.deepEqual((await asked()).heard.at(-1), { purpose: "dictation", bytes: 76 });
  const wrong = await send("PUT", "/api/voice", { conversation: "no" });
  assert.deepEqual([wrong.status, (await wrong.json()).error], [400, "Voice conversations are switched on with true and off with false"]);
  assert.equal(saved().conversation, false, "a refused save changes nothing");
  // Switched on again: all as before.
  assert.equal((await (await send("PUT", "/api/voice", { conversation: true })).json()).conversation, true);
  assert.deepEqual([voiceSpeaks(), rule()], [true, 1]);
  assert.equal((await speak()).status, 200);
  assert.deepEqual(await (await lease("new", true)).json(), { ok: true });
  await lease("new", false);
});

test("an agent's voice is one its source offers now, or the source's own choice; any other is refused, also while there is no source or it is not running", async () => {
  const agent = createAgent({ name: "Picky" });
  const refused = async (value) => {
    const answer = await agentVoice(agent.id, value);
    assert.deepEqual([answer.status, (await answer.json()).error], [400, NOT_OFFERED], String(value));
  };
  assert.equal((await (await agentVoice(agent.id, "speaker-warm")).json()).voice, "speaker-warm");
  await refused("elsewhere");
  assert.equal((await (await agentVoice(agent.id, "")).json()).voice, "");
  const wrong = await agentVoice(agent.id, 5);
  assert.deepEqual([wrong.status, (await wrong.json()).error], [400, "Choose a voice"]);
  await set({ ready: false });
  await refused("speaker-warm");
  await set({ ready: true });
  await stopUsing();
  await refused("speaker-warm");
  assert.equal((await agentVoice(agent.id, "")).status, 200);
  await choose(true);
});

test("a server half is told what it got wrong", async () => {
  const dir = path.join(home, "packages", "wrong");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "server.js");
  writeFileSync(file, `export default function (portal) {
    globalThis.refused = [];
    const offered = { label: "Wrong", state: () => undefined, transcribe: async () => "", speak: async () => new Response() };
    for (const given of [undefined, {}, { label: "No state" }, { ...offered, state: undefined }, { ...offered, transcribe: undefined }, { ...offered, speak: undefined }, { ...offered, use: true }]) {
      try { portal.voice.provide(given); } catch (e) { globalThis.refused.push(e.message); }
    }
    try { portal.voice.choose("yes"); } catch (e) { globalThis.refused.push(e.message); }
  }\n`);
  await host.syncServerHalves([{ name: "wrong", version: "1.0.0", file, rev: "1" }]);
  const shape = "provide takes { label, state, transcribe, speak, use? }: what it is called, what it offers now, how it recognises and speaks, and what it is told as voice mode is used";
  assert.deepEqual(globalThis.refused, [...Array(7).fill(shape), "choose takes true, to be voice mode's source, or false, to stop being it"]);
  assert.deepEqual([...host.voiceProviders().keys()], []);
});
