import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import { fakeDocker } from "./fake-docker.mts";
import { inProcessHome } from "./helpers.mts";

// Choosing the GPU for the managed voice: the card chosen on the page (by UUID) and `VOICE_GPU` (by index) are the
// two ways to ask for one, and both go through the one GPU check, the engine choice and the container that the
// managed service already has. A fake Docker daemon stands in for the host: no GPU and no container is touched.
const dir = inProcessHome('voice-gpu-');
process.env.DOCKER_SOCKET = path.join(dir, 'docker.sock');
process.env.PORTAL_CONTAINER_NAME = 'portal-test';
// No nvidia-smi on the portal's host: the cards are read in a throwaway container, as a portal in a container does.
process.env.NVIDIA_SMI = path.join(dir, 'no-such-nvidia-smi');
delete process.env.VOICE_GPU;
delete process.env.VOICE_VRAM_RESERVE_MIB;

const A = 'GPU-aaaa-0000', B = 'GPU-bbbb-1111';
// Card 0 holds the session model and has little free; card 1 is the one with the most room.
const SMI = `0, ${A}, NVIDIA GeForce RTX 3060, 12288, 4427\n1, ${B}, NVIDIA GeForce RTX 3060, 12288, 12159\n`;
const BASE = 'ubuntu:22.04';

let container: any = null;
// What nvidia-smi inside the image prints.
let reading = SMI;
const docker = await fakeDocker(process.env.DOCKER_SOCKET!, ({ method, url, path: p, body }) => {
  if (url === '/containers/portal-test/json') return { json: { Id: 'portal-one', State: { Running: true } } };
  if (url === '/containers/pithagoras-voice/json') return { status: container ? 200 : 404, json: container };
  if (url.startsWith('/containers/pithagoras-voice/logs')) return { json: 'services ready' };
  if (url.startsWith('/images/')) return {};
  if (url === '/volumes/create') return {};
  // The throwaway container that reads nvidia-smi inside the image.
  if (url === '/containers/create') return { json: { Id: 'probe-1' } };
  if (url === '/containers/probe-1/start') return {};
  if (url === '/containers/probe-1/wait') return { json: { StatusCode: 0 } };
  if (url.startsWith('/containers/probe-1/logs')) return { json: reading };
  if (method === 'DELETE' && p === '/containers/probe-1') return {};
  if (method === 'POST' && p === '/containers/pithagoras-voice/stop') { container.State.Running = false; return {}; }
  if (method === 'DELETE' && p === '/containers/pithagoras-voice') { container = null; return {}; }
  if (method === 'POST' && url.startsWith('/containers/create?name=pithagoras-voice')) { container = { Config: body, HostConfig: body.HostConfig, State: { Running: false } }; return {}; }
  if (method === 'POST' && url === '/containers/pithagoras-voice/start') { container.State.Running = true; return {}; }
  return undefined;
});
const { calls } = docker;
const oldFetch = globalThis.fetch;
// The voice processes answer their health checks.
globalThis.fetch = (async () => new Response('{}')) as typeof fetch;
after(() => { globalThis.fetch = oldFetch; });
const voice = await import('../core/server/src/extensions/voice-service.js');
const { parseGpus, askedCard, holds, deviceId, cardOf } = await import('../core/server/src/voice-gpu.js');
voice.hostReader.read = () => ({ totalMiB: 16384, freeMiB: 12000, threads: 8 });

const reset = () => { container = null; reading = SMI; docker.reset(); voice.useGpu(''); delete process.env.VOICE_GPU; };
const settle = async () => { for (let n = 0; n < 200 && (await voice.status()).busy; n++) await new Promise(r => setTimeout(r, 10)); };
const created = () => calls.filter(c => c.url === '/containers/create?name=pithagoras-voice');
const cardOfCreated = () => created()[0].body.HostConfig.DeviceRequests[0];
/** The voice container was deleted, not the throwaway one that reads nvidia-smi, and the models volume was not touched. */
const gone = () => calls.some(c => c.method === 'DELETE' && c.url === '/containers/pithagoras-voice?force=true');
const volumeKept = () => !calls.some(c => c.method === 'DELETE' && c.url.startsWith('/volumes'));
/** A managed container of the default engines, as an earlier portal made it: on a card by index, or on Docker's own pick without one. */
const made = (devices: any, running = false, recipe = 'breeze+whisper:base') => ({ Config: { Labels: { 'pithagoras.addon': 'voice', 'pithagoras.voice-network': 'shared-v1', 'pithagoras.voice-recipe': recipe } },
  HostConfig: { NetworkMode: 'container:portal-one', ...(devices ? { DeviceRequests: [devices] } : {}) }, State: { Running: running } });
