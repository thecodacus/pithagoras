import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { speechChunks, samplesWav } from '../web/src/voice.js';
import { inProcessHome } from "./helpers.mts";
const dir = inProcessHome('pithagoras-voice-');
// No Docker here, whatever this machine has: the managed service is tested on its own.
process.env.DOCKER_SOCKET = join(dir, 'no-docker.sock');
const { voiceRouter, pcmWav, wavPcm, validateConfig, connectManagedVoice, errorLineRetry } = await import('../server/src/api/voice.js');
const { INPUT_LANGUAGES, CHATTERBOX_LANGUAGES } = await import('../server/src/voice-languages.js');
const { getDb, getSkipThinkingProviders, getVoiceInstructions, getVoiceModel } = await import('../server/src/db.js');
const { DEFAULT_SKIP_THINKING_PROVIDERS, DEFAULT_VOICE_INSTRUCTIONS } = await import('../server/src/pi/voice-first.js');
const upstream = express();
let calls = 0;
let busyAttempts = 0;
let speechCalls = 0;
// The next this many speech requests fail, as a model that is still coming up does.
let failSpeech = 0;
// A speech model that is slow, or that answers with something other than 24 kHz audio.
let slowSpeechMs = 0;
let badSpeech: 'json' | 'rate' | undefined;
let nativeRequest: any;
let speechBody = "";
let transcriptionBody = "";
let releaseStream: (() => void) | undefined;
let streamClosed: (() => void) | undefined;
upstream.post('/inference', express.raw({ type: () => true }), (req, res) => {
  transcriptionBody = req.body.toString();
  calls++; assert.match(transcriptionBody, /name="file"; filename="recording.wav"/);
  res.json({ text: ' Test the session. ' });
});
let dictationBody = "";
upstream.post('/dictation', express.raw({ type: () => true }), (req, res) => {
  dictationBody = req.body.toString();
  res.json({ text: ' Dictated elsewhere. ' });
});
upstream.post('/v1/audio/speech', express.raw({ type: () => true }), async (req, res) => {
  speechCalls++;
  if (failSpeech > 0) { failSpeech--; return res.status(503).json({ detail: 'loading' }); }
  if (slowSpeechMs) await new Promise(r => setTimeout(r, slowSpeechMs));
  if (badSpeech === 'json') return res.json({ detail: 'not audio' });
  if (badSpeech === 'rate') return res.set({ 'Content-Type': 'audio/pcm', 'X-Sample-Rate': '16000' }).send(Buffer.from([0, 0, 255, 127]));
  if (req.get('content-type') === 'application/json') {
    nativeRequest = JSON.parse(req.body.toString());
    // Chatterbox and Kokoro have no streaming mode: they answer with one complete WAV.
    if (nativeRequest.model === 'chatterbox' || nativeRequest.model === 'kokoro')
      return res.set({ 'Content-Type': 'audio/wav' }).send(pcmWav(Buffer.from([0, 0, 255, 127])));
    return res.set({ 'Content-Type': 'audio/pcm', 'X-Sample-Rate': '24000' }).send(Buffer.from([0, 0, 255, 127]));
  }
  if (req.body.toString().includes('stream-test')) {
    res.set({ 'Content-Type': 'audio/pcm', 'X-Sample-Rate': '24000' });
    res.write(Buffer.from([0, 0]));
    releaseStream = () => res.end(Buffer.from([255, 127]));
    res.on('close', () => streamClosed?.());
    return;
  }
  if (req.body.toString().includes('busy-test') && ++busyAttempts <= 2) return res.status(409).json({ detail: 'busy' });
  speechBody = req.body.toString();
  calls++; assert.match(speechBody, /name="instruction"/);
  res.set({ 'Content-Type': 'audio/pcm', 'X-Sample-Rate': '24000' }).send(Buffer.from([0, 0, 255, 127]));
});
const backend = upstream.listen(0, '127.0.0.1');
await new Promise<void>(r => backend.once('listening', r));
const port = (backend.address() as { port: number }).port;
const app = express(); app.use(express.json()); app.use('/api', voiceRouter());
const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
after(async () => {
  await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => backend.close(() => r()))]);
  getDb().close();
});
const settings = { enabled: true, whisperUrl: `http://127.0.0.1:${port}/inference`, breezeUrl: `http://127.0.0.1:${port}/v1/audio/speech`, instruction: 'A calm English voice.' };
/** A reference clone in the voice library, made once, for the tests that need a voice with a recording. */
let clone: string | undefined;
const cloneVoice = async () => {
  if (clone) return clone;
  const { addVoice } = await import('../server/src/voice-presets.js');
  const audio = Buffer.from(await samplesWav(new Float32Array(16000)).arrayBuffer()).toString('base64');
  return (clone = addVoice({ name: 'Reference', kind: 'clone', instruction: 'A calm English voice.', transcript: 'Reference voice.', audio }).id);
};
test('voice is opt-in, checks session existence, and proxies actual multipart contracts', async () => {
  assert.equal((await (await fetch(`${base}/voice`)).json()).enabled, false);
  assert.equal((await fetch(`${base}/sessions/test/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"hello"}' })).status, 409);
  const saved = await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
  assert.equal(saved.status, 200);
  assert.equal((await fetch(`${base}/sessions/missing/voice/transcribe`, { method: 'POST' })).status, 404);
  getDb().prepare("INSERT INTO sessions (id,title,workspace,executor,status,created_at,updated_at) VALUES ('test','Voice','/tmp','host','idle','now','now')").run();
  assert.equal((await fetch(`${base}/sessions/test/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: 'invalid' })).status, 400);
  const transcribed = await fetch(`${base}/sessions/test/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: new Uint8Array(pcmWav(Buffer.alloc(32))) });
  assert.deepEqual(await transcribed.json(), { text: 'Test the session.' });
  const spoken = await fetch(`${base}/sessions/test/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"Hello"}' });
  assert.equal(spoken.headers.get('content-type')?.split(';')[0], 'audio/wav');
  const wav = Buffer.from(await spoken.arrayBuffer()); assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 24000); assert.equal(wav.readUInt32LE(40), 4);
  assert.equal(calls, 2);
  const busy = await fetch(`${base}/sessions/test/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"busy-test"}' });
  assert.equal(busy.status, 200);
  assert.equal(busyAttempts, 3);
  assert.equal(Buffer.from(await busy.arrayBuffer()).toString("ascii", 0, 4), "RIFF");
  assert.match(transcriptionBody, /name="language"\r\n\r\nauto\r\n/);
});
test('a voice that is not in the library is refused rather than spoken in another', () => {
  assert.throws(() => validateConfig({ ...settings, voice: 'missing' }));
  assert.throws(() => validateConfig({ ...settings, voice: '../other' }));
});
test('dictation can name a model of its own; voice mode and an empty setting keep the general one', async () => {
  const put = (body: object) => fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const transcribe = async (query = '') => {
    const res = await fetch(`${base}/sessions/test/voice/transcribe${query}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: new Uint8Array(pcmWav(Buffer.alloc(32))) });
    assert.equal(res.status, 200);
    return transcriptionBody.match(/name="model"\r\n\r\n(.*)\r\n/)?.[1];
  };
  const saved = await put({ ...settings, sttModel: 'fast-asr', dictationModel: ' accurate-asr ' });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).dictationModel, 'accurate-asr');
  assert.equal(await transcribe(), 'fast-asr');
  assert.equal(await transcribe('?purpose=dictation'), 'accurate-asr');
  // "Auto": empty means dictation uses the general model.
  assert.equal((await put({ ...settings, sttModel: 'fast-asr', dictationModel: '' })).status, 200);
  assert.equal(await transcribe('?purpose=dictation'), 'fast-asr');
  // Only the dictation model is set: voice mode sends no model field.
  assert.equal((await put({ ...settings, sttModel: '', dictationModel: 'accurate-asr' })).status, 200);
  assert.equal(await transcribe(), undefined);
  assert.equal(await transcribe('?purpose=dictation'), 'accurate-asr');
  assert.throws(() => validateConfig({ ...settings, dictationModel: 'a model' }));
  assert.throws(() => validateConfig({ ...settings, dictationModel: 3 }));
  // The managed service names its own model, so a leftover one is dropped.
  assert.equal(connectManagedVoice().dictationModel, '');
});
test('dictation can name an endpoint of its own; voice mode and an empty setting keep the voice one', async () => {
  const put = (body: object) => fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const transcribe = async (query = '') => {
    transcriptionBody = dictationBody = '';
    const res = await fetch(`${base}/sessions/test/voice/transcribe${query}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: new Uint8Array(pcmWav(Buffer.alloc(32))) });
    assert.equal(res.status, 200);
    return { text: (await res.json()).text, voice: transcriptionBody !== '', own: dictationBody !== '' };
  };
  const own = `http://127.0.0.1:${port}/dictation`;
  const saved = await put({ ...settings, dictationUrl: ` ${own} ` });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).dictationUrl, own);
  // Dictation goes to its own address; voice mode keeps the general one.
  assert.deepEqual(await transcribe('?purpose=dictation'), { text: 'Dictated elsewhere.', voice: false, own: true });
  assert.deepEqual(await transcribe(), { text: 'Test the session.', voice: true, own: false });
  // Empty: dictation uses the voice address like voice mode.
  assert.equal((await put({ ...settings, dictationUrl: '' })).status, 200);
  assert.deepEqual(await transcribe('?purpose=dictation'), { text: 'Test the session.', voice: true, own: false });
  assert.equal((await put({ ...settings })).status, 200);
  assert.deepEqual(await transcribe('?purpose=dictation'), { text: 'Test the session.', voice: true, own: false });
  // The same check as for the voice address.
  for (const bad of ['not a url', 'ftp://example.test/x', 'http://user:pw@example.test/x', 'http://example.test/x#frag'])
    assert.throws(() => validateConfig({ ...settings, dictationUrl: bad }), undefined, bad);
  assert.throws(() => validateConfig({ ...settings, dictationUrl: 3 }));
  assert.equal(validateConfig({ ...settings, dictationUrl: '  ' }).dictationUrl, '');
  // The managed service has one address for both, so a leftover one is dropped.
  await put({ ...settings, dictationUrl: own });
  assert.equal(connectManagedVoice().dictationUrl, '');
});
test('selected input language is sent to Whisper and invalid languages are rejected', async () => {
  for (const language of ['en', 'hi', 'bn']) {
    const saved = await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, language }) });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).language, language);
    const result = await fetch(`${base}/sessions/test/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: new Uint8Array(pcmWav(Buffer.alloc(32))) });
    assert.equal(result.status, 200);
    assert.ok(transcriptionBody.includes('name="language"\r\n\r\n' + language + '\r\n'));
  }
  assert.throws(() => validateConfig({ ...settings, language: 'invalid' }));
});
test('reject invalid service settings and malformed audio', () => {
  assert.throws(() => validateConfig({ ...settings, breezeUrl: 'file:///etc/passwd' }));
  assert.throws(() => validateConfig({ ...settings, enabled: 'true' }));
  assert.throws(() => pcmWav(Buffer.alloc(1)));
  assert.throws(() => validateConfig({ ...settings, cfgScale: 0 }));
});
test('spoken chunks omit code and preserve long prose without exceeding the API bound', () => {
  assert.deepEqual(speechChunks('Hello **there**. [Read this](https://example.com) ```js\nsecret()\n```'), ['Hello there. Read this Code is shown in the transcript.']);
  const text = 'word '.repeat(1000).trim(); const chunks = speechChunks(text);
  assert.ok(chunks.every(c => c.length <= 600)); assert.equal(chunks.join(' '), text);
  assert.equal(speechChunks('a'.repeat(1600)).join(''), 'a'.repeat(1600));
});

test('PCM reaches the client before synthesis completes, and cancelling disconnects upstream', async () => {
  const request = (signal?: AbortSignal) => fetch(`${base}/sessions/test/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'audio/pcm' }, body: JSON.stringify({ text: 'stream-test' }), signal });
  const response = await request();
  assert.equal(response.headers.get('content-type'), 'audio/pcm');
  const reader = response.body!.getReader();
  assert.deepEqual((await reader.read()).value, new Uint8Array([0, 0]));
  releaseStream!();
  assert.deepEqual((await reader.read()).value, new Uint8Array([255, 127]));
  assert.equal((await reader.read()).done, true);
  const abort = new AbortController();
  const next = await request(abort.signal);
  const nextReader = next.body!.getReader();
  await nextReader.read();
  const closed = new Promise<void>(resolve => { streamClosed = resolve; });
  abort.abort();
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('Upstream did not cancel')), 2000).unref())]);
});

