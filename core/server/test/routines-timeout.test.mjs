import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "./server-harness.mjs";

const home = inProcessHome("pithagoras-routines-timeout-");
// Set where the portal starts, as a run of three hours would ask for: read as the supervisor loads.
process.env.ROUTINE_RUN_TIMEOUT_MIN = "180";

const { default: express } = await import("express");
const { runLimitMs, defaultTimeoutMin, ENV_TIMEOUT_MIN } = await import("../dist/routines/supervisor.js");
const { envTimeoutMin, readTimeout } = await import("../dist/routines/timeout.js");
const { routinesRouter } = await import("../dist/api/routines.js");
const { routineTools } = await import("../dist/pi/routine-tools.js");
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
    call.status = res.status;
    return res.json();
  };
  try {
    await fn(call);
  } finally {
    server.close();
  }
}

test("a run is given the minutes ROUTINE_RUN_TIMEOUT_MIN says, not the hour", async () => {
  await withApi(async (call) => {
    const made = await call("POST", "/routines", { name: "Nightly build", schedule: "@daily", instructions: "x" });
    let given;
    sessions.ask = async (_id, _prompt, opts) => {
      given = opts.timeoutMs;
      return "done";
    };
    const after = await call("POST", `/routines/${made.id}/run`);
    assert.equal(after.lastStatus, "ok");
    assert.equal(given, 180 * 60_000);
  });
});

test("the variable is read by the rule a routine's own limit is read by, and what it refuses is named and leaves the hour", () => {
  assert.equal(ENV_TIMEOUT_MIN, 180, "as the portal started");
  const said = [];
  const read = (raw) => envTimeoutMin(raw, (problem) => said.push(problem));
  assert.equal(read(undefined), 60); // asked for nothing: nothing to say
  assert.equal(read(""), 60);
  assert.equal(read("  "), 60);
  assert.deepEqual(said, []);
  assert.equal(read("90"), 90);
  assert.equal(read(" 35791 "), 35791);
  assert.deepEqual(said, []);
  for (const bad of ["0", "-30", "soon", "2.5", "60min", "35792", "99999999999"]) {
    assert.equal(read(bad), 60, bad);
    assert.match(said.at(-1), new RegExp(`^ROUTINE_RUN_TIMEOUT_MIN=${JSON.stringify(bad)} is not a whole number of minutes from 1 to 35791; using 60$`), bad);
  }
  assert.equal(said.length, 7, "each named once");
  // The same rule, as the API and the tools read it.
  assert.deepEqual(readTimeout(45), { timeoutMin: 45 });
  assert.deepEqual(readTimeout(0), { timeoutMin: null });
  assert.ok("error" in readTimeout("45"));
});

test("the portal's default is what the Routines page stored, else what the portal started with, read as a run starts", async () => {
  await withApi(async (call) => {
    assert.deepEqual((await call("GET", "/routines")).timeoutDefault, { minutes: 180, stored: null, fallback: 180 });
    const made = await call("POST", "/routines", { name: "Takes the default", schedule: "@daily", instructions: "x" });
    let given;
    sessions.ask = async (_id, _prompt, opts) => {
      given = opts.timeoutMs;
      return "done";
    };
    const set = await call("PUT", "/routines/timeout-default", { minutes: 45 });
    assert.deepEqual(set, { timeoutDefault: { minutes: 45, stored: 45, fallback: 180 } });
    assert.deepEqual((await call("GET", "/routines")).timeoutDefault, { minutes: 45, stored: 45, fallback: 180 });
    assert.equal(defaultTimeoutMin(), 45);
    await call("POST", `/routines/${made.id}/run`);
    assert.equal(given, 45 * 60_000, "the next run has it, with no restart");
    // A routine's own limit wins over it.
    await call("PATCH", `/routines/${made.id}`, { timeoutMin: 20 });
    await call("POST", `/routines/${made.id}/run`);
    assert.equal(given, 20 * 60_000);
    await call("PATCH", `/routines/${made.id}`, { timeoutMin: null });
    // Cleared, what the portal started with stands again: null and 0 say so alike.
    for (const back of [null, 0]) {
      await call("PUT", "/routines/timeout-default", { minutes: 30 });
      assert.deepEqual(await call("PUT", "/routines/timeout-default", { minutes: back }), { timeoutDefault: { minutes: 180, stored: null, fallback: 180 } });
      await call("POST", `/routines/${made.id}/run`);
      assert.equal(given, 180 * 60_000);
    }
    // What is not a whole number of minutes is refused, and nothing changes.
    for (const bad of [-5, 2.5, "45", 35_792, true]) {
      const answer = await call("PUT", "/routines/timeout-default", { minutes: bad });
      assert.deepEqual([call.status, answer.error], [400, "minutes must be a whole number of minutes from 1 to 35791, or 0 for the portal's default"], JSON.stringify(bad));
    }
    assert.equal(defaultTimeoutMin(), 180);
  });
});

