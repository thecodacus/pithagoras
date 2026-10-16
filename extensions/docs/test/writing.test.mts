import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drafted, followWriting } from '../writing.js';

/**
 * What the agent writes in a document, followed as the model writes the call (writing.js): with pi's events as they come
 * (`toolcall_delta`, whose `partial` message has the arguments as far as they have come) and a clock that is the test's.
 */
function follower({ offers = (_chat: string, _tool: string) => 'direct' as 'direct' | 'lazy' | undefined, documents = {} as Record<string, unknown> } = {}) {
  const sent: [string, any][] = [];
  const read: string[] = [];
  const due: (() => void)[] = [];
  const writing = followWriting({
    offers,
    folderOf: () => 'f0f0f0f0f0f0f0f0',
    documentOf: async (_chat: string, id: string) => {
      read.push(id);
      return documents[id];
    },
    send: (chat: string, message: unknown) => void sent.push([chat, message]),
    setTimer: (run: () => void) => due.push(run),
    clearTimer: () => {},
  });
  /** The model has written this much of call `id` of tool `name`. */
  const wrote = (id: string, name: string, args: unknown, chat = 'a') =>
    writing.observe(chat, { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta: '…', partial: { content: [{ type: 'text', text: 'Writing it.' }, { type: 'toolCall', id, name, arguments: args }] } } });
  /** The time to tell the pages has come, after what was being read is in. */
  const later = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    while (due.length) due.shift()!();
  };
  const messages = () => sent.splice(0).map(([chat, message]) => ({ chat, ...message }));
  return { writing, wrote, later, messages, read };
}

const PLAN = '# Plan\n\nShip it on Friday.\n\nThe build is green.\n';

test('a new document is shown as the model writes it, at most once a quarter of a second, and its end says where it is', async () => {
  const { writing, wrote, later, messages } = follower();
  wrote('c1', 'doc_create', { title: 'Ide' });
  wrote('c1', 'doc_create', { title: 'Ideas', markdown: 'First' });
  await later();
  // What was written meanwhile is said once, as it was last.
  assert.deepEqual(messages(), [{ chat: 'a', type: 'writing', call: 'c1', tool: 'create', folder: 'f0f0f0f0f0f0f0f0', title: 'Ideas', markdown: 'First' }]);
  wrote('c1', 'doc_create', { title: 'Ideas', markdown: 'First things first' });
  // The end comes before the next turn of the clock: what was written last is said before it, and nothing after.
  writing.observe('a', { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'doc_create', result: { details: { action: 'create', folder: 'f0f0f0f0f0f0f0f0', id: '4444444444444444' } } });
  await later();
  assert.deepEqual(messages(), [
    { chat: 'a', type: 'writing', call: 'c1', tool: 'create', folder: 'f0f0f0f0f0f0f0f0', title: 'Ideas', markdown: 'First things first' },
    { chat: 'a', type: 'written', call: 'c1', ok: true, folder: 'f0f0f0f0f0f0f0f0', id: '4444444444444444' },
  ]);
  // One that was refused made nothing.
  wrote('c2', 'doc_create', { title: 'Ideas' });
  writing.observe('a', { type: 'tool_execution_end', toolCallId: 'c2', toolName: 'doc_create', isError: true, result: { content: [{ type: 'text', text: 'exists: …' }] } });
  assert.deepEqual(messages().at(-1), { chat: 'a', type: 'written', call: 'c2', ok: false });
});

test('an edit is shown on the document it names, read once all of its id has come, with the edits that have come so far', async () => {
  const doc = { folder: 'f0f0f0f0f0f0f0f0', id: '1111111111111111', revision: 3, markdown: PLAN };
  const { writing, wrote, later, messages, read } = follower({ documents: { '1111111111111111': doc } });
  wrote('e1', 'doc_edit', { id: '11111111' });
  await later();
  assert.deepEqual(read, [], 'not on a part of its id');
  assert.deepEqual(messages(), [], 'and nothing to show before the document is read');
  wrote('e1', 'doc_edit', { id: '1111111111111111', expected_revision: 3, edits: [{ quote: 'Friday' }] });
  await later();
  const shown = () => messages().map((m) => m.markdown);
  // A quote whose replacement has not begun is not made yet.
  assert.deepEqual(shown(), [PLAN]);
  wrote('e1', 'doc_edit', { id: '1111111111111111', expected_revision: 3, edits: [{ quote: 'Friday', replacement: 'Mon' }] });
  await later();
  assert.deepEqual(shown(), [PLAN.replace('Friday', 'Mon')]);
  wrote('e1', 'doc_edit', { id: '1111111111111111', expected_revision: 3, edits: [{ quote: 'Friday', replacement: 'Monday' }, { quote: 'The build is green.', replacement: 'The build is red' }] });
  await later();
  assert.deepEqual(shown(), [PLAN.replace('Friday', 'Monday').replace('The build is green.', 'The build is red')]);
  assert.deepEqual(read, ['1111111111111111'], 'read once');
  writing.observe('a', { type: 'tool_execution_end', toolCallId: 'e1', toolName: 'doc_edit', result: { details: { action: 'edit', folder: 'f0f0f0f0f0f0f0f0', id: '1111111111111111', revision: 4 } } });
  assert.deepEqual(messages(), [{ chat: 'a', type: 'written', call: 'e1', ok: true, folder: 'f0f0f0f0f0f0f0f0', id: '1111111111111111' }]);

  // A document the chat does not see, or that is not there, is not shown: its call only ends.
  wrote('e2', 'doc_edit', { id: '2222222222222222', edits: [{ quote: 'a', replacement: 'b' }] });
  await later();
  assert.deepEqual(messages(), []);
  writing.observe('a', { type: 'tool_execution_end', toolCallId: 'e2', toolName: 'doc_edit', isError: true, result: {} });
  assert.deepEqual(messages(), [{ chat: 'a', type: 'written', call: 'e2', ok: false }]);
});

