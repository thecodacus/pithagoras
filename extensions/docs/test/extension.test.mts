import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { ensureDependencies, missingDependencies } from '../deps.js';
import { SECRET_WARNING } from '../secret.js';
import docsServer from '../server.js';
import { folderFiles } from '../../../core/server/src/folder-files.ts';
import { scratch } from '../../../tests/helpers.mts';

/** The portal's data folder for the stores. */
const DATA = scratch('docs-ext-data-');

type Res = { status(code: number): Res; json(body: unknown): void; setHeader(name: string, value: string): void; end(body?: Buffer | string): void };
type Handler = (req: { params: Record<string, string>; query: Record<string, string>; method: string; path: string; body?: unknown }, res: Res) => unknown;

/** The Documents extension's server half, given chats that work in these folders, as the portal gives it them. */
function server(folders: Record<string, string>, logged: string[] = []) {
  const routes = new Map<string, Handler>();
  const add = (method: string) => (route: string, ...handlers: Handler[]) => routes.set(`${method} ${route}`, handlers.at(-1)!);
  docsServer({
    extension: 'pithagoras-docs',
    log: (line: string) => logged.push(line),
    router: { get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE') },
    http: { json: () => () => {} },
    files: folderFiles,
    sandbox: { on: () => false },
    // The portal's data folder for the stores: one for the file, the stores are told apart by their folders' ids.
    dataDir: () => DATA,
    chats: {
      list: () => Object.keys(folders).map((id) => ({ id, title: `Chat ${id}` })),
      folder: (id: string) => realpathSync(folders[id]),
      inFolder: (folder: string) => Object.keys(folders).filter((id) => ((() => { try { return realpathSync(folders[id]) === folder; } catch { return false; } })())).map((id) => ({ id, title: `Chat ${id}` })),
    },
  }, {
    // What it needs to run is there: the test does not install anything.
    dependencies: (log: (line: string) => void) => (log('dependencies checked'), Promise.resolve(true)),
  });
  const call = async (method: string, route: string, params: Record<string, string> = {}, body?: unknown) => {
    const answer: { status: number; body: any; headers: Record<string, string> } = { status: 200, body: undefined, headers: {} };
    const res: Res = {
      status: (code) => ((answer.status = code), res),
      json: (body) => void (answer.body = body),
      setHeader: (name, value) => void (answer.headers[name.toLowerCase()] = value),
      end: (body) => void (answer.body = body),
    };
    await routes.get(`${method} ${route}`)!({ params, query: {}, method, path: route, body }, res);
    return answer;
  };
  const ask = (route: string, params: Record<string, string> = {}) => call('GET', route, params);
  return {
    folders: async () => (await ask('/folders')).body.folders,
    read: (folder: string, id: string) => ask('/folders/:folder/documents/:id', { folder, id }),
    call,
  };
}

/** The id of the document `name` in a listed folder. */
const idOf = (folder: any, name: string) => folder.documents.find((d: any) => d.name === name).id as string;

function folderWith(prefix: string, files: Record<string, string>) {
  const folder = scratch(prefix);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    writeFileSync(path.join(folder, name), text);
  }
  return folder;
}

