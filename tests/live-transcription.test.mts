import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveTranscription } from '../core/web/src/live-transcription.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const audio = () => new Float32Array(512);
function begin(live: LiveTranscription) { live.frame(0.9, audio()); live.begin(); live.confirm(); }
function pause(live: LiveTranscription) { for (let i = 0; i < 6; i++) live.frame(0.01, audio()); }
function end(live: LiveTranscription) { const samples = audio(); live.end(samples); return samples; }

test('transcribes in the turn-end silence and reuses a current hypothesis without another request', async () => {
  let calls = 0; const previews: string[] = [];
  const live = new LiveTranscription(async () => { calls++; return 'Ready to send.'; }, text => previews.push(text));
  begin(live); pause(live); await tick();
  assert.equal(calls, 1); assert.equal(previews.at(-1), 'Ready to send.');
  assert.equal(await live.finish(end(live), new AbortController().signal), 'Ready to send.');
  assert.equal(calls, 1);
});
test('resumed speech invalidates an earlier hypothesis and final audio is transcribed', async () => {
  let calls = 0;
  const live = new LiveTranscription(async () => ++calls === 1 ? 'Old partial.' : 'The whole thought.', () => {});
  begin(live); pause(live); await tick(); live.frame(0.9, audio());
  assert.equal(await live.finish(end(live), new AbortController().signal), 'The whole thought.');
  assert.equal(calls, 2);
});
test('slow speculative work is reused once complete; mute cancels it and never returns late text', async () => {
  let resolve!: (text: string) => void; let input: AbortSignal | undefined;
  const live = new LiveTranscription((_samples, signal) => { input = signal; return new Promise(r => { resolve = r; }); }, () => {});
  begin(live); pause(live);
  const result = live.finish(end(live), new AbortController().signal);
  live.reset(); assert.equal(input?.aborted, true); resolve('Discard this.');
  await assert.rejects(result);
});
test('finalized segments remain distinct when speech resumes before transcription finishes', async () => {
  let calls = 0;
  const live = new LiveTranscription(async () => `Segment ${++calls}`, () => {});
  begin(live); pause(live); await tick(); const first = end(live);
  begin(live); pause(live); await tick(); const second = end(live);
  assert.equal(await live.finish(first, new AbortController().signal), 'Segment 1');
  assert.equal(await live.finish(second, new AbortController().signal), 'Segment 2');
  assert.equal(calls, 2);
});
test('speculation failures retry with the final recording', async () => {
  let calls = 0;
  const live = new LiveTranscription(async () => { if (++calls === 1) throw new Error('Temporary failure'); return 'Recovered'; }, () => {});
  begin(live); pause(live); await tick();
  assert.equal(await live.finish(end(live), new AbortController().signal), 'Recovered');
});

test('sequential baseline makes exactly one request after speech ends',async()=>{
 let calls=0;const live=new LiveTranscription(async()=>{calls++;return 'Complete utterance';},()=>{},false);
 begin(live);for(let i=0;i<150;i++)live.frame(.9,audio());pause(live);await tick();assert.equal(calls,0);
 const samples=end(live);assert.equal(calls,0);
 assert.equal(await live.finish(samples,new AbortController().signal),'Complete utterance');assert.equal(calls,1);
});
