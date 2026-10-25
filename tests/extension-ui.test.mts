import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { bridgeExtensionUi, clientHalf, staticImports, packageKinds, packageThemes, serverHalf, validName, UI_RECEIVE, UI_SEND } from '../core/server/src/extension-ui.ts';
import { choose, registerTheme, themes, themesSettled } from '../core/web/src/extensions/themes.ts';
import { chosenPalette, choosePalette, coloursOf, storedPalette, themeIdNow, toTriplet, TOKENS } from '../core/web/src/theme.tsx';
import { register, slotEntries } from '../core/web/src/extensions/slots.ts';
import { rankExtensions } from '../core/web/src/extensions/rank.ts';
import { hasCommand, registerCommand, runCommand } from '../core/web/src/extensions/commands.ts';
import { addStrings, forgetStrings, translate, translateCount, translateInContext, translateWithParts } from '../core/web/src/extensions/strings.ts';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chatOnScreen, extensionGone, extensionHere, onlyWaitFor, onServerPush, serverPush, setChatOnScreen } from '../core/web/src/extensions/server-feed.ts';
import { panels, panelsFor, setPanelController } from '../core/web/src/extensions/panels.ts';
import { chatFeed, forgetChatFeed, onChatFeed, publishChat, sameValue } from '../core/web/src/extensions/chat-feed.ts';
import { addLocale, setLanguage } from '../core/web/src/i18n.ts';
import { settlePanels } from '../core/web/src/use-work-panels.ts';
import { placeWindows } from '../core/web/src/voice-windows.ts';
import notes from './fixtures/extensions/notes/index.ts';
import notesServer from './fixtures/extensions/notes/server.js';
import { scratch } from './helpers.mts';

const bus = () => {
  const handlers = new Map<string, ((data: unknown) => void)[]>();
  return {
    emit: (channel: string, data: unknown) => handlers.get(channel)?.forEach((handler) => handler(data)),
    on: (channel: string, handler: (data: unknown) => void) => {
      handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
      return () => handlers.set(channel, (handlers.get(channel) ?? []).filter((h) => h !== handler));
    },
  };
};

/** A package folder with these files, and this under `pithagoras` in its package.json. */
function pkg(declared: unknown, files: string[], name: string | undefined = 'my-extension') {
  const dir = scratch('extension-ui-');
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...(name ? { name } : {}), version: '1.2.3', pi: { extensions: ['./index.ts'] }, ...(declared ? { pithagoras: declared } : {}) }));
  for (const file of files) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), '// here');
  }
  return dir;
}

test('a package that declares a browser half has its web folder, its module and its stylesheet found', () => {
  const dir = pkg({ client: './web/client.js', style: './web/look/client.css' }, ['index.ts', 'web/client.js', 'web/look/client.css']);
  const half = clientHalf(dir)!;
  assert.equal(half.name, 'my-extension');
  assert.equal(half.version, '1.2.3');
  assert.equal(half.dir, path.join(dir, 'web'));
  assert.equal(half.entry, 'client.js');
  assert.equal(half.style, 'look/client.css');
  // Of the files of its folder, as a digest that goes in an address.
  assert.match(half.rev, /^[\w-]{16}$/);
});

test('what a browser half imports along with itself is found by what each module says, down to the last, and not what it imports when called', () => {
  const dir = pkg({ client: './web/client.js' }, ['web/client.js']);
  const web = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir, 'web', file)), { recursive: true });
    writeFileSync(path.join(dir, 'web', file), text);
  };
  web('client.js', 'import { a } from "./a.js";\nimport"./side.js";\nexport * from "./re/export.js";\nimport("./lazy.js");\nexport default () => a;');
  web('a.js', 'import{b as c}from"./sub/b.js";import x from "../outside.js";import "./style.css";export const a = c;');
  web('sub/b.js', 'import { a } from "../a.js";\nimport type { T } from "./types.js";\nexport const b = 1;');
  web('side.js', '');
  web('re/export.js', 'export const r = 1;');
  web('sub/types.js', '');
  web('lazy.js', 'import "./never.js";');
  web('never.js', '');
  // The files that are there, by their path from the folder: not the module itself, which is asked for under its revision, and not a file that is not there.
  assert.deepEqual(staticImports(clientHalf(dir)!).sort(), ['a.js', 're/export.js', 'side.js', 'sub/b.js', 'sub/types.js']);
  // As it is changed, it is read again.
  web('client.js', 'import "./never.js";');
  assert.deepEqual(staticImports(clientHalf(dir)!), ['never.js']);
});

test('what a browser half imports is found in time in step with the size of its modules, whatever is in them, and a module too large to be one is not read', () => {
  const dir = pkg({ client: './web/client.js' }, ['web/client.js']);
  const web = (file: string, text: string) => writeFileSync(path.join(dir, 'web', file), text);
  web('a.js', '');
  // A long stretch that says "import" and "export" over and over without a quote or a semicolon, as a licence banner or a block of prose in a bundle may.
  web('client.js', `import "./a.js";\n/* ${'import export '.repeat(25_000)} */`);
  const before = process.cpuUsage();
  assert.deepEqual(staticImports(clientHalf(dir)!), ['a.js']);
  const { user, system } = process.cpuUsage(before);
  assert.ok((user + system) / 1000 < 1000, `${(user + system) / 1000} ms of CPU for 350 KB`);
  // Too large to be a module of an extension's: not read, and so nothing found in it.
  web('client.js', `import "./a.js";\n/* ${'x'.repeat(2 * 1024 * 1024)} */`);
  assert.deepEqual(staticImports(clientHalf(dir)!), []);
});

test('a module changed, or only its stylesheet, is a module under another revision', () => {
  const dir = pkg({ client: './web/client.js', style: './web/client.css' }, ['web/client.js', 'web/client.css']);
  const before = clientHalf(dir)!.rev;
  writeFileSync(path.join(dir, 'web', 'client.js'), '// here, and longer than it was');
  const changed = clientHalf(dir)!.rev;
  assert.notEqual(changed, before);
  writeFileSync(path.join(dir, 'web', 'client.css'), '/* here, and longer than it was */');
  assert.notEqual(clientHalf(dir)!.rev, changed);
});

