import assert from 'node:assert/strict';
import fs, { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { scratch } from './server-harness.mjs';
const { FileError, baseDir, listDir, removeEntry, renameEntry, folderPath, holdForReading, readBytes, readText, writeText, openFile, sweepTemp, removeFile, renameFile, folderIdentity } = await import('../dist/workspace-files.js');

/**
 * What is removed, renamed, listed or read whole in a chat's folder, with a folder on the way to it swapped for a link
 * to a folder outside the chat's while the portal works, and a folder in the middle of what is removed swapped as it is
 * walked. With the sandbox on the portal is root and the folder is the agent's, so a call that follows the link acts
 * outside: these run as a plain user, and as root on the test machine, where the owners are the sandbox's own.
 * `fs` is hooked at a fixed point, as in workspace-files.test.mjs.
 */

const root = process.getuid?.() === 0;
/** The user the sandbox runs the agent as, for a test that is run as root. */
const AGENT = 10100;
const codeOf = async (fn) => { try { await fn(); } catch (e) { return e instanceof FileError ? e.code : `other:${e.message}`; } return 'none'; };
const names = (folder) => readdirSync(folder).sort();

/** The chat's folder with `sub` in it (and `sub/doc.md`), and beside it `outside`, which has a `doc.md` of its own and is closed to everyone else. */
function swappable() {
  const top = scratch('wswalk-');
  const dir = path.join(top, 'work');
  const outside = path.join(top, 'outside');
  mkdirSync(dir); mkdirSync(outside);
  writeFileSync(path.join(outside, 'secret'), 'top secret');
  const sub = path.join(dir, 'sub');
  mkdirSync(sub);
  writeFileSync(path.join(sub, 'doc.md'), 'ours');
  writeFileSync(path.join(outside, 'doc.md'), 'theirs');
  chmodSync(outside, 0o700);
  if (root) for (const where of [dir, sub, path.join(sub, 'doc.md')]) chownSync(where, AGENT, AGENT);
  /** What the agent does: the folder goes aside, a link to the folder outside stands in its place. */
  const swap = (folder = sub) => {
    renameSync(folder, `${folder}.aside`);
    symlinkSync(outside, folder);
  };
  return { top, dir, base: baseDir(dir), outside, sub, aside: `${sub}.aside`, swap, done: () => rmSync(top, { recursive: true, force: true }) };
}

/**
 * Runs `fn` with `swap` done right before the first call of one of `point.names` (in `fs`, or in `fs/promises` with
 * `point.promises`) for which `point.when` holds, or right after it with `point.after`. Says whether it was done.
 */
async function swappedAt(point, swap, fn) {
  const module = point.promises ? fsp : fs;
  const real = {};
  let swapped = false;
  for (const name of point.names) {
    real[name] = module[name];
    module[name] = point.promises
      ? async (...args) => {
        if (swapped || !point.when(name, args)) return real[name](...args);
        swapped = true;
        if (!point.after) swap();
        const result = await real[name](...args);
        if (point.after) swap();
        return result;
      }
      : (...args) => {
        if (!swapped && point.when(name, args)) { swapped = true; swap(); }
        return real[name](...args);
      };
  }
  syncBuiltinESMExports();
  try { await fn(); } finally {
    for (const name of point.names) module[name] = real[name];
    syncBuiltinESMExports();
  }
  return swapped;
}

/** Before the folder is walked (the first thing opened), and the first thing the work itself does once it is held. */
const FIRST = { names: ['openSync', 'mkdirSync', 'readdirSync', 'renameSync'], when: () => true };
const WORK = { promises: true, names: ['lstat', 'rm', 'open', 'readdir', 'unlink', 'rmdir'], when: () => true };
/** The first look the work takes at a name of the folder it holds (a path through its descriptor), and the call that takes a name away or gives it another. */
const HELD = (names) => ({ names, when: (_name, [where]) => String(where).startsWith('/proc/self/fd/') });

test('a folder swapped for a link before a removal walks to it is refused, and nothing outside is removed', async () => {
  const { base, outside, aside, swap, done } = swappable();
  let got;
  assert.ok(await swappedAt(FIRST, swap, async () => { got = await codeOf(() => removeEntry(base, 'sub/doc.md', true)); }));
  assert.equal(got, 'invalid');
  assert.deepEqual(names(outside), ['doc.md', 'secret']);
  assert.equal(readFileSync(path.join(outside, 'doc.md'), 'utf8'), 'theirs');
  assert.equal(readFileSync(path.join(aside, 'doc.md'), 'utf8'), 'ours', 'and what was to be removed is left');
  done();
});

test('a file is removed in the folder that was checked, however the path is changed after: the link gets nothing', async () => {
  const { base, outside, aside, swap, done } = swappable();
  let got;
  assert.ok(await swappedAt(HELD(['lstatSync']), swap, async () => { got = await codeOf(() => removeEntry(base, 'sub/doc.md', true)); }));
  assert.equal(got, 'none');
  assert.deepEqual(names(outside), ['doc.md', 'secret'], 'nothing was removed outside');
  assert.equal(readFileSync(path.join(outside, 'doc.md'), 'utf8'), 'theirs');
  assert.deepEqual(names(aside), [], 'it went from the folder it was in');
  done();
});

test('a folder is removed with all in it where it was checked, and the link that took its parent\'s place is not followed', async () => {
  const { dir, base, outside, aside, sub, swap, done } = swappable();
  mkdirSync(path.join(sub, 'tree', 'deeper'), { recursive: true });
  writeFileSync(path.join(sub, 'tree', 'deeper', 'doc.md'), 'ours too');
  mkdirSync(path.join(outside, 'tree', 'deeper'), { recursive: true });
  writeFileSync(path.join(outside, 'tree', 'deeper', 'doc.md'), 'theirs too');
  let got;
  assert.ok(await swappedAt(WORK, swap, async () => { got = await codeOf(() => removeEntry(base, 'sub/tree', true)); }));
  assert.equal(got, 'none');
  assert.equal(readFileSync(path.join(outside, 'tree', 'deeper', 'doc.md'), 'utf8'), 'theirs too', 'what the link leads to is whole');
  assert.ok(!existsSync(path.join(aside, 'tree')), 'and the tree is gone from where it was');
  assert.ok(existsSync(path.join(dir, 'sub')));
  done();
});

test('a folder in the tree that is swapped for a link as the walk reaches it is not followed: what it leads to is left whole', async () => {
  // Before the folder is opened, and right after: the first leaves a link where a folder was, the second a link
  // beside the folder that was opened, which the walk goes on in.
  for (const after of [false, true]) {
    const { base, sub, outside, swap, done } = swappable();
    mkdirSync(path.join(sub, 'tree', 'inner'), { recursive: true });
    for (const folder of [path.join(sub, 'tree', 'inner'), outside]) {
      writeFileSync(path.join(folder, 'a.txt'), folder === outside ? 'theirs a' : 'ours a');
      writeFileSync(path.join(folder, 'b.txt'), folder === outside ? 'theirs b' : 'ours b');
    }
    const before = names(outside);
    const point = { promises: true, names: ['open'], after, when: (_name, [where]) => String(where).endsWith('/inner') };
    let got;
    assert.ok(await swappedAt(point, () => swap(path.join(sub, 'tree', 'inner')), async () => { got = await codeOf(() => removeEntry(base, 'sub/tree', true)); }), `after: ${after}`);
    assert.equal(got, 'failed', `after: ${after}: it says the tree changed under it`);
    assert.deepEqual(names(outside), before, `after: ${after}: nothing outside was removed`);
    assert.equal(readFileSync(path.join(outside, 'a.txt'), 'utf8'), 'theirs a');
    assert.equal(readFileSync(path.join(outside, 'b.txt'), 'utf8'), 'theirs b');
    done();
  }
});

test('a folder in the tree swapped for a file as the walk reaches it makes the removal stop, and nothing outside changes', async () => {
  const { base, sub, outside, done } = swappable();
  mkdirSync(path.join(sub, 'tree', 'inner'), { recursive: true });
  writeFileSync(path.join(sub, 'tree', 'inner', 'a.txt'), 'ours a');
  const point = { promises: true, names: ['open'], when: (_name, [where]) => String(where).endsWith('/inner') };
  let got;
  assert.ok(await swappedAt(point, () => { rmSync(path.join(sub, 'tree', 'inner'), { recursive: true }); writeFileSync(path.join(sub, 'tree', 'inner'), 'now a file'); }, async () => { got = await codeOf(() => removeEntry(base, 'sub/tree', true)); }));
  assert.equal(got, 'failed');
  assert.deepEqual(names(outside), ['doc.md', 'secret']);
  done();
});

/** What the agent does to the entry itself, not to a folder on the way to it: it goes aside, a link to the same name outside stands in its place. */
function swapEntry(entry, leadsTo) {
  return () => {
    renameSync(entry, `${entry}.aside`);
    symlinkSync(leadsTo, entry);
  };
}

test('the last name of what is removed swapped for a link as the removal reaches it: the link is what goes, and what it leads to is left whole', async () => {
  // A folder, swapped before it is looked at (the link goes) and right after (it is not opened through the link); and a file, before it is unlinked.
  for (const [name, point, outcome] of [
    ['tree', { promises: true, names: ['lstat'], when: (_name, [where]) => String(where).endsWith('/tree') }, 'none'],
    ['tree', { promises: true, names: ['lstat'], after: true, when: (_name, [where]) => String(where).endsWith('/tree') }, 'failed'],
    ['doc.md', { names: ['unlinkSync'], when: (_name, [where]) => String(where).endsWith('/doc.md') }, 'none'],
  ]) {
    const { base, sub, outside, done } = swappable();
    mkdirSync(path.join(sub, 'tree', 'deeper'), { recursive: true });
    writeFileSync(path.join(sub, 'tree', 'deeper', 'doc.md'), 'ours too');
    mkdirSync(path.join(outside, 'tree', 'deeper'), { recursive: true });
    writeFileSync(path.join(outside, 'tree', 'deeper', 'doc.md'), 'theirs too');
    const before = names(outside);
    let got;
    assert.ok(await swappedAt(point, swapEntry(path.join(sub, name), path.join(outside, name)), async () => { got = await codeOf(() => removeEntry(base, `sub/${name}`, true)); }), name);
    assert.equal(got, outcome, `${name}: ${outcome}`);
    assert.deepEqual(names(outside), before, `${name}: nothing outside was removed`);
    assert.equal(readFileSync(path.join(outside, 'doc.md'), 'utf8'), 'theirs');
    assert.equal(readFileSync(path.join(outside, 'tree', 'deeper', 'doc.md'), 'utf8'), 'theirs too', `${name}: nor what the link leads to`);
    assert.ok(existsSync(path.join(sub, `${name}.aside`)), `${name}: what was there goes on, aside, whole`);
    assert.equal(existsSync(path.join(sub, name)), outcome === 'failed', `${name}: the link is gone, or left where the removal stopped`);
    done();
  }
});

test('the last name of what is renamed swapped for a link as the rename is made: nothing outside is renamed, and a file is not taken for the link that stands there now', async () => {
  for (const [name, call] of [['doc.md', 'linkSync'], ['tree', 'renameSync']]) {
    const { base, sub, outside, done } = swappable();
    mkdirSync(path.join(sub, 'tree'));
    mkdirSync(path.join(outside, 'tree'));
    const before = names(outside);
    let got;
    assert.ok(await swappedAt({ names: [call], when: () => true }, swapEntry(path.join(sub, name), path.join(outside, name)), async () => { got = await codeOf(() => renameEntry(base, `sub/${name}`, 'renamed')); }), name);
    assert.deepEqual(names(outside), before, `${name}: nothing outside was renamed`);
    assert.ok(existsSync(path.join(sub, `${name}.aside`)), `${name}: what was there goes on, aside, whole`);
    if (name === 'doc.md') {
      // A file that was looked at is not the link that took its name: the rename stops, and the new name is not kept.
      assert.equal(got, 'conflict');
      assert.ok(!existsSync(path.join(sub, 'renamed')) && lstatSync(path.join(sub, name)).isSymbolicLink());
    } else {
      // A folder is renamed by the name: the link that took its place is what is renamed.
      assert.equal(got, 'none');
      assert.ok(lstatSync(path.join(sub, 'renamed')).isSymbolicLink(), `${name}: the link carries the new name`);
    }
    done();
  }
});

test('a rename never puts a file over one that took the new name since it was looked at', async () => {
  const { base, sub, aside, done } = swappable();
  let got;
  // The agent makes a file of the new name right before the call that gives it.
  const made = () => writeFileSync(path.join(sub, 'taken.md'), 'the agent\'s own');
  assert.ok(await swappedAt({ names: ['linkSync', 'renameSync'], when: () => true }, made, async () => { got = await codeOf(() => renameEntry(base, 'sub/doc.md', 'taken.md')); }));
  assert.equal(got, 'exists');
  assert.equal(readFileSync(path.join(sub, 'taken.md'), 'utf8'), 'the agent\'s own', 'what took the name is whole');
  assert.equal(readFileSync(path.join(sub, 'doc.md'), 'utf8'), 'ours', 'and the file keeps its name');
  assert.ok(!existsSync(aside));
  done();
});

test('a file is renamed under the name it is given with its owner, mode and content, and a link as the link', async () => {
  const { base, sub, outside, done } = swappable();
  const before = lstatSync(path.join(sub, 'doc.md'));
  assert.equal(renameEntry(base, 'sub/doc.md', 'new.md'), path.join('sub', 'new.md'));
  const after = lstatSync(path.join(sub, 'new.md'));
  assert.deepEqual([after.ino, after.uid, after.gid, after.mode, readFileSync(path.join(sub, 'new.md'), 'utf8')], [before.ino, before.uid, before.gid, before.mode, 'ours']);
  assert.deepEqual(names(sub), ['new.md']);
  symlinkSync(outside, path.join(sub, 'out'));
  renameEntry(base, 'sub/out', 'away');
  assert.ok(lstatSync(path.join(sub, 'away')).isSymbolicLink());
  assert.deepEqual(names(outside), ['doc.md', 'secret']);
  done();
});

test('a tree of many files and folders is removed whole, a link in it as the link, and a folder that is too deep is not, with the reason', async () => {
  const { base, sub, done } = swappable();
  mkdirSync(path.join(sub, 'wide', 'a', 'b'), { recursive: true });
  for (let i = 0; i < 1500; i++) writeFileSync(path.join(sub, 'wide', 'a', ...(i % 2 ? ['b'] : []), `f${i}.txt`), 'x');
  symlinkSync('/etc', path.join(sub, 'wide', 'a', 'link-out'));
  symlinkSync('nowhere', path.join(sub, 'wide', 'dangling'));
  assert.equal(await codeOf(() => removeEntry(base, 'sub/wide', true)), 'none');
  assert.ok(!existsSync(path.join(sub, 'wide')));
  assert.ok(existsSync('/etc'), 'a link was removed as the link it is');
  // 600 levels, made from inside: the path would be longer than the system takes in one piece.
  mkdirSync(path.join(sub, 'deep'));
  const here = process.cwd();
  try {
    process.chdir(path.join(sub, 'deep'));
    for (let i = 0; i < 600; i++) { mkdirSync('d'); process.chdir('d'); }
  } finally {
    process.chdir(here);
  }
  assert.equal(await codeOf(() => removeEntry(base, 'sub/deep', true)), 'failed');
  assert.ok(existsSync(path.join(sub, 'deep')), 'it is not half taken away');
  done();
});

test('a rename is made in the folder that was checked: a link put in its place before gets it refused, one put there after gets nothing', async () => {
  for (const [point, outcome] of [[FIRST, 'invalid'], [{ names: ['linkSync'], when: () => true }, 'none']]) {
    const { base, outside, aside, swap, done } = swappable();
    let got;
    assert.ok(await swappedAt(point, swap, async () => { got = await codeOf(() => renameEntry(base, 'sub/doc.md', 'renamed.md')); }));
    assert.equal(got, outcome);
    assert.deepEqual(names(outside), ['doc.md', 'secret'], 'nothing outside was renamed');
    assert.deepEqual(names(aside), outcome === 'none' ? ['renamed.md'] : ['doc.md']);
    done();
  }
});

test('a folder is listed as the folder that was checked: a link put in its place before gets it refused, one put there after lists what was there', async () => {
  for (const [point, outcome] of [[FIRST, 'invalid'], [{ names: ['readdirSync'], when: () => true }, 'none']]) {
    const { base, aside, swap, done } = swappable();
    let got;
    let listed;
    assert.ok(await swappedAt(point, swap, async () => { got = await codeOf(() => { listed = listDir(base, 'sub'); }); }));
    assert.equal(got, outcome);
    if (outcome === 'none') assert.deepEqual(listed.entries.map((entry) => entry.name), ['doc.md'], 'never what the link leads to');
    assert.ok(existsSync(aside));
    done();
  }
});

test('a link in a folder that is listed is shown by where it leads, as the held folder has it: inside is followed, outside is a link', async () => {
  const { base, sub, outside, done } = swappable();
  mkdirSync(path.join(sub, 'real'));
  symlinkSync('real', path.join(sub, 'inside'));
  symlinkSync('../../outside', path.join(sub, 'out'));
  symlinkSync(path.join(outside, 'secret'), path.join(sub, 'absolute-out'));
  const entries = Object.fromEntries(listDir(base, 'sub').entries.map((entry) => [entry.name, [entry.type, entry.link === true]]));
  assert.deepEqual(entries, { 'absolute-out': ['link', true], 'doc.md': ['file', false], inside: ['dir', true], out: ['link', true], real: ['dir', false] });
  done();
});

test('a folder is told apart by its device and inode as it is held: a move keeps them, another folder has others, and a link put in its place is refused', async () => {
  const { dir, base, sub, aside, swap, done } = swappable();
  const mine = folderIdentity(base, 'sub');
  const stat = statSync(sub, { bigint: true });
  assert.deepEqual(mine, { dev: String(stat.dev), ino: String(stat.ino) });
  assert.notDeepEqual(folderIdentity(base, ''), mine);
  assert.deepEqual(folderIdentity(base, ''), { dev: String(statSync(dir, { bigint: true }).dev), ino: String(statSync(dir, { bigint: true }).ino) });
  // Moved, it is the same folder; a new one in its place is another.
  renameSync(sub, path.join(dir, 'moved'));
  assert.deepEqual(folderIdentity(base, 'moved'), mine);
  mkdirSync(sub);
  assert.notDeepEqual(folderIdentity(base, 'sub'), mine);
  // Told about the folder that was checked: one swapped for a link right before it is held is refused, not the one it leads to.
  rmSync(sub, { recursive: true });
  renameSync(path.join(dir, 'moved'), sub);
  let got;
  assert.ok(await swappedAt(FIRST, swap, async () => { got = await codeOf(() => folderIdentity(base, 'sub')); }));
  assert.equal(got, 'invalid');
  assert.equal(await codeOf(() => folderIdentity(base, 'nowhere')), 'missing');
  assert.equal(await codeOf(() => folderIdentity(base, 'sub/doc.md')), 'invalid');
  assert.ok(existsSync(aside));
  done();
});

test('the checked path of a folder is a folder that is opened without following a link on the way: one put there after the check is refused', async () => {
  const { base, outside, sub, aside, swap, done } = swappable();
  mkdirSync(path.join(sub, 'inner'));
  let got;
  assert.ok(await swappedAt(FIRST, swap, async () => { got = await codeOf(() => folderPath(base, 'sub/inner')); }));
  assert.equal(got, 'invalid');
  assert.ok(existsSync(path.join(aside, 'inner')) && !existsSync(path.join(outside, 'inner')));
  done();
  const plain = swappable();
  assert.equal(folderPath(plain.base, 'sub'), path.join(plain.base, 'sub'));
  assert.equal(folderPath(plain.base, ''), plain.base);
  assert.equal(await codeOf(() => folderPath(plain.base, 'nope')), 'missing');
  assert.equal(await codeOf(() => folderPath(plain.base, 'sub/doc.md')), 'invalid');
  plain.done();
});

test('the portal as root gives nothing away through a link: what the link leads to keeps its owner and mode', { skip: !root }, async () => {
  const { base, outside, aside, swap, done } = swappable();
  const before = statSync(outside);
  assert.ok(await swappedAt({ names: ['renameSync'], when: () => true }, swap, async () => { await codeOf(() => renameEntry(base, 'sub/doc.md', 'renamed.md')); }));
  const after = lstatSync(outside);
  assert.deepEqual([after.uid, after.gid, after.mode], [before.uid, before.gid, before.mode], 'what the link leads to keeps its owner and mode');
  assert.deepEqual([statSync(path.join(aside, 'renamed.md')).uid, statSync(path.join(aside, 'renamed.md')).gid], [AGENT, AGENT]);
  done();
});

test('a folder held for reading stays the folder that was checked: a link put in its place after is not what this process or a child reads', async () => {
  const { base, outside, sub, aside, swap, done } = swappable();
  const held = holdForReading(base, 'sub');
  try {
    assert.equal(held.name, 'sub');
    swap();
    assert.deepEqual(names(held.path), ['doc.md'], 'here');
    if (held.fd !== undefined) {
      const listed = execFileSync('ls', ['-A', held.inChild(3)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', held.fd] });
      assert.equal(listed.trim(), 'doc.md', 'and in a child that is given the descriptor');
    }
    assert.ok(!names(outside).includes('sub') && existsSync(aside) && lstatSync(sub).isSymbolicLink());
  } finally {
    held.close();
  }
  done();
});

test('a folder is held for reading as it is opened, without following a link in any place on the way', async () => {
  const { base, outside, sub, swap, done } = swappable();
  mkdirSync(path.join(sub, 'inner'));
  let got;
  assert.ok(await swappedAt(FIRST, swap, async () => { got = await codeOf(() => holdForReading(base, 'sub/inner').close()); }));
  assert.equal(got, 'invalid');
  assert.deepEqual(names(outside), ['doc.md', 'secret']);
  const whole = holdForReading(swappable().base, '');
  assert.equal(whole.name, '');
  whole.close();
  assert.equal(await codeOf(() => holdForReading(base, 'nope')), 'missing');
  done();
});

/**
 * The sandbox closes a folder the agent may not enter to root alone, mode 0700 (0750 for its tools' group). The agent writes in its own
 * folder and can rename that folder to the name of one the portal reads as root on its behalf (`documents`): the portal then hands the
 * agent what it could not read itself. `likeParent` turns such a folder, and a file in one the agent can write that it could not read, away.
 */
function closable() {
  const made = swappable();
  const { dir, sub, outside } = made;
  // `documents` is the agent's; `closed` is the sandbox's, with a document in it, beside it in the agent's folder.
  mkdirSync(path.join(dir, 'documents'));
  writeFileSync(path.join(dir, 'documents', 'plan.md'), '# ours');
  mkdirSync(path.join(dir, 'closed'));
  writeFileSync(path.join(dir, 'closed', 'secret.md'), '# the sandbox kept this from the agent');
  if (root) {
    for (const where of [path.join(dir, 'documents'), path.join(dir, 'documents', 'plan.md')]) chownSync(where, AGENT, AGENT);
    chownSync(path.join(dir, 'closed'), 0, 0);
    chmodSync(path.join(dir, 'closed'), 0o700);
  }
  return { ...made, documents: path.join(dir, 'documents'), closed: path.join(dir, 'closed'), outside, sub };
}

test('a folder the sandbox closed to the agent is not used under another name: its files are not read, listed or written', { skip: !root }, async () => {
  const { base, dir, closed, documents, done } = closable();
  const asDocuments = { direct: true, alone: true, likeParent: true };
  // The agent\'s own folder is used as ever.
  assert.equal(folderPath(base, 'documents', { direct: true, likeParent: true }), documents);
  assert.equal(readBytes(documents, 'plan.md', asDocuments).bytes.toString(), '# ours');
  assert.deepEqual(listDir(documents, '', { likeParent: true }).entries.map((entry) => entry.name), ['plan.md']);
  // Renamed to the name of that one, the closed folder is refused wherever it is asked for: by name, and on the folder itself.
  renameSync(documents, `${documents}.aside`);
  renameSync(closed, documents);
  assert.equal(await codeOf(() => folderPath(base, 'documents', { direct: true, likeParent: true })), 'invalid');
  assert.equal(await codeOf(() => readBytes(documents, 'secret.md', asDocuments)), 'invalid');
  assert.equal(await codeOf(() => readText(documents, 'secret.md', { likeParent: true })), 'invalid');
  assert.equal(await codeOf(() => openFile(documents, 'secret.md', asDocuments)), 'invalid');
  assert.equal(await codeOf(() => listDir(documents, '', { likeParent: true })), 'invalid');
  assert.equal(await codeOf(() => writeText(documents, 'new.md', 'x', undefined, true, { direct: true, likeParent: true })), 'invalid');
  assert.deepEqual(sweepTemp(documents, '', 0, { likeParent: true }), [], 'and nothing is swept in it');
  assert.ok(!existsSync(path.join(documents, 'new.md')));
  // Nor is anything taken away in it or given another name: what the sandbox kept from the agent stays as it was.
  for (const [what, call] of [
    ['removeFile', async () => removeFile(documents, 'secret.md', asDocuments)],
    ['renameFile', async () => renameFile(documents, 'secret.md', 'other.md', asDocuments)],
    ['removeEntry', () => removeEntry(documents, 'secret.md', true, { direct: true, likeParent: true })],
    ['renameEntry', async () => renameEntry(documents, 'secret.md', 'other.md', { direct: true, likeParent: true })],
  ]) assert.equal(await codeOf(call), 'invalid', what);
  assert.deepEqual(names(documents), ['secret.md']);
  assert.equal(await codeOf(() => folderIdentity(base, 'documents', { direct: true, likeParent: true })), 'invalid');
  assert.deepEqual(folderIdentity(base, 'documents', { direct: true }), folderIdentity(base, 'documents'), 'without the option nothing is asked of its owner');
  // Without the option nothing is asked of its owner: the portal\'s other uses of a folder are as ever.
  assert.equal(readBytes(documents, 'secret.md', { direct: true }).bytes.toString(), '# the sandbox kept this from the agent');
  assert.equal(statSync(dir).uid, AGENT);
  done();
});

test('a folder is checked as it is held: one swapped for the closed one right after it was looked at is refused when it is read', { skip: !root }, async () => {
  const { base, closed, documents, done } = closable();
  const asDocuments = { direct: true, alone: true, likeParent: true };
  const folder = folderPath(base, 'documents', { direct: true, likeParent: true });
  // The agent swaps them in the moment between the portal looking at the folder and reading from it.
  renameSync(documents, `${documents}.aside`);
  renameSync(closed, documents);
  assert.equal(await codeOf(() => readBytes(folder, 'secret.md', asDocuments)), 'invalid');
  done();
  // And a file the agent could not read, put into a folder of its own that it could: refused, the folder is used as ever for the rest.
  const second = closable();
  renameSync(path.join(second.closed, 'secret.md'), path.join(second.documents, 'moved.md'));
  assert.equal(await codeOf(() => readBytes(second.documents, 'moved.md', asDocuments)), 'invalid', 'a file owned by root alone in the agent\'s folder');
  assert.equal(readBytes(second.documents, 'plan.md', asDocuments).bytes.toString(), '# ours', 'the others are read');
  assert.equal(await codeOf(() => writeText(second.documents, 'moved.md', 'x', undefined, false, { direct: true, likeParent: true })), 'invalid', 'nor is it replaced');
  second.done();
});

test('what is open to the agent is used as ever: its own, its group\'s, and everyone\'s', { skip: !root }, async () => {
  const { base, dir, documents, done } = closable();
  const asDocuments = { direct: true, alone: true, likeParent: true };
  // Root\'s, but readable by everyone: the agent could read it itself, so nothing is given it that it did not have.
  chownSync(documents, 0, 0);
  chmodSync(documents, 0o755);
  chownSync(path.join(documents, 'plan.md'), 0, 0);
  chmodSync(path.join(documents, 'plan.md'), 0o644);
  assert.equal(readBytes(documents, 'plan.md', asDocuments).bytes.toString(), '# ours');
  // Root\'s and closed to others, but the agents\' group (the folder\'s group) may read it.
  chmodSync(documents, 0o750);
  chownSync(documents, 0, AGENT);
  chownSync(path.join(documents, 'plan.md'), 0, AGENT);
  chmodSync(path.join(documents, 'plan.md'), 0o640);
  assert.equal(readBytes(documents, 'plan.md', asDocuments).bytes.toString(), '# ours');
  // The same without the group\'s right to it: closed.
  chmodSync(documents, 0o700);
  assert.equal(await codeOf(() => readBytes(documents, 'plan.md', asDocuments)), 'invalid');
  assert.equal(statSync(dir).gid, AGENT);
  done();
});

test('the portal\'s own user sees nothing closed that it made or owns: what is its own is used', async () => {
  // As a plain user (and as root without a user of the agent\'s): every folder here is owned by the same user, so nothing is refused.
  const { base, documents, done } = closable();
  const asDocuments = { direct: true, alone: true, likeParent: true };
  chmodSync(documents, 0o700);
  if (!root) {
    assert.equal(folderPath(base, 'documents', { direct: true, likeParent: true }), documents);
    assert.equal(readBytes(documents, 'plan.md', asDocuments).bytes.toString(), '# ours');
    assert.deepEqual(listDir(documents, '', { likeParent: true }).entries.map((entry) => entry.name), ['plan.md']);
    assert.equal(writeText(documents, 'next.md', 'x', undefined, true, { direct: true, likeParent: true }).size, 1);
  }
  done();
});
