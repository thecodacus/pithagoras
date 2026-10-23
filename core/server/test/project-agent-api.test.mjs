import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * The agent a project works with, against the whole server: what the page reads and writes at
 * /api/projects/:name/agent, what the project list says of it, and what a project's link does when the
 * project or the agent goes.
 */
const home = inProcessHome("pithagoras-project-agent-api-");
const ws = path.join(home, "ws");
mkdirSync(path.join(ws, "research"), { recursive: true });
mkdirSync(path.join(ws, "dev"), { recursive: true });

// The server's own database, to see what the routes stored where none of them tells.
const db = await import("../dist/db.js");

let base;
before(async () => {
  ({ base } = await startServer(serverEnv(home, await freePort())));
});

const send = (url, method, body) =>
  fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (url, method = "GET", body) => {
  const res = await send(url, method, body);
  assert.ok(res.ok, `${url}: ${res.status} ${await res.clone().text()}`);
  return res.json();
};
const agentIds = async () => (await json("/api/agents")).agents.map((a) => a.id);
const newAgent = async (name) => (await json("/api/agents", "POST", { name })).id;

// Each test starts from projects that say nothing of their own, so any of them can be run alone.
beforeEach(() => {
  db.getDb().exec("DELETE FROM project_agent");
});

test("a project that said nothing is a blank slate: no agent, and so none of the memory an extension holds", async () => {
  assert.deepEqual(await json("/api/projects/research/agent"), { agent: null, memory: false, memoryAvailable: false });
});

test("the agent a project works with and its memory switch are stored by the project and read back", async () => {
  const nova = await newAgent("Nova");
  const saved = await json("/api/projects/research/agent", "PUT", { agent: nova });
  assert.deepEqual(saved, { agent: nova, memory: true, memoryAvailable: false });
  assert.deepEqual(db.projectAgent("research"), { agent: nova, memoryOff: false });

  // What is left out stays: the switch changes, the agent is still Nova's.
  const off = await json("/api/projects/research/agent", "PUT", { memory: false });
  assert.deepEqual(off, { agent: nova, memory: false, memoryAvailable: false });
  assert.deepEqual(await json("/api/projects/research/agent"), off);
  assert.deepEqual(db.projectAgent("research"), { agent: nova, memoryOff: true });

  // And the other way round: a blank slate again, the switch as it was.
  const blank = await json("/api/projects/research/agent", "PUT", { agent: null });
  assert.deepEqual(blank, { agent: null, memory: false, memoryAvailable: false });

  // Another project has what it had.
  assert.deepEqual(await json("/api/projects/dev/agent"), { agent: null, memory: false, memoryAvailable: false });
});

test("the project list says which agent each project works with, and the chat list's places do too", async () => {
  const nova = await newAgent("Nova");
  await json("/api/projects/research/agent", "PUT", { agent: nova, memory: false });
  const full = await json("/api/projects");
  const research = full.projects.find((p) => p.name === "research");
  assert.equal(research.agent, nova);
  assert.equal(research.memoryOff, true);
  const dev = full.projects.find((p) => p.name === "dev");
  assert.equal("agent" in dev, false);
  assert.equal("memoryOff" in dev, false);

  const places = await json("/api/projects?bare=1");
  assert.equal(places.projects.find((p) => p.name === "research").agent, nova);
  assert.equal("agent" in places.projects.find((p) => p.name === "dev"), false);
});

test("a request that names no agent, no project or something that is not a choice is refused and changes nothing", async () => {
  const nova = await newAgent("Nova");
  await json("/api/projects/research/agent", "PUT", { agent: nova });
  const refused = async (url, method, body, status) => {
    const res = await send(url, method, body);
    assert.equal(res.status, status, `${method} ${url} ${JSON.stringify(body)}`);
  };
  await refused("/api/projects/research/agent", "PUT", { agent: "nobody" }, 404);
  await refused("/api/projects/research/agent", "PUT", { agent: 7 }, 400);
  await refused("/api/projects/research/agent", "PUT", { memory: "no" }, 400);
  await refused("/api/projects/research/agent", "PUT", {}, 400);
  await refused("/api/projects/missing/agent", "PUT", { agent: nova }, 404);
  await refused("/api/projects/missing/agent", "GET", undefined, 404);
  assert.deepEqual(db.projectAgent("research"), { agent: nova, memoryOff: false });
});

