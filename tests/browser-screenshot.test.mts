import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineBrowserScreenshot } from '../core/server/src/pi/browser-screenshot.js';
test('screenshot calls of a Playwright MCP request inline images, preserving capture options', () => {
  const direct = { filename: 'page.png', fullPage: true, scale: 'css', target: 'e12' };
  inlineBrowserScreenshot('mcp__browser__browser_take_screenshot', direct);
  assert.deepEqual(direct, { fullPage: true, scale: 'css', target: 'e12' });
  const jpeg = { filename: 'page.jpg' };
  inlineBrowserScreenshot('mcp__playwright__browser_take_screenshot', jpeg);
  assert.deepEqual(jpeg, { type: 'jpeg' });
  // The old adapter's tool, which named the Playwright tool in an argument, is no screenshot call.
  const proxy = { tool: 'browser_take_screenshot', args: { filename: 'page.jpg' } };
  inlineBrowserScreenshot('mcp', proxy);
  assert.deepEqual(proxy.args, { filename: 'page.jpg' });
});
test('other file-writing tools and explicit screenshot formats remain intact', () => {
  const input = { filename: 'snapshot.md' };
  inlineBrowserScreenshot('browser_snapshot', input);
  assert.deepEqual(input, { filename: 'snapshot.md' });
  const capture = { filename: 'page.jpg', type: 'png' };
  inlineBrowserScreenshot('browser_take_screenshot', capture);
  assert.deepEqual(capture, { type: 'png' });
});
