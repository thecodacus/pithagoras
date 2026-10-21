import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeCall, describeOutcome, elapsed } from '../core/web/src/tool-activity.js';

const folder = '/work/proj';
const start = (toolName: string, args: any) => ({ toolName, args, toolCallId: 'c' });
const end = (toolName: string, result: any, isError = false) => ({ toolName, toolCallId: 'c', result, isError });
const said = (t: string, details?: any) => ({ content: [{ type: 'text', text: t }], ...(details ? { details } : {}) });

test('file tools name the file, by its path in the folder, and open no window of the portal\'s own', () => {
  // The window a file's card opens is an extension's that says it is for files (Files', `opensFor`).
  assert.deepEqual(describeCall(start('read', { path: 'src/app.ts', offset: 10, limit: 20 }), folder), { label: 'Reading app.ts', detail: 'src/app.ts · lines 10–29' });
  assert.deepEqual(describeCall(start('edit', { path: '/work/proj/README.md' }), folder), { label: 'Editing README.md', detail: '' });
  assert.deepEqual(describeCall(start('write', { path: '/etc/hosts' }), folder), { label: 'Writing hosts', detail: '' });
});

test('other tools say what they are doing and where it can be seen', () => {
  assert.equal(describeCall(start('bash', { command: 'npm   test' }), folder).detail, 'npm test');
  // No window of the portal's own: the terminal extension's says it is for commands (`opensFor`).
  assert.equal(describeCall(start('bash', { command: 'x' }), folder).target, undefined);
  assert.equal(describeCall(start('grep', { pattern: 'retry', glob: '*.ts' }), folder).label, 'Searching for “retry”');
  // A browser tool's card is the browser's extension's to word (its window's `describe`), and opens its window: none of the portal's own.
  assert.deepEqual(describeCall(start('browser_navigate', { url: 'https://example.com/a?b' }), folder), { label: 'Using browser navigate', detail: 'https://example.com/a?b' });
  assert.deepEqual(describeCall(start('jira_get_issue', { query: 'ABC-1' }), folder), { label: 'Using jira get issue', detail: 'ABC-1' });
});

test('an ending says what came of it', () => {
  assert.equal(describeOutcome(start('edit', {}), end('edit', said('ok', { diff: ' 1 a\n-2 b\n+2 c\n+3 d\n   ...' }))), '+2 −1');
  assert.equal(describeOutcome(start('write', { content: 'a\nb\nc\n' }), end('write', said('ok'))), '3 lines');
  assert.equal(describeOutcome(start('grep', {}), end('grep', said('a.ts:1: x\nb.ts:4: y'))), '2 matches');
  assert.equal(describeOutcome(start('grep', {}), end('grep', said('No matches found'))), 'No matches');
  assert.equal(describeOutcome(start('find', {}), end('find', said('a.ts\nb.ts\n\n[Showing first 2]', { resultLimitReached: 2 }))), '2 files+');
  assert.equal(describeOutcome(start('ls', {}), end('ls', said('a/\nb'))), '2 entries');
  assert.equal(describeOutcome(start('bash', { command: 'x' }), end('bash', said('\nCommand exited with code 1\nmore'), true)), 'Command exited with code 1');
  assert.equal(describeOutcome(start('bash', { command: 'x' }), end('bash', said('fine'))), '');
});

test('time taken reads as seconds, then minutes', () => {
  assert.equal(elapsed(4200), '4 s');
  assert.equal(elapsed(125_000), '2 min 5 s');
  assert.equal(elapsed(120_000), '2 min');
});
