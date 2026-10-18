import assert from 'node:assert/strict';
import fs, { chmodSync, chownSync, closeSync, constants, existsSync, fstatSync, lutimesSync, renameSync, linkSync, lstatSync, mkdirSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { scratch } from './server-harness.mjs';
const files = await import('../dist/workspace-files.js');
const { FileError, baseDir, listDir, readText, writeText, removeEntry, renameEntry, folderPath, resolveInside, openDownload, openFile, readBytes, saveNewFile, uploadTarget, makeFolder, sweepTemp, MAX_EDIT_BYTES } = files;
const { folderFiles } = await import('../dist/folder-files.js');

/** A folder to work in, and one beside it that nothing may reach. */
function setup() {
  const top = scratch('wsfiles-');
  const dir = path.join(top, 'work');
  const outside = path.join(top, 'outside');
  mkdirSync(dir); mkdirSync(outside);
  writeFileSync(path.join(outside, 'secret'), 'top secret');
  return { top, dir, outside, base: baseDir(dir), done: () => rmSync(top, { recursive: true, force: true }) };
}
const code = (fn) => { try { fn(); } catch (e) { return e instanceof FileError ? e.code : `other:${e.message}`; } return 'none'; };
/** The same, for what is awaited: removeEntry asks git first. */
const codeOf = async (fn) => { try { await fn(); } catch (e) { return e instanceof FileError ? e.code : `other:${e.message}`; } return 'none'; };

test('a folder is listed with folders first, and .git is left out', () => {
  const { dir, base, done } = setup();
  mkdirSync(path.join(dir, 'src')); mkdirSync(path.join(dir, '.git'));
  writeFileSync(path.join(dir, 'b.txt'), 'bb'); writeFileSync(path.join(dir, 'a.txt'), 'a');
  const list = listDir(base, '');
  assert.deepEqual(list.entries.map((e) => [e.name, e.type]), [['src', 'dir'], ['a.txt', 'file'], ['b.txt', 'file']]);
  assert.equal(list.entries[2].size, 2);
  assert.equal(list.truncated, false);
  done();
});

test('a nested folder is listed by its path, and an empty one is empty', () => {
  const { dir, base, done } = setup();
  mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  writeFileSync(path.join(dir, 'a', 'b', 'x.md'), '# x');
  assert.equal(listDir(base, 'a/b').path, path.join('a', 'b'));
  assert.equal(listDir(base, 'a/b').entries.length, 1);
  mkdirSync(path.join(dir, 'empty'));
  assert.deepEqual(listDir(base, 'empty').entries, []);
  done();
});

test('nothing outside the folder can be reached by a path', async () => {
  const { base, outside, done } = setup();
  for (const p of ['..', '../outside', '../outside/secret', '/etc/passwd', 'a/../../outside', path.join(outside, 'secret'), 'x\0y']) {
    assert.match(code(() => readText(base, p)), /invalid|missing/, JSON.stringify(p));
    assert.match(code(() => listDir(base, p)), /invalid|missing/, JSON.stringify(p));
    assert.match(code(() => writeText(base, p, 'x')), /invalid|missing/, JSON.stringify(p));
    assert.match(await codeOf(() => removeEntry(base, p)), /invalid|missing/, JSON.stringify(p));
  }
  assert.equal(readFileSync(path.join(outside, 'secret'), 'utf8'), 'top secret');
  done();
});

test('an absolute-looking path is taken as inside the folder, not as the root of the disk', () => {
  const { dir, base, done } = setup();
  writeFileSync(path.join(dir, 'a.txt'), 'inside');
  assert.equal(readText(base, '/a.txt').content, 'inside');
  done();
});

test('a link that leads out is refused for every operation, and what it points at is untouched', () => {
  const { dir, base, outside, done } = setup();
  symlinkSync(outside, path.join(dir, 'escape'));
  symlinkSync(path.join(outside, 'secret'), path.join(dir, 'peek'));
  for (const p of ['escape', 'escape/secret', 'peek']) {
    assert.equal(code(() => readText(base, p)), 'invalid', p);
    assert.equal(code(() => writeText(base, p, 'x')), 'invalid', p);
  }
  assert.equal(code(() => writeText(base, 'escape/new.txt', 'x')), 'invalid');
  assert.equal(existsSync(path.join(outside, 'new.txt')), false);
  assert.equal(readFileSync(path.join(outside, 'secret'), 'utf8'), 'top secret');
  done();
});

test('a link to nowhere is refused rather than written through', () => {
  const { dir, base, outside, done } = setup();
  symlinkSync(path.join(outside, 'not-yet'), path.join(dir, 'dangling'));
  assert.equal(code(() => writeText(base, 'dangling', 'planted')), 'invalid');
  assert.equal(existsSync(path.join(outside, 'not-yet')), false);
  done();
});

test('links are listed as what they lead to when that is inside, and as links when it is not', () => {
  const { dir, base, outside, done } = setup();
  writeFileSync(path.join(dir, 'real.txt'), 'real'); mkdirSync(path.join(dir, 'sub'));
  symlinkSync(path.join(dir, 'real.txt'), path.join(dir, 'to-file'));
  symlinkSync(path.join(dir, 'sub'), path.join(dir, 'to-dir'));
  symlinkSync(outside, path.join(dir, 'out'));
  symlinkSync(path.join(dir, 'missing'), path.join(dir, 'broken'));
  const type = Object.fromEntries(listDir(base, '').entries.map((e) => [e.name, e.type]));
  assert.deepEqual(type, { sub: 'dir', 'to-dir': 'dir', out: 'link', broken: 'link', 'real.txt': 'file', 'to-file': 'file' });
  assert.equal(readText(base, 'to-file').content, 'real');
  done();
});

test('a link to something inside the folder can be read', () => {
  const { dir, base, done } = setup();
  mkdirSync(path.join(dir, 'sub')); writeFileSync(path.join(dir, 'sub', 'a.txt'), 'in sub');
  symlinkSync(path.join(dir, 'sub'), path.join(dir, 'alias'));
  assert.equal(readText(base, 'alias/a.txt').content, 'in sub');
  done();
});

test('text is read with its size and time; binary and large files are only described', () => {
  const { dir, base, done } = setup();
  writeFileSync(path.join(dir, 'a.txt'), 'héllo');
  const text = readText(base, 'a.txt');
  assert.equal(text.binary, false); assert.equal(text.content, 'héllo'); assert.equal(text.size, 6);
  assert.equal(text.mtime, statSync(path.join(dir, 'a.txt')).mtimeMs);
  writeFileSync(path.join(dir, 'b.bin'), Buffer.from([1, 2, 0, 3]));
  assert.deepEqual({ ...readText(base, 'b.bin'), mtime: 0 }, { binary: true, size: 4, mtime: 0 });
  writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(MAX_EDIT_BYTES + 1));
  assert.equal(readText(base, 'big.txt').binary, true);
  assert.equal('content' in readText(base, 'big.txt'), false);
  done();
});

test('a folder, and a file that is not there, are not read as files', () => {
  const { dir, base, done } = setup();
  mkdirSync(path.join(dir, 'sub'));
  assert.equal(code(() => readText(base, 'sub')), 'invalid');
  assert.equal(code(() => readText(base, 'nope.txt')), 'missing');
  assert.equal(code(() => listDir(base, 'nope')), 'missing');
  writeFileSync(path.join(dir, 'a.txt'), 'x');
  assert.equal(code(() => listDir(base, 'a.txt')), 'invalid');
  done();
});

