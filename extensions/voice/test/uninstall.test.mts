import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "../../../tests/helpers.mts";
import { serveVoice } from "./portal.mts";
import { CONTAINER } from "./service.mts";

/**
 * Uninstalling the voice service from its page, against Docker's fake daemon: the container goes, the volume with the
 * downloads stays unless the person says it goes too, and voice mode goes back to the person's own addresses where it
 * listened and spoke through the service, which are as they were all along. No GPU, no image and no container of this
 * machine is touched.
 */

inProcessHome("pithagoras-voice-uninstall-");
const { machine, at, api, docker: daemon } = await serveVoice();
const { setting } = await import("../src/server/store.ts");

const VOLUME = "pithagoras_voice-models";
const json = { "content-type": "application/json" };
const state = async () => (await fetch(`${at}/state`)).json();
const post = (route: string, body: unknown = {}) => fetch(`${at}${route}`, { method: "POST", headers: json, body: JSON.stringify(body) });
const voice = async () => (await fetch(`${api}/voice`)).json();
const saveVoice = async (patch: Record<string, unknown>) => {
  const answer = await fetch(`${api}/voice`, { method: "PUT", headers: json, body: JSON.stringify({ ...(await voice()), ...patch }) });
  assert.equal(answer.status, 200, JSON.stringify(await answer.clone().json()));
};
// A speech recognition server and a speech server the person runs themselves.
const OWN = { enabled: true, whisperUrl: "http://stt.example.test:9000/inference", breezeUrl: "http://tts.example.test:9001/v1/audio/speech", instruction: "A calm voice.", runtime: "breeze", sttModel: "my-model", dictationModel: "my-dictation", dictationUrl: "http://dictate.example.test:9002/inference", voice: "design", language: "de" };
const fields = (c: any) => ({ enabled: c.enabled, provider: c.provider, runtime: c.runtime, whisperUrl: c.whisperUrl, breezeUrl: c.breezeUrl, sttModel: c.sttModel, dictationModel: c.dictationModel, dictationUrl: c.dictationUrl });
const RECOGNITION_ONLY = { tts: "none", asr: "whisper", asrModel: "base" };
/** Installed from the page, recognition alone (no GPU needed), and up: voice mode then listens through it. */
const install = async () => {
  assert.equal((await post("/install", RECOGNITION_ONLY)).status, 200);
  await machine.settle();
  assert.equal((await state()).state, "running");
};
const reset = async () => {
  machine.reset();
  machine.hostGpus(null);
  await saveVoice({ ...OWN, provider: "" });
};
/** Whether the voice container, and the volume with the downloads, are gone. */
const removed = () => ({ container: machine.voice() === undefined, volume: !daemon.volumes.some((v) => v.Name === VOLUME) });

test("uninstall removes the container, keeps the downloads, and gives voice mode back to the person's own addresses as they were", async () => {
  await reset();
  await install();
  assert.equal((await voice()).provider, "pithagoras-voice");
  let stops = 0;
  daemon.runs.onStop = (c) => { if (c.Name === CONTAINER) stops++; };
  const answer = await post("/uninstall");
  assert.deepEqual([answer.status, await answer.json()], [200, { ok: true }]);
  // A running container is stopped, then removed; the volume with the downloads is not touched.
  assert.equal(stops, 1);
  assert.deepEqual(removed(), { container: true, volume: false });
  assert.deepEqual(fields(await voice()), { ...fields(OWN), provider: "" });
  // The voice, the language and the speech detection are as they were: voice mode's own.
  const back = await voice();
  assert.deepEqual([back.voice, back.language, back.instruction], ["design", "de", "A calm voice."]);
  // The page shows what a portal that never installed it shows, and Install works again.
  const now = await state();
  assert.deepEqual([now.available, now.state, now.busy, now.error], [true, "absent", false, ""]);
  assert.equal(setting("setupPending"), false);
  await install();
  assert.equal((await voice()).provider, "pithagoras-voice");
});

test("voice mode at the person's own addresses, or at another extension, is not touched by an uninstall", async () => {
  await reset();
  await install();
  await saveVoice({ provider: "" });
  assert.equal((await post("/uninstall")).status, 200);
  assert.deepEqual(fields(await voice()), { ...fields(OWN), provider: "" });
  await install();
  await saveVoice({ provider: "test-speaker" });
  assert.equal((await post("/uninstall")).status, 200);
  assert.equal((await voice()).provider, "test-speaker");
});

