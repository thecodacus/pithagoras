import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { scratch } from "./helpers.mts";
import { fakeDocker } from "./fake-docker.mts";

// The managed service against a fake Docker daemon and a fake nvidia-smi: what is
// asked of Docker for each choice, how the GPU is read and what is refused. No
// GPU, no image and no container is touched.
const dir = scratch('voice-choices-');
process.env.DOCKER_SOCKET = path.join(dir, 'docker.sock');
process.env.PORTAL_CONTAINER_NAME = 'portal-test';
delete process.env.VOICE_GPU;
delete process.env.VOICE_VRAM_RESERVE_MIB;
const smi = path.join(dir, 'nvidia-smi');
const smiOutput = path.join(dir, 'smi-output');
writeFileSync(smi, `#!/bin/sh\ncat "${smiOutput}"\n`);
chmodSync(smi, 0o755);
const noDevices = path.join(dir, 'nvidia-smi-no-devices');
writeFileSync(noDevices, '#!/bin/sh\necho "No devices were found" >&2\nexit 6\n');
chmodSync(noDevices, 0o755);
/** What the host's nvidia-smi prints, or null for a host that has none. */
const hostGpus = (output: string | null) => {
  if (output === null) process.env.NVIDIA_SMI = path.join(dir, 'no-such-nvidia-smi');
  else { process.env.NVIDIA_SMI = smi; writeFileSync(smiOutput, output); }
};

let container: any = null;
let portalId = 'portal-one';
let dockerGpus: string | null = null;   // what nvidia-smi inside the CUDA image prints; null: no GPU runtime
// The images the daemon has: the CUDA one many gigabytes, the base one small. A pull adds the image it was asked for.
const CUDA = 'nvidia/cuda:12.4.1-devel-ubuntu22.04';
const BASE = 'ubuntu:22.04';
let images = new Set<string>([CUDA, BASE]);
let pullFails = false;
// How Docker fails a container that wants a GPU on a host that has none for it: the daemon's own words.
const NO_RUNTIME = 'could not select device driver "nvidia" with capabilities: [[gpu]]';
let noGpuRuntime = false;               // making the container works, starting one that wants a GPU does not
let probeError: string | null = null;   // an unrelated failure of the probe container
let hangUp = false;                     // the daemon drops the probe's connection
let probeDelay = 0;                     // the probe container is slow to be made, as when its image is still being downloaded
let onStop: (() => void) | null = null; // what stopping the voice container changes: the memory it held is given back
const docker = await fakeDocker(process.env.DOCKER_SOCKET!, async ({ method, url, path: p, query, body, req }) => {
  if (url === '/containers/portal-test/json') return { json: { Id: portalId, State: { Running: true } } };
  if (url === '/containers/pithagoras-voice/json') return { status: container ? 200 : 404, json: container };
  if (url.startsWith('/containers/pithagoras-voice/logs')) return { json: 'services ready' };
  if (p === '/images/create') {
    if (pullFails) return { status: 500, json: { message: 'no route to host' } };
    images.add(`${query.get('fromImage')}:${query.get('tag')}`);
    return { text: '{"status":"Download complete"}\n' };
  }
  if (p.startsWith('/images/') && p.endsWith('/json')) return { status: images.has(decodeURIComponent(p.slice('/images/'.length, -'/json'.length))) ? 200 : 404 };
  // The throwaway container that reads nvidia-smi inside the image.
  if (url === '/containers/create') {
    if (probeDelay) await new Promise(r => setTimeout(r, probeDelay));
    if (hangUp) { req.socket.destroy(); return 'handled'; }
    if (probeError) return { status: 500, json: { message: probeError } };
    if (dockerGpus === null) return { status: 500, json: { message: NO_RUNTIME } };
    return { json: { Id: 'probe-1' } };
  }
  // Only a container that asks for a GPU is refused one.
  if (noGpuRuntime && (url === '/containers/probe-1/start' || (url === '/containers/pithagoras-voice/start' && container?.HostConfig?.DeviceRequests))) return { status: 500, json: { message: NO_RUNTIME } };
  if (p === '/volumes/create') return {};
  if (url === '/containers/probe-1/start') return { status: 204, text: '' };
  if (url === '/containers/probe-1/wait') return { json: { StatusCode: 0 } };
  if (url.startsWith('/containers/probe-1/logs')) return { text: dockerGpus ?? '' };
  if (url.startsWith('/containers/probe-1?')) return {};
  if (url.startsWith('/containers/pithagoras-voice/stop?')) { container.State.Running = false; onStop?.(); return {}; }
  if (method === 'DELETE' && p === '/containers/pithagoras-voice') { container = null; return {}; }
  if (url.startsWith('/containers/create?name=pithagoras-voice')) { container = { Config: body, HostConfig: body.HostConfig, State: { Running: false } }; return {}; }
  if (url === '/containers/pithagoras-voice/start') { container.State.Running = true; return {}; }
});
const { calls } = docker;
const oldFetch = globalThis.fetch;
let unhealthy: string[] = [];
globalThis.fetch = (async (url: any) => new Response('{}', { status: unhealthy.some(u => String(url).includes(u)) ? 503 : 200 })) as typeof fetch;
after(async () => {
  globalThis.fetch = oldFetch;
});
const voice = await import('../core/server/src/extensions/voice-service.js');
const { DEFAULT_CHOICE } = await import('../core/server/src/voice-engines.js');
const { NO_GPU_MESSAGE, NO_GPU_FOR_SPEECH, NO_GPU_FOR_SPEECH_UNUSABLE, DRIVER_TOO_OLD_MESSAGE } = await import('../core/server/src/voice-gpu.js');

