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
// A stand-in for the portal: writes down how it was started, asks the restart to stop it as an update does, and
// stops as the real one does, with the status the restart asked for. Its second life ends at once.
writeFileSync(script, `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const [marker, dist] = process.argv.slice(2);
const { restartMode, restartPortal, restartProblem, requestedExit, serviceOf } = await import(dist + "/restart.js");
const lives = existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\\n").length : 0;
const cgroup = readFileSync("/proc/self/cgroup", "utf8");
appendFileSync(marker, JSON.stringify({ life: lives + 1, mode: restartMode(process.env, cgroup), unit: serviceOf(cgroup)?.unit ?? null, problem: await restartProblem() }) + "\\n");
if (lives > 0) setTimeout(() => process.exit(0), 100);
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

/** Runs the stand-in as a user service with the given restart policy; the unit is stopped and removed afterwards. */
async function service(policy, settle) {
  const unit = `pithagoras-update-test-${process.pid}-${policy}`;
  const marker = path.join(home, `${policy}.lives`);
  execFileSync("systemd-run", ["--user", "--quiet", "--collect", `--unit=${unit}`, `--property=Restart=${policy}`, "--property=RestartSec=100ms", "--property=StandardOutput=null", "--property=StandardError=null", "--", process.execPath, script, marker, dist]);
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
  assert.equal(seen[0].mode, "exit", "told to be a service by its control group, with nothing set");
  assert.match(seen[0].unit, /^pithagoras-update-test-.*\.service$/);
  assert.equal(seen[0].problem, null, "a policy that restarts it is no problem");
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
});
