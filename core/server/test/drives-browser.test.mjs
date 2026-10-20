import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// A tool of any package that says it drives a browser (`drivesBrowser` on its definition), as the portal remembers
// it: one of the browser's tools wherever they are counted, and no MCP server's however it is named. Next to a
// Playwright MCP server called `browser`, whose tools say nothing of themselves.
const home = inProcessHome("pithagoras-drives-browser-");
const agent = process.env.PI_CODING_AGENT_DIR;
writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: ["npm:pi-mcp-adapter@2.18.0"] }));
writeFileSync(path.join(agent, "mcp.json"), JSON.stringify({ mcpServers: { browser: { command: "npx", args: ["@playwright/mcp"] } } }));

const db = await import("../dist/db.js");
const { browserTool } = await import("../dist/tool-policy.js");

const ADAPTER = "npm:pi-mcp-adapter@2.18.0";
/** A tool as a chat reports it and the portal remembers it. */
const report = (tool) => db.remembered(tool);
const known = (name) => db.knownTools().find((t) => t.name === name);

test("what a tool says of itself is remembered as its latest report says, and read back as it was written", () => {
  db.rememberTools([
    report({ name: "page_open", source: "pithagoras-pages", inline: true, drivesBrowser: true }),
    report({ name: "page_note", source: "pithagoras-pages", inline: true }),
  ]);
  assert.equal(known("page_open").drivesBrowser, true);
  assert.equal("drivesBrowser" in known("page_note"), false);
  assert.equal(JSON.parse(db.getSetting("tools_seen")).find((t) => t.name === "page_open").drivesBrowser, true, "kept in tools_seen");
  // A report without it takes it back, as one without its files does.
  db.rememberTools([report({ name: "page_open", source: "pithagoras-pages", inline: true })]);
  assert.equal("drivesBrowser" in known("page_open"), false);
  db.rememberTools([report({ name: "page_open", source: "pithagoras-pages", inline: true, drivesBrowser: true })]);
  assert.equal(known("page_open").drivesBrowser, true);
});

test("a tool that says it drives a browser is one of the browser's tools, as a browser server's are and the portal's own remembered before tools said so", () => {
  db.rememberTools([
    report({ name: "browser_browser_click", source: "pi-mcp-adapter", package: ADAPTER }),
    // The portal's own, remembered by a portal from before its tools said it.
    report({ name: "browser_navigate", source: "browser", inline: true }),
    report({ name: "web_search", source: "pi-web-access", package: "npm:pi-web-access" }),
  ]);
  assert.deepEqual(db.seenBrowserTools().sort(), ["browser_browser_click", "browser_navigate", "page_open"]);
  assert.equal(browserTool("page_open", ["browser"]), false, "by its name it is nobody's");
  assert.equal(browserTool("page_open", ["browser"], ["browser"], true), true);

  // Who may drive a browser follows its switches with the rest of them.
  assert.equal(db.browserByDefault(), true);
  db.setToolDefaultsOff(["browser_browser_click", "browser_navigate"]);
  assert.equal(db.browserByDefault(), true, "page_open still has it");
  db.setToolDefaultsOff(["browser_browser_click", "browser_navigate", "page_open"]);
  assert.equal(db.browserByDefault(), false);
  db.setToolDefaultsOff([]);
});

test("a browser tool that turns up later on an upgraded install is carried as the others were, when it says it drives a browser", () => {
  db.createSession({ id: "granted", title: "granted", workspace: home, executor: "host" });
  db.getDb().prepare("UPDATE sessions SET browser = 1 WHERE id = 'granted'").run();
  db.putSetting("browser_tools_adopted", "carry");
  db.rememberTools([
    report({ name: "page_back", source: "pithagoras-pages", inline: true, drivesBrowser: true }),
    report({ name: "page_count", source: "pithagoras-pages", inline: true }),
  ]);
  assert.ok(db.toolDefaultsOff().includes("page_back"), "off by default, as the browser was on this install");
  assert.ok(db.sessionTools("granted").on.includes("page_back"), "and on where the browser was granted");
  assert.ok(!db.toolDefaultsOff().includes("page_count"), "one that says nothing is left alone");
  db.putSetting("browser_tools_adopted", "1");
  db.setToolDefaultsOff([]);
});

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
  db.rememberTools([report({ name: "browser_open", source: "pithagoras-pages", inline: true, drivesBrowser: true })]);
  writeFileSync(path.join(agent, "mcp.json"), JSON.stringify({ mcpServers: {} }));
  db.mcpServersRemoved(["browser"], []);
  assert.equal(known("browser_browser_click"), undefined, "the server's tool is forgotten");
  assert.ok(known("browser_open"), "the package's stays");
  assert.deepEqual(db.withdrawnMcpTools([{ name: "browser_browser_type" }, { name: "browser_close", inline: true }]), ["browser_browser_type"]);
});