// What the host has to run recognition on: sixteen GiB and eight threads, unless a test says otherwise.
const host = (patch = {}) => { voice.hostReader.read = () => ({ totalMiB: 16384, freeMiB: 12000, threads: 8, ...patch }); };
const reset = () => { host(); portalId = 'portal-one'; container = null; dockerGpus = ''; images = new Set([CUDA, BASE]); pullFails = false; noGpuRuntime = false; probeError = null; hangUp = false; probeDelay = 0; onStop = null; docker.reset(); unhealthy = []; delete process.env.VOICE_GPU; delete process.env.VOICE_VRAM_RESERVE_MIB; };
const settle = async () => { for (let n = 0; n < 200 && (await voice.status()).busy; n++) await new Promise(r => setTimeout(r, 10)); };
const created = () => calls.filter(c => c.url === '/containers/create?name=pithagoras-voice');
/** The voice container was deleted, not the throwaway one that reads nvidia-smi. */
const gone = () => calls.some(c => c.method === 'DELETE' && c.url === '/containers/pithagoras-voice?force=true');
const GPU = (index: number, total: number, free: number, name = `Test GPU ${index}`) => `${index}, ${name}, ${total}, ${free}\n`;
const env = (spec: any) => Object.fromEntries(spec.Env.map((e: string) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));

test('a first install without a choice takes what the GPU check suggests, and says so in the setup log', async () => {
  reset(); hostGpus(GPU(0, 12288, 11000));
  await voice.install();
  await settle();
  assert.equal(created().length, 1);
  const spec = created()[0].body;
  assert.deepEqual(env(spec).VOICE_ASR, 'qwen3-asr');
  assert.deepEqual([env(spec).VOICE_TTS, env(spec).VOICE_ASR_MODEL], ['breeze', '1.7b']);
  assert.equal(spec.Labels['pithagoras.voice-recipe'], 'breeze+qwen3-asr:1.7b');
  assert.match(env(spec).VOICE_PLAN, /^Detected Test GPU 0 \(12\.0 GiB, 10\.7 GiB free\): Breeze speech with Qwen3-ASR 1\.7B needs about 7\.0 GiB, which fits\.$/);
  // One card: Docker's own pick, as it has always been.
  assert.deepEqual(spec.HostConfig.DeviceRequests, [{ Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }]);
  assert.equal((await voice.hardware()).source, 'host', 'the cards are the host\'s word, which Docker was then asked to confirm');
  assert.deepEqual(JSON.parse(env(spec).VOICE_SERVER_CONFIG).models.map((m: any) => m.id), ['breeze', 'qwen3-asr']);
  // Ready needs only the audio.cpp process: there is no Whisper.
  unhealthy = [':8188'];
  container.State.Running = true;
  const state = await voice.status();
  assert.deepEqual([state.state, state.choice], ['running', { tts: 'breeze', asr: 'qwen3-asr', asrModel: '1.7b' }]);
});

test('a portal without nvidia-smi reads the GPUs in a throwaway container, and names the one with the most room', async () => {
  reset(); hostGpus(null);
  dockerGpus = GPU(0, 8192, 1000) + GPU(1, 12288, 12000);
  await voice.install({ tts: 'chatterbox', asr: 'qwen3-asr', asrModel: '0.6b' });
  await settle();
  const probe = calls.find(c => c.url === '/containers/create')!.body;
  assert.deepEqual(probe.Cmd.slice(0, 1), ['nvidia-smi']);
  assert.equal(probe.Image, BASE, 'the small image, not the CUDA one');
  assert.deepEqual(probe.Env, ['NVIDIA_DRIVER_CAPABILITIES=utility']);
  assert.deepEqual(probe.HostConfig.DeviceRequests, [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }], 'all of them, to choose among');
  assert.ok(calls.some(c => c.method === 'DELETE' && c.url.startsWith('/containers/probe-1')), 'the probe container is removed again');
  assert.equal(calls.some(c => c.url.includes('/images/create')), false, 'the check never pulls an image of its own');
  const spec = created()[0].body;
  assert.deepEqual(spec.HostConfig.DeviceRequests, [{ Driver: 'nvidia', DeviceIDs: ['1'], Capabilities: [['gpu']] }]);
  assert.equal(spec.Labels['pithagoras.voice-recipe'], 'chatterbox+qwen3-asr:0.6b');
  assert.match(env(spec).VOICE_PLAN, /^Detected Test GPU 1 /);
});

test('VOICE_GPU picks the card and VOICE_VRAM_RESERVE_MIB keeps memory on it free', async () => {
  reset(); hostGpus(GPU(0, 8192, 6500) + GPU(1, 12288, 12000));
  process.env.VOICE_GPU = '0';
  await voice.install();
  await settle();
  assert.deepEqual(created()[0].body.HostConfig.DeviceRequests[0].DeviceIDs, ['0']);
  assert.equal(created()[0].body.Labels['pithagoras.voice-recipe'], 'breeze+qwen3-asr:0.6b', '6.5 GB free holds Breeze and the small model, not the large one');
  reset(); hostGpus(GPU(0, 8192, 8000));
  // Without the reserve 8 GB holds the large model too.
  process.env.VOICE_VRAM_RESERVE_MIB = '2500';
  await voice.install();
  await settle();
  assert.equal(created()[0].body.Labels['pithagoras.voice-recipe'], 'breeze+whisper:base', 'room is kept for something else');
  const hardware = await voice.hardware();
  assert.deepEqual([hardware.reserveMiB, hardware.selected, hardware.suggestion], [2500, 0, DEFAULT_CHOICE]);
});

