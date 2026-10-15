import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import express from 'express';
import canvas from '../src/server.ts';
import { scratch } from '../../../tests/helpers.mts';

/**
 * The server half over a stand-in for the portal: what it tells the pages open on a chat, the agent's tools in each
 * chat as its pi starts, what it hears of a chat's pi, and a chat that goes.
 */
function portal() {
  const sent: [string, any][] = [];
  const life = new EventEmitter();
  let open: (chat: string) => unknown = () => undefined;
  let heard: (chat: string, event: any) => void = () => {};
  const factories: ((pi: any, chat: any) => void)[] = [];
  const offered = new Map<string, 'direct' | 'lazy' | undefined>();
  const given = {
    router: express.Router(),
    http: { json: express.json },
    dataDir: () => scratch('canvas-data-'),
    chats: {
      get: (id: string) => (['a', 'b'].includes(id) ? { id, title: id, workspace: '/w', status: 'idle' } : undefined),
      send: (chat: string, data: unknown) => sent.push([chat, data]),
      onOpen: (handler: typeof open) => void (open = handler),
      onEvent: (handler: typeof heard) => void (heard = handler),
      on: (event: string, handler: (chat: string) => void) => void life.on(event, handler),
      extend: (factory: (pi: any, chat: any) => void) => void factories.push(factory),
      offers: (chat: string) => offered.get(chat) ?? 'direct',
    },
  };
  const stop = canvas(given as any) as () => void;
  /** The chat's pi starting: the tools it was given. */
  const start = (chat: string) => {
    const tools: Record<string, any> = {};
    for (const factory of factories) factory({ registerTool: (tool: any) => (tools[tool.name] = tool) }, { id: chat });
    return tools;
  };
  return { sent, opened: (chat: string) => open(chat), heard: (chat: string, event: any) => heard(chat, event), life, start, stop };
}
const value = async (call: Promise<any>) => JSON.parse((await call).content[0].text);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a page that opens a chat is told its canvases first, and a write in progress is told at most every 250 ms, as its latest', async () => {
  const p = portal();
  try {
    const tools = p.start('a');
    const row = await value(tools.canvas_create.execute('create', { title: 'Plan' }));
    assert.deepEqual(p.opened('a'), { type: 'snapshot', canvases: [{ ...row, agent_read_revision: 0 }] });
    assert.deepEqual(p.opened('b'), { type: 'snapshot', canvases: [] }, 'each chat its own');
    assert.deepEqual(p.sent.map(([chat, m]) => [chat, m.type]), [['a', 'create']]);
    p.sent.length = 0;
    // The pieces of a write, as the model streams its arguments: only the latest goes, after a moment.
    const piece = (delta: string) => p.heard('a', { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta, partial: { content: [{ type: 'toolCall', name: 'canvas_write', id: 'w1' }] } } });
    piece(`{"canvas_id":"${row.id}","revision":0,"operation":"replace","content":"One`);
    piece(' two');
    piece(' three');
    assert.deepEqual(p.sent, [], 'held for a moment');
    await wait(320);
    assert.deepEqual(p.sent.map(([, m]) => [m.type, m.canvas.content]), [['update', 'One two three']]);
    // A change that is not an update sends what was held first, in order.
    p.sent.length = 0;
    piece(' four');
    const other = await value(tools.canvas_create.execute('create2', { title: 'Other' }));
    assert.deepEqual(p.sent.map(([, m]) => [m.type, m.canvas.title]), [['update', 'Plan'], ['create', 'Other']]);
    assert.equal(p.sent[0][1].canvas.content, 'One two three four');
    assert.ok(other.id);
  } finally {
    p.stop();
  }
});

test('the tools are a chat\'s own, a write is followed only by the chat that makes it, and a chat that goes takes its canvases', async () => {
  const p = portal();
  try {
    const a = p.start('a');
    p.start('b');
    const row = await value(a.canvas_create.execute('create', { title: 'Mine' }));
    // What chat b's pi says is not a write to a's canvas.
    p.heard('b', { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: `{"canvas_id":"${row.id}","revision":0,"operation":"replace","content":"Not b's`, partial: { content: [{ type: 'toolCall', name: 'canvas_write', id: 'x' }] } } });
    assert.deepEqual((await value(a.canvas_list.execute('list', {}))).map((c: any) => c.characters), [0]);
    // A write that a stop cut off keeps what came.
    p.heard('a', { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: `{"canvas_id":"${row.id}","revision":0,"operation":"replace","content":"Half`, partial: { content: [{ type: 'toolCall', name: 'canvas_write', id: 'w' }] } } });
    p.life.emit('stopped', 'a');
    const after = await value(p.start('a').canvas_read.execute('read', { canvas_id: row.id }));
    assert.equal(after.content, 'Half');
    assert.equal(after.status, 'interrupted');
    // Deleted: its canvases go, stored or not.
    p.life.emit('deleted', 'a');
    assert.deepEqual(p.opened('a'), { type: 'snapshot', canvases: [] });
  } finally {
    p.stop();
  }
});