test('audio.cpp receives cloning context and exposes incremental playback', async () => {
  await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, runtime: 'audio-cpp', voice: await cloneVoice(), cfgScale: 1 }) });
  const response = await fetch(`${base}/sessions/test/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'audio/pcm' }, body: JSON.stringify({ text: 'Speak while generating.' }) });
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-voice-streaming'), 'true');
  assert.equal(nativeRequest.reference_text, 'Reference voice.');
  assert.equal(nativeRequest.voice_ref.type, 'base64'); assert.equal(nativeRequest.stream_format, 'audio');
  assert.equal(nativeRequest.options.guidance_scale, '1'); await response.arrayBuffer();
});


test('voice mode speaks with the voice of the agent the chat is with', async () => {
  const { createAgent, setVoice } = await import('../server/src/agents.js');
  const { createSession } = await import('../server/src/db.js');
  const saved = await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, runtime: 'audio-cpp', voice: 'design' }) });
  assert.equal(saved.status, 200);
  const { addVoice } = await import('../server/src/voice-presets.js');
  const { samplesWav } = await import('../web/src/voice.js');
  const audio = Buffer.from(await samplesWav(new Float32Array(16000)).arrayBuffer()).toString('base64');
  const clone = addVoice({ name: 'Herald voice', kind: 'clone', instruction: 'Warm.', transcript: 'Herald reference.', audio });
  const agent = createAgent({ name: 'Herald' });
  setVoice(agent.id, clone.id);
  createSession({ id: 'herald-chat', title: 'Herald', workspace: agent.home, executor: 'host' });
  nativeRequest = undefined;
  const response = await fetch(`${base}/sessions/herald-chat/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hello.' }) });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.equal(nativeRequest.reference_text, 'Herald reference.', "the agent's clone, not the designed voice in the settings");

  // A chat in a project speaks as the first agent, with its avatar and its voice.
  setVoice('home', clone.id);
  createSession({ id: 'project-chat', title: 'Project', workspace: join(dir, 'ws', 'site'), executor: 'host' });
  nativeRequest = undefined;
  const project = await fetch(`${base}/sessions/project-chat/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hello.' }) });
  assert.equal(project.status, 200);
  await project.arrayBuffer();
  assert.equal(nativeRequest.reference_text, 'Herald reference.');
  setVoice('home', '');
});

test('custom clone sends its saved recording, transcript and description to audio.cpp', async () => {
  const { addVoice } = await import('../server/src/voice-presets.js');
  const { samplesWav } = await import('../web/src/voice.js');
  const audio = Buffer.from(await samplesWav(new Float32Array(16000)).arrayBuffer()).toString('base64');
  const preset = addVoice({ name: 'Custom narrator', kind: 'clone', instruction: 'Warm narrator.', transcript: 'My reference words.', audio });
  const saved = await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, runtime: 'audio-cpp', voice: preset.id }) });
  assert.equal(saved.status, 200);
  const response = await fetch(`${base}/sessions/test/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Custom voice response.' }) });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.deepEqual(nativeRequest.voice_ref, { type: 'base64', data: audio });
  assert.equal(nativeRequest.reference_text, 'My reference words.');
  assert.equal(nativeRequest.options.instruction, 'Warm narrator.');
});

