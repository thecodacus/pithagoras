import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askedOf, canvasesOf, hear, known, type Canvas } from '../src/feed.ts';

/** A chat's canvases as the page has them, from what the server half says. */
const doc = (id: string, more: Partial<Canvas> = {}): Canvas => ({ id, title: id, content: '', revision: 0, status: 'saved', active_call: null, updated_at: '', persisted: false, ...more });
const listOf = (chat: string) => canvasesOf(chat).map((row) => row.title);

test('the list the server half sent, with each change since, newest first; each chat its own', () => {
  assert.equal(known('one'), false, 'nothing told yet: the panel asks for it');
  hear('one', { type: 'snapshot', canvases: [doc('a'), doc('b')] });
  assert.equal(known('one'), true);
  hear('one', { type: 'update', canvas: doc('b', { title: 'B, edited' }) });
  hear('one', { type: 'create', canvas: doc('c') });
  hear('one', { type: 'delete', id: 'a' });
  assert.deepEqual(listOf('one'), ['c', 'B, edited']);
  assert.deepEqual(listOf('two'), []);
});

test('what the agent does brings a canvas up: one made, one read, and each write once as it begins', () => {
  hear('three', { type: 'snapshot', canvases: [] });
  assert.equal(askedOf('three').count, 0);
  hear('three', { type: 'create', canvas: doc('made') });
  assert.deepEqual(askedOf('three'), { count: 1, id: 'made' });
  hear('three', { type: 'focus', canvas: doc('read') });
  assert.deepEqual(askedOf('three'), { count: 2, id: 'read' });
  // A write: once as it begins, not at each piece of it.
  for (const content of ['A', 'A b', 'A b c']) hear('three', { type: 'update', canvas: doc('made', { status: 'writing', active_call: 'call-1', content }) });
  assert.deepEqual(askedOf('three'), { count: 3, id: 'made' });
  // The person's own edits and a write that ended bring nothing up.
  hear('three', { type: 'update', canvas: doc('made', { status: 'edited' }) });
  hear('three', { type: 'update', canvas: doc('made', { status: 'saved' }) });
  assert.equal(askedOf('three').count, 3);
  // The next write is another.
  hear('three', { type: 'update', canvas: doc('made', { status: 'writing', active_call: 'call-2' }) });
  assert.equal(askedOf('three').count, 4);
});
