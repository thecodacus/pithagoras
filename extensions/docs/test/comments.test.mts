import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express from 'express';
import docsServer from '../server.js';
import { folderFiles } from '../../../core/server/src/folder-files.ts';
import { scratch } from '../../../tests/helpers.mts';

/**
 * The comments of the Documents extension (extensions/docs/store.js, server.js): threads anchored to a passage of
 * a document, replies, resolving, and the passage kept in its place as the document changes. Against a real store on
 * disk, with git and SQLite, and a real router in a real server; the page works through the routes.
 */

const DATA = scratch('docs-comments-data-');

interface Frame { id?: string; event?: string; data?: any; comment?: string }

/** The server half for chats that work in these folders. */
async function portal(folders: Record<string, string>, data = DATA) {
  const router = express.Router();
  const logged: string[] = [];
  const stop = docsServer({
    extension: 'pithagoras-docs',
    log: (line: string) => logged.push(line),
    router,
    http: { json: express.json },
    files: folderFiles,
    sandbox: { on: () => false },
    dataDir: () => data,
    chats: {
      list: () => Object.keys(folders).map((id) => ({ id, title: `Chat ${id}` })),
      folder: (id: string) => realpathSync(folders[id]),
      inFolder: (folder: string) => Object.keys(folders).filter((id) => ((() => { try { return realpathSync(folders[id]) === folder; } catch { return false; } })())).map((id) => ({ id, title: `Chat ${id}` })),
    },
  }, { dependencies: async () => true, pollMs: 40 }) as () => Promise<void>;
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
    return { frame, next };
  }
  return {
    call,
    listen,
    logged,
    close: async () => {
      for (const abort of aborts) abort.abort();
      await stop();
      // close() leaves a connection open that fetch made and has not sent a request on yet.
      server.closeAllConnections();
      server.close();
    },
  };
}

const folderIdOf = (folder: string) => createHash('sha256').update(folder).digest('hex').slice(0, 16);
const fileOf = (folder: string, name = 'plan.md') => readFileSync(path.join(folder, 'documents', name), 'utf8');
const writeFile = (folder: string, text: string, name = 'plan.md') => writeFileSync(path.join(folder, 'documents', name), text);

const PLAN = '# Plan\n\nShip it on Friday.\n\nThe build is green.\n\nSign-off is on Monday.\n';
const GREEN = 'The build is green.';

/** A folder with one document made through the page, and the portal for it. */
async function withDocument(prefix: string, markdown = PLAN) {
  const folder = realpathSync(scratch(prefix));
  const docs = await portal({ a: folder });
  const f = folderIdOf(folder);
  const made = await docs.call('POST', `/folders/${f}/documents`, { title: 'Plan', markdown });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.id as string;
  const url = `/folders/${f}/documents/${id}`;
  /** A thread on `quote`, as the page makes it: the revision it saw, the words and what is around them. */
  const comment = async (quote: string, body = 'Is this right?', base = 1, text = markdown, nth = 0) => {
    let start = -1;
    for (let n = 0; n <= nth; n++) start = text.indexOf(quote, start + 1);
    assert.ok(start >= 0, `${quote} is in the text`);
    return docs.call('POST', `${url}/threads`, { base, quote, prefix: text.slice(Math.max(0, start - 32), start), suffix: text.slice(start + quote.length, start + quote.length + 32), start, body });
  };
  const threads = async () => (await docs.call('GET', `${url}/threads`)).body;
  const save = (markdown: string, base: number) => docs.call('PUT', url, { markdown, base });
  return { folder, docs, f, id, url, comment, threads, save };
}

/** What a thread says it is on, in the text. */
const on = (text: string, thread: any) => text.slice(thread.start, thread.end);

test('a thread is made on a passage, with the person as the author of its first comment, and listed with the document', async () => {
  const { docs, comment, threads, f, folder } = await withDocument('docs-comments-basic-');
  try {
    // The page is told where a comment that asks the agent can go: the chats that work in the folder, and the folder.
    const { ask, ...first } = await threads();
    assert.deepEqual(first, { revision: 1, threads: [] });
    assert.deepEqual(ask, { chats: [{ id: 'a', title: 'Chat a' }], own: false, workspace: folder });
    const made = await comment(GREEN, 'Is this right?');
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.match(made.body.id, /^[0-9a-f]{16}$/);
    assert.deepEqual({ ...made.body, id: undefined, createdAt: undefined, updatedAt: undefined, comments: undefined }, {
      id: undefined, status: 'open', orphaned: false, quote: GREEN, prefix: '# Plan\n\nShip it on Friday.\n\n', suffix: '\n\nSign-off is on Monday.\n',
      start: PLAN.indexOf(GREEN), end: PLAN.indexOf(GREEN) + GREEN.length, revision: 1, createdAt: undefined, updatedAt: undefined, comments: undefined,
      // Nobody was asked, and the agent has not answered.
      toAgent: false, answered: false, ping: null,
    });
    assert.equal(made.body.comments.length, 1);
    assert.equal(made.body.comments[0].author, 'user');
    assert.equal(made.body.comments[0].body, 'Is this right?');
    assert.ok(!Number.isNaN(Date.parse(made.body.comments[0].at)));
    assert.deepEqual({ ...(await threads()), ask: undefined }, { revision: 1, threads: [made.body], ask: undefined });
    // The listing says how many threads are open on each document.
    const listed = (await docs.call('GET', '/folders')).body.folders[0].documents;
    assert.equal(listed[0].openThreads, 1);
    assert.equal(f.length, 16);
  } finally {
    await docs.close();
  }
});

