import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FRAME_MS, TurnEnd, WINDOW_SAMPLES, turnWindow, whisperFeatures, type SmartTurnSettings } from '../core/web/src/smart-turn.ts';
import { DEFAULT_SMART_TURN, DEFAULT_VAD } from '../core/web/src/api.ts';
import { RATE, join, readWav, silence, simulate, smartTurn } from './smart-turn-simulation.mts';

const jfk = readWav(new URL('./fixtures/jfk.wav', import.meta.url).pathname);
const seconds = (from: number, to: number) => jfk.slice(Math.round(from * RATE), Math.round(to * RATE));
/** What the reference implementation makes of pieces of jfk.wav (fixtures/smart-turn/reference.py). */
const reference: { name: string; start: number; end: number; probability: number; mean: number; std: number; min: number; max: number; stride: number; sample: number[] }[] =
  JSON.parse(readFileSync(new URL('./fixtures/smart-turn/jfk.json', import.meta.url), 'utf8'));

test('the model hears the last 8 s of the turn, with silence in front of a shorter one', () => {
  const frames = [Float32Array.from({ length: 512 }, () => 0.5), Float32Array.from({ length: 512 }, () => -0.25)];
  const window = turnWindow(frames);
  assert.equal(window.length, WINDOW_SAMPLES);
  assert.ok(window.subarray(0, WINDOW_SAMPLES - 1024).every(v => v === 0));
  assert.ok(window.subarray(WINDOW_SAMPLES - 1024, WINDOW_SAMPLES - 512).every(v => v === 0.5));
  assert.ok(window.subarray(WINDOW_SAMPLES - 512).every(v => v === -0.25));
  const long = Array.from({ length: 300 }, (_, i) => new Float32Array(512).fill(i));
  const last = turnWindow(long);
  assert.equal(last[0], 300 - WINDOW_SAMPLES / 512);
  assert.equal(last[WINDOW_SAMPLES - 1], 299);
});

// Features: within 5e-5 of WhisperFeatureExtractor's (the sample is rounded to 5 decimals; the full matrices differ
// by at most 1.9e-5). Probabilities: within 2e-3, the size of what int8 rounding moves between ONNX Runtime builds.
for (const clip of reference) {
  test(`Smart Turn's input and answer match the reference implementation: ${clip.name}`, async () => {
    const window = turnWindow([seconds(clip.start, clip.end)]);
    const features = whisperFeatures(window);
    assert.equal(features.length, 80 * 800);
    let worst = 0;
    clip.sample.forEach((expected, i) => { worst = Math.max(worst, Math.abs(features[i * clip.stride] - expected)); });
    assert.ok(worst < 5e-5, `largest difference ${worst}`);
    const mean = features.reduce((n, v) => n + v, 0) / features.length;
    const std = Math.sqrt(features.reduce((n, v) => n + (v - mean) ** 2, 0) / features.length);
    for (const [name, value, expected] of [['mean', mean, clip.mean], ['std', std, clip.std], ['min', Math.min(...features), clip.min], ['max', Math.max(...features), clip.max]] as const) {
      assert.ok(Math.abs(value - expected) < 2e-5, `${name}: ${value}, reference ${expected}`);
    }
    const probability = await (await smartTurn())(window);
    assert.ok(Math.abs(probability - clip.probability) < 2e-3, `probability ${probability}, reference ${clip.probability}`);
  });
}

/** A TurnEnd with a model that answers when told to, and Silero's redemption as it was last set. A 200 ms check delay unless said. */
function harness(settings: SmartTurnSettings = { ...DEFAULT_SMART_TURN, checkMs: 200 }) {
  const asked: { window: Float32Array; answer: (p: number) => void; fail: (e: Error) => void }[] = [];
  const redemption: number[] = [];
  const turns = new TurnEnd(DEFAULT_VAD, settings, {
    predict: window => new Promise((answer, fail) => asked.push({ window, answer, fail })),
    redemption: ms => redemption.push(ms),
  });
  const frame = (probability: number, value = probability) => turns.frame(probability, new Float32Array(512).fill(value));
  const quiet = (ms: number) => { for (let i = 0; i < Math.ceil(ms / FRAME_MS); i++) frame(0.05); };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { turns, asked, redemption, frame, quiet, settle };
}

