import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript } from '../../../core/web/src/transcript.ts';
import { agentsOf, subagents } from '../src/subagents.ts';

/**
 * The agents beside a chat, as the extension reads them from the chat's events (src/subagents.ts): every one of the
 * subagent protocol, and nothing else, with the conversation as the portal draws it (`ChatFeed.items`).
 */

const ev = (seq: number, type: string, payload: any = {}) => ({ seq, at: seq * 1000, type, payload });
const call = (seq: number, id: string, name: string, args: any = {}) => ev(seq, 'tool_execution_start', { toolCallId: id, toolName: name, args });
const update = (seq: number, id: string, name: string, partialResult: any) => ev(seq, 'tool_execution_update', { toolCallId: id, toolName: name, partialResult });
const list = (events: any[], ended = false) => subagents(events, buildTranscript(events), ended);

test('a web search that reported as it ran is not a subagent', () => {
  const events = [
    call(1, 'w', 'web_search', { query: 'x' }),
    update(2, 'w', 'web_search', { content: [{ type: 'text', text: 'searching' }] }),
    update(3, 'w', 'web_search', { content: [{ type: 'text', text: 'reading' }] }),
    ev(4, 'tool_execution_end', { toolCallId: 'w', toolName: 'web_search', updates: 2, result: { content: [{ type: 'text', text: 'done' }] } }),
  ];
  assert.deepEqual(list(events), []);
  assert.deepEqual(list(events.slice(0, 3)), [], 'nor while it runs');
});

test('code mode with progress details, still running, is not a subagent', () => {
  const events = [
    call(1, 'c', 'codemode', { code: 'x' }),
    update(2, 'c', 'codemode', { content: [], details: { calls: [{ name: 'read' }] } }),
  ];
  assert.deepEqual(list(events), []);
});

test('a research tool with phases, even with steps in its details, is not a subagent', () => {
  const events = [
    call(1, 'd', 'deep_research', { topic: 'x' }),
    update(2, 'd', 'deep_research', { details: { phase: 'searching', items: [{ type: 'text', text: 'a step' }, { type: 'toolCall', name: 'web_search' }] } }),
    update(3, 'd', 'deep_research', { details: { phase: 'reading' } }),
  ];
  assert.deepEqual(list(events), []);
});

test('a subagent of the protocol is listed with its status, among tools that are not', () => {
  const events = [
    call(1, 'w', 'web_search'),
    update(2, 'w', 'web_search', { content: [{ type: 'text', text: 'searching' }] }),
    call(3, 'call', 'delegate'),
    ev(4, 'portal_subagent', { op: 'start', id: 'a', label: 'Helper', toolCallId: 'call', input: true, stop: true }),
    ev(5, 'portal_subagent', { op: 'event', id: 'a', event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } } }),
  ];
  const running = list(events);
  assert.deepEqual(running.map((s) => [s.id, s.label, s.status, s.events.length]), [['a', 'Helper', 'running', 1]]);
  const over = [...events, ev(6, 'portal_subagent', { op: 'end', id: 'a', status: 'done' })];
  assert.deepEqual(list(over).map((s) => [s.id, s.status]), [['a', 'done']]);
});

test('one whose tool call ended without its end is stopped, at the call\'s end; one in the background runs on', () => {
  const start = (seq: number, id: string, callId: string, detached = false) => ev(seq, 'portal_subagent', { op: 'start', id, label: id, toolCallId: callId, ...(detached ? { detached: true } : {}) });
  const events = [
    call(1, 'c1', 'subagent'), start(2, 'a', 'c1'),
    call(3, 'c2', 'subagent'), start(4, 'b', 'c2', true),
    ev(5, 'tool_execution_end', { toolCallId: 'c1', toolName: 'subagent', result: { content: [] } }),
    ev(6, 'tool_execution_end', { toolCallId: 'c2', toolName: 'subagent', result: { content: [] } }),
  ];
  assert.deepEqual(list(events).map((s) => [s.id, s.status, s.until]), [['a', 'stopped', 5000], ['b', 'running', undefined]]);
  // The chat in error: the one in the background is not taken for over, as the portal writes its end when its pi goes.
  assert.deepEqual(list(events, true).map((s) => [s.id, s.status]), [['a', 'stopped'], ['b', 'running']]);
});

test('a chat\'s subagents are worked out once for each state of the chat, and one that has not changed is the object it was', () => {
  const events = [
    call(1, 'c1', 'subagent'),
    ev(2, 'portal_subagent', { op: 'start', id: 'a', label: 'One', toolCallId: 'c1' }),
    call(3, 'c2', 'subagent'),
    ev(4, 'portal_subagent', { op: 'start', id: 'b', label: 'Two', toolCallId: 'c2' }),
  ];
  const feed = (evs: any[]) => ({ events: evs, items: buildTranscript(evs), status: 'running' }) as any;
  const first = feed(events);
  const one = agentsOf('chat', first);
  assert.equal(agentsOf('chat', first), one, 'asked again of the same state: the same list');
  // A word of the chat's own reply, and a step of the second subagent's.
  const next = agentsOf('chat', feed([...events, ev(5, 'message_update', {}), ev(6, 'portal_subagent', { op: 'event', id: 'b', event: { type: 'turn_start' } })]));
  assert.equal(next[0], one[0], 'the first has not changed');
  assert.notEqual(next[1], one[1], 'the second has');
});

test('a subagent that works in a chat names it, and one whose kept chat is given more is the same subagent at work again, from then', () => {
  const start = (seq: number, callId: string, more: any = {}) => ev(seq, 'portal_subagent', { op: 'start', id: 'k', label: 'Kept', toolCallId: callId, input: true, stop: true, chat: 'k', ...more });
  const events = [
    call(1, 'c1', 'subagent'), start(2, 'c1'),
    ev(3, 'portal_subagent', { op: 'end', id: 'k', status: 'error', error: 'It failed' }),
    ev(4, 'tool_execution_end', { toolCallId: 'c1', toolName: 'subagent', result: { content: [] } }),
    call(5, 'c2', 'subagent'), start(6, 'c2', { detail: 'Continuing' }),
  ];
  const [again] = list(events);
  assert.deepEqual(
    [again.chat, again.status, again.since, again.until, again.error, again.detail, again.calls, again.toolCallId],
    ['k', 'running', 6000, undefined, undefined, 'Continuing', ['c1', 'c2'], 'c2'],
  );
  // Waiting for a slot, then starting, is one start: where it began stays.
  const waited = list([call(1, 'c3', 'subagent'), start(2, 'c3', { detail: 'Waiting for a free slot' }), start(3, 'c3', { detail: 'Starting' })]);
  assert.deepEqual(waited.map((s) => [s.since, s.detail, s.calls]), [[2000, 'Starting', ['c3']]]);
});

test('a subagent with the same calls is the same entry, however its list of them was made', () => {
  const events = [call(1, 'c1', 'subagent'), ev(2, 'portal_subagent', { op: 'start', id: 'a', label: 'One', toolCallId: 'c1', chat: 'a' })];
  const feed = (evs: any[]) => ({ events: evs, items: buildTranscript(evs), status: 'running' }) as any;
  const one = agentsOf('chat-calls', feed(events));
  assert.equal(agentsOf('chat-calls', feed([...events, ev(3, 'message_update', {})]))[0], one[0]);
});
