import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bridgeExtensionUi, clientHalf, UI_RECEIVE, UI_SEND } from '../server/src/extension-ui.ts';
import { register, slotEntries } from '../web/src/extensions/slots.ts';
import { settlePanels } from '../web/src/use-work-panels.ts';
import notes from '../extensions/notes/index.ts';
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
  assert.match(half.rev, /^[0-9a-z]+-[0-9a-z]+$/);
});

test('a module changed is a module under another revision', () => {
  const dir = pkg({ client: './web/client.js' }, ['web/client.js']);
  const before = clientHalf(dir)!.rev;
  writeFileSync(path.join(dir, 'web', 'client.js'), '// here, and longer than it was');
  assert.notEqual(clientHalf(dir)!.rev, before);
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
  assert.deepEqual(settlePanels(['git', 'x:notes/notes'], ['git', 'x:notes/notes', 'terminal']), { order: ['x:notes/notes', 'terminal'], close: ['git'] });
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
