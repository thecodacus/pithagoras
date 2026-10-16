import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript } from '../core/web/src/transcript.ts';
import { appendLiveEvents } from '../core/web/src/live-events.ts';
import { forgetOpenCalls, openCalls, READ_EVERY_MS } from '../core/web/src/open-calls.ts';
import { LiveEvents } from '../core/server/src/live-events.ts';

// The tool calls of a chat that have not ended, as a page that has the chat open has them (ChatFeed.calls): the ones the
// model is writing, with their arguments as far as they have come, and the ones running.

let seq = -1;
/** A piece of a tool call as the server sends it to a page: which call it is, and what of its arguments came. */
const piece = (call: string, name: string, type: string, delta = '', extra: object = {}) => ({
  seq: seq--, type: 'message_update', payload: { streamId: 'reply', assistantMessageEvent: { type, contentIndex: 0, ...(delta ? { delta } : {}), toolCallId: call, toolName: name, ...extra } },
});

test('the server says which call a piece of a tool call being written is of, as only the message so far says', () => {
  const live = new LiveEvents(() => ({}) as any);
  const partial = { role: 'assistant', content: [{ type: 'text', text: 'Writing it.' }, { type: 'toolCall', id: 'c1', name: 'doc_create', arguments: { title: 'Id' } }] };
  const row = live.record('s', 'message_update', { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta: 'eas', partial } });
  const sent = JSON.parse(row.payload);
  assert.deepEqual(sent.assistantMessageEvent, { type: 'toolcall_delta', contentIndex: 1, delta: 'eas', toolCallId: 'c1', toolName: 'doc_create' });
  // The message so far is not sent with each piece: only what it added.
  assert.equal('partial' in sent.assistantMessageEvent, false);
  const text = JSON.parse(live.record('s', 'message_update', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x', partial } }).payload);
  assert.deepEqual(text.assistantMessageEvent, { type: 'text_delta', contentIndex: 0, delta: 'x' }, 'a text is as it was');
});

test('a page keeps what has come of each call being written, in the reply being written, and its arguments whole once the model has written it', () => {
  const events = appendLiveEvents([], [
    piece('c1', 'doc_create', 'toolcall_start'),
    piece('c1', 'doc_create', 'toolcall_delta', '{"title":"Ide'),
    piece('c2', 'bash', 'toolcall_delta', '{"command":"ls'),
    piece('c1', 'doc_create', 'toolcall_delta', 'as","markdown":"First'),
  ]);
  assert.equal(events.length, 1, 'one entry for the reply');
  const blocks = events[0].payload.message.content;
  // The one written last is last: what the reply is doing now.
  assert.deepEqual(blocks.map((b: any) => [b.id, b.name, b.partialJson]), [['c2', 'bash', '{"command":"ls'], ['c1', 'doc_create', '{"title":"Ideas","markdown":"First']]);
  const ended = appendLiveEvents(events, [piece('c1', 'doc_create', 'toolcall_end', '', { toolCall: { id: 'c1', name: 'doc_create', arguments: { title: 'Ideas', markdown: 'First things' } } })]);
  assert.deepEqual(ended[0].payload.message.content.at(-1).arguments, { title: 'Ideas', markdown: 'First things' });
  // The reply as the transcript draws it is as it was.
  assert.equal(buildTranscript(ended).filter((i) => i.kind === 'assistant').length, 1);
});

test('the calls being written are read as far as they have come, a few times a second at most, and whole once written', () => {
  const at = 1_000_000;
  let events = appendLiveEvents([], [piece('c1', 'doc_create', 'toolcall_delta', '{"title":"Ide')]);
  const first = openCalls('chat', events, [], at).calls;
  assert.deepEqual(first, [{ name: 'doc_create', callId: 'c1', status: 'writing', input: { title: 'Ide' } }]);
  // More came, too soon after: what was read stands, the same object, so nothing that drew it is drawn again.
  events = appendLiveEvents(events, [piece('c1', 'doc_create', 'toolcall_delta', 'as","markdown":"Fir')]);
  assert.equal(openCalls('chat', events, [], at + 10).calls[0].input, first[0].input);
  // Once the time has gone by, it is read again.
  assert.deepEqual(openCalls('chat', events, [], at + READ_EVERY_MS).calls[0].input, { title: 'Ideas', markdown: 'Fir' });
  // Written whole: as the model wrote it, at once.
  events = appendLiveEvents(events, [piece('c1', 'doc_create', 'toolcall_end', '', { toolCall: { arguments: { title: 'Ideas', markdown: 'First' } } })]);
  assert.deepEqual(openCalls('chat', events, [], at + READ_EVERY_MS + 1).calls[0].input, { title: 'Ideas', markdown: 'First' });
  forgetOpenCalls('chat');
});

test('a call through the tools tool is the call of the tool it calls, and the calls that are running are open too, until they end', () => {
  const at = 2_000_000;
  const events = [
    { seq: 1, type: 'tool_execution_start', payload: { toolCallId: 'r1', toolName: 'doc_edit', args: { id: 'a', edits: [] } } },
    { seq: 2, type: 'tool_execution_start', payload: { toolCallId: 'r2', toolName: 'bash', args: { command: 'ls' } } },
    { seq: 3, type: 'tool_execution_end', payload: { toolCallId: 'r2', toolName: 'bash', result: { content: [{ type: 'text', text: 'ok' }], details: { exit: 0 } } } },
    ...appendLiveEvents([], [piece('c1', 'tools', 'toolcall_delta', '{"action":"call","name":"doc_create","args":{"title":"Thr')]),
  ];
  const items = buildTranscript(events);
  const { calls, call } = openCalls('lazy', events, items, at);
  assert.deepEqual(calls.map((c) => [c.callId, c.name, c.status, c.input]), [['r1', 'doc_edit', 'running', { id: 'a', edits: [] }], ['c1', 'doc_create', 'writing', { title: 'Thr' }]]);
  // Any call by its id, ended or not, as it came out.
  assert.deepEqual(call('r2'), { name: 'bash', callId: 'r2', status: 'done', input: { command: 'ls' }, output: 'ok', details: { exit: 0 } });
  assert.equal(call('c1')?.status, 'writing');
  assert.equal(call('nowhere'), undefined);
  // A run that ended with a call open: it is over, and did not succeed.
  const cut = buildTranscript([events[0], { seq: 4, type: 'agent_start', payload: {} }]);
  assert.deepEqual(openCalls('cut', [], cut, at).calls, []);
  assert.equal(openCalls('cut', [], cut, at).call('r1')?.status, 'error');
  forgetOpenCalls('lazy');
});

test('a page that opens while a call is being written has what came of it so far, and goes on with the pieces that follow', () => {
  const live = new LiveEvents(() => ({}) as any);
  let partial: any = { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'doc_create', arguments: {} }] };
  for (const delta of ['{"title":', '"Id']) {
    partial = { ...partial, content: [{ ...partial.content[0], arguments: delta === '"Id' ? { title: 'Id' } : {} }] };
    live.record('s', 'message_update', { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta, partial } });
  }
  const [snapshot] = live.snapshot('s');
  const opened = { seq: snapshot.seq, type: snapshot.type, payload: JSON.parse(snapshot.payload) };
  const block = opened.payload.message.content[0];
  assert.equal(block.partialJson, '{"title":"Id');
  const at = 3_000_000;
  // As it was when the page opened: pi's reading of it.
  assert.deepEqual(openCalls('mid', [opened], [], at).calls[0].input, { title: 'Id' });
  // The pieces that follow go on from what had come.
  const streamId = opened.payload.streamId;
  const more = appendLiveEvents([opened], [{ seq: -5, type: 'message_update', payload: { streamId, assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: 'eas"', toolCallId: 'c1', toolName: 'doc_create' } } }]);
  assert.deepEqual(openCalls('mid', more, [], at + READ_EVERY_MS).calls[0].input, { title: 'Ideas' });
  forgetOpenCalls('mid');
});
