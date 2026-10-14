import { test } from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// What a page is sent when it opens a chat's event stream or scrolls back in it:
// the stored text as it is, every event once and in order however long the
// catching up, and nothing piled up in the server for a reader that is slow.

const home = inProcessHome("pithagoras-events-");

const { default: express } = await import("express");
const { appendEvent, atomically, createSession, eventsSince, getDb } = await import("../dist/db.js");
const { eventJson, replaySince } = await import("../dist/event-replay.js");
const { eventsRouter } = await import("../dist/api/events.js");
const { sessions } = await import("../dist/session-manager.js");

test.after(() => getDb().close());

test("an event is its stored text, put in place as it is", () => {
  const payload = '{"n":1.0,"text":"a\\nb","big":[1e3]}';
  const frame = eventJson({ seq: 7, type: "message_end", payload, created_at: "2026-10-03T10:00:00.000Z" });
  assert.ok(frame.includes(`"payload":${payload}}`), "not parsed and written out again");
  assert.deepEqual(JSON.parse(frame), { seq: 7, type: "message_end", at: Date.parse("2026-10-03T10:00:00.000Z"), payload: { n: 1, text: "a\nb", big: [1000] } });
  // No time, no "at": a live event that was never stored has one all the same, and an old row may not.
  assert.deepEqual(JSON.parse(eventJson({ seq: -1, type: "x", payload: "{}" })), { seq: -1, type: "x", payload: {} });
});

createSession({ id: "long", title: "long", workspace: home, executor: "host" });
const seqs = Array.from({ length: 10 }, (_, i) => appendEvent("long", "portal_notice", { n: i }).seq);

test("everything stored is delivered in order, a page of the size it was asked for at a time", async () => {
  const seen = [];
  const result = await replaySince("long", 0, (row) => (seen.push(row.seq), true), 3);
  assert.deepEqual(seen, seqs);
  assert.deepEqual(result, { lastSent: seqs.at(-1), gone: false });
  // Exactly a page's worth is not the end: one more is asked for.
  assert.equal((await replaySince("long", seqs[6], () => true, 3)).lastSent, seqs.at(-1));
  assert.deepEqual((await replaySince("long", seqs.at(-1), () => true, 3)), { lastSent: seqs.at(-1), gone: false });
});

test("the other streams get their turn between pages", async () => {
  const order = [];
  setImmediate(() => order.push("another stream"));
  await replaySince("long", 0, (row) => (order.push(row.seq), true), 3);
  const at = order.indexOf("another stream");
  assert.ok(at > 0 && at < order.length - 1, `in the middle of the replay: ${order.join(",")}`);
});

test("a reader that is waited for is waited for in order, and one that has gone ends the replay", async () => {
  const slow = [];
  await replaySince("long", 0, async (row) => (await new Promise((r) => setTimeout(r, 1)), slow.push(row.seq), true), 4);
  assert.deepEqual(slow, seqs);

  const some = [];
  const result = await replaySince("long", 0, (row) => (some.push(row.seq), some.length < 4), 3);
  assert.deepEqual(some, seqs.slice(0, 4), "not one more once it had gone");
  assert.equal(result.gone, true);
  const asked = [];
  assert.deepEqual((await replaySince("long", 0, (row) => (asked.push(row.seq), new Promise((r) => setTimeout(() => r(false), 1))), 3)).gone, true);
  assert.equal(asked.length, 1);
});

/** The stream of a chat, as a page reads it: what arrived, in frames. */
function open(app, url, onResponse) {
  const server = app.listen(0);
  const port = server.address().port;
  const frames = [];
  let rest = "";
  const request = get(`http://127.0.0.1:${port}${url}`, (res) => {
    onResponse?.(res);
    res.on("data", (chunk) => {
      rest += chunk;
      let end;
      while ((end = rest.indexOf("\n\n")) >= 0) {
        frames.push(rest.slice(0, end));
        rest = rest.slice(end + 2);
      }
    });
  });
  request.on("error", () => {});
  return { frames, close: () => { request.destroy(); server.close(); }, server };
}
const dataOf = (frames) => frames.filter((f) => f.includes("data: {\"seq\"")).map((f) => JSON.parse(f.slice(f.indexOf("data: ") + 6)));