test('a save replaces the text, and can make a file in a folder that is there', () => {
  const { dir, base, done } = setup();
  writeFileSync(path.join(dir, 'a.txt'), 'a long first version');
  const saved = writeText(base, 'a.txt', 'short');
  assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'short');
  assert.equal(saved.size, 5);
  mkdirSync(path.join(dir, 'sub'));
  writeText(base, 'sub/new.txt', 'made');
  assert.equal(readFileSync(path.join(dir, 'sub', 'new.txt'), 'utf8'), 'made');
  assert.equal(code(() => writeText(base, 'no/such/dir.txt', 'x')), 'missing');
  assert.equal(code(() => writeText(base, 'sub', 'x')), 'invalid');
  done();
});

test('a save over a file that changed since it was opened is refused, and one over a file that did not goes through', () => {
  const { dir, base, done } = setup();
  const file = path.join(dir, 'a.txt');
  writeFileSync(file, 'v1');
  const opened = readText(base, 'a.txt').mtime;
  // The agent writes in between, a while later.
  writeFileSync(file, 'the agent was here'); utimesSync(file, new Date(), new Date(Date.now() + 60_000));
  assert.equal(code(() => writeText(base, 'a.txt', 'mine', opened)), 'conflict');
  assert.equal(readFileSync(file, 'utf8'), 'the agent was here');
  const now = readText(base, 'a.txt').mtime;
  writeText(base, 'a.txt', 'mine', now);
  assert.equal(readFileSync(file, 'utf8'), 'mine');
  done();
});

test('a file too large to edit is refused, and a file with a second name is left alone', () => {
  const { dir, base, outside, done } = setup();
  assert.equal(code(() => writeText(base, 'big.txt', 'x'.repeat(MAX_EDIT_BYTES + 1))), 'too_large');
  linkSync(path.join(outside, 'secret'), path.join(dir, 'twin'));
  assert.equal(code(() => writeText(base, 'twin', 'overwritten')), 'invalid');
  assert.equal(readFileSync(path.join(outside, 'secret'), 'utf8'), 'top secret');
  done();
});

test('a folder is removed with what is in it; a link goes, and what it led to stays', async () => {
  const { dir, base, outside, done } = setup();
  mkdirSync(path.join(dir, 'sub')); writeFileSync(path.join(dir, 'sub', 'a.txt'), 'x');
  await removeEntry(base, 'sub');
  assert.equal(existsSync(path.join(dir, 'sub')), false);
  symlinkSync(outside, path.join(dir, 'escape'));
  await removeEntry(base, 'escape');
  assert.equal(existsSync(path.join(dir, 'escape')), false);
  assert.equal(readFileSync(path.join(outside, 'secret'), 'utf8'), 'top secret');
  symlinkSync(path.join(dir, 'gone'), path.join(dir, 'broken'));
  await removeEntry(base, 'broken');
  assert.equal(await codeOf(() => removeEntry(base, 'broken')), 'missing');
  done();
});

test('the folder itself cannot be removed, however it is spelled', async () => {
  const { dir, base, done } = setup();
  for (const p of ['', '.', './', '/', 'sub/..']) {
    assert.match(await codeOf(() => removeEntry(base, p)), /invalid|missing/, JSON.stringify(p));
  }
  assert.equal(existsSync(dir), true);
  done();
});

/** Everything a download hands over, read from its descriptor. */
const drain = ({ fd, size }) => { const buf = Buffer.alloc(size); readSync(fd, buf, 0, size, 0); closeSync(fd); return buf.toString(); };

test('a download is a plain file opened once, dotfiles included, and nothing else', () => {
  const { dir, base, outside, done } = setup();
  writeFileSync(path.join(dir, 'a.txt'), 'hello'); writeFileSync(path.join(dir, '.env'), 'SECRET=1'); mkdirSync(path.join(dir, 'sub'));
  const file = openDownload(base, 'a.txt');
  assert.equal(file.name, 'a.txt'); assert.equal(file.size, 5); assert.equal(drain(file), 'hello');
  const dot = openDownload(base, '.env');
  assert.equal(dot.name, '.env'); assert.equal(drain(dot), 'SECRET=1');
  assert.equal(code(() => openDownload(base, 'sub')), 'invalid');
  assert.equal(code(() => openDownload(base, 'gone')), 'missing');
  symlinkSync(path.join(outside, 'secret'), path.join(dir, 'peek'));
  assert.equal(code(() => openDownload(base, 'peek')), 'invalid');
  done();
});

test('a download from a folder that sits under a dot-folder is not refused for it', () => {
  const top = scratch('wsfiles-');
  const dir = path.join(top, '.hidden', 'home'); mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'a.txt'), 'x');
  assert.equal(drain(openDownload(baseDir(dir), 'a.txt')), 'x');
});

test('a folder that is itself a link is followed once, up front, and checked against where it leads', () => {
  const { top, outside, done } = setup();
  const linked = path.join(top, 'linked');
  symlinkSync(outside, linked);
  // The chat's folder is what its link leads to; from there nothing else is reachable.
  const base = baseDir(linked);
  assert.equal(base, realpathSync(outside));
  assert.equal(code(() => readText(base, '../work')), 'invalid');
  assert.equal(readText(base, 'secret').content, 'top secret');
  assert.equal(code(() => baseDir(path.join(top, 'no-such-folder'))), 'missing');
  done();
});

test('resolveInside returns the canonical path, so what is used is what was checked', () => {
  const { dir, base, done } = setup();
  mkdirSync(path.join(dir, 'sub'));
  symlinkSync(path.join(dir, 'sub'), path.join(dir, 'alias'));
  assert.equal(resolveInside(base, 'alias'), path.join(base, 'sub'));
  done();
});

test('a folder with more entries than the cap is cut off and says so', () => {
  const { dir, base, done } = setup();
  for (let i = 0; i < files.MAX_ENTRIES + 5; i++) writeFileSync(path.join(dir, `f${i}`), '');
  const list = listDir(base, '');
  assert.equal(list.entries.length, files.MAX_ENTRIES);
  assert.equal(list.truncated, true);
  done();
});

test('a file and a folder are renamed in the folder they are in, and the new path is returned', () => {
  const { dir, base, done } = setup();
  mkdirSync(path.join(dir, 'sub')); writeFileSync(path.join(dir, 'sub', 'a.txt'), 'x'); writeFileSync(path.join(dir, 'b.txt'), 'b');
  assert.equal(renameEntry(base, 'sub/a.txt', 'c.txt'), path.join('sub', 'c.txt'));
  assert.equal(readFileSync(path.join(dir, 'sub', 'c.txt'), 'utf8'), 'x');
  assert.equal(existsSync(path.join(dir, 'sub', 'a.txt')), false);
  assert.equal(renameEntry(base, 'sub', 'renamed'), 'renamed');
  assert.equal(readFileSync(path.join(dir, 'renamed', 'c.txt'), 'utf8'), 'x');
  assert.equal(renameEntry(base, 'b.txt', ' spaced name.txt '), 'spaced name.txt');
  assert.equal(renameEntry(base, 'spaced name.txt', 'spaced name.txt'), 'spaced name.txt');
  done();
});

test('a rename never replaces something that is there, and is a name, not a place', () => {
  const { dir, base, outside, done } = setup();
  writeFileSync(path.join(dir, 'a.txt'), 'a'); writeFileSync(path.join(dir, 'b.txt'), 'b');
  assert.equal(code(() => renameEntry(base, 'a.txt', 'b.txt')), 'exists');
  assert.equal(readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'b');
  for (const name of ['', '   ', '.', '..', 'x/y', '../outside/moved', '/etc/x', 'a\\b', 'x\0y', 'n'.repeat(300), undefined, 5]) {
    assert.equal(code(() => renameEntry(base, 'a.txt', name)), 'invalid', JSON.stringify(name));
  }
  assert.equal(existsSync(path.join(dir, 'a.txt')), true);
  assert.equal(existsSync(path.join(outside, 'moved')), false);
  done();
});

