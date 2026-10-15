import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express from 'express';
import docsServer from '../server.js';
import { resolveInside } from '../../../core/server/src/workspace-files.ts';
import { scratch } from '../../../tests/helpers.mts';

/**
 * A document that is changed while a page has it open (extensions/docs/server.js, store.js): the stream a page
 * listens to, which tells it each revision as it is made, and the save of a page that started from an earlier
 * revision, which is put together with what was saved since. Against a real store on disk, with git, and a real
 * router in a real server; the agent works through its tools, the page through the routes.
 */

const DATA = scratch('docs-stream-data-');

/** One message of a stream: a frame up to the blank line, in its parts. */
interface Frame { id?: string; event?: string; data?: any; comment?: string; retry?: string }

/** The server half for a chat in `folder`. `pingMs` and `pollMs`: how often the stream is pinged and the folder looked at. */
async function portal(folder: string, { pingMs, pollMs = 40 }: { pingMs?: number; pollMs?: number } = {}) {
  const router = express.Router();
  const factories: ((pi: unknown, chat: unknown) => void)[] = [];
  const logged: string[] = [];
  const stop = docsServer({
    extension: 'pithagoras-docs',
    executor: 'host',
    log: (line: string) => logged.push(line),
    router,
    http: { json: express.json },
    files: { inside: resolveInside },
    sandbox: { on: () => false },
    dataDir: () => DATA,
    chats: {
      list: () => [{ id: 'a', title: 'Chat a' }],
      folder: () => folder,
      extend: (factory: (pi: unknown, chat: unknown) => void) => void factories.push(factory),
    },
  }, { dependencies: async () => true, pingMs, pollMs }) as () => Promise<void>;
  const app = express();
  app.use('/x', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
  const aborts: AbortController[] = [];
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  /** A page's stream: the frames as they come, one at a time. */
  async function listen(url: string, headers: Record<string, string> = {}) {
    const abort = new AbortController();
    aborts.push(abort);
    const res = await fetch(base + url, { headers: { accept: 'text/event-stream', ...headers }, signal: abort.signal });
    if (!res.ok || !res.headers.get('content-type')?.startsWith('text/event-stream')) return { res, status: res.status, body: await res.json().catch(() => null) as any };
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    /** The next frame, or null where the stream has ended. */
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
            else if (line.startsWith('retry: ')) out.retry = line.slice(7);
          }
          return out;
        }
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
    };
    /** The next revision the stream tells of. */
    const revision = async () => {
      for (;;) {
        const next = await frame();
        if (!next || next.event === 'revision') return next?.data ?? null;
      }
    };
    return { res, status: res.status, body: null as any, frame, revision, close: () => abort.abort() };
  }
  const agent = () => {
    const tools = new Map<string, any>();
    for (const factory of factories) factory({ registerTool: (tool: any) => tools.set(tool.name, tool), events: { on: () => () => {} }, on: () => {} }, { id: 'a', title: 'Chat a', workspace: folder, status: 'idle' });
    return async (name: string, params: unknown) => {
      try {
        const result = await tools.get(name).execute('call-1', params, undefined, undefined, {});
        return { ok: true as const, text: result.content[0].text as string };
      } catch (e: any) {
        return { ok: false as const, error: e.message as string };
      }
    };
  };
  return {
    call,
    listen,
    agent: agent(),
    logged,
    close: async () => {
      for (const abort of aborts) abort.abort();
      await stop();
      server.close();
    },
    /** The stop alone, for a test of what it does to a stream. */
    stop,
    closeServer: () => server.close(),
  };
}

