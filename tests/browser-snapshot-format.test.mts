import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanBrowserSnapshot, isBrowserSnapshot } from '../core/server/src/pi/browser-snapshot-format.js';
test('compacts metadata while retaining deep content, refs, state and URLs', () => {
 const tree = ['- generic [ref=f11e1]:','  - main [ref=f11e2]:','    - generic [ref=f11e3]:','      - link "Post title" [ref=f11e4] [cursor=pointer]:','        - /url: https://example.com/post?x=1&y=2','      - checkbox "Subscribe" [checked] [disabled] [ref=f11e5]','      - generic [ref=f11e6]: Keep [ref=e99] and generic [cursor=pointer] in page text','      - button "Literal [ref=e88]" [ref=f11e7]'];
 const input = '### Page\n- Page URL: https://example.com\n### Snapshot\n```yaml\n'+tree.join('\n')+'\n```\n### Events\nError detail';
 const result=cleanBrowserSnapshot(input);
 assert.ok(result.includes('   - link "Post title" [f11e4] [pointer]:'));
 assert.ok(result.includes('https://example.com/post?x=1&y=2'));
 assert.ok(result.includes('[checked] [disabled] [f11e5]'));
 assert.ok(result.includes('Keep [ref=e99] and generic [cursor=pointer] in page text'));
 assert.ok(result.includes('"Literal [ref=e88]" [f11e7]'));
 assert.equal(result.split('\n').filter(l=>/^ *- /.test(l)).length,tree.length+1);
 for(let i=1;i<=7;i++) assert.ok(result.includes(`[f11e${i}]`));
 assert.ok(result.endsWith('### Events\nError detail'));
 assert.equal(cleanBrowserSnapshot(result),result);
});
test('does not rewrite other sections or non-snapshot tools', () => {
 const text='### Result\n```yaml\n- generic [ref=e1]: hello\n```';
 assert.equal(cleanBrowserSnapshot(text),text);
 assert.ok(isBrowserSnapshot('browser_browser_snapshot',{}));
 assert.ok(isBrowserSnapshot('mcp',{tool:'browser_browser_snapshot'}));
 assert.equal(isBrowserSnapshot('browser_take_screenshot',{}),false);
});