test('a choice the GPU cannot hold is refused with what would fit, and nothing is created', async () => {
  reset(); hostGpus(GPU(0, 6144, 6000));
  await voice.install({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '1.7b' });
  await settle();
  const state = await voice.status();
  assert.match(state.error, /Breeze speech with Qwen3-ASR 1\.7B needs about 7\.0 GiB of GPU memory, but Test GPU 0 \(6\.0 GiB, 5\.9 GiB free\) has less\. Breeze speech with Qwen3-ASR 0\.6B would fit\./);
  assert.equal(state.state, 'absent');
  assert.equal(created().length, 0);
  // The refusal is not sticky: the next attempt starts clean.
  await voice.install({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' });
  await settle();
  assert.equal((await voice.status()).error, '');
  assert.equal(created().length, 1);
});

test('where the GPU cannot be told, the choice is installed unchecked and Docker has the last word', async () => {
  reset(); hostGpus(null); probeError = 'no space left on device';
  const unknown = await voice.hardware();
  assert.deepEqual([unknown.gpus, unknown.source, unknown.checked, unknown.suggestion, unknown.selected], [[], 'none', false, DEFAULT_CHOICE, null]);
  assert.match(unknown.error, /host: nvidia-smi was not found; docker: no space left on device/);
  await voice.install({ tts: 'chatterbox', asr: 'whisper', asrModel: 'small' });
  await settle();
  assert.equal(created().length, 1);
  assert.match(env(created()[0].body).VOICE_PLAN, /^No GPU could be read here; installing Chatterbox speech with Whisper small unchecked\.$/);
  // The small image the probe runs in is downloaded when it is missing; when that does not come, nothing could be asked, which is not an answer.
  reset(); hostGpus(null); images.delete(BASE); dockerGpus = GPU(0, 12288, 11000);
  assert.equal((await voice.hardware()).gpus.length, 1);
  assert.ok(calls.some(c => c.url.startsWith('/images/create?fromImage=ubuntu')), 'downloaded');
  assert.ok(!calls.some(c => c.url.includes('nvidia%2Fcuda') && c.url.startsWith('/images/create')), 'the CUDA image is not needed to ask');
  reset(); hostGpus(null); images.delete(BASE); pullFails = true;
  const early = await voice.hardware();
  assert.match(early.error, /docker: Pull failed with 500/);
  assert.deepEqual([early.checked, early.cpuOnly], [false, false]);
});

test('no GPU for Docker is "no GPU", not an error, however Docker or the driver says so: Kokoro and recognition are installed on the CPU', async () => {
  const cpuOnly = async (why: string) => {
    const found = await voice.hardware();
    assert.deepEqual([found.gpus, found.checked, found.cpuOnly, found.selected], [[], true, true, null], why);
    assert.deepEqual(found.suggestion, { tts: 'kokoro', ttsDevice: 'cpu', asr: 'qwen3-asr', asrModel: '0.6b' }, why);
    assert.deepEqual(found.host, { totalMiB: 16384, freeMiB: 12000, threads: 8 }, why);
    assert.doesNotMatch(JSON.stringify(found), /could not select device driver|nvidia-container|ECONN/, why);
    // Left to the check, an install is recognition alone: no error, no GPU asked for, and no CUDA image.
    await voice.install();
    await settle();
    const state = await voice.status();
    assert.equal(state.error, '', why);
    assert.equal(created().length, 1, why);
    const spec = created()[0].body;
    assert.equal(spec.Image, BASE, why);
    assert.equal('DeviceRequests' in spec.HostConfig, false, why);
    assert.equal(spec.Labels['pithagoras.voice-recipe'], 'kokoro@cpu+qwen3-asr:0.6b', why);
    assert.match(env(spec).VOICE_PLAN, /^No GPU detected: installing Kokoro speech on the CPU with Qwen3-ASR 0\.6B needing about 2\.8 GiB of memory on the CPU, which fits\.$/, why);
    assert.deepEqual([env(spec).VOICE_TTS_DEVICE, JSON.parse(env(spec).VOICE_CPU_CONFIG).models.map((m: any) => m.id)], ['cpu', ['kokoro', 'qwen3-asr']], why);
    assert.deepEqual([state.state, state.choice], ['running', { tts: 'kokoro', ttsDevice: 'cpu', asr: 'qwen3-asr', asrModel: '0.6b' }], why);
    assert.ok(!calls.some(c => c.url.startsWith('/images/create') && c.url.includes('nvidia')), `${why}: the CUDA image is never downloaded`);
    if (why === 'refused at start') assert.ok(calls.some(c => c.method === 'DELETE' && c.url.startsWith('/containers/probe-1')), `${why}: the probe is removed again`);
  };
  // Docker refuses the probe as it is made, or as it is started, which is where the daemon says it.
  reset(); hostGpus(null); dockerGpus = null; images.delete(CUDA);
  await cpuOnly('refused at create');
  reset(); hostGpus(null); dockerGpus = ''; noGpuRuntime = true; images.delete(CUDA);
  await cpuOnly('refused at start');
  // The daemon does not answer at all.
  reset(); hostGpus(null); hangUp = true; images.delete(CUDA);
  await cpuOnly('no answer');
  // The driver is there and finds no device.
  reset(); process.env.NVIDIA_SMI = noDevices; dockerGpus = null; images.delete(CUDA);
  await cpuOnly('no devices');
});

test('on a host without a GPU a speech engine on the GPU is refused, Kokoro on the CPU is not, and what runs there is the host\'s to carry', async () => {
  reset(); hostGpus(null); dockerGpus = null; images.delete(CUDA);
  // A request for speech synthesis is told what is missing, and nothing is made.
  await voice.install({ tts: 'breeze', asr: 'whisper', asrModel: 'base' });
  await settle();
  const state = await voice.status();
  assert.equal(state.error, NO_GPU_FOR_SPEECH);
  assert.equal(state.state, 'absent');
  assert.equal(created().length, 0);
  // Few threads: a model that would fall behind the speaker is not suggested, and the cheap one is; with one thread, not Kokoro either.
  host({ threads: 2 });
  assert.deepEqual((await voice.hardware()).suggestion, { tts: 'kokoro', ttsDevice: 'cpu', asr: 'whisper', asrModel: 'base' });
  host({ threads: 1 });
  assert.deepEqual((await voice.hardware()).suggestion, { tts: 'none', asr: 'whisper', asrModel: 'base' });
  // Kokoro asked for on the CPU is installed there, in the small image, with no GPU asked for.
  host({ threads: 8 });
  await voice.install({ tts: 'kokoro', ttsDevice: 'cpu', asr: 'whisper', asrModel: 'base' });
  await settle();
  const kokoro = created()[0].body;
  assert.equal(kokoro.Image, BASE);
  assert.equal('DeviceRequests' in kokoro.HostConfig, false);
  assert.equal(kokoro.Labels['pithagoras.voice-recipe'], 'kokoro@cpu+whisper:base');
  assert.deepEqual([env(kokoro).VOICE_TTS_DEVICE, env(kokoro).VOICE_THREADS, 'VOICE_SERVER_CONFIG' in env(kokoro)], ['cpu', '8', false]);
  assert.deepEqual(JSON.parse(env(kokoro).VOICE_CPU_CONFIG).models.map((m: any) => m.id), ['kokoro']);
  // On the GPU it is refused like any other.
  reset(); hostGpus(null); dockerGpus = null; images.delete(CUDA);
  await voice.install({ tts: 'kokoro', asr: 'whisper', asrModel: 'base' });
  await settle();
  assert.equal((await voice.status()).error, NO_GPU_FOR_SPEECH);
  // Little memory: what does not fit is refused, with what would.
  host({ totalMiB: 2048, freeMiB: 1800, threads: 8 });
  await voice.install({ tts: 'none', asr: 'qwen3-asr', asrModel: '1.7b' });
  await settle();
  assert.match((await voice.status()).error, /^Qwen3-ASR 1\.7B \(speech recognition only\) needs about 2\.9 GiB of memory on the CPU, but this host has 2\.0 GiB\. .* would fit\.$/);
  assert.equal(created().length, 0);
  // Recognition alone that is asked for by name is installed as it is, with the threads the host has.
  host({ threads: 6 });
  await voice.install({ tts: 'none', asr: 'whisper', asrModel: 'small' });
  await settle();
  const spec = created()[0].body;
  assert.equal(spec.Image, BASE);
  assert.deepEqual([env(spec).VOICE_TTS, env(spec).VOICE_ASR, env(spec).VOICE_ASR_DEVICE, env(spec).VOICE_THREADS], ['none', 'whisper', 'cpu', '6']);
  assert.equal('VOICE_SERVER_CONFIG' in env(spec) || 'VOICE_CPU_CONFIG' in env(spec), false, 'Whisper alone needs no audio.cpp');
});

test('a CPU-only container is ready when its own services answer, and keeps its engines through start', async () => {
  reset(); hostGpus(null); dockerGpus = null; images.delete(CUDA);
  await voice.install({ tts: 'none', asr: 'qwen3-asr', asrModel: '0.6b' });
  await settle();
  const spec = created()[0].body;
  assert.deepEqual([env(spec).VOICE_ASR_DEVICE, env(spec).VOICE_THREADS], ['cpu', '8']);
  assert.equal('VOICE_SERVER_CONFIG' in env(spec), false, 'there is no GPU process');
  const cpuConfig = JSON.parse(env(spec).VOICE_CPU_CONFIG);
  assert.deepEqual([cpuConfig.backend, cpuConfig.port, cpuConfig.threads, cpuConfig.models.map((m: any) => m.id)], ['cpu', 7863, 8, ['qwen3-asr']]);
  // Neither Whisper's port nor the speech port is waited for.
  unhealthy = [':8188', ':7862'];
  container.State.Running = true;
  assert.equal((await voice.status()).state, 'running');
  unhealthy = [':7863'];
  assert.equal((await voice.status()).state, 'starting');
  // Start keeps what it is, and does not ask for a GPU it was never given.
  container.State.Running = false; docker.reset();
  host({ threads: 2 });
  process.env.VOICE_GPU = '1';
  await voice.start();
  await settle();
  assert.equal(gone() || created().length > 0, false);
  assert.equal(container.State.Running, true);
});

test('a GPU host can put recognition on the CPU, to keep its memory: one image, a GPU server for speech and a CPU one for recognition', async () => {
  reset(); hostGpus(GPU(0, 6144, 6000));
  // Breeze next to Qwen3-ASR 1.7B does not fit the card: on the CPU it does.
  await voice.install({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '1.7b', asrDevice: 'cpu' });
  await settle();
  assert.equal((await voice.status()).error, '');
  const spec = created()[0].body;
  assert.equal(spec.Image, CUDA);
  assert.deepEqual(spec.HostConfig.DeviceRequests, [{ Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }]);
  assert.equal(spec.Labels['pithagoras.voice-recipe'], 'breeze+qwen3-asr:1.7b@cpu');
  assert.deepEqual(JSON.parse(env(spec).VOICE_SERVER_CONFIG).models.map((m: any) => m.id), ['breeze']);
  assert.deepEqual(JSON.parse(env(spec).VOICE_CPU_CONFIG).models.map((m: any) => m.id), ['qwen3-asr']);
  assert.match(env(spec).VOICE_PLAN, /^Detected Test GPU 0 \(6\.0 GiB, 5\.9 GiB free\): Breeze speech with Qwen3-ASR 1\.7B on the CPU needs about 4\.5 GiB, which fits, and about 2\.9 GiB of memory on the CPU, which fits\.$/);
  assert.equal((await voice.status()).choice?.asrDevice, 'cpu');
  // The same choice on the GPU is refused: it does not fit the card.
  reset(); hostGpus(GPU(0, 6144, 6000));
  await voice.install({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '1.7b', asrDevice: 'gpu' });
  await settle();
  assert.match((await voice.status()).error, /needs about 7\.0 GiB of GPU memory/);
  // What the host cannot hold on the CPU is refused too.
  reset(); hostGpus(GPU(0, 24576, 24000)); host({ totalMiB: 2048, freeMiB: 1800 });
  await voice.install({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '1.7b', asrDevice: 'cpu' });
  await settle();
  assert.match((await voice.status()).error, /Breeze speech with Qwen3-ASR 1\.7B on the CPU needs about 2\.9 GiB of memory on the CPU, but this host has 2\.0 GiB\./);
  assert.equal(created().length, 0);
});

test('a GPU that Docker cannot hand on is told in one plain sentence, not as the daemon words it', async () => {
  // The host sees a card and Docker could not be asked (the check itself failed): the container is made, and cannot start.
  reset(); hostGpus(GPU(0, 12288, 11000)); probeError = 'no space left on device'; noGpuRuntime = true;
  await voice.install();
  await settle();
  assert.equal(created().length, 1);
  const state = await voice.status();
  assert.equal(state.error, NO_GPU_MESSAGE);
  assert.doesNotMatch(JSON.stringify(state), /could not select device driver/);
  // The card is there, so the sentence does not say that none was found.
  assert.doesNotMatch(state.error, /none was found/);
  // A container that was made and exited with Docker's own words is shown the same way.
  reset(); hostGpus(GPU(0, 12288, 11000));
  container = { Config: { Labels: { 'pithagoras.addon': 'voice' } }, HostConfig: { NetworkMode: 'container:portal-one' }, State: { Running: false, ExitCode: 128, Error: `failed to create task for container: ${NO_RUNTIME}` } };
  await voice.stop();   // the install's own error is gone; what is left is what Docker says of the container
  container.State.Running = false;
  const failed = await voice.status();
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error, NO_GPU_MESSAGE);
  // Anything else Docker says is left as it is.
  container.State.Error = 'port is already allocated';
  assert.equal((await voice.status()).error, 'port is already allocated');
});

test('a driver too old for the CUDA image is told as that, and the toolkit\'s other errors are left as they are', async () => {
  const requirement = 'failed to create task for container: OCI runtime create failed: runc create failed: unable to start container process: error during container init: error running hook #0: error running hook: exit status 1, stdout: , stderr: Auto-detected mode as \'legacy\'\nnvidia-container-cli: requirement error: unsatisfied condition: cuda>=12.4, please update your driver to a newer version, or use an earlier cuda container: unknown';
  reset(); hostGpus(GPU(0, 12288, 11000));
  container = { Config: { Labels: { 'pithagoras.addon': 'voice' } }, HostConfig: { NetworkMode: 'container:portal-one' }, State: { Running: false, ExitCode: 128, Error: requirement } };
  await voice.stop();
  container.State.Running = false;
  const old = await voice.status();
  assert.equal(old.error, DRIVER_TOO_OLD_MESSAGE);
  assert.match(old.error, /driver.*too old.*update the driver/);
  assert.doesNotMatch(old.error, /NVIDIA Container Toolkit|no GPU|none was found/, 'the toolkit is there; saying it is missing would send the person the wrong way');
  // Other errors of the toolkit say what is wrong in their own words.
  for (const message of ['nvidia-container-cli: mount error: failed to add device rules: unable to find any existing device filters', 'nvidia-container-cli: ldcache error: process /sbin/ldconfig failed with error code: 127']) {
    container.State.Error = `error running hook: ${message}`;
    assert.equal((await voice.status()).error, `error running hook: ${message}`);
  }
});

test('a host with the driver but without the toolkit has no GPU for voice: the card is said to be unusable, and Kokoro and recognition are installed on the CPU', async () => {
  // nvidia-smi on the host lists a card; Docker, asked to hand it to a container, has no runtime for it.
  reset(); hostGpus(GPU(0, 12288, 11000, 'Test GPU 0')); dockerGpus = null; images.delete(CUDA);
  const found = await voice.hardware();
  assert.deepEqual([found.gpus, found.checked, found.cpuOnly, found.selected, found.unusable], [[], true, true, null, ['Test GPU 0']]);
  assert.deepEqual(found.suggestion, { tts: 'kokoro', ttsDevice: 'cpu', asr: 'qwen3-asr', asrModel: '0.6b' });
  assert.doesNotMatch(JSON.stringify(found), /could not select device driver/);
  // Left to the check, the install does not pick Breeze to fail on it: it is Kokoro and recognition on the CPU, in the small image.
  await voice.install();
  await settle();
  const state = await voice.status();
  assert.equal(state.error, '');
  assert.equal(created().length, 1);
  assert.equal(created()[0].body.Image, BASE);
  assert.equal('DeviceRequests' in created()[0].body.HostConfig, false);
  assert.deepEqual(state.choice, { tts: 'kokoro', ttsDevice: 'cpu', asr: 'qwen3-asr', asrModel: '0.6b' });
  assert.ok(!calls.some(c => c.url.startsWith('/images/create') && c.url.includes('nvidia')), 'no CUDA image');
  // The log says what the page says: the card is there, and it is Docker that cannot use it.
  assert.match(env(created()[0].body).VOICE_PLAN, /^GPU detected: Test GPU 0, but Docker cannot use it: installing Kokoro speech on the CPU with Qwen3-ASR 0\.6B needing about 2\.8 GiB of memory on the CPU, which fits\.$/);
  // A request for speech is told what is missing: the toolkit, not a card, since the card is there.
  reset(); hostGpus(GPU(0, 12288, 11000)); dockerGpus = null;
  await voice.install({ tts: 'breeze', asr: 'whisper', asrModel: 'base' });
  await settle();
  assert.equal((await voice.status()).error, NO_GPU_FOR_SPEECH_UNUSABLE);
  assert.match(NO_GPU_FOR_SPEECH_UNUSABLE, /NVIDIA Container Toolkit/);
  assert.doesNotMatch(NO_GPU_FOR_SPEECH_UNUSABLE, /none was found/);
  // Where there is no card at all it is a GPU that is asked for.
  reset(); hostGpus(null); dockerGpus = null;
  await voice.install({ tts: 'breeze', asr: 'whisper', asrModel: 'base' });
  await settle();
  assert.equal((await voice.status()).error, NO_GPU_FOR_SPEECH);
  reset(); hostGpus(GPU(0, 12288, 11000)); dockerGpus = null;
  // Docker that cannot be asked leaves the host's word, and Docker that works confirms it.
  reset(); hostGpus(GPU(0, 12288, 11000)); probeError = 'no space left on device';
  assert.deepEqual([(await voice.hardware()).gpus.length, (await voice.hardware()).cpuOnly], [1, false]);
  reset(); hostGpus(GPU(0, 12288, 11000));
  const fine = await voice.hardware();
  assert.deepEqual([fine.gpus.length, fine.cpuOnly, fine.unusable], [1, false, undefined]);
  assert.ok(calls.some(c => c.method === 'DELETE' && c.url.startsWith('/containers/probe-1')), 'the throwaway container is removed');
});

test('a container made before engines could be chosen keeps its engines through start and through a restating of the same choice', async () => {
  reset(); hostGpus(GPU(0, 1024, 1000));   // far too small: a restart must not be refused on that
  container = { Config: { Labels: { 'pithagoras.addon': 'voice', 'pithagoras.voice-network': 'shared-v1' } }, HostConfig: { NetworkMode: 'container:portal-one' }, State: { Running: false } };
  assert.deepEqual((await voice.status()).choice, DEFAULT_CHOICE);
  await voice.start();
  await settle();
  assert.equal(container.State.Running, true);
  await voice.install(DEFAULT_CHOICE);
  await settle();
  assert.equal(gone() || created().length > 0, false, 'nothing recreated');
  assert.equal((await voice.status()).error, '');
  assert.deepEqual((await voice.status()).state, 'running');
});

test('a legacy container moved to a new network namespace is recreated as the original combination, without a GPU check', async () => {
  reset(); hostGpus(GPU(0, 1024, 1000));   // a card the original combination would be refused on
  container = { Config: { Labels: { 'pithagoras.addon': 'voice' } }, HostConfig: { NetworkMode: 'bridge' }, State: { Running: true } };
  assert.equal((await voice.status()).state, 'installing');
  await settle();
  assert.equal((await voice.status()).error, '');
  const spec = created()[0].body;
  assert.equal(spec.HostConfig.NetworkMode, 'container:portal-one');
  assert.equal(spec.Labels['pithagoras.voice-recipe'], 'breeze+whisper:base');
  assert.deepEqual(spec.HostConfig.DeviceRequests, [{ Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }]);
  assert.equal('VOICE_PLAN' in env(spec), false, 'no check was made, so there is nothing to report');
  assert.equal(calls.some(c => c.url === '/containers/create'), false);
});

test('a container recreated for a new portal namespace stays on the card it was given', async () => {
  reset(); hostGpus(GPU(0, 12288, 2000) + GPU(1, 12288, 12000));
  await voice.install({ tts: 'breeze', asr: 'whisper', asrModel: 'base' });
  await settle();
  assert.deepEqual(created()[0].body.HostConfig.DeviceRequests, [{ Driver: 'nvidia', DeviceIDs: ['1'], Capabilities: [['gpu']] }]);
  // A portal update gives the portal container a new id, and the voice container is made again for it.
  // The card it has is looked up, as it may be gone, but the engines are not judged against it again: with card 1 read as too small for them they are kept.
  hostGpus(GPU(0, 12288, 2000) + GPU(1, 2048, 1500));
  portalId = 'portal-two'; docker.reset();
  assert.equal((await voice.status()).state, 'installing');
  await settle();
  assert.equal(created()[0].body.HostConfig.NetworkMode, 'container:portal-two');
  assert.deepEqual(created()[0].body.HostConfig.DeviceRequests, [{ Driver: 'nvidia', DeviceIDs: ['1'], Capabilities: [['gpu']] }]);
  assert.equal(created()[0].body.Labels['pithagoras.voice-recipe'], 'breeze+whisper:base');
  assert.equal((await voice.status()).error, '', 'a kept choice is not checked again');
});

test('VOICE_GPU decides the card of a recreated container, and of one installed without a GPU reading', async () => {
  reset(); hostGpus(GPU(0, 12288, 12000) + GPU(1, 12288, 3000));
  container = { Config: { Labels: { 'pithagoras.addon': 'voice' } }, HostConfig: { NetworkMode: 'bridge' }, State: { Running: true } };
  process.env.VOICE_GPU = '1';
  assert.equal((await voice.status()).state, 'installing');
  await settle();
  assert.deepEqual(created()[0].body.HostConfig.DeviceRequests, [{ Driver: 'nvidia', DeviceIDs: ['1'], Capabilities: [['gpu']] }]);
  reset(); hostGpus(null); probeError = 'no space left on device';
  process.env.VOICE_GPU = '1';
  await voice.install({ tts: 'chatterbox', asr: 'whisper', asrModel: 'base' });
  await settle();
  assert.deepEqual(created()[0].body.HostConfig.DeviceRequests, [{ Driver: 'nvidia', DeviceIDs: ['1'], Capabilities: [['gpu']] }]);
});

test('a VOICE_GPU that no card has is ignored when the cards can be read, at install and at recreation alike', async () => {
  reset(); hostGpus(GPU(0, 12288, 2000) + GPU(1, 12288, 12000));
  process.env.VOICE_GPU = '2';
  await voice.install({ tts: 'breeze', asr: 'whisper', asrModel: 'base' });
  await settle();
  const card = (spec: any) => spec.HostConfig.DeviceRequests[0];
  assert.deepEqual(card(created()[0].body).DeviceIDs, ['1'], 'the card with the most room');
  // A portal update: the container is made again, on the card it has, not on one that is not there.
  portalId = 'portal-two'; docker.reset();
  assert.equal((await voice.status()).state, 'installing');
  await settle();
  assert.deepEqual(card(created()[0].body).DeviceIDs, ['1']);
  assert.equal((await voice.status()).error, '');
  // One card, and a setting that names a second: Docker's own pick, as an install makes it.
  reset(); hostGpus(GPU(0, 12288, 12000));
  container = { Config: { Labels: { 'pithagoras.addon': 'voice' } }, HostConfig: { NetworkMode: 'bridge' }, State: { Running: true } };
  process.env.VOICE_GPU = '1';
  assert.equal((await voice.status()).state, 'installing');
  await settle();
  assert.deepEqual(card(created()[0].body), { Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] });
});

