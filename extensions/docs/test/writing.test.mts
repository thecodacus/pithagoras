import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drafted, isDocumentId, sameCalls, shownNew, shownOf } from '../web/writing.js';

// What the page draws of what the agent is writing in a document (web/writing.js), from the chat's calls as it has them.

const PLAN = '# Plan\n\nShip it on Friday.\n\nThe build is green.\n';
const edit = (quote: string, replacement: string) => ({ quote, replacement });

test('an edit being written is drawn on the document as the tool will make it, with the edits that have come so far', () => {
  assert.equal(drafted(PLAN, [edit('Friday', 'Monday'), edit('# Plan', '# The plan')]), PLAN.replace('Friday', 'Monday').replace('# Plan', '# The plan'));
  // The replacement as far as it has come; a quote whose replacement has not begun is not made yet.
  assert.equal(drafted(PLAN, [edit('Friday', 'Mon'), { quote: 'The build' }]), PLAN.replace('Friday', 'Mon'));
  // Not there, there twice, overlapping one before it: left out, and the tool says why when it runs.
  assert.equal(drafted('a b a', [edit('a', 'x'), edit('c', 'y'), edit('b', 'B')]), 'a B a');
  assert.equal(drafted(PLAN, [edit('Ship it on', 'Send it on'), edit('it on Friday', 'x')]), PLAN.replace('Ship it on', 'Send it on'));
  // An edit whose replacement came before its quote may have a quote that is not whole yet: not made.
  assert.equal(drafted(PLAN, [{ replacement: 'x', quote: 'Fri' }]), PLAN);
  // A quote with line feeds is found in a document written with CRLF.
  assert.equal(drafted('a\r\nb\r\n', [edit('a\nb', 'c')]), 'c\r\n');
  for (const edits of [undefined, 'x', [null, 3, { quote: '' }]]) assert.equal(drafted(PLAN, edits as any), PLAN);
});

test('a new document is drawn as it will be: its title its heading where it has none, and a front matter block left out as the editor does', () => {
  assert.equal(shownOf('---\ntags: [a]\n---\n# Plan\n'), '# Plan\n');
  assert.equal(shownOf('# Plan\n'), '# Plan\n');
  assert.equal(shownNew('Ideas', 'Some text'), '# Ideas\n\nSome text');
  assert.equal(shownNew(' Ideas ', '\n\nSome text'), '# Ideas\n\nSome text');
  assert.equal(shownNew('Ideas', '## Own heading\n\nText'), '## Own heading\n\nText');
  assert.equal(shownNew('Ideas', '---\ntags: [a]\n---\nText'), '# Ideas\n\nText');
  // As far as the arguments have come: no title yet, no Markdown yet.
  assert.equal(shownNew(undefined, 'Text'), 'Text');
  assert.equal(shownNew('Ideas', undefined), '# Ideas\n\n');
});

test('a call is drawn again only when it changed, and an edit is opened once all of the id it names has come', () => {
  const input = { title: 'A' };
  const call = { name: 'doc_create', callId: 'c1', status: 'writing', input };
  assert.ok(sameCalls([call], [{ ...call }]));
  assert.ok(!sameCalls([call], [{ ...call, input: { title: 'A' } }]), 'arguments read again');
  assert.ok(!sameCalls([call], [{ ...call, status: 'running' }]));
  assert.ok(!sameCalls([call], []));
  assert.ok(isDocumentId('1111111111111111'));
  for (const id of ['11111111', '1111111111111111x', undefined, 7]) assert.ok(!isDocumentId(id));
});
