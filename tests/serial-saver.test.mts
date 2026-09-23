import test from 'node:test';
import assert from 'node:assert/strict';
import { serialSaver } from '../web/src/serial-saver.ts';

/** A save whose completion the test decides, so that moves can be made while it is out. */
function held() {
  const sent: string[] = [];
  const pending: (() => void)[] = [];
  const save = (v: string) => new Promise<void>((resolve) => { sent.push(v); pending.push(resolve); });
  const finish = async () => { pending.shift()!(); await new Promise((r) => setTimeout(r, 0)); };
  return { sent, save, finish };
}

test('the last value asked for is the one saved last: low, high, low', async () => {
  const h = held();
  const s = serialSaver(h.save);
  const done = s.request('low');
  await s.request('high');
  await s.request('low');
  assert.deepEqual(h.sent, ['low'], 'nothing else is sent while a save is out');
  await h.finish();
  await done;
  assert.deepEqual(h.sent, ['low'], 'the waiting value is the one just saved, so nothing more');
});

test('a different value picked meanwhile is sent once the save returns, and only the last of several', async () => {
  const h = held();
  const s = serialSaver(h.save);
  const done = s.request('low');
  await s.request('medium');
  await s.request('high');
  await h.finish();
  assert.deepEqual(h.sent, ['low', 'high']);
  await h.finish();
  await done;
  assert.equal(s.busy, false);
});

test('the same value asked for again while it is being saved is not sent twice', async () => {
  const h = held();
  const s = serialSaver(h.save);
  const done = s.request('high');
  await s.request('high'); await s.request('high');
  await h.finish(); await done;
  assert.deepEqual(h.sent, ['high']);
});

test('busy stays true until the last save and what follows it are done', async () => {
  const h = held();
  let settledCalls = 0;
  const s = serialSaver(h.save, async () => { settledCalls++; });
  const done = s.request('a');
  assert.equal(s.busy, true);
  await s.request('b');
  await h.finish();
  assert.equal(s.busy, true, 'b is still out');
  await h.finish(); await done;
  assert.equal(s.busy, false);
  assert.equal(settledCalls, 1, 'once, after the last save');
});

test('a failed save frees the saver and the error reaches the one that started it', async () => {
  const s = serialSaver(async () => { throw new Error('server said no'); });
  await assert.rejects(s.request('x'), /server said no/);
  assert.equal(s.busy, false);
  const ok: string[] = [];
  const again = serialSaver(async (v: string) => { ok.push(v); });
  await again.request('y');
  assert.deepEqual(ok, ['y']);
});