test('only what is in the folder is renamed: not the folder, not a way out, not what is not there', () => {
  const { base, outside, done } = setup();
  for (const p of ['', '.', '/', '..', '../outside/secret', '/etc/passwd', 'a/../../outside/secret']) {
    assert.match(code(() => renameEntry(base, p, 'x')), /invalid|missing/, JSON.stringify(p));
  }
  assert.equal(code(() => renameEntry(base, 'nope', 'x')), 'missing');
  assert.equal(readFileSync(path.join(outside, 'secret'), 'utf8'), 'top secret');
  done();
});

test('a link is renamed as the link, and what it leads to keeps its name; nothing is renamed through one', () => {
  const { dir, base, outside, done } = setup();
  symlinkSync(outside, path.join(dir, 'escape'));
  assert.equal(renameEntry(base, 'escape', 'moved-link'), 'moved-link');
  assert.equal(existsSync(path.join(outside, 'secret')), true);
  symlinkSync(outside, path.join(dir, 'door'));
  assert.equal(code(() => renameEntry(base, 'door/secret', 'x')), 'invalid');
  assert.equal(existsSync(path.join(outside, 'secret')), true);
  done();
});

test('a folder is found for archiving, and a file, a missing place and a way out are not', () => {
  const { dir, base, outside, done } = setup();
  mkdirSync(path.join(dir, 'sub')); writeFileSync(path.join(dir, 'a.txt'), 'x');
  assert.equal(folderPath(base, 'sub'), path.join(base, 'sub'));
  assert.equal(folderPath(base, ''), base);
  assert.equal(code(() => folderPath(base, 'a.txt')), 'invalid');
  assert.equal(code(() => folderPath(base, 'nope')), 'missing');
  symlinkSync(outside, path.join(dir, 'escape'));
  assert.equal(code(() => folderPath(base, 'escape')), 'invalid');
  assert.equal(code(() => folderPath(base, '../outside')), 'invalid');
  done();
});

test('a save over a file that was emptied since it was opened is refused, like any other change', () => {
  const { dir, base, done } = setup();
  const file = path.join(dir, 'a.txt');
  writeFileSync(file, 'the first version');
  const opened = readText(base, 'a.txt').mtime;
  writeFileSync(file, ''); utimesSync(file, new Date(), new Date(Date.now() + 60_000));
  assert.equal(code(() => writeText(base, 'a.txt', 'my stale text', opened)), 'conflict');
  assert.equal(readFileSync(file, 'utf8'), '');
  done();
});

test('a save over a file that was taken away since it was opened does not put it back', () => {
  const { dir, base, done } = setup();
  const file = path.join(dir, 'a.txt');
  writeFileSync(file, 'text');
  const opened = readText(base, 'a.txt').mtime;
  rmSync(file);
  assert.equal(code(() => writeText(base, 'a.txt', 'resurrected', opened)), 'conflict');
  assert.equal(existsSync(file), false);
  // Saving it anyway, on purpose, is a save without the time it was opened at.
  writeText(base, 'a.txt', 'on purpose');
  assert.equal(readFileSync(file, 'utf8'), 'on purpose');
  done();
});

test('an empty file that has not changed is saved, and a file made without a time to compare is made', () => {
  const { dir, base, done } = setup();
  writeFileSync(path.join(dir, 'empty.txt'), '');
  writeText(base, 'empty.txt', 'now with text', readText(base, 'empty.txt').mtime);
  assert.equal(readFileSync(path.join(dir, 'empty.txt'), 'utf8'), 'now with text');
  writeText(base, 'made.txt', 'new');
  assert.equal(readFileSync(path.join(dir, 'made.txt'), 'utf8'), 'new');
  done();
});

test('a save is put in place whole: the mode stays, and no temporary file is left', () => {
  const { dir, base, done } = setup();
  const file = path.join(dir, 'a.sh');
  writeFileSync(file, '#!/bin/sh\n'); chmodSync(file, 0o750);
  writeText(base, 'a.sh', '#!/bin/sh\necho hi\n', readText(base, 'a.sh').mtime);
  assert.equal(readFileSync(file, 'utf8'), '#!/bin/sh\necho hi\n');
  assert.equal(statSync(file).mode & 0o7777, 0o750);
  writeText(base, 'made.txt', 'new');
  assert.deepEqual(readdirSync(dir).sort(), ['a.sh', 'made.txt']);
  done();
});

test('a save that cannot be made leaves the file as it was, and the next save is not a conflict', { skip: process.getuid?.() === 0 && 'root can write anywhere' }, () => {
  const { dir, base, done } = setup();
  const file = path.join(dir, 'a.txt');
  writeFileSync(file, 'precious');
  const opened = readText(base, 'a.txt');
  chmodSync(dir, 0o500);
  try {
    assert.equal(code(() => writeText(base, 'a.txt', 'never lands', opened.mtime)), 'failed');
    assert.equal(readFileSync(file, 'utf8'), 'precious');
    assert.equal(statSync(file).mtimeMs, opened.mtime);
  } finally { chmodSync(dir, 0o700); }
  writeText(base, 'a.txt', 'second try', opened.mtime);
  assert.equal(readFileSync(file, 'utf8'), 'second try');
  assert.deepEqual(readdirSync(dir), ['a.txt']);
  done();
});

test('a folder over the cap is cut down before it is looked at, and folders still come first', () => {
  const { dir, base, done } = setup();
  for (let i = 0; i < files.MAX_ENTRIES + 5; i++) writeFileSync(path.join(dir, `f${i}`), '');
  mkdirSync(path.join(dir, 'zzz-last-by-name'));
  const list = listDir(base, '');
  assert.equal(list.entries.length, files.MAX_ENTRIES);
  assert.equal(list.entries[0].name, 'zzz-last-by-name');
  assert.equal(list.entries[0].type, 'dir');
  assert.equal(list.truncated, true);
  done();
});

test('a read-only file in a folder that can be written is saved, and stays read-only', { skip: process.getuid?.() === 0 && 'root can write anywhere' }, () => {
  const { dir, base, done } = setup();
  const file = path.join(dir, 'generated.txt');
  writeFileSync(file, 'generated'); chmodSync(file, 0o444);
  assert.equal(readText(base, 'generated.txt').content, 'generated');
  writeText(base, 'generated.txt', 'edited', readText(base, 'generated.txt').mtime);
  assert.equal(readFileSync(file, 'utf8'), 'edited');
  assert.equal(statSync(file).mode & 0o7777, 0o444);
  done();
});

test('what the system refuses on a delete or a rename is said, not a 500', { skip: process.getuid?.() === 0 && 'root can write anywhere' }, async () => {
  const { dir, base, done } = setup();
  mkdirSync(path.join(dir, 'sub')); writeFileSync(path.join(dir, 'sub', 'a.txt'), 'x');
  chmodSync(path.join(dir, 'sub'), 0o500);
  try {
    assert.equal(await codeOf(() => removeEntry(base, 'sub/a.txt')), 'failed');
    assert.equal(code(() => renameEntry(base, 'sub/a.txt', 'b.txt')), 'failed');
    assert.equal(existsSync(path.join(dir, 'sub', 'a.txt')), true);
  } finally { chmodSync(path.join(dir, 'sub'), 0o700); }
  done();
});

