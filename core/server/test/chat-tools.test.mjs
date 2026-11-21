import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// The agent's own past (#376): the tools that list, read and search its old
// chats, called as pi calls them. The record of a chat is pi's session file,
// so the tests write one, the way pi writes it: a line per entry, each naming
// its parent, the conversation the path from the last entry back to the root.

const home = inProcessHome("pithagoras-chat-tools-");

const { createSession, getDb } = await import("../dist/db.js");
const { createAgent } = await import("../dist/agents.js");
const { chatTools, CHAT_LIST_TOOL, CHAT_READ_TOOL, CHAT_SEARCH_TOOL } = await import("../dist/pi/chat-tools.js");

const SESSION_DIR = process.env.SESSION_DIR;

/** The tools one factory registers, by name. */
const toolsOf = (factory) => {
  const tools = {};
  factory({ registerTool: (tool) => (tools[tool.name] = tool) });
  return tools;
};
/** What the model reads from a result, as pi builds it. */
const said = (result) => {
  assert.ok(Array.isArray(result.content), "a result has content, which is what pi hands the model");
  return result.content.map((part) => part.text).join("\n");
};
const run = (tool, params) => tool.execute("call-1", params);

/** A pi session file for a chat: the header, then the entries, each the child of the last. */
function writeChatFile(sessionId, entries) {
  const dir = path.join(SESSION_DIR, sessionId);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "chat.jsonl");
  let parent = null;
  const lines = ['{"type":"session","version":1,"id":"hdr","timestamp":"2026-01-01T00:00:00Z","cwd":"/nowhere"}'];
  for (const entry of entries) {
    const line = { id: `e${lines.length}`, parentId: parent, ...entry };
    lines.push(JSON.stringify(line));
    parent = line.id;
  }
  writeFileSync(file, lines.join("\n") + "\n");
  getDb().prepare("UPDATE sessions SET pi_session_file = ? WHERE id = ?").run(file, sessionId);
  return file;
}
const user = (text) => ({ type: "message", message: { role: "user", content: text } });
const agent = (text) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
const acted = (name) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text: "Let me look." }, { type: "toolCall", id: "tc", name, arguments: {} }] },
});
const result = (text) => ({ type: "message", message: { role: "toolResult", toolCallId: "tc", toolName: "bash", content: [{ type: "text", text }] } });

const scout = createAgent({ name: "Scout" });
const other = createAgent({ name: "Marlow" });
createSession({ id: "plan", title: "The backup plan", workspace: scout.home, executor: "host" });
createSession({ id: "channel", title: "Telegram: #general", workspace: scout.home, executor: "host", kind: "agent", channel_slug: "tg", channel_key: "tg:chat:1" });
createSession({ id: "foreign", title: "Marlow's own chat", workspace: other.home, executor: "host" });

writeChatFile("plan", [
  user("Fix the backup script, it fails on Sundays"),
  acted("bash"),
  result("MARKER-ONLY-IN-TOOL-RESULT"),
  agent("The cron entry is wrong; here is the fix."),
]);
writeChatFile("channel", [user("anyone home?"), agent("I am, what do you need?"), user("check the BACKUP status")]);
writeChatFile("foreign", [user("a word only Marlow knows: zebraquest")]);

const tools = toolsOf(chatTools(scout.id, "plan"));

