import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

const home = inProcessHome("pithagoras-ext-state-");

const { createSession } = await import("../dist/db.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { sessions } = await import("../dist/session-manager.js");

class FakePi extends EventEmitter {
  running = true;
  async abort() {}
  dispose() {}
  isIdle() { return true; }
  async getCommands() { return [{ name: "bg", source: "extension" }]; }
  async prompt() {
    this.emit("event", { type: "extension_ui_request", id: "s", method: "setStatus", statusKey: "bg", statusText: "bg 1 running" });
    this.emit("event", { type: "extension_ui_request", id: "w", method: "setWidget", widgetKey: "jobs", widgetContent: ["npm run dev"] });
    return { outcome: "handled" };
  }
}
SdkPiClient.create = async () => new FakePi();

test("what extensions showed goes with a pi that is stopped, not only one that crashed", async () => {
  createSession({ id: "restarted", title: "restarted", workspace: home, executor: "host" });
  await sessions.prompt("restarted", "/bg");
  assert.deepEqual(sessions.extensionState("restarted"), {
    statuses: [{ key: "bg", text: "bg 1 running" }],
    widgets: [{ key: "jobs", lines: ["npm run dev"] }],
  });
  // A model or tool change restarts it; a delete stops it for good.
  await sessions.stop("restarted");
  assert.deepEqual(sessions.extensionState("restarted"), { statuses: [], widgets: [] });
});

test("a chat knows when a tool call is running in it, its subagents' included", async () => {
  createSession({ id: "calls", title: "calls", workspace: home, executor: "host" });
  await sessions.prompt("calls", "/bg");
  const pi = sessions.live.get("calls").client;
  assert.equal(sessions.callsRunning("calls"), false);
  pi.emit("event", { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "npm test" } });
  assert.equal(sessions.callsRunning("calls"), true);
  pi.emit("event", { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {} });
  assert.equal(sessions.callsRunning("calls"), false);
  // A subagent's call, and the subagent ending with it still open.
  pi.emit("event", { type: "portal_subagent", op: "event", id: "s1", event: { type: "tool_execution_start", toolCallId: "t1", toolName: "bash" } });
  assert.equal(sessions.callsRunning("calls"), true);
  pi.emit("event", { type: "portal_subagent", op: "end", id: "s1", status: "stopped" });
  assert.equal(sessions.callsRunning("calls"), false);
});
