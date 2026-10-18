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

/** The routine a conversation's `routine_create` makes, when it is given no workspace (or says home). */
async function created(id, kind, workspace, extra = {}, params = {}) {
  mkdirSync(workspace, { recursive: true });
  createSession({ id, title: id, workspace, executor: "host", kind, ...extra });
  const client = await sessions.ensureClient(id);
  try {
    const tools = {};
    routineTools(id)({ registerTool: (tool) => (tools[tool.name] = tool) });
    await tools.routine_create.execute("call", { name: `Daily ${id}`, instructions: "x", schedule: "@daily", ...params });
    return getDb().prepare("SELECT workspace FROM routines WHERE name = ?").get(`Daily ${id}`).workspace;
  } finally {
    client.dispose();
  }
}
const { routineTools } = await import("../dist/pi/routine-tools.js");
const { getDb } = await import("../dist/db.js");
const { routinesIn } = await import("../dist/api/routines.js");

test("a routine made in a second agent's chat runs in that agent's home, not the first agent's", async () => {
  const second = createAgent({ name: "Third" });
  assert.equal(await created("third-chat", "task", second.home), second.home);
  assert.equal(await created("third-home", "task", second.home, {}, { workspace: "home" }), second.home);
  assert.deepEqual(routinesIn(second.home).map((r) => r.name).sort(), ["Daily third-chat", "Daily third-home"]);
});

test("a routine made in the first agent's chat stays null, which follows the first agent's home", async () => {
  assert.equal(await created("first-routine", "task", process.env.AGENT_HOME), null);
});

test("a project named for the routine is kept as asked", async () => {
  const project = path.join(process.env.WORKSPACE_ROOT, "proj");
  mkdirSync(project, { recursive: true });
  const second = createAgent({ name: "Fourth" });
  assert.equal(await created("proj-routine", "task", second.home, {}, { workspace: project }), project);
});
