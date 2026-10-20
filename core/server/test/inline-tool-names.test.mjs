import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// A tool an inline extension registers (the portal's own, or a server half's under its package's name) is no MCP
// server's however it is named: next to a Playwright MCP server called `browser`, a package's `browser_open` is the
// package's.
inProcessHome("pithagoras-inline-tool-names-");
const agent = process.env.PI_CODING_AGENT_DIR;
writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: ["npm:pi-mcp-adapter@2.18.0"] }));
writeFileSync(path.join(agent, "mcp.json"), JSON.stringify({ mcpServers: { browser: { command: "npx", args: ["@playwright/mcp"] } } }));

const db = await import("../dist/db.js");

const ADAPTER = "npm:pi-mcp-adapter@2.18.0";
const known = (name) => db.knownTools().find((t) => t.name === name);

test("a package's tool named like a server's is not that server's: browser_open beside a server called browser", () => {
  const servers = ["browser"];
  // Registered by an inline extension, the portal's own or a server half's under its package's name.
  assert.equal(db.lazyAllowed({ name: "browser_open", source: "pithagoras-pages", package: null, inline: true }, servers), true);
  // Not by a name list: any name, the portal's own browser tools' among them.
  assert.equal(db.lazyAllowed({ name: "browser_navigate", source: "browser", package: null, inline: true }, servers), true);
  // One of no inline extension that the server's name claims is taken for the server's, as before.
  assert.equal(db.lazyAllowed({ name: "browser_open", source: "pi-other", package: "npm:pi-other" }, servers), false);
  assert.equal(db.lazyAllowed({ name: "browser_browser_click", source: "pi-mcp-adapter", package: ADAPTER }, servers), false);

  // A removed server takes its tools from a chat still running with them, and not a package's of a name like theirs.
  db.rememberTools([
    db.remembered({ name: "browser_browser_click", source: "pi-mcp-adapter", package: ADAPTER }),
    db.remembered({ name: "browser_open", source: "pithagoras-pages", inline: true }),
  ]);
  writeFileSync(path.join(agent, "mcp.json"), JSON.stringify({ mcpServers: {} }));
  db.mcpServersRemoved(["browser"], []);
  assert.equal(known("browser_browser_click"), undefined, "the server's tool is forgotten");
  assert.ok(known("browser_open"), "the package's stays");
  assert.deepEqual(db.withdrawnMcpTools([{ name: "browser_browser_type" }, { name: "browser_close", inline: true }]), ["browser_browser_type"]);
});
