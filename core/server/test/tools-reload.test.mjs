import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "./server-harness.mjs";

inProcessHome("pithagoras-reload-");

const { SdkPiClient } = await import("../dist/pi/sdk-client.js");

/**
 * The parts of pi 1.x's AgentSession that decide which tools are active.
 *
 * The registry holds every definition, `grep`, `find` and `ls` among them, and
 * a session starts with only read/bash/edit/write plus the extensions' tools
 * active. Activation from anywhere ends in `_setActiveTools`, called on `this`:
 * an extension registering later and a reload call it themselves, and
 * `setActiveToolsByName`, which extensions reach, goes through it.
 */
function fakeSession() {
  const session = {
    registry: ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "browser_browser_click"],
    active: ["read", "bash", "edit", "write", "web_search", "browser_browser_click"],
    extension: ["web_search", "browser_browser_click"],
    getAllTools: () => session.registry.map((name) => ({ name })),
    getToolDefinition: (name) => (session.registry.includes(name) ? { name } : undefined),
    getActiveToolNames: () => [...session.active],
    _setActiveTools(names) {
      session.active = [...new Set(names)].filter((name) => session.registry.includes(name));
    },
    setActiveToolsByName(names) {
      this._setActiveTools(names);
    },
    /** `ctx.refreshTools()`: whatever was not there before comes up active. */
    register(name) {
      session.registry.push(name);
      session.extension.push(name);
      this._setActiveTools([...session.active, name]);
    },
    async reload() {
      // A new runner, bound as pi binds one, before the tools are refreshed.
      session._bindExtensionCore({ runtime: {} });
      this._setActiveTools([...session.active, ...session.extension]);
    },
    /** What every extension's `pi.getActiveTools()` / `pi.setActiveTools()` goes through. */
    _extensionRunner: null,
    _bindExtensionCore(runner) {
      runner.runtime.getActiveTools = () => session.getActiveToolNames();
      runner.runtime.setActiveTools = (names) => session.setActiveToolsByName(names);
      session._extensionRunner = runner;
    },
  };
  session._bindExtensionCore({ runtime: {} });
  return session;
}

const client = (session) => new SdkPiClient(session, {}, () => {});

test("switching one tool off does not switch on what pi left inactive", async () => {
  const session = fakeSession();
  const c = client(session);
  await c.setToolsOff(["web_search"]);
  assert.deepEqual(session.active, ["read", "bash", "edit", "write", "browser_browser_click"]);
  for (const name of ["grep", "find", "ls"]) assert.ok(!session.active.includes(name), name);
});

test("switching it back on restores what pi wanted, and no more", async () => {
  const session = fakeSession();
  const c = client(session);
  await c.setToolsOff(["web_search"]);
  await c.setToolsOff([]);
  assert.deepEqual(
    [...session.active].sort(),
    ["bash", "browser_browser_click", "edit", "read", "web_search", "write"]
  );
});

test("a tool that registers after the switch was made comes up off", async () => {
  const session = fakeSession();
  const c = client(session);
  await c.setToolsOff(["jira_create_issue"]);
  session.register("jira_create_issue");
  assert.ok(!session.active.includes("jira_create_issue"));
  // And one nobody switched off does come up.
  session.register("jira_search");
  assert.ok(session.active.includes("jira_search"));
});

test("a reload does not bring back what was switched off", async () => {
  const session = fakeSession();
  const c = client(session);
  await c.setToolsOff(["browser_browser_click"]);
  await c.reload();
  assert.ok(!session.active.includes("browser_browser_click"));
  assert.ok(session.active.includes("web_search"));
  assert.ok(!session.active.includes("grep"));
});

test("a reload with nothing switched off leaves pi's active set alone", async () => {
  const session = fakeSession();
  const c = client(session);
  await c.reload();
  assert.deepEqual([...session.active].sort(), [...fakeSession().active].sort());
});

test("only what the model could be offered is listed", async () => {
  const c = client(fakeSession());
  const names = (await c.getTools()).map((t) => t.name);
  assert.ok(names.includes("web_search"));
  // Registered, and inactive: a tick beside them would be a state the session
  // is not in.
  for (const name of ["grep", "find", "ls"]) assert.ok(!names.includes(name), name);
});

