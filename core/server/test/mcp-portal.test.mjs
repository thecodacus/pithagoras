import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import { inProcessHome } from "./server-harness.mjs";

// Settings → MCP beyond the file (issue 361, PR 5): what the portal says of each server, the mark and the tools that ask
// first it sets, and the servers of a folder's own configuration it takes into the user's.
const home = inProcessHome("pithagoras-mcp-portal-");
const agent = process.env.PI_CODING_AGENT_DIR;
const mcpPath = path.join(agent, "mcp.json");

const db = await import("../dist/db.js");
const toolCache = await import("../dist/mcp-tools.js");
const { mcpPortalRouter } = await import("../dist/api/mcp-portal.js");
const { MCP_MIGRATION } = await import("../dist/mcp-migration-run.js");
const d = db.getDb();

const app = express();
app.use(express.json());
app.use("/api", mcpPortalRouter());
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => {
  server.close();
  d.close();
});

const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const file = () => JSON.parse(readFileSync(mcpPath, "utf8"));
const put = (servers) => writeFileSync(mcpPath, JSON.stringify({ mcpServers: servers }));
const status = async () => (await call("GET", "/api/mcp/status")).body.servers;
const tools = (server, names, tokens = 100) => toolCache.rememberServerTools(server, toolCache.configHash(file().mcpServers[server]), names.map((name) => ({ name: `mcp__${server}__${name}`, original: name, description: "", parameters: {}, tokens })));


test("the status says, for each server, what a chat that starts now does with its tools and what is known of them", async () => {
  put({ small: { command: "a", exposure: "deferred" }, big: { command: "b" }, fresh: { command: "c" }, marked: { command: "m" } });
  tools("small", ["one", "two"], 10);
  tools("big", Array.from({ length: 30 }, (_, i) => `t${i}`), 400);
  tools("marked", ["x"]);
  db.setToolMarks({ marked: "direct" });
  db.setMcpApprove("big", ["delete_*"]);
  db.setTrustedMcpServers(["small"]);
  db.rememberTools([...Array.from({ length: 30 }, (_, i) => ({ name: `mcp__big__t${i}`, source: "big", server: "big", package: null, tokens: 400 })), { name: "mcp__small__one", source: "small", server: "small", package: null, tokens: 10 }]);
  const states = await status();
  assert.deepEqual(Object.keys(states).sort(), ["big", "fresh", "marked", "small"]);
  assert.equal(states.marked.by, "mark");
  assert.equal(states.marked.lazy, false);
  assert.equal(states.marked.mark, "direct");
  // Nothing is known of a server that has never connected: lazy until it has run once.
  assert.equal(states.fresh.by, "unknown");
  assert.equal(states.fresh.lazy, true);
  assert.equal(states.fresh.tools, null);
  // Thirty tools of four hundred tokens are over the limits and are taken out; two small ones stay in the list.
  assert.equal(states.big.by, "threshold");
  assert.equal(states.big.lazy, true);
  assert.equal(states.big.tools.count, 30);
  assert.equal(states.big.tools.tokens, 12000);
  assert.deepEqual(states.big.approve, ["delete_*"]);
  assert.equal(states.small.by, "size");
  assert.equal(states.small.lazy, false);
  assert.equal(states.small.trusted, true);
  assert.equal(states.big.trusted, false);
});

test("what was remembered of a server's tools is stale once its entry is changed", async () => {
  put({ small: { command: "a" } });
  tools("small", ["one"]);
  assert.equal((await status()).small.tools.stale, false);
  put({ small: { command: "a-other" } });
  assert.equal((await status()).small.tools.stale, true);
});