test('a delete of something that has gone in the meantime is not an error', async () => {
  const { dir, base, done } = setup();
  writeFileSync(path.join(dir, 'a.txt'), 'x');
  await removeEntry(base, 'a.txt');
  assert.equal(await codeOf(() => removeEntry(base, 'a.txt')), 'missing');
  done();
});

test('a link is marked as one, also when it leads to a folder that is listed as a folder', () => {
  const { dir, base, outside, done } = setup();
  mkdirSync(path.join(dir, 'sub')); writeFileSync(path.join(dir, 'a.txt'), 'x');
  symlinkSync(path.join(dir, 'sub'), path.join(dir, 'to-sub'));
  symlinkSync(path.join(dir, 'a.txt'), path.join(dir, 'to-a'));
  symlinkSync(outside, path.join(dir, 'out'));
  symlinkSync(path.join(dir, 'gone'), path.join(dir, 'broken'));
  const by = Object.fromEntries(listDir(base, '').entries.map((e) => [e.name, e]));
  assert.deepEqual([by['to-sub'].type, by['to-sub'].link], ['dir', true]);
  assert.deepEqual([by['to-a'].type, by['to-a'].link], ['file', true]);
  assert.deepEqual([by.out.type, by.out.link], ['link', true]);
  assert.deepEqual([by.broken.type, by.broken.link], ['link', true]);
  assert.equal(by.sub.link, undefined);
  assert.equal(by['a.txt'].link, undefined);
  done();
});

test('a refusal is sent with its code, so that the page does not have to read the sentence', async () => {
  const { fail } = await import('../dist/api/files.js');
  const answer = (e) => {
    const sent = {};
    const res = { status(s) { sent.status = s; return this; }, json(b) { sent.body = b; return this; } };
    fail(res, e);
    return sent;
  };
  // Both are 409: only the code says which one it is.
  assert.deepEqual(answer(new FileError('conflict', 'The file changed after you opened it')), { status: 409, body: { error: 'The file changed after you opened it', code: 'conflict' } });
  assert.deepEqual(answer(new FileError('exists', 'Something with that name is already here')), { status: 409, body: { error: 'Something with that name is already here', code: 'exists' } });
  assert.equal(answer(new FileError('too_large', 'Too big')).body.code, 'too_large');
});

/** The folders that are synced while `fn` runs: a save is only lasting once the folder it renamed in is. */
function syncedFolders(fn) {
  const real = fs.fsyncSync;
  const folders = [];
  fs.fsyncSync = (fd) => {
    const st = fstatSync(fd);
    if (st.isDirectory()) folders.push(st.ino);
    return real(fd);
  };
  syncBuiltinESMExports();
  try {
    fn();
  } finally {
    fs.fsyncSync = real;
    syncBuiltinESMExports();
  }
  return folders;
}

test('a save takes bytes as well as text, and writes them as they are', () => {
  const { dir, base, done } = setup();
  const bytes = Buffer.from([0, 1, 2, 255, 254, 0, 0x80]);
  const saved = writeText(base, 'b.bin', bytes);
  assert.deepEqual(readFileSync(path.join(dir, 'b.bin')), bytes);
  assert.equal(saved.size, bytes.length);
  // The limit counts bytes, not characters: 600,000 of these are 1.2 MB.
  assert.equal(code(() => writeText(base, 'big.txt', 'é'.repeat(600_000))), 'too_large');
  assert.equal(code(() => writeText(base, 'big.bin', Buffer.alloc(MAX_EDIT_BYTES + 1))), 'too_large');
  writeText(base, 'b.bin', Buffer.alloc(MAX_EDIT_BYTES));
  assert.equal(statSync(path.join(dir, 'b.bin')).size, MAX_EDIT_BYTES);
  done();
});

test('bytes are read as they are, null bytes included, up to 1 MB, and the start of a file alone', () => {
  const { dir, base, done } = setup();
  const bytes = Buffer.from([0, 1, 2, 3, 0, 0xff]);
  writeFileSync(path.join(dir, 'b.bin'), bytes);
  const read = readBytes(base, 'b.bin');
  assert.deepEqual(read.bytes, bytes);
  assert.equal(read.size, 6);
  assert.equal(read.mtime, readText(base, 'b.bin').mtime);
  assert.deepEqual(readBytes(base, 'b.bin', { head: 2 }).bytes, bytes.subarray(0, 2));
  assert.equal(readBytes(base, 'b.bin', { head: 2 }).size, 6, 'the size is the whole file\'s');
  assert.equal(readBytes(base, 'b.bin', { head: 0 }).bytes.length, 0);
  assert.equal(readBytes(base, 'b.bin', { head: 100 }).bytes.length, 6);
  assert.equal(readBytes(base, 'b.bin', { head: 0 }).change, read.change, 'a look at it alone says the same');
  writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(MAX_EDIT_BYTES + 1));
  assert.equal(code(() => readBytes(base, 'big.bin')), 'too_large');
  assert.equal(code(() => readBytes(base, 'gone.bin')), 'missing');
  mkdirSync(path.join(dir, 'sub'));
  assert.equal(code(() => readBytes(base, 'sub')), 'invalid');
  done();
});

test('what is opened says when it changed: a write in place and a file put there by a rename both differ, a look does not', () => {
  const { dir, base, done } = setup();
  const file = path.join(dir, 'a.md');
  writeFileSync(file, 'one');
  const first = openFile(base, 'a.md');
  closeSync(first.fd);
  const again = openFile(base, 'a.md');
  closeSync(again.fd);
  assert.equal(again.change, first.change, 'nothing happened to it');
  assert.equal(first.name, 'a.md');
  // In place: the same file, other times.
  utimesSync(file, new Date(), new Date(Date.now() + 60_000));
  const touched = readBytes(base, 'a.md');
  assert.notEqual(touched.change, first.change);
  // Put in place by a rename, with the same size, the same times and the same content: another file all the same.
  const stat = statSync(file);
  writeFileSync(path.join(dir, 'other'), 'one');
  utimesSync(path.join(dir, 'other'), stat.atime, stat.mtime);
  renameSync(path.join(dir, 'other'), file);
  assert.equal(readBytes(base, 'a.md').size, touched.size);
  assert.notEqual(readBytes(base, 'a.md').change, touched.change, 'its inode is another');
  done();
});

test('a save answers with the change of the file it wrote, which is what opening it says after', () => {
  const { dir, base, done } = setup();
  writeFileSync(path.join(dir, 'a.md'), 'old');
  const replaced = writeText(base, 'a.md', 'newer');
  assert.equal(replaced.change, readBytes(base, 'a.md').change);
  assert.equal(replaced.mtime, readBytes(base, 'a.md').mtime);
  const made = writeText(base, 'made.md', 'x', undefined, true);
  assert.equal(made.change, readBytes(base, 'made.md').change);
  assert.notEqual(made.change, replaced.change);
  done();
});

test('an open file is the one the name had then: what is put in its place after is not read through it', () => {
  const { dir, base, done } = setup();
  writeFileSync(path.join(dir, 'a.md'), 'the first');
  const opened = openFile(base, 'a.md');
  try {
    writeText(base, 'a.md', 'the second');
    const buffer = Buffer.alloc(opened.size);
    assert.equal(readSync(opened.fd, buffer, 0, opened.size, 0), opened.size);
    assert.equal(buffer.toString(), 'the first');
  } finally {
    closeSync(opened.fd);
  }
  done();
});