test('a reply is added to an open thread, in order, and cannot be added to a resolved one until it is opened again', async () => {
  const { docs, comment, threads, url } = await withDocument('docs-comments-reply-');
  try {
    const made = (await comment(GREEN)).body;
    const t = `${url}/threads/${made.id}`;
    const reply = await docs.call('POST', `${t}/comments`, { body: 'Yes, the build ran at noon.' });
    assert.equal(reply.status, 201);
    assert.deepEqual(reply.body.comments.map((c: any) => [c.author, c.body]), [['user', 'Is this right?'], ['user', 'Yes, the build ran at noon.']]);
    const resolved = await docs.call('POST', `${t}/resolve`, {});
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.status, 'resolved');
    assert.equal(resolved.body.comments.length, 2);
    // Not added to, and not counted as open.
    const refused = await docs.call('POST', `${t}/comments`, { body: 'One more thing.' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'thread_resolved');
    assert.equal((await threads()).threads[0].comments.length, 2);
    assert.equal((await docs.call('GET', '/folders')).body.folders[0].documents[0].openThreads, 0);
    // Resolving it again changes nothing; opening it makes it open and countable.
    assert.equal((await docs.call('POST', `${t}/resolve`, {})).body.status, 'resolved');
    const reopened = await docs.call('POST', `${t}/reopen`, {});
    assert.equal(reopened.body.status, 'open');
    assert.equal((await docs.call('GET', '/folders')).body.folders[0].documents[0].openThreads, 1);
    assert.equal((await docs.call('POST', `${t}/comments`, { body: 'One more thing.' })).status, 201);
    // Resolving with a last comment adds it first.
    const done = await docs.call('POST', `${t}/resolve`, { body: 'Done.' });
    assert.equal(done.body.status, 'resolved');
    assert.deepEqual(done.body.comments.map((c: any) => c.body), ['Is this right?', 'Yes, the build ran at noon.', 'One more thing.', 'Done.']);
  } finally {
    await docs.close();
  }
});

test('whoever the request says it is, a comment made through the page is the person\'s', async () => {
  const { docs, comment, url } = await withDocument('docs-comments-author-');
  try {
    const start = PLAN.indexOf(GREEN);
    const made = await docs.call('POST', `${url}/threads`, { base: 1, quote: GREEN, start, body: 'From the agent?', author: 'agent', comments: [{ author: 'agent', body: 'x' }] });
    assert.equal(made.status, 201);
    assert.deepEqual(made.body.comments.map((c: any) => c.author), ['user']);
    const reply = await docs.call('POST', `${url}/threads/${made.body.id}/comments`, { body: 'Again.', author: 'agent' });
    assert.deepEqual(reply.body.comments.map((c: any) => c.author), ['user', 'user']);
    assert.equal((await comment(GREEN)).body.comments[0].author, 'user');
  } finally {
    await docs.close();
  }
});

test('a thread that is not well made is refused with its reason, and nothing is stored', async () => {
  const { docs, comment, threads, url } = await withDocument('docs-comments-refused-');
  try {
    const start = PLAN.indexOf(GREEN);
    const make = (body: any) => docs.call('POST', `${url}/threads`, { base: 1, quote: GREEN, start, body: 'Text', ...body });
    // No comment, or one that is only white space; one too big for the database.
    assert.equal((await make({ body: '' })).status, 400);
    assert.equal((await make({ body: '  \n ' })).status, 400);
    assert.equal((await make({ body: 7 })).status, 400);
    const big = await make({ body: 'é'.repeat(2049) });
    assert.equal(big.status, 413);
    assert.equal(big.body.code, 'too_large');
    assert.equal((await make({ body: 'é'.repeat(2048) })).status, 201);
    // No passage, nothing but white space, one cut in the middle of a character, or too long.
    assert.equal((await make({ quote: '' })).status, 400);
    assert.equal((await make({ quote: ' \n ' })).status, 400);
    assert.equal((await make({ quote: undefined })).status, 400);
    assert.equal((await make({ quote: '\uD83D' })).status, 400);
    assert.equal((await make({ prefix: 5 })).status, 400);
    assert.equal((await make({ quote: 'x'.repeat(5001) })).status, 413);
    // A passage that is not in the revision it names.
    const absent = await make({ quote: 'The deploy is green.' });
    assert.equal(absent.status, 422);
    assert.equal(absent.body.code, 'quote_not_found');
    assert.equal(absent.body.revision, 1);
    // A revision there is not (yet), or no revision.
    const ahead = await make({ base: 2 });
    assert.equal(ahead.status, 409);
    assert.equal(ahead.body.code, 'revision_mismatch');
    assert.equal(ahead.body.revision, 1);
    assert.equal((await make({ base: 0 })).status, 400);
    assert.equal((await make({ base: 'x' })).status, 400);
    assert.equal((await make({ base: undefined })).status, 400);
    assert.equal((await threads()).threads.length, 1, 'only the one that was well made');
    // Replies and states of what is not there.
    const made = (await comment('Ship it on Friday.')).body;
    for (const thread of ['0000000000000000', 'nope', 'x%2Fy']) {
      assert.equal((await docs.call('POST', `${url}/threads/${thread}/comments`, { body: 'Hi' })).status, 404, thread);
      assert.equal((await docs.call('POST', `${url}/threads/${thread}/resolve`, {})).status, 404, thread);
      assert.equal((await docs.call('POST', `${url}/threads/${thread}/reopen`, {})).status, 404, thread);
    }
    assert.equal((await docs.call('POST', `${url}/threads/${made.id}/comments`, { body: '' })).status, 400);
    assert.equal((await docs.call('POST', `${url}/threads/${made.id}/comments`, { body: 'x'.repeat(4097) })).status, 413);
    assert.equal((await docs.call('POST', `${url}/threads/${made.id}/resolve`, { body: 'x'.repeat(4097) })).status, 413);
    assert.equal((await threads()).threads.find((t: any) => t.id === made.id).status, 'open', 'a resolve that was refused leaves it open');
    assert.equal((await docs.call('GET', url.replace(/[0-9a-f]{16}$/, '0000000000000000') + '/threads')).status, 404);
  } finally {
    await docs.close();
  }
});