test('until the model is ready nothing is asked, and the plain silence rule stands', () => {
  const { asked, redemption, frame, quiet } = harness();
  for (let i = 0; i < 20; i++) frame(0.9);
  quiet(1500);
  assert.equal(asked.length, 0);
  assert.deepEqual(redemption, []);
});

test('once ready, a pause of the check delay asks once, about the whole turn with the audio before it', async () => {
  const { turns, asked, redemption, frame, quiet, settle } = harness();
  turns.ready();
  assert.deepEqual(redemption, [2000]);
  for (let i = 0; i < 12; i++) frame(0.1, 0.01);
  for (let i = 0; i < 30; i++) frame(0.9);
  quiet(192);
  assert.equal(asked.length, 0, 'not before 200 ms');
  quiet(32);
  assert.equal(asked.length, 1);
  quiet(1000);
  assert.equal(asked.length, 1, 'once per pause');
  // Silero keeps 10 frames (320 ms) before speech; so does the turn.
  const turn = asked[0].window.subarray(WINDOW_SAMPLES - (10 + 30 + 7) * 512);
  assert.ok(turn.subarray(0, 10 * 512).every(v => Math.abs(v - 0.01) < 1e-6));
  assert.ok(asked[0].window.subarray(0, WINDOW_SAMPLES - turn.length).every(v => v === 0));
  asked[0].answer(0.8);
  await settle();
  assert.deepEqual(redemption, [2000, 0], 'a finished turn ends at the next silent frame');
  turns.ended();
  assert.deepEqual(redemption, [2000, 0, 2000]);
});

test('an unfinished turn keeps listening, and the next pause asks again about all of it', async () => {
  const { turns, asked, redemption, frame, quiet, settle } = harness();
  turns.ready();
  for (let i = 0; i < 20; i++) frame(0.9);
  quiet(300);
  asked[0].answer(0.2);
  await settle();
  assert.deepEqual(redemption, [2000]);
  for (let i = 0; i < 20; i++) frame(0.9);
  quiet(300);
  assert.equal(asked.length, 2);
  const turn = (20 + 10 + 20 + 7) * 512;
  assert.ok(asked[1].window.subarray(WINDOW_SAMPLES - turn).every(v => v !== 0));
  assert.ok(asked[1].window.subarray(0, WINDOW_SAMPLES - turn).every(v => v === 0));
});

test('an answer about a pause that speech has ended since is not acted on', async () => {
  const { turns, asked, redemption, frame, quiet, settle } = harness();
  turns.ready();
  for (let i = 0; i < 20; i++) frame(0.9);
  quiet(250);
  frame(0.9);
  asked[0].answer(0.99);
  await settle();
  assert.deepEqual(redemption, [2000]);
});

test('speech after a finished answer, before Silero ended the turn, waits again', async () => {
  const { turns, asked, redemption, frame, quiet, settle } = harness();
  turns.ready();
  for (let i = 0; i < 20; i++) frame(0.9);
  quiet(250);
  asked[0].answer(0.99);
  await settle();
  frame(0.9);
  assert.deepEqual(redemption, [2000, 0, 2000]);
});

test('frames between the two thresholds neither start a pause nor end one', () => {
  const { turns, asked, frame, quiet } = harness();
  turns.ready();
  for (let i = 0; i < 20; i++) frame(0.9);
  for (let i = 0; i < 20; i++) frame(0.5);
  assert.equal(asked.length, 0);
  quiet(100);
  for (let i = 0; i < 4; i++) frame(0.5);
  assert.equal(asked.length, 1, 'counted as part of the pause once it began');
});

