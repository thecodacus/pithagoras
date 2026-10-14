import { test, before } from "node:test";
import assert from "node:assert/strict";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * The Agent tab asks for the first agent's conversations without naming one. The
 * first agent is the one the portal calls that, not an id the code expects: a
 * database whose first agent has another id still has an Agent tab.
 */
const home = inProcessHome("pithagoras-agent-default-");
const { getDb } = await import("../dist/db.js");

let base;
before(async () => {
  ({ base } = await startServer(serverEnv(home, await freePort())));
});

test("the Agent tab without ?agent= answers for the first agent, whatever its id", async () => {
  const plain = await fetch(`${base}/api/agent/sessions`);
  assert.equal(plain.status, 200);

  getDb().prepare("UPDATE agents SET id = 'first-one' WHERE id = 'home'").run();
  const renamed = await fetch(`${base}/api/agent/sessions`);
  assert.equal(renamed.status, 200);
  assert.deepEqual(Object.keys(await renamed.json()).sort(), ["agentHome", "sessions"]);

  // An agent that is named and not there is still not found.
  assert.equal((await fetch(`${base}/api/agent/sessions?agent=nobody`)).status, 404);
});

test("a conversation begun on the Agent page is the owner's, whoever is named primary: a command typed there is not refused", async () => {
  getDb().prepare("INSERT INTO people (key, name, role) VALUES ('tg:owner', 'Sam', 'primary')").run();
  const post = async (url, body) => (await fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const page = await post("/api/agent/sessions", { title: "From the page" });
  const refusal = /only be run by the primary user/;
  const sent = await post(`/api/sessions/${page.id}/prompt`, { message: "/compact" });
  assert.doesNotMatch(String(sent.failed ?? ""), refusal, "the owner, signed in, is not a stranger in their own chat");
  // What a channel's own conversation, in which nobody was named, still is.
  getDb()
    .prepare("INSERT INTO sessions (id, title, workspace, executor, kind, channel_slug, channel_key) VALUES ('strangers', 'x', ?, 'host', 'agent', 'tg', 'tg:nobody')")
    .run(home);
  assert.match((await post("/api/sessions/strangers/prompt", { message: "/compact" })).failed, refusal);
});
