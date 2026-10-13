import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { inProcessHome } from "./server-harness.mjs";

// The debug lines of the tool calls and the approvals: what is written, when it is written, and what never is.

const home = inProcessHome("pithagoras-debug-areas-");

const { createSession, getDb, recordAudit, setDefaultReportTo } = await import("../dist/db.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { sessions } = await import("../dist/session-manager.js");
const { channelSupervisor } = await import("../dist/channels/supervisor.js");
const { askPrimaryTool } = await import("../dist/pi/ask-primary.js");
const { askQuestion } = await import("../dist/questions.js");
const { recordApproval } = await import("../dist/approvals.js");
const { installLogCapture, readLogs, resetLogs, setLogLevel } = await import("../dist/logs.js");
const { seen, setRole } = await import("../dist/people.js");

test.after(() => getDb().close());

class FakePi extends EventEmitter {
  running = true;
  async abort() {}
  dispose() {}
  isIdle() { return true; }
  async getCommands() { return [{ name: "bg", source: "extension" }]; }
  async prompt() { return { outcome: "handled" }; }
}
SdkPiClient.create = async () => new FakePi();

installLogCapture();

/** Runs `fn` with the server at the debug level, what it prints kept off the runner's output; the lines are read back from the list. */
async function atDebug(fn) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  setLogLevel("debug");
  try {
    return await fn();
  } finally {
    setLogLevel("info");
    process.stdout.write = write;
  }
}

/** The debug lines of one scope since the last reset. */
const lines = (scope) => readLogs().filter((l) => l.level === "debug" && l.text.startsWith(`[${scope}]`)).map((l) => l.text);
const everything = () => readLogs().map((l) => l.text).join("\n");

/** Runs `fn` with the clock where it is put and moving only when told: `tick(ms)`. */
async function withClock(fn) {
  let at = 1_000_000;
  const now = mock.method(Date, "now", () => at);
  try {
    return await fn((ms) => { at += ms; });
  } finally {
    now.mock.restore();
  }
}

const chat = async (id) => {
  createSession({ id, title: id, workspace: home, executor: "host" });
  await sessions.prompt(id, "/bg");
  return sessions.live.get(id).client;
};

test("a tool call has a line when it begins and one when it ends, with the outcome and how long it took, and nothing else of it", async () => {
  await atDebug(async () => {
    resetLogs();
    const pi = await chat("calls-a");
    await withClock(async (tick) => {
      pi.emit("event", { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "curl -H 'Authorization: Bearer abcdefghijklmnop1234567890' https://x" } });
      tick(1520);
      pi.emit("event", { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "password=hunter2hunter2" }] } });
      pi.emit("event", { type: "tool_execution_start", toolCallId: "t2", toolName: "read" });
      tick(7);
      pi.emit("event", { type: "tool_execution_end", toolCallId: "t2", toolName: "read", isError: true });
    });
    assert.deepEqual(lines("tool"), [
      "[tool] start tool=bash session=calls-a",
      "[tool] end tool=bash outcome=ok ms=1520 session=calls-a",
      "[tool] start tool=read session=calls-a",
      "[tool] end tool=read outcome=error ms=7 session=calls-a",
    ]);
    assert.doesNotMatch(everything(), /Bearer|hunter2|curl|abcdefghijklmnop/, "what a call was given and returned is not in a line");
  });
});

test("a call through the tools tool is filed under the lazy tool it calls, and a search through it under tools", async () => {
  await atDebug(async () => {
    resetLogs();
    const pi = await chat("calls-lazy");
    await withClock(async (tick) => {
      pi.emit("event", { type: "tool_execution_start", toolCallId: "t1", toolName: "tools", args: { action: "call", name: "browser_click", args: { ref: "e1" } } });
      tick(40);
      pi.emit("event", { type: "tool_execution_end", toolCallId: "t1", toolName: "tools", isError: false });
      pi.emit("event", { type: "tool_execution_start", toolCallId: "t2", toolName: "tools", args: { action: "search", query: "browser" } });
      tick(3);
      pi.emit("event", { type: "tool_execution_end", toolCallId: "t2", toolName: "tools", isError: false });
    });
    assert.deepEqual(lines("tool"), [
      "[tool] start tool=browser_click via=tools session=calls-lazy",
      "[tool] end tool=browser_click via=tools outcome=ok ms=40 session=calls-lazy",
      "[tool] start tool=tools session=calls-lazy",
      "[tool] end tool=tools outcome=ok ms=3 session=calls-lazy",
    ]);
  });
});

test("a subagent's call names the subagent, and a call whose subagent stops, or whose pi is stopped, ends as cut off", async () => {
  await atDebug(async () => {
    resetLogs();
    const pi = await chat("calls-b");
    await withClock(async (tick) => {
      const inSubagent = (event) => pi.emit("event", { type: "portal_subagent", op: "event", id: "s1", event });
      inSubagent({ type: "tool_execution_start", toolCallId: "t1", toolName: "grep" });
      tick(40);
      inSubagent({ type: "tool_execution_end", toolCallId: "t1", toolName: "grep", isError: false });
      inSubagent({ type: "tool_execution_start", toolCallId: "t2", toolName: "find" });
      tick(300);
      pi.emit("event", { type: "portal_subagent", op: "end", id: "s1", status: "stopped" });
      // The chat's own call, still running when its pi is stopped.
      pi.emit("event", { type: "tool_execution_start", toolCallId: "t3", toolName: "bash" });
      tick(90);
      await sessions.stop("calls-b");
    });
    assert.deepEqual(lines("tool"), [
      "[tool] start tool=grep session=calls-b subagent=s1",
      "[tool] end tool=grep outcome=ok ms=40 session=calls-b subagent=s1",
      "[tool] start tool=find session=calls-b subagent=s1",
      "[tool] end tool=find outcome=cut-off ms=300 session=calls-b subagent=s1",
      "[tool] start tool=bash session=calls-b",
      "[tool] end tool=bash outcome=cut-off ms=90 session=calls-b",
    ]);
  });
});

