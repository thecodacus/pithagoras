import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";
import { fakeModel, resultsIn } from "./fake-model.mjs";

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

// The list holds no message, but a channel chat's title comes from outside: the
// name of a remote group, up to 120 characters of what a sender called it.
test("list, read and search all say their result is outside content", () => {
  assert.deepEqual(tools[CHAT_LIST_TOOL].guard, { outside: true });
  assert.deepEqual(tools[CHAT_READ_TOOL].guard, { outside: true });
  assert.deepEqual(tools[CHAT_SEARCH_TOOL].guard, { outside: true });
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

test("two images in one message get two files, and the search lists them", async () => {
  createSession({ id: "two", title: "Two pictures", workspace: scout.home, executor: "host" });
  writeChatFile("two", [
    { type: "message", message: { role: "user", content: [{ type: "image", data: PNG, mimeType: "image/png" }, { type: "image", data: PNG, mimeType: "image/png" }] } },
  ]);
  const read = said(await run(tools[CHAT_READ_TOOL], { id: "two" }));
  const files = [...read.matchAll(/→ \[image: (.+)\]/g)].map((m) => m[1]);
  assert.equal(files.length, 2, "each image is a line of its own");
  assert.notEqual(files[0], files[1], "the two images are not the same file");
  for (const file of files) assert.ok(existsSync(file), "each image is saved where it is named");

  const found = said(await run(tools[CHAT_SEARCH_TOOL], { images: true }));
  assert.match(found, /two "Two pictures", message 0: \[image: .+\.png\]/);
});

test("the search lists the messages with images, with the file to open them", async () => {
  const found = said(await run(tools[CHAT_SEARCH_TOOL], { images: true }));
  assert.match(found, /3 images:/);
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
  assert.match(userMsg.content, /\[0\] \*\*User:\*\* the backup broke/, "each line with the index of the message it is");
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

test("a read carries the index of each message, as the question's transcript does", async () => {
  const read = said(await run(tools[CHAT_READ_TOOL], { id: "plan" }));
  assert.match(read, /^\[0\] \*\*User:\*\* Fix the backup script/m);
  assert.match(read, /^\[1\] \*\*Agent:\*\* Let me look\./m);
  assert.match(read, /^\[1\] → bash/m, "a tool call is a line of the message it is in");
  assert.match(read, /^\[2\] \*\*Agent:\*\* The cron entry is wrong/m);
});

test("a read is capped at 50 KB of UTF-8, at a character boundary, and a first message too long is said to be cut", async () => {
  createSession({ id: "big", title: "A big one", workspace: scout.home, executor: "host" });
  writeChatFile("big", [user("\u00e9".repeat(60_000))]);
  const read = said(await run(tools[CHAT_READ_TOOL], { id: "big" }));
  assert.ok(Buffer.byteLength(read, "utf8") <= 50_000, "the cap is in bytes, not characters");
  assert.match(read, /\u2026message 0 is longer than a read holds and is cut here$/);
  assert.doesNotMatch(read, /\uFFFD/, "it cuts at a character boundary");
});

test("a read cut at the cap says after which message, where to go on, and what the header shows", async () => {
  createSession({ id: "long-read", title: "Many messages", workspace: scout.home, executor: "host" });
  // 100 messages of 1 KB each is about 100 KB: the cap falls inside the account.
  const entries = [];
  for (let i = 0; i < 50; i++) entries.push(user(`question ${i} ${"q".repeat(1000)}`), agent(`answer ${i} ${"a".repeat(1000)}`));
  writeChatFile("long-read", entries);
  const read = said(await run(tools[CHAT_READ_TOOL], { id: "long-read" }));
  assert.ok(Buffer.byteLength(read, "utf8") <= 50_000);
  const note = /\u2026truncated after message (\d+); go on with from: (\d+)$/.exec(read);
  assert.ok(note, "the note names where the cut fell");
  const last = Number(note[1]);
  assert.equal(Number(note[2]), last + 1, "and the message to go on with");
  assert.ok(last > 0 && last < 99, "inside the chat");
  assert.match(read, new RegExp(`^"Many messages" \\(chat long-read, task \u2014 messages 0 to ${last} of 100\\)`), "the header says what is shown, not the whole range");
  assert.match(read, new RegExp(`^\\[${last}\\] `, "m"), "the last message named is in the read");
  assert.doesNotMatch(read, new RegExp(`^\\[${last + 1}\\] `, "m"), "and the next one is not");

  const next = said(await run(tools[CHAT_READ_TOOL], { id: "long-read", from: last + 1 }));
  assert.match(next, new RegExp(`^\\[${last + 1}\\] `, "m"), "going on with from picks up where it stopped");
});

test("summaries count against the question's budget, and the note says what is left out", async () => {
  const model = await fakeModel(() => "the summaries.");
  writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));
  const entries = [user("start the work")];
  for (let i = 0; i < 200; i++) entries.push({ type: "compaction", summary: "s".repeat(4000) });
  entries.push(agent("done"));
  createSession({ id: "sums", title: "Summaries", workspace: scout.home, executor: "host", provider: "fake", model: "m" });
  writeChatFile("sums", entries);

  await run(tools[CHAT_SEARCH_TOOL], { prompt: "what was done", id: "sums" });
  const userMsg = model.requests.at(-1).messages.find((m) => m.role === "user");
  // The budget is the model's window in characters, 80% of it: 200000 * 4 * 0.8.
  assert.ok(userMsg.content.length <= 640_000 + 200, "the transcript fits the budget, the note and the question aside");
  assert.match(userMsg.content, /the earliest summaries are left out/, "the note says what was left out");
});

// The guard holds the tools to the primary user: they are not a read, so a role
// that may not run what is not a read — a colleague, a heartbeat — is refused
// them by the rule that keeps a non-read tool from a role that has not been
// allowed it. The primary user reads its own past.
test("a colleague and a heartbeat are refused the tools by the guard, the primary user is not", async () => {
  const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
  const { mkdtempSync } = await import("node:fs");
  const model = await fakeModel((request) => (resultsIn(request) === 0 ? { name: CHAT_READ_TOOL, args: { id: "plan" } } : "Done."));
  writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));

  const runAs = async (whoNow) => {
    const client = await SdkPiClient.create({
      cwd: scout.home,
      sessionDir: mkdtempSync(path.join(process.env.SESSION_DIR, "guard-")),
      provider: "fake", modelId: "m",
      sessionId: "guard-" + Math.random().toString(36).slice(2),
      whoNow, dialogs: false,
    });
    const results = [];
    const settled = new Promise((resolve) => client.on("event", (e) => {
      if (e?.type === "tool_execution_end") results.push(e);
      if (e?.type === "agent_settled") resolve();
    }));
    try {
      await client.prompt("Read the plan chat");
      await settled;
      return results;
    } finally {
      client.dispose();
    }
  };

  const colleague = await runAs(() => ({ role: "colleague", key: "priya" }));
  assert.equal(colleague.length, 1);
  assert.equal(colleague[0].isError, true, "a colleague is refused");
  assert.match(JSON.stringify(colleague[0].result), /not your primary user/);

  const heartbeat = await runAs(() => ({ role: "heartbeat" }));
  assert.equal(heartbeat.length, 1);
  assert.equal(heartbeat[0].isError, true, "a heartbeat is refused");

  const primary = await runAs(() => ({ role: "primary" }));
  assert.equal(primary.length, 1);
  assert.equal(primary[0].isError, false, "the primary user reads its own past");
  assert.match(JSON.stringify(primary[0].result), /The backup plan/);
});