test("any file of a half's folder changed, one added or one removed, is another revision of it, and not what is in node_modules or under a dot", () => {
  const dir = pkg({ client: './web/client.js', server: './server.js' }, ['server.js', 'lib/said.js', 'web/client.js', 'web/parts/part.js', 'web/node_modules/dep/index.js', 'web/.cache/x.js', 'web/.notes']);
  const revs = () => [clientHalf(dir)!.rev, serverHalf(dir)!.rev];
  let [client, server] = revs();
  const step = (file: string, change: () => void, what: string, counts: { client: boolean; server: boolean }) => {
    change();
    const [nextClient, nextServer] = revs();
    assert.equal(nextClient !== client, counts.client, `${what} (${file}): the browser half's`);
    assert.equal(nextServer !== server, counts.server, `${what} (${file}): the server half's`);
    [client, server] = [nextClient, nextServer];
  };
  const edit = (file: string) => () => writeFileSync(path.join(dir, file), `// changed ${file}, and longer`);
  step('web/parts/part.js', edit('web/parts/part.js'), 'a file the module imports', { client: true, server: true });
  step('lib/said.js', edit('lib/said.js'), "a file of the server half's folder, outside the web folder", { client: false, server: true });
  step('web/parts/more.js', edit('web/parts/more.js'), 'a file added', { client: true, server: true });
  step('web/parts/more.js', () => rmSync(path.join(dir, 'web/parts/more.js')), 'a file removed', { client: true, server: true });
  step('web/parts/part.js', () => renameSync(path.join(dir, 'web/parts/part.js'), path.join(dir, 'web/parts/moved.js')), 'a file renamed', { client: true, server: true });
  for (const file of ['web/node_modules/dep/index.js', 'web/.cache/x.js', 'web/.notes']) step(file, edit(file), 'not looked at', { client: false, server: false });
  // Nothing changed: the same.
  assert.deepEqual(revs(), [client, server]);
});

test("a folder of more files than a revision looks at: the first by their path count, and the module and its stylesheet always", () => {
  const files = Array.from({ length: 1000 }, (_, i) => `web/a/${String(i).padStart(4, '0')}.js`);
  const dir = pkg({ client: './web/z/client.js', style: './web/z/client.css' }, [...files.map((file) => file.replace('web/', 'web/z/')), 'web/z/client.js', 'web/z/client.css', 'web/z/past.js']);
  const rev = () => clientHalf(dir)!.rev;
  let before = rev();
  writeFileSync(path.join(dir, 'web/z/past.js'), '// past the thousandth file, and longer');
  assert.equal(rev(), before, 'a file past them');
  writeFileSync(path.join(dir, 'web/z/a/0999.js'), '// the thousandth, and longer');
  assert.notEqual(rev(), before, 'the last that counts');
  before = rev();
  writeFileSync(path.join(dir, 'web/z/client.js'), '// the module, past them by its path, and longer');
  assert.notEqual(rev(), before, 'the module');
  before = rev();
  writeFileSync(path.join(dir, 'web/z/client.css'), '/* the stylesheet, and longer */');
  assert.notEqual(rev(), before, 'the stylesheet');
});

test("a half whose module or stylesheet is gone by the time its revision is read has another revision, and reading it does not throw", () => {
  const dir = pkg({ client: './web/client.js', style: './web/client.css', server: './server.js' }, ['server.js', 'web/client.js', 'web/client.css']);
  const client = clientHalf(dir)!, server = serverHalf(dir)!;
  const before = [clientHalf(dir)!.rev, serverHalf(dir)!.rev];
  // Found before, read after: as a sync that waits for the one before it reads them.
  rmSync(path.join(dir, 'web/client.css'));
  rmSync(path.join(dir, 'server.js'));
  assert.notEqual(client.rev, before[0], 'the stylesheet gone');
  assert.notEqual(server.rev, before[1], 'the module gone');
  assert.equal(serverHalf(dir), undefined, 'and looked for again, the half is not there');
});

test('a package with no browser half, or one it cannot have, has none', () => {
  assert.equal(clientHalf(pkg(undefined, ['index.ts'])), undefined, 'declares none');
  assert.equal(clientHalf(pkg({ client: './web/client.js' }, ['index.ts'])), undefined, 'names a file that is not there');
  assert.equal(clientHalf(pkg({ client: './web' }, ['web/client.js'])), undefined, 'names a folder');
  assert.equal(clientHalf(pkg({ client: './web/client.js' }, ['web/client.js'], '')), undefined, 'has no name to go by');
  assert.equal(clientHalf(scratch('extension-ui-')), undefined, 'is no package');
});

test('the module is in a folder of its own: at the package\'s root the portal would serve all of the package', () => {
  assert.equal(clientHalf(pkg({ client: './client.js' }, ['client.js', 'index.ts'])), undefined);
});

test('nothing outside the package is served: a module above it is refused, a stylesheet outside the web folder is left out', () => {
  const outside = scratch('extension-ui-');
  writeFileSync(path.join(outside, 'client.js'), '// elsewhere');
  const dir = pkg({ client: path.join(outside, 'client.js') }, ['index.ts']);
  assert.equal(clientHalf(dir), undefined);
  assert.equal(clientHalf(pkg({ client: '../client.js' }, ['index.ts'])), undefined);
  const half = clientHalf(pkg({ client: './web/client.js', style: './index.css' }, ['web/client.js', 'index.css']))!;
  assert.equal(half.style, undefined);
});

test('what an extension says to its browser half reaches the portal as a session event, and only that', () => {
  const b = bus();
  const out: any[] = [];
  const off = bridgeExtensionUi(b, (event) => out.push(event));
  b.emit(UI_SEND, { extension: 'my-extension', data: { type: 'notes', notes: [1] } });
  b.emit(UI_SEND, { extension: 'my-extension' });
  b.emit(UI_SEND, { data: 'from nobody' });
  b.emit(UI_SEND, null);
  b.emit(UI_RECEIVE, { extension: 'my-extension', data: 'the other way' });
  assert.deepEqual(out, [
    { type: 'portal_extension_ui', extension: 'my-extension', data: { type: 'notes', notes: [1] } },
    { type: 'portal_extension_ui', extension: 'my-extension', data: null },
  ]);
  off();
  b.emit(UI_SEND, { extension: 'my-extension', data: 1 });
  assert.equal(out.length, 2);
});

const Nothing = () => null;

test('a slot holds what was registered in it, in order, until it is taken out', () => {
  const offs = [
    register('b-ext', 'nav.page', { id: 'late', title: 'Late', component: Nothing }),
    register('a-ext', 'nav.page', { id: 'second', title: 'Second', order: 20, component: Nothing }),
    register('a-ext', 'nav.page', { id: 'first', title: 'First', order: 10, component: Nothing }),
    register('c-ext', 'nav.page', { id: 'later', title: 'Later', component: Nothing }),
  ];
  assert.deepEqual(slotEntries('nav.page').map((e) => e.key), ['a-ext/first', 'a-ext/second', 'b-ext/late', 'c-ext/later'], 'ordered ones first, the rest as they came');
  assert.equal(slotEntries('nav.page')[0].extension, 'a-ext');
  const before = slotEntries('nav.page');
  assert.equal(slotEntries('nav.page'), before, 'the same list until it changes: it is what React compares');
  offs[1]();
  offs[1]();
  assert.deepEqual(slotEntries('nav.page').map((e) => e.key), ['a-ext/first', 'b-ext/late', 'c-ext/later']);
  assert.notEqual(slotEntries('nav.page'), before);
  assert.deepEqual(slotEntries('chat.panel'), [], 'each slot its own');
  for (const off of offs) off();
  assert.deepEqual(slotEntries('nav.page'), []);
});

