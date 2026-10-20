import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// A browser wired under another name, as an older portal or a hand-written
// mcp.json would have it. What makes it a browser the agent is signed into is
// that it attaches to one that is running, wherever that is.
inProcessHome("pithagoras-name-");
const mcp = path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json");
const attached = (at) => ({ command: "npx", args: ["-y", "@playwright/mcp@0.0.79", "--cdp-endpoint", at] });
const { browserServers } = await import("../dist/api/mcp.js");

test("a browser server is one that attaches to a running browser, at any address, not the one with a certain name", () => {
  writeFileSync(
    mcp,
    JSON.stringify({
      mcpServers: {
        chrome: attached("http://127.0.0.1:9222"),
        remote: attached("http://10.0.0.5:9333"),
        // Another Playwright server with a browser of its own: nobody's logins.
        scratch: { command: "npx", args: ["-y", "@playwright/mcp@0.0.79"] },
      },
    })
  );
  assert.deepEqual(browserServers(), ["chrome", "remote"]);
});

test("one that is called browser still counts, as it always has", () => {
  writeFileSync(mcp, JSON.stringify({ mcpServers: { browser: {} } }));
  assert.deepEqual(browserServers(), ["browser"]);
});

test("an entry that is not an object is no browser, and does not stop the others from being found", () => {
  writeFileSync(mcp, JSON.stringify({ mcpServers: { old: null, odd: 3, chrome: attached("http://127.0.0.1:9222") } }));
  assert.deepEqual(browserServers(), ["chrome"]);
});
