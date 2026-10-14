import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

// A server that is removed takes its tools with it: the portal remembers every tool a chat has reported, and the
// adapter caches what each server offered, so both would list a server that is gone for ever.
inProcessHome("pithagoras-mcp-remove-");
const agent = process.env.PI_CODING_AGENT_DIR;
const mcpFile = path.join(agent, "mcp.json");
const cacheFile = path.join(agent, "mcp-cache.json");
const write = (servers) => writeFileSync(mcpFile, JSON.stringify({ mcpServers: servers }));
const cache = () => JSON.parse(readFileSync(cacheFile, "utf8"));

const { default: express } = await import("express");
const { mcpRouter } = await import("../dist/api/mcp.js");
const db = await import("../dist/db.js");

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

const TOOLS = ["jira_search", "jira_create", "notes_read", "notes_staging_read", "mcp", "mcpScript", "bash"];
const seed = () => {
  write({ jira: { command: "jira-mcp" }, notes: { command: "notes-mcp" }, notes_staging: { command: "notes-mcp" } });
  db.putSetting("tools_seen", "[]");
  db.rememberTools(TOOLS.map((name) => ({ name, source: name === "bash" ? "built in" : "pi-mcp-adapter", package: name === "bash" ? null : "npm:pi-mcp-adapter" })));
  writeFileSync(cacheFile, JSON.stringify({ version: 1, servers: { jira: { tools: [] }, notes: { tools: [] }, notes_staging: { tools: [] } } }));
};

test("a server removed through the API loses its tools and its cache entry, and no other server does", async () => {
  seed();
  db.setToolDefaultsOff(["jira_search"]);
  assert.equal((await del("jira")).status, 200);
  assert.deepEqual(names(), ["bash", "mcp", "mcpScript", "notes_read", "notes_staging_read"]);
  assert.deepEqual(Object.keys(cache().servers).sort(), ["notes", "notes_staging"]);
  assert.equal(cache().version, 1, "the rest of the adapter's file is as it was");
  assert.deepEqual(db.toolDefaultsOff(), ["jira_search"], "what was set for its tools is kept, for when it comes back");
});

test("a server is told from one whose name it is the start of", async () => {
  assert.equal((await del("notes")).status, 200);
  assert.ok(names().includes("notes_staging_read"), "the longer name's tools are not notes'");
  assert.ok(!names().includes("notes_read"));
  assert.deepEqual(Object.keys(cache().servers), ["notes_staging"]);
});

test("a rename drops the old name's tools; changing a server under its own name and adding one drop nothing", async () => {
  seed();
  assert.equal((await put("jira", { command: "jira-mcp", args: ["--fast"] }, "jira")).status, 200);
  assert.equal((await put("fresh", { command: "x" })).status, 200);
  assert.ok(names().includes("jira_search"));
  assert.deepEqual(Object.keys(cache().servers).sort(), ["jira", "notes", "notes_staging"]);
  assert.equal((await put("tracker", { command: "jira-mcp" }, "jira")).status, 200);
  assert.ok(!names().includes("jira_search"));
  assert.deepEqual(Object.keys(cache().servers).sort(), ["notes", "notes_staging"]);
});

test("a server taken out in the raw editor is forgotten the same way", async () => {
  seed();
  const body = JSON.stringify({ content: JSON.stringify({ mcpServers: { notes: { command: "notes-mcp" }, notes_staging: { command: "notes-mcp" } } }) });
  assert.equal((await fetch(`${base}/mcp/raw`, { method: "PUT", headers: { "content-type": "application/json" }, body })).status, 200);
  assert.ok(!names().includes("jira_create"));
  assert.deepEqual(Object.keys(cache().servers).sort(), ["notes", "notes_staging"]);
});

test("an adapter cache that is missing or not readable does not fail the removal", async () => {
  seed();
  writeFileSync(cacheFile, "{ not json");
  assert.equal((await del("jira")).status, 200);
  assert.ok(!names().includes("jira_search"));
  assert.equal(readFileSync(cacheFile, "utf8"), "{ not json", "a file that cannot be read is left alone");
  seed();
  writeFileSync(cacheFile, JSON.stringify({ version: 1 }));
  assert.equal((await del("jira")).status, 200);
  assert.deepEqual(cache(), { version: 1 });
  seed();
  rmSync(cacheFile);
  assert.equal((await del("jira")).status, 200);
  assert.ok(!names().includes("jira_search"));
});

