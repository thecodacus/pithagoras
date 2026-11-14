import { test } from "node:test";
import assert from "node:assert/strict";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

// A portal's Tools page listed 27 `browser_browser_*` tools of a Playwright server called `browser` that had been taken
// out of mcp.json by an edit made outside the portal: only a write of the portal's own took a removed server's tools
// out, so an edit by hand left them remembered, and in what is kept of each server's tools, for ever.
const home = inProcessHome("pithagoras-mcp-edited-outside-");
const agent = process.env.PI_CODING_AGENT_DIR;
const mcpPath = path.join(agent, "mcp.json");
/** The file written as a shell or an editor writes it: not through the portal. */
const byHand = (servers) => writeFileSync(mcpPath, JSON.stringify({ mcpServers: servers }));

const db = await import("../dist/db.js");
const toolCache = await import("../dist/mcp-tools.js");
/** What each server offered when it last connected, as the portal keeps it: the tools by the server's own names. */
const cacheFile = (servers) => {
  rmSync(toolCache.mcpToolCachePath(), { force: true });
  for (const [server, { tools }] of Object.entries(servers)) {
    toolCache.rememberServerTools(server, "h", tools.map(({ name }) => ({ name: `mcp__${server.replace(/-/g, "_")}__${name}`, original: name, description: "", parameters: {}, tokens: 10 })));
  }
};
const cached = () => Object.keys(toolCache.cachedServers()).sort();
/** A tool as a chat reports it: pi's name for it, and the server it is of by pi's namespace. */
const adapter = (server, name) => ({ name: `mcp__${server.replace(/-/g, "_")}__${name}`, source: server, server, package: null });
const { sessions } = await import("../dist/session-manager.js");
const { onMcpWritten, writeMcpFile } = await import("../dist/api/mcp.js");

const setting = (key) => db.getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;
const removed = () => JSON.parse(setting("mcp_removed") ?? "[]");
const configured = () => JSON.parse(setting("mcp_configured"));
const listed = () => db.shownTools().map((t) => t.name).sort();
const known = () => db.knownTools().map((t) => t.name);

// The running chats are loaded again as the server does it (server.ts), which reads the servers again when a chat starts.
let reloads = 0;
sessions.reloadIdle = async () => {
  reloads++;
  return { reloaded: 0, waiting: 0 };
};
onMcpWritten(() => {
  sessions.reloadIdle();
});

const JIRA = { command: "jira-mcp" };

test("the first time there is nothing to compare with: the servers in the file are remembered, and nothing is judged", () => {
  // As on a portal upgrading to this after `old` was taken out of the file by hand: its entry left in what is kept of
  // the servers' tools and its tools in what the portal remembers. Nothing tells them from a server of a project's own file.
  byHand({ jira: JIRA });
  cacheFile({ jira: { tools: [{ name: "search" }] }, old: { tools: [{ name: "lookup" }] } });
  db.rememberTools([adapter("jira", "search"), adapter("old", "lookup")]);
  assert.equal(setting("mcp_configured"), undefined);
  assert.ok(listed().includes("mcp__old__lookup"));
  assert.ok(known().includes("mcp__old__lookup"));
  assert.deepEqual(configured(), ["jira"]);
  assert.deepEqual(removed(), []);
  assert.deepEqual(cached(), ["jira", "old"]);
});

test("a server taken out of mcp.json by hand is removed as through the panel, and the chats that are running are loaded again", () => {
  byHand({ jira: JIRA, browser: { command: "npx", args: ["@playwright/mcp"] } });
  cacheFile({ jira: { tools: [{ name: "search" }] }, browser: { tools: [{ name: "browser_navigate" }, { name: "browser_click" }] } });
  db.rememberTools([adapter("browser", "browser_navigate"), adapter("browser", "browser_click")]);
  assert.ok(listed().includes("mcp__browser__browser_click"));
  assert.deepEqual(configured(), ["browser", "jira"], "the server added by hand is remembered");

  const before = reloads;
  byHand({ jira: JIRA });
  const shown = listed();
  assert.ok(!shown.some((name) => name.startsWith("mcp__browser__")), shown.join(", "));
  assert.ok(!known().some((name) => name.startsWith("mcp__browser__")), "forgotten, not only hidden");
  assert.deepEqual(cached(), ["jira"], "what was kept of its tools is out");
  assert.deepEqual(removed(), ["browser"]);
  assert.deepEqual(configured(), ["jira"]);
  assert.ok(reloads > before, "the chats that are running are loaded again, to leave the server");
  // What a chat that still has it reports again is not remembered again.
  db.rememberTools([adapter("browser", "browser_navigate"), adapter("browser", "browser_click")]);
  assert.ok(!known().includes("mcp__browser__browser_click"));
});

