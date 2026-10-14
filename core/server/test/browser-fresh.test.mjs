import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// A new install: no conversations, so nothing was ever granted and there is
// nothing to carry. The browser is a server like any other.
const home = inProcessHome("pithagoras-fresh-");
const mcp = path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json");
writeFileSync(mcp, JSON.stringify({ mcpServers: { browser: {} } }));

const { browserAllowed, browserByDefault, createSession, getDb, getSession, rememberTools, toolDefaultsOff } =
  await import("../dist/db.js");

createSession({ id: "first", title: "first", workspace: home, executor: "host" });

test("a fresh install adopts nothing", () => {
  const flag = getDb().prepare("SELECT value FROM settings WHERE key = 'browser_tools_adopted'").get();
  // Set when the database opened, before the conversation above existed.
  assert.equal(flag?.value, "1");
});

test("a browser no session has registered yet is on, like any server nobody has spoken about", () => {
  // The window between the server starting and the first session listing its
  // tools, and the case of a lazy server whose tools pi has not cached: the
  // question still gets asked, and refusing it would leave a browser that is
  // configured and cannot be switched.
  assert.equal(browserAllowed(getSession("first")), true);
  assert.equal(browserByDefault(), true);
});

test("registering the tools changes nothing about that", () => {
  rememberTools([{ name: "browser_browser_click", source: "pi-mcp-adapter" }]);
  // Code mode only, which every install starts with off.
  assert.deepEqual(toolDefaultsOff(), ["codemode"]);
  assert.equal(browserAllowed(getSession("first")), true);
});

test("with no browser server configured, there is nothing to have", () => {
  writeFileSync(mcp, JSON.stringify({ mcpServers: {} }));
  getDb().prepare("DELETE FROM settings WHERE key = 'tools_seen'").run();
  assert.equal(browserAllowed(getSession("first")), false);
  assert.equal(browserByDefault(), false);
});
