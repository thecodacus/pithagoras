import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASE, CONTAINER, CUDA, GPU, NO_RUNTIME, PROBE, env, voiceService } from './service.mts';

// The voice service against Docker's own API for it and a daemon of the tests' own, and a fake nvidia-smi: what is
// asked of Docker for each choice, how the GPU is read and what is refused. No GPU, no image and no container is touched.
const v = await voiceService();
const { service: voice, daemon } = v;
const { DEFAULT_CHOICE } = await import('../src/engines.ts');
const { NO_GPU_MESSAGE, NO_GPU_FOR_SPEECH, NO_GPU_FOR_SPEECH_UNUSABLE, DRIVER_TOO_OLD_MESSAGE } = await import('../src/server/gpu.ts');
// nvidia-smi of a driver that finds no device.
const noDevices = path.join(mkdtempSync(path.join(os.tmpdir(), 'voice-smi-')), 'nvidia-smi');
writeFileSync(noDevices, '#!/bin/sh\necho "No devices were found" >&2\nexit 6\n');
chmodSync(noDevices, 0o755);

// What the host has to run recognition on: sixteen GiB and eight threads, unless a test says otherwise.
const host = (patch = {}) => { voice.hostReader.read = () => ({ totalMiB: 16384, freeMiB: 12000, threads: 8, ...patch }); };
const reset = () => v.reset();
const settle = () => v.settle();
/** What each voice container was made with: Docker's create body. */
const created = () => v.made().map(c => c.made as any);
const GONE = (id: string) => !daemon.containers.some(c => c.Id === id);
/** A voice container an earlier portal made, as it is now. */
const earlier = (labels: Record<string, string>, hostConfig: Record<string, unknown>, state = 'exited') => v.putVoice({ Labels: { 'pithagoras.addon': 'voice', ...labels }, HostConfig: hostConfig, State: state });
const voiceStarts = () => daemon.starts.filter(name => name === CONTAINER).length;

test('a first install without a choice takes what the GPU check suggests, and says so in the setup log', async () => {
  reset(); v.hostGpus(GPU(0, 12288, 11000));
  await voice.install();
  await settle();
  assert.equal(created().length, 1);
  const spec = created()[0];
  assert.deepEqual(env(spec).VOICE_ASR, 'qwen3-asr');
  assert.deepEqual([env(spec).VOICE_TTS, env(spec).VOICE_ASR_MODEL], ['breeze', '1.7b']);
  assert.equal(spec.Labels['pithagoras.voice-recipe'], 'breeze+qwen3-asr:1.7b');
  assert.match(env(spec).VOICE_PLAN, /^Detected Test GPU 0 \(12\.0 GiB, 10\.7 GiB free\): Breeze speech with Qwen3-ASR 1\.7B needs about 7\.0 GiB, which fits\.$/);
  // One card: Docker's own pick, as it has always been.
  assert.deepEqual(spec.HostConfig.DeviceRequests, [{ Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }]);
  assert.equal((await voice.hardware()).source, 'host', 'the cards are the host\'s word, which Docker was then asked to confirm');
  assert.deepEqual(JSON.parse(env(spec).VOICE_SERVER_CONFIG).models.map((m: any) => m.id), ['breeze', 'qwen3-asr']);
  // Ready needs only the audio.cpp process: there is no Whisper.
  v.voiceProcesses.unhealthy = [':8188'];
  const state = await voice.status();
  assert.deepEqual([state.state, state.choice], ['running', { tts: 'breeze', asr: 'qwen3-asr', asrModel: '1.7b' }]);
});

test('a portal without nvidia-smi reads the GPUs in a short-lived container, and names the one with the most room', async () => {
  reset(); v.hostGpus(null);
  v.dockerGpus(GPU(0, 8192, 1000) + GPU(1, 12288, 12000));
  await voice.install({ tts: 'chatterbox', asr: 'qwen3-asr', asrModel: '0.6b' });
  await settle();
  const probe = daemon.created.find(c => c.Name === PROBE)!.made as any;
  assert.deepEqual(probe.Cmd.slice(0, 1), ['nvidia-smi']);
  assert.equal(probe.Image, BASE, 'the small image, not the CUDA one');
  assert.deepEqual(probe.Env, ['NVIDIA_DRIVER_CAPABILITIES=utility']);
  assert.deepEqual(probe.HostConfig.DeviceRequests, [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }], 'all of them, to choose among');
  assert.equal(probe.Labels['pithagoras.addon'], 'voice-probe');
  assert.equal(daemon.containers.some(c => c.Name === PROBE), false, 'the check\'s container is removed again');
  assert.deepEqual(daemon.pulls, [], 'the check pulls no image it has');
  const spec = created()[0];
  assert.deepEqual(spec.HostConfig.DeviceRequests, [{ Driver: 'nvidia', DeviceIDs: ['1'], Capabilities: [['gpu']] }]);
  assert.equal(spec.Labels['pithagoras.voice-recipe'], 'chatterbox+qwen3-asr:0.6b');
  assert.match(env(spec).VOICE_PLAN, /^Detected Test GPU 1 /);
});

