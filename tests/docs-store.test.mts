import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express from 'express';
import docsServer from '../extensions/docs/server.js';
import { resolveInside } from '../server/src/workspace-files.ts';
import { scratch } from './helpers.mts';

/**
 * The Documents extension's store, through its server half's routes: a real
 * router in a real server, folders on disk, and git.
 */

type Answer = { status: number; body: any };

/** The server half for chats that work in these folders. `fault` breaks the next write after that step. */
async function portal(folders: Record<string, string>) {
  const router = express.Router();
  const logged: string[] = [];
  let armed: string | null = null;
  const stop = docsServer({
    extension: 'pithagoras-docs',
    log: (line: string) => logged.push(line),
    router,
    http: { json: express.json },
    files: { inside: resolveInside },
    chats: {
      list: () => Object.keys(folders).map((id) => ({ id, title: `Chat ${id}` })),
      folder: (id: string) => realpathSync(folders[id]),
    },
  }, {
    dependencies: async () => true,
    faults: {
      after(step: string) {
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

/** git, on the store's own repository. */
const git = (folder: string, ...args: string[]) =>
  execFileSync('git', [`--git-dir=${path.join(folder, '.pithagoras-docs', 'git')}`, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
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

    // The store keeps itself to itself.
    assert.equal(statSync(path.join(folder, '.pithagoras-docs')).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(folder, '.pithagoras-docs', 'git')).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(folder, '.pithagoras-docs', 'docs.sqlite')).mode & 0o777, 0o600);
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
        assert.deepEqual(answer.body, { error: 'There is no such document' });
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
      assert.equal(existsSync(path.join(empty, '.pithagoras-docs')), false);
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
    writeFileSync(path.join(folder, '.pithagoras-docs', 'git', 'index.lock'), '');
    // Not the store's: kept.
    writeFileSync(path.join(folder, 'documents', '.notes.tmp'), 'the agent\'s');
    assert.equal((await docs.call('PUT', url, { markdown: '# Plan\n\nTwo.\n', base: 1 })).body.revision, 2);
    assert.equal(existsSync(temp), false);
    assert.equal(existsSync(path.join(folder, '.pithagoras-docs', 'git', 'index.lock')), false);
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
  for (const file of readdirSync(path.join(folder, '.pithagoras-docs'))) if (file.startsWith('docs.sqlite')) rmSync(path.join(folder, '.pithagoras-docs', file));
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
  // Checked with the very chown the test needs: a namespace that starts can still
  // refuse to give a file to another id (no subordinate ids mapped, no CAP_CHOWN).
  const probeDir = scratch('docs-owner-probe-');
  const probe = spawnSync('unshare', ['--map-auto', '--map-root-user', 'sh', '-c', 'touch "$1" && chown 1234:1235 "$1"', 'sh', path.join(probeDir, 'probe')], { encoding: 'utf8' });
  rmSync(probeDir, { recursive: true, force: true });
  if (probe.status !== 0) return t.skip(`cannot chown to other ids in a user namespace here: ${probe.stderr?.trim() || probe.error?.message || `exit ${probe.status}`}`);
  const script = `
    import express from 'express';
    import { chownSync, chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
    import path from 'node:path';
    import docsServer from ${JSON.stringify(new URL('../extensions/docs/server.js', import.meta.url).href)};
    import { resolveInside } from ${JSON.stringify(new URL('../server/src/workspace-files.ts', import.meta.url).href)};
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
      const router = express.Router();
      const stop = docsServer({ log: (line) => console.error(line), router, http: { json: express.json }, files: { inside: resolveInside },
        chats: { list: () => [{ id: 'a', title: 'A' }], folder: () => folder } }, { dependencies: async () => true });
      const app = express(); app.use(router);
      const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
      const base = 'http://127.0.0.1:' + server.address().port;
      const call = async (method, url, body) => (await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })).json();
      const [listed] = (await call('GET', '/folders')).folders;
      const doc = listed.documents[0];
      const saved = await call('PUT', '/folders/' + listed.id + '/documents/' + doc.id, { markdown: '# Plan\\n\\nSaved by the portal.\\n', base: doc.revision });
      const made = await call('POST', '/folders/' + listed.id + '/documents', { title: 'Notes' });
      const own = (name) => { const s = statSync(path.join(folder, 'documents', name)); return [s.uid, s.gid, (s.mode & 0o777).toString(8)]; };
      const store = statSync(path.join(folder, '.pithagoras-docs'));
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
