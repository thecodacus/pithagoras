import test from 'node:test';
import assert from 'node:assert/strict';
import { activity, buildTranscript } from '../core/web/src/transcript.ts';

const delta = (seq: number, text: string) => ({ seq, type: 'message_update', payload: { streamId: 'r', assistantMessageEvent: { type: 'text_delta', delta: text } } });
const first = { seq: 1, type: 'portal_prompt', payload: { message: 'fix the build' } };
const steer = { seq: 3, type: 'portal_prompt', payload: { message: 'use the other file', queued: true } };

test('a message sent into a run waits at the foot, without splitting the reply', () => {
  const items = buildTranscript([first, delta(2, 'Looking'), steer, delta(4, ' at it')] as any);
  assert.deepEqual(items.map((i) => i.kind), ['user', 'assistant', 'user']);
  assert.equal((items[1] as any).text, 'Looking at it');
  assert.equal((items[2] as any).queued, true);
});

test('taken in, it sits where the agent read it, as an ordinary message', () => {
  const items = buildTranscript([
    first, delta(2, 'Looking'), steer,
    { seq: 4, type: 'tool_execution_start', payload: { toolName: 'bash', toolCallId: 't' } },
    { seq: 5, type: 'portal_taken', payload: { seq: 3 } },
    delta(6, 'Switching files'),
  ] as any);
  assert.deepEqual(items.map((i) => i.kind), ['user', 'assistant', 'tool', 'user', 'assistant']);
  assert.equal((items[3] as any).queued, undefined);
  assert.equal((items[3] as any).text, 'use the other file');
});

test('stopped before it was taken in, it shows as not sent, where the run stopped', () => {
  const items = buildTranscript([
    first, delta(2, 'Looking'), steer,
    { seq: 4, type: 'portal_unsent', payload: { seqs: [3] } },
    { seq: 5, type: 'portal_status', payload: { status: 'idle', aborted: true } },
  ] as any);
  assert.deepEqual(items.map((i) => i.kind), ['user', 'assistant', 'user', 'notice']);
  assert.equal((items[2] as any).unsent, "stopped");
});

test('a waiting message does not reset what the agent is doing', () => {
  const now = { ...delta(2, 'Looking'), at: 't2' };
  assert.equal(activity([first, now, { ...steer, at: 't3' }] as any).label, 'writing the reply');
});

test('a message whose prompt is older than the events loaded is still shown where it was read', () => {
  const items = buildTranscript([
    delta(40, 'Still going'),
    { seq: 41, type: 'portal_taken', payload: { seq: 3, prompt: { message: 'use the other file', queued: true, steer: true } } },
    delta(42, 'Switching'),
  ] as any);
  assert.deepEqual(items.map((i) => i.kind), ['assistant', 'user', 'assistant']);
  assert.equal((items[1] as any).id, 'u3');
  assert.equal((items[1] as any).text, 'use the other file');
  assert.equal((items[1] as any).queued, undefined);
});

test('so is one that was never sent, and one the portal could not tell about says so', () => {
  const items = buildTranscript([
    { seq: 50, type: 'portal_unsent', payload: { seqs: [7], prompts: { 7: { message: 'stop that' } } } },
    { seq: 51, type: 'portal_unsent', payload: { seqs: [8], prompts: { 8: { message: 'maybe' } }, restarted: true, unsure: true } },
  ] as any);
  assert.deepEqual(items.map((i: any) => [i.text, i.unsent]), [['stop that', 'stopped'], ['maybe', 'unsure']]);
});

test('once the prompt itself is loaded, the message is shown once', () => {
  const items = buildTranscript([
    first, steer,
    { seq: 5, type: 'portal_taken', payload: { seq: 3, prompt: { message: 'use the other file', queued: true } } },
  ] as any);
  assert.equal(items.filter((i: any) => i.kind === 'user' && i.text === 'use the other file').length, 1);
});

test('one sent as starting a run, that pi queued into another, moves to where it was read', () => {
  const items = buildTranscript([
    { seq: 1, type: 'portal_prompt', payload: { message: 'after all' } },
    delta(2, 'A routine answering'),
    { seq: 3, type: 'portal_taken', payload: { seq: 1, prompt: { message: 'after all', queued: true } } },
    delta(4, 'Now yours'),
  ] as any);
  assert.deepEqual(items.map((i) => i.kind), ['assistant', 'user', 'assistant']);
  assert.equal((items[1] as any).text, 'after all');
});
