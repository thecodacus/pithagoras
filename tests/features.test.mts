import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "./helpers.mts";

inProcessHome("pitha-features-");

test("background subagents the last server left running are found by their start without an end", async () => {
  const { appendEvent, openDetachedSubagents } = await import("../core/server/src/db.ts");
  const { createSession } = await import("../core/server/src/db.ts");
  createSession({ id: "bg-chat", title: "t", workspace: "/w", executor: "host", kind: "task" });
  appendEvent("bg-chat", "portal_subagent", { type: "portal_subagent", op: "start", id: "done-one", detached: true });
  appendEvent("bg-chat", "portal_subagent", { type: "portal_subagent", op: "end", id: "done-one", detached: true, status: "done" });
  appendEvent("bg-chat", "portal_subagent", { type: "portal_subagent", op: "start", id: "left-one", detached: true });
  appendEvent("bg-chat", "portal_subagent", { type: "portal_subagent", op: "start", id: "foreground", toolCallId: "c" });
  assert.deepEqual(openDetachedSubagents(), [{ sessionId: "bg-chat", id: "left-one" }]);
});

test("the page is shown the three defaults it edits, and nothing else the settings table keeps", async () => {
  const { putSetting, setSettings, shownStoredSettings } = await import("../core/server/src/db.ts");
  putSetting("guard_trusted_mcp_servers", JSON.stringify(["notes"]));
  setSettings({ provider: "llama-swap", model: "model-a" });
  const shown = shownStoredSettings();
  assert.deepEqual(shown, { provider: "llama-swap", model: "model-a" });
});

test("a package pi lists by its folder is found as a full path, ~ for home included", async () => {
  const { localPackagePath } = await import("../core/server/src/features.ts");
  const home = process.env.HOME;
  process.env.HOME = "/home/someone";
  try {
    assert.equal(localPackagePath("~/src/pithagoras/extensions/subagent", "/home/someone/.pi/agent"), "/home/someone/src/pithagoras/extensions/subagent");
    assert.equal(localPackagePath("../../src/x", "/home/someone/.pi/agent"), "/home/someone/src/x");
    assert.equal(localPackagePath("/abs/x", "/home/someone/.pi/agent"), "/abs/x");
  } finally {
    process.env.HOME = home;
  }
});

test("background subagents open in a chat are kept in step with their starts and ends, and dropped with the chat", async () => {
  const { appendEvent, openSubagentsIn, createSession, deleteSession } = await import("../core/server/src/db.ts");
  createSession({ id: "open-chat", title: "t", workspace: "/w", executor: "host", kind: "task" });
  appendEvent("open-chat", "portal_subagent", { type: "portal_subagent", op: "start", id: "a", detached: true });
  appendEvent("open-chat", "portal_subagent", { type: "portal_subagent", op: "start", id: "b", detached: true });
  appendEvent("open-chat", "portal_subagent", { type: "portal_subagent", op: "event", id: "a", detached: true, event: { type: "agent_start" } });
  appendEvent("open-chat", "portal_subagent", { type: "portal_subagent", op: "end", id: "a", detached: true, status: "done" });
  assert.deepEqual(openSubagentsIn("open-chat"), ["b"]);
  deleteSession("open-chat");
  assert.deepEqual(openSubagentsIn("open-chat"), []);
});