test('each part an extension draws is inside an element that says whose it is, laid out as if it were not there', () => {
  const off = register('@me/panel', 'chat.panel', {
    id: 'p',
    title: 'P',
    component: ({ chat }: { chat: { id: string } }) => createElement('p', { className: 'flex' }, chat.id),
    header: () => createElement('span', null, 'Tabs'),
    actions: () => createElement('button', null, 'Go'),
  });
  try {
    const [entry] = slotEntries('chat.panel');
    const drawn = (part: unknown, props: object) => renderToStaticMarkup(createElement(part as any, props));
    assert.equal(drawn(entry.component, { chat: { id: 'c1' } }), '<div data-extension="@me/panel" style="display:contents"><p class="flex">c1</p></div>');
    assert.equal(drawn(entry.header, {}), '<div data-extension="@me/panel" style="display:contents"><span>Tabs</span></div>');
    assert.equal(drawn(entry.actions, {}), '<div data-extension="@me/panel" style="display:contents"><button>Go</button></div>');
  } finally {
    off();
  }
});

test('what cannot be drawn is refused where it is registered, with why', () => {
  assert.throws(() => register('ext', 'chat.sidebar' as any, { id: 'x', component: Nothing } as any), /no slot called "chat\.sidebar".*chat\.panel/);
  assert.throws(() => register('ext', 'chat.panel', { id: '', title: 'X', component: Nothing }), /needs an id and a component/);
  assert.throws(() => register('ext', 'chat.panel', { id: 'x', title: 'X' } as any), /needs an id and a component/);
  const off = register('ext', 'chat.panel', { id: 'x', title: 'X', component: Nothing });
  assert.throws(() => register('ext', 'chat.panel', { id: 'x', title: 'Again', component: Nothing }), /already has an entry called "x"/);
  const other = register('other', 'chat.panel', { id: 'x', title: 'Another extension\'s', component: Nothing });
  assert.equal(slotEntries('chat.panel').length, 2, 'another extension may use the same id');
  off();
  other();
});

test('an extension\'s panel counts like the portal\'s own: a third closes the one open longest', () => {
  const two = settlePanels([], ['files', 'x:notes/notes']);
  assert.deepEqual(settlePanels(two.order, ['files', 'x:notes/notes', 'git']), { order: ['x:notes/notes', 'git'], close: ['files'] });
  assert.deepEqual(settlePanels(['git', 'x:notes/notes'], ['git', 'x:notes/notes', 'files']), { order: ['x:notes/notes', 'files'], close: ['git'] });
});

/** The Notes extension's pi half, loaded into a pi that is only what it uses. */
function loadNotes(kept: any[] = []) {
  const b = bus();
  const said: any[] = [];
  b.on(UI_SEND, (message: any) => message.extension === 'pithagoras-notes' && said.push(message.data));
  const entries = [...kept];
  const on = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  let tool: any;
  notes({
    events: b,
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => on.set(event, handler),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data }),
    registerTool: (definition: unknown) => { tool = definition; },
  });
  const ctx = { sessionManager: { getBranch: () => entries } };
  const tell = (data: unknown, extension = 'pithagoras-notes') => b.emit(UI_RECEIVE, { extension, data });
  return { said, entries, tool, tell, start: () => on.get('session_start')!({}, ctx) };
}
const lastNotes = (said: any[]) => [...said].reverse().find((data) => data.type === 'notes').notes;

test('the Notes extension keeps what the agent and the person pin, tells its browser half, and keeps it with the conversation', async () => {
  const n = loadNotes();
  await n.start();
  assert.deepEqual(n.said, [{ type: 'notes', notes: [] }]);
  const result = await n.tool.execute('call-1', { text: '  Ship on Friday  ' });
  assert.match(result.content[0].text, /#1/);
  n.tell({ type: 'add', text: 'Ask about the logo' });
  n.tell({ type: 'add', text: '   ' });
  n.tell({ type: 'add', text: 'For another extension' }, 'someone-else');
  assert.deepEqual(lastNotes(n.said), [{ id: 1, text: 'Ship on Friday', by: 'agent' }, { id: 2, text: 'Ask about the logo', by: 'you' }]);
  n.tell({ type: 'remove', id: 1 });
  n.tell({ type: 'remove', id: 99 });
  assert.deepEqual(lastNotes(n.said), [{ id: 2, text: 'Ask about the logo', by: 'you' }]);
  assert.deepEqual(n.entries.at(-1), { type: 'custom', customType: 'pithagoras-notes', data: { notes: [{ id: 2, text: 'Ask about the logo', by: 'you' }] } });
  assert.equal(n.entries.length, 3, 'kept on each change, and only then');
  const before = n.said.length;
  n.tell({ type: 'ready' });
  assert.deepEqual(n.said.slice(before), [{ type: 'notes', notes: [{ id: 2, text: 'Ask about the logo', by: 'you' }] }], 'a page that opens later asks');
  await assert.rejects(n.tool.execute('call-2', { text: ' ' }), /needs some text/);
});

test('the Notes extension has its notes back when the chat is loaded again, and pins the agent\'s last reply when asked', async () => {
  const reply = (text: string) => ({ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text }] } });
  const n = loadNotes([
    { type: 'custom', customType: 'pithagoras-notes', data: { notes: [{ id: 4, text: 'From before', by: 'agent' }] } },
    { type: 'custom', customType: 'another-extension', data: { notes: [{ id: 1, text: 'Not ours', by: 'you' }] } },
    reply('First answer'),
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'thanks' }] } },
  ]);
  n.tell({ type: 'pin-last' });
  assert.deepEqual(n.said, [{ type: 'nothing-to-pin' }], 'before the chat is loaded there is no conversation to read');
  await n.start();
  assert.deepEqual(lastNotes(n.said), [{ id: 4, text: 'From before', by: 'agent' }]);
  n.tell({ type: 'pin-last' });
  assert.deepEqual(lastNotes(n.said), [{ id: 4, text: 'From before', by: 'agent' }, { id: 5, text: 'First answer', by: 'you' }]);
});

