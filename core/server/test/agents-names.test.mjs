import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

const home = inProcessHome("pithagoras-agent-names-");

const { default: express } = await import("express");
const { agentOf, agentsRoot, chatsOf, createAgent, deleteAgent, listAgents, slugOf } = await import("../dist/agents.js");
const { agentsRouter } = await import("../dist/api/agents.js");
const { createSession, getDb } = await import("../dist/db.js");

const listener = express().use("/api", agentsRouter()).listen(0, "127.0.0.1");
await new Promise((resolve) => listener.once("listening", resolve));
const base = `http://127.0.0.1:${listener.address().port}/api`;
test.after(() => listener.close());

/** How many times the agents were read from the database while `fn` ran. */
async function readsOfAgents(fn) {
  const db = getDb();
  const prepare = db.prepare.bind(db);
  let reads = 0;
  db.prepare = (sql) => {
    if (/FROM agents ORDER BY/.test(sql)) reads++;
    return prepare(sql);
  };
  try {
    await fn();
  } finally {
    delete db.prepare;
  }
  return reads;
}

test("the chats of an agent are found with one read of the agents, however many chats there are", async () => {
  const bot = createAgent({ name: "Lookup Bot" });
  const chats = [];
  for (let i = 0; i < 40; i++) {
    const workspace = i % 2 ? bot.home : path.join(bot.home, "notes");
    chats.push({ id: `chat-${i}`, workspace });
  }
  chats.push({ id: "elsewhere", workspace: path.join(home, "ws", "project") });
  for (const chat of chats) createSession({ id: chat.id, title: chat.id, workspace: chat.workspace, executor: "host" });

  let mine = [];
  assert.equal(await readsOfAgents(() => { mine = chatsOf(bot, chats); }), 1);
  assert.equal(mine.length, 40, "all of its chats, inside its home too, and none of the others");

  // Given the agents, it asks for none.
  const agents = listAgents();
  assert.equal(await readsOfAgents(() => { for (const chat of chats) agentOf(chat.workspace, agents); }), 0);

  // And the list of agents the page polls reads them once, and counts every chat.
  let listed;
  assert.equal(await readsOfAgents(async () => { listed = await (await fetch(`${base}/agents`)).json(); }), 1);
  assert.equal(listed.agents.find((a) => a.id === bot.id).chats, 40);
});

test("a name with accents keeps its letters, and one with none a folder can keep gets a folder of its own", () => {
  assert.equal(slugOf("Jürgen"), "jurgen");
  assert.equal(slugOf("Zoë Müller"), "zoe-muller");
  assert.equal(slugOf("Research Bot"), "research-bot");
  const maria = slugOf("Мария");
  assert.match(maria, /^agent-[0-9a-f]{6}$/);
  assert.equal(slugOf("  мария "), maria, "the same name is the same folder");
  assert.notEqual(slugOf("小助手"), maria);
  assert.match(slugOf("🙂"), /^agent-[0-9a-f]{6}$/);
});

test("an agent takes up only the folder that was kept for its own name", () => {
  const maria = createAgent({ name: "Мария" });
  assert.equal(path.dirname(maria.home), agentsRoot());
  assert.equal(readFileSync(path.join(maria.home, ".agent-name"), "utf8"), "Мария");
  writeFileSync(path.join(maria.home, "MEMORY.md"), "Maria's memory");
  deleteAgent(maria.id, { deleteFolder: false });

  const other = createAgent({ name: "小助手" });
  assert.notEqual(other.home, maria.home);
  assert.ok(!existsSync(path.join(other.home, "MEMORY.md")), "she does not start with Maria's memory");

  const back = createAgent({ name: "мария" });
  assert.equal(back.home, maria.home);
  assert.equal(readFileSync(path.join(back.home, "MEMORY.md"), "utf8"), "Maria's memory");
});

test("two names that make the same folder name do not share what one of them kept", () => {
  const first = createAgent({ name: "Мария 7" });
  assert.equal(first.id, "7");
  writeFileSync(path.join(first.home, "MEMORY.md"), "first");
  deleteAgent(first.id, { deleteFolder: false });

  const second = createAgent({ name: "小助手 7" });
  assert.equal(second.id, "7-2");
  assert.ok(!existsSync(path.join(second.home, "MEMORY.md")));
  assert.equal(createAgent({ name: "Мария 7" }).id, "7");
});

test("a folder kept before the name was recorded is taken up by the name it was made from", () => {
  const legacy = path.join(agentsRoot(), "legacy-bot");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, "SOUL.md"), "kept");
  assert.equal(createAgent({ name: "Legacy Bot" }).home, legacy);

  // A name that is not plain letters cannot be told to be the one it was made for.
  const unmarked = path.join(agentsRoot(), "9");
  mkdirSync(unmarked, { recursive: true });
  writeFileSync(path.join(unmarked, "SOUL.md"), "kept");
  assert.equal(createAgent({ name: "Мария 9" }).id, "9-2");
});
