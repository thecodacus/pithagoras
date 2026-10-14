import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inProcessHome, scratch } from "./server-harness.mjs";

/**
 * Updating the portal from its checkout, with a git and a build of the test's own: nothing is pulled, built or
 * restarted. The fake git answers from a state the test changes, and writes down each command it was given.
 */
inProcessHome("pithagoras-update-");
const { Updater, UpdateError, tail } = await import("../dist/update.js");
// The steps say what they do in the log; a test looks at the steps themselves.
console.log = console.error = () => {};

const repo = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".."));

const commit = (sha, subject = `commit ${sha}`) => ({ sha: sha.padEnd(40, "0"), subject, date: "2026-10-12T09:00:00+02:00" });
const line = (c) => `${c.sha}\x1f${c.subject}\x1f${c.date}\n`;
const ok = (stdout = "") => ({ code: 0, stdout, output: stdout });
const failed = (output, code = 1) => ({ code, stdout: "", output });

/** A checkout on `main` at `aaa`, with `bbb` and `ccc` new on origin/main. */
function world(over = {}) {
  const w = {
    toplevel: repo,
    branch: "main",
    changed: [],
    head: commit("aaa"),
    target: commit("ccc"),
    ahead: 0,
    behind: 2,
    fetchError: null,
    /** Steps that fail, by the command and its first argument: "npm ci", "npm run", "git merge". */
    fails: new Set(),
    /** Held back until the test lets it go: "npm ci". */
    gates: new Map(),
    ran: [],
    /** The commit the build in place was made from, as its record on disk has it; nothing until one is written, or once somebody has built since. */
    built: undefined,
    ...over,
  };
  // What the update puts aside and writes down, said into `ran` among the commands, and kept in `built` as the files would.
  w.artifacts = {
    builtFrom: async () => w.built,
    markBuilt: async (sha, onlyIfUnknown = false) => {
      w.ran.push(`files markBuilt ${sha.slice(0, 3)}${onlyIfUnknown ? " if unknown" : ""}`);
      if (!onlyIfUnknown || w.built === undefined) w.built = sha;
    },
    keepModules: async () => void w.ran.push("files keepModules"),
    keepBuild: async () => void w.ran.push("files keepBuild"),
    restore: async () => void w.ran.push("files restore"),
    discard: async () => void w.ran.push("files discard"),
  };
  w.exec = async (command, args) => {
    w.ran.push(`${command} ${args.join(" ")}`);
    const key = `${command} ${args[0]}`;
    const gate = w.gates.get(key);
    if (gate) await gate;
    if (command === "npm") return w.fails.has(key) ? failed(`${key} printed this\nand then this`, 1) : ok();
    switch (args[0]) {
      case "rev-parse": return ok(`${w.toplevel}\n`);
      case "symbolic-ref": return w.branch ? ok(`${w.branch}\n`) : failed("", 1);
      case "status": return ok(w.changed.map((f) => ` M ${f}\n`).join(""));
      case "fetch": return w.fetchError ? failed(w.fetchError, 128) : ok();
      case "log": return ok(line(args.includes("HEAD") ? w.head : w.target));
      case "rev-list": return ok(`${w.ahead}\t${w.behind}\n`);
      case "merge":
        if (w.fails.has(key)) return failed("fatal: Not possible to fast-forward, aborting.", 128);
        w.head = w.target;
        w.behind = 0;
        return ok("Fast-forward\n");
      default: throw new Error(`the fake git was asked for ${args.join(" ")}`);
    }
  };
  return w;
}

function updater(w, over = {}) {
  const calls = { restart: 0, raised: [] };
  const u = new Updater({
    root: repo,
    exec: w.exec,
    artifacts: w.artifacts,
    running: () => w.running ?? 0,
    restart: async () => { calls.restart++; if (w.restartFails) throw new Error(w.restartFails); },
    inContainer: () => false,
    fromSource: () => false,
    onRaise: (notice) => calls.raised.push(notice),
    ...over,
  });
  return { u, calls };
}