test('a changed voice description reaches the next phrase on both Breeze runtimes, and the recording stays', async () => {
  const { addVoice } = await import('../server/src/voice-presets.js');
  const { samplesWav } = await import('../web/src/voice.js');
  const audio = Buffer.from(await samplesWav(new Float32Array(16000)).arrayBuffer()).toString('base64');
  const preset = addVoice({ name: 'Edited narrator', kind: 'clone', instruction: 'Warm narrator.', transcript: 'Words on the tape.', audio });
  const patch = (id: string, body: unknown) => fetch(`${base}/voice/presets/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const speak = async () => { const response = await fetch(`${base}/sessions/test/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Edited voice response.' }) }); assert.equal(response.status, 200); await response.arrayBuffer(); };
  const select = async (runtime: string) => assert.equal((await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, runtime, voice: preset.id }) })).status, 200);
  await select('audio-cpp');
  await speak();
  assert.equal(nativeRequest.options.instruction, 'Warm narrator.');
  const edited = await patch(preset.id, { instruction: '  A slow, low voice.  ' });
  assert.equal(edited.status, 200);
  assert.deepEqual(await edited.json(), { id: preset.id, name: 'Edited narrator', kind: 'clone', instruction: 'A slow, low voice.', transcript: 'Words on the tape.' });
  await speak();
  assert.equal(nativeRequest.options.instruction, 'A slow, low voice.');
  assert.deepEqual(nativeRequest.voice_ref, { type: 'base64', data: audio });
  assert.equal(nativeRequest.reference_text, 'Words on the tape.');
  // The Python runtime takes the same text as a form field.
  await select('breeze');
  await speak();
  assert.ok(speechBody.includes('name="instruction"\r\n\r\nA slow, low voice.\r\n'));
  assert.ok(!speechBody.includes('Warm narrator.'));
  assert.equal((await (await fetch(`${base}/voice/presets`)).json()).find((v: any) => v.id === preset.id).instruction, 'A slow, low voice.');
  // A description that cannot be used, or a voice that is not there, changes nothing.
  for (const instruction of ['', '   ', 'x'.repeat(1001), 7, undefined]) {
    const refused = await patch(preset.id, { instruction });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /1–1000 characters/);
  }
  assert.equal((await patch('voice-missing', { instruction: 'Clear.' })).status, 404);
  await speak();
  assert.ok(speechBody.includes('name="instruction"\r\n\r\nA slow, low voice.\r\n'));
});

test('Chatterbox clones a reference, writes numbers out and returns one buffered phrase', async () => {
  const chatterbox = { ...settings, runtime: 'chatterbox', voice: await cloneVoice(), language: 'de', exaggeration: 0.3, sttModel: 'qwen3-asr' };
  assert.equal((await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(chatterbox) })).status, 200);
  const response = await fetch(`${base}/sessions/test/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'audio/pcm' }, body: JSON.stringify({ text: 'Der Build nutzt 4070 Megabyte.' }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/pcm');
  assert.equal(response.headers.get('x-sample-rate'), '24000');
  // Without a stream there is nothing to announce as incremental playback.
  assert.equal(response.headers.get('x-voice-streaming'), null);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 0, 255, 127]));
  assert.equal(nativeRequest.model, 'chatterbox');
  assert.equal(nativeRequest.language, 'de');
  assert.equal(nativeRequest.input, 'Der Build nutzt viertausendsiebzig Megabyte.');
  assert.equal(nativeRequest.options.exaggeration, '0.3');
  assert.equal(nativeRequest.voice_ref.type, 'base64');
  // The recognition model reaches the OpenAI-compatible transcription endpoint.
  await fetch(`${base}/sessions/test/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: new Uint8Array(pcmWav(Buffer.alloc(32))) });
  assert.ok(transcriptionBody.includes('name="model"\r\n\r\nqwen3-asr\r\n'));
  // A designed voice has no recording to clone from: refused on save, not on
  // every phrase of a conversation.
  const refused = await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...chatterbox, voice: 'design' }) });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /reference clone/);
  assert.throws(() => validateConfig({ ...chatterbox, language: 'ru' }), /Chatterbox speaks/);
  // Chatterbox is told a language; auto-detect would silently mean English.
  assert.throws(() => validateConfig({ ...chatterbox, language: 'auto' }), /needs an input language/);
  assert.equal(validateConfig({ ...chatterbox, language: 'nl' }).language, 'nl');
  assert.throws(() => validateConfig({ ...settings, sttModel: 'a model' }));
  assert.throws(() => validateConfig({ ...settings, exaggeration: 5 }));
});

