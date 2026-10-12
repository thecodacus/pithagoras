import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import express from 'express';
import { fakeDocker } from "./fake-docker.mts";
import { inProcessHome } from "./helpers.mts";

// Uninstalling the managed voice service, through the API, against a fake Docker daemon: the container and the volume it
// leaves, and the saved settings the install overwrote. No GPU, no image and no container of this machine is touched.
const dir = inProcessHome('voice-uninstall-');
process.env.DOCKER_SOCKET = path.join(dir, 'docker.sock');
process.env.PORTAL_CONTAINER_NAME = 'portal-test';
// A host with neither nvidia-smi nor a GPU runtime for Docker: what is installed here is recognition alone, which needs no GPU.
process.env.NVIDIA_SMI = path.join(dir, 'no-such-nvidia-smi');
delete process.env.VOICE_GPU;
const NO_RUNTIME = 'could not select device driver "nvidia" with capabilities: [[gpu]]';
const CONTAINER = 'pithagoras-voice', VOLUME = 'pithagoras_voice-models';

let container: any = null;
let volumes = new Set<string>();
let images = new Set<string>(['ubuntu:22.04']);
// While set, a download of an image does not end: a setup that is under way.
let pullGate: Promise<void> | null = null;
// While set, Docker refuses to delete a volume, as it does when another container has it.
let volumeFails = false;
const docker = await fakeDocker(process.env.DOCKER_SOCKET!, async ({ method, url, path: p, query, body }) => {
  if (url === '/containers/portal-test/json') return { json: { Id: 'portal-one', State: { Running: true } } };
  if (url === `/containers/${CONTAINER}/json`) return { status: container ? 200 : 404, json: container };
  if (url.startsWith(`/containers/${CONTAINER}/logs`)) return { json: 'services ready' };
  if (url.startsWith('/images/create')) {
    await pullGate;
    images.add(`${query.get('fromImage')}:${query.get('tag')}`);
    return { text: '{"status":"Download complete"}\n' };
  }
  if (url.startsWith('/images/')) return { status: images.has(decodeURIComponent(url.slice('/images/'.length, -'/json'.length))) ? 200 : 404 };
  // The throwaway container that reads nvidia-smi: Docker has no GPU runtime here.
  if (url === '/containers/create') return { status: 500, json: { message: NO_RUNTIME } };
  if (url === '/volumes/create') { volumes.add(body.Name); return {}; }
  if (method === 'DELETE' && url.startsWith('/volumes/')) {
    const name = url.slice('/volumes/'.length);
    if (!volumes.has(name)) return { status: 404, json: { message: `get ${name}: no such volume` } };
    if (volumeFails) return { status: 409, json: { message: 'volume is in use - [another-container]' } };
    // As Docker refuses it: a container still has it.
    if (container) return { status: 409, json: { message: `volume is in use - [${CONTAINER}]` } };
    volumes.delete(name);
    return { status: 204, text: '' };
  }
  if (method === 'POST' && p === `/containers/${CONTAINER}/stop`) { container.State.Running = false; return {}; }
  if (method === 'DELETE' && p === `/containers/${CONTAINER}`) { container = null; return { status: 204, text: '' }; }
  if (method === 'POST' && url.startsWith(`/containers/create?name=${CONTAINER}`)) { container = { Config: body, HostConfig: body.HostConfig, State: { Running: false } }; return {}; }
  if (method === 'POST' && url === `/containers/${CONTAINER}/start`) { container.State.Running = true; return {}; }
  return undefined;
});
const { calls } = docker;
const { voiceRouter } = await import('../server/src/api/voice.js');
const { getDb } = await import('../server/src/db.js');
const voice = await import('../server/src/extensions/voice-service.js');
voice.hostReader.read = () => ({ totalMiB: 16384, freeMiB: 12000, threads: 8 });
const app = express(); app.use(express.json()); app.use('/api', voiceRouter());
const portal = app.listen(0, '127.0.0.1'); await new Promise<void>(r => portal.once('listening', r));
const base = `http://127.0.0.1:${(portal.address() as { port: number }).port}/api`;
// The services of the container answer as healthy; the portal's own API is reached as it is.
const oldFetch = globalThis.fetch;
globalThis.fetch = ((url: any, init?: any) => String(url).startsWith(base) ? oldFetch(url, init) : Promise.resolve(new Response('{}'))) as typeof fetch;
after(async () => {
  globalThis.fetch = oldFetch;
  await new Promise<void>(r => portal.close(() => r()));
  getDb().close();
});

