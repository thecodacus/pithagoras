import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The dialogs an extension opens with pi's ui calls (confirm, select, input, editor): they wait for a person
 * until they are answered, cancelled or stopped, with no time limit of their own (issue #114). Only a caller
 * that passes a `timeout` has one.
 */
inProcessHome("pithagoras-extension-dialogs-");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");

/** A client with nothing behind it but the bridge to the page, and the events it sends. */
function bridge() {
  const session = { abort: async () => {} };
  const client = new SdkPiClient(session, {}, () => {});
  const events = [];
  client.on("event", (e) => events.push(e));
  return { client, ui: client.buildUiContext(), events };
}
const closed = (events) => events.filter((e) => e.type === "extension_ui_cancel");
const FIVE_MINUTES = 5 * 60_000;

test("a dialog is still open long after the five minutes it used to be closed at, and answers when it is answered", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [method, open, answer] of [
    ["confirm", (ui) => ui.confirm("Sure?", "Really"), true],
    ["select", (ui) => ui.select("Pick", ["a", "b"]), "b"],
    ["input", (ui) => ui.input("Name", "type here"), "Ada"],
    ["editor", (ui) => ui.editor("Edit", "text"), "edited"],
  ]) {
    const { client, ui, events } = bridge();
    let result;
    const asked = open(ui).then((v) => { result = { v }; });
    const request = events.find((e) => e.type === "extension_ui_request");
    assert.equal(request.method, method);

    t.mock.timers.tick(FIVE_MINUTES + 1);
    t.mock.timers.tick(24 * 60 * 60_000);
    await Promise.resolve();
    assert.equal(result, undefined, `${method} is not settled by the passing of time`);
    assert.equal(client.dialogsOpen(), 1, `${method} is still waiting`);
    assert.deepEqual(closed(events), [], `${method} was not closed on the pages`);

    assert.equal(client.respondUi(request.id, { value: answer }), true);
    await asked;
    assert.deepEqual(result, { v: answer }, method);
    assert.equal(client.dialogsOpen(), 0);
  }
});

test("a dialog that waits still ends when it is cancelled or the run is stopped, with the value of no answer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { client, ui, events } = bridge();

  const refused = ui.confirm("Sure?", "Really");
  client.respondUi(events[0].id, { cancelled: true });
  assert.equal(await refused, false);
  assert.deepEqual(closed(events), [], "cancelled on a page: that page dropped it");

  const stop = new AbortController();
  const stopped = ui.select("Pick", ["a"], { signal: stop.signal });
  t.mock.timers.tick(FIVE_MINUTES * 2);
  assert.equal(client.dialogsOpen(), 1);
  stop.abort();
  assert.equal(await stopped, undefined);
  assert.deepEqual(closed(events).map((e) => e.id), [events[1].id], "the pages that show it close it");
  assert.equal(client.dialogsOpen(), 0);

  // Already stopped when it is asked: nothing is shown at all.
  assert.equal(await ui.confirm("Late?", "Too late", { signal: stop.signal }), false);
  assert.equal(events.filter((e) => e.type === "extension_ui_request").length, 2);
});

test("Stop closes every dialog of the run, also one that was opened without a signal", async () => {
  const { client, ui, events } = bridge();
  const asked = [ui.confirm("Sure?", "Really"), ui.editor("Edit", "text"), ui.questions({ questions: [{ id: "q1", question: "Pick", options: ["A"] }] })];
  const ids = events.filter((e) => e.type === "extension_ui_request").map((e) => e.id);
  assert.equal(client.dialogsOpen(), 3);
  await client.abort();
  assert.deepEqual(await Promise.all(asked), [false, undefined, undefined]);
  assert.deepEqual(closed(events).map((e) => e.id), ids);
  assert.equal(client.dialogsOpen(), 0);
  assert.deepEqual(client.openDialogRequests(), []);
});

test("a caller that names a wait gets it: the dialog closes as a timeout when it is up, and 0 is no wait", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { client, ui, events } = bridge();

  const timed = ui.input("Name", "", { timeout: 1000 });
  const forever = ui.confirm("Sure?", "Really", { timeout: 0 });
  t.mock.timers.tick(999);
  assert.equal(client.dialogsOpen(), 2, "not before its time");
  t.mock.timers.tick(1);
  assert.equal(await timed, undefined);
  assert.deepEqual(closed(events).map((e) => e.id), [events[0].id], "the pages that show it close it");

  t.mock.timers.tick(FIVE_MINUTES);
  assert.equal(client.dialogsOpen(), 1, "0 waits as the default does");
  client.respondUi(events[1].id, { value: true });
  assert.equal(await forever, true);
});

