import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preparePcmSpeech, readPcmStream } from '../core/web/src/pcm-stream.js';
import { stretch } from '../core/web/src/time-stretch.js';
import { addLocale, setLanguage } from '../core/web/src/i18n.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function audio() {
  const sources: any[] = [];
  return { sources, context: {
    currentTime: 1,
    createBuffer: (_channels: number, count: number, rate: number) => {
      const data = new Float32Array(count);
      return { duration: count / rate, getChannelData: () => data };
    },
    createBufferSource: () => {
      const source = { buffer: null, onended: null as any, stopped: false, at: 0,
        connect() {}, disconnect() {}, start(at: number) { this.at = at; }, stop() { this.stopped = true; } };
      sources.push(source); return source;
    },
  } as unknown as AudioContext };
}
test('PCM starts before generation ends and schedules incoming chunks contiguously', async () => {
  const { context, sources } = audio(); const abort = new AbortController();
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { writer = c; } });
  const ready = preparePcmSpeech(body, context, abort.signal);
  writer.enqueue(new Uint8Array(32001)); // also exercise split 16-bit samples
  const speech = await ready;
  let generated = false; void speech.completed.then(() => { generated = true; });
  let started = false;
  const playing = speech.play({} as AudioNode, () => { started = true; });
  assert.equal(started, true); assert.equal(generated, false);
  writer.enqueue(new Uint8Array(15999)); await tick();
  assert.equal(sources.length, 2);
  assert.equal(sources[1].at, sources[0].at + sources[0].buffer.duration);
  writer.close(); await speech.completed;
  for (const source of sources) source.onended();
  await playing;
});
test('buffered PCM is stretched as it arrives, chunk by chunk, like the whole at once', async () => {
  const { context } = audio(); const abort = new AbortController();
  const rate = 1.5;
  const samples = Float32Array.from({ length: 4800 }, (_, i) => 0.25 * Math.sin(i / 7)); // 9600 bytes
  const bytesOf = (s: Float32Array) => {
    const b = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) { const v = Math.max(-1, Math.min(1, s[i])) * 32768 | 0; b[i * 2] = v & 255; b[i * 2 + 1] = (v >> 8) & 255; }
    return b;
  };
  const decodedOf = (b: Uint8Array) => {
    const n = b.length / 2, out = new Float32Array(n), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < n; i++) out[i] = v.getInt16(i * 2, true) / 32768;
    return out;
  };
  const wholeBytes = bytesOf(samples);
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { writer = c; } });
  const recorded: Float32Array[] = [];
  // Cuts chosen mid-sample, so chunks end inside 16-bit samples.
  const cuts = [3201, 6400]; const chunks: Uint8Array[] = [];
  let from = 0; for (const cut of [...cuts, wholeBytes.length]) { chunks.push(wholeBytes.subarray(from, cut)); from = cut; }
  writer.enqueue(chunks[0]); await tick();
  const bufferPromise = readPcmStream(body, context, abort.signal, { rate, record: s => recorded.push(s) });
  writer.enqueue(chunks[1]); await tick();
  writer.enqueue(chunks[2]); writer.close();
  const buffer = await bufferPromise;
  assert.equal(recorded.length, 1);
  // Recorded whole, as it was spoken.
  assert.ok(recorded[0].every((v, i) => v === decodedOf(wholeBytes)[i]));
  // And stretched exactly what the whole would have been.
  const expected = stretch(decodedOf(wholeBytes), rate);
  assert.equal(buffer.getChannelData(0).length, expected.length);
  assert.ok(buffer.getChannelData(0).every((v, i) => Math.abs(v - expected[i]) < 1e-6));
});
test('buffered PCM with a missing half-sample is incomplete', async () => {
  const { context } = audio();
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { writer = c; } });
  writer.enqueue(new Uint8Array(15)); writer.close();
  await assert.rejects(readPcmStream(body, context, new AbortController().signal), /incomplete/);
});
test('audio that stops short is reported without naming an engine, in the portal\'s language', async () => {
  const { context } = audio();
  const reasons = async () => {
    const buffered = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(15)); c.close(); } });
    const streamed = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(32001)); c.close(); } });
    const speech = await preparePcmSpeech(streamed, context, new AbortController().signal);
    return Promise.all([
      readPcmStream(buffered, context, new AbortController().signal).then(() => '', (e: Error) => e.message),
      speech.completed.then(() => '', (e: Error) => e.message),
    ]);
  };
  addLocale({ code: 'xx', name: 'Test', strings: { "Voice mode's source returned incomplete audio": 'xx: incomplete audio' } });
  assert.deepEqual(await reasons(), ["Voice mode's source returned incomplete audio", "Voice mode's source returned incomplete audio"]);
  setLanguage('xx');
  try {
    assert.deepEqual(await reasons(), ['xx: incomplete audio', 'xx: incomplete audio']);
  } finally {
    setLanguage('system');
  }
});
test('barge-in cancels both streaming reads and scheduled audio', async () => {
  const { context, sources } = audio(); const abort = new AbortController(); let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(32000)); }, cancel() { cancelled = true; } });
  const speech = await preparePcmSpeech(body, context, abort.signal);
  const playing = speech.play({} as AudioNode, () => {});
  abort.abort(new Error('interrupted'));
  await assert.rejects(playing, /interrupted/);
  await assert.rejects(speech.completed, /interrupted/);
  assert.equal(cancelled, true); assert.ok(sources.every(s => s.stopped));
});
