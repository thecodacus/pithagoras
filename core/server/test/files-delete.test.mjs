import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// A home of its own: who commits, and no config of the person running the tests.
const home = inProcessHome("pithagoras-files-delete-");
process.env.HOME = home;
process.env.GIT_CONFIG_GLOBAL = path.join(home, ".gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Tester\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n");

const { default: express } = await import("express");
const { filesRouter } = await import("../dist/api/files.js");
const { createSession } = await import("../dist/db.js");

const work = path.join(home, "work");
mkdirSync(work);
createSession({ id: "del", title: "del", workspace: work, executor: "host" });

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
let n = 0;
/** A clone in the chat's folder, of a repository that has one commit. */
function clone(name) {
  const origin = path.join(home, `origin${++n}`);
  mkdirSync(origin);
  sh(origin, "init", "-q");
  writeFileSync(path.join(origin, "a.txt"), "one\n");
  sh(origin, "add", "-A");
  sh(origin, "commit", "-qm", "first");
  const dir = path.join(work, name);
  execFileSync("git", ["clone", "-q", origin, dir]);
  return dir;
}
/** One commit that no remote has. */
function commitHere(dir) {
  writeFileSync(path.join(dir, "a.txt"), "only here\n");
  sh(dir, "commit", "-qam", "only here");
}

async function withApi(fn) {
  const app = express();
  app.use(express.json());
  app.use("/api", filesRouter());
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/sessions/del`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}
const del = (base, p, query = "") =>
  fetch(`${base}/file?path=${encodeURIComponent(p)}${query}`, { method: "DELETE" }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

test("a clone with commits no remote has is refused with what it holds, and goes when that is meant", async () => {
  await withApi(async (base) => {
    const dir = clone("api");
    commitHere(dir);
    writeFileSync(path.join(dir, "b.txt"), "b\n");
    sh(dir, "add", "b.txt");
    const refused = await del(base, "api");
    assert.equal(refused.status, 409);
    assert.equal(refused.code, "unsaved-work");
    assert.deepEqual(refused.unsaved, { changed: 1, unpushed: 1, stashes: 0 });
    assert.equal(existsSync(dir), true);
    // Only ?discard=1 says it: anything else is not that.
    assert.equal((await del(base, "api", "&discard=0")).status, 409);
    assert.equal(existsSync(dir), true);

    assert.deepEqual(await del(base, "api", "&discard=1"), { status: 200, ok: true });
    assert.equal(existsSync(dir), false);
  });
});

test("a repository's .git is refused as not told apart, and goes only when that is meant", async () => {
  await withApi(async (base) => {
    const dir = clone("lib");
    writeFileSync(path.join(dir, "new.txt"), "not committed\n");
    const refused = await del(base, "lib/.git");
    assert.equal(refused.status, 409);
    assert.equal(refused.code, "unsaved-work");
    assert.deepEqual(refused.unsaved, { changed: 0, unpushed: 0, stashes: 0, unknown: true });
    assert.equal(existsSync(path.join(dir, ".git")), true);

    await del(base, "lib/.git", "&discard=1");
    assert.equal(existsSync(path.join(dir, ".git")), false);
    assert.equal(existsSync(path.join(dir, "new.txt")), true);
  });
});

test("what holds nothing of its own goes without being asked: files, plain folders, a clone that is saved", async () => {
  await withApi(async (base) => {
    const dir = clone("saved");
    writeFileSync(path.join(dir, "a.txt"), "edited\n");
    // A file, even one with changes in a repository: that is what was picked.
    assert.equal((await del(base, "saved/a.txt")).status, 200);
    mkdirSync(path.join(work, "plain", "deep"), { recursive: true });
    writeFileSync(path.join(work, "plain", "deep", "x.txt"), "x");
    assert.equal((await del(base, "plain")).status, 200);
    // Pushed, committed: the origin has all of it.
    sh(dir, "checkout", "-q", "--", ".");
    assert.equal((await del(base, "saved")).status, 200);
    assert.equal(existsSync(dir), false);
  });
});

test("what a delete would lose can be asked first, so the question names it", async () => {
  await withApi(async (base) => {
    const dir = clone("asked");
    commitHere(dir);
    const ask = (p) => fetch(`${base}/unsaved?path=${encodeURIComponent(p)}`).then(async (r) => ({ status: r.status, ...(await r.json()) }));
    assert.deepEqual(await ask("asked"), { status: 200, unsaved: { changed: 0, unpushed: 1, stashes: 0 } });
    assert.deepEqual(await ask("asked/a.txt"), { status: 200, unsaved: null });
    assert.equal((await ask("gone")).status, 404);
    assert.equal((await ask("../outside")).status, 400);
    assert.equal(existsSync(dir), true);
  });
});

test("a refusal for another reason is not taken for unsaved work", async () => {
  await withApi(async (base) => {
    const res = await del(base, "nothing-here");
    assert.equal(res.status, 404);
    // Every refusal names its kind; only "unsaved" is the question about work that would be lost.
    assert.equal(res.code, "missing");
  });
});
