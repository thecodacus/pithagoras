import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPACTION_PHRASES, HandsFreeVoice, THINKING_PHRASES, type VoiceIO } from '../core/web/src/hands-free.js';
import { addLocale, setLanguage } from '../core/web/src/i18n.js';
import { samplesWav } from '../core/web/src/voice.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const reply = (id: string, done = true) => ({ kind: 'assistant' as const, id, text: 'A spoken answer.', thinking: '', done });
function setup(patch: Partial<VoiceIO> & { speak?: (text: string, signal: AbortSignal) => Promise<void> } = {}) {
  const sent: string[] = [], spoken: string[] = [], errors: string[] = [];
  const io: VoiceIO = {
    transcribe: async () => 'hello', send: async text => { sent.push(text); },
    abort: async () => {}, agentRunning: () => false,
    synthesize: async text => async signal => { if (patch.speak) await patch.speak(text, signal); else spoken.push(text); }, phase: () => {}, error: message => { errors.push(message); }, ...patch,
  };
  return { voice: new HandsFreeVoice(io, [reply('a10')]), sent, spoken, errors };
}
test('successive automatic turns work without another mic toggle; history stays silent', async () => {
  const { voice, sent, spoken } = setup();
  voice.observe([reply('a1'), reply('a10')]);
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  assert.deepEqual(sent, ['hello']);
  voice.observe([reply('a10'), reply('a20')]); await tick();
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  voice.observe([reply('a10'), reply('a20'), reply('a30')]); await tick();
  assert.equal(sent.length, 2); assert.equal(spoken.length, 2); voice.stop();
});
test('barge-in immediately cancels playback and ignores the interrupted reply remainder', async () => {
  let playbackSignal: AbortSignal | undefined;
  let aborted = 0;
  const { voice, sent } = setup({ agentRunning: () => true, abort: async () => { aborted++; }, speak: async (_text, signal) => {
    playbackSignal = signal; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  } });
  voice.observe([reply('a20'), reply('a21', false)]); await tick();
  voice.speechStart(); assert.equal(playbackSignal?.aborted, true); await tick();
  // Not stopped for a sound; stopped once it is words for the agent.
  assert.equal(aborted, 0);
  voice.heard('hello'); await tick();
  assert.equal(aborted, 1);
  voice.observe([reply('a20'), reply('a21')]);
  voice.speechEnd(new Float32Array(16000)); await tick();
  assert.deepEqual(sent, ['hello']); voice.stop();
});
test('speech resumed during transcription is combined, not dropped or sent halfway through', async () => {
  const first = deferred<string>(); let count = 0;
  const { voice, sent } = setup({ transcribe: () => ++count === 1 ? first.promise : Promise.resolve('and the second part') });
  voice.speechStart(); voice.speechEnd(new Float32Array(16000));
  voice.speechStart(); first.resolve('the first part'); await tick();
  assert.equal(sent.length, 0);
  voice.speechEnd(new Float32Array(16000)); await tick();
  assert.deepEqual(sent, ['the first part and the second part']); voice.stop();
});
test('barge-in waits for an in-flight send before abort, then sends the next turn', async () => {
  const accepted = deferred<void>(); const calls: string[] = [];
  const { voice } = setup({ send: async () => { calls.push('send'); if (calls.length === 1) await accepted.promise; }, abort: async () => { calls.push('abort'); } });
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  voice.speechStart(); voice.heard('hello'); voice.speechEnd(new Float32Array(16000));
  assert.deepEqual(calls, ['send']); accepted.resolve(); await tick(); await tick();
  assert.deepEqual(calls, ['send', 'abort', 'send']); voice.stop();
});
test('ending voice during transcription aborts the request and cannot send late text', async () => {
  const pending = deferred<string>(); let signal: AbortSignal | undefined;
  const { voice, sent } = setup({ transcribe: (_audio, input) => { signal = input; return pending.promise; } });
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); voice.stop();
  assert.equal(signal?.aborted, true); pending.resolve('must not be sent'); await tick();
  assert.deepEqual(sent, []);
});
test('a failed interruption is reported and does not send into the old running turn', async () => {
  const { voice, sent, errors } = setup({ agentRunning: () => true, abort: async () => { throw new Error('offline'); } });
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  assert.equal(sent.length, 0); assert.ok(errors.some(e => e.includes('offline'))); voice.stop();
});
test('VAD samples produce a 16 kHz PCM WAV with clipped amplitudes', async () => {
  const wav = new DataView(await samplesWav(new Float32Array([-2, 0, 2])).arrayBuffer());
  assert.equal(wav.getUint32(24, true), 16000); assert.equal(wav.getUint32(40, true), 6);
  assert.equal(wav.getInt16(44, true), -32768); assert.equal(wav.getInt16(48, true), 32767);
});

