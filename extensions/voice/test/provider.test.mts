import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "../../../tests/helpers.mts";
import { serveVoice } from "./portal.mts";
import { KOKORO_VOICES } from "../src/kokoro-voices.ts";

/**
 * The voice service as voice mode's source (`portal.voice.provide`): what it offers while it runs, its speech model
 * loaded while voice mode uses it, and the source chosen when the person asks for it on the service's page or a setup
 * they started has come up. Through the portal's own voice routes, as voice mode reaches it.
 */

inProcessHome("pithagoras-voice-provider-");
const { machine, at, api, db, host, halves } = await serveVoice();
const { state: offers, maintain } = await import("../src/server/provider.ts");
const { putSettings, setting } = await import("../src/server/store.ts");

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

test("what it offers follows the engines its container was built for, while it runs, and nothing otherwise", async () => {
  await reset();
  useSource("pithagoras-voice");
  const offered = async () => {
    const { label, ready, speech } = await voice();
    return { label, ready, speech };
  };
  const designed = [{ id: "design", name: "Designed voice", builtIn: true }];
  for (const [recipe, speaks, voices] of [
    ["breeze+whisper:base", true, designed],
    ["chatterbox+qwen3-asr:1.7b", true, []],
    ["kokoro@cpu+qwen3-asr:0.6b", true, KOKORO_VOICES.map((v) => ({ id: v.id, name: `${v.name} (${v.locale})`, builtIn: true }))],
    ["none+whisper:small", false, []],
  ] as const) {
    running(recipe);
    assert.equal((await state()).state, "running", recipe);
    assert.deepEqual(offers(), { speaks, voices }, recipe);
    assert.deepEqual(await offered(), { label: "Voice service", ready: true, speech: speaks }, recipe);
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
  assert.deepEqual(await offered(), { label: "Voice service", ready: false, speech: true });
  machine.voice()!.State = "running";
  machine.voiceProcesses.unhealthy = [":8188"];
  assert.equal((await state()).state, "starting");
  assert.equal(offers(), undefined);
  machine.voiceProcesses.unhealthy = [];
  machine.dropVoice();
  assert.equal((await state()).state, "absent");
  assert.equal(offers(), undefined);
});

test("Use for voice mode makes it the source once it runs, and voice mode on", async () => {
  await reset();
  running("breeze+whisper:base");
  machine.voice()!.State = "exited";
  const early = await fetch(`${at}/connect`, { method: "POST" });
  assert.deepEqual([early.status, (await early.json()).error], [400, "Wait for voice setup to finish before connecting"]);
  assert.equal((await voice()).provider, "");
  machine.voice()!.State = "running";
  const answer = await fetch(`${at}/connect`, { method: "POST" });
  assert.deepEqual([answer.status, await answer.json()], [200, { ok: true }]);
  const now = await voice();
  assert.deepEqual([now.provider, now.enabled], ["pithagoras-voice", true]);
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
