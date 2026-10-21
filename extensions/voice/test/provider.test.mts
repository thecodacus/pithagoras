import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "../../../tests/helpers.mts";
import { serveVoice } from "./portal.mts";

/**
 * The voice service as voice mode's source (`portal.voice.provide`): where it listens and speaks while it runs, its
 * speech model loaded while voice mode uses it, and the source chosen when the person asks for it on the service's page
 * or a setup they started has come up. Through the portal's own voice routes, as voice mode reaches it.
 */

inProcessHome("pithagoras-voice-provider-");
const { machine, at, api, db, host, halves } = await serveVoice();
const { provider, maintain } = await import("../src/server/provider.ts");
const { putSettings, setting } = await import("../src/server/store.ts");

const json = { "content-type": "application/json" };
const state = async () => (await fetch(`${at}/state`)).json();
const voice = async () => (await fetch(`${api}/voice`)).json();
const saveVoice = async (patch: Record<string, unknown>) => {
  const answer = await fetch(`${api}/voice`, { method: "PUT", headers: json, body: JSON.stringify({ ...(await voice()), ...patch }) });
  assert.equal(answer.status, 200, JSON.stringify(await answer.clone().json()));
};
const lease = (client: string, active: boolean) => fetch(`${api}/sessions/talk/voice/connection`, { method: "POST", headers: json, body: JSON.stringify({ client, active }) });
/** A voice container an earlier portal made for these engines, running on the portal's loopback. */
const running = (recipe: string) => machine.putVoice({ Labels: { "pithagoras.addon": "voice", "pithagoras.voice-network": "shared-v1", "pithagoras.voice-recipe": recipe }, HostConfig: { NetworkMode: "container:portal-one" }, State: "running" });
const models = () => machine.voiceProcesses.models.map(({ url, body }) => `${url.replace("http://127.0.0.1:", "")} ${(body as { id: string }).id}`);
// The person's own addresses: a portal with nothing set up, and voice mode on.
const OWN = { whisperUrl: "http://127.0.0.1:8178/inference", breezeUrl: "http://127.0.0.1:7860/v1/audio/speech", runtime: "breeze" };
db.createSession({ id: "talk", title: "Talk", workspace: process.env.WORKSPACE_ROOT!, executor: "host" });
const reset = async () => {
  machine.reset();
  machine.hostGpus(null);
  await saveVoice({ enabled: true, instruction: "A calm voice.", language: "auto", provider: "", ...OWN });
};

test("where it listens and speaks follows the engines its container was built for, while it runs, and nothing otherwise", async () => {
  await reset();
  const offered = async () => (await voice()).providers;
  for (const [recipe, where, runtime] of [
    ["breeze+whisper:base", { listen: { url: "http://127.0.0.1:8188/inference" }, speak: { url: "http://127.0.0.1:7862/v1/audio/speech", runtime: "audio-cpp" } }, "audio-cpp"],
    ["chatterbox+qwen3-asr:1.7b", { listen: { url: "http://127.0.0.1:7862/v1/audio/transcriptions", model: "qwen3-asr" }, speak: { url: "http://127.0.0.1:7862/v1/audio/speech", runtime: "chatterbox" } }, "chatterbox"],
    ["kokoro@cpu+qwen3-asr:0.6b", { listen: { url: "http://127.0.0.1:7863/v1/audio/transcriptions", model: "qwen3-asr" }, speak: { url: "http://127.0.0.1:7863/v1/audio/speech", runtime: "kokoro" } }, "kokoro"],
    ["none+whisper:small", { listen: { url: "http://127.0.0.1:8188/inference" } }, "none"],
  ] as const) {
    running(recipe);
    assert.equal((await state()).state, "running", recipe);
    assert.deepEqual(provider().where(), where, recipe);
    assert.deepEqual(await offered(), [{ name: "pithagoras-voice", label: "Voice service", ready: true, runtime }], recipe);
  }
  // Coming up, stopped, or gone: nothing to listen and speak at, which voice mode then says.
  machine.voiceProcesses.unhealthy = [":8188"];
  assert.equal((await state()).state, "starting");
  assert.equal(provider().where(), undefined);
  machine.voiceProcesses.unhealthy = [];
  machine.voice()!.State = "exited";
  assert.equal((await state()).state, "stopped");
  assert.deepEqual(await offered(), [{ name: "pithagoras-voice", label: "Voice service", ready: false }]);
  machine.dropVoice();
  assert.equal((await state()).state, "absent");
  assert.equal(provider().where(), undefined);
});

test("Use for voice mode makes it the source once it runs, and voice mode on; the person's own addresses stay as they are", async () => {
  await reset();
  await saveVoice({ enabled: false });
  running("breeze+whisper:base");
  machine.voice()!.State = "exited";
  const early = await fetch(`${at}/connect`, { method: "POST" });
  assert.deepEqual([early.status, (await early.json()).error], [400, "Wait for voice setup to finish before connecting"]);
  assert.equal((await voice()).provider, "");
  machine.voice()!.State = "running";
  const answer = await fetch(`${at}/connect`, { method: "POST" });
  assert.deepEqual([answer.status, await answer.json()], [200, { ok: true }]);
  const now = await voice();
  assert.deepEqual([now.provider, now.enabled, now.whisperUrl, now.breezeUrl, now.runtime], ["pithagoras-voice", true, OWN.whisperUrl, OWN.breezeUrl, OWN.runtime]);
  // Chatterbox is told a language and has none to detect: one it speaks is given where auto-detect was set.
  await saveVoice({ provider: "", language: "auto" });
  running("chatterbox+whisper:base");
  await state();
  assert.equal((await fetch(`${at}/connect`, { method: "POST" })).status, 200);
  assert.deepEqual([(await voice()).provider, (await voice()).language], ["pithagoras-voice", "en"]);
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
  // Chosen once: the person's choice of their own addresses after it stands.
  await saveVoice({ provider: "" });
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
  await saveVoice({ provider: "pithagoras-voice" });
  assert.equal((await lease("a", true)).status, 200);
  assert.equal((await lease("a", false)).status, 200);
  assert.deepEqual(models(), ["7862/v1/models/load breeze", "7862/v1/models/unload breeze"]);
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
  await saveVoice({ provider: "pithagoras-voice" });
  await lease("f", true);
  // Docker's update, say: both halves stop and start again, and the next renewal tells the new one.
  await host.stopServerHalves();
  await host.syncServerHalves([halves.docker, halves.voice]);
  await state();
  machine.voiceProcesses.models.length = 0;
  assert.equal((await lease("f", true)).status, 200);
  assert.deepEqual(models(), ["7862/v1/models/load breeze"]);
  await lease("f", false);
});

test("voice mode at the service while it does not run says so, and does not listen elsewhere", async () => {
  await reset();
  running("breeze+whisper:base");
  await state();
  await saveVoice({ provider: "pithagoras-voice" });
  machine.voice()!.State = "exited";
  await state();
  const refused = await lease("e", true);
  assert.equal(refused.status, 503);
  assert.match((await refused.json()).error, /^Voice mode listens and speaks through an extension that is not running/);
});
