import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The store is the browser's; a Map stands in for it.
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
const events: string[] = [];
(globalThis as any).window = Object.assign(new EventTarget(), { localStorage: (globalThis as any).localStorage });
(globalThis as any).window.addEventListener('command-trigger-changed', () => events.push('changed'));
const { commandTrigger, setCommandTrigger, typedCharacter, validTrigger } = await import('../core/web/src/command-trigger.ts');

beforeEach(() => { store.clear(); events.length = 0; });

test('the slash is the trigger until another is chosen', () => {
  assert.equal(commandTrigger(), '/');
});

test('a chosen character is kept in this browser, and the page is told', () => {
  setCommandTrigger('!');
  assert.equal(commandTrigger(), '!');
  assert.equal(store.get('commandTrigger'), '!');
  assert.deepEqual(events, ['changed']);
});

test('only a choice that differs from the default is stored', () => {
  setCommandTrigger('!');
  setCommandTrigger('/');
  assert.equal(store.has('commandTrigger'), false);
  assert.equal(commandTrigger(), '/');
});

test('a character that cannot be one is not kept, and neither is a stored one', () => {
  setCommandTrigger('a');
  setCommandTrigger('');
  setCommandTrigger('!!');
  assert.equal(store.has('commandTrigger'), false);
  assert.deepEqual(events, []);
  // Something else in the store, from an older version or by hand.
  store.set('commandTrigger', 'abc');
  assert.equal(commandTrigger(), '/');
  store.set('commandTrigger', ' ');
  assert.equal(commandTrigger(), '/');
});

test('a punctuation mark or a symbol can be one; a letter, a digit, a space or part of a name cannot', () => {
  for (const ok of ['/', '!', '.', ',', ';', '\\', '#', '@', '$', '~', '>', '|', '§', '€', '»']) assert.equal(validTrigger(ok), true, ok);
  for (const no of ['a', 'Z', 'ä', '7', '٣', ' ', '\n', '\t', '', '-', '_', ':', '!!', '/a']) assert.equal(validTrigger(no), false, JSON.stringify(no));
});

test('what was typed into the one-character field is found wherever the caret was', () => {
  // Over the selected one, after it, and before it: all the same character.
  assert.equal(typedCharacter('/', '!'), '!');
  assert.equal(typedCharacter('/', '/!'), '!');
  assert.equal(typedCharacter('/', '!/'), '!');
  // A letter before the old one is a letter, not the old one.
  assert.equal(typedCharacter('!', 'a!'), 'a');
  // The same character typed again is still what was typed.
  assert.equal(typedCharacter('/', '//'), '/');
  assert.equal(typedCharacter('', '#'), '#');
  // More than one at once, as a paste: the last of it.
  assert.equal(typedCharacter('/', 'ab'), 'b');
  assert.equal(typedCharacter('/', '😀'), '😀');
  // Nothing inserted.
  assert.equal(typedCharacter('!', ''), '');
  assert.equal(typedCharacter('!', '!'), '');
});