test('the Documents page is told every folder chats work in that has documents, each once, with its documents by title', async () => {
  const site = folderWith('docs-site-', {
    'documents/plan.md': '# The plan\n\nShip it.\n',
    // A `#` in a code block is a comment: the title is the heading after it.
    'documents/setup.md': '```bash\n# install first\nnpm ci\n```\n\n## Setting up\n',
    'documents/untitled.md': 'No heading at all.\n',
    // Not documents: another kind of file, a hidden one, one in a folder below, and one beside the documents folder.
    'documents/picture.png': 'png',
    'documents/.draft.md': '# Hidden',
    'documents/old/archive.md': '# Archived',
    'README.md': '# Not in documents',
  });
  const empty = folderWith('docs-empty-', { 'notes.md': '# Not a document' });
  const logged: string[] = [];
  const docs = server({ a: site, b: site, c: empty }, logged);
  assert.deepEqual(logged, ['dependencies checked'], 'it sees to its dependencies as it starts, in the portal\'s log');
  const [only, ...more] = await docs.folders();
  assert.deepEqual(more, [], 'a folder without documents is left out');
  assert.equal(only.path, realpathSync(site));
  assert.equal(only.name, path.basename(site));
  assert.match(only.id, /^[0-9a-f]{16}$/, 'named by an id, not by its path');
  assert.deepEqual(only.chats, [{ id: 'a', title: 'Chat a' }, { id: 'b', title: 'Chat b' }], 'two chats in one folder: one folder');
  assert.deepEqual(only.documents.map((d: any) => [d.name, d.title]), [
    ['setup.md', 'Setting up'],
    ['plan.md', 'The plan'],
    ['untitled.md', 'untitled'],
  ]);
  assert.equal(only.documents[1].size, Buffer.byteLength('# The plan\n\nShip it.\n'));
  assert.ok(!Number.isNaN(Date.parse(only.documents[1].modified)));
  // Each is a document of the folder's store from now on: named by an id, at its first revision.
  for (const doc of only.documents) {
    assert.match(doc.id, /^[0-9a-f]{16}$/);
    assert.equal(doc.revision, 1);
  }
  assert.deepEqual((await docs.folders())[0].documents.map((d: any) => d.id), only.documents.map((d: any) => d.id), 'the same ids the next time');
});

test('a chat whose folder is gone has no documents, and the others are still listed', async () => {
  const site = folderWith('docs-gone-', { 'documents/plan.md': '# Plan' });
  const docs = server({ a: site, gone: path.join(site, 'no-such-folder') });
  assert.deepEqual((await docs.folders()).map((f: any) => f.chats.map((c: any) => c.id)), [['a']]);
});

test('a document is read by its folder\'s id and its own, and nothing else is', async () => {
  const site = folderWith('docs-read-', {
    'documents/plan.md': '# The plan\n\nShip it.\n',
    'documents/other.md': '# Other',
    'secret.md': '# Outside the documents folder',
    'documents/big.md': '#'.repeat(1024 * 1024 + 1),
  });
  const outside = folderWith('docs-outside-', { 'private.md': '# Not this folder' });
  // A link, a link to another document, and a second name of a file outside: none of them is a document.
  symlinkSync(path.join(outside, 'private.md'), path.join(site, 'documents', 'link.md'));
  symlinkSync('other.md', path.join(site, 'documents', 'alias.md'));
  linkSync(path.join(outside, 'private.md'), path.join(site, 'documents', 'hard.md'));
  const docs = server({ a: site });
  const [folder] = await docs.folders();
  assert.deepEqual(folder.documents.map((d: any) => d.name), ['other.md', 'plan.md'], 'neither links nor a file too big are listed');
  const plan = await docs.read(folder.id, idOf(folder, 'plan.md'));
  assert.equal(plan.status, 200);
  assert.equal(plan.body.markdown, '# The plan\n\nShip it.\n');
  assert.equal(plan.body.title, 'The plan');
  assert.equal(plan.body.name, 'plan.md');

  // A document is named by its id: a name, a path, or an id the store did not give is none.
  for (const name of ['plan.md', '../secret.md', 'link.md', 'alias.md', 'hard.md', 'big.md', '.', '', 'documents/plan.md', 'plan.md\0', '0123456789abcdef']) {
    const refused = await docs.read(folder.id, name);
    assert.equal(refused.status, 404, name);
    assert.deepEqual(refused.body, name === '0123456789abcdef' ? { error: 'There is no such document', code: 'deleted' } : { error: 'There is no such document' }, name);
  }
  // A folder is only one a chat works in: an id the portal does not list, or a path, is no folder.
  const id = idOf(folder, 'plan.md');
  assert.equal((await docs.read('0123456789abcdef', id)).status, 404);
  assert.equal((await docs.read(realpathSync(site), id)).status, 404);
  assert.equal((await server({ b: outside }).read(folder.id, id)).status, 404, 'the chat that worked there is gone');
});

