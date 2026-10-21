import test from 'node:test';
import assert from 'node:assert/strict';
import { putSettings } from '../src/server/store.ts';
import { BASE, PROBE, voiceService } from './service.mts';

// Choosing the GPU for the voice service: the card chosen on the page (by UUID, `gpu` in Voice's settings) and
// `VOICE_GPU` (by index) are the two ways to ask for one, and both go through the one GPU check, the engine choice and
// the container that the service already has. Docker's fake daemon stands in for the host: no GPU and no container is touched.
const v = await voiceService();
const { service: voice, daemon } = v;
const { parseGpus, askedCard, holds, deviceId, cardOf } = await import('../src/server/gpu.ts');

const A = 'GPU-aaaa-0000', B = 'GPU-bbbb-1111';
// Card 0 holds the session model and has little free; card 1 is the one with the most room.
const SMI = `0, ${A}, NVIDIA GeForce RTX 3060, 12288, 4427\n1, ${B}, NVIDIA GeForce RTX 3060, 12288, 12159\n`;

/** No nvidia-smi on the portal's host: the cards are read in a short-lived container, as a portal in a container does. */
const reset = () => { v.reset(); v.hostGpus(null); v.dockerGpus(SMI); };
const reading = (smi: string) => v.dockerGpus(smi);
const useGpu = (gpu: string) => putSettings({ gpu });
const settle = () => v.settle();
const created = () => v.made().map(c => c.made as any);
const cardOfCreated = () => created()[0].HostConfig.DeviceRequests[0];
/** Nothing was made again: the voice container is the one there was. */
const kept = () => created().length === 0;
const volumeKept = () => daemon.volumes.some(volume => volume.Name === 'pithagoras_voice-models');
/** A voice container of the default engines, as an earlier portal made it: on a card by index, or on Docker's own pick without one. */
const made = (devices: any, running = false, recipe = 'breeze+whisper:base') => {
  v.putVoice({ Labels: { 'pithagoras.addon': 'voice', 'pithagoras.voice-network': 'shared-v1', 'pithagoras.voice-recipe': recipe },
    HostConfig: { NetworkMode: 'container:portal-one', ...(devices ? { DeviceRequests: [devices] } : {}) }, State: running ? 'running' : 'exited' });
  daemon.volumes.push({ Name: 'pithagoras_voice-models', Labels: null });
};
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
  const probe = daemon.created.find(c => c.Name === PROBE)!.made as any;
  assert.equal(probe.Image, BASE, 'the small image, not the CUDA one');
  assert.match(probe.Cmd.join(' '), /--query-gpu=index,uuid,name,/);
  assert.equal(daemon.containers.some(c => c.Name === PROBE), false, 'the check\'s container is removed again');
  assert.deepEqual([found.chosen, found.selected], ['', 1], 'automatic: the card with the most room');
  useGpu(A);
  const chosen = await voice.hardware();
  assert.deepEqual([chosen.chosen, chosen.selected], [A, 0]);
  // What is suggested is for the card in use: card 0 has a third of card 1's room.
  assert.notDeepEqual(chosen.suggestion, found.suggestion);
  // A choice for a card that is not on the host is no choice: nothing is shown as chosen, and the automatic pick is used.
  useGpu('GPU-gone');
  const gone = await voice.hardware();
  assert.deepEqual([gone.chosen, gone.selected], ['', 1]);
  await voice.checkGpu(A);
  await assert.rejects(voice.checkGpu('GPU-gone'), /That GPU is not on this host/);
});

test('the engine check judges the chosen card, and the container is made for it', async () => {
  reset();
  useGpu(A);
  await voice.install(DEFAULTS);
  await settle();
  assert.equal((await voice.status()).error, '');
  assert.deepEqual(cardOfCreated(), { Driver: 'nvidia', DeviceIDs: [A], Capabilities: [['gpu']] });
  assert.equal(created()[0].Labels['pithagoras.voice-recipe'], 'breeze+whisper:base');
  assert.match(created()[0].Env.find((e: string) => e.startsWith('VOICE_PLAN='))!, /Detected NVIDIA GeForce RTX 3060 \(12\.0 GiB, 4\.3 GiB free\)/, 'the setup log names the card it checked');
  // Without a choice it is the card with the most room, named by UUID too.
  reset();
  await voice.install(DEFAULTS);
  await settle();
  assert.deepEqual(cardOfCreated().DeviceIDs, [B]);
  // What fits is judged on the card that was chosen and not on the one with the most room.
  reset();
  await voice.install();
  await settle();
  const roomy = created()[0].Labels['pithagoras.voice-recipe'];
  reset();
  useGpu(A);
  await voice.install();
  await settle();
  assert.deepEqual(cardOfCreated().DeviceIDs, [A]);
  assert.notEqual(created()[0].Labels['pithagoras.voice-recipe'], roomy);
});