test('a model that fails puts the plain silence rule back, and is not asked again', async () => {
  const { turns, asked, redemption, frame, quiet, settle } = harness();
  turns.ready();
  for (let i = 0; i < 20; i++) frame(0.9);
  quiet(250);
  asked[0].fail(new Error('out of memory'));
  await settle();
  assert.deepEqual(redemption, [2000, DEFAULT_VAD.redemptionMs]);
  turns.ended();
  for (let i = 0; i < 20; i++) frame(0.9);
  quiet(1000);
  assert.equal(asked.length, 1);
});

test('once its answer is that the turn goes on, it is not asked again in the same pause unless asked to', async () => {
  const { turns, asked, frame, quiet, settle } = harness();
  turns.ready();
  for (let i = 0; i < 20; i++) frame(0.9);
  quiet(224);
  asked[0].answer(0.2);
  await settle();
  quiet(1500);
  assert.equal(asked.length, 1);
});

test('with recheck, a pause that goes on is asked about again each check delay, one question at a time, until the turn is found finished', async () => {
  const { turns, asked, redemption, frame, quiet, settle } = harness({ ...DEFAULT_SMART_TURN, checkMs: 200, recheck: true });
  turns.ready();
  for (let i = 0; i < 20; i++) frame(0.9);
  quiet(224);
  assert.equal(asked.length, 1);
  quiet(256);
  assert.equal(asked.length, 1, 'not while the first answer is awaited');
  asked[0].answer(0.2);
  await settle();
  quiet(160);
  assert.equal(asked.length, 2, 'at the next multiple of the check delay');
  assert.ok(asked[1].window.length === asked[0].window.length);
  asked[1].answer(0.7);
  await settle();
  assert.deepEqual(redemption, [2000, 0]);
  quiet(500);
  assert.equal(asked.length, 2, 'not once the turn is found finished');
  // Speech again starts a new pause, which is asked about from its own start.
  for (let i = 0; i < 5; i++) frame(0.9);
  quiet(224);
  assert.equal(asked.length, 3);
});

test('a model that cannot load leaves the plain silence rule in place', () => {
  const { turns, asked, redemption, frame, quiet } = harness();
  turns.failed();
  for (let i = 0; i < 20; i++) frame(0.9);
  quiet(1000);
  assert.equal(asked.length, 0);
  assert.deepEqual(redemption, [DEFAULT_VAD.redemptionMs]);
});

// Real speech through Silero and vad-web's FrameProcessor, as voice mode runs them. Smart Turn's answer is taken to
// arrive 250 ms after it is asked, about what it takes in a browser on a laptop (see the pull request).
const LATENCY = 250;
const after = (run: { ends: number[]; lastSpeech: number[] }, i: number) => run.ends[i] - run.lastSpeech[i];

test('a finished turn is answered sooner than after the one second of silence', async () => {
  // "...ask not what your country can do for you, ask what you can do for your country."
  const audio = join(seconds(3, 11), silence(3000));
  const plain = await simulate(audio, null);
  const smart = await simulate(audio, DEFAULT_SMART_TURN, LATENCY);
  assert.equal(smart.ends.length, 1);
  assert.ok(after(plain, plain.ends.length - 1) >= 960, `plain: ${after(plain, plain.ends.length - 1)} ms`);
  // The default check delay (400 ms), the answer (250 ms) and Silero's next silent frame.
  assert.ok(after(smart, 0) < 800, `Smart Turn: ${after(smart, 0)} ms`);
});

for (const gap of [1200, 1500, 1800]) {
  test(`a ${gap} ms pause in the middle of a sentence is waited for, where the silence rule sends half of it`, async () => {
    // "...what your country can do for you, [pause] ask what you can do for your country."
    const audio = join(seconds(3, 7.85), silence(gap), seconds(8.6, 11), silence(3000));
    const plain = await simulate(audio, null);
    const smart = await simulate(audio, DEFAULT_SMART_TURN, LATENCY);
    assert.ok(plain.ends[0] < 7.85 * 1000 - 3000 + gap, `plain ends at ${plain.ends}`);
    assert.equal(smart.ends.length, 1, `Smart Turn ends at ${smart.ends}`);
    assert.ok(smart.ends[0] > 4850 + gap + 2000, 'after the words that follow the pause');
  });
}
