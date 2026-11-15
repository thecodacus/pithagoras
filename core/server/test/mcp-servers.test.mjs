import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { freePort, serverEnv, startServer, testHome } from "./server-harness.mjs";

/** Adding or renaming an MCP server onto a name that is taken replaced it, with everything the form does not show. */
const home = testHome("mcp-servers-");
const file = path.join(home, "agent", "mcp.json");
writeFileSync(file, JSON.stringify({ mcpServers: { github: { url: "https://mcp.example.test", auth: "oauth", oauth: { clientId: "kept" }, headers: { "X-Org": "a" } }, notes: { command: "notes-mcp" } } }));
const { base } = await startServer(serverEnv(home, await freePort()));

const put = async (name, entry, from) => {
  const res = await fetch(`${base}/api/mcp/servers/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ entry, from }) });
  return { status: res.status, body: await res.json() };
};
const servers = () => JSON.parse(readFileSync(file, "utf8")).mcpServers;

test("a new server on a taken name is refused, and the one there is as it was", async () => {
  const refused = await put("github", { command: "other" });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "exists");
  assert.deepEqual(servers().github.oauth, { clientId: "kept" });
  assert.equal(servers().github.command, undefined);
});

test("a rename onto a taken name is refused, and neither server is lost", async () => {
  const refused = await put("github", { command: "notes-mcp" }, "notes");
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.deepEqual(Object.keys(servers()).sort(), ["github", "notes"]);
  assert.equal(servers().notes.command, "notes-mcp");
});

test("a server is still changed under its own name, renamed to a free one, and added", async () => {
  assert.equal((await put("notes", { command: "notes-mcp", args: ["--fast"] }, "notes")).status, 200);
  assert.deepEqual(servers().notes.args, ["--fast"]);
  assert.equal((await put("journal", { command: "notes-mcp" }, "notes")).status, 200);
  assert.deepEqual(Object.keys(servers()).sort(), ["github", "journal"]);
  assert.equal((await put("fresh", { command: "x" })).status, 200);
  assert.ok(servers().fresh);
});

test("a pasted config adds the servers that are new and leaves the one of the same name as it was", async () => {
  const text = JSON.stringify({ mcpServers: { github: { command: "npx", args: ["-y", "github-mcp"] }, pasted: { command: "pasted-mcp" } } });
  const res = await fetch(`${base}/api/mcp/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(body.added, ["pasted"]);
  assert.deepEqual(body.skipped, [{ name: "github", reason: "A server called github already exists" }]);
  assert.deepEqual(servers().github.oauth, { clientId: "kept" });
  assert.equal(servers().github.command, undefined);
  assert.equal(servers().pasted.command, "pasted-mcp");
});

const json = async (method, url, body) => {
  const res = await fetch(`${base}${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test("a server sent with tools that ask first that cannot be kept is not written at all", async () => {
  // From the CodeRabbit review of #371: the entry was saved, then its questions refused, and the server ran without them.
  const many = Array.from({ length: 101 }, (_, i) => `tool_${i}`);
  const res = await fetch(`${base}/api/mcp/servers/asking`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ entry: { command: "x" }, approve: many }) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /At most 100 patterns/);
  assert.equal(servers().asking, undefined);
  const fine = await fetch(`${base}/api/mcp/servers/asking`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ entry: { command: "x" }, approve: ["drop_*"] }) });
  assert.equal(fine.status, 200);
  assert.ok(servers().asking);
});

test("the status, the mark and the questions are the running portal's, and a rename leaves them behind", async () => {
  const marked = await json("PUT", "/api/mcp/servers/pasted/mark", { mark: "direct" });
  assert.equal(marked.status, 200, JSON.stringify(marked.body));
  assert.equal((await json("PUT", "/api/mcp/servers/pasted/approve", { approve: ["drop_*"] })).status, 200);
  let state = (await json("GET", "/api/mcp/status")).body.servers.pasted;
  assert.deepEqual([state.mark, state.lazy, state.by, state.approve], ["direct", false, "mark", ["drop_*"]]);
  assert.equal(servers().pasted.exposure, "direct", "said in the file for pi alone");
  // The Tools page's own route keeps the same marks, and refuses what it refused before.
  assert.equal((await json("PUT", "/api/tools/marks", { marks: { pasted: "direct", "<tool>read": "lazy" } })).status, 400);
  assert.equal((await json("PUT", "/api/tools/marks", { marks: { pasted: "direct", fresh: "lazy" } })).status, 200);
  // A rename takes the questions with the old name; the form says them again under the new one.
  assert.equal((await put("renamed", servers().pasted, "pasted")).status, 200);
  state = (await json("GET", "/api/mcp/status")).body.servers.renamed;
  assert.deepEqual(state.approve, []);
  assert.equal((await json("PUT", "/api/mcp/servers/pasted/approve", { approve: ["x"] })).status, 404);
});

test("a server written in the old adapter's keys is said not to connect, beside the server, and one that is switched off is not", async () => {
  // Round 2 of PR B, spec finding 1: an entry put back from mcp.json.adapter is not converted, and was listed as if it worked.
  const before = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ mcpServers: { ...before.mcpServers, restored: { command: "old-mcp", excludeTools: ["delete_all"], directTools: true }, restoredOff: { command: "old-mcp", directTools: true, enabled: false } } }));
  const listed = await (await fetch(`${base}/api/mcp`)).json();
  const one = (name) => listed.servers.find((server) => server.name === name);
  assert.match(one("restored").problem, /old MCP adapter \(directTools, excludeTools\)/);
  assert.equal(one("restoredOff").problem, null);
  assert.equal(one("fresh").problem, null);
  writeFileSync(file, JSON.stringify({ mcpServers: before.mcpServers }));
});
