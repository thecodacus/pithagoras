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
