import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

const home = inProcessHome("pithagoras-notify-");

const { createSession, eventsSince } = await import("../dist/db.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { sessions } = await import("../dist/session-manager.js");

class FakePi extends EventEmitter {
  running = true;
  async abort() {}
  dispose() {}
}
let pi;
SdkPiClient.create = async () => (pi = new FakePi());

const notify = (message, notifyType) => ({ type: "extension_ui_request", id: `n-${Math.random()}`, method: "notify", message, notifyType });

test("what an extension says with notify stays in the chat, and is the answer a channel hears", async () => {
  // /bg-update answers only with a notify: pi prints it, the portal showed nothing.
  createSession({ id: "update", title: "update", workspace: home, executor: "host" });
  sessions.submit = async (id, message) => {
    // The command's line, as submit writes it: what is said while it is in hand is its answer.
    const command = sessions.startCommand(id, message);
    setImmediate(() => {
      pi.emit("event", notify("\x1b[1mpi-background-tasks 2.6.2 is installed; 2.6.5 is the latest.\x1b[0m\n  pi install npm:pi-background-tasks@latest", "info"));
      pi.emit("event", notify("Disk almost full", "warning"));
      pi.emit("event", notify("   ", "info"));
      sessions.endCommand(id, command, { outcome: "handled" });
      pi.emit("event", { type: "agent_settled" });
    });
  };
  const reply = await sessions.ask("update", "/bg-update", { streamText: false });

  const rows = eventsSince("update").map((r) => ({ type: r.type, payload: JSON.parse(r.payload) }));
  const of = eventsSince("update").find((r) => r.type === "portal_command").seq;
  assert.deepEqual(rows.filter((r) => r.type === "portal_notice").map((r) => r.payload), [
    { text: "pi-background-tasks 2.6.2 is installed; 2.6.5 is the latest.\n  pi install npm:pi-background-tasks@latest", from: "extension", command: of },
    { text: "Disk almost full", warning: true, from: "extension", command: of },
  ]);
  assert.equal(rows.filter((r) => r.type === "extension_ui_request").length, 0, "the request itself is still not stored");
  assert.match(reply, /2\.6\.5 is the latest/);
});

test("what an extension says that is not for a channel's command stays in the chat, and is not sent to the channel", async () => {
  // A message from a channel starts a run; meanwhile another extension's job finishes, and a handler fails.
  createSession({ id: "news", title: "news", workspace: home, executor: "host" });
  sessions.submit = async () => {
    setImmediate(() => {
      pi.emit("event", { type: "agent_start" });
      pi.emit("event", notify("job 3 finished", "info"));
      pi.emit("event", { type: "extension_error", extensionPath: "/x/node_modules/pkg-other/index.js", error: "bad" });
      pi.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello there" } });
      pi.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello there" }] } });
      pi.emit("event", { type: "agent_settled" });
    });
  };
  const reply = await sessions.ask("news", "Say hello", { streamText: false });
  assert.equal(reply, "Hello there");
  const notices = eventsSince("news").filter((r) => r.type === "portal_notice").map((r) => JSON.parse(r.payload).text);
  assert.deepEqual(notices, ["job 3 finished", "pkg-other failed: bad"]);
});

test("a status line or a widget that lands in the middle of a reply does not cut it", async () => {
  // An extension refreshes its status on its own clock, whatever the model is writing.
  const ui = (method, extra) => ({ type: "extension_ui_request", id: `u-${Math.random()}`, method, ...extra });
  const delta = (text) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
  sessions.submit = async () => {
    setImmediate(() => {
      pi.emit("event", { type: "agent_start" });
      pi.emit("event", delta("Hello wor"));
      pi.emit("event", ui("setStatus", { statusKey: "background-tasks", statusText: "0 tasks" }));
      pi.emit("event", delta("ld, and "));
      pi.emit("event", ui("setWidget", { widgetKey: "background-tasks", widgetContent: [] }));
      pi.emit("event", ui("notify", { message: "   ", notifyType: "info" }));
      pi.emit("event", delta("goodbye"));
      pi.emit("event", ui("setTitle", { title: "t" }));
      pi.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello world, and goodbye" }] } });
      pi.emit("event", { type: "agent_settled" });
    });
  };
  createSession({ id: "refresh", title: "refresh", workspace: home, executor: "host" });
  assert.equal(await sessions.ask("refresh", "Say hello", { streamText: false }), "Hello world, and goodbye", "as one answer");

  // A channel that relays progress posts each piece as a message of its own.
  createSession({ id: "refresh-live", title: "refresh-live", workspace: home, executor: "host" });
  const pieces = [];
  await sessions.ask("refresh-live", "Say hello", { onReply: (line) => pieces.push(line), streamText: true });
  assert.deepEqual(pieces, ["Hello world, and goodbye"], "relayed as one piece");
});

test("a question an extension asks still ends the text before it", async () => {
  createSession({ id: "question", title: "question", workspace: home, executor: "host" });
  const asked = [];
  sessions.submit = async () => {
    setImmediate(() => {
      pi.emit("event", { type: "agent_start" });
      pi.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Before the question" } });
      pi.emit("event", { type: "extension_ui_request", id: "q1", method: "confirm", title: "Go on?", message: "" });
      pi.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "After it" } });
      pi.emit("event", { type: "message_end", message: { role: "assistant", content: [] } });
      pi.emit("event", { type: "agent_settled" });
    });
  };
  const reply = await sessions.ask("question", "go", { streamText: false, onUi: (r) => asked.push(r.method) });
  assert.equal(reply, "Before the question\n\nAfter it");
  assert.deepEqual(asked, ["confirm"]);
});
