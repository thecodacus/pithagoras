import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { inProcessHome } from "../../../tests/helpers.mts";
import { serveVoice } from "./portal.mts";
import { GPU } from "./service.mts";

/**
 * The routes of the voice service's page in Settings, at /api/x/pithagoras-voice, as the portal serves them: the GPU
 * check and the card, an install's choice of engines, what is said where Docker cannot be reached, Use for voice mode
 * and Stop using, how it speaks (Your voice), and the voice library.
 */

inProcessHome("pithagoras-voice-routes-");
const { machine, at, api, db, docker: daemon } = await serveVoice();
const { setting } = await import("../src/server/store.ts");
const { samplesWav } = await import("../src/web/audio.ts");

const json = { "content-type": "application/json" };
const get = async (route: string) => (await fetch(`${at}${route}`)).json();
const post = (route: string, body: unknown = {}) => fetch(`${at}${route}`, { method: "POST", headers: json, body: JSON.stringify(body) });
const put = (route: string, body: unknown) => fetch(`${at}${route}`, { method: "PUT", headers: json, body: JSON.stringify(body) });
/** A voice container an earlier portal made for these engines, running on the portal's loopback, or stopped. */
const made = (recipe: string, state = "running") => machine.putVoice({ Labels: { "pithagoras.addon": "voice", "pithagoras.voice-network": "shared-v1", "pithagoras.voice-recipe": recipe }, HostConfig: { NetworkMode: "container:portal-one" }, State: state });
/** Voice mode's source, as the portal's own route has it. */
const source = async () => (await (await fetch(`${api}/voice`)).json()).provider;
/** `seconds` of a recording, as the page sends it: base64 of a mono 16 kHz 16-bit WAV. */
const recording = async (seconds = 1) => Buffer.from(await samplesWav(new Float32Array(16000 * seconds)).arrayBuffer()).toString("base64");

test("the GPU check reports the GPUs and what it would suggest, and without a tool or a Docker that answers it is no GPU, said plainly", async () => {
  machine.reset();
  machine.hostGpus(GPU(0, 12288, 11000, "Test GPU A") + GPU(1, 24576, 24000, "Test GPU B"));
  // What the host has is told, not read from the machine the tests run on.
  machine.service.hostReader.read = () => ({ totalMiB: 16384, freeMiB: 8192, threads: 8 });
  const found = await get("/hardware");
  assert.deepEqual(found.gpus.map((g: any) => [g.index, g.name, g.totalMiB, g.freeMiB]), [[0, "Test GPU A", 12288, 11000], [1, "Test GPU B", 24576, 24000]]);
  assert.deepEqual([found.source, found.selected, found.reserveMiB], ["host", 1, 0]);
  assert.deepEqual(found.suggestion, { tts: "breeze", asr: "qwen3-asr", asrModel: "1.7b" });
  machine.hostGpus(null);
  const socket = process.env.DOCKER_SOCKET;
  process.env.DOCKER_SOCKET = path.join(os.tmpdir(), "no-docker-here.sock");
  try {
    const none = await fetch(`${at}/hardware`);
    assert.equal(none.status, 200);
    const empty = await none.json();
    // No tool and no Docker is no GPU: what is suggested is Kokoro and recognition on the CPU, sized to the host.
    assert.deepEqual([empty.gpus, empty.source, empty.selected, empty.checked, empty.cpuOnly], [[], "none", null, true, true]);
    assert.equal(empty.error, "host: nvidia-smi was not found; docker: no GPU available");
    assert.deepEqual(empty.host, { totalMiB: 16384, freeMiB: 8192, threads: 8 });
    assert.deepEqual(empty.suggestion, { tts: "kokoro", ttsDevice: "cpu", asr: "qwen3-asr", asrModel: "0.6b" });
  } finally {
    process.env.DOCKER_SOCKET = socket;
  }
});

