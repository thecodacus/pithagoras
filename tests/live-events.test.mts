import test from 'node:test';
import assert from 'node:assert/strict';
import { activity, buildTranscript } from '../core/web/src/transcript.ts';
import { appendLiveEvent, appendLiveEvents } from '../core/web/src/live-events.ts';

const delta = (seq: number, type: string, text: string, at?: number, streamId = 'reply') => ({
  seq, type: 'message_update', ...(at !== undefined ? { at } : {}), payload: { streamId, assistantMessageEvent: { type, delta: text } },
});
const tokens = (n: number, from = -1) => Array.from({ length: n }, (_, i) => delta(from - i, 'text_delta', `w${i} `, 1000 + i));

test('the tokens of a reply are one entry, not one each', () => {
  const events = tokens(3000).reduce(appendLiveEvent, [] as any[]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'message_snapshot');
  const text = (buildTranscript(events)[0] as any).text as string;
  assert.ok(text.startsWith('w0 w1 w2 ') && text.endsWith('w2999 '));
});

test('a batch is what its events one at a time would have made', () => {
  const batch = [
    delta(-1, 'thinking_delta', 'Plan', 100),
    delta(-2, 'thinking_delta', ' it', 160),
    delta(-3, 'text_delta', 'Hello', 200),
    delta(-4, 'toolcall_delta', '{"path"', 210),
    delta(-5, 'text_delta', ' there', 220),
    { seq: -6, type: 'tool_execution_update', payload: { toolCallId: 't', partialResult: { content: [] } } },
    { seq: -7, type: 'tool_execution_update', payload: { toolCallId: 't', partialResult: { content: [{ type: 'text', text: 'more' }] } } },
  ];
  const once = appendLiveEvents([], batch);
  assert.deepEqual(once, batch.reduce(appendLiveEvent, [] as any[]));
  // The tool's newer output replaced its older, and the reply is one entry.
  assert.equal(once.length, 2);
  const [reply] = buildTranscript(once) as any[];
  assert.equal(reply.text, 'Hello there');
  assert.equal(reply.thinking, 'Plan it');
  // When the reasoning ran is kept from its tokens' times.
  assert.equal(reply.thinkingSince, 100);
  assert.equal(reply.thinkingUntil, 160);
});

test('the transcript of the folded reply is the one the unfolded tokens made', () => {
  const batch = [delta(-1, 'thinking_delta', 'Think', 10), delta(-2, 'text_delta', 'Say', 20), delta(-3, 'text_delta', ' it', 30)];
  assert.deepEqual(buildTranscript(appendLiveEvents([], batch)), buildTranscript(batch as any));
});

test('a message ending takes its stream with it, also within one batch', () => {
  const end = { seq: 9, type: 'message_end', payload: { streamId: 'reply', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello there' }] } } };
  const other = delta(-20, 'text_delta', 'Next', 500, 'second');
  const events = appendLiveEvents([{ seq: 4, type: 'agent_start', payload: {} } as any], [...tokens(50), end, other]);
  assert.deepEqual(events.map((e) => e.type), ['agent_start', 'message_end', 'message_snapshot']);
  assert.equal(events[2].payload.streamId, 'second');
});

test('a token adds to the stream it belongs to, and leaves the list it was given as it was', () => {
  const first = appendLiveEvents([], [delta(-1, 'text_delta', 'a', 1), delta(-2, 'text_delta', 'b', 1, 'second')]);
  const kept = JSON.stringify(first);
  const next = appendLiveEvents(first, [delta(-3, 'text_delta', 'c', 2)]);
  assert.equal(JSON.stringify(first), kept);
  assert.equal(next.length, 2);
  assert.equal(next.find((e) => e.payload.streamId === 'reply')!.payload.message.content[0].text, 'ac');
  assert.equal(appendLiveEvents(first, []), first);
});

test('what a reply being written is doing is read from the folded entry', () => {
  assert.equal(activity(appendLiveEvents([], [delta(-1, 'thinking_delta', 'hm', 1)])).label, 'thinking');
  assert.equal(activity(appendLiveEvents([], [delta(-1, 'thinking_delta', 'hm', 1), delta(-2, 'text_delta', 'Hi', 2)])).label, 'writing the reply');
  // A tool call's arguments are written too, and are not shown.
  assert.equal(activity(appendLiveEvents([], [delta(-1, 'toolcall_delta', '{"a"', 1)])).label, 'writing the reply');
});

test('a long run is folded in one pass over the list, not one per token', () => {
  const history = Array.from({ length: 1200 }, (_, i) => ({ seq: i + 1, type: 'tool_execution_end', payload: { toolCallId: `t${i}` } }));
  const started = Date.now();
  const events = appendLiveEvents(history as any[], tokens(30_000));
  assert.equal(events.length, 1201);
  // Taking each token on its own list was seconds of copying.
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
});
