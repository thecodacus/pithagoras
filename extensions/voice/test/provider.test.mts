import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "../../../tests/helpers.mts";
import { serveVoice } from "./portal.mts";
import { KOKORO_VOICES } from "../src/kokoro-voices.ts";

/**
 * The voice service as voice mode's source (`portal.voice.provide`): what it offers while it runs, the voices with it,
 * what it hears and says through the engines of its container, its speech model loaded while voice mode uses it, and
 * the source chosen when a setup the person started has come up. Through the portal's own voice routes, as voice mode
 * reaches it.
 */

inProcessHome("pithagoras-voice-provider-");
const { machine, at, api, db, host, halves } = await serveVoice();
const { state: offers, maintain } = await import("../src/server/provider.ts");
const { putSettings, setting } = await import("../src/server/store.ts");
const { addVoice } = await import("../src/server/voices.ts");
const { samplesWav } = await import("../src/web/audio.ts");

const json = { "content-type": "application/json" };
const state = async () => (await fetch(`${at}/state`)).json();
const voice = async () => (await fetch(`${api}/voice`)).json();
/** Voice mode's source, as its settings keep it. */
const useSource = (provider: string) => db.putSetting("voice", JSON.stringify({ provider }));
const lease = (client: string, active: boolean) => fetch(`${api}/sessions/talk/voice/connection`, { method: "POST", headers: json, body: JSON.stringify({ client, active }) });
/** A voice container an earlier portal made for these engines, running on the portal's loopback. */
const running = (recipe: string) => machine.putVoice({ Labels: { "pithagoras.addon": "voice", "pithagoras.voice-network": "shared-v1", "pithagoras.voice-recipe": recipe }, HostConfig: { NetworkMode: "container:portal-one" }, State: "running" });
const models = () => machine.voiceProcesses.models.map(({ url, body }) => `${url.replace("http://127.0.0.1:", "")} ${(body as { id: string }).id}`);
db.createSession({ id: "talk", title: "Talk", workspace: process.env.WORKSPACE_ROOT!, executor: "host" });
const reset = async () => {
  machine.reset();
  machine.hostGpus(null);
  useSource("");
};

test("what it offers follows the engines its container was built for, while it runs, with the voices of the library each speaks with, and nothing otherwise", async () => {
  await reset();
  useSource("pithagoras-voice");
  const offered = async () => {
    const { label, ready, speech, voices } = await voice();
    return { label, ready, speech, voices };
  };
  const audio = Buffer.from(await samplesWav(new Float32Array(16000)).arrayBuffer()).toString("base64");
  const calm = addVoice({ name: "Calm", kind: "design", instruction: "A calm voice." });
  const aria = addVoice({ name: "Aria", kind: "clone", instruction: "Warm.", transcript: "Hello there.", audio });
  // The names of the voices the person added are theirs, and are shown as they are: not one of them is built in.
  const library = [{ id: aria.id, name: "Aria" }, { id: calm.id, name: "Calm" }];
  for (const [recipe, speaks, voices] of [
    ["breeze+whisper:base", true, [{ id: "design", name: "Designed voice", builtIn: true }, ...library]],
    ["chatterbox+qwen3-asr:1.7b", true, [{ id: aria.id, name: "Aria" }]],
    ["kokoro@cpu+qwen3-asr:0.6b", true, KOKORO_VOICES.map((v) => ({ id: v.id, name: `${v.name} (${v.locale})`, builtIn: true }))],
    ["none+whisper:small", false, []],
  ] as const) {
    running(recipe);
    assert.equal((await state()).state, "running", recipe);
    assert.deepEqual(offers(), { speaks, voices }, recipe);
    assert.deepEqual(await offered(), { label: "Voice service", ready: true, speech: speaks, voices }, recipe);
  }
  // A health check that is slow once, as an engine busy speaking may be, leaves it where it was found answering.
  machine.voiceProcesses.unhealthy = [":8188"];
  assert.equal((await state()).state, "starting");
  assert.deepEqual(offers(), { speaks: false, voices: [] });
  machine.voiceProcesses.unhealthy = [];
  // Stopped, coming up again, or gone: nothing to offer, which voice mode then says.
  machine.voice()!.State = "exited";
  assert.equal((await state()).state, "stopped");
  assert.equal(offers(), undefined);
  assert.deepEqual(await offered(), { label: "Voice service", ready: false, speech: true, voices: [] });
  machine.voice()!.State = "running";
  machine.voiceProcesses.unhealthy = [":8188"];
  assert.equal((await state()).state, "starting");
  assert.equal(offers(), undefined);
  machine.voiceProcesses.unhealthy = [];
  machine.dropVoice();
  assert.equal((await state()).state, "absent");
  assert.equal(offers(), undefined);
});

