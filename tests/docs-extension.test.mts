import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { ensureDependencies, missingDependencies } from '../extensions/docs/deps.js';
import docsServer from '../extensions/docs/server.js';
import { resolveInside } from '../server/src/workspace-files.ts';
import { scratch } from './helpers.mts';

type Res = { status(code: number): Res; json(body: unknown): void };
type Handler = (req: { params: Record<string, string> }, res: Res) => void;

/** The Documents extension's server half, given chats that work in these folders, as the portal gives it them. */
function server(folders: Record<string, string>, logged: string[] = []) {
  const routes = new Map<string, Handler>();
  docsServer({
    extension: 'pithagoras-docs',
    log: (line: string) => logged.push(line),
    router: { get: (route: string, handler: Handler) => routes.set(route, handler) },
    files: { inside: resolveInside },
    chats: {
      list: () => Object.keys(folders).map((id) => ({ id, title: `Chat ${id}` })),
      folder: (id: string) => realpathSync(folders[id]),
    },
  }, {
    // What it needs to run is there: the test does not install anything.
    dependencies: (log: (line: string) => void) => (log('dependencies checked'), Promise.resolve(true)),
  });
  const ask = (route: string, params: Record<string, string> = {}) => {
    let answer: { status: number; body: any } = { status: 200, body: undefined };
    const res: Res = {
      status: (code) => ((answer.status = code), res),
      json: (body) => void (answer.body = body),
    };
    routes.get(route)!({ params }, res);
    return answer;
  };
  return {
    folders: () => ask('/folders').body.folders,
    read: (folder: string, name: string) => ask('/folders/:folder/documents/:name', { folder, name }),
  };
}

function folderWith(prefix: string, files: Record<string, string>) {
  const folder = scratch(prefix);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    writeFileSync(path.join(folder, name), text);
  }
  return folder;
}

test('the Documents page is told every folder chats work in that has documents, each once, with its documents by title', () => {
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
  const [only, ...more] = docs.folders();
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
});

test('a chat whose folder is gone has no documents, and the others are still listed', () => {
  const site = folderWith('docs-gone-', { 'documents/plan.md': '# Plan' });
  const docs = server({ a: site, gone: path.join(site, 'no-such-folder') });
  assert.deepEqual(docs.folders().map((f: any) => f.chats.map((c: any) => c.id)), [['a']]);
});

test('a document is read by its folder\'s id and its name, and nothing else is', () => {
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
  const [folder] = docs.folders();
  assert.deepEqual(folder.documents.map((d: any) => d.name), ['other.md', 'plan.md'], 'neither links nor a file too big are listed');

  const plan = docs.read(folder.id, 'plan.md');
  assert.equal(plan.status, 200);
  assert.equal(plan.body.markdown, '# The plan\n\nShip it.\n');
  assert.equal(plan.body.title, 'The plan');
  assert.equal(plan.body.name, 'plan.md');

  for (const name of ['../secret.md', 'link.md', 'alias.md', 'hard.md', 'big.md', 'missing.md', '.', '', 'documents/plan.md', 'plan.md\0']) {
    const refused = docs.read(folder.id, name);
    assert.equal(refused.status, 404, name);
    assert.deepEqual(refused.body, { error: 'There is no such document' }, name);
  }
  // A folder is only one a chat works in: an id the portal does not list, or a path, is no folder.
  assert.equal(docs.read('0123456789abcdef', 'plan.md').status, 404);
  assert.equal(docs.read(realpathSync(site), 'plan.md').status, 404);
  assert.equal(server({ b: outside }).read(folder.id, 'plan.md').status, 404, 'the chat that worked there is gone');
});