test('VOICE_GPU picks the card and VOICE_VRAM_RESERVE_MIB keeps memory on it free', async () => {
  reset(); v.hostGpus(GPU(0, 8192, 6500) + GPU(1, 12288, 12000));
  process.env.VOICE_GPU = '0';
  await voice.install();
  await settle();
  assert.deepEqual(created()[0].HostConfig.DeviceRequests[0].DeviceIDs, ['0']);
  assert.equal(created()[0].Labels['pithagoras.voice-recipe'], 'breeze+qwen3-asr:0.6b', '6.5 GB free holds Breeze and the small model, not the large one');
  reset(); v.hostGpus(GPU(0, 8192, 8000));
  // Without the reserve 8 GB holds the large model too.
  process.env.VOICE_VRAM_RESERVE_MIB = '2500';
  await voice.install();
  await settle();
  assert.equal(created()[0].Labels['pithagoras.voice-recipe'], 'breeze+whisper:base', 'room is kept for something else');
  const hardware = await voice.hardware();
  assert.deepEqual([hardware.reserveMiB, hardware.selected, hardware.suggestion], [2500, 0, DEFAULT_CHOICE]);
});

test('a choice the GPU cannot hold is refused with what would fit, and nothing is created', async () => {
  reset(); v.hostGpus(GPU(0, 6144, 6000));
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
  // The check's image cannot be downloaded: nothing could be asked, which is not an answer.
  reset(); v.hostGpus(null); daemon.images.delete(BASE); daemon.failing.set(BASE, 'no space left on device');
  const unknown = await voice.hardware();
  assert.deepEqual([unknown.gpus, unknown.source, unknown.checked, unknown.suggestion, unknown.selected], [[], 'none', false, DEFAULT_CHOICE, null]);
  assert.match(unknown.error, /host: nvidia-smi was not found; docker: no space left on device/);
  assert.equal(unknown.cpuOnly, false);
  await voice.install({ tts: 'chatterbox', asr: 'whisper', asrModel: 'small' });
  await settle();
  assert.equal(created().length, 1);
  assert.match(env(created()[0]).VOICE_PLAN, /^No GPU could be read here; installing Chatterbox speech with Whisper small unchecked\.$/);
  // The small image the check runs in is downloaded when it is missing, and the CUDA one is not needed to ask.
  reset(); v.hostGpus(null); daemon.images.delete(BASE); v.dockerGpus(GPU(0, 12288, 11000));
  assert.equal((await voice.hardware()).gpus.length, 1);
  assert.deepEqual(daemon.pulls, [BASE]);
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
    const spec = created()[0];
    assert.equal(spec.Image, BASE, why);
    assert.equal('DeviceRequests' in spec.HostConfig, false, why);
    assert.equal(spec.Labels['pithagoras.voice-recipe'], 'kokoro@cpu+qwen3-asr:0.6b', why);
    assert.match(env(spec).VOICE_PLAN, /^No GPU detected: installing Kokoro speech on the CPU with Qwen3-ASR 0\.6B needing about 2\.8 GiB of memory on the CPU, which fits\.$/, why);
    assert.deepEqual([env(spec).VOICE_TTS_DEVICE, JSON.parse(env(spec).VOICE_CPU_CONFIG).models.map((m: any) => m.id)], ['cpu', ['kokoro', 'qwen3-asr']], why);
    assert.deepEqual([state.state, state.choice], ['running', { tts: 'kokoro', ttsDevice: 'cpu', asr: 'qwen3-asr', asrModel: '0.6b' }], why);
    assert.ok(!daemon.pulls.some(image => image.startsWith('nvidia')), `${why}: the CUDA image is never downloaded`);
    assert.equal(daemon.containers.some(c => c.Name === PROBE), false, `${why}: the check's container is removed again`);
  };
  // Docker refuses to start the check's container, which asks for a GPU: that is where the daemon says it.
  reset(); v.hostGpus(null); v.dockerGpus(null); daemon.images.delete(CUDA);
  await cpuOnly('refused at start');
  // The driver is there and finds no device.
  reset(); process.env.NVIDIA_SMI = noDevices; v.dockerGpus(null); daemon.images.delete(CUDA);
  await cpuOnly('no devices');
});

test('a Docker that does not answer is no GPU, and nothing is installed without one', async () => {
  reset(); v.hostGpus(null);
  const socket = process.env.DOCKER_SOCKET;
  process.env.DOCKER_SOCKET = path.join(os.tmpdir(), 'no-docker-here.sock');
  try {
    const found = await voice.hardware();
    assert.deepEqual([found.gpus, found.checked, found.cpuOnly], [[], true, true]);
    assert.equal(found.error, 'host: nvidia-smi was not found; docker: no GPU available');
    await assert.rejects(voice.install(), /Docker is unavailable/);
    assert.equal((await voice.status()).state, 'unavailable');
  } finally { process.env.DOCKER_SOCKET = socket; }
  assert.equal((await voice.status()).busy, false, 'the refusal leaves no setup running');
});

