import assert from 'node:assert/strict';
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { scratch } from './server-harness.mjs';
const files = await import('../dist/workspace-files.js');
const { FileError, baseDir, listDir, readText, writeText, removeEntry, renameEntry, folderPath, resolveInside, openDownload, MAX_EDIT_BYTES } = files;

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
