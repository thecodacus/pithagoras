import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

// A portal's Tools page listed 27 `browser_browser_*` tools of a Playwright server called `browser` that had been taken
// out of mcp.json by an edit made outside the portal: only a write of the portal's own took a removed server's tools
// out, so an edit by hand left them remembered, and in the adapter's cache, for ever.
const home = inProcessHome("pithagoras-mcp-edited-outside-");
const agent = process.env.PI_CODING_AGENT_DIR;
writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: ["npm:pi-mcp-adapter@2.18.0"] }));
const mcpPath = path.join(agent, "mcp.json");
const cachePath = path.join(agent, "mcp-cache.json");
/** The file written as a shell or an editor writes it: not through the portal. */
const byHand = (servers) => writeFileSync(mcpPath, JSON.stringify({ mcpServers: servers }));
const cacheFile = (servers) => writeFileSync(cachePath, JSON.stringify({ version: 1, servers }));
const cached = () => Object.keys(JSON.parse(readFileSync(cachePath, "utf8")).servers).sort();
const adapter = (name) => ({ name, source: "pi-mcp-adapter", package: "npm:pi-mcp-adapter@2.18.0" });

const db = await import("../dist/db.js");
const { sessions } = await import("../dist/session-manager.js");
const { onMcpWritten, writeMcpFile } = await import("../dist/api/mcp.js");

const setting = (key) => db.getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;
const removed = () => JSON.parse(setting("mcp_removed") ?? "[]");
const configured = () => JSON.parse(setting("mcp_configured"));
const listed = () => db.shownTools().map((t) => t.name).sort();
const known = () => db.knownTools().map((t) => t.name);

// The running chats are told as the server tells them (server.ts), and the test waits for them to have been.
let telling = Promise.resolve();
onMcpWritten(() => {
  telling = sessions.applyToolDefaults();
});

const JIRA = { command: "jira-mcp" };

test("the first time there is nothing to compare with: the servers in the file are remembered, and nothing is judged", () => {
  // As on a portal upgrading to this after `old` was taken out of the file by hand: its entry left in the adapter's
  // cache and its tools in what the portal remembers. Nothing tells them from a server of a project's own files.
  byHand({ jira: JIRA });
  cacheFile({ jira: { tools: [{ name: "search" }] }, old: { tools: [{ name: "lookup" }] } });
  db.rememberTools([adapter("jira_search"), adapter("old_lookup"), adapter("mcp")]);
  assert.equal(setting("mcp_configured"), undefined);
  assert.ok(listed().includes("old_lookup"));
  assert.deepEqual(configured(), ["jira"]);
  assert.deepEqual(removed(), []);
  assert.deepEqual(cached(), ["jira", "old"]);
  assert.ok(known().includes("old_lookup"));
});

test("a server taken out of mcp.json by hand is removed as through the panel, and a chat still running with it has its tools off", async () => {
  byHand({ jira: JIRA, browser: { command: "npx", args: ["@playwright/mcp"] } });
  cacheFile({ jira: { tools: [{ name: "search" }] }, browser: { tools: [{ name: "browser_navigate" }, { name: "browser_click" }] } });
  db.rememberTools([adapter("browser_browser_navigate"), adapter("browser_browser_click")]);
  assert.ok(listed().includes("browser_browser_click"));
  assert.deepEqual(configured(), ["browser", "jira"], "the server added by hand is remembered");

  // A chat that started while the server was there, and has its tools loaded.
  const reported = ["browser_browser_navigate", "browser_browser_click", "jira_search", "mcp", "bash"].map((name) => ({ name, source: name === "bash" ? "built in" : "pi-mcp-adapter" }));
  const told = [];
  db.createSession({ id: "running", title: "running", workspace: home, executor: "host" });
  sessions.live.set("running", { client: { getTools: async () => reported, setToolsOff: async (off) => { told.push(off); } } });
  try {
    byHand({ jira: JIRA });
    const shown = listed();
    assert.ok(!shown.some((name) => name.startsWith("browser_browser_")), shown.join(", "));
    assert.ok(shown.includes("jira_search") && shown.includes("mcp"));
    assert.ok(!known().some((name) => name.startsWith("browser_browser_")), "forgotten, not only hidden");
    assert.deepEqual(cached(), ["jira"], "its entry is out of the adapter's cache");
    assert.deepEqual(removed(), ["browser"]);
    assert.deepEqual(configured(), ["jira"]);
    await telling;
    assert.ok(told.length, "the running chat was told");
    assert.deepEqual(told.at(-1).filter((name) => name.startsWith("browser_")), ["browser_browser_click", "browser_browser_navigate"]);
    assert.ok(!told.at(-1).includes("jira_search"));
    const off = sessions.piOff("running", reported);
    assert.ok(off.includes("browser_browser_navigate") && off.includes("browser_browser_click"));
    // What the chat reports again is not remembered again.
    db.rememberTools(reported.slice(0, 2).map((t) => adapter(t.name)));
    assert.ok(!known().includes("browser_browser_click"));
  } finally {
    sessions.live.delete("running");
  }
});

