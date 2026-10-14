import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { scratch } from './server-harness.mjs';
const { removeSessionFiles } = await import('../dist/session-files.js');

const root = () => scratch('session-files-');

test("a session's folder and the conversation in it are removed, and only that one", () => {
  const r = root();
  mkdirSync(path.join(r, 'abc123'));
  writeFileSync(path.join(r, 'abc123', '2026-09-19_x.jsonl'), '{}');
  mkdirSync(path.join(r, 'other'));
  writeFileSync(path.join(r, 'other', 'keep.jsonl'), '{}');
  assert.equal(removeSessionFiles(r, 'abc123'), true);
  assert.equal(existsSync(path.join(r, 'abc123')), false);
  assert.equal(existsSync(path.join(r, 'other', 'keep.jsonl')), true);
});

test('a session that never wrote anything is not an error', () => {
  const r = root();
  assert.equal(removeSessionFiles(r, 'never-started'), false);
});

test('nothing outside the root can be reached through an id', () => {
  const r = root(); const outside = root();
  writeFileSync(path.join(outside, 'precious'), 'x');
  for (const id of ['..', '.', '', '../' + path.basename(outside), 'a/b', 'a\\b', '/etc', 'x\0y', '.hidden']) {
    assert.throws(() => removeSessionFiles(r, id), /not a session id/, JSON.stringify(id));
  }
  assert.equal(existsSync(path.join(outside, 'precious')), true);
});

test('a link in the place of the folder is removed as a link, and what it pointed at stays', () => {
  const r = root(); const outside = root();
  writeFileSync(path.join(outside, 'precious'), 'x');
  symlinkSync(outside, path.join(r, 'linked'));
  assert.equal(removeSessionFiles(r, 'linked'), true);
  assert.equal(existsSync(path.join(r, 'linked')), false);
  assert.equal(readFileSync(path.join(outside, 'precious'), 'utf8'), 'x');
});

test('only "not there" means nothing to do; a folder that cannot be looked at is an error', () => {
  const r = root();
  assert.equal(removeSessionFiles(path.join(r, 'no-such-root'), 'abc'), false);
  // A root that is a file: the folder under it cannot be looked at, and that is not "absent".
  const file = path.join(r, 'a-file');
  writeFileSync(file, 'x');
  assert.throws(() => removeSessionFiles(file, 'abc'), /ENOTDIR/);
});