const byIndex = (index: number) => ({ Driver: 'nvidia', DeviceIDs: [String(index)], Capabilities: [['gpu']] });
const anyGpu = { Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] };
const DEFAULTS = { tts: 'breeze', asr: 'whisper', asrModel: 'base' } as const;

test('nvidia-smi rows become GPUs with their UUID, a reading without one still lists the card, and anything else is skipped', () => {
  assert.deepEqual(parseGpus(SMI + 'Failed to initialize NVML\n'), [
    { index: 0, uuid: A, name: 'NVIDIA GeForce RTX 3060', totalMiB: 12288, freeMiB: 4427 },
    { index: 1, uuid: B, name: 'NVIDIA GeForce RTX 3060', totalMiB: 12288, freeMiB: 12159 },
  ]);
  // A name with a comma keeps it, with the UUID in front.
  assert.deepEqual(parseGpus(`0, ${A}, Test GPU, Rev 2, 4096, 100\n`), [{ index: 0, uuid: A, name: 'Test GPU, Rev 2', totalMiB: 4096, freeMiB: 100 }]);
  assert.deepEqual(parseGpus('0, Test GPU, 4096, 100\n'), [{ index: 0, name: 'Test GPU', totalMiB: 4096, freeMiB: 100 }]);
  assert.deepEqual(parseGpus(''), []);
});

test('a card is asked for by the choice on the page first, then by VOICE_GPU, and only one that is there', () => {
  const gpus = parseGpus(SMI);
  assert.equal(askedCard(gpus, B, 0)?.index, 1, 'the choice on the page wins over VOICE_GPU');
  assert.equal(askedCard(gpus, '', 0)?.index, 0, 'VOICE_GPU where nothing is chosen');
  assert.equal(askedCard(gpus, 'GPU-gone', 0)?.index, 0, 'a choice that is no longer there is not one');
  assert.equal(askedCard(gpus, 'GPU-gone', 7), undefined, 'neither is there: the automatic pick stays');
  assert.equal(askedCard(gpus, '', undefined), undefined);
  // Where the cards could not be read, what was asked for is taken as it is, and Docker has the last word.
  assert.deepEqual(askedCard([], B, 0), { uuid: B });
  assert.deepEqual(askedCard([], '', 3), { index: 3 });
  assert.equal(askedCard([], '', undefined), undefined);
});

test('a container is told its card by UUID where it is known, and a card is held by whichever of UUID and index both name', () => {
  const [a, b] = parseGpus(SMI);
  assert.equal(deviceId(b), B);
  assert.equal(deviceId({ index: 1 }), '1');
  assert.deepEqual([cardOf('1'), cardOf(B)], [{ index: 1 }, { uuid: B }]);
  // A container made before UUIDs were used names its card by index; one made later by UUID. Neither is made again for the other.
  assert.equal(holds(cardOf('1'), b), true);
  assert.equal(holds(cardOf(B), b), true);
  assert.equal(holds(cardOf('1'), a), false);
  assert.equal(holds(cardOf(B), a), false);
  // One that asked Docker for any one GPU has the first.
  assert.deepEqual([holds(undefined, a), holds(undefined, b)], [true, false]);
});

test('the container asks for any one GPU until one is chosen, then for that card, and for none where nothing runs on the GPU', () => {
  const [, b] = parseGpus(SMI);
  assert.deepEqual(voice.containerSpec('true', 'host').HostConfig.DeviceRequests, [anyGpu]);
  assert.deepEqual(voice.containerSpec('true', 'host', undefined, { card: b }).HostConfig.DeviceRequests, [{ Driver: 'nvidia', DeviceIDs: [B], Capabilities: [['gpu']] }]);
  assert.deepEqual(voice.containerSpec('true', 'host', undefined, { card: { index: 1 } }).HostConfig.DeviceRequests, [byIndex(1)]);
  assert.equal(voice.containerSpec('true', 'host', { tts: 'none', asr: 'whisper', asrModel: 'base' }, { card: b }).HostConfig.DeviceRequests, undefined);
});