test('a thread belongs to its document: it is not reachable through another', async () => {
  const folder = realpathSync(scratch('docs-comments-other-'));
  const docs = await portal({ a: folder });
  try {
    const f = folderIdOf(folder);
    const one = (await docs.call('POST', `/folders/${f}/documents`, { title: 'One', markdown: '# One\n\nAlpha beta.\n' })).body.id;
    const two = (await docs.call('POST', `/folders/${f}/documents`, { title: 'Two', markdown: '# Two\n\nGamma delta.\n' })).body.id;
    const made = await docs.call('POST', `/folders/${f}/documents/${one}/threads`, { base: 1, quote: 'Alpha beta.', body: 'Hm' });
    assert.equal(made.status, 201);
    const via = `/folders/${f}/documents/${two}/threads/${made.body.id}`;
    assert.equal((await docs.call('POST', `${via}/comments`, { body: 'Hi' })).status, 404);
    assert.equal((await docs.call('POST', `${via}/resolve`, {})).status, 404);
    assert.deepEqual((await docs.call('GET', `/folders/${f}/documents/${two}/threads`)).body.threads, []);
  } finally {
    await docs.close();
  }
});

test('a thread has at most 100 comments, and a document at most 1000 threads', async () => {
  const { docs, comment, threads, url, folder } = await withDocument('docs-comments-limits-');
  try {
    const made = (await comment(GREEN)).body;
    // The most are put straight into the database (a hundred requests would be the same test, slower).
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(path.join(DATA, folderIdOf(folder), 'docs.sqlite'));
    const now = new Date().toISOString();
    const addComment = db.prepare("INSERT INTO comments (id, thread_id, author, body, created_at) VALUES (?, ?, 'user', ?, ?)");
    db.transaction(() => { for (let n = 2; n <= 99; n++) addComment.run(n.toString(16).padStart(16, '0'), made.id, `Comment ${n}`, now); })();
    assert.equal((await docs.call('POST', `${url}/threads/${made.id}/comments`, { body: 'The hundredth' })).status, 201);
    const full = await docs.call('POST', `${url}/threads/${made.id}/comments`, { body: 'One too many' });
    assert.equal(full.status, 409);
    assert.equal(full.body.code, 'too_many');
    assert.equal((await threads()).threads[0].comments.length, 100);
    // Closing it with a last comment is no way around it, and leaves it open.
    assert.equal((await docs.call('POST', `${url}/threads/${made.id}/resolve`, { body: 'Done' })).status, 409);
    assert.equal((await threads()).threads[0].status, 'open');
    assert.equal((await docs.call('POST', `${url}/threads/${made.id}/resolve`, {})).body.status, 'resolved');

    // 998 more threads, the same way.
    const doc = db.prepare('SELECT id FROM documents').get() as { id: string };
    const insert = db.prepare('INSERT INTO threads (id, doc_id, quote, start, "end", revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)');
    const start = PLAN.indexOf('Ship it');
    db.transaction(() => { for (let n = 0; n < 998; n++) insert.run(n.toString(16).padStart(16, '0'), doc.id, 'Ship it', start, start + 7, now, now); })();
    db.close();
    assert.equal((await comment('Sign-off is on Monday.')).status, 201, 'the thousandth');
    const over = await comment('Sign-off is on Monday.');
    assert.equal(over.status, 409);
    assert.equal(over.body.code, 'too_many');
  } finally {
    await docs.close();
  }
});

test('a passage keeps its place when the text before it changes, and is listed at the revision the document is at', async () => {
  const { docs, comment, threads, save } = await withDocument('docs-comments-follow-');
  try {
    const made = (await comment(GREEN)).body;
    const next = PLAN.replace('# Plan\n', '# Plan\n\nA new paragraph, written before.\n');
    assert.equal((await save(next, 1)).body.revision, 2);
    const [moved] = (await threads()).threads;
    assert.equal(moved.id, made.id);
    assert.equal(on(next, moved), GREEN);
    assert.equal(moved.revision, 2);
    assert.equal(moved.orphaned, false);
    assert.equal(moved.prefix, 'A new paragraph, written before.\n\nShip it on Friday.\n\n'.slice(-32));
    // And again, through a change after it.
    const last = next.replace('Monday', 'Tuesday');
    await save(last, 2);
    assert.equal(on(last, (await threads()).threads[0]), GREEN);
  } finally {
    await docs.close();
  }
});

test('a passage the person edits is the edited text, so the comment stays with the words', async () => {
  const { docs, comment, threads, save } = await withDocument('docs-comments-edited-', '# Plan\n\nShip it on Friday. The build is green. Sign-off is on Monday.\n\nThe build is green.\n');
  try {
    await comment('The build is green.', 'Is it?', 1, undefined, 1);
    await comment('Friday');
    await comment('Sign-off is on Monday.');
    let text = '# Plan\n\nShip it on Friday. The build is green. Sign-off is on Monday.\n\nThe build is red and green.\n';
    await save(text, 1);
    let listed = (await threads()).threads;
    assert.deepEqual(listed.map((t: any) => on(text, t)), ['The build is red and green.', 'Friday', 'Sign-off is on Monday.']);
    assert.deepEqual(listed.map((t: any) => t.quote), ['The build is red and green.', 'Friday', 'Sign-off is on Monday.']);
    // A word replaced by another: the thread on the word is on the other word.
    text = text.replace('Friday', 'Monday afternoon');
    await save(text, 2);
    listed = (await threads()).threads;
    assert.deepEqual(listed.map((t: any) => on(text, t)), ['The build is red and green.', 'Monday afternoon', 'Sign-off is on Monday.']);
    assert.ok(listed.every((t: any) => !t.orphaned && t.revision === 3));
    // A sentence in a paragraph rewritten.
    text = text.replace('Sign-off is on Monday.', 'Approval comes on Tuesday.');
    await save(text, 3);
    listed = (await threads()).threads;
    assert.deepEqual(listed.map((t: any) => on(text, t)), ['The build is red and green.', 'Monday afternoon', 'Approval comes on Tuesday.']);
    // A whole paragraph rewritten with none of its words is gone, though the sentence in its words is still in the document.
    text = text.replace('The build is red and green.', 'Everything passes now.');
    await save(text, 4);
    listed = (await threads()).threads;
    assert.equal(listed[0].orphaned, true);
    assert.equal(listed[0].quote, 'The build is red and green.');
    assert.deepEqual(listed.slice(1).map((t: any) => on(text, t)), ['Monday afternoon', 'Approval comes on Tuesday.']);
  } finally {
    await docs.close();
  }
});

