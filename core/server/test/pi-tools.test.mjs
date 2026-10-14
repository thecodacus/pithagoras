import test, { mock } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// The portal's inline tools, called as pi calls them. pi reads what the model sees from `content`
// and marks an error only when `execute` throws: a tool that answers with anything else says
// nothing, and every failure of it reads as success.

const home = inProcessHome("pithagoras-pi-tools-");

const { createSession, getDb, listRoutineSessions, setDefaultReportTo } = await import("../dist/db.js");
const { createAgent } = await import("../dist/agents.js");
const { channelSupervisor } = await import("../dist/channels/supervisor.js");
const { routineSupervisor } = await import("../dist/routines/supervisor.js");
const { routineTools } = await import("../dist/pi/routine-tools.js");
const { reportTool } = await import("../dist/pi/report-tool.js");
const { heartbeatTool } = await import("../dist/pi/heartbeat-tool.js");
const { askPrimaryTool } = await import("../dist/pi/ask-primary.js");
const { askQuestion, recordAnswer } = await import("../dist/questions.js");
const { NOTE_TOOL } = await import("../dist/pi/heartbeat-names.js");
const { seen, setRole } = await import("../dist/people.js");

/** The tools one factory registers, by name. */
const toolsOf = (factory) => {
  const tools = {};
  factory({ registerTool: (tool) => (tools[tool.name] = tool) });
  return tools;
};
/** What the model reads from a result, as pi builds it. */
const said = (result) => {
  assert.ok(Array.isArray(result.content), "a result has content, which is what pi hands the model");
  return result.content.map((part) => part.text).join("\n");
};
const run = (tool, params) => tool.execute("call-1", params);
const sends = [];
/** Whether each of them asked for a note in the conversation it lands in, by the same index. */
const notedFlags = [];
channelSupervisor.send = async (channel, target, text, _options, note) => {
  if (sends.failWith) throw new Error(sends.failWith);
  sends.push({ channel, target, text });
  notedFlags.push(note);
  return "sent";
};

test("the routine tools answer in the shape pi reads, and a failure throws", async () => {
  const tools = toolsOf(routineTools());
  assert.equal(said(await run(tools.routines_list, {})), "No routines are set up.");

  await assert.rejects(run(tools.routine_create, { name: "Backups", instructions: "check", schedule: "not a cron" }), /cron|field/i);
  await assert.rejects(run(tools.routine_create, { name: " ", instructions: "x", schedule: "@daily" }), /needs a name/);
  await assert.rejects(run(tools.routine_create, { name: "Both", instructions: "x", schedule: "@daily", runAt: "2031-01-01T00:00:00Z" }), /not both/);
  const created = said(await run(tools.routine_create, { name: "Backups", instructions: "check the backups", schedule: "@daily" }));
  assert.match(created, /^Created "Backups"\. Next run: /);

  const listed = said(await run(tools.routines_list, {}));
  assert.match(listed, /"slug": "backups"/);
  assert.match(listed, /check the backups/);

  await assert.rejects(run(tools.routine_update, { routine: "nothing" }), /No routine called "nothing"/);
  await assert.rejects(run(tools.routine_update, { routine: "backups" }), /Nothing to change/);
  assert.match(said(await run(tools.routine_update, { routine: "backups", enabled: false })), /^Updated "Backups"/);

  const row = getDb().prepare("SELECT * FROM routines WHERE slug = 'backups'").get();
  const real = routineSupervisor.run;
  try {
    routineSupervisor.run = async () => ({ ...row, last_status: "ok", last_output: "all green" });
    assert.equal(said(await run(tools.routine_run, { routine: "backups" })), "all green");
    routineSupervisor.run = async () => ({ ...row, last_status: "error", last_output: "disk full" });
    await assert.rejects(run(tools.routine_run, { routine: "backups" }), /It failed: disk full/);
    routineSupervisor.run = async () => {
      throw new Error('"Backups" is already running');
    };
    await assert.rejects(run(tools.routine_run, { routine: "backups" }), /already running/);
  } finally {
    routineSupervisor.run = real;
  }
});

test("a routine the agent makes under the name of a deleted one does not take up that one's conversation", async () => {
  const tools = toolsOf(routineTools());
  await run(tools.routine_create, { name: "Weekly digest", instructions: "the old plan", schedule: "@weekly" });
  const old = getDb().prepare("SELECT * FROM routines WHERE name = 'Weekly digest'").get();
  // A run of it, as one that ran leaves it behind. The routine is deleted, its runs stay.
  createSession({ id: "digest-run", title: "A run", workspace: home, executor: "host", kind: "routine", routine_slug: old.slug });
  getDb().prepare("DELETE FROM routines WHERE id = ?").run(old.id);

  await run(tools.routine_create, { name: "Weekly digest", instructions: "the new plan", schedule: "@weekly" });
  const again = getDb().prepare("SELECT * FROM routines WHERE name = 'Weekly digest'").get();
  assert.notEqual(again.slug, old.slug, "not the slug whose runs are still there");
  assert.deepEqual(listRoutineSessions(again.slug), [], "its first run is not made in the old routine's chat");
  assert.deepEqual(listRoutineSessions(old.slug).map((x) => x.id), ["digest-run"]);
});