test("voice mode hears through the engines of its container, and speaks through them where it has a speech engine", async () => {
  await reset();
  running("breeze+whisper:base");
  await state();
  useSource("pithagoras-voice");
  const wav = new Uint8Array(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40)]));
  const transcribe = () => fetch(`${api}/sessions/talk/voice/transcribe`, { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
  const speak = () => fetch(`${api}/sessions/talk/voice/speech`, { method: "POST", headers: json, body: JSON.stringify({ text: "Hello." }) });
  let answer = await transcribe();
  assert.deepEqual([answer.status, await answer.json()], [200, { text: "Heard you." }]);
  answer = await speak();
  assert.deepEqual([answer.status, answer.headers.get("content-type"), Buffer.from(await answer.arrayBuffer())], [200, "audio/pcm", Buffer.from([0, 0, 255, 127])]);
  assert.equal(machine.voiceProcesses.spoken.length, 1);
  // Recognition alone: dictation is heard, and replies are not spoken.
  running("none+whisper:base");
  await state();
  answer = await transcribe();
  assert.equal(answer.status, 200);
  answer = await speak();
  assert.deepEqual([answer.status, (await answer.json()).error], [409, "Voice mode's source recognises speech alone: replies are not spoken"]);
  assert.equal(machine.voiceProcesses.spoken.length, 1);
});

test("a setup started on the page is the source once it has come up, once: asked after by the page or by the half on its own", async () => {
  await reset();
  // Recognition alone: no GPU needed. The container comes up as it is made.
  const install = await fetch(`${at}/install`, { method: "POST", headers: json, body: JSON.stringify({ tts: "none", asr: "whisper", asrModel: "base" }) });
  assert.equal(install.status, 200);
  assert.equal(setting("setupPending"), true);
  await machine.settle();
  assert.equal((await voice()).provider, "", "not before it was seen to have come up");
  assert.equal((await state()).state, "running");
  assert.deepEqual([(await voice()).provider, (await voice()).speech, setting("setupPending")], ["pithagoras-voice", false, false]);
  // Chosen once: the person's choice of no source after it stands.
  useSource("");
  await state();
  assert.equal((await voice()).provider, "");
  // The half itself sees to it, every 30 seconds, where nobody looks at the page; Stop is no setup to wait for.
  putSettings({ setupPending: true });
  await maintain();
  assert.deepEqual([(await voice()).provider, setting("setupPending")], ["pithagoras-voice", false]);
  assert.equal((await fetch(`${at}/stop`, { method: "POST" })).status, 200);
  assert.equal(setting("setupPending"), false);
});