test("without Docker the page says only that Docker is needed, and an install or an uninstall says the same and changes nothing", async () => {
  machine.reset();
  const before = await (await fetch(`${api}/voice`)).json();
  const socket = process.env.DOCKER_SOCKET;
  process.env.DOCKER_SOCKET = path.join(os.tmpdir(), "no-docker-here.sock");
  try {
    const state = await get("/state");
    assert.deepEqual([state.available, state.state, state.busy, state.lazyLoad], [false, "unavailable", false, true]);
    assert.equal(state.error, "Automatic voice setup requires access to Docker.");
    assert.doesNotMatch(state.error, /GPU|NVIDIA/);
    for (const removeData of [false, true]) {
      const answer = await post("/uninstall", { removeData });
      assert.deepEqual([answer.status, (await answer.json()).error], [400, "Docker is unavailable"]);
    }
    const install = await post("/install");
    assert.deepEqual([install.status, (await install.json()).error], [400, "Docker is unavailable"]);
  } finally {
    process.env.DOCKER_SOCKET = socket;
  }
  assert.equal(setting("setupPending"), undefined);
  assert.deepEqual(await (await fetch(`${api}/voice`)).json(), before);
});

test("install takes the engines to build, and refuses a choice the installer does not make", async () => {
  machine.reset();
  for (const body of [{ tts: "piper", asr: "whisper", asrModel: "base" }, { tts: "breeze", asr: "whisper", asrModel: "1.7b" }, { tts: "breeze" }, { asr: "qwen3-asr", asrModel: "0.6b" }]) {
    const answer = await post("/install", body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.match((await answer.json()).error, /Choose a supported speech/);
  }
  // Nothing was started, so there is no setup to wait for either.
  assert.equal(setting("setupPending"), undefined);
  assert.deepEqual(daemon.created, []);
});

test("PUT /gpu is how a card is chosen: it keeps the UUID, moves a running service, and refuses a card that is not there", async () => {
  const A = "GPU-aaaa-0000", B = "GPU-bbbb-1111";
  const SMI = GPU(0, 12288, 4427, "NVIDIA GeForce RTX 3060", A) + GPU(1, 12288, 12159, "NVIDIA GeForce RTX 3060", B);
  machine.reset();
  machine.hostGpus(null);
  machine.dockerGpus(SMI);
  const put = (gpu: unknown) => fetch(`${at}/gpu`, { method: "PUT", headers: json, body: JSON.stringify({ gpu }) });
  const chosen = async () => (await get("/hardware")).chosen;
  const deviceIds = () => (machine.voice()!.made as any).HostConfig.DeviceRequests[0].DeviceIDs;
  const made = (index: number, running: boolean, recipe = "breeze+whisper:base") => machine.putVoice({
    Labels: { "pithagoras.addon": "voice", "pithagoras.voice-network": "shared-v1", "pithagoras.voice-recipe": recipe },
    HostConfig: { NetworkMode: "container:portal-one", DeviceRequests: [{ Driver: "nvidia", DeviceIDs: [String(index)], Capabilities: [["gpu"]] }] },
    State: running ? "running" : "exited",
  });
  assert.equal((await put(7)).status, 400);
  const unknown = await put("GPU-gone");
  assert.deepEqual([unknown.status, (await unknown.json()).error], [400, "That GPU is not on this host"]);
  assert.equal(setting("gpu"), undefined);
  // A card that cannot hold the engines installed is refused before anything is saved or stopped.
  machine.dockerGpus(GPU(0, 6144, 6000, "Small GPU", A) + GPU(1, 12288, 12159, "NVIDIA GeForce RTX 3060", B));
  made(1, true, "breeze+qwen3-asr:1.7b");
  const large = await put(A);
  assert.equal(large.status, 400);
  assert.match((await large.json()).error, /needs about 7\.0 GiB of GPU memory, but Small GPU/);
  assert.equal(setting("gpu"), undefined);
  assert.deepEqual([machine.made(), machine.voice()!.State], [[], "running"]);
  machine.dockerGpus(SMI);
  // Stopped: kept, and used from the next start.
  made(0, false);
  let answer = await put(B);
  assert.deepEqual([answer.status, await answer.json()], [200, { selected: B, restarting: false }]);
  assert.equal(setting("gpu"), B);
  assert.deepEqual(machine.made(), []);
  assert.equal(await chosen(), B);
  assert.equal((await post("/start")).status, 200);
  await machine.settle();
  assert.deepEqual(deviceIds(), [B]);
  // Running: moved at once, with the downloads kept.
  daemon.created.length = 0;
  answer = await put(A);
  assert.deepEqual([answer.status, await answer.json()], [200, { selected: A, restarting: true }]);
  await machine.settle();
  assert.deepEqual(deviceIds(), [A]);
  assert.equal(machine.made().length, 1);
  assert.ok(daemon.volumes.some((volume) => volume.Name === "pithagoras_voice-models"));
  // Automatic clears the choice.
  answer = await put("");
  assert.deepEqual([answer.status, await answer.json()], [200, { selected: "", restarting: true }]);
  await machine.settle();
  assert.equal(setting("gpu"), "");
  assert.equal(await chosen(), "");
});

test("Use for voice mode makes it the source once it runs, Stop using gives it up, and the page is told which it is", async () => {
  machine.reset();
  db.putSetting("voice", JSON.stringify({ provider: "" }));
  made("breeze+whisper:base", "exited");
  const early = await put("/chosen", { chosen: true });
  assert.deepEqual([early.status, (await early.json()).error], [400, "Wait for voice setup to finish before using it for voice mode"]);
  assert.equal(await source(), "");
  for (const chosen of ["yes", 1, null]) {
    const refused = await put("/chosen", { chosen });
    assert.deepEqual([refused.status, (await refused.json()).error], [400, "chosen must be a boolean"], JSON.stringify(chosen));
  }
  machine.voice()!.State = "running";
  assert.equal((await get("/state")).chosen, false);
  let answer = await put("/chosen", { chosen: true });
  assert.deepEqual([answer.status, await answer.json()], [200, { chosen: true }]);
  assert.equal(await source(), "pithagoras-voice");
  assert.equal((await (await fetch(`${api}/voice`)).json()).enabled, true);
  assert.equal((await get("/state")).chosen, true);
  // Stop using needs no running service, and leaves voice mode with no source.
  machine.voice()!.State = "exited";
  answer = await put("/chosen", { chosen: false });
  assert.deepEqual([answer.status, await answer.json()], [200, { chosen: false }]);
  assert.equal(await source(), "");
  assert.equal((await get("/state")).chosen, false);
  // Another extension chosen since is not given up by this one.
  db.putSetting("voice", JSON.stringify({ provider: "test-speaker" }));
  answer = await put("/chosen", { chosen: false });
  assert.deepEqual([answer.status, await answer.json()], [200, { chosen: false }]);
  assert.equal(await source(), "test-speaker");
});

test("how it speaks is read with its defaults, saved as checked, and held to Chatterbox's rules where its container is for Chatterbox", async () => {
  machine.reset();
  machine.dropVoice();
  assert.deepEqual(await get("/speech"), { voice: "design", instruction: "A warm, clear English voice with a calm, conversational delivery.", cfgScale: 4, exaggeration: 0.5, kokoroVoice: "af_heart", speed: 1, language: "auto" });
  const saved = { voice: "design", instruction: "  A low voice.  ", cfgScale: 1, exaggeration: 0.8, kokoroVoice: "bf_emma", speed: 0.85, language: "auto" };
  let answer = await put("/speech", saved);
  assert.deepEqual([answer.status, await answer.json()], [200, { ...saved, instruction: "A low voice." }]);
  assert.equal(setting("instruction"), "A low voice.");
  for (const [patch, error] of [
    [{ instruction: "" }, "Provide a voice description of 1–1000 characters"],
    [{ instruction: "x".repeat(1001) }, "Provide a voice description of 1–1000 characters"],
    [{ voice: "voice-missing" }, "Voice not found"],
    [{ cfgScale: 2 }, "Choose fast or expressive speech generation"],
    [{ exaggeration: -1 }, "Expressiveness must be between 0 and 2"],
    [{ kokoroVoice: "jf_alpha" }, "Choose one of Kokoro's voices"],
    [{ speed: 2 }, "Choose a supported speaking speed"],
    [{ language: "xx" }, "Choose a supported input language"],
  ] as const) {
    const refused = await put("/speech", { ...saved, ...patch });
    assert.deepEqual([refused.status, (await refused.json()).error], [400, error], JSON.stringify(patch));
  }
  assert.equal(setting("cfgScale"), 1, "nothing of a refused save is kept");
  // A container for Chatterbox, even a stopped one, holds the settings to what it takes: a language, and a clone.
  made("chatterbox+qwen3-asr:1.7b", "exited");
  answer = await put("/speech", saved);
  assert.deepEqual([answer.status, (await answer.json()).error], [400, "Chatterbox needs an input language: auto-detect selects no voice"]);
  answer = await put("/speech", { ...saved, language: "de" });
  assert.deepEqual([answer.status, (await answer.json()).error], [400, "Chatterbox speaks with a reference clone: choose a voice with a recording"]);
  const clone = await (await post("/voices", { name: "Clone", kind: "clone", instruction: "Warm.", transcript: "Words.", audio: await recording() })).json();
  answer = await put("/speech", { ...saved, language: "de", voice: clone.id });
  assert.equal(answer.status, 200);
  // Made for Chatterbox anew, a language it does not speak becomes English.
  machine.dropVoice();
  machine.hostGpus(GPU(0, 24576, 24000));
  assert.equal((await put("/speech", { language: "ru" })).status, 200);
  assert.equal((await post("/install", { tts: "chatterbox", asr: "qwen3-asr", asrModel: "1.7b" })).status, 200);
  await machine.settle();
  assert.equal((await get("/state")).error, "");
  assert.equal(setting("language"), "en");
});

test("the voice library: voices are added, listed, described anew, heard and deleted, and one that is not there is a 404", async () => {
  machine.reset();
  const audio = await recording(30);
  // Thirty seconds of a recording is about 1.3 MB of JSON.
  let answer = await post("/voices", { name: "Narrator", kind: "clone", instruction: "Warm.", transcript: "Thirty seconds of words.", audio });
  assert.equal(answer.status, 200);
  const clone = await answer.json();
  assert.deepEqual(clone, { id: clone.id, name: "Narrator", kind: "clone", instruction: "Warm.", transcript: "Thirty seconds of words." });
  const designed = await (await post("/voices", { name: "Bright", kind: "design", instruction: "A bright voice." })).json();
  answer = await post("/voices", { name: "Bad", kind: "clone", instruction: "Clear", transcript: "Hello", audio: "YWJj" });
  assert.deepEqual([answer.status, (await answer.json()).error], [400, "Invalid reference WAV; upload a 1–30 second audio clip using Settings"]);
  assert.deepEqual((await get("/voices")).filter((v: { id: string }) => [clone.id, designed.id].includes(v.id)), [designed, clone]);
  answer = await fetch(`${at}/voices/${clone.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ instruction: " Slow. " }) });
  assert.deepEqual([answer.status, await answer.json()], [200, { ...clone, instruction: "Slow." }]);
  answer = await fetch(`${at}/voices/${clone.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ instruction: "" }) });
  assert.deepEqual([answer.status, (await answer.json()).error], [400, "Describe the voice in 1–1000 characters"]);
  answer = await fetch(`${at}/voices/voice-missing`, { method: "PATCH", headers: json, body: JSON.stringify({ instruction: "Slow." }) });
  assert.deepEqual([answer.status, (await answer.json()).error], [404, "Voice not found"]);
  answer = await fetch(`${at}/voices/${clone.id}/audio`);
  assert.deepEqual([answer.status, answer.headers.get("content-type"), answer.headers.get("cache-control")], [200, "audio/wav", "no-store"]);
  assert.deepEqual(Buffer.from(await answer.arrayBuffer()), Buffer.from(audio, "base64"));
  for (const id of [designed.id, "voice-missing", "..%2Fsettings.json"]) assert.equal((await fetch(`${at}/voices/${id}/audio`)).status, 404, id);
  answer = await fetch(`${at}/voices/${clone.id}`, { method: "DELETE" });
  assert.deepEqual([answer.status, await answer.json()], [200, { ok: true }]);
  assert.equal((await fetch(`${at}/voices/${clone.id}/audio`)).status, 404);
  assert.equal((await fetch(`${at}/voices/${clone.id}`, { method: "DELETE" })).status, 404);
  assert.deepEqual((await get("/voices")).map((v: { id: string }) => v.id).includes(clone.id), false);
});
