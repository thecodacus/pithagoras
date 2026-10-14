import { test, before } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import express from "express";
import { freePort, inProcessHome, serverEnv, startServer, testHome } from "./server-harness.mjs";

/**
 * Restarting the portal from its Settings (issue #188): who may ask, what a portal with nothing to start it again
 * answers, and the status the real portal ends with, which is what the supervisor starts it from.
 */
const home = inProcessHome("pithagoras-restart-route-");
const { restartRouter } = await import("../dist/api/restart.js");
const { RESTART_EXIT, restartSupport } = await import("../dist/restart.js");
const { closeConnections } = await import("../dist/close-connections.js");

const PASSWORD = "a password long enough";

// --- the whole server ---

let base;
let child;
let log;
before(async () => {
  // PORTAL_UPDATE_RESTART=exit: run by something that restarts it, as a unit with Restart=on-failure or a container is.
  ({ base, child, log } = await startServer(serverEnv(home, await freePort(), { PORTAL_PASSWORD: PASSWORD, PORTAL_ALLOW_NO_PASSWORD: "", PORTAL_UPDATE_RESTART: "exit", PORTAL_SECRET: "" })));
});
const login = async () => (await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) })).headers.getSetCookie()[0].split(";")[0];
const send = async (cookie, url, method = "GET", body) => {
  const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test("anyone who is not signed in is turned away, and the portal keeps running", async () => {
  for (const [url, method] of [["/api/restart", "GET"], ["/api/restart", "POST"]]) {
    const res = await send(undefined, url, method, method === "POST" ? { confirm: true } : undefined);
    assert.equal(res.status, 401, `${method} ${url}`);
  }
  assert.equal((await send("pi_portal_auth=1.forged", "/api/restart", "POST", { confirm: true })).status, 401);
  assert.equal(child.exitCode, null);
  assert.doesNotMatch(log(), /\[restart\]/);
});

test("the health check answers without a login, with the token of this start", async () => {
  const a = await send(undefined, "/api/health");
  assert.equal(a.status, 200);
  assert.equal(a.body.ok, true);
  assert.match(a.body.boot, /^[0-9a-f]{12}$/);
  assert.equal((await send(undefined, "/api/health")).body.boot, a.body.boot);
});

test("the owner is told it is possible, and a request without the confirmation does nothing", async () => {
  const cookie = await login();
  const status = await send(cookie, "/api/restart");
  assert.equal(status.status, 200);
  const { loaded, keepsLogins, ...rest } = status.body;
  assert.deepEqual(rest, { possible: true, by: "manager", running: 0 });
  assert.equal(keepsLogins, false, "a password and no secret of its own: a restart ends the login");
  assert.ok(loaded === null || Array.isArray(loaded), "the extensions this start runs, once they are known");
  const bare = await send(cookie, "/api/restart", "POST", {});
  assert.equal(bare.status, 400);
  assert.equal(bare.body.code, "confirm");
  assert.equal(child.exitCode, null);
});

test("a portal with no password has no logins to end, and does not say they will", async () => {
  const open = await startServer(serverEnv(testHome("pithagoras-restart-open-"), await freePort(), { PORTAL_SECRET: "", PORTAL_UPDATE_RESTART: "exit" }));
  const res = await fetch(`${open.base}/api/restart`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).keepsLogins, true);
});

test("a confirmed request is logged with the time, answers 202, and the portal ends with the status that gets it started again", async () => {
  const cookie = await login();
  const boot = (await send(undefined, "/api/health")).body.boot;
  const res = await send(cookie, "/api/restart", "POST", { confirm: true });
  assert.equal(res.status, 202);
  assert.deepEqual(res.body, { restarting: true, boot });
  // A second request while it winds down is not a second restart.
  assert.equal((await send(cookie, "/api/restart", "POST", { confirm: true })).status, 409);
  const [code] = await once(child, "exit");
  assert.equal(code, RESTART_EXIT);
  assert.equal(RESTART_EXIT, 75);
  assert.match(log(), /\[restart\] the owner asked for a restart at \d{4}-\d\d-\d\dT[\d:.]+Z from \S+, started again by manager; 0 running chats or routines end/);
  assert.match(log(), /SIGTERM received/);
});

// --- the route with a supervisor of the test's own ---