test('on a host without a GPU a speech engine on the GPU is refused, Kokoro on the CPU is not, and what runs there is the host\'s to carry', async () => {
  reset(); v.hostGpus(null); v.dockerGpus(null); daemon.images.delete(CUDA);
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
  const kokoro = created()[0];
  assert.equal(kokoro.Image, BASE);
  assert.equal('DeviceRequests' in kokoro.HostConfig, false);
  assert.equal(kokoro.Labels['pithagoras.voice-recipe'], 'kokoro@cpu+whisper:base');
  assert.deepEqual([env(kokoro).VOICE_TTS_DEVICE, env(kokoro).VOICE_THREADS, 'VOICE_SERVER_CONFIG' in env(kokoro)], ['cpu', '8', false]);
  assert.deepEqual(JSON.parse(env(kokoro).VOICE_CPU_CONFIG).models.map((m: any) => m.id), ['kokoro']);
  // On the GPU it is refused like any other.
  reset(); v.hostGpus(null); v.dockerGpus(null); daemon.images.delete(CUDA);
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
  const spec = created()[0];
  assert.equal(spec.Image, BASE);
  assert.deepEqual([env(spec).VOICE_TTS, env(spec).VOICE_ASR, env(spec).VOICE_ASR_DEVICE, env(spec).VOICE_THREADS], ['none', 'whisper', 'cpu', '6']);
  assert.equal('VOICE_SERVER_CONFIG' in env(spec) || 'VOICE_CPU_CONFIG' in env(spec), false, 'Whisper alone needs no audio.cpp');
});

test('a CPU-only container is ready when its own services answer, and keeps its engines through start', async () => {
  reset(); v.hostGpus(null); v.dockerGpus(null); daemon.images.delete(CUDA);
  await voice.install({ tts: 'none', asr: 'qwen3-asr', asrModel: '0.6b' });
  await settle();
  const spec = created()[0];
  assert.deepEqual([env(spec).VOICE_ASR_DEVICE, env(spec).VOICE_THREADS], ['cpu', '8']);
  assert.equal('VOICE_SERVER_CONFIG' in env(spec), false, 'there is no GPU process');
  const cpuConfig = JSON.parse(env(spec).VOICE_CPU_CONFIG);
  assert.deepEqual([cpuConfig.backend, cpuConfig.port, cpuConfig.threads, cpuConfig.models.map((m: any) => m.id)], ['cpu', 7863, 8, ['qwen3-asr']]);
  // Neither Whisper's port nor the speech port is waited for.
  v.voiceProcesses.unhealthy = [':8188', ':7862'];
  assert.equal((await voice.status()).state, 'running');
  v.voiceProcesses.unhealthy = [':7863'];
  assert.equal((await voice.status()).state, 'starting');
  // Start keeps what it is, and does not ask for a GPU it was never given.
  await v.docker.containers.stop(CONTAINER);
  daemon.created.length = 0;
  host({ threads: 2 });
  process.env.VOICE_GPU = '1';
  await voice.start();
  await settle();
  assert.equal(created().length, 0);
  assert.equal(v.voice()!.State, 'running');
});

test('a GPU host can put recognition on the CPU, to keep its memory: one image, a GPU server for speech and a CPU one for recognition', async () => {
  reset(); v.hostGpus(GPU(0, 6144, 6000));
  // Breeze next to Qwen3-ASR 1.7B does not fit the card: on the CPU it does.
  await voice.install({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '1.7b', asrDevice: 'cpu' });
  await settle();
  assert.equal((await voice.status()).error, '');
  const spec = created()[0];
  assert.equal(spec.Image, CUDA);
  assert.deepEqual(spec.HostConfig.DeviceRequests, [{ Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }]);
  assert.equal(spec.Labels['pithagoras.voice-recipe'], 'breeze+qwen3-asr:1.7b@cpu');
  assert.deepEqual(JSON.parse(env(spec).VOICE_SERVER_CONFIG).models.map((m: any) => m.id), ['breeze']);
  assert.deepEqual(JSON.parse(env(spec).VOICE_CPU_CONFIG).models.map((m: any) => m.id), ['qwen3-asr']);
  assert.match(env(spec).VOICE_PLAN, /^Detected Test GPU 0 \(6\.0 GiB, 5\.9 GiB free\): Breeze speech with Qwen3-ASR 1\.7B on the CPU needs about 4\.5 GiB, which fits, and about 2\.9 GiB of memory on the CPU, which fits\.$/);
  assert.equal((await voice.status()).choice?.asrDevice, 'cpu');
  // The same choice on the GPU is refused: it does not fit the card.
  reset(); v.hostGpus(GPU(0, 6144, 6000));
  await voice.install({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '1.7b', asrDevice: 'gpu' });
  await settle();
  assert.match((await voice.status()).error, /needs about 7\.0 GiB of GPU memory/);
  // What the host cannot hold on the CPU is refused too.
  reset(); v.hostGpus(GPU(0, 24576, 24000)); host({ totalMiB: 2048, freeMiB: 1800 });
  await voice.install({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '1.7b', asrDevice: 'cpu' });
  await settle();
  assert.match((await voice.status()).error, /Breeze speech with Qwen3-ASR 1\.7B on the CPU needs about 2\.9 GiB of memory on the CPU, but this host has 2\.0 GiB\./);
  assert.equal(created().length, 0);
});

