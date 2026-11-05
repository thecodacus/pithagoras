import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimeStretch, stretch, stretchInSteps } from '../core/web/src/time-stretch.js';

const RATE = 24000;
const tone = (seconds: number, hz: number) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => 0.5 * Math.sin(2 * Math.PI * hz * i / RATE));
/** The pitch of a clean tone, from how often it crosses zero. */
const pitch = (samples: Float32Array) => {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings++;
  return crossings / 2 / (samples.length / RATE);
};
const rms = (s: Float32Array) => Math.sqrt(s.reduce((n, v) => n + v * v, 0) / s.length);

test('faster speech is shorter by the rate, and keeps its pitch', () => {
  const input = tone(2, 220);
  for (const rate of [1.25, 1.5, 2, 0.8]) {
    const out = stretch(input, rate);
    assert.ok(Math.abs(out.length - input.length / rate) <= 1, `${rate}: ${out.length}`);
    // Away from the ends, where the first and last pieces fade.
    const middle = out.subarray(2400, out.length - 2400);
    assert.ok(Math.abs(pitch(middle) - 220) < 4, `${rate}: ${pitch(middle)} Hz`);
    // Lined-up pieces add up; a buzz of cancelling pieces would lose loudness.
    assert.ok(Math.abs(rms(middle) - rms(input)) < 0.03, `${rate}: rms ${rms(middle)}`);
  }
});

test('streamed in pieces, it comes out the same as all at once', () => {
  const input = tone(1.3, 180);
  const whole = stretch(input, 1.5);
  const s = new TimeStretch(1.5);
  const parts: Float32Array[] = [];
  for (let i = 0; i < input.length; i += 1111) parts.push(s.push(input.subarray(i, i + 1111)));
  parts.push(s.flush());
  const streamed = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { streamed.set(p, offset); offset += p.length; }
  assert.equal(streamed.length, whole.length);
  assert.ok(streamed.every((v, i) => Math.abs(v - whole[i]) < 1e-6));
  // And output comes out as it goes, not only at the end.
  assert.ok(parts.slice(1, -1).some(p => p.length > 0));
});

test('at normal speed nothing is changed', () => {
  const input = tone(0.2, 300);
  assert.equal(stretch(input, 1), input);
  const s = new TimeStretch(1);
  assert.equal(s.push(input), input);
  assert.equal(s.flush().length, 0);
});

test('a very short phrase still comes out, at its shorter length', () => {
  const input = tone(0.05, 300);
  assert.ok(Math.abs(stretch(input, 1.5).length - input.length / 1.5) <= 1);
  assert.equal(stretch(new Float32Array(0), 1.5).length, 0);
});

test('stretching a little at a time gives what stretching it at once does', async () => {
  const input = new Float32Array(24000 * 2).map((_, i) => Math.sin(i / 7) * 0.5);
  const whole = stretch(input, 1.5);
  const stepped = await stretchInSteps(input, 1.5, new AbortController().signal);
  assert.equal(stepped.length, whole.length);
  assert.ok(stepped.every((v, i) => Math.abs(v - whole[i]) < 1e-6));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(stretchInSteps(input, 1.5, controller.signal));
});

/** A tone made at any sample rate, and its pitch worked out at that rate. */
const toneAt = (sampleRate: number, seconds: number, hz: number) => Float32Array.from({ length: Math.round(seconds * sampleRate) }, (_, i) => 0.5 * Math.sin(2 * Math.PI * hz * i / sampleRate));
const pitchAt = (samples: Float32Array, sampleRate: number) => {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings++;
  return crossings / 2 / (samples.length / sampleRate);
};

test('speech made at 44.1 or 48 kHz is shorter by the rate and keeps its pitch, low voices too', () => {
  for (const sampleRate of [22050, 44100, 48000]) {
    // 40 and 50 Hz are a deep voice's lowest tones: their period is longer than the pieces' nudge was at 24 kHz's sizes.
    for (const hz of [40, 50, 220]) {
      const input = toneAt(sampleRate, 2, hz);
      for (const rate of [1.5, 2]) {
        const out = stretch(input, rate, sampleRate);
        assert.ok(Math.abs(out.length - input.length / rate) <= 1, `${sampleRate} Hz, ${hz} Hz, ${rate}: ${out.length}`);
        const middle = out.subarray(Math.round(sampleRate / 10), out.length - Math.round(sampleRate / 10));
        assert.ok(Math.abs(pitchAt(middle, sampleRate) - hz) < 1.5, `${sampleRate} Hz, ${hz} Hz, ${rate}: ${pitchAt(middle, sampleRate)} Hz`);
        assert.ok(Math.abs(rms(middle) - rms(input)) < 0.03, `${sampleRate} Hz, ${hz} Hz, ${rate}: rms ${rms(middle)}`);
      }
    }
  }
});

test('the pieces are as long in time at every sample rate, so streamed in parts it comes out as all at once', async () => {
  const sampleRate = 44100, input = toneAt(sampleRate, 1.3, 180);
  const whole = stretch(input, 1.5, sampleRate);
  const s = new TimeStretch(1.5, sampleRate);
  const parts: Float32Array[] = [];
  for (let i = 0; i < input.length; i += 2111) parts.push(s.push(input.subarray(i, i + 2111)));
  parts.push(s.flush());
  const streamed = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { streamed.set(p, offset); offset += p.length; }
  assert.equal(streamed.length, whole.length);
  assert.ok(streamed.every((v, i) => Math.abs(v - whole[i]) < 1e-6));
  const stepped = await stretchInSteps(input, 1.5, new AbortController().signal, sampleRate);
  assert.equal(stepped.length, whole.length);
  assert.ok(stepped.every((v, i) => Math.abs(v - whole[i]) < 1e-6));
  assert.throws(() => new TimeStretch(1.5, 0), /sample rate/);
});

test('the work for a second of speech does not grow with the sample rate', () => {
  /** The fastest of a few runs, so a busy machine does not tip it. */
  const best = (sampleRate: number) => {
    const input = toneAt(sampleRate, 2, 120);
    let fastest = Infinity;
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      stretch(input, 1.5, sampleRate);
      fastest = Math.min(fastest, performance.now() - start);
    }
    return fastest;
  };
  best(24000);
  // Compared at every sample of a piece, 192 kHz takes 64 times as long as 24 kHz; held to a few times it keeps up on a phone.
  const ratio = best(192000) / best(24000);
  assert.ok(ratio < 8, `192 kHz takes ${ratio.toFixed(1)} times as long as 24 kHz`);
});
