import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

const { PiRpcClient } = await import("../dist/pi/rpc-client.js");

/** A pi that is not there: what the client writes is kept, and `say` is pi answering. */
function fakePi() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const sent = [];
  child.stdin = new Writable({
    write(chunk, _enc, done) {
      sent.push(JSON.parse(chunk.toString()));
      done();
    },
  });
  const client = new PiRpcClient(child);
  return {
    client,
    sent,
    async say(message) {
      child.stdout.write(JSON.stringify(message) + "\n");
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

/** What a promise came to, without waiting for it: pending, or its value, or its error's message. */
function watch(promise) {
  const state = { done: false, value: undefined, error: undefined };
  promise.then(
    (v) => Object.assign(state, { done: true, value: v }),
    (e) => Object.assign(state, { done: true, error: e.message }),
  );
  return state;
}

test("compact and reload are given half an hour to answer, as pi answers them when the work is done", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    for (const command of ["compact", "reload"]) {
      const pi = fakePi();
      const run = watch(pi.client[command]());
      assert.equal(pi.sent.at(-1).type, command);
      // Past the 30 seconds of the other commands: pi is still summarising, or reading.
      mock.timers.tick(31_000);
      mock.timers.tick(10 * 60_000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(run.done, false, `${command} was given up on`);
      await pi.say({ id: pi.sent.at(-1).id, type: "response", command, success: true });
      assert.equal(run.done, true);
      assert.equal(run.error, undefined);
    }
  } finally {
    mock.timers.reset();
  }
});

test("a command that never answers is still given up on: after 30 seconds, and for compact after half an hour", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pi = fakePi();
    const state = watch(pi.client.getState());
    mock.timers.tick(30_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(state.error, /'get_state' timed out after 30000ms/);

    const compact = watch(pi.client.compact());
    mock.timers.tick(29 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(compact.done, false);
    mock.timers.tick(60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(compact.error, /'compact' timed out after 1800000ms/);
  } finally {
    mock.timers.reset();
  }
});

test("the stats have a context usage, also when pi leaves it out", async () => {
  const pi = fakePi();
  const left = watch(pi.client.getStats());
  await pi.say({ id: pi.sent.at(-1).id, type: "response", success: true, data: { tokens: { input: 1, output: 2, total: 3 }, cost: 0, toolCalls: 0, totalMessages: 0 } });
  assert.deepEqual(left.value.contextUsage, { tokens: null, contextWindow: 0, percent: null });
  assert.deepEqual(left.value.tokens, { input: 1, output: 2, total: 3 });

  const given = { tokens: 10, contextWindow: 100, percent: 10 };
  const kept = watch(pi.client.getStats());
  await pi.say({ id: pi.sent.at(-1).id, type: "response", success: true, data: { contextUsage: given } });
  assert.deepEqual(kept.value.contextUsage, given);

  // No data at all.
  const none = watch(pi.client.getStats());
  await pi.say({ id: pi.sent.at(-1).id, type: "response", success: true });
  assert.deepEqual(none.value.contextUsage, { tokens: null, contextWindow: 0, percent: null });
});
