import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { scratch } from './server-harness.mjs';
const { FileError, baseDir, uploadStream, watchFolder, UPLOAD_INTERRUPTED } = await import('../dist/workspace-files.js');
const { folderFiles } = await import('../dist/folder-files.js');

/**
 * A file that arrives as a stream, and a folder that is watched, through `portal.files` (workspace-files.ts):
 * the numbering and the checks of an upload, a file that does not arrive whole, and a watch that stays on the
 * folder it was set on.
 */

function setup() {
  const top = scratch('wsstream-');
  const dir = path.join(top, 'work');
  const outside = path.join(top, 'outside');
  mkdirSync(dir); mkdirSync(outside);
  mkdirSync(path.join(dir, 'sub'));
  writeFileSync(path.join(outside, 'secret'), 'top secret');
  return { top, dir, outside, sub: path.join(dir, 'sub'), base: baseDir(dir), done: () => rmSync(top, { recursive: true, force: true }) };
}
const codeOf = async (fn) => { try { await fn(); } catch (e) { return e instanceof FileError ? e.code : `other:${e.message}`; } return 'none'; };
const chunks = (...parts) => Readable.from(parts.map((p) => Buffer.from(p)));

test('a file that arrives as a stream is put in place whole, and a taken name gets a number instead of replacing', async () => {
  const { base, dir, sub, done } = setup();
  assert.deepEqual(await uploadStream(base, '', 'report.pdf', chunks('one', 'two')), { path: 'report.pdf', size: 6 });
  assert.deepEqual(await uploadStream(base, '', 'report.pdf', chunks('again')), { path: 'report (2).pdf', size: 5 });
  assert.equal(readFileSync(path.join(dir, 'report.pdf'), 'utf8'), 'onetwo');
  assert.equal(readFileSync(path.join(dir, 'report (2).pdf'), 'utf8'), 'again');
  assert.deepEqual(await uploadStream(base, 'sub', 'a.txt', chunks('')), { path: path.join('sub', 'a.txt'), size: 0 });
  assert.ok(existsSync(path.join(sub, 'a.txt')));
  // Through the portal's `files`, as an extension has it, and from anything iterable in chunks.
  assert.deepEqual(await folderFiles.upload(base, '', 'iter.txt', (async function* () { yield Buffer.from('x'); yield Buffer.from('y'); })()), { path: 'iter.txt', size: 2 });
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.upload')), [], 'nothing half-written is left');
  done();
});

test('a file over the limit is refused as soon as the limit is crossed, and nothing is kept', async () => {
  const { base, dir, done } = setup();
  let consumed = 0;
  const body = (async function* () { for (let i = 0; i < 100; i++) { consumed++; yield Buffer.alloc(10); } })();
  assert.equal(await codeOf(() => uploadStream(base, '', 'big.bin', body, { maxBytes: 55 })), 'too_large');
  assert.ok(consumed <= 7, `it stopped reading at the limit, not at the end (${consumed})`);
  assert.deepEqual(readdirSync(dir).filter((n) => n !== 'sub'), []);
  done();
});

