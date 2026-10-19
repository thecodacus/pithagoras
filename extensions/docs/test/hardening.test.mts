import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express from 'express';
import docsServer from '../server.js';
import { DocError, explained } from '../errors.js';
import { GitError } from '../git.js';
import { folderFiles } from '../../../core/server/src/folder-files.ts';
import { scratch } from '../../../tests/helpers.mts';

/**
 * What a person hits at the edges of the Documents extension, through its server half as the portal runs it: a document that is
 * renamed or removed while it is open, a file that is too big or that the portal may not read, a folder it may not write in, a
 * store whose git, history or database is broken, many saves at once, documents at the size limit, and a chat that never starts
 * when the agent is asked in a comment.
 */

const DATA = scratch('docs-hardening-data-');
const UI_RECEIVE = 'pithagoras:v1:ui:receive';
/** Permissions mean nothing to root: those tests are for a portal that is not. */
const unprivileged = process.getuid?.() !== 0;

interface Options { faults?: { after(step: string): void }; wakeMs?: number; wakeLimitMs?: number; tell?: (chat: string) => Promise<boolean> }

/** The server half for chats that work in these folders, with a stand-in for the portal's chats that rings a pi's bell. */
async function portal(chats: Record<string, string>, options: Options = {}) {
  const router = express.Router();
  const factories: ((pi: unknown, chat: unknown) => void)[] = [];
  const logged: string[] = [];
  const bells: Record<string, ((data: unknown) => void)[]> = {};
  const sent: Record<string, any[]> = Object.fromEntries(Object.keys(chats).map((id) => [id, []]));
  const tools = new Map<string, Map<string, any>>();
  const told: string[] = [];
  const start = (id: string) => {
    if (tools.has(id)) return tools.get(id)!;
    const mine = new Map<string, any>();
    tools.set(id, mine);
    bells[id] = [];
    const pi = {
      registerTool: (tool: any) => mine.set(tool.name, tool),
      events: { on: (channel: string, handler: (data: unknown) => void) => { if (channel === UI_RECEIVE) bells[id].push(handler); return () => {}; } },
      on: () => {},
      sendMessage: (message: any) => sent[id].push(message),
    };
    for (const factory of factories) factory(pi, { id, title: `Chat ${id}`, workspace: chats[id], status: 'idle' });
    return mine;
  };
  const stop = docsServer({
    extension: 'pithagoras-docs',
    executor: 'host',
    log: (line: string) => logged.push(line),
    router,
    http: { json: express.json },
    files: folderFiles,
    sandbox: { on: () => false },
    dataDir: () => DATA,
    chats: {
      list: () => Object.keys(chats).map((id) => ({ id, title: `Chat ${id}` })),
      folder: (id: string) => realpathSync(chats[id]),
      inFolder: (folder: string) => Object.keys(chats).filter((id) => ((() => { try { return realpathSync(chats[id]) === folder; } catch { return false; } })())).map((id) => ({ id, title: `Chat ${id}` })),
      extend: (factory: (pi: unknown, chat: unknown) => void) => void factories.push(factory),
      async tell(id: string, data: unknown) {
        told.push(id);
        if (options.tell && !(await options.tell(id))) return false;
        start(id);
        for (const ring of bells[id]) ring({ extension: 'pithagoras-docs', data });
        return true;
      },
    },
  }, { dependencies: async () => true, faults: options.faults, pollMs: 0, wakeMs: options.wakeMs ?? 25, wakeLimitMs: options.wakeLimitMs }) as () => Promise<void>;
  const app = express();
  app.use('/x', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  /** A tool of a chat's agent, called as pi calls it: its text, or the error it threw. */
  const agent = (chat: string) => async (name: string, params: unknown) => {
    try {
      const result = await start(chat).get(name)!.execute('call-1', params, undefined, undefined, {});
      return { text: result.content[0].text as string, error: null };
    } catch (e: any) {
      return { text: '', error: e.message as string };
    }
  };
  return { call, agent, sent, told, logged, close: async () => { await stop(); server.close(); } };
}

const folderIdOf = (folder: string) => createHash('sha256').update(folder).digest('hex').slice(0, 16);
const PLAN = '# Plan\n\nShip it on Friday.\n\nThe build is green.\n';

/** A folder with one document made through the page. */
async function withDocument(prefix: string, markdown = PLAN, options: Options = {}) {
  const folder = realpathSync(scratch(prefix));
  const docs = await portal({ a: folder }, options);
  const f = folderIdOf(folder);
  const made = await docs.call('POST', `/folders/${f}/documents`, { title: 'Plan', markdown });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const file = path.join(folder, 'documents', 'plan.md');
  return { folder, docs, f, id: made.body.id as string, url: `/folders/${f}/documents/${made.body.id}`, file };
}

const git = (store: string, ...args: string[]) => execFileSync('git', [`--git-dir=${path.join(store, 'git')}`, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();

/** Waits until `ready` is true: what happens in the background has no promise to wait for. */
async function until(ready: () => boolean | Promise<boolean>, what = 'it to happen') {
  for (let n = 0; n < 2000; n++) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`waited for ${what}`);
}

// A document renamed or removed while it is open

test('a document whose file was deleted while it is open is saved as its file again, on the revision the text started from', async () => {
  const { docs, folder, url, file } = await withDocument('docs-hard-gone-');
  try {
    const comment = await docs.call('POST', `${url}/threads`, { base: 1, quote: 'The build is green.', start: PLAN.indexOf('The build'), body: 'Really?' });
    assert.equal(comment.status, 201);
    rmSync(file);
    // Not there: it is not listed, and not read.
    assert.deepEqual((await docs.call('GET', '/folders')).body.folders, []);
    assert.equal((await docs.call('GET', url)).status, 404);
    // The person goes on typing in the page: their text is the document, and is written again.
    const text = `${PLAN}\nTyped after it was deleted.\n`;
    const saved = await docs.call('PUT', url, { markdown: text, base: 1 });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.recreated, true);
    assert.equal(saved.body.revision, 2);
    assert.equal(readFileSync(file, 'utf8'), text);
    // The same document: its history, and the comment on it, were not lost with the file.
    assert.deepEqual((await docs.call('GET', `${url}/history`)).body.revisions.map((r: any) => [r.revision, r.author]), [[2, 'user'], [1, 'user']]);
    assert.equal((await docs.call('GET', `${url}/threads`)).body.threads[0].comments[0].body, 'Really?');
    const [listed] = (await docs.call('GET', '/folders')).body.folders;
    assert.deepEqual(listed.documents.map((d: any) => [d.name, d.revision]), [['plan.md', 2]]);
    // A save that is not the file's making again says nothing of it.
    const next = await docs.call('PUT', url, { markdown: `${text}More.\n`, base: 2 });
    assert.equal(next.body.recreated, undefined);
    assert.deepEqual(readdirSync(path.join(folder, 'documents')), ['plan.md']);
  } finally {
    await docs.close();
  }
});

test('a document renamed while it is open is saved under its own name again, and the renamed file is another document', async () => {
  const { docs, folder, url, file } = await withDocument('docs-hard-renamed-');
  try {
    renameSync(file, path.join(folder, 'documents', 'plan-old.md'));
    const saved = await docs.call('PUT', url, { markdown: `${PLAN}\nMore.\n`, base: 1 });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.recreated, true);
    // Nothing is lost: the renamed file is taken in as a document of its own, as any Markdown file put in the folder is.
    assert.equal(readFileSync(file, 'utf8'), `${PLAN}\nMore.\n`);
    assert.equal(readFileSync(path.join(folder, 'documents', 'plan-old.md'), 'utf8'), PLAN);
    const [listed] = (await docs.call('GET', '/folders')).body.folders;
    assert.deepEqual(listed.documents.map((d: any) => [d.name, d.revision]), [['plan-old.md', 1], ['plan.md', 2]]);
  } finally {
    await docs.close();
  }
});