test('mute discards pending microphone input but leaves agent and playback alone', async () => {
  const transcription = deferred<string>(); let signal: AbortSignal | undefined;
  let aborts = 0; let playback: AbortSignal | undefined;
  const { voice, sent } = setup({ transcribe: (_samples, s) => { signal = s; return transcription.promise; }, abort: async () => { aborts++; },
    speak: async (_text, s) => { playback = s; await new Promise<void>(resolve => s.addEventListener('abort', () => resolve(), { once: true })); },
  });
  voice.speechStart(); voice.speechEnd(new Float32Array(16000));
  voice.setMuted(true); assert.equal(signal?.aborted, true);
  transcription.resolve('discard this partial turn'); await tick(); assert.deepEqual(sent, []);
  voice.observe([reply('a20')]); await tick();
  assert.equal(playback?.aborted, false);
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  assert.equal(aborts, 0); assert.equal(playback?.aborted, false); assert.deepEqual(sent, []);
  voice.stop();
});

test('unmute accepts new turns in the same voice session', async () => {
  const { voice, sent } = setup();
  voice.setMuted(true); voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  assert.deepEqual(sent, []);
  voice.setMuted(false); voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  assert.deepEqual(sent, ['hello']); voice.stop();
});

test('speaks stable sentences before response completion without replaying deltas or the final event', async () => {
  const { voice, spoken } = setup();
  const part = (text: string, done = false) => ({ ...reply('a20', done), text });
  voice.observe([part('Here is the first sentence. Now')]); await tick();
  assert.deepEqual(spoken, ['Here is the first sentence.']);
  voice.observe([part('Here is the first sentence. Now the rest arrives.')]); await tick();
  assert.equal(spoken.length, 1);
  voice.observe([part('Here is the first sentence. Now the rest arrives.', true)]); await tick();
  voice.observe([part('Here is the first sentence. Now the rest arrives.', true)]); await tick();
  assert.deepEqual(spoken, ['Here is the first sentence.', 'Now the rest arrives.']); voice.stop();
});

test('streaming code and link fragments are not spoken, and a final unfinished sentence is flushed', async () => {
  const { voice, spoken } = setup();
  const part = (text: string, done = false) => ({ ...reply('a20', done), text });
  voice.observe([part('Here is an introduction. ```js\nsecret.call();\n')]); await tick();
  assert.deepEqual(spoken, ['Here is an introduction.']);
  voice.observe([part('Here is an introduction. ```js\nsecret.call();\n```\nSee [the docs](https://secret.')]); await tick();
  assert.ok(spoken.join(' ').includes('Code is shown in the transcript.'));
  voice.observe([part('Here is an introduction. ```js\nsecret.call();\n```\nSee [the docs](https://secret.example). Final words', true)]); await tick();
  assert.ok(spoken.join(' ').endsWith('See the docs. Final words'));
  assert.ok(!spoken.join(' ').includes('secret')); voice.stop();
});


test('multiple available sentences stay separate so playback buffers only one phrase at a time', async () => {
  const { voice, spoken } = setup();
  voice.observe([{ ...reply('a20'), text: 'This is the first sentence. This is the second sentence. This is the final sentence.' }]);
  await tick();
  assert.deepEqual(spoken, ['This is the first sentence.', 'This is the second sentence.', 'This is the final sentence.']);
  voice.stop();
});


test('tiny sentences join the next phrase, while a short final reply still flushes', async () => {
  const { voice, spoken } = setup();
  const part = (text: string, done = false) => ({ ...reply('a20', done), text });
  voice.observe([part('Yes. ')]); await tick(); assert.deepEqual(spoken, []);
  voice.observe([part('Yes. I can check that for you. Next')]); await tick();
  assert.deepEqual(spoken, ['Yes. I can check that for you.']);
  voice.observe([part('Yes. I can check that for you. Next', true)]); await tick();
  assert.deepEqual(spoken, ['Yes. I can check that for you.', 'Next']); voice.stop();
});