test('a Markdown file the person uploads is a document as it is, under its own name, and a document is downloaded as its file', async () => {
  const site = folderWith('docs-upload-', { 'documents/plan.md': '# The plan\n' });
  const docs = server({ a: site });
  const [folder] = await docs.folders();
  const upload = (body: unknown) => docs.call('POST', '/folders/:folder/documents/upload', { folder: folder.id }, body);
  // Kept as it is: no heading is added, and the name is the file's.
  const made = await upload({ name: 'Meeting notes.md', markdown: 'No heading here.\n' });
  assert.equal(made.status, 201);
  assert.equal(made.body.name, 'Meeting notes.md');
  assert.equal(made.body.title, 'Meeting notes');
  assert.equal(readFileSync(path.join(site, 'documents', 'Meeting notes.md'), 'utf8'), 'No heading here.\n');
  // A name that is taken gets a number; a .markdown file is kept as .md; what would leave the folder stays in it.
  assert.equal((await upload({ name: 'plan.md', markdown: '# Another plan\n' })).body.name, 'plan-2.md');
  assert.equal((await upload({ name: 'ideas.markdown', markdown: '# Ideas\n' })).body.name, 'ideas.md');
  assert.equal((await upload({ name: '../../../evil.md', markdown: 'x' })).body.name, 'evil.md');
  assert.equal((await upload({ name: '.hidden.md', markdown: 'x' })).body.name, 'hidden.md');
  assert.deepEqual(readdirSync(path.join(site, 'documents')).sort(), ['Meeting notes.md', 'evil.md', 'hidden.md', 'ideas.md', 'plan-2.md', 'plan.md']);
  // Only Markdown, and only text.
  for (const body of [{ name: 'picture.png', markdown: 'x' }, { name: 'notes.md' }, { markdown: 'x' }]) assert.equal((await upload(body)).status, 400, JSON.stringify(body));
  assert.equal((await upload({ name: 'big.md', markdown: 'x'.repeat(1024 * 1024 + 1) })).status, 413);

  const down = await docs.call('GET', '/folders/:folder/documents/:id/download', { folder: folder.id, id: made.body.id });
  assert.equal(down.status, 200);
  assert.equal(String(down.body), 'No heading here.\n');
  assert.match(down.headers['content-type'], /^text\/markdown/);
  assert.equal(down.headers['content-disposition'], `attachment; filename="Meeting notes.md"; filename*=UTF-8''Meeting%20notes.md`);
  assert.equal((await docs.call('GET', '/folders/:folder/documents/:id/download', { folder: folder.id, id: '0123456789abcdef' })).status, 404);
});

test('an uploaded name that is cut to 80 characters is never cut in the middle of a character made of two (no U+FFFD in the name)', async () => {
  const site = folderWith('docs-upload-cut-', { 'documents/plan.md': '# The plan\n' });
  const docs = server({ a: site });
  const [folder] = await docs.folders();
  const upload = (name: string) => docs.call('POST', '/folders/:folder/documents/upload', { folder: folder.id }, { name, markdown: 'x' });
  // 79 letters and an emoji (two UTF-16 units): the second unit would be the 81st.
  const cut = await upload(`${'a'.repeat(79)}😀.md`);
  assert.equal(cut.status, 201);
  assert.equal(cut.body.name, `${'a'.repeat(79)}.md`);
  // Within the limit the whole emoji stays, and the same name again gets a number: cut so that the number fits, not through the emoji.
  const whole = await upload(`${'b'.repeat(77)}😀.md`);
  assert.equal(whole.body.name, `${'b'.repeat(77)}😀.md`);
  const again = await upload(`${'b'.repeat(77)}😀.md`);
  assert.equal(again.body.name, `${'b'.repeat(77)}-2.md`);
  const names = readdirSync(path.join(site, 'documents'));
  assert.equal(names.length, 4);
  for (const name of names) assert.ok(name.isWellFormed() && !name.includes('\uFFFD'), name);
  // A name of astral characters throughout stays a name the file system takes (80 units are at most 240 bytes).
  const many = await upload(`${'😀'.repeat(60)}.md`);
  assert.equal(many.status, 201);
  assert.equal(many.body.name, `${'😀'.repeat(40)}.md`);
});