async function until(check, what) {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("a page that catches up on a long run slowly is not buffered whole, loses nothing and sees what happened meanwhile once", async () => {
  createSession({ id: "run", title: "run", workspace: home, executor: "host" });
  const filler = "x".repeat(5000);
  const stored = atomically(() => Array.from({ length: 6000 }, (_, i) => appendEvent("run", "portal_notice", { i, filler }).seq));
  const app = express();
  let held;
  app.use((req, res, next) => ((held ??= res), next()));
  app.use("/api", eventsRouter());
  let response;
  const stream = open(app, "/api/sessions/run/events?since=1", (res) => {
    response = res;
    // A reader that has stopped reading: what the server writes has nowhere to go.
    res.pause();
  });
  try {
    await until(() => response, "the stream to open");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(held.writableLength < 10_000_000, `waiting on the reader, not buffering ${held.writableLength} bytes`);

    // Said while the replay waits: a notice that is kept, a model being loaded
    // that is only ever live, and a word of an answer that the snapshot holds.
    const live = sessions.record("run", "portal_notice", { text: "meanwhile" });
    sessions.record("run", "portal_model", { loading: true });
    sessions.record("run", "message_update", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hel", contentIndex: 0 } });
    response.resume();
    await until(() => stream.frames.some((f) => f.startsWith("event: caught-up")), "the replay to end");
    // Let what waited behind it go out.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const events = dataOf(stream.frames);
    const seen = events.filter((e) => e.type === "portal_notice").map((e) => e.seq);
    assert.deepEqual(seen, [...stored.filter((s) => s > 1), live.seq], "all of it, once each and in order, what happened meanwhile at the end");
    assert.equal(events.filter((e) => e.type === "message_update").length, 0, "not said again after the snapshot that holds it");
    assert.equal(events.filter((e) => e.type === "message_snapshot").length, 1);
    const caughtUp = stream.frames.findIndex((f) => f.startsWith("event: caught-up"));
    const model = stream.frames.findIndex((f) => f.includes('"type":"portal_model"'));
    assert.ok(model > caughtUp, "what is only live is let through once the page has caught up");
    assert.equal(events.filter((e) => e.type === "portal_model").length, 1);
  } finally {
    stream.close();
  }
});

test("a page that leaves between two pages of the replay leaves nothing waiting for it", async () => {
  createSession({ id: "left", title: "left", workspace: home, executor: "host" });
  atomically(() => Array.from({ length: 5200 }, (_, i) => appendEvent("left", "portal_notice", { i })));
  const app = express();
  let held;
  let drainBefore;
  let notices = 0;
  app.use((req, res, next) => {
    held = res;
    drainBefore = res.listenerCount("drain");
    const write = res.write.bind(res);
    // The last event of the first page is the last write before the replay looks for the next page.
    res.write = (chunk, ...rest) => {
      const result = write(chunk, ...rest);
      if (String(chunk).includes("portal_notice") && ++notices === 5000) res.destroy();
      return result;
    };
    next();
  });
  app.use("/api", eventsRouter());
  const stream = open(app, "/api/sessions/left/events?since=1");
  try {
    await until(() => notices >= 5000, "the first page to go out");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(notices, 5000, "not a row more to a page that has gone");
    assert.equal(held.listenerCount("drain"), drainBefore, "no wait for a drain that cannot come");
  } finally {
    stream.close();
  }
});

test("scrolling back answers with the stored text too, and with the page it was asked for", async () => {
  const app = express();
  app.use("/api", eventsRouter());
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/long/events/before?before=${seqs[8]}&limit=3`);
    const body = await res.json();
    assert.deepEqual(body.events.map((e) => e.seq), [seqs[5], seqs[6], seqs[7]]);
    assert.deepEqual(body.events[0].payload, { n: 5 });
    assert.equal(body.more, true);
    assert.equal(typeof body.events[0].at, "number");
    const all = await (await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/long/events/before?before=${seqs[8]}`)).json();
    assert.equal(all.more, false, "fewer than its limit: nothing further back");
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/nobody/events/before`)).status, 404);
  } finally {
    server.close();
  }
});
