import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * An agent's and a routine's own tool switches (#81), against the whole server:
 * what their pages read and write, and what a chat or a run under them starts
 * with. The layers, each an exception to the one before it: the portal-wide
 * default, the agent, the project, the routine, and the chat's own.
 */
const home = inProcessHome("pithagoras-tool-layers-api-");
mkdirSync(path.join(home, "ws", "research"), { recursive: true });
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({}));

const db = await import("../dist/db.js");
db.rememberTools([
  { name: "web_search", source: "pi-web-access" },
  { name: "web_fetch", source: "pi-web-access" },
  { name: "bash", source: "built in", package: null },
  // The portal's own browser tool: what a routine's old Browser switch answers for.
  { name: "browser_navigate", source: "browser", package: null, inline: true },
]);

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
const states = (r) => Object.fromEntries(r.tools.map((t) => [t.name, t.enabled]));

beforeEach(async () => {
  await json("/api/tools", "PUT", { off: ["web_fetch"] });
  db.getDb().exec("DELETE FROM project_tools; DELETE FROM agent_tools; UPDATE routines SET tools_off = '', tools_on = ''");
});

/** A routine, made as the page makes one, in Home or a project. */
const routine = async (name, workspace) =>
  json("/api/routines", "POST", { name, schedule: "0 9 * * *", instructions: "Do it", ...(workspace ? { workspace } : {}) });

/** A session that is a run of the routine, as the supervisor makes one. */
function runOf(r, workspace) {
  const id = `run-${r.slug}`;
  if (!db.getSession(id)) db.createSession({ id, title: r.name, workspace, executor: "host", kind: "routine", routine_slug: r.slug });
  return id;
}

test("an agent's switches are exceptions to the default, for every chat in its home", async () => {
  const agent = await json("/api/agents", "POST", { name: "Reader" });
  const before = await json(`/api/agents/${agent.id}/tools`);
  assert.deepEqual(states(before), { bash: true, browser_navigate: true, web_fetch: false, web_search: true });
  assert.equal(before.live, false);

  // Both ways: bash off where the default has it on, web_fetch on where the default has it off.
  const saved = await json(`/api/agents/${agent.id}/tools`, "PUT", { off: ["bash"] });
  assert.deepEqual(saved.off, ["bash"]);
  assert.deepEqual(db.agentTools(agent.id), { off: ["bash"], on: ["web_fetch"] });

  const chat = await json("/api/sessions", "POST", { agent: agent.id });
  assert.deepEqual(states(await json(`/api/sessions/${chat.id}/tools`)), { bash: false, browser_navigate: true, web_fetch: true, web_search: true });
  // Another agent's chats, and a project's, are not this agent's.
  const other = await json("/api/sessions", "POST", {});
  assert.deepEqual(states(await json(`/api/sessions/${other.id}/tools`)), { bash: true, browser_navigate: true, web_fetch: false, web_search: true });
  const project = await json("/api/sessions", "POST", { workspace: "research" });
  assert.equal(states(await json(`/api/sessions/${project.id}/tools`)).bash, true);

  // A later change to the default reaches what the agent never said anything about.
  await json("/api/tools", "PUT", { off: ["web_fetch", "web_search"] });
  assert.equal(states(await json(`/api/sessions/${chat.id}/tools`)).web_search, false);
  // And the chat's own switch is the last word.
  await json(`/api/sessions/${chat.id}/tools`, "PUT", { off: ["web_search"] });
  assert.equal(states(await json(`/api/sessions/${chat.id}/tools`)).bash, true);
});

test("the first agent's switches reach its chats, its heartbeat and the routines in Home", async () => {
  await json("/api/agents/home/tools", "PUT", { off: ["web_fetch", "web_search"] });
  const chat = await json("/api/sessions", "POST", {});
  assert.equal(states(await json(`/api/sessions/${chat.id}/tools`)).web_search, false);
  const r = await routine("Home routine");
  const run = runOf(r, db.getSession(chat.id).workspace);
  assert.equal(states(await json(`/api/sessions/${run}/tools`)).web_search, false);
  // The routine's page shows what its agent leaves as its default.
  const page = await json(`/api/routines/${r.id}/tools`);
  assert.equal(page.tools.find((t) => t.name === "web_search").defaultOn, false);
});

test("a routine's switches come after its agent and its project, and a run's chat has the last word", async () => {
  await json("/api/projects/research/tools", "PUT", { off: ["web_fetch", "bash"] });
  const r = await routine("Research digest", "research");
  const page = await json(`/api/routines/${r.id}/tools`);
  // The project's, with the browser off as a routine's always was.
  assert.deepEqual(states(page), { bash: false, browser_navigate: false, web_fetch: false, web_search: true });
  assert.equal(page.tools.find((t) => t.name === "bash").defaultOn, false, "what the layers under it say");
  assert.equal(page.tools.find((t) => t.name === "browser_navigate").defaultOn, true);

  await json(`/api/routines/${r.id}/tools`, "PUT", { off: ["web_fetch", "web_search", "browser_navigate"] });
  assert.deepEqual(db.routineTools(r.slug), { off: ["browser_navigate", "web_search"], on: ["bash"] });
  const run = runOf(r, path.join(home, "ws", "research"));
  assert.deepEqual(states(await json(`/api/sessions/${run}/tools`)), { bash: true, browser_navigate: false, web_fetch: false, web_search: false });
  await json(`/api/sessions/${run}/tools`, "PUT", { off: ["web_fetch", "web_search", "browser_navigate"] });
  assert.equal(states(await json(`/api/sessions/${run}/tools`)).bash, true);
  await json(`/api/sessions/${run}/tools`, "PUT", { off: ["web_fetch", "browser_navigate"] });
  assert.equal(states(await json(`/api/sessions/${run}/tools`)).web_search, true, "the run's chat switched it on for itself");
});

