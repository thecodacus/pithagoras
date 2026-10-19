import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mockPortal } from '@pithagoras/extension-api/testing';
import docsServer from '../server.js';
import { folderFiles } from '../../../core/server/src/folder-files.ts';
import { setAgentAccess } from '../../../core/server/src/workspace-files.ts';
import { scratch } from '../../../tests/helpers.mts';

/**
 * A folder, or a file, that the sandbox closed to the agent (root's, mode 0700 and 0600), moved by the agent to where the portal, which is root,
 * reads and writes the documents. The agent writes in its chat's folder, and a rename needs the right to write in that folder only, so it can
 * rename the closed folder to `documents`, or move the closed file into `documents/`. The store must never hold to such a folder (a person's
 * delete and rename act in the folder it holds to), nor read it, nor take such a file in: not for the agent (`doc_read`, the lists), not for the page.
 *
 * Twice. As root (`root`), the folders as the sandbox leaves them: a project is root's, with the sandbox's group on it (2775), and so is what the
 * portal made in it; the closed ones are `root:root`; and the agent is a user of its own that is in the sandbox group, and moves the folders as a
 * process of its own (`setpriv`, as the sandbox runs it). And as any other user (`modes`), where the agent is another user than the test's and
 * the folders stand for those by their modes (it is everyone to them). The portal's `files` is the real one in both, told who the agent is.
 */

const DATA = scratch('docs-closed-data-');
const AGENT = 10103;
/** The sandbox's group, which every agent is in. */
const SHARED = 10010;
const root = process.getuid?.() === 0;
const flavours = root ? [false, true] : [false];
const named = (real: boolean) => (real ? 'root' : 'modes');
/** The agent, as the sandbox runs it. Another user than the test's, if the test is not root. */
const THE_AGENT = (real: boolean) => (real ? { uid: AGENT, groups: [AGENT, SHARED] } : { uid: 61234, groups: [61234, 61235] });
const setpriv = root && spawnSync('setpriv', ['--version']).status === 0;
after(() => setAgentAccess(() => undefined));
/** As the portal tells it: the agents of the chats named, and none for none (which refuses): a call that does not say whose chats work in the folder is refused. */
const agentsOf = (real: boolean) => (chats: readonly string[]) => (chats.length ? [THE_AGENT(real)] : []);

/** What the agent is told by doc_list of a documents folder it may not use: that it is closed, not that there are no documents. */
const CLOSED_TO_IT = /^closed: the documents folder of this project is closed to this chat's agent/;
const isClosed = (listed: Result) => {
  assert.equal(listed.ok, false, JSON.stringify(listed));
  assert.match((listed as any).error, CLOSED_TO_IT);
};

const SECRET = '# Secret\n\nThe sandbox kept this from the agent.\n';
const SECRET_PLAN = '# Plan\n\nThe sandbox kept this from the agent, too.\n';
const SECRETS = /sandbox kept this/;

type Result = { ok: true; text: string; details: any } | { ok: false; error: string };

/** `portal.files`, with something the agent does right before the call of that name (once), for an agent that is quick. */
function racing(before: Record<string, () => void> = {}): typeof folderFiles {
  const wrapped: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(folderFiles)) {
    wrapped[name] = (...args: any[]) => {
      const hook = before[name];
      if (hook) {
        delete before[name];
        hook();
      }
      return (fn as any)(...args);
    };
  }
  return wrapped as typeof folderFiles;
}

/**
 * The server half for sessions that work in these folders (by id: where each was made to work), with the agent's tools, and the person's routes. As the
 * portal has them: `chats.list` gives the tasks alone, `chats.inFolder` the sessions of every kind that work in a folder, and `chats.folder` resolves a
 * stored workspace now, for a session of any kind. `kinds`: a session is a task unless it is said what else it is. `folderOf`: where a session's
 * folder leads now, where a test makes it lead somewhere else.
 */
async function portal(chats: Record<string, string>, files: typeof folderFiles = folderFiles, opts: { kinds?: Record<string, string>; folderOf?: (id: string) => string } = {}) {
  const mock = await mockPortal({ extension: 'pithagoras-docs', executor: 'host', chats, dataDir: DATA, files, kinds: opts.kinds, folderOf: opts.folderOf });
  await mock.start(docsServer, { pollMs: 0 });
  const { call } = await mock.serve();
  /** What the agent of a chat gets when it calls a tool: its text and details, or the refusal it reads. */
  const agent = (chat: string) => async (name: string, params: unknown): Promise<Result> => {
    const result = await mock.pi(chat).call(name, params);
    return result.error === null ? { ok: true, text: result.text as string, details: result.details } : { ok: false, error: result.error };
  };
  /** A session that comes after, as a routine run does. */
  const addChat = (id: string, folder: string) => mock.addChat(id, folder);
  return { call, agent, addChat, close: () => mock.stop() };
}

