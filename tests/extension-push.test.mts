import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { forgetPushes, listenTopic } from '../core/web/src/extensions/push.ts';

/**
 * What an extension's browser half hears of the topics its server half pushes (`portal.server.on(topic, handler)`):
 * one stream for the page that is kept for as long as something listens, a topic asked for on it, and asked for again
 * when the stream drops or the server half has stopped.
 */

class FakeSource {
  static all: FakeSource[] = [];
  url: string;
  closed = false;
  listeners: Record<string, ((e: { data: string }) => void)[]> = {};
  constructor(url: string) {
    this.url = url;
    FakeSource.all.push(this);
  }
  addEventListener(name: string, fn: (e: { data: string }) => void) {
    (this.listeners[name] ??= []).push(fn);
  }
  close() {
    this.closed = true;
  }
  emit(name: string, data: unknown) {
    for (const fn of this.listeners[name] ?? []) fn({ data: JSON.stringify(data) });
  }
}

interface Post { url: string; body: any }
let posts: Post[] = [];
/** What the server answers to an ask: by default it lets the page listen. */
let answer: (post: Post) => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true } });

beforeEach(() => {
  FakeSource.all = [];
  posts = [];
  answer = () => ({ status: 200, body: { ok: true } });
  (globalThis as any).EventSource = FakeSource;
  (globalThis as any).window = { dispatchEvent() {} };
  (globalThis as any).fetch = async (url: string, init: RequestInit) => {
    const post = { url, body: JSON.parse(String(init.body)) };
    posts.push(post);
    const { status, body } = answer(post);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const live = () => FakeSource.all.filter((s) => !s.closed);
/** A topic that nobody listens to any more is left after the tick it was let go in: waited for, and what it sent. */
const afterTick = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await settle();
};
/** The asks and leaves for a topic, without the page's name for each. */
const named = (list: Post[]) => list.map((p) => ({ extension: p.body.extension, topic: p.body.topic }));
/** The stream is open and says which it is. */
async function ready(source: FakeSource, id = 's1') {
  source.emit('ready', { stream: id });
  await settle();
}
const push = (source: FakeSource, extension: string, topic: string, data: unknown) => source.emit('push', { extension, topic, data });

test('a topic is asked for on the page\'s one stream, and what is pushed to it is heard, and nothing of another topic or extension', async () => {
  const heard: unknown[] = [];
  const off = listenTopic('ext-a', 'folders', (data) => heard.push(data));
  const other: unknown[] = [];
  const offOther = listenTopic('ext-a', 'doc/1', (data) => other.push(data));
  assert.equal(live().length, 1, 'one stream for both topics');
  assert.equal(live()[0].url, '/api/pushes');
  await ready(live()[0]);
  assert.deepEqual(posts.map((p) => p.url), ['/api/pushes/s1/listen', '/api/pushes/s1/listen']);
  assert.deepEqual(named(posts), [{ extension: 'ext-a', topic: 'folders' }, { extension: 'ext-a', topic: 'doc/1' }]);
  assert.notEqual(posts[0].body.token, posts[1].body.token, 'each ask has a name of its own');
  push(live()[0], 'ext-a', 'folders', { version: 'x' });
  push(live()[0], 'ext-b', 'folders', 'not ours');
  push(live()[0], 'ext-a', 'doc/2', 'not asked for');
  push(live()[0], 'ext-a', 'doc/1', 7);
  assert.deepEqual(heard, [{ version: 'x' }]);
  assert.deepEqual(other, [7]);
  off();
  offOther();
  await afterTick();
});

test('several listeners to one topic ask once, and the server is told only when the last has gone, which also lets the stream go', async () => {
  const off1 = listenTopic('ext-a', 't', () => {});
  const off2 = listenTopic('ext-a', 't', () => {});
  await ready(live()[0]);
  assert.equal(posts.filter((p) => p.url.endsWith('/listen')).length, 1);
  off1();
  await afterTick();
  assert.equal(posts.filter((p) => p.url.endsWith('/leave')).length, 0);
  assert.equal(live().length, 1);
  off2();
  await afterTick();
  const leaves = posts.filter((p) => p.url.endsWith('/leave'));
  assert.deepEqual(named(leaves), [{ extension: 'ext-a', topic: 't' }]);
  assert.equal(leaves[0].body.token, posts[0].body.token, 'it names the ask it ends');
  assert.equal(live().length, 0, 'no stream is kept for nobody');
});

test('a handler that throws does not keep the others from hearing', async () => {
  const quiet = mock.method(console, 'error', () => {});
  const heard: unknown[] = [];
  const off1 = listenTopic('ext-a', 't', () => { throw new Error('its own'); });
  const off2 = listenTopic('ext-a', 't', (data) => heard.push(data));
  await ready(live()[0]);
  push(live()[0], 'ext-a', 't', 1);
  assert.deepEqual(heard, [1]);
  assert.equal(quiet.mock.callCount(), 1);
  quiet.mock.restore();
  off1();
  off2();
  await afterTick();
});

test('a stream that drops is opened again after a wait, longer each time, and every topic is asked for again on the new one', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const off = listenTopic('ext-a', 't', () => {});
    await ready(live()[0]);
    live()[0].emit('error', {});
    assert.equal(live().length, 0);
    mock.timers.tick(1999);
    assert.equal(live().length, 0, 'not at once');
    mock.timers.tick(1);
    assert.equal(live().length, 1);
    live()[0].emit('error', {});
    mock.timers.tick(3999);
    assert.equal(live().length, 0, 'twice as long the second time');
    mock.timers.tick(1);
    await ready(live()[0], 's2');
    assert.deepEqual(posts.map((p) => p.url), ['/api/pushes/s1/listen', '/api/pushes/s2/listen']);
    // A stream that is back is waited for from the start again.
    live()[0].emit('error', {});
    mock.timers.tick(2000);
    assert.equal(live().length, 1);
    off();
    mock.timers.tick(1);
  } finally {
    mock.timers.reset();
  }
});

