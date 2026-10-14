import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

const home = inProcessHome("pithagoras-routines-restart-");

const { default: express } = await import("express");
const { routineSupervisor } = await import("../dist/routines/supervisor.js");
const { routinesRouter } = await import("../dist/api/routines.js");
const { getDb } = await import("../dist/db.js");
const { sessions } = await import("../dist/session-manager.js");

async function withApi(fn) {
  const app = express();
  app.use(express.json());
  app.use("/api", routinesRouter());
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body && JSON.stringify(body),
    });
    return res.json();
  };
  try {
    await fn(call);
  } finally {
    server.close();
  }
}

const row = (id) => getDb().prepare("SELECT * FROM routines WHERE id = ?").get(id);

test("a one-off moved to a new time while it runs is not switched off by that run ending", async () => {
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
  await withApi(async (call) => {
    const made = await call("POST", "/routines", { name: "Reminder", runAt: new Date(Date.now() - 60_000).toISOString(), instructions: "x" });
    // Moved while its run is under way, the way a person or the agent would.
    sessions.ask = async () => {
      await call("PATCH", `/routines/${made.id}`, { schedule: "", runAt: tomorrow });
      return "done";
    };
    const after = await call("POST", `/routines/${made.id}/run`);
    assert.equal(after.enabled, true, "it was given a new moment, which is still to come");
    assert.equal(after.done, false);
    assert.equal(after.nextRun, tomorrow);
    assert.equal(row(made.id).run_at, tomorrow);

    // One that is not moved still ends switched off, as it always did.
    const plain = await call("POST", "/routines", { name: "Plain", runAt: new Date(Date.now() - 60_000).toISOString(), instructions: "x" });
    sessions.ask = async () => "done";
    const ran = await call("POST", `/routines/${plain.id}/run`);
    assert.equal(ran.enabled, false);
    assert.equal(ran.done, true);
  });
});

test("a run a restart cut off is no longer shown as running, and a one-off is not counted as done", async () => {
  const past = new Date(Date.now() - 3_600_000).toISOString();
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const lastRun = new Date(Date.now() - 600_000).toISOString();
  await withApi(async (call) => {
    const daily = await call("POST", "/routines", { name: "Daily", schedule: "@daily", instructions: "x" });
    const once = await call("POST", "/routines", { name: "Quarterly numbers", runAt: past, instructions: "send them" });
    const tried = await call("POST", "/routines", { name: "Tried early", runAt: future, instructions: "x" });
    const fine = await call("POST", "/routines", { name: "Fine", schedule: "@daily", instructions: "x" });
    const mark = getDb().prepare("UPDATE routines SET last_run = ?, last_status = ? WHERE id = ?");
    mark.run(lastRun, "running", daily.id);
    mark.run(lastRun, "running", once.id);
    // A run by hand ahead of its moment: a try, with the moment still to come.
    mark.run(new Date(Date.now() - 60_000).toISOString(), "running", tried.id);
    mark.run(lastRun, "ok", fine.id);

    routineSupervisor.start();
    routineSupervisor.stop();

    const list = Object.fromEntries((await call("GET", "/routines")).routines.map((r) => [r.name, r]));
    assert.equal(list.Daily.lastStatus, "interrupted");
    assert.match(list.Daily.lastOutput, /portal restarted during this run/);
    assert.equal(list.Daily.enabled, true, "a recurring one simply waits for its next slot");

    assert.equal(list["Quarterly numbers"].lastStatus, "interrupted");
    assert.equal(list["Quarterly numbers"].done, false, "it did not finish, so it is not shown as having run");
    assert.equal(list["Quarterly numbers"].enabled, false, "and it is not run again behind the person's back");
    assert.equal(list["Quarterly numbers"].nextRun, null);

    assert.equal(list["Tried early"].lastStatus, "interrupted");
    assert.equal(list["Tried early"].enabled, true, "its moment is still to come");
    assert.equal(list["Tried early"].nextRun, future);

    assert.equal(list.Fine.lastStatus, "ok");
    assert.equal(list.Fine.lastOutput, null);

    // Given a new time, the cut-off one-off is armed again.
    const again = await call("PATCH", `/routines/${once.id}`, { schedule: "", runAt: future });
    assert.equal(again.enabled, true);
    assert.equal(again.lastStatus, null);
    assert.equal(again.nextRun, future);
  });
});

test("a run stopped in its chat is not an ok one, and a one-off it stopped is not counted as done", async () => {
  const past = new Date(Date.now() - 3_600_000).toISOString();
  await withApi(async (call) => {
    const daily = await call("POST", "/routines", { name: "Stoppable", schedule: "@daily", instructions: "x" });
    const once = await call("POST", "/routines", { name: "Stoppable once", runAt: past, instructions: "x" });
    // What ask does for a run somebody pressed Stop in: tells the caller, and hands back what was written.
    sessions.ask = async (_id, _message, opts) => {
      opts.onStopped();
      return "Half of the answer";
    };
    const stopped = await call("POST", `/routines/${daily.id}/run`);
    assert.equal(stopped.lastStatus, "stopped");
    assert.equal(stopped.lastOutput, "Stopped before it finished.\n\nHalf of the answer");
    assert.equal(stopped.enabled, true, "a recurring one carries on with its next slot");

    const cut = await call("POST", `/routines/${once.id}/run`);
    assert.equal(cut.lastStatus, "stopped");
    assert.equal(cut.done, false, "it did not finish, so it is not shown as having run");
    assert.equal(cut.enabled, false, "and it is not run again behind the person's back");
  });
});

test("refreshing the schedule of one routine leaves the others as they are", async () => {
  await withApi(async (call) => {
    const a = await call("POST", "/routines", { name: "A", schedule: "@daily", instructions: "x" });
    const b = await call("POST", "/routines", { name: "B", schedule: "@daily", instructions: "x" });
    const set = getDb().prepare("UPDATE routines SET next_run = 'stale' WHERE id = ?");
    set.run(a.id);
    set.run(b.id);
    routineSupervisor.refreshSchedules([a.id]);
    assert.notEqual(row(a.id).next_run, "stale");
    assert.equal(row(b.id).next_run, "stale");
    routineSupervisor.refreshSchedules();
    assert.notEqual(row(b.id).next_run, "stale", "and without a list, every one");
  });
  getDb().close?.();
});