test("a dialog of every kind opened with no page attached is handed to a page that opens later, until it is settled", async () => {
  const { client, ui, events } = bridge();
  const stop = new AbortController();
  const asked = [
    ui.confirm("Sure?", "Really"),
    ui.select("Pick", ["a", "b"]),
    ui.input("Name", "type here"),
    ui.editor("Edit", "text"),
    ui.questions({ questions: [{ id: "q1", question: "Pick", options: ["A"] }] }),
    ui.confirm("Stopped?", "Later", { signal: stop.signal }),
  ];
  const sent = events.filter((e) => e.type === "extension_ui_request");
  assert.deepEqual(sent.map((e) => e.method), ["confirm", "select", "input", "editor", "questions", "confirm"]);
  // What a page attaching now is shown: every request as it was sent, under the same id.
  assert.deepEqual(client.openDialogRequests(), sent);

  // Answered and cancelled dialogs are gone from it, and so is one the run stopped.
  client.respondUi(sent[0].id, { value: true });
  client.respondUi(sent[1].id, { cancelled: true });
  stop.abort();
  await Promise.all([asked[0], asked[1], asked[5]]);
  assert.deepEqual(client.openDialogRequests(), sent.slice(2, 5));
  client.respondUi(sent[2].id, { value: "Ada" });
  client.respondUi(sent[3].id, { value: "x" });
  client.respondUi(sent[4].id, { value: {} });
  await Promise.all(asked);
  assert.deepEqual(client.openDialogRequests(), []);
});

test("a dialog waiting while no page is attached is replayed to a page that opens, and not once it is answered", async () => {
  const { default: express } = await import("express");
  const { eventsRouter } = await import("../dist/api/events.js");
  const { sessions } = await import("../dist/session-manager.js");
  const { createSession } = await import("../dist/db.js");
  createSession({ id: "confirming", title: "confirming", workspace: process.env.WORKSPACE_ROOT, executor: "host" });
  const { client, ui, events } = bridge();
  sessions.live.set("confirming", { client });
  const app = express().use("/api", eventsRouter());
  const server = app.listen(0);
  // What a fresh page is sent before the stream is caught up.
  const page = async () => {
    const abort = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/confirming/events`, { signal: abort.signal });
      let text = "";
      const reader = res.body.getReader();
      while (!text.includes("event: caught-up")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      const frames = text.split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)));
      return frames.filter((f) => f.type === "extension_ui_request");
    } finally {
      abort.abort();
    }
  };
  try {
    const answer = ui.confirm("Sure?", "Really");
    const picked = ui.select("Pick", ["a", "b"]);
    // The agent's questions are no dialog over the page: they are kept with the chat (see chat-questions.test.mjs).
    const asked = ui.questions({ title: "Setup", questions: [{ id: "q1", question: "Pick", kind: "single", options: [{ label: "A" }], other: false, optional: false }] });
    const sent = events.filter((e) => e.type === "extension_ui_request");
    const dialogs = sent.filter((e) => e.method !== "questions");
    assert.equal(dialogs.length, 2);
    const seen = await page();
    assert.deepEqual(seen.map((f) => f.payload), dialogs, "each as it was sent, under the id the answer comes back by");
    assert.ok(seen.every((f) => f.seq < 0), "live only: it never moves the page's cursor");

    client.respondUi(dialogs[0].id, { value: true });
    assert.equal(await answer, true);
    assert.deepEqual((await page()).map((f) => f.payload.id), [dialogs[1].id], "only the one still waiting");

    client.respondUi(dialogs[1].id, { cancelled: true });
    await picked;
    assert.deepEqual(await page(), []);
    client.respondUi(sent.find((e) => e.method === "questions").id, { cancelled: true });
    await asked;
  } finally {
    server.close();
    sessions.live.delete("confirming");
  }
});

test("a dialog in a chat someone is watching arms no timer at all, whatever the run's own limits are", async (t) => {
  const { client, ui, events } = bridge();
  const timers = t.mock.method(globalThis, "setTimeout");
  const asked = [ui.confirm("Sure?", "Really"), ui.select("Pick", ["a"]), ui.input("Name", ""), ui.editor("Edit", "x")];
  assert.equal(timers.mock.callCount(), 0, "nothing counts the wait down");
  assert.equal(client.dialogsOpen(), 4);
  for (const e of events.filter((e) => e.type === "extension_ui_request")) client.respondUi(e.id, { cancelled: true });
  await Promise.all(asked);
});
