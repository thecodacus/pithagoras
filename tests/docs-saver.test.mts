import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSaver } from '../extensions/docs/web/saver.js';

/**
 * Saving a document as it is edited (extensions/docs/web/saver.js), with no editor and no clock: the text is a
 * variable, the timer is run by hand, and the server is a function that answers as the server half does.
 */

class Refused extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super('refused');
  }
}

function setup(document = { revision: 3, markdown: 'one\n' }) {
  const editor = { text: document.markdown };
  const sent: { markdown: string; base: number }[] = [];
  const states: string[] = [];
  /** The timers that are waiting, by id: what is cleared is gone. */
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let ids = 0;
  /** Answers each save from here: held until released, when `hold` is set. */
  const server = { revision: document.revision, markdown: document.markdown, hold: null as Promise<void> | null, fail: null as Error | null, warning: undefined as string | undefined };
  const saver = createSaver({
    read: () => editor.text,
    send: async (markdown: string, base: number) => {
      sent.push({ markdown, base });
      await server.hold;
      if (server.fail) throw server.fail;
      if (base !== server.revision) throw new Refused(409, { revision: server.revision, markdown: server.markdown });
      server.revision += 1;
      server.markdown = markdown;
      return { revision: server.revision, ...(server.warning ? { warning: server.warning } : {}) };
    },
    onState: (state: { status: string }) => states.push(state.status),
    delay: 1000,
    setTimer: (fn: () => void, ms: number) => {
      timers.set(++ids, { fn, ms });
      return ids;
    },
    clearTimer: (id: number) => void timers.delete(id),
  });
  saver.adopt(document.revision, document.markdown);
  const type = (text: string) => {
    editor.text = text;
    saver.changed();
  };
  /** Runs the timers that are waiting. */
  const wait = async () => {
    const due = [...timers.values()];
    timers.clear();
    for (const timer of due) timer.fn();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { saver, editor, sent, states, timers, server, type, wait };
}

test('a save carries the revision the text started from, and the next one the revision that came back', async () => {
  const { saver, type, wait, sent } = setup();
  type('one two\n');
  assert.equal(saver.state().status, 'dirty');
  await wait();
  assert.deepEqual(sent, [{ markdown: 'one two\n', base: 3 }]);
  assert.equal(saver.state().status, 'saved');
  assert.equal(saver.state().base, 4);
  type('one two three\n');
  await wait();
  assert.deepEqual(sent.map((s) => s.base), [3, 4]);
});

test('text typed since the editor last said so is unsaved all the same', async () => {
  const { saver, editor, type, wait } = setup();
  assert.equal(saver.unsaved(), false);
  // The editor says it changed a moment after it did: the text is asked.
  editor.text = 'one two\n';
  assert.equal(saver.state().status, 'saved');
  assert.equal(saver.unsaved(), true);
  saver.changed();
  assert.equal(saver.unsaved(), true);
  await wait();
  assert.equal(saver.unsaved(), false);
  type('one two three\n');
  assert.equal(saver.unsaved(), true);
});

test('nothing is sent before the text has been still for the delay, and what is sent is the text then', async () => {
  const { type, timers, wait, sent } = setup();
  type('a\n');
  type('ab\n');
  type('abc\n');
  // Each change took the earlier wait back: one is left.
  assert.deepEqual([...timers.values()].map((t) => t.ms), [1000]);
  assert.equal(sent.length, 0);
  await wait();
  assert.deepEqual(sent, [{ markdown: 'abc\n', base: 3 }]);
});

test('text given back to what it was is not saved', async () => {
  const { saver, type, wait, sent } = setup();
  type('one!\n');
  type('one\n');
  assert.equal(saver.state().status, 'saved');
  await wait();
  assert.equal(sent.length, 0);
});

test('a text the editor writes differently from the file is not saved until it changes: the baseline is what the editor holds', async () => {
  // The file has `* one`, the editor writes `- one`: adopted as the editor has it.
  const { saver, wait, sent } = setup({ revision: 3, markdown: '- one\n' });
  assert.equal(await saver.flush(), true);
  await wait();
  assert.equal(sent.length, 0);
});

test('a refused save keeps the text and the other version, and sends nothing more', async () => {
  const { saver, type, wait, sent, server, editor } = setup();
  server.revision = 4;
  server.markdown = 'theirs\n';
  type('mine\n');
  await wait();
  assert.equal(saver.state().status, 'conflict');
  assert.deepEqual(saver.state().conflict, { revision: 4, markdown: 'theirs\n' });
  // The text is the person's, and the base the one it started from.
  assert.equal(editor.text, 'mine\n');
  assert.equal(saver.state().base, 3);
  type('mine, more\n');
  await wait();
  assert.equal(await saver.flush(), false);
  assert.equal(sent.length, 1);
  assert.equal(saver.state().status, 'conflict');
});

test('keeping my text saves it on top of the other version', async () => {
  const { saver, type, wait, sent, server } = setup();
  server.revision = 4;
  server.markdown = 'theirs\n';
  type('mine\n');
  await wait();
  assert.equal(await saver.keepMine(), true);
  assert.deepEqual(sent.at(-1), { markdown: 'mine\n', base: 4 });
  assert.equal(saver.state().status, 'saved');
  assert.equal(saver.state().base, 5);
  assert.equal(server.markdown, 'mine\n');
});

test('taking theirs is the editor holding their text: adopted as the document at their revision, and nothing is sent', async () => {
  const { saver, type, wait, sent, server, editor } = setup();
  server.revision = 4;
  server.markdown = 'theirs\n';
  type('mine\n');
  await wait();
  editor.text = 'theirs\n';
  saver.adopt(4, 'theirs\n');
  assert.equal(saver.state().status, 'saved');
  assert.equal(saver.state().conflict, null);
  assert.equal(await saver.flush(), true);
  assert.equal(sent.length, 1);
  type('theirs and more\n');
  await wait();
  assert.deepEqual(sent.at(-1), { markdown: 'theirs and more\n', base: 4 });
});

test('somebody saving the very words that were being saved is not a conflict', async () => {
  const { saver, type, wait, server } = setup();
  server.revision = 4;
  server.markdown = 'same\n';
  type('same\n');
  await wait();
  assert.equal(saver.state().status, 'saved');
  assert.equal(saver.state().base, 4);
});

test('a draft kept from earlier on another revision is a conflict at once, and keeps its own base until the person chooses', async () => {
  const { saver, editor, sent, wait } = setup({ revision: 5, markdown: 'now\n' });
  editor.text = 'draft\n';
  saver.conflicted({ revision: 5, markdown: 'now\n' }, 3);
  assert.equal(saver.state().status, 'conflict');
  assert.equal(saver.state().base, 3);
  await wait();
  assert.equal(sent.length, 0);
  // Kept: saved on top of the revision the document is at.
  assert.equal(await saver.keepMine(), true);
  assert.deepEqual(sent, [{ markdown: 'draft\n', base: 5 }]);
});

test('a failed save is an error, tried again at the next change and by flush', async () => {
  const { saver, type, wait, sent, server } = setup();
  server.fail = new Error('Cannot reach the portal');
  type('one two\n');
  await wait();
  assert.equal(saver.state().status, 'error');
  assert.equal(saver.state().error, 'Cannot reach the portal');
  // Not given up on: asked for again.
  server.fail = null;
  assert.equal(await saver.flush(), true);
  assert.equal(sent.length, 2);
  assert.equal(saver.state().status, 'saved');
  server.fail = new Error('down');
  type('one two three\n');
  await wait();
  assert.equal(saver.state().status, 'error');
  server.fail = null;
  type('one two three four\n');
  assert.equal(saver.state().status, 'dirty');
  await wait();
  assert.equal(saver.state().status, 'saved');
});

test('one save at a time: what is typed while one is on its way is sent after it, in its own', async () => {
  const { saver, type, wait, sent, server } = setup();
  let release: () => void = () => {};
  server.hold = new Promise((resolve) => (release = resolve));
  type('one two\n');
  await wait();
  assert.equal(saver.state().status, 'saving');
  type('one two three\n');
  // The wait runs out while the first is on its way: no second request.
  await wait();
  assert.equal(sent.length, 1);
  server.hold = null;
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saver.state().status, 'dirty');
  await wait();
  assert.deepEqual(sent, [{ markdown: 'one two\n', base: 3 }, { markdown: 'one two three\n', base: 4 }]);
  assert.equal(saver.state().status, 'saved');
});