test('text put in at the edge of a passage is not in it', async () => {
  const { docs, comment, threads, save } = await withDocument('docs-comments-edge-', '# Plan\n\nalpha beta gamma\n');
  try {
    await comment('beta');
    const text = '# Plan\n\nalpha, new beta, newer gamma\n';
    await save(text, 1);
    const [moved] = (await threads()).threads;
    assert.equal(on(text, moved), 'beta');
  } finally {
    await docs.close();
  }
});

test('a passage that is deleted is orphaned, kept with its words, and found again when the words come back', async () => {
  const { docs, comment, threads, save, url } = await withDocument('docs-comments-orphan-');
  try {
    const made = (await comment(GREEN)).body;
    const without = PLAN.replace(`${GREEN}\n\n`, '');
    await save(without, 1);
    let [thread] = (await threads()).threads;
    assert.equal(thread.id, made.id);
    assert.equal(thread.orphaned, true);
    assert.equal(thread.start, null);
    assert.equal(thread.end, null);
    assert.equal(thread.quote, GREEN, 'its words are kept');
    assert.equal(thread.status, 'open');
    assert.equal(thread.revision, 2);
    // It can be answered and resolved all the same.
    assert.equal((await docs.call('POST', `${url}/threads/${made.id}/comments`, { body: 'Gone.' })).status, 201);
    // Brought back by restoring the first revision.
    assert.equal((await docs.call('POST', `${url}/restore`, { revision: 1 })).status, 200);
    [thread] = (await threads()).threads;
    assert.equal(thread.orphaned, false);
    assert.equal(on(PLAN, thread), GREEN);
    assert.equal(thread.revision, 3);
  } finally {
    await docs.close();
  }
});

test('a paragraph that is moved takes its comment along; a short phrase that reads the same elsewhere is not taken for the one that was deleted', async () => {
  const text = '# Plan\n\nFirst we agree on the scope of the release.\n\nYes.\n\nThen we ship.\n\nYes.\n\nThe end.\n';
  const { docs, comment, threads, save } = await withDocument('docs-comments-moved-', text);
  try {
    const scope = (await comment('First we agree on the scope of the release.')).body;
    const first = (await comment('Yes.', 'Why yes?')).body;
    const second = (await comment('Yes.', 'And again?', 1, text, 1)).body;
    const moved = '# Plan\n\nYes.\n\nThen we ship.\n\nYes.\n\nFirst we agree on the scope of the release.\n\nThe end.\n';
    await save(moved, 1);
    let listed = (await threads()).threads;
    assert.equal(on(moved, listed.find((t: any) => t.id === scope.id)), 'First we agree on the scope of the release.');
    // The two that read the same stay in the order they were, each in its own place.
    assert.equal(listed.find((t: any) => t.id === first.id).start, moved.indexOf('Yes.'));
    assert.equal(listed.find((t: any) => t.id === second.id).start, moved.lastIndexOf('Yes.'));
    // The first "Yes." deleted: the comment on it is not moved to the other.
    const gone = moved.replace('Yes.\n\nThen we ship.', 'Then we ship.');
    await save(gone, 2);
    listed = (await threads()).threads;
    assert.equal(listed.find((t: any) => t.id === first.id).orphaned, true);
    const kept = listed.find((t: any) => t.id === second.id);
    assert.equal(kept.orphaned, false);
    assert.equal(kept.start, gone.indexOf('Yes.'));
    assert.equal(on(gone, listed.find((t: any) => t.id === scope.id)), 'First we agree on the scope of the release.');
  } finally {
    await docs.close();
  }
});

test('a passage that is gone does not turn up on other words that read the same, in the next revision or the one it was deleted in', async () => {
  const text = '# Plan\n\nFirst we agree on the scope of the release.\n\nYes.\n\nThen we ship.\n\nYes.\n\nThe end.\n';
  const { docs, comment, threads, save } = await withDocument('docs-comments-lost-', text);
  try {
    const first = (await comment('Yes.', 'Why yes?')).body;
    const second = (await comment('Yes.', 'And again?', 1, text, 1)).body;
    // The first one deleted: the blank lines and the full stop round the other are what both were set off by, and are not the same place.
    const gone = text.replace('Yes.\n\nThen', 'Then');
    await save(gone, 1);
    let listed = (await threads()).threads;
    assert.equal(listed.find((t: any) => t.id === first.id).orphaned, true, 'in the revision it was deleted in');
    assert.equal(on(gone, listed.find((t: any) => t.id === second.id)), 'Yes.');
    // And in the next, when it is looked for again by its words alone.
    const later = gone.replace('The end.', 'The end, really.');
    await save(later, 2);
    listed = (await threads()).threads;
    assert.equal(listed.find((t: any) => t.id === first.id).orphaned, true, 'in the next revision');
    assert.equal(listed.find((t: any) => t.id === first.id).start, null);
    assert.equal(listed.find((t: any) => t.id === second.id).start, later.indexOf('Yes.'));
    // The same with no look at the threads between the deletion and the new words: what the agent's edits of a document nobody has
    // open, or a page's autosave, do. Two changes are one step for the threads.
    const { docs: d3, comment: c3, threads: t3, save: s3 } = await withDocument('docs-comments-lost-blind-', '# Plan\n\nShip it on Friday.\n\nYes.\n\nThen sign off.\n');
    try {
      const was = '# Plan\n\nShip it on Friday.\n\nYes.\n\nThen sign off.\n';
      const friday = (await c3('Friday', 'Why Friday?', 1, was)).body;
      const yes = (await c3('Yes.', 'Why yes?', 1, was)).body;
      await s3('# Plan\n\nThen sign off.\n', 1);
      await s3('# Plan\n\nThen sign off.\n\nThank God it is Friday, said nobody.\n\nDo we stop?\n\nYes.\n', 2);
      const listed = (await t3()).threads;
      assert.equal(listed.find((t: any) => t.id === friday.id).orphaned, true, 'a new "Friday" is not the old one');
      assert.equal(listed.find((t: any) => t.id === yes.id).orphaned, true, 'a new "Yes." is not the old one');
    } finally {
      await d3.close();
    }
    // Words of a paragraph that is gone, and another that has them in it, with none of what was round them.
    const { docs: d2, comment: c2, threads: t2, save: s2 } = await withDocument('docs-comments-lost-friday-', '# Plan\n\nShip it on Friday.\n\nThen sign off.\n');
    try {
      const friday = (await c2('Friday', 'Why Friday?', 1, '# Plan\n\nShip it on Friday.\n\nThen sign off.\n')).body;
      await s2('# Plan\n\nThen sign off.\n', 1);
      assert.equal((await t2()).threads[0].orphaned, true);
      await s2('# Plan\n\nThen sign off.\n\nThank God it is Friday, said nobody.\n', 2);
      const [thread] = (await t2()).threads;
      assert.equal(thread.id, friday.id);
      assert.equal(thread.orphaned, true, 'a new "Friday" is not the old one');
    } finally {
      await d2.close();
    }
  } finally {
    await docs.close();
  }
});

