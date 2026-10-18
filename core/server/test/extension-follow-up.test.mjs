import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

/**
 * What a server half says to a chat's agent (`portal.chats.followUp`): the portal's side that finds the chat and
 * names the extension, and the pi client's side that puts it in the conversation after the turn that is going on.
 */
const home = inProcessHome("extension-follow-up-");
const pkg = path.join(home, "packages", "notes");
mkdirSync(pkg, { recursive: true });
const NAME = "pithagoras-notes";
const file = path.join(pkg, "server.js");
writeFileSync(file, "export default async function (portal) { globalThis.followed = portal; }\n");
const stat = statSync(file);

const host = await import("../dist/extension-host.js");
const { createSession } = await import("../dist/db.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const work = path.join(process.env.WORKSPACE_ROOT, "site");
mkdirSync(work, { recursive: true });
createSession({ id: "a", title: "First chat", workspace: work, executor: "host" });

const told = [];
host.setChatBridge({ tell: async () => false, followUp: async (chat, extension, message) => (told.push({ chat, extension, message }), chat === "a"), offers: () => undefined });
await host.syncServerHalves([{ name: NAME, version: "1.0.0", file, rev: `${stat.mtimeMs}-1` }]);
test.after(() => host.stopServerHalves());

test("a server half's follow-up reaches the portal's chats under its own name, and is true once pi took it", async () => {
  const { chats } = globalThis.followed;
  assert.equal(await chats.followUp("a", { text: "Answer the comment", details: { thread: "t1" }, type: "ping" }), true);
  assert.deepEqual(told, [{ chat: "a", extension: NAME, message: { text: "Answer the comment", details: { thread: "t1" }, type: "ping" } }]);
  assert.equal(await chats.followUp("a", { text: "plain" }), true);
  assert.deepEqual(told[1].message, { text: "plain", details: undefined, type: undefined });
});

test("a follow-up to a chat that is not there, or with nothing to say, is refused", async () => {
  const { chats } = globalThis.followed;
  await assert.rejects(chats.followUp("gone", { text: "hello" }), /No such chat/);
  await assert.rejects(chats.followUp("a", { text: "  " }), TypeError);
  await assert.rejects(chats.followUp("a", {}), TypeError);
  assert.equal(told.length, 2, "nothing reached the chats");
});

test("pi takes it as a message of the extension, shown to the person, after the turn that is going on, and a turn starts if it is idle", async () => {
  const sent = [];
  const client = Object.create(SdkPiClient.prototype);
  client.session = { sendCustomMessage: async (message, options) => void sent.push({ message, options }) };
  assert.equal(client.followUpExtension(NAME, { text: "Answer it", details: { thread: "t1" }, type: "ping" }), true);
  assert.equal(client.followUpExtension(NAME, { text: "Plain" }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.map(({ message }) => message.customType), [`${NAME}:ping`, NAME]);
  assert.deepEqual(sent[0], { message: { customType: `${NAME}:ping`, content: "Answer it", display: true, details: { thread: "t1" } }, options: { deliverAs: "followUp", triggerTurn: true } });
  assert.equal(sent[1].message.details, undefined);
});

test("a message pi could not take is said to the person as a failure of the run, not lost", async () => {
  const events = [];
  const client = Object.create(SdkPiClient.prototype);
  client.session = { sendCustomMessage: async () => { throw new Error("session disposed"); } };
  client.emit = (name, event) => events.push([name, event]);
  assert.equal(client.followUpExtension(NAME, { text: "Hello" }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [["event", { type: "portal_failed", error: `A message from ${NAME} could not be delivered: session disposed` }]]);
});
