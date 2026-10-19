import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// What a channel package gets beyond words: pictures sent with a message reach
// the agent, a picture or a clip a call gives goes back out, and a code the
// package needs scanned is on the channel's page while it waits for it.

const home = inProcessHome("pithagoras-channel-pictures-");

const { createSession, findChannelSession, getDb } = await import("../dist/db.js");
const { channelSupervisor } = await import("../dist/channels/supervisor.js");
const { IMAGE_ROOT, sessions } = await import("../dist/session-manager.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { setAgentAccess } = await import("../dist/workspace-files.js");

getDb().prepare("INSERT INTO channels (id, slug, kind, name, config) VALUES ('c1', 'sig', 'test', 'Test', '{}')").run();

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom"), Buffer.alloc(20)]);

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

test("what a call gives goes to a channel as it is given, with the words after it: a picture and a clip sent, any other file named", async () => {
  const workspace = path.join(home, "pictures-ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, "chart.png"), PNG);
  writeFileSync(path.join(workspace, "fox.mp4"), MP4);
  writeFileSync(path.join(workspace, "sales.csv"), "a,b\n1,2\n");
  createSession({ id: "shown", title: "shown", workspace, executor: "host" });
  const realSubmit = sessions.submit;
  const ended = (toolCallId, toolName, files, extra = {}) =>
    pi.emit("event", { type: "tool_execution_end", toolCallId, toolName, result: { content: [{ type: "text", text: "done" }], details: { files } }, ...extra });
  sessions.submit = async () => {
    setImmediate(() => {
      pi.emit("event", { type: "agent_start" });
      pi.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Drawing it." } });
      pi.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Drawing it." }] } });
      pi.emit("event", { type: "tool_execution_start", toolCallId: "t1", toolName: "show_image", args: { path: "chart.png", title: "Sales" } });
      ended("t1", "show_image", [{ path: "chart.png", title: "Sales" }]);
      // Any tool's, called through the lazy tools' gateway too: a clip, and a file that is neither, in one call.
      ended("t2", "tools", [{ path: "fox.mp4", title: "A fox" }, { path: path.join(workspace, "sales.csv") }], { portalCalledTool: "plot_tool" });
      // What is not given: a failed call's, a file outside the folder, one that is not there.
      ended("t3", "show_image", [{ path: "chart.png" }], { isError: true });
      ended("t4", "generate_image", [{ path: "/etc/passwd" }, { path: "../outside.png" }, { path: "gone.png" }]);
      pi.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Sales doubled." } });
      pi.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Sales doubled." }] } });
      pi.emit("event", { type: "agent_settled" });
    });
  };
  try {
    const sent = [];
    const reply = await sessions.ask("shown", "chart the sales", {
      streamText: false,
      onPicture: (picture) => sent.push(picture),
      onVideo: (video) => sent.push(video),
    });
    assert.deepEqual(sent, [
      { data: PNG.toString("base64"), mimeType: "image/png", name: "chart.png", title: "Sales" },
      { data: MP4.toString("base64"), mimeType: "video/mp4", name: "fox.mp4", title: "A fox" },
    ]);
    assert.equal(reply, "Drawing it.\n\n📎 sales.csv\n\nSales doubled.", "with Progress off the words still come at the end, the file named among them");

    // With Progress on, each sits between the words it came between. A channel that cannot send a clip has it named.
    const order = [];
    await sessions.ask("shown", "again", {
      streamText: true,
      onReply: (line) => order.push(line),
      onPicture: (picture) => order.push(`[${picture.name}]`),
    });
    assert.deepEqual(order.filter((l) => !l.startsWith("⚙")), ["Drawing it.", "[chart.png]", "📎 A fox (fox.mp4)", "📎 sales.csv", "Sales doubled."]);

    // One the channel failed to send is named too, so the person still hears of it: when the failure is known, after what was said by then.
    const failed = await sessions.ask("shown", "once more", {
      streamText: false,
      onPicture: () => {},
      onVideo: async () => {
        throw new Error("Signal refused the attachment");
      },
    });
    assert.equal(failed, "Drawing it.\n\n📎 sales.csv\n\nSales doubled.\n\n📎 A fox (fox.mp4)");
  } finally {
    sessions.submit = realSubmit;
  }
});

test("a picture or a clip a call gives that the sandbox closed to the agent is not sent on: it is named, as a file that was not sent", async () => {
  const workspace = path.join(home, "closed-ws");
  mkdirSync(path.join(workspace, "closed"), { recursive: true });
  writeFileSync(path.join(workspace, "chart.png"), PNG);
  writeFileSync(path.join(workspace, "closed", "secret.png"), PNG);
  writeFileSync(path.join(workspace, "closed", "clip.mp4"), MP4);
  // The folders above the chat's are open to everyone, as a sandbox has them; what is closed to the agent is a folder of its own.
  chmodSync(home, 0o755);
  chmodSync(path.join(workspace, "closed"), 0o700);
  createSession({ id: "closed", title: "closed", workspace, executor: "host" });
  // The agent is another user than the portal: everyone, to the files.
  setAgentAccess(() => [{ uid: 61234, groups: [61234] }]);
  const realSubmit = sessions.submit;
  sessions.submit = async () => {
    setImmediate(() => {
      pi.emit("event", { type: "agent_start" });
      pi.emit("event", {
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "plot_tool",
        result: { content: [{ type: "text", text: "done" }], details: { files: [{ path: "closed/secret.png" }, { path: "closed/clip.mp4" }, { path: "chart.png" }] } },
      });
      pi.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Here." }] } });
      pi.emit("event", { type: "agent_settled" });
    });
  };
  try {
    const sent = [];
    const reply = await sessions.ask("closed", "show me", { streamText: false, onPicture: (picture) => sent.push(picture), onVideo: (video) => sent.push(video) });
    assert.deepEqual(sent.map((file) => file.name), ["chart.png"], "only what the agent could read itself");
    assert.doesNotMatch(JSON.stringify(sent), new RegExp(MP4.toString("base64").slice(0, 12)));
    assert.match(reply, /📎 closed\/secret\.png/);
    assert.match(reply, /📎 closed\/clip\.mp4/);
  } finally {
    sessions.submit = realSubmit;
    setAgentAccess(() => undefined);
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
