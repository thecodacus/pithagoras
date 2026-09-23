import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { speechChunks, newSpeech } from '../web/src/voice.js';
const dir = mkdtempSync(join(tmpdir(), 'pithagoras-voice-'));
process.env.DATA_DIR = dir;
// Background filler rendering has its own tests; here it would outlive the database.
process.env.VOICE_STATUS_SPEECH = 'false';
const { voiceRouter, pcmWav, validateConfig } = await import('../server/src/api/voice.js');
const { getDb } = await import('../server/src/db.js');
const upstream = express();
let calls = 0;
let busyAttempts = 0;
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
upstream.post('/v1/audio/speech', express.raw({ type: () => true }), (req, res) => {
  if (req.get('content-type') === 'application/json') {
    nativeRequest = JSON.parse(req.body.toString());
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
  getDb().close(); rmSync(dir, { recursive: true, force: true });
});
const settings = { enabled: true, whisperUrl: `http://127.0.0.1:${port}/inference`, breezeUrl: `http://127.0.0.1:${port}/v1/audio/speech`, instruction: 'A calm English voice.' };
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
test('Aria sends the installed reference and transcript; missing references never fall back to a designed voice', async () => {
  const save = await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, voice: 'aria', cfgScale: 1 }) });
  assert.equal(save.status, 200);
  const speak = () => fetch(`${base}/sessions/test/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hello from Aria.' }) });
  const before = calls;
  assert.equal((await speak()).status, 502);
  assert.equal(calls, before);
  mkdirSync(join(dir, 'voices'));
  writeFileSync(join(dir, 'voices/aria.wav'), pcmWav(Buffer.alloc(32)));
  writeFileSync(join(dir, 'voices/aria.txt'), 'This is the exact reference transcript.');
  assert.equal((await speak()).status, 200);
  assert.match(speechBody, /name="ref_audio"; filename="aria.wav"/);
  assert.match(speechBody, /name="ref_text"/);
  assert.ok(speechBody.includes('name="cfg_scale"\r\n\r\n1\r\n'));
  assert.match(speechBody, /This is the exact reference transcript\./);
  assert.throws(() => validateConfig({ ...settings, voice: '../other' }));
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

test('history loading, partial replies and reconnect replay never repeat speech', () => {
  const seen = new Set<string>();
  const reply = (id: string, done: boolean) => ({ kind: 'assistant' as const, id, done, text: 'Hello.', thinking: 'Private reasoning' });
  assert.deepEqual(newSpeech([reply('a1', true), reply('a30', false)], 20, seen), []);
  assert.deepEqual(newSpeech([reply('a1', true), reply('a30', true)], 20, seen), ['Hello.']);
  assert.deepEqual(newSpeech([reply('a5', true), reply('a30', true)], 20, seen), []);
  assert.deepEqual(newSpeech([reply('a40', true)], 20, seen), ['Hello.']);
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
  await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, runtime: 'audio-cpp', voice: 'aria', cfgScale: 1 }) });
  // The earlier missing-reference test removes its fixture.
  mkdirSync(join(dir, 'voices'), { recursive: true });
  writeFileSync(join(dir, 'voices/aria.wav'), pcmWav(Buffer.alloc(32)));
  writeFileSync(join(dir, 'voices/aria.txt'), 'Reference voice.');
  const response = await fetch(`${base}/sessions/test/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'audio/pcm' }, body: JSON.stringify({ text: 'Speak while generating.' }) });
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-voice-streaming'), 'true');
  assert.equal(nativeRequest.reference_text, 'Reference voice.');
  assert.equal(nativeRequest.voice_ref.type, 'base64'); assert.equal(nativeRequest.stream_format, 'audio');
  assert.equal(nativeRequest.options.guidance_scale, '1'); await response.arrayBuffer();
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

test('VAD settings preserve defaults, accept tuning and reject invalid thresholds', () => {
  assert.equal(validateConfig(settings).vad?.redemptionMs, 1000);
  assert.equal(validateConfig({...settings, vad:{redemptionMs:500}}).vad?.redemptionMs, 500);
  assert.equal(validateConfig({...settings, vad:{redemptionMs:500}}).vad?.positiveSpeechThreshold, 0.65);
  for (const vad of [{redemptionMs:0}, {minSpeechMs:NaN}, {preSpeechPadMs:1001}, {positiveSpeechThreshold:0.3,negativeSpeechThreshold:0.4}]) {
    assert.throws(() => validateConfig({...settings,vad}));
  }
});

test('filler clips are listed in the voice language and served immutably from disk', async () => {
  await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, language: 'auto' }) });
  const list = await (await fetch(`${base}/voice/clips?languages=de-DE,en`)).json();
  assert.equal(list.language, 'de');
  assert.match(list.version, /^[0-9a-f]{32}$/);
  assert.ok(list.clips.length && list.clips.every((clip: any) => !clip.ready));
  assert.equal(list.notices.compactionDone, 'Die Zusammenfassung ist fertig. Ich kann weitermachen.');
  const clip = list.clips[0];
  assert.equal((await fetch(`${base}/voice/clips/${list.version}/${clip.hash}`)).status, 404);
  mkdirSync(join(dir, 'voice-clips', list.version), { recursive: true });
  writeFileSync(join(dir, 'voice-clips', list.version, `${clip.hash}.pcm`), Buffer.from([0, 0, 255, 127]));
  const served = await fetch(`${base}/voice/clips/${list.version}/${clip.hash}`);
  assert.equal(served.headers.get('content-type'), 'audio/pcm');
  assert.match(served.headers.get('cache-control') ?? '', /immutable/);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), Buffer.from([0, 0, 255, 127]));
  assert.ok((await (await fetch(`${base}/voice/clips?languages=de`)).json()).clips[0].ready);
  // Another voice is another version, so its clips can never be served for this one.
  await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, language: 'auto', instruction: 'A different voice.' }) });
  assert.notEqual((await (await fetch(`${base}/voice/clips?languages=de`)).json()).version, list.version);
  assert.equal((await fetch(`${base}/voice/clips/..%2F..%2Fportal.db/${clip.hash}`)).status, 404);
});
