import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "./server-harness.mjs";

const home = inProcessHome("pithagoras-routines-timeout-");
// Set where the portal starts, as a run of three hours would ask for: read as the supervisor loads.
process.env.ROUTINE_RUN_TIMEOUT_MIN = "180";

const { default: express } = await import("express");
const { runTimeoutMs, runLimitMs } = await import("../dist/routines/supervisor.js");
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

test("the limit as said keeps its edges: minutes above zero, or the hour", () => {
  const hour = 60 * 60_000;
  assert.equal(runTimeoutMs(undefined), hour); // asked for nothing
  assert.equal(runTimeoutMs(""), hour);
  assert.equal(runTimeoutMs("0"), hour); // no run at all is no limit
  assert.equal(runTimeoutMs("-30"), hour);
  assert.equal(runTimeoutMs("soon"), hour);
  assert.equal(runTimeoutMs("90"), 90 * 60_000);
  assert.equal(runTimeoutMs("2.5"), 150_000); // half a minute is still a wait
  assert.equal(runTimeoutMs("99999999999"), 2_147_483_647); // past what a timer may hold
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
    assert.equal(list.timeoutDefaultMin, 180, "the default, for the page to say");
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
  assert.equal(runLimitMs({ timeout_min: 99_999_999 }), 2_147_483_647);
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
