import assert from "node:assert/strict";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { freePort, serverEnv, startServer, testHome } from "./server-harness.mjs";

// A delete that does not go through leaves its chats as they were, and a message to
// one of them is taken: they were marked as being deleted from the moment it began,
// and only the end of the route says they are not.

const home = testHome("delete-reopen-");
const { base } = await startServer(serverEnv(home, await freePort()));

const call = async (method, url, body) => {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

/** What a message to the chat is answered with: with no model it may fail, but not as a chat that is being deleted. */
const messageTaken = async (id) => {
  const sent = await call("POST", `/api/sessions/${id}/prompt`, { message: "hello" });
  assert.doesNotMatch(JSON.stringify(sent.body), /being deleted/);
  return sent;
};

/** Makes every delete of a chat fail, as a database that cannot be written to would. */
function refuseDeletes() {
  const db = new Database(path.join(home, "portal.db"));
  db.exec("CREATE TRIGGER refuse_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'delete refused'); END");
  return () => {
    db.exec("DROP TRIGGER refuse_delete");
    db.close();
  };
}

/** What of a chat is left in the database: its transcript and its stored canvases go before the chat's own row does. */
function whatIsLeft(id) {
  const db = new Database(path.join(home, "portal.db"), { readonly: true });
  try {
    const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(id).n;
    return { events: count("events"), canvases: count("canvases") };
  } finally {
    db.close();
  }
}

test("a chat whose delete failed takes messages again, and still has what it had", async () => {
  const chat = (await call("POST", "/api/sessions", {})).body;
  const db = new Database(path.join(home, "portal.db"));
  db.prepare("INSERT INTO events (session_id, type, payload) VALUES (?, 'user_message', '{}')").run(chat.id);
  db.prepare("INSERT INTO canvases (id, session_id, title, content) VALUES ('kept-canvas', ?, 'Notes', 'text')").run(chat.id);
  db.close();
  const allow = refuseDeletes();
  try {
    const refused = await call("DELETE", `/api/sessions/${chat.id}`);
    assert.equal(refused.status, 500);
    assert.match(refused.body.error, /delete refused/);
  } finally {
    allow();
  }
  // Each statement of the delete ran in turn: the chat is back in use, so it must not be one without its history.
  assert.deepEqual(whatIsLeft(chat.id), { events: 1, canvases: 1 });
  await messageTaken(chat.id);
  assert.equal((await call("DELETE", `/api/sessions/${chat.id}`)).status, 200, "and it can still be deleted");
});

test("the conversations of a channel whose delete with them failed take messages again", async () => {
  const db = new Database(path.join(home, "portal.db"));
  db.prepare("INSERT INTO channels (id, slug, kind, name, config, agent_id) VALUES ('chan1', 'door', 'test', 'Door', '{}', '')").run();
  db.prepare("INSERT INTO sessions (id, title, workspace, executor, kind, channel_slug, channel_key) VALUES ('door-chat', 'Sam', ?, 'host', 'agent', 'door', 'door:chat:1')")
    .run(path.join(home, "agent-home"));
  db.close();
  const allow = refuseDeletes();
  try {
    const refused = await call("DELETE", "/api/channels/chan1?sessions=delete");
    assert.equal(refused.status, 500);
    assert.match(refused.body.error, /delete refused/);
  } finally {
    allow();
  }
  await messageTaken("door-chat");
});

test("the chats of a project whose folder could not be removed take messages again", { skip: process.getuid?.() === 0 }, async () => {
  const root = path.join(home, "ws");
  mkdirSync(root, { recursive: true });
  const project = await call("POST", "/api/projects", { name: "Stays" });
  assert.equal(project.status, 200, JSON.stringify(project.body));
  const chat = (await call("POST", "/api/sessions", { workspace: project.body.path })).body;
  // The folder is put aside by a rename in its parent, or removed there: neither can be done in one that cannot be written to.
  chmodSync(root, 0o555);
  try {
    const refused = await call("DELETE", `/api/projects/${project.body.name}`);
    assert.equal(refused.status, 500, JSON.stringify(refused.body));
  } finally {
    chmodSync(root, 0o755);
  }
  await messageTaken(chat.id);
});