test('a GPU that Docker cannot hand on is told in one plain sentence, not as the daemon words it', async () => {
  // The host sees a card and Docker could not be asked (the check's image does not come): the container is made, and cannot start.
  reset(); v.hostGpus(GPU(0, 12288, 11000)); v.dockerGpus(null); daemon.images.delete(BASE); daemon.failing.set(BASE, 'no space left on device');
  await voice.install();
  await settle();
  assert.equal(created().length, 1);
  const state = await voice.status();
  assert.equal(state.error, NO_GPU_MESSAGE);
  assert.doesNotMatch(JSON.stringify(state), /could not select device driver/);
  // The card is there, so the sentence does not say that none was found.
  assert.doesNotMatch(state.error, /none was found/);
  // A container that was made and exited with Docker's own words is shown the same way.
  reset(); v.hostGpus(GPU(0, 12288, 11000));
  v.putVoice({ Labels: { 'pithagoras.addon': 'voice' }, HostConfig: { NetworkMode: 'container:portal-one' }, State: 'exited', code: 128, error: `failed to create task for container: ${NO_RUNTIME}` });
  await voice.stop();   // the install's own error is gone; what is left is what Docker says of the container
  const failed = await voice.status();
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error, NO_GPU_MESSAGE);
  // Anything else Docker says is left as it is.
  v.voice()!.error = 'port is already allocated';
  assert.equal((await voice.status()).error, 'port is already allocated');
});

test('a driver too old for the CUDA image is told as that, and the toolkit\'s other errors are left as they are', async () => {
  const requirement = 'failed to create task for container: OCI runtime create failed: runc create failed: unable to start container process: error during container init: error running hook #0: error running hook: exit status 1, stdout: , stderr: Auto-detected mode as \'legacy\'\nnvidia-container-cli: requirement error: unsatisfied condition: cuda>=12.4, please update your driver to a newer version, or use an earlier cuda container: unknown';
  reset(); v.hostGpus(GPU(0, 12288, 11000));
  v.putVoice({ Labels: { 'pithagoras.addon': 'voice' }, HostConfig: { NetworkMode: 'container:portal-one' }, State: 'exited', code: 128, error: requirement });
  await voice.stop();
  const old = await voice.status();
  assert.equal(old.error, DRIVER_TOO_OLD_MESSAGE);
  assert.match(old.error, /driver.*too old.*update the driver/);
  assert.doesNotMatch(old.error, /NVIDIA Container Toolkit|no GPU|none was found/, 'the toolkit is there; saying it is missing would send the person the wrong way');
  // Other errors of the toolkit say what is wrong in their own words.
  for (const message of ['nvidia-container-cli: mount error: failed to add device rules: unable to find any existing device filters', 'nvidia-container-cli: ldcache error: process /sbin/ldconfig failed with error code: 127']) {
    v.voice()!.error = `error running hook: ${message}`;
    assert.equal((await voice.status()).error, `error running hook: ${message}`);
  }
});

test('a host with the driver but without the toolkit has no GPU for voice: the card is said to be unusable, and Kokoro and recognition are installed on the CPU', async () => {
  // nvidia-smi on the host lists a card; Docker, asked to hand it to a container, has no runtime for it.
  reset(); v.hostGpus(GPU(0, 12288, 11000, 'Test GPU 0')); v.dockerGpus(null); daemon.images.delete(CUDA);
  const found = await voice.hardware();
  assert.deepEqual([found.gpus, found.checked, found.cpuOnly, found.selected, found.unusable], [[], true, true, null, ['Test GPU 0']]);
  assert.deepEqual(found.suggestion, { tts: 'kokoro', ttsDevice: 'cpu', asr: 'qwen3-asr', asrModel: '0.6b' });
  assert.doesNotMatch(JSON.stringify(found), /could not select device driver/);
  assert.equal(daemon.containers.some(c => c.Name === PROBE), false, 'the check\'s container is removed');
  // Left to the check, the install does not pick Breeze to fail on it: it is Kokoro and recognition on the CPU, in the small image.
  await voice.install();
  await settle();
  const state = await voice.status();
  assert.equal(state.error, '');
  assert.equal(created().length, 1);
  assert.equal(created()[0].Image, BASE);
  assert.equal('DeviceRequests' in created()[0].HostConfig, false);
  assert.deepEqual(state.choice, { tts: 'kokoro', ttsDevice: 'cpu', asr: 'qwen3-asr', asrModel: '0.6b' });
  assert.ok(!daemon.pulls.some(image => image.startsWith('nvidia')), 'no CUDA image');
  // The log says what the page says: the card is there, and it is Docker that cannot use it.
  assert.match(env(created()[0]).VOICE_PLAN, /^GPU detected: Test GPU 0, but Docker cannot use it: installing Kokoro speech on the CPU with Qwen3-ASR 0\.6B needing about 2\.8 GiB of memory on the CPU, which fits\.$/);
  // A request for speech is told what is missing: the toolkit, not a card, since the card is there.
  reset(); v.hostGpus(GPU(0, 12288, 11000)); v.dockerGpus(null);
  await voice.install({ tts: 'breeze', asr: 'whisper', asrModel: 'base' });
  await settle();
  assert.equal((await voice.status()).error, NO_GPU_FOR_SPEECH_UNUSABLE);
  assert.match(NO_GPU_FOR_SPEECH_UNUSABLE, /NVIDIA Container Toolkit/);
  assert.doesNotMatch(NO_GPU_FOR_SPEECH_UNUSABLE, /none was found/);
  // Where there is no card at all it is a GPU that is asked for.
  reset(); v.hostGpus(null); v.dockerGpus(null);
  await voice.install({ tts: 'breeze', asr: 'whisper', asrModel: 'base' });
  await settle();
  assert.equal((await voice.status()).error, NO_GPU_FOR_SPEECH);
  // Docker that cannot be asked leaves the host's word, and Docker that works confirms it.
  reset(); v.hostGpus(GPU(0, 12288, 11000)); daemon.images.delete(BASE); daemon.failing.set(BASE, 'no space left on device');
  assert.deepEqual([(await voice.hardware()).gpus.length, (await voice.hardware()).cpuOnly], [1, false]);
  reset(); v.hostGpus(GPU(0, 12288, 11000));
  const fine = await voice.hardware();
  assert.deepEqual([fine.gpus.length, fine.cpuOnly, fine.unusable], [1, false, undefined]);
  assert.equal(daemon.containers.some(c => c.Name === PROBE), false, 'the check\'s container is removed');
});