test('a comment on a document whose file was deleted while it is open is made on the text it last had, and follows the text when a save makes the file again', async () => {
  const { docs, url, file } = await withDocument('docs-hard-gone-comment-');
  try {
    rmSync(file);
    const made = await docs.call('POST', `${url}/threads`, { base: 1, quote: 'The build is green.', start: PLAN.indexOf('The build'), body: 'Is it?' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.quote, 'The build is green.');
    // Not in the text, and it is not made up: a passage the document never had is refused as ever.
    assert.equal((await docs.call('POST', `${url}/threads`, { base: 1, quote: 'Never written.', body: 'No' })).status, 422);
    // The thread is answered while the file is gone, and goes on being on its words when the file is made again with the text changed.
    assert.equal((await docs.call('POST', `${url}/threads/${made.body.id}/comments`, { body: 'Yes' })).status, 201);
    // The agent cannot read what is not there: asking it says why it was not, and the comment is kept.
    const asked = await docs.call('POST', `${url}/threads`, { base: 1, quote: 'Ship it on Friday.', start: PLAN.indexOf('Ship'), body: 'Still wanted, @agent?', chat: 'a' });
    assert.equal(asked.status, 201);
    await until(async () => (await docs.call('GET', `${url}/threads`)).body.threads.find((t: any) => t.id === asked.body.id).ping.state === 'failed', 'the thread to say it was not delivered');
    assert.equal((await docs.call('GET', `${url}/threads`)).body.threads.find((t: any) => t.id === asked.body.id).ping.error, 'There is no such document');
    assert.deepEqual(docs.told, []);
    const text = PLAN.replace('Ship it', 'Do ship it');
    assert.equal((await docs.call('PUT', url, { markdown: text, base: 1 })).body.recreated, true);
    const [thread] = (await docs.call('GET', `${url}/threads`)).body.threads;
    assert.equal(thread.quote, 'The build is green.');
    assert.equal(thread.start, text.indexOf('The build'));
    assert.equal(thread.orphaned, false);
    assert.equal(thread.comments.length, 2);
  } finally {
    await docs.close();
  }
});

test('the whole documents folder deleted while a document is open is made again with the document', async () => {
  const { docs, folder, url, file } = await withDocument('docs-hard-gone-folder-');
  try {
    chmodSync(path.join(folder, 'documents'), 0o750);
    rmSync(path.join(folder, 'documents'), { recursive: true });
    assert.deepEqual((await docs.call('GET', '/folders')).body.folders, []);
    const saved = await docs.call('PUT', url, { markdown: `${PLAN}\nMore.\n`, base: 1 });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.recreated, true);
    assert.equal(readFileSync(file, 'utf8'), `${PLAN}\nMore.\n`);
    // With the folder's own mode, so that the agent can write in it as before.
    assert.equal(statSync(path.join(folder, 'documents')).mode & 0o777, statSync(folder).mode & 0o777);
  } finally {
    await docs.close();
  }
});

test('a documents folder made again has the chat folder\'s mode, and a file called documents is refused as that', async () => {
  // The race between making the folder and giving it its mode (a link put in its place) is the portal's own `files.makeFolder`
  // to hold: tested with it, in core/server/test/workspace-files.test.mjs.
  const { docs, folder, url } = await withDocument('docs-hard-swap-');
  const documents = path.join(folder, 'documents');
  chmodSync(folder, 0o775);
  try {
    rmSync(documents, { recursive: true });
    writeFileSync(documents, 'a file');
    const blocked = await docs.call('PUT', url, { markdown: `${PLAN}\nMore.\n`, base: 1 });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error, 'documents in this folder is not a folder');
    assert.equal(readFileSync(documents, 'utf8'), 'a file');
    rmSync(documents);
    assert.equal((await docs.call('PUT', url, { markdown: `${PLAN}\nMore, more.\n`, base: 1 })).status, 200);
    assert.equal(statSync(documents).mode & 0o777, 0o775);
  } finally {
    await docs.close();
  }
});

