import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// What a channel package gets beyond words: pictures sent with a message reach
// the agent, a picture the agent shows goes back out, and a code the package
// needs scanned is on the channel's page while it waits for it.

const home = inProcessHome("pithagoras-channel-pictures-");

const { createSession, findChannelSession, getDb } = await import("../dist/db.js");
const { channelSupervisor } = await import("../dist/channels/supervisor.js");
const { IMAGE_ROOT, sessions } = await import("../dist/session-manager.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");

getDb().prepare("INSERT INTO channels (id, slug, kind, name, config) VALUES ('c1', 'sig', 'test', 'Test', '{}')").run();

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);

class FakePi extends EventEmitter {
  running = true;
  async abort() {}
  dispose() {}
}
let pi;
SdkPiClient.create = async () => (pi = new FakePi());

test("pictures a channel hands over go to the agent with the message, kept beside the chat; what is not a picture is said so and goes nowhere", async () => {
  const realAsk = sessions.ask;
  const turns = [];
  sessions.ask = async (id, build) => {
    turns.push({ id, ...build() });
    return "a cat";
  };
  try {
    const reply = await channelSupervisor.ask("c1", "what is this?", { session: "chat:1", from: { id: "+1555" }, images: [{ data: PNG.toString("base64"), mimeType: "image/jpeg" }] });
    assert.equal(reply, "a cat");
    assert.equal(turns.length, 1);
    const [image] = turns[0].images;
    assert.equal(image.mimeType, "image/png", "the type its bytes say, not what the package said");
    assert.equal(image.data, PNG.toString("base64"));
    assert.ok(existsSync(path.join(IMAGE_ROOT, findChannelSession("sig:chat:1").id, image.name)), "kept beside the chat, as a browser's picture is");

    const refused = await channelSupervisor.ask("c1", "and this?", { session: "chat:1", from: { id: "+1555" }, images: [{ data: Buffer.from("#!/bin/sh\nrm -rf /").toString("base64") }] });
    assert.match(refused, /not a PNG, JPEG, GIF or WebP/);
    assert.equal(turns.length, 1, "the agent never saw it");

    assert.match(await channelSupervisor.ask("c1", "/compact", { session: "chat:1", from: { id: "+1555" }, images: [{ data: PNG.toString("base64") }] }), /does not take pictures/);
    assert.equal(turns.length, 1);
  } finally {
    sessions.ask = realAsk;
  }
});

test("a picture the agent shows in a channel's chat goes to the channel as it is shown, with its words after it", async () => {
  const workspace = path.join(home, "pictures-ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, "chart.png"), PNG);
  createSession({ id: "shown", title: "shown", workspace, executor: "host" });
  const realSubmit = sessions.submit;
  sessions.submit = async () => {
    setImmediate(() => {
      pi.emit("event", { type: "agent_start" });
      pi.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Drawing it." } });
      pi.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Drawing it." }] } });
      pi.emit("event", { type: "tool_execution_start", toolCallId: "t1", toolName: "show_image", args: { path: "chart.png", title: "Sales" } });
      pi.emit("event", { type: "tool_execution_end", toolCallId: "t1", toolName: "show_image", result: { content: [{ type: "text", text: "Shown to the user: chart.png" }], details: { path: "chart.png", title: "Sales" } } });
      // One that failed, and one an extension brought under the portal's name: neither is a picture of the chat's folder.
      pi.emit("event", { type: "tool_execution_end", toolCallId: "t2", toolName: "show_image", isError: true, result: { details: { path: "chart.png" } } });
      pi.emit("event", { type: "tool_execution_end", toolCallId: "t3", toolName: "generate_image", result: { details: { path: "/etc/passwd" } } });
      pi.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Sales doubled." } });
      pi.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Sales doubled." }] } });
      pi.emit("event", { type: "agent_settled" });
    });
  };
  try {
    const said = [];
    const reply = await sessions.ask("shown", "chart the sales", {
      streamText: false,
      onPicture: (picture) => said.push(picture),
    });
    assert.deepEqual(said, [{ data: PNG.toString("base64"), mimeType: "image/png", name: "chart.png", title: "Sales" }]);
    assert.equal(reply, "Drawing it.\n\nSales doubled.", "with Progress off the words still come at the end");

    // With Progress on, the picture sits between the words it came between.
    const order = [];
    await sessions.ask("shown", "again", {
      streamText: true,
      onReply: (line) => order.push(line),
      onPicture: (picture) => order.push(`[${picture.name}]`),
    });
    assert.deepEqual(order.filter((l) => !l.startsWith("⚙")), ["Drawing it.", "[chart.png]", "Sales doubled."]);
  } finally {
    sessions.submit = realSubmit;
  }
});

test("a picture a lazy tool shows or makes goes to the channel as one of a direct call does: the call is of the tools tool, and its end says which tool it was", async () => {
  const workspace = path.join(home, "lazy-pictures-ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, "chart.png"), PNG);
  writeFileSync(path.join(workspace, "made.png"), PNG);
  createSession({ id: "lazy-shown", title: "lazy-shown", workspace, executor: "host" });
  const realSubmit = sessions.submit;
  /** The call of a lazy tool as the portal passes it on: the start has the call in its arguments, the end names the tool. */
  const through = (id, name, args, result, extra = {}) => {
    pi.emit("event", { type: "tool_execution_start", toolCallId: id, toolName: "tools", args: { action: "call", name, args } });
    pi.emit("event", { type: "tool_execution_end", toolCallId: id, toolName: "tools", portalCalledTool: name, result: { content: [{ type: "text", text: "done" }], details: result }, ...extra });
  };
  sessions.submit = async () => {
    setImmediate(() => {
      pi.emit("event", { type: "agent_start" });
      pi.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Drawing it." } });
      pi.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Drawing it." }] } });
      through("l1", "show_image", { path: "chart.png", title: "Sales" }, { path: "chart.png", title: "Sales" });
      // The portal's own generate_image, which says so; and what is no picture: a failed call, another tool's path, a search, one an extension brought.
      through("l2", "generate_image", { prompt: "a cat" }, { path: "made.png", title: "A cat", portalImage: true });
      through("l3", "show_image", { path: "chart.png" }, { path: "chart.png" }, { isError: true });
      through("l4", "docs_open", { id: "d" }, { path: "chart.png" });
      pi.emit("event", { type: "tool_execution_end", toolCallId: "l5", toolName: "tools", result: { details: { path: "chart.png" } } });
      through("l6", "generate_image", { prompt: "an extension's" }, { path: "/etc/passwd" });
      pi.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "There." } });
      pi.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "There." }] } });
      pi.emit("event", { type: "agent_settled" });
    });
  };
  try {
    const said = [];
    const reply = await sessions.ask("lazy-shown", "chart the sales", { streamText: false, onPicture: (picture) => said.push(picture) });
    assert.deepEqual(said, [
      { data: PNG.toString("base64"), mimeType: "image/png", name: "chart.png", title: "Sales" },
      { data: PNG.toString("base64"), mimeType: "image/png", name: "made.png", title: "A cat" },
    ]);
    assert.equal(reply, "Drawing it.\n\nThere.");
  } finally {
    sessions.submit = realSubmit;
  }
});

