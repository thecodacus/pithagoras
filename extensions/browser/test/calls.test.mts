import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Portal } from '@pithagoras/extension-api';
import { setPortal } from '../src/portal.tsx';
import { describeBrowserCall, isBrowserCall, latestBrowserCall } from '../src/calls.ts';

/**
 * Which of the agent's calls drive a browser (what opens Browser's voice window, by itself and from a card), and what
 * voice mode's card of one says: src/calls.ts.
 */

// Its words as the code writes them: the portal's `t` in English.
setPortal({ t: (text: string) => text } as unknown as Portal);

const via = (name: string, args: unknown) => ({ action: 'call', name, args });
const at = (seq: number, toolName: string, args: unknown) => ({ seq, type: 'tool_execution_start', payload: { toolName, toolCallId: `c${seq}`, args } });

/** A tool event of pi's names the tool `toolName` or `name`, and its arguments `args`, `input` or `parameters`. */
const spellings = (name: string, args: unknown) => [
  { toolName: name, args },
  { name, input: args },
  { toolName: name, parameters: args },
];

test('only browser tool calls count as driving the browser; plain mentions and other tools do not', () => {
  const events = [
    { seq: 1, type: 'message_update', payload: { text: 'browser' } },
    { seq: 2, type: 'tool_execution_start', payload: { toolName: 'bash', input: { command: 'echo browser' } } },
    { seq: 3, type: 'tool_execution_start', payload: { toolName: 'mcp', input: { tool: 'browser_navigate' } } },
  ];
  assert.equal(latestBrowserCall(events.slice(0, 2)), 0);
  assert.equal(latestBrowserCall(events), 3);
});

test('a lazy browser tool called through tools drives the browser, and a search of the tools does not', () => {
  const direct = [at(4, 'browser_navigate', { url: 'https://example.com' })];
  assert.equal(latestBrowserCall(direct), 4);
  assert.equal(latestBrowserCall([at(5, 'tools', via('browser_navigate', { url: 'https://example.com' }))]), 5);
  assert.equal(latestBrowserCall([at(6, 'tools', via('browser_navigate', JSON.stringify({ url: 'https://example.com' })))]), 6, 'arguments as JSON text');
  // The newest browser call is the one that counts, direct or lazy.
  assert.equal(latestBrowserCall([...direct, at(7, 'tools', via('browser_click', {}))]), 7);
  // Searching for or describing a browser tool uses none, and another lazy tool is no browser.
  assert.equal(latestBrowserCall([at(8, 'tools', { action: 'search', query: 'browser' })]), 0);
  assert.equal(latestBrowserCall([at(9, 'tools', { action: 'describe', name: 'browser_navigate' })]), 0);
  assert.equal(latestBrowserCall([at(10, 'tools', via('docs_open', { id: 'browser' }))]), 0);
});

test('a browser behind the MCP adapter drives the browser, by the server or the tool it is asked for, in every spelling', () => {
  for (const wrapped of spellings('mcp', { server: 'browser', tool: 'navigate', args: { url: 'https://example.com/a' } })) {
    assert.equal(latestBrowserCall([{ seq: 6, type: 'tool_execution_start', payload: wrapped }]), 6, JSON.stringify(wrapped));
  }
  for (const input of [{ connect: 'browser' }, { describe: 'browser' }, { tool: 'browser_click' }]) assert.equal(isBrowserCall('mcp', input), true, JSON.stringify(input));
  assert.equal(isBrowserCall('mcp', { server: 'jira', tool: 'get_issue' }), false);
  // A Playwright MCP's tool, called by itself, and one under a prefix.
  assert.equal(isBrowserCall('browser_take_screenshot', {}), true);
  assert.equal(isBrowserCall('playwright_browser_type', {}), true);
  assert.equal(isBrowserCall('browserless', {}), false);
});

test('a card of a browser call says what it does, by the part of its name after browser_, or the tool an mcp call names', () => {
  const view = (name: string, input: Record<string, unknown>) => ({ name, status: 'running' as const, input });
  assert.deepEqual(describeBrowserCall(view('browser_navigate', { url: 'https://example.com/a?b' })), { label: 'Opening a page', detail: 'example.com' });
  assert.deepEqual(describeBrowserCall(view('browser_take_screenshot', {})), { label: 'Taking a screenshot', detail: '' });
  assert.deepEqual(describeBrowserCall(view('browser_scroll', {})), { label: 'Scrolling the page', detail: '' });
  assert.deepEqual(describeBrowserCall(view('browser_find', { query: 'pricing' })), { label: 'Searching the page', detail: 'pricing' });
  assert.deepEqual(describeBrowserCall(view('browser_get_text', { ref: 'e5' })), { label: 'Reading the page', detail: '' });
  assert.deepEqual(describeBrowserCall(view('browser_click', { element: 'Sign in' })), { label: 'Clicking in the browser', detail: 'Sign in' });
  assert.deepEqual(describeBrowserCall(view('browser_key', { key: 'Enter' })), { label: 'Typing in the browser', detail: '' });
  assert.deepEqual(describeBrowserCall(view('browser_snapshot', {})), { label: 'Reading the page', detail: '' });
  assert.deepEqual(describeBrowserCall(view('browser_back', {})), { label: 'Using the browser', detail: '' });
  assert.deepEqual(describeBrowserCall(view('browser.open_tab', { url: 'https://docs.example.com/x' })), { label: 'Opening a page', detail: 'docs.example.com' });
  assert.deepEqual(describeBrowserCall(view('mcp', { connect: 'browser', url: 'https://example.com' })), { label: 'Using the browser', detail: 'example.com' });
});
