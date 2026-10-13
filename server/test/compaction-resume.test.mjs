import { test, before } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel } from "./fake-model.mjs";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * A chat compacted while the agent is working, against the whole server with
 * pi running on a model that is held: pi stops the run to compact (that is how
 * it does a manual compaction, and it never picks the run up again), so the
 * portal has to carry on with the interrupted work itself.
 */
const home = inProcessHome("pithagoras-compaction-resume-");

/** Whether a request is pi summarising the conversation rather than the agent working. */
const summarising = (request) => JSON.stringify(request.messages).includes("context summarization assistant");
/** The words of the messages a request holds from the person. */
const userWords = (request) =>
  request.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text).join("")));

/** The requests the agent made while working, in the order they came: the summaries pi asks for are left out. */
const asked = [];
/** How many summaries pi has asked for. */
let summaries = 0;
/** What the next request that is not a summary waits for, if it is to be held; and the same for a summary. */
let hold;
let holdSummary;
const model = await fakeModel(async (request) => {
  if (summarising(request)) {
    summaries++;
    if (holdSummary) await holdSummary;
    return "The summary.";
  }
  asked.push(request);
  if (hold) await hold;
  return `Answer ${asked.length}.`;
});
writeFileSync(path.join(home, "agent", "models.json"), JSON.stringify(model.models()));
// Almost nothing is kept word for word, so that a short chat has something to summarise.
writeFileSync(path.join(home, "agent", "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "m", compaction: { keepRecentTokens: 1 } }));

const db = await import("../dist/db.js");

let base;
before(async () => {
  ({ base } = await startServer(serverEnv(home, await freePort())));
  // Opened while the server is still, so that it is not a write of the server that finds this one half way through.
  db.getDb();
});

const call = (url, init = {}) => fetch(base + url, { ...init, headers: { "Content-Type": "application/json" } });
const json = async (url, init) => {
  const res = await call(url, init);
  assert.ok(res.ok, `${url}: ${res.status} ${await res.clone().text()}`);
  return res.json();
};
const say = (chat, message) => json(`/api/sessions/${chat}/prompt`, { method: "POST", body: JSON.stringify({ message }) });
const until = async (ready, what) => {
  for (let i = 0; !(await ready()); i++) {
    assert.ok(i < 500, `waited 5 s for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
const idle = (chat) => db.getSession(chat).status === "idle";
const happened = (chat, type) => db.eventsSince(chat, 0).filter((e) => e.type === type).length;
/** What was sent to the agent in the chat, in the words of the page: the messages of the person and of the portal alike. */
const sent = (chat) => db.eventsSince(chat, 0).filter((e) => e.type === "portal_prompt").map((e) => JSON.parse(e.payload).message);
const RESUME = /compacted while you were working/;

/** A chat with `answered` messages answered, and one more that the agent is working on: its request is held. */
async function busyChat(answered = ["first", "second"]) {
  hold = undefined;
  holdSummary = undefined;
  asked.length = 0;
  const chat = (await json("/api/sessions", { method: "POST", body: "{}" })).id;
  for (const words of answered) {
    const before = asked.length;
    await say(chat, words);
    await until(() => asked.length > before && idle(chat), `${words} to be answered`);
  }
  let release;
  hold = new Promise((resolve) => (release = resolve));
  const before = asked.length;
  await say(chat, "third");
  await until(() => asked.length > before, "the third message to reach the model");
  return { chat, release: () => ((hold = undefined), release()) };
}
/** Waits for pi to have stopped the run for the compaction: only then is the held request let go. */
const compacting = (chat) => until(() => happened(chat, "compaction_start") > 0, "the compaction to start");
/** Holds the summary pi asks for, until the returned function lets it go. */
function holdTheSummary() {
  let letGo;
  holdSummary = new Promise((resolve) => (letGo = resolve));
  return letGo;
}

test("a chat compacted while the agent works goes on with the work by itself", async () => {
  const { chat, release } = await busyChat();
  const worked = asked.length;
  const compacted = call(`/api/sessions/${chat}/compact`, { method: "POST" });
  await compacting(chat);
  release();
  assert.equal((await compacted).status, 200);

  // The agent is asked again, and has the summary, the interrupted message and the word to go on in front of it.
  await until(() => asked.length > worked, "the agent to go on after the compaction");
  const resumed = asked.at(-1);
  assert.ok(JSON.stringify(resumed.messages).includes("The summary."));
  assert.match(userWords(resumed).at(-1), RESUME);
  await until(() => idle(chat), "the chat to settle");
  assert.equal(asked.length, worked + 1);
  assert.equal(happened(chat, "compaction_end"), 1);
  assert.equal(sent(chat).filter((words) => RESUME.test(words)).length, 1);
});

test("/compact typed into a working chat goes on with the work as well", async () => {
  const { chat, release } = await busyChat();
  const worked = asked.length;
  await say(chat, "/compact");
  await compacting(chat);
  release();
  await until(() => asked.length > worked, "the agent to go on after the compaction");
  assert.match(userWords(asked.at(-1)).at(-1), RESUME);
  await until(() => idle(chat), "the chat to settle");
  assert.equal(asked.length, worked + 1);
});

test("a compaction that fails still leaves the work to be carried on", async () => {
  // One message only: there is nothing yet that pi can summarise.
  const { chat, release } = await busyChat([]);
  const worked = asked.length;
  const compacted = call(`/api/sessions/${chat}/compact`, { method: "POST" });
  await until(() => happened(chat, "compaction_end") > 0, "the compaction to fail");
  release();
  const answer = await compacted;
  assert.equal(answer.status, 500);
  assert.match((await answer.json()).error, /Nothing to compact/);
  await until(() => asked.length > worked, "the agent to go on after the compaction");
  assert.match(userWords(asked.at(-1)).at(-1), RESUME);
  await until(() => idle(chat), "the chat to settle");
});

test("a chat that was not working is compacted and left alone", async () => {
  const { chat, release } = await busyChat();
  release();
  await until(() => idle(chat), "the third message to be answered");
  const worked = asked.length;
  await json(`/api/sessions/${chat}/compact`, { method: "POST" });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(asked.length, worked);
  assert.ok(idle(chat));
  assert.deepEqual(sent(chat).filter((words) => RESUME.test(words)), []);
});

test("a Stop pressed during the compaction ends the work: it is not carried on", async () => {
  const { chat, release } = await busyChat();
  const worked = asked.length;
  const before = summaries;
  const letGo = holdTheSummary();
  const compacted = call(`/api/sessions/${chat}/compact`, { method: "POST" });
  await compacting(chat);
  release();
  await until(() => summaries > before, "pi to ask for the summary");
  await json(`/api/sessions/${chat}/abort`, { method: "POST" });
  letGo();
  await compacted;
  await until(() => idle(chat), "the chat to settle");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(asked.length, worked);
  assert.deepEqual(sent(chat).filter((words) => RESUME.test(words)), []);
  assert.ok(idle(chat));
});

test("a message sent during the compaction carries the work on, with no word to go on behind it", async () => {
  const { chat, release } = await busyChat();
  const worked = asked.length;
  const before = summaries;
  const letGo = holdTheSummary();
  const compacted = call(`/api/sessions/${chat}/compact`, { method: "POST" });
  await compacting(chat);
  release();
  await until(() => summaries > before, "pi to ask for the summary");
  const typed = say(chat, "actually, do this instead");
  // Waiting behind the compaction by now: the message is on its way to pi, and the work with it.
  await new Promise((r) => setTimeout(r, 300));
  letGo();
  await compacted;
  await typed;
  await until(() => asked.length > worked && idle(chat), "the message to be answered");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(asked.length, worked + 1);
  assert.match(userWords(asked.at(-1)).at(-1), /do this instead/);
  assert.deepEqual(sent(chat).filter((words) => RESUME.test(words)), []);
});