test('one check lists the cards with their UUID, and the page is told the choice and the card in use', async () => {
  reset();
  const found = await voice.hardware();
  assert.deepEqual(found.gpus.map(g => [g.index, g.uuid]), [[0, A], [1, B]]);
  assert.equal(found.source, 'docker');
  const probe = calls.find(c => c.url === '/containers/create')!.body;
  assert.equal(probe.Image, BASE, 'the small image, not the CUDA one');
  assert.match(probe.Cmd.join(' '), /--query-gpu=index,uuid,name,/);
  assert.ok(calls.some(c => c.method === 'DELETE' && c.url.startsWith('/containers/probe-1')), 'the probe container is removed again');
  assert.deepEqual([found.chosen, found.selected], ['', 1], 'automatic: the card with the most room');
  voice.useGpu(A);
  const chosen = await voice.hardware();
  assert.deepEqual([chosen.chosen, chosen.selected], [A, 0]);
  // What is suggested is for the card in use: card 0 has a third of card 1's room.
  assert.notDeepEqual(chosen.suggestion, found.suggestion);
  // A choice for a card that is not on the host is no choice: nothing is shown as chosen, and the automatic pick is used.
  voice.useGpu('GPU-gone');
  const gone = await voice.hardware();
  assert.deepEqual([gone.chosen, gone.selected], ['', 1]);
  await voice.checkGpu(A);
  await assert.rejects(voice.checkGpu('GPU-gone'), /That GPU is not on this host/);
});

test('the engine check judges the chosen card, and the container is made for it', async () => {
  reset();
  voice.useGpu(A);
  await voice.install(DEFAULTS);
  await settle();
  assert.equal((await voice.status()).error, '');
  assert.deepEqual(cardOfCreated(), { Driver: 'nvidia', DeviceIDs: [A], Capabilities: [['gpu']] });
  assert.equal(created()[0].body.Labels['pithagoras.voice-recipe'], 'breeze+whisper:base');
  assert.match(created()[0].body.Env.find((e: string) => e.startsWith('VOICE_PLAN='))!, /Detected NVIDIA GeForce RTX 3060 \(12\.0 GiB, 4\.3 GiB free\)/, 'the setup log names the card it checked');
  // Without a choice it is the card with the most room, named by UUID too.
  reset();
  await voice.install(DEFAULTS);
  await settle();
  assert.deepEqual(cardOfCreated().DeviceIDs, [B]);
  // What fits is judged on the card that was chosen and not on the one with the most room.
  reset();
  await voice.install();
  await settle();
  const roomy = created()[0].body.Labels['pithagoras.voice-recipe'];
  reset();
  voice.useGpu(A);
  await voice.install();
  await settle();
  assert.deepEqual(cardOfCreated().DeviceIDs, [A]);
  assert.notEqual(created()[0].body.Labels['pithagoras.voice-recipe'], roomy);
});

test('the choice on the page wins over VOICE_GPU, and automatic hands the card back to it', async () => {
  reset();
  process.env.VOICE_GPU = '0';
  voice.useGpu(B);
  await voice.install(DEFAULTS);
  await settle();
  assert.deepEqual(cardOfCreated().DeviceIDs, [B]);
  assert.equal((await voice.hardware()).selected, 1);
  voice.useGpu('');
  assert.equal((await voice.hardware()).selected, 0, 'VOICE_GPU again');
  reset();
  process.env.VOICE_GPU = '0';
  await voice.install(DEFAULTS);
  await settle();
  assert.deepEqual(cardOfCreated().DeviceIDs, [A], 'VOICE_GPU names the card by its UUID too');
});

