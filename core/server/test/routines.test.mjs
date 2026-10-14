import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

const home = inProcessHome("pithagoras-routines-");

const { default: express } = await import("express");
const { parseCron, nextRun } = await import("../dist/routines/cron.js");
const { oneOffDone, routineSupervisor } = await import("../dist/routines/supervisor.js");
const { routinesIn, routinesRouter, switchOffRoutines } = await import("../dist/api/routines.js");
const { getDb } = await import("../dist/db.js");
const { sessions } = await import("../dist/session-manager.js");

test("cron takes 7 for Sunday, and day and month names", () => {
  // Sunday 2026-09-27, 09:00 local.
  const saturday = new Date(2026, 8, 26, 12, 0);
  for (const expression of ["0 9 * * 7", "0 9 * * 0", "0 9 * * SUN", "0 9 * sep sun"]) {
    const next = nextRun(parseCron(expression), saturday);
    assert.equal(next?.getDay(), 0, expression);
    assert.equal(next?.getHours(), 9, expression);
  }
  // A weekday range written with names.
  const monday = nextRun(parseCron("30 8 * * mon-fri"), saturday);
  assert.equal(monday?.getDay(), 1);
  // "*" still counts as any day, 7 folded in or not.
  assert.equal(parseCron("0 0 * * *").fields[4].values.size, 7);
  assert.throws(() => parseCron("0 9 * * fun"), /day of week/);
  assert.throws(() => parseCron("0 9 * * 8"), /out of range/);
});

test("a one-off is done only by a run at or after its moment", () => {
  const row = { schedule: "", run_at: "2026-10-01T09:00:00.000Z" };
  assert.equal(oneOffDone({ ...row, last_run: null }), false);
  assert.equal(oneOffDone({ ...row, last_run: "2026-09-22T10:00:00.000Z" }), false);
  assert.equal(oneOffDone({ ...row, last_run: "2026-10-01T09:00:10.000Z" }), true);
  assert.equal(oneOffDone({ schedule: "0 9 * * *", run_at: null, last_run: "2026-10-01T09:00:10.000Z" }), false);
  // A moment that cannot be read: any run is its run, or it would never stop.
  assert.equal(oneOffDone({ schedule: "", run_at: "next tuesday", last_run: "2026-09-22T10:00:00.000Z" }), true);
  assert.equal(oneOffDone({ schedule: "", run_at: "next tuesday", last_run: null }), false);
});

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

test("running a future one-off by hand leaves its moment in place", async () => {
  sessions.ask = async () => "tried it";
  await withApi(async (call) => {
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const made = await call("POST", "/routines", { name: "Later", runAt: at, instructions: "x" });
    const after = await call("POST", `/routines/${made.id}/run`);
    assert.equal(after.lastOutput, "tried it");
    assert.equal(after.enabled, true);
    assert.equal(after.done, false);
    assert.equal(after.nextRun, at);
  });
});

test("a routine runs in Home or in the project it is given, with a session for each place", async () => {
  const project = path.join(process.env.WORKSPACE_ROOT, "site");
  mkdirSync(project, { recursive: true });
  const asked = [];
  sessions.ask = async (id) => {
    asked.push(getDb().prepare("SELECT workspace FROM sessions WHERE id = ?").get(id).workspace);
    return "ok";
  };
  await withApi(async (call) => {
    const made = await call("POST", "/routines", { name: "Build", schedule: "@daily", instructions: "x" });
    assert.equal(made.workspace, null, "Home unless told otherwise");
    await call("POST", `/routines/${made.id}/run`);

    const moved = await call("PATCH", `/routines/${made.id}`, { workspace: "site" });
    assert.equal(moved.workspace, project, "a bare name is a project under the root");
    await call("POST", `/routines/${made.id}/run`);

    const back = await call("PATCH", `/routines/${made.id}`, { workspace: null });
    assert.equal(back.workspace, null);
    await call("POST", `/routines/${made.id}/run`);

    assert.deepEqual(asked, [process.env.AGENT_HOME, project, process.env.AGENT_HOME]);
    const own = getDb().prepare("SELECT DISTINCT workspace FROM sessions WHERE routine_slug = ?").all(made.slug);
    assert.equal(own.length, 2, "back in Home, it picks up its Home session again");

    assert.match((await call("PATCH", `/routines/${made.id}`, { workspace: "/etc" })).error, /inside the workspace root/);
    assert.match((await call("POST", "/routines", { name: "Nowhere", schedule: "@daily", workspace: "missing" })).error, /does not exist/);

    // A project that has gone fails the run, rather than doing the work in Home.
    const gone = path.join(process.env.WORKSPACE_ROOT, "gone");
    mkdirSync(gone);
    const there = await call("POST", "/routines", { name: "Gone", schedule: "@daily", instructions: "x", workspace: gone });
    const { rmSync } = await import("node:fs");
    rmSync(gone, { recursive: true });
    const failed = await call("POST", `/routines/${there.id}/run`);
    assert.equal(failed.lastStatus, "error");
    assert.match(failed.lastOutput, /cannot be used/);
  });
});