test('a sender that goes away mid-file is an interrupted upload, and what came is not kept', async () => {
  const { base, dir, done } = setup();
  const body = (async function* () { yield Buffer.from('half of a file'); throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' }); })();
  let got;
  try { await uploadStream(base, '', 'cut.bin', body); } catch (e) { got = e; }
  assert.ok(got instanceof FileError);
  assert.deepEqual([got.code, got.message], ['failed', UPLOAD_INTERRUPTED]);
  assert.deepEqual(readdirSync(dir).filter((n) => n !== 'sub'), []);
  done();
});

test('a stream cannot be sent out of the folder, by path or by name', async () => {
  const { base, dir, outside, done } = setup();
  symlinkSync(outside, path.join(dir, 'escape'));
  for (const [where, name, want] of [['..', 'x.txt', 'invalid'], ['escape', 'x.txt', 'invalid'], ['', '../x.txt', 'invalid'], ['', '..', 'invalid'], ['nope', 'x.txt', 'missing']]) {
    assert.equal(await codeOf(() => uploadStream(base, where, name, chunks('x'))), want, `${where}/${name}`);
  }
  assert.deepEqual(readdirSync(outside), ['secret']);
  done();
});

test('a stream is put in the folder that was checked: a link put in its place while the file comes in gets nothing', async () => {
  const { base, sub, outside, done } = setup();
  const body = (async function* () {
    yield Buffer.from('first part ');
    // The folder goes aside and a link to the one outside stands in its place, in the middle of the file.
    renameSync(sub, `${sub}.aside`);
    symlinkSync(outside, sub);
    yield Buffer.from('second part');
  })();
  assert.deepEqual(await uploadStream(base, 'sub', 'up.txt', body), { path: path.join('sub', 'up.txt'), size: 22 });
  assert.deepEqual(readdirSync(outside), ['secret'], 'nothing was made outside');
  assert.equal(readFileSync(path.join(`${sub}.aside`, 'up.txt'), 'utf8'), 'first part second part');
  done();
});

/** Waits until `ok()` or two seconds. */
async function until(ok, what) {
  for (let i = 0; i < 80 && !ok(); i++) await sleep(25);
  assert.ok(ok(), what);
}

test('a watch tells that something in the folder changed, once for a burst, and nothing else', async () => {
  const { base, sub, done } = setup();
  const told = [];
  const watch = watchFolder(base, 'sub', (change) => told.push(change), { debounceMs: 60 });
  try {
    for (let i = 0; i < 5; i++) writeFileSync(path.join(sub, `f${i}.txt`), 'x');
    await until(() => told.length >= 1, 'told of the burst');
    await sleep(200);
    assert.deepEqual(told, [{}], 'a burst is one call, with nothing but that something changed');
    rmSync(path.join(sub, 'f0.txt'));
    await until(() => told.length === 2, 'told of a removal');
    assert.ok(watch.current());
  } finally {
    watch.close();
  }
  // Closed: nothing more is told, and closing again is safe.
  writeFileSync(path.join(sub, 'later.txt'), 'x');
  await sleep(200);
  assert.equal(told.length, 2);
  watch.close();
  done();
});

test('a watch ends by itself, saying so, when its folder is removed, renamed or replaced', async () => {
  for (const act of [
    (sub) => rmSync(sub, { recursive: true }),
    (sub) => renameSync(sub, `${sub}.moved`),
    (sub) => { renameSync(sub, `${sub}.moved`); mkdirSync(sub); },
  ]) {
    const { base, sub, done } = setup();
    const told = [];
    const watch = watchFolder(base, 'sub', (change) => told.push(change), { debounceMs: 20 });
    act(sub);
    await until(() => told.some((change) => change.gone), 'told it is gone');
    assert.equal(watch.current(), false);
    const count = told.length;
    for (const where of [sub, `${sub}.moved`]) if (existsSync(where)) writeFileSync(path.join(where, 'z.txt'), 'z');
    await sleep(150);
    assert.equal(told.length, count, 'and the watch is over: it says nothing more');
    done();
  }
});

test('a watch is on the folder that was checked: a link put in its place does not lead it elsewhere, and a folder behind a link is refused', async () => {
  const { base, sub, outside, done } = setup();
  const told = [];
  const watch = watchFolder(base, 'sub', (change) => told.push(change), { debounceMs: 20 });
  // The agent swaps the folder for a link to one outside.
  renameSync(sub, `${sub}.aside`);
  symlinkSync(outside, sub);
  await until(() => told.some((change) => change.gone), 'the swap is told as the folder being gone');
  writeFileSync(path.join(outside, 'new.txt'), 'x');
  await sleep(150);
  assert.deepEqual(told.filter((change) => !change.gone), [], 'what happens where the link leads is not told');
  watch.close();
  assert.equal(await codeOf(() => watchFolder(base, 'sub', () => {})), 'invalid', 'a link is refused');
  done();
});

test('a watch that was swapped for a link before it was set is refused, and one that cannot be set is failed, with the system\'s code', async () => {
  const { base, sub, outside, done } = setup();
  mkdirSync(path.join(sub, 'inner'));
  const real = fs.openSync;
  let swapped = false;
  fs.openSync = (...args) => {
    if (!swapped) { swapped = true; renameSync(sub, `${sub}.aside`); symlinkSync(outside, sub); }
    return real(...args);
  };
  syncBuiltinESMExports();
  try {
    assert.equal(await codeOf(() => watchFolder(base, 'sub/inner', () => {})), 'invalid');
  } finally {
    fs.openSync = real;
    syncBuiltinESMExports();
  }
  assert.ok(swapped);
  done();
  const second = setup();
  const watchReal = fs.watch;
  fs.watch = () => { throw Object.assign(new Error('no more watches'), { code: 'ENOSPC' }); };
  syncBuiltinESMExports();
  try {
    let got;
    try { watchFolder(second.base, 'sub', () => {}); } catch (e) { got = e; }
    assert.ok(got instanceof FileError);
    assert.deepEqual([got.code, got.errno], ['failed', 'ENOSPC']);
  } finally {
    fs.watch = watchReal;
    syncBuiltinESMExports();
  }
  second.done();
});

test('a handler that throws does not take the portal down, and the watch goes on', async () => {
  const { base, sub, done } = setup();
  let calls = 0;
  const original = console.error;
  console.error = () => {};
  const watch = watchFolder(base, 'sub', () => { calls++; throw new Error('its own failure'); }, { debounceMs: 20 });
  try {
    writeFileSync(path.join(sub, 'a.txt'), 'x');
    await until(() => calls === 1, 'called');
    writeFileSync(path.join(sub, 'b.txt'), 'x');
    await until(() => calls === 2, 'and again');
  } finally {
    console.error = original;
    watch.close();
  }
  done();
});
