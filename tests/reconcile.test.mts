import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../core/web/src/reconcile.ts';

const row = (id: string, status = 'idle') => ({ id, title: `Chat ${id}`, status, tags: ['a', 'b'] });

test('an answer that says what the last said is the last, whole', () => {
  const prev = [row('a'), row('b')];
  assert.equal(reconcile(prev, [row('a'), row('b')]), prev);
  assert.equal(reconcile(null, null), null);
  const state = { statuses: [{ key: 'k', text: 't' }], widgets: [] as unknown[] };
  assert.equal(reconcile(state, { statuses: [{ key: 'k', text: 't' }], widgets: [] }), state);
});

test('a row that changed is the only one that is new', () => {
  const prev = [row('a'), row('b'), row('c')];
  const next = reconcile(prev, [row('a'), row('b', 'running'), row('c')]);
  assert.notEqual(next, prev);
  assert.equal(next[0], prev[0]);
  assert.equal(next[2], prev[2]);
  assert.deepEqual(next[1], row('b', 'running'));
  assert.notEqual(next[1], prev[1]);
});

test('rows with an id are told apart by it when the list is reordered, added to or cut', () => {
  const prev = [row('a'), row('b'), row('c')];
  const moved = reconcile(prev, [row('c'), row('a'), row('b')]);
  assert.deepEqual(moved.map((r) => r.id), ['c', 'a', 'b']);
  assert.equal(moved[0], prev[2]);
  assert.equal(moved[1], prev[0]);
  const longer = reconcile(prev, [...prev.map((r) => row(r.id)), row('d')]);
  assert.equal(longer.length, 4);
  assert.equal(longer[0], prev[0]);
  const shorter = reconcile(prev, [row('a'), row('b')]);
  assert.notEqual(shorter, prev);
  assert.equal(shorter[1], prev[1]);
});

test('objects without an id are compared place by place, and a key that went or came is a change', () => {
  const prev = { home: '/h', projects: [{ name: 'x', path: '/w/x' }, { name: 'y', path: '/w/y' }] };
  const next = reconcile(prev, { home: '/h', projects: [{ name: 'x', path: '/w/x' }, { name: 'y', path: '/w/z' }] });
  assert.notEqual(next, prev);
  assert.equal(next.projects[0], prev.projects[0]);
  assert.deepEqual(next.projects[1], { name: 'y', path: '/w/z' });
  assert.deepEqual(reconcile<Record<string, unknown>>({ a: 1 }, { a: 1, b: 2 }), { a: 1, b: 2 });
  assert.deepEqual(reconcile<Record<string, unknown>>({ a: 1, b: 2 }, { a: 1 }), { a: 1 });
});
