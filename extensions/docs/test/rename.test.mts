import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { type BigIntStats, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import docsServer from '../server.js';
import { folderFiles } from '../../../core/server/src/folder-files.ts';
import { scratch } from '../../../tests/helpers.mts';
import { CASEFOLD, inCasefold } from '../../../tests/casefold.mts';

/**
 * A document renamed and deleted by the person (extensions/docs/store.js, server.js): the same document under another file name, with its
 * comments, its history and its id; and gone, with its file, its comments and its name. Against a real store on disk, with git and SQLite, and
 * a real router in a real server. The races on the disk are in core/server/test/workspace-files.test.mjs.
 */

const DATA = scratch('docs-rename-data-');

interface Frame { id?: string; event?: string; data?: any; comment?: string }

type Options = {
  /** What `portal.files` is: the portal's own, or the portal's own with some call changed, for a test that cuts a rename off between its halves. */
  files?: typeof folderFiles;
  /** `faults.after`: runs after each step of a write, and throws to cut it off. */
  onStep?: (step: string) => void;
  data?: string;
};

/** The server half for chats that work in these folders. `fault` breaks the next write after that step. */
async function portal(folders: Record<string, string>, options: Options = {}) {
  const router = express.Router();
  const logged: string[] = [];
  let armed: string | null = null;
  const stop = docsServer({
    extension: 'pithagoras-docs',
    log: (line: string) => logged.push(line),
    router,
    http: { json: express.json },
    files: options.files ?? folderFiles,
    sandbox: { on: () => false },
    dataDir: () => options.data ?? DATA,
    chats: {
      list: () => Object.keys(folders).map((id) => ({ id, title: `Chat ${id}` })),
      folder: (id: string) => realpathSync(folders[id]),
      inFolder: (folder: string) => Object.keys(folders).filter((id) => ((() => { try { return realpathSync(folders[id]) === folder; } catch { return false; } })())).map((id) => ({ id, title: `Chat ${id}` })),
    },
  }, {
    dependencies: async () => true,
    pollMs: 40,
    faults: {
      after(step: string) {
        options.onStep?.(step);
        if (step !== armed) return;
        armed = null;
        throw new Error(`injected failure after the ${step}`);
      },
    },
  }) as () => Promise<void>;
  const app = express();
  app.use('/x', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
  const aborts: AbortController[] = [];
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) as any }; } catch { throw new Error(`${method} ${url} ${res.status}: ${text.slice(0, 300)}`); }
  };
  /** A page's stream, frame by frame. */
  async function listen(url: string) {
    const abort = new AbortController();
    aborts.push(abort);
    const res = await fetch(base + url, { headers: { accept: 'text/event-stream' }, signal: abort.signal });
    if (!res.headers.get('content-type')?.startsWith('text/event-stream')) return { status: res.status, frame: async () => null as Frame | null, next: async (_: string) => null as Frame | null };
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const frame = async (): Promise<Frame | null> => {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const text = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const out: Frame = {};
          for (const line of text.split('\n')) {
            if (line.startsWith(':')) out.comment = line.slice(1).trim();
            else if (line.startsWith('data: ')) out.data = JSON.parse(line.slice(6));
            else if (line.startsWith('id: ')) out.id = line.slice(4);
            else if (line.startsWith('event: ')) out.event = line.slice(7);
          }
          return out;
        }
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
    };
    /** The next frame of a kind, skipping the others. */
    const next = async (event: string) => {
      for (;;) {
        const got = await frame();
        if (!got || got.event === event) return got;
      }
    };
    return { status: res.status, frame, next };
  }
  return {
    call,
    listen,
    logged,
    fault: (step: string) => void (armed = step),
    close: async () => {
      for (const abort of aborts) abort.abort();
      await stop();
      server.close();
    },
  };
}

/** A chat's folder with these files in it. */
function folderWith(prefix: string, files: Record<string, string> = {}) {
  const folder = realpathSync(scratch(prefix));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    writeFileSync(path.join(folder, name), text);
  }
  return folder;
}

/** The id the page knows a folder by. */
const folderIdOf = (folder: string) => createHash('sha256').update(folder).digest('hex').slice(0, 16);
const storeOf = (folder: string, data = DATA) => path.join(data, folderIdOf(folder));

