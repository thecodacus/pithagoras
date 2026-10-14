import { test, before } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel } from "./fake-model.mjs";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * Messages sent while the agent works, against the whole server with pi running
 * on a model that is held: they can be taken back, or sent first.
 */
const home = inProcessHome("pithagoras-queued-");

/** The first request waits for this, so that the run is going while the test queues messages. */
let release;
let held = false;
/** Whether the held request was still waiting when each request came in. */
const heldWhenAsked = [];
let freed = false;
const model = await fakeModel(async () => {
  heldWhenAsked.push(held && !freed);
  if (!held) {
    held = true;
    await new Promise((resolve) => (release = () => ((freed = true), resolve())));
  }
  return "Done.";
});
writeFileSync(path.join(home, "agent", "models.json"), JSON.stringify(model.models()));
writeFileSync(path.join(home, "agent", "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "m" }));

const db = await import("../dist/db.js");

let base;
before(async () => {
  ({ base } = await startServer(serverEnv(home, await freePort())));
});

const call = (url, init = {}) =>
  fetch(base + url, { ...init, headers: { "Content-Type": "application/json" } });
const json = async (url, init) => {
  const res = await call(url, init);
  assert.ok(res.ok, `${url}: ${res.status} ${await res.clone().text()}`);
  return res.json();
};
const say = (chat, message, steer) =>
  json(`/api/sessions/${chat}/prompt`, { method: "POST", body: JSON.stringify({ message, ...(steer ? { steer: true } : {}) }) });
const until = async (ready, what) => {
  for (let i = 0; !(await ready()); i++) {
    assert.ok(i < 500, `waited 5 s for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
/** What waits for the agent, in the order sent: [seq, words]. */
const waiting = (chat) =>
  db.eventsSince(chat, 0).filter((e) => e.type === "portal_prompt" && JSON.parse(e.payload).queued === true).map((e) => [e.seq, JSON.parse(e.payload).message]);
/** The words of the messages a request holds from the person. */
const userWords = (request) =>
  request.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text).join("")));

/** A chat whose first message is being worked on, with two more behind it. */
async function busyChat() {
  held = false;
  freed = false;
  const before = model.requests.length;
  const chat = (await json("/api/sessions", { method: "POST", body: "{}" })).id;
  await say(chat, "first");
  await until(() => model.requests.length > before, "the model to be asked");
  // Both as steers, as a message typed mid-run is in the app.
  await say(chat, "second", true);
  await say(chat, "third", true);
  assert.deepEqual(waiting(chat).map(([, words]) => words), ["second", "third"]);
  return { chat, before };
}

test("a waiting message is taken back, the others keep their order, and the agent never reads it", async () => {
  const { chat, before } = await busyChat();
  const [[second]] = waiting(chat);
  await json(`/api/sessions/${chat}/queued/${second}`, { method: "DELETE" });
  assert.deepEqual(waiting(chat).map(([, words]) => words), ["third"]);
  // Sent again, "third" is still a steer: a plain delete keeps each message's lane.
  const resent = db.eventsSince(chat, 0).map((e) => e.type === "portal_prompt" && JSON.parse(e.payload)).filter((p) => p && p.queued === true && p.message === "third");
  assert.equal(resent.at(-1).steer, true);

  // Once it is gone it cannot be taken back again.
  const again = await call(`/api/sessions/${chat}/queued/${second}`, { method: "DELETE" });
  assert.equal(again.status, 409);
  assert.equal((await call(`/api/sessions/nobody/queued/1`, { method: "DELETE" })).status, 422);

  release();
  await until(() => model.requests.length >= before + 2, "the follow-up to be read");
  const words = userWords(model.requests.at(-1));
  assert.deepEqual(words.slice(-2), ["first", "third"]);
  assert.ok(!words.includes("second"));
});

test("send directly stops the run and sends that message first, the others behind it in their order", async () => {
  const { chat, before } = await busyChat();
  const [, [third]] = waiting(chat);
  await json(`/api/sessions/${chat}/queued/${third}/send`, { method: "POST" });

  // The chosen one starts a new turn while the stopped run's request is still held, and the model
  // is asked about it alone: the other is not steered into that request.
  await until(() => model.requests.length >= before + 2, "the message to reach the model");
  assert.equal(heldWhenAsked[before + 1], true, "the new turn began before the stopped request was let go");
  const first = userWords(model.requests[before + 1]);
  assert.deepEqual(first.slice(-2), ["first", "third"]);
  assert.ok(!first.includes("second"));
  // Only then is the other answered, behind it.
  await until(() => model.requests.length >= before + 3, "the other message to reach the model");
  assert.deepEqual(userWords(model.requests[before + 2]).slice(-3), ["first", "third", "second"]);
  // The chosen one started a run of its own; only the other waits in it, as a follow-up.
  const sent = db.eventsSince(chat, 0).filter((e) => e.type === "portal_prompt").map((e) => [JSON.parse(e.payload).message, JSON.parse(e.payload).queued, JSON.parse(e.payload).steer]);
  assert.deepEqual(sent, [["first", undefined, undefined], ["third", undefined, undefined], ["second", true, undefined]]);
  // Neither was dropped as not sent by the stop.
  assert.deepEqual(db.eventsSince(chat, 0).filter((e) => e.type === "portal_unsent"), []);
  release();
});