test('response audio plays while the send acknowledgement is still pending', async () => {
  const accepted = deferred<void>();
  const { voice, spoken } = setup({ send: () => accepted.promise });
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  voice.observe([reply('a20')]); await tick();
  assert.deepEqual(spoken, ['A spoken answer.']);
  accepted.resolve(); await tick(); voice.stop();
});

// The cue comes after a pause the voice sets itself. The test moves the clock past it instead of waiting it out.
const PAST_THE_PAUSE = 1900;

test('thinking gets one short queued phrase; fast replies suppress it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { voice, spoken } = setup({ agentRunning: () => true });
  voice.observe([reply('a10')]);
  t.mock.timers.tick(PAST_THE_PAUSE); await tick();
  assert.equal(spoken.length, 1);
  assert.match(spoken[0], /think|consider|moment/i);
  voice.observe([reply('a10')]); await tick();
  assert.equal(spoken.length, 1);
  voice.stop();
  const fast = setup({ agentRunning: () => true });
  fast.voice.observe([reply('a10')]);
  fast.voice.observe([reply('a20')]); await tick();
  fast.voice.stop();
  assert.deepEqual(fast.spoken, ['A spoken answer.']);
});

test('compaction replaces thinking cues once and returns to normal status after ending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const phases: string[] = [];
  const { voice, spoken } = setup({ agentRunning: () => true, phase: phase => phases.push(phase) });
  voice.observe([reply('a10')]);
  voice.setCompacting(true);
  voice.setCompacting(true);
  await tick();
  t.mock.timers.tick(PAST_THE_PAUSE); await tick();
  assert.equal(spoken.length, 1);
  assert.match(spoken[0], /context/i);
  assert.equal(phases.at(-1), 'Compacting context');
  voice.setCompacting(false);
  await tick();
  assert.ok(spoken.some(text => text.includes('compaction is done')));
  assert.equal(phases.at(-1), 'Thinking');
  voice.stop();
});

test('compaction aborts an in-flight thinking cue', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let cueSignal: AbortSignal | undefined;
  const { voice } = setup({ agentRunning: () => true, synthesize: async (text, signal) => {
    if (!text.includes('context')) {
      cueSignal = signal;
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    }
    return async () => {};
  } });
  voice.observe([reply('a10')]);
  t.mock.timers.tick(PAST_THE_PAUSE); await tick();
  assert.ok(cueSignal);
  voice.setCompacting(true);
  assert.equal(cueSignal.aborted, true);
  await tick();
  voice.stop();
});

test('what it says while it waits is said in the portal\'s language', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const others = ["Context compaction is done. I'm ready to continue.", 'Context compaction stopped before it finished.', "I'm still compacting our conversation. Please wait a moment; I'll let you know when I'm ready."];
  addLocale({ code: 'xx', name: 'Test', strings: Object.fromEntries([...THINKING_PHRASES, ...COMPACTION_PHRASES, ...others].map(text => [text, `xx: ${text}`])) });
  setLanguage('xx');
  try {
    // A slow reply, then a compaction that is waited through, spoken over, and ends well; and one that does not.
    const slow = setup({ agentRunning: () => true });
    slow.voice.observe([reply('a10')]);
    t.mock.timers.tick(PAST_THE_PAUSE); await tick();
    assert.equal(slow.spoken.length, 1);
    assert.ok(THINKING_PHRASES.map(text => `xx: ${text}`).includes(slow.spoken[0]), slow.spoken[0]);
    slow.voice.setCompacting(true); await tick();
    assert.ok(COMPACTION_PHRASES.map(text => `xx: ${text}`).includes(slow.spoken[1]), slow.spoken[1]);
    slow.voice.speechStart(); await tick();
    slow.voice.setCompacting(false); await tick();
    // Told to wait when spoken over, and told it is done when it ends.
    assert.deepEqual(slow.spoken.slice(2), [`xx: ${others[2]}`, `xx: ${others[0]}`]);
    slow.voice.stop();
    const failed = setup();
    failed.voice.setCompacting(true); await tick();
    failed.voice.setCompacting(false, false); await tick();
    assert.equal(failed.spoken.at(-1), `xx: ${others[1]}`);
    failed.voice.stop();
  } finally {
    setLanguage('system');
  }
});

