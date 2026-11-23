import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// A tool is filed under what says whose it is, never under what its name looks like: an MCP server's tools under the
// server (the report says so: `mcp`), a package's `browser_open` next to a Playwright MCP server called `browser` under
// the package. Removing the server forgets its tools and no package's.
inProcessHome("pithagoras-inline-tool-names-");
const agent = process.env.PI_CODING_AGENT_DIR;
writeFileSync(path.join(agent, "mcp.json"), JSON.stringify({ mcpServers: { browser: { command: "npx", args: ["@playwright/mcp"] } } }));

const db = await import("../dist/db.js");
const known = (name) => db.knownTools().find((t) => t.name === name);

test("a package's tool named like a server's is not that server's: browser_open beside a server called browser", () => {
  // Registered by an inline extension, the portal's own or a server half's under its package's name.
  assert.equal(db.lazyAllowed({ name: "browser_open", source: "pithagoras-pages", inline: true }), true);
  assert.equal(db.lazyAllowed({ name: "browser_navigate", source: "browser", inline: true }), true);
  // An MCP server's tools are a set like any other: they may be lazy.
  assert.equal(db.lazyAllowed({ name: "mcp__browser__browser_click", source: "browser" }), true);
  // pi's own tools may not.
  assert.equal(db.lazyAllowed({ name: "bash", source: "built in" }), false);

  db.rememberTools([
    db.remembered({ name: "mcp__browser__browser_click", source: "browser", mcp: "browser" }),
    db.remembered({ name: "browser_open", source: "pithagoras-pages", inline: true }),
  ]);
  assert.equal(known("mcp__browser__browser_click").mcp, "browser");
  assert.equal(known("browser_open").mcp, undefined);
  // The server is taken out of the file, by whoever: its tools are forgotten, and not a package's of a name like theirs.
  writeFileSync(path.join(agent, "mcp.json"), JSON.stringify({ mcpServers: {} }));
  db.forgetMcpTools(["browser"]);
  assert.equal(known("mcp__browser__browser_click"), undefined, "the server's tool is forgotten");
  assert.ok(known("browser_open"), "the package's stays");
});
