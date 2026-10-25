import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript } from '../core/web/src/transcript.ts';
import { subagents } from '../core/web/src/subagents.ts';

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
