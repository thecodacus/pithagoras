import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// A browser connection written before vision: the portal's own, and one
// somebody gave capabilities of their own.
const home = inProcessHome("pithagoras-pin-");
const mcp = path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json");
const CDP = "http://127.0.0.1:9222";
writeFileSync(
  mcp,
  JSON.stringify({
    mcpServers: {
      browser: {
        command: "npx",
        args: ["-y", "@playwright/mcp@0.0.79", "--cdp-endpoint", CDP, "--snapshot-mode", "none"],
        directTools: ["browser_navigate", "browser_take_screenshot"],
      },
      tabs: {
        command: "npx",
        args: ["-y", "@playwright/mcp@0.0.79", "--cdp-endpoint", CDP, "--snapshot-mode", "none", "--caps", "tabs"],
      },
      unrelated: { command: "npx", args: ["-y", "some-other-server"] },
    },
  })
);

const { pinConnection } = await import("../dist/api/browser.js");
const read = () => JSON.parse(readFileSync(mcp, "utf8")).mcpServers;

test("an older connection gains vision and its pointer tools", () => {
  pinConnection();
  const { browser } = read();
  assert.deepEqual(browser.args.slice(-2), ["--caps", "vision"]);
  assert.deepEqual(browser.directTools, [
    "browser_navigate",
    "browser_take_screenshot",
    "browser_mouse_click_xy",
    "browser_mouse_move_xy",
    "browser_mouse_drag_xy",
    "browser_mouse_wheel",
  ]);
});

test("capabilities somebody chose are kept, with vision beside them", () => {
  const { tabs } = read();
  assert.equal(tabs.args[tabs.args.indexOf("--caps") + 1], "tabs,vision");
  // No prompt-listed tools were written for it, so none are invented.
  assert.equal(tabs.directTools, undefined);
});

test("a server that is not the browser is left alone", () => {
  assert.deepEqual(read().unrelated.args, ["-y", "some-other-server"]);
});

test("running it again changes nothing", () => {
  const before = readFileSync(mcp, "utf8");
  pinConnection();
  assert.equal(readFileSync(mcp, "utf8"), before);
});