test('a new choice recreates a service on another card with its engines and models, and the same choice only starts it', async () => {
  reset();
  // Made by a portal that named its card by index: card 1.
  container = made(byIndex(1), true);
  voice.useGpu(B);
  await voice.install();
  await settle();
  assert.equal(gone() || created().length > 0, false, 'card 1 is the one it is on, however it was named');
  // Another card: recreated, with the engines it has and the volume kept.
  voice.useGpu(A);
  await voice.install();
  await settle();
  assert.deepEqual(cardOfCreated(), { Driver: 'nvidia', DeviceIDs: [A], Capabilities: [['gpu']] });
  assert.equal(container.Config.Labels['pithagoras.voice-recipe'], 'breeze+whisper:base');
  assert.ok(gone() && volumeKept());
  assert.equal(container.State.Running, true);
  // Chosen again: what is there is started as it is.
  docker.reset();
  await voice.install();
  await settle();
  assert.equal(gone() || created().length > 0, false);
  // Automatic, with no VOICE_GPU, leaves it on the card it has.
  voice.useGpu('');
  await voice.install();
  await settle();
  assert.equal(gone() || created().length > 0, false);
  assert.deepEqual(container.HostConfig.DeviceRequests[0].DeviceIDs, [A]);
});

test('a stopped service moves on its next start, one that asked Docker for any GPU is on the first, and a choice that is gone moves nothing', async () => {
  reset();
  container = made(anyGpu);
  voice.useGpu(A);
  await voice.start();
  await settle();
  assert.equal(gone() || created().length > 0, false, 'Docker\'s any one GPU is the first, which is card 0');
  reset();
  container = made(anyGpu);
  voice.useGpu(B);
  await voice.start();
  await settle();
  assert.deepEqual(cardOfCreated().DeviceIDs, [B]);
  assert.equal(container.Config.Labels['pithagoras.voice-recipe'], 'breeze+whisper:base', 'the default engines, as every earlier installation has');
  // A card that was taken out: the service is not moved to something that is not there.
  reset();
  container = made(byIndex(0));
  voice.useGpu('GPU-gone');
  await voice.start();
  await settle();
  assert.equal(gone() || created().length > 0, false);
  assert.equal((await voice.status()).error, '');
});

test('a card that cannot hold the engines installed is refused, and the service stays where it is', async () => {
  // Card 0 has 6 GiB: room for Breeze with Whisper, not for Breeze with the large Qwen3-ASR model that runs on card 1.
  const small = `0, ${A}, Small GPU, 6144, 6000\n1, ${B}, NVIDIA GeForce RTX 3060, 12288, 12159\n`;
  reset();
  reading = small;
  container = made(byIndex(1), true, 'breeze+qwen3-asr:1.7b');
  await assert.rejects(voice.checkGpu(A), /Breeze speech with Qwen3-ASR 1\.7B needs about 7\.0 GiB of GPU memory, but Small GPU \(6\.0 GiB, 5\.9 GiB free\) has less\. Breeze speech with Qwen3-ASR 0\.6B would fit\./);
  await voice.checkGpu(B);
  // The same, where it is Start that moves it: by a choice saved earlier, or by VOICE_GPU. It goes on running, and says why.
  for (const ask of [() => voice.useGpu(A), () => { process.env.VOICE_GPU = '0'; }]) {
    reset();
    reading = small;
    container = made(byIndex(1), true, 'breeze+qwen3-asr:1.7b');
    ask();
    await voice.start();
    await settle();
    assert.match((await voice.status()).error, /needs about 7\.0 GiB of GPU memory, but Small GPU/);
    assert.equal(gone() || created().length > 0, false);
    assert.equal(container.State.Running, true);
  }
  // Engines that fit move: Breeze with Whisper is 4.5 GiB.
  reset();
  reading = small;
  container = made(byIndex(1), true);
  voice.useGpu(A);
  await voice.start();
  await settle();
  assert.equal((await voice.status()).error, '');
  assert.deepEqual(cardOfCreated().DeviceIDs, [A]);
});