test('a package may name a server half anywhere in itself, and has none where the file is not its own', () => {
  const dir = pkg({ client: './web/client.js', server: './server.js' }, ['web/client.js', 'server.js']);
  const half = serverHalf(dir)!;
  assert.deepEqual({ name: half.name, version: half.version, file: half.file }, { name: 'my-extension', version: '1.2.3', file: path.join(dir, 'server.js') });
  assert.match(half.rev, /^[\w-]{16}$/);
  assert.equal(serverHalf(pkg({ client: './web/client.js' }, ['web/client.js'])), undefined, 'declares none');
  assert.equal(serverHalf(pkg({ server: './server.js' }, [])), undefined, 'names a file that is not there');
  assert.equal(serverHalf(pkg({ server: '../server.js' }, [])), undefined, 'names a file above it');
  assert.ok(serverHalf(pkg({ server: './lib/server.js' }, ['lib/server.js'])), 'a server half alone, with no browser half');
});

test('a server half says what it builds on, by name and version range, and what is not that is not read', () => {
  const builds = serverHalf(pkg({ server: './server.js', requires: { 'pithagoras-docker': '^1.0.0', '../up': '*', bad: 2 }, optional: { '@a/b': '>=0.2' } }, ['server.js']))!;
  assert.deepEqual(builds.requires, { 'pithagoras-docker': '^1.0.0' });
  assert.deepEqual(builds.optional, { '@a/b': '>=0.2' });
  const none = serverHalf(pkg({ server: './server.js', requires: ['pithagoras-docker'] }, ['server.js']))!;
  assert.equal(none.requires, undefined, 'a list says no versions: not read');
  assert.equal(none.optional, undefined);
});

test('a package goes by a name its addresses can carry, and has no halves under any other', () => {
  for (const name of ['notes', 'pithagoras-notes', '@codacus/notes', 'a.b_c~d', '@a/b.c']) assert.equal(validName(name), true, name);
  for (const name of ['', '..', '.hidden', 'a/b', '@a/b/c', '@a/..', 'a b', 'a?b', '../up', '@/x', 42, undefined]) assert.equal(validName(name), false, String(name));
  assert.equal(clientHalf(pkg({ client: './web/client.js' }, ['web/client.js'], 'my ext')), undefined);
  assert.equal(serverHalf(pkg({ server: './server.js' }, ['server.js'], '../other')), undefined);
});

test('a command is asked for by its name, by whoever knows it, until it is taken back', () => {
  const off = registerCommand('my-files.reveal', (path: string, line = 1) => `${path}:${line}`);
  assert.equal(hasCommand('my-files.reveal'), true);
  assert.equal(runCommand('my-files.reveal', 'src/a.ts', 7), 'src/a.ts:7');
  assert.throws(() => registerCommand('my-files.reveal', () => 0), /already a command called "my-files\.reveal"/);
  assert.throws(() => registerCommand('', () => 0), /needs a name/);
  off();
  off();
  assert.equal(hasCommand('my-files.reveal'), false);
  assert.throws(() => runCommand('my-files.reveal'), /no command called "my-files\.reveal"/);
});

test('an extension\'s texts are its own in each language, beside the portal\'s and not in place of them', () => {
  addLocale({ code: 'xx', name: 'Test', strings: { Remove: 'Weg', 'Hello {name}': 'Portal says hallo {name}' } });
  const offNotes = addStrings('notes', 'xx', { Notes: 'Notizen', 'Hello {name}': 'Hallo {name}' });
  addStrings('other', 'xx', { Notes: 'Zettel' });
  try {
    setLanguage('en');
    assert.equal(translate('notes', 'Notes'), 'Notes', 'English is what the code says');
    setLanguage('xx');
    assert.equal(translate('notes', 'Notes'), 'Notizen');
    assert.equal(translate('other', 'Notes'), 'Zettel', 'each extension its own');
    assert.equal(translate('notes', 'Hello {name}', { name: 'Ada' }), 'Hallo Ada', 'its own before the portal\'s');
    assert.equal(translate('notes', 'Remove'), 'Weg', 'the portal\'s where it has none');
    assert.equal(translate('notes', 'Never said'), 'Never said');
    offNotes();
    assert.equal(translate('notes', 'Notes'), 'Notes');
    forgetStrings('other');
    assert.equal(translate('other', 'Notes'), 'Notes');
  } finally {
    setLanguage('system');
  }
});

test('an extension\'s counts, texts told apart by what they are, and texts with parts drawn in, are its own before the portal\'s', () => {
  addLocale({ code: 'xx', name: 'Test', strings: { '{n} files': { one: '{n} Portal-Datei', other: '{n} Portal-Dateien' }, 'Open\u0004state': 'Offen (Portal)' } });
  const off = addStrings('git', 'xx', {
    '{n} commits': { one: '{n} Eintrag', other: '{n} Einträge' },
    'Open\u0004state': 'Offen',
    'Pushed to {branch}': 'Nach {branch} geschoben',
  });
  try {
    setLanguage('en');
    assert.equal(translateCount('git', 1, '{n} commit', '{n} commits'), '1 commit');
    assert.equal(translateCount('git', 3, '{n} commit', '{n} commits'), '3 commits');
    setLanguage('xx');
    assert.equal(translateCount('git', 1, '{n} commit', '{n} commits'), '1 Eintrag');
    assert.equal(translateCount('git', 3, '{n} commit', '{n} commits'), '3 Einträge');
    assert.equal(translateCount('git', 2, '{n} file', '{n} files'), '2 Portal-Dateien', 'the portal\'s where it has none');
    assert.equal(translateInContext('git', 'Open', 'state'), 'Offen');
    assert.equal(translateInContext('notes', 'Open', 'state'), 'Offen (Portal)');
    assert.equal(translateInContext('git', 'Open', 'button'), 'Open');
    const drawn = translateWithParts('git', 'Pushed to {branch}', { branch: createElement('b', null, 'main') });
    assert.equal(renderToStaticMarkup(createElement(Fragment, null, drawn)), 'Nach <b>main</b> geschoben');
  } finally {
    off();
    setLanguage('system');
  }
});

test('what a server half says waits for a module that is not in the page yet, and is handed over in order once it is', () => {
  const got: unknown[][] = [];
  // The page's stream opened first: where things stand, and a change, before the module was called.
  serverPush('a', 'late', { type: 'state', n: 0 });
  serverPush('b', 'late', { type: 'state', n: 5 });
  serverPush('a', 'never-installed', 'dropped');
  const off = onServerPush('late', (chatId, data) => got.push([chatId, data]));
  assert.deepEqual(got, [], 'nothing until its module has been called');
  onlyWaitFor(['late']);
  extensionHere('late');
  serverPush('a', 'late', { type: 'changed', n: 1 });
  assert.deepEqual(got, [['a', { type: 'state', n: 0 }], ['b', { type: 'state', n: 5 }], ['a', { type: 'changed', n: 1 }]]);
  // Nothing was kept for one that has no browser half.
  const other: unknown[] = [];
  onServerPush('never-installed', (_chat, data) => other.push(data));
  extensionHere('never-installed');
  assert.deepEqual(other, []);
  off();
  serverPush('a', 'late', 'after it stopped listening');
  assert.equal(got.length, 3);
  extensionGone('late');
  extensionGone('never-installed');
});