test('a pipe named like a document is no document, and asking for one does not hold the portal', () => {
  const site = folderWith('docs-pipe-', { 'documents/plan.md': '# Plan', 'documents/other.md': '# Other' });
  execFileSync('mkfifo', [path.join(site, 'documents', 'pipe.md')]);
  // Asked in a process of its own: a server half that waits for the pipe's writer waits for good, and so would this test.
  // A document whose file is swapped for a pipe after it was listed is asked for as well.
  const asking = `
    import docsServer from ${JSON.stringify(new URL('../server.js', import.meta.url).href)};
    import { folderFiles } from ${JSON.stringify(new URL('../../../core/server/src/folder-files.ts', import.meta.url).href)};
    import { execFileSync } from 'node:child_process';
    import { realpathSync, rmSync } from 'node:fs';
    const routes = new Map();
    const add = (method) => (route, ...handlers) => routes.set(method + ' ' + route, handlers.at(-1));
    docsServer({
      log: () => {},
      router: { get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE') },
      http: { json: () => () => {} },
      files: folderFiles,
      sandbox: { on: () => false },
      dataDir: () => process.env.DATA,
      chats: { list: () => [{ id: 'a', title: 'A' }], inFolder: () => [{ id: 'a', title: 'A' }], folder: () => realpathSync(process.env.SITE) },
    }, { dependencies: async () => true });
    const ask = async (route, params) => { const answer = {}; const res = { status: (code) => ((answer.status = code), res), json: (body) => (answer.body = body) }; await routes.get('GET ' + route)({ params, query: {} }, res); return answer; };
    const [folder] = (await ask('/folders', {})).body.folders;
    const other = folder.documents.find((d) => d.name === 'other.md');
    rmSync(process.env.SITE + '/documents/other.md');
    execFileSync('mkfifo', [process.env.SITE + '/documents/other.md']);
    const read = await ask('/folders/:folder/documents/:id', { folder: folder.id, id: other.id });
    const [again] = (await ask('/folders', {})).body.folders;
    console.log(JSON.stringify({ listed: folder.documents.map((d) => d.name), status: read.status, again: again.documents.map((d) => d.name) }));
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', asking], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, SITE: site, DATA } });
  assert.equal(child.signal, null, 'held by the pipe until it was killed');
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { listed: ['other.md', 'plan.md'], status: 404, again: ['plan.md'] });
});

test('a document\'s title is its first heading as the page draws it, the same in the list and when it is read', async () => {
  const site = folderWith('docs-titles-', {
    // A heading underlined is a heading.
    'documents/setext.md': 'The plan\n========\n\nShip it.\n\n## Details\n',
    'documents/setext-two.md': 'Some notes\nover two lines\n---\n\n# Later\n',
    // A list item or a rule over a line of dashes is not one.
    'documents/list.md': '- an item\n---\n\n# After the list\n',
    // A closing fence has no info string: a line like ```js inside a block is still code.
    'documents/fence.md': '````md\n```js\n# not a heading\n````\n\n# Real heading\n',
    // Its inline Markdown is drawn, so it is not part of the title.
    'documents/inline.md': '# The **plan** for `v2`, with [a link](https://example.com) and _care_\n',
    // Far down: neither the list nor the document has a title other than its name.
    'documents/late.md': `${'Text before the heading. '.repeat(200)}\n\n# Late heading\n`,
  });
  const docs = server({ a: site });
  const [folder] = await docs.folders();
  const listed = Object.fromEntries(folder.documents.map((d: any) => [d.name, d.title]));
  assert.deepEqual(listed, {
    'setext.md': 'The plan',
    'setext-two.md': 'Some notes over two lines',
    'list.md': 'After the list',
    'fence.md': 'Real heading',
    'inline.md': 'The plan for v2, with a link and care',
    'late.md': 'late',
  });
  for (const [name, title] of Object.entries(listed)) assert.equal((await docs.read(folder.id, idOf(folder, name))).body.title, title, name);
});