test("a mark is set, said in the file for pi alone, and taken away again", async () => {
  put({ notes: { command: "n", exposure: "deferred" } });
  db.setToolMarks({});
  let r = await call("PUT", "/api/mcp/servers/notes/mark", { mark: "direct" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.marks, { notes: "direct" });
  assert.equal(file().mcpServers.notes.exposure, "direct", "said in the file, which is how pi's own command line reaches it");
  r = await call("PUT", "/api/mcp/servers/notes/mark", { mark: "lazy" });
  assert.equal(file().mcpServers.notes.exposure, "deferred");
  r = await call("PUT", "/api/mcp/servers/notes/mark", { mark: "auto" });
  assert.deepEqual(r.body.marks, {});
  assert.equal(file().mcpServers.notes.exposure, "deferred", "auto leaves the file as it was");
  assert.equal((await call("PUT", "/api/mcp/servers/notes/mark", { mark: "sometimes" })).status, 400);
  assert.equal((await call("PUT", "/api/mcp/servers/nobody/mark", { mark: "lazy" })).status, 404);
});

test("the tools that ask first are kept by the server's name, and refused when they are not patterns", async () => {
  put({ notes: { command: "n" } });
  let r = await call("PUT", "/api/mcp/servers/notes/approve", { approve: [" delete_* ", "drop", "drop", ""] });
  assert.deepEqual(r.body.approve, ["delete_*", "drop"]);
  assert.deepEqual(db.mcpApprove().notes, ["delete_*", "drop"]);
  assert.equal((await call("PUT", "/api/mcp/servers/notes/approve", { approve: ["a\nb"] })).status, 400);
  assert.equal((await call("PUT", "/api/mcp/servers/notes/approve", { approve: "delete_*" })).status, 400);
  assert.equal((await call("PUT", "/api/mcp/servers/other/approve", { approve: ["x"] })).status, 404);
  r = await call("PUT", "/api/mcp/servers/notes/approve", { approve: [] });
  assert.deepEqual(db.mcpApprove().notes, undefined, "none takes the entry away");
});

// --- the folders of the report ---

const repo = path.join(home, "repo");
const outside = path.join(home, "secret.json");
const report = (projects) => ({ v: 1, status: "done", at: new Date().toISOString(), adapter: { was: "on", removed: true }, file: { state: "converted" }, servers: [], names: { converted: 0 }, expanded: [], unconverted: [], untrusted: [], texts: [], projects, gone: [], notes: [] });
const listFolder = (extra = {}) => db.putSetting(MCP_MIGRATION, JSON.stringify(report([{ folder: repo, adapterSettings: false, mcpJson: true, foreign: [".mcp.json", path.join(".vscode", "mcp.json"), "opencode.json"], ...extra }])));

test("a folder's file is taken into the user's configuration, switched off, translated where it is in the adapter's keys", async () => {
  mkdirSync(path.join(repo, ".pi"), { recursive: true });
  mkdirSync(path.join(repo, ".vscode"), { recursive: true });
  writeFileSync(
    path.join(repo, ".pi", "mcp.json"),
    JSON.stringify({ mcpServers: { tracker: { url: "https://tracker.example.test/mcp", directTools: true, approveTools: ["tracker_close*"] }, override: { enabled: false }, "bad name": { command: "x" }, runs: { command: "x", env: { TOKEN: "!pass show t" } } } }),
  );
  writeFileSync(path.join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { local: { command: "npx", args: ["-y", "local-mcp"] } } }));
  writeFileSync(path.join(repo, ".vscode", "mcp.json"), JSON.stringify({ servers: { vs: { type: "http", url: "https://vs.example.test/mcp" } } }));
  put({ existing: { command: "e" } });
  listFolder();

  let r = await call("POST", "/api/mcp/import-folder", { folder: repo, file: path.join(".pi", "mcp.json") });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.added.sort(), ["runs", "tracker"]);
  assert.deepEqual(r.body.skipped.map((one) => one.name).sort(), ["bad name", "override"]);
  assert.deepEqual(r.body.commands, { runs: ["env.TOKEN"] });
  const servers = file().mcpServers;
  assert.equal(servers.tracker.enabled, false, "what a repository says is looked at before it runs");
  assert.equal(servers.tracker.exposure, "direct", "the adapter's directTools became pi's exposure");
  assert.equal("directTools" in servers.tracker, false);
  assert.equal(servers.runs.enabled, false);
  assert.deepEqual(db.mcpApprove().tracker, ["tracker_close*"], "approveTools became the tools that ask first");
  assert.ok(servers.existing, "what was there stays");

  r = await call("POST", "/api/mcp/import-folder", { folder: repo, file: ".mcp.json" });
  assert.deepEqual(r.body.added, ["local"]);
  r = await call("POST", "/api/mcp/import-folder", { folder: repo, file: path.join(".vscode", "mcp.json") });
  assert.deepEqual(r.body.added, ["vs"]);
  // Again: a name that is taken is not replaced.
  r = await call("POST", "/api/mcp/import-folder", { folder: repo, file: ".mcp.json" });
  assert.deepEqual(r.body.added, []);
  assert.match(r.body.skipped[0].reason, /already exists/);
});

test("only a folder and a file the report names can be read", async () => {
  listFolder();
  put({});
  assert.equal((await call("POST", "/api/mcp/import-folder", { folder: home, file: ".mcp.json" })).status, 404, "a folder the report does not list");
  assert.equal((await call("POST", "/api/mcp/import-folder", { folder: repo, file: "../secret.json" })).status, 400);
  assert.equal((await call("POST", "/api/mcp/import-folder", { folder: repo, file: "opencode.json" })).status, 400, "a shape that is not read");
  assert.equal((await call("POST", "/api/mcp/import-folder", { folder: repo, file: "package.json" })).status, 400);
  listFolder({ mcpJson: false, foreign: [] });
  assert.equal((await call("POST", "/api/mcp/import-folder", { folder: repo, file: ".mcp.json" })).status, 400, "a file the report did not find there");
  assert.deepEqual(file().mcpServers, {});
});

test("a link in a repository that leads out of it is not followed", async () => {
  writeFileSync(outside, JSON.stringify({ mcpServers: { stolen: { command: "x" } } }));
  rmSync(path.join(repo, ".mcp.json"));
  symlinkSync(outside, path.join(repo, ".mcp.json"));
  listFolder();
  const r = await call("POST", "/api/mcp/import-folder", { folder: repo, file: ".mcp.json" });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.deepEqual(file().mcpServers, {});
});
