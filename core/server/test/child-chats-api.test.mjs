import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel } from "./fake-model.mjs";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * Child chats as the portal's pages see them: a listed child is in the chat list with its parent named, an unlisted one
 * only by its id, and deleting the parent deletes its children. The whole server, on a database this test writes the
 * chats into as a server half's `chats.create` would.
 */
const home = inProcessHome("pithagoras-child-chats-api-");
const { appendEvent, createSession, getDb, getSession } = await import("../dist/db.js");
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
// A project with a chat of its own and one a server half started there unlisted (chats.start), with no parent.
const blog = path.join(workspace, "blog");
mkdirSync(blog, { recursive: true });
createSession({ id: "blog-chat", title: "Write a post", workspace: blog, executor: "host" });
createSession({ id: "blog-started", title: "Answer a comment", workspace: blog, executor: "host", listed: 0, creator: "helper", unattended: 1 });

// A model that does not answer until the test lets it: a chat that is working for as long as that takes.
let release = () => {};
const held = new Promise((resolve) => { release = resolve; });
const model = await fakeModel(async () => { await held; return "Done."; });
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "m" }));

let base;
before(async () => {
  ({ base } = await startServer(serverEnv(home, await freePort())));
});
test.after(() => getDb().close());

const call = async (method, url, body) => {
  const res = await fetch(`${base}${url}`, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
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

test("a chat a server half started unlisted is in no list, is found by its id, and is deleted with its project", async () => {
  const listed = (await call("GET", "/api/sessions")).body.sessions.map((s) => s.id);
  assert.ok(listed.includes("blog-chat") && !listed.includes("blog-started"));
  const started = await call("GET", "/api/sessions/blog-started");
  assert.equal(started.status, 200);
  assert.deepEqual([started.body.parent, started.body.creator, started.body.unattended], [undefined, undefined, undefined], "what is stored for it is the portal's");
  assert.equal((await call("GET", "/api/projects/blog")).body.sessions, 1, "the project counts the chats it lists");
  const deleted = await call("DELETE", "/api/projects/blog?discard=1");
  assert.equal(deleted.status, 200);
  for (const id of ["blog-chat", "blog-started"]) assert.equal((await call("GET", `/api/sessions/${id}`)).status, 404, id);
});

/** A chat a server half started unlisted in `folder` (chats.start), set working on a model that does not answer yet. */
async function working(id, folder) {
  createSession({ id, title: "Answer a comment", workspace: folder, executor: "host", listed: 0, creator: "helper", unattended: 1 });
  const asked = model.requests.length;
  assert.equal((await call("POST", `/api/sessions/${id}/prompt`, { message: "Take your time" })).status, 200);
  for (let i = 0; model.requests.length === asked; i++) {
    assert.ok(i < 400, "the chat never asked the model");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(getSession(id).status, "running");
}

test("a working chat a server half keeps out of the lists does not keep its project or its agent from being deleted: nobody could find it to stop it, and it is stopped with them", async (t) => {
  t.after(() => release());
  const news = path.join(workspace, "news");
  mkdirSync(news, { recursive: true });
  await working("news-started", news);
  const project = await call("DELETE", "/api/projects/news?discard=1");
  assert.deepEqual([project.status, project.body.sessionsDeleted], [200, 1], JSON.stringify(project.body));
  assert.equal((await call("GET", "/api/sessions/news-started")).status, 404);

  const agent = await call("POST", "/api/agents", { name: "Reader" });
  assert.equal(agent.status, 200, JSON.stringify(agent.body));
  await working("reader-started", agent.body.home);
  const deleted = await call("DELETE", `/api/agents/${agent.body.id}`);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal((await call("GET", "/api/sessions/reader-started")).status, 404, "it goes with the agent, listed or not");
});
