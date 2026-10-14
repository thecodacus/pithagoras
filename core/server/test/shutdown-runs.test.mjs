import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// What a routine's run and an agent's look are recorded as when the run ends
// because the portal is stopping, or because it ran out of time: a pi that
// settles when it is aborted, as pi does, and the real supervisors around it.

inProcessHome("pithagoras-shutdown-runs-");

const { getDb, getSession } = await import("../dist/db.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { sessions } = await import("../dist/session-manager.js");
const { routineSupervisor } = await import("../dist/routines/supervisor.js");
const { heartbeat, WATCH_FILE } = await import("../dist/heartbeat.js");
const { createAgent, getAgent } = await import("../dist/agents.js");

test.after(() => getDb().close());

/** A pi whose run goes on until it is aborted, or until the test says it ended. */
class FakePi extends EventEmitter {
  running = true;
  disposed = false;
  idle = true;
  aborted = 0;
  constructor(opts) {
    super();
    this.sessionFile = path.join(opts.sessionDir, "conversation.jsonl");
  }
  isIdle() { return this.idle; }
  dialogsOpen() { return 0; }
  async getTools() { return []; }
  async getCommands() { return []; }
  async getState() { return { model: { id: "m", name: "M", provider: "p", input: ["text"] }, thinkingLevel: "off" }; }
  async prompt() {
    this.idle = false;
    this.emit("event", { type: "agent_start" });
    return { outcome: "started" };
  }
  /** The run ends, with what the agent had written of its answer. */
  settle(text) {
    this.idle = true;
    if (text) this.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
    this.emit("event", { type: "message_end", message: { role: "assistant", stopReason: text ? "stop" : "aborted", content: text ? [{ type: "text", text }] : [] } });
    this.emit("event", { type: "agent_end" });
    this.emit("event", { type: "agent_settled" });
  }
  clearQueue() { return []; }
  async abort() { this.aborted++; this.settle(""); }
  dispose() { this.disposed = true; this.emit("exit", { code: 0, signal: null }); }
}

const launched = [];
SdkPiClient.create = async (opts) => {
  const pi = new FakePi(opts);
  launched.push(pi);
  return pi;
};

let count = 0;
/** A routine, by the API's own insert: clean session or not, and a one-off or a recurring one. */
function routine({ fresh = false, once = false } = {}) {
  const id = `r${++count}`;
  getDb()
    .prepare("INSERT INTO routines (id, slug, name, schedule, run_at, instructions, fresh_session) VALUES (?, ?, ?, ?, ?, 'x', ?)")
    .run(id, `routine-${count}`, "Look around", once ? "" : "0 9 * * *", once ? new Date(Date.now() - 60_000).toISOString() : null, fresh ? 1 : 0);
  return getDb().prepare("SELECT * FROM routines WHERE id = ?").get(id);
}
const row = (id) => getDb().prepare("SELECT * FROM routines WHERE id = ?").get(id);
const sessionOf = (slug) => getDb().prepare("SELECT * FROM sessions WHERE routine_slug = ?").get(slug);
const working = (made) => {
  const chat = sessionOf(made.slug);
  return chat !== undefined && getSession(chat.id).status === "running";
};
async function until(check, what = "the server to catch up") {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("a run in a clean session that ends by itself is not aborted, and its pi is let go", async () => {
  const made = routine({ fresh: true });
  const run = routineSupervisor.run(made, "manual");
  await until(() => launched.length > 0 && launched.at(-1).idle === false, "the run to start");
  const pi = launched.at(-1);
  pi.settle("All done");
  const after = await run;

  assert.deepEqual([after.last_status, after.last_output], ["ok", "All done"]);
  assert.equal(pi.aborted, 0, "nothing to stop: it had ended");
  assert.equal(pi.disposed, true);
});

test("a clean-session run that runs out of time is stopped with its pi, and leaves its chat not running", async () => {
  const ask = sessions.ask;
  sessions.ask = (id, message, opts) => ask.call(sessions, id, message, { ...opts, timeoutMs: 100 });
  try {
    const made = routine({ fresh: true });
    const after = await routineSupervisor.run(made, "manual");
    const pi = launched.at(-1);

    assert.equal(after.last_status, "error");
    assert.match(after.last_output, /did not finish/);
    assert.equal(pi.aborted, 1, "the run it timed out on is ended, not left under a pi that is gone");
    assert.equal(pi.disposed, true);
    const chat = sessionOf(made.slug);
    assert.equal(chat.status, "idle", "it is not left showing a run nothing will settle");
    assert.equal(sessions.anyBusy(), false, "so nothing that waits for the model waits for it for good");
  } finally {
    sessions.ask = ask;
  }
});

/** What the agent's tool call starts in the background, as bg_run of pi-background-tasks does: marked, in the folder, in a session of its own. */
const startJob = (folder) => spawn("sleep", ["60"], { cwd: folder, detached: true, stdio: "ignore", env: { ...process.env, PITHAGORAS_AGENT: "1" } });
const endJob = (job) => {
  try {
    process.kill(-job.pid, "SIGKILL");
  } catch {
    // Gone already.
  }
};

test("a clean-session run that started a job is not let go while the job runs, and is once it is over", { skip: process.platform !== "linux" }, async () => {
  const made = routine({ fresh: true });
  const run = routineSupervisor.run(made, "manual");
  await until(() => launched.length > 0 && launched.at(-1).idle === false, "the run to start");
  const pi = launched.at(-1);
  let job;
  try {
    // The call that starts it, and the agent's last word: "Started it in the background."
    pi.emit("event", { type: "tool_execution_start", toolCallId: "bg-1", toolName: "bg_run" });
    job = startJob(sessionOf(made.slug).workspace);
    await until(() => job.pid, "the job to start");
    pi.emit("event", { type: "tool_execution_end", toolCallId: "bg-1", toolName: "bg_run" });
    pi.settle("Started the backup in the background.");
    const after = await run;

    assert.deepEqual([after.last_status, after.last_output], ["ok", "Started the backup in the background."]);
    assert.equal(pi.disposed, false, "its extensions end the job when they are told, and nobody would hear of it");

    endJob(job);
    const chat = sessionOf(made.slug);
    sessions.activity.set(chat.id, Date.now() - 60 * 60_000);
    // The list of what runs is read at most once a second, and a job's end is seen when it is read.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.deepEqual(await sessions.reapIdle(), [chat.id], "the idle reaper takes it once the job is over");
    assert.equal(pi.disposed, true);
  } finally {
    if (job) endJob(job);
  }
});

test("a clean-session run that ran out of time with a job going is ended, and its pi is kept for the job", { skip: process.platform !== "linux" }, async () => {
  const ask = sessions.ask;
  sessions.ask = (id, message, opts) => ask.call(sessions, id, message, { ...opts, timeoutMs: 300 });
  const made = routine({ fresh: true });
  let job;
  try {
    const run = routineSupervisor.run(made, "manual");
    await until(() => launched.length > 0 && launched.at(-1).idle === false, "the run to start");
    const pi = launched.at(-1);
    pi.emit("event", { type: "tool_execution_start", toolCallId: "bg-1", toolName: "bg_run" });
    job = startJob(sessionOf(made.slug).workspace);
    await until(() => job.pid, "the job to start");
    pi.emit("event", { type: "tool_execution_end", toolCallId: "bg-1", toolName: "bg_run" });
    const after = await run;

    assert.equal(after.last_status, "error");
    assert.equal(pi.aborted, 1, "the run it timed out on is ended all the same");
    assert.equal(sessionOf(made.slug).status, "idle");
    assert.equal(pi.disposed, false);
  } finally {
    sessions.ask = ask;
    if (job) endJob(job);
  }
});

test("a routine's run that a stop of the portal aborts is interrupted, as one a crash cut off is, and a one-off is switched off", async () => {
  const recurring = routine();
  const once = routine({ once: true });
  const started = launched.length;
  const runs = [routineSupervisor.run(recurring, "schedule"), routineSupervisor.run(once, "schedule")];
  await until(() => launched.slice(started).filter((pi) => pi.idle === false).length === 2, "both runs to start");
  assert.ok(working(recurring) && working(once));
  assert.equal(row(recurring.id).last_status, "running");

  try {
    await sessions.shutdown();
    await Promise.all(runs);
  } finally {
    sessions.closing = false;
  }

  for (const made of [recurring, once]) {
    const after = row(made.id);
    assert.equal(after.last_status, "interrupted");
    assert.equal(after.last_output, "The portal restarted during this run");
  }
  assert.equal(row(once.id).enabled, 0, "a one-off is not run again by itself");
  assert.equal(row(recurring.id).enabled, 1);

  // And the next start leaves it as it is, rather than finding "ok".
  routineSupervisor.start();
  routineSupervisor.stop();
  assert.equal(row(recurring.id).last_status, "interrupted");
  assert.equal(row(recurring.id).last_output, "The portal restarted during this run");
});

test("a look that a stop of the portal aborts is shown as interrupted, not as one that found nothing", async () => {
  const agent = createAgent({ name: "Watcher" });
  writeFileSync(path.join(agent.home, WATCH_FILE), "The open PRs on the repo.\n");
  const started = launched.length;
  const look = heartbeat.run(getAgent(agent.id), "manual");
  await until(() => launched.length > started && launched.at(-1).idle === false, "the look to start");

  try {
    await sessions.shutdown();
    await look;
  } finally {
    sessions.closing = false;
  }

  assert.equal(getAgent(agent.id).heartbeat_status, "Interrupted by a restart");
});

test("a routine's run that is stopped in its chat is recorded as stopped, with what it had written, and a one-off is switched off", async () => {
  const recurring = routine();
  const once = routine({ once: true });
  const started = launched.length;
  const runs = [routineSupervisor.run(recurring, "schedule"), routineSupervisor.run(once, "schedule")];
  await until(() => launched.slice(started).filter((pi) => pi.idle === false).length === 2, "both runs to start");
  launched.at(-1).emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Half an answer" } });

  // What Stop in the chat does, to each run's session.
  for (const made of [recurring, once]) await sessions.abort(sessionOf(made.slug).id);
  await Promise.all(runs);

  for (const made of [recurring, once]) {
    const after = row(made.id);
    assert.equal(after.last_status, "stopped", "it was cut off, whatever pi made of the abort");
    assert.match(after.last_output, /^Stopped before it finished\./);
  }
  assert.match(row(once.id).last_output, /Half an answer$/, "what the agent had written stays readable");
  assert.equal(row(once.id).enabled, 0, "a one-off is not run again by itself");
  assert.equal(row(recurring.id).enabled, 1);
});

test("a look that is stopped in its chat says so, not that it found nothing", async () => {
  const agent = createAgent({ name: "Stopped Watcher" });
  writeFileSync(path.join(agent.home, WATCH_FILE), "The open PRs on the repo.\n");
  const started = launched.length;
  const look = heartbeat.run(getAgent(agent.id), "manual");
  await until(() => launched.length > started && launched.at(-1).idle === false, "the look to start");
  const chat = getDb().prepare("SELECT id FROM sessions WHERE kind = 'heartbeat' AND workspace = ?").get(agent.home);
  await sessions.abort(chat.id);
  assert.equal((await look).heartbeat_status, "Stopped");
});

test("a look that ends by itself says what it found", async () => {
  const agent = createAgent({ name: "Scout" });
  writeFileSync(path.join(agent.home, WATCH_FILE), "The open PRs on the repo.\n");
  const started = launched.length;
  const look = heartbeat.run(getAgent(agent.id), "manual");
  await until(() => launched.length > started && launched.at(-1).idle === false, "the look to start");
  assert.equal(getAgent(agent.id).heartbeat_status, "Looking");
  launched.at(-1).settle("Nothing new.");
  assert.equal((await look).heartbeat_status, "Nothing new");
});
