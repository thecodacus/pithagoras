import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedInput } from '../src/text.ts';

/** A send whose completion the test decides, so that keys can be typed while one is out. */
function held() {
  const sent: string[] = [];
  const pending: { resolve: () => void; reject: (e: Error) => void }[] = [];
  const send = (data: string) =>
    new Promise<void>((resolve, reject) => {
      sent.push(data);
      pending.push({ resolve, reject });
    });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const finish = async () => { pending.shift()!.resolve(); await tick(); };
  const fail = async () => { pending.shift()!.reject(new Error('gone')); await tick(); };
  return { sent, send, finish, fail };
}

test('keys typed while one is out wait, and go together in the order typed', async () => {
  const h = held();
  const type = orderedInput(h.send, () => {});
  for (const key of 'echo') type(key);
  assert.deepEqual(h.sent, ['e'], 'one request at a time');
  await h.finish();
  assert.deepEqual(h.sent, ['e', 'cho']);
  await h.finish();
  type('\r');
  assert.deepEqual(h.sent, ['e', 'cho', '\r'], 'with nothing out, a key goes at once');
});

test('a request that fails is reported, and what was typed after it is still sent', async () => {
  const h = held();
  let failures = 0;
  const type = orderedInput(h.send, () => failures++);
  type('a');
  type('b');
  await h.fail();
  assert.equal(failures, 1);
  assert.deepEqual(h.sent, ['a', 'b']);
  await h.finish();
  type('c');
  assert.deepEqual(h.sent, ['a', 'b', 'c']);
});