test('the panels of the chat on screen are opened by name from anywhere, an extension\'s own by its ids', () => {
  assert.equal(panels.isOpen('files'), false, 'with no chat on screen nothing is open');
  assert.throws(() => panels.open('files'), /No chat is on screen/);
  const calls: unknown[][] = [];
  setPanelController({ isOpen: (key) => key === 'terminal', open: (key, params) => calls.push(['open', key, params]), close: (key) => calls.push(['close', key]) });
  panels.open('files', { path: 'src/a.ts' });
  const own = panelsFor('my-extension');
  assert.equal(own, panelsFor('my-extension'), 'the same object each time');
  own.open('notes', { draft: 'x' });
  own.close('notes');
  assert.equal(panels.isOpen('terminal'), true);
  assert.equal(own.isOpen('notes'), false);
  assert.deepEqual(calls, [['open', 'files', { path: 'src/a.ts' }], ['open', 'my-extension/notes', { draft: 'x' }], ['close', 'my-extension/notes']]);
  setPanelController(undefined);
});

test('a chat is said as the page has it, to whoever listens to that chat', () => {
  const heard: number[] = [];
  const off = onChatFeed('a', (feed) => heard.push(feed.events.length));
  assert.equal(chatFeed('a').loading, true, 'before the chat has said anything it is being fetched');
  publishChat('a', { events: [{ seq: 1, type: 'agent_start', payload: {} }], items: [], running: true, loading: false });
  publishChat('b', { events: [], items: [], running: false, loading: false });
  assert.deepEqual(heard, [1], 'another chat is not this one\'s');
  assert.equal(chatFeed('a').running, true);
  off();
  publishChat('a', { events: [], items: [], running: false, loading: false });
  assert.deepEqual(heard, [1]);
  forgetChatFeed('a');
  forgetChatFeed('b');
  assert.equal(chatFeed('a').loading, true);
});

test('a window an extension brought to voice mode is placed as the pictures are: at the side, or in the middle when the side is taken', () => {
  assert.deepEqual(placeWindows({ 'x:notes/notes': true }), { main: undefined, side: 'x:notes/notes' });
  assert.deepEqual(placeWindows({ conversation: true, 'x:notes/notes': true }), { main: 'x:notes/notes', side: 'conversation' });
  assert.deepEqual(placeWindows({ 'x:b/b': true, 'x:notes/notes': true }, { 'x:b/b': 'middle' }), { main: 'x:b/b', side: 'x:notes/notes' });
  assert.deepEqual(placeWindows({ pictures: true, 'x:notes/notes': true }), { main: 'x:notes/notes', side: 'pictures' }, 'after the portal\'s own');
  assert.deepEqual(placeWindows({ pictures: true, 'x:notes/notes': false }), { main: undefined, side: 'pictures' });
});

test('the Notes extension\'s server half keeps each chat\'s notes in the chat\'s folder, answers for all chats, and tells a page how many', () => {
  const folders = { a: scratch('notes-a-'), b: scratch('notes-b-') } as Record<string, string>;
  const sent: unknown[][] = [];
  const routes = new Map<string, (req: unknown, res: { json(body: unknown): void }) => void>();
  let onEvent: (chatId: string, event: any) => void = () => {};
  let onOpen: (chatId: string) => unknown = () => undefined;
  const life = new Map<string, (chatId: string) => void>();
  notesServer({
    extension: 'pithagoras-notes',
    router: { get: (route: string, handler: any) => routes.set(route, handler) },
    files: { inside: (base: string, rel: string) => path.join(base, rel) },
    chats: {
      folder: (id: string) => {
        if (!folders[id]) throw new Error('No such chat');
        return folders[id];
      },
      list: () => Object.keys(folders).map((id) => ({ id, title: `Chat ${id}` })),
      send: (chatId: string, data: unknown) => sent.push([chatId, data]),
      onEvent: (handler: typeof onEvent) => { onEvent = handler; },
      onOpen: (handler: typeof onOpen) => { onOpen = handler; },
      on: (event: string, handler: (chatId: string) => void) => life.set(event, handler),
    },
  });
  const all = () => {
    let body: any;
    routes.get('/notes')!({}, { json: (b) => { body = b; } });
    return body.chats;
  };
  const says = (chatId: string, list: unknown[], extension = 'pithagoras-notes') => onEvent(chatId, { type: 'portal_extension_ui', extension, data: { type: 'notes', notes: list } });
  assert.deepEqual(all(), []);
  assert.deepEqual(onOpen('a'), { type: 'count', count: 0 });

  says('a', [{ id: 1, text: 'Ship on Friday', by: 'agent' }]);
  says('a', [{ id: 9, text: 'Another extension\'s', by: 'you' }], 'someone-else');
  onEvent('a', { type: 'message_update' });
  const file = path.join(folders.a, '.pithagoras-notes', 'a.json');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [{ id: 1, text: 'Ship on Friday', by: 'agent' }], 'in the folder the chat works in');
  assert.deepEqual(sent, [['a', { type: 'count', count: 1 }]]);
  assert.deepEqual(onOpen('a'), { type: 'count', count: 1 });
  assert.deepEqual(all(), [{ id: 'a', title: 'Chat a', notes: [{ id: 1, text: 'Ship on Friday', by: 'agent' }] }], 'only chats that have notes');

  // The last note taken off: nothing is left behind in the folder.
  says('a', []);
  assert.equal(existsSync(file), false);
  // A chat deleted takes its notes' file with it, though it no longer says where it worked.
  says('b', [{ id: 1, text: 'Mine', by: 'you' }]);
  const kept = path.join(folders.b, '.pithagoras-notes', 'b.json');
  assert.equal(existsSync(kept), true);
  delete folders.b;
  life.get('deleted')!('b');
  assert.equal(existsSync(kept), false);
});

