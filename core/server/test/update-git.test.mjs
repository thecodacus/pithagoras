import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The update against real repositories: an origin and a checkout of it in a temp folder, with the real git and a
 * build of the test's own. The fake git of update.test.mjs cannot say that the commands are the ones git understands.
 */
const home = inProcessHome("pithagoras-update-git-");
const { Updater, UpdateError, realExec } = await import("../dist/update.js");
const { fileArtifacts } = await import("../dist/update-files.js");
console.log = console.error = () => {};

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const origin = path.join(home, "origin.git");
const seed = path.join(home, "seed");
git(home, "init", "--bare", "-b", "main", origin);
git(home, "clone", origin, seed);
git(seed, "checkout", "-b", "main");
writeFileSync(path.join(seed, "package.json"), JSON.stringify({ name: "pithagoras", version: "0.0.0" }));
mkdirSync(path.join(seed, "core", "server"), { recursive: true });
writeFileSync(path.join(seed, "core", "server", "package.json"), "{}");
writeFileSync(path.join(seed, "notes.txt"), "first\n");
// What the repository ignores of a build, as it does: the build is not a change to the checkout.
writeFileSync(path.join(seed, ".gitignore"), "node_modules/\ndist/\n*.update-old\n");
git(seed, "add", ".");
git(seed, "commit", "-m", "First");
git(seed, "push", "origin", "main");

let n = 0;
/**
 * A new checkout of the origin with a build in it, and an updater for it with an install and a build that only write
 * down what they make: `npm.fails` is the step that fails, after it has written something half way.
 */
