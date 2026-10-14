import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The store is the browser's; a Map stands in for it.
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
(globalThis as any).window = Object.assign(new EventTarget(), { localStorage: (globalThis as any).localStorage });
const { ACTIONS, actions, addAction, resolve, assign, setBinding, resetBinding, resetAll, matches, bindingOf, bindingFrom, defaults, describe, keyName } = await import('../core/web/src/keybindings.js');

beforeEach(() => store.clear());

test('every action has a default, and no two defaults are the same key', () => {
  const seen = new Set<string>();
  for (const action of ACTIONS) {
    assert.ok(action.default, action.id);
    const key = describe(action.default, null, false);
    assert.ok(!seen.has(key), `${key} twice`);
    seen.add(key);
  }
});

test('a key event is a shortcut by physical key and modifiers; a lone modifier is none', () => {
  assert.deepEqual(bindingOf({ code: 'KeyV', altKey: true }), { code: 'KeyV', alt: true });
  assert.equal(bindingOf({ code: 'ShiftLeft', shiftKey: true }), undefined);
  assert.equal(matches({ code: 'KeyM' }, { code: 'KeyM' }), true);
  assert.equal(matches({ code: 'KeyM' }, { code: 'KeyM', shiftKey: true }), false);
  assert.equal(matches({ code: 'KeyM', shift: true }, { code: 'KeyM', shiftKey: true }), true);
  // A held key comes up after its modifiers may have.
  assert.equal(matches({ code: 'Space', ctrl: true }, { code: 'Space', type: 'keyup' }), true);
  assert.equal(matches(null, { code: 'KeyM' }), false);
});

test('a chosen shortcut is kept, and one already in use moves over from its action', () => {
  const took = setBinding('voice.mute', { code: 'KeyR' });
  assert.equal(took, 'voice.repeat');
  const now = resolve();
  assert.deepEqual(now['voice.mute'], { code: 'KeyR' });
  assert.equal(now['voice.repeat'], null);
  // Only what differs from the defaults is stored.
  assert.deepEqual(JSON.parse(store.get('keybindings')!), { 'voice.mute': { code: 'KeyR' }, 'voice.repeat': null });
  resetBinding('voice.mute');
  assert.deepEqual(resolve()['voice.mute'], { code: 'KeyM' });
  resetAll();
  assert.deepEqual(resolve()['voice.repeat'], { code: 'KeyR' });
});

test('none is a choice of its own, and junk in the store is ignored', () => {
  setBinding('voice.stop', null);
  assert.equal(resolve()['voice.stop'], null);
  store.set('keybindings', '{"voice.mute":{"nope":1},"voice.hold":"x","other":{"code":"KeyQ"}');
  assert.deepEqual(resolve()['voice.mute'], { code: 'KeyM' });
  store.set('keybindings', '{"voice.mute":{"nope":1},"voice.hold":"x","other":{"code":"KeyQ"}}');
  assert.deepEqual(resolve()['voice.hold'], { code: 'Space' });
  assert.deepEqual(assign('voice.mute', { code: 'KeyM' }, {}).choice, {});
});

test('shortcuts are written the way this computer and keyboard name them', () => {
  assert.equal(describe({ code: 'KeyV', alt: true }, null, false), 'Alt+V');
  assert.equal(describe({ code: 'KeyV', alt: true }, null, true), '⌥V');
  assert.equal(describe({ code: 'KeyM', shift: true, ctrl: true }, null, false), 'Ctrl+Shift+M');
  assert.equal(keyName('Escape'), 'Esc');
  assert.equal(keyName('Space', new Map([['Space', ' ']])), 'Space');
  // On a German keyboard the key right of L types "ö", and US "Y" is "Z".
  assert.equal(keyName('Semicolon', new Map([['Semicolon', 'ö']])), 'Ö');
  assert.equal(keyName('KeyY', new Map([['KeyY', 'z']])), 'Z');
  assert.equal(keyName('Period'), '.');
});

test('Tab is how the keyboard moves on, so no shortcut can take it, stored by an older version or not', () => {
  assert.equal(setBinding('voice.toggle', { code: 'Tab' }), undefined);
  assert.equal(setBinding('voice.mute', { code: 'Tab', shift: true }), undefined);
  assert.deepEqual(resolve()['voice.mute'], { code: 'KeyM' });
  assert.equal(store.get('keybindings') ?? '{}', '{}');
  store.set('keybindings', '{"voice.mute":{"code":"Tab"},"voice.repeat":{"code":"Tab","shift":true},"voice.hold":{"code":"Tab","ctrl":true}}');
  assert.deepEqual(resolve()['voice.mute'], { code: 'KeyM' });
  assert.deepEqual(resolve()['voice.repeat'], { code: 'KeyR' });
  // With a modifier the browser does not take it for moving on: that one is a shortcut like any.
  assert.deepEqual(resolve()['voice.hold'], { code: 'Tab', ctrl: true });
});

test('the Esc line in the fixed shortcuts does not say the message box has to be empty', async () => {
  const { FIXED } = await import('../core/web/src/keybindings.js');
  assert.equal(FIXED.find((f) => f.keys.code === 'Escape')?.label, 'Stop the run');
});

