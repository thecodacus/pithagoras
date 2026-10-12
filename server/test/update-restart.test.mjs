import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scratch } from "./server-harness.mjs";

/**
 * Starting the portal again after an update: what is run and when the old one is stopped, with a spawn and a stop of
 * the test's own; and the wait itself, with a real shell and a stand-in for the old portal.
 */
const { RESTART_EXIT, requestedExit, restartMode, restartPortal, restartProblem, serviceOf } = await import("../dist/restart.js");

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

test("the portal exits for its manager under systemd, starts itself elsewhere, and PORTAL_UPDATE_RESTART decides either way", () => {
  assert.equal(restartMode({}, SYSTEM), "exit");
  assert.equal(restartMode({}, USER), "exit");
  assert.equal(restartMode({}, TERMINAL), "self");
  assert.equal(restartMode({}, ""), "self");
  assert.equal(restartMode({ PORTAL_UPDATE_RESTART: "self" }, SYSTEM), "self");
  assert.equal(restartMode({ PORTAL_UPDATE_RESTART: "exit" }, TERMINAL), "exit");
  assert.equal(restartMode({ PORTAL_UPDATE_RESTART: "whatever" }, SYSTEM), "exit");
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
  await restartPortal(launch, deps);
  await pause(40);
  assert.equal(seen.spawned.length, 0);
  assert.equal(seen.stopped, 1);
  assert.equal(requestedExit(), RESTART_EXIT);
});

test("a systemd service that is not set to start again is found out before the update, not after", async () => {
  const asked = [];
  const policy = (text) => async (args) => (asked.push(args), text === undefined ? undefined : `Restart=${text}\n`);
  const system = { unit: "pithagoras.service", user: false };
  for (const ok of ["always", "on-failure"]) assert.equal(await restartProblem("exit", system, policy(ok)), null, ok);
  for (const bad of ["no", "on-success", "on-abnormal", "on-abort", "on-watchdog"]) {
    const why = await restartProblem("exit", system, policy(bad));
    assert.match(why, new RegExp(`pithagoras\\.service, which is set to Restart=${bad}`), bad);
    assert.match(why, /Restart=on-failure \(or Restart=always\)/);
  }
  assert.deepEqual(asked.at(-1), ["show", "--property=Restart", "pithagoras.service"]);
  // A user's service is asked of the user's manager.
  await restartProblem("exit", { unit: "p.service", user: true }, policy("no"));
  assert.deepEqual(asked.at(-1), ["--user", "show", "--property=Restart", "p.service"]);
  // Nothing is claimed where it cannot be read, or where the portal starts itself.
  assert.equal(await restartProblem("exit", system, policy(undefined)), null);
  assert.equal(await restartProblem("exit", undefined, policy("no")), null);
  const before = asked.length;
  assert.equal(await restartProblem("self", system, policy("no")), null);
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