async function serve(deps) {
  const calls = { restart: [], held: [] };
  const app = express();
  app.use(express.json());
  app.use("/api", restartRouter({ running: () => 2, now: () => new Date("2026-10-14T10:00:00Z"), updating: () => false, hold: (on) => void calls.held.push(on), loaded: () => ["web-search"], keepsLogins: () => true, restart: async (s) => void calls.restart.push(s), ...deps }));
  const server = http.createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async (body) => {
    const res = await fetch(`${url}/api/restart`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { calls, post, get: async () => (await fetch(`${url}/api/restart`)).json(), close: () => server.close() };
}

test("a portal started by hand says that a restart is not possible here, and does nothing", async () => {
  const none = await restartSupport({ env: {}, cgroup: "0::/user.slice/session-2.scope\n", container: () => false });
  const lines = [];
  const logged = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  const s = await serve({ support: async () => none });
  try {
    assert.deepEqual(await s.get(), { possible: false, code: "unsupervised", reason: none.message, running: 2, loaded: ["web-search"], keepsLogins: true });
    const res = await s.post({ confirm: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "unsupervised");
    assert.match(res.body.error, /Nothing would start this portal again/);
    assert.deepEqual(s.calls.restart, [], "nothing was stopped");
    assert.deepEqual(lines, [], "and nothing is logged as a restart");
    assert.deepEqual(s.calls.held, [true, false], "and the update is not kept waiting");
  } finally {
    console.log = logged;
    s.close();
  }
});

test("a request is logged with who and when, counts what it stops, and starts the restart once", async () => {
  const lines = [];
  const logged = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  const s = await serve({ support: async () => ({ ok: true, mode: "exit", by: "systemd" }) });
  try {
    assert.equal((await s.post({ confirm: true })).status, 202);
    assert.deepEqual(s.calls.restart, [{ ok: true, mode: "exit", by: "systemd" }]);
    assert.deepEqual(s.calls.held, [true], "an update begun now is turned away");
    assert.equal((await s.post({ confirm: true })).status, 409);
    assert.equal(s.calls.restart.length, 1);
    assert.match(lines.join("\n"), /^\[restart\] the owner asked for a restart at 2026-10-14T10:00:00\.000Z from \S+, started again by systemd; 2 running chats or routines end$/);
  } finally {
    console.log = logged;
    s.close();
  }
});

test("a restart that cannot be started is an error, and a later request may try again", async () => {
  let fails = true;
  const logged = console.log;
  console.log = () => {};
  const s = await serve({ support: async () => ({ ok: true, mode: "self", by: "copy" }), restart: async () => { if (fails) throw new Error("spawn sh ENOENT"); } });
  try {
    const first = await s.post({ confirm: true });
    assert.equal(first.status, 500);
    assert.match(first.body.error, /ENOENT/);
    fails = false;
    assert.equal((await s.post({ confirm: true })).status, 202);
  } finally {
    console.log = logged;
    s.close();
  }
});

test("while an update runs the portal is not restarted: it has moved its files aside, and the stop would leave it without them", async () => {
  let updating = true;
  const s = await serve({ support: async () => ({ ok: true, mode: "exit", by: "systemd" }), updating: () => updating });
  try {
    const state = await s.get();
    assert.equal(state.possible, false);
    assert.equal(state.code, "update");
    assert.match(state.reason, /An update is running/);
    const res = await s.post({ confirm: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "update");
    assert.deepEqual(s.calls.restart, [], "nothing was stopped");
    assert.deepEqual(s.calls.held, [], "and nothing was held");
    updating = false;
    assert.equal((await s.get()).possible, true);
    assert.equal((await s.post({ confirm: true })).status, 202);
  } finally {
    s.close();
  }
});

test("it says whether a login outlives the restart, and which extensions this start runs", async () => {
  const s = await serve({ support: async () => ({ ok: true, mode: "exit", by: "systemd" }), keepsLogins: () => false, loaded: () => null });
  try {
    const state = await s.get();
    assert.equal(state.keepsLogins, false);
    assert.equal(state.loaded, null, "not known yet");
  } finally {
    s.close();
  }
});

// --- what counts as something that starts it again ---

const cgroup = (path) => `0::${path}\n`;
const units = (main, restart) => async () => `MainPID=${main}\nRestart=${restart}\n`;

test("what restarts the portal: systemd with a policy that does, a manager, a container; not a terminal", async () => {
  const unit = cgroup("/system.slice/pithagoras.service");
  const base = { env: {}, container: () => false, pids: [4242, 4000] };

  assert.deepEqual(await restartSupport({ ...base, cgroup: unit, show: units(4242, "on-failure") }), { ok: true, mode: "exit", by: "systemd" });
  assert.deepEqual(await restartSupport({ ...base, cgroup: unit, show: units(4000, "always") }), { ok: true, mode: "exit", by: "systemd" });
  const no = await restartSupport({ ...base, cgroup: unit, show: units(4242, "no") });
  assert.equal(no.ok, false);
  assert.equal(no.code, "policy");
  assert.match(no.message, /systemd service pithagoras\.service.*Restart=no.*Restart=on-failure/);
  // In a unit's control group without being its process (npm start under dash): the portal starts a copy as well.
  assert.deepEqual(await restartSupport({ ...base, cgroup: unit, show: units(1, "on-failure") }), { ok: true, mode: "both", by: "systemd" });
  // The same under a unit that does not start it again: the copy it starts is ended with the unit's control group.
  for (const policy of ["no", "on-success", "on-abnormal"]) {
    const wrapped = await restartSupport({ ...base, cgroup: unit, show: units(1, policy) });
    assert.equal(wrapped.ok, false, policy);
    assert.equal(wrapped.code, "policy");
    assert.match(wrapped.message, new RegExp(`pithagoras\\.service.*not as the unit's own process.*Restart=${policy}`));
  }
  assert.deepEqual(await restartSupport({ ...base, cgroup: unit, show: units(1, "always") }), { ok: true, mode: "both", by: "systemd" });
  // A systemctl that cannot be asked claims nothing.
  assert.deepEqual(await restartSupport({ ...base, cgroup: unit, show: async () => undefined }), { ok: true, mode: "both", by: "systemd" });
  // The owner's word for it wins: a job of cron under a unit whose policy says nothing about the job.
  assert.deepEqual(await restartSupport({ ...base, env: { PORTAL_UPDATE_RESTART: "self" }, cgroup: unit, show: units(1, "no") }), { ok: true, mode: "self", by: "copy" });

  assert.deepEqual(await restartSupport({ ...base, env: { PORTAL_UPDATE_RESTART: "exit" }, cgroup: cgroup("/user.slice/session-1.scope") }), { ok: true, mode: "exit", by: "manager" });
  assert.deepEqual(await restartSupport({ ...base, env: { PORTAL_UPDATE_RESTART: "self" }, cgroup: "" }), { ok: true, mode: "self", by: "copy" });

  const hand = await restartSupport({ ...base, cgroup: cgroup("/user.slice/session-1.scope") });
  assert.equal(hand.ok, false);
  assert.equal(hand.code, "unsupervised");
});

test("in a container it depends on Docker's restart policy where Docker can say, and is taken as given where it cannot", async () => {
  const base = { env: {}, cgroup: cgroup("/"), container: () => true };
  for (const policy of ["unless-stopped", "always", "on-failure"]) {
    assert.deepEqual(await restartSupport({ ...base, policy: async () => policy }), { ok: true, mode: "exit", by: "container" }, policy);
  }
  assert.deepEqual(await restartSupport({ ...base, policy: async () => undefined }), { ok: true, mode: "exit", by: "container" });
  for (const policy of ["no", ""]) {
    const refused = await restartSupport({ ...base, policy: async () => policy });
    assert.equal(refused.ok, false, JSON.stringify(policy));
    assert.equal(refused.code, "policy");
    assert.match(refused.message, /no restart policy/);
  }
});

// --- the requests that are open when it stops ---

test("closing: an idle connection ends at once, an answer that is on its way finishes, the rest is cut after the grace", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    if (req.url === "/slow") setTimeout(() => res.end("done"), 200);
    // /stream never ends, as an event stream does.
    else if (req.url === "/stream") res.write("data: x\n\n");
    else res.end("ok");
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const agent = new http.Agent({ keepAlive: true });
  const get = (path) => new Promise((resolve) => {
    http.get({ port, host: "127.0.0.1", path, agent }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ body, ended: true }));
      res.on("error", () => resolve({ body, ended: false }));
      res.on("aborted", () => resolve({ body, ended: false }));
      res.on("close", () => resolve({ body, ended: res.complete }));
    }).on("error", () => resolve({ body: "", ended: false }));
  });
  try {
    await get("/idle"); // leaves a kept-alive connection
    const slow = get("/slow");
    const stream = get("/stream");
    await new Promise((r) => setTimeout(r, 50));
    const closed = once(server, "close");
    server.close();
    closeConnections(server, 600);
    assert.deepEqual(await slow, { body: "done", ended: true }, "the answer that was on its way was not cut");
    const cut = await stream;
    assert.equal(cut.ended, false, "the stream was cut");
    await closed;
  } finally {
    agent.destroy();
    server.closeAllConnections();
  }
});
