import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shownNew, shownOf, writingStore } from '../web/writing.js';

// What the page keeps of what the agent is writing, as the server half tells it (web/writing.js).

test('the page keeps what is being written in each chat, and how it ended, with a new map each time one changes', () => {
  const writes = writingStore();
  let heard = 0;
  const stop = writes.subscribe(() => heard++);
  const empty = writes.of('a');
  writes.hear('a', { type: 'writing', call: 'c1', tool: 'create', folder: 'f', title: 'Id', markdown: '' });
  const first = writes.of('a');
  assert.notEqual(first, empty);
  writes.hear('a', { type: 'writing', call: 'c1', tool: 'create', folder: 'f', title: 'Ideas', markdown: 'Text' });
  assert.notEqual(writes.of('a'), first, 'a change is a new map');
  assert.deepEqual(writes.of('a').get('c1'), { type: 'writing', call: 'c1', tool: 'create', folder: 'f', title: 'Ideas', markdown: 'Text', done: false });
  writes.hear('a', { type: 'written', call: 'c1', ok: true, folder: 'f', id: '4444444444444444' });
  assert.deepEqual(writes.of('a').get('c1'), { type: 'writing', call: 'c1', tool: 'create', folder: 'f', title: 'Ideas', markdown: 'Text', done: true, ok: true, id: '4444444444444444' });
  // An end of a call the page never heard of, another message, and another chat's: nothing of this chat changes.
  const before = writes.of('a');
  writes.hear('a', { type: 'written', call: 'gone', ok: true });
  writes.hear('a', { type: 'snapshot', canvases: [] });
  writes.hear('b', { type: 'writing', call: 'c9', tool: 'create', folder: 'f', title: 'B', markdown: '' });
  assert.equal(writes.of('a'), before);
  assert.equal(heard, 4);
  // What a page is told as it opens is what is being written now.
  writes.hear('a', { type: 'writings', list: [{ type: 'writing', call: 'c2', tool: 'edit', folder: 'f', id: '1111111111111111', revision: 3, markdown: 'x' }] });
  assert.deepEqual([...writes.of('a').keys()], ['c2']);
  stop();
  writes.hear('a', { type: 'writing', call: 'c3', tool: 'create', folder: 'f', title: '', markdown: '' });
  assert.equal(heard, 5, 'one that stopped listening is not told');
});

test('a chat keeps the twenty calls that ended last, and every one still being written', () => {
  const writes = writingStore();
  for (let i = 0; i < 30; i++) {
    writes.hear('a', { type: 'writing', call: `c${i}`, tool: 'create', folder: 'f', title: '', markdown: '' });
    if (i !== 3) writes.hear('a', { type: 'written', call: `c${i}`, ok: false });
  }
  const kept = [...writes.of('a').keys()];
  assert.equal(kept.length, 20);
  assert.ok(kept.includes('c3'), 'the one still being written');
  assert.ok(kept.includes('c29'));
  assert.ok(!kept.includes('c0'));
});

test('a draft shows a document as the editor does, and a new one with its title as its heading where it has none', () => {
  assert.equal(shownOf('---\ntags: [a]\n---\n# Plan\n'), '# Plan\n');
  assert.equal(shownOf('# Plan\n'), '# Plan\n');
  assert.equal(shownNew('Ideas', 'Some text'), '# Ideas\n\nSome text');
  assert.equal(shownNew('Ideas', '\n\nSome text'), '# Ideas\n\nSome text');
  assert.equal(shownNew('Ideas', '## Own heading\n\nText'), '## Own heading\n\nText');
  assert.equal(shownNew('Ideas', '---\ntags: [a]\n---\nText'), '# Ideas\n\nText');
  assert.equal(shownNew('', 'Text'), 'Text');
});