test("a new project can be made with an agent and without the memory an extension holds, and a bad choice leaves no folder", async () => {
  const nova = await newAgent("Nova");
  const made = await json("/api/projects", "POST", { name: "linked-new", instructions: "Be brief.", agent: nova, memory: false });
  assert.equal(made.name, "linked-new");
  assert.deepEqual(db.projectAgent("linked-new"), { agent: nova, memoryOff: true });

  const bad = await send("/api/projects", "POST", { name: "never-made", agent: "nobody" });
  assert.equal(bad.status, 404);
  assert.equal(existsSync(path.join(ws, "never-made")), false);

  // Saying nothing is a blank slate, the way it was before there was a choice.
  await json("/api/projects", "POST", { name: "blank-new" });
  assert.deepEqual(db.projectAgent("blank-new"), { agent: "", memoryOff: false });
});

test("a folder of the same name left behind by an earlier project does not give its agent to a new one", async () => {
  const nova = await newAgent("Nova");
  db.setProjectAgent("left-behind", { agent: nova, memoryOff: true });
  await json("/api/projects", "POST", { name: "left-behind" });
  assert.deepEqual(db.projectAgent("left-behind"), { agent: "", memoryOff: false });
});

test("deleting the project forgets its agent; deleting the agent makes its projects blank slates", async () => {
  const nova = await newAgent("Nova");
  await json("/api/projects", "POST", { name: "short-lived", agent: nova });
  await json("/api/projects/short-lived", "DELETE");
  assert.equal(db.projectAgents().has("short-lived"), false);

  await json("/api/projects/research/agent", "PUT", { agent: nova });
  await json("/api/projects/dev/agent", "PUT", { agent: nova, memory: false });
  await json(`/api/agents/${nova}`, "DELETE");
  assert.equal((await agentIds()).includes(nova), false);
  assert.deepEqual(await json("/api/projects/research/agent"), { agent: null, memory: false, memoryAvailable: false });
  // What it said about the memory is the project's own, and stays.
  assert.deepEqual(await json("/api/projects/dev/agent"), { agent: null, memory: false, memoryAvailable: false });
  assert.equal("agent" in (await json("/api/projects")).projects.find((p) => p.name === "dev"), false);
});

test("the avatar of a chat in a linked project is its agent's", async () => {
  const nova = await newAgent("Nova");
  await json(`/api/agents/${nova}/orb`, "PUT", { personality: "calm" });
  const linked = await json("/api/sessions", "POST", { workspace: "research" });
  const before = await json(`/api/agent/orb?session=${linked.id}`);
  assert.notEqual(before.personality, "calm");

  await json("/api/projects/research/agent", "PUT", { agent: nova });
  assert.equal((await json(`/api/agent/orb?session=${linked.id}`)).personality, "calm");
  // A chat in a project that works with no one is the first agent's, as it was.
  const plain = await json("/api/sessions", "POST", { workspace: "dev" });
  assert.notEqual((await json(`/api/agent/orb?session=${plain.id}`)).personality, "calm");
  // And so is the agent voice mode is told it is with.
  const avatar = await json(`/api/agent/avatar?session=${linked.id}`);
  assert.deepEqual([avatar.agent.id, avatar.agent.name, avatar.orb.personality], [nova, "Nova", "calm"]);
  assert.notEqual((await json(`/api/agent/avatar?session=${plain.id}`)).agent.id, nova);
});
