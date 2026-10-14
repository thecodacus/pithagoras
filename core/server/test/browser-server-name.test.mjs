import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// A browser wired under another name, as an older portal or a hand-written
// mcp.json would have it. What makes it the browser is where it connects.
const home = inProcessHome("pithagoras-name-");
const mcp = path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json");
const CDP = "http://127.0.0.1:9222";
writeFileSync(
  mcp,
  JSON.stringify({
    mcpServers: {
      chrome: { command: "npx", args: ["-y", "@playwright/mcp@0.0.79", "--cdp-endpoint", CDP] },
      // Another Playwright server with a browser of its own: not ours.
      scratch: { command: "npx", args: ["-y", "@playwright/mcp@0.0.79"] },
    },
  })
);

const { browserAllowed, browserByDefault, createSession, getSession, rememberTools, setSessionTools } =
  await import("../dist/db.js");
const { browserServers, findConnection } = await import("../dist/api/mcp.js");

createSession({ id: "c1", title: "c", workspace: home, executor: "host" });

test("the browser is the server that connects to it, not the one with a certain name", () => {
  assert.deepEqual(browserServers(), ["chrome"]);
  assert.equal(findConnection(), "chrome");
});

test("its tools are the browser's, and a conversation with them has it", () => {
  rememberTools([
    { name: "chrome_browser_click", source: "pi-mcp-adapter" },
    { name: "scratch_browser_click", source: "pi-mcp-adapter" },
  ]);
  assert.equal(browserAllowed(getSession("c1")), true);
  assert.equal(browserByDefault(), true);
});

test("switching them off takes the browser away, and the other server's do not give it back", () => {
  setSessionTools("c1", { off: ["chrome_browser_click"], on: ["scratch_browser_click"] });
  assert.equal(browserAllowed(getSession("c1")), false);
});

test("one that is called browser still counts, as it always has", () => {
  writeFileSync(mcp, JSON.stringify({ mcpServers: { browser: {} } }));
  assert.deepEqual(browserServers(), ["browser"]);
});

test("an entry that is not an object is no browser, and does not stop the others from being found", () => {
  writeFileSync(mcp, JSON.stringify({ mcpServers: { old: null, odd: 3, chrome: { command: "npx", args: ["-y", "@playwright/mcp@0.0.79", "--cdp-endpoint", CDP] } } }));
  assert.deepEqual(browserServers(), ["chrome"]);
  assert.equal(findConnection(), "chrome");
});