const tools = {};
routineTools()({ registerTool: (tool) => (tools[tool.name] = tool) });
const viaTool = async (name, params) => {
  try {
    return await tools[name].execute("call", params);
  } catch (e) {
    return { error: e.message };
  }
};
const row = (slug) => getDb().prepare("SELECT * FROM routines WHERE slug = ?").get(slug);

test("a routine with a limit of its own gives its runs those minutes; without one, the portal's default", async () => {
  await withApi(async (call) => {
    const list = await call("GET", "/routines");
    assert.equal(list.timeoutDefault.minutes, 180, "the default, for the page to say");
    const made = await call("POST", "/routines", { name: "Long benchmark", schedule: "@daily", instructions: "x", timeoutMin: 240 });
    assert.equal(made.timeoutMin, 240);
    let given;
    sessions.ask = async (_id, _prompt, opts) => {
      given = opts.timeoutMs;
      return "done";
    };
    await call("POST", `/routines/${made.id}/run`);
    assert.equal(given, 240 * 60_000);
    // Cleared, back to the portal's default: 0 and null say so alike.
    for (const back of [0, null]) {
      await call("PATCH", `/routines/${made.id}`, { timeoutMin: 300 });
      const cleared = await call("PATCH", `/routines/${made.id}`, { timeoutMin: back });
      assert.equal(cleared.timeoutMin, null);
      await call("POST", `/routines/${made.id}/run`);
      assert.equal(given, 180 * 60_000);
    }
    // A change that says nothing of it leaves it.
    await call("PATCH", `/routines/${made.id}`, { timeoutMin: 90 });
    const renamed = await call("PATCH", `/routines/${made.id}`, { name: "Longer benchmark" });
    assert.equal(renamed.timeoutMin, 90);
  });
});

test("the limit a run gets: the routine's own minutes, else the portal's default, never past what a timer holds", () => {
  assert.equal(runLimitMs({ timeout_min: null }), 180 * 60_000);
  assert.equal(runLimitMs({ timeout_min: 0 }), 180 * 60_000);
  assert.equal(runLimitMs({ timeout_min: 45 }), 45 * 60_000);
  assert.equal(runLimitMs({ timeout_min: 99_999_999 }), 35_791 * 60_000, "a hand-edited row past what a timer holds");
});

test("a limit that is not a whole number of minutes is refused, by the API and by the agent's tool alike, and nothing is saved", async () => {
  await withApi(async (call) => {
    const made = await call("POST", "/routines", { name: "Checked", schedule: "@daily", instructions: "x", timeoutMin: 30 });
    const why = "timeoutMin must be a whole number of minutes from 1 to 35791, or 0 for the portal's default";
    for (const bad of [-5, 2.5, "soon", "60", 35_792, true]) {
      const answer = await call("PATCH", `/routines/${made.id}`, { timeoutMin: bad });
      assert.deepEqual([call.status, answer.error], [400, why], JSON.stringify(bad));
      const refusedNew = await call("POST", "/routines", { name: "Never", schedule: "@daily", instructions: "x", timeoutMin: bad });
      assert.equal(refusedNew.error, why, JSON.stringify(bad));
      assert.equal((await viaTool("routine_update", { routine: "checked", timeoutMin: bad })).error, why, JSON.stringify(bad));
      assert.equal((await viaTool("routine_create", { name: "Never either", schedule: "@daily", instructions: "x", timeoutMin: bad })).error, why, JSON.stringify(bad));
    }
    assert.equal(row("checked").timeout_min, 30, "kept as it was");
    assert.equal(row("never"), undefined);
    assert.equal(row("never-either"), undefined);
    // And set through the tool as through the API.
    await viaTool("routine_update", { routine: "checked", timeoutMin: 120 });
    assert.equal(row("checked").timeout_min, 120);
    await viaTool("routine_create", { name: "By the agent", schedule: "@daily", instructions: "x", timeoutMin: 150 });
    assert.equal(row("by-the-agent").timeout_min, 150);
    await viaTool("routine_update", { routine: "by-the-agent", timeoutMin: 0 });
    assert.equal(row("by-the-agent").timeout_min, null);
  });
});