test('Kokoro speaks with a voice of its own, at the speed chosen, and an agent can have one of its voices', async () => {
  const { createAgent, setVoice } = await import('../server/src/agents.js');
  const { createSession } = await import('../server/src/db.js');
  const kokoro = { ...settings, runtime: 'kokoro', voice: await cloneVoice(), kokoroVoice: 'bf_emma', speed: 1.15 };
  assert.equal((await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(kokoro) })).status, 200);
  const speak = (session: string) => fetch(`${base}/sessions/${session}/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'audio/pcm' }, body: JSON.stringify({ text: 'It costs 12 dollars.' }) });
  const response = await speak('test');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-sample-rate'), '24000');
  assert.equal(response.headers.get('x-voice-streaming'), null);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 0, 255, 127]));
  // The voice names the language, and the library voice saved for the other engines is not sent.
  assert.deepEqual(nativeRequest, { model: 'kokoro', input: 'It costs 12 dollars.', voice: 'bf_emma', speed: 1.15, response_format: 'wav', options: { seed: '42' } });
  // An agent with one of Kokoro's voices speaks with it; one with a library voice speaks as in the settings.
  const agent = createAgent({ name: 'Kokoro agent' });
  setVoice(agent.id, 'am_onyx');
  createSession({ id: 'kokoro-chat', title: 'Kokoro', workspace: agent.home, executor: 'host' });
  await (await speak('kokoro-chat')).arrayBuffer();
  assert.equal(nativeRequest.voice, 'am_onyx');
  setVoice(agent.id, await cloneVoice());
  await (await speak('kokoro-chat')).arrayBuffer();
  assert.equal(nativeRequest.voice, 'bf_emma');
  // And back on another engine, an agent's Kokoro voice is not taken for a library one.
  setVoice(agent.id, 'am_onyx');
  assert.equal((await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...kokoro, runtime: 'audio-cpp' }) })).status, 200);
  await (await speak('kokoro-chat')).arrayBuffer();
  assert.equal(nativeRequest.model, 'breeze');
  assert.equal(nativeRequest.reference_text, 'Reference voice.');
  assert.throws(() => setVoice(agent.id, 'xx_nobody'), /not in the voice library/);
  // Only its packaged voices, without the Japanese ones it cannot read, and the speeds the page offers.
  assert.throws(() => validateConfig({ ...kokoro, kokoroVoice: 'jf_alpha' }), /Kokoro's voices/);
  assert.throws(() => validateConfig({ ...kokoro, speed: 3 }), /speaking speed/);
  assert.deepEqual([validateConfig(settings).kokoroVoice, validateConfig(settings).speed], ['af_heart', 1]);
});

test('the spoken error line is made once when voice mode starts, kept, and read at error time without asking the speech model', async () => {
  const { existsSync, readdirSync } = await import('node:fs');
  const put = (patch: object) => fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, ...patch }) });
  const make = (text = 'An error occurred.', session = 'test') => fetch(`${base}/sessions/${session}/voice/error-line`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  const read = (text = 'An error occurred.', session = 'test') => fetch(`${base}/sessions/${session}/voice/error-line?text=${encodeURIComponent(text)}`);
  errorLineRetry.waitsMs = [0, 0];
  const files = () => existsSync(join(dir, 'voice')) ? readdirSync(join(dir, 'voice')).filter(name => name.endsWith('.wav')) : [];
  assert.equal((await put({ runtime: 'kokoro' })).status, 200);
  // Before voice mode has started there is no file, and that is said, not synthesized on the spot.
  const before = speechCalls;
  const missing = await read();
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /has not been made/);
  assert.equal(speechCalls, before);
  // Made at the start: one call to the engine, one file.
  const made = await make();
  assert.deepEqual(await made.json(), { ready: true, generated: true });
  assert.equal(speechCalls, before + 1);
  assert.equal(nativeRequest.input, 'An error occurred.');
  assert.equal(files().length, 1);
  // Read at error time: the stored WAV, and no call to the engine.
  const stored = await read();
  assert.equal(stored.status, 200);
  assert.equal(stored.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(wavPcm(Buffer.from(await stored.arrayBuffer())), Buffer.from([0, 0, 255, 127]));
  assert.equal(speechCalls, before + 1);
  // Every later start finds it and does not ask again.
  assert.deepEqual(await (await make()).json(), { ready: true, generated: false });
  assert.equal(speechCalls, before + 1);
  assert.equal(files().length, 1);
  // Another language is another line, and the first is still there for when the language is changed back.
  assert.equal((await read('Es ist ein Fehler aufgetreten.')).status, 404);
  assert.deepEqual(await (await make('Es ist ein Fehler aufgetreten.')).json(), { ready: true, generated: true });
  assert.equal(speechCalls, before + 2);
  assert.equal((await read()).status, 200);
  assert.equal(files().length, 2);
  // Another voice, or another engine, finds no line until the next start has made one.
  assert.equal((await put({ runtime: 'kokoro', kokoroVoice: 'bf_emma' })).status, 200);
  assert.equal((await read()).status, 404);
  assert.deepEqual(await (await make()).json(), { ready: true, generated: true });
  assert.equal(nativeRequest.voice, 'bf_emma');
  assert.equal((await put({ runtime: 'audio-cpp' })).status, 200);
  assert.equal((await read()).status, 404);
  // The speech model is not there at the start: nothing is stored, the failure is reported, and the line stays missing.
  assert.equal((await put({ runtime: 'kokoro', kokoroVoice: 'am_onyx', breezeUrl: 'http://127.0.0.1:9/v1/audio/speech' })).status, 200);
  const failed = await make();
  assert.equal(failed.status, 502);
  assert.ok((await failed.json()).error);
  assert.equal((await read()).status, 404);
  const count = files().length;
  // Not text for a line, and no speech synthesis to make it with.
  assert.equal((await make('')).status, 400);
  assert.equal((await make('x'.repeat(201))).status, 400);
  assert.equal((await read('')).status, 400);
  assert.equal((await put({ runtime: 'none', breezeUrl: '' })).status, 200);
  assert.equal((await make()).status, 409);
  assert.equal(files().length, count);
  assert.equal((await put({})).status, 200);
});

test('a failed spoken error line is tried again at the start, and again at every later start until it exists', async () => {
  const { readdirSync, writeFileSync: write } = await import('node:fs');
  const put = (patch: object) => fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, ...patch }) });
  const make = () => fetch(`${base}/sessions/test/voice/error-line`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'A line for retries.' }) });
  const read = () => fetch(`${base}/sessions/test/voice/error-line?text=${encodeURIComponent('A line for retries.')}`);
  errorLineRetry.waitsMs = [0, 0];
  const warned: string[] = [];
  const warn = console.warn; console.warn = (...args: unknown[]) => { warned.push(args.join(' ')); };
  try {
    assert.equal((await put({ runtime: 'kokoro', kokoroVoice: 'bm_fable' })).status, 200);
    // The model is up on the third try: one start, three calls, one file, a warning per failed try.
    let before = speechCalls; failSpeech = 2;
    assert.deepEqual(await (await make()).json(), { ready: true, generated: true });
    assert.equal(speechCalls - before, 3);
    assert.equal(warned.length, 2);
    assert.match(warned[0], /try 1 of 3.*HTTP 503/);
    assert.match(warned[1], /try 2 of 3/);
    assert.equal((await read()).status, 200);
    // Found at the next start: the engine is not asked, and a success stops the retrying.
    before = speechCalls;
    assert.deepEqual(await (await make()).json(), { ready: true, generated: false });
    assert.equal(speechCalls, before);
    // Another voice: the model fails on all three tries. The start reports it, nothing is stored, one warning per try.
    assert.equal((await put({ runtime: 'kokoro', kokoroVoice: 'bm_george' })).status, 200);
    warned.length = 0; before = speechCalls; failSpeech = 99;
    const failed = await make();
    assert.equal(failed.status, 502);
    assert.equal(speechCalls - before, 3);
    assert.equal(warned.length, 3);
    assert.match(warned[2], /try 3 of 3.*tried again when voice mode next starts/);
    assert.equal((await read()).status, 404);
    // The error time reads the file only, and does not ask the model while the line is missing.
    before = speechCalls;
    assert.equal((await read()).status, 404);
    assert.equal(speechCalls, before);
    // The next start tries again, on its own, without an error having happened, and makes it now that the model is up.
    failSpeech = 0; before = speechCalls;
    assert.deepEqual(await (await make()).json(), { ready: true, generated: true });
    assert.equal(speechCalls - before, 1);
    assert.equal((await read()).status, 200);
    // A damaged file is no line: it is made again, not served.
    const folder = join(dir, 'voice');
    for (const file of readdirSync(folder).filter(n => n.endsWith('.wav'))) write(join(folder, file), Buffer.from('broken'));
    assert.equal((await read()).status, 404);
    before = speechCalls;
    assert.deepEqual(await (await make()).json(), { ready: true, generated: true });
    assert.equal(speechCalls - before, 1);
    assert.equal((await read()).status, 200);
    // The waits between the tries are the ones set.
    errorLineRetry.waitsMs = [30, 60];
    assert.equal((await put({ runtime: 'kokoro', kokoroVoice: 'bm_lewis' })).status, 200);
    failSpeech = 2; const started = Date.now();
    assert.equal((await make()).status, 200);
    assert.ok(Date.now() - started >= 85, 'the tries wait as long as set');
  } finally {
    console.warn = warn; failSpeech = 0; errorLineRetry.waitsMs = [1000, 3000];
    await put({});
  }
});

test('an error that comes while the line is still being made waits for it, and a line that is not 24 kHz audio is not kept', async () => {
  const { readdirSync, rmSync, statSync, utimesSync } = await import('node:fs');
  const folder = join(dir, 'voice');
  const wavs = () => existsSync(folder) ? readdirSync(folder).filter(n => n.endsWith('.wav')) : [];
  const put = (patch: object) => fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, ...patch }) });
  const make = (text: string) => fetch(`${base}/sessions/test/voice/error-line`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  const read = (text: string) => fetch(`${base}/sessions/test/voice/error-line?text=${encodeURIComponent(text)}`);
  errorLineRetry.waitsMs = [0, 0];
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal((await put({ runtime: 'kokoro', kokoroVoice: 'af_nova' })).status, 200);
    // The first engine call is slow: the error asks for the line while it is made, and gets it, not a 404.
    slowSpeechMs = 300;
    const making = make('Waiting for the line.');
    await new Promise(r => setTimeout(r, 80));
    const early = await read('Waiting for the line.');
    assert.equal(early.status, 200);
    assert.equal(early.headers.get('content-type'), 'audio/wav');
    assert.equal((await making).status, 200);
    // A line that is being made and fails is still a 404 for the error, which then shows the text only.
    // The wait between the tries keeps the make in flight (the engine answers a failure at once), so the read has to wait for it.
    failSpeech = 99; errorLineRetry.waitsMs = [300, 0];
    const failing = make('Waiting in vain.');
    await new Promise(r => setTimeout(r, 30));
    const askedAt = Date.now();
    assert.equal((await read('Waiting in vain.')).status, 404);
    assert.ok(Date.now() - askedAt >= 200, 'the read waited for the make that failed');
    assert.equal((await failing).status, 502);
    failSpeech = 0; slowSpeechMs = 0; errorLineRetry.waitsMs = [0, 0];
    // Used lines are the ones kept: a line used after eight newer ones were made survives, the least recently used goes.
    for (const name of wavs()) rmSync(join(folder, name));
    const named = async (text: string) => { const before = new Set(wavs()); assert.equal((await make(text)).status, 200); return wavs().find(n => !before.has(n))!; };
    const age = (name: string, secondsAgo: number) => { const at = new Date(Date.now() - secondsAgo * 1000); utimesSync(join(folder, name), at, at); };
    const used = await named('Used often.');
    age(used, 1000);
    const others: string[] = [];
    for (let i = 1; i <= 7; i++) { const name = await named(`Line number ${i}.`); age(name, 500 - i); others.push(name); }
    assert.equal(wavs().length, 8);
    assert.deepEqual(await (await make('Used often.')).json(), { ready: true, generated: false });
    assert.ok(statSync(join(folder, used)).mtimeMs > Date.now() - 5000, 'a hit marks the line as used');
    await named('The ninth line.');
    assert.ok(wavs().includes(used), 'the line used last is kept');
    assert.ok(!wavs().includes(others[0]), 'the one unused longest is cleared away');
    // The same on a read at error time.
    age(used, 2000);
    assert.equal((await read('Used often.')).status, 200);
    assert.ok(statSync(join(folder, used)).mtimeMs > Date.now() - 5000);
    // Breeze answering with something that is not 24 kHz PCM stores nothing, with the errors /voice/speech gives.
    assert.equal((await put({ runtime: 'audio-cpp' })).status, 200);
    const count = wavs().length;
    badSpeech = 'json';
    let refused = await make('Not audio.');
    assert.equal(refused.status, 502);
    assert.match((await refused.json()).error, /Expected PCM audio from the Breeze API/);
    badSpeech = 'rate';
    refused = await make('Wrong rate.');
    assert.equal(refused.status, 502);
    assert.match((await refused.json()).error, /Unsupported Breeze sample rate: 16000/);
    assert.equal(wavs().length, count);
    assert.equal((await read('Wrong rate.')).status, 404);
  } finally {
    console.warn = warn; failSpeech = 0; slowSpeechMs = 0; badSpeech = undefined; errorLineRetry.waitsMs = [1000, 3000];
    await put({});
  }
});

test('VAD settings preserve defaults, accept tuning and reject invalid thresholds', () => {
  assert.equal(validateConfig(settings).vad?.redemptionMs, 1000);
  assert.equal(validateConfig({...settings, vad:{redemptionMs:500}}).vad?.redemptionMs, 500);
  assert.equal(validateConfig({...settings, vad:{redemptionMs:500}}).vad?.positiveSpeechThreshold, 0.65);
  for (const vad of [{redemptionMs:0}, {minSpeechMs:NaN}, {preSpeechPadMs:1001}, {positiveSpeechThreshold:0.3,negativeSpeechThreshold:0.4}]) {
    assert.throws(() => validateConfig({...settings,vad}));
  }
});

test('every language a runtime accepts is one the add-on can offer', () => {
  for (const code of CHATTERBOX_LANGUAGES) assert.ok(INPUT_LANGUAGES.some(([value]) => value === code), `${code} is missing from the input languages`);
  assert.equal(validateConfig({ ...settings, language: 'sw' }).language, 'sw');
});

test('a WAV whose data chunk carries a placeholder size keeps its samples', () => {
  const wav = pcmWav(Buffer.from([0, 0, 255, 127]));
  assert.deepEqual(wavPcm(wav), Buffer.from([0, 0, 255, 127]));
  for (const size of [0, 0xffffffff]) {
    const placeholder = Buffer.from(wav);
    placeholder.writeUInt32LE(size, 40);
    assert.deepEqual(wavPcm(placeholder), Buffer.from([0, 0, 255, 127]));
  }
  // A truncated fmt chunk is reported as unsupported audio, not as a read past the end.
  const truncated = Buffer.concat([Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVE', 'ascii'), Buffer.alloc(40), Buffer.from('fmt ', 'ascii'), Buffer.alloc(8)]);
  assert.throws(() => wavPcm(truncated), /Expected mono 24 kHz 16-bit audio/);
  // Samples ahead of their fmt chunk, or in a non-PCM encoding, are refused.
  const dataFirst = Buffer.concat([wav.subarray(0, 12), wav.subarray(36), wav.subarray(12, 36)]);
  assert.throws(() => wavPcm(dataFirst), /Expected mono 24 kHz 16-bit audio/);
  const float = Buffer.from(wav);
  float.writeUInt16LE(3, 20);
  assert.throws(() => wavPcm(float), /Expected mono 24 kHz 16-bit audio/);
});

test('connecting the managed voice drops a recognition model from another runtime', async () => {
  const saved = await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, runtime: 'chatterbox', voice: await cloneVoice(), language: 'de', sttModel: 'qwen3-asr' }) });
  assert.equal(saved.status, 200);
  // Whisper.cpp is sent this field verbatim; another runtime's model id would
  // reach it in the multipart body of every transcription.
  assert.equal(connectManagedVoice().sttModel, '');
  assert.equal((await (await fetch(`${base}/voice`)).json()).sttModel, '');
});

test('connecting the managed voice points the settings at the engines it was built with', async () => {
  const voice = await cloneVoice();
  const put = (patch: object) => fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, voice, ...patch }) });
  assert.equal((await put({ language: 'auto' })).status, 200);
  // Whisper: its own endpoint, and no model field in the request.
  const whisper = connectManagedVoice({ tts: 'breeze', asr: 'whisper', asrModel: 'small' });
  assert.deepEqual([whisper.runtime, whisper.whisperUrl, whisper.breezeUrl, whisper.sttModel], ['audio-cpp', 'http://127.0.0.1:8188/inference', 'http://127.0.0.1:7862/v1/audio/speech', '']);
  // Qwen3-ASR: audio.cpp's transcription endpoint, with the id of the model it loaded.
  const qwen = connectManagedVoice({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' });
  assert.deepEqual([qwen.runtime, qwen.whisperUrl, qwen.sttModel, qwen.language], ['audio-cpp', 'http://127.0.0.1:7862/v1/audio/transcriptions', 'qwen3-asr', 'auto']);
  assert.equal((await (await fetch(`${base}/voice`)).json()).managed, true);
  // Chatterbox refuses to guess a language: auto-detect becomes one it speaks, a chosen one stays.
  const chatterbox = connectManagedVoice({ tts: 'chatterbox', asr: 'qwen3-asr', asrModel: '1.7b' });
  assert.deepEqual([chatterbox.runtime, chatterbox.language, chatterbox.sttModel], ['chatterbox', 'en', 'qwen3-asr']);
  const shown = await (await fetch(`${base}/voice`)).json();
  assert.deepEqual([shown.runtime, shown.managed], ['chatterbox', true], 'the leases load the model the saved engine speaks with');
  await put({ language: 'de' });
  assert.equal(connectManagedVoice({ tts: 'chatterbox', asr: 'whisper', asrModel: 'base' }).language, 'de');
  // Back to Breeze keeps the language and drops Chatterbox's runtime.
  assert.deepEqual([connectManagedVoice().runtime, connectManagedVoice().language], ['audio-cpp', 'de']);
  // Kokoro reads the language from its voice: the recognition language stays as it was.
  const kokoro = connectManagedVoice({ tts: 'kokoro', asr: 'whisper', asrModel: 'base' });
  assert.deepEqual([kokoro.runtime, kokoro.language, kokoro.breezeUrl], ['kokoro', 'de', 'http://127.0.0.1:7862/v1/audio/speech']);
  assert.equal((await (await fetch(`${base}/voice`)).json()).managed, true);
  // Put on the CPU it is spoken to in the CPU process, which is managed just the same.
  const onCpu = connectManagedVoice({ tts: 'kokoro', ttsDevice: 'cpu', asr: 'qwen3-asr', asrModel: '0.6b' });
  assert.deepEqual([onCpu.runtime, onCpu.breezeUrl, onCpu.whisperUrl], ['kokoro', 'http://127.0.0.1:7863/v1/audio/speech', 'http://127.0.0.1:7863/v1/audio/transcriptions']);
  assert.equal((await (await fetch(`${base}/voice`)).json()).managed, true);
});

test('recognition alone: nothing is spoken, and dictation still has its transcription', async () => {
  const put = (patch: object) => fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, ...patch }) });
  // Connecting the managed services of a choice without speech synthesis saves no address to speak to.
  const whisper = connectManagedVoice({ tts: 'none', asr: 'whisper', asrModel: 'base' });
  assert.deepEqual([whisper.runtime, whisper.breezeUrl, whisper.whisperUrl, whisper.sttModel, whisper.enabled, whisper.managed], ['none', '', 'http://127.0.0.1:8188/inference', '', true, true]);
  const qwen = connectManagedVoice({ tts: 'none', asr: 'qwen3-asr', asrModel: '0.6b' });
  assert.deepEqual([qwen.runtime, qwen.breezeUrl, qwen.whisperUrl, qwen.sttModel], ['none', '', 'http://127.0.0.1:7863/v1/audio/transcriptions', 'qwen3-asr']);
  // Beside a speech engine, Qwen3-ASR is on the GPU server's port, or on the CPU server's by choice.
  assert.equal(connectManagedVoice({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' }).whisperUrl, 'http://127.0.0.1:7862/v1/audio/transcriptions');
  assert.equal(connectManagedVoice({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b', asrDevice: 'cpu' }).whisperUrl, 'http://127.0.0.1:7863/v1/audio/transcriptions');
  connectManagedVoice({ tts: 'none', asr: 'whisper', asrModel: 'base' });
  // The page is told there is nothing to speak with, so that voice mode is not offered; dictation is.
  const shown = await (await fetch(`${base}/voice`)).json();
  assert.deepEqual([shown.enabled, shown.speech, shown.runtime, shown.managed], [true, false, 'none', false]);
  // Replies are not synthesized, and the answer says why instead of failing on an address that is not there.
  const spoken = await fetch(`${base}/sessions/test/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"Hello"}' });
  assert.equal(spoken.status, 409);
  assert.match((await spoken.json()).error, /Speech synthesis is not installed/);
  // What was heard is still transcribed: that is dictation. The tests' Whisper stands where the managed one would.
  assert.equal((await put({ runtime: 'none', breezeUrl: '' })).status, 200);
  const transcribed = await fetch(`${base}/sessions/test/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: new Uint8Array(pcmWav(Buffer.alloc(32))) });
  assert.deepEqual(await transcribed.json(), { text: 'Test the session.' });
  // The settings are saved with no speech address only when there is no speech synthesis.
  assert.equal((await put({ runtime: 'none', breezeUrl: '' })).status, 200);
  assert.equal((await put({ runtime: 'audio-cpp', breezeUrl: '' })).status, 400);
  assert.equal((await put({ runtime: 'none', breezeUrl: 'ftp://nowhere' })).status, 400);
  // Back to speech: spoken again, and the page is told so.
  assert.equal((await put({})).status, 200);
  assert.equal((await (await fetch(`${base}/voice`)).json()).speech, true);
});

test('without Docker the setup says only that Docker is needed: recognition alone needs no GPU, and the requirement of speech synthesis is said where it applies', async () => {
  // No Docker socket here, whatever this machine has.
  const state = await (await fetch(`${base}/voice/install`)).json();
  assert.deepEqual([state.available, state.state, state.busy], [false, 'unavailable', false]);
  assert.equal(state.error, 'Automatic voice setup requires access to Docker.');
  assert.doesNotMatch(state.error, /GPU|NVIDIA/);
});

test('without Docker an uninstall says the same as an install, and leaves the settings alone', async () => {
  const before = await (await fetch(`${base}/voice`)).json();
  for (const removeData of [false, true]) {
    const answer = await fetch(`${base}/voice/uninstall`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ removeData }) });
    assert.equal(answer.status, 400);
    assert.equal((await answer.json()).error, 'Docker is unavailable');
  }
  const install = await fetch(`${base}/voice/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal((await install.json()).error, 'Docker is unavailable');
  assert.deepEqual(await (await fetch(`${base}/voice`)).json(), before);
});

