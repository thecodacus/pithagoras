import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express from 'express';
import docsServer from '../server.js';
import { folderFiles } from '../../../core/server/src/folder-files.ts';
import { scratch } from '../../../tests/helpers.mts';

/**
 * The Documents extension's store, through its server half's routes: a real
 * router in a real server, folders on disk, and git.
 */

type Answer = { status: number; body: any };

/**
 * The portal's data folder for the store, the same for every portal of this file: a store is found by its folder's id,
 * so a portal started again over the same folder finds its store. A test that wants a data folder of its own passes one.
 */
const DATA = scratch('docs-store-data-');

/**
 * The server half for chats that work in these folders. `fault` breaks the next write after that step.
 * `onStep` runs after each step of a write ("write", "commit"), and before a store of an earlier version is moved
 * ("move"): a test does there what someone else could between two git runs, or what makes a move fail.
 * `gitTimeoutMs` is how long one git run may take. `data` is the portal's data folder for the store, `sandbox` whether
 * agents run as users of their own.
 */
async function portal(folders: Record<string, string>, options: { onStep?: (step: string) => void; gitTimeoutMs?: number; data?: string; sandbox?: boolean } = {}) {
  const router = express.Router();
  const logged: string[] = [];
  let armed: string | null = null;
  const stop = docsServer({
    extension: 'pithagoras-docs',
    log: (line: string) => logged.push(line),
    router,
    http: { json: express.json },
    files: folderFiles,
    sandbox: { on: () => options.sandbox ?? false },
    dataDir: () => options.data ?? DATA,
    chats: {
      list: () => Object.keys(folders).map((id) => ({ id, title: `Chat ${id}` })),
      folder: (id: string) => realpathSync(folders[id]),
      inFolder: (folder: string) => Object.keys(folders).filter((id) => ((() => { try { return realpathSync(folders[id]) === folder; } catch { return false; } })())).map((id) => ({ id, title: `Chat ${id}` })),
    },
  }, {
    dependencies: async () => true,
    gitTimeoutMs: options.gitTimeoutMs,
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
  const call = async (method: string, url: string, body?: unknown): Promise<Answer> => {
    const res = await fetch(base + url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const listed = async () => (await call('GET', '/folders')).body.folders;
  return {
    call,
    listed,
    logged,
    fault: (step: string) => void (armed = step),
    close: async () => {
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

/** Where a folder's store is: in the data folder, by the id the page knows the folder by. */
const storeOf = (folder: string, data = DATA) => path.join(data, folderIdOf(folder));

/** git, on the store's own repository. */
const git = (folder: string, ...args: string[]) =>
  execFileSync('git', [`--git-dir=${path.join(storeOf(folder), 'git')}`, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
const head = (folder: string) => git(folder, 'rev-parse', 'HEAD');
const trailers = (folder: string, rev = 'HEAD') => git(folder, 'show', '-s', '--format=%(trailers:only,unfold)', rev);
const commits = (folder: string) => Number(git(folder, 'rev-list', '--count', 'HEAD'));

/** The id the page knows a folder by: a folder with no document yet is not listed, and has one all the same. */
const folderIdOf = (folder: string) => createHash('sha256').update(folder).digest('hex').slice(0, 16);

/** A folder with one document made through the store, and its ids. */
async function withDocument(prefix: string, markdown = '# Plan\n\nOne.\n') {
  const folder = folderWith(prefix, { 'documents/.keep': '' });
  const docs = await portal({ a: folder });
  const id = folderIdOf(folder);
  const made = await docs.call('POST', `/folders/${id}/documents`, { title: 'Plan', markdown });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return { folder, docs, f: id, doc: made.body.id as string, url: `/folders/${id}/documents/${made.body.id}` };
}

test('a document is made, read, saved revision after revision, and each save is one commit with its trailers', async () => {
  const { folder, docs, f, doc, url } = await withDocument('docs-store-basic-');
  try {
    assert.match(doc, /^[0-9a-f]{16}$/);
    const read = await docs.call('GET', url);
    assert.equal(read.status, 200);
    assert.equal(read.body.markdown, '# Plan\n\nOne.\n');
    assert.equal(read.body.revision, 1);
    assert.equal(read.body.name, 'plan.md');
    assert.equal(read.body.title, 'Plan');
    assert.equal(readFileSync(path.join(folder, 'documents', 'plan.md'), 'utf8'), '# Plan\n\nOne.\n');

    const saved = await docs.call('PUT', url, { markdown: '# Plan\n\nTwo.\n', base: 1 });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.revision, 2);
    assert.equal(readFileSync(path.join(folder, 'documents', 'plan.md'), 'utf8'), '# Plan\n\nTwo.\n');
    assert.equal(commits(folder), 2);
    assert.equal(trailers(folder), `Doc-Id: ${doc}\nDoc-Name: plan.md\nRevision: 2\nAuthor: user`);
    // Only the document is in the history, never what else is in the folder.
    assert.equal(git(folder, 'ls-tree', '--name-only', 'HEAD'), 'plan.md');

    // The same text again is no new revision.
    const same = await docs.call('PUT', url, { markdown: '# Plan\n\nTwo.\n', base: 2 });
    assert.equal(same.body.revision, 2);
    assert.equal(same.body.changed, false);
    assert.equal(commits(folder), 2);

    // A second document with the same title gets a name of its own; one titled like a path gets a slug.
    const second = await docs.call('POST', `/folders/${f}/documents`, { title: 'Plan', markdown: 'Other' });
    assert.equal(second.body.name, 'plan-2.md');
    const sneaky = await docs.call('POST', `/folders/${f}/documents`, { title: '../../.ssh/Authorized Keys' });
    assert.equal(sneaky.status, 201);
    assert.equal(sneaky.body.name, 'ssh-authorized-keys.md');
    assert.equal(readFileSync(path.join(folder, 'documents', 'ssh-authorized-keys.md'), 'utf8'), '# ../../.ssh/Authorized Keys\n');
    assert.deepEqual(readdirSync(path.join(folder, 'documents')).sort(), ['.keep', 'plan-2.md', 'plan.md', 'ssh-authorized-keys.md']);

    // The store keeps itself to itself, in the portal's data folder, and nothing of it is in the folder.
    assert.equal(statSync(storeOf(folder)).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(storeOf(folder), 'git')).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(storeOf(folder), 'docs.sqlite')).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(folder), ['documents']);
  } finally {
    await docs.close();
  }
});

test('a save on a revision that is not the latest is refused with 409 and the current text, and nothing is written', async () => {
  const { folder, docs, url } = await withDocument('docs-store-stale-');
  try {
    assert.equal((await docs.call('PUT', url, { markdown: '# Plan\n\nThe agent\'s.\n', base: 1 })).status, 200);
    const was = head(folder);
    const stale = await docs.call('PUT', url, { markdown: '# Plan\n\nThe user\'s, on revision 1.\n', base: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.revision, 2);
    assert.equal(stale.body.markdown, '# Plan\n\nThe agent\'s.\n');
    assert.match(stale.body.error, /revision 2/);
    assert.equal(readFileSync(path.join(folder, 'documents', 'plan.md'), 'utf8'), '# Plan\n\nThe agent\'s.\n', 'the file is as it was');
    assert.equal(head(folder), was, 'no commit');
    assert.equal((await docs.call('GET', `${url}/history`)).body.revisions.length, 2);
    // A base from the future, or none, is no better.
    assert.equal((await docs.call('PUT', url, { markdown: 'x', base: 3 })).status, 409);
    assert.equal((await docs.call('PUT', url, { markdown: 'x' })).status, 400);
    assert.equal((await docs.call('PUT', url, { markdown: 'x', base: '2; rm -rf' })).status, 400);
    assert.equal(head(folder), was);
  } finally {
    await docs.close();
  }
});

test('a document is named by its id: a path, a name or ../ in its place is refused', async () => {
  const folder = folderWith('docs-store-ids-', { 'documents/plan.md': '# Plan', 'secret.md': '# Secret' });
  const outside = folderWith('docs-store-outside-', { 'private.md': '# Private' });
  const docs = await portal({ a: folder });
  try {
    const [listed] = await docs.listed();
    const f = listed.id;
    assert.deepEqual(listed.documents.map((d: any) => d.name), ['plan.md']);
    const asks = ['..%2Fsecret.md', '..%2F..%2F' + encodeURIComponent(path.basename(outside)) + '%2Fprivate.md', 'plan.md', '%2Fetc%2Fpasswd', '0123456789abcdeg', '0123456789ABCDEF', '0123456789abcdef'];
    for (const id of asks) {
      for (const [method, suffix, body] of [['GET', '', undefined], ['PUT', '', { markdown: 'overwritten', base: 1 }], ['GET', '/history', undefined], ['GET', '/revisions/1', undefined], ['POST', '/restore', { revision: 1 }]] as const) {
        const answer = await docs.call(method, `/folders/${f}/documents/${id}${suffix}`, body);
        assert.equal(answer.status, 404, `${method} ${id}${suffix}`);
        // An id the store knows the form of, and has no document for, says so with `deleted` (what the page takes for a deletion); any other is only not found.
        assert.deepEqual(answer.body, id === '0123456789abcdef' ? { error: 'There is no such document', code: 'deleted' } : { error: 'There is no such document' });
      }
    }
    assert.equal(readFileSync(path.join(folder, 'secret.md'), 'utf8'), '# Secret');
    assert.equal(readFileSync(path.join(folder, 'documents', 'plan.md'), 'utf8'), '# Plan');
    assert.equal(readFileSync(path.join(outside, 'private.md'), 'utf8'), '# Private');
    assert.equal(commits(folder), 1);
    // A folder is one a chat works in, named by its id: not a path. One without documents gets no store from a question.
    assert.equal((await docs.call('POST', `/folders/${encodeURIComponent(outside)}/documents`, { title: 'x' })).status, 404);
    assert.equal((await docs.call('POST', '/folders/0123456789abcdef/documents', { title: 'x' })).status, 404);
    assert.equal(existsSync(path.join(outside, 'documents')), false);
    const empty = folderWith('docs-store-empty-');
    const other = await portal({ b: empty });
    try {
      assert.equal((await other.call('GET', `/folders/${folderIdOf(empty)}/documents/0123456789abcdef`)).status, 404);
      assert.equal(existsSync(storeOf(empty)), false);
    } finally {
      await other.close();
    }
  } finally {
    await docs.close();
  }
});

test('a write cut off after the file is written is committed as a recovered revision the next time the store is used', async () => {
  const { folder, docs, f, doc, url } = await withDocument('docs-store-fault-write-');
  try {
    docs.fault('write');
    const failed = await docs.call('PUT', url, { markdown: '# Plan\n\nWritten, never committed.\n', base: 1 });
    assert.equal(failed.status, 500);
    assert.match(docs.logged.join('\n'), /injected failure after the write/);
    assert.equal(commits(folder), 1, 'nothing committed yet');

    const read = await docs.call('GET', url);
    assert.equal(read.body.revision, 2);
    assert.equal(read.body.markdown, '# Plan\n\nWritten, never committed.\n');
    assert.equal(trailers(folder), `Doc-Id: ${doc}\nDoc-Name: plan.md\nRevision: 2\nAuthor: external`);
    assert.equal(git(folder, 'show', 'HEAD:plan.md'), '# Plan\n\nWritten, never committed.');
    const history = (await docs.call('GET', `${url}/history`)).body;
    assert.deepEqual(history.revisions.map((r: any) => [r.revision, r.author, r.kind]), [[2, 'external', 'recovered'], [1, 'user', 'create']]);
    // And it goes on from there.
    assert.equal((await docs.call('PUT', url, { markdown: '# Plan\n\nThree.\n', base: 2 })).body.revision, 3);

    // The same for a new document: its id is kept.
    docs.fault('write');
    assert.equal((await docs.call('POST', `/folders/${f}/documents`, { title: 'Notes', markdown: '# Notes\n' })).status, 500);
    const notes = (await docs.listed())[0].documents.find((d: any) => d.name === 'notes.md');
    assert.equal(notes.revision, 1);
    assert.equal((await docs.call('GET', `/folders/${f}/documents/${notes.id}/history`)).body.revisions[0].kind, 'adopted');
  } finally {
    await docs.close();
  }
});

test('a write cut off after its commit is told to the database from the commit\'s trailers', async () => {
  const { folder, docs, f, url } = await withDocument('docs-store-fault-commit-');
  try {
    docs.fault('commit');
    assert.equal((await docs.call('PUT', url, { markdown: '# Plan\n\nCommitted, not recorded.\n', base: 1 })).status, 500);
    assert.equal(commits(folder), 2, 'the commit is there');

    const read = await docs.call('GET', url);
    assert.equal(read.body.revision, 2);
    assert.equal(read.body.markdown, '# Plan\n\nCommitted, not recorded.\n');
    assert.equal(commits(folder), 2, 'replayed, not committed again');
    const history = (await docs.call('GET', `${url}/history`)).body;
    assert.deepEqual(history.revisions.map((r: any) => [r.revision, r.author, r.kind]), [[2, 'user', 'save'], [1, 'user', 'create']]);
    // A save on the revision the page was told before is stale; on the replayed one it goes through.
    assert.equal((await docs.call('PUT', url, { markdown: 'x', base: 1 })).status, 409);
    assert.equal((await docs.call('PUT', url, { markdown: '# Plan\n\nThree.\n', base: 2 })).body.revision, 3);

    docs.fault('commit');
    const made = await docs.call('POST', `/folders/${f}/documents`, { title: 'Notes', markdown: '# Notes\n' });
    assert.equal(made.status, 500);
    const notes = (await docs.listed())[0].documents.find((d: any) => d.name === 'notes.md');
    const history2 = (await docs.call('GET', `/folders/${f}/documents/${notes.id}/history`)).body;
    assert.deepEqual(history2.revisions.map((r: any) => [r.revision, r.author, r.kind]), [[1, 'user', 'create']]);
  } finally {
    await docs.close();
  }
});

test('what a crash leaves (a temporary file, a stale index.lock) is cleared, and a file changed outside is committed as a revision of its own', async () => {
  const { folder, docs, doc, url } = await withDocument('docs-store-leftovers-');
  try {
    const temp = path.join(folder, 'documents', '.plan.md.0123456789ab.tmp');
    writeFileSync(temp, 'half a document');
    // Left a while ago: a save of Files' that is under this moment writes such a file too, and is not removed (below).
    utimesSync(temp, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    const inFlight = path.join(folder, 'documents', '.other.md.fedcba987654.tmp');
    writeFileSync(inFlight, 'a save that is under way');
    writeFileSync(path.join(storeOf(folder), 'git', 'index.lock'), '');
    // Not the store's: kept.
    writeFileSync(path.join(folder, 'documents', '.notes.tmp'), 'the agent\'s');
    assert.equal((await docs.call('PUT', url, { markdown: '# Plan\n\nTwo.\n', base: 1 })).body.revision, 2);
    assert.equal(existsSync(temp), false);
    assert.equal(existsSync(inFlight), true, 'a temporary file that is not old is a save under way, and is left');
    rmSync(inFlight);
    assert.equal(existsSync(path.join(storeOf(folder), 'git', 'index.lock')), false);
    assert.equal(existsSync(path.join(folder, 'documents', '.notes.tmp')), true);

    // The agent (or Files, or an editor) writes the file itself.
    writeFileSync(path.join(folder, 'documents', 'plan.md'), '# Plan\n\nThe agent wrote this.\n');
    const read = await docs.call('GET', url);
    assert.equal(read.body.revision, 3);
    assert.equal(trailers(folder), `Doc-Id: ${doc}\nDoc-Name: plan.md\nRevision: 3\nAuthor: external`);
    // A file written by hand into the documents folder becomes a document; one that is no document does not.
    writeFileSync(path.join(folder, 'documents', 'ideas.md'), '# Ideas\n');
    writeFileSync(path.join(folder, 'documents', 'list.txt'), 'not a document');
    const listed = (await docs.listed())[0].documents.map((d: any) => [d.name, d.title, d.revision]);
    assert.deepEqual(listed, [['ideas.md', 'Ideas', 1], ['plan.md', 'Plan', 3]]);
    assert.deepEqual(git(folder, 'ls-tree', '--name-only', 'HEAD').split('\n'), ['ideas.md', 'plan.md']);
  } finally {
    await docs.close();
  }
});

test('the revisions are told again from the commits when the database is lost', async () => {
  const { folder, docs, f, doc, url } = await withDocument('docs-store-rebuild-');
  await docs.call('PUT', url, { markdown: '# Plan\n\nTwo.\n', base: 1 });
  await docs.close();
  for (const file of readdirSync(storeOf(folder))) if (file.startsWith('docs.sqlite')) rmSync(path.join(storeOf(folder), file));
  const again = await portal({ a: folder });
  try {
    const read = await again.call('GET', `/folders/${f}/documents/${doc}`);
    assert.equal(read.status, 200, 'the same id');
    assert.equal(read.body.revision, 2);
    assert.deepEqual((await again.call('GET', `${url}/history`)).body.revisions.map((r: any) => [r.revision, r.kind]), [[2, 'save'], [1, 'create']]);
    assert.equal(commits(folder), 2);
  } finally {
    await again.close();
  }
});

test('a restore saves an earlier revision\'s text as a new revision, and history only grows', async () => {
  const { folder, docs, url } = await withDocument('docs-store-restore-');
  try {
    await docs.call('PUT', url, { markdown: '# Plan\n\nTwo.\n', base: 1 });
    const old = await docs.call('GET', `${url}/revisions/1`);
    assert.equal(old.body.markdown, '# Plan\n\nOne.\n');

    const restored = await docs.call('POST', `${url}/restore`, { revision: 1, base: 2 });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.revision, 3);
    assert.equal(restored.body.restoredFrom, 1);
    assert.equal(readFileSync(path.join(folder, 'documents', 'plan.md'), 'utf8'), '# Plan\n\nOne.\n');
    assert.equal(commits(folder), 3);
    assert.match(trailers(folder), /^Revision: 3$/m);
    assert.match(trailers(folder), /^Restored-From: 1$/m);
    const history = (await docs.call('GET', `${url}/history`)).body;
    assert.deepEqual(history.revisions.map((r: any) => [r.revision, r.kind, r.restoredFrom]), [[3, 'restore', 1], [2, 'save', undefined], [1, 'create', undefined]]);
    // Revision 2 is still there to go back to.
    assert.equal((await docs.call('GET', `${url}/revisions/2`)).body.markdown, '# Plan\n\nTwo.\n');

    assert.equal((await docs.call('POST', `${url}/restore`, { revision: 2, base: 2 })).status, 409, 'on a stale base');
    assert.equal((await docs.call('POST', `${url}/restore`, { revision: 9 })).status, 404);
    // A document whose file was deleted is made again.
    rmSync(path.join(folder, 'documents', 'plan.md'));
    assert.equal((await docs.call('GET', url)).status, 404);
    const back = await docs.call('POST', `${url}/restore`, { revision: 2 });
    assert.equal(back.body.revision, 4);
    assert.equal(readFileSync(path.join(folder, 'documents', 'plan.md'), 'utf8'), '# Plan\n\nTwo.\n');
  } finally {
    await docs.close();
  }
});

test('a save keeps the file\'s mode, and never writes through a link or a second name', async () => {
  const { folder, docs, f, url } = await withDocument('docs-store-links-');
  const outside = folderWith('docs-store-target-', { 'private.md': '# Private\n' });
  try {
    const file = path.join(folder, 'documents', 'plan.md');
    chmodSync(file, 0o640);
    assert.equal((await docs.call('PUT', url, { markdown: '# Plan\n\nTwo.\n', base: 1 })).status, 200);
    assert.equal(statSync(file).mode & 0o777, 0o640);

    // The document's name made a second name of a file outside.
    rmSync(file);
    linkSync(path.join(outside, 'private.md'), file);
    const hard = await docs.call('PUT', url, { markdown: 'overwritten', base: 2 });
    assert.notEqual(hard.status, 200);
    assert.equal(readFileSync(path.join(outside, 'private.md'), 'utf8'), '# Private\n');
    // A link in its place.
    rmSync(file);
    symlinkSync(path.join(outside, 'private.md'), file);
    assert.notEqual((await docs.call('PUT', url, { markdown: 'overwritten', base: 2 })).status, 200);
    assert.notEqual((await docs.call('POST', `${url}/restore`, { revision: 1 })).status, 200);
    assert.equal(readFileSync(path.join(outside, 'private.md'), 'utf8'), '# Private\n');
    // Neither is taken in as a document of its own.
    assert.deepEqual((await docs.listed()).flatMap((folder: any) => folder.documents.map((d: any) => d.name)), []);
    assert.equal((await docs.call('POST', `/folders/${f}/documents`, { title: 'Private' })).body.name, 'private.md', 'a name of its own, inside');
  } finally {
    await docs.close();
  }
});

test('a save that looks like it holds a secret is kept, with a warning', async () => {
  const { docs, url } = await withDocument('docs-store-secret-');
  try {
    const saved = await docs.call('PUT', url, { markdown: `# Plan\n\nkey: ghp_${'a'.repeat(36)}\n`, base: 1 });
    assert.equal(saved.status, 200);
    assert.match(saved.body.warning, /secret/);
    assert.equal((await docs.call('PUT', url, { markdown: '# Plan\n\nNothing.\n', base: 2 })).body.warning, undefined);
  } finally {
    await docs.close();
  }
});

/**
 * With the sandbox on, the portal runs as root and the agent's user owns the
 * folder it works in. Run here as root in a user namespace of its own, with
 * other ids mapped, where the system allows one.
 */
test('with the sandbox on, a saved document keeps its owner, and a new one gets the documents folder\'s', async (t) => {
  // Probed with the same binary and call the test makes (node, chownSync): a namespace that
  // starts can still refuse to give a file to another id (no subordinate ids mapped, no
  // CAP_CHOWN, AppArmor rules that differ by binary).
  const probeDir = scratch('docs-owner-probe-');
  const probeScript = "const f = process.argv[1]; require('node:fs').writeFileSync(f, ''); require('node:fs').chownSync(f, 1234, 1235);";
  const probe = spawnSync('unshare', ['--map-auto', '--map-root-user', process.execPath, '-e', probeScript, path.join(probeDir, 'probe')], { encoding: 'utf8' });
  rmSync(probeDir, { recursive: true, force: true });
  if (probe.status !== 0) return t.skip(`cannot chown to other ids in a user namespace here: ${probe.stderr?.trim().split('\n')[0] || probe.error?.message || `exit ${probe.status}`}`);
  const script = `
    import express from 'express';
    import { chownSync, chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
    import path from 'node:path';
    import docsServer from ${JSON.stringify(new URL('../server.js', import.meta.url).href)};
    import { folderFiles } from ${JSON.stringify(new URL('../../../core/server/src/folder-files.ts', import.meta.url).href)};
    const root = mkdtempSync(path.join(process.env.WHERE, 'docs-owner-'));
    try {
      const folder = path.join(root, 'project');
      mkdirSync(path.join(folder, 'documents'), { recursive: true });
      writeFileSync(path.join(folder, 'documents', 'plan.md'), '# Plan\\n');
      // The agent's user and group own the folder; the documents folder is shared with the group.
      chownSync(folder, 1234, 1234);
      chownSync(path.join(folder, 'documents'), 1234, 1234);
      chmodSync(path.join(folder, 'documents'), 0o2775);
      chownSync(path.join(folder, 'documents', 'plan.md'), 1234, 1235);
      chmodSync(path.join(folder, 'documents', 'plan.md'), 0o660);
      // The portal's data folder is the portal's own (root here), closed to the agent's user.
      const data = path.join(root, 'data');
      mkdirSync(data, { mode: 0o700 });
      const router = express.Router();
      const stop = docsServer({ log: (line) => console.error(line), router, http: { json: express.json }, files: folderFiles, sandbox: { on: () => true }, dataDir: () => data,
        chats: { list: () => [{ id: 'a', title: 'A' }], inFolder: () => [{ id: 'a', title: 'A' }], folder: () => folder } }, { dependencies: async () => true });
      const app = express(); app.use(router);
      const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
      const base = 'http://127.0.0.1:' + server.address().port;
      const call = async (method, url, body) => (await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })).json();
      const [listed] = (await call('GET', '/folders')).folders;
      const doc = listed.documents[0];
      const saved = await call('PUT', '/folders/' + listed.id + '/documents/' + doc.id, { markdown: '# Plan\\n\\nSaved by the portal.\\n', base: doc.revision });
      const made = await call('POST', '/folders/' + listed.id + '/documents', { title: 'Notes' });
      const own = (name) => { const s = statSync(path.join(folder, 'documents', name)); return [s.uid, s.gid, (s.mode & 0o777).toString(8)]; };
      const store = statSync(path.join(data, listed.id));
      console.log(JSON.stringify({ saved: saved.revision, made: made.name, plan: own('plan.md'), notes: own('notes.md'), store: [store.uid, (store.mode & 0o777).toString(8)] }));
      await stop(); server.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  `;
  const where = scratch('docs-owner-ns-');
  const child = spawnSync('unshare', ['--map-auto', '--map-root-user', process.execPath, '--import', 'tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 60_000, cwd: process.cwd(), env: { ...process.env, WHERE: where },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    saved: 2,
    made: 'notes.md',
    plan: [1234, 1235, '660'],
    notes: [1234, 1234, '664'],
    store: [0, '700'],
  });
});

test('a name a link holds is skipped when a document is made, not a failure', async () => {
  const folder = folderWith('docs-store-taken-', { 'README.md': '# Read me\n', 'documents/.keep': '' });
  symlinkSync('../README.md', path.join(folder, 'documents', 'notes.md'));
  const docs = await portal({ a: folder });
  try {
    const made = await docs.call('POST', `/folders/${folderIdOf(folder)}/documents`, { title: 'Notes' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.name, 'notes-2.md');
    assert.equal(readFileSync(path.join(folder, 'README.md'), 'utf8'), '# Read me\n');
  } finally {
    await docs.close();
  }
});

test('a document whose name starts with a space keeps its id and history when the database is lost', async () => {
  const folder = folderWith('docs-store-space-', { 'documents/ notes.md': '# Notes\n' });
  const first = await portal({ a: folder });
  let doc: any;
  try {
    doc = (await first.listed())[0].documents[0];
    assert.equal(doc.name, ' notes.md');
    const url = `/folders/${folderIdOf(folder)}/documents/${doc.id}`;
    assert.equal((await first.call('PUT', url, { markdown: '# Notes\n\nTwo.\n', base: doc.revision })).status, 200);
  } finally {
    await first.close();
  }
  for (const file of readdirSync(storeOf(folder))) if (file.startsWith('docs.sqlite')) rmSync(path.join(storeOf(folder), file));
  const again = await portal({ a: folder });
  try {
    const read = await again.call('GET', `/folders/${folderIdOf(folder)}/documents/${doc.id}`);
    assert.equal(read.status, 200, 'the same id');
    assert.equal(read.body.revision, doc.revision + 1);
  } finally {
    await again.close();
  }
});

test('a store that fails to open does not keep its database open on every request', async (t) => {
  if (!existsSync('/proc/self/fd')) return t.skip('no /proc/self/fd to count descriptors in');
  const { folder, docs } = await withDocument('docs-store-leak-');
  await docs.close();
  // A database of a later version cannot be opened by this store.
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(path.join(storeOf(folder), 'docs.sqlite'));
  db.prepare("UPDATE meta SET value = '9' WHERE key = 'schema'").run();
  db.close();
  const again = await portal({ a: folder });
  try {
    await again.call('GET', '/folders');
    const open = () => readdirSync('/proc/self/fd').length;
    const before = open();
    for (let i = 0; i < 20; i++) await again.call('GET', '/folders');
    assert.ok(open() - before < 10, `${open() - before} descriptors more after 20 requests`);
  } finally {
    await again.close();
  }
});

/** More folders than the portal's listing keeps (2,000, folders before files), so that no file of the documents folder is in it. */
function pastTheListing(dir: string) {
  for (let i = 0; i <= 2000; i++) mkdirSync(path.join(dir, `pictures-${String(i).padStart(4, '0')}`));
}

test('a document is checked for an outside change by its name, so that a folder with more entries than a listing keeps does not hide it', async () => {
  const { folder, docs, url } = await withDocument('docs-store-many-');
  try {
    const dir = path.join(folder, 'documents');
    pastTheListing(dir);
    // The agent rewrites it; the person, who was shown revision 1, saves.
    writeFileSync(path.join(dir, 'plan.md'), '# Plan\n\nThe agent\'s, in a folder full of pictures.\n');
    const stale = await docs.call('PUT', url, { markdown: '# Plan\n\nThe person\'s, on revision 1.\n', base: 1 });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.revision, 2);
    assert.equal(stale.body.markdown, '# Plan\n\nThe agent\'s, in a folder full of pictures.\n');
    assert.equal(readFileSync(path.join(dir, 'plan.md'), 'utf8'), '# Plan\n\nThe agent\'s, in a folder full of pictures.\n', 'the agent\'s text is not written over');
    // Taken into the history as the agent's, so that it is not lost.
    assert.equal(commits(folder), 2);
    const history = (await docs.call('GET', `${url}/history`)).body;
    assert.deepEqual(history.revisions.map((r: any) => [r.revision, r.author]), [[2, 'external'], [1, 'user']]);
  } finally {
    await docs.close();
  }
});

test('a folder too big to be listed whole does not say that a document was never kept: its row stays until its file is seen to be gone', async () => {
  const folder = folderWith('docs-store-many-gone-', { 'documents/.keep': '' });
  const docs = await portal({ a: folder });
  try {
    const f = folderIdOf(folder);
    // A new document whose commit never came: its row has no revision yet, and its file is taken in under its id.
    docs.fault('write');
    assert.equal((await docs.call('POST', `/folders/${f}/documents`, { title: 'Notes', markdown: '# Notes\n' })).status, 500);
    const file = path.join(folder, 'documents', 'notes.md');
    rmSync(file);
    pastTheListing(path.join(folder, 'documents'));
    await docs.call('GET', '/folders');
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(path.join(storeOf(folder), 'docs.sqlite'), { readonly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM documents WHERE name = 'notes.md'").get().n, 1, 'the row is kept');
    } finally {
      db.close();
    }
  } finally {
    await docs.close();
  }
});

test('a document an outside change pushed past 1 MB is restored over, not refused', async () => {
  const { folder, docs, url } = await withDocument('docs-store-big-', '# Plan\n\nOne.\n');
  try {
    assert.equal((await docs.call('PUT', url, { markdown: '# Plan\n\nTwo.\n', base: 1 })).status, 200);
    const file = path.join(folder, 'documents', 'plan.md');
    writeFileSync(file, `# Plan\n\n${'log\n'.repeat(300_000)}`);
    assert.ok(statSync(file).size > 1024 * 1024);
    const restored = await docs.call('POST', `${url}/restore`, { revision: 1 });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(readFileSync(file, 'utf8'), '# Plan\n\nOne.\n');
    assert.equal((await docs.call('GET', url)).body.revision, 3);
  } finally {
    await docs.close();
  }
});

test('a store whose history was deleted while the portal runs is opened again, not failed on every request', async () => {
  const { folder, docs, f, doc, url } = await withDocument('docs-store-nogit-');
  try {
    rmSync(path.join(storeOf(folder), 'git'), { recursive: true, force: true });
    const read = await docs.call('GET', url);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.id, doc);
    assert.deepEqual((await docs.listed()).map((x: any) => x.id), [f]);
    // And it takes saves again, with a history of its own.
    assert.equal((await docs.call('PUT', url, { markdown: '# Plan\n\nTwo.\n', base: read.body.revision })).status, 200);
  } finally {
    await docs.close();
  }
});

/** The store folder `store` and what is in it that is open to others: its own folders to anyone, what is in them to writing by group or others. */
function loose(store: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of readdirSync(dir)) {
      const place = path.join(dir, entry);
      const stat = lstatSync(place);
      // A link's own mode is always open: it is what it leads to that counts.
      if (stat.isSymbolicLink()) continue;
      if (depth === 0 && stat.isDirectory() ? stat.mode & 0o077 : stat.mode & 0o022) found.push(`${path.relative(store, place)} ${(stat.mode & 0o7777).toString(8)}`);
      if (stat.isDirectory()) walk(place, depth + 1);
    }
  };
  if (statSync(store).mode & 0o077) found.push(`. ${(statSync(store).mode & 0o7777).toString(8)}`);
  walk(store, 0);
  return found;
}

/** Mode, owner and change time of `dir` and everything in it: what a chmod or a chown, even to what a file has, would show. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (place: string) => {
    const stat = lstatSync(place);
    out.push(`${path.relative(dir, place) || '.'} ${(stat.mode & 0o7777).toString(8)} ${stat.uid}:${stat.gid} ${stat.ctimeMs}`);
    if (stat.isDirectory()) for (const entry of readdirSync(place).sort()) walk(path.join(place, entry));
  };
  walk(dir);
  return out;
}

/**
 * The sandbox's preparation of a chat's folder, run as it runs it (a recursive chown and chmod for the agents' group),
 * for the group this user is in. Run in a process of its own: it loads the server's modules, which read the environment.
 */
function prepareFolder(folder: string) {
  const home = scratch('docs-store-prepare-home-');
  const script = `
    const { prepareFolder } = await import(${JSON.stringify(new URL('../../../core/server/src/sandbox/apply.ts', import.meta.url).href)});
    const folder = process.env.FOLDER;
    await prepareFolder({ enabled: true, rules: [{ path: folder, access: 'write' }], trusted: [] }, { available: true, ids: { tools: process.getuid(), group: process.getgid() } }, folder);
  `;
  const env = { ...process.env, FOLDER: folder, DATA_DIR: home, AGENT_HOME: path.join(home, 'agent-home'), WORKSPACE_ROOT: path.join(home, 'ws'), SESSION_DIR: path.join(home, 'sessions'), PI_CODING_AGENT_DIR: path.join(home, 'agent'), BIN_DIR: path.join(home, 'bin'), CHANNELS_DIR: path.join(home, 'channels') };
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60_000, cwd: process.cwd(), env });
  assert.equal(child.status, 0, child.stderr);
}

test('the sandbox\'s preparation of a chat\'s folder does not touch the store, which is in the portal\'s data folder: not its own, nor one for a folder below it', async () => {
  const { folder, docs, url } = await withDocument('docs-store-prepare-');
  const below = path.join(folder, 'sub');
  mkdirSync(path.join(below, 'documents'), { recursive: true });
  const other = await portal({ b: below });
  try {
    assert.equal((await docs.call('PUT', url, { markdown: '# Plan\n\nTwo.\n', base: 1 })).status, 200);
    assert.equal((await other.call('POST', `/folders/${folderIdOf(below)}/documents`, { title: 'Notes', markdown: '# Notes\n' })).status, 201);
    const stores = [storeOf(folder), storeOf(below)];
    const before = stores.map(snapshot);
    prepareFolder(folder);
    // The folder's own files are the group's now, as the preparation is for; the stores are not in it.
    assert.ok(statSync(path.join(folder, 'documents', 'plan.md')).mode & 0o020, 'the document is group-writable');
    assert.deepEqual(readdirSync(folder).sort(), ['documents', 'sub']);
    assert.deepEqual(readdirSync(below), ['documents']);
    assert.deepEqual(stores.map(snapshot), before, 'not a mode, owner or change time of the stores');
    assert.deepEqual(stores.flatMap(loose), []);
    // And the requests go on as before.
    assert.equal((await docs.call('PUT', url, { markdown: '# Plan\n\nThree.\n', base: 2 })).status, 200);
    assert.equal((await other.listed()).length, 1);
  } finally {
    await other.close();
    await docs.close();
  }
});

test('the store is made in the portal\'s data folder on first use, by the folder\'s id, and says which folder it is for', async () => {
  const folder = folderWith('docs-store-place-', { 'documents/plan.md': '# Plan\n' });
  const data = scratch('docs-store-place-data-');
  const docs = await portal({ a: folder }, { data });
  try {
    assert.deepEqual(readdirSync(data), [], 'nothing is made before a folder\'s documents are asked for');
    const id = folderIdOf(folder);
    assert.deepEqual((await docs.listed()).map((f: any) => f.id), [id]);
    assert.deepEqual(readdirSync(data), [id]);
    assert.deepEqual(readdirSync(path.join(data, id)).sort(), ['docs.sqlite', 'docs.sqlite-shm', 'docs.sqlite-wal', 'folder.json', 'git']);
    const stat = statSync(folder);
    assert.deepEqual(JSON.parse(readFileSync(path.join(data, id, 'folder.json'), 'utf8')), { path: folder, dev: String(stat.dev), ino: String(stat.ino) });
    assert.equal(statSync(path.join(data, id, 'folder.json')).mode & 0o777, 0o600);
    // Nothing is made in the folder, and a store is not made for a folder that has no documents folder.
    assert.deepEqual(readdirSync(folder), ['documents']);
    const bare = folderWith('docs-store-place-bare-');
    const other = await portal({ b: bare }, { data });
    try {
      assert.deepEqual(await other.listed(), []);
      assert.deepEqual(readdirSync(data), [id]);
    } finally {
      await other.close();
    }
  } finally {
    await docs.close();
  }
  // A portal started again over the same data folder finds it by the folder's id: the same document ids, and the history.
  const first = await portal({ a: folder }, { data });
  let doc: any;
  try {
    doc = (await first.listed())[0].documents[0];
  } finally {
    await first.close();
  }
  const again = await portal({ a: folder }, { data });
  try {
    const [listed] = await again.listed();
    assert.deepEqual(listed.documents.map((d: any) => [d.id, d.revision]), [[doc.id, 1]]);
    assert.deepEqual((await again.call('GET', `/folders/${listed.id}/documents/${doc.id}/history`)).body.revisions.map((r: any) => r.kind), ['adopted']);
  } finally {
    await again.close();
  }
});

test('the data folder the stores are in is closed to others when it is found open, and one that is a link is refused', async () => {
  const folder = folderWith('docs-store-data-mode-', { 'documents/plan.md': '# Plan\n' });
  const data = scratch('docs-store-data-mode-data-');
  chmodSync(data, 0o775);
  const docs = await portal({ a: folder }, { data });
  try {
    assert.equal((await docs.listed()).length, 1);
    assert.equal(statSync(data).mode & 0o777, 0o700);
  } finally {
    await docs.close();
  }
  const real = scratch('docs-store-data-link-real-');
  const link = path.join(scratch('docs-store-data-link-'), 'data');
  symlinkSync(real, link);
  const linked = await portal({ a: folder }, { data: link });
  try {
    assert.equal((await linked.call('POST', `/folders/${folderIdOf(folder)}/documents`, { title: 'Notes' })).status, 500);
    assert.deepEqual(readdirSync(real), [], 'nothing was made where the link leads');
  } finally {
    await linked.close();
  }
});

/** Takes a folder out of the way, with its inode kept, and puts a new one at its path: no inode of the new one can be the old one's. */
function replaceFolder(folder: string, files: Record<string, string>) {
  renameSync(folder, `${folder}.was`);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    writeFileSync(path.join(folder, name), text);
  }
}

test('a folder deleted and made again at the same path does not get the old folder\'s history and comments: the old store is kept aside', async () => {
  const { folder, docs, f, doc, url } = await withDocument('docs-store-reused-');
  assert.equal((await docs.call('PUT', url, { markdown: '# Plan\n\nTwo.\n', base: 1 })).status, 200);
  await docs.close();
  replaceFolder(folder, { 'documents/other.md': '# Other\n' });
  const again = await portal({ a: folder });
  try {
    const [listed] = await again.listed();
    assert.equal(listed.id, f, 'the same folder id: it is made from the path');
    assert.deepEqual(listed.documents.map((d: any) => [d.name, d.revision]), [['other.md', 1]]);
    assert.equal((await again.call('GET', url)).status, 404, 'the old document is not this folder\'s');
    assert.equal(commits(folder), 1);
    assert.deepEqual(JSON.parse(readFileSync(path.join(storeOf(folder), 'folder.json'), 'utf8')), { path: folder, dev: String(statSync(folder).dev), ino: String(statSync(folder).ino) });
    // Kept, not deleted: it is somebody's history.
    const aside = readdirSync(DATA).filter((name) => name.startsWith(`${f}.replaced-`));
    assert.equal(aside.length, 1);
    assert.equal(execFileSync('git', [`--git-dir=${path.join(DATA, aside[0], 'git')}`, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim(), '2');
    assert.match(again.logged.join('\n'), /kept as .*replaced/);
  } finally {
    await again.close();
  }
});

test('a folder deleted and made again while the portal runs is noticed by the next request, not served with the old store', async () => {
  const { folder, docs, f, doc, url } = await withDocument('docs-store-reused-live-');
  try {
    assert.equal((await docs.call('GET', url)).status, 200, 'held now');
    replaceFolder(folder, { 'documents/other.md': '# Other\n' });
    assert.equal((await docs.call('GET', url)).status, 404, 'the old document is not this folder\'s');
    const [listed] = await docs.listed();
    assert.deepEqual(listed.documents.map((d: any) => [d.name, d.revision]), [['other.md', 1]]);
    assert.equal(commits(folder), 1, 'a history of its own');
    assert.equal(readdirSync(DATA).filter((name) => name.startsWith(`${f}.replaced-`)).length, 1);
    assert.ok(doc);
  } finally {
    await docs.close();
  }
});

test('a folder restored from a backup (other inodes, the same documents) keeps its history, and the store follows it', async () => {
  const { folder, docs, f, doc, url } = await withDocument('docs-store-restored-');
  assert.equal((await docs.call('PUT', url, { markdown: '# Plan\n\nTwo.\n', base: 1 })).status, 200);
  await docs.close();
  // The backup holds the document as it was at its first revision: it is one of the store's.
  replaceFolder(folder, { 'documents/plan.md': '# Plan\n\nOne.\n' });
  const again = await portal({ a: folder });
  try {
    const [listed] = await again.listed();
    const [restored] = listed.documents;
    assert.equal(restored.id, doc, 'the same document');
    // The file is not the text of the last revision: taken in as an outside change, on top of the history.
    assert.equal(restored.revision, 3);
    assert.deepEqual((await again.call('GET', `${url}/history`)).body.revisions.map((r: any) => r.revision), [3, 2, 1]);
    assert.deepEqual(readdirSync(DATA).filter((name) => name.startsWith(`${f}.replaced-`)), []);
    // And it is told which folder it is for now.
    assert.equal(JSON.parse(readFileSync(path.join(storeOf(folder), 'folder.json'), 'utf8')).ino, String(statSync(folder).ino));
  } finally {
    await again.close();
  }
});

test('a folder that was moved takes its store along, and a folder made at its old path does not get it', async () => {
  const { folder, docs, f, doc, url } = await withDocument('docs-store-moved-');
  assert.equal((await docs.call('PUT', url, { markdown: '# Plan\n\nTwo.\n', base: 1 })).status, 200);
  await docs.close();
  const moved = `${folder}-moved`;
  renameSync(folder, moved);
  // A chat works in the new place, and a folder is made at the old one.
  const fresh = folderWith('docs-store-moved-fresh-', { 'documents/other.md': '# Other\n' });
  const again = await portal({ a: moved });
  try {
    const [listed] = await again.listed();
    assert.notEqual(listed.id, f, 'another path, another id');
    assert.deepEqual(listed.documents.map((d: any) => [d.id, d.revision]), [[doc, 2]]);
    const newUrl = `/folders/${listed.id}/documents/${doc}`;
    assert.deepEqual((await again.call('GET', `${newUrl}/history`)).body.revisions.map((r: any) => r.revision), [2, 1]);
    assert.equal((await again.call('GET', `${newUrl}/revisions/1`)).body.markdown, '# Plan\n\nOne.\n');
    assert.equal(existsSync(storeOf(folder)), false, 'gone from the old id');
    assert.equal(commits(moved), 2);
    assert.equal(JSON.parse(readFileSync(path.join(storeOf(moved), 'folder.json'), 'utf8')).path, moved);
    assert.match(again.logged.join('\n'), /followed it/);
    // Another folder at the old path (here: its own) starts its own.
    renameSync(fresh, folder);
    const next = await portal({ a: folder, b: moved });
    try {
      const found = await next.listed();
      assert.deepEqual(found.map((x: any) => x.documents.map((d: any) => d.name)).sort(), [['other.md'], ['plan.md']]);
      assert.equal(commits(folder), 1);
      assert.equal(commits(moved), 2);
    } finally {
      await next.close();
    }
  } finally {
    await again.close();
  }
});

test('a leftover `.pithagoras-docs` beside the store does not take the folder\'s history when the folder is moved, with the sandbox on or off', async () => {
  for (const sandbox of [false, true]) {
    const { folder, docs, doc, url } = await withDocument(`docs-store-leftover-${sandbox}-`);
    assert.equal((await docs.call('PUT', url, { markdown: '# Plan\n\nTwo.\n', base: 1 })).status, 200);
    // A copy somebody kept by hand, as it was then; the history goes on in the store in the data folder.
    cpSync(storeOf(folder), path.join(folder, '.pithagoras-docs'), { recursive: true });
    assert.equal((await docs.call('PUT', url, { markdown: '# Plan\n\nThree.\n', base: 2 })).status, 200);
    await docs.close();
    const moved = `${folder}-moved`;
    renameSync(folder, moved);
    const again = await portal({ a: moved }, { sandbox });
    try {
      const [listed] = await again.listed();
      assert.deepEqual(listed.documents.map((d: any) => [d.id, d.revision]), [[doc, 3]], `sandbox ${sandbox}`);
      assert.deepEqual((await again.call('GET', `/folders/${listed.id}/documents/${doc}/history`)).body.revisions.map((r: any) => [r.revision, r.kind]), [[3, 'save'], [2, 'save'], [1, 'create']]);
      assert.equal(commits(moved), 3);
      assert.ok(existsSync(path.join(moved, '.pithagoras-docs')), 'the leftover is not touched');
      assert.match(again.logged.join('\n'), /\.pithagoras-docs in .* is not used/);
    } finally {
      await again.close();
    }
  }
});

test('a moved folder finds its store again when the folder made at its old path is placed before it', async () => {
  const { folder, docs, f, doc, url } = await withDocument('docs-store-moved-late-');
  assert.equal((await docs.call('PUT', url, { markdown: '# Plan\n\nTwo.\n', base: 1 })).status, 200);
  await docs.close();
  const moved = `${folder}-moved`;
  renameSync(folder, moved);
  mkdirSync(path.join(folder, 'documents'), { recursive: true });
  writeFileSync(path.join(folder, 'documents', 'other.md'), '# Other\n');
  // The old path is first: its folder is another one, so the old store is put aside before the moved folder asks for it.
  const again = await portal({ a: folder, b: moved });
  try {
    const found = await again.listed();
    const byPath = Object.fromEntries(found.map((x: any) => [x.path, x]));
    assert.deepEqual(byPath[folder].documents.map((d: any) => [d.name, d.revision]), [['other.md', 1]]);
    assert.deepEqual(byPath[moved].documents.map((d: any) => [d.id, d.revision]), [[doc, 2]], 'its own document, with its history');
    const newUrl = `/folders/${byPath[moved].id}/documents/${doc}`;
    assert.deepEqual((await again.call('GET', `${newUrl}/history`)).body.revisions.map((r: any) => r.revision), [2, 1]);
    assert.equal(commits(moved), 2);
    assert.equal(commits(folder), 1);
    assert.deepEqual(readdirSync(DATA).filter((name) => name.startsWith(`${f}.replaced-`)), [], 'the one put aside is the moved folder\'s again');
    assert.equal(JSON.parse(readFileSync(path.join(storeOf(moved), 'folder.json'), 'utf8')).path, moved);
  } finally {
    await again.close();
  }
});

test('a second path to a folder (a mount, a link) does not take the store made for the first', async () => {
  const folder = folderWith('docs-store-alias-', { 'documents/plan.md': '# Plan\n' });
  const stat = statSync(folder);
  // A store made for this very folder, which is still there at the path it names (here a link to it).
  const alias = path.join(scratch('docs-store-alias-link-'), 'alias');
  symlinkSync(folder, alias);
  const other = path.join(DATA, '0123456789abcdef');
  mkdirSync(other, { mode: 0o700 });
  writeFileSync(path.join(other, 'folder.json'), JSON.stringify({ path: alias, dev: String(stat.dev), ino: String(stat.ino) }));
  const docs = await portal({ a: folder });
  try {
    assert.equal((await docs.listed()).length, 1);
    assert.ok(existsSync(path.join(other, 'folder.json')), 'left where it was');
    assert.ok(existsSync(path.join(storeOf(folder), 'git')), 'this folder has a store of its own');
    assert.equal(JSON.parse(readFileSync(path.join(storeOf(folder), 'folder.json'), 'utf8')).path, folder);
  } finally {
    await docs.close();
  }
});

/**
 * A folder with a store as an earlier version kept it: its history in `.pithagoras-docs` in the folder, with what
 * that version left there, and no word of which folder it is for. Nothing is in the data folder for it.
 */
async function withEarlierStore(prefix: string) {
  const { folder, docs, f, doc, url } = await withDocument(prefix);
  assert.equal((await docs.call('PUT', url, { markdown: '# Plan\n\nTwo.\n', base: 1 })).status, 200);
  await docs.close();
  const old = path.join(folder, '.pithagoras-docs');
  renameSync(storeOf(folder), old);
  rmSync(path.join(old, 'folder.json'));
  writeFileSync(path.join(old, '.gitignore'), '*\n');
  writeFileSync(path.join(old, '.audited'), '');
  return { folder, f, doc, url, old };
}

/** What a folder's documents and history are once its store has been moved in: the same as before, in the data folder only. */
async function assertMoved(docs: Awaited<ReturnType<typeof portal>>, folder: string, f: string, doc: string, url: string, old: string) {
  const [listed] = await docs.listed();
  assert.equal(listed.id, f);
  assert.deepEqual(listed.documents.map((d: any) => [d.id, d.revision]), [[doc, 2]]);
  assert.deepEqual((await docs.call('GET', `${url}/history`)).body.revisions.map((r: any) => [r.revision, r.kind]), [[2, 'save'], [1, 'create']]);
  assert.equal((await docs.call('GET', `${url}/revisions/1`)).body.markdown, '# Plan\n\nOne.\n');
  assert.equal(existsSync(old), false, 'moved, not copied: it is not in the folder any more');
  assert.deepEqual(readdirSync(folder), ['documents']);
  assert.equal(commits(folder), 2);
  assert.deepEqual(readdirSync(DATA).filter((name) => name.startsWith('.moving')), []);
  assert.equal(statSync(storeOf(folder)).mode & 0o777, 0o700);
  assert.deepEqual(loose(storeOf(folder)), []);
  assert.equal(JSON.parse(readFileSync(path.join(storeOf(folder), 'folder.json'), 'utf8')).path, folder);
  // It takes saves, as it did.
  assert.equal((await docs.call('PUT', url, { markdown: '# Plan\n\nThree.\n', base: 2 })).body.revision, 3);
}

test('a store of an earlier version in the folder is moved into the data folder, history and all, the first time the folder is opened', async () => {
  const { folder, f, doc, url, old } = await withEarlierStore('docs-store-legacy-');
  const database = statSync(path.join(old, 'docs.sqlite')).ino;
  const steps: string[] = [];
  const docs = await portal({ a: folder }, { onStep: (step) => steps.push(step) });
  try {
    await assertMoved(docs, folder, f, doc, url, old);
    assert.ok(steps.includes('move'));
    // One store before and after, on this file system: renamed.
    assert.equal(statSync(path.join(storeOf(folder), 'docs.sqlite')).ino, database);
    assert.match(docs.logged.join('\n'), /was moved from \.pithagoras-docs into the portal's data folder/);
  } finally {
    await docs.close();
  }
});

test('across file systems the store of an earlier version is written anew in the data folder and the old one removed', async () => {
  const { folder, f, doc, url, old } = await withEarlierStore('docs-store-legacy-copy-');
  const database = statSync(path.join(old, 'docs.sqlite')).ino;
  const docs = await portal({ a: folder }, { onStep: (step) => { if (step === 'move') throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); } });
  try {
    await assertMoved(docs, folder, f, doc, url, old);
    assert.notEqual(statSync(path.join(storeOf(folder), 'docs.sqlite')).ino, database, 'written anew');
  } finally {
    await docs.close();
  }
});

test('with the sandbox on a store of an earlier version is not moved or used, whatever the sandbox\'s preparation made of it, and nothing is changed', async () => {
  const { folder, f, doc, url, old } = await withEarlierStore('docs-store-legacy-sandbox-');
  // The sandbox's preparation of the folder gives all of it, the old store too, to the agents' group.
  prepareFolder(folder);
  assert.ok(statSync(path.join(old, 'docs.sqlite')).mode & 0o060, 'the preparation opened it to the group');
  const before = snapshot(old);
  const steps: string[] = [];
  const docs = await portal({ a: folder }, { sandbox: true, onStep: (step) => steps.push(step) });
  try {
    const answered = await docs.call('GET', url);
    assert.equal(answered.status, 409, JSON.stringify(answered.body));
    assert.match(answered.body.error, /could not be moved into the portal's data folder \(the sandbox is on, and an agent could have changed what is in it\)/);
    assert.deepEqual(snapshot(old), before, 'as it was');
    assert.equal(existsSync(storeOf(folder)), false, 'nothing made beside it');
    assert.ok(!steps.includes('move'), 'no rename was tried');
    assert.deepEqual(await docs.listed(), []);
  } finally {
    await docs.close();
  }
  // Without the sandbox (or with the old store taken away) the folder is served: it moves as for any other.
  const plain = await portal({ a: folder });
  try {
    await assertMoved(plain, folder, f, doc, url, old);
  } finally {
    await plain.close();
  }
});

test('what an agent could have left in an earlier version\'s store is not honoured once it is moved in', async () => {
  const { folder, f, doc, url, old } = await withEarlierStore('docs-store-legacy-planted-');
  const elsewhere = folderWith('docs-store-legacy-planted-objects-');
  // A setting that makes every commit carry another encoding, a second place for git to read objects from, and hooks.
  writeFileSync(path.join(old, 'git', 'config'), '[core]\n\trepositoryformatversion = 0\n[i18n]\n\tcommitEncoding = ISO-8859-1\n');
  writeFileSync(path.join(old, 'git', 'objects', 'info', 'alternates'), `${path.join(elsewhere, 'objects')}\n`);
  mkdirSync(path.join(old, 'git', 'hooks'));
  writeFileSync(path.join(old, 'git', 'hooks', 'pre-commit'), '#!/bin/sh\n');
  const docs = await portal({ a: folder });
  try {
    const saved = await docs.call('PUT', url, { markdown: '# Plan\n\nThree.\n', base: 2 });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const store = storeOf(folder);
    assert.equal(existsSync(path.join(store, 'git', 'objects', 'info', 'alternates')), false);
    assert.equal(existsSync(path.join(store, 'git', 'hooks')), false);
    assert.doesNotMatch(readFileSync(path.join(store, 'git', 'config'), 'utf8'), /i18n|ISO-8859-1/);
    assert.doesNotMatch(git(folder, 'cat-file', 'commit', 'HEAD'), /^encoding /m);
    assert.ok(f && doc);
  } finally {
    await docs.close();
  }
});

test('a store of an earlier version that holds a link is moved, then refused when opened, and a link is never followed', async () => {
  const { folder, f, url, old } = await withEarlierStore('docs-store-legacy-link-');
  const outside = folderWith('docs-store-legacy-link-target-', { 'config': 'not the store\'s' });
  symlinkSync(path.join(outside, 'config'), path.join(old, 'git', 'config.link'));
  for (const across of [false, true]) {
    const docs = await portal({ a: folder }, { onStep: (step) => { if (across && step === 'move') throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); } });
    try {
      const answered = await docs.call('GET', url);
      assert.equal(answered.status, 409, JSON.stringify(answered.body));
      assert.equal(readFileSync(path.join(outside, 'config'), 'utf8'), 'not the store\'s');
      if (across) {
        assert.match(answered.body.error, /could not be moved/);
        assert.ok(existsSync(path.join(old, 'git', 'config.link')), 'a copy that refuses leaves the old one as it was');
        assert.equal(existsSync(storeOf(folder)), false);
        rmSync(path.join(old, 'git', 'config.link'));
      } else {
        assert.match(answered.body.error, /not its own/);
        // Moved already; whoever made the link (or an administrator) takes it out, and the store is used again.
        rmSync(path.join(storeOf(folder), 'git', 'config.link'));
        assert.equal((await docs.call('GET', url)).status, 200);
      }
    } finally {
      await docs.close();
    }
    if (!across) {
      // The second round: the same, written anew.
      renameSync(storeOf(folder), old);
      rmSync(path.join(old, 'folder.json'));
      symlinkSync(path.join(outside, 'config'), path.join(old, 'git', 'config.link'));
    }
  }
  assert.ok(f);
});

test('a store of an earlier version that cannot be moved is refused with the reason, not used, and nothing is changed', async () => {
  const { folder, f, doc, url, old } = await withEarlierStore('docs-store-legacy-refused-');
  const before = snapshot(old);
  let failure: string | null = null;
  const docs = await portal({ a: folder }, { onStep: (step) => { if (step === 'move' && failure) throw Object.assign(new Error('refused by the system'), { code: failure }); } });
  try {
    // The rename fails.
    failure = 'EACCES';
    const answered = await docs.call('POST', `/folders/${f}/documents`, { title: 'Notes' });
    assert.equal(answered.status, 409, JSON.stringify(answered.body));
    assert.match(answered.body.error, /\.pithagoras-docs in this folder is the documents store of an earlier version/);
    assert.match(answered.body.error, /could not be moved into the portal's data folder \(EACCES\)/);
    assert.match(answered.body.error, /It is not used: move or delete it/);
    assert.equal((await docs.call('GET', url)).status, 409);
    assert.deepEqual(snapshot(old), before, 'the old store is as it was');
    assert.equal(existsSync(storeOf(folder)), false, 'and no new one was made beside it');
    assert.deepEqual(readdirSync(folder).sort(), ['.pithagoras-docs', 'documents'], 'no document was made either');
    // Listed, a folder whose store is refused says why in the portal's log and is left out.
    assert.deepEqual(await docs.listed(), []);
    assert.match(docs.logged.join('\n'), /could not be listed: .*could not be moved/);
    // Whatever stopped it is gone: the same store is moved in.
    failure = null;
    await assertMoved(docs, folder, f, doc, url, old);
  } finally {
    await docs.close();
  }
});

test('a store of an earlier version that is a link, a file or not the portal\'s own is refused, and what a link leads to is left alone', async () => {
  const folder = folderWith('docs-store-legacy-linked-', { 'documents/plan.md': '# Plan\n' });
  const real = folderWith('docs-store-legacy-linked-real-', { 'git/HEAD': 'ref: refs/heads/main\n' });
  const docs = await portal({ a: folder });
  const f = folderIdOf(folder);
  try {
    for (const [what, make] of [
      ['a link to a folder', () => symlinkSync(real, path.join(folder, '.pithagoras-docs'))],
      ['a file', () => writeFileSync(path.join(folder, '.pithagoras-docs'), 'not a store')],
    ] as const) {
      make();
      const answered = await docs.call('POST', `/folders/${f}/documents`, { title: 'Notes' });
      assert.equal(answered.status, 409, `${what}: ${JSON.stringify(answered.body)}`);
      assert.match(answered.body.error, /could not be moved into the portal's data folder \(it is a link or a file, not a folder\)/);
      assert.equal(existsSync(storeOf(folder)), false, what);
      assert.deepEqual(readdirSync(real), ['git'], 'what the link leads to is as it was');
      assert.equal(readFileSync(path.join(real, 'git', 'HEAD'), 'utf8'), 'ref: refs/heads/main\n');
      rmSync(path.join(folder, '.pithagoras-docs'));
    }
    // Taken away, the folder gets a store of its own.
    assert.equal((await docs.call('POST', `/folders/${f}/documents`, { title: 'Notes' })).status, 201);
  } finally {
    await docs.close();
  }
});

test('a store of an earlier version that cannot be written anew leaves the old one whole and no leftover in the data folder, and is moved when it can', async () => {
  const { folder, f, doc, url, old } = await withEarlierStore('docs-store-legacy-pipe-');
  // Something in it that is no file: a pipe (and nothing waits at it).
  execFileSync('mkfifo', [path.join(old, 'git', 'objects', 'info', 'pipe')]);
  const before = snapshot(old);
  const docs = await portal({ a: folder }, { onStep: (step) => { if (step === 'move') throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); } });
  try {
    const answered = await Promise.race([docs.call('GET', url), new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000).unref())]);
    assert.ok(answered, 'answered, not waiting at the pipe');
    assert.equal(answered.status, 409, JSON.stringify(answered.body));
    assert.match(answered.body.error, /could not be moved into the portal's data folder \(pipe is a link or something that is not a file\)/);
    assert.deepEqual(snapshot(old), before, 'the old one is whole');
    assert.deepEqual(readdirSync(DATA).filter((name) => name.startsWith('.moving') || name === f), [], 'nothing left in the data folder');
    rmSync(path.join(old, 'git', 'objects', 'info', 'pipe'));
    await assertMoved(docs, folder, f, doc, url, old);
  } finally {
    await docs.close();
  }
});

test('a store in the data folder wins over a leftover `.pithagoras-docs`, which is not touched, and the log says to remove it', async () => {
  const { folder, docs, url } = await withDocument('docs-store-legacy-both-');
  await docs.close();
  mkdirSync(path.join(folder, '.pithagoras-docs'));
  writeFileSync(path.join(folder, '.pithagoras-docs', 'left'), 'a copy somebody kept');
  // Opened again, as when the portal starts: the store is there, and the leftover is said.
  const again = await portal({ a: folder });
  try {
    assert.equal((await again.call('PUT', url, { markdown: '# Plan\n\nTwo.\n', base: 1 })).status, 200);
    assert.equal((await again.listed()).length, 1);
    assert.equal(readFileSync(path.join(folder, '.pithagoras-docs', 'left'), 'utf8'), 'a copy somebody kept');
    assert.equal(commits(folder), 2);
    assert.match(again.logged.join('\n'), /\.pithagoras-docs in .* is not used, as the store in the portal's data folder is: remove it/);
  } finally {
    await again.close();
  }
});

test('a store that something opened to the group while the portal ran (a recursive chmod, a restore) is closed and its git settings written new before git runs on it', async () => {
  const { folder, docs, url } = await withDocument('docs-store-loosened-');
  try {
    assert.equal((await docs.call('PUT', url, { markdown: '# Plan\n\nTwo.\n', base: 1 })).status, 200);
    const store = storeOf(folder);
    // What an agent that could write there would leave: a setting, and a second place for git to read its objects from.
    execFileSync('chmod', ['-R', 'g+rwX', store]);
    writeFileSync(path.join(store, 'git', 'config'), '[core]\n\trepositoryformatversion = 0\n[trace2]\n\tnormalTarget = /tmp/planted\n');
    writeFileSync(path.join(store, 'git', 'objects', 'info', 'alternates'), '/tmp\n');
    writeFileSync(path.join(store, 'git', 'commondir'), '/tmp\n');
    assert.notDeepEqual(loose(store), []);
    // The store the portal holds is not the one it was: a request is not run on it as it is.
    assert.equal((await docs.call('GET', url)).status, 200);
    assert.deepEqual(loose(store), []);
    assert.doesNotMatch(readFileSync(path.join(store, 'git', 'config'), 'utf8'), /trace2|planted/);
    assert.equal(existsSync(path.join(store, 'git', 'objects', 'info', 'alternates')), false);
    assert.equal(existsSync(path.join(store, 'git', 'commondir')), false);
    assert.equal(git(folder, 'show', 'HEAD:plan.md'), '# Plan\n\nTwo.');
  } finally {
    await docs.close();
  }
});

test('a folder git reads from that an agent filled is taken away with what is in it, through the folders opened, and nothing else', async () => {
  const { folder, docs, url } = await withDocument('docs-store-hooks-');
  await docs.close();
  const store = storeOf(folder);
  const outside = folderWith('docs-store-hooks-outside-', { 'victim.txt': 'not the store' });
  mkdirSync(path.join(store, 'git', 'hooks', 'sub', 'deep'), { recursive: true });
  writeFileSync(path.join(store, 'git', 'hooks', 'sub', 'deep', 'pre-commit'), '#!/bin/sh\n');
  writeFileSync(path.join(store, 'git', 'hooks', 'post-commit'), '#!/bin/sh\n');
  const again = await portal({ a: folder });
  try {
    assert.equal((await again.call('GET', url)).status, 200);
    assert.equal(existsSync(path.join(store, 'git', 'hooks')), false);
    assert.equal(readFileSync(path.join(outside, 'victim.txt'), 'utf8'), 'not the store');
    assert.equal(git(folder, 'show', 'HEAD:plan.md'), '# Plan\n\nOne.');
  } finally {
    await again.close();
  }
});

test('a store opened to others in the middle of a request is not run git on for the rest of it', async () => {
  let opened = false;
  const folder = folderWith('docs-store-midway-', { 'documents/.keep': '' });
  const docs = await portal({ a: folder }, {
    onStep: (step) => {
      if (step === 'write' && opened) chmodSync(storeOf(folder), 0o770);
    },
  });
  try {
    const f = folderIdOf(folder);
    const made = await docs.call('POST', `/folders/${f}/documents`, { title: 'Plan', markdown: '# Plan\n' });
    assert.equal(made.status, 201);
    opened = true;
    const url = `/folders/${f}/documents/${made.body.id}`;
    const saved = await docs.call('PUT', url, { markdown: '# Plan\n\nTwo.\n', base: 1 });
    assert.equal(saved.status, 409, JSON.stringify(saved.body));
    assert.match(saved.body.error, /opened to others/);
    assert.equal(commits(folder), 1, 'no commit made on it');
    opened = false;
    // The next request opens it again, and puts it right.
    const read = await docs.call('GET', url);
    assert.equal(read.status, 200);
    assert.equal(read.body.revision, 2, 'the file that was written is taken in');
    assert.deepEqual(loose(storeOf(folder)), []);
  } finally {
    await docs.close();
  }
});

/** A `git` ahead of the real one on the portal's PATH: `before` runs (a shell script) when git is called with `when` among its arguments. */
function wrappedGit(when: string, before: string) {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const dir = scratch('docs-store-git-');
  writeFileSync(path.join(dir, 'git'), `#!/bin/sh\ncase " $* " in *" ${when} "*)\n${before}\n;; esac\nexec ${real} "$@"\n`, { mode: 0o755 });
  const was = process.env.PATH;
  process.env.PATH = `${dir}:${was}`;
  return () => void (process.env.PATH = was);
}

test('git is never handed a document\'s path: a file swapped for a link when git starts is not read, or stored', async () => {
  const secret = folderWith('docs-store-secret-file-', { 'shadow': 'root:$6$a-secret-the-agent-may-not-read\n' });
  const folder = folderWith('docs-store-swap-', { 'documents/plan.md': '# Plan\n\nWhat the agent wrote.\n' });
  const secretId = execFileSync('git', ['hash-object', path.join(secret, 'shadow')], { encoding: 'utf8' }).trim();
  // The agent, who owns the file, wins the race: the file is a link to what it may not read when git opens it.
  const restore = wrappedGit('fast-import', `for f in ${JSON.stringify(path.join(folder, 'documents'))}/*.md; do rm -f "$f"; ln -s ${JSON.stringify(path.join(secret, 'shadow'))} "$f"; done`);
  const docs = await portal({ a: folder });
  try {
    // Any request takes the file in; the file is a link by the time git runs, so it is no document to list any more.
    await docs.listed();
    assert.ok(lstatSync(path.join(folder, 'documents', 'plan.md')).isSymbolicLink(), 'the swap happened');
    const has = spawnSync('git', [`--git-dir=${path.join(storeOf(folder), 'git')}`, 'cat-file', '-e', secretId]);
    assert.notEqual(has.status, 0, 'what the link leads to is not in the store');
    // The text that was read is what is committed.
    assert.equal(git(folder, 'show', 'HEAD:plan.md'), '# Plan\n\nWhat the agent wrote.');
  } finally {
    restore();
    await docs.close();
  }
});

test('a git run that hangs is stopped, and the folder goes on with the next request', async () => {
  const folder = folderWith('docs-store-hang-', { 'documents/.keep': '' });
  const flag = path.join(scratch('docs-store-hang-flag-'), 'hang');
  writeFileSync(flag, '');
  const restore = wrappedGit('hash-object', `[ -e ${JSON.stringify(flag)} ] && exec sleep 60`);
  const docs = await portal({ a: folder }, { gitTimeoutMs: 400 });
  try {
    const f = folderIdOf(folder);
    const answered = await Promise.race([docs.call('POST', `/folders/${f}/documents`, { title: 'Plan', markdown: '# Plan\n' }), new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000).unref())]);
    assert.ok(answered, 'answered before the hung git would have ended');
    assert.equal(answered.status, 500);
    rmSync(flag);
    // The queue moved on: the document written before git hung is taken in.
    const listed = await Promise.race([docs.listed(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000).unref())]);
    assert.deepEqual(listed?.[0].documents.map((d: any) => d.name), ['plan.md']);
  } finally {
    restore();
    await docs.close();
  }
});

test('the documents a folder already has are taken in with one git run for their texts, not one each, and big ones a batch at a time', async () => {
  // 20 MB of documents of nearly 1 MB each, more than one run takes, and small ones after them.
  const files: Record<string, string> = {};
  for (let i = 0; i < 20; i++) files[`documents/big-${String(i).padStart(2, '0')}.md`] = `# Big ${i}\n\n${'x'.repeat(1_000_000)}\n`;
  for (let i = 0; i < 50; i++) files[`documents/small-${String(i).padStart(2, '0')}.md`] = `# Small ${i}\n`;
  const folder = folderWith('docs-store-batch-', files);
  const runs = path.join(scratch('docs-store-batch-runs-'), 'runs');
  writeFileSync(runs, '');
  const restoreBatch = wrappedGit('fast-import', `echo fast-import >> ${JSON.stringify(runs)}`);
  const restoreOne = wrappedGit('hash-object', `echo hash-object >> ${JSON.stringify(runs)}`);
  const docs = await portal({ a: folder });
  try {
    const [listed] = await docs.listed();
    assert.equal(listed.documents.length, 70);
    assert.ok(listed.documents.every((d: any) => d.revision === 1));
    // The first 17 MB in one run, the rest in another.
    assert.deepEqual(readFileSync(runs, 'utf8').trim().split('\n'), ['fast-import', 'fast-import']);
    // All of them in one commit, each with the text its file has: from the first run and from the second.
    assert.equal(commits(folder), 1);
    assert.equal(git(folder, 'ls-tree', '--name-only', 'HEAD').split('\n').length, 70);
    for (const name of ['big-00.md', 'big-19.md', 'small-49.md']) assert.equal(git(folder, 'show', `HEAD:${name}`), readFileSync(path.join(folder, 'documents', name), 'utf8').trim(), name);
  } finally {
    restoreOne();
    restoreBatch();
    await docs.close();
  }
});

test('the store folder swapped for another between two git runs of a request is refused, and the other one is not written to', async () => {
  let swapped = false;
  const folder = folderWith('docs-store-swap-dir-', { 'documents/.keep': '' });
  const store = storeOf(folder);
  const docs = await portal({ a: folder }, {
    onStep: (step) => {
      if (step !== 'write' || !swapped) return;
      // The agent renames the store and puts one of its own (a copy: it is its own, so only where it is does tell) in its place.
      renameSync(store, `${store}.moved`);
      cpSync(`${store}.moved`, store, { recursive: true });
    },
  });
  try {
    const f = folderIdOf(folder);
    const made = await docs.call('POST', `/folders/${f}/documents`, { title: 'Plan', markdown: '# Plan\n' });
    assert.equal(made.status, 201);
    swapped = true;
    const saved = await docs.call('PUT', `/folders/${f}/documents/${made.body.id}`, { markdown: '# Plan\n\nTwo.\n', base: 1 });
    swapped = false;
    assert.equal(saved.status, 409, JSON.stringify(saved.body));
    assert.match(saved.body.error, /replaced/);
    const count = (dir: string) => Number(execFileSync('git', [`--git-dir=${path.join(dir, 'git')}`, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }));
    assert.equal(count(store), 1, 'the one put in its place got no commit');
    assert.equal(count(`${store}.moved`), 1, 'nor the one that was held');
  } finally {
    await docs.close();
  }
});

test('a link, or a pipe, in the store is refused when it is opened: git does not follow or wait at it', async () => {
  const { folder, docs, f, url } = await withDocument('docs-store-inside-');
  await docs.close();
  const git = path.join(storeOf(folder), 'git');
  const outside = folderWith('docs-store-inside-target-', { 'config': '[core]\n\tfsmonitor = /tmp/evil\n' });
  for (const plant of [
    () => symlinkSync(path.join(outside, 'config'), path.join(git, 'config.link')),
    () => execFileSync('mkfifo', [path.join(git, 'objects', 'info', 'pipe')]),
  ]) {
    plant();
    const again = await portal({ a: folder });
    try {
      const answered = await Promise.race([again.call('GET', url), new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000).unref())]);
      assert.ok(answered, 'answered, not waiting at the pipe');
      assert.equal(answered.status, 409, JSON.stringify(answered.body));
      assert.match(answered.body.error, /not its own/);
      assert.equal(readFileSync(path.join(outside, 'config'), 'utf8'), '[core]\n\tfsmonitor = /tmp/evil\n');
    } finally {
      await again.close();
    }
    rmSync(path.join(git, 'config.link'), { force: true });
    rmSync(path.join(git, 'objects', 'info', 'pipe'), { force: true });
  }
  const fine = await portal({ a: folder });
  try {
    assert.equal((await fine.call('GET', url)).status, 200, 'and fine again without them');
    assert.ok(f);
  } finally {
    await fine.close();
  }
});
