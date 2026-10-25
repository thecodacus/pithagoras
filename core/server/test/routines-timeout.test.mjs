import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "./server-harness.mjs";

const home = inProcessHome("pithagoras-routines-timeout-");
// Set where the portal starts, as a run of three hours would ask for: read as the supervisor loads.
process.env.ROUTINE_RUN_TIMEOUT_MIN = "180";

const { default: express } = await import("express");
const { runTimeoutMs } = await import("../dist/routines/supervisor.js");
const { routinesRouter } = await import("../dist/api/routines.js");
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
