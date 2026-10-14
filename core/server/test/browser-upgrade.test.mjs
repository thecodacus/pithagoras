import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// An install that already has conversations in it, opened the way a server
// opens it after an upgrade: the database first, the tools later.
const home = inProcessHome("pithagoras-upgrade-");
writeFileSync(
  path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json"),
  JSON.stringify({ mcpServers: { browser: {} } })
);

const {
  adoptBrowserGrants,
  browserAllowed,
  browserByDefault,
  browserExceptions,
  createSession,
  getDb,
  getSession,
  rememberTools,
  sessionTools,
  setSessionTools,
  setToolDefaultsOff,
  toolDefaultsOff,
} = await import("../dist/db.js");

const BROWSER = ["browser_browser_click", "browser_browser_navigate"];
const seen = () => [
  ...BROWSER.map((name) => ({ name, source: "pi-mcp-adapter" })),
  { name: "web_search", source: "pi-web-access" },
];
const flag = () =>
  getDb().prepare("SELECT value FROM settings WHERE key = 'browser_tools_adopted'").get()?.value;

// What the database looked like before this build: conversations, one of which
// was given the browser, and no record of any tool.
createSession({ id: "was-on", title: "granted", workspace: home, executor: "host" });
createSession({ id: "was-off", title: "not granted", workspace: home, executor: "host" });
getDb().prepare("UPDATE sessions SET browser = 1 WHERE id = 'was-on'").run();
getDb().prepare("DELETE FROM settings WHERE key IN ('browser_tools_adopted', 'tools_seen')").run();

test("the first start after an upgrade has nothing to carry yet, and does not pretend to", () => {
  adoptBrowserGrants();
  // Not done: no session has registered a tool, so there is no telling which
  // are the browser's. Marking it done here is what made the migration a no-op.
  assert.equal(flag(), "pending");
  // Code mode only, which an upgrade switches off by default.
  assert.deepEqual(toolDefaultsOff(), ["codemode"]);
});

test("until the tools are seen, the old grant stands", () => {
  assert.equal(browserAllowed(getSession("was-on")), true);
  assert.equal(browserAllowed(getSession("was-off")), false);
  assert.equal(browserByDefault(), false);
});

test("the first session to register them carries the posture over", () => {
  // The order production has: the database is open long before any session
  // launches and reports its tools.
  rememberTools(seen());
  // Not "1": the posture keeps applying to browser tools that turn up later.
  assert.equal(flag(), "carry");
  for (const name of BROWSER) assert.ok(toolDefaultsOff().includes(name), name);
  assert.deepEqual(sessionTools("was-on").on, BROWSER);
  assert.equal(browserAllowed(getSession("was-on")), true);
  assert.equal(browserAllowed(getSession("was-off")), false);
  assert.equal(browserByDefault(), false);
});

test("and only once", () => {
  getDb().prepare("DELETE FROM settings WHERE key = 'tools_off_default'").run();
  rememberTools(seen());
  assert.deepEqual(toolDefaultsOff(), []);
  assert.equal(browserAllowed(getSession("was-off")), true);
});

test("a browser tool that turns up later is carried the same way", () => {
  // A lazy server has cached some of its tools and not others, and a pinned
  // version that is bumped adds names. Neither may arrive default-on on an
  // install that was upgraded to keep the browser off.
  setToolDefaultsOff(BROWSER);
  rememberTools([{ name: "browser_browser_type", source: "pi-mcp-adapter" }]);
  assert.ok(toolDefaultsOff().includes("browser_browser_type"));
  assert.ok(sessionTools("was-on").on.includes("browser_browser_type"));
  assert.equal(browserAllowed(getSession("was-off")), false);
  assert.equal(browserAllowed(getSession("was-on")), true);
  // And one that is not the browser's is left alone.
  rememberTools([{ name: "web_fetch", source: "pi-web-access" }]);
  assert.ok(!toolDefaultsOff().includes("web_fetch"));
});

test("a grant that still lives in the column is listed, whatever the tools say", () => {
  // The Browser page lists the conversations that disagree with the default.
  // Filtering on the tools columns first left it empty exactly where the column
  // is the only record — a container deployment, or an upgrade still waiting.
  setSessionTools("was-on", { off: [], on: [] });
  setToolDefaultsOff([]);
  getDb().prepare("UPDATE settings SET value = 'pending' WHERE key = 'browser_tools_adopted'").run();
  getDb().prepare("DELETE FROM settings WHERE key = 'tools_seen'").run();
  assert.deepEqual(
    browserExceptions().map((row) => row.id),
    ["was-on"]
  );
});
