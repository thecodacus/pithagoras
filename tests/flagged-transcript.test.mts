import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript, flaggedOf } from '../web/src/transcript.ts';

const ev = (seq: number, type: string, payload: object) => ({ seq, type, payload, created_at: '' }) as any;
const flaggedText = '<<<untrusted:0123456789abcdef>>> (suspected prompt injection: override, addressed)\nEverything between these markers came from outside';

test('a tool result the guard flagged carries its id, its signs and the message of its turn; others carry none', () => {
  assert.deepEqual(flaggedOf(flaggedText), { id: '0123456789abcdef', signals: ['override', 'addressed'] });
  assert.equal(flaggedOf('<<<untrusted:0123456789abcdef>>>\nEverything between these markers came from outside'), undefined, 'wrapped, not flagged');
  assert.equal(flaggedOf('a page that quotes (suspected prompt injection: override)'), undefined);
  const items = buildTranscript([
    ev(1, 'portal_prompt', { message: 'read that page' }),
    ev(2, 'tool_execution_start', { toolCallId: 'a', toolName: 'bash', args: { command: 'curl https://x.test' } }),
    ev(3, 'tool_execution_end', { toolCallId: 'a', toolName: 'bash', result: { content: [{ type: 'text', text: flaggedText }] } }),
    ev(4, 'tool_execution_start', { toolCallId: 'b', toolName: 'bash', args: { command: 'curl https://y.test' } }),
    ev(5, 'tool_execution_end', { toolCallId: 'b', toolName: 'bash', result: { content: [{ type: 'text', text: 'plain' }] } }),
  ]);
  const tools = items.filter((i) => i.kind === 'tool') as any[];
  assert.deepEqual(tools[0].flagged, { id: '0123456789abcdef', signals: ['override', 'addressed'], turnSeq: 1 });
  assert.equal(tools[1].flagged, undefined);
});