test('what the page does not draw as a heading is no title, and what it draws as one is', async () => {
  const site = folderWith('docs-blocks-', {
    // A code block that opens on a list item's line is a code block all the same.
    'documents/list-fence.md': 'Steps:\n\n1. ```sh\n   # install the tools first\n   npm ci\n   ```\n\n# Setup steps\n',
    'documents/quote-fence.md': '> ```\n> # in a quoted code block\n> ```\n\n# After the quote\n',
    // A heading in a quote is drawn as one.
    'documents/quote.md': '> # Quoted heading\n\n# Later\n',
    // A code block left open in a quote or a list item ends with it.
    'documents/quote-open.md': '> ```\n> code\n\n# After the open quote\n',
    'documents/item-open.md': '- ```\n  code\n\n# After the open item\n',
    // An HTML comment, and a block of HTML, are not drawn as text at all.
    'documents/comment.md': '<!--\n# TODO: replace this template text\n-->\n\n# Meeting notes\n',
    'documents/comment-one-line.md': '<!-- # not this -->\n# Meeting notes\n',
    'documents/html.md': '<div align="center">\n\n# Centered title\n\n</div>\n',
    'documents/html-block.md': '<div>\n# not a heading in the block\n</div>\n\n# After the block\n',
    'documents/script.md': '<script>\n\n# in a script\n\n</script>\n\n# After the script\n',
    // A tab before a line reaches the fourth column: code, or more of the paragraph above, not a heading.
    'documents/tab-code.md': 'Install:\n\n\t# install the tools first\n\tnpm ci\n\n# Setup steps\n',
    'documents/tab-top.md': '\t# a comment in code\n\n# Real title\n',
    'documents/tab-paragraph.md': 'Some text\n\t# still the paragraph\n\n# After the paragraph\n',
    'documents/tab-quote.md': '>\t# Heading in a quote, after a tab\n',
    // A heading underlined in a quote, or in a list item, is drawn as one; a rule under an item is a rule.
    'documents/quote-setext.md': '> Quoted title\n> ===\n\n# Later\n',
    'documents/item-setext.md': '- Item title\n  ---\n\n# Later\n',
    'documents/item-rule.md': '- an item\n---\n\n# After the rule\n',
    // A byte order mark is not text.
    'documents/bom.md': '﻿# Release plan\n',
    // Inline code with backticks is no fence.
    'documents/inline-fence.md': '``` not a fence ```\n\n# Title after inline code\n',
    // Marks of links, pictures and footnotes are not drawn.
    // Emphasis loses its marks however long it is; a lone star and a word with underscores keep theirs.
    'documents/long-emphasis.md': '# **Project Phoenix: moving the billing service onto the new platform**\n',
    'documents/stars.md': '# 5 * 3 * 2 in my_file_name, and *one* __two__ ~~three~~\n',
    'documents/marks.md': '# The [release plan][plan], [![CI](https://example.com/ci.svg)](https://example.com/ci) and <https://example.com> [^1]\n\n[plan]: ./plan.md\n[^1]: A note.\n',
  });
  const docs = server({ a: site });
  const [folder] = await docs.folders();
  const listed = Object.fromEntries(folder.documents.map((d: any) => [d.name, d.title]));
  assert.deepEqual(listed, {
    'list-fence.md': 'Setup steps',
    'quote-fence.md': 'After the quote',
    'quote.md': 'Quoted heading',
    'quote-open.md': 'After the open quote',
    'item-open.md': 'After the open item',
    'comment.md': 'Meeting notes',
    'comment-one-line.md': 'Meeting notes',
    'html.md': 'Centered title',
    'html-block.md': 'After the block',
    'script.md': 'After the script',
    'tab-code.md': 'Setup steps',
    'tab-top.md': 'Real title',
    'tab-paragraph.md': 'After the paragraph',
    'tab-quote.md': 'Heading in a quote, after a tab',
    'quote-setext.md': 'Quoted title',
    'item-setext.md': 'Item title',
    'item-rule.md': 'After the rule',
    'long-emphasis.md': 'Project Phoenix: moving the billing service onto the new platform',
    'stars.md': '5 * 3 * 2 in my_file_name, and one two three',
    'bom.md': 'Release plan',
    'inline-fence.md': 'Title after inline code',
    'marks.md': 'The release plan, CI and https://example.com',
  });
  for (const [name, title] of Object.entries(listed)) assert.equal((await docs.read(folder.id, idOf(folder, name))).body.title, title, name);
});