/** git, on the store's own repository. */
const git = (folder: string, ...args: string[]) =>
  execFileSync('git', [`--git-dir=${path.join(storeOf(folder), 'git')}`, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
const tree = (folder: string, rev = 'HEAD') => git(folder, 'ls-tree', '--name-only', rev).split('\n').filter(Boolean);
const trailers = (folder: string, rev = 'HEAD') => git(folder, 'show', '-s', '--format=%(trailers:only,unfold)', rev);
const commits = (folder: string) => Number(git(folder, 'rev-list', '--count', 'HEAD'));

/**
 * What ext4 does with a file made just after another was removed, made certain: a look at the names in `files` (the store's, not followed)
 * finds the device and inode of the file `was` had, and everything else of the file that is there now. Undone by what it returns.
 */
function reusedInode(files: string[], was: BigIntStats) {
  const real = fs.lstatSync;
  fs.lstatSync = ((at: fs.PathLike, options?: any) => {
    const stat = real(at, options);
    if (!stat || !files.includes(path.resolve(String(at)))) return stat;
    const as = (n: bigint) => (options?.bigint ? n : Number(n));
    return Object.create(stat, { dev: { value: as(was.dev) }, ino: { value: as(was.ino) } });
  }) as typeof fs.lstatSync;
  syncBuiltinESMExports();
  return () => {
    fs.lstatSync = real;
    syncBuiltinESMExports();
  };
}

/**
 * What lstat gives where Node cannot use statx (an old kernel, a sandbox that refuses it): the time of the file's last change as the time it was
 * made, for every look (the store's own as well). Undone by what it returns.
 */
function changeAsBirth() {
  const real = fs.lstatSync;
  fs.lstatSync = ((at: fs.PathLike, options?: any) => {
    const stat = real(at, options);
    if (!stat) return stat;
    return Object.create(stat, { birthtimeNs: { value: (stat as BigIntStats).ctimeNs }, birthtimeMs: { value: stat.ctimeMs }, birthtime: { value: stat.ctime } });
  }) as typeof fs.lstatSync;
  syncBuiltinESMExports();
  return () => {
    fs.lstatSync = real;
    syncBuiltinESMExports();
  };
}

/** A folder with a document called `Plan` made through the store, saved once more, and a comment on it. */
async function withDocument(prefix: string, options: Options = {}) {
  const folder = folderWith(prefix, { 'documents/.keep': '' });
  const docs = await portal({ a: folder }, options);
  const f = folderIdOf(folder);
  const made = await docs.call('POST', `/folders/${f}/documents`, { title: 'Plan', markdown: '# Plan\n\nOne.\n' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const url = `/folders/${f}/documents/${made.body.id}`;
  const saved = await docs.call('PUT', url, { markdown: '# Plan\n\nOne.\n\nTwo.\n', base: 1 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const thread = await docs.call('POST', `${url}/threads`, { base: 2, quote: 'Two.', prefix: 'One.\n\n', suffix: '\n', start: 15, body: 'Is this right?' });
  assert.equal(thread.status, 201, JSON.stringify(thread.body));
  return { folder, docs, f, id: made.body.id as string, url, thread: thread.body, dir: path.join(folder, 'documents') };
}

const TEXT_2 = '# Plan\n\nOne.\n\nTwo.\n';

test('a rename gives the file another name and keeps the document: its id, its comments, its history and its text', async () => {
  const { folder, docs, f, id, url, thread, dir } = await withDocument('docs-rename-keeps-');
  try {
    const inode = statSync(path.join(dir, 'plan.md')).ino;
    const answer = await docs.call('POST', `${url}/rename`, { name: 'Roadmap 2027.md' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual({ id: answer.body.id, name: answer.body.name, revision: answer.body.revision, changed: answer.body.changed }, { id, name: 'Roadmap 2027.md', revision: 3, changed: true });
    // The file: the same one, under the new name, and nothing under the old.
    assert.deepEqual(readdirSync(dir).filter((n) => !n.startsWith('.')).sort(), ['Roadmap 2027.md']);
    assert.equal(statSync(path.join(dir, 'Roadmap 2027.md')).ino, inode);
    assert.equal(readFileSync(path.join(dir, 'Roadmap 2027.md'), 'utf8'), TEXT_2);

    // The same document by its id, with the same text.
    const read = await docs.call('GET', url);
    assert.deepEqual([read.body.name, read.body.markdown, read.body.revision, read.body.title], ['Roadmap 2027.md', TEXT_2, 3, 'Plan']);
    // The comments are where they were.
    const threads = await docs.call('GET', `${url}/threads`);
    assert.equal(threads.body.threads.length, 1);
    assert.equal(threads.body.threads[0].id, thread.id);
    assert.deepEqual([threads.body.threads[0].quote, threads.body.threads[0].orphaned, threads.body.threads[0].comments.map((c: any) => c.body)], ['Two.', false, ['Is this right?']]);
    // The history has it as a revision of its own at the top, and every earlier revision can be read and restored.
    const history = await docs.call('GET', `${url}/history`);
    assert.deepEqual(history.body.revisions.map((r: any) => [r.revision, r.kind, r.author, r.renamedFrom]), [[3, 'rename', 'user', 'plan.md'], [2, 'save', 'user', undefined], [1, 'create', 'user', undefined]]);
    assert.equal((await docs.call('GET', `${url}/revisions/1`)).body.markdown, '# Plan\n\nOne.\n');
    assert.equal((await docs.call('GET', `${url}/revisions/2`)).body.markdown, TEXT_2);
    assert.equal((await docs.call('GET', `${url}/revisions/3`)).body.markdown, TEXT_2);
    const restored = await docs.call('POST', `${url}/restore`, { revision: 1, base: 3 });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.deepEqual([restored.body.name, restored.body.revision], ['Roadmap 2027.md', 4]);
    assert.equal(readFileSync(path.join(dir, 'Roadmap 2027.md'), 'utf8'), '# Plan\n\nOne.\n');
    // The page's lists have it by the new name, once.
    const listed = (await docs.call('GET', '/folders')).body.folders[0].documents;
    assert.deepEqual(listed.map((d: any) => [d.id, d.name]), [[id, 'Roadmap 2027.md']]);
    assert.deepEqual((await docs.call('GET', `/chats/a/documents`)).body.documents.map((d: any) => d.name), ['Roadmap 2027.md']);
    // Looking at the folder takes nothing in as a change from outside: the rename is the one revision, nothing is `recovered`.
    assert.deepEqual((await docs.call('GET', `${url}/history`)).body.revisions.map((r: any) => r.kind), ['restore', 'rename', 'save', 'create']);
    assert.equal(f, folderIdOf(folder));
  } finally {
    await docs.close();
  }
});

test('a rename is one commit that moves the file in the history, and says what it was called', async () => {
  const { folder, docs, url } = await withDocument('docs-rename-commit-');
  try {
    const before = commits(folder);
    await docs.call('POST', `${url}/rename`, { name: 'roadmap.md' });
    assert.equal(commits(folder), before + 1);
    assert.deepEqual(tree(folder), ['roadmap.md'], 'the old name is out of the tree, the new one is in');
    assert.match(trailers(folder), /Doc-Name: roadmap\.md/);
    assert.match(trailers(folder), /Renamed-From: plan\.md/);
    assert.match(trailers(folder), /Revision: 3/);
    assert.match(trailers(folder), /Author: user/);
    // The earlier commits still hold the text under the name it had then.
    assert.equal(git(folder, 'show', 'HEAD~1:plan.md'), TEXT_2.trim());
    assert.equal(git(folder, 'show', 'HEAD:roadmap.md'), TEXT_2.trim());
  } finally {
    await docs.close();
  }
});

test('a rename and a rename back, and the same name, change what they say they do', async () => {
  const { docs, url, dir } = await withDocument('docs-rename-twice-');
  try {
    const same = await docs.call('POST', `${url}/rename`, { name: 'plan.md' });
    assert.deepEqual([same.status, same.body.changed, same.body.revision], [200, false, 2]);
    assert.equal((await docs.call('POST', `${url}/rename`, { name: 'b.md' })).body.revision, 3);
    // Written as a person would: padded, and with a name that is not the slug's.
    const padded = await docs.call('POST', `${url}/rename`, { name: '  Q3 plan.MD ' });
    assert.deepEqual([padded.status, padded.body.name, padded.body.revision], [200, 'Q3 plan.MD', 4]);
    const back = await docs.call('POST', `${url}/rename`, { name: 'plan.md' });
    assert.deepEqual([back.status, back.body.name, back.body.revision], [200, 'plan.md', 5]);
    assert.deepEqual(readdirSync(dir).filter((n) => !n.startsWith('.')), ['plan.md']);
    assert.deepEqual((await docs.call('GET', `${url}/history`)).body.revisions.map((r: any) => [r.revision, r.renamedFrom]), [[5, 'Q3 plan.MD'], [4, 'b.md'], [3, 'plan.md'], [2, undefined], [1, undefined]]);
    assert.equal((await docs.call('GET', `${url}/revisions/1`)).body.markdown, '# Plan\n\nOne.\n');
  } finally {
    await docs.close();
  }
});

test('a name that is taken is refused, by another document or by whatever else is in the folder, and nothing changes', async () => {
  const { folder, docs, f, id, url, dir } = await withDocument('docs-rename-taken-');
  try {
    const other = await docs.call('POST', `/folders/${f}/documents`, { title: 'Other', markdown: '# Other\n' });
    const taken = await docs.call('POST', `${url}/rename`, { name: 'other.md' });
    assert.deepEqual([taken.status, taken.body.exists], [409, other.body.id]);
    assert.match(taken.body.error, /other\.md exists already/);
    // A folder, a link and a file with a second name in the way: refused, and each is as it was.
    mkdirSync(path.join(dir, 'folder.md'));
    writeFileSync(path.join(dir, 'folder.md', 'inner'), 'kept');
    symlinkSync(path.join(folder, 'documents', 'other.md'), path.join(dir, 'link.md'));
    for (const name of ['folder.md', 'link.md']) {
      const refused = await docs.call('POST', `${url}/rename`, { name });
      assert.deepEqual([refused.status, refused.body.exists], [409, null], name);
      assert.match(refused.body.error, /in the way/);
    }
    assert.equal(readFileSync(path.join(dir, 'folder.md', 'inner'), 'utf8'), 'kept');
    assert.ok(lstatSync(path.join(dir, 'link.md')).isSymbolicLink());
    assert.equal(readFileSync(path.join(dir, 'other.md'), 'utf8'), '# Other\n');
    // The document is as it was: its name, its revision, its file, its history.
    const read = await docs.call('GET', url);
    assert.deepEqual([read.body.id, read.body.name, read.body.revision], [id, 'plan.md', 2]);
    assert.equal(readFileSync(path.join(dir, 'plan.md'), 'utf8'), TEXT_2);
    assert.equal((await docs.call('GET', `${url}/history`)).body.revisions.length, 2);
    // Nothing is left half done, which the next request would finish: the other document's first commit is the only one more.
    assert.equal(commits(folder), 3);
  } finally {
    await docs.close();
  }
});

test('a name that is not a document\'s is refused with a reason, and a document that is not there is a 404', async () => {
  const { docs, f, id, url, dir } = await withDocument('docs-rename-invalid-');
  try {
    const names: unknown[] = ['', '   ', '.md', 'plan', 'plan.txt', '.hidden.md', 'a/b.md', '../out.md', 'a\\b.md', 'a\0b.md', 'line\nbreak.md', 'tab\there.md', 'x'.repeat(300) + '.md', 'é'.repeat(130) + '.md', null, 5, { name: 'a.md' }, ['a.md'], undefined];
    for (const name of names) {
      const refused = await docs.call('POST', `${url}/rename`, name === undefined ? {} : { name });
      assert.equal(refused.status, 400, JSON.stringify(name));
      assert.ok(typeof refused.body.error === 'string' && refused.body.error.length > 0);
    }
    assert.deepEqual(readdirSync(dir).filter((n) => !n.startsWith('.')), ['plan.md']);
    assert.equal((await docs.call('GET', url)).body.revision, 2);
    assert.equal((await docs.call('POST', `/folders/${f}/documents/0123456789abcdef/rename`, { name: 'x.md' })).status, 404);
    assert.equal((await docs.call('POST', `/folders/${f}/documents/not-an-id/rename`, { name: 'x.md' })).status, 404);
    assert.equal((await docs.call('POST', `/folders/0123456789abcdef/documents/${id}/rename`, { name: 'x.md' })).status, 404);
  } finally {
    await docs.close();
  }
});

test('a document whose file is gone, or is not a plain file now, is not renamed', async () => {
  const { docs, url, dir } = await withDocument('docs-rename-gone-');
  try {
    const file = path.join(dir, 'plan.md');
    const text = readFileSync(file, 'utf8');
    // A link where the file was: it is no document's file, and what it leads to is not renamed.
    renameSync(file, path.join(dir, 'real.md.hidden'));
    symlinkSync(path.join(dir, 'real.md.hidden'), file);
    const linked = await docs.call('POST', `${url}/rename`, { name: 'x.md' });
    assert.ok([404, 409].includes(linked.status), JSON.stringify(linked));
    assert.equal(readFileSync(path.join(dir, 'real.md.hidden'), 'utf8'), text);
    assert.ok(lstatSync(file).isSymbolicLink());
    unlinkSync(file);
    const gone = await docs.call('POST', `${url}/rename`, { name: 'x.md' });
    assert.equal(gone.status, 404);
    assert.equal(existsSync(path.join(dir, 'x.md')), false);
  } finally {
    await docs.close();
  }
});

test('a page that has the document open is told of a rename as of any revision, and the document by its id has its new name', async () => {
  const { docs, url } = await withDocument('docs-rename-told-');
  try {
    const stream = await docs.listen(`${url}/events`);
    assert.equal((await stream.next('revision'))!.data.revision, 2);
    const answer = await docs.call('POST', `${url}/rename`, { name: 'moved.md' });
    assert.equal(answer.status, 200);
    const told = await stream.next('revision');
    assert.deepEqual([told!.data.revision, told!.data.author, told!.id], [3, 'user', '3']);
    assert.equal((await docs.call('GET', url)).body.name, 'moved.md');
    // The list that is kept current says so too: its version is not the one it was.
    const list = await docs.listen('/folders/events');
    const first = (await list.next('documents'))!.data.version;
    await docs.call('POST', `${url}/rename`, { name: 'moved-again.md' });
    assert.notEqual((await list.next('documents'))!.data.version, first);
  } finally {
    await docs.close();
  }
});

test('a rename that was cut off after the file was renamed is finished by the next look: the document is the same one, not a new one', async () => {
  const { folder, docs, f, id, url, thread, dir } = await withDocument('docs-rename-cut-file-');
  docs.fault('rename');
  const cut = await docs.call('POST', `${url}/rename`, { name: 'after.md' });
  assert.equal(cut.status, 500);
  await docs.close();
  // The file has the new name, and nothing has said so yet.
  assert.deepEqual(readdirSync(dir).filter((n) => !n.startsWith('.')), ['after.md']);
  assert.equal(commits(folder), 2);
  const again = await portal({ a: folder });
  try {
    const listed = (await again.call('GET', '/folders')).body.folders[0].documents;
    assert.deepEqual(listed.map((d: any) => [d.id, d.name, d.revision]), [[id, 'after.md', 3]], 'one document, by the new name');
    const history = await again.call('GET', `${url}/history`);
    assert.deepEqual(history.body.revisions.map((r: any) => [r.revision, r.kind, r.renamedFrom]), [[3, 'rename', 'plan.md'], [2, 'save', undefined], [1, 'create', undefined]]);
    assert.equal((await again.call('GET', `${url}/threads`)).body.threads[0].id, thread.id);
    assert.deepEqual(tree(folder), ['after.md']);
    assert.equal(commits(folder), 3);
    // And it stays done.
    assert.equal((await again.call('GET', url)).body.name, 'after.md');
    assert.equal(commits(folder), 3);
    assert.equal(f, folderIdOf(folder));
  } finally {
    await again.close();
  }
});

test('a rename that was cut off between the two halves of the file\'s rename is finished: the old name is taken away', async () => {
  let cutting = true;
  // The portal's own `files`, but a rename that makes the second name and stops: the file has both names, as after a crash between them.
  const stopping = { ...folderFiles, renameFile: (base: string, rel: string, name: string, options?: any) => {
    if (!cutting) return folderFiles.renameFile(base, rel, name, options);
    linkSync(path.join(base, rel), path.join(base, name));
    throw new Error('stopped between the link and the unlink');
  } } as typeof folderFiles;
  const { folder, docs, id, url, thread, dir } = await withDocument('docs-rename-cut-link-', { files: stopping });
  const cut = await docs.call('POST', `${url}/rename`, { name: 'after.md' });
  assert.equal(cut.status, 500);
  await docs.close();
  cutting = false;
  assert.deepEqual(readdirSync(dir).filter((n) => !n.startsWith('.')).sort(), ['after.md', 'plan.md'], 'one file, two names');
  assert.equal(statSync(path.join(dir, 'plan.md')).nlink, 2);
  const again = await portal({ a: folder });
  try {
    const listed = (await again.call('GET', '/folders')).body.folders[0].documents;
    assert.deepEqual(listed.map((d: any) => [d.id, d.name, d.revision]), [[id, 'after.md', 3]]);
    assert.deepEqual(readdirSync(dir).filter((n) => !n.startsWith('.')), ['after.md']);
    assert.equal(statSync(path.join(dir, 'after.md')).nlink, 1);
    assert.equal(readFileSync(path.join(dir, 'after.md'), 'utf8'), TEXT_2);
    assert.equal((await again.call('GET', `${url}/threads`)).body.threads[0].id, thread.id);
    assert.deepEqual(tree(folder), ['after.md']);
  } finally {
    await again.close();
  }
});

test('a rename that was cut off between its halves is finished where a look gives the time of the last change as the time the file was made', async () => {
  let cutting = true;
  // The second name changes that time: the clock has moved on by then (a tick is 10 ms at most), as it has after any real stop.
  const stopping = { ...folderFiles, renameFile: (base: string, rel: string, name: string, options?: any) => {
    if (!cutting) return folderFiles.renameFile(base, rel, name, options);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    linkSync(path.join(base, rel), path.join(base, name));
    throw new Error('stopped between the link and the unlink');
  } } as typeof folderFiles;
  const undo = changeAsBirth();
  try {
    const { folder, docs, id, url, dir } = await withDocument('docs-rename-cut-ctime-', { files: stopping });
    assert.equal((await docs.call('POST', `${url}/rename`, { name: 'after.md' })).status, 500);
    await docs.close();
    cutting = false;
    assert.equal(statSync(path.join(dir, 'plan.md')).nlink, 2);
    const again = await portal({ a: folder });
    try {
      const listed = (await again.call('GET', '/folders')).body.folders[0].documents;
      assert.deepEqual(listed.map((d: any) => [d.id, d.name]), [[id, 'after.md']]);
      assert.deepEqual(readdirSync(dir).filter((n) => !n.startsWith('.')), ['after.md'], 'the old name is taken away');
      assert.equal(statSync(path.join(dir, 'after.md')).nlink, 1);
    } finally {
      await again.close();
    }
  } finally {
    undo();
  }
});

test('a rename whose commit was made but not told to the database is told by the next look', async () => {
  const { folder, docs, id, url } = await withDocument('docs-rename-cut-commit-');
  docs.fault('commit');
  assert.equal((await docs.call('POST', `${url}/rename`, { name: 'after.md' })).status, 500);
  await docs.close();
  assert.equal(commits(folder), 3, 'the commit was made');
  const again = await portal({ a: folder });
  try {
    const read = await again.call('GET', url);
    assert.deepEqual([read.body.id, read.body.name, read.body.revision, read.body.markdown], [id, 'after.md', 3, TEXT_2]);
    assert.deepEqual((await again.call('GET', `${url}/history`)).body.revisions.map((r: any) => r.kind), ['rename', 'save', 'create']);
    assert.equal(commits(folder), 3, 'and nothing was made again');
    assert.equal((await again.call('GET', '/folders')).body.folders[0].documents.length, 1);
  } finally {
    await again.close();
  }
});

test('a rename that was decided and whose file was never touched is dropped: nothing is renamed', async () => {
  // A stop before the file was renamed (the files' call failed): the decision is not kept, and the document is as it was.
  const failing = { ...folderFiles, renameFile: () => { throw Object.assign(new Error('The file could not be renamed (EACCES)'), { code: 'failed', errno: 'EACCES' }); } } as typeof folderFiles;
  const { folder, docs, id, url, dir } = await withDocument('docs-rename-refused-', { files: failing });
  const refused = await docs.call('POST', `${url}/rename`, { name: 'after.md' });
  assert.equal(refused.status, 403, 'the system\'s refusal is said, as for a save');
  await docs.close();
  const again = await portal({ a: folder });
  try {
    const read = await again.call('GET', url);
    assert.deepEqual([read.body.id, read.body.name, read.body.revision], [id, 'plan.md', 2]);
    assert.deepEqual(readdirSync(dir).filter((n) => !n.startsWith('.')), ['plan.md']);
    assert.equal(commits(folder), 2);
  } finally {
    await again.close();
  }
});

test('a rebuilt index finds the renamed document by its new name, with its history, and does not take the old name for another document', async () => {
  const { folder, docs, id, url, dir } = await withDocument('docs-rename-rebuild-');
  await docs.call('POST', `${url}/rename`, { name: 'after.md' });
  await docs.close();
  // The database is lost: it is made again from the history.
  for (const file of readdirSync(storeOf(folder))) if (file.startsWith('docs.sqlite')) rmSync(path.join(storeOf(folder), file));
  const again = await portal({ a: folder });
  try {
    const listed = (await again.call('GET', '/folders')).body.folders[0].documents;
    assert.deepEqual(listed.map((d: any) => [d.id, d.name, d.revision]), [[id, 'after.md', 3]]);
    assert.deepEqual((await again.call('GET', `${url}/history`)).body.revisions.map((r: any) => [r.revision, r.kind, r.renamedFrom]), [[3, 'rename', 'plan.md'], [2, 'save', undefined], [1, 'create', undefined]]);
    assert.equal((await again.call('GET', `${url}/revisions/1`)).body.markdown, '# Plan\n\nOne.\n');
    // A document made under the old name afterwards is another one.
    const f = folderIdOf(folder);
    const second = await again.call('POST', `/folders/${f}/documents`, { title: 'Plan', markdown: '# Plan\n\nAgain.\n' });
    assert.deepEqual([second.status, second.body.name], [201, 'plan.md']);
    assert.notEqual(second.body.id, id);
    assert.deepEqual(readdirSync(dir).filter((n) => !n.startsWith('.')).sort(), ['after.md', 'plan.md']);
  } finally {
    await again.close();
  }
  // And once more from nothing: both are there, each with its own history.
  for (const file of readdirSync(storeOf(folder))) if (file.startsWith('docs.sqlite')) rmSync(path.join(storeOf(folder), file));
  const third = await portal({ a: folder });
  try {
    const listed = (await third.call('GET', '/folders')).body.folders[0].documents;
    assert.deepEqual(listed.map((d: any) => [d.name, d.revision]).sort(), [['after.md', 3], ['plan.md', 1]]);
  } finally {
    await third.close();
  }
});

test('a deleted document is gone: its file, its comments and its history on the page, and its name is free', async () => {
  const { folder, docs, f, id, url, dir } = await withDocument('docs-delete-gone-');
  try {
    const answer = await docs.call('DELETE', url);
    assert.deepEqual([answer.status, answer.body], [200, { deleted: true }]);
    assert.deepEqual(readdirSync(dir).filter((n) => !n.startsWith('.')), []);
    for (const tail of ['', '/threads', '/history', '/revisions/1', '/download']) assert.equal((await docs.call('GET', url + tail)).status, 404, tail);
    assert.equal((await docs.call('PUT', url, { markdown: 'x', base: 2 })).status, 404);
    assert.equal((await docs.call('POST', `${url}/restore`, { revision: 1 })).status, 404);
    assert.equal((await docs.call('DELETE', url)).status, 404, 'once');
    assert.deepEqual((await docs.call('GET', '/folders')).body.folders ?? [], []);
    assert.deepEqual((await docs.call('GET', '/chats/a/documents')).body.documents, []);
    // Nothing of it is left in the database: its revisions, its comments and their threads went with it.
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(path.join(storeOf(folder), 'docs.sqlite'), { readonly: true });
    try {
      for (const table of ['documents', 'revisions', 'threads', 'comments', 'pings']) assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
    } finally {
      db.close();
    }
    // The history says so, so that the index made again from it does not bring the document back; the commits it had stay.
    assert.deepEqual(tree(folder), []);
    assert.match(trailers(folder), /Doc-Id: [0-9a-f]{16}/);
    assert.match(trailers(folder), /Deleted: yes/);
    assert.equal(git(folder, 'show', 'HEAD~1:plan.md'), TEXT_2.trim(), 'the text is still in the store\'s repository');
    // A new document of the same name is a new one: none of the old one's comments, revision 1.
    const again = await docs.call('POST', `/folders/${f}/documents`, { title: 'Plan', markdown: '# Plan\n\nNew.\n' });
    assert.deepEqual([again.status, again.body.name, again.body.revision], [201, 'plan.md', 1]);
    assert.notEqual(again.body.id, id);
    assert.deepEqual((await docs.call('GET', `/folders/${f}/documents/${again.body.id}/threads`)).body.threads, []);
  } finally {
    await docs.close();
  }
});

test('a deleted document that was never saved again, and one whose file is already gone, are deleted too', async () => {
  const folder = folderWith('docs-delete-plain-', { 'documents/.keep': '' });
  const docs = await portal({ a: folder });
  try {
    const f = folderIdOf(folder);
    const made = await docs.call('POST', `/folders/${f}/documents`, { title: 'Once', markdown: '# Once\n' });
    assert.equal((await docs.call('DELETE', `/folders/${f}/documents/${made.body.id}`)).status, 200);
    assert.deepEqual(readdirSync(path.join(folder, 'documents')).filter((n) => !n.startsWith('.')), []);
    // Its file taken away by someone else: the document is a name without a file, and deleting it is only forgetting it.
    const two = await docs.call('POST', `/folders/${f}/documents`, { title: 'Twice', markdown: '# Twice\n' });
    unlinkSync(path.join(folder, 'documents', 'twice.md'));
    assert.equal((await docs.call('DELETE', `/folders/${f}/documents/${two.body.id}`)).status, 200);
    assert.equal((await docs.call('GET', `/folders/${f}/documents/${two.body.id}`)).status, 404);
    const third = await docs.call('POST', `/folders/${f}/documents`, { title: 'Twice', markdown: '# Twice\n' });
    assert.deepEqual([third.status, third.body.name], [201, 'twice.md'], 'its name is free');
  } finally {
    await docs.close();
  }
});

test('a name that is something else now is not deleted: a folder, a link and a file with a second name stay as they are', async () => {
  const { folder, docs, f, url, dir } = await withDocument('docs-delete-refused-');
  try {
    const file = path.join(dir, 'plan.md');
    // A file with a second name is no document's file (not read, not deleted).
    linkSync(file, path.join(dir, 'twin.md'));
    const shared = await docs.call('DELETE', url);
    assert.equal(shared.status, 409, JSON.stringify(shared.body));
    assert.equal(readFileSync(file, 'utf8'), TEXT_2);
    unlinkSync(path.join(dir, 'twin.md'));
    // A folder, a link.
    renameSync(file, path.join(dir, 'aside.txt'));
    mkdirSync(file);
    writeFileSync(path.join(file, 'inner'), 'precious');
    assert.equal((await docs.call('DELETE', url)).status, 409);
    assert.equal(readFileSync(path.join(file, 'inner'), 'utf8'), 'precious');
    rmSync(file, { recursive: true });
    symlinkSync(path.join(dir, 'aside.txt'), file);
    assert.equal((await docs.call('DELETE', url)).status, 409);
    assert.ok(lstatSync(file).isSymbolicLink());
    assert.equal(readFileSync(path.join(dir, 'aside.txt'), 'utf8'), TEXT_2, 'what the link leads to is left');
    // Refused, so it is not half done: no commit, nothing for the next look to finish.
    assert.equal(commits(folder), 2);
    unlinkSync(file);
    renameSync(path.join(dir, 'aside.txt'), file);
    assert.equal((await docs.call('GET', url)).body.revision, 2);
    assert.equal((await docs.call('DELETE', url)).status, 200);
    assert.equal(f, folderIdOf(folder));
  } finally {
    await docs.close();
  }
});

test('a page that has the document open is told that it was deleted, once, and a request for it is a 404 after', async () => {
  const { docs, f, id, url } = await withDocument('docs-delete-told-');
  try {
    const stream = await docs.listen(`${url}/events`);
    assert.equal((await stream.next('revision'))!.data.revision, 2);
    const list = await docs.listen('/folders/events');
    const first = (await list.next('documents'))!.data.version;
    assert.equal((await docs.call('DELETE', url)).status, 200);
    const told = await stream.next('deleted');
    assert.equal(typeof told!.data.at, 'string');
    // No revision of a document that is not there: the page does not ask for its text and find nothing.
    const after = await docs.call('POST', `/folders/${f}/documents`, { title: 'Next', markdown: '# Next\n' });
    assert.equal(after.status, 201);
    assert.notEqual((await list.next('documents'))!.data.version, first);
    assert.equal((await docs.listen(`${url}/events`)).status, 404);
    assert.notEqual(after.body.id, id);
  } finally {
    await docs.close();
  }
});

test('a deletion that was cut off after the file was removed is finished by the next look', async () => {
  const { folder, docs, f, id, url, dir } = await withDocument('docs-delete-cut-file-');
  docs.fault('delete');
  assert.equal((await docs.call('DELETE', url)).status, 500);
  await docs.close();
  assert.deepEqual(readdirSync(dir).filter((n) => !n.startsWith('.')), []);
  assert.equal(commits(folder), 2);
  const again = await portal({ a: folder });
  try {
    assert.deepEqual((await again.call('GET', '/folders')).body.folders ?? [], [], 'not a document of a name without a file: it is gone');
    assert.equal((await again.call('GET', url)).status, 404);
    assert.match(trailers(folder), /Deleted: yes/);
    assert.equal(commits(folder), 3);
    const made = await again.call('POST', `/folders/${f}/documents`, { title: 'Plan', markdown: '# Plan\n' });
    assert.deepEqual([made.status, made.body.name], [201, 'plan.md']);
    assert.notEqual(made.body.id, id);
  } finally {
    await again.close();
  }
});

test('a deletion whose commit was made but not told to the database is told by the next look', async () => {
  const { folder, docs, url } = await withDocument('docs-delete-cut-commit-');
  docs.fault('commit');
  assert.equal((await docs.call('DELETE', url)).status, 500);
  await docs.close();
  assert.equal(commits(folder), 3);
  const again = await portal({ a: folder });
  try {
    assert.equal((await again.call('GET', url)).status, 404);
    assert.deepEqual((await again.call('GET', '/folders')).body.folders ?? [], []);
    assert.equal(commits(folder), 3);
  } finally {
    await again.close();
  }
});

test('a deleted document stays deleted when the index is made again from the history, and one of its name made after it is kept', async () => {
  const { folder, docs, f, id, url } = await withDocument('docs-delete-rebuild-');
  await docs.call('DELETE', url);
  const made = await docs.call('POST', `/folders/${f}/documents`, { title: 'Plan', markdown: '# Plan\n\nNew.\n' });
  assert.equal(made.body.name, 'plan.md');
  await docs.close();
  for (const file of readdirSync(storeOf(folder))) if (file.startsWith('docs.sqlite')) rmSync(path.join(storeOf(folder), file));
  const again = await portal({ a: folder });
  try {
    const listed = (await again.call('GET', '/folders')).body.folders[0].documents;
    assert.deepEqual(listed.map((d: any) => [d.id, d.name, d.revision]), [[made.body.id, 'plan.md', 1]]);
    assert.equal((await again.call('GET', url)).status, 404);
    assert.notEqual(made.body.id, id);
  } finally {
    await again.close();
  }
});

test('a deletion deals with a document whose comments were waiting for the agent: nothing is asked after it, and nothing is logged as a failure', async () => {
  const { docs, url, thread } = await withDocument('docs-delete-ping-');
  try {
    const reply = await docs.call('POST', `${url}/threads/${thread.id}/comments`, { body: '@agent please answer', chat: 'a' });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal((await docs.call('DELETE', url)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(docs.logged.filter((line) => /could not be asked/.test(line)), []);
  } finally {
    await docs.close();
  }
});

test('a documents folder swapped for a link as a document is deleted or renamed: nothing outside it is removed or renamed, and the document stays', async () => {
  for (const act of ['delete', 'rename'] as const) {
    let swap: (() => void) | null = null;
    // The portal's own `files`, but the agent's move is made in the time between the store's look at the folder and the call that works on it.
    const racing = {
      ...folderFiles,
      removeFile: (...args: Parameters<typeof folderFiles.removeFile>) => { swap?.(); swap = null; return folderFiles.removeFile(...args); },
      renameFile: (...args: Parameters<typeof folderFiles.renameFile>) => { swap?.(); swap = null; return folderFiles.renameFile(...args); },
    } as typeof folderFiles;
    const { folder, docs, id, url, dir } = await withDocument(`docs-${act}-race-`, { files: racing });
    try {
      const outside = folderWith(`docs-${act}-outside-`, { 'plan.md': 'theirs', 'new.md': 'theirs too' });
      swap = () => { renameSync(dir, `${dir}.aside`); symlinkSync(outside, dir); };
      const answer = act === 'delete' ? await docs.call('DELETE', url) : await docs.call('POST', `${url}/rename`, { name: 'new.md' });
      assert.equal(answer.status, 409, `${act}: ${JSON.stringify(answer.body)}`);
      assert.equal(swap, null, 'the swap was made');
      assert.deepEqual(readdirSync(outside).sort(), ['new.md', 'plan.md'], `${act}: nothing outside was removed or made`);
      assert.deepEqual([readFileSync(path.join(outside, 'plan.md'), 'utf8'), readFileSync(path.join(outside, 'new.md'), 'utf8')], ['theirs', 'theirs too']);
      assert.equal(readFileSync(path.join(`${dir}.aside`, 'plan.md'), 'utf8'), TEXT_2, `${act}: and the folder that went aside was not touched`);
      // The document is as it was, and nothing is left half done.
      assert.deepEqual(readdirSync(`${dir}.aside`).filter((n) => !n.startsWith('.')), ['plan.md']);
      assert.equal(commits(folder), 2);
      assert.equal(id.length, 16);
    } finally {
      await docs.close();
    }
  }
});

test('a documents folder that is a link keeps the document from being deleted: it is not forgotten with its file left behind the link', async () => {
  const { folder, docs, id, url, dir } = await withDocument('docs-delete-link-');
  try {
    const outside = folderWith('docs-delete-link-outside-', { 'plan.md': 'theirs' });
    renameSync(dir, `${dir}.aside`);
    symlinkSync(outside, dir);
    const answer = await docs.call('DELETE', url);
    assert.equal(answer.status, 409);
    assert.match(answer.body.error, /documents in this folder is a link/);
    assert.equal(readFileSync(path.join(outside, 'plan.md'), 'utf8'), 'theirs');
    unlinkSync(dir);
    renameSync(`${dir}.aside`, dir);
    // Back where it was, the document is there with its comments.
    const read = await docs.call('GET', url);
    assert.deepEqual([read.body.id, read.body.name], [id, 'plan.md']);
    assert.equal((await docs.call('GET', `${url}/threads`)).body.threads.length, 1);
    assert.equal(commits(folder), 2);
  } finally {
    await docs.close();
  }
});

test('a rename that fails again when it is finished is dropped, so that a disk that cannot be written does not keep the store from being used', async () => {
  // Not an error the system says by a code: what is left of the rename is looked at on the next use, and tried once.
  const breaking = { ...folderFiles, renameFile: () => { throw new Error('something unknown went wrong'); } } as typeof folderFiles;
  const { folder, docs, id, url, dir } = await withDocument('docs-rename-dropped-', { files: breaking });
  assert.equal((await docs.call('POST', `${url}/rename`, { name: 'after.md' })).status, 500);
  await docs.close();
  const again = await portal({ a: folder }, { files: breaking });
  try {
    // Used again at once, with the rename given up.
    const read = await again.call('GET', url);
    assert.deepEqual([read.status, read.body.id, read.body.name, read.body.revision], [200, id, 'plan.md', 2]);
    assert.deepEqual(readdirSync(dir).filter((n) => !n.startsWith('.')), ['plan.md']);
  } finally {
    await again.close();
  }
  const third = await portal({ a: folder });
  try {
    assert.equal((await third.call('GET', url)).body.name, 'plan.md');
    assert.equal(commits(folder), 2);
  } finally {
    await third.close();
  }
});

test('the agent has no tool to rename or delete a document', async () => {
  const source = readFileSync(new URL('../tools.js', import.meta.url), 'utf8');
  const names = [...source.matchAll(/name:\s*"(doc_[a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(names.length > 0);
  assert.deepEqual(names.filter((n) => /rename|delete_doc|remove|move/.test(n)), []);
});

// What a rename and a deletion do not do, whatever the folder or the file has become: the file of another folder, the second name of another file, the only name of a file.

test('a second name that someone made for the file is in the way of a rename, not a half of it: the old name is not taken away', async () => {
  let hook: (() => void) | null = null;
  // Made in the time between the store's look at the file and its look at the names, as the agent could.
  const racing = { ...folderFiles, readBytes: (...args: Parameters<typeof folderFiles.readBytes>) => { const read = folderFiles.readBytes(...args); const fire = args[2]?.head === undefined ? hook : null; if (fire) { hook = null; fire(); } return read; } } as typeof folderFiles;
  const { folder, docs, id, url, dir } = await withDocument('docs-rename-twin-', { files: racing });
  try {
    hook = () => linkSync(path.join(dir, 'plan.md'), path.join(dir, 'twin.md'));
    const refused = await docs.call('POST', `${url}/rename`, { name: 'twin.md' });
    assert.equal(hook, null, 'the second name was made');
    assert.deepEqual([refused.status, refused.body.exists], [409, null], JSON.stringify(refused.body));
    assert.match(refused.body.error, /in the way/);
    assert.deepEqual(readdirSync(dir).filter((n) => !n.startsWith('.')).sort(), ['plan.md', 'twin.md'], 'both names are there: the one that was the file\'s own is not taken away');
    assert.equal(statSync(path.join(dir, 'plan.md')).ino, statSync(path.join(dir, 'twin.md')).ino);
    assert.equal(commits(folder), 2, 'and nothing was committed');
    assert.equal(id.length, 16);
  } finally {
    await docs.close();
  }
});

test('a rename that was cut off between its halves is finished only for the file it was decided for: a file with the two names that is another one is left as it is', async () => {
  let cutting = true;
  const stopping = { ...folderFiles, renameFile: (base: string, rel: string, name: string, options?: any) => {
    if (!cutting) return folderFiles.renameFile(base, rel, name, options);
    linkSync(path.join(base, rel), path.join(base, name));
    throw new Error('stopped between the link and the unlink');
  } } as typeof folderFiles;
  const { folder, docs, url, dir } = await withDocument('docs-rename-other-file-', { files: stopping });
  const was = lstatSync(path.join(dir, 'plan.md'), { bigint: true });
  assert.equal((await docs.call('POST', `${url}/rename`, { name: 'after.md' })).status, 500);
  await docs.close();
  cutting = false;
  // The agent has made another file of it by the time of the next look: it has the two names as well, and the inode the other had.
  unlinkSync(path.join(dir, 'plan.md'));
  unlinkSync(path.join(dir, 'after.md'));
  writeFileSync(path.join(dir, 'plan.md'), 'The agent\'s own file.\n');
  linkSync(path.join(dir, 'plan.md'), path.join(dir, 'after.md'));
  const undo = reusedInode([path.join(dir, 'plan.md'), path.join(dir, 'after.md')], was);
  const again = await portal({ a: folder });
  try {
    await again.call('GET', '/folders');
    assert.deepEqual(readdirSync(dir).filter((n) => !n.startsWith('.')).sort(), ['after.md', 'plan.md'], 'neither name of the other file was taken away');
    assert.equal(statSync(path.join(dir, 'plan.md')).nlink, 2);
    assert.equal(commits(folder) >= 2, true);
    // What was decided is dropped: it is not tried again at every look.
    const store = await import('better-sqlite3').then(({ default: Database }) => new Database(path.join(storeOf(folder), 'docs.sqlite'), { readonly: true }));
    try {
      assert.equal(store.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = 'pending'").get().n, 0);
    } finally {
      store.close();
    }
  } finally {
    undo();
    await again.close();
  }
});

test('what someone wrote to the file in the time of a rename is taken in as a revision of its own, and a restore cannot lose it', async () => {
  let edit = false;
  const { docs, id, url, dir } = await withDocument('docs-rename-window-', {
    onStep: (step) => { if (step === 'rename' && edit) { edit = false; writeFileSync(path.join(dir, 'after.md'), `${TEXT_2}The agent\'s line.\n`); } },
  });
  try {
    edit = true;
    const answer = await docs.call('POST', `${url}/rename`, { name: 'after.md' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(edit, false, 'the edit was made in the window');
    // The edit is in the history as what it is, after the rename: the next look takes it in (it is not hidden by the file's key).
    const history = await docs.call('GET', `${url}/history`);
    assert.deepEqual(history.body.revisions.map((r: any) => [r.revision, r.kind, r.author]), [[4, 'recovered', 'external'], [3, 'rename', 'user'], [2, 'save', 'user'], [1, 'create', 'user']]);
    assert.equal((await docs.call('GET', `${url}/revisions/4`)).body.markdown, `${TEXT_2}The agent's line.\n`);
    assert.equal((await docs.call('GET', `${url}/revisions/3`)).body.markdown, TEXT_2);
    assert.equal((await docs.call('GET', url)).body.markdown, `${TEXT_2}The agent's line.\n`);
    // A restore of an earlier revision can be undone, since the text it replaces is a revision.
    const restored = await docs.call('POST', `${url}/restore`, { revision: 1, base: 4 });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal((await docs.call('GET', `${url}/revisions/4`)).body.markdown, `${TEXT_2}The agent's line.\n`);
    assert.equal(id.length, 16);
  } finally {
    await docs.close();
  }
});

/** The folder of a chat with a document, and another folder (`private`) with a file of the same name in it that the document's rights do not reach: stands for a folder the agent may not write in. */
async function withPrivate(prefix: string, options: Options = {}) {
  const made = await withDocument(prefix, options);
  const privateDir = path.join(made.folder, 'private');
  mkdirSync(privateDir);
  writeFileSync(path.join(privateDir, 'plan.md'), 'not the agent\'s\n');
  writeFileSync(path.join(privateDir, 'new.md'), 'also not the agent\'s\n');
  /** What the agent does: the documents folder goes aside, the other folder takes its name. */
  const swap = () => {
    renameSync(made.dir, `${made.dir}.aside`);
    renameSync(privateDir, made.dir);
  };
  const intact = (where: string) => {
    assert.equal(readFileSync(path.join(where, 'plan.md'), 'utf8'), 'not the agent\'s\n');
    assert.equal(readFileSync(path.join(where, 'new.md'), 'utf8'), 'also not the agent\'s\n');
    assert.deepEqual(readdirSync(where).filter((n) => !n.startsWith('.')).sort(), ['new.md', 'plan.md']);
  };
  return { ...made, privateDir, swap, intact, aside: `${made.dir}.aside` };
}

test('a folder moved onto the documents folder\'s place in the time of a deletion or a rename is not acted in: what is in it stays, and the document stays', async () => {
  for (const act of ['delete', 'rename'] as const) {
    let swap: (() => void) | null = null;
    // The agent\'s move, made between the store\'s look at the folder and the call that works in it.
    const racing = {
      ...folderFiles,
      removeFile: (...args: Parameters<typeof folderFiles.removeFile>) => { swap?.(); swap = null; return folderFiles.removeFile(...args); },
      renameFile: (...args: Parameters<typeof folderFiles.renameFile>) => { swap?.(); swap = null; return folderFiles.renameFile(...args); },
    } as typeof folderFiles;
    const made = await withPrivate(`docs-${act}-folder-race-`, { files: racing });
    try {
      swap = made.swap;
      const answer = act === 'delete' ? await made.docs.call('DELETE', made.url) : await made.docs.call('POST', `${made.url}/rename`, { name: 'new.md' });
      assert.equal(swap, null, `${act}: the swap was made`);
      assert.equal(answer.status, 409, `${act}: ${JSON.stringify(answer.body)}`);
      assert.equal(answer.body.code, 'folder_replaced');
      made.intact(made.dir);
      assert.equal(readFileSync(path.join(made.aside, 'plan.md'), 'utf8'), TEXT_2, `${act}: the folder that went aside is as it was`);
      assert.equal(commits(made.folder), 2, `${act}: nothing was decided`);
    } finally {
      await made.docs.close();
    }
  }
});

test('a documents folder that is another folder than the one the documents were kept in is not acted in: a deletion and a rename are refused with the reason, until a person makes a document', async () => {
  const made = await withPrivate('docs-folder-replaced-');
  try {
    made.swap();
    for (const answer of [await made.docs.call('DELETE', made.url), await made.docs.call('POST', `${made.url}/rename`, { name: 'brand-new.md' })]) {
      assert.equal(answer.status, 409, JSON.stringify(answer.body));
      assert.equal(answer.body.code, 'folder_replaced');
      assert.match(answer.body.error, /not the folder these documents were kept in/);
    }
    made.intact(made.dir);
    // A person making a document takes the folder as it is now (the agent's tool does not), and then the folder is the one.
    const made2 = await made.docs.call('POST', `/folders/${made.f}/documents`, { title: 'Fresh', markdown: '# Fresh\n' });
    assert.equal(made2.status, 201, JSON.stringify(made2.body));
    const deleted = await made.docs.call('DELETE', `/folders/${made.f}/documents/${made2.body.id}`);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(existsSync(path.join(made.dir, 'fresh.md')), false);
    made.intact(made.dir);
  } finally {
    await made.docs.close();
  }
});

test('a deletion whose file was removed and whose commit was cut off is finished without removing anything again: a folder moved onto the place, or a file made at the name, stays', async () => {
  for (const scene of ['a folder', 'a file'] as const) {
    const made = await withPrivate(`docs-delete-once-${scene === 'a folder' ? 'folder' : 'file'}-`);
    made.docs.fault('delete');
    assert.equal((await made.docs.call('DELETE', made.url)).status, 500);
    await made.docs.close();
    assert.equal(existsSync(path.join(made.dir, 'plan.md')), false, 'the file was removed');
    if (scene === 'a folder') made.swap();
    else writeFileSync(path.join(made.dir, 'plan.md'), 'made after.\n');
    const again = await portal({ a: made.folder });
    try {
      await again.call('GET', '/folders');
      assert.equal((await again.call('GET', made.url)).status, 404, `${scene}: the document is gone`);
      assert.match(git(made.folder, 'log', '--format=%(trailers:only,unfold)'), /Deleted: yes/);
      if (scene === 'a folder') made.intact(made.dir);
      else assert.equal(readFileSync(path.join(made.dir, 'plan.md'), 'utf8'), 'made after.\n', 'the file made at the name is not removed in its turn');
    } finally {
      await again.close();
    }
  }
});

test('a deletion that is not known to have removed the file does not remove another file that is at the name, whatever it is called by then', async () => {
  const made = await withDocument('docs-delete-unknown-');
  const was = lstatSync(path.join(made.dir, 'plan.md'), { bigint: true });
  made.docs.fault('delete');
  assert.equal((await made.docs.call('DELETE', made.url)).status, 500);
  await made.docs.close();
  // The stop came between the removal and the note that it was made: the decision says the file is still to be removed.
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(path.join(storeOf(made.folder), 'docs.sqlite'));
  try {
    assert.equal(db.prepare("UPDATE meta SET value = json_set(value, '$.done', json('false')) WHERE key = 'pending'").run().changes, 1);
  } finally {
    db.close();
  }
  // And another file has the name by then (not the one that was decided on), with the inode the removed one had.
  writeFileSync(path.join(made.dir, 'plan.md'), 'made after.\n');
  const undo = reusedInode([path.join(made.dir, 'plan.md')], was);
  const again = await portal({ a: made.folder });
  try {
    await again.call('GET', '/folders');
    assert.equal(readFileSync(path.join(made.dir, 'plan.md'), 'utf8'), 'made after.\n');
    assert.equal((await again.call('GET', made.url)).status, 404);
  } finally {
    undo();
    await again.close();
  }
});

// A file system that does not tell two names apart: names that differ in capitals, or in the form of a letter. A tmpfs with `casefold` in a mount
// namespace stands for it (tests/casefold.mts); the tests marked [casefold] are run there, once more, by the one below.

if (CASEFOLD) {
  const casefolded = (prefix: string, files: Record<string, string> = {}) => {
    const folder = realpathSync(mkdtempSync(path.join(CASEFOLD, prefix)));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
      writeFileSync(path.join(folder, name), text);
    }
    return folder;
  };
  const listing = (dir: string) => readdirSync(dir).filter((n) => !n.startsWith('.')).sort();

  test('[casefold] a rename that only changes the capitals of the name is refused, with the reason, and the document and its file stay', async () => {
    const folder = casefolded('docs-case-', { 'documents/.keep': '' });
    const docs = await portal({ a: folder });
    const dir = path.join(folder, 'documents');
    try {
      // The file system is what this stands on: the two names are one file.
      writeFileSync(path.join(dir, 'probe.md'), 'x');
      assert.equal(statSync(path.join(dir, 'PROBE.MD')).ino, statSync(path.join(dir, 'probe.md')).ino);
      rmSync(path.join(dir, 'probe.md'));
      const f = folderIdOf(folder);
      const made = await docs.call('POST', `/folders/${f}/documents`, { title: 'Plan', markdown: '# Plan\n\nOne.\n' });
      const url = `/folders/${f}/documents/${made.body.id}`;
      for (const name of ['Plan.md', 'PLAN.MD']) {
        const refused = await docs.call('POST', `${url}/rename`, { name });
        assert.equal(refused.status, 409, JSON.stringify(refused.body));
        assert.equal(refused.body.code, 'same_name');
        assert.match(refused.body.error, /rename it to another name first/);
        assert.deepEqual(listing(dir), ['plan.md'], `${name}: the file is there`);
        const read = await docs.call('GET', url);
        assert.deepEqual([read.status, read.body.name, read.body.markdown, read.body.revision], [200, 'plan.md', '# Plan\n\nOne.\n', 1], name);
      }
      assert.equal(commits(folder), 1, 'nothing was committed');
      // In two steps it can be done: another name in between.
      assert.equal((await docs.call('POST', `${url}/rename`, { name: 'tmp.md' })).status, 200);
      const done = await docs.call('POST', `${url}/rename`, { name: 'Plan.md' });
      assert.deepEqual([done.status, done.body.name, done.body.revision], [200, 'Plan.md', 3]);
      assert.deepEqual(listing(dir), ['Plan.md']);
      assert.equal(readFileSync(path.join(dir, 'Plan.md'), 'utf8'), '# Plan\n\nOne.\n');
      assert.deepEqual((await docs.call('GET', '/folders')).body.folders[0].documents.map((d: any) => d.name), ['Plan.md']);
    } finally {
      await docs.close();
    }
  });

  test('[casefold] a file that is taken in with capitals in its extension is not deleted by a rename form that was not changed', async () => {
    const folder = casefolded('docs-case-upper-', { 'documents/README.MD': '# Readme\n' });
    const docs = await portal({ a: folder });
    const dir = path.join(folder, 'documents');
    try {
      const f = folderIdOf(folder);
      const listed = (await docs.call('GET', '/folders')).body.folders[0].documents;
      assert.deepEqual(listed.map((d: any) => d.name), ['README.MD']);
      const url = `/folders/${f}/documents/${listed[0].id}`;
      // What the form sent for the name as it was (it adds `.md`): the same file under a name that is not told apart from it.
      const refused = await docs.call('POST', `${url}/rename`, { name: 'README.md' });
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.deepEqual(listing(dir), ['README.MD']);
      assert.equal(readFileSync(path.join(dir, 'README.MD'), 'utf8'), '# Readme\n');
      assert.equal((await docs.call('GET', url)).status, 200);
      assert.equal((await docs.call('DELETE', url)).status, 200, 'and it can be deleted as any');
      assert.deepEqual(listing(dir), []);
    } finally {
      await docs.close();
    }
  });
} else {
  test('a rename that only changes the capitals of the name, or the form of a letter, is refused on a file system that does not tell them apart', (t) => {
    const done = inCasefold(fileURLToPath(import.meta.url), '\\[casefold\\]');
    if (!done) return t.skip('no case-insensitive file system can be made here (user namespaces, Linux 6.13 or later and chattr are needed)');
    assert.ok(done.ok, done.output);
    assert.match(done.output, /\[casefold\] a rename that only changes/);
  });
}
