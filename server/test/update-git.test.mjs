import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The update against real repositories: an origin and a checkout of it in a temp folder, with the real git and a
 * build of the test's own. The fake git of update.test.mjs cannot say that the commands are the ones git understands.
 */
const home = inProcessHome("pithagoras-update-git-");
const { Updater, UpdateError, realExec } = await import("../dist/update.js");
console.log = console.error = () => {};

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const origin = path.join(home, "origin.git");
const seed = path.join(home, "seed");
git(home, "init", "--bare", "-b", "main", origin);
git(home, "clone", origin, seed);
git(seed, "checkout", "-b", "main");
writeFileSync(path.join(seed, "package.json"), JSON.stringify({ name: "pithagoras", version: "0.0.0" }));
mkdirSync(path.join(seed, "server"));
writeFileSync(path.join(seed, "server", "package.json"), "{}");
writeFileSync(path.join(seed, "notes.txt"), "first\n");
git(seed, "add", ".");
git(seed, "commit", "-m", "First");
git(seed, "push", "origin", "main");

let n = 0;
/** A new checkout of the origin, and an updater for it with a build that only writes down what it was asked. */
function portal(clone = []) {
  const dir = path.join(home, `portal-${++n}`);
  git(home, "clone", ...clone, origin, dir);
  const built = [];
  const real = realExec(dir);
  let restarts = 0;
  const u = new Updater({
    root: dir,
    exec: (command, args, options) => (command === "npm" ? Promise.resolve({ code: 0, stdout: "", output: "" }).then((r) => (built.push(args.join(" ")), r)) : real(command, args, options)),
    running: () => 0,
    restart: async () => void restarts++,
    inContainer: () => false,
  });
  return { dir, u, built, restarts: () => restarts };
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
  assert.equal(git(p.dir, "status", "--porcelain"), "");
});

test("a checkout with a change to a tracked file is left as it is; a file git does not track is no change", async () => {
  const p = portal();
  const newest = publish("c.txt", "c\n");
  writeFileSync(path.join(p.dir, "notes.txt"), "edited here\n");
  await refused(p.u.start(), "dirty");
  assert.equal(readFileSync(path.join(p.dir, "notes.txt"), "utf8"), "edited here\n");
  assert.notEqual(git(p.dir, "rev-parse", "HEAD"), newest);
  assert.deepEqual(p.built, []);

  git(p.dir, "checkout", "notes.txt");
  writeFileSync(path.join(p.dir, "scratch.log"), "not tracked\n");
  await p.u.start();
  assert.equal((await settled(p.u)).state, "restarting");
  assert.equal(git(p.dir, "rev-parse", "HEAD"), newest);
  assert.equal(readFileSync(path.join(p.dir, "scratch.log"), "utf8"), "not tracked\n");
});

test("a checkout on no branch, or with commits of its own, is left as it is", async () => {
  const p = portal();
  publish("d.txt", "d\n");
  git(p.dir, "checkout", "--detach");
  await refused(p.u.start(), "detached");

  git(p.dir, "checkout", "main");
  writeFileSync(path.join(p.dir, "mine.txt"), "mine\n");
  git(p.dir, "add", ".");
  git(p.dir, "commit", "-m", "Mine");
  const mine = git(p.dir, "rev-parse", "HEAD");
  await refused(p.u.start(), "diverged");
  assert.equal(git(p.dir, "rev-parse", "HEAD"), mine);
  assert.deepEqual(p.built, []);
});

test("a checkout that is up to date has nothing to update to", async () => {
  const p = portal();
  await p.u.check();
  await refused(p.u.start(), "current");
});

test("an origin that cannot be reached is a problem to tell, with the checkout as it was", async () => {
  const p = portal();
  git(p.dir, "remote", "set-url", "origin", path.join(home, "no-such-origin.git"));
  const seen = await p.u.check();
  assert.equal(seen.problem.code, "fetch");
  await refused(p.u.start(), "fetch");
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