test("a file that cannot be read takes nothing out, and the one that fixes it is compared with the servers last seen", () => {
  writeMcpFile({ mcpServers: { jira: JIRA, notes: { command: "notes-mcp" } } });
  db.rememberTools([adapter("notes_read")]);
  writeFileSync(mcpPath, "{ not json");
  assert.ok(listed().includes("notes_read"), "a typo takes nothing out");
  assert.deepEqual(configured(), ["jira", "notes"]);
  assert.deepEqual(removed(), ["browser"]);
  // Fixed by hand, without notes.
  byHand({ jira: JIRA });
  assert.ok(!listed().includes("notes_read"));
  assert.ok(!known().includes("notes_read"));
  assert.deepEqual(removed(), ["browser", "notes"]);
});

test("a tool of a server the portal's file never had, as one of a project's own, stays listed and on", () => {
  byHand({ jira: JIRA });
  // The adapter loads `cursorsrv` from a .mcp.json in the project: it is in no file the portal writes.
  db.rememberTools([adapter("cursorsrv_lookup")]);
  listed();
  byHand({ jira: JIRA, scratch: { command: "s" } });
  listed();
  byHand({ jira: JIRA });
  assert.ok(listed().includes("cursorsrv_lookup"));
  assert.ok(known().includes("cursorsrv_lookup"));
  assert.ok(!removed().includes("cursorsrv"));
  db.createSession({ id: "in-project", title: "in-project", workspace: home, executor: "host" });
  assert.ok(!sessions.piOff("in-project", [{ name: "cursorsrv_lookup" }]).includes("cursorsrv_lookup"));
});

test("a server with a hyphen in its name, taken out by hand, takes its tools with it, and the one its name starts like keeps its own", () => {
  byHand({ jira: JIRA, "brave-search": { command: "b" }, brave: { command: "b" } });
  cacheFile({ jira: { tools: [{ name: "search" }] }, "brave-search": { tools: [{ name: "web_search" }] }, brave: { tools: [{ name: "news" }] } });
  db.rememberTools([adapter("brave_search_web_search"), adapter("brave_news")]);
  assert.ok(listed().includes("brave_search_web_search"));
  byHand({ jira: JIRA, brave: { command: "b" } });
  const shown = listed();
  assert.ok(!shown.includes("brave_search_web_search"));
  assert.ok(shown.includes("brave_news"));
  assert.ok(!known().includes("brave_search_web_search"));
  assert.deepEqual(cached(), ["brave", "jira"]);
  assert.ok(removed().includes("brave-search") && !removed().includes("brave"));
});

test("a rename by hand is a removal and an addition", () => {
  byHand({ jira: JIRA, notes: { command: "notes-mcp" } });
  db.rememberTools([adapter("notes_read")]);
  assert.ok(listed().includes("notes_read"));
  assert.ok(!removed().includes("notes"), "configured again, so no longer removed");
  byHand({ jira: JIRA, journal: { command: "notes-mcp" } });
  assert.ok(!listed().includes("notes_read"));
  assert.deepEqual(configured(), ["jira", "journal"]);
  assert.ok(removed().includes("notes"));
});

test("a write of the portal's right after an edit by hand that was not noticed yet takes out what the edit did", () => {
  byHand({ jira: JIRA, notes: { command: "notes-mcp" } });
  db.rememberTools([adapter("notes_read")]);
  assert.ok(listed().includes("notes_read"));
  // Taken out by hand, and a server added in the panel before anything listed the tools again.
  byHand({ jira: JIRA });
  writeMcpFile({ mcpServers: { jira: JIRA, fresh: { command: "f" } } });
  assert.ok(!known().includes("notes_read"));
  assert.ok(removed().includes("notes"));
  assert.deepEqual(configured(), ["fresh", "jira"]);
});

test("nothing is written or told while the file has not changed, nor told while its servers have not", () => {
  byHand({ jira: JIRA });
  listed();
  let calls = 0;
  const stop = onMcpWritten(() => calls++);
  // Every write to the settings, counted where they are kept.
  const d = db.getDb();
  d.exec(`CREATE TEMP TABLE written (key TEXT);
    CREATE TEMP TRIGGER put AFTER INSERT ON main.settings BEGIN INSERT INTO written VALUES (new.key); END;
    CREATE TEMP TRIGGER changed AFTER UPDATE ON main.settings BEGIN INSERT INTO written VALUES (new.key); END;
    CREATE TEMP TRIGGER dropped AFTER DELETE ON main.settings BEGIN INSERT INTO written VALUES (old.key); END;`);
  const writes = () => d.prepare("SELECT key FROM written").all().map((r) => r.key);
  try {
    const view = db.mcpView();
    listed();
    db.withdrawnMcpTools();
    assert.equal(db.mcpView(), view, "the view is kept, so nothing it is read from changed");
    // A server's entry changed, its servers the same.
    byHand({ jira: { ...JIRA, args: ["--fast"] } });
    listed();
    assert.equal(calls, 0);
    assert.deepEqual(writes(), []);
  } finally {
    stop();
    d.exec("DROP TRIGGER put; DROP TRIGGER changed; DROP TRIGGER dropped; DROP TABLE written;");
  }
});