test('a service pinned to a card that was taken out is made again on one that is there', async () => {
  const gonePin = { Driver: 'nvidia', DeviceIDs: ['GPU-replaced-9999'], Capabilities: [['gpu']] };
  reset();
  container = made(gonePin);
  await voice.start();
  await settle();
  assert.equal((await voice.status()).error, '');
  assert.deepEqual(cardOfCreated().DeviceIDs, [B], 'the card with the most room, as an install takes it');
  assert.equal(container.Config.Labels['pithagoras.voice-recipe'], 'breeze+whisper:base');
  assert.ok(gone() && volumeKept());
  // One card left, pinned by an index that is no longer there too: it is pinned to the card that is.
  reset();
  reading = `0, ${A}, NVIDIA GeForce RTX 3060, 12288, 12159\n`;
  container = made(byIndex(1));
  await voice.start();
  await settle();
  assert.deepEqual(cardOfCreated().DeviceIDs, [A]);
  // The card that is there cannot hold the engines: it is refused as an install is, and the service is left as it is.
  reset();
  reading = `0, ${A}, Tiny GPU, 2048, 2000\n`;
  container = made(gonePin);
  await voice.start();
  await settle();
  assert.match((await voice.status()).error, /Breeze speech with Whisper base needs about 4\.5 GiB of GPU memory, but Tiny GPU/);
  assert.equal(gone() || created().length > 0, false);
  // A card that is still there is no reason to move: it is started as it is.
  reset();
  container = made({ Driver: 'nvidia', DeviceIDs: [B], Capabilities: [['gpu']] });
  await voice.start();
  await settle();
  assert.equal(gone() || created().length > 0, false);
});

test('PUT /api/voice/gpu is how a card is chosen: it stores the UUID, moves a running service, and refuses a card that is not there', async () => {
  reset();
  const { voiceRouter } = await import('../core/server/src/api/voice.js');
  const { getDb } = await import('../core/server/src/db.js');
  const app = express(); app.use(express.json()); app.use('/api', voiceRouter());
  const api = app.listen(0, '127.0.0.1'); await new Promise<void>(r => api.once('listening', r));
  const base = `http://127.0.0.1:${(api.address() as any).port}/api`;
  const put = (gpu: unknown) => oldFetch(`${base}/voice/gpu`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gpu }) });
  const stored = () => (getDb().prepare("SELECT value FROM settings WHERE key = 'voice_gpu'").get() as any)?.value;
  const chosen = async () => (await oldFetch(`${base}/voice/hardware`).then(r => r.json())).chosen;
  try {
    assert.equal((await put(7)).status, 400);
    const unknown = await put('GPU-gone');
    assert.deepEqual([unknown.status, (await unknown.json()).error], [400, 'That GPU is not on this host']);
    assert.equal(stored(), undefined);
    // A card that cannot hold the engines installed is refused before anything is saved or stopped.
    reading = `0, ${A}, Small GPU, 6144, 6000\n1, ${B}, NVIDIA GeForce RTX 3060, 12288, 12159\n`;
    container = made(byIndex(1), true, 'breeze+qwen3-asr:1.7b');
    const large = await put(A);
    assert.equal(large.status, 400);
    assert.match((await large.json()).error, /needs about 7\.0 GiB of GPU memory, but Small GPU/);
    assert.equal(stored(), undefined);
    assert.equal(gone() || created().length > 0, false);
    reading = SMI;
    // Stopped: saved, and used from the next start.
    container = made(byIndex(0));
    let answer = await put(B);
    assert.deepEqual([answer.status, await answer.json()], [200, { selected: B, restarting: false }]);
    assert.equal(stored(), B);
    assert.equal(gone(), false);
    assert.equal(await chosen(), B);
    await voice.start();
    await settle();
    assert.deepEqual(cardOfCreated().DeviceIDs, [B]);
    // Running: moved at once, with the models kept.
    docker.reset();
    container.State.Running = true;
    answer = await put(A);
    assert.deepEqual([answer.status, await answer.json()], [200, { selected: A, restarting: true }]);
    await settle();
    assert.deepEqual(container.HostConfig.DeviceRequests[0].DeviceIDs, [A]);
    assert.ok(gone() && volumeKept());
    // Automatic clears the choice.
    answer = await put('');
    assert.deepEqual([answer.status, await answer.json()], [200, { selected: '', restarting: true }]);
    await settle();
    assert.equal(stored(), undefined);
    assert.equal(await chosen(), '');
  } finally { await new Promise<void>(r => api.close(() => r())); getDb().close(); }
});