test("the downloaded engines and models go when asked, after the container, and not otherwise", async () => {
  await reset();
  machine.putVoice({ Labels: { "pithagoras.addon": "voice", "pithagoras.voice-network": "shared-v1" }, HostConfig: { NetworkMode: "container:portal-one" }, State: "exited" });
  daemon.volumes.push({ Name: VOLUME, Labels: null });
  assert.equal((await post("/uninstall", { removeData: false })).status, 200);
  assert.deepEqual(removed(), { container: true, volume: false });
  // The container is gone already: the volume the portal made is taken over and deleted.
  assert.equal((await post("/uninstall", { removeData: true })).status, 200);
  assert.deepEqual(removed(), { container: true, volume: true });
  // With the container still there, the volume is deleted after it.
  await install();
  assert.equal((await post("/uninstall", { removeData: true })).status, 200);
  assert.deepEqual(removed(), { container: true, volume: true });
  assert.equal((await state()).state, "absent");
});

test("uninstalling what is not installed is harmless, and the choice to delete the downloads still applies", async () => {
  await reset();
  const before = await voice();
  for (const body of [{}, { removeData: true }]) {
    const answer = await post("/uninstall", body);
    assert.deepEqual([answer.status, await answer.json()], [200, { ok: true }]);
  }
  assert.deepEqual(await voice(), before);
});

test("a container that is not the voice service's is left alone, and so is voice mode", async () => {
  await reset();
  await install();
  machine.putVoice({ Labels: {}, State: "running" });
  daemon.volumes.length = 0;
  daemon.volumes.push({ Name: VOLUME, Labels: null });
  const answer = await post("/uninstall", { removeData: true });
  assert.equal(answer.status, 400);
  assert.match((await answer.json()).error, /is not the voice service's, so it is left alone/);
  assert.deepEqual(removed(), { container: false, volume: false });
  assert.equal(machine.voice()!.State, "running");
  assert.equal((await voice()).provider, "pithagoras-voice");
  assert.equal((await state()).state, "failed", "and the page says why");
});

test("nothing is uninstalled while a setup is under way, and a choice that is not yes or no is refused", async () => {
  await reset();
  // The image of the setup is on its way.
  daemon.images.delete("ubuntu:22.04");
  let release!: () => void;
  daemon.hold.pull = new Promise<void>((resolve) => { release = resolve; });
  assert.equal((await post("/install", RECOGNITION_ONLY)).status, 200);
  const early = await post("/uninstall");
  assert.equal(early.status, 400);
  assert.match((await early.json()).error, /Wait for voice setup to finish/);
  release();
  await machine.settle();
  assert.equal((await state()).state, "running");
  // The setup went on as it was: the container is there, and voice mode listens through it.
  assert.equal((await voice()).provider, "pithagoras-voice");
  for (const removeData of ["yes", 1, "false"]) {
    const refused = await post("/uninstall", { removeData });
    assert.equal(refused.status, 400, JSON.stringify(removeData));
    assert.match((await refused.json()).error, /removeData must be true or false/);
  }
  assert.ok(machine.voice());
  assert.equal((await post("/uninstall")).status, 200);
});

test("where the volume cannot be deleted the container is still removed and voice mode still given back, and the error says why the downloads stay", async () => {
  await reset();
  await install();
  // Another extension's volume by that name: not Voice's to delete.
  daemon.volumes.length = 0;
  daemon.volumes.push({ Name: VOLUME, Labels: { "pithagoras.extension": "pithagoras-elsewhere" } });
  const answer = await post("/uninstall", { removeData: true });
  assert.equal(answer.status, 409);
  assert.match((await answer.json()).error, /^The voice container is removed, but its downloaded engines and models could not be deleted: pithagoras_voice-models is pithagoras-elsewhere's volume/);
  assert.deepEqual(removed(), { container: true, volume: false });
  assert.equal((await voice()).provider, "");
  assert.equal(setting("setupPending"), false);
  assert.equal((await state()).state, "absent");
});