const adapter = (name) => ({ name, source: "pi-mcp-adapter", package: "npm:pi-mcp-adapter@2.18.0" });

test("a chat that still has the removed server loaded does not bring its tools back", async () => {
  seed();
  assert.equal((await del("jira")).status, 200);
  const { PORTAL_BROWSER_TOOLS } = await import("../dist/tool-policy.js");
  // What the chat's registry reports when its tool switches are opened.
  db.rememberTools([
    adapter("jira_search"),
    adapter("notes_read"),
    adapter("mcp"),
    adapter("mcpScript"),
    { name: "jira_other", source: "pi-web-access", package: "npm:pi-web-access" },
    ...PORTAL_BROWSER_TOOLS.map((name) => ({ name, source: "browser", package: null })),
  ]);
  const seen = names();
  assert.ok(!seen.includes("jira_search"), "the removed server's tool is not remembered again");
  for (const kept of ["notes_read", "mcp", "mcpScript", "jira_other", ...PORTAL_BROWSER_TOOLS]) assert.ok(seen.includes(kept), kept);
});

test("with an mcp.json that cannot be read nothing is taken for a removed server", () => {
  seed();
  writeFileSync(mcpFile, "{ broken");
  db.rememberTools([adapter("tracker_open")]);
  assert.ok(names().includes("tracker_open"));
});

test("a server with a hyphen in its name loses its tools: the adapter writes the name with underscores", async () => {
  write({ "brave-search": { command: "brave" }, brave: { command: "b" }, jira: { command: "jira-mcp" } });
  db.putSetting("tools_seen", "[]");
  db.rememberTools([adapter("brave_search_web"), adapter("brave_news"), adapter("jira_search")]);
  writeFileSync(cacheFile, JSON.stringify({ version: 1, servers: { "brave-search": { tools: [] }, brave: { tools: [] }, jira: { tools: [] } } }));
  assert.equal((await del("brave-search")).status, 200);
  assert.deepEqual(names(), ["brave_news", "jira_search"], "the shorter name's tool is not the hyphenated one's");
  assert.deepEqual(Object.keys(cache().servers).sort(), ["brave", "jira"]);
});

test("another package's tool is kept when a removed server's name starts it", async () => {
  write({ web: { command: "web-mcp" }, jira: { command: "jira-mcp" } });
  db.putSetting("tools_seen", "[]");
  db.rememberTools([adapter("web_fetch_page"), adapter("jira_search")]);
  // Reported by a project's own settings, which is no package of the user's, and by a package.
  db.putSetting(
    "tools_seen",
    JSON.stringify([...db.knownTools(), { name: "web_search", source: "pi-web-access", package: "npm:pi-web-access" }, { name: "web_code", source: "local-folder", package: null }]),
  );
  assert.equal((await del("web")).status, 200);
  assert.deepEqual(names(), ["jira_search", "web_code", "web_search"]);
});

test("a server of a project's own files, which the portal never had, keeps its tools remembered", async () => {
  seed();
  assert.equal((await del("jira")).status, 200);
  // The adapter loads it from a .mcp.json in the project: it is in no file the portal writes.
  db.rememberTools([adapter("cursorsrv_lookup"), adapter("jira_search")]);
  assert.ok(names().includes("cursorsrv_lookup"));
  assert.ok(!names().includes("jira_search"), "only the one the portal removed is held back");
});

test("a removed server that is added again has its tools remembered again", async () => {
  seed();
  assert.equal((await del("jira")).status, 200);
  db.rememberTools([adapter("jira_search")]);
  assert.ok(!names().includes("jira_search"));
  assert.equal((await put("jira", { command: "jira-mcp" })).status, 200);
  db.rememberTools([adapter("jira_search")]);
  assert.ok(names().includes("jira_search"));
  // Also when it comes back by the file, not through the portal's form.
  assert.equal((await del("jira")).status, 200);
  write({ jira: { command: "jira-mcp" } });
  db.rememberTools([adapter("jira_create")]);
  assert.ok(names().includes("jira_create"));
});

test("a longer name that is still configured keeps its tools when the shorter one is removed", async () => {
  seed();
  assert.equal((await del("notes")).status, 200);
  db.rememberTools([adapter("notes_staging_write"), adapter("notes_write")]);
  assert.ok(names().includes("notes_staging_write"));
  assert.ok(!names().includes("notes_write"));
});