test('speech during compaction does not abort or send, even if compaction ends mid-utterance', async () => {
 let aborts=0, transcriptions=0;
 const {voice,spoken,sent}=setup({agentRunning:()=>true,abort:async()=>{aborts++},transcribe:async()=>{transcriptions++;return 'interrupt'}});
 voice.setCompacting(true); await tick();
 voice.speechStart(); voice.speechStart(); await tick();
 assert.equal(aborts,0);
 assert.equal(spoken.filter(text=>text.includes('Please wait')).length,1);
 voice.setCompacting(false); await tick();
 voice.speechEnd(new Float32Array(16000)); await tick();
 assert.equal(transcriptions,0); assert.equal(sent.length,0);
 assert.ok(spoken.some(text=>text.includes('compaction is done')));
 voice.stop();
});
test('failed compaction is not announced as completed', async () => {
 const {voice,spoken}=setup();voice.setCompacting(true);await tick();voice.setCompacting(false,false);await tick();
 assert.ok(spoken.some(text=>text.includes('stopped before')));
 assert.ok(!spoken.some(text=>text.includes('compaction is done')));voice.stop();
});


test('short sentences wait regardless of character length', async () => {
  const { voice, spoken } = setup();
  const part = (text: string, done = false) => ({ ...reply('a20', done), text });
  voice.observe([part('Absolutely extraordinary. ')]); await tick(); assert.deepEqual(spoken, []);
  voice.observe([part('Absolutely extraordinary. I am here. Next')]); await tick();
  assert.deepEqual(spoken, ['Absolutely extraordinary. I am here.']);
  voice.observe([part('Absolutely extraordinary. I am here. Next', true)]); await tick();
  assert.equal(spoken.at(-1), 'Next'); voice.stop();
});

test('speech cues do not count as words and three-word phrases join the next sentence', async () => {
  const { voice, spoken } = setup();
  const part = (text: string, done = false) => ({ ...reply('a20', done), text });
  voice.observe([part('(clears throat) Hello. ')]); await tick(); assert.deepEqual(spoken, []);
  voice.observe([part('(clears throat) Hello. I am here. Go to it. Next')]); await tick();
  assert.deepEqual(spoken, ['(clears throat) Hello. I am here.']);
  voice.observe([part('(clears throat) Hello. I am here. Go to it. Now we can continue. Next')]); await tick();
  assert.deepEqual(spoken, ['(clears throat) Hello. I am here.', 'Go to it. Now we can continue.']); voice.stop();
});

test('sequential baseline waits for the complete agent turn before synthesizing',async()=>{
 let running=true;const generated:string[]=[];
 const {voice}=setup({sequential:true,agentRunning:()=>running,synthesize:async text=>{generated.push(text);return async()=>{};}});
 voice.observe([reply('a20'),reply('a21',false)]);await tick();assert.equal(generated.length,0);
 voice.observe([reply('a20'),reply('a21')]);await tick();assert.equal(generated.length,0);
 running=false;voice.observe([reply('a20'),reply('a21')]);await tick();assert.equal(generated.length,2);voice.stop();
});

