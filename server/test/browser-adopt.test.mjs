import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// An install from before the portal's own browser tools: the Playwright MCP
// entry the portal wrote, and switches on its tools.
const home = inProcessHome("pithagoras-adopt-");
const mcpFile = path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json");
const CDP = "http://127.0.0.1:9222";
const managed = { command: "npx", args: ["-y", "@playwright/mcp@0.0.79", "--cdp-endpoint", CDP] };
writeFileSync(mcpFile, JSON.stringify({ mcpServers: { browser: managed, jira: { command: "jira-mcp" }, understory: { url: "http://127.0.0.1:3800/mcp" } } }));

const db = await import("../dist/db.js");
const { adoptPortalBrowser } = await import("../dist/api/browser.js");
const { PORTAL_BROWSER_TOOLS } = await import("../dist/tool-policy.js");

const OLD = ["browser_browser_click", "browser_browser_navigate", "browser_tabs"];
// What the old server left behind in the adapter's cache, with another server's entry beside it.
const cacheFile = path.join(process.env.PI_CODING_AGENT_DIR, "mcp-cache.json");
writeFileSync(cacheFile, JSON.stringify({ version: 1, servers: { browser: { tools: [{ name: "browser_click" }] }, jira: { tools: [{ name: "search" }] } } }));
db.rememberTools([
  ...OLD.map((name) => ({ name, source: "pi-mcp-adapter" })),
  // Reported by a chat that has the portal's own tools (the ones the old server's direct tools share names with), before the move.
  ...PORTAL_BROWSER_TOOLS.map((name) => ({ name, source: "browser", package: null })),
  { name: "jira_search", source: "pi-mcp-adapter" },
  { name: "understory_recall", source: "pi-mcp-adapter" },
  { name: "mcp", source: "pi-mcp-adapter" },
  { name: "mcpScript", source: "pi-mcp-adapter" },
]);
// The default has the browser off; one chat switched it on, another off on top of a project that had it on.
db.setToolDefaultsOff([...OLD, "jira_search"]);
db.createSession({ id: "has-it", title: "on", workspace: home, executor: "host" });
db.createSession({ id: "no-it", title: "off", workspace: home, executor: "host" });
db.createSession({ id: "silent", title: "untouched", workspace: home, executor: "host" });
db.setSessionTools("has-it", { off: [], on: OLD });
db.setSessionTools("no-it", { off: ["browser_browser_click"], on: [] });
db.setProjectTools("site", { off: [], on: OLD });
// And an agent's and a routine's own switches.
db.getDb().prepare("INSERT OR IGNORE INTO agents (id, name, home) VALUES ('scout', 'Scout', ?)").run(path.join(home, "scout"));
db.setAgentTools("scout", { off: [], on: OLD });
const { slug: routine } = (await import("../dist/routines/store.js")).insertRoutine({
  name: "Check", timing: { schedule: "0 9 * * *", runAt: null }, instructions: "Look", freshSession: false, reportChannel: null, reportTarget: null, workspace: null,
});
db.setRoutineTools(routine, { off: OLD, on: [] });

const has = (list) => PORTAL_BROWSER_TOOLS.every((name) => list.includes(name));
const mcp = () => JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers;

test("the first start moves over: the MCP entry goes, the portal's tools come on, every switch carried", () => {
  assert.equal(db.portalBrowserState(), "unset");
  adoptPortalBrowser();
  assert.equal(db.portalBrowserState(), "on");
  assert.deepEqual(Object.keys(mcp()), ["jira", "understory"], "only the entry the portal wrote is removed");
  assert.ok(has(db.toolDefaultsOff()), "off by default, as the browser was");
  assert.ok(db.toolDefaultsOff().includes("jira_search"));
  assert.ok(has(db.sessionTools("has-it").on), "a chat that had the browser still has it");
  assert.ok(has(db.sessionTools("no-it").off), "a chat that had it off still has it off");
  assert.deepEqual(db.sessionTools("silent"), { off: [], on: [] }, "a chat that said nothing still says nothing");
  assert.ok(has(db.projectTools("site").on), "and a project's say too");
  assert.ok(has(db.agentTools("scout").on), "an agent's");
  assert.ok(has(db.routineTools(routine).off), "and a routine's");
});

test("what the old server left behind goes: its tools and its cache entry, and nothing of the others", () => {
  const names = () => db.knownTools().map((t) => t.name);
  assert.ok(!OLD.some((name) => names().includes(name)), "the old server's tools are not listed any more");
  assert.ok(has(names()), "the portal's own browser tools stay");
  for (const kept of ["jira_search", "understory_recall", "mcp", "mcpScript"]) assert.ok(names().includes(kept), kept);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(cacheFile, "utf8")).servers), ["jira"], "the adapter forgets the server too");
  assert.ok(OLD.every((name) => db.toolDefaultsOff().includes(name)), "what was set for them is kept");
});

test("whether a chat may drive the browser reads the portal's tools from then on", () => {
  db.rememberTools(PORTAL_BROWSER_TOOLS.map((name) => ({ name, source: "browser" })));
  assert.equal(db.browserAllowed(db.getSession("has-it")), true);
  assert.equal(db.browserAllowed(db.getSession("no-it")), false);
  assert.equal(db.browserAllowed(db.getSession("silent")), false);
  assert.equal(db.browserConfigured(), true);
});

test("it runs once: a Playwright MCP added back by hand stays", () => {
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { browser: managed } }));
  adoptPortalBrowser();
  assert.deepEqual(Object.keys(mcp()), ["browser"]);
});

test("switched off, it stays off, and an install without the old entry is left alone", () => {
  db.setPortalBrowser(false);
  adoptPortalBrowser();
  assert.equal(db.portalBrowserState(), "off");
  db.getDb().prepare("DELETE FROM settings WHERE key = 'browser_tools'").run();
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: {} }));
  adoptPortalBrowser();
  assert.equal(db.portalBrowserState(), "unset", "a fresh install connects from the Browser page");
});