test("a file that cannot be read takes nothing out, and the one that fixes it is compared with the servers last seen", () => {
  writeMcpFile({ mcpServers: { jira: JIRA, notes: { command: "notes-mcp" } } });
  db.rememberTools([adapter("notes", "read")]);
  writeFileSync(mcpPath, "{ not json");
  assert.ok(listed().includes("mcp__notes__read"), "a typo takes nothing out");
  assert.deepEqual(configured(), ["jira", "notes"]);
  assert.deepEqual(removed(), ["browser"]);
  // Fixed by hand, without notes.
  byHand({ jira: JIRA });
  assert.ok(!listed().includes("mcp__notes__read"));
  assert.ok(!known().includes("mcp__notes__read"));
  assert.deepEqual(removed(), ["browser", "notes"]);
});

test("a tool of a server the portal's file never had, as one of a project's own, stays listed and on", () => {
  byHand({ jira: JIRA });
  // pi loads `cursorsrv` from a .pi/mcp.json in the project: it is in no file the portal writes.
  db.rememberTools([adapter("cursorsrv", "lookup")]);
  listed();
  byHand({ jira: JIRA, scratch: { command: "s" } });
  listed();
  byHand({ jira: JIRA });
  assert.ok(listed().includes("mcp__cursorsrv__lookup"));
  assert.ok(known().includes("mcp__cursorsrv__lookup"));
  assert.ok(!removed().includes("cursorsrv"));
  db.createSession({ id: "in-project", title: "in-project", workspace: home, executor: "host" });
  assert.ok(!sessions.piOff("in-project", [{ name: "mcp__cursorsrv__lookup" }]).includes("mcp__cursorsrv__lookup"));
});

test("a server with a hyphen in its name, taken out by hand, takes its tools with it, and the one its name starts like keeps its own", () => {
  byHand({ jira: JIRA, "brave-search": { command: "b" }, brave: { command: "b" } });
  cacheFile({ jira: { tools: [{ name: "search" }] }, "brave-search": { tools: [{ name: "web_search" }] }, brave: { tools: [{ name: "news" }] } });
  db.rememberTools([adapter("brave-search", "web_search"), adapter("brave", "news")]);
  assert.ok(listed().includes("mcp__brave_search__web_search"));
  byHand({ jira: JIRA, brave: { command: "b" } });
  const shown = listed();
  assert.ok(!shown.includes("mcp__brave_search__web_search"));
  assert.ok(shown.includes("mcp__brave__news"));
  assert.ok(!known().includes("mcp__brave_search__web_search"));
  assert.deepEqual(cached(), ["brave", "jira"]);
  assert.ok(removed().includes("brave-search") && !removed().includes("brave"));
});

test("a rename by hand is a removal and an addition", () => {
  byHand({ jira: JIRA, notes: { command: "notes-mcp" } });
  db.rememberTools([adapter("notes", "read")]);
  assert.ok(listed().includes("mcp__notes__read"));
  assert.ok(!removed().includes("notes"), "configured again, so no longer removed");
  byHand({ jira: JIRA, journal: { command: "notes-mcp" } });
  assert.ok(!listed().includes("mcp__notes__read"));
  assert.deepEqual(configured(), ["jira", "journal"]);
  assert.ok(removed().includes("notes"));
});

test("a write of the portal's right after an edit by hand that was not noticed yet takes out what the edit did", () => {
  byHand({ jira: JIRA, notes: { command: "notes-mcp" } });
  db.rememberTools([adapter("notes", "read")]);
  assert.ok(listed().includes("mcp__notes__read"));
  // Taken out by hand, and a server added in the panel before anything listed the tools again.
  byHand({ jira: JIRA });
  writeMcpFile({ mcpServers: { jira: JIRA, fresh: { command: "f" } } });
  assert.ok(!known().includes("mcp__notes__read"));
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
  db.rememberTools([adapter("notes", "read"), adapter("notes", "write")]);
  assert.ok(listed().includes("mcp__notes__write"));
  db.setToolDefaultsOff([...db.toolDefaultsOff(), "mcp__notes__write"]);
  byHand({ jira: JIRA });
  assert.ok(!listed().includes("mcp__notes__write"));
  assert.ok(removed().includes("notes"));
  // Put back; the portal keeps what the server offers again once it has run.
  byHand({ jira: JIRA, notes: { command: "notes-mcp" } });
  cacheFile({ jira: { tools: [{ name: "search" }] }, notes: { tools: [{ name: "read" }, { name: "write" }] } });
  const shown = listed();
  assert.ok(shown.includes("mcp__notes__read") && shown.includes("mcp__notes__write"));
  assert.ok(!removed().includes("notes"));
  assert.ok(db.toolDefaultsOff().includes("mcp__notes__write"), "off by default, as it was set before");
  db.createSession({ id: "after", title: "after", workspace: home, executor: "host" });
  const off = sessions.piOff("after");
  assert.ok(off.includes("mcp__notes__write") && !off.includes("mcp__notes__read"));
  db.rememberTools([adapter("notes", "read")]);
  assert.ok(known().includes("mcp__notes__read"), "a chat's report of it is remembered again");
});

