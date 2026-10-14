import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scratch } from "./server-harness.mjs";

/**
 * The restart under a real systemd, as far as a test can: the portal's restart code runs in a transient service of
 * the user's own manager (`systemd-run --user`), once with `Restart=on-failure`, which has to start it again, and once
 * with `Restart=no`, which does not and which the check before an update has to say so. Skipped where there is no user
 * manager to ask.
 */
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const manager = (() => {
  try {
    execFileSync("systemctl", ["--user", "show", "--property=Version"], { stdio: "ignore", timeout: 5000 });
    execFileSync("systemd-run", ["--user", "--version"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
})();

const home = scratch("pithagoras-update-systemd-");
const script = path.join(home, "portal.mjs");
// A stand-in for the portal: writes down how it was started and what the restart makes of it. Told `restart`, it asks
// the restart to stop it as an update does, and stops as the real one does, with the status the restart asked for; its
// second life ends at once. Told `plan`, it only writes down.
writeFileSync(script, `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const [marker, dist, how] = process.argv.slice(2);
const { restartPlan, restartPortal, restartProblem, restartSupport, requestedExit } = await import(dist + "/restart.js");
const lives = existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\\n").length : 0;
const plan = await restartPlan();
appendFileSync(marker, JSON.stringify({ life: lives + 1, mode: plan.mode, unit: plan.service?.unit ?? null, problem: await restartProblem(), support: await restartSupport() }) + "\\n");
if (how === "plan" || lives > 0) setTimeout(() => process.exit(0), 100);
else {
  process.on("SIGTERM", () => process.exit(requestedExit()));
  await restartPortal();
  setInterval(() => {}, 1000);
}
`);

const lives = (marker) => (existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const until = async (condition, ms) => {
  for (let i = 0; i < ms / 100 && !condition(); i++) await new Promise((r) => setTimeout(r, 100));
};

/**
 * Runs the stand-in as a user service with the given restart policy; the unit is stopped and removed afterwards.
 * `how` is how the service starts it: the service's own main process, its child (as `npm start` has it) or its
 * grandchild (as a job a daemon starts has it).
 */
async function service(policy, settle, { how = "restart", start = "main" } = {}) {
  const unit = `pithagoras-update-test-${process.pid}-${policy}-${start}`;
  const marker = path.join(home, `${policy}-${start}.lives`);
  const portal = [script, marker, dist, how];
  const command = {
    main: [process.execPath, ...portal],
    // The shell stays as the main process and the portal is its child.
    child: ["sh", "-c", '"$0" "$@"; true', process.execPath, ...portal],
    // A subshell between them: the portal's parent is not the main process, which only waits.
    grandchild: ["sh", "-c", '( "$0" "$@"; true ) & wait', process.execPath, ...portal],
    // Two shells that do not exec and pass the status on, as `npm start` under dash has them: npm, `sh -c node …`, node.
    shells: ["sh", "-c", '"$0" "$@"; exit $?', "sh", "-c", '"$0" "$@"; exit $?', process.execPath, ...portal],
  }[start];
  execFileSync("systemd-run", ["--user", "--quiet", "--collect", `--unit=${unit}`, `--property=Restart=${policy}`, "--property=RestartSec=100ms", "--property=StandardOutput=null", "--property=StandardError=null", "--", ...command]);
  try {
    await settle(marker);
    return lives(marker);
  } finally {
    try {
      execFileSync("systemctl", ["--user", "stop", `${unit}.service`], { stdio: "ignore" });
    } catch {
      // Gone already.
    }
  }
}

test("under systemd with Restart=on-failure the portal is started again after the update stops it", { skip: !manager && "no user manager of systemd" }, async () => {
  const seen = await service("on-failure", (marker) => until(() => lives(marker).length >= 2, 15_000));
  assert.equal(seen.length, 2, "started again");
  assert.equal(seen[0].mode, "exit", "told to be the service by its control group and its main process, with nothing set");
  assert.match(seen[0].unit, /^pithagoras-update-test-.*\.service$/);
  assert.equal(seen[0].problem, null, "a policy that restarts it is no problem");
  assert.deepEqual(seen[0].support, { ok: true, mode: "exit", by: "systemd" }, "the Restart button may restart it");
});

test("under systemd with Restart=no the portal is not started again, and the check before the update says so", { skip: !manager && "no user manager of systemd" }, async () => {
  // Waits until it has run, and then as long as the other needed to come back, and more.
  const seen = await service("no", async (marker) => {
    await until(() => lives(marker).length >= 1, 15_000);
    await new Promise((r) => setTimeout(r, 4000));
  });
  assert.equal(seen.length, 1, "it does not come back");
  assert.equal(seen[0].mode, "exit");
  assert.match(seen[0].problem, /Restart=no/);
  assert.match(seen[0].problem, /Restart=on-failure \(or Restart=always\)/);
  assert.equal(seen[0].support.ok, false, "and the Restart button refuses");
  assert.equal(seen[0].support.code, "policy");
});

test("a portal that is the child of a service's main process, as under npm start, is taken for the service", { skip: !manager && "no user manager of systemd" }, async () => {
  const seen = await service("no", (marker) => until(() => lives(marker).length >= 1, 15_000), { how: "plan", start: "child" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].mode, "exit");
  assert.match(seen[0].unit, /^pithagoras-update-test-.*\.service$/);
  assert.match(seen[0].problem, /Restart=no/);
});

test("a portal under shells that do not exec, as npm start has under dash, starts a copy and stops with the status, and systemd starts it again", { skip: !manager && "no user manager of systemd" }, async () => {
  const seen = await service("on-failure", (marker) => until(() => lives(marker).length >= 2, 15_000), { start: "shells" });
  assert.ok(seen.length >= 2, "started again");
  assert.equal(seen[0].mode, "both", "the main process is not the portal or its parent");
  assert.equal(seen[0].unit, null);
  assert.equal(seen[0].problem, null);
  assert.deepEqual(seen[0].support, { ok: true, mode: "both", by: "systemd" }, "a unit that starts it again: the Restart button may restart it");
});

test("a portal that a service only runs a job for is not taken for the unit's own process: it starts a copy and stops with the status, and is not told to change the unit", { skip: !manager && "no user manager of systemd" }, async () => {
  // In the unit's control group, as a cron job is in cron.service, and not the unit's main process or its child.
  const seen = await service("no", (marker) => until(() => lives(marker).length >= 1, 15_000), { how: "plan", start: "grandchild" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].mode, "both");
  assert.equal(seen[0].unit, null);
  assert.equal(seen[0].problem, null);
  // The Update goes ahead (it cannot tell the job from cron's), but the Restart button looks at the unit's policy, which
  // is no: the copy it would start is ended with the unit's control group.
  assert.equal(seen[0].support.ok, false);
  assert.equal(seen[0].support.code, "policy");
  assert.match(seen[0].support.message, /Restart=no/);
});
