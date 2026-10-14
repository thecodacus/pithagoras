import { test } from 'node:test';
import assert from 'node:assert/strict';
import { below, within } from '../core/web/src/paths.js';

test('the folder itself and what is under it are within it', () => {
  assert.equal(within('/w/site', '/w/site'), true);
  assert.equal(within('/w/site', '/w/site/src/a.ts'), true);
});

test('a sibling that only shares the start of the name is not', () => {
  assert.equal(within('/w/site', '/w/site-old'), false);
  assert.equal(within('/w/site', '/w/site-old/a.ts'), false);
  assert.equal(within('/w/site', '/w'), false);
});

test('everything is within the root folder', () => {
  assert.equal(below('/', '/etc/passwd'), 'etc/passwd');
  assert.equal(below('/', '/'), '');
});

test('a trailing slash on the folder makes no difference', () => {
  assert.equal(within('/w/site//', '/w/site/a'), true);
  assert.equal(within('/w/site/', '/w/site'), true);
  assert.equal(within('/w/site/', '/w/site/a.ts'), true);
  assert.equal(within('/w/site/', '/w/site-old'), false);
});

test('relative paths, as the files panel has them', () => {
  assert.equal(within('src', 'src'), true);
  assert.equal(within('src', 'src/a.ts'), true);
  assert.equal(within('src', 'src2/a.ts'), false);
  assert.equal(within('src', ''), false);
  // "" is "/", as the hand-written copies had it: every absolute path.
  assert.equal(within('', '/etc'), true);
  assert.equal(within('', 'src/a.ts'), false);
});

test('below says what is under the folder', () => {
  assert.equal(below('/w/site', '/w/site/docs/a.md'), 'docs/a.md');
  assert.equal(below('/w/site/', '/w/site/docs'), 'docs');
  assert.equal(below('/w/site', '/w/site'), '');
  assert.equal(below('/w/site', '/w/other'), undefined);
});