/** 4 KB of `line`, line after line: as much as is looked at for a title. */
const fill = (line: string) => `${line}\n`.repeat(Math.floor(4096 / (line.length + 1)));

/**
 * Documents made to be slow to title, each kind what one rule took longest
 * over: a heading with a long run of blanks; runs of emphasis marks; a long
 * underlined paragraph; a paragraph of many short lines; headings whose text is
 * all taken off (so the next line is looked at too) made of unclosed brackets,
 * pictures and footnote marks, links and references; long quotes and lists.
 */
const SLOW: Record<string, string> = {
  blanks: `# a${' '.repeat(4090)}b`,
  strong: `# ${'**a '.repeat(1000)}`,
  emphasis: `# ${'*a '.repeat(1300)}`,
  underlined: `${'_a '.repeat(1300)}\n===\n`,
  lines: fill('a'),
  brackets: fill(`# <a ${'['.repeat(1017)}>`),
  pictures: fill(`# <a ${'![^'.repeat(339)}>`),
  links: fill(`# <a ${'[a]('.repeat(250)}>`),
  references: fill(`# <a ${'[a]['.repeat(250)}>`),
  tags: fill(`# ${'<a '.repeat(330)}`),
  quotes: fill('> a'),
  items: fill('- a\n  b'),
};

test('documents made to be slow to title do not hold the portal while they are listed', async () => {
  for (const [kind, text] of Object.entries(SLOW)) {
    // As many as a folder lists, in a folder of their own.
    const site = folderWith(`docs-slow-${kind}-`, { 'documents/.keep': '' });
    for (let i = 0; i < 1000; i++) writeFileSync(path.join(site, 'documents', `${kind}-${i}.md`), text);
    const docs = server({ a: site });
    // The first listing takes them into the folder's store (and its history), once: it is what comes after that is timed.
    await docs.folders();
    // The processor's time, not the clock's: a busy machine makes the process wait for its turn, which is not what a slow rule costs.
    const started = process.cpuUsage();
    const [folder] = await docs.folders();
    const { user, system } = process.cpuUsage(started);
    const took = (user + system) / 1000;
    assert.equal(folder.documents.length, 1000, kind);
    // Before, these took from one and a half seconds (brackets) to twelve (blanks); an ordinary folder of this size takes a few dozen milliseconds.
    assert.ok(took < 1000, `${kind}: listing took ${Math.round(took)} ms`);
  }
});

test('a documents folder that is a link is not one: what it leads to is neither listed nor read', async () => {
  const site = folderWith('docs-linked-', { 'src/code.md': '# Code' });
  symlinkSync('src', path.join(site, 'documents'));
  const docs = server({ a: site });
  assert.deepEqual(await docs.folders(), []);
  // Asked for all the same, by the id the page would know the folder by.
  const id = createHash('sha256').update(realpathSync(site)).digest('hex').slice(0, 16);
  assert.equal((await docs.read(id, '0123456789abcdef')).status, 404);
  // The same folder with a real documents folder: listed and read by that id.
  rmSync(path.join(site, 'documents'));
  mkdirSync(path.join(site, 'documents'));
  writeFileSync(path.join(site, 'documents', 'code.md'), '# Code');
  const [folder] = await docs.folders();
  assert.equal(folder.id, id);
  assert.equal((await docs.read(id, idOf(folder, 'code.md'))).status, 200);
});

