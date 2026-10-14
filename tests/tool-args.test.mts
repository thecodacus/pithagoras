import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript } from '../core/web/src/transcript.ts';
import { argLabel, argsSummary } from '../core/web/src/tool-args.ts';
import { argsSummary as serverSummary, describeToolCall } from '../core/server/src/tool-summary.ts';

const call = (toolName: string, args: unknown) => ({ seq: 1, type: 'tool_execution_start', payload: { toolCallId: 't', toolName, args } });
const detail = (toolName: string, args: unknown) => (buildTranscript([call(toolName, args)])[0] as any).detail;

test('a call with no command, file or search in it says its parameters, not their JSON', () => {
  // It said {"queries":["pgvector vs qdrant","homelab vector db"]}.
  assert.equal(detail('web_search', { queries: ['pgvector vs qdrant', 'homelab vector db'] }), 'Queries: pgvector vs qdrant, homelab vector db');
  assert.equal(
    detail('web_search', { queries: ['a'], numResults: 5, includeContent: false }),
    'Queries: a · Num results: 5 · Include content: false',
  );
  // Through the MCP adapter, what the tool inside was given.
  assert.equal(detail('mcp', { tool: 'github_list_issues', args: { owner: 'me', state: 'open' } }), 'Owner: me · State: open');
  // A list of objects is counted, an object inside left to the opened view.
  assert.equal(detail('plan', { steps: [{ a: 1 }, { a: 2 }], options: { deep: true }, title: 'Ship it' }), 'Steps: 2 items · Title: Ship it');
  for (const d of [detail('web_search', { queries: ['a', 'b'] }), detail('x', { a: [1, 2], b: 'c' })]) assert.doesNotMatch(d, /[{}"[\]]/);
});

test('what a call acted on is still said bare', () => {
  assert.equal(detail('bash', { command: 'ls  -la\n  /tmp' }), 'ls -la /tmp');
  assert.equal(detail('read', { path: 'web/src/main.tsx', offset: 1, limit: 40 }), 'web/src/main.tsx');
  assert.equal(detail('web_search', { query: 'current weather in Berlin' }), 'current weather in Berlin');
  assert.equal(detail('x', 'plain words'), 'plain words');
  // Nothing worth a line: no detail, rather than "{}".
  assert.equal(detail('browser_snapshot', {}), undefined);
  assert.equal(detail('x', { nested: { a: 1 } }), undefined);
});

test('a long summary is cut, and labels read as words', () => {
  const long = argsSummary({ queries: Array.from({ length: 40 }, (_, i) => `query number ${i}`) })!;
  assert.equal(long.length, 160);
  assert.ok(long.endsWith('…'));
  assert.deepEqual(['queries', 'file_path', 'numResults', 'oldText', 'max-depth', 'URL'].map(argLabel), ['Queries', 'File path', 'Num results', 'Old text', 'Max depth', 'Url']);
});

test('a channel says a call the way the chat does', () => {
  // One module for both: two copies were kept alike only by this test's few inputs.
  assert.equal(argsSummary, serverSummary);
  // It said "⚙ web_search · {"queries":[…]}", and "⚙ mcp · {"tool":…}" for anything behind the adapter.
  assert.deepEqual(describeToolCall({ toolName: 'web_search', args: { queries: ['a', 'b'] } }), { name: 'web_search', detail: 'Queries: a, b' });
  assert.deepEqual(describeToolCall({ toolName: 'mcp', args: { tool: 'github_list_issues', args: { state: 'open' } } }), { name: 'github_list_issues', detail: 'State: open' });
});

test('nothing in the page is written in a way older Safari cannot read', async () => {
  // A regex lookbehind is a syntax error in Safari before 16.4, where the whole bundle then failed to load.
  const { readdirSync, readFileSync } = await import('node:fs');
  const files = (readdirSync('core/web/src', { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f));
  const found = files.filter((f) => /\(\?<[!=]/.test(readFileSync(`core/web/src/${f}`, 'utf8')));
  assert.deepEqual(found, []);
});

test('a channel says a call through the tools tool as the tool it calls, and a search of the lazy tools as it is', () => {
  // The lazy tools are reached through `tools`: the line is the tool and what it was given, as for a direct call.
  assert.deepEqual(
    describeToolCall({ toolName: 'tools', args: { action: 'call', name: 'browser_navigate', args: { url: 'https://example.com' } } }),
    describeToolCall({ toolName: 'browser_navigate', args: { url: 'https://example.com' } }),
  );
  assert.deepEqual(
    describeToolCall({ toolName: 'tools', args: { action: 'call', name: 'browser_navigate', args: '{"url":"https://example.com"}' } }),
    { name: 'browser_navigate', detail: 'https://example.com' },
  );
  assert.deepEqual(describeToolCall({ toolName: 'tools', args: { action: 'call', name: 'browser_back' } }), { name: 'browser_back', detail: undefined });
  // A search calls nothing, so it stays a line of `tools`.
  assert.equal(describeToolCall({ toolName: 'tools', args: { action: 'search', query: 'pdf' } }).name, 'tools');
});