test('direct: a name in the folder itself, never one that a link led to, for reading and for saving', () => {
  const { dir, base, outside, done } = setup();
  writeFileSync(path.join(dir, 'real.md'), 'real');
  symlinkSync('real.md', path.join(dir, 'inside-link.md'));
  symlinkSync(path.join(outside, 'secret'), path.join(dir, 'out-link.md'));
  mkdirSync(path.join(dir, 'sub'));
  writeFileSync(path.join(dir, 'sub', 'deep.md'), 'deep');
  const direct = { direct: true };
  assert.equal(readBytes(base, 'real.md', direct).bytes.toString(), 'real');
  // Without it a link inside the folder is followed, as ever; with it, it is not a file by that name.
  assert.equal(readBytes(base, 'inside-link.md').bytes.toString(), 'real');
  assert.equal(code(() => readBytes(base, 'inside-link.md', direct)), 'invalid');
  assert.equal(code(() => readBytes(base, 'out-link.md', direct)), 'invalid');
  assert.equal(code(() => openFile(base, 'inside-link.md', direct)), 'invalid');
  assert.equal(code(() => readBytes(base, 'sub/deep.md', direct)), 'invalid', 'a name, not a way');
  assert.equal(code(() => readBytes(base, 'nowhere.md', direct)), 'missing');
  // A save does not write through the link either, however it is spelled.
  assert.equal(code(() => writeText(base, 'inside-link.md', 'x', undefined, false, direct)), 'invalid');
  assert.equal(readFileSync(path.join(dir, 'real.md'), 'utf8'), 'real');
  assert.equal(code(() => writeText(base, 'inside-link.md', 'x', undefined, true, direct)), 'invalid');
  assert.equal(code(() => writeText(base, 'sub/deep.md', 'x', undefined, false, direct)), 'invalid');
  writeText(base, 'real.md', 'changed', undefined, false, direct);
  assert.equal(readFileSync(path.join(dir, 'real.md'), 'utf8'), 'changed');
  done();
});

test('alone: a file with a second name is not read, whatever it is a second name of', () => {
  const { dir, base, outside, done } = setup();
  linkSync(path.join(outside, 'secret'), path.join(dir, 'twin.md'));
  assert.equal(readBytes(base, 'twin.md').bytes.toString(), 'top secret');
  assert.equal(code(() => readBytes(base, 'twin.md', { alone: true })), 'invalid');
  assert.equal(code(() => openFile(base, 'twin.md', { alone: true })), 'invalid');
  writeFileSync(path.join(dir, 'one.md'), 'one');
  assert.equal(readBytes(base, 'one.md', { alone: true }).bytes.toString(), 'one');
  done();
});

test('a file that is made has the folder\'s mode (group-writable where the folder is), and one that is replaced keeps its own', () => {
  const { dir, base, done } = setup();
  chmodSync(dir, 0o775);
  writeText(base, 'like.md', 'x');
  assert.equal(statSync(path.join(dir, 'like.md')).mode & 0o777, 0o664);
  saveNewFile(base, '', 'up.md', Buffer.from('x'));
  assert.equal(statSync(path.join(dir, 'up.md')).mode & 0o777, 0o664, 'an upload too');
  chmodSync(dir, 0o755);
  writeText(base, 'like2.md', 'x');
  assert.equal(statSync(path.join(dir, 'like2.md')).mode & 0o777, 0o644);
  chmodSync(path.join(dir, 'like2.md'), 0o600);
  writeText(base, 'like2.md', 'y');
  assert.equal(statSync(path.join(dir, 'like2.md')).mode & 0o777, 0o600);
  // The owner and group are the folder's where the portal may give them away (it does not in a test that runs as someone).
  assert.deepEqual([statSync(path.join(dir, 'like.md')).uid, statSync(path.join(dir, 'like.md')).gid], [statSync(dir).uid, statSync(dir).gid]);
  done();
});

test('a folder that is made has the mode of the folder it is made in', () => {
  const { dir, base, done } = setup();
  chmodSync(dir, 0o775);
  makeFolder(base, '', 'a');
  assert.equal(statSync(path.join(dir, 'a')).mode & 0o777, 0o775);
  chmodSync(dir, 0o750);
  makeFolder(base, '', 'b');
  assert.equal(statSync(path.join(dir, 'b')).mode & 0o777, 0o750);
  assert.equal(code(() => makeFolder(base, '', 'b')), 'exists');
  writeFileSync(path.join(dir, 'file'), 'x');
  assert.equal(code(() => makeFolder(base, '', 'file')), 'exists');
  done();
});

test('a folder that is made is given its mode through itself: a link put in its place meanwhile gets nothing', () => {
  const { dir, base, outside, done } = setup();
  const victim = path.join(outside, 'secret');
  chmodSync(victim, 0o600);
  chmodSync(dir, 0o775);
  // What the agent could do where the portal is root and the folder is the agent's to write in: put a link where the folder
  // was just made, before it is given its mode.
  const real = fs.mkdirSync;
  fs.mkdirSync = (target, ...rest) => {
    const made = real(target, ...rest);
    rmSync(target, { recursive: true });
    symlinkSync(victim, target);
    return made;
  };
  syncBuiltinESMExports();
  try {
    assert.equal(code(() => makeFolder(base, '', 'swapped')), 'exists');
  } finally {
    fs.mkdirSync = real;
    syncBuiltinESMExports();
  }
  assert.equal(statSync(victim).mode & 0o777, 0o600, 'what the link leads to keeps its mode');
  assert.equal(readFileSync(victim, 'utf8'), 'top secret');
  done();
});

test('a folder is found as a name in the folder itself, and a link to a folder is none', () => {
  const { dir, base, outside, done } = setup();
  mkdirSync(path.join(dir, 'documents'));
  mkdirSync(path.join(dir, 'real'));
  symlinkSync('real', path.join(dir, 'inside-link'));
  symlinkSync(outside, path.join(dir, 'out-link'));
  writeFileSync(path.join(dir, 'file'), 'x');
  assert.equal(folderPath(base, 'documents', { direct: true }), path.join(base, 'documents'));
  assert.equal(folderPath(base, 'inside-link'), path.join(base, 'real'), 'followed, as ever');
  assert.equal(code(() => folderPath(base, 'inside-link', { direct: true })), 'invalid');
  assert.equal(code(() => folderPath(base, 'out-link', { direct: true })), 'invalid');
  assert.equal(code(() => folderPath(base, 'file', { direct: true })), 'invalid');
  assert.equal(code(() => folderPath(base, 'gone', { direct: true })), 'missing');
  done();
});