const folderIdOf = (folder: string) => createHash('sha256').update(folder).digest('hex').slice(0, 16);
const git = (folder: string, ...args: string[]) =>
  execFileSync('git', [`--git-dir=${path.join(DATA, folderIdOf(folder), 'git')}`, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
const fileOf = (folder: string, name = 'plan.md') => readFileSync(path.join(folder, 'documents', name), 'utf8');

const PLAN = '# Plan\n\nShip it on Friday.\n\nThe build is green.\n\nSign-off is on Monday.\n';

/** A folder with one document, made through the page, and the portal for it. */
async function withDocument(prefix: string, options: { pingMs?: number; pollMs?: number } = {}, markdown = PLAN) {
  const folder = realpathSync(scratch(prefix));
  const docs = await portal(folder, options);
  const f = folderIdOf(folder);
  const made = await docs.call('POST', `/folders/${f}/documents`, { title: 'Plan', markdown });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.id as string;
  return { folder, docs, f, id, url: `/folders/${f}/documents/${id}`, events: `/folders/${f}/documents/${id}/events` };
}

const edit = (docs: Awaited<ReturnType<typeof portal>>, id: string, expected: number, quote: string, replacement: string) =>
  docs.agent('doc_edit', { id, expected_revision: expected, edits: [{ quote, replacement }] });

test('a page that listens is told where the document stands, and then each revision as it is made, whoever made it', async () => {
  const { docs, id, url, events } = await withDocument('docs-stream-basic-');
  try {
    const stream = await docs.listen(events);
    assert.equal(stream.status, 200);
    assert.equal(stream.res.headers.get('cache-control'), 'no-cache, no-transform');
    assert.equal(stream.res.headers.get('x-accel-buffering'), 'no', 'a proxy is not to hold it');
    // The first message is a retry, then where the document is: revision 1, by the page that made it.
    assert.deepEqual(await stream.frame!(), { retry: '2000' });
    const first = await stream.frame!();
    assert.equal(first?.event, 'revision');
    assert.equal(first?.id, '1');
    assert.deepEqual({ ...first?.data, at: typeof first?.data.at }, { revision: 1, author: 'user', at: 'string' });
    assert.ok(!Number.isNaN(Date.parse(first?.data.at)));

    assert.equal((await edit(docs, id, 1, 'on Friday', 'on Thursday')).ok, true);
    assert.deepEqual(await stream.revision!(), { revision: 2, author: 'agent', at: (await docs.call('GET', `${url}/history`)).body.revisions[0].at });
    const saved = await docs.call('PUT', url, { markdown: `${PLAN}Another line.\n`, base: 2 });
    assert.equal(saved.status, 200);
    const third = await stream.revision!();
    assert.deepEqual([third.revision, third.author], [3, 'user']);
    // Restoring is a revision like the others.
    assert.equal((await docs.call('POST', `${url}/restore`, { revision: 1 })).status, 200);
    assert.deepEqual((await stream.revision!()).revision, 4);
  } finally {
    await docs.close();
  }
});

test('two pages listening to one document hear its revisions in the same order, and a page hears nothing of another document', async () => {
  const { folder, docs, f, id, events } = await withDocument('docs-stream-two-');
  try {
    const other = await docs.call('POST', `/folders/${f}/documents`, { title: 'Notes', markdown: '# Notes\n\nOne.\n' });
    const otherId = other.body.id as string;
    const one = await docs.listen(events);
    const two = await docs.listen(events);
    const notes = await docs.listen(`/folders/${f}/documents/${otherId}/events`);
    assert.deepEqual([(await one.revision!()).revision, (await two.revision!()).revision, (await notes.revision!()).revision], [1, 1, 1]);
    for (let n = 1; n <= 4; n++) assert.equal((await edit(docs, id, n, n === 1 ? 'on Friday' : `Friday ${n - 1}`, `Friday ${n}`)).ok, true);
    const heard = async (stream: typeof one) => [(await stream.revision!()).revision, (await stream.revision!()).revision, (await stream.revision!()).revision, (await stream.revision!()).revision];
    assert.deepEqual(await heard(one), [2, 3, 4, 5]);
    assert.deepEqual(await heard(two), [2, 3, 4, 5]);
    // The other document's own revision is the next thing its page hears.
    assert.equal((await docs.call('PUT', `/folders/${f}/documents/${otherId}`, { markdown: '# Notes\n\nTwo.\n', base: 1 })).status, 200);
    const notesAt = (await docs.call('GET', `/folders/${f}/documents/${otherId}/history`)).body.revisions[0].at;
    assert.deepEqual(await notes.revision!(), { revision: 2, author: 'user', at: notesAt });
    assert.ok(fileOf(folder).includes('Friday 4'));
  } finally {
    await docs.close();
  }
});

test('a page that comes back, with the id it last heard, is told where the document stands now, whatever it missed', async () => {
  const { docs, id, events } = await withDocument('docs-stream-again-');
  try {
    const first = await docs.listen(events);
    await first.revision!();
    first.close!();
    for (let n = 1; n <= 3; n++) assert.equal((await edit(docs, id, n, n === 1 ? 'on Friday' : `Friday ${n - 1}`, `Friday ${n}`)).ok, true);
    // As the browser's EventSource asks again: with the id of the last message, which the first message here makes no use of.
    const again = await docs.listen(events, { 'last-event-id': '1' });
    const told = await again.revision!();
    assert.deepEqual([told.revision, told.author], [4, 'agent']);
  } finally {
    await docs.close();
  }
});

test('revisions made while a stream is being opened are heard, in order, and the last one is where it ends', async () => {
  for (let round = 0; round < 4; round++) {
    const { docs, id, events } = await withDocument(`docs-stream-race-${round}-`);
    try {
      let [listening] = await Promise.all([
        docs.listen(events),
        (async () => {
          for (let n = 1; n <= 4; n++) assert.equal((await edit(docs, id, n, n === 1 ? 'on Friday' : `Friday ${n - 1}`, `Friday ${n}`)).ok, true);
        })(),
      ]);
      const heard: number[] = [];
      for (let last = 0; last < 5; ) {
        const next = (await listening.revision!()).revision as number;
        heard.push(next);
        last = next;
      }
      assert.deepEqual([...heard].sort((a, b) => a - b), heard, `round ${round}: in order`);
      assert.equal(new Set(heard).size, heard.length, `round ${round}: none twice`);
      assert.equal(heard.at(-1), 5);
    } finally {
      await docs.close();
    }
  }
});

test('a stream for what is not there is refused as any request is, and none is opened', async () => {
  const { docs, f, id, events } = await withDocument('docs-stream-refused-');
  try {
    for (const url of [`/folders/${f}/documents/0123456789abcdef/events`, `/folders/${f}/documents/..%2Fplan.md/events`, `/folders/0123456789abcdef/documents/${id}/events`, `/folders/${f}/documents/plan.md/events`]) {
      const refused = await docs.listen(url);
      assert.equal(refused.status, 404, url);
      assert.match(refused.body.error, /There is no such/);
    }
    // And a folder with no store at all: nothing is made for it.
    const none = await docs.listen('/folders/0123456789abcdef/documents/0123456789abcdef/events');
    assert.equal(none.status, 404);
    assert.equal((await docs.listen(events)).status, 200);
  } finally {
    await docs.close();
  }
});

test('a change made outside the page and the agent (Files, an editor) is told as an outside revision once the folder is looked at', async () => {
  const { folder, docs, events } = await withDocument('docs-stream-outside-');
  try {
    const stream = await docs.listen(events);
    assert.equal((await stream.revision!()).revision, 1);
    writeFileSync(path.join(folder, 'documents', 'plan.md'), PLAN.replace('on Friday', 'on Wednesday'));
    const told = await stream.revision!();
    assert.deepEqual([told.revision, told.author], [2, 'external']);
    // It is a revision of the history, and the text is the file's.
    assert.match(git(folder, 'show', '-s', '--format=%B', 'HEAD'), /Author: external/);
    // Not looked at again for what is already taken in.
    writeFileSync(path.join(folder, 'documents', 'plan.md'), PLAN.replace('on Friday', 'on Tuesday'));
    assert.equal((await stream.revision!()).revision, 3);
  } finally {
    await docs.close();
  }
});

test('the folder is looked at only while a page listens to it', async () => {
  const { folder, docs, f, id, events } = await withDocument('docs-stream-idle-');
  try {
    writeFileSync(path.join(folder, 'documents', 'plan.md'), PLAN.replace('on Friday', 'on Wednesday'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Nobody listened: the change is not taken in until something asks, as before.
    assert.equal(git(folder, 'rev-list', '--count', 'HEAD'), '1');
    const stream = await docs.listen(events);
    assert.equal((await stream.revision!()).revision, 2, 'taken in when the page listens');
    stream.close!();
    // Closed, and not looked at again.
    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(path.join(folder, 'documents', 'plan.md'), PLAN.replace('on Friday', 'on Tuesday'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(git(folder, 'rev-list', '--count', 'HEAD'), '2');
    assert.equal((await docs.call('GET', `/folders/${f}/documents/${id}`)).body.revision, 3, 'and then by what asks');
  } finally {
    await docs.close();
  }
});

test('a stream that is open gets a comment line every so often, and is ended when the extension is stopped', async () => {
  const { docs, events } = await withDocument('docs-stream-ping-', { pingMs: 30, pollMs: 0 });
  try {
    const stream = await docs.listen(events);
    await stream.revision!();
    const comments: (string | undefined)[] = [];
    for (let n = 0; n < 3; n++) comments.push((await stream.frame!())?.comment);
    assert.deepEqual(comments, ['ping', 'ping', 'ping']);
    await docs.stop();
    // Everything it had open is ended: a page's reconnect is the next thing it does.
    let ended = false;
    for (let n = 0; n < 20 && !ended; n++) ended = (await stream.frame!()) === null;
    assert.equal(ended, true);
    docs.closeServer();
  } finally {
    await docs.close().catch(() => {});
  }
});

test('a save that started from an earlier revision is put together with the agent\'s change when they meet nowhere: the agent\'s change is not lost', async () => {
  const { folder, docs, id, url, events } = await withDocument('docs-stream-merge-');
  try {
    const stream = await docs.listen(events);
    await stream.revision!();
    // The agent changes one paragraph; the page, still on revision 1, changed another.
    assert.equal((await edit(docs, id, 1, 'on Friday', 'on Thursday')).ok, true);
    assert.equal((await stream.revision!()).revision, 2);
    const mine = PLAN.replace('is green', 'is red');
    const saved = await docs.call('PUT', url, { markdown: mine, base: 1 });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.revision, 3);
    assert.equal(saved.body.merged, true);
    assert.equal(saved.body.changed, true);
    const both = PLAN.replace('on Friday', 'on Thursday').replace('is green', 'is red');
    assert.equal(saved.body.markdown, both, 'the text that was saved comes back: the page takes it up');
    assert.equal(fileOf(folder), both, 'the agent\'s change is in the file');
    // One more revision, by the page, in the history, told like any other.
    const history = (await docs.call('GET', `${url}/history`)).body.revisions;
    assert.deepEqual(history.map((r: any) => [r.revision, r.author]), [[3, 'user'], [2, 'agent'], [1, 'user']]);
    assert.deepEqual((await stream.revision!()).revision, 3);
    assert.match(git(folder, 'show', '-s', '--format=%B', 'HEAD'), /merged with revision 2[\s\S]*Revision: 3\nAuthor: user/);
    // The next save is on the revision it came back with.
    assert.equal((await docs.call('PUT', url, { markdown: `${both}More.\n`, base: 3 })).status, 200);
  } finally {
    await docs.close();
  }
});

test('a save whose changes meet the agent\'s is refused with their text, and nothing is written or told', async () => {
  const { folder, docs, id, url, events } = await withDocument('docs-stream-meet-');
  try {
    assert.equal((await edit(docs, id, 1, 'on Friday', 'on Thursday')).ok, true);
    const was = git(folder, 'rev-parse', 'HEAD');
    const agents = fileOf(folder);
    // The page changed the same paragraph, and another one that would have merged.
    const refused = await docs.call('PUT', url, { markdown: PLAN.replace('on Friday', 'on Saturday').replace('is green', 'is red'), base: 1 });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.revision, 2);
    assert.equal(refused.body.markdown, agents);
    assert.equal(refused.body.merged, undefined);
    assert.equal(fileOf(folder), agents);
    assert.equal(git(folder, 'rev-parse', 'HEAD'), was);
    // Lines that follow each other count as one place.
    const list = await docs.call('POST', `/folders/${folderIdOf(folder)}/documents`, { title: 'List', markdown: '- a\n- b\n- c\n' });
    const listUrl = `/folders/${folderIdOf(folder)}/documents/${list.body.id}`;
    assert.equal((await edit(docs, list.body.id, 1, '- b', '- B')).ok, true);
    assert.equal((await docs.call('PUT', listUrl, { markdown: '- a\n- b2\n- c\n', base: 1 })).status, 409);
    assert.equal((await docs.call('PUT', listUrl, { markdown: '- a\n- b\n- c\n- d\n', base: 1 })).status, 200);
  } finally {
    await docs.close();
  }
});

test('a save whose changes are in the document already makes no revision, and says so', async () => {
  const { folder, docs, id, url } = await withDocument('docs-stream-same-');
  try {
    assert.equal((await edit(docs, id, 1, 'on Friday', 'on Thursday')).ok, true);
    const was = git(folder, 'rev-parse', 'HEAD');
    // The page made the same change the agent did, and nothing else.
    const saved = await docs.call('PUT', url, { markdown: PLAN.replace('on Friday', 'on Thursday'), base: 1 });
    assert.equal(saved.status, 200);
    assert.deepEqual([saved.body.revision, saved.body.changed, saved.body.merged], [2, false, true]);
    assert.equal(saved.body.markdown, PLAN.replace('on Friday', 'on Thursday'));
    assert.equal(git(folder, 'rev-parse', 'HEAD'), was);
    // A page that changed nothing at all, on an old revision, is told what the document is now.
    const same = await docs.call('PUT', url, { markdown: PLAN, base: 1 });
    assert.deepEqual([same.status, same.body.revision, same.body.changed, same.body.merged], [200, 2, false, true]);
    assert.equal(same.body.markdown, PLAN.replace('on Friday', 'on Thursday'));
  } finally {
    await docs.close();
  }
});

test('only a save of the page is put together: a base that is not an earlier revision, a restore and a file that is not text are refused as before', async () => {
  const { folder, docs, id, url } = await withDocument('docs-stream-only-');
  try {
    assert.equal((await edit(docs, id, 1, 'on Friday', 'on Thursday')).ok, true);
    // From the future: refused. From no revision at all, which is no base.
    assert.equal((await docs.call('PUT', url, { markdown: PLAN, base: 9 })).status, 409);
    assert.equal((await docs.call('PUT', url, { markdown: PLAN, base: 0 })).status, 400);
    // A restore says which revision the document is to be at, and is refused on any other.
    const restore = await docs.call('POST', `${url}/restore`, { revision: 1, base: 1 });
    assert.equal(restore.status, 409);
    assert.equal(restore.body.revision, 2);
    // Bytes that are not text are not put together, though the two changes meet nowhere: written back, they would be other bytes.
    const bytes = Buffer.concat([Buffer.from(PLAN.slice(0, PLAN.indexOf('Sign-off'))), Buffer.from([0xff, 0xfe, 0x0a])]);
    writeFileSync(path.join(folder, 'documents', 'plan.md'), bytes);
    const stale = await docs.call('PUT', url, { markdown: PLAN.replace('is green', 'is red'), base: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.revision, 3, 'the file was taken in as a revision of its own');
    assert.deepEqual(readFileSync(path.join(folder, 'documents', 'plan.md')), bytes);
  } finally {
    await docs.close();
  }
});

test('what a merge writes keeps the file\'s mode, like any save', async () => {
  const { folder, docs, id, url } = await withDocument('docs-stream-mode-');
  try {
    chmodSync(path.join(folder, 'documents', 'plan.md'), 0o640);
    assert.equal((await edit(docs, id, 1, 'on Friday', 'on Thursday')).ok, true);
    const saved = await docs.call('PUT', url, { markdown: PLAN.replace('is green', 'is red'), base: 1 });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.merged, true);
    assert.equal(statSync(path.join(folder, 'documents', 'plan.md')).mode & 0o777, 0o640);
  } finally {
    await docs.close();
  }
});

test('two changes that fit in a megabyte each but not together are refused, and nothing is written', async () => {
  const { folder, docs, id, url } = await withDocument('docs-stream-size-', {}, 'a\n\nb\n\nc\n');
  try {
    const part = (tag: string) => `${tag}${'x'.repeat(600 * 1024)}`;
    assert.equal((await edit(docs, id, 1, 'a', part('A'))).ok, true);
    const was = git(folder, 'rev-parse', 'HEAD');
    const stale = await docs.call('PUT', url, { markdown: `a\n\nb\n\n${part('C')}\n`, base: 1 });
    assert.equal(stale.status, 413);
    assert.equal(git(folder, 'rev-parse', 'HEAD'), was);
    assert.ok(fileOf(folder).startsWith('A'));
  } finally {
    await docs.close();
  }
});