test('every text the Documents page shows has a German one, and no German one is left over', () => {
  // The page's modules, whichever of them says a text: the built editor next to them says none.
  const folder = new URL('../web/', import.meta.url);
  const modules = readdirSync(folder).filter((name) => name.endsWith('.js') && name !== 'editor.js');
  assert.ok(modules.includes('client.js') && modules.includes('document-editor.js'), modules.join(', '));
  const shown = new Set<string>();
  // What each German text is, by its English: kept to say each fills in the same words.
  const said = new Map<string, string>();
  // A text that is not written out where it is asked for cannot be held to a German one: there are none.
  const unwritten: string[] = [];
  let german: Set<string> | undefined;
  for (const name of modules) {
    const src = ts.createSourceFile(name, readFileSync(new URL(name, folder), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText(src);
        const first = n.arguments[0];
        if (callee === 't' && first && ts.isStringLiteralLike(first)) shown.add(first.text);
        else if (callee === 't') unwritten.push(`${name}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}`);
        if (callee === 'portal.locale.add' && first && ts.isStringLiteralLike(first) && first.text === 'de') {
          const table = n.arguments[1] as ts.ObjectLiteralExpression;
          german = new Set(table.properties.map((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : '')));
          for (const p of table.properties as unknown as ts.PropertyAssignment[]) {
            if (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) && ts.isStringLiteralLike(p.initializer)) said.set(p.name.text, p.initializer.text);
          }
        }
      }
      // A page's title in the sidebar is shown as well.
      if (ts.isPropertyAssignment(n) && n.name.getText(src) === 'title' && ts.isStringLiteralLike(n.initializer) && name === 'client.js') shown.add(n.initializer.text);
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  // The portal's own texts, which it translates itself.
  shown.delete('Loading…');
  assert.ok(german, 'German texts are added');
  assert.ok(shown.size > 3);
  assert.deepEqual([...shown].filter((text) => !german!.has(text)), [], 'shown without German');
  assert.deepEqual([...german!].filter((text) => !shown.has(text)), [], 'German for nothing shown');
  assert.deepEqual(unwritten, [], 'texts asked for that are not written out');
  // Each German text fills in the words the English does, and is not empty.
  const words = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const [english, german] of said) {
    assert.deepEqual(words(german), words(english), english);
    assert.ok(german.trim(), `${english} has no German`);
  }
  assert.equal(said.size, german!.size, 'every German text is written out');
  // The warning the server half sends with a save is said by the page in the person's language, and is the same words.
  assert.ok(shown.has(SECRET_WARNING), 'the page says the secret warning as the server half does');
});

/** `version` of `name` in the package folder `dir`, as npm leaves it there. */
function installed(dir: string, where: string, version: string) {
  mkdirSync(path.join(dir, where), { recursive: true });
  writeFileSync(path.join(dir, where, 'package.json'), JSON.stringify({ version }));
}

/**
 * A package folder that depends on `a` (which brings `d`) and `b` to run and on `c` to be built, as its lock
 * file says, with an npm that does what it is told to.
 */
function packageNeeding(npmSays: string) {
  const dir = scratch('docs-deps-');
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'needs', dependencies: { a: '^1.0.0', b: '^1.0.0' }, devDependencies: { c: '1.0.0' } }));
  writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
    name: 'needs', lockfileVersion: 3, packages: {
      '': { name: 'needs' },
      'node_modules/a': { version: '1.2.0' },
      'node_modules/a/node_modules/d': { version: '2.0.0' },
      'node_modules/b': { version: '1.0.0' },
      'node_modules/c': { version: '1.0.0', dev: true },
      // Only where it fits: left out by npm elsewhere.
      'node_modules/e': { version: '1.0.0', optional: true },
    },
  }));
  const npm = path.join(dir, 'fake-npm');
  writeFileSync(npm, `#!/bin/sh\necho "$@" >> "${dir}/asked"\n${npmSays}\n`);
  chmodSync(npm, 0o755);
  return { dir, npm, asked: () => readFileSync(path.join(dir, 'asked'), 'utf8').trim().split('\n') };
}

/** What a fake npm does for `npm ci --omit=dev`: what the lock names to run, at its versions. */
const INSTALLS = [['node_modules/a', '1.2.0'], ['node_modules/a/node_modules/d', '2.0.0'], ['node_modules/b', '1.0.0']]
  .map(([where, version]) => `mkdir -p ${where} && echo '{"version":"${version}"}' > ${where}/package.json`).join(' && ');

