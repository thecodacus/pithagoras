import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * Child chats as the portal's pages see them: a listed child is in the chat list with its parent named, an unlisted one
 * only by its id, and deleting the parent deletes its children. The whole server, on a database this test writes the
 * chats into as a server half's `chats.create` would.
 */
const home = inProcessHome("pithagoras-child-chats-api-");
const { appendEvent, createSession, getDb } = await import("../dist/db.js");
const workspace = process.env.WORKSPACE_ROOT;
createSession({ id: "parent", title: "The work", workspace, executor: "host" });
createSession({ id: "shown", title: "A part of it", workspace, executor: "host", parent_id: "parent", listed: 1, creator: "helper" });
createSession({ id: "hidden", title: "Another part", workspace, executor: "host", parent_id: "parent", listed: 0, creator: "helper" });
createSession({ id: "other", title: "Something else", workspace, executor: "host" });
appendEvent("hidden", "portal_prompt", { message: "Look it up" });
// A project with a chat and its listed child, and a chat of the project's own.
const site = path.join(workspace, "site");
mkdirSync(site, { recursive: true });
createSession({ id: "site-chat", title: "Build the site", workspace: site, executor: "host" });
createSession({ id: "site-child", title: "Check the links", workspace: site, executor: "host", parent_id: "site-chat", listed: 1, creator: "helper" });
createSession({ id: "site-other", title: "Fix the logo", workspace: site, executor: "host" });

let base;
before(async () => {
  ({ base } = await startServer(serverEnv(home, await freePort())));
});
test.after(() => getDb().close());

const call = async (method, url) => {
  const res = await fetch(`${base}${url}`, { method });
  return { status: res.status, body: await res.json() };
};

test("the chat list has a listed child with its parent named, and not an unlisted one, which is found by its id", async () => {
  const sessions = (await call("GET", "/api/sessions")).body.sessions.filter((s) => s.workspace === workspace);
  const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(byId).sort(), ["other", "parent", "shown"]);
  assert.deepEqual([byId.shown.parent, byId.shown.listed], ["parent", true]);
  assert.equal("parent" in byId.parent, false, "a chat of its own names no parent");
  for (const s of sessions) assert.deepEqual([s.parent_id, s.creator], [undefined, undefined], "what is stored for it is the portal's");

  const hidden = await call("GET", "/api/sessions/hidden");
  assert.equal(hidden.status, 200);
  assert.deepEqual([hidden.body.parent, hidden.body.listed, hidden.body.title], ["parent", false, "Another part"]);
});

test("a child that waits on a person says so in the list, until its question has ended", async () => {
  const asking = async () => {
    const byId = Object.fromEntries((await call("GET", "/api/sessions")).body.sessions.map((s) => [s.id, s]));
    return [byId.shown.asking, byId.parent.asking];
  };
  assert.deepEqual(await asking(), [undefined, undefined]);
  appendEvent("shown", "portal_question", { id: "q1", questions: [{ id: "a", question: "Which one?", options: [{ label: "This" }] }] });
  assert.deepEqual(await asking(), [true, undefined], "the child asks; its parent's row works that out from its children");
  assert.equal((await call("GET", "/api/sessions/shown")).body.asking, true);
  appendEvent("shown", "portal_question_end", { of: "q1", outcome: "answered" });
  assert.deepEqual(await asking(), [undefined, undefined]);
});

test("the list reads a child's questions through their index, and a question whose wait is up does not count and is not ended by the poll", async () => {
  const { QUESTION_EVENTS } = await import("../dist/questions.js");
  const plan = getDb().prepare(`EXPLAIN QUERY PLAN ${QUESTION_EVENTS}`).all("shown").map((r) => r.detail).join("\n");
  assert.match(plan, /idx_events_questions/, "not a walk through every event of the chat");

  const events = () => getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = 'shown'").get().n;
  appendEvent("shown", "portal_question", { id: "q2", until: Date.now() - 1000, questions: [{ id: "a", question: "Still there?", options: [{ label: "Yes" }] }] });
  const before = events();
  const row = async () => (await call("GET", "/api/sessions")).body.sessions.find((s) => s.id === "shown");
  assert.equal((await row()).asking, undefined);
  assert.equal(events(), before, "listing the chats writes nothing");
  appendEvent("shown", "portal_question", { id: "q3", until: Date.now() + 60_000, questions: [{ id: "a", question: "Which?", options: [{ label: "This" }] }] });
  assert.equal((await row()).asking, true, "a question that still waits counts");
  getDb().prepare("DELETE FROM events WHERE session_id = 'shown' AND type = 'portal_question'").run();
});

test("deleting a chat deletes its children and their transcripts, and leaves the other chats", async () => {
  assert.equal((await call("DELETE", "/api/sessions/parent")).status, 200);
  for (const id of ["parent", "shown", "hidden"]) assert.equal((await call("GET", `/api/sessions/${id}`)).status, 404, id);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = 'hidden'").get().n, 0);
  assert.equal((await call("GET", "/api/sessions/other")).status, 200);
});

test("a project counts its chats without their children, and deleting it deletes them with their parents", async () => {
  const { projects } = (await call("GET", "/api/projects")).body;
  assert.equal(projects.find((p) => p.name === "site").sessions, 2, "the two chats of its own");
  assert.equal((await call("GET", "/api/projects/site")).body.sessions, 2);
  const deleted = await call("DELETE", "/api/projects/site?discard=1");
  assert.deepEqual([deleted.status, deleted.body.sessionsDeleted], [200, 2]);
  for (const id of ["site-chat", "site-child", "site-other"]) assert.equal((await call("GET", `/api/sessions/${id}`)).status, 404, id);
});