test('sentence comparison submits a completed sentence before the agent turn ends',async()=>{
 const generated:string[]=[];const {voice}=setup({sequential:true,sentenceChunks:true,agentRunning:()=>true,synthesize:async text=>{generated.push(text);return async()=>{};}});
 voice.observe([{...reply('a20',false),text:'Here is the first complete sentence. More'}]);await tick();
 assert.deepEqual(generated,['Here is the first complete sentence.']);voice.stop();
});
test('what is for the page is handled there and never sent', async () => {
  const handled: string[] = [];
  const { voice, sent, spoken } = setup({ transcribe: async () => 'say that again', command: text => { handled.push(text); return true; } });
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  assert.deepEqual(handled, ['say that again']);
  assert.deepEqual(sent, []);
  // Replies after it are spoken as before.
  voice.observe([reply('a10'), reply('a20')]); await tick();
  assert.equal(spoken.length, 1); voice.stop();
});
test('a page command heard over an interrupted reply keeps its remainder spoken', async () => {
  const handled: string[] = [];
  const { voice, sent, spoken } = setup({ agentRunning: () => true, transcribe: async () => 'say that again', command: text => { handled.push(text); return true; } });
  voice.speechStart();
  // The reply it cut off is held back while what is said may still be for the page.
  voice.observe([reply('a10'), reply('a20')]); await tick();
  voice.speechEnd(new Float32Array(16000)); await tick();
  assert.deepEqual(handled, ['say that again']);
  assert.deepEqual(sent, []);
  // What the interruption cut off is spoken after all, not dropped with it.
  assert.deepEqual(spoken, ['A spoken answer.']); voice.stop();
});
test('when steering, speaking mid-run adds to the run instead of stopping it', async () => {
  let aborted = 0, steering = true;
  const { voice, sent } = setup({ agentRunning: () => true, abort: async () => { aborted++; }, steering: () => steering });
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  assert.equal(aborted, 0); assert.deepEqual(sent, ['hello']);
  steering = false;
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  assert.equal(aborted, 1); voice.stop();
});
test('speech taken back before it ends is not sent, and replies carry on', async () => {
  const phases: string[] = [];
  const { voice, sent, spoken } = setup({ phase: phase => { phases.push(phase); } });
  voice.speechStart(); voice.speechCancel(); await tick();
  assert.deepEqual(sent, []);
  assert.equal(phases.at(-1), 'Listening');
  voice.observe([reply('a10'), reply('a20')]); await tick();
  assert.equal(spoken.length, 1); voice.stop();
});
test('a noise that transcribes to nothing leaves the run going and its reply spoken', async () => {
  let aborted = 0;
  const { voice, sent, spoken } = setup({ agentRunning: () => true, transcribe: async () => '', abort: async () => { aborted++; } });
  voice.observe([reply('a10'), reply('a20', false)]); await tick();
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  assert.equal(aborted, 0); assert.deepEqual(sent, []);
  // What the agent says after the cough is heard.
  voice.observe([reply('a10'), reply('a20', false), reply('a30')]); await tick();
  assert.deepEqual(spoken, ['A spoken answer.']); voice.stop();
});
test('a run is stopped as soon as what is being said is plainly for the agent, and only once', async () => {
  let aborted = 0;
  const pending = deferred<string>();
  const { voice, sent } = setup({ agentRunning: () => aborted === 0, abort: async () => { aborted++; }, transcribe: () => pending.promise,
    couldBeCommand: partial => /^(say|say that)$/i.test(partial.trim()) });
  voice.speechStart();
  voice.heard('Say'); await tick();
  assert.equal(aborted, 0);
  voice.heard("Stop, don't"); await tick();
  assert.equal(aborted, 1);
  voice.heard("Stop, don't touch that file"); await tick();
  voice.speechEnd(new Float32Array(16000)); pending.resolve("Stop, don't touch that file."); await tick(); await tick();
  assert.equal(aborted, 1); assert.deepEqual(sent, ["Stop, don't touch that file."]); voice.stop();
});
test('what is heard mid-run does not stop it when steering or while it could still be for the page', async () => {
  let aborted = 0;
  const { voice } = setup({ agentRunning: () => true, abort: async () => { aborted++; }, steering: () => true });
  voice.speechStart(); voice.heard('Also check the tests'); await tick();
  assert.equal(aborted, 0); voice.stop();
});
test('a cough mid-reply cuts it off, then the cut-off sentence and what came meanwhile are spoken', async () => {
  const started: string[] = [];
  let release: (() => void) | undefined;
  const { voice } = setup({ agentRunning: () => true, transcribe: async () => '', speak: async (text, signal) => {
    started.push(text);
    await new Promise<void>(resolve => { release = resolve; signal.addEventListener('abort', () => resolve(), { once: true }); });
  } });
  voice.observe([reply('a10'), { ...reply('a20', false), text: 'First sentence here now. Second sentence here now. ' }]); await tick();
  assert.deepEqual(started, ['First sentence here now.']);
  voice.speechStart(); await tick();
  voice.observe([reply('a10'), { ...reply('a20', false), text: 'First sentence here now. Second sentence here now. Third sentence here now. ' }]); await tick();
  assert.deepEqual(started, ['First sentence here now.']);
  voice.speechEnd(new Float32Array(16000)); await tick(); await tick();
  for (let i = 0; i < 3; i++) { release?.(); await tick(); await tick(); }
  assert.deepEqual(started, ['First sentence here now.', 'First sentence here now.', 'Second sentence here now.', 'Third sentence here now.']);
  voice.stop();
});
test('a push-to-talk press taken back does not lose the reply it cut off', async () => {
  const started: string[] = [];
  const { voice } = setup({ agentRunning: () => true, speak: async (text, signal) => {
    started.push(text); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  } });
  voice.observe([reply('a10'), reply('a20')]); await tick();
  voice.speechStart(); voice.speechCancel(); await tick(); await tick();
  assert.deepEqual(started, ['A spoken answer.', 'A spoken answer.']); voice.stop();
});
test('what is sent drops the reply it cut off', async () => {
  const { voice, spoken, sent } = setup();
  voice.speechStart();
  voice.observe([reply('a10'), reply('a20')]); await tick();
  voice.speechEnd(new Float32Array(16000)); await tick(); await tick();
  assert.deepEqual(sent, ['hello']); assert.deepEqual(spoken, []); voice.stop();
});
test('a stop that failed while speaking is tried again before what was said is sent', async () => {
  const calls: string[] = []; const firstAbort = deferred<void>();
  const { voice, sent } = setup({ agentRunning: () => true, send: async text => { calls.push('send'); sent.push(text); },
    abort: async () => { calls.push('abort'); if (calls.filter(c => c === 'abort').length === 1) { await firstAbort.promise; throw new Error('offline'); } } });
  voice.speechStart(); voice.heard('stop'); await tick();
  voice.speechEnd(new Float32Array(16000)); await tick();
  assert.deepEqual(calls, ['abort']);
  firstAbort.resolve(); await tick(); await tick(); await tick();
  assert.deepEqual(calls, ['abort', 'abort', 'send']); assert.deepEqual(sent, ['hello']); voice.stop();
});