/** The events of a process that has ended can come after the promise for it: what they log is in by then. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('the Documents extension installs what it needs to run when it is missing, once, and says so in the log', async () => {
  const { dir, npm, asked } = packageNeeding(INSTALLS);
  installed(dir, 'node_modules/a', '1.2.0');
  installed(dir, 'node_modules/a/node_modules/d', '2.0.0');
  assert.deepEqual(missingDependencies(dir), ['b'], 'what it needs to be built is not asked for');
  assert.deepEqual(missingDependencies(dir, { dev: true }), ['b', 'c'], 'unless it is to be built');
  const log: string[] = [];
  // Asked twice while it installs: one install.
  const [first, second] = await Promise.all([ensureDependencies((line: string) => log.push(line), { dir, npm }), ensureDependencies((line: string) => log.push(line), { dir, npm })]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.deepEqual(asked(), ['ci --omit=dev --ignore-scripts --no-audit --no-fund']);
  assert.deepEqual(missingDependencies(dir), []);
  await settle();
  assert.equal(log.length, 2);
  assert.match(log[0], /^Installing its dependencies \(b\) with npm$/);
  assert.match(log[1], /^Installed its dependencies in \d+ s$/);
  // Everything there: npm is not asked again.
  assert.equal(await ensureDependencies((line: string) => log.push(line), { dir, npm }), true);
  assert.equal(asked().length, 1);
  assert.equal(log.length, 2);
});

test('a new revision of the server half asking while the revision before installs is one install', async () => {
  const { dir, npm, asked } = packageNeeding(`sleep 0.3; ${INSTALLS}`);
  // The module read again, as the portal loads it under another revision of the half.
  const next: typeof import('../deps.js') = await import(`${new URL('../deps.js', import.meta.url).href}?revision=next`);
  assert.notEqual(next.ensureDependencies, ensureDependencies);
  const log: string[] = [];
  const first = ensureDependencies((line: string) => log.push(line), { dir, npm });
  const second = next.ensureDependencies((line: string) => log.push(line), { dir, npm });
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(asked(), ['ci --omit=dev --ignore-scripts --no-audit --no-fund']);
});

test('a dependency at another version than the lock names is installed again, one it brings along as well', async () => {
  const { dir, npm, asked } = packageNeeding(INSTALLS);
  // What an older lock installed: a later commit moved `a` on, and `a` brings another `d`.
  installed(dir, 'node_modules/a', '1.0.0');
  installed(dir, 'node_modules/a/node_modules/d', '1.0.0');
  installed(dir, 'node_modules/b', '1.0.0');
  assert.deepEqual(missingDependencies(dir), ['a', 'd']);
  const log: string[] = [];
  assert.equal(await ensureDependencies((line: string) => log.push(line), { dir, npm }), true);
  assert.equal(asked().length, 1);
  assert.match(log[0], /^Installing its dependencies \(a, d\) with npm$/);
  assert.deepEqual(missingDependencies(dir), []);
  // An optional package that is there is checked like the rest.
  installed(dir, 'node_modules/e', '0.1.0');
  assert.deepEqual(missingDependencies(dir), ['e']);
});

test('without a lock file, what the package names is what is checked', () => {
  const { dir } = packageNeeding('');
  rmSync(path.join(dir, 'package-lock.json'));
  installed(dir, 'node_modules/a', '0.0.1');
  assert.deepEqual(missingDependencies(dir), ['b']);
  assert.deepEqual(missingDependencies(dir, { dev: true }), ['b', 'c']);
});

test('an install of the Documents extension\'s dependencies that fails is said in the log once, and tried again on the next start', async () => {
  const { dir, npm, asked } = packageNeeding('echo "npm error network unreachable" >&2; exit 1');
  const log: string[] = [];
  assert.equal(await ensureDependencies((line: string) => log.push(line), { dir, npm }), false);
  await settle();
  assert.deepEqual(log.slice(1), ['Could not install its dependencies: npm exited with 1: npm error network unreachable']);
  assert.equal(await ensureDependencies((line: string) => log.push(line), { dir, npm }), false);
  assert.equal(asked().length, 2);
  // An npm that cannot be started at all is said as well, once: not again as the end of a process that never ran.
  log.length = 0;
  assert.equal(await ensureDependencies((line: string) => log.push(line), { dir, npm: path.join(dir, 'no-such-npm') }), false);
  await settle();
  assert.equal(log.length, 2, log.join('\n'));
  assert.match(log[1], /^Could not install its dependencies: spawn .*no-such-npm ENOENT$/);
});