test('a sentence that is written again around a passage in it is not the passage rewritten: the thread is orphaned and does not land on the new words', async () => {
  const { docs, comment, threads, save } = await withDocument('docs-comments-sentence-', '# Budget\n\nThe budget is 5000 euros.\n\nCall Bob at noon.\n');
  try {
    await comment('5000 euros', 'Is this enough?');
    await comment('Bob', 'Who is Bob?');
    const text = '# Budget\n\nThe deadline is next Monday.\n\nWeather is nice today.\n';
    await save(text, 1);
    const listed = (await threads()).threads;
    assert.deepEqual(listed.map((t: any) => t.orphaned), [true, true]);
    assert.deepEqual(listed.map((t: any) => t.quote), ['5000 euros', 'Bob']);
    // A word of the sentence replaced is as it was: the thread is on the other word.
    const { docs: d2, comment: c2, threads: t2, save: s2 } = await withDocument('docs-comments-sentence-word-', '# Budget\n\nThe budget is 5000 euros.\n');
    try {
      await c2('5000 euros', 'Enough?', 1, '# Budget\n\nThe budget is 5000 euros.\n');
      const next = '# Budget\n\nThe budget is 7500 dollars.\n';
      await s2(next, 1);
      assert.equal(on(next, (await t2()).threads[0]), '7500 dollars');
    } finally {
      await d2.close();
    }
  } finally {
    await docs.close();
  }
});

test('a start that is not a place in the text is no place: the passage is found by its words', async () => {
  const { docs, threads, url } = await withDocument('docs-comments-start-');
  try {
    for (const start of [-3, -1e9, 1e9, 1.5, 'x', null]) {
      const made = await docs.call('POST', `${url}/threads`, { base: 1, quote: '# Plan', start, body: 'x' });
      assert.equal(made.status, 201, JSON.stringify(start));
      assert.equal(made.body.quote, '# Plan', JSON.stringify(start));
      assert.equal(made.body.start, 0, JSON.stringify(start));
      assert.equal(made.body.end, 6, JSON.stringify(start));
    }
    assert.equal((await threads()).threads.length, 6);
  } finally {
    await docs.close();
  }
});

test('a document of a dozen pages written back with other line endings, by a program outside the portal, keeps its comments on headings and short lines', async () => {
  const lf = `# Plan\n\n## Risks\n\nApproved.\n\n${Array.from({ length: 230 }, (_, i) => `Paragraph ${i} says something about the plan.`).join('\n\n')}\n`;
  const crlf = lf.replace(/\n/g, '\r\n');
  const { docs, comment, threads, save, folder } = await withDocument('docs-comments-crlf-', crlf);
  try {
    await comment('Risks', 'Which?', 1, crlf);
    await comment('Approved.', 'By whom?', 1, crlf);
    await comment('Paragraph 7 says', 'Says what?', 1, crlf);
    // The file written back with LF by something outside (a Windows editor, git), found as a change and listed.
    writeFile(folder, lf);
    let listed = (await threads()).threads;
    assert.deepEqual(listed.map((t: any) => [t.orphaned, on(lf, t)]), [[false, 'Risks'], [false, 'Approved.'], [false, 'Paragraph 7 says']]);
    // Nothing is lost at the next listing either, nor when it is written back again.
    await save(`${lf}One more.\n`, 2);
    writeFile(folder, crlf);
    listed = (await threads()).threads;
    assert.deepEqual(listed.map((t: any) => [t.orphaned, on(crlf, t)]), [[false, 'Risks'], [false, 'Approved.'], [false, 'Paragraph 7 says']]);
  } finally {
    await docs.close();
  }
});

test('a change made outside the page (the file written by another program) is taken in with its revision, and the passage follows it', async () => {
  const { docs, comment, threads, folder } = await withDocument('docs-comments-outside-');
  try {
    await comment(GREEN);
    const text = `Outside note.\n\n${PLAN}`;
    writeFile(folder, text);
    const [thread] = (await threads()).threads;
    assert.equal(on(text, thread), GREEN);
    assert.equal(thread.revision, 2);
    assert.equal(fileOf(folder), text);
  } finally {
    await docs.close();
  }
});

