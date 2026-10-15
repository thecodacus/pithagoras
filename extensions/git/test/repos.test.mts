import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scratch } from "../../../tests/helpers.mts";

// A home of its own: who commits, and no config of the person running the tests.
const home = scratch("pithagoras-git-repos-");
process.env.HOME = home;
process.env.GIT_CONFIG_GLOBAL = path.join(home, ".gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
// Nor the repository that the temp folder may lie in.
process.env.GIT_CEILING_DIRECTORIES = path.dirname(home);
writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Tester\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n");

const { default: express } = await import("express");
// The Git extension: its git, run by the portal's own runner, and its server half, given a portal as the portal gives
// it one: each chat's folder as the portal finds it, a path checked inside it as the portal checks one, and git.
const g = await import("../src/git.ts");
const { default: gitServer } = await import("../src/server.ts");
const { gitAt } = await import("../../../core/server/src/git.ts");
const { baseDir, resolveInside } = await import("../../../core/server/src/workspace-files.ts");
g.useGit(gitAt);
const folders = new Map();

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
let n = 0;
/** A repository with one commit, a file `tag.txt` saying which it is. */
function repo(dir, branch) {
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", branch);
  writeFileSync(path.join(dir, "tag.txt"), `${branch}\n`);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "first");
  return dir;
}
/** A chat in a folder of its own. */
function chat() {
  const work = path.join(home, `work${++n}`);
  mkdirSync(work);
  folders.set(`s${n}`, work);
  return { id: `s${n}`, work };
}