test("the list shows the agent's chats and nothing of another agent's", async () => {
  const list = said(await run(tools[CHAT_LIST_TOOL], {}));
  assert.match(list, /2 chats:/);
  assert.match(list, /plan "The backup plan" \(task, 3 messages/);
  assert.match(list, /channel "Telegram: #general" \(agent, 3 messages/);
  assert.match(list, /plan "The backup plan".*\(this chat\)/s, "the chat it is in is marked");
  assert.doesNotMatch(list, /foreign|Marlow|zebraquest/, "another agent's chat is not in the list");
});

test("the read is an account of the chat: the words, a line per tool call, not the results", async () => {
  const read = said(await run(tools[CHAT_READ_TOOL], { id: "plan" }));
  assert.match(read, /^"The backup plan" \(chat plan, task\)/);
  assert.match(read, /\*\*User:\*\* Fix the backup script, it fails on Sundays/);
  assert.match(read, /\*\*Agent:\*\* Let me look\./);
  assert.match(read, /→ bash/);
  assert.match(read, /\*\*Agent:\*\* The cron entry is wrong; here is the fix\./);
  assert.doesNotMatch(read, /MARKER-ONLY-IN-TOOL-RESULT/, "a tool's result is what the work read, not what the chat said");
});

test("a read takes a slice by message range, and refuses what is not a range", async () => {
  const slice = said(await run(tools[CHAT_READ_TOOL], { id: "plan", from: 1, to: 1 }));
  assert.match(slice, /messages 1 to 1 of 3/);
  assert.match(slice, /Let me look\./);
  assert.doesNotMatch(slice, /fails on Sundays/, "the message before the slice is not in it");
  assert.doesNotMatch(slice, /cron entry/, "the message after the slice is not in it");

  const clamped = said(await run(tools[CHAT_READ_TOOL], { id: "plan", to: 99 }));
  assert.match(clamped, /The cron entry is wrong/, "a to past the end reads to the end");

  await assert.rejects(run(tools[CHAT_READ_TOOL], { id: "plan", from: 1, to: 0 }), /not before from/);
  await assert.rejects(run(tools[CHAT_READ_TOOL], { id: "plan", from: 4 }), /past the end/);
  await assert.rejects(run(tools[CHAT_READ_TOOL], { id: "plan", from: -1 }), /0-based/);
  await assert.rejects(run(tools[CHAT_READ_TOOL], { id: "" }), /needs an id/);
  await assert.rejects(run(tools[CHAT_READ_TOOL], { id: "nope" }), /No chat with that id/);
});

test("a chat of another agent's is not read, whatever its id", async () => {
  await assert.rejects(run(tools[CHAT_READ_TOOL], { id: "foreign" }), /not one of yours/);
  const search = said(await run(tools[CHAT_SEARCH_TOOL], { query: "zebraquest" }));
  assert.match(search, /No matches/, "the search does not reach it either");
});

test("the search finds words across the agent's chats, case-insensitively, with a snippet", async () => {
  const found = said(await run(tools[CHAT_SEARCH_TOOL], { query: "backup" }));
  assert.match(found, /2 matches for "backup":/);
  assert.match(found, /plan "The backup plan", message 0: .*fails on Sundays/);
  assert.match(found, /channel "Telegram: #general", message 2: .*check the BACKUP status/);
  assert.doesNotMatch(found, /MARKER-ONLY-IN-TOOL-RESULT/, "it does not look in the results the read does not show");

  const none = said(await run(tools[CHAT_SEARCH_TOOL], { query: "zebraquest" }));
  assert.match(none, /No matches for "zebraquest"/);
  await assert.rejects(run(tools[CHAT_SEARCH_TOOL], { query: "   " }), /Nothing to search for/);
});

test("a compaction is in the account as its summary, and the list counts what is in the file", async () => {
  createSession({ id: "long", title: "A long one", workspace: scout.home, executor: "host" });
  writeChatFile("long", [
    user("start the work"),
    agent("on it"),
    { type: "compaction", summary: "## Goal\nDo the thing.\n## So far\nHalf done." },
    user("continue"),
    agent("done"),
  ]);
  const read = said(await run(tools[CHAT_READ_TOOL], { id: "long" }));
  assert.match(read, /\[compacted\] ## Goal\nDo the thing\./);

  const list = said(await run(tools[CHAT_LIST_TOOL], {}));
  assert.match(list, /long "A long one" \(task, 4 messages/);
});

test("read and search say their result is outside content, the list does not", () => {
  assert.deepEqual(tools[CHAT_READ_TOOL].guard, { outside: true });
  assert.deepEqual(tools[CHAT_SEARCH_TOOL].guard, { outside: true });
  assert.equal(tools[CHAT_LIST_TOOL].guard, undefined);
});
