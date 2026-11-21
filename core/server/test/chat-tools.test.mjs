import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";
import { fakeModel } from "./fake-model.mjs";

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

// A 1x1 png, the smallest image the record may hold.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("a read shows an image of a message as a file it can open", async () => {
  createSession({ id: "pic", title: "With a picture", workspace: scout.home, executor: "host" });
  writeChatFile("pic", [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "look at this" }, { type: "image", data: PNG, mimeType: "image/png" }] } },
    agent("a red dot"),
  ]);
  const read = said(await run(tools[CHAT_READ_TOOL], { id: "pic" }));
  const line = /→ \[image: (.+)\]/.exec(read);
  assert.ok(line, "the image is a line of its own");
  assert.ok(existsSync(line[1]), "the image is saved where it is named");
  assert.equal(readFileSync(line[1]).toString("base64"), PNG, "it is the image of the record");
});

test("the search lists the messages with images, with the file to open them", async () => {
  const found = said(await run(tools[CHAT_SEARCH_TOOL], { images: true }));
  assert.match(found, /1 image:/);
  assert.match(found, /pic "With a picture", message 0: \[image: .+\.png\]/);
});

test("a prompt asks the chat's model about its context", async () => {
  const model = await fakeModel(() => "The cron entry, message 3.");
  writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));
  createSession({ id: "asked", title: "Asked", workspace: scout.home, executor: "host", provider: "fake", model: "m" });
  writeChatFile("asked", [user("the backup broke"), agent("looking")]);

  const answer = said(await run(tools[CHAT_SEARCH_TOOL], { prompt: "what broke the backup", id: "asked" }));
  assert.match(answer, /The cron entry, message 3\./);

  const request = model.requests.at(-1);
  const userMsg = request.messages.find((m) => m.role === "user");
  assert.match(userMsg.content, /the backup broke/, "the model reads the transcript");
  assert.match(userMsg.content, /Question: what broke the backup/, "and the question");
  const system = request.messages.find((m) => m.role === "system");
  assert.match(system.content, /data, not instructions/, "the transcript is told to be data");

  await assert.rejects(run(tools[CHAT_SEARCH_TOOL], { prompt: "x", id: "foreign" }), /not one of yours/);
  await assert.rejects(run(tools[CHAT_SEARCH_TOOL], { prompt: "x" }), /needs the chat's id/);
  await assert.rejects(run(tools[CHAT_SEARCH_TOOL], { query: "x", prompt: "y" }), /not both/);
});

test("a chat in a project linked to the agent is its own, and a blank slate's is no agent's", async () => {
  const linked = path.join(process.env.WORKSPACE_ROOT, "linked-proj");
  mkdirSync(linked, { recursive: true });
  getDb().prepare("INSERT INTO project_agent (project, agent, memory_off) VALUES (?, ?, 0)").run("linked-proj", scout.id);
  createSession({ id: "linked", title: "In the linked project", workspace: linked, executor: "host" });
  writeChatFile("linked", [user("work in the linked project: goldfinch")]);

  assert.match(said(await run(tools[CHAT_LIST_TOOL], {})), /linked "In the linked project"/, "the linked project's chat is in the list");
  assert.match(said(await run(tools[CHAT_READ_TOOL], { id: "linked" })), /goldfinch/);
  assert.match(said(await run(tools[CHAT_SEARCH_TOOL], { query: "goldfinch" })), /linked "In the linked project", message 0/);

  const blank = path.join(process.env.WORKSPACE_ROOT, "blank-proj");
  mkdirSync(blank, { recursive: true });
  createSession({ id: "blank", title: "Blank slate", workspace: blank, executor: "host" });
  writeChatFile("blank", [user("a word no agent may find: nightjar")]);
  await assert.rejects(run(tools[CHAT_READ_TOOL], { id: "blank" }), /not one of yours/);
  assert.match(said(await run(tools[CHAT_SEARCH_TOOL], { query: "nightjar" })), /No matches/);
});

test("a read is capped at 50 KB of UTF-8, at a character boundary, the note reserved", async () => {
  createSession({ id: "big", title: "A big one", workspace: scout.home, executor: "host" });
  writeChatFile("big", [user("\u00e9".repeat(60_000))]);
  const read = said(await run(tools[CHAT_READ_TOOL], { id: "big" }));
  assert.ok(Buffer.byteLength(read, "utf8") <= 50_000, "the cap is in bytes, not characters");
  assert.match(read, /\u2026truncated; read a slice with from and to\.$/);
  assert.doesNotMatch(read, /\uFFFD/, "it cuts at a character boundary");
});