test("an mcp.json that is not there takes nothing out, and the file there next is compared with the servers last seen", () => {
  byHand({ jira: JIRA, notes: { command: "notes-mcp" } });
  cacheFile({ jira: { tools: [{ name: "search" }] }, notes: { tools: [{ name: "read" }] } });
  db.rememberTools([adapter("jira", "search"), adapter("notes", "read")]);
  listed();
  // Moved away and then written again, as `mv mcp.json mcp.json.bak` and a script or an editor after it do.
  renameSync(mcpPath, `${mcpPath}.bak`);
  listed();
  assert.ok(known().includes("mcp__jira__search") && known().includes("mcp__notes__read"));
  assert.deepEqual(cached(), ["jira", "notes"]);
  assert.ok(!removed().includes("jira") && !removed().includes("notes"));
  assert.deepEqual(configured(), ["jira", "notes"]);
  byHand({ jira: JIRA });
  const shown = listed();
  assert.ok(shown.includes("mcp__jira__search") && !shown.includes("mcp__notes__read"));
  assert.ok(known().includes("mcp__jira__search") && !known().includes("mcp__notes__read"));
  assert.deepEqual(cached(), ["jira"]);
  assert.ok(removed().includes("notes") && !removed().includes("jira"));
  // Deleted, and then one written through the portal: judged against the servers last seen.
  rmSync(mcpPath);
  listed();
  writeMcpFile({ mcpServers: { fresh: { command: "f" } } });
  assert.ok(!known().includes("mcp__jira__search"));
  assert.ok(removed().includes("jira"));
  assert.deepEqual(configured(), ["fresh"]);
});

test("an edit made while the portal was not running is noticed when it starts", async () => {
  // Through the portal, which remembers the servers it wrote.
  writeMcpFile({ mcpServers: { jira: JIRA, wiki: { command: "wiki-mcp" } } });
  cacheFile({ jira: { tools: [{ name: "search" }] }, wiki: { tools: [{ name: "page" }] } });
  db.rememberTools([adapter("wiki", "page"), adapter("jira", "search")]);
  assert.ok(listed().includes("mcp__wiki__page"));
  // Then, with the portal stopped, taken out by hand; this process does not look at the file again.
  byHand({ jira: JIRA });
  const { base } = await startServer(serverEnv(home, await freePort()));
  // Before anything is asked of it but whether it answers.
  assert.ok(removed().includes("wiki"));
  assert.ok(!known().includes("mcp__wiki__page"));
  assert.deepEqual(cached(), ["jira"]);
  const tools = (await (await fetch(`${base}/api/tools`)).json()).tools.map((t) => t.name);
  assert.ok(!tools.includes("mcp__wiki__page"), tools.join(", "));
  assert.ok(tools.includes("mcp__jira__search"));
});

test("a tool left behind by a server taken out by hand before the first look goes once the server is added again under its name and removed in Settings → MCP", () => {
  // As the first look left `old`'s tools above: remembered, listed, and claimed by no server of the file.
  writeMcpFile({ mcpServers: { jira: JIRA } });
  db.rememberTools([adapter("gone", "lookup")]);
  assert.ok(listed().includes("mcp__gone__lookup"));
  assert.ok(!configured().includes("gone"));
  // Added again in the panel, with any entry, and removed there: its tools go as any removed server's do.
  writeMcpFile({ mcpServers: { jira: JIRA, gone: { command: "true" } } });
  writeMcpFile({ mcpServers: { jira: JIRA } });
  assert.ok(!listed().includes("mcp__gone__lookup"));
  assert.ok(!known().includes("mcp__gone__lookup"), "forgotten, not only hidden");
  assert.ok(removed().includes("gone"));
});
