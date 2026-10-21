import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The portal's own Understory holds the agent's memory as an extension would (`portal.memory.hold`), through the same
 * function: the portal's flags and the agent's setup name it, and an extension that asks while it holds it is refused.
 */
const home = inProcessHome("extension-memory-understory-");
const agentDir = process.env.PI_CODING_AGENT_DIR;
const said = [];
const log = console.log;
console.log = (...args) => {
  said.push(args.join(" "));
  log(...args);
};
test.after(() => (console.log = log));

const host = await import("../dist/extension-host.js");
const { UNDERSTORY_RULE } = await import("../dist/features.js");
const { memoryHolder } = await import("../dist/memory-holder.js");
const { memoryRule } = await import("../dist/pi/sdk-client.js");
const { agentFileStatus } = await import("../dist/agent-setup.js");
const { featuresRouter } = await import("../dist/api/features.js");
const { default: express } = await import("express");
test.after(() => host.stopServerHalves());

const app = express().use("/api", featuresRouter());
const listener = app.listen(0, "127.0.0.1");
await new Promise((resolve) => listener.once("listening", resolve));
test.after(() => listener.close());
const flags = async () => (await fetch(`http://127.0.0.1:${listener.address().port}/api/features/flags`)).json();

/** Understory as the portal has it when it is switched on: its MCP server, reached through the adapter. */
function understory(on) {
  writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: on ? { understory: { url: "http://127.0.0.1:1/mcp" } } : {} }));
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-mcp-adapter"] }));
}

test("Understory holds the memory while it is on: the flags and the agent's setup say so, by its name, and its rule is said", async () => {
  const agentHome = process.env.AGENT_HOME;
  understory(false);
  assert.deepEqual(await flags(), { subagent: { enabled: false }, understory: { enabled: false }, memory: { held: false, by: null } });
  assert.equal(agentFileStatus(agentHome).memory, "file");
  assert.deepEqual(memoryRule(agentHome), []);

  understory(true);
  assert.deepEqual(await flags(), { subagent: { enabled: false }, understory: { enabled: true }, memory: { held: true, by: "Understory" } });
  const setup = agentFileStatus(agentHome);
  assert.deepEqual({ memory: setup.memory, by: setup.by }, { memory: "extension", by: "Understory" });
  assert.deepEqual(memoryRule(agentHome), [UNDERSTORY_RULE]);
});

test("an extension that asks to hold the memory while Understory does is refused, with a line in the log", async () => {
  understory(true);
  const dir = path.join(home, "packages", "keeper");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "server.js");
  writeFileSync(file, `export default function (portal) {\nportal.memory.hold({ label: "Keeper", rule: "Keeper's rule.", on: () => true });\n}\n`);
  await host.syncServerHalves([{ name: "keeper", version: "1.0.0", file, rev: statSync(file).size.toString(36) }]);
  assert.ok(said.includes("[portal] keeper cannot hold the agent's memory: the portal holds it already, as Understory"), said.join("\n"));
  assert.equal(memoryHolder()?.label, "Understory");
  // Stopped, it lets go of nothing it did not hold.
  await host.syncServerHalves([]);
  assert.equal(memoryHolder()?.label, "Understory");
});