test('the choice on the page wins over VOICE_GPU, and automatic hands the card back to it', async () => {
  reset();
  process.env.VOICE_GPU = '0';
  useGpu(B);
  await voice.install(DEFAULTS);
  await settle();
  assert.deepEqual(cardOfCreated().DeviceIDs, [B]);
  assert.equal((await voice.hardware()).selected, 1);
  useGpu('');
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
  made(byIndex(1), true);
  useGpu(B);
  await voice.install();
  await settle();
  assert.ok(kept(), 'card 1 is the one it is on, however it was named');
  // Another card: recreated, with the engines it has and the volume kept.
  useGpu(A);
  await voice.install();
  await settle();
  assert.deepEqual(cardOfCreated(), { Driver: 'nvidia', DeviceIDs: [A], Capabilities: [['gpu']] });
  assert.equal(v.voice()!.Labels['pithagoras.voice-recipe'], 'breeze+whisper:base');
  assert.ok(created().length === 1 && volumeKept());
  assert.equal(v.voice()!.State, 'running');
  // Chosen again: what is there is started as it is.
  daemon.created.length = 0;
  await voice.install();
  await settle();
  assert.ok(kept());
  // Automatic, with no VOICE_GPU, leaves it on the card it has.
  useGpu('');
  await voice.install();
  await settle();
  assert.ok(kept());
  assert.deepEqual((v.voice()!.made as any).HostConfig.DeviceRequests[0].DeviceIDs, [A]);
});

test('a stopped service moves on its next start, one that asked Docker for any GPU is on the first, and a choice that is gone moves nothing', async () => {
  reset();
  made(anyGpu);
  useGpu(A);
  await voice.start();
  await settle();
  assert.ok(kept(), 'Docker\'s any one GPU is the first, which is card 0');
  reset();
  made(anyGpu);
  useGpu(B);
  await voice.start();
  await settle();
  assert.deepEqual(cardOfCreated().DeviceIDs, [B]);
  assert.equal(v.voice()!.Labels['pithagoras.voice-recipe'], 'breeze+whisper:base', 'the default engines, as every earlier installation has');
  // A card that was taken out: the service is not moved to something that is not there.
  reset();
  made(byIndex(0));
  useGpu('GPU-gone');
  await voice.start();
  await settle();
  assert.ok(kept());
  assert.equal((await voice.status()).error, '');
});

test('a card that cannot hold the engines installed is refused, and the service stays where it is', async () => {
  // Card 0 has 6 GiB: room for Breeze with Whisper, not for Breeze with the large Qwen3-ASR model that runs on card 1.
  const small = `0, ${A}, Small GPU, 6144, 6000\n1, ${B}, NVIDIA GeForce RTX 3060, 12288, 12159\n`;
  reset();
  reading(small);
  made(byIndex(1), true, 'breeze+qwen3-asr:1.7b');
  await assert.rejects(voice.checkGpu(A), /Breeze speech with Qwen3-ASR 1\.7B needs about 7\.0 GiB of GPU memory, but Small GPU \(6\.0 GiB, 5\.9 GiB free\) has less\. Breeze speech with Qwen3-ASR 0\.6B would fit\./);
  await voice.checkGpu(B);
  // The same, where it is Start that moves it: by a choice saved earlier, or by VOICE_GPU. It goes on running, and says why.
  for (const ask of [() => useGpu(A), () => { process.env.VOICE_GPU = '0'; }]) {
    reset();
    reading(small);
    made(byIndex(1), true, 'breeze+qwen3-asr:1.7b');
    ask();
    await voice.start();
    await settle();
    assert.match((await voice.status()).error, /needs about 7\.0 GiB of GPU memory, but Small GPU/);
    assert.ok(kept());
    assert.equal(v.voice()!.State, 'running');
  }
  // Engines that fit move: Breeze with Whisper is 4.5 GiB.
  reset();
  reading(small);
  made(byIndex(1), true);
  useGpu(A);
  await voice.start();
  await settle();
  assert.equal((await voice.status()).error, '');
  assert.deepEqual(cardOfCreated().DeviceIDs, [A]);
});

test('a service pinned to a card that was taken out is made again on one that is there', async () => {
  const gonePin = { Driver: 'nvidia', DeviceIDs: ['GPU-replaced-9999'], Capabilities: [['gpu']] };
  reset();
  made(gonePin);
  await voice.start();
  await settle();
  assert.equal((await voice.status()).error, '');
  assert.deepEqual(cardOfCreated().DeviceIDs, [B], 'the card with the most room, as an install takes it');
  assert.equal(v.voice()!.Labels['pithagoras.voice-recipe'], 'breeze+whisper:base');
  assert.ok(created().length === 1 && volumeKept());
  // One card left, pinned by an index that is no longer there too: it is pinned to the card that is.
  reset();
  reading(`0, ${A}, NVIDIA GeForce RTX 3060, 12288, 12159\n`);
  made(byIndex(1));
  await voice.start();
  await settle();
  assert.deepEqual(cardOfCreated().DeviceIDs, [A]);
  // The card that is there cannot hold the engines: it is refused as an install is, and the service is left as it is.
  reset();
  reading(`0, ${A}, Tiny GPU, 2048, 2000\n`);
  made(gonePin);
  await voice.start();
  await settle();
  assert.match((await voice.status()).error, /Breeze speech with Whisper base needs about 4\.5 GiB of GPU memory, but Tiny GPU/);
  assert.ok(kept());
  // A card that is still there is no reason to move: it is started as it is.
  reset();
  made({ Driver: 'nvidia', DeviceIDs: [B], Capabilities: [['gpu']] });
  await voice.start();
  await settle();
  assert.ok(kept());
});
