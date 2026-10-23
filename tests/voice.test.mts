import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { speechChunks } from '../core/web/src/voice.js';
import { inProcessHome } from "./helpers.mts";
inProcessHome('pithagoras-voice-');
const { voiceRouter, wavPcm, validateConfig } = await import('../core/server/src/api/voice.js');
const host = await import('../core/server/src/extension-host.js');
const { getDb, putSetting, getSkipThinkingProviders, getVoiceInstructions, getVoiceModel } = await import('../core/server/src/db.js');
const { DEFAULT_SKIP_THINKING_PROVIDERS, DEFAULT_VOICE_INSTRUCTIONS } = await import('../core/server/src/pi/voice-first.js');
const app = express();
app.use((req, res, next) => (req.path.startsWith('/api/x/') ? next() : express.json()(req, res, next)));
app.use('/api/x', host.extensionRoutes);
app.use('/api', voiceRouter());
const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
after(async () => {
  await host.stopServerHalves();
  await new Promise<void>(r => server.close(() => r()));
  getDb().close();
});
/** A mono 16-bit WAV of `pcm` at `rate`. */
function wav(pcm: Buffer, rate = 24000): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
const put = (body: object) => fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const transcribe = () => fetch(`${base}/sessions/test/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: new Uint8Array(wav(Buffer.alloc(32), 16000)) });
const speak = () => fetch(`${base}/sessions/test/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"Hello"}' });

