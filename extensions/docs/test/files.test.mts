import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { folderFiles } from '../../../core/server/src/folder-files.ts';
import { lookAtDocument, readDocument, Refused, removeDocument, renameDocument, writeDocument } from '../files.js';
import { scratch } from '../../../tests/helpers.mts';
// @ts-ignore: a module of the portal's own tests, plain JavaScript
import { race, root } from '../../../core/server/test/race-harness.mjs';

/**
 * A document's file as Documents reads and writes it, on the portal's own `files`: a name in the documents folder and nothing a
 * link led to, and no second name.
 */

/** A documents folder with `b.md` in it, and a link `a.md` to it, which `files.write` follows unless it is told to take the name as it is. */
function linked() {
  const dir = realpathSync(scratch('docs-files-'));
  writeFileSync(path.join(dir, 'b.md'), 'b, as it was');
  symlinkSync('b.md', path.join(dir, 'a.md'));
  return dir;
}

const refused = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof Refused ? e : new Error(`not a refusal: ${e}`);
  }
  return null;
};

test('a document is not written through a link, with or without create: the file it leads to is left as it was', () => {
  const dir = linked();
  const bytes = Buffer.from('written through the link');
  const without = refused(() => writeDocument(folderFiles, dir, 'a.md', bytes));
  assert.ok(without instanceof Refused, `${without}`);
  assert.equal(without.taken, false);
  assert.equal(readFileSync(path.join(dir, 'b.md'), 'utf8'), 'b, as it was');
  assert.ok(lstatSync(path.join(dir, 'a.md')).isSymbolicLink(), 'the link is as it was');

  const created = refused(() => writeDocument(folderFiles, dir, 'a.md', bytes, { create: true }));
  assert.ok(created instanceof Refused, `${created}`);
  assert.equal(created.taken, true, 'the name is another file\'s');
  assert.equal(readFileSync(path.join(dir, 'b.md'), 'utf8'), 'b, as it was');
  assert.deepEqual(readdirSync(dir).sort(), ['a.md', 'b.md'], 'no temporary file is left');
});

test('a document is not written through a link to a name that is not there yet, nor over a second name of a file', () => {
  const dir = realpathSync(scratch('docs-files-twin-'));
  symlinkSync('later.md', path.join(dir, 'dangling.md'));
  assert.ok(refused(() => writeDocument(folderFiles, dir, 'dangling.md', Buffer.from('x'), { create: true })) instanceof Refused);
  assert.ok(refused(() => writeDocument(folderFiles, dir, 'dangling.md', Buffer.from('x'))) instanceof Refused);
  assert.deepEqual(readdirSync(dir), ['dangling.md']);

  writeFileSync(path.join(dir, 'one.md'), 'one');
  linkSync(path.join(dir, 'one.md'), path.join(dir, 'two.md'));
  assert.ok(refused(() => writeDocument(folderFiles, dir, 'two.md', Buffer.from('x'))) instanceof Refused);
  assert.equal(readFileSync(path.join(dir, 'one.md'), 'utf8'), 'one');
});

test('a link is no document to read or look at either, and a plain file is both', () => {
  const dir = linked();
  assert.equal(readDocument(folderFiles, dir, 'a.md'), null);
  assert.equal(lookAtDocument(folderFiles, dir, 'a.md', 4), null);
  assert.equal(readDocument(folderFiles, dir, 'b.md')?.bytes.toString(), 'b, as it was');
  assert.equal(lookAtDocument(folderFiles, dir, 'b.md', 4)?.head.toString(), 'b, a');
  mkdirSync(path.join(dir, 'folder.md'));
  assert.equal(readDocument(folderFiles, dir, 'folder.md'), null);
});

test('a document is written whole and keeps the key it is read by', () => {
  const dir = realpathSync(scratch('docs-files-whole-'));
  const made = writeDocument(folderFiles, dir, 'a.md', Buffer.from('first'), { create: true });
  assert.equal(readDocument(folderFiles, dir, 'a.md')?.key, made.key);
  const replaced = writeDocument(folderFiles, dir, 'a.md', Buffer.from('second'));
  assert.equal(readFileSync(path.join(dir, 'a.md'), 'utf8'), 'second');
  assert.equal(readDocument(folderFiles, dir, 'a.md')?.key, replaced.key);
  assert.notEqual(replaced.key, made.key);
  assert.ok(refused(() => writeDocument(folderFiles, dir, 'a.md', Buffer.from('third'), { create: true })) instanceof Refused, 'a made document is not replaced');
  assert.ok(refused(() => writeDocument(folderFiles, dir, 'not-a-document.txt', Buffer.from('x'))) instanceof Refused);
  assert.equal(readFileSync(path.join(dir, 'a.md'), 'utf8'), 'second');
});

