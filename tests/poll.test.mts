import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { pollWhileVisible, reconnectDelay, type Visibility } from "../core/web/src/poll.ts";

function fakeDocument() {
  const listeners = new Set<() => void>();
  const doc = {
    hidden: false,
    addEventListener: (_: "visibilitychange", l: () => void) => void listeners.add(l),
    removeEventListener: (_: "visibilitychange", l: () => void) => void listeners.delete(l),
  } satisfies Visibility;
  return {
    doc,
    listeners,
    set(hidden: boolean) {
      doc.hidden = hidden;
      listeners.forEach((l) => l());
    },
  };
}

test("ticks on the interval while the page is visible", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const { doc } = fakeDocument();
    let n = 0;
    const stop = pollWhileVisible(() => n++, 1000, doc);
    mock.timers.tick(3000);
    assert.equal(n, 3);
    stop();
  } finally {
    mock.timers.reset();
  }
});

test("stops while hidden, and asks at once when it comes back", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const page = fakeDocument();
    let n = 0;
    const stop = pollWhileVisible(() => n++, 1000, page.doc);
    mock.timers.tick(1000);
    assert.equal(n, 1);
    page.set(true);
    mock.timers.tick(60_000);
    assert.equal(n, 1, "nothing while hidden");
    page.set(false);
    assert.equal(n, 2, "one right away");
    mock.timers.tick(1000);
    assert.equal(n, 3, "and then on the interval again");
    stop();
  } finally {
    mock.timers.reset();
  }
});

test("a page that starts hidden does not poll until it is shown", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const page = fakeDocument();
    page.doc.hidden = true;
    let n = 0;
    const stop = pollWhileVisible(() => n++, 1000, page.doc);
    mock.timers.tick(5000);
    assert.equal(n, 0);
    page.set(false);
    assert.equal(n, 1);
    stop();
  } finally {
    mock.timers.reset();
  }
});

test("the stop function ends the polling and lets go of the listener", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const page = fakeDocument();
    let n = 0;
    const stop = pollWhileVisible(() => n++, 1000, page.doc);
    stop();
    assert.equal(page.listeners.size, 0);
    mock.timers.tick(5000);
    assert.equal(n, 0);
  } finally {
    mock.timers.reset();
  }
});

test("reconnecting waits longer after each failure, up to a limit", () => {
  assert.equal(reconnectDelay(1), 2000);
  assert.equal(reconnectDelay(2), 4000);
  assert.equal(reconnectDelay(3), 8000);
  assert.equal(reconnectDelay(4), 15_000);
  assert.equal(reconnectDelay(50), 15_000);
});

test("no failures yet is the shortest wait, not a negative one", () => {
  assert.equal(reconnectDelay(0), 2000);
});