test('an error in the chat is said once in one short line, and one from before voice mode is not', async () => {
  const { voice, spoken } = setup();
  const failure = (id: string) => ({ kind: 'notice' as const, id, text: 'Model error: overloaded', tone: 'error' as const });
  // a10 is where voice mode began: n5 is older, n11 and n12 are new.
  voice.observe([failure('n5'), reply('a10')]); await tick();
  assert.deepEqual(spoken, []);
  voice.observe([failure('n5'), reply('a10'), failure('n11')]); await tick();
  assert.deepEqual(spoken, ['An error occurred.']);
  voice.observe([failure('n5'), reply('a10'), failure('n11')]); await tick();
  assert.equal(spoken.length, 1);
  voice.observe([failure('n5'), reply('a10'), failure('n11'), { kind: 'notice' as const, id: 'n12', text: 'Aborted', tone: 'info' as const }]); await tick();
  assert.equal(spoken.length, 1);
  voice.observe([failure('n5'), reply('a10'), failure('n11'), failure('n13')]); await tick();
  assert.deepEqual(spoken, ['An error occurred.', 'An error occurred.']); voice.stop();
});

test('an error is said whatever the status settings say', async () => {
  for (const patch of [{ statusSpeech: false }, { sequential: true }]) {
    const { voice, spoken } = setup(patch);
    voice.observe([reply('a10'), { kind: 'notice' as const, id: 'n11', text: 'Model error: overloaded', tone: 'error' as const }]); await tick();
    assert.deepEqual(spoken, ['An error occurred.']); voice.stop();
  }
});

test('an error that comes in while the user speaks is not said, not even after the speech is cancelled', async () => {
  const { voice, spoken } = setup();
  voice.speechStart();
  voice.observe([reply('a10'), { kind: 'notice' as const, id: 'n11', text: 'Model error: overloaded', tone: 'error' as const }]); await tick();
  assert.deepEqual(spoken, []);
  voice.speechCancel(); await tick();
  voice.observe([reply('a10'), { kind: 'notice' as const, id: 'n11', text: 'Model error: overloaded', tone: 'error' as const }]); await tick();
  assert.deepEqual(spoken, []); voice.stop();
});

test('the error of a turn the agent refused is said, although replies are off after the failed send', async () => {
  const { voice, spoken, errors } = setup({ send: async () => { throw new Error('example has no API key.'); } });
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick(); await tick(); await tick();
  assert.deepEqual(errors, ['Could not send “hello”: example has no API key.']);
  voice.observe([reply('a10'), { kind: 'notice' as const, id: 'n12', text: 'example has no API key.', tone: 'error' as const }]); await tick();
  assert.deepEqual(spoken, ['An error occurred.']); voice.stop();
});

test('the error line is asked for as its own kind, which the page plays from a file instead of asking the speech model', async () => {
  const kinds: (string | undefined)[] = [];
  const { voice } = setup({ synthesize: async (_text, _signal, kind) => { kinds.push(kind); return async () => {}; } });
  voice.observe([reply('a10'), { kind: 'notice' as const, id: 'n11', text: 'Model error: overloaded', tone: 'error' as const }]); await tick();
  assert.deepEqual(kinds, ['error']); voice.stop();
});