test('a document is removed as a plain file: one that is gone is nothing, and a link, a folder and a second name are refused and left as they are', () => {
  const dir = linked();
  mkdirSync(path.join(dir, 'folder.md'));
  writeFileSync(path.join(dir, 'folder.md', 'inner'), 'kept');
  writeFileSync(path.join(dir, 'one.md'), 'one');
  linkSync(path.join(dir, 'one.md'), path.join(dir, 'two.md'));
  for (const name of ['a.md', 'folder.md', 'two.md']) {
    const found = refused(() => removeDocument(folderFiles, dir, name));
    assert.ok(found instanceof Refused, name);
    assert.equal(found.taken, true, `${name}: the name is another file's`);
  }
  assert.ok(lstatSync(path.join(dir, 'a.md')).isSymbolicLink());
  assert.equal(readFileSync(path.join(dir, 'b.md'), 'utf8'), 'b, as it was', 'what a link led to stays');
  assert.equal(readFileSync(path.join(dir, 'folder.md', 'inner'), 'utf8'), 'kept');
  // A file that had a second name cut off is removed as `shared`.
  assert.equal(removeDocument(folderFiles, dir, 'two.md', { shared: true }), true);
  assert.equal(readFileSync(path.join(dir, 'one.md'), 'utf8'), 'one');
  assert.equal(removeDocument(folderFiles, dir, 'b.md'), true);
  assert.equal(removeDocument(folderFiles, dir, 'b.md'), false, 'gone already');
  assert.ok(refused(() => removeDocument(folderFiles, dir, 'notes.txt')) instanceof Refused, 'only a document\'s name');
  assert.ok(refused(() => removeDocument(folderFiles, dir, '../b.md')) instanceof Refused);
});

test('a document is renamed to a name that is free, and never to one that is taken, whatever is there; a link and a folder are not renamed', () => {
  const dir = linked();
  mkdirSync(path.join(dir, 'folder.md'));
  writeFileSync(path.join(dir, 'taken.md'), 'taken');
  const inode = statSync(path.join(dir, 'b.md')).ino;
  for (const name of ['taken.md', 'folder.md', 'a.md']) {
    const found = refused(() => renameDocument(folderFiles, dir, 'b.md', name));
    assert.ok(found instanceof Refused, name);
    assert.equal(found.taken, true, `${name} is taken`);
  }
  assert.equal(readFileSync(path.join(dir, 'taken.md'), 'utf8'), 'taken');
  assert.ok(lstatSync(path.join(dir, 'a.md')).isSymbolicLink(), 'a link that was the name is as it was');
  renameDocument(folderFiles, dir, 'b.md', 'c.md');
  assert.equal(statSync(path.join(dir, 'c.md')).ino, inode, 'the same file');
  assert.equal(existsSync(path.join(dir, 'b.md')), false);
  // Not a plain file, not a name, gone.
  for (const [from, to] of [['a.md', 'z.md'], ['folder.md', 'z.md'], ['c.md', 'notes.txt'], ['c.md', '.z.md'], ['c.md', 'x/z.md']]) assert.ok(refused(() => renameDocument(folderFiles, dir, from, to)) instanceof Refused, `${from} to ${to}`);
  const gone = refused(() => renameDocument(folderFiles, dir, 'nothing.md', 'z.md'));
  assert.ok(gone instanceof Refused);
  assert.equal(gone.gone, true);
  assert.deepEqual(readdirSync(dir).sort(), ['a.md', 'c.md', 'folder.md', 'taken.md']);
});

// As root against an agent that is not (core/server/test/race-harness.mjs): a folder the agent has no access to is moved onto the documents folder's
// place and back, while the document is deleted or renamed in the documents folder. Told which folder it is for, Documents never acts in the other.
for (const [what, act] of [
  ['removeDocument', (folder: string, options: { expect?: { dev: bigint; ino: bigint } }) => removeDocument(folderFiles, folder, 'doc.md', { expect: options.expect })],
  ['renameDocument', (folder: string, options: { expect?: { dev: bigint; ino: bigint } }) => renameDocument(folderFiles, folder, 'doc.md', 'new.md', { expect: options.expect })],
] as const) {
  test(`${what} as root never acts in a closed folder that the agent moved onto the documents folder's place, when it is told which folder it is for`, { skip: !root && 'only as root', timeout: 60_000 }, async (t) => {
    const told = await race(act, { expect: true });
    if (!told) return t.skip('the agent\'s user cannot run node here');
    assert.ok(told.rounds > 100, `the agent moved the folders (${told.rounds} rounds)`);
    assert.equal(told.breaches, 0, `${what}: the closed folder was acted in ${told.breaches} times in ${told.calls} calls`);
    const free = await race(act, { expect: false });
    if (!free) return t.skip('the agent\'s user cannot run node here');
    assert.ok(free.breaches > 0, `${what}: without expect the closed folder was never acted in (${free.calls} calls, ${free.rounds} rounds): the race did not happen, so the test says nothing`);
  });
}