test("a routine whose project has gone still saves its other changes, and says the place is gone", async () => {
  const project = path.join(process.env.WORKSPACE_ROOT, "left");
  mkdirSync(path.join(project, "docs"), { recursive: true });
  writeFileSync(path.join(project, "notes.txt"), "x");
  await withApi(async (call) => {
    const made = await call("POST", "/routines", { name: "Left", schedule: "@daily", instructions: "x", workspace: "left/docs" });
    assert.equal(made.workspace, path.join(project, "docs"), "a folder in a project is a place too");
    assert.equal(made.workspaceProblem, null, "and one that can be used");

    assert.match((await call("PATCH", `/routines/${made.id}`, { workspace: "left/notes.txt" })).error, /not a directory/);
    assert.equal((await call("PATCH", `/routines/${made.id}`, { workspace: " Home " })).workspace, null, "read as the agent's tool reads it");

    await call("PATCH", `/routines/${made.id}`, { workspace: project });
    rmSync(project, { recursive: true });
    const shown = (await call("GET", "/routines")).routines.find((r) => r.id === made.id);
    assert.match(shown.workspaceProblem, /does not exist/);
    // The page sends the place it already has along with the change.
    const saved = await call("PATCH", `/routines/${made.id}`, { instructions: "y", workspace: project });
    assert.equal(saved.instructions, "y");
    assert.equal(saved.workspace, project);
    assert.match((await call("PATCH", `/routines/${made.id}`, { workspace: "missing" })).error, /does not exist/, "a new place is still checked");
  });
});

test("deleting a project switches off the routines that run in it, and leaves their sessions", async () => {
  const project = path.join(process.env.WORKSPACE_ROOT, "doomed");
  mkdirSync(path.join(project, "sub"), { recursive: true });
  mkdirSync(path.join(process.env.WORKSPACE_ROOT, "doomed-too"), { recursive: true });
  symlinkSync(project, path.join(process.env.WORKSPACE_ROOT, "alias"));
  sessions.ask = async () => "ok";
  await withApi(async (call) => {
    const top = await call("POST", "/routines", { name: "Top", schedule: "@daily", instructions: "x", workspace: "doomed" });
    const below = await call("POST", "/routines", { name: "Below", schedule: "@daily", instructions: "x", workspace: "doomed/sub" });
    const linked = await call("POST", "/routines", { name: "Linked", schedule: "@daily", instructions: "x", workspace: "alias" });
    const beside = await call("POST", "/routines", { name: "Beside", schedule: "@daily", instructions: "x", workspace: "doomed-too" });
    const off = await call("POST", "/routines", { name: "Off", schedule: "@daily", instructions: "x", workspace: "doomed" });
    await call("PATCH", `/routines/${off.id}`, { enabled: false });
    await call("POST", `/routines/${top.id}/run`);

    // Found while the folder is there, since a link into it cannot be followed after.
    const found = routinesIn(project);
    assert.deepEqual(found.map((r) => r.name), ["Below", "Linked", "Off", "Top"], "a link to the project is in it too");

    // While the folder goes, none of them may start a run, even by hand. Two
    // deletes at once each hold them: the first to finish leaves the other's.
    const first = routineSupervisor.hold(found.map((r) => r.slug));
    const second = routineSupervisor.hold(found.map((r) => r.slug));
    assert.match((await call("POST", `/routines/${top.id}/run`)).error, /being deleted/);
    first();
    first();
    assert.match((await call("POST", `/routines/${top.id}/run`)).error, /being deleted/, "released once, however often called");
    second();

    rmSync(project, { recursive: true });
    assert.deepEqual(switchOffRoutines(found), ["Below", "Linked", "Top"], "one already off is not named");
    const all = (await call("GET", "/routines")).routines;
    const on = (id) => all.find((r) => r.id === id).enabled;
    assert.equal(on(top.id), false);
    assert.equal(on(below.id), false);
    assert.equal(on(linked.id), false);
    assert.equal(on(beside.id), true, "a folder that only starts with the same name is another project");
    assert.equal((await call("GET", `/routines/${top.id}/sessions`)).sessions.length, 1, "a run held back makes no session, and the one before keeps its record");
  });
});

test("giving a finished one-off a new time switches it back on", async () => {
  sessions.ask = async () => "did it";
  await withApi(async (call) => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const made = await call("POST", "/routines", { name: "Once", runAt: past, instructions: "x" });
    const ran = await call("POST", `/routines/${made.id}/run`);
    assert.equal(ran.lastOutput, "did it");
    assert.equal(ran.done, true);
    assert.equal(ran.enabled, false);

    const again = new Date(Date.now() + 86_400_000).toISOString();
    const rearmed = await call("PATCH", `/routines/${made.id}`, { schedule: "", runAt: again });
    assert.equal(rearmed.enabled, true);
    assert.equal(rearmed.done, false);
    assert.equal(rearmed.nextRun, again);
  });
  routineSupervisor.stop();
  getDb().close?.();
});