test('install takes the engines to build, and refuses a choice the installer does not make', async () => {
  const post = (body: object) => fetch(`${base}/voice/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const body of [{ tts: 'piper', asr: 'whisper', asrModel: 'base' }, { tts: 'breeze', asr: 'whisper', asrModel: '1.7b' }, { tts: 'breeze' }, { asr: 'qwen3-asr', asrModel: '0.6b' }]) {
    const answer = await post(body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.match((await answer.json()).error, /Choose a supported speech/);
  }
  // Nothing was started, so there is no setup to wait for either.
  assert.equal((getDb().prepare("SELECT value FROM settings WHERE key='voice_setup_pending'").get() as any)?.value, undefined);
});

test('the hardware check reports the GPUs and what it would suggest, and degrades to the original combination without a tool', async () => {
  const smi = join(dir, 'nvidia-smi');
  writeFileSync(smi, '#!/bin/sh\nprintf "0, Test GPU A, 12288, 11000\\n1, Test GPU B, 24576, 24000\\n"\n');
  chmodSync(smi, 0o755);
  process.env.NVIDIA_SMI = smi;
  // What the host has is told, not read from the machine the tests run on.
  (await import('../server/src/extensions/voice-service.js')).hostReader.read = () => ({ totalMiB: 16384, freeMiB: 8192, threads: 8 });
  const found = await (await fetch(`${base}/voice/hardware`)).json();
  assert.deepEqual(found.gpus.map((g: any) => [g.index, g.name, g.totalMiB, g.freeMiB]), [[0, 'Test GPU A', 12288, 11000], [1, 'Test GPU B', 24576, 24000]]);
  assert.deepEqual([found.source, found.selected, found.reserveMiB], ['host', 1, 0]);
  assert.deepEqual(found.suggestion, { tts: 'breeze', asr: 'qwen3-asr', asrModel: '1.7b' });
  process.env.NVIDIA_SMI = join(dir, 'missing-nvidia-smi');
  const none = await fetch(`${base}/voice/hardware`);
  assert.equal(none.status, 200);
  const empty = await none.json();
  // No tool and no Docker is no GPU, said plainly: what is suggested is Kokoro and recognition on the CPU, sized to the host.
  assert.deepEqual([empty.gpus, empty.source, empty.selected, empty.checked, empty.cpuOnly], [[], 'none', null, true, true]);
  assert.equal(empty.error, 'host: nvidia-smi was not found; docker: no GPU available');
  assert.deepEqual(empty.host, { totalMiB: 16384, freeMiB: 8192, threads: 8 });
  assert.deepEqual(empty.suggestion, { tts: 'kokoro', ttsDevice: 'cpu', asr: 'qwen3-asr', asrModel: '0.6b' });
  delete process.env.NVIDIA_SMI;
});

test('speaking instructions: the built-in text is offered, a custom one is saved, and blank or equal goes back to the built-in', async () => {
  const put = (responseInstructions: unknown) => fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, responseInstructions }) });
  const get = async () => (await fetch(`${base}/voice`)).json();
  // Nothing saved: the server's own text is what the page shows and resets to.
  await put(undefined);
  let shown = await get();
  assert.equal(shown.responseInstructions, DEFAULT_VOICE_INSTRUCTIONS);
  assert.equal(shown.defaultResponseInstructions, DEFAULT_VOICE_INSTRUCTIONS);
  assert.equal(shown.responseInstructionsOff, false);
  assert.equal(getVoiceInstructions(), '');
  // A custom text is saved trimmed, and is what every turn is then given.
  const saved = await put('  Answer in one word.\n');
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).responseInstructions, 'Answer in one word.');
  assert.equal(getVoiceInstructions(), 'Answer in one word.');
  shown = await get();
  assert.equal(shown.responseInstructions, 'Answer in one word.');
  assert.equal(shown.defaultResponseInstructions, DEFAULT_VOICE_INSTRUCTIONS, 'still there to go back to');
  // Empty text, or the built-in text sent back, is not saved as a custom one: the built-in instructions then follow the portal's updates.
  for (const back of ['', '   ', DEFAULT_VOICE_INSTRUCTIONS, `${DEFAULT_VOICE_INSTRUCTIONS}\n`]) {
    await put('Answer in one word.');
    assert.equal((await put(back)).status, 200);
    assert.equal(getVoiceInstructions(), '', JSON.stringify(back));
    assert.equal((await get()).responseInstructions, DEFAULT_VOICE_INSTRUCTIONS);
  }
  // Connecting the managed voice saves the settings again, and keeps it.
  await put('Answer in one word.');
  assert.equal(connectManagedVoice().responseInstructions, 'Answer in one word.');
  assert.equal(getVoiceInstructions(), 'Answer in one word.');
  // Text that cannot be, and a size that no turn should carry.
  assert.equal((await put(42)).status, 400);
  assert.equal((await put('x'.repeat(8001))).status, 400);
  assert.equal((await put('x'.repeat(8000))).status, 200);
  assert.equal(getVoiceInstructions(), 'x'.repeat(8000));
  await put('');
});
test('the providers that skip thinking on the first spoken call: the default list is offered, another is saved, and the default sent back is not', async () => {
  const put = (skipThinkingProviders: unknown) => fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, skipThinkingProviders }) });
  const get = async () => (await fetch(`${base}/voice`)).json();
  await put(undefined);
  let shown = await get();
  assert.deepEqual(shown.skipThinkingProviders, [...DEFAULT_SKIP_THINKING_PROVIDERS]);
  assert.deepEqual(shown.defaultSkipThinkingProviders, [...DEFAULT_SKIP_THINKING_PROVIDERS]);
  assert.equal(getSkipThinkingProviders(), undefined);
  // Trimmed, each once, and what the first call then reads.
  assert.equal((await put([' llama-swap ', 'my-gateway', 'llama-swap', ''])).status, 200);
  assert.deepEqual(getSkipThinkingProviders(), ['llama-swap', 'my-gateway']);
  shown = await get();
  assert.deepEqual(shown.skipThinkingProviders, ['llama-swap', 'my-gateway']);
  // Kept when the managed voice saves the settings again.
  assert.deepEqual(connectManagedVoice().skipThinkingProviders, ['llama-swap', 'my-gateway']);
  // Empty is a choice: thinking stays on everywhere.
  await put([]);
  assert.deepEqual(getSkipThinkingProviders(), []);
  assert.deepEqual((await get()).skipThinkingProviders, []);
  // The default list sent back, in any order, is not saved: it then follows the portal's updates.
  await put([...DEFAULT_SKIP_THINKING_PROVIDERS].reverse());
  assert.equal(getSkipThinkingProviders(), undefined);
  // What is not a list of provider names.
  for (const bad of ['llama-swap', [42], ['two words'], ['a/b'], Array(51).fill('x')]) assert.equal((await put(bad)).status, 400, JSON.stringify(bad).slice(0, 40));
  await put(undefined);
});
test('the voice model: none by default, a provider/model is saved and read back, and anything else is refused', async () => {
  const put = (voiceModel: unknown) => fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, voiceModel }) });
  await put(undefined);
  assert.equal(getVoiceModel(), undefined);
  assert.equal((await put(' fast/small-model:q4 ')).status, 200);
  assert.deepEqual(getVoiceModel(), { provider: 'fast', modelId: 'small-model:q4' });
  assert.equal(((await (await fetch(`${base}/voice`)).json()) as any).voiceModel, 'fast/small-model:q4');
  // Kept when the managed voice saves the settings again.
  assert.equal(connectManagedVoice().voiceModel, 'fast/small-model:q4');
  // A model id may hold slashes of its own: only the first one ends the provider.
  await put('router/vendor/model');
  assert.deepEqual(getVoiceModel(), { provider: 'router', modelId: 'vendor/model' });
  // Empty is the way back to the chat's own.
  await put('');
  assert.equal(getVoiceModel(), undefined);
  for (const bad of [42, 'no-slash', '/model', 'provider/', 'two words/model', 'x'.repeat(301)]) assert.equal((await put(bad)).status, 400, JSON.stringify(bad).slice(0, 40));
  await put(undefined);
});
test('VOICE_RESPONSE_INSTRUCTIONS=false is shown to the page, and leaves a saved text alone', async () => {
  const previous = process.env.VOICE_RESPONSE_INSTRUCTIONS;
  try {
    await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, responseInstructions: 'Answer in one word.' }) });
    process.env.VOICE_RESPONSE_INSTRUCTIONS = 'false';
    const shown = await (await fetch(`${base}/voice`)).json();
    assert.equal(shown.responseInstructionsOff, true);
    assert.equal(shown.responseInstructions, 'Answer in one word.');
    process.env.VOICE_RESPONSE_INSTRUCTIONS = 'true';
    assert.equal((await (await fetch(`${base}/voice`)).json()).responseInstructionsOff, false);
  } finally {
    if (previous === undefined) delete process.env.VOICE_RESPONSE_INSTRUCTIONS;
    else process.env.VOICE_RESPONSE_INSTRUCTIONS = previous;
    await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
  }
});
