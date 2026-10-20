import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolArgsOf, toolNameOf } from '../core/web/src/tool-payload.js';
import { describeCall } from '../core/web/src/tool-activity.js';
import { latestFileActivity } from '../extensions/files/src/activity.ts';
import { latestCommand } from '../extensions/terminal/src/runs.ts';

/** A tool event of pi's names the tool `toolName` or `name`, and its arguments `args`, `input` or `parameters`. */
const spellings = (name: string, args: unknown) => [
  { toolName: name, args },
  { name, input: args },
  { toolName: name, parameters: args },
];

test('the name is toolName, else name, else what the reader falls back to', () => {
  assert.equal(toolNameOf({ toolName: 'read', name: 'other' }), 'read');
  assert.equal(toolNameOf({ name: 'read' }), 'read');
  assert.equal(toolNameOf({}), '');
  assert.equal(toolNameOf({}, 'tool'), 'tool');
  assert.equal(toolNameOf(undefined, 'tool'), 'tool');
  assert.equal(toolNameOf(null), '');
});

test('the arguments are input, else args, else parameters, and nothing where there are none', () => {
  assert.deepEqual(toolArgsOf({ input: { a: 1 }, args: { a: 2 }, parameters: { a: 3 } }), { a: 1 });
  assert.deepEqual(toolArgsOf({ args: { a: 2 }, parameters: { a: 3 } }), { a: 2 });
  assert.deepEqual(toolArgsOf({ parameters: { a: 3 } }), { a: 3 });
  assert.equal(toolArgsOf({}), undefined);
  assert.equal(toolArgsOf(undefined), undefined);
});

test('every reader of a tool event reads each spelling alike', () => {
  const folder = '/work/proj';
  for (const read of spellings('read', { path: 'src/app.ts' })) {
    assert.equal(describeCall(read, folder).label, 'Reading app.ts', JSON.stringify(read));
    assert.deepEqual(latestFileActivity([{ seq: 4, type: 'tool_execution_start', payload: read } as any], folder), { seq: 4, path: 'src/app.ts', tool: 'read' }, JSON.stringify(read));
  }
  for (const bash of spellings('bash', { command: 'ls' })) {
    assert.equal(latestCommand([{ seq: 5, type: 'tool_execution_start', payload: bash } as any]), 5, JSON.stringify(bash));
  }
  // A tool behind the MCP adapter: what the adapter was asked to call is what is told, not "mcp".
  for (const wrapped of spellings('mcp', { server: 'browser', tool: 'navigate', args: { url: 'https://example.com/a' } })) {
    assert.equal(describeCall(wrapped, folder).label, 'Using navigate', JSON.stringify(wrapped));
  }
});