const json = { 'Content-Type': 'application/json' };
const get = async (p: string) => (await oldFetch(`${base}${p}`)).json() as Promise<any>;
const post = (p: string, body?: unknown) => oldFetch(`${base}${p}`, { method: 'POST', headers: json, body: JSON.stringify(body ?? {}) });
const put = (body: object) => oldFetch(`${base}/voice`, { method: 'PUT', headers: json, body: JSON.stringify(body) });
const stored = (key: string) => (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
const reset = () => {
  container = null; volumes = new Set(); images = new Set(['ubuntu:22.04']); pullGate = null; volumeFails = false; docker.reset();
  getDb().prepare("DELETE FROM settings WHERE key IN ('voice', 'voice_before_managed', 'voice_setup_pending')").run();
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Waits for a setup to end, then reads the status once more: that read is what connects the saved settings to a service that has come up. */
const settle = async () => { for (let n = 0; n < 300 && (await get('/voice/install')).busy; n++) await sleep(10); return get('/voice/install'); };
const RECOGNITION_ONLY = { tts: 'none', asr: 'whisper', asrModel: 'base' };
const install = async (choice: object = RECOGNITION_ONLY) => { assert.equal((await post('/voice/install', choice)).status, 200); return settle(); };
/** A voice container as the installer of an older portal made it, with nothing remembered of the settings it overwrote. */
const seedContainer = (running = true) => { container = { Config: { Labels: { 'pithagoras.addon': 'voice', 'pithagoras.voice-network': 'shared-v1' } }, HostConfig: { NetworkMode: 'container:portal-one' }, State: { Running: running } }; volumes.add(VOLUME); };
const removed = () => calls.filter(c => c.method === 'DELETE').map(c => c.url);

// A speech recognition server and a speech server the user runs themselves, with the model one of them is told to use.
const OWN = { enabled: true, whisperUrl: 'http://stt.example.test:9000/inference', breezeUrl: 'http://tts.example.test:9001/v1/audio/speech', instruction: 'A calm voice.', runtime: 'breeze', sttModel: 'my-model', dictationModel: 'my-dictation', dictationUrl: 'http://dictate.example.test:9002/inference', voice: 'design', language: 'de' };
const MANAGED = { whisper: 'http://127.0.0.1:8188/inference', qwen: 'http://127.0.0.1:7862/v1/audio/transcriptions', speech: 'http://127.0.0.1:7862/v1/audio/speech' };
const DEFAULTS = { whisperUrl: 'http://127.0.0.1:8178/inference', breezeUrl: 'http://127.0.0.1:7860/v1/audio/speech' };
const fields = (c: any) => ({ enabled: c.enabled, runtime: c.runtime, whisperUrl: c.whisperUrl, breezeUrl: c.breezeUrl, sttModel: c.sttModel, dictationModel: c.dictationModel, dictationUrl: c.dictationUrl });

test('install overwrites the settings, and uninstall puts back exactly what they were: the container goes, the downloads stay', async () => {
  reset();
  assert.equal((await put({ ...OWN, vad: { positiveSpeechThreshold: 0.7, negativeSpeechThreshold: 0.3, minSpeechMs: 300, preSpeechPadMs: 200, redemptionMs: 800 } })).status, 200);
  const up = await install();
  assert.equal(up.state, 'running');
  // What the install does to the settings: the runtime is none for recognition alone, and the addresses are the managed service's.
  assert.deepEqual(fields(await get('/voice')), { enabled: true, runtime: 'none', whisperUrl: MANAGED.whisper, breezeUrl: '', sttModel: '', dictationModel: '', dictationUrl: '' });
  docker.reset();
  const answer = await post('/voice/uninstall');
  assert.deepEqual([answer.status, await answer.json()], [200, { ok: true }]);
  // A running container is stopped, then removed; the volume with the downloads is not touched.
  assert.deepEqual(calls.filter(c => c.method === 'POST' || c.method === 'DELETE').map(c => `${c.method} ${c.url}`), [`POST /containers/${CONTAINER}/stop?t=10`, `DELETE /containers/${CONTAINER}?force=true`]);
  assert.equal(container, null);
  assert.ok(volumes.has(VOLUME));
  const back = await get('/voice');
  assert.deepEqual(fields(back), { enabled: true, runtime: 'breeze', whisperUrl: OWN.whisperUrl, breezeUrl: OWN.breezeUrl, sttModel: 'my-model', dictationModel: 'my-dictation', dictationUrl: OWN.dictationUrl });
  // The voice, the language and the speech detection are not what an install overwrites, and are as they were.
  assert.deepEqual([back.voice, back.language, back.instruction, back.vad.redemptionMs, back.managed], ['design', 'de', 'A calm voice.', 800, false]);
  // The page shows what a portal that never installed it shows, and Install works again.
  const state = await get('/voice/install');
  assert.deepEqual([state.available, state.state, state.busy, state.error], [true, 'absent', false, '']);
  assert.equal(stored('voice_before_managed'), undefined);
  assert.equal(stored('voice_setup_pending'), undefined);
  assert.equal((await install()).state, 'running');
  assert.deepEqual(fields(await get('/voice')), { enabled: true, runtime: 'none', whisperUrl: MANAGED.whisper, breezeUrl: '', sttModel: '', dictationModel: '', dictationUrl: '' });
});

test('Kokoro on the CPU is the managed service too: its speech address is not taken for the user\'s own, and uninstall puts theirs back', async () => {
  reset();
  assert.equal((await put(OWN)).status, 200);
  const kokoro = { tts: 'kokoro', ttsDevice: 'cpu', asr: 'whisper', asrModel: 'base' };
  const up = await install(kokoro);
  assert.deepEqual([up.state, up.connected], ['running', true]);
  // Speech is in the audio.cpp process on the CPU, not the GPU one.
  const CPU_SPEECH = 'http://127.0.0.1:7863/v1/audio/speech';
  assert.deepEqual(fields(await get('/voice')), { enabled: true, runtime: 'kokoro', whisperUrl: MANAGED.whisper, breezeUrl: CPU_SPEECH, sttModel: '', dictationModel: '', dictationUrl: '' });
  // Connected over again, as a rebuild does: what is remembered is still what the user had, not the service's address.
  assert.equal((await post('/voice/connect')).status, 200);
  assert.equal((await post('/voice/uninstall')).status, 200);
  assert.deepEqual(fields(await get('/voice')), { enabled: true, runtime: 'breeze', whisperUrl: OWN.whisperUrl, breezeUrl: OWN.breezeUrl, sttModel: 'my-model', dictationModel: 'my-dictation', dictationUrl: OWN.dictationUrl });
});

test('what was remembered is what there was before the first connect: a second connect, a rebuild and "Use installed voice" do not replace it', async () => {
  reset();
  assert.equal((await put(OWN)).status, 200);
  await install();
  assert.equal((await post('/voice/connect')).status, 200);
  // Rebuilt with other engines: recreated, then connected again.
  assert.equal((await install({ tts: 'none', asr: 'qwen3-asr', asrModel: '0.6b' })).state, 'running');
  assert.equal((await get('/voice')).whisperUrl, 'http://127.0.0.1:7863/v1/audio/transcriptions');
  assert.equal((await post('/voice/uninstall')).status, 200);
  assert.deepEqual(fields(await get('/voice')), { enabled: true, runtime: 'breeze', whisperUrl: OWN.whisperUrl, breezeUrl: OWN.breezeUrl, sttModel: 'my-model', dictationModel: 'my-dictation', dictationUrl: OWN.dictationUrl });
});

test('an address set up after the install and connected over comes back, beside what was there on the other side', async () => {
  // Recognition alone leaves no speech address and the runtime none, which the install saved and which is not the user's own.
  reset();
  assert.equal((await put(OWN)).status, 200);
  await install();
  assert.deepEqual(fields(await get('/voice')), { enabled: true, runtime: 'none', whisperUrl: MANAGED.whisper, breezeUrl: '', sttModel: '', dictationModel: '', dictationUrl: '' });
  // Their own second recognition server, saved over the managed one (the page hides the speech address while there is none), then Stop and Start, which connect again.
  const other = { ...OWN, whisperUrl: 'http://stt2.example.test:9000/inference', runtime: 'none', breezeUrl: '', sttModel: '' };
  assert.equal((await put(other)).status, 200);
  assert.equal((await post('/voice/stop')).status, 200);
  assert.equal((await post('/voice/start')).status, 200);
  assert.equal((await settle()).state, 'running');
  assert.equal((await get('/voice')).whisperUrl, MANAGED.whisper);
  assert.equal((await post('/voice/uninstall')).status, 200);
  // The second server is the one the connect overwrote last, and the speech server and runtime from before the install are not lost to it.
  assert.deepEqual(fields(await get('/voice')), { enabled: true, runtime: 'breeze', whisperUrl: other.whisperUrl, breezeUrl: OWN.breezeUrl, sttModel: '', dictationModel: 'my-dictation', dictationUrl: OWN.dictationUrl });
  // The same where the speech side is the service's by its address: a container of the original engines, Breeze with Whisper, which are the ones with speech.
  const connected = async (own: object) => {
    reset(); seedContainer();
    assert.equal((await put(own)).status, 200);
    assert.equal((await post('/voice/connect')).status, 200);
    return get('/voice');
  };
  const up = await connected(OWN);
  assert.deepEqual(fields(up), { enabled: true, runtime: 'audio-cpp', whisperUrl: MANAGED.whisper, breezeUrl: MANAGED.speech, sttModel: '', dictationModel: '', dictationUrl: '' });
  assert.equal((await put({ ...up, whisperUrl: other.whisperUrl, sttModel: 'other-model' })).status, 200);
  assert.equal((await post('/voice/connect')).status, 200);
  assert.equal((await post('/voice/uninstall')).status, 200);
  assert.deepEqual(fields(await get('/voice')), { enabled: true, runtime: 'breeze', whisperUrl: other.whisperUrl, breezeUrl: OWN.breezeUrl, sttModel: 'other-model', dictationModel: '', dictationUrl: '' });
  // Their own recognition-only setup after the install is theirs as well: the empty speech address is the service's only where the service wrote it.
  const again = await connected(OWN);
  assert.equal((await put({ ...again, whisperUrl: other.whisperUrl, breezeUrl: '', runtime: 'none', sttModel: '' })).status, 200);
  assert.equal((await post('/voice/connect')).status, 200);
  assert.equal((await post('/voice/uninstall')).status, 200);
  assert.deepEqual(fields(await get('/voice')), { enabled: true, runtime: 'none', whisperUrl: other.whisperUrl, breezeUrl: '', sttModel: '', dictationModel: '', dictationUrl: '' });
});

test('what was set up after the install is the user\'s own and stays, and so is a service that was switched off', async () => {
  reset();
  assert.equal((await put(OWN)).status, 200);
  await install();
  // Their own speech servers again, saved over the managed ones: nothing there points at the service.
  const other = { ...OWN, whisperUrl: 'http://stt2.example.test:9000/inference', breezeUrl: 'http://tts2.example.test:9001/v1/audio/speech', sttModel: 'other-model' };
  assert.equal((await put(other)).status, 200);
  assert.equal((await post('/voice/uninstall')).status, 200);
  assert.deepEqual(fields(await get('/voice')), fields(other));
  assert.equal(stored('voice_before_managed'), undefined);
  // Voice switched off after the install is not switched on by the uninstall.
  reset();
  assert.equal((await put(OWN)).status, 200);
  await install();
  const off = await get('/voice');
  assert.equal((await put({ ...off, enabled: false })).status, 200);
  assert.equal((await post('/voice/uninstall')).status, 200);
  assert.deepEqual(fields(await get('/voice')), { ...fields(OWN), enabled: false });
});

test('a portal that had no voice set up is back to that: the defaults, with voice off', async () => {
  reset();
  assert.equal((await get('/voice')).enabled, false);
  await install();
  assert.equal((await get('/voice')).enabled, true);
  assert.equal((await post('/voice/uninstall')).status, 200);
  const back = await get('/voice');
  assert.deepEqual(fields(back), { enabled: false, runtime: 'breeze', whisperUrl: DEFAULTS.whisperUrl, breezeUrl: DEFAULTS.breezeUrl, sttModel: '', dictationModel: '', dictationUrl: '' });
  assert.equal(back.managed, false);
});

test('voice that was off before the install is off after it, however the sides were connected over: the flag goes with each side', async () => {
  // Nothing was set up: voice off, on the default addresses. The user then moves the speech side to their own server and keeps the managed recognition, and a connect follows (Use installed voice, or Stop and Start).
  reset(); seedContainer();
  assert.equal((await get('/voice')).enabled, false);
  assert.equal((await post('/voice/connect')).status, 200);
  const up = await get('/voice');
  assert.equal(up.enabled, true);
  assert.equal((await put({ ...up, runtime: 'breeze', breezeUrl: OWN.breezeUrl })).status, 200);
  assert.equal((await post('/voice/connect')).status, 200);
  assert.equal((await post('/voice/uninstall')).status, 200);
  // The speech server is theirs and stays; the recognition address is only a default, and voice is not left on against it.
  assert.deepEqual(fields(await get('/voice')), { enabled: false, runtime: 'breeze', whisperUrl: DEFAULTS.whisperUrl, breezeUrl: OWN.breezeUrl, sttModel: '', dictationModel: '', dictationUrl: '' });
  // The same with their own recognition server and the managed speech.
  reset(); seedContainer();
  assert.equal((await post('/voice/connect')).status, 200);
  assert.equal((await put({ ...await get('/voice'), whisperUrl: OWN.whisperUrl, sttModel: 'my-model' })).status, 200);
  assert.equal((await post('/voice/connect')).status, 200);
  assert.equal((await post('/voice/uninstall')).status, 200);
  assert.deepEqual(fields(await get('/voice')), { enabled: false, runtime: 'breeze', whisperUrl: OWN.whisperUrl, breezeUrl: DEFAULTS.breezeUrl, sttModel: 'my-model', dictationModel: '', dictationUrl: '' });
  // Voice that was on, with both sides theirs, stays on when one side was moved to another server of theirs in between.
  reset(); seedContainer();
  assert.equal((await put(OWN)).status, 200);
  assert.equal((await post('/voice/connect')).status, 200);
  assert.equal((await put({ ...await get('/voice'), runtime: 'breeze', breezeUrl: 'http://tts2.example.test:9001/v1/audio/speech' })).status, 200);
  assert.equal((await post('/voice/connect')).status, 200);
  assert.equal((await post('/voice/uninstall')).status, 200);
  assert.deepEqual(fields(await get('/voice')), { enabled: true, runtime: 'breeze', whisperUrl: OWN.whisperUrl, breezeUrl: 'http://tts2.example.test:9001/v1/audio/speech', sttModel: 'my-model', dictationModel: 'my-dictation', dictationUrl: OWN.dictationUrl });
});

test('a service installed before settings were remembered: only what points at it is reset, and every other address stays', async () => {
  // The dictation endpoint of OWN stays throughout this test: the service never wrote one, so it is the user's.
  // Speech and recognition both the managed service's: both go back to a portal with nothing set up, and voice is off.
  reset(); seedContainer();
  assert.equal((await put({ ...OWN, runtime: 'audio-cpp', whisperUrl: MANAGED.qwen, breezeUrl: MANAGED.speech, sttModel: 'qwen3-asr' })).status, 200);
  assert.equal((await post('/voice/uninstall')).status, 200);
  const both = await get('/voice');
  assert.deepEqual(fields(both), { enabled: false, runtime: 'breeze', whisperUrl: DEFAULTS.whisperUrl, breezeUrl: DEFAULTS.breezeUrl, sttModel: '', dictationModel: 'my-dictation', dictationUrl: OWN.dictationUrl });
  assert.deepEqual([both.voice, both.language, both.instruction], ['design', 'de', 'A calm voice.']);
  // Recognition alone, with no speech address, is the managed service's as well.
  reset(); seedContainer();
  assert.equal((await put({ ...OWN, runtime: 'none', whisperUrl: MANAGED.whisper, breezeUrl: '', sttModel: '' })).status, 200);
  assert.equal((await post('/voice/uninstall')).status, 200);
  assert.deepEqual(fields(await get('/voice')), { enabled: false, runtime: 'breeze', whisperUrl: DEFAULTS.whisperUrl, breezeUrl: DEFAULTS.breezeUrl, sttModel: '', dictationModel: 'my-dictation', dictationUrl: OWN.dictationUrl });
  // Their own speech server beside the managed recognition: it stays, with the runtime it is spoken to in.
  reset(); seedContainer();
  assert.equal((await put({ ...OWN, runtime: 'audio-cpp', whisperUrl: MANAGED.qwen, sttModel: 'qwen3-asr' })).status, 200);
  assert.equal((await post('/voice/uninstall')).status, 200);
  assert.deepEqual(fields(await get('/voice')), { enabled: false, runtime: 'audio-cpp', whisperUrl: DEFAULTS.whisperUrl, breezeUrl: OWN.breezeUrl, sttModel: '', dictationModel: 'my-dictation', dictationUrl: OWN.dictationUrl });
  // And the other way round: their own recognition server stays beside the managed speech, which goes.
  reset(); seedContainer();
  assert.equal((await put({ ...OWN, runtime: 'audio-cpp', breezeUrl: MANAGED.speech })).status, 200);
  assert.equal((await post('/voice/uninstall')).status, 200);
  assert.deepEqual(fields(await get('/voice')), { enabled: false, runtime: 'breeze', whisperUrl: OWN.whisperUrl, breezeUrl: DEFAULTS.breezeUrl, sttModel: 'my-model', dictationModel: 'my-dictation', dictationUrl: OWN.dictationUrl });
  // Nothing of the managed service in the settings: nothing is changed, not even voice being on.
  reset(); seedContainer();
  assert.equal((await put(OWN)).status, 200);
  assert.equal((await post('/voice/uninstall')).status, 200);
  assert.deepEqual(fields(await get('/voice')), fields(OWN));
});

test('the downloaded engines and models go when asked, after the container, and not otherwise', async () => {
  reset(); seedContainer(false);
  assert.equal((await post('/voice/uninstall', { removeData: false })).status, 200);
  assert.deepEqual(removed(), [`/containers/${CONTAINER}?force=true`]);
  assert.ok(volumes.has(VOLUME));
  // The container is stopped already: nothing to stop. The volume is deleted once nothing has it.
  assert.ok(!calls.some(c => c.url.includes('/stop?')));
  docker.reset();
  assert.equal((await post('/voice/uninstall', { removeData: true })).status, 200);
  assert.deepEqual(removed(), [`/volumes/${VOLUME}`]);
  assert.equal(volumes.has(VOLUME), false);
  // With the container still there, the volume is deleted after it.
  reset(); seedContainer();
  assert.equal((await post('/voice/uninstall', { removeData: true })).status, 200);
  assert.deepEqual(removed(), [`/containers/${CONTAINER}?force=true`, `/volumes/${VOLUME}`]);
  assert.equal(volumes.size, 0);
  assert.equal((await get('/voice/install')).state, 'absent');
});

test('uninstalling what is not installed is harmless, and the choice to delete the downloads still applies', async () => {
  reset();
  assert.equal((await put(OWN)).status, 200);
  const before = await get('/voice');
  for (const body of [{}, { removeData: true }]) {
    const answer = await post('/voice/uninstall', body);
    assert.deepEqual([answer.status, await answer.json()], [200, { ok: true }]);
  }
  // Nothing to stop or remove; a volume that is not there is not an error either.
  assert.deepEqual(removed(), [`/volumes/${VOLUME}`]);
  assert.deepEqual(await get('/voice'), before);
  assert.equal(stored('voice_before_managed'), undefined);
  // A container that was removed by hand, with the settings left pointing at it: they are put right.
  reset();
  assert.equal((await put({ ...OWN, runtime: 'audio-cpp', whisperUrl: MANAGED.qwen, breezeUrl: MANAGED.speech, sttModel: 'qwen3-asr' })).status, 200);
  assert.equal((await post('/voice/uninstall')).status, 200);
  assert.deepEqual(fields(await get('/voice')), { enabled: false, runtime: 'breeze', whisperUrl: DEFAULTS.whisperUrl, breezeUrl: DEFAULTS.breezeUrl, sttModel: '', dictationModel: 'my-dictation', dictationUrl: OWN.dictationUrl });
});

test('a container that the portal did not make is left alone, with the settings as they are', async () => {
  reset();
  container = { Config: { Labels: {} }, HostConfig: {}, State: { Running: true } };
  assert.equal((await put({ ...OWN, runtime: 'audio-cpp', whisperUrl: MANAGED.qwen, breezeUrl: MANAGED.speech })).status, 200);
  const answer = await post('/voice/uninstall', { removeData: true });
  assert.equal(answer.status, 400);
  assert.match((await answer.json()).error, /not a managed voice add-on/);
  assert.deepEqual(removed(), []);
  assert.deepEqual(calls.filter(c => c.method === 'POST'), []);
  assert.equal((await get('/voice')).whisperUrl, MANAGED.qwen);
});

test('nothing is uninstalled while a setup is under way, and a choice that is not yes or no is refused', async () => {
  reset();
  assert.equal((await put(OWN)).status, 200);
  let release!: () => void;
  pullGate = new Promise<void>(r => { release = r; });
  images.clear();
  assert.equal((await post('/voice/install', RECOGNITION_ONLY)).status, 200);
  const early = await post('/voice/uninstall');
  assert.equal(early.status, 400);
  assert.match((await early.json()).error, /Wait for voice setup to finish/);
  release();
  assert.equal((await settle()).state, 'running');
  // The setup went on as it was: the settings are connected, and the container is there.
  assert.equal((await get('/voice')).whisperUrl, MANAGED.whisper);
  for (const removeData of ['yes', 1, 'false']) {
    const refused = await post('/voice/uninstall', { removeData });
    assert.equal(refused.status, 400, JSON.stringify(removeData));
    assert.match((await refused.json()).error, /removeData must be true or false/);
  }
  assert.ok(container);
  assert.equal((await post('/voice/uninstall')).status, 200);
});

test('where the volume cannot be deleted the container is still removed and the settings are still put back, and the error says why the downloads stay', async () => {
  reset();
  assert.equal((await put(OWN)).status, 200);
  await install();
  volumeFails = true;
  const answer = await post('/voice/uninstall', { removeData: true });
  assert.equal(answer.status, 409);
  assert.match((await answer.json()).error, /^The voice container is removed, but its downloaded engines and models could not be deleted: volume is in use/);
  assert.equal(container, null);
  assert.ok(volumes.has(VOLUME));
  assert.deepEqual(fields(await get('/voice')), { enabled: true, runtime: 'breeze', whisperUrl: OWN.whisperUrl, breezeUrl: OWN.breezeUrl, sttModel: 'my-model', dictationModel: 'my-dictation', dictationUrl: OWN.dictationUrl });
  assert.equal(stored('voice_before_managed'), undefined);
  assert.equal(stored('voice_setup_pending'), undefined);
  const state = await get('/voice/install');
  assert.deepEqual([state.state, state.connected], ['absent', false]);
});

test('the status says whether the saved settings point at the service, also after its container was removed by hand', async () => {
  reset();
  assert.equal((await put(OWN)).status, 200);
  assert.equal((await get('/voice/install')).connected, false);
  await install();
  const up = await get('/voice/install');
  assert.deepEqual([up.state, up.connected], ['running', true]);
  // The container is removed with Docker, and the page still has to be able to put the settings right.
  container = null;
  const gone = await get('/voice/install');
  assert.deepEqual([gone.state, gone.connected], ['absent', true]);
  assert.equal((await post('/voice/uninstall')).status, 200);
  assert.equal((await get('/voice/install')).connected, false);
  // Recognition alone, as a service of an older portal leaves it, counts as well; their own dictation-only setup does not.
  reset();
  assert.equal((await put({ ...OWN, runtime: 'none', whisperUrl: MANAGED.whisper, breezeUrl: '', sttModel: '' })).status, 200);
  assert.equal((await get('/voice/install')).connected, true);
  assert.equal((await put({ ...OWN, runtime: 'none', breezeUrl: '', sttModel: '' })).status, 200);
  assert.equal((await get('/voice/install')).connected, false);
});

test('a dictation endpoint and model set up after the install survive Start voice, and the uninstall puts back what there was before', async () => {
  reset();
  assert.equal((await put(OWN)).status, 200);
  await install();
  // The install took the recognition over from their own server, so the dictation pair of that server is gone for now.
  const set = await get('/voice');
  assert.deepEqual([set.dictationModel, set.dictationUrl], ['', '']);
  const mine = { dictationUrl: 'http://big.example.test:9100/v1/audio/transcriptions', dictationModel: 'big-asr' };
  assert.equal((await put({ ...set, ...mine })).status, 200);
  // Stop and Start connect again, over a recognition that is the service's already.
  assert.equal((await post('/voice/stop')).status, 200);
  assert.equal((await post('/voice/start')).status, 200);
  assert.equal((await settle()).state, 'running');
  assert.deepEqual(fields(await get('/voice')), { enabled: true, runtime: 'none', whisperUrl: MANAGED.whisper, breezeUrl: '', sttModel: '', ...mine });
  // The uninstall puts the recognition back and leaves the endpoint they set up since, with its model.
  assert.equal((await post('/voice/uninstall')).status, 200);
  assert.deepEqual(fields(await get('/voice')), { enabled: true, runtime: 'breeze', whisperUrl: OWN.whisperUrl, breezeUrl: OWN.breezeUrl, sttModel: 'my-model', ...mine });
  // Without one of theirs set up since, what was there before the install comes back.
  reset();
  assert.equal((await put(OWN)).status, 200);
  await install();
  assert.equal((await post('/voice/stop')).status, 200);
  assert.equal((await post('/voice/start')).status, 200);
  assert.equal((await settle()).state, 'running');
  assert.equal((await post('/voice/uninstall')).status, 200);
  assert.deepEqual(fields(await get('/voice')), { enabled: true, runtime: 'breeze', whisperUrl: OWN.whisperUrl, breezeUrl: OWN.breezeUrl, sttModel: 'my-model', dictationModel: 'my-dictation', dictationUrl: OWN.dictationUrl });
});

test('a dictation endpoint that points at the service is cleared by the uninstall, also when voice mode listens to their own server', async () => {
  reset();
  assert.equal((await put(OWN)).status, 200);
  await install();
  // Dictation keeps the service's recognition while voice mode listens to their own server.
  const split = { ...await get('/voice'), whisperUrl: OWN.whisperUrl, dictationUrl: MANAGED.whisper, dictationModel: 'asr-x' };
  assert.equal((await put(split)).status, 200);
  assert.equal((await get('/voice/install')).connected, true);
  assert.equal((await post('/voice/uninstall')).status, 200);
  const back = await get('/voice');
  assert.deepEqual([back.whisperUrl, back.dictationUrl, back.dictationModel], [OWN.whisperUrl, '', '']);
  assert.equal((await get('/voice/install')).connected, false);
});

test('a managed dictation address is not remembered as theirs when Start voice takes the recognition over, so the uninstall does not put it back', async () => {
  reset();
  assert.equal((await put(OWN)).status, 200);
  await install();
  // The split setup: voice mode on their own server, dictation on the service's. Start voice connects again over their server.
  const split = { ...await get('/voice'), whisperUrl: OWN.whisperUrl, dictationUrl: MANAGED.whisper, dictationModel: 'asr-x' };
  assert.equal((await put(split)).status, 200);
  assert.equal((await post('/voice/stop')).status, 200);
  assert.equal((await post('/voice/start')).status, 200);
  assert.equal((await settle()).state, 'running');
  const kept = JSON.parse(stored('voice_before_managed')!).listening;
  assert.deepEqual([kept.whisperUrl, kept.dictationUrl, kept.dictationModel], [OWN.whisperUrl, '', '']);
  assert.equal((await post('/voice/uninstall')).status, 200);
  const back = await get('/voice');
  assert.deepEqual([back.whisperUrl, back.dictationUrl, back.dictationModel], [OWN.whisperUrl, '', '']);
});

test('a managed dictation address alone makes the settings point at the service, and the uninstall clears it when both sides are their own', async () => {
  reset(); seedContainer();
  assert.equal((await put({ ...OWN, dictationUrl: MANAGED.whisper, dictationModel: 'asr-x' })).status, 200);
  assert.equal((await get('/voice/install')).connected, true);
  assert.equal((await post('/voice/uninstall')).status, 200);
  assert.deepEqual(fields(await get('/voice')), { ...fields(OWN), dictationUrl: '', dictationModel: '' });
  assert.equal((await get('/voice/install')).connected, false);
});

test('Start voice over a recognition that is the service\'s clears a dictation address that is the service\'s as well', async () => {
  reset();
  assert.equal((await put(OWN)).status, 200);
  await install();
  assert.equal((await put({ ...await get('/voice'), dictationUrl: MANAGED.whisper, dictationModel: 'asr-x' })).status, 200);
  assert.equal((await post('/voice/stop')).status, 200);
  assert.equal((await post('/voice/start')).status, 200);
  assert.equal((await settle()).state, 'running');
  const now = await get('/voice');
  assert.deepEqual([now.whisperUrl, now.dictationUrl, now.dictationModel], [MANAGED.whisper, '', '']);
});