test("a server put back by hand has its tools listed again, with the switches they had", () => {
  byHand({ jira: JIRA, notes: { command: "notes-mcp" } });
  cacheFile({ jira: { tools: [{ name: "search" }] }, notes: { tools: [{ name: "read" }, { name: "write" }] } });
  db.rememberTools([adapter("notes_read"), adapter("notes_write")]);
  assert.ok(listed().includes("notes_write"));
  db.setToolDefaultsOff([...db.toolDefaultsOff(), "notes_write"]);
  byHand({ jira: JIRA });
  assert.ok(!listed().includes("notes_write"));
  assert.ok(removed().includes("notes"));
  // Put back; the adapter writes its entry again once the server has run.
  byHand({ jira: JIRA, notes: { command: "notes-mcp" } });
  cacheFile({ jira: { tools: [{ name: "search" }] }, notes: { tools: [{ name: "read" }, { name: "write" }] } });
  const shown = listed();
  assert.ok(shown.includes("notes_read") && shown.includes("notes_write"));
  assert.ok(!removed().includes("notes"));
  assert.ok(db.toolDefaultsOff().includes("notes_write"), "off by default, as it was set before");
  db.createSession({ id: "after", title: "after", workspace: home, executor: "host" });
  const off = sessions.piOff("after");
  assert.ok(off.includes("notes_write") && !off.includes("notes_read"));
  db.rememberTools([adapter("notes_read")]);
  assert.ok(known().includes("notes_read"), "a chat's report of it is remembered again");
});

test("an mcp.json that is not there takes nothing out, and the file there next is compared with the servers last seen", () => {
  byHand({ jira: JIRA, notes: { command: "notes-mcp" } });
  cacheFile({ jira: { tools: [{ name: "search" }] }, notes: { tools: [{ name: "read" }] } });
  db.rememberTools([adapter("jira_search"), adapter("notes_read")]);
  listed();
  // Moved away and then written again, as `mv mcp.json mcp.json.bak` and a script or an editor after it do.
  renameSync(mcpPath, `${mcpPath}.bak`);
  listed();
  assert.ok(known().includes("jira_search") && known().includes("notes_read"));
  assert.deepEqual(cached(), ["jira", "notes"]);
  assert.ok(!removed().includes("jira") && !removed().includes("notes"));
  assert.deepEqual(configured(), ["jira", "notes"]);
  byHand({ jira: JIRA });
  const shown = listed();
  assert.ok(shown.includes("jira_search") && !shown.includes("notes_read"));
  assert.ok(known().includes("jira_search") && !known().includes("notes_read"));
  assert.deepEqual(cached(), ["jira"]);
  assert.ok(removed().includes("notes") && !removed().includes("jira"));
  // Deleted, and then one written through the portal: judged against the servers last seen.
  rmSync(mcpPath);
  listed();
  writeMcpFile({ mcpServers: { fresh: { command: "f" } } });
  assert.ok(!known().includes("jira_search"));
  assert.ok(removed().includes("jira"));
  assert.deepEqual(configured(), ["fresh"]);
});

test("an edit made while the portal was not running is noticed when it starts", async () => {
  // Through the portal, which remembers the servers it wrote.
  writeMcpFile({ mcpServers: { jira: JIRA, wiki: { command: "wiki-mcp" } } });
  cacheFile({ jira: { tools: [{ name: "search" }] }, wiki: { tools: [{ name: "page" }] } });
  db.rememberTools([adapter("wiki_page"), adapter("jira_search")]);
  assert.ok(listed().includes("wiki_page"));
  // Then, with the portal stopped, taken out by hand; this process does not look at the file again.
  byHand({ jira: JIRA });
  const { base } = await startServer(serverEnv(home, await freePort()));
  // Before anything is asked of it but whether it answers.
  assert.ok(removed().includes("wiki"));
  assert.ok(!known().includes("wiki_page"));
  assert.deepEqual(cached(), ["jira"]);
  const tools = (await (await fetch(`${base}/api/tools`)).json()).tools.map((t) => t.name);
  assert.ok(!tools.includes("wiki_page"), tools.join(", "));
  assert.ok(tools.includes("jira_search"));
});

test("a tool left behind by a server taken out by hand before the first look goes once the server is added again under its name and removed in Settings → MCP", () => {
  // As the first look left `old_lookup` above: remembered, listed, and claimed by no server of the file.
  writeMcpFile({ mcpServers: { jira: JIRA } });
  db.rememberTools([adapter("gone_lookup")]);
  assert.ok(listed().includes("gone_lookup"));
  assert.ok(!configured().includes("gone"));
  // Added again in the panel, with any entry, and removed there: its tools go as any removed server's do.
  writeMcpFile({ mcpServers: { jira: JIRA, gone: { command: "true" } } });
  writeMcpFile({ mcpServers: { jira: JIRA } });
  assert.ok(!listed().includes("gone_lookup"));
  assert.ok(!known().includes("gone_lookup"), "forgotten, not only hidden");
  assert.ok(removed().includes("gone"));
});
