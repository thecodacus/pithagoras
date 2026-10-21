import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The rules for a Playwright MCP browser someone attached by hand, which the portal says in the system
 * prompt (framing in sdk-client.ts). They are about 325 tokens in every request, so they are said only
 * where such a server is configured. A package's browser tools carry rules of their own.
 */
const home = inProcessHome("pithagoras-browser-mcp-rules-");
mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR, "extensions"), { recursive: true });
mkdirSync(process.env.WORKSPACE_ROOT, { recursive: true });
// A tool an extension brings, which a chat has only where the resource loader, which loads the extensions, was made.
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "extensions", "notes.ts"), `
export default function (pi: any) {
  pi.registerTool({ name: "note_down", label: "Note down", description: "Note something down.", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) });
}
`);

const model = await fakeModel(() => "Done.");
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));

const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { BROWSER_READING_RULE, BROWSER_SCREENSHOT_RULE } = await import("../dist/pi/browser-mcp-rules.js");

const systemOf = (request) =>
  request.messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");

let n = 0;
/** The first request a new conversation sends. */
async function ask() {
  model.requests.length = 0;
  const client = await SdkPiClient.create({
    cwd: mkdtempSync(path.join(process.env.WORKSPACE_ROOT, "chat-")),
    sessionDir: mkdtempSync(path.join(home, "chat-")),
    provider: "fake",
    modelId: "m",
    sessionId: `mcp-rules-${n++}`,
  });
  const settled = new Promise((resolve) => client.on("event", (e) => e?.type === "agent_settled" && resolve()));
  try {
    await client.prompt("Hello");
    await settled;
    return model.requests[0];
  } finally {
    client.dispose();
  }
}

test("the rules for a Playwright browser are sent only where there is one", async () => {
  const mcp = path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json");
  const playwright = { command: "npx", args: ["-y", "@playwright/mcp@0.0.79", "--cdp-endpoint", "http://127.0.0.1:9222"] };
  const said = async () => {
    const system = systemOf(await ask());
    return { reading: system.includes(BROWSER_READING_RULE), screenshot: system.includes(BROWSER_SCREENSHOT_RULE) };
  };
  try {
    // A fresh install: no browser server.
    assert.deepEqual(await said(), { reading: false, screenshot: false }, "no browser server");
    // Another server is no browser.
    writeFileSync(mcp, JSON.stringify({ mcpServers: { files: { command: "npx", args: ["-y", "some-other-server"] } } }));
    assert.deepEqual(await said(), { reading: false, screenshot: false }, "a server that is not a browser");
    // A Playwright server that starts a Chromium of its own is not the agent's browser either.
    writeFileSync(mcp, JSON.stringify({ mcpServers: { playwright: { command: "npx", args: ["-y", "@playwright/mcp@0.0.79"] } } }));
    assert.deepEqual(await said(), { reading: false, screenshot: false }, "a Playwright server with a browser of its own");
    // A Playwright server pointed at a running browser, whatever it is called, and wherever that browser is.
    writeFileSync(mcp, JSON.stringify({ mcpServers: { chrome: playwright } }));
    assert.deepEqual(await said(), { reading: true, screenshot: true }, "a server attached to the browser");
    writeFileSync(mcp, JSON.stringify({ mcpServers: { browser: playwright } }));
    assert.deepEqual(await said(), { reading: true, screenshot: true }, "a browser server");
    writeFileSync(mcp, JSON.stringify({ mcpServers: { remote: { ...playwright, args: ["-y", "@playwright/mcp@0.0.79", "--cdp-endpoint", "http://10.0.0.5:9333"] } } }));
    assert.deepEqual(await said(), { reading: true, screenshot: true }, "a server attached to a browser elsewhere");
  } finally {
    rmSync(mcp, { force: true });
  }
});

test("a configuration that cannot be read says there is no browser server, and leaves the chat its extensions", async () => {
  const mcp = path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json");
  const errors = mock.method(console, "error", () => {});
  const names = (request) => (request.tools ?? []).map((t) => t.function.name);
  try {
    for (const [why, put] of [
      ["a server that is null", () => writeFileSync(mcp, JSON.stringify({ mcpServers: { old: null } }))],
      ["a server that is a number", () => writeFileSync(mcp, JSON.stringify({ mcpServers: { old: 3 } }))],
      ["text that is not JSON", () => writeFileSync(mcp, "{ not json")],
      // A file that cannot be read, whoever the portal runs as.
      ["a file that is a folder", () => mkdirSync(mcp)],
    ]) {
      rmSync(mcp, { recursive: true, force: true });
      put();
      const request = await ask();
      // Without the resource loader a chat has pi's own tools only: no extension's, and no guard.
      assert.ok(names(request).includes("note_down"), `${why}: the extensions' tools are there`);
      const system = systemOf(request);
      assert.ok(!system.includes(BROWSER_READING_RULE) && !system.includes(BROWSER_SCREENSHOT_RULE), `${why}: no Playwright rules`);
      assert.equal(errors.mock.calls.filter((call) => /resource loader unavailable/.test(String(call.arguments[0]))).length, 0, `${why}: the loader was made`);
    }
  } finally {
    rmSync(mcp, { recursive: true, force: true });
    errors.mock.restore();
  }
});