test('Start moves a container to the card VOICE_GPU names, and leaves one that is on it alone', async () => {
  const stopped = (devices: any) => ({ Config: { Labels: { 'pithagoras.addon': 'voice', 'pithagoras.voice-network': 'shared-v1', 'pithagoras.voice-recipe': 'breeze+whisper:base' } }, HostConfig: { NetworkMode: 'container:portal-one', DeviceRequests: [devices] }, State: { Running: false } });
  const cards = GPU(0, 12288, 12000) + GPU(1, 12288, 12000);
  reset(); hostGpus(cards);
  container = stopped({ Driver: 'nvidia', DeviceIDs: ['0'], Capabilities: [['gpu']] });
  process.env.VOICE_GPU = '1';
  await voice.start();
  await settle();
  assert.deepEqual(created()[0].body.HostConfig.DeviceRequests[0].DeviceIDs, ['1']);
  assert.equal(container.Config.Labels['pithagoras.voice-recipe'], 'breeze+whisper:base');
  // Already there: started as it is. So is one that asked Docker for any one GPU, which is the first.
  for (const [devices, asked] of [[{ Driver: 'nvidia', DeviceIDs: ['1'], Capabilities: [['gpu']] }, '1'], [{ Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }, '0']] as const) {
    reset(); hostGpus(cards);
    container = stopped(devices);
    process.env.VOICE_GPU = asked;
    await voice.start();
    await settle();
    assert.equal(gone() || created().length > 0, false, `on card ${asked} already`);
    assert.equal(container.State.Running, true);
  }
  // No setting: whatever card it has is kept.
  reset(); hostGpus(cards);
  container = stopped({ Driver: 'nvidia', DeviceIDs: ['1'], Capabilities: [['gpu']] });
  await voice.start();
  await settle();
  assert.equal(gone(), false);
});