test("a code a channel package asks to have scanned is on its status until it takes it back, and a stopped start of it cannot put one there", async () => {
  getDb().prepare("INSERT INTO channels (id, slug, kind, name, config, enabled) VALUES ('c2', 'pair', 'pairing', 'Pairing', '{}', 1)").run();
  const row = getDb().prepare("SELECT * FROM channels WHERE id = 'c2'").get();
  let first;
  await channelSupervisor.startChannel(row, { start: async (ctx) => ((first = ctx), { stop() {} }) });
  first.showPairing({ code: "sgnl://linkdevice?uuid=1", hint: "Scan it with your phone." });
  assert.deepEqual(channelSupervisor.status("c2").pairing, { code: "sgnl://linkdevice?uuid=1", hint: "Scan it with your phone." });
  first.showPairing(null);
  assert.equal(channelSupervisor.status("c2").pairing, undefined);
  first.showPairing({ code: "x".repeat(5000), hint: "" });
  assert.equal(channelSupervisor.status("c2").pairing, undefined, "nothing a QR code could hold");

  await channelSupervisor.stopChannel("c2");
  await channelSupervisor.startChannel(row, { start: async () => ({ stop() {} }) });
  first.showPairing({ code: "sgnl://stale", hint: "" });
  assert.equal(channelSupervisor.status("c2").pairing, undefined, "the old start's code is not the new one's");
  await channelSupervisor.stopChannel("c2");
});

test("what a channel package keeps with ctx.state is there for its next start, not written by a stopped one, and goes with the channel", async () => {
  const { removeChannelState } = await import("../dist/channels/state.js");
  getDb().prepare("INSERT INTO channels (id, slug, kind, name, config, enabled) VALUES ('c3', 'kept', 'keeping', 'Keeping', '{}', 1)").run();
  const row = getDb().prepare("SELECT * FROM channels WHERE id = 'c3'").get();
  let first;
  await channelSupervisor.startChannel(row, { start: async (ctx) => ((first = ctx), { stop() {} }) });
  assert.equal(first.state.get(), undefined, "nothing kept yet");
  first.state.set({ lastEventId: "7" });
  assert.throws(() => first.state.set({ big: "x".repeat(70 * 1024) }), /at most 64 KB/);

  await channelSupervisor.stopChannel("c3");
  let second;
  await channelSupervisor.startChannel(row, { start: async (ctx) => ((second = ctx), { stop() {} }) });
  assert.deepEqual(second.state.get(), { lastEventId: "7" }, "the next start finds it, as a restart of the portal would");
  first.state.set({ lastEventId: "1" });
  assert.deepEqual(second.state.get(), { lastEventId: "7" }, "a stopped start does not write over the running one's");

  removeChannelState("c3");
  assert.equal(second.state.get(), undefined);
  await channelSupervisor.stopChannel("c3");
});

test("a channel switched off forgets what it kept, so that switched on again it does not pick up where it was", async () => {
  const { readChannelState, writeChannelState } = await import("../dist/channels/state.js");
  getDb().prepare("INSERT INTO channels (id, slug, kind, name, config, enabled) VALUES ('c4', 'off', 'keeping', 'Off', '{}', 1)").run();
  writeChannelState("c4", { lastEventId: "9" });
  await channelSupervisor.sync();
  assert.deepEqual(readChannelState("c4"), { lastEventId: "9" }, "kept while it is on, across a restart or a save");
  getDb().prepare("UPDATE channels SET enabled = 0 WHERE id = 'c4'").run();
  await channelSupervisor.sync();
  assert.equal(readChannelState("c4"), undefined);
});
