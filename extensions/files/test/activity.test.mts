import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileOfCall, latestFileActivity } from '../src/activity.ts';

const folder = '/workspaces/proj';
const start = (seq: number, toolName: string, args: any, toolCallId = String(seq)) => ({ seq, type: 'tool_execution_start', payload: { toolName, args, toolCallId } });
const end = (seq: number, toolName: string, toolCallId: string, extra: any = {}) => ({ seq, type: 'tool_execution_end', payload: { toolName, toolCallId, ...extra } });

test('a read counts when it starts', () => {
  assert.deepEqual(latestFileActivity([start(3, 'read', { path: 'a.md' })], folder), { seq: 3, path: 'a.md', tool: 'read' });
});

test('a write or an edit counts when it ends, with the path from the call that began it', () => {
  const events = [start(1, 'write', { path: 'out.txt', content: 'x' }, 'c1')];
  assert.equal(latestFileActivity(events, folder), null);
  events.push(end(2, 'write', 'c1') as any);
  assert.deepEqual(latestFileActivity(events, folder), { seq: 2, path: 'out.txt', tool: 'write' });
  const edited = [start(5, 'edit', { file_path: '/workspaces/proj/src/x.ts' }, 'e'), end(6, 'edit', 'e')];
  assert.deepEqual(latestFileActivity(edited, folder), { seq: 6, path: 'src/x.ts', tool: 'edit' });
});

test('a write that failed shows nothing new', () => {
  const events = [start(1, 'read', { path: 'a.md' }), start(2, 'write', { path: 'b.md' }, 'w'), end(3, 'write', 'w', { isError: true })];
  assert.equal(latestFileActivity(events, folder)?.path, 'a.md');
});

test('the latest counts, and other tools and other places do not', () => {
  const events = [
    start(1, 'read', { path: 'a.md' }),
    start(2, 'bash', { command: 'cat b.md' }),
    start(3, 'read', { path: '/etc/hosts' }),
    start(4, 'grep', { pattern: 'x', path: 'c.md' }),
  ];
  assert.deepEqual(latestFileActivity(events, folder), { seq: 1, path: 'a.md', tool: 'read' });
  assert.equal(latestFileActivity([], folder), null);
});

test('an ending with no call id is not matched to some other call', () => {
  const events = [
    start(1, 'read', { path: 'other.md' }, undefined as any),
    { seq: 2, type: 'tool_execution_end', payload: { toolName: 'write' } },
  ];
  // The read is the latest thing that counts; the write's file is not known, and not guessed.
  assert.deepEqual(latestFileActivity(events as any, folder), { seq: 1, path: 'other.md', tool: 'read' });
  const onlyEnd = [{ seq: 3, type: 'tool_execution_end', payload: { toolName: 'edit' } }, start(4, 'bash', { command: 'ls' })];
  assert.equal(latestFileActivity(onlyEnd as any, folder), null);
});

test('a call of the agent\'s is for Files when it reads or changes a file in the chat\'s folder', () => {
  const call = (name: string, input: Record<string, unknown>) => ({ name, input, status: 'done' as const });
  assert.equal(fileOfCall(call('read', { path: 'src/a.ts' }), folder), 'src/a.ts');
  assert.equal(fileOfCall(call('edit', { file_path: '/workspaces/proj/b.md' }), folder), 'b.md');
  assert.equal(fileOfCall(call('write', { path: '/etc/hosts' }), folder), undefined, 'somewhere else');
  assert.equal(fileOfCall(call('bash', { command: 'cat a.ts' }), folder), undefined, 'not a file tool');
  assert.equal(fileOfCall(call('read', {}), folder), undefined);
});