test('the page is told the card the installed service is on, not the one with the most room', async () => {
  const cards = GPU(0, 6144, 6000) + GPU(1, 12288, 5000);
  reset(); hostGpus(cards);
  assert.equal((await voice.hardware()).selected, 0, 'nothing installed: the card with the most room');
  container = { Config: { Labels: { 'pithagoras.addon': 'voice', 'pithagoras.voice-recipe': 'breeze+qwen3-asr:1.7b' } }, HostConfig: { DeviceRequests: [{ Driver: 'nvidia', DeviceIDs: ['1'], Capabilities: [['gpu']] }] }, State: { Running: true } };
  assert.equal((await voice.hardware()).selected, 1, 'the service holds memory there, which is why it has less free');
  // One made before the card was chosen has Docker's first.
  container = { Config: { Labels: { 'pithagoras.addon': 'voice' } }, HostConfig: { DeviceRequests: [{ Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }] }, State: { Running: true } };
  hostGpus(GPU(0, 6144, 1000) + GPU(1, 12288, 12000));
  assert.equal((await voice.hardware()).selected, 0);
  container = null;
  process.env.VOICE_GPU = '0';
  assert.equal((await voice.hardware()).selected, 0, 'VOICE_GPU for a first install');
});

test('a rebuild takes its own reading of the GPUs after the stop, not that of a check of the page which began before it', async () => {
  // Two cards: the service runs on card 0, which looks full while it holds its memory (5000 MiB free) and has 12000 once it is stopped; card 1 has 9000.
  const running = () => ({ Config: { Labels: { 'pithagoras.addon': 'voice', 'pithagoras.voice-network': 'shared-v1', 'pithagoras.voice-recipe': 'breeze+whisper:base' } }, HostConfig: { NetworkMode: 'container:portal-one', DeviceRequests: [{ Driver: 'nvidia', DeviceIDs: ['0'], Capabilities: [['gpu']] }] }, State: { Running: true } });
  const setup = () => {
    reset(); hostGpus(GPU(0, 12288, 5000) + GPU(1, 12288, 9000)); container = running();
    onStop = () => writeFileSync(smiOutput, GPU(0, 12288, 12000) + GPU(1, 12288, 9000));
  };
  // Alone: the card the service is on.
  setup();
  await voice.install({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' });
  await settle();
  assert.deepEqual(created()[0].body.HostConfig.DeviceRequests[0].DeviceIDs, ['0']);
  // While the page's check is still running, slowly, with readings taken when the service still held its memory.
  setup(); probeDelay = 400;
  const page = voice.hardware();
  await new Promise(r => setTimeout(r, 50));
  await voice.install({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' });
  await page;
  await settle();
  assert.deepEqual(created()[0].body.HostConfig.DeviceRequests[0].DeviceIDs, ['0'], 'the service stays on its card: it is the one with room once it is stopped');
  assert.match(env(created()[0].body).VOICE_PLAN, /^Detected Test GPU 0 \(12\.0 GiB, 11\.7 GiB free\)/);
  // The page's own check is not made to wait for ever, and a failed one does not stop the install.
  setup(); probeDelay = 50; probeError = 'no space left on device';
  const failing = voice.hardware();
  await new Promise(r => setTimeout(r, 10));
  await voice.install({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' });
  await failing;
  await settle();
  assert.equal(created().length, 1);
});

test('a rebuild reads the GPU after the running service is stopped, and starts it again when the choice is refused', async () => {
  reset(); hostGpus(null); dockerGpus = GPU(0, 6144, 6000);
  const running = () => ({ Config: { Labels: { 'pithagoras.addon': 'voice', 'pithagoras.voice-network': 'shared-v1', 'pithagoras.voice-recipe': 'breeze+whisper:base' } }, HostConfig: { NetworkMode: 'container:portal-one' }, State: { Running: true } });
  container = running();
  await voice.install({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '1.7b' });
  await settle();
  const at = (test: (c: { url: string }) => boolean) => calls.findIndex(test);
  assert.ok(at(c => c.url.includes('/stop?')) >= 0 && at(c => c.url.includes('/stop?')) < at(c => c.url === '/containers/create'), 'its own memory is not counted as taken by others');
  assert.match((await voice.status()).error, /needs about 7\.0 GiB/);
  assert.equal(container.State.Running, true, 'the refusal leaves the service running');
  assert.equal(calls.some(c => c.method === 'DELETE' && c.url === '/containers/pithagoras-voice?force=true'), false);
  assert.equal(calls.filter(c => c.url === '/containers/pithagoras-voice/start').length, 1);
  // A choice that fits is stopped once, probed, and replaced.
  docker.reset(); container = running();
  await voice.install({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' });
  await settle();
  assert.equal(calls.filter(c => c.url.includes('/stop?')).length, 1);
  assert.ok(at(c => c.url.includes('/stop?')) < at(c => c.url === '/containers/create'));
  assert.equal(created()[0].body.Labels['pithagoras.voice-recipe'], 'breeze+qwen3-asr:0.6b');
});

test('another choice recreates the container, keeps the volume and is not mistaken for a network change', async () => {
  reset(); hostGpus(GPU(0, 12288, 11000));
  container = { Config: { Labels: { 'pithagoras.addon': 'voice', 'pithagoras.voice-network': 'shared-v1' } }, HostConfig: { NetworkMode: 'container:portal-one' }, State: { Running: true } };
  await voice.install({ tts: 'chatterbox', asr: 'qwen3-asr', asrModel: '1.7b' });
  await settle();
  assert.ok(calls.some(c => c.method === 'DELETE' && c.url === '/containers/pithagoras-voice?force=true'));
  assert.ok(calls.some(c => c.url.includes('/stop?')));
  assert.equal(calls.some(c => c.url.startsWith('/volumes') && c.method === 'DELETE'), false);
  assert.deepEqual(created()[0].body.HostConfig.Binds, ['pithagoras_voice-models:/voice']);
  assert.equal(container.Config.Labels['pithagoras.voice-recipe'], 'chatterbox+qwen3-asr:1.7b');
  // Start now keeps what was built.
  docker.reset();
  await voice.start();
  await settle();
  assert.equal(gone(), false);
  assert.equal(container.Config.Labels['pithagoras.voice-recipe'], 'chatterbox+qwen3-asr:1.7b');
});

test('a request for an engine the installer does not make is refused before anything happens', async () => {
  reset(); hostGpus(GPU(0, 12288, 11000));
  await assert.rejects(voice.install({ tts: 'piper', asr: 'whisper', asrModel: 'base' } as any), /speech synthesis engine/);
  await assert.rejects(voice.install({ tts: 'breeze', asr: 'whisper', asrModel: '1.7b' }), /speech recognition model/);
  assert.equal((await voice.status()).busy, false, 'the refusal does not leave a setup running');
  assert.equal(calls.some(c => c.url.startsWith('/containers/create')), false);
});

test('the container spec of the original combination is the one it always was', () => {
  const spec = voice.containerSpec('echo test', 'host');
  assert.deepEqual(spec.HostConfig.DeviceRequests, [{ Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }]);
  assert.deepEqual(spec.HostConfig.Binds, ['pithagoras_voice-models:/voice']);
  assert.equal(spec.Labels['pithagoras.voice-network'], 'shared-v1');
  assert.equal(spec.Labels['pithagoras.voice-recipe'], 'breeze+whisper:base');
  assert.deepEqual(spec.Cmd, ['bash', '-c', 'echo test']);
  assert.deepEqual(env(spec).VOICE_TTS + env(spec).VOICE_ASR + env(spec).VOICE_ASR_MODEL, 'breezewhisperbase');
  assert.equal('VOICE_PLAN' in env(spec), false);
});

test('the model the lease loads is the one the saved engine speaks with', async () => {
  reset();
  const sent: { url: string; body: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return new Response('{}'); }) as typeof fetch;
  await voice.modelAction('load');
  await voice.modelAction('unload');
  await voice.modelAction('load', 'chatterbox');
  await voice.modelAction('unload', 'chatterbox');
  await voice.modelAction('load', 'kokoro');
  assert.deepEqual(sent.map(s => s.url).slice(0, 4), Array(4).fill('http://127.0.0.1:7862/v1/models/load').map((u, i) => u.replace('load', i % 2 ? 'unload' : 'load')));
  // The load request Breeze has always had, byte for byte.
  assert.deepEqual(sent[0].body, { id: 'breeze', family: 'breeze_tts', path: '/voice/models/breeze-q8_0.gguf', task: 'tts', mode: 'streaming', session_options: { 'breeze_tts.reference_cache_slots': '1' } });
  assert.deepEqual(sent[1].body, { id: 'breeze' });
  assert.equal(sent[2].body.id, 'chatterbox');
  assert.equal(sent[2].body.path, '/voice/models/chatterbox-q8_0.gguf');
  assert.deepEqual(sent[3].body, { id: 'chatterbox' });
  assert.deepEqual(sent[4].body, { id: 'kokoro', family: 'kokoro_tts', path: '/voice/models/kokoro-82m-q8_0.gguf', task: 'tts', mode: 'offline' });
});