test('a title whose file is gone is free for the agent: it gets a new document, not an error about one it cannot see', async () => {
  const { docs, id, file } = await withDocument('docs-hard-gone-title-');
  try {
    const agent = docs.agent('a');
    // While the file is there the title is taken, as before.
    assert.match((await agent('doc_create', { title: 'Plan' })).error ?? '', /^exists: A document called plan\.md exists already/);
    rmSync(file);
    const made = await agent('doc_create', { title: 'Plan', markdown: '# Plan\n\nNew.\n' });
    assert.equal(made.error, null);
    assert.match(made.text, /documents\/plan-2\.md, revision 1/);
    assert.equal(readFileSync(path.join(path.dirname(file), 'plan-2.md'), 'utf8'), '# Plan\n\nNew.\n');
    // The old one is not listed, and not readable, and is not mistaken for the new one.
    assert.match((await agent('doc_read', { id })).error ?? '', /^not_found: /);
    assert.deepEqual((await agent('doc_list', {})).text.match(/plan[^ ]*\.md/g), ['plan-2.md']);
  } finally {
    await docs.close();
  }
});

test('a save for a deleted document that has moved on since is a conflict with the document as it was last, and writes nothing', async () => {
  const { docs, url, file, folder } = await withDocument('docs-hard-gone-stale-');
  try {
    assert.equal((await docs.call('PUT', url, { markdown: `${PLAN}\nThe agent.\n`, base: 1 })).status, 200);
    rmSync(file);
    const stale = await docs.call('PUT', url, { markdown: `${PLAN}\nThe person.\n`, base: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.revision, 2);
    assert.equal(stale.body.markdown, `${PLAN}\nThe agent.\n`);
    assert.deepEqual(readdirSync(path.join(folder, 'documents')), []);
    // Keeping their text after theirs is what the page then does: the file is made again.
    const kept = await docs.call('PUT', url, { markdown: `${PLAN}\nThe person.\n`, base: 2 });
    assert.equal(kept.status, 200);
    assert.equal(kept.body.recreated, true);
    assert.equal(readFileSync(file, 'utf8'), `${PLAN}\nThe person.\n`);
  } finally {
    await docs.close();
  }
});

test('something else in the place of the deleted file is not written over: the save is refused and says why', async () => {
  const { docs, url, file } = await withDocument('docs-hard-inway-');
  try {
    rmSync(file);
    // A folder where the file was.
    mkdirSync(file);
    const blocked = await docs.call('PUT', url, { markdown: `${PLAN}\nMore.\n`, base: 1 });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.match(blocked.body.error, /Another file took the document's name/);
    assert.ok(statSync(file).isDirectory());
    rmSync(file, { recursive: true });
    // A second name for another file (a hard link): writing would reach that file.
    const other = path.join(path.dirname(file), 'other.txt');
    writeFileSync(other, 'not a document');
    linkSync(other, file);
    const linked = await docs.call('PUT', url, { markdown: `${PLAN}\nMore.\n`, base: 1 });
    assert.equal(linked.status, 409, JSON.stringify(linked.body));
    assert.equal(readFileSync(other, 'utf8'), 'not a document');
    rmSync(file);
    // A link to another file, and one that leads nowhere: the same answer, and what they lead to is not written.
    symlinkSync('other.txt', file);
    const toFile = await docs.call('PUT', url, { markdown: `${PLAN}\nMore.\n`, base: 1 });
    assert.equal(toFile.status, 409, JSON.stringify(toFile.body));
    assert.match(toFile.body.error, /^Another file took the document's name$/);
    assert.equal(readFileSync(other, 'utf8'), 'not a document');
    rmSync(file);
    symlinkSync('nowhere.txt', file);
    const dangling = await docs.call('PUT', url, { markdown: `${PLAN}\nMore.\n`, base: 1 });
    assert.equal(dangling.status, 409, JSON.stringify(dangling.body));
    assert.match(dangling.body.error, /^Another file took the document's name$/);
    assert.equal(existsSync(path.join(path.dirname(file), 'nowhere.txt')), false);
  } finally {
    await docs.close();
  }
});

test('a document file that grew past 1 MB outside the page is refused with that reason, not called missing, and is not written over', async () => {
  const { docs, url, file, id } = await withDocument('docs-hard-grown-');
  try {
    const grown = `${PLAN}${'x'.repeat(1024 * 1024)}\n`;
    writeFileSync(file, grown);
    const read = await docs.call('GET', url);
    assert.equal(read.status, 409);
    assert.match(read.body.error, /bigger than 1 MB/);
    const saved = await docs.call('PUT', url, { markdown: `${PLAN}\nMore.\n`, base: 1 });
    assert.equal(saved.status, 409);
    assert.match(saved.body.error, /bigger than 1 MB/);
    assert.equal(readFileSync(file, 'utf8'), grown, 'the outside change is still there');
    // The agent is told the same, by its tool.
    const tool = await docs.agent('a')('doc_read', { id });
    assert.match(tool.error ?? '', /^refused: .*bigger than 1 MB/);
  } finally {
    await docs.close();
  }
});

test('a document file the portal may not read is refused with that reason when it is saved, not called missing', { skip: !unprivileged }, async () => {
  const { docs, url, file } = await withDocument('docs-hard-unreadable-');
  try {
    chmodSync(file, 0o000);
    const saved = await docs.call('PUT', url, { markdown: `${PLAN}\nMore.\n`, base: 1 });
    assert.equal(saved.status, 409, JSON.stringify(saved.body));
    assert.match(saved.body.error, /not allowed to read it/);
    chmodSync(file, 0o644);
    assert.equal(readFileSync(file, 'utf8'), PLAN);
  } finally {
    chmodSync(file, 0o644);
    await docs.close();
  }
});

// A folder without the rights

test('a documents folder the portal may not write in says so, for a save, a new document and the agent, and leaves nothing behind', { skip: !unprivileged }, async () => {
  const { docs, folder, f, url, id } = await withDocument('docs-hard-readonly-');
  const dir = path.join(folder, 'documents');
  try {
    chmodSync(dir, 0o555);
    const saved = await docs.call('PUT', url, { markdown: `${PLAN}\nMore.\n`, base: 1 });
    assert.equal(saved.status, 403, JSON.stringify(saved.body));
    assert.match(saved.body.error, /not allowed to change files in this folder's documents folder/);
    const made = await docs.call('POST', `/folders/${f}/documents`, { title: 'Other' });
    assert.equal(made.status, 403);
    const tool = await docs.agent('a')('doc_create', { title: 'Another' });
    assert.match(tool.error ?? '', /^refused: The portal is not allowed to change files/);
    assert.equal(readFileSync(path.join(dir, 'plan.md'), 'utf8'), PLAN);
    assert.deepEqual(readdirSync(dir), ['plan.md'], 'no temporary file is left');
    // A failure of the disk is not one of the store's own: the log is not filled with it, and the history is as it was.
    assert.deepEqual(docs.logged, []);
    assert.equal((await docs.call('GET', `${url}/history`)).body.revisions.length, 1);
    // The agent reads what it may.
    assert.ok((await docs.agent('a')('doc_read', { id })).text.includes('Ship it on Friday.'));
    // Given the rights back, the save goes through: nothing was left half done.
    chmodSync(dir, 0o755);
    assert.equal((await docs.call('PUT', url, { markdown: `${PLAN}\nMore.\n`, base: 1 })).status, 200);
  } finally {
    chmodSync(dir, 0o755);
    await docs.close();
  }
});

test('a documents folder the portal may not read is said on the page, with the reason, and is not listed as one with no documents', { skip: !unprivileged }, async () => {
  const folder = realpathSync(scratch('docs-hard-unlistable-'));
  const other = realpathSync(scratch('docs-hard-listable-'));
  mkdirSync(path.join(folder, 'documents'));
  writeFileSync(path.join(folder, 'documents', 'plan.md'), PLAN);
  mkdirSync(path.join(other, 'documents'));
  writeFileSync(path.join(other, 'documents', 'notes.md'), '# Notes\n');
  const docs = await portal({ a: folder, b: other });
  try {
    const id = (await docs.call('GET', '/folders')).body.folders.find((x: any) => x.path === folder).documents[0].id as string;
    chmodSync(path.join(folder, 'documents'), 0o000);
    const { folders, problems } = (await docs.call('GET', '/folders')).body;
    assert.deepEqual(folders.map((x: any) => x.path), [other], 'the others are listed');
    assert.deepEqual(problems.map((x: any) => [x.path, x.name, x.id]), [[folder, path.basename(folder), folderIdOf(folder)]]);
    assert.match(problems[0].error, /not allowed to read this folder's documents folder/);
    // The agent is told too, and not that there are no documents to list; and the document that is open is not called missing,
    // nor its save said to be a refusal to write.
    const tool = await docs.agent('a')('doc_list', {});
    assert.match(tool.error ?? '', /^refused: The portal is not allowed to read this folder's documents folder/);
    const url = `/folders/${folderIdOf(folder)}/documents/${id}`;
    for (const answer of [await docs.call('GET', url), await docs.call('PUT', url, { markdown: `${PLAN}\nMore.\n`, base: 1 })]) {
      assert.equal(answer.status, 403, JSON.stringify(answer.body));
      assert.match(answer.body.error, /^The portal is not allowed to read this folder's documents folder/);
    }
    assert.match((await docs.agent('a')('doc_read', { id })).error ?? '', /^refused: The portal is not allowed to read this folder's documents folder/);
    chmodSync(path.join(folder, 'documents'), 0o755);
    const again = (await docs.call('GET', '/folders')).body;
    assert.equal(again.problems, undefined);
    assert.equal(again.folders.length, 2);
  } finally {
    chmodSync(path.join(folder, 'documents'), 0o755);
    await docs.close();
  }
});

test('a documents folder that is a link leading out of the folder is refused when a document is saved or made, and nothing is written where it leads', async () => {
  const { docs, folder, url } = await withDocument('docs-hard-linked-');
  const outside = realpathSync(scratch('docs-hard-linked-outside-'));
  try {
    rmSync(path.join(folder, 'documents'), { recursive: true });
    symlinkSync(outside, path.join(folder, 'documents'));
    const saved = await docs.call('PUT', url, { markdown: `${PLAN}\nMore.\n`, base: 1 });
    assert.equal(saved.status, 409, JSON.stringify(saved.body));
    assert.equal(saved.body.error, 'documents in this folder is a link');
    const made = await docs.agent('a')('doc_create', { title: 'Another' });
    assert.equal(made.error, 'refused: documents in this folder is a link');
    assert.deepEqual(readdirSync(outside), []);
    assert.deepEqual(docs.logged.filter((line) => /failed/.test(line)), []);
  } finally {
    await docs.close();
  }
});

// What a failed disk, git or database is to the person who reads it

test('a full data disk, which git says in words, is said as a full disk and not as a damaged history to be removed', async () => {
  const { docs, url } = await withDocument('docs-hard-full-');
  // A git that fails as it does when the data folder's disk is full, and is git otherwise.
  const bin = realpathSync(scratch('docs-hard-fakegit-'));
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = hash-object ]; then echo "error: unable to create temporary file: No space left on device" >&2; exit 128; fi\ndone\nexec ${real} "$@"\n`, { mode: 0o755 });
  const was = process.env.PATH;
  process.env.PATH = `${bin}:${was}`;
  try {
    const saved = await docs.call('PUT', url, { markdown: `${PLAN}\nMore.\n`, base: 1 });
    assert.equal(saved.status, 507, JSON.stringify(saved.body));
    assert.equal(saved.body.error, 'There is no room left on the disk for this document');
    const made = await docs.agent('a')('doc_create', { title: 'Another' });
    assert.equal(made.error, 'refused: There is no room left on the disk for this document');
    assert.ok(![...docs.logged].some((line) => /remove its git folder/.test(line)));
  } finally {
    process.env.PATH = was;
    await docs.close();
  }
});

test('a full disk, a read-only file system, a missing right, git and the database say what is wrong, and anything else is left as it is', () => {
  const fs = (code: string, path = '/data/ws/documents/.plan.md.0123456789ab.tmp') => Object.assign(new Error(`${code}: failed, open '${path}'`), { code, path });
  const reasons = (e: unknown, dir: string | null = '/data/store') => { const said = explained(e, dir) as DocError; return [said.status, said.message] as const; };
  assert.deepEqual(reasons(fs('ENOSPC')), [507, 'There is no room left on the disk for this document']);
  assert.deepEqual(reasons(fs('EDQUOT')), [507, 'There is no room left on the disk for this document']);
  assert.deepEqual(reasons(fs('EROFS')), [403, "The documents folder, or the portal's data folder, is on a read-only file system"]);
  assert.deepEqual(reasons(fs('EACCES')), [403, "The portal is not allowed to change files in this folder's documents folder (permission denied)"]);
  assert.deepEqual(reasons(fs('EPERM')), [403, "The portal is not allowed to change files in this folder's documents folder (permission denied)"]);
  // A file of the store itself is not in the documents folder: whether named through its open folder or by its path.
  assert.deepEqual(reasons(fs('EACCES', '/proc/self/fd/9/git/index.lock')), [403, 'The portal is not allowed to use the documents store in /data/store (permission denied)']);
  assert.deepEqual(reasons(fs('EACCES', '/data/store/docs.sqlite')), [403, 'The portal is not allowed to use the documents store in /data/store (permission denied)']);
  // git: not there at all, or failed with what it said (its first line, and where the store is).
  assert.deepEqual(reasons(new GitError('git could not be started: spawn git ENOENT', { spawn: 'ENOENT' })), [500, "git could not be found on the portal's PATH: the history of the documents is kept with it"]);
  const [status, why] = reasons(new GitError('git cat-file failed (128): fatal: bad object\nmore of what it said'));
  assert.equal(status, 500);
  assert.match(why, /^The history of the documents could not be used: git cat-file failed \(128\): fatal: bad object \(the store is \/data\/store: /);
  assert.ok(!why.includes('more of what it said'));
  // What the disk said to git, which is a child process: it reaches it as words.
  assert.deepEqual(reasons(new GitError('git hash-object failed (128): error: unable to create temporary file: No space left on device')), [507, 'There is no room left on the disk for this document']);
  assert.deepEqual(reasons(new GitError('git commit-tree failed (128): fatal: Disk quota exceeded')), [507, 'There is no room left on the disk for this document']);
  assert.deepEqual(reasons(new GitError('git update-ref failed (128): error: could not write: Read-only file system')), [403, "The documents folder, or the portal's data folder, is on a read-only file system"]);
  assert.deepEqual(reasons(new GitError("git read-tree failed (128): fatal: Unable to create '/x/index.lock': Permission denied")), [403, 'The portal is not allowed to use the documents store in /data/store (permission denied)']);
  assert.deepEqual(reasons(Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' })), [507, 'There is no room left on the disk for this document']);
  const forThePerson = (e: unknown) => Boolean((explained(e, '/data/store') as any).operator);
  // git's own words for an object it may not write, which is what a store left to another user (the portal once run as root) gives.
  assert.deepEqual(reasons(new GitError('git hash-object failed (128): error: insufficient permission for adding an object to repository database /proc/self/fd/3/git/objects')), [403, 'The portal is not allowed to use the documents store in /data/store (permission denied)']);
  // A database the portal may not write is opened read-only by SQLite and says so on the first write: said as that, naming the store and
  // the message, and not as a read-only file system alone. One moved or deleted under an open connection is not that.
  const [roStatus, roWhy] = reasons(Object.assign(new Error('attempt to write a readonly database'), { code: 'SQLITE_READONLY' }));
  assert.equal(roStatus, 403);
  assert.equal(roWhy, 'The documents database cannot be written: the portal may not write the docs.sqlite files in /data/store, or their file system is read-only (attempt to write a readonly database)');
  assert.equal(forThePerson(Object.assign(new Error('x'), { code: 'SQLITE_READONLY_CANTINIT' })), true);
  assert.deepEqual(reasons(Object.assign(new Error('attempt to write a readonly database'), { code: 'SQLITE_READONLY_DBMOVED' })), [500, 'The database of the documents could not be used: attempt to write a readonly database (the store is /data/store)']);
  assert.deepEqual(reasons(Object.assign(new Error('access permission denied'), { code: 'SQLITE_PERM' })), [403, 'The portal is not allowed to use the documents store in /data/store (permission denied)']);
  // What names the store or a way to mend it is for the person alone: marked, so that the agent is not given it.
  assert.equal(forThePerson(new GitError('git cat-file failed (128): fatal: bad object')), true);
  assert.equal(forThePerson(new GitError('git could not be started', { spawn: 'ENOENT' })), true);
  assert.equal(forThePerson(Object.assign(new Error('x'), { code: 'SQLITE_CORRUPT' })), true);
  assert.equal(forThePerson(fs('EACCES', '/proc/self/fd/9/git/index.lock')), true);
  assert.equal(forThePerson(fs('EACCES')), false);
  assert.equal(forThePerson(new GitError('git hash-object failed (128): No space left on device')), false);
  // The database: damaged, with what to do, or failed for another reason.
  assert.match(reasons(Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' }))[1], /^The database of the documents is damaged: file is not a database \(remove the docs\.sqlite files in \/data\/store /);
  assert.deepEqual(reasons(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })), [500, 'The database of the documents could not be used: database is locked (the store is /data/store)']);
  // A refusal is its own, and a failure nobody can do anything about is not dressed up: it is logged and answered as a failure.
  const refusal = new DocError(409, 'Nope');
  assert.equal(explained(refusal), refusal);
  const other = new TypeError('x is not a function');
  assert.equal(explained(other), other);
  const missing = fs('ENOENT');
  assert.equal(explained(missing), missing);
});

// A broken store

/** What the agent is told when the store is broken: that the person has to mend it, and nothing of where it is or what to delete. */
const AGENT_TOLD = 'refused: the documents store of this folder cannot be used just now. Tell the person: the Documents page says what is wrong and how to mend it. Do not try to repair it yourself';

/** The store of `folder` in the data folder. */
const storeOf = (folder: string) => path.join(DATA, folderIdOf(folder));

/** A document with a comment on it and two revisions, whose portal is stopped: what is done to its store is found by the next one. */
async function stored(prefix: string) {
  const made = await withDocument(prefix);
  assert.equal((await made.docs.call('PUT', made.url, { markdown: `${PLAN}\nMore.\n`, base: 1 })).status, 200);
  const thread = await made.docs.call('POST', `${made.url}/threads`, { base: 2, quote: 'More.', start: `${PLAN}\n`.length, body: 'A comment' });
  assert.equal(thread.status, 201);
  await made.docs.close();
  return made;
}

test('a folder whose store cannot be opened is said on the page, with the reason, and the other folders are listed', async () => {
  const { folder, id } = await stored('docs-hard-git-gone-');
  const other = realpathSync(scratch('docs-hard-git-other-'));
  mkdirSync(path.join(other, 'documents'));
  writeFileSync(path.join(other, 'documents', 'notes.md'), '# Notes\n');
  const was = process.env.PATH;
  // git is not there: a portal on a machine that has none.
  process.env.PATH = '/nonexistent';
  const docs = await portal({ a: folder });
  try {
    const { folders, problems } = (await docs.call('GET', '/folders')).body;
    assert.deepEqual(folders, []);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].path, folder);
    assert.match(problems[0].error, /git could not be found on the portal's PATH/);
    assert.ok(docs.logged.some((line) => /could not be listed/.test(line)));
    // Every request says why, in words, not that the store could not do that.
    const read = await docs.call('GET', `/folders/${folderIdOf(folder)}/documents/${id}`);
    assert.equal(read.status, 500);
    assert.match(read.body.error, /git could not be found on the portal's PATH/);
    // And the agent is told the same.
    const tool = await docs.agent('a')('doc_list', {});
    assert.equal(tool.error, AGENT_TOLD);
    assert.ok(docs.logged.some((line) => /^A document tool failed in chat a: git could not be found/.test(line)), 'the log has the reason');
  } finally {
    process.env.PATH = was;
    await docs.close();
  }
  // With git back, the store is as it was.
  const back = await portal({ a: folder, b: other });
  try {
    const { folders, problems } = (await back.call('GET', '/folders')).body;
    assert.equal(problems, undefined);
    assert.equal(folders.length, 2);
  } finally {
    await back.close();
  }
});

test('a store whose history is damaged is said, with where it is, and starting its history again keeps the documents and their comments', async () => {
  const { folder, id } = await stored('docs-hard-git-damaged-');
  // The branch points at nothing git can read: what a write cut off by a crash or a full disk can leave.
  writeFileSync(path.join(storeOf(folder), 'git', 'refs', 'heads', 'main'), 'zzz\n');
  const docs = await portal({ a: folder });
  try {
    const { folders, problems } = (await docs.call('GET', '/folders')).body;
    assert.deepEqual(folders, []);
    assert.match(problems[0].error, /^The history of the documents could not be used: git /);
    assert.ok(problems[0].error.includes(storeOf(folder)), problems[0].error);
    const read = await docs.call('GET', `/folders/${folderIdOf(folder)}/documents/${id}`);
    assert.equal(read.status, 500);
    assert.match(read.body.error, /history of the documents could not be used/);
    assert.equal((await docs.agent('a')('doc_read', { id })).error, AGENT_TOLD);
    // The file is the person's own, and is as it was.
    assert.equal(readFileSync(path.join(folder, 'documents', 'plan.md'), 'utf8'), `${PLAN}\nMore.\n`);
  } finally {
    await docs.close();
  }
  // What the message says to do: the history folder removed, and it starts again from the files.
  rmSync(path.join(storeOf(folder), 'git'), { recursive: true });
  const mended = await portal({ a: folder });
  try {
    const [listed] = (await mended.call('GET', '/folders')).body.folders;
    assert.deepEqual(listed.documents.map((d: any) => [d.id, d.revision, d.openThreads]), [[id, 1, 1]]);
    const thread = (await mended.call('GET', `/folders/${folderIdOf(folder)}/documents/${id}/threads`)).body.threads[0];
    assert.equal(thread.comments[0].body, 'A comment');
    assert.equal(thread.quote, 'More.');
    assert.equal(thread.orphaned, false);
    // And it is saved on, with the history it has now.
    const saved = await mended.call('PUT', `/folders/${folderIdOf(folder)}/documents/${id}`, { markdown: `${PLAN}\nMore, more.\n`, base: 1 });
    assert.equal(saved.status, 200);
    assert.equal(git(storeOf(folder), 'rev-list', '--count', 'HEAD'), '2');
  } finally {
    await mended.close();
  }
});

test('a database that is not one is said, with what to do, and without it the documents come back from the history, the comments being lost', async () => {
  const { folder, id } = await stored('docs-hard-sqlite-');
  rmSync(path.join(storeOf(folder), 'docs.sqlite-wal'), { force: true });
  rmSync(path.join(storeOf(folder), 'docs.sqlite-shm'), { force: true });
  writeFileSync(path.join(storeOf(folder), 'docs.sqlite'), 'this is not a database');
  const docs = await portal({ a: folder });
  try {
    const { folders, problems } = (await docs.call('GET', '/folders')).body;
    assert.deepEqual(folders, []);
    assert.match(problems[0].error, /^The database of the documents is damaged: /);
    assert.ok(problems[0].error.includes(`remove the docs.sqlite files in ${storeOf(folder)}`), problems[0].error);
    const read = await docs.call('GET', `/folders/${folderIdOf(folder)}/documents/${id}`);
    assert.equal(read.status, 500);
    assert.match(read.body.error, /database of the documents is damaged/);
    // The remedy is the person's: the agent runs commands as the portal and could carry it out, so it is told only to ask them.
    for (const [name, params] of [['doc_list', {}], ['doc_read', { id }], ['doc_create', { title: 'Another' }]] as const) {
      const tool = await docs.agent('a')(name, params);
      assert.equal(tool.error, AGENT_TOLD, name);
      assert.ok(!tool.error!.includes(storeOf(folder)) && !/remove|delete/i.test(tool.error!), name);
    }
    assert.ok(docs.logged.some((line) => line.includes(`remove the docs.sqlite files in ${storeOf(folder)}`)), 'the log has the whole reason');
  } finally {
    await docs.close();
  }
  for (const name of readdirSync(storeOf(folder)).filter((x) => x.startsWith('docs.sqlite'))) rmSync(path.join(storeOf(folder), name));
  const mended = await portal({ a: folder });
  try {
    const [listed] = (await mended.call('GET', '/folders')).body.folders;
    assert.deepEqual(listed.documents.map((d: any) => [d.id, d.revision, d.openThreads]), [[id, 2, 0]]);
    assert.deepEqual((await mended.call('GET', `/folders/${folderIdOf(folder)}/documents/${id}/history`)).body.revisions.map((r: any) => r.revision), [2, 1]);
  } finally {
    await mended.close();
  }
});

test('a store left to another user, which git and SQLite may not write, is said as a permission problem naming the store, with nothing to delete and the reason in the log', { skip: !unprivileged }, async () => {
  const { folder, id } = await stored('docs-hard-owner-');
  const store = storeOf(folder);
  // As after a start of the portal as root: what it may not write.
  const objects = path.join(store, 'git', 'objects');
  const closed = [objects, ...readdirSync(objects).map((name) => path.join(objects, name))].filter((x) => statSync(x).isDirectory());
  closed.forEach((x) => chmodSync(x, 0o555));
  const docs = await portal({ a: folder });
  try {
    const url = `/folders/${folderIdOf(folder)}/documents/${id}`;
    const saved = await docs.call('PUT', url, { markdown: `${PLAN}\nMore, more.\n`, base: 2 });
    assert.equal(saved.status, 403, JSON.stringify(saved.body));
    assert.equal(saved.body.error, `The portal is not allowed to use the documents store in ${store} (permission denied)`);
    assert.ok(!/remove/.test(saved.body.error));
    assert.ok(docs.logged.some((line) => line.includes(`not allowed to use the documents store in ${store}`)), docs.logged.join('\n'));
    assert.equal((await docs.agent('a')('doc_create', { title: 'Another' })).error, AGENT_TOLD);
  } finally {
    closed.forEach((x) => chmodSync(x, 0o755));
    await docs.close();
  }
  // The database file, the same way: the portal's user may not write it, and the reason is neither a disk nor something to delete.
  chmodSync(path.join(store, 'docs.sqlite'), 0o444);
  const readonly = await portal({ a: folder });
  try {
    const saved = await readonly.call('PUT', `/folders/${folderIdOf(folder)}/documents/${id}`, { markdown: `${PLAN}\nMore, more, more.\n`, base: 2 });
    const said = saved.body.error ?? (await readonly.call('GET', '/folders')).body.problems?.[0]?.error;
    assert.match(said, /^The documents database cannot be written: the portal may not write the docs\.sqlite files in /, JSON.stringify(saved.body));
    assert.ok(said.includes(store) && /readonly database/.test(said), said);
    assert.ok(readonly.logged.some((line) => /readonly database/.test(line)), `the reason is in the log: ${readonly.logged.join('\n')}`);
    assert.equal((await readonly.agent('a')('doc_list', {})).error, AGENT_TOLD);
  } finally {
    chmodSync(path.join(store, 'docs.sqlite'), 0o644);
    await readonly.close();
  }
});

test('a store that holds what is not the portal\'s own is refused naming the store and the entry, for the person alone, and with nothing done to it', async () => {
  const { folder, id } = await stored('docs-hard-notown-');
  const store = storeOf(folder);
  // As a store copied in by another user, or with something put in it, looks to the portal: a link in the history's folder.
  symlinkSync('/etc/hostname', path.join(store, 'git', 'planted'));
  const docs = await portal({ a: folder });
  try {
    const { problems } = (await docs.call('GET', '/folders')).body;
    assert.equal(problems[0].error, `The documents store holds something that is not its own: git/planted (the store is ${store})`);
    const saved = await docs.call('PUT', `/folders/${folderIdOf(folder)}/documents/${id}`, { markdown: `${PLAN}\nMore, more.\n`, base: 2 });
    assert.equal(saved.status, 409);
    assert.equal(saved.body.error, problems[0].error);
    // The agent is told only to ask the person: it runs commands as the portal, and could carry out a remedy that names the store.
    for (const [name, params] of [['doc_list', {}], ['doc_read', { id }]] as const) assert.equal((await docs.agent('a')(name, params)).error, AGENT_TOLD, name);
    assert.ok(docs.logged.some((line) => line.includes(`git/planted (the store is ${store})`)));
    // Nothing was done to it: the link is where it was, and what it leads to is not read or changed.
    assert.equal(readlinkSync(path.join(store, 'git', 'planted')), '/etc/hostname');
  } finally {
    await docs.close();
  }
  // Taken away, as the guide says, the store is used again.
  rmSync(path.join(store, 'git', 'planted'));
  const mended = await portal({ a: folder });
  try {
    assert.equal((await mended.call('GET', '/folders')).body.problems, undefined);
  } finally {
    await mended.close();
  }
});

test('one revision of the history that cannot be read says so, and the document and the rest of its history are not touched by it', async () => {
  const { docs, folder, url } = await withDocument('docs-hard-blob-');
  try {
    assert.equal((await docs.call('PUT', url, { markdown: `${PLAN}\nMore.\n`, base: 1 })).status, 200);
    const blob = git(storeOf(folder), 'rev-parse', 'HEAD~1:plan.md');
    const object = path.join(storeOf(folder), 'git', 'objects', blob.slice(0, 2), blob.slice(2));
    chmodSync(object, 0o644);
    writeFileSync(object, 'garbage');
    const first = await docs.call('GET', `${url}/revisions/1`);
    assert.equal(first.status, 500);
    assert.match(first.body.error, /^The history of the documents could not be used: git cat-file failed/);
    assert.equal((await docs.call('GET', `${url}/revisions/2`)).status, 200);
    assert.equal((await docs.call('GET', url)).status, 200);
    assert.equal((await docs.call('PUT', url, { markdown: `${PLAN}\nMore, more.\n`, base: 2 })).status, 200);
  } finally {
    await docs.close();
  }
});

// Many saves at once

test('saves from many windows at once on one revision are put together where they do not meet, and one wins where they do', async () => {
  const paragraphs = Array.from({ length: 24 }, (_, i) => `Paragraph ${i}.`);
  const text = `# Plan\n\n${paragraphs.join('\n\n')}\n`;
  const { docs, folder, url, file } = await withDocument('docs-hard-windows-', text);
  try {
    // Ten windows, each changed its own paragraph, all started from revision 1, and all save together.
    const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => docs.call('PUT', url, { markdown: text.replace(`Paragraph ${i * 2}.`, `Window ${i}.`), base: 1 })));
    assert.deepEqual(answers.map((a) => a.status), Array(10).fill(200), JSON.stringify(answers.map((a) => a.body.error)));
    assert.deepEqual(answers.map((a) => a.body.revision).sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const now = readFileSync(file, 'utf8');
    for (let i = 0; i < 10; i++) assert.ok(now.includes(`Window ${i}.`), `window ${i} is in`);
    assert.equal(git(storeOf(folder), 'rev-list', '--count', 'HEAD'), '11');
    // Five windows that changed the same paragraph: one is saved, the others get the document as it is, and nothing is lost to a mix.
    const same = await Promise.all(Array.from({ length: 5 }, (_, i) => docs.call('PUT', url, { markdown: now.replace('Paragraph 1.', `Same ${i}.`), base: 11 })));
    assert.deepEqual(same.map((a) => a.status).sort(), [200, 409, 409, 409, 409]);
    const winner = same.findIndex((a) => a.status === 200);
    assert.equal(readFileSync(file, 'utf8'), now.replace('Paragraph 1.', `Same ${winner}.`));
    for (const lost of same.filter((a) => a.status === 409)) assert.equal(lost.body.markdown, readFileSync(file, 'utf8'));
  } finally {
    await docs.close();
  }
});

// Documents at the size limit

test('a document of the largest size is listed, read, saved, merged, commented on and restored without holding the portal', async () => {
  const paragraphs = Array.from({ length: 12_000 }, (_, i) => `Paragraph ${i} ${'word '.repeat(10)}`.trim());
  let text = `# Big\n\n${paragraphs.join('\n\n')}\n`;
  while (Buffer.byteLength(text) > 1024 * 1024) text = text.slice(0, -1000).replace(/[^\n]*$/, '');
  assert.ok(Buffer.byteLength(text) > 700_000, 'it is a large document');
  const { docs, url } = await withDocument('docs-hard-large-', text);
  const took: Record<string, number> = {};
  const timed = async (what: string, work: () => Promise<{ status: number; body: any }>, status = 200) => {
    const started = performance.now();
    const answer = await work();
    took[what] = performance.now() - started;
    assert.equal(answer.status, status, `${what}: ${JSON.stringify(answer.body).slice(0, 200)}`);
    return answer;
  };
  try {
    await timed('list', () => docs.call('GET', '/folders'));
    assert.equal((await timed('read', () => docs.call('GET', url))).body.markdown, text);
    // A comment on every hundredth paragraph, as a long review leaves.
    for (let i = 1; i <= 40; i++) {
      const quote = `Paragraph ${i * 100} ${'word '.repeat(10)}`.trim();
      await timed('comment', () => docs.call('POST', `${url}/threads`, { base: 1, quote, start: text.indexOf(quote), body: `Comment ${i}` }), 201);
    }
    // Edits all over the text, and then one made on the first revision by another window.
    let edited = text;
    for (let i = 0; i < 300; i++) edited = edited.replace(`Paragraph ${i * 40 + 7} `, `Changed ${i} `);
    await timed('save', () => docs.call('PUT', url, { markdown: edited, base: 1 }));
    const late = text.replace('Paragraph 11999 ', 'Late 11999 ');
    const merged = await timed('merge', () => docs.call('PUT', url, { markdown: late, base: 1 }));
    assert.equal(merged.body.merged, true);
    assert.ok(merged.body.markdown.includes('Late 11999 ') && merged.body.markdown.includes('Changed 299 '));
    const threads = (await timed('threads', () => docs.call('GET', `${url}/threads`))).body.threads;
    assert.equal(threads.length, 40);
    assert.equal(threads.filter((t: any) => t.orphaned).length, 0);
    await timed('history', () => docs.call('GET', `${url}/history`));
    await timed('restore', () => docs.call('POST', `${url}/restore`, { revision: 1, base: 3 }));
    // One byte more is refused as a document, in every way a document is made or saved.
    const over = `${text}${'x'.repeat(1024 * 1024 - Buffer.byteLength(text) + 1)}`;
    assert.equal(Buffer.byteLength(over), 1024 * 1024 + 1);
    assert.equal((await docs.call('PUT', url, { markdown: over, base: 4 })).status, 413);
    // Each of them took a small part of a second on a machine that was not doing anything else; a long way from the limit is allowed.
    for (const [what, ms] of Object.entries(took)) assert.ok(ms < 5000, `${what} took ${Math.round(ms)} ms`);
  } finally {
    await docs.close();
  }
});

// The agent that is asked and never answers

test('a chat that never starts says so after a while, and the next change to the comment asks again', async () => {
  let hang = true;
  const { docs, url } = await withDocument('docs-hard-wake-', PLAN, { wakeMs: 20, wakeLimitMs: 150, tell: (chat) => (hang ? new Promise<boolean>(() => {}) : Promise.resolve(true)) });
  try {
    const made = await docs.call('POST', `${url}/threads`, { base: 1, quote: 'The build is green.', start: PLAN.indexOf('The build'), body: 'Is it, @agent?', chat: 'a' });
    assert.equal(made.status, 201);
    const threads = async () => (await docs.call('GET', `${url}/threads`)).body.threads as any[];
    await until(() => docs.told.length === 1, 'the chat to be rung');
    assert.equal((await threads())[0].ping.state, 'pending');
    // The chat does not start: past the limit the thread no longer says it is being asked.
    await until(async () => (await threads())[0].ping.state === 'failed', 'the thread to say it was not delivered');
    assert.equal((await threads())[0].ping.error, 'This chat did not start in time');
    assert.deepEqual(docs.sent.a ?? [], []);
    assert.ok(docs.logged.some((line) => /could not be asked in a comment: This chat did not start in time/.test(line)));
    // Changing the comment asks again, and this time the chat starts.
    hang = false;
    const comment = made.body.comments[0].id;
    const again = await docs.call('PUT', `${url}/threads/${made.body.id}/comments/${comment}`, { body: 'Is it really, @agent?', chat: 'a' });
    assert.equal(again.status, 200);
    await until(async () => (await threads())[0].ping.state === 'sent', 'the thread to say the chat took it');
    assert.equal(docs.sent.a.length, 1);
    assert.ok(docs.sent.a[0].content.includes('> Is it really, @agent?'));
  } finally {
    await docs.close();
  }
});
