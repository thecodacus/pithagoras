import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express from 'express';
import docsServer from '../server.js';
import { folderFiles } from '../../../core/server/src/folder-files.ts';
import { scratch } from '../../../tests/helpers.mts';

/**
 * The Documents extension's tools for the agent (extensions/docs/tools.js), through its server half: the tools are
 * registered in a chat's pi as the portal does it (`chats.extend`), and run against a real store on disk, with git.
 * What the person does meanwhile goes through the server half's routes, as the page does it.
 */

const DATA = scratch('docs-tools-data-');

type Result = { ok: true; text: string; details: any } | { ok: false; error: string };

/** The server half for chats that work in these folders (`chats`: the folder of each, by id), with pi run as `executor`. */
async function portal(chats: Record<string, string>, executor = 'host') {
  const router = express.Router();
  const factories: ((pi: unknown, chat: unknown) => void)[] = [];
  const logged: string[] = [];
  const stop = docsServer({
    extension: 'pithagoras-docs',
    executor,
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
  }, { dependencies: async () => true }) as () => Promise<void>;
  const app = express();
  app.use('/x', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
  /** The person, through the routes. */
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  /** A chat's pi as the portal starts it: the tools the server half put into it, by name. */
  const pi = (chat: string) => {
    const tools = new Map<string, any>();
    for (const factory of factories) factory({ registerTool: (tool: any) => tools.set(tool.name, tool), events: { on: () => () => {} }, on: () => {} }, { id: chat, title: `Chat ${chat}`, workspace: chats[chat], status: 'idle' });
    return tools;
  };
  /** What the agent of a chat gets when it calls a tool: its text and details, or the refusal it reads. */
  const agent = (chat: string) => {
    const tools = pi(chat);
    return async (name: string, params: unknown): Promise<Result> => {
      try {
        const result = await tools.get(name).execute('call-1', params, undefined, undefined, {});
        return { ok: true, text: result.content[0].text, details: result.details };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    };
  };
  return { call, pi, agent, factories, logged, close: async () => { await stop(); server.close(); } };
}

function folderWith(prefix: string, files: Record<string, string> = {}) {
  const folder = realpathSync(scratch(prefix));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    writeFileSync(path.join(folder, name), text);
  }
  return folder;
}

const folderIdOf = (folder: string) => createHash('sha256').update(folder).digest('hex').slice(0, 16);
const git = (folder: string, ...args: string[]) =>
  execFileSync('git', [`--git-dir=${path.join(DATA, folderIdOf(folder), 'git')}`, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
const head = (folder: string) => git(folder, 'rev-parse', 'HEAD');
const fileOf = (folder: string, name: string) => readFileSync(path.join(folder, 'documents', name), 'utf8');

/** A refusal's text: it starts with its code. */
function refused(result: Result, code: string) {
  assert.equal(result.ok, false, `refused with ${code}`);
  assert.match((result as any).error, new RegExp(`^${code}: `));
  return (result as any).error as string;
}
function done(result: Result) {
  assert.equal(result.ok, true, (result as any).error);
  return result as Extract<Result, { ok: true }>;
}

/** One chat in a folder that has a document made through the page. */
async function withDocument(prefix: string, markdown = '# Plan\n\nShip it on Friday.\n\nThe build is green.\n') {
  const folder = folderWith(prefix);
  const docs = await portal({ a: folder });
  const f = folderIdOf(folder);
  const made = await docs.call('POST', `/folders/${f}/documents`, { title: 'Plan', markdown });
  assert.equal(made.status, 201);
  const id = made.body.id as string;
  return { folder, docs, f, id, url: `/folders/${f}/documents/${id}`, agent: docs.agent('a') };
}

test('the seven tools are put into each chat\'s pi where pi runs in the portal, and none where it does not', async () => {
  const folder = folderWith('docs-tools-reg-');
  const host = await portal({ a: folder }, 'host');
  const container = await portal({ a: folder }, 'container');
  try {
    assert.equal(host.factories.length, 1, 'one pi extension for every chat');
    assert.deepEqual([...host.pi('a').keys()].sort(), ['doc_comment', 'doc_create', 'doc_delete_comment', 'doc_edit', 'doc_edit_comment', 'doc_list', 'doc_read', 'doc_reply', 'doc_resolve']);
    for (const tool of host.pi('a').values()) {
      assert.ok(tool.description.length > 40 && tool.label && tool.promptSnippet, `${tool.name} says what it is for`);
      // A part is counted in characters, and so is said to be.
      assert.ok(!/\bKB\b/.test(tool.description), `${tool.name} does not count in bytes`);
      assert.equal(tool.parameters.type, 'object');
    }
    assert.match(host.pi('a').get('doc_read').description, /parts of about 60,000 characters/);
    assert.deepEqual(container.factories, [], 'with pi in a container there is no pi extension of the portal\'s to add to');
  } finally {
    await host.close();
    await container.close();
  }
});

test('a document the agent makes is a revision 1 file in the documents folder, by the agent, and the page lists it', async () => {
  const folder = folderWith('docs-tools-create-');
  const docs = await portal({ a: folder });
  try {
    const agent = docs.agent('a');
    const made = done(await agent('doc_create', { title: 'Release notes', markdown: '# Release notes\n\nNothing yet.\n' }));
    assert.equal(made.details.path, 'documents/release-notes.md');
    assert.equal(made.details.revision, 1);
    assert.equal(made.details.title, 'Release notes');
    assert.equal(made.details.scope, 'project');
    assert.equal(made.details.folder, folderIdOf(folder));
    assert.match(made.details.id, /^[0-9a-f]{16}$/);
    assert.ok(made.text.includes(made.details.id) && made.text.includes('documents/release-notes.md'), 'the agent is told where it is, and its id');
    assert.equal(fileOf(folder, 'release-notes.md'), '# Release notes\n\nNothing yet.\n');
    assert.equal(git(folder, 'show', '-s', '--format=%(trailers:only,unfold)', 'HEAD'), `Doc-Id: ${made.details.id}\nDoc-Name: release-notes.md\nRevision: 1\nAuthor: agent`);
    const history = await docs.call('GET', `/folders/${folderIdOf(folder)}/documents/${made.details.id}/history`);
    assert.deepEqual(history.body.revisions.map((r: any) => [r.revision, r.author, r.kind]), [[1, 'agent', 'create']]);
    const listed = await docs.call('GET', '/folders');
    assert.deepEqual(listed.body.folders[0].documents.map((d: any) => [d.name, d.title, d.revision, d.scope]), [['release-notes.md', 'Release notes', 1, 'project']]);

    // Left out, the text is the title as a heading.
    const bare = done(await agent('doc_create', { title: '  Ideas  ' }));
    assert.equal(fileOf(folder, 'ideas.md'), '# Ideas\n');
    assert.equal(bare.details.title, 'Ideas');
  } finally {
    await docs.close();
  }
});

test('a new document is called by its first heading: the title is that heading only where the Markdown has none of its own', async () => {
  const folder = folderWith('docs-tools-title-');
  const docs = await portal({ a: folder });
  try {
    const agent = docs.agent('a');
    // No heading: the title is put at the top, as it was given, capitals and all.
    const plain = done(await agent('doc_create', { title: 'Scope check', markdown: 'What is in, what is out.\n' }));
    assert.equal(fileOf(folder, 'scope-check.md'), '# Scope check\n\nWhat is in, what is out.\n');
    assert.equal(plain.details.title, 'Scope check');
    // A heading of its own: kept as it is, and the document is called by it; the file is named from the title.
    const own = done(await agent('doc_create', { title: 'Alpha Beta', markdown: '# Gamma Delta\n\nBody.\n' }));
    assert.equal(fileOf(folder, 'alpha-beta.md'), '# Gamma Delta\n\nBody.\n');
    assert.equal(own.details.title, 'Gamma Delta');
    assert.equal(own.details.path, 'documents/alpha-beta.md');
    // A front matter block stays first, and is not taken for a heading (its closing marks would underline its keys).
    const tagged = done(await agent('doc_create', { title: 'Tagged', markdown: '---\ntitle: Elsewhere\ntags: [a]\n---\n\nBody.\n' }));
    assert.equal(fileOf(folder, 'tagged.md'), '---\ntitle: Elsewhere\ntags: [a]\n---\n\n# Tagged\n\nBody.\n');
    assert.equal(tagged.details.title, 'Tagged');
    // One that ends the Markdown, with no line break after its closing marks, still closes, before the heading.
    done(await agent('doc_create', { title: 'Only tags', markdown: '---\ntags: [a]\n---' }));
    assert.equal(fileOf(folder, 'only-tags.md'), '---\ntags: [a]\n---\n\n# Only tags\n');
    // Blank lines before the text, and a title over more than one line, make one heading and one blank line.
    done(await agent('doc_create', { title: 'Two\nLines', markdown: '\n\n\nText.\n' }));
    assert.equal(fileOf(folder, 'two-lines.md'), '# Two Lines\n\nText.\n');
    // The page makes them the same way.
    const page = await docs.call('POST', `/folders/${folderIdOf(folder)}/documents`, { title: 'From the page', markdown: 'Some text.\n' });
    assert.equal(page.body.title, 'From the page');
    assert.equal(fileOf(folder, 'from-the-page.md'), '# From the page\n\nSome text.\n');
    const listed = (await docs.call('GET', '/folders')).body.folders[0].documents;
    assert.deepEqual(Object.fromEntries(listed.map((d: any) => [d.name, d.title])), {
      'alpha-beta.md': 'Gamma Delta', 'from-the-page.md': 'From the page', 'only-tags.md': 'Only tags', 'scope-check.md': 'Scope check', 'tagged.md': 'Tagged', 'two-lines.md': 'Two Lines',
    });
  } finally {
    await docs.close();
  }
});

test('a document is never made in place of another: a title whose name is taken is refused, and the other is as it was', async () => {
  const folder = folderWith('docs-tools-exists-', { 'documents/guide.md': '# The user\'s guide\n' });
  const docs = await portal({ a: folder });
  try {
    const agent = docs.agent('a');
    // A file that is in the folder already, though no document yet (and one made by the page, and one made earlier by the agent).
    refused(await agent('doc_create', { title: 'Guide', markdown: '# Guide by the agent\n' }), 'exists');
    assert.equal(fileOf(folder, 'guide.md'), '# The user\'s guide\n');
    const page = await docs.call('POST', `/folders/${folderIdOf(folder)}/documents`, { title: 'Plan', markdown: '# The user\'s plan\n' });
    refused(await agent('doc_create', { title: 'Plan' }), 'exists');
    done(await agent('doc_create', { title: 'Notes' }));
    const again = refused(await agent('doc_create', { title: 'notes', markdown: 'Second' }), 'exists');
    assert.match(again, /notes\.md/);
    assert.equal(fileOf(folder, 'plan.md'), '# The user\'s plan\n');
    assert.equal(fileOf(folder, 'notes.md'), '# Notes\n');
    assert.deepEqual(readdirSync(path.join(folder, 'documents')).sort(), ['guide.md', 'notes.md', 'plan.md']);
    assert.equal((await docs.call('GET', `/folders/${folderIdOf(folder)}/documents/${page.body.id}/history`)).body.revisions.length, 1);
    // Two at once for one title: one is made, the other is refused.
    const results = await Promise.all([agent('doc_create', { title: 'Race' }), agent('doc_create', { title: 'Race' })]);
    assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
    assert.equal(readdirSync(path.join(folder, 'documents')).filter((n) => n.startsWith('race')).length, 1);
  } finally {
    await docs.close();
  }
});

test('a document is not made past what a document may be, with a secret in it, or from arguments that make no sense', async () => {
  const folder = folderWith('docs-tools-create-refused-');
  const docs = await portal({ a: folder });
  try {
    const agent = docs.agent('a');
    refused(await agent('doc_create', { title: 'Huge', markdown: 'x'.repeat(1024 * 1024 + 1) }), 'too_large');
    refused(await agent('doc_create', { title: 'Keys', markdown: '# Keys\n\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n' }), 'secret');
    refused(await agent('doc_create', { title: 'Token', markdown: 'token: ghp_' + 'a'.repeat(36) }), 'secret');
    refused(await agent('doc_create', { title: '   ' }), 'invalid');
    refused(await agent('doc_create', { title: 'x'.repeat(201) }), 'invalid');
    refused(await agent('doc_create', { title: 'Odd', scope: 'everyone' }), 'invalid');
    refused(await agent('doc_create', { title: 'Odd', markdown: 42 }), 'invalid');
    refused(await agent('doc_create', {}), 'invalid');
    // None of it reached the disk or the history.
    assert.deepEqual(readdirSync(folder), []);
    assert.equal((await docs.call('GET', '/folders')).body.folders.length, 0);
    // The title is a title, not a path.
    const sneaky = done(await agent('doc_create', { title: '../../.ssh/Authorized Keys' }));
    assert.equal(sneaky.details.path, 'documents/ssh-authorized-keys.md');
    assert.deepEqual(readdirSync(folder), ['documents']);
  } finally {
    await docs.close();
  }
});

test('the agent lists the project\'s documents and its own chat\'s, by scope, and no other chat\'s', async () => {
  const folder = folderWith('docs-tools-list-', { 'documents/by-hand.md': 'No heading here.\n' });
  const empty = folderWith('docs-tools-list-empty-');
  const docs = await portal({ a: folder, b: folder, c: empty });
  try {
    const a = docs.agent('a');
    const b = docs.agent('b');
    assert.equal(done(await docs.agent('c')('doc_list', {})).text, 'No documents yet. Make one with doc_create.');
    assert.deepEqual(readdirSync(empty), [], 'listing makes nothing in a folder with no documents');
    done(await a('doc_create', { title: 'Plan', scope: 'project' }));
    const mine = done(await a('doc_create', { title: 'Scratch pad', scope: 'chat' }));
    const theirs = done(await b('doc_create', { title: 'Second chat only', scope: 'chat' }));
    assert.equal(mine.details.scope, 'chat');

    const all = done(await a('doc_list', {}));
    assert.deepEqual(all.details.documents.map((d: any) => [d.title, d.path, d.scope]), [
      ['by-hand', 'documents/by-hand.md', 'project'],
      ['Plan', 'documents/plan.md', 'project'],
      ['Scratch pad', 'documents/scratch-pad.md', 'chat'],
    ]);
    assert.match(all.text, /^3 documents:\n- [0-9a-f]{16}  "by-hand"  documents\/by-hand\.md  revision 1  project  changed /);
    assert.match(all.text, /"Scratch pad"  documents\/scratch-pad\.md  revision 1  this chat's  changed /);
    assert.ok(!all.text.includes('Second chat only'), 'another chat\'s own document is not listed');
    assert.deepEqual(done(await a('doc_list', { scope: 'chat' })).details.documents.map((d: any) => d.title), ['Scratch pad']);
    assert.deepEqual(done(await a('doc_list', { scope: 'project' })).details.documents.map((d: any) => d.title), ['by-hand', 'Plan']);
    assert.deepEqual(done(await b('doc_list', {})).details.documents.map((d: any) => d.title), ['by-hand', 'Plan', 'Second chat only']);
    refused(await a('doc_list', { scope: 'mine' }), 'invalid');
    // The page lists what the chats of a folder have, whichever chat's it is.
    const page = await docs.call('GET', '/folders');
    assert.equal(page.body.folders[0].documents.length, 4);
    assert.ok(theirs.details.id);
    // The panel beside a chat lists every document of its folder, as the page does, with the folder they are in: another chat's own
    // is marked as that chat's (its agent does not see it). Nothing for a chat that is not there.
    const beside = await docs.call('GET', '/chats/a/documents');
    assert.deepEqual(beside.body.folder, { id: folderIdOf(folder), name: path.basename(folder), path: folder });
    assert.deepEqual(beside.body.documents.map((d: any) => [d.title, d.scope, d.otherChat ?? false, d.chatTitle ?? null]), [['by-hand', 'project', false, null], ['Plan', 'project', false, null], ['Scratch pad', 'chat', false, null], ['Second chat only', 'chat', true, 'Chat b']]);
    assert.deepEqual((await docs.call('GET', '/chats/b/documents')).body.documents.map((d: any) => [d.title, d.otherChat ?? false]), [['by-hand', false], ['Plan', false], ['Scratch pad', true], ['Second chat only', false]]);
    const none = await docs.call('GET', '/chats/c/documents');
    assert.deepEqual(none.body, { folder: { id: folderIdOf(empty), name: path.basename(empty), path: empty }, documents: [] });
    assert.deepEqual(readdirSync(empty), [], 'asking makes nothing in a folder with no documents');
    assert.equal((await docs.call('GET', '/chats/gone/documents')).status, 404);
  } finally {
    await docs.close();
  }
});

test('the agent reads a document by its id: its Markdown and revision, an earlier revision of it, and nothing it is not given', async () => {
  const { folder, docs, f, id, url, agent } = await withDocument('docs-tools-read-');
  try {
    const first = done(await agent('doc_read', { id }));
    assert.equal(first.details.revision, 1);
    assert.equal(first.details.title, 'Plan');
    assert.ok(first.text.startsWith(`"Plan" (id ${id}, documents/plan.md, revision 1, project document)\n\n# Plan\n\nShip it on Friday.`));
    assert.ok(first.text.endsWith('The build is green.\n'), 'the document is returned whole, as it is');
    await docs.call('PUT', url, { markdown: '# Plan\n\nShip it on Monday.\n', base: 1 });
    const second = done(await agent('doc_read', { id }));
    assert.equal(second.details.revision, 2);
    assert.ok(second.text.includes('Ship it on Monday.') && !second.text.includes('Friday'));
    const earlier = done(await agent('doc_read', { id, revision: 1 }));
    assert.ok(earlier.text.includes('Ship it on Friday.'));
    assert.match(earlier.text, /revision 1 \(an earlier one; it is at 2 now\)/);
    assert.equal(earlier.details.current, 2);
    refused(await agent('doc_read', { id, revision: 9 }), 'not_found');
    refused(await agent('doc_read', { id, revision: 0 }), 'invalid');

    // By id only: a name, a path, an id that is not one and one nobody has are all no document.
    writeFileSync(path.join(folder, 'secret.md'), '# Outside the documents folder');
    for (const bad of ['plan.md', 'documents/plan.md', '../secret.md', '/etc/passwd', '0123456789abcdef', 'ABCDEF0123456789', '', undefined, 7]) {
      refused(await agent('doc_read', { id: bad }), 'not_found');
    }
    assert.ok(f);
  } finally {
    await docs.close();
  }
});

test('a long document is read in parts that run on from each other, and the parts are the document', async () => {
  const lines = Array.from({ length: 4000 }, (_, i) => `Line ${i + 1} of a long document, with some words in it.`);
  const text = `# Long\n\n${lines.join('\n')}\n`;
  const { docs, id, agent } = await withDocument('docs-tools-long-', text);
  try {
    let joined = '';
    let from = 1;
    let parts = 0;
    for (;;) {
      const part = done(await agent('doc_read', { id, from_line: from }));
      parts++;
      const body = part.text.slice(part.text.indexOf('\n\n') + 2);
      const more = /\n\[Lines (\d+)-(\d+) of (\d+)\. Read on with from_line=(\d+)\.\]$/.exec(body);
      if (!more) {
        joined += from > 1 ? body.replace(/\n\[Lines \d+-\d+ of \d+: the end\.\]$/, '') : body;
        break;
      }
      assert.equal(Number(more[1]), from);
      assert.equal(Number(more[4]), Number(more[2]) + 1);
      assert.ok(body.length < 62_000, 'a part is about 60 KB');
      joined += body.slice(0, more.index) + '\n';
      from = Number(more[4]);
    }
    assert.ok(parts > 1);
    assert.equal(joined, text);
    refused(await agent('doc_read', { id, from_line: 5000 }), 'invalid');
    refused(await agent('doc_read', { id, from_line: 0 }), 'invalid');
  } finally {
    await docs.close();
  }
});

test('a line longer than a part is cut into parts too, each read on from the one before, and a part is never more than a part', async () => {
  const wide = 'x'.repeat(500_000);
  // The cut of the second text falls between the halves of a character outside the basic plane.
  const emoji = 'a' + '😀'.repeat(40_000);
  for (const text of [`# Big\n\n${wide}\nAfter.\n`, `# Wide\n\n${emoji}\n\nEnd.`]) {
    const { docs, id, agent } = await withDocument('docs-tools-wide-', text);
    try {
      let joined = '';
      let from = 1;
      let offset = 0;
      let parts = 0;
      for (;;) {
        const part = done(await agent('doc_read', { id, from_line: from, char_offset: offset }));
        parts++;
        const body = part.text.slice(part.text.indexOf('\n\n') + 2);
        const more = /\n\[Lines (\d+)-(\d+) of (\d+)(?:, the last one only in part)?\. Read on with from_line=(\d+)(?:, char_offset=(\d+))?\.\]$/.exec(body);
        const piece = more ? body.slice(0, more.index) : body.replace(/\n\[Lines \d+-\d+ of \d+: the end\.\]$/, '');
        assert.ok(piece.length <= 60_000, `a part is no more than 60000 characters, not ${piece.length}`);
        assert.ok(piece.isWellFormed(), 'no part ends inside a character');
        if (!more) {
          joined += piece;
          break;
        }
        // A part that stops inside a line goes on in that line; one that stops at the end of a line, at the next.
        const inside = more[5] !== undefined;
        joined += inside ? piece : piece + '\n';
        from = Number(more[4]);
        offset = inside ? Number(more[5]) : 0;
      }
      assert.ok(parts > 1);
      assert.equal(joined, text);
    } finally {
      await docs.close();
    }
  }
  const { docs, id, agent } = await withDocument('docs-tools-wide-refused-', `# Big\n\n${wide}\n`);
  try {
    refused(await agent('doc_read', { id, from_line: 3, char_offset: 500_001 }), 'invalid');
    refused(await agent('doc_read', { id, from_line: 3, char_offset: -1 }), 'invalid');
  } finally {
    await docs.close();
  }
  // An offset the agent counted itself may fall inside a character: it is told, and no part starts with half of one.
  const pairs = await withDocument('docs-tools-wide-pairs-', `# W\n\na${'😀'.repeat(100)}\n`);
  try {
    // 'a' is 0, the first character after it is 1 and 2, the next 3 and 4.
    assert.match(refused(await pairs.agent('doc_read', { id: pairs.id, from_line: 3, char_offset: 2 }), 'invalid'), /char_offset 2 is inside a character of line 3: use 1 or 3/);
    refused(await pairs.agent('doc_read', { id: pairs.id, from_line: 3, char_offset: 4 }), 'invalid');
    for (const offset of [0, 1, 3, 201]) {
      const part = done(await pairs.agent('doc_read', { id: pairs.id, from_line: 3, char_offset: offset }));
      assert.ok(part.text.isWellFormed(), `from ${offset}`);
    }
  } finally {
    await pairs.docs.close();
  }
});

test('a chat\'s own document is the chat\'s: another chat in the folder is told there is none, to read or to edit', async () => {
  const folder = folderWith('docs-tools-scope-');
  const docs = await portal({ a: folder, b: folder });
  try {
    const a = docs.agent('a');
    const b = docs.agent('b');
    const own = done(await a('doc_create', { title: 'Mine', markdown: '# Mine\n\nOne.\n', scope: 'chat' })).details.id;
    const shared = done(await a('doc_create', { title: 'Ours', markdown: '# Ours\n\nOne.\n' })).details.id;
    assert.ok(done(await a('doc_read', { id: own })).text.includes('this chat\'s document'));
    const was = head(folder);
    refused(await b('doc_read', { id: own }), 'not_found');
    refused(await b('doc_edit', { id: own, expected_revision: 1, edits: [{ quote: 'One.', replacement: 'Two.' }] }), 'not_found');
    assert.equal(fileOf(folder, 'mine.md'), '# Mine\n\nOne.\n');
    assert.equal(head(folder), was);
    // A project document is every chat's.
    done(await b('doc_edit', { id: shared, expected_revision: 1, edits: [{ quote: 'One.', replacement: 'Two.' }] }));
    assert.equal(fileOf(folder, 'ours.md'), '# Ours\n\nTwo.\n');
    assert.ok(done(await a('doc_read', { id: shared })).text.includes('Two.'));
  } finally {
    await docs.close();
  }
});

test('an edit replaces quoted text on the revision that was read: one new revision by the agent, and the page sees it', async () => {
  const { folder, docs, f, id, url, agent } = await withDocument('docs-tools-edit-');
  try {
    const before = Number(git(folder, 'rev-list', '--count', 'HEAD'));
    const edited = done(await agent('doc_edit', { id, expected_revision: 1, edits: [{ quote: 'on Friday', replacement: 'on Monday' }, { quote: 'The build is green.', replacement: 'The build is green, the tests too.' }] }));
    assert.equal(edited.details.revision, 2);
    assert.equal(edited.details.from, 1);
    assert.equal(edited.details.edits, 2);
    assert.equal(edited.details.changed, true);
    assert.match(edited.text, /^Edited "Plan" \(documents\/plan\.md\): 2 edits made, now at revision 2\.$/);
    assert.equal(fileOf(folder, 'plan.md'), '# Plan\n\nShip it on Monday.\n\nThe build is green, the tests too.\n');
    assert.equal(Number(git(folder, 'rev-list', '--count', 'HEAD')), before + 1, 'one commit for all of its edits');
    assert.equal(git(folder, 'show', '-s', '--format=%(trailers:only,unfold)', 'HEAD'), `Doc-Id: ${id}\nDoc-Name: plan.md\nRevision: 2\nAuthor: agent`);
    const read = await docs.call('GET', url);
    assert.equal(read.body.revision, 2);
    assert.equal(read.body.markdown, '# Plan\n\nShip it on Monday.\n\nThe build is green, the tests too.\n');
    const history = await docs.call('GET', `${url}/history`);
    assert.deepEqual(history.body.revisions.map((r: any) => [r.revision, r.author]), [[2, 'agent'], [1, 'user']]);

    // The next edit goes on from the revision the last one gave, with no read between; a quote may go, and a title change shows.
    const next = done(await agent('doc_edit', { id, expected_revision: 2, edits: [{ quote: '# Plan', replacement: '# Release plan' }, { quote: '\n\nThe build is green, the tests too.\n', replacement: '\n' }] }));
    assert.equal(next.details.revision, 3);
    assert.equal(next.details.title, 'Release plan');
    assert.equal(fileOf(folder, 'plan.md'), '# Release plan\n\nShip it on Monday.\n');
    assert.ok(f);
  } finally {
    await docs.close();
  }
});

test('an edit on a revision the document has moved on from writes nothing: after the person saved, or a file was changed outside', async () => {
  const { folder, docs, url, id, agent } = await withDocument('docs-tools-mismatch-');
  try {
    const edit = (expected: number) => agent('doc_edit', { id, expected_revision: expected, edits: [{ quote: 'on Friday', replacement: 'on Monday' }] });
    assert.equal((await docs.call('PUT', url, { markdown: '# Plan\n\nShip it on Friday, said the user.\n\nThe build is green.\n', base: 1 })).status, 200);
    const was = head(folder);
    const bytes = fileOf(folder, 'plan.md');
    const error = refused(await edit(1), 'revision_mismatch');
    assert.match(error, /revision 2, not 1/);
    assert.match(error, /Nothing was written/);
    assert.equal(fileOf(folder, 'plan.md'), bytes, 'the file is as it was');
    assert.equal(head(folder), was, 'no commit');
    assert.equal((await docs.call('GET', url)).body.revision, 2);
    // A revision from the future is as wrong.
    refused(await edit(3), 'revision_mismatch');
    refused(await agent('doc_edit', { id, expected_revision: 'latest', edits: [{ quote: 'a', replacement: 'b' }] }), 'invalid');
    refused(await agent('doc_edit', { id, edits: [{ quote: 'a', replacement: 'b' }] }), 'invalid');
    assert.equal(head(folder), was);

    // Someone changes the file itself (Files, an editor): that is a revision of its own, and the agent's old one is stale.
    writeFileSync(path.join(folder, 'documents', 'plan.md'), '# Plan\n\nShip it on Friday, by hand.\n');
    refused(await edit(2), 'revision_mismatch');
    assert.equal(fileOf(folder, 'plan.md'), '# Plan\n\nShip it on Friday, by hand.\n');
    assert.deepEqual((await docs.call('GET', `${url}/history`)).body.revisions.map((r: any) => [r.revision, r.author]), [[3, 'external'], [2, 'user'], [1, 'user']]);
    done(await edit(3));
    assert.equal(fileOf(folder, 'plan.md'), '# Plan\n\nShip it on Monday, by hand.\n');
  } finally {
    await docs.close();
  }
});

test('two edits made on one revision at once: one is made, the other is refused and changes nothing', async () => {
  const { folder, docs, id, agent } = await withDocument('docs-tools-parallel-');
  try {
    const results = await Promise.all([
      agent('doc_edit', { id, expected_revision: 1, edits: [{ quote: 'on Friday', replacement: 'on Monday' }] }),
      agent('doc_edit', { id, expected_revision: 1, edits: [{ quote: 'is green', replacement: 'is red' }] }),
    ]);
    assert.deepEqual(results.map((r) => r.ok), [true, false]);
    refused(results[1], 'revision_mismatch');
    assert.equal(fileOf(folder, 'plan.md'), '# Plan\n\nShip it on Monday.\n\nThe build is green.\n', 'only the first one\'s change');
    assert.equal(git(folder, 'rev-list', '--count', 'HEAD'), '2');
  } finally {
    await docs.close();
  }
});

test('a quote that is not in the document, or is in it twice, is refused, and so is an edit list that cannot be made whole', async () => {
  const text = '# Plan\n\nShip it on Friday.\n\nShip it on Friday, again.\n\nThe build is green.\n';
  const { folder, docs, id, agent } = await withDocument('docs-tools-quotes-', text);
  try {
    const was = head(folder);
    const edit = (...edits: { quote: string; replacement: string }[]) => agent('doc_edit', { id, expected_revision: 1, edits });
    assert.match(refused(await edit({ quote: 'on Tuesday', replacement: 'x' }), 'quote_not_found'), /Nothing was written/);
    assert.match(refused(await edit({ quote: 'Ship it on Friday', replacement: 'x' }), 'quote_ambiguous'), /more than once/);
    // The same text as one quote takes the whole of what it names: more of it makes it one.
    done(await edit({ quote: 'Friday.\n\nShip', replacement: 'Monday.\n\nShip' }));
    assert.equal(fileOf(folder, 'plan.md'), text.replace('Friday.\n\nShip', 'Monday.\n\nShip'));
    assert.notEqual(head(folder), was);
  } finally {
    await docs.close();
  }
});

test('edits are all made or none, each found in the text as it was, and none over another', async () => {
  const { folder, docs, id, agent } = await withDocument('docs-tools-whole-');
  try {
    const was = head(folder);
    const bytes = fileOf(folder, 'plan.md');
    const edit = (...edits: { quote: string; replacement: string }[]) => agent('doc_edit', { id, expected_revision: 1, edits });
    // The second cannot be made: the first is not, either. The message says which one.
    assert.match(refused(await edit({ quote: 'on Friday', replacement: 'on Monday' }, { quote: 'on Tuesday', replacement: 'x' }), 'quote_not_found'), /^quote_not_found: edit 2: /);
    // Text that only the first edit brings is not in the document the second looks in.
    refused(await edit({ quote: 'on Friday', replacement: 'on a Tuesday' }, { quote: 'a Tuesday', replacement: 'x' }), 'quote_not_found');
    // Two that change the same words, or one inside another.
    assert.match(refused(await edit({ quote: 'Ship it on', replacement: 'x' }, { quote: 'it on Friday', replacement: 'y' }), 'edits_overlap'), /edits 1 and 2/);
    refused(await edit({ quote: 'Ship it on Friday.', replacement: 'x' }, { quote: 'it on', replacement: 'y' }), 'edits_overlap');
    // Nothing to do, or no quote to find.
    refused(await agent('doc_edit', { id, expected_revision: 1, edits: [] }), 'invalid');
    refused(await edit({ quote: '', replacement: 'x' }), 'invalid');
    refused(await agent('doc_edit', { id, expected_revision: 1, edits: [{ quote: 'on Friday' }] }), 'invalid');
    refused(await agent('doc_edit', { id, expected_revision: 1, edits: Array.from({ length: 51 }, () => ({ quote: 'Plan', replacement: 'Plan' })) }), 'invalid');
    assert.equal(fileOf(folder, 'plan.md'), bytes);
    assert.equal(head(folder), was);
    // Given in any order, they are made where they are.
    done(await edit({ quote: 'The build is green.', replacement: 'Green.' }, { quote: '# Plan', replacement: '# Plan B' }));
    assert.equal(fileOf(folder, 'plan.md'), '# Plan B\n\nShip it on Friday.\n\nGreen.\n');
  } finally {
    await docs.close();
  }
});

test('whole lines taken out take their line breaks with them: no blank lines are left where they were', async () => {
  const cases: [string, string, string][] = [
    // A paragraph between two others: one blank line stays between them.
    ['# Plan\n\nA.\n\nB.\n\nC.\n', 'B.', '# Plan\n\nA.\n\nC.\n'],
    // The same, quoted with its line breaks.
    ['# Plan\n\nA.\n\nB.\n\nC.\n', 'B.\n\n', '# Plan\n\nA.\n\nC.\n'],
    // A line of a list: the list closes up.
    ['# Plan\n\n- a\n- b\n- c\n', '- b', '# Plan\n\n- a\n- c\n'],
    // The last paragraph: the document ends as it did, with one line break.
    ['# Plan\n\nA.\n\nC.\n', 'C.', '# Plan\n\nA.\n'],
    // The first line: nothing is left in front of what follows.
    ['# Plan\n\nA.\n', '# Plan', 'A.\n'],
    // Words in a line: only the words go.
    ['# Plan\n\nA very good day.\n', 'very ', '# Plan\n\nA good day.\n'],
    ['# Plan\n\nA word\nB.\n', ' word', '# Plan\n\nA\nB.\n'],
    // Written with CRLF, it stays CRLF.
    ['# Plan\r\n\r\nA.\r\n\r\nB.\r\n\r\nC.\r\n', 'B.', '# Plan\r\n\r\nA.\r\n\r\nC.\r\n'],
  ];
  for (const [markdown, quote, after] of cases) {
    const { folder, docs, id, agent } = await withDocument('docs-tools-remove-', markdown);
    try {
      done(await agent('doc_edit', { id, expected_revision: 1, edits: [{ quote, replacement: '' }] }));
      assert.equal(fileOf(folder, 'plan.md'), after, JSON.stringify({ markdown, quote }));
    } finally {
      await docs.close();
    }
  }
  // Two lines removed in one call, next to each other, and line breaks the agent quotes on their own are its to take.
  const { folder, docs, id, agent } = await withDocument('docs-tools-remove-two-', '# Plan\n\nA.\n\nB.\n\nC.\n\nD.\n');
  try {
    done(await agent('doc_edit', { id, expected_revision: 1, edits: [{ quote: 'B.', replacement: '' }, { quote: 'C.', replacement: '' }] }));
    assert.equal(fileOf(folder, 'plan.md'), '# Plan\n\nA.\n\nD.\n');
    done(await agent('doc_edit', { id, expected_revision: 2, edits: [{ quote: 'A.\n\n', replacement: 'A.\n' }] }));
    assert.equal(fileOf(folder, 'plan.md'), '# Plan\n\nA.\nD.\n');
  } finally {
    await docs.close();
  }
});

test('an edit that changes nothing makes no revision, and a document written with CRLF line breaks is edited with a quote of any', async () => {
  const { folder, docs, id, agent } = await withDocument('docs-tools-same-');
  try {
    const same = done(await agent('doc_edit', { id, expected_revision: 1, edits: [{ quote: 'on Friday', replacement: 'on Friday' }] }));
    assert.equal(same.details.changed, false);
    assert.equal(same.details.revision, 1);
    assert.match(same.text, /^No change/);
    assert.equal(git(folder, 'rev-list', '--count', 'HEAD'), '1');

    const dos = '# Plan\r\n\r\nShip it on Friday.\r\n\r\nThe build is green.\r\n';
    writeFileSync(path.join(folder, 'documents', 'plan.md'), dos);
    // The file was changed outside: its revision is 2 now. A quote with line feeds finds its lines, and the replacement keeps the document's.
    const crlf = done(await agent('doc_edit', { id, expected_revision: 2, edits: [{ quote: 'Friday.\n\nThe build', replacement: 'Monday.\n\nThe new build' }] }));
    assert.equal(crlf.details.revision, 3);
    assert.equal(fileOf(folder, 'plan.md'), dos.replace('Friday.\r\n\r\nThe build', 'Monday.\r\n\r\nThe new build'));
    // A quote on one line, found as it is, brings line breaks of its own into the replacement: the document's kind.
    const more = done(await agent('doc_edit', { id, expected_revision: 3, edits: [{ quote: 'The new build', replacement: 'One\nAnd a half\r\nAnd two' }] }));
    assert.equal(more.details.revision, 4);
    assert.equal(fileOf(folder, 'plan.md'), '# Plan\r\n\r\nShip it on Monday.\r\n\r\nOne\r\nAnd a half\r\nAnd two is green.\r\n');
    assert.ok(!/(?<!\r)\n/.test(fileOf(folder, 'plan.md')), 'no line break of the other kind');
    // A quote that starts with a line break matches the line feed of a CRLF break: the carriage return before it goes with it.
    writeFileSync(path.join(folder, 'documents', 'plan.md'), '# Plan\r\n\r\nOne\r\nTwo\r\n');
    done(await agent('doc_edit', { id, expected_revision: 5, edits: [{ quote: '\nTwo', replacement: '\nOne and a half\nTwo' }] }));
    assert.equal(fileOf(folder, 'plan.md'), '# Plan\r\n\r\nOne\r\nOne and a half\r\nTwo\r\n');
    // Also when the replacement takes the line break away: no carriage return is left alone.
    done(await agent('doc_edit', { id, expected_revision: 6, edits: [{ quote: '\nTwo', replacement: ' and Two' }] }));
    assert.equal(fileOf(folder, 'plan.md'), '# Plan\r\n\r\nOne\r\nOne and a half and Two\r\n');
    assert.ok(!/\r(?!\n)/.test(fileOf(folder, 'plan.md')), 'no carriage return without its line feed');
    // A document of line feeds keeps them, and one of both has the kind most of it has.
    writeFileSync(path.join(folder, 'documents', 'plan.md'), '# Plan\nOne\nTwo\r\n');
    done(await agent('doc_edit', { id, expected_revision: 8, edits: [{ quote: 'One', replacement: 'A\nB' }] }));
    assert.equal(fileOf(folder, 'plan.md'), '# Plan\nA\nB\nTwo\r\n');
    writeFileSync(path.join(folder, 'documents', 'plan.md'), '# Plan\r\nOne\r\nTwo\n');
    done(await agent('doc_edit', { id, expected_revision: 10, edits: [{ quote: 'One', replacement: 'A\nB' }] }));
    assert.equal(fileOf(folder, 'plan.md'), '# Plan\r\nA\r\nB\r\nTwo\n');
  } finally {
    await docs.close();
  }
});

test('an edit that would make the document too big, or put a secret into it, is refused and writes nothing', async () => {
  const { folder, docs, id, agent } = await withDocument('docs-tools-edit-refused-');
  try {
    const was = head(folder);
    const bytes = fileOf(folder, 'plan.md');
    refused(await agent('doc_edit', { id, expected_revision: 1, edits: [{ quote: 'on Friday', replacement: 'x'.repeat(1024 * 1024) }] }), 'too_large');
    refused(await agent('doc_edit', { id, expected_revision: 1, edits: [{ quote: 'on Friday', replacement: 'key AKIA' + 'A'.repeat(16) }] }), 'secret');
    refused(await agent('doc_edit', { id, expected_revision: 1, edits: [{ quote: 'on Friday', replacement: '-----BEGIN RSA PRIVATE KEY-----' }] }), 'secret');
    assert.equal(fileOf(folder, 'plan.md'), bytes);
    assert.equal(head(folder), was);
    // A document that already holds one (the person saved it, and was warned) can still be edited elsewhere.
    const token = `ghp_${'b'.repeat(36)}`;
    writeFileSync(path.join(folder, 'documents', 'plan.md'), `${bytes}\ntoken ${token}\n`);
    done(await agent('doc_edit', { id, expected_revision: 2, edits: [{ quote: 'on Friday', replacement: 'on Monday' }] }));
    // Not one that it makes of what is there and its replacement: neither part is a secret alone.
    const holder = done(await agent('doc_create', { title: 'Parts', markdown: '# Parts\n\nkey: sk-PLACEHOLDER\n\nghp_AAAA and more\n' }));
    const parts = fileOf(folder, 'parts.md');
    const edit = (expected: number, ...edits: { quote: string; replacement: string }[]) => agent('doc_edit', { id: holder.details.id, expected_revision: expected, edits });
    refused(await edit(1, { quote: 'PLACEHOLDER', replacement: 'abcdefghijklmnopqrstuvwxyz0123' }), 'secret');
    // Nor out of two edits that meet.
    refused(await edit(1, { quote: 'key', replacement: 'gh' }, { quote: ': ', replacement: `p_${'A'.repeat(36)}` }), 'secret');
    // Nor one the document holds changed into another.
    writeFileSync(path.join(folder, 'documents', 'parts.md'), `${parts}${token}\n`);
    refused(await edit(2, { quote: token, replacement: `${token.slice(0, -1)}c` }), 'secret');
    refused(await edit(2, { quote: 'and more', replacement: token }), 'secret');
    assert.equal(fileOf(folder, 'parts.md'), `${parts}${token}\n`);
    // What it leaves as it is, or takes out, is no trouble.
    done(await edit(2, { quote: 'and more', replacement: 'and less' }, { quote: token, replacement: 'removed' }));
    assert.ok(!fileOf(folder, 'parts.md').includes('ghp_bbb'));
  } finally {
    await docs.close();
  }
});

test('a document the store cannot find is not found, and the tools of a chat whose folder is gone say so', async () => {
  const folder = folderWith('docs-tools-missing-');
  const docs = await portal({ a: folder, gone: path.join(folder, 'no-such-folder') });
  try {
    // No store at all in this folder yet: reading makes none.
    refused(await docs.agent('a')('doc_read', { id: '0123456789abcdef' }), 'not_found');
    refused(await docs.agent('a')('doc_edit', { id: '0123456789abcdef', expected_revision: 1, edits: [{ quote: 'a', replacement: 'b' }] }), 'not_found');
    assert.deepEqual(readdirSync(folder), []);
    assert.deepEqual(readdirSync(DATA).includes(folderIdOf(folder)), false, 'no store was made for it');
    refused(await docs.agent('gone')('doc_list', {}), 'not_found');
    refused(await docs.agent('gone')('doc_create', { title: 'Plan' }), 'not_found');
  } finally {
    await docs.close();
  }
});

test('an edit made while the person saves is refused by the store when the person got in first: it never writes over their text', async () => {
  // The two meet inside the agent's read, which takes a while: a few times over, as when they meet is the only thing not fixed.
  for (let round = 0; round < 4; round++) {
    const { folder, docs, url, id, agent } = await withDocument(`docs-tools-meanwhile-${round}-`);
    try {
      const person = '# Plan\n\nShip it on Friday, said the user.\n\nThe build is green.\n';
      const agents = '# Plan\n\nShip it on Monday.\n\nThe build is green.\n';
      const [edited, saved] = await Promise.all([
        agent('doc_edit', { id, expected_revision: 1, edits: [{ quote: 'on Friday', replacement: 'on Monday' }] }),
        docs.call('PUT', url, { markdown: person, base: 1 }),
      ]);
      // Both were made on revision 1: one of them is the next revision, and the other is refused.
      assert.equal(Number(edited.ok) + Number(saved.status === 200), 1, `round ${round}: ${JSON.stringify([edited, saved.status])}`);
      assert.equal(fileOf(folder, 'plan.md'), edited.ok ? agents : person);
      assert.equal(git(folder, 'rev-list', '--count', 'HEAD'), '2');
      if (!edited.ok) refused(edited, 'revision_mismatch');
    } finally {
      await docs.close();
    }
  }
});

test('a name that something else holds in the documents folder is no name for a new document: the agent is told it exists', async () => {
  const folder = folderWith('docs-tools-way-', { 'documents/.keep': '' });
  const elsewhere = folderWith('docs-tools-way-target-');
  const docs = await portal({ a: folder });
  try {
    // A link under the name (not a file the store takes in): the document is not made under the next number instead.
    symlinkSync(path.join(elsewhere, 'target.md'), path.join(folder, 'documents', 'plan.md'));
    const error = refused(await docs.agent('a')('doc_create', { title: 'Plan', markdown: '# Plan\n' }), 'exists');
    assert.match(error, /plan\.md is in the way/);
    assert.deepEqual(readdirSync(path.join(folder, 'documents')).sort(), ['.keep', 'plan.md']);
    assert.deepEqual(readdirSync(elsewhere), [], 'nothing was written through the link');
  } finally {
    await docs.close();
  }
});

test('what the store refuses that has no code of its own is said as refused, with its reason', async () => {
  // `documents` is a link to another folder of the project: not where the documents are.
  const folder = folderWith('docs-tools-link-', { 'other/.keep': '' });
  symlinkSync(path.join(folder, 'other'), path.join(folder, 'documents'));
  const docs = await portal({ a: folder });
  try {
    assert.match(refused(await docs.agent('a')('doc_create', { title: 'Plan' }), 'refused'), /documents in this folder is a link/);
    assert.deepEqual(readdirSync(path.join(folder, 'other')), ['.keep']);
  } finally {
    await docs.close();
  }
});