const folderIdOf = (folder: string) => createHash('sha256').update(folder).digest('hex').slice(0, 16);
const storeOf = (folder: string) => path.join(DATA, folderIdOf(folder), 'docs.sqlite');

/** The folder the store holds to, `{ dev, ino }`, or nothing before it holds to one (or has no store). */
async function pinOf(folder: string) {
  if (!existsSync(storeOf(folder))) return null;
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(storeOf(folder), { readonly: true });
  try {
    const value = (db.prepare("SELECT value FROM meta WHERE key = 'documents'").get() as { value: string } | undefined)?.value;
    return value ? JSON.parse(value) : null;
  } finally {
    db.close();
  }
}

/** A store as an earlier version left it: it knows no documents folder to hold to. */
async function forgetPin(folder: string) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(storeOf(folder));
  try {
    db.prepare("DELETE FROM meta WHERE key = 'documents'").run();
  } finally {
    db.close();
  }
}

const idOf = (place: string) => {
  const stat = statSync(place, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
};

/**
 * A chat's folder with `closed` in it (the sandbox's: a `secret.md`, and a `plan.md` of the name of a document the agent's folder has), a
 * closed file `creds.md` beside it, and `documents`, the agent's, unless `documents` is false. What the agent does, as a process of its own where
 * there is `setpriv`: `swap` puts its documents folder aside (if it has one) and the closed one in its place, `swapBack` undoes it, `moveIn`
 * moves the closed file into `documents/`. The files are told who the agent is.
 */
function scene(prefix: string, real: boolean, { documents = true } = {}) {
  const folder = realpathSync(scratch(prefix));
  const dir = path.join(folder, 'documents');
  const closed = path.join(folder, 'closed');
  const creds = path.join(folder, 'creds.md');
  mkdirSync(closed);
  writeFileSync(path.join(closed, 'secret.md'), SECRET);
  writeFileSync(path.join(closed, 'plan.md'), SECRET_PLAN);
  writeFileSync(creds, SECRET);
  if (documents) mkdirSync(dir);
  if (real) {
    // A project is root's with the sandbox's group on it, and what the portal makes in it the same; the none rule makes root:root 0700 and 0600.
    for (const where of documents ? [folder, dir] : [folder]) {
      chownSync(where, 0, SHARED);
      chmodSync(where, 0o2775);
    }
    for (const where of [closed, path.join(closed, 'secret.md'), path.join(closed, 'plan.md'), creds]) {
      chownSync(where, 0, 0);
      chmodSync(where, statSync(where).isDirectory() ? 0o700 : 0o600);
    }
  } else {
    for (const where of documents ? [folder, dir] : [folder]) chmodSync(where, 0o777);
    for (const where of [closed, path.join(closed, 'secret.md'), path.join(closed, 'plan.md'), creds]) chmodSync(where, statSync(where).isDirectory() ? 0o700 : 0o600);
  }
  setAgentAccess(agentsOf(real));
  const aside = `${dir}.aside`;
  /** What the agent does, as the agent where it can: a user of its own, in its group and the sandbox's. */
  const mv = (from: string, to: string) => {
    if (setpriv && real) execFileSync('setpriv', [`--reuid=${AGENT}`, `--regid=${AGENT}`, `--groups=${AGENT},${SHARED}`, '--inh-caps=-all', '--', 'mv', from, to]);
    else renameSync(from, to);
  };
  const swap = () => {
    if (existsSync(dir)) mv(dir, aside);
    mv(closed, dir);
  };
  const swapBack = () => {
    mv(dir, closed);
    if (existsSync(aside)) mv(aside, dir);
  };
  const moveIn = () => mv(creds, path.join(dir, 'creds.md'));
  /** The closed folder is as the sandbox left it, wherever it is. */
  const intact = (where: string) => {
    assert.equal(readFileSync(path.join(where, 'secret.md'), 'utf8'), SECRET);
    assert.equal(readFileSync(path.join(where, 'plan.md'), 'utf8'), SECRET_PLAN);
    assert.deepEqual(readdirSync(where).sort(), ['plan.md', 'secret.md']);
  };
  return { folder, dir, aside, closed, creds, swap, swapBack, moveIn, intact, f: folderIdOf(folder) };
}

/** A folder with a document called Plan made through the page, and the portal that did it (stopped, when `stop`). */
async function withPlan(prefix: string, real: boolean, { stop = false } = {}) {
  const s = scene(prefix, real);
  const docs = await portal({ a: s.folder });
  const made = await docs.call('POST', `/folders/${s.f}/documents`, { title: 'Plan', markdown: '# Plan\n\nOurs.\n' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.id as string;
  const own = idOf(s.dir);
  assert.deepEqual(await pinOf(s.folder), own, 'the store holds to the folder it made the document in');
  if (stop) await docs.close();
  return { ...s, docs, id, url: `/folders/${s.f}/documents/${id}`, own };
}

/**
 * A project whose every folder is the agent's, below a folder the sandbox closed: the "none" rule is `root:root 0700` on the folder it names, and what
 * is inside keeps the group's rights. The kernel needs search on each folder of a path, so the agent can reach nothing in it by a path, and the
 * portal, which reaches the project as root, must not read it, list it, take it in or hold to it for the agent.
 */
for (const real of flavours) {
  test(`[${named(real)}] a project below a closed folder is not read, listed, taken in or held to, though every folder in it is the agent's: and is as soon as the folder above is open`, async () => {
    const top = realpathSync(scratch('docs-closed-above-'));
    chmodSync(top, 0o755);
    const outer = path.join(top, 'outer');
    const folder = path.join(outer, 'proj');
    const dir = path.join(folder, 'documents');
    mkdirSync(dir, { recursive: true });
    for (const where of [folder, dir]) {
      if (real) chownSync(where, 0, SHARED);
      chmodSync(where, real ? 0o2775 : 0o777);
    }
    if (real) chownSync(outer, 0, 0);
    setAgentAccess(agentsOf(real));
    const f = folderIdOf(folder);
    const docs = await portal({ a: folder });
    try {
      // Open, the project is the agent's as ever.
      chmodSync(outer, 0o755);
      const made = await docs.call('POST', `/folders/${f}/documents`, { title: 'Plan', markdown: '# Plan\n\nOurs.\n' });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      const url = `/folders/${f}/documents/${made.body.id}`;
      assert.equal(existsSync(path.join(dir, 'plan.md')), true);
      assert.match(JSON.stringify(await docs.agent('a')('doc_list', {})), /"Plan"/);
      const own = idOf(dir);
      assert.deepEqual(await pinOf(folder), own);
      // The folder above is closed (the none rule): nothing in the project is the agent's to reach, whatever the folders below say.
      chmodSync(outer, 0o700);
      isClosed(await docs.agent('a')('doc_list', {}));
      assert.doesNotMatch(JSON.stringify((await docs.call('GET', '/folders')).body), /Plan|plan/);
      assert.equal((await docs.agent('a')('doc_read', { id: made.body.id })).ok, false, 'not read for the agent');
      const read = await docs.call('GET', url);
      assert.equal(read.status, 409, JSON.stringify(read.body));
      assert.doesNotMatch(JSON.stringify(read.body), /Ours/);
      for (const [what, answer] of [
        ['save', await docs.call('PUT', url, { markdown: '# Plan\n\nChanged.\n', base: 1 })],
        ['rename', await docs.call('POST', `${url}/rename`, { name: 'other.md' })],
        ['delete', await docs.call('DELETE', url)],
        ['create', await docs.call('POST', `/folders/${f}/documents`, { title: 'Fresh', markdown: '# Fresh\n' })],
      ] as const) assert.equal(answer.status, 409, `${what}: ${JSON.stringify(answer.body)}`);
      assert.deepEqual(readdirSync(dir).sort(), ['plan.md'], 'nothing was made, renamed or removed');
      assert.equal(readFileSync(path.join(dir, 'plan.md'), 'utf8'), '# Plan\n\nOurs.\n');
      assert.deepEqual(await pinOf(folder), own, 'and the folder held to is the same');
      // Open again: the document is there, as it was.
      chmodSync(outer, 0o755);
      assert.match(JSON.stringify(await docs.agent('a')('doc_read', { id: made.body.id })), /Ours\./);
      assert.equal((await docs.call('DELETE', url)).status, 200);
    } finally {
      await docs.close();
    }
  });

  test(`[${named(real)}] a closed folder that the agent renamed to documents before anything was listed is not held to, read or listed: not by the agent's doc_list, nor by the page`, async () => {
    // A chat's folder in which Documents was never used: no store, and no documents folder of the agent's.
    const s = scene('docs-closed-fresh-', real, { documents: false });
    s.swap();
    const docs = await portal({ a: s.folder });
    try {
      const listed = await docs.agent('a')('doc_list', {});
      isClosed(listed);
      assert.doesNotMatch(JSON.stringify(listed), /Secret|sandbox kept/);
      // The person's page: nothing of it is listed either.
      const page = await docs.call('GET', '/folders');
      assert.doesNotMatch(JSON.stringify(page.body), /secret|Secret/);
      assert.equal(await pinOf(s.folder), null, 'no folder is held to');
      // The agent's own tools make nothing in it, and take nothing from it.
      const made = await docs.agent('a')('doc_create', { title: 'Mine' });
      assert.equal(made.ok, false, 'the agent\'s document is not made in a closed folder');
      assert.equal(await pinOf(s.folder), null);
      s.intact(s.dir);
    } finally {
      await docs.close();
    }
  });

  test(`[${named(real)}] a closed file that the agent moved into documents is not taken in as a document, read, listed or replaced: the others are`, async () => {
    const s = scene('docs-closed-file-', real);
    const docs = await portal({ a: s.folder });
    try {
      const agent = docs.agent('a');
      const made = await agent('doc_create', { title: 'Plan', markdown: '# Plan\n\nOurs.\n' });
      assert.ok(made.ok, JSON.stringify(made));
      s.moveIn();
      writeFileSync(path.join(s.dir, 'notes.md'), '# Notes\n\nThe agent\'s own.\n');
      const listed = await agent('doc_list', {});
      assert.ok(listed.ok, JSON.stringify(listed));
      assert.match((listed as any).text, /"Plan"/);
      assert.match((listed as any).text, /"Notes"/, 'a file of the agent\'s own is taken in as ever');
      assert.doesNotMatch(JSON.stringify(listed), /Secret|creds|sandbox kept/);
      assert.doesNotMatch(JSON.stringify((await docs.call('GET', '/folders')).body), /creds|Secret|sandbox kept/);
      assert.equal(readFileSync(path.join(s.dir, 'creds.md'), 'utf8'), SECRET);
      // Not even by a document of that name that the store has: the closed file is not read in its place, and is not written over.
      const uploaded = await docs.call('POST', `/folders/${s.f}/documents/upload`, { name: 'creds.md', markdown: '# Mine\n' });
      assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
      assert.notEqual(uploaded.body.name, 'creds.md', 'it takes another name than the closed file\'s');
      assert.equal(readFileSync(path.join(s.dir, 'creds.md'), 'utf8'), SECRET, 'the closed file is as it was');
    } finally {
      await docs.close();
    }
  });

  test(`[${named(real)}] a store that held to no folder (one from before the folder was held to) does not take the closed folder at documents as the one: a deletion does not act in it`, async () => {
    const w = await withPlan('docs-closed-unpinned-', real, { stop: true });
    await forgetPin(w.folder);
    assert.equal(await pinOf(w.folder), null);
    w.swap();
    const docs = await portal({ a: w.folder });
    try {
      // The first look at the folder after the update is the agent's, with the closed folder in place.
      const listed = await docs.agent('a')('doc_list', {});
      isClosed(listed);
      assert.doesNotMatch(JSON.stringify(listed), /Secret|sandbox kept/);
      assert.equal(await pinOf(w.folder), null, 'the closed folder is not held to');
      // And the person's deletion, which would act in the folder held to, finds none: it is refused, and the file of that name in the closed folder stays.
      const deleted = await docs.call('DELETE', w.url);
      assert.equal(deleted.status, 409, JSON.stringify(deleted.body));
      assert.match(deleted.body.error, /closed to the agent/);
      w.intact(w.dir);
      assert.equal(readFileSync(path.join(w.aside, 'plan.md'), 'utf8'), '# Plan\n\nOurs.\n', 'the agent\'s own folder is as it was');
      // Back in place, the store goes on: it holds to the agent's folder.
      w.swapBack();
      const read = await docs.call('GET', w.url);
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.deepEqual(await pinOf(w.folder), w.own);
    } finally {
      await docs.close();
    }
  });

  test(`[${named(real)}] a person's new document does not take the closed folder at documents as the one the store holds to: it is refused, the pin stays, and a deletion still acts in the agent's folder only`, async () => {
    const w = await withPlan('docs-closed-repin-', real);
    try {
      w.swap();
      // The deletion, with the closed folder in place: refused, and nothing is acted in.
      const first = await w.docs.call('DELETE', w.url);
      assert.equal(first.status, 409, JSON.stringify(first.body));
      // What the person is told to do about a replaced folder, a new document: the page's, an upload, and the agent's own.
      for (const [url, body] of [['', { title: 'Fresh', markdown: '# Fresh\n' }], ['/upload', { name: 'Upload.md', markdown: '# Upload\n' }]] as const) {
        const made = await w.docs.call('POST', `/folders/${w.f}/documents${url}`, body);
        assert.equal(made.status, 409, `${url || 'new'}: ${JSON.stringify(made.body)}`);
        assert.match(made.body.error, /closed to the agent/);
      }
      assert.equal((await w.docs.agent('a')('doc_create', { title: 'Agent' })).ok, false);
      assert.deepEqual(await pinOf(w.folder), w.own, 'the store still holds to the agent\'s folder');
      w.intact(w.dir);
      // The agent puts its folder back: the deletion is the agent's folder's, and the closed folder's file of the same name is not touched.
      w.swapBack();
      const deleted = await w.docs.call('DELETE', w.url);
      assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
      assert.equal(existsSync(path.join(w.dir, 'plan.md')), false);
      w.intact(w.closed);
    } finally {
      await w.docs.close();
    }
  });

  test(`[${named(real)}] a documents folder that the agent can read but not write in is read from and not changed in: a save, a rename and a deletion are refused with the reason, and it is not held to`, async () => {
    const w = await withPlan('docs-closed-readonly-', real, { stop: true });
    await forgetPin(w.folder);
    // The sandbox's read rule: root's, readable by everyone, writable by no one else.
    if (real) {
      chownSync(w.dir, 0, 0);
      for (const name of readdirSync(w.dir)) chownSync(path.join(w.dir, name), 0, 0);
    }
    chmodSync(w.dir, 0o755);
    for (const name of readdirSync(w.dir)) chmodSync(path.join(w.dir, name), 0o644);
    const docs = await portal({ a: w.folder });
    try {
      const read = await docs.call('GET', w.url);
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.match(read.body.markdown, /Ours\./);
      assert.match(JSON.stringify((await docs.call('GET', '/folders')).body), /Plan/);
      assert.equal(await pinOf(w.folder), null, 'a folder the agent cannot write in is not held to');
      for (const [what, answer] of [
        ['save', await docs.call('PUT', w.url, { markdown: '# Plan\n\nChanged.\n', base: 1 })],
        ['rename', await docs.call('POST', `${w.url}/rename`, { name: 'other.md' })],
        ['delete', await docs.call('DELETE', w.url)],
        ['create', await docs.call('POST', `/folders/${w.f}/documents`, { title: 'Fresh', markdown: '# Fresh\n' })],
      ] as const) {
        assert.equal(answer.status, 409, `${what}: ${JSON.stringify(answer.body)}`);
        assert.match(answer.body.error, /closed to the agent, or the agent could not write/, what);
      }
      assert.deepEqual(readdirSync(w.dir).sort(), ['plan.md'], 'nothing was made, renamed or removed');
      assert.equal(readFileSync(path.join(w.dir, 'plan.md'), 'utf8'), '# Plan\n\nOurs.\n');
    } finally {
      await docs.close();
    }
  });

  test(`[${named(real)}] a folder swapped in while the folder is looked at to be held to is not held to: the identity is taken from the folder the portal holds`, async () => {
    const w = await withPlan('docs-closed-held-', real, { stop: true });
    await forgetPin(w.folder);
    let swapped = false;
    const docs = await portal({ a: w.folder }, racing({ identity: () => { swapped = true; w.swap(); } }));
    try {
      // The first look: the folder is the agent's when it is found, and the closed one by the time it is given an identity.
      const page = await docs.call('GET', '/folders');
      assert.equal(page.status, 200, JSON.stringify(page.body));
      assert.ok(swapped, 'the identity was asked of the portal, which holds the folder');
      assert.equal(await pinOf(w.folder), null, 'the folder that was swapped in is not held to');
      const read = await docs.call('GET', w.url);
      assert.equal(read.status, 409, JSON.stringify(read.body));
      assert.doesNotMatch(JSON.stringify(read.body), SECRETS);
      w.intact(w.dir);
    } finally {
      await docs.close();
    }
  });

  test(`[${named(real)}] a closed folder at documents is not read for the agent or the page: doc_read, doc_list and the history refuse it, and what it holds is not taken in`, async () => {
    const w = await withPlan('docs-closed-read-', real);
    try {
      const commits = async () => (await w.docs.call('GET', `${w.url}/history`)).body.revisions.length;
      assert.equal(await commits(), 1);
      w.swap();
      const agent = w.docs.agent('a');
      // The closed folder has a plan.md of the document's name, with another text, and a secret.md that no document is.
      const read = await agent('doc_read', { id: w.id });
      assert.equal(read.ok, false, 'the document is not read from the closed folder');
      assert.doesNotMatch(JSON.stringify(read), SECRETS);
      const listed = await agent('doc_list', {});
      isClosed(listed);
      assert.doesNotMatch(JSON.stringify(listed), /Secret|sandbox kept|secret\.md/);
      // The person's page: not read, not listed, not taken in.
      const page = await w.docs.call('GET', w.url);
      assert.equal(page.status, 409, JSON.stringify(page.body));
      assert.doesNotMatch(JSON.stringify(page.body), SECRETS);
      assert.doesNotMatch(JSON.stringify((await w.docs.call('GET', '/folders')).body), /secret|Secret|sandbox kept/);
      assert.doesNotMatch(JSON.stringify((await w.docs.call('GET', '/chats/a/documents')).body), /secret|Secret|sandbox kept/);
      assert.equal((await w.docs.call('GET', `${w.url}/history`)).status, 200);
      assert.equal(await commits(), 1, 'nothing of the closed folder was taken in as a revision');
      assert.deepEqual(await pinOf(w.folder), w.own);
      w.intact(w.dir);
      // Back in place, the document is the agent's, as it was.
      w.swapBack();
      const again = await agent('doc_read', { id: w.id });
      assert.ok(again.ok, JSON.stringify(again));
      assert.match((again as any).text, /Ours\./);
      assert.equal(await commits(), 1);
    } finally {
      await w.docs.close();
    }
  });
}

test('[root] the agents of every chat that works in the folder are asked, not one: a folder that one of them could not use is not read for the others', { skip: !root }, async () => {
  const w = await withPlan('docs-closed-chats-', true, { stop: true });
  // Two agents work in the folder: the first is in the sandbox's group, the other is not.
  const OTHER = { uid: AGENT + 5, groups: [AGENT + 5] };
  const asked: string[][] = [];
  setAgentAccess((chats) => {
    asked.push([...chats]);
    return chats.map((id) => (id === 'a' ? THE_AGENT(true) : OTHER));
  });
  chmodSync(w.dir, 0o2770);
  for (const name of readdirSync(w.dir)) chmodSync(path.join(w.dir, name), 0o660);
  // (The second chat's stored workspace is another spelling of the same folder: the portal gives one session for each stored workspace.)
  const both = await portal({ a: w.folder, b: `${w.folder}/.` });
  try {
    const listed = await both.agent('a')('doc_list', {});
    isClosed(listed);
    assert.deepEqual(asked.at(-1)?.sort(), ['a', 'b'], 'the chats of the folder are named, each of them');
    assert.equal((await both.call('GET', w.url)).status, 409);
    assert.equal((await both.call('DELETE', w.url)).status, 409);
    assert.equal(readFileSync(path.join(w.dir, 'plan.md'), 'utf8'), '# Plan\n\nOurs.\n');
  } finally {
    await both.close();
  }
  const alone = await portal({ a: w.folder });
  try {
    assert.match(JSON.stringify(await alone.agent('a')('doc_list', {})), /"Plan"/, 'with its own chat alone the folder is used');
    assert.equal((await alone.call('GET', w.url)).status, 200);
  } finally {
    await alone.close();
  }
});

/**
 * Two agents, as the sandbox runs them: A, and B, whose home is closed to every other agent (`root:` B's group 2770 as root; as another user, 0770 for a group
 * that B is in and A is not), with a `documents` folder in it. The sessions of A can lead into it by a link in a stored folder.
 */
function twoAgents(real: boolean, prefix: string, { documents = true } = {}) {
  const A = THE_AGENT(real);
  const B = real ? { uid: AGENT + 1, groups: [AGENT + 1] } : { uid: 61236, groups: [61236, process.getgid!()] };
  const top = realpathSync(scratch(prefix));
  chmodSync(top, 0o755);
  const home = path.join(top, 'home-b');
  const dir = path.join(home, 'documents');
  mkdirSync(documents ? dir : home, { recursive: true });
  for (const where of documents ? [home, dir] : [home]) {
    if (real) chownSync(where, 0, AGENT + 1);
    chmodSync(where, real ? 0o2770 : 0o770);
  }
  const own = path.join(top, 'own-a');
  mkdirSync(own);
  chmodSync(own, real ? 0o2775 : 0o777);
  if (real) chownSync(own, 0, SHARED);
  return { A, B, top, home, dir, own };
}
/** What the portal says of sessions: the agents they are run as, and a refusal for one it does not know. */
const runAs = (who: Record<string, { uid: number; groups: number[] }>) => (chats: readonly string[]) =>
  chats.map((id) => {
    if (!who[id]) throw new Error('No such chat');
    return who[id];
  });

for (const real of flavours) {
  test(`[${named(real)}] a session that is not a task, whose stored folder leads into another agent's home, is checked as its own agent: the document there is not listed, read or made, by it`, async () => {
    const { A, B, top, home, dir } = twoAgents(real, 'docs-closed-routine-');
    const link = path.join(top, 'leads-there');
    symlinkSync(home, link);
    setAgentAccess(runAs({ tb: B, r1: A }));
    // B's own task chat works in its home. A routine run of A, which has a stored folder that is a link to it, comes after (the portal lists tasks only, and the
    // run is none): once it is there, the folder is one that A's agent works in too, and every agent must be able to use it.
    const chats: Record<string, string> = { tb: home };
    const kinds: Record<string, string> = {};
    const docs = await portal(chats, folderFiles, { kinds });
    try {
      const made = await docs.agent('tb')('doc_create', { title: 'Mine', markdown: '# Mine\n\nB\'s own.\n' });
      assert.ok(made.ok, JSON.stringify(made));
      assert.deepEqual(readdirSync(dir), ['mine.md'], 'the agent whose home it is uses it');
      docs.addChat('r1', link);
      kinds.r1 = 'routine';
      const routine = docs.agent('r1');
      const listed = await routine('doc_list', {});
      isClosed(listed);
      assert.doesNotMatch(JSON.stringify(listed), /Mine/);
      const read = await routine('doc_read', { id: (made as any).details.id });
      assert.equal(read.ok, false);
      assert.doesNotMatch(JSON.stringify(read), /B's own/);
      assert.equal((await routine('doc_create', { title: 'Theirs' })).ok, false, 'nor is a document made in it');
      assert.deepEqual(readdirSync(dir), ['mine.md'], 'nothing was made');
    } finally {
      await docs.close();
    }
  });

  test(`[${named(real)}] the folder a tool names is the same one the sessions are listed for: a path that leads somewhere else the next time it is resolved does not take the caller out of the agents that are asked`, async () => {
    const { A, B, home, dir, own } = twoAgents(real, 'docs-closed-twice-');
    setAgentAccess(runAs({ tb: B, ta: A }));
    let first = true;
    // A task chat of A, whose folder leads into B's home the first time it is resolved (what the tool does) and to its own after (what listing the sessions of the folder does).
    const docs = await portal({ tb: home, ta: own }, folderFiles, { folderOf: (id) => (id === 'ta' ? (first ? ((first = false), home) : own) : home) });
    try {
      const made = await docs.agent('tb')('doc_create', { title: 'Mine', markdown: '# Mine\n\nB\'s own.\n' });
      assert.ok(made.ok, JSON.stringify(made));
      first = true;
      const listed = await docs.agent('ta')('doc_list', {});
      isClosed(listed);
      assert.equal(first, false, 'the swap was made: the tool resolved the folder');
      assert.doesNotMatch(JSON.stringify(listed), /Mine/);
      first = true;
      const read = await docs.agent('ta')('doc_read', { id: (made as any).details.id });
      assert.equal(read.ok, false);
      assert.doesNotMatch(JSON.stringify(read), /B's own/);
      first = true;
      assert.equal((await docs.agent('ta')('doc_create', { title: 'Theirs' })).ok, false);
      assert.deepEqual(readdirSync(dir), ['mine.md']);
    } finally {
      await docs.close();
    }
  });

  test(`[${named(real)}] what the agent of a session that is not a task could not read is not taken in, though the task chat's agent could: what is read for one is handed to the others`, async () => {
    const { A, B, top } = twoAgents(real, 'docs-closed-kinds-');
    const folder = path.join(top, 'shared');
    const dir = path.join(folder, 'documents');
    mkdirSync(dir, { recursive: true });
    for (const where of [folder, dir]) chmodSync(where, 0o777);
    // A file only B can read (its own group's), in a folder both can use.
    const file = path.join(dir, 'secret.md');
    writeFileSync(file, SECRET);
    if (real) chownSync(file, 0, AGENT + 1);
    chmodSync(file, 0o640);
    setAgentAccess(runAs({ tb: B, ra: A }));
    // B has a task chat in the folder; A has a routine run there, which the list of tasks does not give.
    // (Its stored workspace is another spelling of the same folder: the portal gives one session for each stored workspace, and each workspace has one agent.)
    const docs = await portal({ tb: folder, ra: `${folder}/.` }, folderFiles, { kinds: { ra: 'routine' } });
    try {
      const listed = await docs.call('GET', '/folders');
      assert.equal(listed.status, 200, JSON.stringify(listed.body));
      assert.doesNotMatch(JSON.stringify(listed.body), /secret|Secret/, 'the file is not taken in: the routine run\'s agent could not read it');
      assert.doesNotMatch(JSON.stringify((await docs.call('GET', '/chats/tb/documents')).body), /secret|Secret/);
      assert.equal(readFileSync(file, 'utf8'), SECRET);
    } finally {
      await docs.close();
    }
  });

  test(`[${named(real)}] a session whose agent may not write in the folder it leads to makes no documents folder there, and what it is told does not say whether there is one`, async () => {
    // Two homes of B, one with a `documents` folder and one without, each reached by a routine run of A through a link: the portal, which is root, could
    // make the folder in the one that has none, and a look at what stands there tells A what it cannot look at itself.
    const told: string[][] = [];
    for (const documents of [true, false]) {
      const { A, top, home } = twoAgents(real, `docs-closed-${documents ? 'has' : 'hasnot'}-`, { documents });
      const link = path.join(top, 'leads-there');
      symlinkSync(home, link);
      setAgentAccess(runAs({ r1: A }));
      const docs = await portal({ r1: link }, folderFiles, { kinds: { r1: 'routine' } });
      try {
        const agent = docs.agent('r1');
        const listed = await agent('doc_list', {});
        isClosed(listed);
        const made = await agent('doc_create', { title: 'Theirs' });
        assert.equal(made.ok, false, JSON.stringify(made));
        // Nothing was made in B's home, whichever it was.
        assert.deepEqual(readdirSync(home), documents ? ['documents'] : [], `documents ${documents ? 'was' : 'was not'} there, and is as it was`);
        if (documents) assert.deepEqual(readdirSync(path.join(home, 'documents')), []);
        for (const [what, result] of [['create', made], ['list', listed]] as const) {
          const known = result as { ok: false; error: string };
          assert.match(known.error, /closed to/, what);
        }
        told.push([(listed as any).error, (made as any).error]);
      } finally {
        await docs.close();
      }
    }
    assert.deepEqual(told[0], told[1], 'what the agent is told is the same, whether or not there is a documents folder in the folder it may not look into');
  });

  for (const kind of ['routine', 'agent', 'heartbeat']) {
    test(`[${named(real)}] a session of kind ${kind} alone in a folder, with no task chat in it, uses Documents as a task chat does: its agent is asked, and it can make, list and read a document`, async () => {
      const w = scene(`docs-closed-${kind}-`, real, { documents: false });
      setAgentAccess(runAs({ s: THE_AGENT(real) }));
      const docs = await portal({ s: w.folder }, folderFiles, { kinds: { s: kind } });
      try {
        const agent = docs.agent('s');
        const made = await agent('doc_create', { title: 'Plan', markdown: '# Plan\n\nOurs.\n' });
        assert.ok(made.ok, JSON.stringify(made));
        assert.equal(readFileSync(path.join(w.folder, 'documents', 'plan.md'), 'utf8'), '# Plan\n\nOurs.\n');
        const listed = await agent('doc_list', {});
        assert.ok(listed.ok, JSON.stringify(listed));
        assert.match((listed as any).text, /"Plan"/);
        assert.match(JSON.stringify(await agent('doc_read', { id: (made as any).details.id })), /Ours\./);
        assert.deepEqual(await pinOf(w.folder), idOf(path.join(w.folder, 'documents')), 'the folder it made is the one held to');
      } finally {
        await docs.close();
      }
    });
  }
}
