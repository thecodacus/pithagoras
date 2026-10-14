import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineBrowserScreenshot } from '../core/server/src/pi/browser-screenshot.js';
test('direct and proxy screenshot calls request inline images, preserving capture options', () => {
  const direct = { filename: 'page.png', fullPage: true, scale: 'css', target: 'e12' };
  inlineBrowserScreenshot('browser_browser_take_screenshot', direct);
  assert.deepEqual(direct, { fullPage: true, scale: 'css', target: 'e12' });
  const proxy = { tool: 'browser_take_screenshot', args: { filename: 'page.jpg' } };
  inlineBrowserScreenshot('mcp', proxy);
  assert.deepEqual(proxy.args, { type: 'jpeg' });
});
test('other file-writing tools and explicit screenshot formats remain intact', () => {
  const input = { filename: 'snapshot.md' };
  inlineBrowserScreenshot('browser_snapshot', input);
  assert.deepEqual(input, { filename: 'snapshot.md' });
  const capture = { filename: 'page.jpg', type: 'png' };
  inlineBrowserScreenshot('browser_take_screenshot', capture);
  assert.deepEqual(capture, { type: 'png' });
});