test("report says whether it went out, and fails when it did not", async () => {
  const report = toolsOf(reportTool(null)).report;
  setDefaultReportTo(null);
  await assert.rejects(run(report, { message: "hello" }), /Nowhere to report to/);

  setDefaultReportTo({ channel: "tg", target: "chat:1" });
  await assert.rejects(run(report, { message: "  " }), /Nothing to send/);
  assert.equal(said(await run(report, { message: "found a problem" })), "Sent to tg.");
  assert.deepEqual(sends.at(-1), { channel: "tg", target: "chat:1", text: "found a problem" });

  sends.failWith = "chat not found";
  try {
    await assert.rejects(run(report, { message: "again" }), /Could not send: chat not found/);
  } finally {
    delete sends.failWith;
  }
});

test("activity_note says what became of the note, and an empty one is an error", async () => {
  const agent = createAgent({ name: "Scout" });
  const note = toolsOf(heartbeatTool(agent.id, "s1"))[NOTE_TOOL];
  await assert.rejects(run(note, { title: " ", detail: "x" }), /needs a title/);
  assert.equal(said(await run(note, { title: "Disk is filling", detail: "92% used" })), "Noted.");

  setDefaultReportTo(null);
  assert.match(said(await run(note, { title: "Urgent", detail: "now", urgent: true })), /There is no channel to message them through/);
  setDefaultReportTo({ channel: "tg", target: "chat:1" });
  assert.equal(said(await run(note, { title: "Urgent", detail: "now", urgent: true })), "Noted, and sent through tg.");
  assert.match(sends.at(-1).text, /^Scout: Urgent\n\nnow$/);
  // Kept as a note in the chat it lands in, wrapped there as data (security.md says so).
  assert.notEqual(notedFlags.at(-1), false, "an urgent note is a note: the look read outside content, and the chat it goes to has it wrapped");
  sends.failWith = "offline";
  try {
    assert.match(said(await run(note, { title: "Urgent", detail: "now", urgent: true })), /Noted, but the message could not be sent: offline/);
  } finally {
    delete sends.failWith;
  }
});

test("ask_primary says whether the question reached anybody, and names who asks by the platform's key", async () => {
  seen("tg:8812", "Alice (CTO)");
  setRole("tg:8812", "colleague");
  createSession({ id: "colleague-chat", title: "c", workspace: home, executor: "host" });
  getDb().prepare("UPDATE sessions SET channel_slug = 'tg', channel_key = 'tg:chat:8812', last_person_key = 'tg:8812' WHERE id = 'colleague-chat'").run();
  createSession({ id: "plain-chat", title: "p", workspace: home, executor: "host" });
  const ask = toolsOf(askPrimaryTool("colleague-chat")).ask_primary;

  setDefaultReportTo(null);
  await assert.rejects(run(ask, { question: "may I?" }), /no way to reach the primary user/);
  setDefaultReportTo({ channel: "tg", target: "chat:1" });
  await assert.rejects(run(ask, { question: " " }), /Nothing to ask/);
  await assert.rejects(run(toolsOf(askPrimaryTool("plain-chat")).ask_primary, { question: "may I?" }), /nowhere to send an answer back to/);

  const before = sends.length;
  const reply = said(await run(ask, { question: "May I read the budget?", action: "cat budget.csv" }));
  assert.match(reply, /^Asked\. Tell Alice \(CTO\) you have passed it on/);
  const message = sends.at(-1).text;
  assert.equal(sends.length, before + 1);
  assert.match(message, /^Alice \(CTO\) \(tg:8812\) is asking \(via tg\):/, "a name is whatever somebody called themselves; the key is who the platform says they are");
  assert.match(message, /Reply "#[a-z2-9]{4} approve"/);
  assert.equal(notedFlags.at(-1), false, "the asker's words are not kept as a note in the primary user's chat: it would taint it");

  sends.failWith = "chat not found";
  try {
    await assert.rejects(run(ask, { question: "once more?" }), /Could not reach them: chat not found/);
  } finally {
    delete sends.failWith;
  }
});

test("a question id is never one an earlier question had, answered or not", () => {
  // Four letters of 32 collide in about one of a million; made certain here.
  const draws = [0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5];
  const random = mock.method(Math, "random", () => draws.shift() ?? 0.99);
  try {
    const input = { sessionId: "s", personKey: "tg:1", personName: "A", channelSlug: "tg", channelKey: "chat:1", question: "?" };
    const first = askQuestion(input);
    assert.equal(first.id, "aaaa");
    recordAnswer(first.id, "yes");
    const second = askQuestion(input);
    assert.notEqual(second.id, "aaaa", "answered rows are kept, and the id is the primary key");
    assert.equal(second.id.length, 4);
  } finally {
    random.mock.restore();
  }
});
