import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { inProcessHome } from "../../../tests/helpers.mts";
import { serveVoice } from "./portal.mts";
import { GPU } from "./service.mts";

/**
 * The routes of the voice service's page in Settings, at /api/x/pithagoras-voice, as the portal serves them: the GPU
 * check and the card, an install's choice of engines, and what is said where Docker cannot be reached.
 */

inProcessHome("pithagoras-voice-routes-");
const { machine, at, api, docker: daemon } = await serveVoice();
const { setting } = await import("../src/server/store.ts");

const json = { "content-type": "application/json" };
const get = async (route: string) => (await fetch(`${at}${route}`)).json();
const post = (route: string, body: unknown = {}) => fetch(`${at}${route}`, { method: "POST", headers: json, body: JSON.stringify(body) });

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