test('a thread started on an earlier revision than the document is at is placed in the text of that revision and brought forward', async () => {
  const { docs, comment, threads, save } = await withDocument('docs-comments-stale-');
  try {
    const next = PLAN.replace('# Plan\n', '# Plan\n\nA new paragraph, written before.\n');
    await save(next, 1);
    // The page saw revision 1, and the document has moved on while the person typed the comment.
    const made = await comment(GREEN, 'Is this right?', 1, PLAN);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.revision, 2);
    assert.equal(on(next, made.body), GREEN);
    // The words it saw are not in the revision it names: refused, though they are in a later one.
    const other = await comment('A new paragraph, written before.', 'Hm', 1, next);
    assert.equal(other.status, 422);
    assert.equal((await threads()).threads.length, 1);
  } finally {
    await docs.close();
  }
});

test('a passage in a document written in another style than the editor\'s is found by its words, without the marks', async () => {
  const text = '# List\n\n* one\n* two\n* three\n\n| a   | b |\n| --- | - |\n| x   | y |\n';
  const { docs, threads, url } = await withDocument('docs-comments-style-', text);
  try {
    // The editor writes `-` for a bullet: its passage reads "- one\n- two" where the file has "* one\n* two".
    const made = await docs.call('POST', `${url}/threads`, { base: 1, quote: 'one\n- two', prefix: '# List\n\n- ', suffix: '\n- three', body: 'These two?' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.quote, 'one\n* two');
    assert.equal(on(text, made.body), 'one\n* two');
    // Too little to be told from other text with the marks left out is not guessed at.
    const short = await docs.call('POST', `${url}/threads`, { base: 1, quote: '-*-', body: 'x' });
    assert.equal(short.status, 422);
    assert.equal((await threads()).threads.length, 1);
  } finally {
    await docs.close();
  }
});

test('the comments are kept in the store: a portal started again over it finds them, replies included', async () => {
  const folder = realpathSync(scratch('docs-comments-again-'));
  const data = scratch('docs-comments-again-data-');
  const first = await portal({ a: folder }, data);
  const f = folderIdOf(folder);
  let id: string;
  let thread: string;
  try {
    id = (await first.call('POST', `/folders/${f}/documents`, { title: 'Plan', markdown: PLAN })).body.id;
    thread = (await first.call('POST', `/folders/${f}/documents/${id}/threads`, { base: 1, quote: GREEN, body: 'Is it?' })).body.id;
    await first.call('POST', `/folders/${f}/documents/${id}/threads/${thread}/comments`, { body: 'Yes.' });
  } finally {
    await first.close();
  }
  const second = await portal({ a: folder }, data);
  try {
    const { body } = await second.call('GET', `/folders/${f}/documents/${id}/threads`);
    assert.deepEqual(body.threads.map((t: any) => [t.id, t.quote, t.comments.map((c: any) => c.body)]), [[thread, GREEN, ['Is it?', 'Yes.']]]);
  } finally {
    await second.close();
  }
});

test('the stream of a document tells of a change to its comments, with no revision of its own, and says nothing for a change that changed nothing', async () => {
  const { docs, comment, url } = await withDocument('docs-comments-stream-');
  try {
    const events = url + '/events';
    const stream = await docs.listen(events);
    const first = await stream.next('revision');
    assert.equal(first?.data.revision, 1);
    const made = (await comment(GREEN)).body;
    const told = await stream.frame();
    assert.equal(told?.event, 'threads');
    assert.equal(told?.id, undefined, 'a change to the comments is not a revision');
    assert.ok(!Number.isNaN(Date.parse(told?.data.at)));
    await docs.call('POST', `${url}/threads/${made.id}/comments`, { body: 'Hi' });
    assert.equal((await stream.frame())?.event, 'threads');
    await docs.call('POST', `${url}/threads/${made.id}/resolve`, {});
    assert.equal((await stream.frame())?.event, 'threads');
    // Resolved already: nothing changes, nothing is told; the next thing told is the revision after it.
    await docs.call('POST', `${url}/threads/${made.id}/resolve`, {});
    await docs.call('PUT', url, { markdown: `${PLAN}Added.\n`, base: 1 });
    const next = await stream.frame();
    assert.equal(next?.event, 'revision');
    assert.equal(next?.data.revision, 2);
    // A refused comment tells nothing either.
    await docs.call('POST', `${url}/threads/${made.id}/comments`, { body: 'Closed.' });
    await docs.call('POST', `${url}/threads/${made.id}/reopen`, {});
    assert.equal((await stream.frame())?.event, 'threads');
  } finally {
    await docs.close();
  }
});

test('the comment the box saves as it is typed (a draft) is changed, and taken away when it is typed away, only while it is the last of an open thread', async () => {
  const { docs, comment, threads, url } = await withDocument('docs-comments-typed-');
  try {
    const made = (await comment(GREEN, 'Is')).body;
    const first = made.comments[0].id;
    const at = `${url}/threads/${made.id}/comments`;
    // What the box sends: it is a draft. (Without that a comment is changed whatever its place, by the tests below.)
    const put = (comment: string, body: object) => docs.call('PUT', `${at}/${comment}`, { draft: true, ...body });
    const del = (comment: string) => docs.call('DELETE', `${at}/${comment}?draft=1`);
    // Changed: the same comment, with the new words, and the thread changed with it.
    const changed = await put(first, { body: 'Is it right?' });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.deepEqual(changed.body.comments.map((c: any) => [c.id, c.author, c.body]), [[first, 'user', 'Is it right?']]);
    // A comment still being written is not an edited one.
    assert.equal(changed.body.comments[0].edited, undefined);
    assert.ok(changed.body.updatedAt >= made.updatedAt);
    assert.deepEqual((await threads()).threads[0].comments.map((c: any) => c.body), ['Is it right?']);
    // Not empty, not too long, and a comment that is there.
    assert.equal((await put(first, { body: '  ' })).body.code, 'invalid');
    assert.equal((await put(first, { body: 'x'.repeat(4097) })).body.code, 'too_large');
    assert.equal((await put('0123456789abcdef', { body: 'Hi' })).body.code, 'comment_not_found');
    assert.equal((await put(first, {})).status, 400);
    // A reply after it: the first is not the last any more, and neither is changed or taken away while it is not the last.
    const reply = (await docs.call('POST', at, { body: 'And?' })).body.comments[1].id;
    for (const refused of [await put(first, { body: 'Changed' }), await del(first)]) {
      assert.equal(refused.status, 409);
      assert.equal(refused.body.code, 'comment_not_last');
    }
    assert.equal((await threads()).threads[0].comments[0].body, 'Is it right?');
    // The last is taken away: the thread is as it was; the only comment, with its thread.
    const gone = await del(reply);
    assert.equal(gone.status, 200);
    assert.deepEqual([gone.body.removed, gone.body.thread.comments.map((c: any) => c.body)], ['comment', ['Is it right?']]);
    const alone = await del(first);
    assert.deepEqual(alone.body, { removed: 'thread', thread: null });
    assert.deepEqual((await threads()).threads, []);
    assert.equal((await docs.call('GET', '/folders')).body.folders[0].documents[0].openThreads, 0);
    assert.equal((await del(first)).body.code, 'thread_not_found');
  } finally {
    await docs.close();
  }
});

test('a draft of a resolved thread is not changed or taken away, and the stream tells of each change that is made', async () => {
  const { docs, comment, url } = await withDocument('docs-comments-typed-closed-');
  try {
    const stream = await docs.listen(`${url}/events`);
    await stream.next('revision');
    const made = (await comment(GREEN, 'Is it?')).body;
    assert.equal((await stream.frame())?.event, 'threads');
    const at = `${url}/threads/${made.id}/comments/${made.comments[0].id}`;
    assert.equal((await docs.call('PUT', at, { body: 'Is it right?', draft: true })).status, 200);
    assert.equal((await stream.frame())?.event, 'threads');
    await docs.call('POST', `${url}/threads/${made.id}/resolve`, {});
    assert.equal((await stream.frame())?.event, 'threads');
    for (const refused of [await docs.call('PUT', at, { body: 'Late', draft: true }), await docs.call('DELETE', `${at}?draft=1`)]) {
      assert.equal(refused.status, 409);
      assert.equal(refused.body.code, 'thread_resolved');
    }
    // The thread that was resolved is what it was.
    assert.deepEqual((await docs.call('GET', `${url}/threads`)).body.threads[0].comments.map((c: any) => c.body), ['Is it right?']);
    await docs.call('POST', `${url}/threads/${made.id}/reopen`, {});
    assert.equal((await stream.frame())?.event, 'threads');
    assert.equal((await docs.call('DELETE', `${at}?draft=1`)).body.removed, 'thread');
    assert.equal((await stream.frame())?.event, 'threads');
  } finally {
    await docs.close();
  }
});

test('a comment of the person is changed or taken away whatever its place in the thread: it is marked as edited, the passage and the other comments stay, and the stream tells of each', async () => {
  const { docs, comment, threads, url } = await withDocument('docs-comments-edit-');
  try {
    const stream = await docs.listen(`${url}/events`);
    await stream.next('revision');
    const made = (await comment(GREEN, 'First.')).body;
    assert.equal((await stream.frame())?.event, 'threads');
    const at = `${url}/threads/${made.id}/comments`;
    const first = made.comments[0].id;
    const second = (await docs.call('POST', at, { body: 'Second.' })).body.comments[1].id;
    assert.equal((await stream.frame())?.event, 'threads');
    await docs.call('POST', at, { body: 'Third.' });
    assert.equal((await stream.frame())?.event, 'threads');

    // The first of three, which is no draft and not the last: changed, and nothing else with it.
    const changed = await docs.call('PUT', `${at}/${first}`, { body: 'First, changed.' });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.deepEqual(changed.body.comments.map((c: any) => [c.author, c.body]), [['user', 'First, changed.'], ['user', 'Second.'], ['user', 'Third.']]);
    assert.ok(!Number.isNaN(Date.parse(changed.body.comments[0].edited)), 'marked as edited, with when');
    assert.deepEqual(changed.body.comments.slice(1).map((c: any) => c.edited), [undefined, undefined]);
    // Its passage is where it was, and the thread is as open as it was.
    assert.deepEqual([changed.body.quote, changed.body.start, changed.body.end, changed.body.status], [made.quote, made.start, made.end, 'open']);
    assert.ok(changed.body.updatedAt >= made.updatedAt);
    assert.equal((await stream.frame())?.event, 'threads');
    assert.deepEqual((await threads()).threads[0].comments.map((c: any) => c.body), ['First, changed.', 'Second.', 'Third.']);

    // The same words: it is not marked again, and nobody is told (the next thing told is the next change).
    const edited = changed.body.comments[0].edited;
    const same = await docs.call('PUT', `${at}/${first}`, { body: '  First, changed.  ' });
    assert.equal(same.status, 200);
    assert.equal(same.body.comments[0].edited, edited);
    // Not empty, not too long, and a comment that is there; nothing was changed by them.
    assert.equal((await docs.call('PUT', `${at}/${first}`, { body: '  ' })).body.code, 'invalid');
    assert.equal((await docs.call('PUT', `${at}/${first}`, { body: 'x'.repeat(4097) })).body.code, 'too_large');
    assert.equal((await docs.call('PUT', `${at}/0123456789abcdef`, { body: 'Hi' })).body.code, 'comment_not_found');
    assert.equal((await docs.call('PUT', `${at}/${first}`, {})).status, 400);

    // Taken away from the middle: the others stay, in their order, and the thread is open on its passage still.
    const gone = await docs.call('DELETE', `${at}/${second}`);
    assert.equal(gone.status, 200);
    assert.deepEqual([gone.body.removed, gone.body.thread.comments.map((c: any) => c.body), gone.body.thread.quote, gone.body.thread.status], ['comment', ['First, changed.', 'Third.'], GREEN, 'open']);
    assert.equal((await stream.frame())?.event, 'threads', 'only the change that was made was told');
    assert.equal((await docs.call('DELETE', `${at}/${second}`)).body.code, 'comment_not_found');
    // The first of two, then the only one: the thread goes with it.
    assert.equal((await docs.call('DELETE', `${at}/${first}`)).body.removed, 'comment');
    assert.equal((await stream.frame())?.event, 'threads');
    const last = (await threads()).threads[0].comments[0].id;
    assert.deepEqual((await docs.call('DELETE', `${at}/${last}`)).body, { removed: 'thread', thread: null });
    assert.equal((await stream.frame())?.event, 'threads');
    assert.deepEqual((await threads()).threads, []);
    assert.equal((await docs.call('GET', '/folders')).body.folders[0].documents[0].openThreads, 0);
    assert.equal((await docs.call('PUT', `${at}/${last}`, { body: 'Late' })).body.code, 'thread_not_found');
  } finally {
    await docs.close();
  }
});

test('a comment of a resolved thread is changed or taken away all the same, and the thread stays resolved', async () => {
  const { docs, comment, threads, url } = await withDocument('docs-comments-edit-closed-');
  try {
    const made = (await comment(GREEN, 'First.')).body;
    const at = `${url}/threads/${made.id}/comments`;
    const second = (await docs.call('POST', at, { body: 'Second.' })).body.comments[1].id;
    await docs.call('POST', `${url}/threads/${made.id}/resolve`, {});
    const changed = await docs.call('PUT', `${at}/${made.comments[0].id}`, { body: 'First, changed.' });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.deepEqual([changed.body.status, changed.body.comments.map((c: any) => c.body)], ['resolved', ['First, changed.', 'Second.']]);
    assert.ok(changed.body.comments[0].edited);
    const gone = await docs.call('DELETE', `${at}/${second}`);
    assert.deepEqual([gone.body.removed, gone.body.thread.status, gone.body.thread.comments.map((c: any) => c.body)], ['comment', 'resolved', ['First, changed.']]);
    // Nothing is added to it, as before; and its only comment goes with the thread.
    assert.equal((await docs.call('POST', at, { body: 'Late.' })).body.code, 'thread_resolved');
    assert.deepEqual((await docs.call('DELETE', `${at}/${made.comments[0].id}`)).body, { removed: 'thread', thread: null });
    assert.deepEqual((await threads()).threads, []);
  } finally {
    await docs.close();
  }
});

test('a thread the person started is taken away with its comments, open or resolved: the other threads stay, and the stream tells of it', async () => {
  const { docs, comment, threads, url, folder } = await withDocument('docs-comments-thread-');
  try {
    const stream = await docs.listen(`${url}/events`);
    await stream.next('revision');
    const one = (await comment(GREEN, 'One.')).body;
    const other = (await comment('Sign-off is on Monday.', 'Who signs off?')).body;
    await stream.frame();
    await stream.frame();
    await docs.call('POST', `${url}/threads/${one.id}/comments`, { body: 'Two.' });
    await stream.frame();
    const gone = await docs.call('DELETE', `${url}/threads/${one.id}`);
    assert.deepEqual([gone.status, gone.body], [200, { removed: 'thread' }]);
    assert.equal((await stream.frame())?.event, 'threads');
    assert.deepEqual((await threads()).threads.map((t: any) => t.id), [other.id]);
    assert.equal((await docs.call('GET', '/folders')).body.folders[0].documents[0].openThreads, 1);
    // Its comments went with it, not only the thread.
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(path.join(DATA, folderIdOf(folder), 'docs.sqlite'), { readonly: true });
    assert.deepEqual(db.prepare('SELECT body FROM comments').all(), [{ body: 'Who signs off?' }]);
    db.close();
    // Not there any more, or never was.
    assert.equal((await docs.call('DELETE', `${url}/threads/${one.id}`)).body.code, 'thread_not_found');
    assert.equal((await docs.call('DELETE', `${url}/threads/nope`)).body.code, 'thread_not_found');
    // A resolved thread is taken away as well.
    await docs.call('POST', `${url}/threads/${other.id}/resolve`, {});
    await stream.frame();
    assert.equal((await docs.call('DELETE', `${url}/threads/${other.id}`)).status, 200);
    assert.equal((await stream.frame())?.event, 'threads');
    assert.deepEqual((await threads()).threads, []);
  } finally {
    await docs.close();
  }
});

test('a database from before comments could be changed gets the mark added, and keeps its comments', async () => {
  const folder = realpathSync(scratch('docs-comments-migrate-'));
  const data = scratch('docs-comments-migrate-data-');
  const f = folderIdOf(folder);
  const first = await portal({ a: folder }, data);
  let id: string;
  let thread: any;
  try {
    id = (await first.call('POST', `/folders/${f}/documents`, { title: 'Plan', markdown: PLAN })).body.id;
    thread = (await first.call('POST', `/folders/${f}/documents/${id}/threads`, { base: 1, quote: GREEN, body: 'Is it?' })).body;
  } finally {
    await first.close();
  }
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(path.join(data, f, 'docs.sqlite'));
  db.exec('ALTER TABLE comments DROP COLUMN edited_at');
  assert.ok(!db.prepare('PRAGMA table_info(comments)').all().some((c: any) => c.name === 'edited_at'));
  db.close();
  const second = await portal({ a: folder }, data);
  try {
    const url = `/folders/${f}/documents/${id}/threads/${thread.id}/comments/${thread.comments[0].id}`;
    assert.deepEqual((await second.call('GET', `/folders/${f}/documents/${id}/threads`)).body.threads.map((t: any) => t.comments.map((c: any) => [c.body, c.edited])), [[['Is it?', undefined]]]);
    const changed = await second.call('PUT', url, { body: 'Is it right?' });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.deepEqual(changed.body.comments.map((c: any) => [c.body, Boolean(c.edited)]), [['Is it right?', true]]);
  } finally {
    await second.close();
  }
});
