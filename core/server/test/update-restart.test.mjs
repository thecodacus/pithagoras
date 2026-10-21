import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scratch } from "./server-harness.mjs";

/**
 * Starting the portal again after an update: what is run and when the old one is stopped, with a spawn and a stop of
 * the test's own; and the wait itself, with a real shell and a stand-in for the old portal.
 */
const { RESTART_EXIT, containerRestartPolicy, ownService, requestedExit, restartPlan, restartPortal, restartProblem, serviceOf } = await import("../dist/restart.js");

const launch = { execPath: "/usr/bin/node", execArgv: ["--import", "tsx"], script: "/srv/pithagoras/server/dist/index.js", args: ["--flag"], cwd: "/srv/pithagoras" };

/** A spawn that starts nothing and says what it was asked, as a child that has started, or has failed to. */
function fakes(env = {}, spawnFails = false, cgroup = "") {
  const seen = { spawned: [], stopped: 0, unref: 0 };
  const deps = {
    spawn: (command, args, options) => {
      seen.spawned.push({ command, args, options });
      const child = new EventEmitter();
      child.unref = () => seen.unref++;
      process.nextTick(() => (spawnFails ? child.emit("error", new Error("spawn sh ENOENT")) : child.emit("spawn")));
      return child;
    },
    stop: () => seen.stopped++,
    pid: 4242,
    env,
    cgroup,
    delayMs: 10,
  };
  return { seen, deps };
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test("the replacement is started first, detached, with the command line the portal had, and then the old one is stopped", async () => {
  const { seen, deps } = fakes({ PORT: "4100" });
  await restartPortal(launch, deps);
  assert.equal(seen.spawned.length, 1);
  const { command, args, options } = seen.spawned[0];
  assert.equal(command, "sh");
  assert.equal(args[0], "-c");
  // The shell's own name, the pid to wait for, then the command to run once it is gone.
  assert.deepEqual(args.slice(2), ["sh", "4242", "/usr/bin/node", "--import", "tsx", "/srv/pithagoras/server/dist/index.js", "--flag"]);
  assert.equal(options.cwd, "/srv/pithagoras");
  assert.equal(options.detached, true, "in a session of its own, so that nothing that ends the old portal ends it");
  assert.deepEqual(options.stdio, ["ignore", "inherit", "inherit"], "it writes where the portal wrote");
  assert.deepEqual(options.env, { PORT: "4100" });
  assert.equal(seen.unref, 1);
  assert.equal(requestedExit(), 0, "it ends as it always did");
  assert.equal(seen.stopped, 0, "not at once: a page asking meanwhile is told the portal is restarting");
  await pause(40);
  assert.equal(seen.stopped, 1);
});

test("a copy that cannot be started leaves the portal running, and the status it ends with as it was", async () => {
  const { seen, deps } = fakes({}, true, "0::/system.slice/cron.service\n");
  await assert.rejects(restartPortal(launch, { ...deps, show: async () => "MainPID=811\nRestart=no\n", pids: [4242, 4000] }), /ENOENT/);
  await pause(40);
  assert.equal(seen.stopped, 0);
  assert.equal(requestedExit(), 0);
});

/** The control groups of a process in a system service, in a user's service, in a terminal, and under cgroup v1. */
const SYSTEM = "0::/system.slice/pithagoras.service\n";
const USER = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/pithagoras.service\n";
const TERMINAL = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-terminal-1234.scope\n";
const V1 = "12:cpu,cpuacct:/system.slice/pithagoras.service\n1:name=systemd:/system.slice/pithagoras.service\n0::/system.slice/pithagoras.service\n";

test("a portal run by systemd is told from one run in a terminal, by its control group", () => {
  assert.deepEqual(serviceOf(SYSTEM), { unit: "pithagoras.service", user: false });
  assert.deepEqual(serviceOf(USER), { unit: "pithagoras.service", user: true });
  assert.deepEqual(serviceOf(V1), { unit: "pithagoras.service", user: false });
  // Everything a user runs is under user@1000.service: that is the manager, not the portal's own unit.
  assert.equal(serviceOf(TERMINAL), undefined);
  assert.equal(serviceOf("0::/user.slice/user-1000.slice/session-3.scope\n"), undefined);
  assert.equal(serviceOf("0::/\n"), undefined);
  assert.equal(serviceOf(""), undefined);
  assert.equal(serviceOf(undefined), undefined);
});

/** What `systemctl show` says of the unit: the main process and the restart policy. */
const unit = (main, restart = "on-failure", asked = []) => async (args) => (asked.push(args), `MainPID=${main}\nRestart=${restart}\n`);
const PORTAL = 4242;
/** This process, and its parent: `npm start` is a unit's main process and runs the portal as its child. */
const PIDS = [PORTAL, 4000];

test("a portal is a systemd service's own only when it is the unit's main process or that process's child", async () => {
  const system = { unit: "pithagoras.service", user: false, restart: "on-failure" };
  assert.deepEqual(await ownService(SYSTEM, unit(PORTAL), PIDS), system, "node server/dist/index.js as ExecStart");
  assert.deepEqual(await ownService(SYSTEM, unit(4000), PIDS), system, "npm start as ExecStart: the portal is its child");
  assert.deepEqual(await ownService(USER, unit(PORTAL), PIDS), { ...system, user: true });
  // A cron job is in cron.service's control group, and the cron daemon is that unit's main process.
  assert.equal(await ownService("0::/system.slice/cron.service\n", unit(811, "on-failure"), PIDS), undefined);
  assert.equal(await ownService(SYSTEM, unit(0), PIDS), undefined, "a unit that has no main process");
  assert.equal(await ownService(SYSTEM, async () => undefined, PIDS), undefined, "nothing is claimed where it cannot be read");
  assert.equal(await ownService(SYSTEM, async () => "Restart=always\n", PIDS), undefined);
  // Not in a service at all: systemctl is not asked.
  const asked = [];
  assert.equal(await ownService(TERMINAL, unit(PORTAL, "no", asked), PIDS), undefined);
  assert.deepEqual(asked, []);
});

test("the portal exits for its manager when it is the service, starts itself elsewhere, and PORTAL_UPDATE_RESTART decides either way", async () => {
  const mode = async (env, cgroup, show) => (await restartPlan(env, cgroup, show, PIDS)).mode;
  assert.equal(await mode({}, SYSTEM, unit(PORTAL)), "exit");
  assert.equal(await mode({}, USER, unit(4000)), "exit");
  assert.equal(await mode({}, TERMINAL, unit(PORTAL)), "self");
  assert.equal(await mode({}, "", unit(PORTAL)), "self");
  // In a service's control group without being its main process or its child: a job of cron, `npm start` whose shell
  // does not exec (dash), a wrapper script. Which of them it is cannot be told, and it has to work for all: it starts
  // its own copy, for cron, and stops with the status that has a unit start it, for the others.
  assert.equal(await mode({}, "0::/system.slice/cron.service\n", unit(811)), "both");
  assert.equal(await mode({}, SYSTEM, unit(4001)), "both", "the unit's process is another one: npm, or a wrapper");
  assert.equal(await mode({}, SYSTEM, async () => undefined), "both", "systemctl cannot be read");
  assert.equal(await mode({ PORTAL_UPDATE_RESTART: "self" }, SYSTEM, unit(PORTAL)), "self");
  assert.equal(await mode({ PORTAL_UPDATE_RESTART: "exit" }, TERMINAL, unit(PORTAL)), "exit");
  assert.equal(await mode({ PORTAL_UPDATE_RESTART: "exit" }, "0::/system.slice/cron.service\n", unit(811)), "exit");
  assert.equal(await mode({ PORTAL_UPDATE_RESTART: "whatever" }, SYSTEM, unit(PORTAL)), "exit");
  const asked = [];
  await mode({ PORTAL_UPDATE_RESTART: "self" }, SYSTEM, unit(PORTAL, "on-failure", asked));
  assert.deepEqual(asked, [], "said outright: not asked");
});

test("with PORTAL_UPDATE_RESTART=exit the portal only stops, with a status a manager starts it again from", async () => {
  const { seen, deps } = fakes({ PORTAL_UPDATE_RESTART: "exit" });
  await restartPortal(launch, deps);
  await pause(40);
  assert.equal(seen.spawned.length, 0);
  assert.equal(seen.stopped, 1);
  assert.equal(requestedExit(), RESTART_EXIT);
  assert.notEqual(RESTART_EXIT, 0, "Restart=on-failure starts it again from a status that is not 0");
});

test("as a systemd service the portal starts nothing of its own, which the service's end would take with it: it exits", async () => {
  const { seen, deps } = fakes({}, false, SYSTEM);
  await restartPortal(launch, { ...deps, show: unit(PORTAL), pids: PIDS });
  await pause(40);
  assert.equal(seen.spawned.length, 0);
  assert.equal(seen.stopped, 1);
  assert.equal(requestedExit(), RESTART_EXIT);
});

test("a job in another service's control group, cron's, starts its own copy, and stops with the status as well", async () => {
  const { seen, deps } = fakes({}, false, "0::/system.slice/cron.service\n");
  await restartPortal(launch, { ...deps, show: unit(811), pids: PIDS });
  await pause(40);
  assert.equal(seen.spawned.length, 1, "its own copy: nothing else starts a job of cron again");
  assert.equal(seen.spawned[0].options.detached, true);
  assert.equal(seen.stopped, 1);
  assert.equal(requestedExit(), RESTART_EXIT, "cron does not look at it");
});

test("a portal under a shell that does not exec is not the unit's process or its child: it starts a copy and stops with the status, for the unit to start it again", async () => {
  // ExecStart=/usr/bin/npm start on Debian and Ubuntu: npm (the unit's MainPID 4000), `sh -c node server/dist/index.js`
  // (4001), and the portal (4242, whose parent is the shell).
  const { seen, deps } = fakes({}, false, SYSTEM);
  const asked = [];
  await restartPortal(launch, { ...deps, show: unit(4000, "on-failure", asked), pids: [4242, 4001] });
  await pause(40);
  assert.equal(asked.length, 1, "systemd was asked");
  assert.equal(seen.spawned.length, 1);
  assert.equal(seen.stopped, 1);
  assert.equal(requestedExit(), RESTART_EXIT);
});

test("a service that is not set to start again is found out before the update, only where the portal is that service", async () => {
  const asked = [];
  const run = (env, cgroup, show) => restartProblem(env, cgroup, show, PIDS);
  for (const ok of ["always", "on-failure"]) assert.equal(await run({}, SYSTEM, unit(PORTAL, ok)), null, ok);
  for (const bad of ["no", "on-success", "on-abnormal", "on-abort", "on-watchdog"]) {
    const why = await run({}, SYSTEM, unit(PORTAL, bad, asked));
    assert.match(why, new RegExp(`pithagoras\\.service, which is set to Restart=${bad}`), bad);
    assert.match(why, /Restart=on-failure \(or Restart=always\)/);
  }
  assert.deepEqual(asked.at(-1), ["show", "--property=MainPID,Restart", "pithagoras.service"]);
  // A user's service is asked of the user's manager.
  await run({}, USER, unit(PORTAL, "no", asked));
  assert.deepEqual(asked.at(-1), ["--user", "show", "--property=MainPID,Restart", "pithagoras.service"]);
  // A cron job is not told to change cron's unit, whatever its policy is: it is not what restarts it.
  const cron = "0::/system.slice/cron.service\n";
  assert.equal(await run({}, cron, unit(811, "no")), null);
  assert.equal(await run({ PORTAL_UPDATE_RESTART: "exit" }, cron, unit(811, "no")), null);
  // Nothing is claimed where it cannot be read, or where the portal starts itself.
  assert.equal(await run({}, SYSTEM, async () => undefined), null);
  assert.equal(await run({}, TERMINAL, unit(PORTAL, "no")), null);
  const before = asked.length;
  assert.equal(await run({ PORTAL_UPDATE_RESTART: "self" }, SYSTEM, unit(PORTAL, "no", asked)), null);
  assert.equal(asked.length, before);
});

test("a portal that cannot be started again is not stopped", async () => {
  const none = fakes();
  await assert.rejects(restartPortal({ ...launch, script: undefined }, none.deps), /not started from a file/);
  const broken = fakes({}, true);
  await assert.rejects(restartPortal(launch, broken.deps), /ENOENT/);
  await pause(40);
  assert.equal(none.seen.stopped + broken.seen.stopped, 0);
  assert.equal(none.seen.spawned.length, 0);
});

test("the replacement waits for the old portal to be gone, and runs the command with its arguments as they were", async () => {
  const dir = path.join(scratch("pithagoras-restart-"), "a folder with spaces");
  mkdirSync(dir);
  const marker = path.join(dir, "started at");
  const script = path.join(dir, "start.mjs");
  writeFileSync(script, 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], JSON.stringify({ at: Date.now(), cwd: process.cwd(), arg: process.argv[3], env: process.env.RESTART_TEST }));');
  // The old portal: a process that goes away after a while.
  const old = spawn(process.execPath, ["-e", "setTimeout(() => {}, 700)"], { stdio: "ignore" });
  const gone = new Promise((resolve) => old.once("exit", () => resolve(Date.now())));
  await restartPortal({ execPath: process.execPath, execArgv: [], script, args: [marker, "two words"], cwd: dir }, {
    spawn,
    stop: () => {},
    pid: old.pid,
    env: { ...process.env, RESTART_TEST: "kept" },
    delayMs: 0,
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(existsSync(marker), false, "the old portal is still there: the replacement waits");
  const wentAt = await gone;
  for (let i = 0; i < 100 && !existsSync(marker); i++) await pause(50);
  const ran = JSON.parse(readFileSync(marker, "utf8"));
  assert.ok(ran.at >= wentAt, "it started after the old one was gone");
  assert.equal(ran.arg, "two words");
  assert.equal(ran.cwd, realpathSync(dir));
  assert.equal(ran.env, "kept");
});

test("the container's restart policy is asked of Docker over its socket, by the container's name, and is nothing where Docker cannot say", async () => {
  const dir = scratch("pithagoras-restart-policy-");
  const socket = path.join(dir, "docker.sock");
  // Docker, answering for the containers it has; one that is held never answers.
  const policies = { "portal-up": "unless-stopped", "portal-no": "no" };
  const asked = [];
  const docker = http.createServer((req, res) => {
    asked.push(req.url);
    if (req.url === "/containers/portal-held/json") return;
    const name = /^\/containers\/([^/]+)\/json$/.exec(req.url)?.[1];
    if (!(name in policies)) return res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ message: `No such container: ${name}` }));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ Id: "x", HostConfig: { RestartPolicy: { Name: policies[name], MaximumRetryCount: 0 } } }));
  });
  docker.listen(socket);
  await once(docker, "listening");
  try {
    const policy = (name, at = socket) => containerRestartPolicy({ PORTAL_CONTAINER_NAME: name, DOCKER_SOCKET: at });
    assert.equal(await policy("portal-up"), "unless-stopped");
    assert.equal(await policy("portal-no"), "no");
    assert.deepEqual(asked, ["/containers/portal-up/json", "/containers/portal-no/json"]);
    assert.equal(await policy("someone-else"), undefined, "another name");
    assert.equal(await containerRestartPolicy({ HOSTNAME: "portal-up", DOCKER_SOCKET: socket }), "unless-stopped", "by its host name where it is not told its name");
    assert.equal(await policy("portal-up", path.join(dir, "no-docker.sock")), undefined, "no socket");
    const began = Date.now();
    assert.equal(await policy("portal-held"), undefined, "Docker that does not answer");
    assert.ok(Date.now() - began < 5000, `given up on in ${Date.now() - began} ms`);
  } finally {
    docker.closeAllConnections();
    docker.close();
  }
});
