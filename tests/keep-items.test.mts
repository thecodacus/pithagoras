import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript, keepItems } from '../core/web/src/transcript.ts';

const event = (type: string, at: number, payload: any = {}) => ({ type, at, payload, seq: at });
const said = [
  event('portal_prompt', 100, { message: 'First question' }),
  event('message_end', 110, { message: { role: 'assistant', content: [{ type: 'text', text: 'First answer' }] } }),
  event('tool_execution_start', 120, { toolCallId: 'a', toolName: 'read', args: { path: 'a.txt', offset: 1 } }),
  event('tool_execution_end', 125, { toolCallId: 'a', toolName: 'read', result: { content: [{ type: 'text', text: 'file' }] } }),
  event('portal_prompt', 130, { message: 'Second question' }),
];

test('an entry that says the same is the entry from before, where it was made anew from the events', () => {
  const was = buildTranscript(said);
  const next = buildTranscript([...said, event('message_update', 140, { streamId: 's', assistantMessageEvent: { type: 'text_delta', delta: 'Typ' } })]);
  // Made anew: nothing is shared before it is kept.
  assert.ok(was.every((item, i) => item !== next[i]), 'the entries are rebuilt each time');
  const kept = keepItems(was, next);
  assert.equal(kept.length, next.length);
  for (let i = 0; i < was.length; i++) assert.equal(kept[i], was[i], `entry ${i} is the one from before`);
  assert.equal(kept[kept.length - 1], next[next.length - 1], 'what is new is as it was made');
});

test('an entry that changed is the new one, and one that changed deep inside too', () => {
  const was = buildTranscript(said);
  const more = buildTranscript(said.map((e) => (e.seq === 125 ? { ...e, payload: { ...e.payload, result: { content: [{ type: 'text', text: 'file, changed' }] } } } : e)));
  const kept = keepItems(was, more);
  const tool = was.findIndex((item) => item.kind === 'tool');
  assert.notEqual(kept[tool], was[tool]);
  assert.equal(kept[tool], more[tool]);
  // The others, which did not change, are kept.
  assert.equal(kept[0], was[0]);
  assert.equal(kept[tool - 1], was[tool - 1]);
});

test('with no entries from before, the new ones are all there is', () => {
  const next = buildTranscript(said);
  assert.equal(keepItems([], next), next);
});
