import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// A database and an agent directory of their own, before anything opens the
// real ones.
const home = inProcessHome("pithagoras-browser-");
// A server called `browser`, and one whose name merely starts with it.
writeFileSync(
  path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json"),
  JSON.stringify({ mcpServers: { browser: {}, browser_staging: {} } })
);

const {
  adoptBrowserGrants,
  browserAllowed,
  getDb,
  toolDefaultsOff,
  createSession,
  getSession,
  rememberTools,
  setSessionTools,
  setToolDefaultsOff,
} = await import("../dist/db.js");

const BROWSER = ["browser_browser_click", "browser_browser_navigate"];
/** Another server's tools, which start with `browser_` and are not the browser. */
const STAGING = ["browser_staging_click"];

rememberTools([
  ...[...BROWSER, ...STAGING].map((name) => ({ name, source: "pi-mcp-adapter" })),
  { name: "web_search", source: "pi-web-access" },
]);

createSession({
  id: "grant1",
  title: "grant",
  workspace: process.env.DATA_DIR,
  executor: "host",
});
/** Read back each time: browserAllowed asks the switches, not the row. */
const session = () => getSession("grant1");

test("a conversation has the browser when it has the browser's tools", () => {
  assert.equal(browserAllowed(session()), true);
});

test("switching the browser's tools off for one chat takes the browser with them", () => {
  setSessionTools("grant1", { off: BROWSER, on: [] });
  assert.equal(browserAllowed(session()), false);
  // One of them left on is still a conversation that reaches the browser.
  setSessionTools("grant1", { off: [BROWSER[0]], on: [] });
  assert.equal(browserAllowed(session()), true);
  setSessionTools("grant1", { off: [], on: [] });
});

test("switching them off by default takes it from every chat that has not said otherwise", () => {
  setToolDefaultsOff(BROWSER);
  assert.equal(browserAllowed(session()), false);
  // And a chat that says otherwise keeps it.
  setSessionTools("grant1", { off: [], on: [BROWSER[0]] });
  assert.equal(browserAllowed(session()), true);
  setToolDefaultsOff([]);
  setSessionTools("grant1", { off: [], on: [] });
});

test("a tool that is not the browser's does not grant it", () => {
  setSessionTools("grant1", { off: BROWSER, on: ["web_search"] });
  assert.equal(browserAllowed(session()), false);
});

test("a server whose name merely starts with browser_ does not grant the browser", () => {
  // browser_staging_click is on, the real browser's tools are off.
  setSessionTools("grant1", { off: BROWSER, on: STAGING });
  assert.equal(browserAllowed(session()), false);
  setSessionTools("grant1", { off: [], on: [] });
});

test("an upgrade keeps the posture the portal had", () => {
  // As it was before the browser became a server: off unless granted, and one
  // conversation that had been granted it.
  createSession({ id: "old-on", title: "granted", workspace: home, executor: "host" });
  createSession({ id: "old-off", title: "not granted", workspace: home, executor: "host" });
  getDb().prepare("UPDATE sessions SET browser = 1 WHERE id = 'old-on'").run();
  setToolDefaultsOff([]);
  setSessionTools("old-on", { off: [], on: [] });
  setSessionTools("old-off", { off: [], on: [] });
  getDb().prepare("DELETE FROM settings WHERE key = 'browser_tools_adopted'").run();

  adoptBrowserGrants();

  // Off by default now, so a chat that never asked does not suddenly have it.
  for (const name of BROWSER) assert.ok(toolDefaultsOff().includes(name), name);
  assert.equal(browserAllowed(getSession("old-off")), false);
  // And the one that had it keeps it, as its own exception.
  assert.equal(browserAllowed(getSession("old-on")), true);

  // Run once: a later change by the operator is not undone.
  setToolDefaultsOff([]);
  adoptBrowserGrants();
  assert.equal(browserAllowed(getSession("old-off")), true);
});