test('voice mode is off until it has a source, and checks that the session exists', async () => {
  assert.equal((await (await fetch(`${base}/voice`)).json()).enabled, false);
  assert.equal((await speak()).status, 409);
  // Chosen by name, before its server half runs.
  putSetting('voice', JSON.stringify({ provider: 'test-speaker' }));
  assert.equal((await (await fetch(`${base}/voice`)).json()).enabled, true);
  assert.equal((await fetch(`${base}/sessions/missing/voice/transcribe`, { method: 'POST' })).status, 404);
  getDb().prepare("INSERT INTO sessions (id,title,workspace,executor,status,created_at,updated_at) VALUES ('test','Voice','/tmp','host','idle','now','now')").run();
  assert.equal((await fetch(`${base}/sessions/test/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: 'invalid' })).status, 400);
  assert.equal((await transcribe()).status, 503, 'its server half does not run');
});
test('spoken chunks omit code and preserve long prose without exceeding the API bound', () => {
  assert.deepEqual(speechChunks('Hello **there**. [Read this](https://example.com) ```js\nsecret()\n```'), ['Hello there. Read this Code is shown in the transcript.']);
  const text = 'word '.repeat(1000).trim(); const chunks = speechChunks(text);
  assert.ok(chunks.every(c => c.length <= 600)); assert.equal(chunks.join(' '), text);
  assert.equal(speechChunks('a'.repeat(1600)).join(''), 'a'.repeat(1600));
});

test('VAD settings preserve defaults, accept tuning and reject invalid thresholds', () => {
  assert.equal(validateConfig({}).vad?.redemptionMs, 1000);
  assert.equal(validateConfig({vad:{redemptionMs:500}}).vad?.redemptionMs, 500);
  assert.equal(validateConfig({vad:{redemptionMs:500}}).vad?.positiveSpeechThreshold, 0.65);
  for (const vad of [{redemptionMs:0}, {minSpeechMs:NaN}, {preSpeechPadMs:1001}, {positiveSpeechThreshold:0.3,negativeSpeechThreshold:0.4}]) {
    assert.throws(() => validateConfig({vad}));
  }
});

test('voice conversations are on unless a save switches them off, with true or false', () => {
  assert.equal(validateConfig({}).conversation, true);
  assert.equal(validateConfig({conversation:false}).conversation, false);
  for (const conversation of ['no', 0]) assert.throws(() => validateConfig({conversation}), /switched on with true and off with false/);
});

test('a WAV whose data chunk carries a placeholder size keeps its samples', () => {
  const placeheld = wav(Buffer.from([0, 0, 255, 127]));
  assert.deepEqual(wavPcm(placeheld, 'Speaker'), Buffer.from([0, 0, 255, 127]));
  for (const size of [0, 0xffffffff]) {
    const placeholder = Buffer.from(placeheld);
    placeholder.writeUInt32LE(size, 40);
    assert.deepEqual(wavPcm(placeholder, 'Speaker'), Buffer.from([0, 0, 255, 127]));
  }
  // A truncated fmt chunk is reported as unsupported audio, not as a read past the end.
  const truncated = Buffer.concat([Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVE', 'ascii'), Buffer.alloc(40), Buffer.from('fmt ', 'ascii'), Buffer.alloc(8)]);
  assert.throws(() => wavPcm(truncated, 'Speaker'), /Expected mono 24 kHz 16-bit audio from Speaker/);
  // Samples ahead of their fmt chunk, or in a non-PCM encoding, are refused.
  const dataFirst = Buffer.concat([placeheld.subarray(0, 12), placeheld.subarray(36), placeheld.subarray(12, 36)]);
  assert.throws(() => wavPcm(dataFirst, 'Speaker'), /Expected mono 24 kHz 16-bit audio/);
  const float = Buffer.from(placeheld);
  float.writeUInt16LE(3, 20);
  assert.throws(() => wavPcm(float, 'Speaker'), /Expected mono 24 kHz 16-bit audio/);
});

test('recognition alone: nothing is spoken, and dictation still has its transcription', async () => {
  const speaker = fileURLToPath(new URL('./fixtures/extensions/speaker/server.js', import.meta.url));
  await host.syncServerHalves([{ name: 'test-speaker', version: '0.1.0', file: speaker, rev: '1' }]);
  const settings = (body: object) => fetch(`${base}/x/test-speaker/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  // A source that recognises speech alone: the page is told there is nothing to speak with, so that voice mode is not
  // offered; dictation is.
  await settings({ speaks: false });
  const shown = await (await fetch(`${base}/voice`)).json();
  assert.deepEqual([shown.enabled, shown.speech], [true, false]);
  // Replies are not synthesized, and the answer says why.
  const spoken = await speak();
  assert.equal(spoken.status, 409);
  assert.match((await spoken.json()).error, /recognises speech alone/);
  // What was heard is still transcribed: that is dictation.
  assert.deepEqual(await (await transcribe()).json(), { text: 'Heard by the speaker.' });
  // Back to speech: spoken again, and the page is told so.
  await settings({ speaks: true });
  assert.equal((await (await fetch(`${base}/voice`)).json()).speech, true);
  assert.equal((await speak()).status, 200);
});

test('speaking instructions: the built-in text is offered, a custom one is saved, and blank or equal goes back to the built-in', async () => {
  const save = (responseInstructions: unknown) => put({ responseInstructions });
  const get = async () => (await fetch(`${base}/voice`)).json();
  // Nothing saved: the server's own text is what the page shows and resets to.
  await save(undefined);
  let shown = await get();
  assert.equal(shown.responseInstructions, DEFAULT_VOICE_INSTRUCTIONS);
  assert.equal(shown.defaultResponseInstructions, DEFAULT_VOICE_INSTRUCTIONS);
  assert.equal(shown.responseInstructionsOff, false);
  assert.equal(getVoiceInstructions(), '');
  // A custom text is saved trimmed, and is what every turn is then given.
  const saved = await save('  Answer in one word.\n');
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).responseInstructions, 'Answer in one word.');
  assert.equal(getVoiceInstructions(), 'Answer in one word.');
  shown = await get();
  assert.equal(shown.responseInstructions, 'Answer in one word.');
  assert.equal(shown.defaultResponseInstructions, DEFAULT_VOICE_INSTRUCTIONS, 'still there to go back to');
  // Empty text, or the built-in text sent back, is not saved as a custom one: the built-in instructions then follow the portal's updates.
  for (const back of ['', '   ', DEFAULT_VOICE_INSTRUCTIONS, `${DEFAULT_VOICE_INSTRUCTIONS}\n`]) {
    await save('Answer in one word.');
    assert.equal((await save(back)).status, 200);
    assert.equal(getVoiceInstructions(), '', JSON.stringify(back));
    assert.equal((await get()).responseInstructions, DEFAULT_VOICE_INSTRUCTIONS);
  }
  // Text that cannot be, and a size that no turn should carry.
  assert.equal((await save(42)).status, 400);
  assert.equal((await save('x'.repeat(8001))).status, 400);
  assert.equal((await save('x'.repeat(8000))).status, 200);
  assert.equal(getVoiceInstructions(), 'x'.repeat(8000));
  await save('');
});
test('the providers that skip thinking on the first spoken call: the default list is offered, another is saved, and the default sent back is not', async () => {
  const save = (skipThinkingProviders: unknown) => put({ skipThinkingProviders });
  const get = async () => (await fetch(`${base}/voice`)).json();
  await save(undefined);
  let shown = await get();
  assert.deepEqual(shown.skipThinkingProviders, [...DEFAULT_SKIP_THINKING_PROVIDERS]);
  assert.deepEqual(shown.defaultSkipThinkingProviders, [...DEFAULT_SKIP_THINKING_PROVIDERS]);
  assert.equal(getSkipThinkingProviders(), undefined);
  // Trimmed, each once, and what the first call then reads.
  assert.equal((await save([' llama-swap ', 'my-gateway', 'llama-swap', ''])).status, 200);
  assert.deepEqual(getSkipThinkingProviders(), ['llama-swap', 'my-gateway']);
  shown = await get();
  assert.deepEqual(shown.skipThinkingProviders, ['llama-swap', 'my-gateway']);
  // Empty is a choice: thinking stays on everywhere.
  await save([]);
  assert.deepEqual(getSkipThinkingProviders(), []);
  assert.deepEqual((await get()).skipThinkingProviders, []);
  // The default list sent back, in any order, is not saved: it then follows the portal's updates.
  await save([...DEFAULT_SKIP_THINKING_PROVIDERS].reverse());
  assert.equal(getSkipThinkingProviders(), undefined);
  // What is not a list of provider names.
  for (const bad of ['llama-swap', [42], ['two words'], ['a/b'], Array(51).fill('x')]) assert.equal((await save(bad)).status, 400, JSON.stringify(bad).slice(0, 40));
  await save(undefined);
});
test('the voice model: none by default, a provider/model is saved and read back, and anything else is refused', async () => {
  const save = (voiceModel: unknown) => put({ voiceModel });
  await save(undefined);
  assert.equal(getVoiceModel(), undefined);
  assert.equal((await save(' fast/small-model:q4 ')).status, 200);
  assert.deepEqual(getVoiceModel(), { provider: 'fast', modelId: 'small-model:q4' });
  assert.equal(((await (await fetch(`${base}/voice`)).json()) as any).voiceModel, 'fast/small-model:q4');
  // A model id may hold slashes of its own: only the first one ends the provider.
  await save('router/vendor/model');
  assert.deepEqual(getVoiceModel(), { provider: 'router', modelId: 'vendor/model' });
  // Empty is the way back to the chat's own.
  await save('');
  assert.equal(getVoiceModel(), undefined);
  for (const bad of [42, 'no-slash', '/model', 'provider/', 'two words/model', 'x'.repeat(301)]) assert.equal((await save(bad)).status, 400, JSON.stringify(bad).slice(0, 40));
  await save(undefined);
});
test('VOICE_RESPONSE_INSTRUCTIONS=false is shown to the page, and leaves a saved text alone', async () => {
  const previous = process.env.VOICE_RESPONSE_INSTRUCTIONS;
  try {
    await put({ responseInstructions: 'Answer in one word.' });
    process.env.VOICE_RESPONSE_INSTRUCTIONS = 'false';
    const shown = await (await fetch(`${base}/voice`)).json();
    assert.equal(shown.responseInstructionsOff, true);
    assert.equal(shown.responseInstructions, 'Answer in one word.');
    process.env.VOICE_RESPONSE_INSTRUCTIONS = 'true';
    assert.equal((await (await fetch(`${base}/voice`)).json()).responseInstructionsOff, false);
  } finally {
    if (previous === undefined) delete process.env.VOICE_RESPONSE_INSTRUCTIONS;
    else process.env.VOICE_RESPONSE_INSTRUCTIONS = previous;
    await put({});
  }
});
