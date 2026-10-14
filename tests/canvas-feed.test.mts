import { test } from "node:test";
import assert from "node:assert/strict";
import { canvasConnection, canvasMessage, watchCanvases, type CanvasMessage, type FeedState } from "../core/web/src/canvas-feed.ts";

function watcher() {
  const heard: CanvasMessage[] = [];
  const states: FeedState[] = [];
  return { heard, states, watcher: { message: (m: CanvasMessage) => heard.push(m), state: (s: FeedState) => states.push(s) } };
}

const doc = (id: string, title = id) => ({ id, title });

test("a panel drawn after the list came has it, with every change since", () => {
  // The stream sends the whole list first, and the panel was drawn after it:
  // it asked for the same list again, every canvas twice.
  canvasConnection("one", "up");
  canvasMessage("one", { type: "snapshot", canvases: [doc("a"), doc("b")] });
  canvasMessage("one", { type: "update", canvas: doc("b", "B, edited") });
  canvasMessage("one", { type: "create", canvas: doc("c") });
  canvasMessage("one", { type: "delete", id: "a" });

  const late = watcher();
  const stop = watchCanvases("one", late.watcher);
  assert.deepEqual(late.states, ["up"]);
  assert.deepEqual(late.heard, [{ type: "snapshot", canvases: [doc("c"), doc("b", "B, edited")] }]);
  stop();
});

test("a panel hears the stream connecting, up and down; one that fails forgets the list", () => {
  const w = watcher();
  const stop = watchCanvases("two", w.watcher);
  assert.deepEqual(w.states, ["down"]);
  canvasConnection("two", "connecting");
  canvasConnection("two", "up");
  canvasMessage("two", { type: "snapshot", canvases: [doc("a")] });
  assert.deepEqual(w.states, ["down", "connecting", "up"]);

  // Down: what it left may since have changed unheard, so it is not offered.
  canvasConnection("two", "down");
  const after = watcher();
  watchCanvases("two", after.watcher)();
  assert.deepEqual(after.states, ["down"]);
  assert.deepEqual(after.heard, []);
  stop();
});

test("changes heard before any list are not made into one", () => {
  canvasConnection("three", "up");
  canvasMessage("three", { type: "update", canvas: doc("a") });
  const w = watcher();
  watchCanvases("three", w.watcher)();
  assert.deepEqual(w.heard, []);
});
