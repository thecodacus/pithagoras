import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inProcessHome } from "./server-harness.mjs";

/**
 * Voice mode listens and speaks through an extension that offers it a place to (`portal.voice.provide`) where that one is
 * chosen, by the person or by the extension at their asking (`portal.voice.choose`): here the stand-in
 * tests/fixtures/extensions/speaker, which runs a recognition and a speech service of its own on loopback.
 */
const home = inProcessHome("voice-providers-");
// No Docker here, whatever this machine has: the managed service is not what is tested.
process.env.DOCKER_SOCKET = path.join(home, "no-docker.sock");
// The leases run out by the clock they are made with: one the tests can move on, set before they are made.
const realNow = Date.now;
let later = 0;
Date.now = () => realNow() + later;

const { default: express } = await import("express");
const host = await import("../dist/extension-host.js");
const { voiceRouter, connectManagedVoice } = await import("../dist/api/voice.js");
const { createSession } = await import("../dist/db.js");

const SPEAKER = fileURLToPath(new URL("../../../tests/fixtures/extensions/speaker/server.js", import.meta.url));
let revs = 0;
/** The stand-in's server half under a name, started anew each time it is given: another module, as an update would be. */
const speaker = (name = "test-speaker") => ({ name, version: "0.1.0", file: SPEAKER, rev: `${statSync(SPEAKER).size.toString(36)}-${++revs}` });

// The person's own addresses: a recognition service and a speech engine that say what reached them.
const mine = [];
const own = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("latin1");
    const model = req.headers["content-type"] === "application/json" ? JSON.parse(body).model : body.match(/name="model"\r\n\r\n(.*)\r\n/)?.[1];
    mine.push(`${req.url} ${model ?? ""}`.trim());
    if (req.url === "/v1/audio/speech") {
      res.setHeader("content-type", "audio/wav");
      const wav = Buffer.alloc(48);
      wav.write("RIFF"); wav.writeUInt32LE(40, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(4, 40);
      return res.end(wav);
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ text: " Heard at home. " }));
  });
});
await new Promise((resolve) => own.listen(0, "127.0.0.1", resolve));
const MINE = `http://127.0.0.1:${own.address().port}`;