// A chat in a project no agent is linked to has no agent's past to reach: the
// tools were once bound to the first agent for it, and a routine or subagent
// there could list, read and search that agent's chats.
test("a client in a project no agent is linked to has no chat tools", async () => {
  const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
  const { mkdtempSync } = await import("node:fs");
  const model = await fakeModel(() => "Done.");
  writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));
  const loose = path.join(process.env.WORKSPACE_ROOT, "unlinked-proj");
  mkdirSync(loose, { recursive: true });

  const toolNames = async (cwd) => {
    const client = await SdkPiClient.create({
      cwd,
      sessionDir: mkdtempSync(path.join(process.env.SESSION_DIR, "unlinked-")),
      provider: "fake", modelId: "m",
      sessionId: "unlinked-" + Math.random().toString(36).slice(2),
      whoNow: () => ({ role: "primary" }), dialogs: false,
    });
    try {
      const before = model.requests.length;
      const settled = new Promise((resolve) => client.on("event", (e) => e?.type === "agent_settled" && resolve()));
      await client.prompt("Search the old chats");
      await settled;
      return model.requests[before].tools?.map((t) => t.name ?? t.function?.name) ?? [];
    } finally {
      client.dispose();
    }
  };

  const unlinked = await toolNames(loose);
  assert.ok(!unlinked.includes(CHAT_SEARCH_TOOL), "no agent owns the folder, so it has no search over any agent's chats");
  assert.ok(!unlinked.includes(CHAT_LIST_TOOL));
  assert.ok(!unlinked.includes(CHAT_READ_TOOL));
  const own = await toolNames(scout.home);
  assert.ok(own.includes(CHAT_SEARCH_TOOL), "an agent's own chat has them");
});