test("at the info level a tool call writes no line, and one that began before debug was on ends without a duration", async () => {
  resetLogs();
  const pi = await chat("calls-c");
  pi.emit("event", { type: "tool_execution_start", toolCallId: "t1", toolName: "bash" });
  assert.deepEqual(readLogs(), []);
  await atDebug(async () => {
    pi.emit("event", { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false });
  });
  assert.deepEqual(lines("tool"), ["[tool] end tool=bash outcome=ok session=calls-c"]);
});

test("an audit entry has a line with its kind, its tool and the chat, and never its subject or reason", async () => {
  await atDebug(async () => {
    resetLogs();
    recordAudit({
      kind: "refused",
      tool: "bash",
      subject: "curl -H 'Authorization: Bearer abcdefghijklmnop1234567890' https://x?token=abc123",
      reason: "Outside the browser allowlist: https://x?token=abc123",
      personKey: "tg:8812",
      sessionId: "chat-1",
    });
    recordAudit({ kind: "cleared", reason: "3" });
    assert.deepEqual(lines("audit"), ["[audit] refused tool=bash session=chat-1", "[audit] cleared"]);
    assert.doesNotMatch(everything(), /Bearer|token|allowlist|tg:8812/);
  });
  resetLogs();
  recordAudit({ kind: "refused", tool: "bash", sessionId: "chat-1" });
  assert.deepEqual(readLogs(), [], "nothing at info");
});

const question = (extra = {}) =>
  askQuestion({ sessionId: "asking-chat", personKey: "tg:8812", personName: "Alice", channelSlug: "tg", channelKey: "chat:8812", question: "May I read the budget? password=hunter2hunter2", ...extra });

test("an answer to an approval has a line with the tool, the outcome and how long the person waited, and not the action or the words", async () => {
  await atDebug(async () => {
    resetLogs();
    const action = { actionTool: "bash", action: "curl -H 'Authorization: Bearer abcdefghijklmnop1234567890' https://x" };
    await withClock(async () => {
      const asked = question(action);
      // Asked 48 seconds ago, as the database writes it: UTC, without a zone.
      getDb().prepare("UPDATE questions SET asked_at = ? WHERE id = ?").run(new Date(Date.now() - 48_000).toISOString().slice(0, 19).replace("T", " "), asked.id);
      const row = getDb().prepare("SELECT * FROM questions WHERE id = ?").get(asked.id);
      recordApproval(row, { id: "asking-chat" }, true, false);
      recordApproval(row, { id: "asking-chat" }, true, true);
      recordApproval(row, { id: "asking-chat" }, false, false);
      recordApproval(question(), undefined, false, false);
    });
    const out = lines("approval");
    assert.equal(out.length, 4);
    assert.match(out[0], /^\[approval\] answered question=[a-z2-9]{4} tool=bash outcome=once waited_ms=48000 session=asking-chat$/);
    assert.match(out[1], / outcome=always /);
    assert.match(out[2], / outcome=denied /);
    assert.match(out[3], /^\[approval\] answered question=[a-z2-9]{4} outcome=answered waited_ms=\d+ session=asking-chat$/, "a question that was not about an action has no tool");
    assert.doesNotMatch(everything(), /Bearer|hunter2|curl|budget/);
  });
});

test("asking the primary user has a line for the question that was asked and one for the one that could not be", async () => {
  seen("tg:8812", "Alice");
  setRole("tg:8812", "colleague");
  createSession({ id: "colleague-chat", title: "c", workspace: home, executor: "host" });
  getDb().prepare("UPDATE sessions SET channel_slug = 'tg', channel_key = 'tg:chat:8812', last_person_key = 'tg:8812' WHERE id = 'colleague-chat'").run();
  setDefaultReportTo({ channel: "tg", target: "chat:1" });
  const failWith = { value: undefined };
  channelSupervisor.send = async () => {
    if (failWith.value) throw new Error(failWith.value);
    return "sent";
  };
  const tools = {};
  askPrimaryTool("colleague-chat")({ registerTool: (tool) => (tools[tool.name] = tool) });
  const ask = (params) => tools.ask_primary.execute("call-1", params);

  await atDebug(async () => {
    resetLogs();
    await ask({ question: "May I read the budget? password=hunter2hunter2", action: "cat budget.csv" });
    await ask({ question: "Which colour?" });
    failWith.value = "chat not found";
    await assert.rejects(ask({ question: "once more?", action: "cat other.csv" }), /Could not reach them/);
    const out = lines("approval");
    assert.equal(out.length, 3);
    assert.match(out[0], /^\[approval\] asked question=[a-z2-9]{4} tool=bash session=colleague-chat immediate=(true|false)$/);
    assert.match(out[1], /^\[approval\] asked question=[a-z2-9]{4} session=colleague-chat immediate=(true|false)$/, "a question for an opinion has no tool");
    assert.match(out[2], /^\[approval\] not delivered question=[a-z2-9]{4} tool=bash session=colleague-chat$/);
    assert.doesNotMatch(everything(), /hunter2|budget|cat /);
  });
});