test('the temporary files of saves that were cut off are swept, and one of a save that is under way is not', () => {
  const { dir, base, done } = setup();
  const old = new Date(Date.now() - 5 * 60_000);
  const left = (name, when) => { writeFileSync(path.join(dir, name), 'half'); utimesSync(path.join(dir, name), when, when); };
  left('.a.md.0123456789ab.tmp', old);
  const recent = new Date(Date.now() - 10_000);
  left('.b.md.fedcba987654.tmp', recent);
  // Not a save's: no hex, not a temporary file, a folder of that name, and a file somebody called so on purpose is the price of the name.
  left('.notes.tmp', old);
  left('plain.md', old);
  left('.c.md.0123456789ab.upload', old);
  mkdirSync(path.join(dir, '.d.md.0123456789ab.tmp'));
  utimesSync(path.join(dir, '.d.md.0123456789ab.tmp'), old, old);
  symlinkSync('/nowhere', path.join(dir, '.e.md.0123456789ab.tmp'));
  lutimesSync(path.join(dir, '.e.md.0123456789ab.tmp'), recent, recent);
  const swept = sweepTemp(base, '');
  // The two that are ten seconds old wait.
  assert.deepEqual(swept, ['.a.md.0123456789ab.tmp']);
  const names = readdirSync(dir).sort();
  assert.deepEqual(names, ['.b.md.fedcba987654.tmp', '.c.md.0123456789ab.upload', '.d.md.0123456789ab.tmp', '.e.md.0123456789ab.tmp', '.notes.tmp', 'plain.md']);
  // With a shorter wait everything that is a save's temporary file goes, a link as the link, a folder not at all.
  assert.deepEqual(sweepTemp(base, '', 5_000).sort(), ['.b.md.fedcba987654.tmp', '.e.md.0123456789ab.tmp']);
  assert.deepEqual(readdirSync(dir).sort(), ['.c.md.0123456789ab.upload', '.d.md.0123456789ab.tmp', '.notes.tmp', 'plain.md']);
  // A folder that is not there, or leads out, is nothing to sweep.
  assert.deepEqual(sweepTemp(base, 'gone'), []);
  assert.equal(code(() => sweepTemp(base, '../outside')), 'invalid');
  done();
});

test('a save that is under way is not swept: the temporary file it has is its own and is put in place', () => {
  const { dir, base, done } = setup();
  writeFileSync(path.join(dir, 'a.md'), 'old');
  // Swept at the moment the save has its file written and not renamed yet, which is what another half's sweep could do.
  const real = fs.renameSync;
  let swept;
  fs.renameSync = (from, to) => {
    swept = sweepTemp(base, '');
    return real(from, to);
  };
  syncBuiltinESMExports();
  try {
    writeText(base, 'a.md', 'new');
  } finally {
    fs.renameSync = real;
    syncBuiltinESMExports();
  }
  assert.deepEqual(swept, []);
  assert.equal(readFileSync(path.join(dir, 'a.md'), 'utf8'), 'new');
  done();
});

test('the folder is synced after a save, a made file and an upload, so the rename lasts through a crash', () => {
  const { dir, base, done } = setup();
  const ino = statSync(dir).ino;
  writeFileSync(path.join(dir, 'a.txt'), 'old');
  assert.ok(syncedFolders(() => writeText(base, 'a.txt', 'replaced')).includes(ino), 'a file replaced');
  assert.ok(syncedFolders(() => writeText(base, 'new.txt', 'made')).includes(ino), 'a file made');
  assert.ok(syncedFolders(() => saveNewFile(base, '', 'up.txt', Buffer.from('uploaded'))).includes(ino), 'a file uploaded');
  assert.equal(readFileSync(path.join(dir, 'up.txt'), 'utf8'), 'uploaded');
  done();
});

test('a failure of the disk is a refusal that still says which: the system\'s code is on it', () => {
  const { dir, base, done } = setup();
  writeFileSync(path.join(dir, 'a.txt'), 'x');
  chmodSync(dir, 0o555);
  try {
    // A privileged portal may write anywhere: only where the folder really is closed.
    if (process.getuid?.() === 0) return;
    const e = (() => { try { writeText(base, 'a.txt', 'y'); } catch (err) { return err; } })();
    assert.ok(e instanceof FileError);
    assert.equal(e.code, 'failed');
    assert.equal(e.errno, 'EACCES');
    assert.equal(e.cause.code, 'EACCES');
  } finally {
    chmodSync(dir, 0o755);
    done();
  }
});

test('portal.files has them: the options reach the functions, and the old calls are as they were', () => {
  const { dir, base, done } = setup();
  writeFileSync(path.join(dir, 'real.md'), 'real');
  symlinkSync('real.md', path.join(dir, 'link.md'));
  const portalFiles = folderFiles;
  assert.equal(portalFiles.readBytes(base, 'real.md', { head: 2 }).bytes.toString(), 're');
  assert.equal(code(() => portalFiles.readBytes(base, 'link.md', { direct: true })), 'invalid');
  assert.equal(code(() => portalFiles.write(base, 'link.md', Buffer.from('x'), { direct: true })), 'invalid');
  const saved = portalFiles.write(base, 'real.md', Buffer.from([0, 1]), { direct: true });
  assert.equal(saved.size, 2);
  const opened = portalFiles.open(base, 'real.md', { alone: true, direct: true });
  closeSync(opened.fd);
  assert.equal(opened.change, saved.change);
  // As before: text in, a mode time out, a conflict for a file that moved on, a made file that is not replaced.
  assert.equal(portalFiles.write(base, 'text.txt', 'text').size, 4);
  assert.equal(code(() => portalFiles.write(base, 'text.txt', 'again', { create: true })), 'exists');
  assert.equal(code(() => portalFiles.write(base, 'text.txt', 'again', { expected: 1 })), 'conflict');
  const download = portalFiles.open(base, 'text.txt');
  closeSync(download.fd);
  assert.deepEqual([download.size, download.name], [4, 'text.txt']);
  done();
});

// A folder on the way to a file, put aside and replaced by a link while the portal works.
//
// `resolveInside` checks a path once. What the agent does in its folder in the time between that check and the
// call that uses the path decides where the portal, which with the sandbox on is root, makes, reads or removes
// something. These swap a folder for a link to a folder outside the chat's, at a fixed point: right before the
// first file call the operation makes after the check (so before the folder is walked) and right before the call
// that does the work (so after the folder is held), with `fs` hooked the way the tests above hook it.

const root = process.getuid?.() === 0;
/** The user the sandbox runs the agent as, for a test that is run as root. */
const AGENT = 10100;
const FIRST = { names: ['openSync', 'mkdirSync', 'readdirSync'], when: () => true };
const creating = { names: ['openSync'], when: (_name, [, flags]) => typeof flags === 'number' && (flags & constants.O_CREAT) !== 0 };
const reaching = (name) => ({ names: ['openSync'], when: (_name, [where]) => String(where).endsWith(name) });

/** The chat's folder with `sub` in it (and `sub/doc.md`), and beside it `outside`, which has a `doc.md` of its own and is closed to everyone else. */
function swappable() {
  const made = setup();
  const { dir, outside } = made;
  mkdirSync(path.join(dir, 'sub'));
  writeFileSync(path.join(dir, 'sub', 'doc.md'), 'ours');
  writeFileSync(path.join(outside, 'doc.md'), 'theirs');
  chmodSync(outside, 0o700);
  // As the sandbox has it: the folder is the agent's, and the portal that writes in it is root.
  if (root) for (const where of [dir, path.join(dir, 'sub'), path.join(dir, 'sub', 'doc.md')]) chownSync(where, AGENT, AGENT);
  const sub = path.join(dir, 'sub');
  const aside = `${sub}.aside`;
  /** What the agent does: the folder goes aside, a link to the folder outside stands in its place. */
  const swap = () => {
    renameSync(sub, aside);
    symlinkSync(outside, sub);
  };
  return { ...made, sub, aside, swap };
}

/** Runs `fn` with `swap` done right before the first call of one of `point.names` for which `point.when` holds. Says whether it was done. */
function swappedAt(point, swap, fn) {
  const real = {};
  let swapped = false;
  for (const name of point.names) {
    real[name] = fs[name];
    fs[name] = (...args) => {
      if (!swapped && point.when(name, args)) {
        swapped = true;
        swap();
      }
      return real[name](...args);
    };
  }
  syncBuiltinESMExports();
  try {
    fn();
  } finally {
    for (const name of point.names) fs[name] = real[name];
    syncBuiltinESMExports();
  }
  return swapped;
}

