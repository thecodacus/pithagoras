import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insideFolder, latestFileActivity } from '../core/web/src/file-activity.js';

const folder = '/workspaces/proj';
const start = (seq: number, toolName: string, args: any, toolCallId = String(seq)) => ({ seq, type: 'tool_execution_start', payload: { toolName, args, toolCallId } });
const end = (seq: number, toolName: string, toolCallId: string, extra: any = {}) => ({ seq, type: 'tool_execution_end', payload: { toolName, toolCallId, ...extra } });

test('a path is taken as inside the folder, whether it was written relative or absolute', () => {
  assert.equal(insideFolder(folder, 'src/a.ts'), 'src/a.ts');
  assert.equal(insideFolder(folder, './src/../a.ts'), 'a.ts');
  assert.equal(insideFolder(folder, '/workspaces/proj/src/a.ts'), 'src/a.ts');
  assert.equal(insideFolder(folder + '/', '/workspaces/proj/a.ts'), 'a.ts');
});

test('a path somewhere else, or the folder itself, is not a file in it', () => {
  assert.equal(insideFolder(folder, '/etc/passwd'), undefined);
  assert.equal(insideFolder(folder, '/workspaces/proj-other/a.ts'), undefined);
  assert.equal(insideFolder(folder, '../other/a.ts'), undefined);
  assert.equal(insideFolder(folder, 'a/../../x'), undefined);
  assert.equal(insideFolder(folder, '.'), undefined);
  assert.equal(insideFolder(folder, '/workspaces/proj'), undefined);
});

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
