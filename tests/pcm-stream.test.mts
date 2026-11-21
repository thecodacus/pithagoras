import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bufferOf, preparePcmSpeech, readPcmStream, sampleRateOf } from '../core/web/src/pcm-stream.js';
import { stretch } from '../core/web/src/time-stretch.js';
import { addLocale, setLanguage } from '../core/web/src/i18n.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function audio() {
  const sources: any[] = [], rates: number[] = [];
  return { sources, rates, context: {
    currentTime: 1,
    createBuffer: (_channels: number, count: number, rate: number) => {
      rates.push(rate);
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

const bytesOfSamples = (samples: Float32Array) => {
  const bytes = new Uint8Array(samples.length * 2), view = new DataView(bytes.buffer);
  samples.forEach((v, i) => view.setInt16(i * 2, Math.round(v * 32767), true));
  return bytes;
};
test('a phrase says its sample rate in x-sample-rate, and only one the portal passes on counts', () => {
  const said = (value?: string) => sampleRateOf(new Headers(value === undefined ? {} : { 'x-sample-rate': value }));
  assert.deepEqual([said('24000'), said('44100'), said('8000'), said('192000')], [24000, 44100, 8000, 192000]);
  for (const bad of [undefined, '', '7999', '192001', '44100.5', '-44100', 'fast', '4e4', '0x5000', '44100 Hz']) assert.equal(said(bad), undefined, String(bad));
});
test('a buffer is made at the rate of the phrase, whatever the audio context plays at', () => {
  const { context, rates } = audio();
  assert.equal(bufferOf(context, new Float32Array(441), 44100)!.duration, 0.01);
  assert.equal(bufferOf(context, new Float32Array(240))!.duration, 0.01);
  assert.deepEqual(rates, [44100, 24000]);
});
test('44.1 kHz PCM is buffered at 44.1 kHz, stretched at the length and pitch it has there', async () => {
  const sampleRate = 44100, hz = 45;
  const samples = Float32Array.from({ length: sampleRate * 2 }, (_, i) => 0.5 * Math.sin(2 * Math.PI * hz * i / sampleRate));
  const bytes = bytesOfSamples(samples);
  const whole = new Float32Array(bytes.length / 2).map((_, i) => new DataView(bytes.buffer).getInt16(i * 2, true) / 32768);
  for (const rate of [1, 1.5]) {
    const { context, rates } = audio();
    const recorded: Float32Array[] = [];
    // In pieces cut inside a sample, as a network does.
    const body = new ReadableStream<Uint8Array>({ start(c) { for (let at = 0; at < bytes.length; at += 4001) c.enqueue(bytes.subarray(at, at + 4001)); c.close(); } });
    const buffer = await readPcmStream(body, context, new AbortController().signal, { rate, sampleRate, record: s => recorded.push(s) });
    assert.deepEqual([...new Set(rates)], [sampleRate], `${rate}: made at the phrase's rate`);
    // Recorded as it was spoken, for a replay at the phrase's rate.
    assert.equal(recorded[0].length, samples.length);
    const out = buffer.getChannelData(0);
    assert.ok(Math.abs(out.length - samples.length / rate) <= 1, `${rate}: ${out.length}`);
    assert.ok(Math.abs(buffer.duration - 2 / rate) < 1e-3, `${rate}: ${buffer.duration} s`);
    const expected = stretch(whole, rate, sampleRate);
    assert.equal(out.length, expected.length);
    assert.ok(out.every((v, i) => Math.abs(v - expected[i]) < 1e-6));
    const middle = out.subarray(4410, out.length - 4410);
    let crossings = 0;
    for (let i = 1; i < middle.length; i++) if ((middle[i - 1] < 0) !== (middle[i] < 0)) crossings++;
    assert.ok(Math.abs(crossings / 2 / (middle.length / sampleRate) - hz) < 1.5, `${rate}: pitch`);
  }
});
test('44.1 kHz PCM that streams is scheduled in buffers of 44.1 kHz, back to back', async () => {
  const { context, sources, rates } = audio(); const abort = new AbortController();
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { writer = c; } });
  // 0.7 s are enough to start; each buffer is as long as the piece that made it.
  const ready = preparePcmSpeech(body, context, abort.signal, { sampleRate: 44100 });
  writer.enqueue(new Uint8Array(61740));
  const speech = await ready;
  const playing = speech.play({} as AudioNode, () => {});
  writer.enqueue(new Uint8Array(44100)); await tick();
  assert.equal(sources.length, 2);
  assert.ok(Math.abs(sources[0].buffer.duration - 0.7) < 1e-9, `${sources[0].buffer.duration} s`);
  assert.ok(Math.abs(sources[1].buffer.duration - 0.5) < 1e-9, `${sources[1].buffer.duration} s`);
  assert.equal(sources[1].at, sources[0].at + sources[0].buffer.duration);
  writer.close(); await speech.completed;
  for (const source of sources) source.onended();
  await playing;
  assert.deepEqual([...new Set(rates)], [44100]);
});