/** What is in a folder, sorted. */
const names = (folder) => readdirSync(folder).sort();

test('a folder swapped for a link before it is used is refused: a made folder is not made where the link leads', () => {
  const { base, outside, aside, swap, done } = swappable();
  const before = names(outside);
  let outcome;
  assert.ok(swappedAt(FIRST, swap, () => { outcome = code(() => makeFolder(base, 'sub', 'evil')); }));
  assert.equal(outcome, 'invalid');
  assert.deepEqual(names(outside), before, 'nothing was made outside');
  assert.ok(!existsSync(path.join(aside, 'evil')));
  done();
});

test('a folder is made in the folder that was checked, however the path is changed after: the link gets nothing, owner or mode', () => {
  const { dir, base, outside, aside, swap, done } = swappable();
  const before = names(outside);
  chmodSync(path.join(dir, 'sub'), 0o775);
  assert.ok(swappedAt({ names: ['mkdirSync'], when: () => true }, swap, () => { makeFolder(base, 'sub', 'evil'); }));
  assert.deepEqual(names(outside), before, 'nothing was made outside');
  assert.equal(statSync(outside).mode & 0o777, 0o700);
  const made = statSync(path.join(aside, 'evil'));
  assert.equal(made.mode & 0o777, 0o775, 'it is where the folder was held');
  if (root) assert.deepEqual([made.uid, made.gid], [AGENT, AGENT], 'and the folder\'s owner is its');
  done();
});

test('a file that is made is made in the folder that was checked: a link put there before the walk is refused, one put there after is not followed', () => {
  for (const [point, outcome] of [[FIRST, 'invalid'], [creating, 'none']]) {
    const { base, outside, aside, swap, done } = swappable();
    const before = names(outside);
    let got;
    assert.ok(swappedAt(point, swap, () => { got = code(() => writeText(base, 'sub/notes.txt', 'the person\'s', undefined, true)); }));
    assert.equal(got, outcome);
    assert.deepEqual(names(outside), before, 'nothing was made outside');
    assert.equal(existsSync(path.join(aside, 'notes.txt')), outcome === 'none');
    if (root && outcome === 'none') assert.deepEqual([statSync(path.join(aside, 'notes.txt')).uid, statSync(path.join(aside, 'notes.txt')).gid], [AGENT, AGENT]);
    done();
  }
});

test('a file that is replaced is replaced in the folder that was checked, and not the one of that name that the link leads to', () => {
  for (const [point, outcome] of [[FIRST, 'invalid'], [creating, 'none']]) {
    const { base, outside, aside, swap, done } = swappable();
    let got;
    assert.ok(swappedAt(point, swap, () => { got = code(() => writeText(base, 'sub/doc.md', 'changed')); }));
    assert.equal(got, outcome);
    assert.equal(readFileSync(path.join(outside, 'doc.md'), 'utf8'), 'theirs');
    assert.deepEqual(names(outside), ['doc.md', 'secret']);
    assert.equal(readFileSync(path.join(aside, 'doc.md'), 'utf8'), outcome === 'none' ? 'changed' : 'ours');
    done();
  }
});

test('an upload is made and put in place in the folder that was checked', () => {
  for (const point of [FIRST, creating]) {
    const { base, outside, aside, swap, done } = swappable();
    const before = names(outside);
    let got;
    assert.ok(swappedAt(point, swap, () => { got = code(() => saveNewFile(base, 'sub', 'up.txt', Buffer.from('uploaded'))); }));
    assert.deepEqual(names(outside), before, 'nothing was made outside');
    if (point === FIRST) assert.equal(got, 'invalid');
    else {
      assert.equal(got, 'none');
      assert.equal(readFileSync(path.join(aside, 'up.txt'), 'utf8'), 'uploaded');
      if (root) assert.deepEqual([statSync(path.join(aside, 'up.txt')).uid, statSync(path.join(aside, 'up.txt')).gid], [AGENT, AGENT]);
    }
    done();
  }
});

test('an upload that is long in coming goes in place in the folder it began in, not where the path leads by then', () => {
  const { base, outside, aside, swap, done } = swappable();
  const before = names(outside);
  const target = uploadTarget(base, 'sub', 'up.txt');
  closeSync(target.fd);
  swap();
  const placed = target.finish();
  assert.equal(placed, path.join('sub', 'up.txt'));
  assert.deepEqual(names(outside), before, 'nothing was made outside');
  assert.ok(existsSync(path.join(aside, 'up.txt')));
  done();
});

test('a file is read from the folder that was checked: a link put in the folder\'s place gives the contents of what it leads to to nobody', () => {
  const readers = {
    readBytes: (base) => readBytes(base, 'sub/doc.md').bytes.toString(),
    readText: (base) => readText(base, 'sub/doc.md').content,
    openFile: (base) => {
      const opened = openFile(base, 'sub/doc.md');
      try { return readFileSync(opened.fd, 'utf8'); } finally { closeSync(opened.fd); }
    },
  };
  for (const [reader, read] of Object.entries(readers)) {
    for (const [point, outcome] of [[FIRST, 'invalid'], [reaching('/doc.md'), 'ours']]) {
      const { base, swap, done } = swappable();
      let got;
      assert.ok(swappedAt(point, swap, () => { try { got = read(base); } catch (e) { got = e instanceof FileError ? e.code : `other:${e.message}`; } }), reader);
      assert.equal(got, outcome, `${reader}: never what the link leads to`);
      done();
    }
  }
});

test('the temporary files of cut-off saves are swept in the folder that was checked, not in the one a link leads to', () => {
  for (const [point, swept] of [[FIRST, []], [{ names: ['unlinkSync'], when: () => true }, ['.a.md.0123456789ab.tmp']]]) {
    const { sub, aside, outside, base, swap, done } = swappable();
    const old = new Date(Date.now() - 5 * 60_000);
    for (const folder of [sub, outside]) {
      writeFileSync(path.join(folder, '.a.md.0123456789ab.tmp'), 'half');
      utimesSync(path.join(folder, '.a.md.0123456789ab.tmp'), old, old);
    }
    let got;
    assert.ok(swappedAt(point, swap, () => { got = sweepTemp(base, 'sub'); }));
    assert.deepEqual(got, swept);
    assert.ok(existsSync(path.join(outside, '.a.md.0123456789ab.tmp')), 'what is outside stays');
    assert.equal(existsSync(path.join(aside, '.a.md.0123456789ab.tmp')), swept.length === 0);
    done();
  }
});

test('every folder on the way is held, not only the first: a deep one swapped for a link is refused too', () => {
  for (const [point, outcome] of [[FIRST, 'invalid'], [creating, 'none']]) {
    const { sub, base, outside, done } = swappable();
    mkdirSync(path.join(sub, 'deep'));
    const before = names(outside);
    const deep = path.join(sub, 'deep');
    const swapDeep = () => {
      renameSync(deep, `${deep}.aside`);
      symlinkSync(outside, deep);
    };
    let got;
    assert.ok(swappedAt(point, swapDeep, () => { got = code(() => writeText(base, 'sub/deep/notes.txt', 'x', undefined, true)); }));
    assert.equal(got, outcome);
    assert.deepEqual(names(outside), before, 'nothing was made outside');
    assert.equal(existsSync(path.join(`${deep}.aside`, 'notes.txt')), outcome === 'none');
    done();
  }
});