test('a container made before engines could be chosen keeps its engines through start and through a restating of the same choice', async () => {
  reset(); v.hostGpus(GPU(0, 1024, 1000));   // far too small: a restart must not be refused on that
  earlier({ 'pithagoras.voice-network': 'shared-v1' }, { NetworkMode: 'container:portal-one' });
  assert.deepEqual((await voice.status()).choice, DEFAULT_CHOICE);
  await voice.start();
  await settle();
  assert.equal(v.voice()!.State, 'running');
  await voice.install(DEFAULT_CHOICE);
  await settle();
  assert.equal(created().length, 0, 'nothing recreated');
  assert.equal((await voice.status()).error, '');
  assert.deepEqual((await voice.status()).state, 'running');
});

test('a container made before engines could be chosen, moved to a new network namespace, is recreated as the original combination, without a GPU check', async () => {
  reset(); v.hostGpus(GPU(0, 1024, 1000));   // a card the original combination would be refused on
  earlier({}, { NetworkMode: 'bridge' }, 'running');
  assert.equal((await voice.status()).state, 'installing');
  await settle();
  assert.equal((await voice.status()).error, '');
  const spec = created()[0];
  assert.equal(spec.HostConfig.NetworkMode, 'container:portal-one');
  assert.equal(spec.Labels['pithagoras.voice-recipe'], 'breeze+whisper:base');
  assert.deepEqual(spec.HostConfig.DeviceRequests, [{ Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }]);
  assert.equal('VOICE_PLAN' in env(spec), false, 'no check was made, so there is nothing to report');
  assert.equal(daemon.created.some(c => c.Name === PROBE), false);
});

test('a container recreated for a new portal namespace stays on the card it was given', async () => {
  reset(); v.hostGpus(GPU(0, 12288, 2000) + GPU(1, 12288, 12000));
  await voice.install({ tts: 'breeze', asr: 'whisper', asrModel: 'base' });
  await settle();
  assert.deepEqual(created()[0].HostConfig.DeviceRequests, [{ Driver: 'nvidia', DeviceIDs: ['1'], Capabilities: [['gpu']] }]);
  // A portal update gives the portal container a new id, and the voice container is made again for it.
  // The card it has is looked up, as it may be gone, but the engines are not judged against it again: with card 1 read as too small for them they are kept.
  v.hostGpus(GPU(0, 12288, 2000) + GPU(1, 2048, 1500));
  v.portalIs('portal-two'); daemon.created.length = 0;
  assert.equal((await voice.status()).state, 'installing');
  await settle();
  assert.equal(created()[0].HostConfig.NetworkMode, 'container:portal-two');
  assert.deepEqual(created()[0].HostConfig.DeviceRequests, [{ Driver: 'nvidia', DeviceIDs: ['1'], Capabilities: [['gpu']] }]);
  assert.equal(created()[0].Labels['pithagoras.voice-recipe'], 'breeze+whisper:base');
  assert.equal((await voice.status()).error, '', 'a kept choice is not checked again');
});