test('a topic whose server half has stopped is asked for again until it is back; one the server refuses is not asked for again', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const warned = mock.method(console, 'warn', () => {});
  try {
    const off = listenTopic('ext-a', 'gone', () => {});
    const offNo = listenTopic('ext-a', 'secret', () => {});
    let running = false;
    answer = (post) => {
      if (post.body.topic === 'secret') return { status: 403, body: { error: 'That topic is not for this page', code: 'refused' } };
      return running ? { status: 200, body: { ok: true } } : { status: 404, body: { error: 'stopped', code: 'not-running' } };
    };
    await ready(live()[0]);
    assert.equal(posts.length, 2);
    mock.timers.tick(2000);
    await settle();
    assert.equal(posts.filter((p) => p.body.topic === 'gone').length, 2, 'asked again after a wait');
    mock.timers.tick(4000);
    await settle();
    assert.equal(posts.filter((p) => p.body.topic === 'gone').length, 3);
    running = true;
    mock.timers.tick(8000);
    await settle();
    assert.equal(posts.filter((p) => p.body.topic === 'gone').length, 4);
    mock.timers.tick(60_000);
    await settle();
    assert.equal(posts.filter((p) => p.body.topic === 'gone').length, 4, 'heard now: not asked for again');
    assert.equal(posts.filter((p) => p.body.topic === 'secret').length, 1, 'refused: not asked for again');
    assert.equal(warned.mock.callCount(), 1);
    // The server half stopped and was started again (it says so): asked for again.
    live()[0].emit('lost', { extension: 'ext-a', topic: 'gone' });
    mock.timers.tick(2000);
    await settle();
    assert.equal(posts.filter((p) => p.body.topic === 'gone').length, 5);
    off();
    offNo();
    mock.timers.tick(1);
  } finally {
    warned.mock.restore();
    mock.timers.reset();
  }
});

test('an extension taken out of the page listens to nothing any more', async () => {
  const heard: unknown[] = [];
  const keptOther: unknown[] = [];
  listenTopic('ext-a', 't', (data) => heard.push(data));
  const offOther = listenTopic('ext-b', 't', (data) => keptOther.push(data));
  await ready(live()[0]);
  forgetPushes('ext-a');
  await settle();
  assert.deepEqual(named(posts.filter((p) => p.url.endsWith('/leave'))), [{ extension: 'ext-a', topic: 't' }]);
  push(live()[0], 'ext-a', 't', 1);
  push(live()[0], 'ext-b', 't', 2);
  assert.deepEqual(heard, []);
  assert.deepEqual(keptOther, [2]);
  offOther();
  await afterTick();
});

test('a stream the server let go of is opened anew, with every topic asked for on it', async () => {
  const off = listenTopic('ext-a', 't', () => {});
  answer = (post) => (post.url.includes('/s1/') ? { status: 404, body: { error: 'gone', code: 'no-stream' } } : { status: 200, body: { ok: true } });
  const first = live()[0];
  await ready(first);
  assert.equal(first.closed, true);
  assert.equal(live().length, 1);
  await ready(live()[0], 's2');
  assert.deepEqual(posts.map((p) => p.url), ['/api/pushes/s1/listen', '/api/pushes/s2/listen']);
  off();
  await afterTick();
});

test('a topic let go of and listened to again in the same tick is asked for anew, not left first: no leave can overtake the ask', async () => {
  const first: unknown[] = [];
  const second: unknown[] = [];
  const off1 = listenTopic('ext-a', 'folders', (data) => first.push(data));
  await ready(live()[0]);
  assert.equal(posts.length, 1);
  // A page that follows what is open does this on every change: its effect stops and begins again at once.
  off1();
  const off2 = listenTopic('ext-a', 'folders', (data) => second.push(data));
  await afterTick();
  assert.deepEqual(posts.map((p) => p.url), ['/api/pushes/s1/listen', '/api/pushes/s1/listen'], 'asked anew, so it is told where things stand');
  assert.notEqual(posts[0].body.token, posts[1].body.token);
  assert.equal(live().length, 1, 'the stream is kept');
  push(live()[0], 'ext-a', 'folders', 'now');
  assert.deepEqual([first, second], [[], ['now']], 'only the listener that is there hears it');
  off2();
  await afterTick();
  const leaves = posts.filter((p) => p.url.endsWith('/leave'));
  assert.equal(leaves.length, 1, 'left once, when nobody is left');
  assert.equal(leaves[0].body.token, posts[1].body.token, 'naming the ask that is the listening');
});