test('a link to a folder inside the chat\'s folder is still written through: the path is checked, and the folder held is the one it leads to', () => {
  const { dir, base, done } = setup();
  mkdirSync(path.join(dir, 'real'));
  symlinkSync('real', path.join(dir, 'inside-link'));
  writeText(base, 'inside-link/a.txt', 'a');
  saveNewFile(base, 'inside-link', 'b.txt', Buffer.from('b'));
  assert.equal(makeFolder(base, 'inside-link', 'c'), path.join('real', 'c'));
  assert.deepEqual(readdirSync(path.join(dir, 'real')).sort(), ['a.txt', 'b.txt', 'c']);
  assert.equal(readText(base, 'inside-link/a.txt').content, 'a');
  assert.equal(readBytes(base, 'inside-link/b.txt').bytes.toString(), 'b');
  assert.deepEqual(sweepTemp(base, 'inside-link'), []);
  done();
});

test('a folder above the chat\'s folder that was swapped is found when the folder is held: nothing is made in what the link leads to', () => {
  const { top, dir, done } = setup();
  // The chat's folder is `top/work`; the check saw it there, and by the time of the call `top` leads elsewhere.
  const base = baseDir(dir);
  const elsewhere = scratch('wsfiles-elsewhere-');
  mkdirSync(path.join(elsewhere, 'work'));
  const before = names(path.join(elsewhere, 'work'));
  const swapTop = () => {
    renameSync(top, `${top}.aside`);
    symlinkSync(elsewhere, top);
  };
  try {
    let got;
    assert.ok(swappedAt(FIRST, swapTop, () => { got = code(() => writeText(base, 'new.md', 'x', undefined, true)); }));
    assert.equal(got, 'invalid');
    assert.deepEqual(names(path.join(elsewhere, 'work')), before);
  } finally {
    rmSync(`${top}.aside`, { recursive: true, force: true });
    done();
  }
});

test('where descriptors cannot be named as paths the portal still works, and gives nothing away', () => {
  const { dir, base, done } = setup();
  chmodSync(dir, 0o775);
  if (root) chownSync(dir, AGENT, AGENT);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  try {
    writeText(base, 'made.txt', 'x');
    saveNewFile(base, '', 'up.txt', Buffer.from('y'));
    makeFolder(base, '', 'folder');
    writeText(base, 'made.txt', 'replaced');
    assert.equal(readText(base, 'made.txt').content, 'replaced');
    assert.deepEqual(sweepTemp(base, ''), []);
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
  for (const name of ['made.txt', 'up.txt', 'folder']) {
    // Not the folder's, where it could not be known to be the chat's: the portal's own.
    assert.equal(statSync(path.join(dir, name)).uid, process.getuid?.() ?? statSync(path.join(dir, name)).uid, name);
  }
  done();
});

/** The groups this process is in besides the one it makes files in, to stand in for the folder's group. */
const otherGroup = () => process.getgroups?.().find((g) => g !== process.getegid?.());

/** A portal that may not give anything away: the call fails as it does for a user who is not root. */
function cannotGive(allow = () => false, fn) {
  const real = fs.fchownSync;
  fs.fchownSync = (fd, uid, gid) => {
    if (!allow(uid, gid)) throw Object.assign(new Error('EPERM: operation not permitted, fchown'), { code: 'EPERM' });
    return real(fd, uid, gid);
  };
  syncBuiltinESMExports();
  try {
    fn();
  } finally {
    fs.fchownSync = real;
    syncBuiltinESMExports();
  }
}

test('a portal that cannot give a file to the folder\'s group does not make it writable for its own group', { skip: root || otherGroup() === undefined }, () => {
  const { dir, base, done } = setup();
  const group = otherGroup();
  chownSync(dir, process.getuid(), group);
  chmodSync(dir, 0o775);
  const modeOf = (name) => statSync(path.join(dir, name)).mode & 0o7777;
  // Allowed nothing: the files are in the group this process makes them in, which is not the folder's.
  cannotGive(undefined, () => {
    writeText(base, 'a.txt', 'x');
    saveNewFile(base, '', 'b.txt', Buffer.from('x'));
    makeFolder(base, '', 'c');
  });
  for (const name of ['a.txt', 'b.txt', 'c']) assert.notEqual(statSync(path.join(dir, name)).gid, group, name);
  assert.equal(modeOf('a.txt'), 0o644);
  assert.equal(modeOf('b.txt'), 0o644);
  assert.equal(modeOf('c') & 0o020, 0, 'a folder: no group-write');
  assert.equal(modeOf('c') & 0o2000, 0, 'and no setgid');
  // Allowed to change the group only (the portal is in the folder's group, as the owner is the folder's own, no): then the group is the folder's.
  cannotGive((uid) => uid === -1, () => {
    writeText(base, 'd.txt', 'x');
    saveNewFile(base, '', 'e.txt', Buffer.from('x'));
    makeFolder(base, '', 'f');
  });
  for (const name of ['d.txt', 'e.txt', 'f']) assert.equal(statSync(path.join(dir, name)).gid, group, name);
  assert.equal(modeOf('d.txt'), 0o664);
  assert.equal(modeOf('e.txt'), 0o664);
  assert.equal(modeOf('f'), 0o775);
  done();
});

test('a portal that is not root makes files for the folder\'s group only when they are in it (a child that gives up root, with the folder\'s group or without)', { skip: !root }, () => {
  const { top, dir, base, done } = setup();
  const OTHER = 10101, GROUP = 10102, PORTAL = 10103, USERS = 100;
  chmodSync(top, 0o755);
  chmodSync(dir, 0o775);
  const script = `
    const [dist, base, groups] = process.argv.slice(1);
    const { writeText, saveNewFile, makeFolder } = await import(dist);
    process.setgroups(JSON.parse(groups));
    process.setgid(${USERS});
    process.setuid(${PORTAL});
    writeText(base, 'a.txt', 'x');
    saveNewFile(base, '', 'b.txt', Buffer.from('x'));
    makeFolder(base, '', 'c');
  `;
  const dist = fileURLToPath(new URL('../dist/workspace-files.js', import.meta.url));
  const run = (groups) => execFileSync(process.execPath, ['--input-type=module', '-e', script, dist, base, JSON.stringify(groups)]);
  const stat = (name) => ({ uid: statSync(path.join(dir, name)).uid, gid: statSync(path.join(dir, name)).gid, mode: statSync(path.join(dir, name)).mode & 0o7777 });
  const clear = () => { for (const name of ['a.txt', 'b.txt', 'c']) rmSync(path.join(dir, name), { recursive: true }); };

  // The folder is the portal's own, in a group the portal is not in: what it makes stays in the portal's group, which the folder
  // does not let write, so it is not group-writable (it was, for the portal's group, 0664).
  chownSync(dir, PORTAL, GROUP);
  run([]);
  assert.deepEqual(stat('a.txt'), { uid: PORTAL, gid: USERS, mode: 0o644 });
  assert.deepEqual(stat('b.txt'), { uid: PORTAL, gid: USERS, mode: 0o644 });
  assert.deepEqual(stat('c'), { uid: PORTAL, gid: USERS, mode: 0o755 });
  clear();

  // Someone else's folder that the portal writes in through the group: it may not give the files away, but they go to the folder's
  // group, which is the one that may write in the folder.
  chownSync(dir, OTHER, GROUP);
  run([GROUP]);
  assert.deepEqual(stat('a.txt'), { uid: PORTAL, gid: GROUP, mode: 0o664 });
  assert.deepEqual(stat('b.txt'), { uid: PORTAL, gid: GROUP, mode: 0o664 });
  assert.deepEqual(stat('c'), { uid: PORTAL, gid: GROUP, mode: 0o775 });
  done();
});