test('a colour is written as the portal\'s variables hold one, or as hex, and nothing else is a colour', () => {
  assert.equal(toTriplet('34 211 238'), '34 211 238');
  assert.equal(toTriplet('#22d3ee'), '34 211 238');
  assert.equal(toTriplet('#FFF'), '255 255 255');
  assert.equal(toTriplet(' #1b1626 '), '27 22 38');
  for (const not of ['', 'red', 'rgb(1,2,3)', '256 0 0', '1 2', '#12345', '#gggggg', 'var(--x)', '0 0 0; color: red', 12, null, undefined]) assert.equal(toTriplet(not), null, String(not));
  assert.deepEqual(coloursOf({ accent: '#ff79c6', 'fg-muted': '196 188 214' }), { accent: '255 121 198', 'fg-muted': '196 188 214' });
  assert.deepEqual(coloursOf(undefined), {}, 'a mode it does not speak of');
  assert.equal(coloursOf({ accent: 'pink' }), null);
  assert.equal(coloursOf({ background: '#000000' }), null, 'a name the portal has no colour under');
  assert.equal(coloursOf(['#000']), null);
  assert.ok(TOKENS.includes('terminal') && TOKENS.includes('accent-fg'));
});

test('a theme is one an extension registered, chosen by its id and painted over the portal\'s own colours', () => {
  // The page, as far as a theme reaches into it: the root's mode and the variables set on it.
  const set = new Map<string, string>();
  const root = { dataset: { theme: 'dark' } as Record<string, string>, classList: { add() {}, remove() {} }, style: { setProperty: (k: string, v: string) => set.set(k, v), removeProperty: (k: string) => set.delete(k) } };
  const kept = new Map<string, string>();
  Object.assign(globalThis, {
    document: { documentElement: root, querySelector: () => null },
    window: { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), setTimeout: () => 0 },
    getComputedStyle: () => ({ getPropertyValue: () => '10 10 12' }),
    localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => kept.set(k, v), removeItem: (k: string) => kept.delete(k) },
  });
  try {
    assert.throws(() => registerTheme('dusk-pkg', { id: '', name: 'Dusk', dark: { accent: '#ff79c6' } }), /needs an id and a name/);
    assert.throws(() => registerTheme('dusk-pkg', { id: 'dusk', name: 'Dusk', dark: { accent: 'pink' } }), /not "#rrggbb" or three numbers/);
    assert.throws(() => registerTheme('dusk-pkg', { id: 'dusk', name: 'Dusk', dark: { background: '#000000' } }), /no name for/);
    assert.throws(() => registerTheme('dusk-pkg', { id: 'dusk', name: 'Dusk' }), /sets no colours/);
    const off = registerTheme('dusk-pkg', { id: 'dusk', name: 'Dusk', dark: { accent: '#ff79c6', canvas: '27 22 38' }, light: { accent: '#a83282' } });
    assert.throws(() => registerTheme('dusk-pkg', { id: 'dusk', name: 'Again', dark: { accent: '#000000' } }), /already has a theme called "dusk"/);
    assert.deepEqual(themes().map((t) => [t.id, t.name, t.extension]), [['dusk-pkg/dusk', 'Dusk', 'dusk-pkg']]);

    assert.throws(() => choose('dusk-pkg/none'), /no theme called "dusk-pkg\/none"/);
    choose('dusk-pkg/dusk');
    assert.equal(chosenPalette()?.id, 'dusk-pkg/dusk');
    assert.deepEqual(Object.fromEntries(set), { '--accent': '255 121 198', '--canvas': '27 22 38' }, 'the dark colours, in dark');
    assert.deepEqual(JSON.parse(kept.get('pithagoras.palette')!).light, { accent: '168 50 130' }, 'kept whole in the browser, to be painted before anything is loaded');
    // In light, its light colours, and the portal's own for what it does not say.
    kept.set('pithagoras.theme', 'light');
    choosePalette(chosenPalette());
    assert.equal(root.dataset.theme, 'light');
    assert.deepEqual(Object.fromEntries(set), { '--accent': '168 50 130' });
    kept.set('pithagoras.theme', 'dark');

    // The extension updated: the same theme with other colours is painted as it is now.
    off();
    themesSettled();
    assert.equal(chosenPalette(), null, 'its extension gone, the portal\'s own colours are back');
    assert.deepEqual(Object.fromEntries(set), {});
    assert.equal(kept.has('pithagoras.palette'), false);

    const again = registerTheme('dusk-pkg', { id: 'dusk', name: 'Dusk', dark: { accent: '#ff79c6' } });
    choose('dusk-pkg/dusk');
    themesSettled();
    assert.equal(chosenPalette()?.id, 'dusk-pkg/dusk', 'still there: it stays');
    // Its extension is installed and could not be loaded this time: the person's choice is not undone for that.
    again();
    themesSettled(['dusk-pkg']);
    assert.equal(chosenPalette()?.id, 'dusk-pkg/dusk');
    assert.deepEqual(Object.fromEntries(set), { '--accent': '255 121 198' }, 'as it was painted');
    themesSettled(['dusk']);
    assert.equal(chosenPalette(), null, 'another package whose name only starts the same is not its own');
    registerTheme('dusk-pkg', { id: 'dusk', name: 'Dusk', dark: { accent: '#ff79c6' } });
    choose('dusk-pkg/dusk');
    choose(null);
    assert.equal(chosenPalette(), null);

    // Two extensions with themes, under the same id even: each its own, both offered, and one in effect at a time.
    registerTheme('other-pkg', { id: 'dusk', name: 'Other dusk', dark: { canvas: '#101820' } });
    registerTheme('other-pkg', { id: 'noon', name: 'Noon', light: { accent: '#0055aa' } });
    assert.deepEqual(themes().map((t) => t.id), ['dusk-pkg/dusk', 'other-pkg/dusk', 'other-pkg/noon']);
    choose('dusk-pkg/dusk');
    assert.deepEqual(Object.fromEntries(set), { '--accent': '255 121 198' });
    // The other chosen: it replaces the first whole. What it does not say is the portal's own, not what the first had.
    choose('other-pkg/dusk');
    assert.deepEqual(Object.fromEntries(set), { '--canvas': '16 24 32' });
    assert.equal(chosenPalette()?.name, 'Other dusk');
    choose(null);
  } finally {
    for (const name of ['document', 'window', 'getComputedStyle', 'localStorage']) delete (globalThis as any)[name];
  }
});