test('flush saves everything unsaved now, also what is typed during the save, and says whether it all is', async () => {
  const { saver, type, sent, server, editor } = setup();
  let release: () => void = () => {};
  server.hold = new Promise((resolve) => (release = resolve));
  type('one two\n');
  const flushed = saver.flush();
  await new Promise((resolve) => setImmediate(resolve));
  editor.text = 'one two three\n';
  server.hold = null;
  release();
  assert.equal(await flushed, true);
  assert.deepEqual(sent.map((s) => s.markdown), ['one two\n', 'one two three\n']);
  assert.equal(saver.state().status, 'saved');
  // Nothing unsaved: nothing sent.
  assert.equal(await saver.flush(), true);
  assert.equal(sent.length, 2);
});

test('a warning from the server is kept until it is put away, and not said again while saves keep coming back with it', async () => {
  const { saver, type, wait, server } = setup();
  server.warning = 'A secret';
  type('one two\n');
  await wait();
  assert.equal(saver.state().warning, 'A secret');
  saver.dismissWarning();
  assert.equal(saver.state().warning, null);
  type('one two three\n');
  await wait();
  assert.equal(saver.state().warning, null);
  // The secret is gone, and a new one comes: that is said.
  server.warning = undefined;
  type('one\n');
  await wait();
  server.warning = 'A secret';
  type('one two\n');
  await wait();
  assert.equal(saver.state().warning, 'A secret');
});
