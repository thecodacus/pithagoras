import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechPipeline, type PreparedSpeech } from '../core/web/src/speech-pipeline.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

test('next sentence generates during playback, while audio stays in order and synthesis stays single-file', async () => {
  const calls: string[] = [], generated = new Map<string, ReturnType<typeof deferred<PreparedSpeech>>>();
  const played = new Map<string, ReturnType<typeof deferred<void>>>();
  const pipeline = new SpeechPipeline(async text => { calls.push(`generate:${text}`); const gate = deferred<PreparedSpeech>(); generated.set(text, gate); return gate.promise; }, () => {}, error => { throw error; });
  const audio = (text: string) => async () => { calls.push(`play:${text}`); const gate = deferred<void>(); played.set(text, gate); await gate.promise; };
  pipeline.enqueue(['one', 'two']);
  assert.deepEqual(calls, ['generate:one']);
  generated.get('one')!.resolve(audio('one')); await tick();
  assert.deepEqual(calls, ['generate:one', 'play:one', 'generate:two']);
  pipeline.enqueue(['three']);
  generated.get('two')!.resolve(audio('two')); await tick();
  assert.equal(calls.includes('play:two'), false); assert.equal(calls.at(-1), 'generate:three');
  generated.get('three')!.resolve(audio('three')); await tick();
  played.get('one')!.resolve(); await tick(); assert.equal(calls.at(-1), 'play:two');
  played.get('two')!.resolve(); await tick(); assert.equal(calls.at(-1), 'play:three');
  played.get('three')!.resolve(); await tick(); assert.equal(pipeline.busy, false);
});

test('prefetch stops at two prepared phrases and resumes when playback frees space', async () => {
  const generated: string[] = []; const first = deferred<void>();
  const pipeline = new SpeechPipeline(async text => { generated.push(text); return async () => { if (text === '1') await first.promise; }; }, () => {}, () => {});
  pipeline.enqueue(['1', '2', '3', '4', '5']); await tick();
  assert.deepEqual(generated, ['1', '2', '3']);
  first.resolve(); await tick(); await tick();
  assert.deepEqual(generated, ['1', '2', '3', '4', '5']);
});

test('barge-in cancels playing and generating audio and rejects late stale results', async () => {
  const late = deferred<PreparedSpeech>(); const signals: AbortSignal[] = []; const played: string[] = [];
  const pipeline = new SpeechPipeline(async (text, signal) => {
    signals.push(signal);
    if (text === 'two') return late.promise;
    return async s => { played.push(text); if (text === 'one') await new Promise<void>(resolve => s.addEventListener('abort', () => resolve(), { once: true })); };
  }, () => {}, () => {});
  pipeline.enqueue(['one', 'two', 'three']); await tick();
  pipeline.cancel(); assert.ok(signals.every(s => s.aborted));
  pipeline.enqueue(['new']); late.resolve(async () => { played.push('stale'); }); await tick();
  assert.deepEqual(played, ['one', 'new']); assert.equal(pipeline.busy, false);
});

test('generation failure stops queued output, reports once, and permits a later turn', async () => {
  const errors: unknown[] = [], played: string[] = [];
  const pipeline = new SpeechPipeline(async text => { if (text === 'bad') throw new Error('failed'); return async () => { played.push(text); }; }, () => {}, e => errors.push(e));
  pipeline.enqueue(['bad', 'stale']); await tick();
  assert.equal(errors.length, 1); assert.equal(pipeline.busy, false);
  pipeline.enqueue(['new']); await tick(); assert.deepEqual(played, ['new']);
});

test('sequential baseline finishes all synthesis before any playback', async () => {
 const calls:string[]=[];const finish=deferred<void>();
 const pipeline=new SpeechPipeline(async text=>{calls.push(`generate:${text}`);return Object.assign(async()=>{calls.push(`play:${text}`);},{completed:text==='one'?finish.promise:Promise.resolve()});},()=>{},e=>{throw e;},true);
 pipeline.enqueue(['one','two']);await tick();assert.deepEqual(calls,['generate:one']);
 finish.resolve();await tick();await tick();
 assert.deepEqual(calls,['generate:one','generate:two','play:one','play:two']);
 assert.equal(pipeline.busy,false);
});

test('sentence baseline buffers each sentence then plays before generating the next',async()=>{
 const calls:string[]=[];const generated=deferred<void>(),played=deferred<void>();
 const pipeline=new SpeechPipeline(async text=>{calls.push(`generate:${text}`);return Object.assign(async()=>{calls.push(`play:${text}`);if(text==='one')await played.promise;},{completed:text==='one'?generated.promise:Promise.resolve()});},()=>{},e=>{throw e;},true,true);
 pipeline.enqueue(['one','two']);await tick();assert.deepEqual(calls,['generate:one']);
 generated.resolve();await tick();assert.deepEqual(calls,['generate:one','play:one']);
 played.resolve();await tick();await tick();assert.deepEqual(calls,['generate:one','play:one','generate:two','play:two']);
});

test('buffered sentence prefetch generates during playback but never plays incomplete audio',async()=>{
 const calls:string[]=[];
 const firstAudio=deferred<void>(),secondAudio=deferred<void>(),firstPlayback=deferred<void>();
 const pipeline=new SpeechPipeline(async text=>{calls.push(`generate:${text}`);return Object.assign(async()=>{calls.push(`play:${text}`);if(text==='one')await firstPlayback.promise;},{completed:text==='one'?firstAudio.promise:secondAudio.promise});},()=>{},e=>{throw e;},true,true,true);
 pipeline.enqueue(['one','two']);await tick();assert.deepEqual(calls,['generate:one']);
 firstAudio.resolve();await tick();assert.deepEqual(calls,['generate:one','play:one','generate:two']);
 firstPlayback.resolve();await tick();assert.equal(calls.includes('play:two'),false);
 secondAudio.resolve();await tick();assert.deepEqual(calls,['generate:one','play:one','generate:two','play:two']);assert.equal(pipeline.busy,false);
});
