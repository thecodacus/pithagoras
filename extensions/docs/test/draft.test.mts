import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDraft } from '../web/draft.js';

/**
 * A comment saved as it is typed (extensions/docs/web/draft.js), with no box and no clock: what is typed is a call, the
 * timer is run by hand, and the server is a function that makes, changes and takes away a comment as the routes do.
 */

function setup() {
  /** What the server holds: the comment, by id. */
  const server = { comments: new Map<string, string>(), count: 0, hold: null as Promise<void> | null, fail: null as Error | null };
  const calls: string[] = [];
  const states: { id: string | null; saving: boolean; error: Error | null }[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let ids = 0;
  const draft = createDraft({
    save: async (text: string, id: string | null) => {
      calls.push(id === null ? `make ${text}` : `change ${id} ${text}`);
      await server.hold;
      if (server.fail) throw server.fail;
      const at = id ?? `c${++server.count}`;
      server.comments.set(at, text);
      return at;
    },
    remove: async (id: string) => {
      calls.push(`remove ${id}`);
      await server.hold;
      if (server.fail) throw server.fail;
      server.comments.delete(id);
    },
    onState: (state: any) => states.push(state),
    delay: 700,
    setTimer: (fn: () => void, ms: number) => {
      timers.set(++ids, { fn, ms });
      return ids;
    },
    clearTimer: (id: number) => void timers.delete(id),
  });
  /** Runs the timers that are waiting, and lets what they started finish. */
  const wait = async () => {
    const due = [...timers.values()];
    timers.clear();
    for (const timer of due) timer.fn();
    await draft.flush();
  };
  return { draft, server, calls, states, timers, wait };
}

test('what is typed is saved after a pause: the first save makes the comment, the next ones change it', async () => {
  const { draft, server, calls, timers, wait } = setup();
  draft.changed('Is');
  draft.changed('Is this right?');
  // One wait, restarted by each change: nothing was sent while it was typed.
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].ms, 700);
  assert.deepEqual(calls, []);
  await wait();
  assert.deepEqual(calls, ['make Is this right?']);
  assert.equal(draft.state().id, 'c1');
  draft.changed('Is this right? @agent');
  await wait();
  assert.deepEqual(calls, ['make Is this right?', 'change c1 Is this right? @agent']);
  assert.deepEqual([...server.comments], [['c1', 'Is this right? @agent']]);
});

test('text typed while a save is on its way is sent after it, one request at a time', async () => {
  const { draft, calls, server, states } = setup();
  let release!: () => void;
  server.hold = new Promise<void>((resolve) => (release = resolve));
  draft.changed('One');
  const first = draft.flush();
  await Promise.resolve();
  assert.deepEqual(calls, ['make One']);
  draft.changed('One two');
  draft.changed('One two three');
  assert.deepEqual(calls, ['make One'], 'not sent while one is on its way');
  assert.equal(draft.state().saving, true);
  server.hold = null;
  release();
  assert.equal(await first, true);
  // What was typed after the first went out was sent once it was done, as the comment the first made.
  assert.deepEqual(calls, ['make One', 'change c1 One two three']);
  assert.equal(draft.state().saving, false);
  assert.equal(states.at(-1)!.id, 'c1');
});

test('typing it all away takes the comment away, and what is typed next makes a new one', async () => {
  const { draft, calls, server, wait } = setup();
  draft.changed('Words');
  await wait();
  draft.changed('   ');
  await wait();
  assert.deepEqual(calls, ['make Words', 'remove c1']);
  assert.equal(draft.state().id, null);
  assert.equal(server.comments.size, 0);
  // Nothing was made for text that was never saved.
  draft.changed('');
  await wait();
  assert.deepEqual(calls, ['make Words', 'remove c1']);
  draft.changed('Again');
  await wait();
  assert.deepEqual(calls.slice(2), ['make Again']);
  assert.equal(draft.state().id, 'c2');
});

test('a save that failed keeps what was typed and says why, and the next change or flush sends it again', async () => {
  const { draft, calls, server, wait } = setup();
  server.fail = new Error('The documents store could not do that');
  draft.changed('Typed');
  await wait();
  assert.equal(draft.state().error?.message, 'The documents store could not do that');
  assert.equal(draft.state().id, null);
  assert.deepEqual(calls, ['make Typed']);
  // No retry of its own: it waits for the person to go on, or to leave.
  server.fail = null;
  assert.equal(await draft.flush(), true);
  assert.deepEqual(calls, ['make Typed', 'make Typed']);
  assert.equal(draft.state().error, null);
  assert.equal(draft.state().id, 'c1');
  // A failure to change goes the same way, with what was saved kept.
  server.fail = new Error('down');
  draft.changed('Typed more');
  await wait();
  assert.equal(draft.state().error?.message, 'down');
  assert.equal(draft.state().id, 'c1');
  server.fail = null;
  draft.changed('Typed more still');
  await wait();
  assert.deepEqual(calls.slice(-1), ['change c1 Typed more still']);
  assert.equal(draft.state().error, null);
});

test('flush saves at once what the wait has not, settle lets the comment go, and discard takes it away', async () => {
  const { draft, calls, server, timers } = setup();
  draft.changed('First');
  assert.equal(await draft.flush(), true);
  assert.deepEqual(calls, ['make First']);
  assert.equal(timers.size, 0, 'the wait was not left behind');
  // Nothing to save: nothing is sent.
  assert.equal(await draft.flush(), true);
  assert.deepEqual(calls, ['make First']);
  // Let go: what is typed next is a comment of its own, and the first stays.
  assert.equal(await draft.settle(), true);
  assert.equal(draft.state().id, null);
  draft.changed('Second');
  await draft.flush();
  assert.deepEqual(calls, ['make First', 'make Second']);
  assert.deepEqual([...server.comments].map(([, text]) => text), ['First', 'Second']);
  // Not written, but typed and then dropped: nothing is made.
  draft.changed('Third');
  assert.equal(await draft.discard(), true);
  assert.deepEqual(calls, ['make First', 'make Second', 'remove c2']);
  assert.deepEqual([...server.comments].map(([, text]) => text), ['First']);
  await draft.flush();
  assert.equal(calls.length, 3, 'what was dropped is not sent');
});

test('a comment that cannot be taken away is said, and is still the comment', async () => {
  const { draft, server, wait } = setup();
  draft.changed('Words');
  await wait();
  server.fail = new Error('down');
  assert.equal(await draft.discard(), false);
  assert.equal(draft.state().id, 'c1');
  assert.equal(draft.state().error?.message, 'down');
  server.fail = null;
  assert.equal(await draft.discard(), true);
  assert.equal(draft.state().id, null);
});