test("its speech model is loaded as voice mode begins to use it, and let go of after, unless lazy loading is off", async () => {
  await reset();
  running("breeze+whisper:base");
  await state();
  useSource("pithagoras-voice");
  assert.equal((await lease("a", true)).status, 200);
  // Loaded again by the half while voice mode uses it: the engines let go of a model after 90 seconds without use.
  await maintain();
  assert.equal((await lease("a", false)).status, 200);
  await maintain();
  assert.deepEqual(models(), ["7862/v1/models/load breeze", "7862/v1/models/load breeze", "7862/v1/models/unload breeze"]);
  // Lazy loading off: kept loaded after voice mode, and loaded again by the half while it is off.
  const off = await fetch(`${at}/lazy-load`, { method: "PUT", headers: json, body: JSON.stringify({ on: false }) });
  assert.deepEqual([off.status, await off.json()], [200, { lazyLoad: false }]);
  assert.equal((await state()).lazyLoad, false);
  machine.voiceProcesses.models.length = 0;
  await lease("b", true);
  await lease("b", false);
  await maintain();
  assert.deepEqual(models(), ["7862/v1/models/load breeze", "7862/v1/models/load breeze"]);
  // On again, with voice mode not in use: what was kept is let go of.
  await fetch(`${at}/lazy-load`, { method: "PUT", headers: json, body: JSON.stringify({ on: true }) });
  machine.voiceProcesses.models.length = 0;
  await maintain();
  assert.deepEqual(models(), ["7862/v1/models/unload breeze"]);
  await maintain();
  assert.deepEqual(models(), ["7862/v1/models/unload breeze"], "once");
  assert.equal((await fetch(`${at}/lazy-load`, { method: "PUT", headers: json, body: JSON.stringify({ on: "yes" }) })).status, 400);
  // Kokoro on the CPU is in the CPU process; recognition alone has no speech model to load.
  machine.voiceProcesses.models.length = 0;
  running("kokoro@cpu+whisper:base");
  await state();
  await lease("c", true);
  await lease("c", false);
  running("none+whisper:base");
  await state();
  await lease("d", true);
  await lease("d", false);
  assert.deepEqual(models(), ["7863/v1/models/load kokoro", "7863/v1/models/unload kokoro"]);
});

test("a speech model that fails to load is not loaded by the half after, as voice mode does not hold it", async () => {
  await reset();
  running("breeze+whisper:base");
  await state();
  useSource("pithagoras-voice");
  machine.voiceProcesses.failLoads = 1;
  const refused = await lease("h", true);
  assert.deepEqual([refused.status, (await refused.json()).error], [503, "Voice model load failed (500): boom"]);
  machine.voiceProcesses.models.length = 0;
  await maintain();
  await maintain();
  assert.deepEqual(models(), []);
  // The next session loads it as voice mode begins.
  assert.equal((await lease("h", true)).status, 200);
  assert.deepEqual(models(), ["7862/v1/models/load breeze"]);
  await lease("h", false);
});

test("a half started anew while voice mode is in use is told so again, and loads its model", async () => {
  await reset();
  running("breeze+whisper:base");
  await state();
  useSource("pithagoras-voice");
  await lease("f", true);
  // Docker's update, say: both halves stop and start again, and the next renewal tells the new one.
  await host.stopServerHalves();
  await host.syncServerHalves([halves.docker, halves.voice]);
  await state();
  machine.voiceProcesses.models.length = 0;
  assert.equal((await lease("f", true)).status, 200);
  // Loaded, and loaded again where the new half's first look came after voice mode told it.
  assert.deepEqual([...new Set(models())], ["7862/v1/models/load breeze"]);
  await lease("f", false);
});

test("a half started after voice mode stopped using the one before, which nobody could tell, does not keep its model loaded", async () => {
  await reset();
  running("breeze+whisper:base");
  await state();
  useSource("pithagoras-voice");
  await lease("g", true);
  await host.stopServerHalves();
  await lease("g", false);
  await host.syncServerHalves([halves.docker, halves.voice]);
  await state();
  machine.voiceProcesses.models.length = 0;
  await maintain();
  assert.deepEqual(models(), []);
});

test("voice mode at the service while it does not run says so, and does not listen elsewhere", async () => {
  await reset();
  running("breeze+whisper:base");
  await state();
  useSource("pithagoras-voice");
  machine.voice()!.State = "exited";
  await state();
  const refused = await lease("e", true);
  assert.equal(refused.status, 503);
  assert.match((await refused.json()).error, /^Voice mode listens and speaks through pithagoras-voice, which is not running/);
});