test("the browser is a routine's tools now: off unless switched on, and its old switch is kept", async () => {
  const r = await routine("Shop check");
  const run = runOf(r, db.getSession((await json("/api/sessions", "POST", {})).id).workspace);
  const row = () => db.getSession(run);
  assert.equal(db.browserAllowed(row()), false, "a new routine has no browser");
  assert.deepEqual(db.routineTools(r.slug), { off: ["browser_navigate"], on: [] }, "its switch answers for what its lists do not name");

  // Switched on in the tools list: its runs may drive it, and the old switch follows.
  await json(`/api/routines/${r.id}/tools`, "PUT", { off: ["web_fetch"] });
  assert.equal(db.browserAllowed(row()), true);
  assert.equal(states(await json(`/api/sessions/${run}/tools`)).browser_navigate, true);
  assert.equal(db.getDb().prepare("SELECT browser FROM routines WHERE id = ?").get(r.id).browser === 1, true);

  // The old switch through the API still does what it says, after the page has saved.
  await json(`/api/routines/${r.id}`, "PATCH", { browser: false });
  assert.equal(db.browserAllowed(row()), false);
  await json(`/api/routines/${r.id}`, "PATCH", { browser: true });
  assert.equal(db.browserAllowed(row()), true);

  // A browser tool that turns up later starts as the old switch says; what the page wrote down stays.
  await json(`/api/routines/${r.id}/tools`, "PUT", { off: ["web_fetch"] });
  db.getDb().prepare("UPDATE routines SET browser = 0 WHERE id = ?").run(r.id);
  db.rememberTools([{ name: "browser_click", source: "browser", package: null, inline: true }]);
  assert.ok(db.routineTools(r.slug).off.includes("browser_click"));
  assert.ok(db.routineTools(r.slug).on.includes("browser_navigate"), "what was said stays");
});

test("the Browser page lists the chats an agent's switches give the browser", async () => {
  const agent = await json("/api/agents", "POST", { name: "Surfer" });
  db.setToolDefaultsOff(["web_fetch", "browser_navigate", "browser_click"]);
  db.createSession({ id: "surfer-chat", title: "Surfing", workspace: agent.home, executor: "host" });
  assert.ok(!db.browserExceptions().some((row) => row.id === "surfer-chat"));
  db.setAgentTools(agent.id, { off: [], on: ["browser_navigate"] });
  assert.ok(db.browserExceptions().some((row) => row.id === "surfer-chat"));
  db.setToolDefaultsOff(["web_fetch"]);
});

test("an agent or routine that is not there is not found", async () => {
  assert.equal((await send("/api/agents/nobody/tools")).status, 404);
  assert.equal((await send("/api/routines/nothing/tools", "PUT", { off: [] })).status, 404);
  assert.equal((await send("/api/agents/home/tools", "PUT", { off: "bash" })).status, 400);
});

test("a tool held off that the page does not list stays off when another is switched", async () => {
  // As an MCP tool the configuration leaves out for now, or a package not loaded: not listed, so not answered for.
  const agent = await json("/api/agents", "POST", { name: "Holder" });
  db.setAgentTools(agent.id, { off: ["jira_create_issue"], on: [] });
  await json(`/api/agents/${agent.id}/tools`, "PUT", { off: ["web_fetch", "bash"] });
  assert.deepEqual(db.agentTools(agent.id).off, ["bash", "jira_create_issue"]);

  // Off below as well: not taken for one switched back on.
  db.setToolDefaultsOff(["web_fetch", "jira_create_issue"]);
  db.setAgentTools(agent.id, { off: ["jira_create_issue"], on: [] });
  await json(`/api/agents/${agent.id}/tools`, "PUT", { off: ["web_fetch"] });
  assert.deepEqual(db.agentTools(agent.id), { off: ["jira_create_issue"], on: [] });
  db.setToolDefaultsOff(["web_fetch"]);

  const r = await routine("Holding");
  db.setRoutineTools(r.slug, { off: ["jira_create_issue"], on: [] });
  await json(`/api/routines/${r.id}/tools`, "PUT", { off: ["web_fetch", "bash"] });
  assert.ok(db.routineTools(r.slug).off.includes("jira_create_issue"));
});

test("a routine's page works out its place as its runs do, and says so when they cannot run there", async () => {
  const r = await routine("Gone", "research");
  assert.equal((await send(`/api/routines/${r.id}/tools`)).status, 200);
  db.getDb().prepare("UPDATE routines SET workspace = ? WHERE id = ?").run("/nowhere/at/all", r.id);
  const res = await send(`/api/routines/${r.id}/tools`);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /cannot be used/);
});

test("a browser tool its lists do not name follows a routine's switch, however late it comes to be one", async () => {
  const r = await routine("Late");
  db.rememberTools([{ name: "browser_snapshot", source: "browser", package: null, inline: true }]);
  assert.ok(db.routineTools(r.slug).off.includes("browser_snapshot"));
  db.setRoutineBrowser(r.slug, true);
  assert.ok(db.routineTools(r.slug).on.includes("browser_snapshot"));
});

test("a project's chats follow the project, even where the projects' folder is inside an agent's home", () => {
  const homes = [{ id: "home", home: path.dirname(process.env.WORKSPACE_ROOT ?? path.join(home, "ws")) }];
  const project = path.join(process.env.WORKSPACE_ROOT ?? path.join(home, "ws"), "research");
  assert.equal(db.agentIdOf(project, homes), undefined);
  assert.equal(db.agentIdOf(homes[0].home, homes), "home");
});