test('a theme chosen before Dusk and Warm moved into the themes package is still chosen, under its new id', () => {
  const kept = new Map<string, string>();
  const root = { dataset: { theme: 'dark' } as Record<string, string>, classList: { add() {}, remove() {} }, style: { setProperty() {}, removeProperty() {} } };
  Object.assign(globalThis, {
    document: { documentElement: root, querySelector: () => null },
    window: { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), setTimeout: () => 0 },
    getComputedStyle: () => ({ getPropertyValue: () => '10 10 12' }),
    localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => kept.set(k, v), removeItem: (k: string) => kept.delete(k) },
  });
  try {
    assert.equal(themeIdNow('pithagoras-theme-dusk/dusk'), 'pithagoras-themes/dusk');
    assert.equal(themeIdNow('pithagoras-theme-warm/warm'), 'pithagoras-themes/warm');
    for (const same of ['pithagoras-themes/forest', 'my-pkg/dusk', 'constructor', '']) assert.equal(themeIdNow(same), same);

    // What a browser kept before: the old id, with the colours it was chosen with.
    const warm = { id: 'pithagoras-theme-warm/warm', name: 'Warm', light: { accent: '168 68 28' }, dark: { accent: '217 119 87' } };
    kept.set('pithagoras.palette', JSON.stringify(warm));
    assert.deepEqual(storedPalette(), { ...warm, id: 'pithagoras-themes/warm' });
    assert.equal(JSON.parse(kept.get('pithagoras.palette')!).id, 'pithagoras-themes/warm', 'kept under the new id from then on');
    kept.set('pithagoras.palette', JSON.stringify({ ...warm, id: 'my-pkg/warm' }));
    assert.equal(storedPalette()?.id, 'my-pkg/warm', 'a theme of another package is left as it is');

    // And an extension that still switches to it by the old id gets it.
    const off = registerTheme('pithagoras-themes', { id: 'dusk', name: 'Dusk', dark: { accent: '#ff79c6' } });
    try {
      choose('pithagoras-theme-dusk/dusk');
      assert.equal(chosenPalette()?.id, 'pithagoras-themes/dusk');
      assert.throws(() => choose('pithagoras-theme-warm/warm'), /no theme called "pithagoras-theme-warm\/warm"/);
    } finally {
      choose(null);
      off();
    }
  } finally {
    for (const name of ['document', 'window', 'getComputedStyle', 'localStorage']) delete (globalThis as any)[name];
  }
});

test('a package may name themes in its package.json and bring nothing else', () => {
  const dir = pkg({ themes: [{ id: 'dusk', name: 'Dusk', dark: { accent: '#ff79c6' }, light: 'not colours' }, { id: 'nameless' }, 'not a theme'] }, []);
  assert.deepEqual(packageThemes(dir), { name: 'my-extension', version: '1.2.3', themes: [{ id: 'dusk', name: 'Dusk', dark: { accent: '#ff79c6' } }] });
  assert.equal(clientHalf(dir), undefined);
  assert.equal(serverHalf(dir), undefined);
  assert.equal(packageThemes(pkg({ themes: [] }, [])), undefined);
  assert.equal(packageThemes(pkg({ client: './web/client.js' }, ['web/client.js'])), undefined);
  // The one shipped as the example is one the page takes whole.
  const shipped = packageThemes(path.resolve('extensions/themes'))!;
  assert.equal(shipped.name, 'pithagoras-themes');
  for (const theme of shipped.themes) {
    assert.ok(coloursOf(theme.dark) && coloursOf(theme.light), theme.id);
    assert.deepEqual(Object.keys(theme.dark!).sort(), [...TOKENS].sort(), 'every colour of the portal\'s, in dark');
  }
});

test('a package is told apart by what it brings: something for pi, something for the portal, colours', () => {
  assert.deepEqual(packageKinds(path.resolve('tests/fixtures/extensions/notes')), ['pi', 'pithagoras']);
  assert.deepEqual(packageKinds(path.resolve('extensions/themes')), ['themes'], 'no code, so nothing for pi');
  // Its tool comes through its server half: it gives pi nothing of its own.
  assert.deepEqual(packageKinds(path.resolve('extensions/subagent')), ['pithagoras']);
  assert.deepEqual(packageKinds(pkg({ server: './server.js', themes: [{ id: 'a', name: 'A' }] }, ['server.js'])), ['pi', 'pithagoras', 'themes']);
  // A half it names and does not have is not one it brings.
  assert.deepEqual(packageKinds(pkg({ client: './web/client.js' }, [])), ['pi']);
  // Without a `pi` key, pi looks in the folders it knows; with one, only at what the key names.
  const folders = scratch('extension-kinds-');
  mkdirSync(path.join(folders, 'skills'));
  assert.deepEqual(packageKinds(folders), ['pi'], 'no package.json at all');
  writeFileSync(path.join(folders, 'package.json'), JSON.stringify({ name: 'by-folders' }));
  assert.deepEqual(packageKinds(folders), ['pi']);
  writeFileSync(path.join(folders, 'package.json'), JSON.stringify({ name: 'by-key', pi: {} }));
  assert.deepEqual(packageKinds(folders), [], 'a key that names nothing');
  assert.deepEqual(packageKinds(scratch('extension-kinds-')), []);
});

test('an action on a call\'s card names its tool by a name or a pattern, and a shortcut\'s default is a key: anything else is refused where it is registered', async () => {
  // The shortcuts are listed on the page's window, which tells Settings when one comes or goes.
  (globalThis as any).window ??= new EventTarget();
  const { registerShortcut } = await import('../core/web/src/extensions/shortcuts.ts');
  const component = () => null;
  for (const tool of [null, ['bash'], 3, {}]) {
    assert.throws(() => register('probe', 'chat.tool.action', { id: `bad-${JSON.stringify(tool)}`, tool, component } as any), /a name or a pattern/, JSON.stringify(tool));
  }
  for (const tool of [undefined, 'bash', /^sh/]) register('probe', 'chat.tool.action', { id: `good-${String(tool)}`, tool, component } as any)();
  const run = () => {};
  assert.throws(() => registerShortcut('probe', { id: 'tab', label: 'Tab', scope: 'voice', default: { code: 'Tab' }, run }), /a key/);
  assert.throws(() => registerShortcut('probe', { id: 'text', label: 'Text', scope: 'voice', default: 'KeyN' as any, run }), /a key/);
  assert.throws(() => registerShortcut('probe', { id: 'chat', label: 'Chat', scope: 'chat' as any, default: null, run }), /scope/);
  registerShortcut('probe', { id: 'none', label: 'None', scope: 'voice', default: null, run })();
});

