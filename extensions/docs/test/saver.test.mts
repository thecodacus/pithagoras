import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSaver } from '../web/saver.js';

/**
 * Saving a document as it is edited (extensions/docs/web/saver.js), with no editor and no clock: the text is a
 * variable, the timer is run by hand, and the server is a function that answers as the server half does.
 */

class Refused extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super('refused');
  }
}

function setup(document = { revision: 3, markdown: 'one\n' }, hooks: { onMerged?: (answer: any, sent: string) => void } = {}) {
  const editor = { text: document.markdown };
  const sent: { markdown: string; base: number }[] = [];
  const states: string[] = [];
  /** The timers that are waiting, by id: what is cleared is gone. */
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let ids = 0;
  /** Answers each save from here: held until released, when `hold` is set. */
  const server = { revision: document.revision, markdown: document.markdown, hold: null as Promise<void> | null, fail: null as Error | null, warning: undefined as string | undefined, merge: null as string | null };
  const saver = createSaver({
    read: () => editor.text,
    send: async (markdown: string, base: number) => {
      sent.push({ markdown, base });
      await server.hold;
      if (server.fail) throw server.fail;
      // A server that put the text together with what it holds: it answers with what it saved.
      if (base !== server.revision && server.merge) {
        server.revision += 1;
        server.markdown = server.merge;
        return { revision: server.revision, merged: true, changed: true, markdown: server.merge };
      }
      if (base !== server.revision) throw new Refused(409, { revision: server.revision, markdown: server.markdown });
      server.revision += 1;
      server.markdown = markdown;
      return { revision: server.revision, ...(server.warning ? { warning: server.warning } : {}) };
    },
    onMerged: hooks.onMerged,
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

test('a save the server put together with a later revision hands over what was saved, which is not what was sent', async () => {
  const taken: { answer: any; sent: string }[] = [];
  const { saver, editor, type, wait, server, sent } = setup({ revision: 3, markdown: 'one\n\ntwo\n' }, {
    onMerged: (answer, text) => {
      taken.push({ answer, sent: text });
    },
  });
  server.revision = 4;
  server.markdown = 'ONE\n\ntwo\n';
  server.merge = 'ONE\n\ntwo, and more\n';
  type('one\n\ntwo, and more\n');
  await wait();
  assert.deepEqual(sent, [{ markdown: 'one\n\ntwo, and more\n', base: 3 }]);
  assert.equal(taken.length, 1);
  assert.equal(taken[0].sent, 'one\n\ntwo, and more\n');
  assert.deepEqual([taken[0].answer.revision, taken[0].answer.markdown], [5, 'ONE\n\ntwo, and more\n']);
  // The revision is the merged one; the editor, which was not told what to hold, still has what was sent: nothing is unsaved.
  assert.equal(saver.state().base, 5);
  assert.equal(editor.text, 'one\n\ntwo, and more\n');
});

test('the editor taking up a merged save puts the saver on the new revision: what is left of the person\'s own text is unsaved on it', async () => {
  let saver: ReturnType<typeof setup>['saver'];
  let editor: ReturnType<typeof setup>['editor'];
  const made = setup({ revision: 3, markdown: 'one\n\ntwo\n' }, {
    onMerged: (answer) => {
      // The text the document is now, with what was typed meanwhile on top of it.
      editor.text = `${answer.markdown}typed since\n`;
      saver.rebase(answer.revision, answer.markdown);
    },
  });
  ({ saver, editor } = made);
  made.server.revision = 4;
  made.server.markdown = 'ONE\n\ntwo\n';
  made.server.merge = 'ONE\n\nTWO\n';
  made.type('one\n\nTWO\n');
  await made.wait();
  assert.equal(saver.state().status, 'dirty');
  assert.equal(saver.state().base, 5);
  await made.wait();
  assert.deepEqual(made.sent.at(-1), { markdown: 'ONE\n\nTWO\ntyped since\n', base: 5 });
  assert.equal(saver.state().status, 'saved');
});

test('a merged save whose text meets the person\'s own is a conflict, and the save does not go on to send it', async () => {
  let saver: ReturnType<typeof setup>['saver'];
  const made = setup({ revision: 3, markdown: 'one\n' }, {
    onMerged: (answer) => saver.conflicted({ revision: answer.revision, markdown: answer.markdown }, saver.state().base),
  });
  ({ saver } = made);
  made.server.revision = 4;
  made.server.markdown = 'theirs\n';
  made.server.merge = 'merged\n';
  made.type('mine\n');
  await made.wait();
  assert.equal(saver.state().status, 'conflict');
  assert.equal(saver.state().base, 5);
  // The timer that a save that went on would have set: there is none, and nothing more is sent.
  assert.equal(made.timers.size, 0);
  await made.wait();
  assert.equal(made.sent.length, 1);
});

test('what asks whether a save is on its way waits for it, and for nothing else', async () => {
  const { saver, type, wait, server } = setup();
  await saver.idle();
  let release: () => void = () => {};
  server.hold = new Promise((resolve) => (release = resolve));
  type('one two\n');
  await wait();
  assert.equal(saver.state().status, 'saving');
  let idle = false;
  void saver.idle().then(() => (idle = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idle, false);
  server.hold = null;
  release();
  await saver.idle();
  assert.equal(saver.state().status, 'saved');
});

test('rebasing says the document is at a later revision, as the editor writes it: unsaved if the editor holds more, saved if not', async () => {
  const { saver, editor, type, wait, sent, timers } = setup();
  type('one two\n');
  // Dirty, with the text written on revision 3; the document is at 6 now, with this text, and the editor holds more.
  saver.rebase(6, 'one\n');
  assert.deepEqual([saver.state().status, saver.state().base, saver.baseline()], ['dirty', 6, 'one\n']);
  assert.equal(timers.size, 1);
  await wait();
  assert.deepEqual(sent.at(-1), { markdown: 'one two\n', base: 6 });
  // The editor holds what the document is: nothing to save.
  editor.text = 'six\n';
  saver.rebase(7, 'six\n');
  assert.equal(saver.state().status, 'saved');
  assert.equal(timers.size, 0);
});

test('restyling the baseline says the text of the revision is written another way now, without a change of state or a save', async () => {
  const { saver, editor, sent } = setup({ revision: 3, markdown: '* one\n' });
  // The text in the box was the file's; the editor writes the same words with a dash.
  editor.text = '- one\n';
  assert.equal(saver.unsaved(), true);
  saver.restyle('- one\n');
  assert.equal(saver.baseline(), '- one\n');
  assert.equal(saver.unsaved(), false);
  assert.equal(saver.state().status, 'saved');
  assert.deepEqual(sent, []);
});
