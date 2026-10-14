import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript, replyStats } from '../core/web/src/transcript.ts';
import { LiveEvents } from '../core/server/src/live-events.ts';

const usage = { input: 15, output: 20, cacheRead: 40, cacheWrite: 0 };
const timings = { promptTokens: 15, cachedTokens: 40, promptMs: 250.5, promptPerSecond: 59.9, outputTokens: 20, outputMs: 556.9, outputPerSecond: 35.9, draftTokens: 19, draftAccepted: 11 };
const reply = (extra: object = {}) => ({ seq: 12, type: 'message_end', at: 10_000, payload: { streamId: 'r', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }], usage }, ...extra } });

test('a reply from llama.cpp says both its speeds as llama.cpp measured them, and the whole prompt it read', () => {
  const item = buildTranscript([reply({ timings })])[0] as any;
  assert.deepEqual(item.stats, { input: 55, cached: 40, output: 20, outputPerSecond: 35.9, outputMs: 556.9, read: 15, promptPerSecond: 59.9, promptMs: 250.5, draft: { tokens: 19, accepted: 11 } });
});

test('llama.cpp\'s cache count is used where pi\'s usage has none', () => {
  const stats = replyStats({ ...reply({ timings }).payload, message: { role: 'assistant', content: [], usage: { input: 15, output: 20 } } })!;
  assert.equal(stats.cached, 40);
});

test('another provider has the tokens from its usage, and its answer speed from when its first and last tokens came', () => {
  const stats = replyStats(reply({ firstTokenAt: 9_000 }).payload, 10_000)!;
  assert.deepEqual([stats.input, stats.output, stats.outputPerSecond, stats.promptPerSecond], [55, 20, 20, undefined]);
  // Nothing to tell a speed by: the tokens alone.
  assert.equal(replyStats(reply().payload, 10_000)!.outputPerSecond, undefined);
  // Nothing at all: no line.
  assert.equal(replyStats({ message: { role: 'assistant', content: [] } }), undefined);
});

test('a prompt wholly in the cache has no prefill speed: nothing was read', () => {
  const stats = replyStats(reply({ timings: { ...timings, promptTokens: 0, promptPerSecond: 0 } }).payload)!;
  assert.equal(stats.promptPerSecond, undefined);
  assert.equal(stats.outputPerSecond, 35.9);
});

test('the server keeps llama.cpp\'s figures on the message they were measured for, and not on a later one', () => {
  const stored: any[] = [];
  const live = new LiveEvents((session, type, payload) => { stored.push({ type, payload }); return { seq: stored.length, session_id: session, type, payload: JSON.stringify(payload), created_at: '' }; });
  live.record('s', 'message_start', { message: { role: 'assistant' } });
  live.record('s', 'message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'Hi' } });
  live.timings('s', timings as any);
  live.record('s', 'message_end', { message: { role: 'assistant', content: [] } });
  const first = stored.at(-1).payload;
  assert.deepEqual(first.timings, timings);
  assert.equal(typeof first.firstTokenAt, 'number');
  // The next answer: none of its own, so none.
  live.record('s', 'message_start', { message: { role: 'assistant' } });
  live.record('s', 'message_end', { message: { role: 'assistant', content: [] } });
  assert.equal(stored.at(-1).payload.timings, undefined);
  // Figures left from an answer that never ended are dropped when the next one starts.
  live.timings('s', timings as any);
  live.record('s', 'message_start', { message: { role: 'assistant' } });
  live.record('s', 'message_end', { message: { role: 'assistant', content: [] } });
  assert.equal(stored.at(-1).payload.timings, undefined);
});