test('VOICE_GPU decides the card of a recreated container, and of one installed without a GPU reading', async () => {
  reset(); v.hostGpus(GPU(0, 12288, 12000) + GPU(1, 12288, 3000));
  earlier({}, { NetworkMode: 'bridge' }, 'running');
  process.env.VOICE_GPU = '1';
  assert.equal((await voice.status()).state, 'installing');
  await settle();
  assert.deepEqual(created()[0].HostConfig.DeviceRequests, [{ Driver: 'nvidia', DeviceIDs: ['1'], Capabilities: [['gpu']] }]);
  reset(); v.hostGpus(null); daemon.images.delete(BASE); daemon.failing.set(BASE, 'no space left on device');
  process.env.VOICE_GPU = '1';
  await voice.install({ tts: 'chatterbox', asr: 'whisper', asrModel: 'base' });
  await settle();
  assert.deepEqual(created()[0].HostConfig.DeviceRequests, [{ Driver: 'nvidia', DeviceIDs: ['1'], Capabilities: [['gpu']] }]);
});

test('a VOICE_GPU that no card has is ignored when the cards can be read, at install and at recreation alike', async () => {
  reset(); v.hostGpus(GPU(0, 12288, 2000) + GPU(1, 12288, 12000));
  process.env.VOICE_GPU = '2';
  await voice.install({ tts: 'breeze', asr: 'whisper', asrModel: 'base' });
  await settle();
  const card = (spec: any) => spec.HostConfig.DeviceRequests[0];
  assert.deepEqual(card(created()[0]).DeviceIDs, ['1'], 'the card with the most room');
  // A portal update: the container is made again, on the card it has, not on one that is not there.
  v.portalIs('portal-two'); daemon.created.length = 0;
  assert.equal((await voice.status()).state, 'installing');
  await settle();
  assert.deepEqual(card(created()[0]).DeviceIDs, ['1']);
  assert.equal((await voice.status()).error, '');
  // One card, and a setting that names a second: Docker's own pick, as an install makes it.
  reset(); v.hostGpus(GPU(0, 12288, 12000));
  earlier({}, { NetworkMode: 'bridge' }, 'running');
  process.env.VOICE_GPU = '1';
  assert.equal((await voice.status()).state, 'installing');
  await settle();
  assert.deepEqual(card(created()[0]), { Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] });
});

test('Start moves a container to the card VOICE_GPU names, and leaves one that is on it alone', async () => {
  const stopped = (devices: any) => earlier({ 'pithagoras.voice-network': 'shared-v1', 'pithagoras.voice-recipe': 'breeze+whisper:base' }, { NetworkMode: 'container:portal-one', DeviceRequests: [devices] });
  const cards = GPU(0, 12288, 12000) + GPU(1, 12288, 12000);
  reset(); v.hostGpus(cards);
  stopped({ Driver: 'nvidia', DeviceIDs: ['0'], Capabilities: [['gpu']] });
  process.env.VOICE_GPU = '1';
  await voice.start();
  await settle();
  assert.deepEqual(created()[0].HostConfig.DeviceRequests[0].DeviceIDs, ['1']);
  assert.equal(v.voice()!.Labels['pithagoras.voice-recipe'], 'breeze+whisper:base');
  // Already there: started as it is. So is one that asked Docker for any one GPU, which is the first.
  for (const [devices, asked] of [[{ Driver: 'nvidia', DeviceIDs: ['1'], Capabilities: [['gpu']] }, '1'], [{ Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }, '0']] as const) {
    reset(); v.hostGpus(cards);
    stopped(devices);
    process.env.VOICE_GPU = asked;
    await voice.start();
    await settle();
    assert.equal(created().length, 0, `on card ${asked} already`);
    assert.equal(v.voice()!.State, 'running');
  }
  // No setting: whatever card it has is kept.
  reset(); v.hostGpus(cards);
  stopped({ Driver: 'nvidia', DeviceIDs: ['1'], Capabilities: [['gpu']] });
  await voice.start();
  await settle();
  assert.equal(created().length, 0);
});

test('the page is told the card the installed service is on, not the one with the most room', async () => {
  const cards = GPU(0, 6144, 6000) + GPU(1, 12288, 5000);
  reset(); v.hostGpus(cards);
  assert.equal((await voice.hardware()).selected, 0, 'nothing installed: the card with the most room');
  earlier({ 'pithagoras.voice-recipe': 'breeze+qwen3-asr:1.7b' }, { DeviceRequests: [{ Driver: 'nvidia', DeviceIDs: ['1'], Capabilities: [['gpu']] }] }, 'running');
  assert.equal((await voice.hardware()).selected, 1, 'the service holds memory there, which is why it has less free');
  // One made before the card was chosen has Docker's first.
  earlier({}, { DeviceRequests: [{ Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }] }, 'running');
  v.hostGpus(GPU(0, 6144, 1000) + GPU(1, 12288, 12000));
  assert.equal((await voice.hardware()).selected, 0);
  v.dropVoice();
  process.env.VOICE_GPU = '0';
  assert.equal((await voice.hardware()).selected, 0, 'VOICE_GPU for a first install');
});