const app = express();
// As the portal does: one parser for everything but what reads its own.
const json = express.json();
app.use((req, res, next) => (req.path.startsWith("/api/x/") ? next() : json(req, res, next)));
app.use("/api/x", host.extensionRoutes);
app.use("/api", voiceRouter());
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
test.after(async () => {
  await host.stopServerHalves();
  for (const s of [server, own]) {
    s.closeAllConnections();
    s.close();
  }
  Date.now = realNow;
});
const at = (p) => `http://127.0.0.1:${server.address().port}${p}`;
const send = (method, p, body) => fetch(at(p), { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const voice = async () => (await fetch(at("/api/voice"))).json();
const saveVoice = async (patch) => {
  const answer = await send("PUT", "/api/voice", { ...(await voice()), ...patch });
  assert.equal(answer.status, 200, JSON.stringify(await answer.clone().json()));
  return answer.json();
};
const asked = async (name = "test-speaker") => (await fetch(at(`/api/x/${name}/state`))).json();
const set = (settings, name = "test-speaker") => send("PUT", `/api/x/${name}/settings`, settings);
const choose = (chosen, name = "test-speaker") => send("POST", `/api/x/${name}/choose`, { chosen });
// A WAV of silence, as the page records one.
const recording = () => {
  const wav = Buffer.alloc(76);
  wav.write("RIFF"); wav.writeUInt32LE(68, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(32, 40);
  return wav;
};
const transcribe = (query = "") => fetch(at(`/api/sessions/talk/voice/transcribe${query}`), { method: "POST", headers: { "content-type": "audio/wav" }, body: recording() });
const speak = () => send("POST", "/api/sessions/talk/voice/speech", { text: "Hello there." });
const lease = (client, active) => send("POST", "/api/sessions/talk/voice/connection", { client, active });
const NOT_RUNNING = "Voice mode listens and speaks through an extension that is not running: install or start it, or choose your own addresses in Settings → Add-ons → Voice";

const work = path.join(process.env.WORKSPACE_ROOT, "talk");
mkdirSync(work, { recursive: true });
createSession({ id: "talk", title: "Talk", workspace: work, executor: "host" });
const OWN = { enabled: true, whisperUrl: `${MINE}/inference`, breezeUrl: `${MINE}/v1/audio/speech`, runtime: "kokoro", sttModel: "my-asr", instruction: "A calm voice." };
assert.equal((await send("PUT", "/api/voice", OWN)).status, 200);
await host.syncServerHalves([speaker()]);

test("an extension offers voice mode a place to listen and speak, and it is used once chosen, with the person's own addresses as they were", async () => {
  let shown = await voice();
  assert.deepEqual([shown.provider, shown.providers], ["", [{ name: "test-speaker", label: "Speaker", ready: true, runtime: "kokoro" }]]);
  assert.deepEqual(await (await transcribe()).json(), { text: "Heard at home." }, "not chosen: the person's own addresses");
  assert.deepEqual(mine.splice(0), ["/inference my-asr"]);

  await saveVoice({ enabled: false });
  assert.equal((await choose(true)).status, 200);
  shown = await voice();
  // Chosen, and voice mode on; the addresses the person set up are kept as they were, for when they take voice mode back.
  assert.deepEqual([shown.provider, shown.enabled, shown.speech], ["test-speaker", true, true]);
  for (const [key, value] of Object.entries(OWN)) if (key !== "enabled") assert.equal(shown[key], value, key);

  assert.deepEqual(await (await transcribe()).json(), { text: "Heard by the speaker." });
  const spoken = await speak();
  assert.equal(spoken.status, 200);
  assert.equal(spoken.headers.get("content-type"), "audio/wav");
  assert.deepEqual(await asked(), { uses: [], heard: ["speaker-asr"], spoken: ["kokoro"] });
  // The spoken error line is made with it too.
  assert.equal((await send("POST", "/api/sessions/talk/voice/error-line", { text: "An error occurred." })).status, 200);
  assert.deepEqual((await asked()).spoken, ["kokoro", "kokoro"]);
  assert.equal((await fetch(at("/api/sessions/talk/voice/error-line?text=An%20error%20occurred."))).status, 200);
  assert.deepEqual(mine, [], "nothing reached the person's own addresses");
});

test("dictation is the extension's too, unless the person set an address of their own for it, which keeps its model", async () => {
  const heard = async () => (await asked()).heard.at(-1);
  assert.deepEqual(await (await transcribe("?purpose=dictation")).json(), { text: "Heard by the speaker." });
  assert.equal(await heard(), "speaker-asr");
  // A model alone is for the person's own addresses: the extension is asked with its own.
  await saveVoice({ dictationModel: "my-dictation" });
  await transcribe("?purpose=dictation");
  assert.equal(await heard(), "speaker-asr");
  assert.deepEqual(mine, []);
  // An address of their own for dictation is used for it, with the model named for it, or else the one they named for recognition.
  await saveVoice({ dictationUrl: `${MINE}/dictation` });
  assert.deepEqual(await (await transcribe("?purpose=dictation")).json(), { text: "Heard at home." });
  await saveVoice({ dictationModel: "" });
  await transcribe("?purpose=dictation");
  assert.deepEqual(mine.splice(0), ["/dictation my-dictation", "/dictation my-asr"]);
  // Voice mode itself still listens through the extension.
  await transcribe();
  assert.equal(await heard(), "speaker-asr");
  await saveVoice({ dictationUrl: "" });
});

test("an extension that recognises speech alone: replies are not spoken, and dictation works", async () => {
  await set({ speaks: "none" });
  const shown = await voice();
  assert.deepEqual([shown.speech, shown.providers[0].runtime, shown.runtime], [false, "none", "kokoro"]);
  const spoken = await speak();
  assert.equal(spoken.status, 409);
  assert.match((await spoken.json()).error, /Speech synthesis is not installed/);
  assert.equal((await transcribe("?purpose=dictation")).status, 200);
  await set({ speaks: "kokoro" });
});

test("voice mode says that its extension is not running, rather than listen or speak at other addresses", async () => {
  const refused = async (answer) => {
    assert.equal(answer.status, 503);
    assert.equal((await answer.json()).error, NOT_RUNNING);
  };
  const check = async () => {
    await refused(await transcribe());
    await refused(await transcribe("?purpose=dictation"));
    await refused(await speak());
    await refused(await send("POST", "/api/sessions/talk/voice/error-line", { text: "An error occurred." }));
    await refused(await fetch(at("/api/sessions/talk/voice/error-line?text=An%20error%20occurred.")));
    await refused(await lease("waiting", true));
    // Voice mode is still offered: starting it says why it cannot.
    assert.equal((await voice()).speech, true);
  };
  // Its services are down: it answers nothing for where.
  await set({ ready: false });
  assert.deepEqual((await voice()).providers, [{ name: "test-speaker", label: "Speaker", ready: false }]);
  await check();
  // Its server half is not running at all.
  await host.syncServerHalves([]);
  assert.deepEqual([(await voice()).provider, (await voice()).providers], ["test-speaker", []]);
  await check();
  // A dictation address of the person's own does not need it.
  await saveVoice({ dictationUrl: `${MINE}/dictation` });
  assert.deepEqual(await (await transcribe("?purpose=dictation")).json(), { text: "Heard at home." });
  assert.deepEqual(mine.splice(0), ["/dictation my-asr"], "and nothing else reached the person's addresses");
  await saveVoice({ dictationUrl: "" });
  // Back, it is used again.
  await host.syncServerHalves([speaker()]);
  assert.equal((await transcribe()).status, 200);
  assert.deepEqual(await asked(), { uses: [], heard: ["speaker-asr"], spoken: [] });
});

test("the extension is told voice mode is in use at the first lease, and that it is not after the last, also one that ran out", async () => {
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
  // A tab that went without saying so: its lease runs out, and the next look at the leases finds that.
  await lease("c", true);
  later += 76_000;
  await lease("never-there", false);
  assert.deepEqual(await uses(), [true, false, true, false]);
  // What it fails at as voice mode begins is the page's error, and it is asked again at the next lease.
  await set({ fails: true });
  const failed = await lease("d", true);
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).error, "The speaker could not load its model");
  await set({ fails: false });
  await lease("d", true);
  assert.deepEqual(await uses(), [true, false, true, false, true]);
  // Started anew while voice mode is in use, it is told again by the next heartbeat; the one before is gone and is not asked.
  await host.syncServerHalves([speaker()]);
  await lease("d", true);
  assert.deepEqual(await uses(), [true]);
  await lease("d", false);
  assert.deepEqual(await uses(), [true, false]);
});

test("every voice session takes a lease, also at the person's own addresses, where nothing is loaded for it", async () => {
  await choose(false);
  assert.equal((await voice()).provider, "");
  const before = (await asked()).uses;
  assert.deepEqual(await (await lease("own", true)).json(), { ok: true });
  assert.deepEqual(await (await lease("own", false)).json(), { ok: true });
  assert.deepEqual((await asked()).uses, before, "the extension that is not chosen is told nothing");
  assert.deepEqual(mine, []);
});

test("an extension gives voice mode back only where it is the source, and a person's choice of one that is not running stays", async () => {
  await host.syncServerHalves([speaker(), speaker("other-speaker")]);
  assert.deepEqual((await voice()).providers.map((p) => p.name).sort(), ["other-speaker", "test-speaker"]);
  await choose(true);
  await choose(false, "other-speaker");
  assert.equal((await voice()).provider, "test-speaker");
  await choose(true, "other-speaker");
  assert.equal((await voice()).provider, "other-speaker");
  await choose(false);
  assert.equal((await voice()).provider, "other-speaker");
  await choose(false, "other-speaker");
  const shown = await voice();
  // Back at the person's own addresses; voice mode is left as it was.
  assert.deepEqual([shown.provider, shown.enabled, shown.whisperUrl], ["", true, OWN.whisperUrl]);
  // The person chooses by name: any extension's, running or not, and nothing that is not a package's name.
  assert.equal((await saveVoice({ provider: "@someone/voice" })).provider, "@someone/voice");
  for (const provider of ["../voice", "two words", 42]) assert.equal((await send("PUT", "/api/voice", { ...(await voice()), provider })).status, 400, String(provider));
  await saveVoice({ provider: "" });
});

test("an extension that speaks with Chatterbox, chosen, is given a language it speaks, as the managed service's connect does", async () => {
  await set({ speaks: "chatterbox" });
  await saveVoice({ language: "auto" });
  await choose(true);
  assert.deepEqual([(await voice()).language, (await voice()).provider], ["en", "test-speaker"]);
  await saveVoice({ language: "de", provider: "" });
  await choose(true);
  assert.equal((await voice()).language, "de");
  await set({ speaks: "kokoro" });
});

test("connecting the managed service takes voice mode back to the addresses it writes", async () => {
  await choose(true);
  const connected = connectManagedVoice();
  assert.deepEqual([connected.provider, connected.whisperUrl], ["", "http://127.0.0.1:8188/inference"]);
  assert.deepEqual([(await voice()).provider, (await voice()).managed], ["", true]);
});

test("a server half is told what it got wrong", async () => {
  const dir = path.join(home, "packages", "wrong");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "server.js");
  writeFileSync(file, `export default function (portal) {
    globalThis.refused = [];
    for (const given of [undefined, {}, { label: "No where" }, { label: "Bad use", where: () => undefined, use: true }]) {
      try { portal.voice.provide(given); } catch (e) { globalThis.refused.push(e.constructor.name); }
    }
    try { portal.voice.choose("yes"); } catch (e) { globalThis.refused.push(e.constructor.name); }
  }\n`);
  await host.syncServerHalves([{ name: "wrong", version: "1.0.0", file, rev: "1" }]);
  assert.deepEqual(globalThis.refused, ["TypeError", "TypeError", "TypeError", "TypeError", "TypeError"]);
  assert.deepEqual((await voice()).providers, []);
});