const changesTheCheckout = (w) => w.ran.filter((c) => /^(git merge|npm )/.test(c));
const refusal = async (promise, code, status = 409) => {
  const e = await promise.then(() => assert.fail("it was not refused"), (err) => err);
  assert.ok(e instanceof UpdateError, e.message);
  assert.equal(e.code, code, e.message);
  assert.equal(e.status, status);
  return e;
};
/** The run, once it has left `running` and its steps have been taken. */
const settled = async (u, states = ["failed", "restarting"]) => {
  for (let i = 0; i < 200; i++) {
    const run = (await u.status()).run;
    if (run && states.includes(run.state)) return run;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("the run did not settle");
};

test("the portal updates itself from a checkout of its own only: the folder must be the top of a repository, and not a container's", async () => {
  assert.equal(await updater(world()).u.kind(), "git");
  assert.equal(await updater(world({ toplevel: path.dirname(repo) })).u.kind(), "none", "a folder inside another repository");
  assert.equal(await updater(world(), { inContainer: () => true }).u.kind(), "container");
  const other = scratch("pithagoras-update-other-");
  writeFileSync(path.join(other, "package.json"), JSON.stringify({ name: "something-else" }));
  assert.equal(await updater(world({ toplevel: other }), { root: other }).u.kind(), "none", "a repository that is not this one");

  // Where there is nothing to update, nothing is asked of git beyond that, and asking to update is refused.
  const w = world();
  const { u } = updater(w, { inContainer: () => true });
  assert.deepEqual(await u.status(), { kind: "container" });
  await refusal(u.check(), "unavailable", 404);
  await refusal(u.start(w.target.sha), "unavailable", 404);
  assert.deepEqual(w.ran, []);
});

test("checking says where the checkout is and where origin/main is, and changes nothing", async () => {
  const w = world({ running: 3 });
  const { u } = updater(w);
  const seen = await u.check();
  assert.equal(seen.branch, "main");
  assert.equal(seen.current.sha, commit("aaa").sha);
  assert.equal(seen.target.sha, commit("ccc").sha);
  assert.equal(seen.behind, 2);
  assert.equal(seen.problem, null);
  assert.equal(seen.running, 3, "the chats the restart would stop");
  assert.ok(w.ran.some((c) => c.startsWith("git fetch origin +refs/heads/main:refs/remotes/origin/main")), "origin/main is asked for by its full name");
  assert.deepEqual(changesTheCheckout(w), []);
});

test("a checkout with local changes is not updated, and nothing is changed", async () => {
  const w = world({ changed: ["server/src/server.ts", "README.md"] });
  const { u, calls } = updater(w);
  const e = await refusal(u.start(w.target.sha), "dirty");
  assert.match(e.message, /2 files/);
  assert.deepEqual(changesTheCheckout(w), []);
  assert.equal(calls.restart, 0);
  // The tree is clean again: the refusal did not leave the updater held.
  w.changed = [];
  await u.start(w.target.sha);
});

test("what git does not track is no local change: only tracked files count", async () => {
  const w = world();
  const { u } = updater(w);
  await u.start(w.target.sha);
  assert.ok(w.ran.includes("git status --porcelain --untracked-files=no"));
});

test("a checkout that is on no branch is not updated", async () => {
  const w = world({ branch: null });
  const { u } = updater(w);
  await refusal(u.start(w.target.sha), "detached");
  assert.deepEqual(changesTheCheckout(w), []);
});

test("a checkout that cannot move straight to origin/main is not updated: it has commits of its own", async () => {
  const w = world({ ahead: 1, behind: 2 });
  const { u } = updater(w);
  const e = await refusal(u.start(w.target.sha), "diverged");
  assert.match(e.message, /1 commit that origin\/main lacks/);
  assert.deepEqual(changesTheCheckout(w), []);
});

test("a checkout that is not behind has nothing to update to, with commits of its own or without", async () => {
  for (const ahead of [0, 2]) {
    const w = world({ ahead, behind: 0, target: commit("aaa") });
    const { u } = updater(w);
    await refusal(u.start(w.target.sha), "current");
    assert.deepEqual(changesTheCheckout(w), []);
  }
});

test("a remote that cannot be reached is said, and nothing is changed", async () => {
  const w = world({ fetchError: "fatal: unable to access 'https://example.test/x.git/'" });
  const { u } = updater(w);
  const seen = await u.check();
  assert.equal(seen.problem.code, "fetch");
  assert.match(seen.problem.message, /unable to access/);
  await refusal(u.start(w.target.sha), "fetch");
  assert.deepEqual(changesTheCheckout(w), []);
});

test("an origin/main that moved after it was shown is a new question: the update waits for the answer", async () => {
  const w = world();
  const { u } = updater(w);
  const shown = (await u.check()).target.sha;
  w.target = commit("ddd");
  await refusal(u.start(shown), "moved");
  assert.deepEqual(changesTheCheckout(w), []);
  // Shown again, it goes ahead.
  await u.start(commit("ddd").sha);
});

test("a second press while an update runs is refused, and the first is not disturbed", async () => {
  let go;
  const w = world();
  w.gates.set("npm ci", new Promise((resolve) => (go = resolve)));
  const { u, calls } = updater(w);
  const first = await u.start(w.target.sha);
  assert.equal(first.state, "running");
  await refusal(u.start(w.target.sha), "busy");
  // Two at the same moment: the second never gets as far as asking git.
  const w2 = world();
  const { u: other } = updater(w2);
  const results = await Promise.allSettled([other.start(w2.target.sha), other.start(w2.target.sha)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(results.find((r) => r.status === "rejected").reason.code, "busy");
  go();
  const run = await settled(u);
  assert.equal(run.state, "restarting");
  assert.equal(calls.restart, 1, "restarted once");
  assert.equal(w.ran.filter((c) => c.startsWith("git merge")).length, 1);
  assert.equal(w.ran.filter((c) => c.startsWith("npm ci")).length, 1);
  // Still held while the portal is on its way out.
  await refusal(u.start(w.target.sha), "busy");
});

test("an update is not begun while a restart is on its way, and nothing is run", async () => {
  const w = world();
  let pending = true;
  const { u } = updater(w, { restartPending: () => pending });
  await refusal(u.start(w.target.sha), "restarting");
  assert.deepEqual(changesTheCheckout(w), []);
  assert.equal(u.working, false, "and the refusal leaves no update held");
  pending = false;
  assert.equal((await u.start(w.target.sha)).state, "running");
  assert.equal(u.working, true, "one that runs is working, which the restart looks at");
});

test("an update fetches, merges fast-forward only, installs, builds and restarts, in that order", async () => {
  const w = world();
  const { u, calls } = updater(w);
  const started = await u.start(commit("ccc").sha);
  assert.deepEqual(started.steps.map((s) => s.id), ["fetch", "merge", "install", "build", "restart"]);
  assert.equal(started.from.sha, commit("aaa").sha);
  assert.equal(started.to.sha, commit("ccc").sha);
  const run = await settled(u);
  assert.equal(run.state, "restarting");
  assert.deepEqual(run.steps.map((s) => s.state), ["done", "done", "done", "done", "running"]);
  const acts = w.ran.filter((c) => /^(git fetch|git merge|npm )/.test(c));
  assert.deepEqual(acts, [
    "git fetch origin +refs/heads/main:refs/remotes/origin/main",
    "git merge --ff-only refs/remotes/origin/main",
    "npm ci --prefer-offline --no-audit --no-fund",
    "npm run build",
  ]);
  assert.equal(calls.restart, 1);
  assert.ok(!w.ran.some((c) => /reset|--force|\bpush\b|checkout|\bstash\b/.test(c)), "nothing is reset, forced or put aside");
  const after = await u.status();
  assert.equal(after.current.sha, commit("ccc").sha, "the commit shown is the one now checked out");
  assert.equal(after.notice, null);
  assert.equal(after.rebuild, false);
});

test("a failed step stops the update where it failed, with what the program printed, and leaves the portal running", async () => {
  const w = world();
  w.fails.add("npm ci");
  const { u, calls } = updater(w);
  await u.start(w.target.sha);
  const run = await settled(u);
  assert.equal(run.state, "failed");
  assert.equal(run.failed.step, "install");
  assert.match(run.failed.message, /npm ci failed \(exit 1\)/);
  assert.match(run.failed.output, /printed this\nand then this/);
  assert.deepEqual(run.steps.map((s) => s.state), ["done", "done", "failed", "pending", "pending"]);
  assert.ok(!w.ran.includes("npm run build"), "no build on top of a failed install");
  assert.equal(calls.restart, 0, "the old build keeps serving");
  // The merge is in, the build is not: Update builds again instead of saying it is up to date.
  assert.equal((await u.status()).rebuild, true);
});

test("after a failed build, the next update builds again without merging, and restarts when it works", async () => {
  const w = world();
  w.fails.add("npm run");
  const { u, calls } = updater(w);
  await u.start(w.target.sha);
  assert.equal((await settled(u)).failed.step, "build");
  assert.equal(calls.restart, 0);

  w.fails.clear();
  w.ran.length = 0;
  await u.start(w.target.sha);
  const run = await settled(u);
  assert.equal(run.state, "restarting");
  assert.deepEqual(run.steps.map((s) => s.state), ["done", "skipped", "done", "done", "running"]);
  assert.ok(!w.ran.some((c) => c.startsWith("git merge")));
  assert.equal(calls.restart, 1);
  assert.equal((await u.status()).rebuild, false);
});

test("a build that failed does not keep the next update from merging what is new on main meanwhile", async () => {
  const w = world();
  w.fails.add("npm run");
  const { u, calls } = updater(w);
  await u.start(w.target.sha);
  assert.equal((await settled(u)).failed.step, "build");

  // The fix is on main: the checkout is behind again, and the build is still pending.
  w.fails.clear();
  w.ran.length = 0;
  w.target = commit("fff", "The fix");
  w.behind = 1;
  await u.start(commit("fff").sha);
  const run = await settled(u);
  assert.equal(run.state, "restarting");
  assert.deepEqual(run.steps.map((s) => s.state), ["done", "done", "done", "done", "running"]);
  assert.ok(w.ran.includes("git merge --ff-only refs/remotes/origin/main"));
  assert.equal((await u.status()).current.sha, commit("fff").sha);
  assert.equal(calls.restart, 1);
});

test("a merge git refuses fails the update before anything is built", async () => {
  const w = world();
  w.fails.add("git merge");
  const { u } = updater(w);
  await u.start(w.target.sha);
  const run = await settled(u);
  assert.equal(run.failed.step, "merge");
  assert.match(run.failed.output, /Not possible to fast-forward/);
  assert.ok(!w.ran.some((c) => c.startsWith("npm")));
  assert.equal((await u.status()).rebuild, false, "nothing was merged");
  // Free again: the next press is not told one is running.
  w.fails.clear();
  await u.start(w.target.sha);
});

test("a restart that cannot be made is a failed step, and the built portal stays up", async () => {
  const w = world({ restartFails: "The portal was not started from a file" });
  const { u } = updater(w);
  await u.start(w.target.sha);
  const run = await settled(u);
  assert.equal(run.state, "failed");
  assert.equal(run.failed.step, "restart");
  assert.match(run.failed.message, /not started from a file/);
});

test("the output of a failed step is its last lines, each cut short", () => {
  const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(tail(long).split("\n").length, 30);
  assert.equal(tail(long).split("\n").at(-1), "line 99");
  assert.equal(tail(`${"x".repeat(1000)}\n`).length, 301);
  assert.equal(tail("a\r\n\r\nb\r\n"), "a\nb");
});

test("new commits are counted from the checkout to origin/main, and the notice goes up once for each new target", async () => {
  const w = world();
  const { u, calls } = updater(w);
  assert.equal((await u.status()).notice, null, "nothing has been looked at");
  await u.refresh();
  const first = (await u.status()).notice;
  assert.equal(first.count, 2);
  assert.equal(first.target.sha, commit("ccc").sha);
  assert.ok(w.ran.includes("git rev-list --left-right --count HEAD...refs/remotes/origin/main"));
  assert.equal(calls.raised.length, 1);

  // The same target, looked at again: still shown, not raised again, and "since" is when it first was.
  await u.refresh();
  await u.check();
  assert.equal(calls.raised.length, 1);
  assert.equal((await u.status()).notice.since, first.since);

  // More commits: a new target, a new notice with the new count.
  w.target = commit("eee");
  w.behind = 3;
  await u.refresh();
  assert.equal(calls.raised.length, 2);
  assert.equal(calls.raised[1].count, 3);
  assert.equal((await u.status()).notice.count, 3);

  // Updated: nothing new, no notice; and nothing is raised for what is there already.
  w.head = w.target;
  w.behind = 0;
  await u.refresh();
  assert.equal((await u.status()).notice, null);
  assert.equal(calls.raised.length, 2);
});

test("a check that cannot reach the remote is logged and tried again, says nothing to the page, and keeps the notice", async () => {
  const w = world();
  const { u, calls } = updater(w);
  await u.refresh();
  assert.equal(calls.raised.length, 1);
  const warned = [];
  const was = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    w.fetchError = "fatal: unable to access";
    await u.refresh();
    assert.equal(warned.length, 1);
    assert.match(warned[0], /\[update\] could not check origin\/main/);
    const shown = await u.status();
    assert.equal(shown.notice.count, 2, "what was known stays");
    assert.ok(!("error" in shown) && !("problem" in shown), "nothing about the failure is on the page");
    // A git that fails altogether is the same: a line in the log, nothing thrown.
    w.exec = async () => { throw new Error("spawn git ENOENT"); };
    const broken = new Updater({ root: repo, exec: w.exec, artifacts: w.artifacts, running: () => 0, restart: async () => {}, inContainer: () => false, fromSource: () => false });
    await broken.refresh();
    assert.equal(warned.length, 2);
    // And the next time it works, it is raised as ever.
    w.fetchError = null;
  } finally {
    console.warn = was;
  }
  await u.refresh();
  assert.equal(calls.raised.length, 1, "the same target is not raised again after a failed check");
});

test("it is looked for at the start and then on a schedule, and not at all where nothing can be updated", async () => {
  const w = world();
  const { u } = updater(w);
  const stop = await u.begin(40, 5);
  const fetches = () => w.ran.filter((c) => c.startsWith("git fetch")).length;
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(fetches(), 1, "once at the start");
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(fetches() >= 3, "and again every interval");
  stop();
  const after = fetches();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fetches(), after, "until it is stopped");

  const idle = world();
  const { u: inImage } = updater(idle, { inContainer: () => true });
  const stopImage = await inImage.begin(5, 1);
  await new Promise((r) => setTimeout(r, 30));
  stopImage();
  assert.deepEqual(idle.ran, [], "a container's portal asks nothing");
});

test("the schedule leaves the remote alone while an update changes the checkout", async () => {
  let go;
  const w = world();
  w.gates.set("npm ci", new Promise((resolve) => (go = resolve)));
  const { u } = updater(w);
  await u.start(w.target.sha);
  while (!w.ran.includes("npm ci --prefer-offline --no-audit --no-fund")) await new Promise((r) => setTimeout(r, 2));
  const before = w.ran.length;
  await u.refresh();
  assert.equal(w.ran.length, before, "not asked while the update runs");
  go();
  await settled(u);
});

const files = (w) => w.ran.filter((c) => c.startsWith("files ") || /^(git merge|npm )/.test(c));

test("the old node_modules and build are put aside for their steps, put back where one fails, and thrown away only when the build has worked", async () => {
  // It works: aside for the install, aside for the build, the build written down, and only then thrown away.
  const ok = world();
  const first = updater(ok);
  await first.u.start(ok.target.sha);
  await settled(first.u);
  assert.deepEqual(files(ok), [
    "files markBuilt aaa if unknown",
    "git merge --ff-only refs/remotes/origin/main",
    "files keepModules",
    "npm ci --prefer-offline --no-audit --no-fund",
    "files keepBuild",
    "npm run build",
    "files markBuilt ccc",
    "files discard",
  ]);

  // The install fails: node_modules is put back, and the build was never touched.
  const install = world();
  install.fails.add("npm ci");
  const second = updater(install);
  await second.u.start(install.target.sha);
  assert.equal((await settled(second.u)).failed.step, "install");
  assert.deepEqual(files(install).slice(-3), ["files keepModules", "npm ci --prefer-offline --no-audit --no-fund", "files restore"]);
  assert.ok(!install.ran.includes("files keepBuild"));
  assert.ok(!install.ran.includes("files discard"));

  // The build fails: both are put back, node_modules with the build it belongs to.
  const build = world();
  build.fails.add("npm run");
  const third = updater(build);
  await third.u.start(build.target.sha);
  assert.equal((await settled(third.u)).failed.step, "build");
  assert.deepEqual(files(build).slice(-5), ["files keepModules", "npm ci --prefer-offline --no-audit --no-fund", "files keepBuild", "npm run build", "files restore"]);
  assert.ok(!build.ran.includes("files discard"));
  assert.ok(!build.ran.includes("files markBuilt ccc"), "a build that failed is not written down as made");
});

test("a failure is not said, and a second update not begun, until the old files are back", async () => {
  let back;
  const w = world();
  w.fails.add("npm run");
  w.artifacts.restore = () => new Promise((resolve) => (back = resolve));
  const { u } = updater(w);
  await u.start(w.target.sha);
  while (!back) await new Promise((r) => setTimeout(r, 2));
  // The build has failed and the old files are on their way back.
  assert.equal((await u.status()).run.state, "running", "not failed yet: the files a page would trust are not in place");
  assert.equal((await u.status()).run.failed, undefined);
  await refusal(u.start(w.target.sha), "busy");
  back();
  const run = await settled(u);
  assert.equal(run.state, "failed");
  assert.equal(run.failed.step, "build");
  assert.equal(run.steps.find((s) => s.id === "build").state, "failed");
  w.fails.clear();
  w.artifacts.restore = async () => {};
  await u.start(w.target.sha);
});

test("old files that cannot be put back are said, with the failure", async () => {
  const w = world();
  w.fails.add("npm ci");
  w.artifacts.restore = async () => { throw new Error("EACCES: permission denied, rename node_modules.update-old"); };
  const { u } = updater(w);
  await u.start(w.target.sha);
  const run = await settled(u);
  assert.equal(run.failed.step, "install");
  assert.match(run.failed.message, /npm ci failed.*The old files could not be put back: EACCES/);
});

test("that the build is not of the checked out commit is read from what is written down, so that a restart keeps it", async () => {
  const w = world();
  w.fails.add("npm run");
  const first = updater(w);
  await first.u.start(w.target.sha);
  assert.equal((await settled(first.u)).failed.step, "build");

  // The portal is started again: no memory of the run, the same files. It does not say it is up to date.
  const again = updater(w).u;
  assert.equal((await again.status()).rebuild, true);
  const seen = await again.check();
  assert.equal(seen.behind, 0);
  assert.equal(seen.rebuild, true);
  w.fails.clear();
  w.ran.length = 0;
  await again.start(w.target.sha);
  const run = await settled(again);
  assert.equal(run.state, "restarting");
  assert.deepEqual(run.steps.map((s) => s.state), ["done", "skipped", "done", "done", "running"]);
  assert.equal((await updater(w).u.status()).rebuild, false, "written down once it has worked");

  // A portal whose build has never been written down is not told it needs one.
  const fresh = world();
  fresh.head = fresh.target;
  fresh.behind = 0;
  const idle = updater(fresh).u;
  assert.equal((await idle.status()).rebuild, false);
  await refusal(idle.start(fresh.target.sha), "current");
});

test("a portal that runs from its source files under a watcher is not updated: the watcher would restart it halfway", async () => {
  const w = world();
  const { u } = updater(w, { fromSource: () => true });
  assert.equal(await u.kind(), "dev");
  assert.deepEqual(await u.status(), { kind: "dev" });
  const e = await refusal(u.check(), "unavailable", 404);
  assert.match(e.message, /file watcher/);
  await refusal(u.start(w.target.sha), "unavailable", 404);
  const stop = await u.begin(5, 1);
  await new Promise((r) => setTimeout(r, 30));
  stop();
  assert.deepEqual(w.ran, [], "nothing is asked of git, merged or built");
});

test("running from source files, or under node's watch, is told from the file and the flags", async () => {
  const { runsFromSource } = await import("../dist/update.js");
  assert.equal(runsFromSource("file:///srv/pithagoras/server/src/update.ts", []), true, "tsx watch src/index.ts");
  assert.equal(runsFromSource("file:///srv/pithagoras/server/dist/update.js", ["--watch"]), true);
  assert.equal(runsFromSource("file:///srv/pithagoras/server/dist/update.js", ["--watch-path=server/dist"]), true);
  assert.equal(runsFromSource("file:///srv/pithagoras/server/dist/update.js", ["--enable-source-maps", "--watch-kill-signal=SIGTERM"]), false, "the test runner passes its defaults on");
  assert.equal(runsFromSource("file:///srv/pithagoras/server/dist/update.js", []), false, "the built portal");
  assert.equal(runsFromSource(), false, "this test runs the built one");
});

test("a portal that would not come back after the restart is not updated, and the reason is said before anything changes", async () => {
  const w = world();
  const why = "The portal runs as the systemd service pithagoras.service, which is set to Restart=no, so it would not be started again.";
  const { u, calls } = updater(w, { restartProblem: async () => why });
  const seen = await u.check();
  assert.deepEqual(seen.problem, { code: "restart", message: why });
  const e = await refusal(u.start(w.target.sha), "restart");
  assert.equal(e.message, why);
  assert.deepEqual(changesTheCheckout(w), []);
  assert.deepEqual(w.ran.filter((c) => c.startsWith("files")), []);
  assert.equal(calls.restart, 0);

  // Where it would, nothing is said.
  const fine = updater(world(), { restartProblem: async () => null });
  assert.equal((await fine.u.check()).problem, null);
});

test("the update needs the commit that was confirmed: without it nothing is started", async () => {
  const w = world();
  const { u } = updater(w);
  for (const expect of [undefined, null, "", 7, {}, ["ccc"]]) {
    const e = await refusal(u.start(expect), "invalid", 400);
    assert.match(e.message, /expect/);
  }
  assert.deepEqual(w.ran.filter((c) => !c.startsWith("git rev-parse")), [], "no git, no merge, no build");
  // And the next press is not told one is running.
  await u.start(w.target.sha);
});

test("the failure says whether the old files are back: they are where nothing was put aside or what was has been put back, and not after the restart or a restore that failed", async () => {
  const failure = async (setup) => {
    const w = world();
    setup(w);
    const { u } = updater(w);
    await u.start(w.target.sha);
    return (await settled(u)).failed;
  };
  const merge = await failure((w) => w.fails.add("git merge"));
  assert.deepEqual([merge.step, merge.oldFilesBack], ["merge", true], "nothing was put aside");
  const install = await failure((w) => w.fails.add("npm ci"));
  assert.deepEqual([install.step, install.oldFilesBack], ["install", true]);
  const build = await failure((w) => w.fails.add("npm run"));
  assert.deepEqual([build.step, build.oldFilesBack], ["build", true]);

  // The restore itself fails: the files are not back, whatever the step was.
  const lost = await failure((w) => {
    w.fails.add("npm run");
    w.artifacts.restore = async () => { throw new Error("EACCES"); };
  });
  assert.deepEqual([lost.step, lost.oldFilesBack], ["build", false]);
  assert.match(lost.message, /could not be put back/);

  // The restart: the new build has replaced the old files by then.
  const restart = await failure((w) => (w.restartFails = "The portal was not started from a file"));
  assert.deepEqual([restart.step, restart.oldFilesBack], ["restart", false]);
  assert.ok(true);
});

test("what fails after the build is said from what happened to the old files, not from the step", async () => {
  const failure = async (setup) => {
    const w = world();
    setup(w);
    const { u } = updater(w);
    await u.start(w.target.sha);
    return { failed: (await settled(u)).failed, w };
  };
  // The record cannot be written after the build: the old files are put back, and the build is what failed.
  let marks = 0;
  const record = await failure((w) => {
    const mark = w.artifacts.markBuilt;
    w.artifacts.markBuilt = async (...args) => { if (++marks === 2) throw new Error("ENOSPC: no space left on device"); return mark(...args); };
  });
  assert.deepEqual([record.failed.step, record.failed.oldFilesBack], ["build", true]);
  assert.match(record.failed.message, /ENOSPC/);
  assert.ok(record.w.ran.includes("files restore"));
  assert.ok(!record.w.ran.includes("files discard"), "nothing was thrown away");

  // The old files cannot be thrown away: the new build is the one in place, and they are not back.
  const discard = await failure((w) => {
    w.artifacts.discard = async () => { throw new Error("EBUSY: rm node_modules.update-old"); };
  });
  assert.deepEqual([discard.failed.step, discard.failed.oldFilesBack], ["build", false]);

  // The restart fails: the build has replaced them.
  const restart = await failure((w) => (w.restartFails = "The portal was not started from a file"));
  assert.deepEqual([restart.failed.step, restart.failed.oldFilesBack], ["restart", false]);
});