test('what two extensions both want goes by their places in the list of extensions, not by whose module came into the page first', async () => {
  (globalThis as any).window ??= new EventTarget();
  const { registerShortcut } = await import('../core/web/src/extensions/shortcuts.ts');
  const { resolve } = await import('../core/web/src/keybindings.ts');
  const run = () => {};
  const component = () => null;
  const key = { code: 'KeyQ' };
  const keys = () => resolve({});
  // The server lists a before b. b's module is the quicker one, as it may be on any load.
  rankExtensions(['rank-a', 'rank-b']);
  for (const [first, second] of [['rank-b', 'rank-a'], ['rank-a', 'rank-b']]) {
    const off = [
      registerShortcut(first, { id: 'q', label: 'Q', scope: 'voice', default: key, run }),
      registerShortcut(second, { id: 'q', label: 'Q', scope: 'voice', default: key, run }),
      register(first, 'nav.page', { id: 'p', title: first, component }),
      register(second, 'nav.page', { id: 'p', title: second, component }),
      registerTheme(first, { id: 't', name: first, dark: { accent: '#ff0000' } }),
      registerTheme(second, { id: 't', name: second, dark: { accent: '#00ff00' } }),
      registerCommand('rank.open', () => first, first),
      registerCommand('rank.open', () => second, second),
    ];
    const says = `${first} loaded first`;
    assert.deepEqual(Object.fromEntries(['rank-a', 'rank-b'].map((name) => [name, keys()[`x:${name}/q`]?.code ?? null])), { 'rank-a': 'KeyQ', 'rank-b': null }, says);
    assert.deepEqual(slotEntries('nav.page').filter((e) => e.extension.startsWith('rank-')).map((e) => e.extension), ['rank-a', 'rank-b'], says);
    assert.deepEqual(themes().filter((t) => t.extension.startsWith('rank-')).map((t) => t.extension), ['rank-a', 'rank-b'], says);
    assert.equal(runCommand('rank.open'), 'rank-a', says);
    // The one that answers is taken out: the other does.
    off[6]!() ;
    off[7]!();
    off.slice(0, 6).forEach((f) => f());
  }
  // The list changes after both are in: what they hold is put in its order again.
  const offs = [
    registerShortcut('rank-b', { id: 'q', label: 'Q', scope: 'voice', default: key, run }),
    registerShortcut('rank-a', { id: 'q', label: 'Q', scope: 'voice', default: key, run }),
    registerCommand('rank.open', () => 'b', 'rank-b'),
    registerCommand('rank.open', () => 'a', 'rank-a'),
  ];
  assert.equal(runCommand('rank.open'), 'a');
  rankExtensions(['rank-b', 'rank-a']);
  assert.equal(keys()['x:rank-b/q']?.code, 'KeyQ');
  assert.equal(keys()['x:rank-a/q'], null);
  assert.equal(runCommand('rank.open'), 'b');
  // One extension saying a name twice is its own mistake, and refused.
  assert.throws(() => registerCommand('rank.open', () => 0, 'rank-a'), /already a command called "rank\.open"/);
  offs.forEach((f) => f());
  assert.equal(hasCommand('rank.open'), false);
  rankExtensions([]);
});

test('a window an extension brought that asks for a place has it before those that take what is left, and the other place when it is taken', () => {
  assert.deepEqual(placeWindows({ 'x:a/w': true }, { 'x:a/w': 'middle' }), { main: 'x:a/w', side: undefined });
  assert.deepEqual(placeWindows({ 'x:a/w': true, pictures: true }, { 'x:a/w': 'middle' }), { main: 'x:a/w', side: 'pictures' });
  assert.deepEqual(placeWindows({ conversation: true, 'x:a/w': true }, { 'x:a/w': 'side' }), { main: 'conversation', side: 'x:a/w' });
  // One that asked for the middle before it has it: it is given the other.
  assert.deepEqual(placeWindows({ 'x:b/b': true, 'x:a/w': true }, { 'x:b/b': 'middle', 'x:a/w': 'middle' }), { main: 'x:b/b', side: 'x:a/w' });
  assert.deepEqual(placeWindows({ 'x:t/t': true, 'x:a/w': true }, { 'x:t/t': 'side', 'x:a/w': 'side' }), { main: 'x:a/w', side: 'x:t/t' });
  // Without a place it is placed as before, after the portal's own.
  assert.deepEqual(placeWindows({ conversation: true, 'x:a/w': true }), { main: 'x:a/w', side: 'conversation' });
});

const feedOf = (n: number) => ({ events: Array.from({ length: n }, (_, i) => ({ seq: i + 1, type: 'x', payload: {} })), items: [], running: false, loading: false });
const quiet = async (work: () => void) => {
  const said = console.error;
  console.error = () => {};
  try {
    work();
  } finally {
    console.error = said;
  }
};

test('an extension that fails on hearing a chat, or its server half, fails alone: the chat and the others go on', async () => {
  const heard: string[] = [];
  const offBad = onChatFeed('a', () => { throw new Error('its own failure'); });
  const offGood = onChatFeed('a', (feed) => heard.push(`chat ${feed.events.length}`));
  await quiet(() => publishChat('a', feedOf(2)));
  assert.deepEqual(heard, ['chat 2'], 'said to the rest, and nothing thrown at the chat that said it');

  onServerPush('fragile', () => { throw new Error('its own failure'); });
  onServerPush('fragile', (chatId, data) => heard.push(`push ${chatId} ${data}`));
  serverPush('a', 'fragile', 'waited');
  await quiet(() => extensionHere('fragile'));
  await quiet(() => serverPush('a', 'fragile', 'live'));
  assert.deepEqual(heard.slice(1), ['push a waited', 'push a live'], 'what waited is handed over whole, and what comes after is heard');
  offBad();
  offGood();
  extensionGone('fragile');
  forgetChatFeed('a');
});

test('to stop listening twice, or after the chat was left and come back to, takes nothing from whoever listens now', () => {
  const heard: string[] = [];
  const first = onChatFeed('a', () => heard.push('first'));
  first();
  // The chat was left with nobody listening, and is listened to again: by another.
  const second = onChatFeed('a', () => heard.push('second'));
  first();
  publishChat('a', feedOf(1));
  assert.deepEqual(heard, ['second']);
  second();
  forgetChatFeed('a');
  // The chat whose stream the page has open, for a browser half that comes later.
  assert.equal(chatOnScreen(), undefined);
  setChatOnScreen('a');
  assert.equal(chatOnScreen(), 'a');
  setChatOnScreen(undefined);
});

test('what a component picked is the same when it holds the same: a list or a plain object by what is in it, anything else only itself', () => {
  const item = { id: 1 };
  assert.equal(sameValue([item, 2], [item, 2]), true);
  assert.equal(sameValue({ any: true, n: 2 }, { any: true, n: 2 }), true);
  assert.equal(sameValue([item], [{ id: 1 }]), false, 'one level: what is in it is compared as it is');
  assert.equal(sameValue([1, 2], [1, 2, 3]), false);
  assert.equal(sameValue([1], { 0: 1 }), false);
  assert.equal(sameValue(new Set([1]), new Set([2])), false, 'a Set holds what its keys do not show');
  assert.equal(sameValue(new Map([[1, 1]]), new Map()), false);
  assert.equal(sameValue(new Date(1), new Date(2)), false);
  const set = new Set([1]);
  assert.equal(sameValue(set, set), true);
  assert.equal(sameValue(3, 3), true);
  assert.equal(sameValue(null, {}), false);
});
