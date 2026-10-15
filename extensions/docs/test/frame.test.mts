import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frame, unframe } from '../src/frame.js';

/**
 * What the editor keeps apart from a document's Markdown and puts back (extensions/docs/src/frame.js): a byte order
 * mark and a YAML front matter block at the top, and the line ending.
 */

/** What the editor would hand back for `body`, unchanged: the document with the editor's part put through. */
const again = (markdown: string) => unframe(frame(markdown), frame(markdown).body);

test('a document with nothing to keep apart is its own body', () => {
  assert.deepEqual(frame('# Title\n\nText.\n'), { head: '', body: '# Title\n\nText.\n', eol: '\n' });
  assert.deepEqual(frame(''), { head: '', body: '', eol: '\n' });
});

test('a front matter block is kept apart with the blank lines after it, and comes back where it was', () => {
  const text = '---\ntitle: Plan\ntags: [a, b]\n# a comment\nlist:\n  - one\n- two\n---\n\n\n# Plan\n\nText.\n';
  const framed = frame(text);
  assert.equal(framed.head, '---\ntitle: Plan\ntags: [a, b]\n# a comment\nlist:\n  - one\n- two\n---\n\n\n');
  assert.equal(framed.body, '# Plan\n\nText.\n');
  assert.equal(unframe(framed, '# Plan\n\nNew.\n'), '---\ntitle: Plan\ntags: [a, b]\n# a comment\nlist:\n  - one\n- two\n---\n\n\n# Plan\n\nNew.\n');
  // `...` closes it too, and a front matter alone is a document of its own.
  assert.equal(frame('---\na: 1\n...\nText\n').head, '---\na: 1\n...\n');
  assert.deepEqual(frame('---\na: 1\n---'), { head: '---\na: 1\n---', body: '', eol: '\n' });
});

test('two rules with prose between are Markdown, not front matter', () => {
  for (const text of ['---\nSome words\n---\n\nText\n', '---\n\n---\n\nText\n', '---\nnot closed: yes\n\nText\n', 'Text\n\n---\ntitle: x\n---\n', '--- \n']) {
    assert.equal(frame(text).head, '', JSON.stringify(text));
    assert.equal(frame(text).body, text.replace(/\r\n/g, '\n'));
  }
});

test('a byte order mark is kept apart, with or without front matter', () => {
  assert.deepEqual(frame('﻿# Title\n'), { head: '﻿', body: '# Title\n', eol: '\n' });
  assert.equal(frame('﻿---\na: 1\n---\nText\n').head, '﻿---\na: 1\n---\n');
  assert.equal(again('﻿---\na: 1\n---\nText\n'), '﻿---\na: 1\n---\nText\n');
});

test('a document written with CRLF is shown with line feeds and written back with CRLF; one with line feeds is not changed', () => {
  const crlf = '# Title\r\n\r\nOne\r\nTwo\r\n';
  assert.deepEqual(frame(crlf), { head: '', body: '# Title\n\nOne\nTwo\n', eol: '\r\n' });
  assert.equal(unframe(frame(crlf), '# Title\n\nOne\nTwo\nThree\n'), '# Title\r\n\r\nOne\r\nTwo\r\nThree\r\n');
  assert.equal(frame('# Title\n\nOne\n').eol, '\n');
  // Mostly line feeds: those win.
  assert.equal(frame('a\nb\nc\r\nd\n').eol, '\n');
  assert.equal(frame('a\r\nb\r\nc\nd\r\n').eol, '\r\n');
});

test('a front matter block that ends the text with no line break is not glued to what is written after it', () => {
  assert.equal(unframe(frame('---\ntitle: x\n---'), 'Hello\n'), '---\ntitle: x\n---\nHello\n');
  // In the document's own line ending, taken from the block when there is nothing else to take it from.
  assert.equal(unframe(frame('---\r\ntitle: x\r\n---'), 'Hello\nWorld\n'), '---\r\ntitle: x\r\n---\r\nHello\r\nWorld\r\n');
  assert.equal(unframe(frame('\uFEFF---\ntitle: x\n---'), 'Hello\n'), '\uFEFF---\ntitle: x\n---\nHello\n');
  // What was written is front matter and a body again when it is opened the next time.
  const again2 = frame(unframe(frame('---\ntitle: x\n---'), 'Hello\n'));
  assert.deepEqual([again2.head, again2.body], ['---\ntitle: x\n---\n', 'Hello\n']);
  // Nothing is added where nothing follows, or where the block already ends in a line break, or there is only a mark.
  assert.equal(unframe(frame('---\ntitle: x\n---'), ''), '---\ntitle: x\n---');
  assert.equal(unframe(frame('---\ntitle: x\n---\n'), 'Hello\n'), '---\ntitle: x\n---\nHello\n');
  assert.equal(unframe(frame('\uFEFF'), 'Hello\n'), '\uFEFFHello\n');
  assert.equal(frame('---\r\na: 1\r\n---\r\n\r\nText\nmore\n').eol, '\n');
});

test('framing a document and putting it back is the document, in every shape', () => {
  for (const text of ['', '\n', 'Text', '---\na: 1\n---\n', '---\r\na: 1\r\n---\r\n\r\n# T\r\n', '﻿---\r\na: 1\r\n---\r\nText\r\n', '- a\n- b\n', '# T\r\n\r\ntext\r\n']) {
    assert.equal(again(text), text, JSON.stringify(text));
  }
});