test('an extension\'s shortcut is listed after the portal\'s own, and goes with its extension', () => {
  const off = addAction({ id: 'x:notes/pin', label: 'Pin', scope: 'Voice mode', default: { code: 'KeyN' }, extension: 'notes' });
  assert.deepEqual(actions().slice(-1).map((a) => a.id), ['x:notes/pin']);
  assert.equal(actions().length, ACTIONS.length + 1);
  assert.deepEqual(resolve()['x:notes/pin'], { code: 'KeyN' });
  assert.throws(() => addAction({ id: 'x:notes/pin', label: 'Again', scope: 'Voice mode', default: null }), /already/);
  off();
  assert.equal(actions().length, ACTIONS.length);
  assert.equal('x:notes/pin' in resolve(), false);
});

test('an extension\'s default that the portal or an earlier extension has already is not taken from it', () => {
  // M is the portal's mute; B is the first extension's.
  const one = addAction({ id: 'x:a/one', label: 'One', scope: 'Voice mode', default: { code: 'KeyB', shift: true }, extension: 'a' });
  const two = addAction({ id: 'x:b/two', label: 'Two', scope: 'Voice mode', default: { code: 'KeyB', shift: true }, extension: 'b' });
  const mute = addAction({ id: 'x:c/mute', label: 'Mute', scope: 'Voice mode', default: { code: 'KeyM' }, extension: 'c' });
  const now = resolve();
  assert.deepEqual(now['voice.mute'], { code: 'KeyM' });
  assert.equal(now['x:c/mute'], null);
  assert.deepEqual(now['x:a/one'], { code: 'KeyB', shift: true });
  assert.equal(now['x:b/two'], null);
  // Given one by hand, it has it, and the one that had it loses it, as between the portal's own.
  assert.equal(setBinding('x:b/two', { code: 'KeyB', shift: true }), 'x:a/one');
  assert.deepEqual(resolve()['x:b/two'], { code: 'KeyB', shift: true });
  assert.equal(resolve()['x:a/one'], null);
  for (const off of [one, two, mute]) off();
});

test('what was chosen for an extension\'s shortcut is kept while the extension is not there, and is its again when it comes back', () => {
  const off = addAction({ id: 'x:notes/pin', label: 'Pin', scope: 'Voice mode', default: { code: 'KeyN' }, extension: 'notes' });
  setBinding('x:notes/pin', { code: 'KeyJ' });
  off();
  // A change to another shortcut meanwhile writes the store again, without the extension's.
  setBinding('voice.repeat', { code: 'KeyQ' });
  const back = addAction({ id: 'x:notes/pin', label: 'Pin', scope: 'Voice mode', default: { code: 'KeyN' }, extension: 'notes' });
  assert.deepEqual(resolve()['x:notes/pin'], { code: 'KeyJ' });
  assert.equal(resetBinding('x:notes/pin'), undefined);
  assert.deepEqual(resolve()['x:notes/pin'], { code: 'KeyN' });
  back();
});

test('a key chosen for a portal shortcut while an extension was away is the portal\'s: the extension\'s choice of it gives way when it comes back', () => {
  const off = addAction({ id: 'x:notes/pin', label: 'Pin', scope: 'Voice mode', default: { code: 'KeyN' }, extension: 'notes' });
  setBinding('x:notes/pin', { code: 'KeyJ' });
  off();
  setBinding('voice.repeat', { code: 'KeyJ' });
  const back = addAction({ id: 'x:notes/pin', label: 'Pin', scope: 'Voice mode', default: { code: 'KeyN' }, extension: 'notes' });
  assert.deepEqual(resolve()['voice.repeat'], { code: 'KeyJ' });
  assert.equal(resolve()['x:notes/pin'], null, 'one key does one thing');
  back();
});

test('an extension\'s shortcut reset to a default another action has takes it from nobody, and that is what its row calls its default', () => {
  const off = addAction({ id: 'x:c/mute', label: 'Mute', scope: 'Voice mode', default: { code: 'KeyM' }, extension: 'c' });
  assert.equal(defaults()['x:c/mute'], null);
  setBinding('x:c/mute', { code: 'KeyK' });
  assert.equal(resetBinding('x:c/mute'), undefined);
  assert.deepEqual(resolve()['voice.mute'], { code: 'KeyM' }, 'the portal keeps its key');
  assert.equal(resolve()['x:c/mute'], null);
  off();
});

test('a shortcut that is not there any more has nothing to assign or reset, and a default has to be a key', () => {
  const before = JSON.stringify(resolve());
  assert.deepEqual(assign('x:gone/away', { code: 'KeyZ' }).choice, {});
  assert.equal(setBinding('x:gone/away', { code: 'KeyZ' }), undefined);
  assert.equal(resetBinding('x:gone/away'), undefined);
  assert.equal(JSON.stringify(resolve()), before);
  assert.deepEqual(bindingFrom({ code: 'KeyN', shift: true, ctrl: false }), { code: 'KeyN', shift: true });
  assert.equal(bindingFrom(null), null);
  for (const bad of [{ code: 'Tab' }, 'KeyN', { key: 'n' }, { code: '' }, 3]) assert.equal(bindingFrom(bad), undefined, JSON.stringify(bad));
});