test('a call is followed by the name the chat offers its tool under: by its own, or through the tools tool where it is lazy, with its arguments as an object', async () => {
  const lazy = follower({ offers: () => 'lazy' });
  // By its own name where it is lazy: refused, and never run.
  lazy.wrote('c1', 'doc_create', { title: 'Direct' });
  // Through the tools tool, while the name is still coming, and once it is there.
  lazy.wrote('c2', 'tools', { action: 'call', name: 'doc_cre' });
  lazy.wrote('c2', 'tools', { action: 'call', name: 'doc_create', args: { title: 'Through', markdown: 'Text' } });
  // The arguments given as the text of an object are shown once the call is done, as before.
  lazy.wrote('c3', 'tools', { action: 'call', name: 'doc_create', args: '{"title":"As text"' });
  // A search of the tools calls nothing.
  lazy.wrote('c4', 'tools', { action: 'search', query: 'doc_create' });
  await lazy.later();
  assert.deepEqual(lazy.messages().map((m) => [m.call, m.title]), [['c2', 'Through']]);

  const direct = follower({ offers: () => 'direct' });
  direct.wrote('c5', 'tools', { action: 'call', name: 'doc_create', args: { title: 'Through' } });
  // Another tool is not followed, and nor is one the chat does not offer.
  direct.wrote('c6', 'canvas_write', { content: 'x' });
  await direct.later();
  assert.deepEqual(direct.messages(), []);
  const off = follower({ offers: () => undefined });
  off.wrote('c7', 'doc_create', { title: 'Off' });
  await off.later();
  assert.deepEqual(off.messages(), []);
});

test('a run that is over ends what it was writing as not made, a page that opens is told what is being written, and chats are apart', async () => {
  const { writing, wrote, later, messages } = follower();
  assert.equal(writing.opened('a'), undefined, 'nothing to tell');
  wrote('c1', 'doc_create', { title: 'One', markdown: 'Body' });
  wrote('c2', 'doc_create', { title: 'Other chat' }, 'b');
  await later();
  messages();
  assert.deepEqual(writing.opened('a'), { type: 'writings', list: [{ type: 'writing', call: 'c1', tool: 'create', folder: 'f0f0f0f0f0f0f0f0', title: 'One', markdown: 'Body' }] });
  writing.observe('a', { type: 'agent_end' });
  assert.deepEqual(messages(), [{ chat: 'a', type: 'written', call: 'c1', ok: false }]);
  assert.equal(writing.opened('a'), undefined);
  assert.equal(writing.opened('b').list[0].title, 'Other chat', "the other chat's goes on");
  writing.forget('b');
  assert.deepEqual(messages(), [{ chat: 'b', type: 'written', call: 'c2', ok: false }]);
});

test('the draft of an edit makes the edits that will be made, and leaves out what the tool will refuse', () => {
  const edit = (quote: string, replacement: string) => ({ quote, replacement });
  assert.equal(drafted(PLAN, [edit('Friday', 'Monday'), edit('# Plan', '# The plan')]), PLAN.replace('Friday', 'Monday').replace('# Plan', '# The plan'));
  // Not there, there twice, overlapping one before it: left out.
  assert.equal(drafted('a b a', [edit('a', 'x'), edit('c', 'y'), edit('b', 'B')]), 'a B a');
  assert.equal(drafted(PLAN, [edit('Ship it on', 'Send it on'), edit('it on Friday', 'x')]), PLAN.replace('Ship it on', 'Send it on'));
  // An edit whose replacement came before its quote may have a quote that is not whole yet: not made until it is in order.
  assert.equal(drafted(PLAN, [{ replacement: 'x', quote: 'Fri' }]), PLAN);
  // A quote with line feeds is found in a document written with CRLF.
  assert.equal(drafted('a\r\nb\r\n', [edit('a\nb', 'c')]), 'c\r\n');
  for (const edits of [undefined, 'x', [null, 3, { quote: '' }]]) assert.equal(drafted(PLAN, edits as any), PLAN);
});
