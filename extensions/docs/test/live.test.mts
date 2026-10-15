import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLive } from '../web/live.js';
import { merge3 } from '../web/merge.js';
import { createSaver } from '../web/saver.js';

/**
 * A document that is changed while it is open, taken into the page (extensions/docs/web/live.js): with no editor
 * library and no browser. The editor is a variable that holds the text and writes it in its own style (`-` for a
 * bullet), the clock is run by hand, and the server is a function that answers as the server half does: it puts a
 * save that started from an earlier revision together with what it holds, where it can.
 */

class Refused extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super('refused');
  }
}

/** The editor's way of writing Markdown, for what the test needs of it. */
const normalize = (markdown: string) => markdown.replace(/^\* /gm, '- ');

const PLAN = '# Plan\n\nShip it on Friday.\n\nThe build is green.\n\nSign-off is on Monday.\n';

function setup(markdown = PLAN) {
  /** The document as the server half has it, with the text of each revision. */
  const server = {
    revision: 3,
    texts: new Map<number, string>([[3, markdown]]),
    hold: null as Promise<void> | null,
    loads: 0,
    failLoads: false,
    gateLoads: null as Promise<void> | null,
    get markdown() {
      return this.texts.get(this.revision)!;
    },
    /** Somebody else saves: the next revision. */
    elsewhere(text: string) {
      this.revision += 1;
      this.texts.set(this.revision, text);
    },
  };
  const editor = {
    text: normalize(markdown),
    failApply: false,
    applied: [] as string[],
    markdown: () => editor.text,
    normalize,
    apply(next: string) {
      if (editor.failApply) throw new Error('cannot read it');
      editor.applied.push(next);
      editor.text = normalize(next);
    },
  };
  const notices: { kind: string; revision: number; author: string | null }[] = [];
  const sent: { markdown: string; base: number }[] = [];
  const timers = new Map<number, () => void>();
  let ids = 0;
  let live: ReturnType<typeof createLive>;
  const saver = createSaver({
    read: () => editor.text,
    send: async (markdown: string, base: number) => {
      sent.push({ markdown, base });
      await server.hold;
      if (base !== server.revision) {
        const together = merge3(server.texts.get(base)!, markdown, server.markdown);
        if (together === null) throw new Refused(409, { revision: server.revision, markdown: server.markdown });
        server.elsewhere(together);
        return { revision: server.revision, merged: true, changed: true, markdown: together };
      }
      if (markdown !== server.markdown) server.elsewhere(markdown);
      return { revision: server.revision };
    },
    onMerged: (answer: any, text: string) => live.merged(answer, text),
    setTimer: (fn: () => void) => (timers.set(++ids, fn), ids),
    clearTimer: (id: number) => void timers.delete(id),
  });
  saver.adopt(3, editor.text);
  /** The waits before a request that failed is made again, by id and with how long each is. */
  const retries = new Map<number, { fn: () => void; ms: number }>();
  let retryIds = 0;
  live = createLive({
    editor,
    saver,
    revision: 3,
    setTimer: (fn: () => void, ms: number) => (retries.set(++retryIds, { fn, ms }), retryIds),
    clearTimer: (id: number) => void retries.delete(id),
    load: async () => {
      server.loads++;
      await server.gateLoads;
      if (server.failLoads) throw new Error('offline');
      return { revision: server.revision, markdown: server.markdown };
    },
    notify: (what: any) => notices.push(what),
  });
  const type = (text: string) => {
    editor.text = text;
    saver.changed();
  };
  const wait = async () => {
    const due = [...timers.values()];
    timers.clear();
    for (const fn of due) fn();
    await new Promise((resolve) => setImmediate(resolve));
  };
  /** Lets the waits that are on run out: what is asked for again is asked for. */
  const retry = async () => {
    const due = [...retries.values()];
    retries.clear();
    for (const { fn } of due) fn();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { server, editor, saver, live, notices, sent, type, wait, timers, retries, retry };
}

test('a document with nothing of the person\'s unsaved takes the new revision as it is, and is saved at it', async () => {
  const { server, editor, saver, live, notices, sent, timers } = setup();
  server.elsewhere(PLAN.replace('on Friday', 'on Thursday'));
  await live.seen({ revision: 4, author: 'agent' });
  assert.equal(editor.text, PLAN.replace('on Friday', 'on Thursday'));
  assert.deepEqual([saver.state().status, saver.state().base], ['saved', 4]);
  assert.deepEqual(notices, [{ kind: 'updated', revision: 4, author: 'agent' }]);
  // Nothing was sent, and nothing waits to be.
  assert.deepEqual(sent, []);
  assert.equal(timers.size, 0);
});

test('a revision the page is at already is not asked for, whoever made it: its own saves, and a stream that says it twice', async () => {
  const { server, live, type, wait } = setup();
  type(`${PLAN}Another line.\n`);
  await wait();
  const loads = server.loads;
  // Its own save made revision 4.
  await live.seen({ revision: 4, author: 'user' });
  await live.seen({ revision: 4, author: 'user' });
  await live.seen({ revision: 3, author: 'user' });
  assert.equal(server.loads, loads);
  // Something that is not a revision is nothing.
  await live.seen({});
  await live.seen(null);
  assert.equal(server.loads, loads);
});

test('text not yet saved gets the change too where the two do not meet, and is unsaved on the new revision', async () => {
  const { server, editor, saver, live, notices, sent, type, wait } = setup();
  type(PLAN.replace('is green', 'is red'));
  assert.equal(saver.state().status, 'dirty');
  server.elsewhere(PLAN.replace('on Friday', 'on Thursday'));
  await live.seen({ revision: 4, author: 'agent' });
  const both = PLAN.replace('on Friday', 'on Thursday').replace('is green', 'is red');
  assert.equal(editor.text, both);
  assert.deepEqual([saver.state().status, saver.state().base, saver.state().conflict], ['dirty', 4, null]);
  assert.deepEqual(notices, [{ kind: 'merged', revision: 4, author: 'agent' }]);
  // Nothing was sent for it: the person's text goes on its way as it would have, from the new revision.
  assert.deepEqual(sent, []);
  await wait();
  assert.deepEqual(sent, [{ markdown: both, base: 4 }]);
  assert.equal(server.markdown, both);
  assert.equal(saver.state().status, 'saved');
});

test('a change that meets the person\'s own is a conflict: their text stays, nothing is sent, and the other version is there to choose', async () => {
  const { server, editor, saver, live, notices, sent, type, wait, timers } = setup();
  type(PLAN.replace('on Friday', 'on Saturday'));
  server.elsewhere(PLAN.replace('on Friday', 'on Thursday'));
  await live.seen({ revision: 4, author: 'agent' });
  assert.equal(editor.text, PLAN.replace('on Friday', 'on Saturday'), 'the person\'s text is not touched');
  assert.equal(saver.state().status, 'conflict');
  assert.deepEqual(saver.state().conflict, { revision: 4, markdown: PLAN.replace('on Friday', 'on Thursday') });
  // Written on revision 3, still: it is the person who chooses what it is saved on.
  assert.equal(saver.state().base, 3);
  assert.equal(notices.at(-1)?.kind, 'conflict');
  assert.equal(timers.size, 0);
  await wait();
  assert.deepEqual(sent, []);
  // A later revision is the other version now, and the choice is still theirs.
  server.elsewhere(PLAN.replace('on Friday', 'on Wednesday'));
  await live.seen({ revision: 5, author: 'agent' });
  assert.deepEqual(saver.state().conflict, { revision: 5, markdown: PLAN.replace('on Friday', 'on Wednesday') });
  assert.equal(saver.state().base, 3);
  assert.equal(editor.text, PLAN.replace('on Friday', 'on Saturday'));
  assert.equal(await saver.keepMine(), true);
  assert.deepEqual(sent.at(-1), { markdown: PLAN.replace('on Friday', 'on Saturday'), base: 5 });
});

test('a document written in another style is no different for it: the style is not a change that meets the agent\'s', async () => {
  const written = '* One\n* Two\n\nText.\n\nMore text.\n';
  const { server, editor, saver, live, type } = setup(written);
  assert.equal(editor.text, '- One\n- Two\n\nText.\n\nMore text.\n');
  // The person changes the last paragraph; the agent changes a list item, in the style the file has.
  type('- One\n- Two\n\nText.\n\nMore text, said me.\n');
  server.elsewhere('* One\n* Two!\n\nText.\n\nMore text.\n');
  await live.seen({ revision: 4, author: 'agent' });
  assert.equal(editor.text, '- One\n- Two!\n\nText.\n\nMore text, said me.\n');
  assert.equal(saver.state().status, 'dirty');
  assert.equal(saver.state().base, 4);
});

test('a save on its way is waited for before a change is taken up: nothing meets it half sent', async () => {
  const { server, editor, saver, live, notices, sent, type, wait } = setup();
  let release: () => void = () => {};
  server.hold = new Promise((resolve) => (release = resolve));
  type(PLAN.replace('is green', 'is red'));
  await wait();
  assert.equal(saver.state().status, 'saving');
  server.elsewhere(PLAN.replace('on Friday', 'on Thursday'));
  const taken = live.seen({ revision: 4, author: 'agent' });
  await new Promise((resolve) => setImmediate(resolve));
  // Asked for, not yet taken up: the save is still on its way.
  assert.equal(editor.text, PLAN.replace('is green', 'is red'));
  assert.deepEqual(notices, []);
  server.hold = null;
  release();
  await taken;
  // The server put the save together with revision 4, and the editor holds the result.
  assert.deepEqual(sent, [{ markdown: PLAN.replace('is green', 'is red'), base: 3 }]);
  const both = PLAN.replace('on Friday', 'on Thursday').replace('is green', 'is red');
  assert.equal(editor.text, both);
  assert.deepEqual([saver.state().status, saver.state().base], ['saved', 5]);
  assert.equal(server.markdown, both);
  assert.deepEqual(notices.map((n) => n.kind), ['merged']);
});

test('a save the server put together is taken up by the editor, and what was typed while it was on its way is kept', async () => {
  const { server, editor, saver, live, notices, sent, type, wait } = setup();
  // The page was not told of the agent's change: the save meets it.
  server.elsewhere(PLAN.replace('on Friday', 'on Thursday'));
  let release: () => void = () => {};
  server.hold = new Promise((resolve) => (release = resolve));
  type(PLAN.replace('is green', 'is red'));
  await wait();
  assert.equal(saver.state().status, 'saving');
  // Typed in another paragraph while the save is on its way.
  type(PLAN.replace('is green', 'is red').replace('on Monday', 'on Tuesday'));
  server.hold = null;
  release();
  await new Promise((resolve) => setImmediate(resolve));
  const all = PLAN.replace('on Friday', 'on Thursday').replace('is green', 'is red').replace('on Monday', 'on Tuesday');
  assert.equal(editor.text, all);
  assert.deepEqual([saver.state().status, saver.state().base], ['dirty', 5]);
  assert.deepEqual(notices.map((n) => n.kind), ['merged']);
  await wait();
  assert.deepEqual(sent.at(-1), { markdown: all, base: 5 });
  assert.equal(server.markdown, all);
  void live;
});

test('a save the server put together, with nothing typed since, leaves the editor holding what the document is', async () => {
  const { server, editor, saver, notices, type, wait } = setup();
  server.elsewhere(PLAN.replace('on Friday', 'on Thursday'));
  type(PLAN.replace('is green', 'is red'));
  await wait();
  assert.equal(editor.text, PLAN.replace('on Friday', 'on Thursday').replace('is green', 'is red'));
  assert.deepEqual([saver.state().status, saver.state().base], ['saved', 5]);
  assert.deepEqual(notices.map((n) => n.kind), ['merged']);
});

test('a save the server put together that meets what was typed since is a conflict, and nothing more is sent', async () => {
  const { server, editor, saver, sent, type, wait, timers } = setup();
  server.elsewhere(PLAN.replace('on Friday', 'on Thursday'));
  let release: () => void = () => {};
  server.hold = new Promise((resolve) => (release = resolve));
  type(PLAN.replace('is green', 'is red'));
  await wait();
  // Typed in the paragraph that the agent changed: it meets the merged text.
  const meeting = PLAN.replace('is green', 'is red').replace('on Friday', 'on Saturday');
  type(meeting);
  server.hold = null;
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(editor.text, meeting, 'what was typed is not touched');
  assert.equal(saver.state().status, 'conflict');
  assert.equal(saver.state().conflict?.revision, 5);
  assert.equal(timers.size, 0);
  await wait();
  assert.equal(sent.length, 1);
  // The person keeps theirs on top of the merged revision.
  assert.equal(await saver.keepMine(), true);
  assert.deepEqual(sent.at(-1), { markdown: meeting, base: 5 });
});

test('changes that follow each other while one is asked for are taken up one after the other, and a revision is not asked for twice', async () => {
  const { server, editor, saver, live, notices } = setup();
  let open: () => void = () => {};
  server.gateLoads = new Promise((resolve) => (open = resolve));
  server.elsewhere(PLAN.replace('on Friday', 'on Thursday'));
  const first = live.seen({ revision: 4, author: 'agent' });
  server.elsewhere(PLAN.replace('on Friday', 'on Wednesday'));
  const second = live.seen({ revision: 5, author: 'agent' });
  server.gateLoads = null;
  open();
  await Promise.all([first, second]);
  assert.equal(editor.text, PLAN.replace('on Friday', 'on Wednesday'));
  assert.equal(saver.state().base, 5);
  // The first ask already found the document at 5: one request, one change.
  assert.equal(server.loads, 1);
  assert.equal(notices.length, 1);
});

test('the stream saying a page\'s own save before the answer to it comes is no reason to ask for the document', async () => {
  const { server, live, type, wait } = setup();
  let release: () => void = () => {};
  server.hold = new Promise((resolve) => (release = resolve));
  type(`${PLAN}Another line.\n`);
  await wait();
  // The save is made (revision 4), and the stream says so first.
  const heard = live.seen({ revision: 4, author: 'user' });
  await new Promise((resolve) => setImmediate(resolve));
  server.hold = null;
  release();
  await heard;
  assert.equal(server.loads, 0);
});

test('a request that fails leaves the page as it was, and is made again after a while, though no message comes', async () => {
  const { server, editor, saver, live, notices, retries, retry } = setup();
  server.elsewhere(PLAN.replace('on Friday', 'on Thursday'));
  server.failLoads = true;
  await live.seen({ revision: 4, author: 'agent' });
  assert.equal(editor.text, PLAN);
  assert.equal(saver.state().base, 3);
  // The stream is well and says nothing more: the wait is what asks again.
  assert.deepEqual([...retries.values()].map((r) => r.ms), [2000]);
  await retry();
  assert.equal(editor.text, PLAN, 'still failing');
  assert.deepEqual([...retries.values()].map((r) => r.ms), [4000], 'and the wait is longer');
  server.failLoads = false;
  await retry();
  assert.equal(editor.text, PLAN.replace('on Friday', 'on Thursday'));
  assert.equal(saver.state().base, 4);
  assert.deepEqual(notices.map((n) => n.kind), ['updated']);
  assert.equal(retries.size, 0, 'nothing left to wait for');
});

test('the next message asks again at once, without waiting for the wait, and the wait then finds nothing to do', async () => {
  const { server, editor, live, retries, retry } = setup();
  server.elsewhere(PLAN.replace('on Friday', 'on Thursday'));
  server.failLoads = true;
  await live.seen({ revision: 4, author: 'agent' });
  assert.equal(retries.size, 1);
  server.failLoads = false;
  await live.seen({ revision: 4, author: 'agent' });
  assert.equal(editor.text, PLAN.replace('on Friday', 'on Thursday'));
  const loads = server.loads;
  await retry();
  assert.equal(server.loads, loads, 'no request for what is there already');
});

test('the waits stop with the page', async () => {
  const { server, live, retries } = setup();
  server.elsewhere(PLAN.replace('on Friday', 'on Thursday'));
  server.failLoads = true;
  await live.seen({ revision: 4, author: 'agent' });
  assert.equal(retries.size, 1);
  live.close();
  assert.equal(retries.size, 0);
});

test('a text the editor cannot take up is a conflict, with the person\'s text where it was', async () => {
  const { server, editor, saver, live } = setup();
  server.elsewhere(PLAN.replace('on Friday', 'on Thursday'));
  editor.failApply = true;
  await live.seen({ revision: 4, author: 'agent' });
  assert.equal(editor.text, PLAN);
  assert.equal(saver.state().status, 'conflict');
  assert.deepEqual(saver.state().conflict, { revision: 4, markdown: PLAN.replace('on Friday', 'on Thursday') });
});

test('a page that is closed takes up nothing, also what it had asked for', async () => {
  const { server, editor, saver, live } = setup();
  let open: () => void = () => {};
  server.gateLoads = new Promise((resolve) => (open = resolve));
  server.elsewhere(PLAN.replace('on Friday', 'on Thursday'));
  const taken = live.seen({ revision: 4, author: 'agent' });
  // Asked for, and on its way.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.loads, 1);
  live.close();
  open();
  await taken;
  assert.equal(editor.text, PLAN);
  assert.equal(saver.state().base, 3);
  await live.seen({ revision: 4, author: 'agent' });
  assert.equal(server.loads, 1);
});
