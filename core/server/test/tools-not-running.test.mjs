import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

const home = inProcessHome("pithagoras-idle-");

const { createSession, rememberTools, sessionTools, setToolDefaultsOff } = await import("../dist/db.js");
const { sessions } = await import("../dist/session-manager.js");

test("switching a default-off tool on is kept when nothing is running", async () => {
  // The page was drawn while the chat was live; by the time it answers the chat
  // has gone idle and been torn down. With nothing to have registered tools the
  // switch was in neither list, so no exception was written and the tool went
  // on following the default — under a 200.
  rememberTools([
    { name: "web_search", source: "pi-web-access" },
    { name: "web_fetch", source: "pi-web-access" },
  ]);
  setToolDefaultsOff(["web_search"]);
  createSession({ id: "idle", title: "idle", workspace: home, executor: "host" });

  // Everything the default has off except web_search, which is wanted on.
  const off = await sessions.setTools("idle", []);

  assert.deepEqual(sessionTools("idle"), { off: [], on: ["web_search"] });
  assert.deepEqual(off, []);
});

test("a chat that has not started lists the tools seen, and what is switched there is what it starts with", async () => {
  // Before the first message there is no pi to ask. The list used to be empty
  // ("send a message first"), so a tool could only be switched off for a chat
  // once it had already run with it.
  rememberTools([{ name: "bash", source: "builtin", description: "Run a command" }]);
  setToolDefaultsOff([]);
  createSession({ id: "fresh", title: "fresh", workspace: home, executor: "host" });

  const before = await sessions.getTools("fresh");
  assert.equal(before.live, false);
  const byName = Object.fromEntries(before.tools.map((t) => [t.name, t]));
  assert.ok(byName.web_search && byName.web_fetch && byName.bash, "every tool seen is listed");
  assert.equal(byName.bash.description, "Run a command");
  assert.equal(byName.web_search.enabled, true);

  await sessions.setTools("fresh", ["web_search", "web_fetch"]);

  // This chat's own, not the default: another new chat still has them.
  assert.deepEqual(sessionTools("fresh"), { off: ["web_fetch", "web_search"], on: [] });
  createSession({ id: "other", title: "other", workspace: home, executor: "host" });
  assert.ok((await sessions.getTools("other")).tools.every((t) => t.enabled));
  const after = await sessions.getTools("fresh");
  assert.deepEqual(after.tools.filter((t) => !t.enabled).map((t) => t.name).sort(), ["web_fetch", "web_search"]);
  // What pi is given when this chat starts.
  assert.deepEqual(sessions.offFor("fresh"), ["web_fetch", "web_search"]);
});