test('a rebuild takes its own reading of the GPUs after the stop, not that of a check of the page which began before it', async () => {
  // Two cards: the service runs on card 0, which looks full while it holds its memory (5000 MiB free) and has 12000 once it is stopped; card 1 has 9000.
  const setup = () => {
    reset(); v.hostGpus(GPU(0, 12288, 5000) + GPU(1, 12288, 9000));
    earlier({ 'pithagoras.voice-network': 'shared-v1', 'pithagoras.voice-recipe': 'breeze+whisper:base' }, { NetworkMode: 'container:portal-one', DeviceRequests: [{ Driver: 'nvidia', DeviceIDs: ['0'], Capabilities: [['gpu']] }] }, 'running');
    daemon.runs.onStop = (c) => { if (c.Name === CONTAINER) v.hostGpus(GPU(0, 12288, 12000) + GPU(1, 12288, 9000)); };
  };
  // Alone: the card the service is on.
  setup();
  await voice.install({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' });
  await settle();
  assert.deepEqual(created()[0].HostConfig.DeviceRequests[0].DeviceIDs, ['0']);
  // While the page's check is still running, slowly (its image is on its way), with readings taken when the service still held its memory.
  setup(); daemon.images.delete(BASE);
  let release!: () => void;
  daemon.hold.pull = new Promise<void>(resolve => { release = resolve; });
  const page = voice.hardware();
  await new Promise(r => setTimeout(r, 50));
  await voice.install({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' });
  await new Promise(r => setTimeout(r, 50));
  release();
  await page;
  await settle();
  assert.deepEqual(created()[0].HostConfig.DeviceRequests[0].DeviceIDs, ['0'], 'the service stays on its card: it is the one with room once it is stopped');
  assert.match(env(created()[0]).VOICE_PLAN, /^Detected Test GPU 0 \(12\.0 GiB, 11\.7 GiB free\)/);
  // The page's own check is not made to wait for ever, and a failed one does not stop the install.
  setup(); daemon.images.delete(BASE); daemon.failing.set(BASE, 'no space left on device');
  const failing = voice.hardware();
  await new Promise(r => setTimeout(r, 10));
  await voice.install({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' });
  await failing;
  await settle();
  assert.equal(created().length, 1);
});

test('a rebuild reads the GPU after the running service is stopped, and starts it again when the choice is refused', async () => {
  const running = () => earlier({ 'pithagoras.voice-network': 'shared-v1', 'pithagoras.voice-recipe': 'breeze+whisper:base' }, { NetworkMode: 'container:portal-one' }, 'running');
  // The containers made by the time the service was stopped: the check's has to come after.
  let madeAtStop = -1;
  const watchStop = () => { madeAtStop = -1; daemon.runs.onStop = (c) => { if (c.Name === CONTAINER) madeAtStop = daemon.created.length; }; };
  reset(); v.hostGpus(null); v.dockerGpus(GPU(0, 6144, 6000));
  running(); watchStop();
  await voice.install({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '1.7b' });
  await settle();
  const probeAt = () => daemon.created.findIndex(c => c.Name === PROBE);
  assert.ok(madeAtStop >= 0 && madeAtStop <= probeAt(), 'its own memory is not counted as taken by others');
  assert.match((await voice.status()).error, /needs about 7\.0 GiB/);
  assert.equal(v.voice()!.State, 'running', 'the refusal leaves the service running');
  assert.equal(created().length, 0);
  assert.equal(voiceStarts(), 1);
  // A choice that fits is stopped once, checked, and replaced.
  daemon.created.length = 0; daemon.starts.length = 0;
  let stops = 0;
  running(); watchStop();
  const onStop = daemon.runs.onStop!;
  daemon.runs.onStop = (c) => { if (c.Name === CONTAINER) stops++; onStop(c); };
  await voice.install({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' });
  await settle();
  assert.equal(stops, 1);
  assert.ok(madeAtStop >= 0 && madeAtStop <= probeAt());
  assert.equal(created()[0].Labels['pithagoras.voice-recipe'], 'breeze+qwen3-asr:0.6b');
});

test('another choice recreates the container, keeps the volume and is not mistaken for a network change', async () => {
  reset(); v.hostGpus(GPU(0, 12288, 11000));
  earlier({ 'pithagoras.voice-network': 'shared-v1' }, { NetworkMode: 'container:portal-one' }, 'running');
  daemon.volumes.push({ Name: 'pithagoras_voice-models', Labels: null });
  const old = v.voice()!.Id;
  let stops = 0;
  daemon.runs.onStop = (c) => { if (c.Name === CONTAINER) stops++; };
  await voice.install({ tts: 'chatterbox', asr: 'qwen3-asr', asrModel: '1.7b' });
  await settle();
  assert.ok(GONE(old));
  assert.ok(stops >= 1);
  assert.deepEqual(daemon.volumes.map(volume => volume.Name), ['pithagoras_voice-models'], 'the downloads are kept');
  assert.deepEqual(created()[0].HostConfig.Binds, ['pithagoras_voice-models:/voice']);
  assert.equal(v.voice()!.Labels['pithagoras.voice-recipe'], 'chatterbox+qwen3-asr:1.7b');
  // Start now keeps what was built.
  daemon.created.length = 0;
  await voice.start();
  await settle();
  assert.equal(created().length, 0);
  assert.equal(v.voice()!.Labels['pithagoras.voice-recipe'], 'chatterbox+qwen3-asr:1.7b');
});

test('a request for an engine the installer does not make is refused before anything happens', async () => {
  reset(); v.hostGpus(GPU(0, 12288, 11000));
  await assert.rejects(voice.install({ tts: 'piper', asr: 'whisper', asrModel: 'base' } as any), /speech synthesis engine/);
  await assert.rejects(voice.install({ tts: 'breeze', asr: 'whisper', asrModel: '1.7b' }), /speech recognition model/);
  assert.equal((await voice.status()).busy, false, 'the refusal does not leave a setup running');
  assert.deepEqual(daemon.created, []);
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

test('the speech model loaded and let go of is the one the engine speaks with', async () => {
  reset();
  await voice.modelAction('load');
  await voice.modelAction('unload');
  await voice.modelAction('load', 'chatterbox');
  await voice.modelAction('unload', 'chatterbox');
  await voice.modelAction('load', 'kokoro');
  const sent = v.voiceProcesses.models;
  assert.deepEqual(sent.map(s => s.url).slice(0, 4), Array(4).fill('http://127.0.0.1:7862/v1/models/load').map((u, i) => u.replace('load', i % 2 ? 'unload' : 'load')));
  // The load request Breeze has always had, byte for byte.
  assert.deepEqual(sent[0].body, { id: 'breeze', family: 'breeze_tts', path: '/voice/models/breeze-q8_0.gguf', task: 'tts', mode: 'streaming', session_options: { 'breeze_tts.reference_cache_slots': '1' } });
  assert.deepEqual(sent[1].body, { id: 'breeze' });
  assert.equal((sent[2].body as any).id, 'chatterbox');
  assert.equal((sent[2].body as any).path, '/voice/models/chatterbox-q8_0.gguf');
  assert.deepEqual(sent[3].body, { id: 'chatterbox' });
  assert.deepEqual(sent[4].body, { id: 'kokoro', family: 'kokoro_tts', path: '/voice/models/kokoro-82m-q8_0.gguf', task: 'tts', mode: 'offline' });
});

test('the setup shows what the daemon says of an image on its way, and starts the container once it is there', async () => {
  // Made by an older install, with the image gone: a start downloads it again, and keeps what the container has.
  reset(); v.hostGpus(GPU(0, 12288, 11000));
  earlier({ 'pithagoras.voice-network': 'shared-v1' }, { NetworkMode: 'container:portal-one' });
  daemon.images.delete(CUDA);
  let release!: () => void;
  daemon.hold.pull = new Promise<void>(resolve => { release = resolve; });
  const said: string[] = [];
  try {
    await voice.start();
    for (let n = 0; n < 300 && !said.includes('Downloading [=====>   ] 5MB/10MB'); n++) {
      said.push((await voice.status()).progress);
      await new Promise(r => setTimeout(r, 10));
    }
    const shown = await voice.status();
    assert.deepEqual([shown.busy, shown.progress], [true, 'Downloading [=====>   ] 5MB/10MB']);
    // What Docker says before its first line is not shown over what the page said.
    assert.equal(said.includes('starting'), false);
  } finally { release(); }
  await settle();
  assert.equal((await voice.status()).error, '');
  assert.equal(v.voice()!.State, 'running');
  assert.deepEqual(daemon.pulls, [CUDA]);
});

test('a download that fails ends the setup with what Docker said', async () => {
  reset(); v.hostGpus(GPU(0, 12288, 11000));
  earlier({ 'pithagoras.voice-network': 'shared-v1' }, { NetworkMode: 'container:portal-one' });
  daemon.images.delete(CUDA);
  daemon.failing.set(CUDA, 'toomanyrequests: rate limit');
  await voice.start();
  await settle();
  assert.match((await voice.status()).error, /rate limit/);
  assert.equal(v.voice()!.State, 'exited');
});

test('a container removed while it is looked at, as a setup that makes it again removes it, is shown without its log, not as a failure', async () => {
  reset(); v.hostGpus(GPU(0, 12288, 11000));
  earlier({ 'pithagoras.voice-network': 'shared-v1' }, { NetworkMode: 'container:portal-one' });
  const logs = v.docker.containers.logs;
  // Gone between the look at how it stands and the read of what it wrote: Docker says there is no such container.
  v.docker.containers.logs = async () => { v.dropVoice(); throw Object.assign(new Error('There is no container pithagoras-voice'), { status: 404 }); };
  try {
    const now = await voice.status();
    assert.deepEqual([now.state, now.progress], ['stopped', '']);
  } finally { v.docker.containers.logs = logs; }
  assert.equal((await voice.status()).state, 'absent');
});

test('a container removed before it is taken over, as a setup that makes it again removes it, is no container, not a failure', async () => {
  reset(); v.hostGpus(GPU(0, 12288, 11000));
  earlier({ 'pithagoras.voice-network': 'shared-v1' }, { NetworkMode: 'container:portal-one' });
  const get = v.docker.containers.get;
  // Gone between the look at whose it is and taking it over: Docker says there is no such container.
  v.docker.containers.get = async (name) => { const found = await get(name); v.dropVoice(); return found; };
  try {
    assert.equal((await voice.status()).state, 'absent');
  } finally { v.docker.containers.get = get; }
});