test('a pipe named like a document is no document, and asking for one does not hold the portal', () => {
  const site = folderWith('docs-pipe-', { 'documents/plan.md': '# Plan' });
  execFileSync('mkfifo', [path.join(site, 'documents', 'pipe.md')]);
  // Asked in a process of its own: a server half that waits for the pipe's writer waits for good, and so would this test.
  const asking = `
    import docsServer from ${JSON.stringify(new URL('../extensions/docs/server.js', import.meta.url).href)};
    import { resolveInside } from ${JSON.stringify(new URL('../server/src/workspace-files.ts', import.meta.url).href)};
    import { realpathSync } from 'node:fs';
    const routes = new Map();
    docsServer({
      log: () => {},
      router: { get: (route, handler) => routes.set(route, handler) },
      files: { inside: resolveInside },
      chats: { list: () => [{ id: 'a', title: 'A' }], folder: () => realpathSync(process.env.SITE) },
    }, { dependencies: async () => true });
    const ask = (route, params) => { const answer = {}; const res = { status: (code) => ((answer.status = code), res), json: (body) => (answer.body = body) }; routes.get(route)({ params }, res); return answer; };
    const [folder] = ask('/folders', {}).body.folders;
    const read = ask('/folders/:folder/documents/:name', { folder: folder.id, name: 'pipe.md' });
    console.log(JSON.stringify({ listed: folder.documents.map((d) => d.name), status: read.status }));
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', asking], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, SITE: site } });
  assert.equal(child.signal, null, 'held by the pipe until it was killed');
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { listed: ['plan.md'], status: 404 });
});

test('a document\'s title is its first heading as the page draws it, the same in the list and when it is read', () => {
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
  const [folder] = docs.folders();
  const listed = Object.fromEntries(folder.documents.map((d: any) => [d.name, d.title]));
  assert.deepEqual(listed, {
    'setext.md': 'The plan',
    'setext-two.md': 'Some notes over two lines',
    'list.md': 'After the list',
    'fence.md': 'Real heading',
    'inline.md': 'The plan for v2, with a link and care',
    'late.md': 'late',
  });
  for (const [name, title] of Object.entries(listed)) assert.equal(docs.read(folder.id, name).body.title, title, name);
});

test('a documents folder that is a link is not one: what it leads to is neither listed nor read', () => {
  const site = folderWith('docs-linked-', { 'src/code.md': '# Code' });
  symlinkSync('src', path.join(site, 'documents'));
  const docs = server({ a: site });
  assert.deepEqual(docs.folders(), []);
  // Asked for all the same, by the id the page would know the folder by.
  const id = createHash('sha256').update(realpathSync(site)).digest('hex').slice(0, 16);
  assert.equal(docs.read(id, 'code.md').status, 404);
  // The same folder with a real documents folder: listed and read by that id.
  rmSync(path.join(site, 'documents'));
  mkdirSync(path.join(site, 'documents'));
  writeFileSync(path.join(site, 'documents', 'code.md'), '# Code');
  assert.equal(docs.folders()[0].id, id);
  assert.equal(docs.read(id, 'code.md').status, 200);
});

test('every text the Documents page shows has a German one, and no German one is left over', () => {
  const file = new URL('../extensions/docs/web/client.js', import.meta.url);
  const src = ts.createSourceFile('client.js', readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const shown = new Set<string>();
  let german: Set<string> | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(src);
      const first = n.arguments[0];
      if (callee === 't' && first && ts.isStringLiteralLike(first)) shown.add(first.text);
      if (callee === 'portal.locale.add' && first && ts.isStringLiteralLike(first) && first.text === 'de') {
        const table = n.arguments[1] as ts.ObjectLiteralExpression;
        german = new Set(table.properties.map((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : '')));
      }
    }
    // A page's title in the sidebar is shown as well.
    if (ts.isPropertyAssignment(n) && n.name.getText(src) === 'title' && ts.isStringLiteralLike(n.initializer)) shown.add(n.initializer.text);
    ts.forEachChild(n, visit);
  };
  visit(src);
  // The portal's own texts, which it translates itself.
  shown.delete('Loading…');
  assert.ok(german, 'German texts are added');
  assert.ok(shown.size > 3);
  assert.deepEqual([...shown].filter((text) => !german!.has(text)), [], 'shown without German');
  assert.deepEqual([...german!].filter((text) => !shown.has(text)), [], 'German for nothing shown');
});

/** A package folder that depends on `a` and `b` to run and on `c` to be built, with an npm that writes what it is told to. */
function packageNeeding(npmSays: string) {
  const dir = scratch('docs-deps-');
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'needs', dependencies: { a: '1.0.0', b: '1.0.0' }, devDependencies: { c: '1.0.0' } }));
  const npm = path.join(dir, 'fake-npm');
  writeFileSync(npm, `#!/bin/sh\necho "$@" >> "${dir}/asked"\n${npmSays}\n`);
  chmodSync(npm, 0o755);
  return { dir, npm, asked: () => readFileSync(path.join(dir, 'asked'), 'utf8').trim().split('\n') };
}

test('the Documents extension installs what it needs to run when it is missing, once, and says so in the log', async () => {
  const { dir, npm, asked } = packageNeeding('mkdir -p node_modules/a node_modules/b && echo "{}" > node_modules/a/package.json && echo "{}" > node_modules/b/package.json');
  mkdirSync(path.join(dir, 'node_modules', 'a'), { recursive: true });
  writeFileSync(path.join(dir, 'node_modules', 'a', 'package.json'), '{}');
  assert.deepEqual(missingDependencies(dir), ['b'], 'what it needs to be built is not asked for');
  const log: string[] = [];
  // Asked twice while it installs: one install.
  const [first, second] = await Promise.all([ensureDependencies((line: string) => log.push(line), { dir, npm }), ensureDependencies((line: string) => log.push(line), { dir, npm })]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.deepEqual(asked(), ['ci --omit=dev --ignore-scripts --no-audit --no-fund']);
  assert.deepEqual(missingDependencies(dir), []);
  assert.equal(log.length, 2);
  assert.match(log[0], /^Installing its dependencies \(b\) with npm$/);
  assert.match(log[1], /^Installed its dependencies in \d+ s$/);
  // Everything there: npm is not asked again.
  assert.equal(await ensureDependencies((line: string) => log.push(line), { dir, npm }), true);
  assert.equal(asked().length, 1);
  assert.equal(log.length, 2);
});

test('an install of the Documents extension\'s dependencies that fails is said in the log, and tried again on the next start', async () => {
  const { dir, npm, asked } = packageNeeding('echo "npm error network unreachable" >&2; exit 1');
  const log: string[] = [];
  assert.equal(await ensureDependencies((line: string) => log.push(line), { dir, npm }), false);
  assert.match(log.at(-1)!, /^Could not install its dependencies: npm exited with 1: npm error network unreachable$/);
  assert.equal(await ensureDependencies((line: string) => log.push(line), { dir, npm }), false);
  assert.equal(asked().length, 2);
  // An npm that cannot be started at all is said as well.
  assert.equal(await ensureDependencies((line: string) => log.push(line), { dir, npm: path.join(dir, 'no-such-npm') }), false);
  assert.match(log.at(-1)!, /^Could not install its dependencies: spawn .*no-such-npm ENOENT$/);
});
