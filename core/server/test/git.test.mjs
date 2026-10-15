import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scratch } from "./server-harness.mjs";

// A home of its own: who commits, what a new repository's branch is called,
// and no config of the person running the tests.
const home = scratch("pithagoras-git-");
process.env.HOME = home;
process.env.GIT_CONFIG_GLOBAL = path.join(home, ".gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
// Nor the repository that the temp folder may lie in: a developer's TMPDIR can be inside a work tree.
process.env.GIT_CEILING_DIRECTORIES = path.dirname(home);
writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Tester\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n");
// A gh of our own, first on the PATH: it writes down what it was asked and answers as GitHub would.
const bin = path.join(home, "bin");
mkdirSync(bin);
const ghLog = path.join(home, "gh.log");
writeFileSync(
  path.join(bin, "gh"),
  `#!/bin/sh
input=$(cat)
printf '%s\\n' "$*" >> "${ghLog}"
printf 'STDIN:%s\\n' "$input" >> "${ghLog}"
case "$1 $2" in
  "repo view") echo '{"nameWithOwner":"me/demo","url":"https://github.com/me/demo","defaultBranchRef":{"name":"main"}}' ;;
  "pr create") echo "https://github.com/me/demo/pull/7" ;;
  "pr list") echo '[{"number":7,"title":"Add a thing","state":"OPEN"}]' ;;
  "pr view") if [ -z "$3" ] || [ "$3" = "--json" ]; then echo "no pull requests found for branch \\"main\\"" >&2; exit 1; fi; echo '{"number":'"$3"',"title":"Add a thing"}' ;;
  *) echo "unknown: $*" >&2; exit 1 ;;
esac
`,
);
chmodSync(path.join(bin, "gh"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const g = await import("../dist/git.js");

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
let n = 0;
/** A repository with one commit: a.txt and "b c.txt". */
function repo() {
  const dir = path.join(home, `repo${++n}`);
  mkdirSync(dir);
  sh(dir, "init", "-q");
  writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(path.join(dir, "b c.txt"), "spaced\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "first");
  return dir;
}
const open = async (dir) => (await g.findRepo(dir));

test("what changed: staged and not, new files, renames and names with spaces, with their line counts", async () => {
  const dir = repo();
  writeFileSync(path.join(dir, "a.txt"), "one\n2\nthree\nfour\n");
  sh(dir, "mv", "b c.txt", "d e.txt");
  writeFileSync(path.join(dir, "new file.md"), "hello\n");
  writeFileSync(path.join(dir, "staged.txt"), "x\n");
  sh(dir, "add", "staged.txt");

  const s = await g.status(await open(dir));
  assert.equal(s.branch, "main");
  assert.equal(s.operation, null);
  const by = Object.fromEntries(s.files.map((f) => [f.path, f]));
  assert.deepEqual({ x: by["a.txt"].x, y: by["a.txt"].y, unstaged: by["a.txt"].unstaged }, { x: ".", y: "M", unstaged: { added: 2, removed: 1, binary: false } });
  assert.equal(by["d e.txt"].kind, "renamed");
  assert.equal(by["d e.txt"].from, "b c.txt");
  assert.equal(by["new file.md"].kind, "untracked");
  assert.deepEqual(by["staged.txt"].staged, { added: 1, removed: 0, binary: false });
});

test("a status too long to read whole is cut, says so, keeps what is changed, and lists no half of a file", async () => {
  const dir = repo();
  writeFileSync(path.join(dir, "a.txt"), "one\nTWO\nthree\n");
  // Paths of 750 characters: fewer files than are ever listed, and more than a refresh should read.
  const deep = path.join(dir, "d".repeat(250), "e".repeat(250));
  mkdirSync(deep, { recursive: true });
  const made = new Set();
  for (let i = 0; i < 1500; i++) {
    const name = `${"f".repeat(240)}${String(i).padStart(10, "0")}`;
    writeFileSync(path.join(deep, name), "");
    made.add(path.relative(dir, path.join(deep, name)));
  }
  const s = await g.status(await open(dir));
  assert.equal(s.truncated, true);
  assert.ok(s.files.length < 1500, `read ${s.files.length}`);
  // What is changed comes first and is still there, with its counts; every untracked file is a whole one.
  assert.deepEqual(s.files[0].unstaged, { added: 1, removed: 1, binary: false });
  assert.equal(s.files.filter((f) => f.kind === "untracked").every((f) => made.has(f.path)), true);
  // A repository that fits is not said to be cut.
  const small = repo();
  writeFileSync(path.join(small, "new.txt"), "x\n");
  assert.equal((await g.status(await open(small))).truncated, false);
});

test("a remote is shown without the login its URL may carry", () => {
  assert.deepEqual(g.describeRemote("https://me:ghp_secret@github.com/me/demo.git"), { address: "github.com/me/demo", web: "https://github.com/me/demo" });
  assert.deepEqual(g.describeRemote("git@github.com:me/demo.git"), { address: "github.com:me/demo", web: "https://github.com/me/demo" });
  assert.deepEqual(g.describeRemote("ssh://git@gitlab.example.com:2222/a/b.git"), { address: "gitlab.example.com:2222/a/b", web: "https://gitlab.example.com/a/b" });
  assert.equal(g.describeRemote("/srv/git/demo.git").web, undefined);
});

test("a repository git refuses — somebody else's — is said to be refused, not to be none, and is not made again", async () => {
  const dir = repo();
  process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1";
  try {
    await assert.rejects(g.findRepo(dir), (e) => e.status === 409 && /dubious ownership/.test(e.message));
  } finally {
    delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
  }
});

test("a refresh reads what to turn off once, not before every command", async () => {
  const dir = repo();
  // A git that writes down how it was called, first on the PATH.
  const logged = path.join(home, `calls${n}`);
  const wrap = path.join(home, `wrap${n}`);
  mkdirSync(wrap);
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(path.join(wrap, "git"), `#!/bin/sh\necho "$*" >> ${logged}\nexec ${real} "$@"\n`);
  chmodSync(path.join(wrap, "git"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${wrap}:${saved}`;
  try {
    const r = await open(dir);
    await g.status(r);
    const calls = readFileSync(logged, "utf8").split("\n").filter(Boolean);
    assert.equal(calls.filter((c) => c.includes("--get-regexp ^filter")).length, 1, calls.join("\n"));
  } finally {
    process.env.PATH = saved;
  }
});


test("unsaved work: what only a repository's folder holds, so deleting it can be refused", async () => {
  const dir = repo();
  const plain = path.join(home, `plain${++n}`);
  mkdirSync(plain);
  const inside = path.join(dir, "sub");
  mkdirSync(inside);
  // No repository in it or around it.
  assert.equal(await g.unsavedWork(plain), null);

  // Committed, but no remote has it: the commit exists only here.
  assert.deepEqual(await g.unsavedWork(dir), { changed: 0, unpushed: 1, stashes: 0 });

  // Once a remote has it, a clean tree holds nothing of its own.
  const remote = path.join(home, `remote${++n}.git`);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  sh(dir, "remote", "add", "origin", remote);
  sh(dir, "push", "-q", "-u", "origin", "main");
  assert.deepEqual(await g.unsavedWork(dir), { changed: 0, unpushed: 0, stashes: 0 });

  // Edits and new files count, and so does a branch that was never pushed.
  writeFileSync(path.join(dir, "a.txt"), "changed\n");
  writeFileSync(path.join(dir, "new.txt"), "new\n");
  assert.deepEqual(await g.unsavedWork(dir), { changed: 2, unpushed: 0, stashes: 0 });
  sh(dir, "stash", "-u", "-q");
  assert.deepEqual(await g.unsavedWork(dir), { changed: 0, unpushed: 0, stashes: 1 });
  sh(dir, "switch", "-q", "-c", "side");
  writeFileSync(path.join(dir, "s.txt"), "s\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "on a side branch");
  assert.deepEqual(await g.unsavedWork(dir), { changed: 0, unpushed: 1, stashes: 1 });
});

test("unsaved work: a .git that cannot be read is not taken for a clean one", async () => {
  const dir = path.join(home, `broken${++n}`);
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  const got = await g.unsavedWork(dir);
  assert.equal(got?.unknown, true);
});

test("unsaved work: a commit on a detached HEAD counts, and a new folder is one change", async () => {
  const dir = repo();
  const remote = path.join(home, `remote${++n}.git`);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  sh(dir, "remote", "add", "origin", remote);
  sh(dir, "push", "-q", "-u", "origin", "main");
  sh(dir, "switch", "-q", "--detach");
  writeFileSync(path.join(dir, "d.txt"), "d\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "on no branch");
  assert.deepEqual(await g.unsavedWork(dir), { changed: 0, unpushed: 1, stashes: 0 });

  const many = repo();
  mkdirSync(path.join(many, "out"));
  for (let i = 0; i < g.MAX_FILES + 100; i++) writeFileSync(path.join(many, "out", `f${i}`), "x");
  // Only whether something is there matters: git does not list every file in it.
  assert.equal((await g.unsavedWork(many)).changed, 1);
});

test("unsaved work: a linked worktree loses its own files, not the main repository's history", async () => {
  const dir = repo();
  const tree = path.join(home, `tree${++n}`);
  sh(dir, "worktree", "add", "-q", "-b", "wt", tree);
  assert.deepEqual(await g.unsavedWork(tree), { changed: 0, unpushed: 0, stashes: 0 });
  writeFileSync(path.join(tree, "x.txt"), "x\n");
  assert.deepEqual(await g.unsavedWork(tree), { changed: 1, unpushed: 0, stashes: 0 });
});

test("unsaved work: a repository before its first commit is readable, and a detached worktree's own commits count", async () => {
  const fresh = path.join(home, `fresh${++n}`);
  mkdirSync(fresh);
  sh(fresh, "init", "-q");
  writeFileSync(path.join(fresh, "a.txt"), "a\n");
  assert.deepEqual(await g.unsavedWork(fresh), { changed: 1, unpushed: 0, stashes: 0 });

  const dir = repo();
  const tree = path.join(home, `tree${++n}`);
  sh(dir, "worktree", "add", "-q", "--detach", tree);
  writeFileSync(path.join(tree, "w.txt"), "w\n");
  sh(tree, "add", "-A");
  sh(tree, "commit", "-qm", "on no branch, in a worktree");
  assert.deepEqual(await g.unsavedWork(tree), { changed: 0, unpushed: 1, stashes: 0 });
});

/** A bare remote that has the repository's main. */
function pushed(dir) {
  const remote = path.join(home, `remote${++n}.git`);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  sh(dir, "remote", "add", "origin", remote);
  sh(dir, "push", "-q", "-u", "origin", "main");
  return remote;
}

test("unsaved work: a submodule's changes, commits and stashes count, as its data is in the folder", async () => {
  const lib = repo();
  const dir = repo();
  pushed(dir);
  sh(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "lib");
  sh(dir, "commit", "-qm", "add lib");
  sh(dir, "push", "-q");
  assert.deepEqual(await g.unsavedWork(dir), { changed: 0, unpushed: 0, stashes: 0 });

  const sub = path.join(dir, "lib");
  writeFileSync(path.join(sub, "a.txt"), "edited\n");
  assert.deepEqual(await g.unsavedWork(dir), { changed: 1, unpushed: 0, stashes: 0 });
  // Committed in the submodule: the commit is the submodule's, the new pointer the parent's.
  sh(sub, "commit", "-qam", "only here");
  writeFileSync(path.join(sub, "n.txt"), "n\n");
  sh(sub, "stash", "-u", "-q");
  assert.deepEqual(await g.unsavedWork(dir), { changed: 1, unpushed: 1, stashes: 1 });
});

test("unsaved work: a folder that is no repository is looked through for clones", async () => {
  const folder = path.join(home, `client${++n}`);
  mkdirSync(folder);
  assert.equal(await g.unsavedWork(folder), null);
  const api = path.join(folder, "api");
  const web = path.join(folder, "apps", "web");
  execFileSync("git", ["clone", "-q", repo(), api]);
  execFileSync("git", ["clone", "-q", repo(), web]);
  assert.deepEqual(await g.unsavedWork(folder), { changed: 0, unpushed: 0, stashes: 0 });

  writeFileSync(path.join(api, "a.txt"), "edited\n");
  sh(api, "commit", "-qam", "only here");
  writeFileSync(path.join(web, "new.txt"), "new\n");
  // Not looked into: what is in node_modules came from elsewhere.
  const dep = path.join(folder, "node_modules", "dep");
  mkdirSync(dep, { recursive: true });
  sh(dep, "init", "-q");
  writeFileSync(path.join(dep, "x.txt"), "x\n");
  assert.deepEqual(await g.unsavedWork(folder), { changed: 1, unpushed: 1, stashes: 0 });
});

test("unsaved work: a .git file that points inside the folder counts the branches and stashes it holds", async () => {
  const dir = path.join(home, `split${++n}`);
  mkdirSync(dir);
  sh(dir, "init", "-q", "--separate-git-dir", path.join(dir, "data.git"));
  writeFileSync(path.join(dir, ".gitignore"), "data.git/\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "first");
  sh(dir, "branch", "side");
  writeFileSync(path.join(dir, "s.txt"), "s\n");
  sh(dir, "stash", "-u", "-q");
  assert.deepEqual(await g.unsavedWork(dir), { changed: 0, unpushed: 1, stashes: 1 });
});

test("unsaved work: commits a tag holds are taken for ones a remote has", async () => {
  const dir = repo();
  pushed(dir);
  // A release branch that is gone, its tag left.
  sh(dir, "switch", "-q", "-c", "release");
  writeFileSync(path.join(dir, "r.txt"), "r\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "release");
  sh(dir, "tag", "v1");
  sh(dir, "switch", "-q", "main");
  sh(dir, "branch", "-q", "-D", "release");
  assert.deepEqual(await g.unsavedWork(dir), { changed: 0, unpushed: 0, stashes: 0 });
  sh(dir, "switch", "-q", "--detach", "v1");
  assert.deepEqual(await g.unsavedWork(dir), { changed: 0, unpushed: 0, stashes: 0 });
});

test("unsaved work: a worktree inside the folder of its own repository does not count its branches twice", async () => {
  const dir = repo();
  sh(dir, "worktree", "add", "-q", "-b", "wt", path.join(dir, "wt"));
  // Not a change of the main one: it is counted on its own. The one commit, on main and wt, is counted once.
  assert.deepEqual(await g.unsavedWork(dir), { changed: 0, unpushed: 1, stashes: 0 });
});

test("unsaved work: a clean clone inside a repository is not a change of it", async () => {
  const dir = repo();
  pushed(dir);
  execFileSync("git", ["clone", "-q", repo(), path.join(dir, "vendor", "lib")]);
  assert.deepEqual(await g.unsavedWork(dir), { changed: 0, unpushed: 0, stashes: 0 });
  // Something else new beside it is a change: the folder, once.
  writeFileSync(path.join(dir, "vendor", "README"), "r\n");
  writeFileSync(path.join(dir, "vendor", "NOTES"), "n\n");
  assert.deepEqual(await g.unsavedWork(dir), { changed: 1, unpushed: 0, stashes: 0 });
});

test("unsaved work: a remote inside the folder goes with it, so what it has is not saved", async () => {
  const folder = path.join(home, `pair${++n}`);
  mkdirSync(folder);
  const origin = path.join(folder, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", origin]);
  const work = path.join(folder, "work");
  execFileSync("git", ["clone", "-q", origin, work]);
  writeFileSync(path.join(work, "a.txt"), "a\n");
  sh(work, "add", "-A");
  sh(work, "commit", "-qm", "first");
  sh(work, "push", "-q", "origin", "main");
  assert.deepEqual(await g.unsavedWork(folder), { changed: 0, unpushed: 1, stashes: 0 });
  // Pushed somewhere that stays as well: saved.
  const away = path.join(home, `remote${++n}.git`);
  execFileSync("git", ["init", "-q", "--bare", away]);
  sh(work, "remote", "add", "away", away);
  sh(work, "push", "-q", "away", "main");
  assert.deepEqual(await g.unsavedWork(folder), { changed: 0, unpushed: 0, stashes: 0 });
});

test("unsaved work: a folder inside a repository counts what that repository would lose of it", async () => {
  const dir = repo();
  const inside = path.join(dir, "sub");
  mkdirSync(inside);
  assert.deepEqual(await g.unsavedWork(inside), { changed: 0, unpushed: 0, stashes: 0 });
  writeFileSync(path.join(inside, "t.txt"), "t\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "sub");
  writeFileSync(path.join(inside, "t.txt"), "changed\n");
  writeFileSync(path.join(dir, "a.txt"), "outside the folder\n");
  assert.deepEqual(await g.unsavedWork(inside), { changed: 1, unpushed: 0, stashes: 0 });

  // A folder git has none of is as good as one without git.
  const loose = path.join(dir, "loose");
  mkdirSync(loose);
  writeFileSync(path.join(loose, "l.txt"), "l\n");
  assert.equal(await g.unsavedWork(loose), null);
});

test("unsaved work: a folder that cannot be listed is not taken for an empty one", { skip: process.getuid?.() === 0 && "root reads any folder" }, async () => {
  const folder = path.join(home, `locked${++n}`);
  const shut = path.join(folder, "shut");
  mkdirSync(shut, { recursive: true });
  chmodSync(shut, 0o000);
  try {
    assert.equal((await g.unsavedWork(folder))?.unknown, true);
  } finally {
    chmodSync(shut, 0o755);
  }
});

test("unsaved work in a delete from the Files panel: a file or a link goes as it is, a clone's commits are asked about", async () => {
  const folder = path.join(home, `panel${++n}`);
  mkdirSync(folder);
  const api = path.join(folder, "api");
  execFileSync("git", ["clone", "-q", repo(), api]);
  assert.deepEqual(await g.unsavedIn(home, api), { changed: 0, unpushed: 0, stashes: 0 });
  mkdirSync(path.join(api, "src"));
  writeFileSync(path.join(api, "src", "x.ts"), "x\n");
  sh(api, "add", "-A");
  sh(api, "commit", "-qm", "only here");
  assert.deepEqual(await g.unsavedIn(home, api), { changed: 0, unpushed: 1, stashes: 0 });
  // The folder that holds the clone is the same.
  assert.deepEqual(await g.unsavedIn(home, folder), { changed: 0, unpushed: 1, stashes: 0 });

  // What is picked is what goes: a file with changes, a link to the clone.
  writeFileSync(path.join(api, "a.txt"), "edited again\n");
  assert.equal(await g.unsavedIn(home, path.join(api, "a.txt")), null);
  symlinkSync(api, path.join(folder, "link"));
  assert.equal(await g.unsavedIn(home, path.join(folder, "link")), null);
  // A folder in the clone: only what is changed in it, and the commits stay with the repository.
  assert.deepEqual(await g.unsavedIn(home, path.join(api, "src")), { changed: 0, unpushed: 0, stashes: 0 });
  writeFileSync(path.join(api, "src", "x.ts"), "changed\n");
  assert.deepEqual(await g.unsavedIn(home, path.join(api, "src")), { changed: 1, unpushed: 0, stashes: 0 });
  // A folder that is all new is a new folder of the repository: its files are nowhere else.
  mkdirSync(path.join(api, "fresh"));
  writeFileSync(path.join(api, "fresh", "y.ts"), "y\n");
  writeFileSync(path.join(api, "fresh", "z.ts"), "z\n");
  assert.deepEqual(await g.unsavedIn(home, path.join(api, "fresh")), { changed: 1, unpushed: 0, stashes: 0 });
  // Not so for a project: a repository around it that has none of it is as good as none.
  assert.equal(await g.unsavedWork(path.join(api, "fresh")), null);

  // Gone already, or nothing git has.
  assert.equal(await g.unsavedIn(home, path.join(folder, "nothing")), null);
  const plain = path.join(folder, "plain");
  mkdirSync(plain);
  assert.equal(await g.unsavedIn(home, plain), null);
});

test("unsaved work in a delete from the Files panel: what a tool folder holds is not looked into", async () => {
  const folder = path.join(home, `tools${++n}`);
  const modules = path.join(folder, "node_modules");
  const dep = path.join(modules, "dep");
  mkdirSync(dep, { recursive: true });
  sh(dep, "init", "-q");
  writeFileSync(path.join(dep, "x.txt"), "x\n");
  sh(dep, "add", "-A");
  sh(dep, "commit", "-qm", "from elsewhere");
  assert.equal(await g.unsavedIn(home, modules), null);
  // The folder around it does not look into it either.
  assert.equal(await g.unsavedIn(home, folder), null);

  // One that is a repository itself is asked about, by its own name or from the folder around it.
  const venv = path.join(folder, "venv");
  mkdirSync(venv);
  sh(venv, "init", "-q");
  writeFileSync(path.join(venv, "keep.txt"), "k\n");
  sh(venv, "add", "-A");
  sh(venv, "commit", "-qm", "made here");
  assert.deepEqual(await g.unsavedIn(home, venv), { changed: 0, unpushed: 1, stashes: 0 });
  assert.deepEqual(await g.unsavedIn(home, folder), { changed: 0, unpushed: 1, stashes: 0 });

  // And one a repository around it tracks, with changes there.
  const dir = repo();
  mkdirSync(path.join(dir, ".cache"));
  writeFileSync(path.join(dir, ".cache", "c.txt"), "c\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "tracked cache");
  writeFileSync(path.join(dir, ".cache", "c.txt"), "edited\n");
  assert.deepEqual(await g.unsavedIn(home, path.join(dir, ".cache")), { changed: 1, unpushed: 0, stashes: 0 });
});

test("unsaved work: commits only the HEAD of a worktree elsewhere holds go with the repository's data", async () => {
  const dir = repo();
  pushed(dir);
  const tree = path.join(home, `tree${++n}`);
  sh(dir, "worktree", "add", "-q", "--detach", tree);
  writeFileSync(path.join(tree, "w.txt"), "w\n");
  sh(tree, "add", "-A");
  sh(tree, "commit", "-qm", "one");
  sh(tree, "commit", "-q", "--allow-empty", "-m", "two");
  assert.deepEqual(await g.unsavedWork(dir), { changed: 0, unpushed: 2, stashes: 0 });
});

test("unsaved work in a delete from the Files panel: a new folder counts only where git tracks the folder it is in", async () => {
  // The workspace root is a repository that has none of the chat's folder.
  const root = repo();
  const chat = path.join(root, "proj");
  mkdirSync(path.join(chat, "tmp", "deep"), { recursive: true });
  writeFileSync(path.join(chat, "tmp", "deep", "x.txt"), "x\n");
  assert.equal(await g.unsavedIn(chat, path.join(chat, "tmp")), null);
  assert.equal(await g.unsavedIn(chat, path.join(chat, "tmp", "deep")), null);
  // Where git does track the folder it is in, it is the new folder it is.
  mkdirSync(path.join(root, "lib"));
  writeFileSync(path.join(root, "lib", "l.txt"), "l\n");
  sh(root, "add", "lib");
  sh(root, "commit", "-qm", "lib");
  mkdirSync(path.join(root, "lib", "fresh"));
  writeFileSync(path.join(root, "lib", "fresh", "f.txt"), "f\n");
  assert.deepEqual(await g.unsavedIn(root, path.join(root, "lib", "fresh")), { changed: 1, unpushed: 0, stashes: 0 });
  // A node_modules nobody ignored is still what a tool made.
  const dir = repo();
  mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
  writeFileSync(path.join(dir, "node_modules", "dep", "i.js"), "i\n");
  assert.equal(await g.unsavedIn(dir, path.join(dir, "node_modules")), null);
});

test("unsaved work in a delete from the Files panel: a .git above the chat's folder is not one of its own", async () => {
  const base = path.join(home, `odd${++n}`, ".git", "chat");
  mkdirSync(path.join(base, "plain"), { recursive: true });
  writeFileSync(path.join(base, "notes.md"), "n\n");
  assert.equal(await g.unsavedIn(base, path.join(base, "notes.md")), null);
});

test("unsaved work in a delete from the Files panel: a .git, or anything in it, is not told apart", async () => {
  const dir = repo();
  pushed(dir);
  for (const p of [".git", ".git/refs", ".git/refs/heads/main", ".git/HEAD"]) {
    assert.equal((await g.unsavedIn(home, path.join(dir, p)))?.unknown, true, p);
  }
  // A worktree's .git is a file, and the same.
  const tree = path.join(home, `tree${++n}`);
  sh(dir, "worktree", "add", "-q", "-b", "wt2", tree);
  assert.equal((await g.unsavedIn(home, path.join(tree, ".git")))?.unknown, true);
});