test("a tool switched off stays listed, and can come back, after pi refreshes its tools", async () => {
  const session = fakeSession();
  const c = client(session);
  await c.setToolsOff(["web_search"]);
  // pi builds the next set from the active one, which no longer has it.
  session.register("jira_search");
  const listed = await c.getTools();
  const web = listed.find((t) => t.name === "web_search");
  assert.ok(web, "web_search is still offered");
  assert.equal(web.enabled, false);
  await c.setToolsOff([]);
  assert.ok(session.active.includes("web_search"));
});

test("an extension narrowing the tools is taken at its word about what it could see; what is switched off stays the switch's", async () => {
  const session = fakeSession();
  const c = client(session);
  await c.setToolsOff(["web_search"]);
  // `pi.setActiveTools(["read", "grep"])`, a plan mode: bash and the rest are
  // dropped on purpose. web_search was not in what it could see, so it said
  // nothing about it: off while switched off, on once switched on.
  session._extensionRunner.runtime.setActiveTools(["read", "grep"]);
  assert.deepEqual([...session.active].sort(), ["grep", "read"]);
  assert.equal((await c.getTools()).find((t) => t.name === "web_search")?.enabled, false);
  await c.setToolsOff([]);
  assert.deepEqual([...session.active].sort(), ["grep", "read", "web_search"]);
});

test("a narrowing that is pi's own, not an extension's, means what it says", async () => {
  const session = fakeSession();
  const c = client(session);
  await c.setToolsOff(["web_search"]);
  session.setActiveToolsByName(["read", "grep"]);
  await c.setToolsOff([]);
  assert.deepEqual([...session.active].sort(), ["grep", "read"]);
});

test("a switched-off tool whose extension is gone is not wanted any more", async () => {
  const session = fakeSession();
  const c = client(session);
  await c.setToolsOff(["web_search"]);
  session.registry = session.registry.filter((name) => name !== "web_search");
  session.extension = session.extension.filter((name) => name !== "web_search");
  await c.reload();
  assert.ok(!(await c.getTools()).some((t) => t.name === "web_search"));
  // Were it back tomorrow, it would come up like any new tool: not from here.
  session.registry.push("web_search");
  await c.setToolsOff([]);
  assert.ok(!session.active.includes("web_search"));
});

test("an extension taking its own tools out of the set leaves what was switched off switchable", async () => {
  // pi-goal-x on session start: `setActiveTools(getActiveTools() minus its goal
  // tools)`. The switches were applied before it ran, so what it was shown had
  // no web_search in it — it said nothing about web_search. Taken as a
  // narrowing, web_search dropped out of the list for good: switched off before
  // the first message, it could not be switched back on in that chat.
  const session = fakeSession();
  const c = client(session);
  session.register("goal_get");
  session.register("goal_set");
  await c.setToolsOff(["web_search"]);
  const pi = () => session._extensionRunner.runtime;
  pi().setActiveTools(pi().getActiveTools().filter((name) => !name.startsWith("goal_")));
  const web = (await c.getTools()).find((t) => t.name === "web_search");
  assert.ok(web, "web_search is still offered");
  assert.equal(web.enabled, false);
  assert.ok(!session.active.includes("goal_get"), "what the extension took out stays out");
  await c.setToolsOff([]);
  assert.ok(session.active.includes("web_search"));
  assert.ok(!session.active.includes("goal_get"));
});



test("extensions are shown only what the model can call — a switched-off tool is not in it", async () => {
  // Shown switched-off tools as active, an extension writing "use web_search
  // for …" into the prompt told the model of a tool it could not call.
  const session = fakeSession();
  const c = client(session);
  await c.setToolsOff(["web_search"]);
  assert.ok(!session._extensionRunner.runtime.getActiveTools().includes("web_search"));
});

test("after a reload an extension's list still leaves what is switched off switchable", async () => {
  const session = fakeSession();
  const c = client(session);
  await c.setToolsOff(["web_search"]);
  await c.reload();
  const pi = session._extensionRunner.runtime;
  pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "bash"));
  assert.equal((await c.getTools()).find((t) => t.name === "web_search")?.enabled, false);
  await c.setToolsOff([]);
  assert.ok(session.active.includes("web_search"));
  assert.ok(!session.active.includes("bash"));
});