// The entry id is read from a file on disk, and was put into the image's file
// name as it stood: an id with `../` wrote outside the chat's image folder.
test("an entry id that is not a plain id does not put an image outside the chat's folder", async () => {
  createSession({ id: "evil", title: "Evil ids", workspace: scout.home, executor: "host" });
  writeChatFile("evil", [
    { id: "x/../../../escaped", type: "message", message: { role: "user", content: [{ type: "image", data: PNG, mimeType: "image/png" }] } },
    { id: "../../../../also-escaped", type: "message", message: { role: "assistant", content: [{ type: "image", data: PNG, mimeType: "image/png" }] } },
  ]);
  const read = said(await run(tools[CHAT_READ_TOOL], { id: "evil" }));
  const files = [...read.matchAll(/→ \[image: (.+)\]/g)].map((m) => m[1]);
  assert.equal(files.length, 2, "both images are still shown, as files");
  const folder = path.join(process.env.DATA_DIR, "images", "evil") + path.sep;
  for (const file of files) {
    assert.ok(file.startsWith(folder), `${file} is in the chat's image folder`);
    assert.ok(existsSync(file));
    assert.match(path.basename(file), /^chat-[0-9a-f]{40}-\d+\.png$/, "named by a hash of the id");
  }
  assert.ok(!existsSync(path.join(process.env.DATA_DIR, "escaped-0.png")), "nothing was written above the image folder");
  assert.ok(!existsSync(path.join(path.dirname(process.env.DATA_DIR), "also-escaped-0.png")));
  assert.ok(!existsSync(path.join(process.env.DATA_DIR, "images", "also-escaped-0.png")));
});

// Stop ends the run, and a question to a chat's model, which can take minutes,
// is part of it: it ended only with its own time limit.
test("Stop ends a question to a past chat", async () => {
  const model = await fakeModel(() => new Promise(() => {}));
  writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));
  createSession({ id: "slow", title: "Slow", workspace: scout.home, executor: "host", provider: "fake", model: "m" });
  writeChatFile("slow", [user("the backup broke"), agent("looking")]);

  const stop = new AbortController();
  const outcome = tools[CHAT_SEARCH_TOOL].execute("call-1", { prompt: "what broke", id: "slow" }, stop.signal).then(
    () => "answered",
    () => "ended",
  );
  while (!model.requests.length) await new Promise((resolve) => setTimeout(resolve, 20));
  stop.abort();
  const timer = new Promise((resolve) => setTimeout(() => resolve("still waiting"), 5000));
  assert.equal(await Promise.race([outcome, timer]), "ended", "the question ends when the run is stopped, not at its time limit");
});

// A chat's file can be megabytes, and the list reads one per chat it shows: all
// at once held them all in memory together (100 chats of 4 MB peaked at 700 MB).
test("the list reads a few files at a time, and still counts every chat", async () => {
  const fsp = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  for (let i = 0; i < 12; i++) {
    createSession({ id: `many-${i}`, title: `Many ${i}`, workspace: scout.home, executor: "host" });
    writeChatFile(`many-${i}`, [user(`question ${i}`), agent("answer")]);
  }
  const original = fsp.readFile;
  let inFlight = 0;
  let peak = 0;
  fsp.readFile = async (file, ...rest) => {
    if (!String(file).endsWith("chat.jsonl")) return original(file, ...rest);
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return await original(file, ...rest);
    } finally {
      inFlight--;
    }
  };
  syncBuiltinESMExports();
  let list;
  try {
    list = said(await run(tools[CHAT_LIST_TOOL], {}));
  } finally {
    fsp.readFile = original;
    syncBuiltinESMExports();
  }
  assert.ok(peak > 1, "the reads do overlap, so a list of many chats is not one wait per chat");
  assert.ok(peak <= 4, `at most four files are read at once, saw ${peak}`);
  for (let i = 0; i < 12; i++) assert.match(list, new RegExp(`many-${i} "Many ${i}" \\(task, 2 messages`), `chat ${i} is counted`);
});

// The question's budget is the window the portal holds the model to: a limit
// set for the model, or the default as a ceiling, and not only what the model's
// definition declares (200000 tokens for the fake model).
test("a question to a chat is budgeted on the model's configured window, and the model is told it", async () => {
  const { setContextLimit, setDefaultContextLimit } = await import("../dist/db.js");
  const model = await fakeModel(() => "ok");
  writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));
  const entries = [];
  for (let i = 0; i < 100; i++) entries.push(user(`question ${i} ${"q".repeat(1000)}`), agent(`answer ${i} ${"a".repeat(1000)}`));
  createSession({ id: "windowed", title: "Windowed", workspace: scout.home, executor: "host", provider: "fake", model: "m" });
  writeChatFile("windowed", entries);

  const transcriptLength = async () => {
    await run(tools[CHAT_SEARCH_TOOL], { prompt: "what happened", id: "windowed" });
    return model.requests.at(-1).messages.find((m) => m.role === "user").content.length;
  };
  try {
    setContextLimit("fake", "m", 10_000);
    // 10000 tokens: 10000 * 4 * 0.8 = 32000 characters, the note and the question aside.
    assert.ok((await transcriptLength()) <= 32_000 + 200, "the model's own limit is the budget");
    setContextLimit("fake", "m", null);
    setDefaultContextLimit(8_000);
    assert.ok((await transcriptLength()) <= 25_600 + 200, "the default is a ceiling on a model that declares more");
  } finally {
    setContextLimit("fake", "m", null);
    setDefaultContextLimit(null);
  }
  assert.ok((await transcriptLength()) > 100_000, "without a limit, the model's declared window is the budget");
});
