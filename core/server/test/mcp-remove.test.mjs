import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

// A server that is removed takes its tools with it: the portal remembers every tool a chat has reported, and what each
// server offered when it last connected, so both would list a server that is gone for ever.
inProcessHome("pithagoras-mcp-remove-");
const agent = process.env.PI_CODING_AGENT_DIR;
const mcpFile = path.join(agent, "mcp.json");
const write = (servers) => writeFileSync(mcpFile, JSON.stringify({ mcpServers: servers }));

const { default: express } = await import("express");
const { mcpRouter } = await import("../dist/api/mcp.js");
const db = await import("../dist/db.js");
const cache = await import("../dist/mcp-tools.js");
const cached = () => Object.keys(cache.cachedServers()).sort();

const app = express();
app.use(express.json());
app.use("/api", mcpRouter());
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(() => {
  server.close();
  db.getDb().close();
});

const del = (name) => fetch(`${base}/mcp/servers/${name}`, { method: "DELETE" });
const put = (name, entry, from) =>
  fetch(`${base}/mcp/servers/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ entry, from }) });
const names = () => db.knownTools().map((t) => t.name).sort();

/** A tool as a chat reports it: pi's name for it, its server (from the namespace) and the set it is filed under. */
const tool = (server, name) => ({ name: `mcp__${server.replace(/-/g, "_")}__${name}`, source: server, server, package: null });
const own = (name, extra = {}) => ({ name, source: "pi-web-access", package: "npm:pi-web-access", ...extra });

const remember = (...tools) => db.rememberTools(tools);
const kept = (server, ...tools) => cache.rememberServerTools(server, "hash", tools.map((name) => ({ name: `mcp__${server.replace(/-/g, "_")}__${name}`, original: name, description: "", parameters: {}, tokens: 10 })));
const seed = () => {
  write({ jira: { command: "jira-mcp" }, notes: { command: "notes-mcp" }, notes_staging: { command: "notes-mcp" } });
  db.putSetting("tools_seen", "[]");
  db.putSetting("mcp_removed", "");
  remember(tool("jira", "search"), tool("jira", "create"), tool("notes", "read"), tool("notes_staging", "read"), { name: "bash", source: "built in", package: null });
  rmSync(cache.mcpToolCachePath(), { force: true });
  for (const [server, one] of [["jira", "search"], ["notes", "read"], ["notes_staging", "read"]]) kept(server, one);
};

test("a server removed through the API loses its tools and what is kept of what it offered, and no other server does", async () => {
  seed();
  db.setToolDefaultsOff(["mcp__jira__search"]);
  assert.equal((await del("jira")).status, 200);
  assert.deepEqual(names(), ["bash", "mcp__notes__read", "mcp__notes_staging__read"]);
  assert.deepEqual(cached(), ["notes", "notes_staging"]);
  assert.deepEqual(db.toolDefaultsOff(), ["mcp__jira__search"], "what was set for its tools is kept, for when it comes back");
});

test("a server is told from one whose name it is the start of by the server each tool was reported for", async () => {
  assert.equal((await del("notes")).status, 200);
  assert.ok(names().includes("mcp__notes_staging__read"), "the longer name's tools are not notes'");
  assert.ok(!names().includes("mcp__notes__read"));
  assert.deepEqual(cached(), ["notes_staging"]);
});

test("a rename drops the old name's tools; changing a server under its own name and adding one drop nothing", async () => {
  seed();
  assert.equal((await put("jira", { command: "jira-mcp", args: ["--fast"] }, "jira")).status, 200);
  assert.equal((await put("fresh", { command: "x" })).status, 200);
  assert.ok(names().includes("mcp__jira__search"));
  assert.deepEqual(cached(), ["jira", "notes", "notes_staging"]);
  assert.equal((await put("tracker", { command: "jira-mcp" }, "jira")).status, 200);
  assert.ok(!names().includes("mcp__jira__search"));
  assert.deepEqual(cached(), ["notes", "notes_staging"]);
});

test("a server taken out in the raw editor is forgotten the same way", async () => {
  seed();
  const body = JSON.stringify({ content: JSON.stringify({ mcpServers: { notes: { command: "notes-mcp" }, notes_staging: { command: "notes-mcp" } } }) });
  assert.equal((await fetch(`${base}/mcp/raw`, { method: "PUT", headers: { "content-type": "application/json" }, body })).status, 200);
  assert.ok(!names().includes("mcp__jira__create"));
  assert.deepEqual(cached(), ["notes", "notes_staging"]);
});

test("a cache that is missing or not readable does not fail the removal", async () => {
  seed();
  writeFileSync(cache.mcpToolCachePath(), "{ not json");
  assert.equal((await del("jira")).status, 200);
  assert.ok(!names().includes("mcp__jira__search"));
  seed();
  rmSync(cache.mcpToolCachePath());
  assert.equal((await del("jira")).status, 200);
  assert.ok(!names().includes("mcp__jira__search"));
  assert.equal(existsSync(cache.mcpToolCachePath()), false, "nothing is made of a cache that is not there");
});

test("what is set to confirm a removed server's tools goes with it", async () => {
  seed();
  db.setMcpApprove("jira", ["create*"]);
  db.setMcpApprove("notes", ["write*"]);
  assert.equal((await del("jira")).status, 200);
  assert.deepEqual(db.mcpApprove(), { notes: ["write*"] });
});

test("the trust and the mark of a removed server go with it, so that a server given its name later is not trusted or marked unasked", async () => {
  // Round 2 of PR B, security finding 4.
  seed();
  db.setTrustedMcpServers(["jira", "notes"]);
  db.setToolMarks({ jira: "direct", notes: "lazy" });
  // A rename removes the old name.
  assert.equal((await put("jira2", { command: "jira-mcp" }, "jira")).status, 200);
  assert.deepEqual([...db.trustedMcpServers()], ["notes"]);
  assert.deepEqual(db.toolMarks(), { notes: "lazy" });
  // So does taking it out by hand, and the server of that name that comes next starts with nothing.
  assert.equal((await del("notes")).status, 200);
  assert.deepEqual([...db.trustedMcpServers()], []);
  assert.deepEqual(db.toolMarks(), {});
});

test("a chat that still has the removed server loaded does not bring its tools back", async () => {
  seed();
  assert.equal((await del("jira")).status, 200);
  // What the chat's registry reports when its tool switches are opened.
  remember(
    tool("jira", "search"),
    tool("notes", "read"),
    own("jira_other"),
    // A server half's own tools, registered inline under its package: no server's, whatever they are called.
    { name: "jira_board", source: "pithagoras-boards", package: null, inline: true },
    { name: "page_open", source: "pithagoras-pages", package: null, inline: true },
  );
  const seen = names();
  assert.ok(!seen.includes("mcp__jira__search"), "the removed server's tool is not remembered again");
  for (const kept of ["mcp__notes__read", "jira_other", "jira_board", "page_open"]) assert.ok(seen.includes(kept), kept);
});

test("with an mcp.json that cannot be read nothing is taken for a removed server", () => {
  seed();
  writeFileSync(mcpFile, "{ broken");
  remember(tool("tracker", "open"));
  assert.ok(names().includes("mcp__tracker__open"));
});

test("a server with a hyphen in its name is its own: pi writes the name with underscores, and the shorter name's tools stay", async () => {
  write({ "brave-search": { command: "brave" }, brave: { command: "b" }, jira: { command: "jira-mcp" } });
  db.putSetting("tools_seen", "[]");
  remember(tool("brave-search", "web"), tool("brave", "news"), tool("jira", "search"));
  rmSync(cache.mcpToolCachePath(), { force: true });
  for (const [server, one] of [["brave-search", "web"], ["brave", "news"], ["jira", "search"]]) kept(server, one);
  assert.equal((await del("brave-search")).status, 200);
  assert.deepEqual(names(), ["mcp__brave__news", "mcp__jira__search"]);
  assert.deepEqual(cached(), ["brave", "jira"]);
});

test("another package's tool is kept when a removed server's name starts it", async () => {
  write({ web: { command: "web-mcp" }, jira: { command: "jira-mcp" } });
  db.putSetting("tools_seen", "[]");
  remember(tool("web", "fetch_page"), tool("jira", "search"), own("web_search"), { name: "web_code", source: "local-folder", package: null });
  assert.equal((await del("web")).status, 200);
  assert.deepEqual(names(), ["mcp__jira__search", "web_code", "web_search"]);
});

test("a server of a project's own file, which the portal never had, keeps its tools remembered", async () => {
  seed();
  assert.equal((await del("jira")).status, 200);
  // pi loads it from a .pi/mcp.json in the project: it is in no file the portal writes.
  remember(tool("projectsrv", "lookup"), tool("jira", "search"));
  assert.ok(names().includes("mcp__projectsrv__lookup"));
  assert.ok(!names().includes("mcp__jira__search"), "only the one the portal removed is held back");
});

test("a removed server that is added again has its tools remembered again", async () => {
  seed();
  assert.equal((await del("jira")).status, 200);
  remember(tool("jira", "search"));
  assert.ok(!names().includes("mcp__jira__search"));
  assert.equal((await put("jira", { command: "jira-mcp" })).status, 200);
  remember(tool("jira", "search"));
  assert.ok(names().includes("mcp__jira__search"));
  // Also when it comes back by the file, not through the portal's form.
  assert.equal((await del("jira")).status, 200);
  write({ jira: { command: "jira-mcp" } });
  remember(tool("jira", "create"));
  assert.ok(names().includes("mcp__jira__create"));
});

test("a longer name that is still configured keeps its tools when the shorter one is removed", async () => {
  seed();
  assert.equal((await del("notes")).status, 200);
  remember(tool("notes_staging", "write"), tool("notes", "write"));
  assert.ok(names().includes("mcp__notes_staging__write"));
  assert.ok(!names().includes("mcp__notes__write"));
});
