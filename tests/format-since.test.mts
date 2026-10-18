import { test } from 'node:test';
import assert from 'node:assert/strict';
import { since } from '../core/web/src/time.ts';
import { bytesLabel } from '../core/web/src/projects.ts';

/** `portal.format.since` and `portal.format.bytes`: what an extension is offered in place of a copy of its own. */
test('how long ago is told of a Date, a time in ms, and a timestamp the server wrote as text, which is UTC with or without its zone', () => {
  const ago = (ms: number) => Date.now() - ms;
  assert.equal(since(ago(5_000)), 'just now');
  assert.equal(since(new Date(ago(5 * 60_000))), '5m ago');
  assert.equal(since(ago(3 * 3_600_000)), '3h ago');
  assert.equal(since(ago(2 * 86_400_000)), '2d ago');
  // Text: "2026-10-01 12:00:00" has no zone and is UTC, as the server writes it; a Date would read it as local time.
  const fiveMinutesAgo = new Date(ago(5 * 60_000)).toISOString();
  assert.equal(since(fiveMinutesAgo.replace('T', ' ').replace(/\.\d+Z$/, '')), '5m ago');
  assert.equal(since(fiveMinutesAgo), '5m ago');
  assert.equal(since(new Date(ago(5 * 60_000)).toISOString().replace('Z', '+00:00')), '5m ago');
  // What cannot be read is shown as it is, and a number or a Date that is none is nothing.
  assert.equal(since('last Tuesday'), 'last Tuesday');
  assert.equal(since(NaN), '');
  assert.equal(since(new Date(NaN)), '');
  // Past a number of days it is the date.
  assert.match(since(ago(70 * 86_400_000), { dateAfterDays: 60 }), /\d/);
  assert.doesNotMatch(since(ago(70 * 86_400_000), { dateAfterDays: 60 }), /ago/);
});

test('a size is told in bytes, KB, MB or GB', () => {
  assert.deepEqual([0, 1023, 1024, 1536, 1024 ** 2, 5 * 1024 ** 2 + 100, 1024 ** 3].map(bytesLabel), ['0 B', '1023 B', '1.0 KB', '1.5 KB', '1.0 MB', '5.0 MB', '1.0 GB']);
});
