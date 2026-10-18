import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * Which conversations may manage routines (issue #192): the chat a person starts with "+" is stored as a task, and
 * when it works in an agent's home it is a conversation with that agent like a channel's or the Agent page's. A task
 * in a project or any other folder, and a routine run, still do not get the tools.
 */
const home = inProcessHome("pithagoras-routine-tools-chats-");
const model = await fakeModel();
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));

const { createSession, getSettings, setSettings } = await import("../dist/db.js");
const { sessions } = await import("../dist/session-manager.js");
const { createAgent } = await import("../dist/agents.js");
setSettings({ ...getSettings(), provider: "fake", model: "m" });

const ROUTINE_TOOLS = ["routines_list", "routine_create", "routine_update", "routine_run"];

/** The names of the routine tools the pi of a session of this kind and folder has. */
async function toolsOf(id, kind, workspace, extra = {}) {
  mkdirSync(workspace, { recursive: true });
  createSession({ id, title: id, workspace, executor: "host", kind, ...extra });
  const client = await sessions.ensureClient(id);
  try {
    const names = (await client.getTools()).map((t) => t.name);
    return ROUTINE_TOOLS.filter((name) => names.includes(name));
  } finally {
    client.dispose();
  }
}

test("a chat started in the agent's own home gets the routine tools", async () => {
  assert.deepEqual(await toolsOf("home-chat", "task", process.env.AGENT_HOME), ROUTINE_TOOLS);
});

test("a chat in another agent's home gets them too", async () => {
  const other = createAgent({ name: "Second" });
  assert.deepEqual(await toolsOf("second-chat", "task", other.home), ROUTINE_TOOLS);
});

test("a chat in the agent's home still counts on the Agent page and in a channel", async () => {
  assert.deepEqual(await toolsOf("agent-page", "agent", process.env.AGENT_HOME, { channel_slug: "browser", channel_key: "page1234" }), ROUTINE_TOOLS);
});

test("a chat in a project or another folder does not", async () => {
  assert.deepEqual(await toolsOf("repo-chat", "task", path.join(process.env.WORKSPACE_ROOT, "repo")), []);
});

test("a chat in a folder inside the agent's home is a task in that folder, not a conversation with the agent", async () => {
  assert.deepEqual(await toolsOf("sub-chat", "task", path.join(process.env.AGENT_HOME, "some-project")), []);
});

test("a routine run in the agent's home does not, so a routine cannot build a chain", async () => {
  assert.deepEqual(await toolsOf("run", "routine", process.env.AGENT_HOME, { routine_slug: "nightly" }), []);
});

test("a heartbeat look in the agent's home does not", async () => {
  assert.deepEqual(await toolsOf("look", "heartbeat", process.env.AGENT_HOME), []);
});
