import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express from 'express';
import docsServer from '../server.js';
import { folderFiles } from '../../../core/server/src/folder-files.ts';
import { scratch } from '../../../tests/helpers.mts';

/**
 * The agent's tools for comments (extensions/docs/tools.js): doc_comment, doc_reply and doc_resolve, the comments in
 * what doc_read and doc_list say, and doc_edit answering a comment, through the server half as the portal runs it,
 * against a real store on disk. The person works through the routes.
 */

const DATA = scratch('docs-comment-tools-data-');

type Result = { ok: true; text: string; details: any } | { ok: false; error: string };

async function portal(chats: Record<string, string>, faults?: { after(step: string): void }) {
  const router = express.Router();
  const factories: ((pi: unknown, chat: unknown) => void)[] = [];
  const logged: string[] = [];
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
    },
  }, { dependencies: async () => true, pollMs: 0, faults }) as () => Promise<void>;
  const app = express();
  app.use('/x', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  const agent = (chat: string) => {
    const tools = new Map<string, any>();
    for (const factory of factories) factory({ registerTool: (tool: any) => tools.set(tool.name, tool), events: { on: () => () => {} }, on: () => {} }, { id: chat, title: `Chat ${chat}`, workspace: chats[chat], status: 'idle' });
    return async (name: string, params: unknown): Promise<Result> => {
      try {
        const result = await tools.get(name).execute('call-1', params, undefined, undefined, {});
        return { ok: true, text: result.content[0].text, details: result.details };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    };
  };
  const tools = (chat: string) => {
    const found = new Map<string, any>();
    for (const factory of factories) factory({ registerTool: (tool: any) => found.set(tool.name, tool), events: { on: () => () => {} }, on: () => {} }, { id: chat, title: `Chat ${chat}`, workspace: chats[chat], status: 'idle' });
    return found;
  };
  return { call, agent, tools, logged, close: async () => { await stop(); server.close(); } };
}

const folderIdOf = (folder: string) => createHash('sha256').update(folder).digest('hex').slice(0, 16);
const fileOf = (folder: string, name = 'plan.md') => readFileSync(path.join(folder, 'documents', name), 'utf8');

function refused(result: Result, code: string) {
  assert.equal(result.ok, false, `refused with ${code}`);
  assert.match((result as any).error, new RegExp(`^${code}: `));
  return (result as any).error as string;
}
function done(result: Result) {
  assert.equal(result.ok, true, (result as any).error);
  return result as Extract<Result, { ok: true }>;
}

const PLAN = '# Plan\n\nShip it on Friday.\n\nThe build is green, and the build is green again.\n\nSign-off is on Monday.\n';

async function withDocument(prefix: string, markdown = PLAN, faults?: { after(step: string): void }) {
  const folder = realpathSync(scratch(prefix));
  const docs = await portal({ a: folder }, faults);
  const f = folderIdOf(folder);
  const made = await docs.call('POST', `/folders/${f}/documents`, { title: 'Plan', markdown });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.id as string;
  const url = `/folders/${f}/documents/${id}`;
  const threads = async () => (await docs.call('GET', `${url}/threads`)).body.threads as any[];
  /** A comment the person made on `quote`. */
  const person = async (quote: string, body: string) => {
    const start = markdown.indexOf(quote);
    const made = await docs.call('POST', `${url}/threads`, { base: 1, quote, start, body });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return made.body as any;
  };
  return { folder, docs, f, id, url, agent: docs.agent('a'), threads, person };
}

test('the agent comments on a passage it quotes: the thread is its own, on that passage, and the person sees it on the page', async () => {
  const { folder, docs, id, url, agent, threads } = await withDocument('docs-ct-comment-');
  try {
    const made = done(await agent('doc_comment', { id, quote: 'Ship it on Friday.', comment: 'I chose **Friday** because the review is on Thursday.' }));
    assert.match(made.details.thread, /^[0-9a-f]{16}$/);
    assert.equal(made.details.action, 'comment');
    assert.equal(made.details.id, id);
    assert.equal(made.details.folder, folderIdOf(folder));
    assert.ok(made.text.includes(made.details.thread));
    const [thread] = await threads();
    assert.equal(thread.id, made.details.thread);
    assert.equal(thread.quote, 'Ship it on Friday.');
    assert.equal(thread.status, 'open');
    assert.deepEqual(thread.comments.map((c: any) => [c.author, c.body]), [['agent', 'I chose **Friday** because the review is on Thursday.']]);
    assert.equal(PLAN.slice(thread.start, thread.end), 'Ship it on Friday.');
    // Commenting does not change the document.
    assert.equal(fileOf(folder), PLAN);
    assert.equal((await docs.call('GET', url)).body.revision, 1);
  } finally {
    await docs.close();
  }
});

test('a comment is refused when the passage is not in the document, is in it twice, is empty or too long, and nothing is stored', async () => {
  const { docs, id, agent, threads } = await withDocument('docs-ct-comment-refused-');
  try {
    refused(await agent('doc_comment', { id, quote: 'Not in the document.', comment: 'Hm' }), 'quote_not_found');
    const twice = refused(await agent('doc_comment', { id, quote: 'build is green', comment: 'Hm' }), 'quote_ambiguous');
    assert.match(twice, /more than once/);
    refused(await agent('doc_comment', { id, quote: '', comment: 'Hm' }), 'invalid');
    refused(await agent('doc_comment', { id, quote: '  \n', comment: 'Hm' }), 'invalid');
    refused(await agent('doc_comment', { id, quote: 'Ship it on Friday.', comment: '' }), 'invalid');
    refused(await agent('doc_comment', { id, quote: 'Ship it on Friday.', comment: '   ' }), 'invalid');
    refused(await agent('doc_comment', { id, quote: 'Ship it on Friday.' }), 'invalid');
    refused(await agent('doc_comment', { id, quote: 'Ship it on Friday.', comment: 'x'.repeat(4097) }), 'too_large');
    refused(await agent('doc_comment', { id, quote: 'x'.repeat(5001), comment: 'Hm' }), 'too_large');
    refused(await agent('doc_comment', { id: '0123456789abcdef', quote: 'Ship it on Friday.', comment: 'Hm' }), 'not_found');
    refused(await agent('doc_comment', { id: 7, quote: 'Ship it on Friday.', comment: 'Hm' }), 'not_found');
    assert.deepEqual(await threads(), []);
  } finally {
    await docs.close();
  }
});

test('a passage of a document written with CRLF line breaks is quoted with line feeds', async () => {
  const text = '# Plan\r\n\r\nFirst line\r\nsecond line.\r\n\r\nEnd.\r\n';
  const { docs, id, agent, threads } = await withDocument('docs-ct-comment-crlf-', text);
  try {
    done(await agent('doc_comment', { id, quote: 'First line\nsecond line.', comment: 'Two lines.' }));
    const [thread] = await threads();
    assert.equal(thread.quote, 'First line\r\nsecond line.');
    assert.equal(text.slice(thread.start, thread.end), 'First line\r\nsecond line.');
  } finally {
    await docs.close();
  }
});

test('what doc_read says of the comments: the open threads after the text, with their ids, passages, lines and what was said', async () => {
  const { docs, id, agent, threads, person, url } = await withDocument('docs-ct-read-');
  try {
    // Nothing to say while there are none.
    assert.ok(done(await agent('doc_read', { id })).text.endsWith('Sign-off is on Monday.\n'));
    const asked = await person('Sign-off is on Monday.', 'Who signs off?');
    done(await agent('doc_reply', { id, thread: asked.id, comment: 'The release manager.' }));
    const own = done(await agent('doc_comment', { id, quote: 'Ship it on Friday.', comment: 'Why Friday?' }));
    const read = done(await agent('doc_read', { id })).text;
    const [text, comments] = read.split('\n\nOpen comments: ');
    assert.ok(text.endsWith('Sign-off is on Monday.\n[End of the document.]'), 'the text comes first, whole, and says where it ends');
    assert.match(comments, /^2\. Answer one with doc_reply/);
    assert.ok(comments.includes(`Thread ${asked.id} (open, on line 7)\nPassage:\n> Sign-off is on Monday.\nperson (`));
    assert.ok(comments.includes(`): Who signs off?\nagent (`));
    assert.ok(comments.includes('): The release manager.'));
    assert.ok(comments.includes(`Thread ${own.details.thread} (open, on line 3)\nPassage:\n> Ship it on Friday.\n`));
    assert.ok(comments.indexOf(asked.id) < comments.indexOf(own.details.thread), 'oldest first');

    // Resolved ones are counted, and shown on request; none at all on request.
    await docs.call('POST', `${url}/threads/${asked.id}/resolve`, {});
    const resolved = done(await agent('doc_read', { id })).text;
    assert.ok(resolved.includes('Open comments: 1 (1 resolved, not shown)'));
    assert.ok(!resolved.includes('Who signs off?'));
    const all = done(await agent('doc_read', { id, comments: 'all' })).text;
    assert.ok(all.includes('Comments: 2 threads, 1 open') && all.includes('Who signs off?') && all.includes(`Thread ${asked.id} (resolved, `));
    const none = done(await agent('doc_read', { id, comments: 'none' })).text;
    assert.ok(none.endsWith('Sign-off is on Monday.\n'));
    refused(await agent('doc_read', { id, comments: 'some' }), 'invalid');

    // An earlier revision is read as it was, with no comments: their passages are places in the text as it is now.
    await docs.call('PUT', url, { markdown: `${PLAN}Added.\n`, base: 1 });
    const earlier = done(await agent('doc_read', { id, revision: 1 })).text;
    assert.ok(!earlier.includes('Open comments') && !earlier.includes('Why Friday?'));
    const now = done(await agent('doc_read', { id })).text;
    assert.ok(now.includes('Thread ') && now.includes('Why Friday?'));
    assert.equal((await threads()).length, 2);
    // Only with the first part of a document that is read in parts.
    assert.ok(!done(await agent('doc_read', { id, from_line: 3 })).text.includes('Open comments'));
  } finally {
    await docs.close();
  }
});

test('doc_read says when the passage of a comment is no longer in the document, and where a long thread starts', async () => {
  const { docs, id, agent, person, url, threads } = await withDocument('docs-ct-read-orphan-');
  try {
    const asked = await person('Sign-off is on Monday.', 'Who signs off?');
    for (let n = 1; n <= 12; n++) await docs.call('POST', `${url}/threads/${asked.id}/comments`, { body: `Reply ${n}` });
    await docs.call('PUT', url, { markdown: PLAN.replace('Sign-off is on Monday.\n', ''), base: 1 });
    assert.equal((await threads())[0].orphaned, true);
    const read = done(await agent('doc_read', { id })).text;
    assert.ok(read.includes(`Thread ${asked.id} (open, its passage is no longer in the document)\nPassage when it was last in the document:\n> Sign-off is on Monday.`));
    // The last ten comments are shown, and the number of the others.
    assert.ok(read.includes('[3 earlier comments not shown]') && read.includes('Reply 12') && !read.includes('): Reply 2\n') && read.includes('): Reply 3'));
  } finally {
    await docs.close();
  }
});

test('doc_list says how many comments are open on each document', async () => {
  const { docs, agent, person, url } = await withDocument('docs-ct-list-');
  try {
    assert.ok(!done(await agent('doc_list', {})).text.includes('open comment'));
    const one = await person('Ship it on Friday.', 'Why?');
    await person('Sign-off is on Monday.', 'Who?');
    const listed = done(await agent('doc_list', {}));
    assert.match(listed.text, /  2 open comments$/m);
    assert.equal(listed.details.documents[0].openThreads, 2);
    await docs.call('POST', `${url}/threads/${one.id}/resolve`, {});
    assert.match(done(await agent('doc_list', {})).text, /  1 open comment$/m);
  } finally {
    await docs.close();
  }
});

test('the agent replies to an open thread, and the reply is its own, after what was said', async () => {
  const { docs, id, agent, person, threads, url } = await withDocument('docs-ct-reply-');
  try {
    const asked = await person('Ship it on Friday.', 'Could this be Thursday?');
    const replied = done(await agent('doc_reply', { id, thread: asked.id, comment: 'Not before the review: **Friday**.' }));
    assert.equal(replied.details.thread, asked.id);
    assert.equal(replied.details.action, 'reply');
    const [thread] = await threads();
    assert.deepEqual(thread.comments.map((c: any) => [c.author, c.body]), [['user', 'Could this be Thursday?'], ['agent', 'Not before the review: **Friday**.']]);
    // The person's page is told of it (the stream tells; the thread is listed).
    assert.equal(thread.status, 'open');
    // Not to a thread that is not there, is another document's, or is resolved; not empty, not too long.
    refused(await agent('doc_reply', { id, thread: '0000000000000000', comment: 'Hi' }), 'thread_not_found');
    refused(await agent('doc_reply', { id, thread: 'nope', comment: 'Hi' }), 'thread_not_found');
    refused(await agent('doc_reply', { id, thread: undefined, comment: 'Hi' }), 'thread_not_found');
    refused(await agent('doc_reply', { id, thread: asked.id, comment: '' }), 'invalid');
    refused(await agent('doc_reply', { id, thread: asked.id, comment: 'x'.repeat(4097) }), 'too_large');
    await docs.call('POST', `${url}/threads/${asked.id}/resolve`, {});
    refused(await agent('doc_reply', { id, thread: asked.id, comment: 'Hi' }), 'thread_resolved');
    assert.equal((await threads())[0].comments.length, 2);
    const other = done(await agent('doc_create', { title: 'Other' }));
    refused(await agent('doc_reply', { id: other.details.id, thread: asked.id, comment: 'Hi' }), 'thread_not_found');
  } finally {
    await docs.close();
  }
});

test('the agent resolves a thread, with a last comment, and says so when it was resolved already', async () => {
  const { docs, id, agent, person, threads, url } = await withDocument('docs-ct-resolve-');
  try {
    const asked = await person('Ship it on Friday.', 'Please say when exactly.');
    const resolved = done(await agent('doc_resolve', { id, thread: asked.id, comment: 'Added the time.' }));
    assert.equal(resolved.details.changed, true);
    let [thread] = await threads();
    assert.equal(thread.status, 'resolved');
    assert.deepEqual(thread.comments.map((c: any) => [c.author, c.body]), [['user', 'Please say when exactly.'], ['agent', 'Added the time.']]);
    const again = done(await agent('doc_resolve', { id, thread: asked.id, comment: 'Once more.' }));
    assert.equal(again.details.changed, false);
    assert.match(again.text, /resolved already/);
    [thread] = await threads();
    assert.equal(thread.comments.length, 2, 'nothing was added the second time');
    // Without a comment, and the person opens it again.
    await docs.call('POST', `${url}/threads/${asked.id}/reopen`, {});
    done(await agent('doc_resolve', { id, thread: asked.id }));
    assert.equal((await threads())[0].comments.length, 2);
    refused(await agent('doc_resolve', { id, thread: '0000000000000000' }), 'thread_not_found');
    refused(await agent('doc_resolve', { id, thread: asked.id, comment: 7 }), 'invalid');
  } finally {
    await docs.close();
  }
});

test('an edit that answers a comment changes only the passage the comment is on, and says what was changed in the thread', async () => {
  const { folder, docs, id, agent, person, threads } = await withDocument('docs-ct-edit-');
  try {
    const asked = await person('Ship it on Friday.', 'Make this less vague.');
    const edited = done(await agent('doc_edit', {
      id, expected_revision: 1, thread: asked.id,
      edits: [{ quote: 'Friday', replacement: 'Friday afternoon, before the review' }],
      reply: 'Added the time of day and the reason: **Friday afternoon, before the review**.',
    }));
    assert.equal(edited.details.thread, asked.id);
    assert.equal(edited.details.replied, true);
    assert.match(edited.text, /Your reply is in thread/);
    const text = PLAN.replace('Friday', 'Friday afternoon, before the review');
    assert.equal(fileOf(folder), text);
    const [thread] = await threads();
    // The passage is what stands there now, including what was added at its end, and the reply is the agent's.
    assert.equal(thread.quote, 'Ship it on Friday afternoon, before the review.');
    assert.equal(text.slice(thread.start, thread.end), thread.quote);
    assert.equal(thread.revision, 2);
    assert.deepEqual(thread.comments.map((c: any) => c.author), ['user', 'agent']);
    assert.ok(thread.comments[1].body.includes('Friday afternoon, before the review'));
    assert.equal(thread.status, 'open', 'closing it is the person\'s to say, or doc_resolve\'s');
  } finally {
    await docs.close();
  }
});

test('a passage the agent rewrites to answer a comment stays the passage, however little of the old words are in the new', async () => {
  const { folder, docs, id, agent, person, threads } = await withDocument('docs-ct-edit-rewrite-');
  try {
    const asked = await person('Ship it on Friday.', 'Say something more useful.');
    const sign = await person('Sign-off is on Monday.', 'Who?');
    done(await agent('doc_edit', { id, expected_revision: 1, thread: asked.id, edits: [{ quote: 'Ship it on Friday.', replacement: 'The release goes out Thursday night.' }], reply: 'Rewrote it.' }));
    const text = fileOf(folder);
    assert.ok(text.includes('The release goes out Thursday night.'));
    const listed = await threads();
    const mine = listed.find((t: any) => t.id === asked.id);
    // Nothing of the old sentence is in the new one, which a walk by the two texts takes for the old being gone: the agent knows where it put it.
    assert.equal(mine.orphaned, false);
    assert.equal(text.slice(mine.start, mine.end), 'The release goes out Thursday night.');
    assert.equal(mine.quote, 'The release goes out Thursday night.');
    assert.equal(mine.revision, 2);
    // The other thread moved with the text, as it did before.
    assert.equal(text.slice(listed.find((t: any) => t.id === sign.id).start, listed.find((t: any) => t.id === sign.id).end), 'Sign-off is on Monday.');
  } finally {
    await docs.close();
  }
});

test('with a thread, the quotes are looked for in the passage only: a word that is in the document twice is one place in it, and nothing outside is touched', async () => {
  const { folder, docs, id, agent, person, threads } = await withDocument('docs-ct-edit-scope-');
  try {
    const asked = await person('The build is green, and the build is green again.', 'Too repetitive.');
    // "green" is four times in the document and twice in the passage; "again" once in the passage.
    refused(await agent('doc_edit', { id, expected_revision: 1, thread: asked.id, edits: [{ quote: 'green', replacement: 'passing' }], reply: 'Done.' }), 'quote_ambiguous');
    // Outside the passage: in the document, but not in what the comment is on.
    refused(await agent('doc_edit', { id, expected_revision: 1, thread: asked.id, edits: [{ quote: 'Sign-off', replacement: 'Approval' }], reply: 'Done.' }), 'quote_not_found');
    refused(await agent('doc_edit', { id, expected_revision: 1, thread: asked.id, edits: [{ quote: 'Ship it', replacement: 'Release it' }], reply: 'Done.' }), 'quote_not_found');
    assert.equal(fileOf(folder), PLAN, 'nothing was written');
    assert.equal((await threads())[0].comments.length, 1, 'and no reply was added');
    const out = done(await agent('doc_edit', { id, expected_revision: 1, thread: asked.id, edits: [{ quote: ', and the build is green again', replacement: ' again' }], reply: 'Shortened it.' }));
    assert.ok(out.details.replied);
    assert.equal(fileOf(folder), PLAN.replace(', and the build is green again', ' again'));
    assert.equal((await threads())[0].quote, 'The build is green again.');
  } finally {
    await docs.close();
  }
});

test('a paragraph taken out of a passage of two takes its line breaks with it, as it would without the thread', async () => {
  const { folder, docs, id, agent, person, threads } = await withDocument('docs-ct-edit-paragraph-');
  try {
    // The passage starts at a paragraph and ends at the next: the blank line before it is outside, the one after it inside.
    const asked = await person('Ship it on Friday.\n\nThe build is green, and the build is green again.', 'Is the first line needed?');
    done(await agent('doc_edit', { id, expected_revision: 1, thread: asked.id, edits: [{ quote: 'Ship it on Friday.', replacement: '' }], reply: 'Took it out.' }));
    assert.equal(fileOf(folder), PLAN.replace('Ship it on Friday.\n\n', ''));
    const [thread] = await threads();
    assert.equal(thread.quote, 'The build is green, and the build is green again.');
  } finally {
    await docs.close();
  }
});

test('an edit with a thread is refused, and nothing is written, for a thread that is not open or not there, a missing reply, or a reply that cannot be kept', async () => {
  const { folder, docs, id, agent, person, threads, url } = await withDocument('docs-ct-edit-refused-');
  try {
    const asked = await person('Ship it on Friday.', 'Hm');
    const edit = (extra: any) => agent('doc_edit', { id, expected_revision: 1, edits: [{ quote: 'Friday', replacement: 'Thursday' }], ...extra });
    refused(await edit({ thread: asked.id }), 'invalid');
    refused(await edit({ thread: asked.id, reply: '  ' }), 'invalid');
    refused(await edit({ thread: asked.id, reply: 'x'.repeat(4097) }), 'too_large');
    refused(await edit({ reply: 'Done.' }), 'invalid');
    refused(await edit({ thread: 7, reply: 'Done.' }), 'invalid');
    refused(await edit({ thread: '0000000000000000', reply: 'Done.' }), 'thread_not_found');
    refused(await edit({ thread: 'nope', reply: 'Done.' }), 'thread_not_found');
    await docs.call('POST', `${url}/threads/${asked.id}/resolve`, {});
    refused(await edit({ thread: asked.id, reply: 'Done.' }), 'thread_resolved');
    await docs.call('POST', `${url}/threads/${asked.id}/reopen`, {});
    // A thread whose passage is gone has none to change.
    const gone = await person('Sign-off is on Monday.', 'Who?');
    await docs.call('PUT', url, { markdown: PLAN.replace('Sign-off is on Monday.\n', ''), base: 1 });
    refused(await agent('doc_edit', { id, expected_revision: 2, thread: gone.id, edits: [{ quote: 'Monday', replacement: 'Tuesday' }], reply: 'Done.' }), 'thread_orphaned');
    // A document that moved on since it was read.
    refused(await agent('doc_edit', { id, expected_revision: 1, thread: asked.id, edits: [{ quote: 'Friday', replacement: 'Thursday' }], reply: 'Done.' }), 'revision_mismatch');
    assert.equal(fileOf(folder), PLAN.replace('Sign-off is on Monday.\n', ''));
    assert.equal((await threads()).find((t: any) => t.id === asked.id).comments.length, 1);
  } finally {
    await docs.close();
  }
});

test('an edit with a thread is refused before anything is written when the thread has no room for the reply', async () => {
  const { folder, docs, id, agent, person, threads } = await withDocument('docs-ct-edit-full-');
  try {
    const asked = await person('Ship it on Friday.', 'Hm');
    // 99 comments in the thread, put in the database straight (ninety-eight requests would be the same test, slower).
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(path.join(DATA, folderIdOf(folder), 'docs.sqlite'));
    const insert = db.prepare("INSERT INTO comments (id, thread_id, author, body, created_at) VALUES (?, ?, 'user', ?, ?)");
    db.transaction(() => { for (let n = 2; n < 100; n++) insert.run(n.toString(16).padStart(16, '0'), asked.id, `Reply ${n}`, new Date().toISOString()); })();
    db.close();
    // Room for one more, which the edit's reply takes.
    done(await agent('doc_edit', { id, expected_revision: 1, thread: asked.id, edits: [{ quote: 'Friday', replacement: 'Thursday' }], reply: 'Changed it.' }));
    assert.equal((await threads())[0].comments.length, 100);
    // No more room: refused before anything is written.
    refused(await agent('doc_edit', { id, expected_revision: 2, thread: asked.id, edits: [{ quote: 'Thursday', replacement: 'Friday' }], reply: 'Changed it back.' }), 'too_many');
    assert.equal(fileOf(folder), PLAN.replace('Friday', 'Thursday'));
  } finally {
    await docs.close();
  }
});

test('an edit with a thread whose reply cannot be added after the change says so, and the change stays made', async () => {
  // The thread is resolved by another window of the portal between the change and the reply: it is done in the database at
  // the moment the change is committed.
  let resolve: () => void = () => {};
  const { folder, docs, id, agent, person, threads } = await withDocument('docs-ct-edit-late-', PLAN, { after: (step) => step === 'commit' && resolve() });
  try {
    const asked = await person('Ship it on Friday.', 'Hm');
    const { default: Database } = await import('better-sqlite3');
    resolve = () => {
      resolve = () => {};
      const db = new Database(path.join(DATA, folderIdOf(folder), 'docs.sqlite'));
      db.prepare("UPDATE threads SET status = 'resolved' WHERE id = ?").run(asked.id);
      db.close();
    };
    const edited = done(await agent('doc_edit', { id, expected_revision: 1, thread: asked.id, edits: [{ quote: 'Friday', replacement: 'Thursday' }], reply: 'Changed it.' }));
    assert.equal(fileOf(folder), PLAN.replace('Friday', 'Thursday'), 'the change is made');
    assert.match(edited.text, /The reply could not be added to thread [0-9a-f]{16} \(thread_resolved: /);
    assert.match(edited.text, /add it with doc_reply/);
    assert.equal(edited.details.replied, undefined);
    const [thread] = await threads();
    assert.equal(thread.comments.length, 1, 'no reply');
    assert.equal(thread.quote, 'Ship it on Thursday.', 'the passage is where the change put it all the same');
  } finally {
    await docs.close();
  }
});

test('an edit without a thread is as it was, and a comment whose passage the agent changes that way follows the change', async () => {
  const { folder, docs, id, agent, person, threads } = await withDocument('docs-ct-edit-plain-');
  try {
    const asked = await person('Sign-off is on Monday.', 'Who?');
    done(await agent('doc_edit', { id, expected_revision: 1, edits: [{ quote: 'Ship it on Friday.', replacement: 'Ship it on Friday.\n\nA new paragraph.' }] }));
    const [thread] = await threads();
    assert.equal(thread.id, asked.id);
    assert.equal(fileOf(folder).slice(thread.start, thread.end), 'Sign-off is on Monday.');
    assert.equal(thread.comments.length, 1, 'no reply for an edit that answers nothing');
  } finally {
    await docs.close();
  }
});

test('the agent of one chat cannot comment on, reply in or resolve a thread of a document it does not see', async () => {
  const folder = realpathSync(scratch('docs-ct-scope-'));
  const docs = await portal({ a: folder, b: folder });
  try {
    const a = docs.agent('a');
    const b = docs.agent('b');
    const mine = done(await a('doc_create', { title: 'Mine', markdown: '# Mine\n\nA private note.\n', scope: 'chat' })).details.id;
    const thread = done(await a('doc_comment', { id: mine, quote: 'A private note.', comment: 'Hm' })).details.thread;
    refused(await b('doc_comment', { id: mine, quote: 'A private note.', comment: 'Hm' }), 'not_found');
    refused(await b('doc_reply', { id: mine, thread, comment: 'Hm' }), 'not_found');
    refused(await b('doc_resolve', { id: mine, thread }), 'not_found');
    refused(await b('doc_edit', { id: mine, expected_revision: 1, thread, edits: [{ quote: 'private', replacement: 'public' }], reply: 'x' }), 'not_found');
    assert.ok(!done(await b('doc_list', {})).text.includes('Mine'));
    // The project's own document is both chats'.
    const shared = done(await a('doc_create', { title: 'Shared', markdown: '# Shared\n\nHello there.\n' })).details.id;
    const t = done(await a('doc_comment', { id: shared, quote: 'Hello there.', comment: 'Hi' })).details.thread;
    done(await b('doc_reply', { id: shared, thread: t, comment: 'Hi back' }));
    assert.ok(done(await a('doc_read', { id: shared })).text.includes('agent ('));
  } finally {
    await docs.close();
  }
});

test('the tools say what they are for, and the rule for answering a comment is in the agent\'s instructions', async () => {
  const docs = await portal({ a: realpathSync(scratch('docs-ct-describe-')) });
  try {
    const tools = docs.tools('a');
    for (const name of ['doc_comment', 'doc_reply', 'doc_resolve', 'doc_edit_comment', 'doc_delete_comment']) {
      const tool = tools.get(name);
      assert.ok(tool.description.length > 80 && tool.label && tool.promptSnippet, name);
      assert.ok(tool.parameters.required.includes('id'), name);
      assert.equal(tool.executionMode, 'sequential', 'a comment is made after the one before it');
      assert.ok(!/\bKB\b/.test(tool.description), 'sizes are counted in bytes or characters, not KB');
    }
    // The rule for answering a comment is in the agent's instructions for the tools that carry it out.
    assert.ok(tools.get('doc_edit').promptGuidelines.some((g: string) => /comment/.test(g) && /thread/.test(g) && /reply/.test(g)));
    assert.ok(tools.get('doc_reply').promptGuidelines.some((g: string) => /what was done/.test(g)));
    // And that the agent's own comments are its to change, and the person's never its to delete.
    assert.ok(tools.get('doc_delete_comment').promptGuidelines.some((g: string) => /own comments/.test(g) && /person/.test(g) && /doc_reply/.test(g) && /doc_resolve/.test(g)));
    assert.deepEqual(tools.get('doc_delete_comment').parameters.required, ['id', 'thread', 'comment_id']);
    assert.deepEqual(tools.get('doc_edit_comment').parameters.required, ['id', 'thread', 'comment_id', 'comment']);
    assert.ok(tools.get('doc_edit').parameters.properties.thread && tools.get('doc_edit').parameters.properties.reply);
    assert.deepEqual(tools.get('doc_edit').parameters.required, ['id', 'expected_revision', 'edits']);
  } finally {
    await docs.close();
  }
});

test('the agent\'s comments are not the person\'s to change or take away: the page can only change its own', async () => {
  const { docs, agent, person, url, threads } = await withDocument('docs-ct-yours-');
  try {
    const mine = await person('Ship it on Friday.', 'Why?');
    await agent('doc_reply', { id: (await docs.call('GET', '/folders')).body.folders[0].documents[0].id, thread: mine.id, comment: 'Because.' });
    const [thread] = await threads();
    const theirs = thread.comments[1].id;
    for (const [method, body] of [['PUT', { body: 'Changed' }], ['DELETE', undefined]] as const) {
      const refused = await docs.call(method, `${url}/threads/${mine.id}/comments/${theirs}`, body);
      assert.equal(refused.status, 409, method);
      assert.equal(refused.body.code, 'comment_not_yours', method);
    }
    assert.deepEqual((await threads())[0].comments.map((c: any) => c.body), ['Why?', 'Because.']);
  } finally {
    await docs.close();
  }
});

test('the agent changes its own comments and replies, whichever they are: doc_read shows their ids, the person sees them as edited, and the thread is news again only if it was the last', async () => {
  const { docs, id, agent, person, threads, url } = await withDocument('docs-ct-edit-comment-');
  try {
    const asked = await person('Ship it on Friday.', 'Why Friday?');
    done(await agent('doc_reply', { id, thread: asked.id, comment: 'Because of the review.' }));
    await docs.call('POST', `${url}/threads/${asked.id}/comments`, { body: 'And Monday?' });
    done(await agent('doc_reply', { id, thread: asked.id, comment: 'Monday is sign-off.' }));
    let [thread] = await threads();
    const [mine, a1, theirs, a2] = thread.comments;
    // The ids of the agent's own comments are in what it reads, and the person's are not.
    const read = done(await agent('doc_read', { id })).text;
    assert.ok(read.includes(`, comment ${a1.id}): Because of the review.`) && read.includes(`, comment ${a2.id}): Monday is sign-off.`), read);
    assert.ok(!read.includes(mine.id) && !read.includes(theirs.id), 'a comment of the person has no id to give');
    assert.ok(!/edited/.test(read.split('\n\nOpen comments: ')[1]));

    // The person has seen the answer: the agent changing the first of its two comments (not the last) is no news.
    await docs.call('POST', `${url}/threads/${asked.id}/seen`);
    assert.equal((await threads())[0].answered, false);
    const first = done(await agent('doc_edit_comment', { id, thread: asked.id, comment_id: a1.id, comment: 'Because the review is on **Thursday**.' }));
    assert.deepEqual([first.details.action, first.details.thread, first.details.comment, first.details.id], ['edit_comment', asked.id, a1.id, id]);
    assert.ok(first.text.includes(asked.id));
    [thread] = await threads();
    assert.deepEqual(thread.comments.map((c: any) => [c.author, c.body, Boolean(c.edited)]), [
      ['user', 'Why Friday?', false], ['agent', 'Because the review is on **Thursday**.', true], ['user', 'And Monday?', false], ['agent', 'Monday is sign-off.', false],
    ]);
    assert.equal(thread.answered, false);
    // Its last comment: the person is told again, as of a new answer.
    done(await agent('doc_edit_comment', { id, thread: asked.id, comment_id: a2.id, comment: 'Monday is **sign-off**.' }));
    [thread] = await threads();
    assert.equal(thread.answered, true);
    assert.equal(thread.comments[3].body, 'Monday is **sign-off**.');
    // doc_read says which are edited.
    const again = done(await agent('doc_read', { id })).text;
    assert.ok(again.includes(`, comment ${a1.id}, edited): Because the review is on **Thursday**.`) && again.includes(`, comment ${a2.id}, edited): Monday is **sign-off**.`), again);
    // The same words change nothing.
    done(await agent('doc_edit_comment', { id, thread: asked.id, comment_id: a1.id, comment: 'Because the review is on **Thursday**.' }));
    // The passage and the document stay as they were.
    assert.equal(thread.quote, 'Ship it on Friday.');
    assert.equal((await docs.call('GET', url)).body.revision, 1);

    // A resolved thread is corrected all the same.
    await docs.call('POST', `${url}/threads/${asked.id}/resolve`, {});
    done(await agent('doc_edit_comment', { id, thread: asked.id, comment_id: a1.id, comment: 'Because the review is on Thursday.' }));
    [thread] = await threads();
    assert.deepEqual([thread.status, thread.comments[1].body], ['resolved', 'Because the review is on Thursday.']);
  } finally {
    await docs.close();
  }
});

test('the agent does not change what is not its own, or what is not there, or with no words, and a thread that still asks it is told so', async () => {
  const { docs, id, agent, person, threads, url } = await withDocument('docs-ct-edit-comment-refused-');
  try {
    const asked = await person('Ship it on Friday.', 'Why Friday, @agent?');
    const [ask] = (await threads())[0].comments;
    done(await agent('doc_reply', { id, thread: asked.id, comment: 'Because.' }));
    const a1 = (await threads())[0].comments[1].id;
    // The person's comment is not the agent's to change.
    refused(await agent('doc_edit_comment', { id, thread: asked.id, comment_id: ask.id, comment: 'Changed' }), 'comment_not_yours');
    refused(await agent('doc_edit_comment', { id, thread: asked.id, comment_id: '0123456789abcdef', comment: 'Changed' }), 'comment_not_found');
    refused(await agent('doc_edit_comment', { id, thread: asked.id, comment_id: undefined, comment: 'Changed' }), 'comment_not_found');
    refused(await agent('doc_edit_comment', { id, thread: '0000000000000000', comment_id: a1, comment: 'Changed' }), 'thread_not_found');
    refused(await agent('doc_edit_comment', { id, thread: asked.id, comment_id: a1, comment: '  ' }), 'invalid');
    refused(await agent('doc_edit_comment', { id, thread: asked.id, comment_id: a1, comment: 'x'.repeat(4097) }), 'too_large');
    refused(await agent('doc_edit_comment', { id: '0000000000000000', thread: asked.id, comment_id: a1, comment: 'Changed' }), 'not_found');
    const other = done(await agent('doc_create', { title: 'Other' }));
    refused(await agent('doc_edit_comment', { id: other.details.id, thread: asked.id, comment_id: a1, comment: 'Changed' }), 'thread_not_found');
    assert.deepEqual((await threads())[0].comments.map((c: any) => [c.body, Boolean(c.edited)]), [['Why Friday, @agent?', false], ['Because.', false]]);
    // The agent's answer is gone and the person's question stands: the thread asks it again, and the tool says so. Editing is no answer.
    const gone = done(await agent('doc_delete_comment', { id, thread: asked.id, comment_id: a1 }));
    assert.ok(/still asks you/.test(gone.text), gone.text);
    assert.equal((await threads())[0].toAgent, true);
    await docs.call('PUT', `${url}/threads/${asked.id}/comments/${ask.id}`, { body: 'Why Friday, @agent? Please say.' });
    done(await agent('doc_reply', { id, thread: asked.id, comment: 'Because the review.' }));
    const b1 = (await threads())[0].comments[1].id;
    const kept = done(await agent('doc_edit_comment', { id, thread: asked.id, comment_id: b1, comment: 'Because of the review.' }));
    assert.ok(!/still asks you/.test(kept.text));
    assert.equal((await threads())[0].toAgent, false);
  } finally {
    await docs.close();
  }
});

test('the agent deletes its own comments, never the person\'s: a thread goes with its only comment, and the person\'s words stay when they replied', async () => {
  const { docs, id, agent, person, threads, url } = await withDocument('docs-ct-delete-comment-');
  try {
    const asked = await person('Ship it on Friday.', 'Why Friday?');
    done(await agent('doc_reply', { id, thread: asked.id, comment: 'One.' }));
    await docs.call('POST', `${url}/threads/${asked.id}/comments`, { body: 'Thanks.' });
    done(await agent('doc_reply', { id, thread: asked.id, comment: 'Two.' }));
    let [thread] = await threads();
    const [ask, a1, thanks, a2] = thread.comments;
    // Not the person's, not one that is not there, not in a thread that is not there.
    refused(await agent('doc_delete_comment', { id, thread: asked.id, comment_id: ask.id }), 'comment_not_yours');
    refused(await agent('doc_delete_comment', { id, thread: asked.id, comment_id: thanks.id }), 'comment_not_yours');
    refused(await agent('doc_delete_comment', { id, thread: asked.id, comment_id: '0123456789abcdef' }), 'comment_not_found');
    refused(await agent('doc_delete_comment', { id, thread: '0000000000000000', comment_id: a1.id }), 'thread_not_found');
    assert.equal((await threads())[0].comments.length, 4);
    // From the middle: the rest stays, the person's words too.
    const gone = done(await agent('doc_delete_comment', { id, thread: asked.id, comment_id: a1.id }));
    assert.deepEqual([gone.details.action, gone.details.removed, gone.details.thread, gone.details.comment], ['delete_comment', 'comment', asked.id, a1.id]);
    assert.match(gone.text, /3 comments left/);
    [thread] = await threads();
    assert.deepEqual(thread.comments.map((c: any) => c.body), ['Why Friday?', 'Thanks.', 'Two.']);
    // The last one: the person's comment is the last then, and there is nothing to read as news.
    done(await agent('doc_delete_comment', { id, thread: asked.id, comment_id: a2.id }));
    [thread] = await threads();
    assert.deepEqual([thread.comments.map((c: any) => c.body), thread.answered, thread.status], [['Why Friday?', 'Thanks.'], false, 'open']);

    // A thread of the agent's own goes with its only comment; the person's passage is not touched.
    const own = done(await agent('doc_comment', { id, quote: 'The build is green, and the build is green again.', comment: 'Check this.' }));
    assert.equal((await threads()).length, 2);
    const removed = done(await agent('doc_delete_comment', { id, thread: own.details.thread, comment_id: (await threads())[1].comments[0].id }));
    assert.equal(removed.details.removed, 'thread');
    assert.match(removed.text, /thread went with it/);
    assert.deepEqual((await threads()).map((t: any) => t.id), [asked.id]);
    refused(await agent('doc_delete_comment', { id, thread: own.details.thread, comment_id: a1.id }), 'thread_not_found');

    // The agent's thread that the person answered: its comment goes, the person's stays.
    const mixed = done(await agent('doc_comment', { id, quote: 'Sign-off is on Monday.', comment: 'Is Monday right?' }));
    await docs.call('POST', `${url}/threads/${mixed.details.thread}/comments`, { body: 'Yes.' });
    const m = (await threads())[1];
    assert.equal(done(await agent('doc_delete_comment', { id, thread: mixed.details.thread, comment_id: m.comments[0].id })).details.removed, 'comment');
    assert.deepEqual((await threads())[1].comments.map((c: any) => [c.author, c.body]), [['user', 'Yes.']]);
  } finally {
    await docs.close();
  }
});

test('a thread is taken away by the person only while it is theirs and the agent has not commented in it', async () => {
  const { docs, id, agent, person, threads, url } = await withDocument('docs-ct-delete-thread-');
  try {
    // The agent answered: the person cannot delete the thread, and nothing is lost.
    const asked = await person('Ship it on Friday.', 'Why Friday?');
    done(await agent('doc_reply', { id, thread: asked.id, comment: 'Because.' }));
    const refusedAnswered = await docs.call('DELETE', `${url}/threads/${asked.id}`);
    assert.deepEqual([refusedAnswered.status, refusedAnswered.body.code], [409, 'thread_answered']);
    // The agent's own thread is the agent's.
    const own = done(await agent('doc_comment', { id, quote: 'Sign-off is on Monday.', comment: 'Is Monday right?' }));
    const refusedOwn = await docs.call('DELETE', `${url}/threads/${own.details.thread}`);
    assert.deepEqual([refusedOwn.status, refusedOwn.body.code], [409, 'thread_not_yours']);
    assert.equal((await threads()).length, 2);
    // A person's reply in the agent's thread does not make it theirs.
    await docs.call('POST', `${url}/threads/${own.details.thread}/comments`, { body: 'Yes.' });
    assert.equal((await docs.call('DELETE', `${url}/threads/${own.details.thread}`)).body.code, 'thread_not_yours');
    // Once the agent has taken its comment away there is nothing of it in the thread, and it is the person's.
    const a1 = (await threads())[0].comments[1].id;
    done(await agent('doc_delete_comment', { id, thread: asked.id, comment_id: a1 }));
    assert.deepEqual((await docs.call('DELETE', `${url}/threads/${asked.id}`)).body, { removed: 'thread' });
    assert.deepEqual((await threads()).map((t: any) => t.id), [own.details.thread]);
    // The agent resolving a thread without a word is no comment of its own: the person's thread can still go.
    const quiet = await person('The build is green, and the build is green again.', 'Is it?');
    done(await agent('doc_resolve', { id, thread: quiet.id }));
    assert.equal((await docs.call('DELETE', `${url}/threads/${quiet.id}`)).status, 200);
  } finally {
    await docs.close();
  }
});