function portal(clone = [], wrap = (files) => files) {
  const dir = path.join(home, `portal-${++n}`);
  git(home, "clone", ...clone, origin, dir);
  for (const [folder, file] of [["node_modules", "dep.txt"], ["core/server/dist", "index.js"], ["core/web/dist", "index.html"]]) {
    mkdirSync(path.join(dir, folder), { recursive: true });
    writeFileSync(path.join(dir, folder, file), "old");
  }
  const built = [];
  const npm = { fails: undefined };
  const real = realExec(dir);
  let restarts = 0;
  const make = (folder, file, text) => {
    mkdirSync(path.join(dir, folder), { recursive: true });
    writeFileSync(path.join(dir, folder, file), text);
  };
  const updater = () => new Updater({
    root: dir,
    exec: async (command, args, options) => {
      if (command === "git") return real(command, args, options);
      built.push(args.join(" "));
      const step = args[0] === "ci" ? "ci" : "build";
      if (step === "ci") make("node_modules", "dep.txt", "new");
      else {
        make("core/server/dist", "index.js", "new");
        make("core/web/dist", "partial.js", "half");
      }
      return npm.fails === step ? { code: 1, stdout: "", output: `${step} failed` } : { code: 0, stdout: "", output: "" };
    },
    artifacts: wrap(fileArtifacts(dir)),
    running: () => 0,
    restart: async () => void restarts++,
    inContainer: () => false,
    fromSource: () => false,
  });
  return { dir, u: updater(), again: updater, built, npm, restarts: () => restarts };
}
/** A commit on origin's main, made from the seed. */
function publish(file, text, message = `Change ${file}`) {
  git(seed, "checkout", "main");
  writeFileSync(path.join(seed, file), text);
  git(seed, "add", ".");
  git(seed, "commit", "-m", message);
  git(seed, "push", "origin", "main");
  return git(seed, "rev-parse", "HEAD");
}
const settled = async (u) => {
  for (let i = 0; i < 400; i++) {
    const run = (await u.status()).run;
    if (run && run.state !== "running") return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("the run did not settle");
};
const refused = async (promise, code) => {
  const e = await promise.then(() => assert.fail("it was not refused"), (err) => err);
  assert.ok(e instanceof UpdateError, e.message);
  assert.equal(e.code, code, e.message);
};

test("a clean checkout behind origin/main moves to it, builds, and restarts", async () => {
  const p = portal();
  assert.equal(await p.u.kind(), "git");
  const before = git(p.dir, "rev-parse", "HEAD");
  publish("a.txt", "a\n", "Second");
  const newest = publish("b.txt", "b\n", "Third");
  const seen = await p.u.check();
  assert.equal(seen.behind, 2);
  assert.equal(seen.branch, "main");
  assert.equal(seen.current.sha, before);
  assert.equal(seen.target.sha, newest);
  assert.equal(seen.target.subject, "Third");
  assert.equal(seen.problem, null);
  assert.equal(git(p.dir, "rev-parse", "HEAD"), before, "looking changes nothing");

  await p.u.start(newest);
  const run = await settled(p.u);
  assert.equal(run.state, "restarting", JSON.stringify(run.failed));
  assert.equal(git(p.dir, "rev-parse", "HEAD"), newest);
  assert.equal(readFileSync(path.join(p.dir, "b.txt"), "utf8"), "b\n");
  assert.deepEqual(p.built, ["ci --prefer-offline --no-audit --no-fund", "run build"]);
  assert.equal(p.restarts(), 1);
  assert.equal(git(p.dir, "status", "--porcelain"), "", "the build is not a change to the checkout");
  // What was built is the new files, of the new commit, and none of the old ones is left aside.
  assert.equal(readFileSync(path.join(p.dir, "node_modules/dep.txt"), "utf8"), "new");
  assert.equal(readFileSync(path.join(p.dir, "core/server/dist/index.js"), "utf8"), "new");
  assert.equal(JSON.parse(readFileSync(path.join(p.dir, "core/server/dist/.built-from"), "utf8")).sha, newest);
  for (const aside of ["node_modules.update-old", "core/server/dist.update-old", "core/web/dist.update-old"]) assert.equal(existsSync(path.join(p.dir, aside)), false, aside);
  assert.equal((await p.again().status()).rebuild, false);
});

test("a build that fails leaves the old node_modules and build in place, and a portal started again is still told to build", async () => {
  const p = portal();
  const before = git(p.dir, "rev-parse", "HEAD");
  const newest = publish("f.txt", "f\n");
  p.npm.fails = "build";
  await p.u.start(newest);
  const run = await settled(p.u);
  assert.equal(run.failed.step, "build");
  // The checkout is at the new commit; the files are the old ones, with what the failed step wrote gone.
  assert.equal(git(p.dir, "rev-parse", "HEAD"), newest);
  assert.equal(readFileSync(path.join(p.dir, "node_modules/dep.txt"), "utf8"), "old");
  assert.equal(readFileSync(path.join(p.dir, "core/server/dist/index.js"), "utf8"), "old");
  assert.equal(readFileSync(path.join(p.dir, "core/web/dist/index.html"), "utf8"), "old");
  assert.equal(existsSync(path.join(p.dir, "core/web/dist/partial.js")), false);
  assert.equal(JSON.parse(readFileSync(path.join(p.dir, "core/server/dist/.built-from"), "utf8")).sha, before, "the old build is still of the old commit");
  assert.equal(p.restarts(), 0);

  // The portal is started again, as after a reboot: nothing in memory, the same files on disk.
  const restarted = p.again();
  assert.equal((await restarted.status()).rebuild, true);
  const seen = await restarted.check();
  assert.equal(seen.behind, 0);
  assert.equal(seen.rebuild, true);
  p.npm.fails = undefined;
  await restarted.start(newest);
  const second = await settled(restarted);
  assert.equal(second.state, "restarting", JSON.stringify(second.failed));
  assert.deepEqual(second.steps.map((s) => s.state), ["done", "skipped", "done", "done", "running"]);
  assert.equal(readFileSync(path.join(p.dir, "core/server/dist/index.js"), "utf8"), "new");
  assert.equal(JSON.parse(readFileSync(path.join(p.dir, "core/server/dist/.built-from"), "utf8")).sha, newest);
});

test("a build made on the host after an update is not told to be built again", async () => {
  const p = portal();
  const second = publish("h.txt", "h\n");
  await p.u.start(second);
  assert.equal((await settled(p.u)).state, "restarting");
  assert.equal((await p.again().status()).rebuild, false);

  // `git pull --ff-only && npm ci && npm run build` by hand, as when Update refused for a dirty checkout: the build
  // is made again, and the record the update wrote is of the commit before.
  const third = publish("i.txt", "i\n");
  git(p.dir, "pull", "-q", "--ff-only", "origin", "main");
  assert.equal(git(p.dir, "rev-parse", "HEAD"), third);
  const file = path.join(p.dir, "core/server/dist/index.js");
  writeFileSync(file, "built by hand");
  const later = new Date(Date.now() + 5000);
  utimesSync(file, later, later);

  const restarted = p.again();
  assert.equal((await restarted.status()).rebuild, false);
  const seen = await restarted.check();
  assert.equal(seen.behind, 0);
  assert.equal(seen.rebuild, false);
  await refused(restarted.start(third), "current");
  assert.deepEqual(p.built, ["ci --prefer-offline --no-audit --no-fund", "run build"], "nothing was built again");
});

test("a record that cannot be written after the build leaves the old files in place, and says the build failed", async () => {
  // The disk fills up while the build runs, and the build just fits: the record of it cannot be written.
  let marks = 0;
  const p = portal([], (files) => ({
    ...files,
    markBuilt: async (sha, onlyIfUnknown) => {
      if (++marks === 2) throw new Error("ENOSPC: no space left on device, write");
      return files.markBuilt(sha, onlyIfUnknown);
    },
  }));
  const newest = publish("j.txt", "j\n");
  await p.u.start(newest);
  const run = await settled(p.u);
  assert.equal(run.state, "failed");
  // Not the restart's: nothing was thrown away, and the old files are what is in place.
  assert.equal(run.failed.step, "build");
  assert.equal(run.failed.oldFilesBack, true);
  assert.match(run.failed.message, /ENOSPC/);
  assert.equal(readFileSync(path.join(p.dir, "node_modules/dep.txt"), "utf8"), "old");
  assert.equal(readFileSync(path.join(p.dir, "core/server/dist/index.js"), "utf8"), "old");
  assert.equal(readFileSync(path.join(p.dir, "core/web/dist/index.html"), "utf8"), "old");
  assert.equal(p.restarts(), 0);
  assert.equal((await p.again().status()).rebuild, true, "and the build to do is still told");
});

test("an install that fails leaves the old node_modules in place", async () => {
  const p = portal();
  const newest = publish("g.txt", "g\n");
  p.npm.fails = "ci";
  await p.u.start(newest);
  assert.equal((await settled(p.u)).failed.step, "install");
  assert.equal(readFileSync(path.join(p.dir, "node_modules/dep.txt"), "utf8"), "old");
  assert.equal(readFileSync(path.join(p.dir, "core/server/dist/index.js"), "utf8"), "old");
  assert.deepEqual(p.built, ["ci --prefer-offline --no-audit --no-fund"], "no build on top of it");
});

test("a checkout with a change to a tracked file is left as it is; a file git does not track is no change", async () => {
  const p = portal();
  const newest = publish("c.txt", "c\n");
  writeFileSync(path.join(p.dir, "notes.txt"), "edited here\n");
  await refused(p.u.start(newest), "dirty");
  assert.equal(readFileSync(path.join(p.dir, "notes.txt"), "utf8"), "edited here\n");
  assert.notEqual(git(p.dir, "rev-parse", "HEAD"), newest);
  assert.deepEqual(p.built, []);

  git(p.dir, "checkout", "notes.txt");
  writeFileSync(path.join(p.dir, "scratch.log"), "not tracked\n");
  await p.u.start(newest);
  assert.equal((await settled(p.u)).state, "restarting");
  assert.equal(git(p.dir, "rev-parse", "HEAD"), newest);
  assert.equal(readFileSync(path.join(p.dir, "scratch.log"), "utf8"), "not tracked\n");
});

test("a checkout on no branch, or with commits of its own, is left as it is", async () => {
  const p = portal();
  const newest = publish("d.txt", "d\n");
  git(p.dir, "checkout", "--detach");
  await refused(p.u.start(newest), "detached");

  git(p.dir, "checkout", "main");
  writeFileSync(path.join(p.dir, "mine.txt"), "mine\n");
  git(p.dir, "add", ".");
  git(p.dir, "commit", "-m", "Mine");
  const mine = git(p.dir, "rev-parse", "HEAD");
  await refused(p.u.start(newest), "diverged");
  assert.equal(git(p.dir, "rev-parse", "HEAD"), mine);
  assert.deepEqual(p.built, []);
});

test("a checkout that is up to date has nothing to update to", async () => {
  const p = portal();
  const seen = await p.u.check();
  await refused(p.u.start(seen.target.sha), "current");
});

test("an origin that cannot be reached is a problem to tell, with the checkout as it was", async () => {
  const p = portal();
  git(p.dir, "remote", "set-url", "origin", path.join(home, "no-such-origin.git"));
  const seen = await p.u.check();
  assert.equal(seen.problem.code, "fetch");
  await refused(p.u.start("a".repeat(40)), "fetch");
  assert.deepEqual(p.built, []);
});

test("a clone of another branch only still sees origin/main", async () => {
  git(seed, "checkout", "main");
  git(seed, "branch", "-f", "older", "HEAD");
  git(seed, "push", "-f", "origin", "older");
  const newest = publish("e.txt", "e\n");
  const p = portal(["--single-branch", "--branch", "older"]);
  // The clone knows no origin/main: it takes the one asked for by name.
  assert.equal(git(p.dir, "branch", "--show-current"), "older");
  const seen = await p.u.check();
  assert.equal(seen.target.sha, newest);
  assert.equal(seen.problem, null);
});