async function withApi(fn) {
  const router = express.Router();
  gitServer({
    router,
    http: { json: express.json },
    chats: {
      folder: (id) => {
        if (!folders.has(id)) throw new Error("No such chat");
        return baseDir(folders.get(id));
      },
    },
    files: { inside: resolveInside },
    git: { at: gitAt },
  });
  const app = express();
  app.use("/api/x/pithagoras-git", router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/x/pithagoras-git/chats`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}
const get = (url) => fetch(url).then(async (r) => ({ status: r.status, ...(await r.json()) }));

test("clones below the folder are found, the repository around it first, and none looked into further", async () => {
  const { work } = chat();
  repo(work, "outer");
  repo(path.join(work, "tools", "lib"), "lib");
  repo(path.join(work, "app"), "app");
  // Inside a clone: not listed, a clone's own business.
  repo(path.join(work, "app", "vendored", "inner"), "inner");
  // Not looked into: what is only built, and what is hidden.
  repo(path.join(work, "node_modules", "dep"), "dep");
  repo(path.join(work, ".cache", "x"), "x");
  const found = await g.findRepos(work);
  assert.deepEqual(found.repos.map((r) => r.path), ["", "app", "tools/lib"]);
  assert.equal(found.truncated, false);
});

test("a folder in no repository lists only the clones in it, and a link is not followed", async () => {
  const { work } = chat();
  const elsewhere = repo(path.join(home, `elsewhere${n}`), "else");
  repo(path.join(work, "a"), "a");
  symlinkSync(elsewhere, path.join(work, "link"));
  assert.deepEqual((await g.findRepos(work)).repos, [{ path: "a", name: "a" }]);
});

test("a tree too deep or with too many clones is cut, and says so", async () => {
  const { work } = chat();
  // Deeper than a scan goes: not found, and not a reason to say it was cut short.
  repo(path.join(work, "a", "b", "c", "d", "e", "deep"), "deep");
  assert.deepEqual((await g.findRepos(work)).repos, []);
  // Folders with a HEAD, objects and refs, which is all the scan reads of a clone: it does not start git for each.
  for (let i = 0; i < 52; i++) {
    const dotGit = path.join(work, `r${String(i).padStart(2, "0")}`, ".git");
    mkdirSync(path.join(dotGit, "objects"), { recursive: true });
    mkdirSync(path.join(dotGit, "refs"));
    writeFileSync(path.join(dotGit, "HEAD"), "ref: refs/heads/main\n");
  }
  const many = await g.findRepos(work);
  assert.equal(many.repos.length, 50);
  assert.equal(many.truncated, true);
});

test("the depth and the folder limits are where the docs say: four levels, 4000 folders", async () => {
  const { work } = chat();
  // Four levels below the folder is found, five is not, and nothing was cut that a scan would have reached.
  repo(path.join(work, "a", "b", "c", "d"), "four");
  repo(path.join(work, "a", "b", "c", "d", "e"), "five-inside");
  repo(path.join(work, "p", "q", "r", "s", "t"), "five");
  const bounded = await g.findRepos(work);
  assert.deepEqual(bounded.repos.map((r) => r.path), ["a/b/c/d"]);
  assert.equal(bounded.truncated, false);

  // More folders than a scan reads: it stops and says so, rather than walking on.
  const { work: wide } = chat();
  for (let i = 0; i < 4100; i++) mkdirSync(path.join(wide, `f${String(i).padStart(4, "0")}`));
  const cut = await g.findRepos(wide);
  assert.equal(cut.truncated, true);
});

test("an empty or broken .git is not a repository: it is not listed, and ?repo= refuses it", async () => {
  const { id, work } = chat();
  repo(work, "outer");
  mkdirSync(path.join(work, "empty", ".git"), { recursive: true });
  repo(path.join(work, "real"), "real");
  mkdirSync(path.join(work, "plain"));
  await withApi(async (base) => {
    const url = `${base}/${id}`;
    assert.deepEqual((await get(`${url}/repos`)).repos.map((r) => r.path), ["", "real"]);
    // Git works in the repository around such a folder, so a route given it would act on that one.
    for (const repoName of ["empty", "plain"]) {
      const r = await get(`${url}?repo=${repoName}`);
      assert.equal(r.status, 404);
      assert.equal(r.branch, undefined);
      assert.equal((await get(`${url}/log?repo=${repoName}`)).status, 404);
    }
    assert.equal((await get(`${url}?repo=real`)).branch, "real");
  });
});

/** The clone `real` and one folder made by `make`: only the clone is listed, through the function and the route. */
async function onlyRealListed(make) {
  const { id, work } = chat();
  repo(path.join(work, "real"), "real");
  make(path.join(work, "odd"));
  assert.deepEqual((await g.findRepos(work)).repos.map((r) => r.path), ["real"]);
  await withApi(async (base) => {
    assert.deepEqual((await get(`${base}/${id}/repos`)).repos.map((r) => r.path), ["real"]);
  });
}

test("a .git file naming a git dir that is gone is not listed, as a worktree left by a deleted clone is", async () => {
  await onlyRealListed((dir) => {
    mkdirSync(dir);
    writeFileSync(path.join(dir, ".git"), `gitdir: ${path.join(home, "no-such-clone", ".git", "worktrees", "odd")}\n`);
  });
});

test("a .git file that is not a gitfile is not listed", async () => {
  await onlyRealListed((dir) => {
    mkdirSync(dir);
    writeFileSync(path.join(dir, ".git"), "nonsense\n");
  });
});

test("a .git folder with only a HEAD is not listed", async () => {
  await onlyRealListed((dir) => {
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  });
});

test("a worktree and a submodule are listed: their .git file names a git dir that exists", async () => {
  const { work } = chat();
  const main = repo(path.join(work, "main"), "main");
  sh(main, "worktree", "add", "-q", path.join(work, "wt"), "-b", "side");
  const dep = repo(path.join(work, "dep-src"), "dep");
  sh(main, "-c", "protocol.file.allow=always", "submodule", "add", "-q", dep, "sub");
  assert.deepEqual((await g.findRepos(work)).repos.map((r) => r.path), ["dep-src", "main", "wt"]);
  // The submodule sits inside main, which is listed itself and not looked into.
  assert.equal(await g.isRepoRoot(path.join(main, "sub")), true);
  // Scanned from the superproject, the submodule is listed: its gitdir is relative (`../.git/modules/sub`), and
  // it is resolved against the folder of the .git file, not the server's.
  assert.deepEqual((await g.findRepos(main)).repos.map((r) => r.path), ["", "sub"]);
});

test("the routes work in the clone ?repo= names, and refuse a path out of the folder", async () => {
  const { id, work } = chat();
  repo(work, "outer");
  repo(path.join(work, "tools", "lib"), "lib");
  writeFileSync(path.join(work, "tools", "lib", "tag.txt"), "changed\n");
  await withApi(async (base) => {
    const url = `${base}/${id}`;
    assert.deepEqual((await get(`${url}/repos`)).repos.map((r) => r.path), ["", "tools/lib"]);

    // Without it, the repository the folder is in, which holds the clone as it does any folder.
    const outer = await get(url);
    assert.equal(outer.branch, "outer");
    assert.equal(outer.root, work);
    // With it, the clone: its branch and its change.
    const lib = await get(`${url}?repo=${encodeURIComponent("tools/lib")}`);
    assert.equal(lib.branch, "lib");
    assert.equal(lib.root, path.join(work, "tools", "lib"));
    assert.deepEqual(lib.files.map((f) => f.path), ["tag.txt"]);
    // And a route that needs a repository gets that one.
    const log = await get(`${url}/log?repo=tools%2Flib`);
    assert.equal(log.commits.length, 1);
    const branches = await get(`${url}/branches?repo=tools%2Flib`);
    assert.deepEqual(branches.branches.map((b) => b.name), ["lib"]);

    assert.equal((await get(`${url}?repo=..`)).status, 404);
    assert.equal((await get(`${url}?repo=${encodeURIComponent("/etc")}`)).status, 404);
    assert.equal((await get(`${url}?repo=nothing%2Fhere`)).status, 404);
  });
});

test("a clone is found in a folder that is in no repository, and the folder itself answers that it is in none", async () => {
  const { id, work } = chat();
  repo(path.join(work, "only"), "only");
  await withApi(async (base) => {
    const url = `${base}/${id}`;
    assert.equal((await get(url)).repo, false);
    assert.deepEqual((await get(`${url}/repos`)).repos, [{ path: "only", name: "only" }]);
    assert.equal((await get(`${url}?repo=only`)).branch, "only");
  });
});
