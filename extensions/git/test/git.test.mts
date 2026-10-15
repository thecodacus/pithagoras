import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scratch } from "../../../tests/helpers.mts";

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

// The Git extension's git, run by the portal's own runner, as its server half is given it (`portal.git.at`).
const g = await import("../src/git.ts");
const { filterOverrides, gitAt } = await import("../../../core/server/src/git.ts");
g.useGit(gitAt);

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

/** Two remotes named as GitHub has them — a fork and what it was forked from — that are bare repositories here. */
function forked() {
  const dir = repo();
  for (const [name, owner] of [["origin", "forker"], ["upstream", "me"]]) {
    const bare = path.join(home, `${owner}-demo${n}.git`);
    execFileSync("git", ["init", "-q", "--bare", bare]);
    sh(dir, "config", `url.${bare}.insteadOf`, `https://github.com/${owner}/demo.git`);
    sh(dir, "remote", "add", name, `https://github.com/${owner}/demo.git`);
    sh(dir, "push", "-q", name, "main");
  }
  sh(dir, "fetch", "-q", "--all");
  sh(dir, "branch", "-q", "--set-upstream-to=origin/main");
  return dir;
}

test("diffs of one file: in the tree, in the index, and a new one — and nothing outside what changed", async () => {
  const dir = repo();
  const r = await open(dir);
  writeFileSync(path.join(dir, "a.txt"), "one\nTWO\nthree\n");
  writeFileSync(path.join(dir, "fresh.txt"), "brand new\n");
  assert.match((await g.diff(r, { of: "unstaged", path: "a.txt" })).diff, /^-two\n\+TWO$/m);
  sh(dir, "add", "a.txt");
  assert.equal((await g.diff(r, { of: "unstaged", path: "a.txt" })).diff, "");
  assert.match((await g.diff(r, { of: "staged", path: "a.txt" })).diff, /^\+TWO$/m);
  assert.match((await g.diff(r, { of: "untracked", path: "fresh.txt" })).diff, /^\+brand new$/m);

  // --no-index would show any file at all: only what git lists as new is shown.
  await assert.rejects(g.diff(r, { of: "untracked", path: "a.txt" }), { status: 404 });
  await assert.rejects(g.diff(r, { of: "untracked", path: "../../etc/passwd" }), { status: 400 });
  await assert.rejects(g.diff(r, { of: "unstaged", path: "/etc/passwd" }), { status: 400 });
  // A path is a path, not a pattern: "*.txt" is no file here.
  assert.equal((await g.diff(r, { of: "staged", path: "*.txt" })).diff, "");
});

test("looking does not run what the repository's config would: no fsmonitor, external diff or text conversion", async () => {
  const dir = repo();
  const marker = path.join(home, `ran${n}`);
  const script = path.join(home, `evil${n}.sh`);
  writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`);
  chmodSync(script, 0o755);
  sh(dir, "config", "core.fsmonitor", script);
  sh(dir, "config", "diff.external", script);
  sh(dir, "config", "diff.conv.textconv", script);
  writeFileSync(path.join(dir, ".gitattributes"), "*.txt diff=conv\n");
  writeFileSync(path.join(dir, "a.txt"), "changed\n");
  const r = await open(dir);
  await g.status(r);
  await g.diff(r, { of: "unstaged", path: "a.txt" });
  assert.equal(existsSync(marker), false);
});

test("stage, unstage, discard and commit — before the first commit as well", async () => {
  const dir = path.join(home, `empty${++n}`);
  mkdirSync(dir);
  sh(dir, "init", "-q");
  const r = await open(dir);
  writeFileSync(path.join(dir, "x.txt"), "x\n");
  writeFileSync(path.join(dir, "y.txt"), "y\n");
  await g.stage(r, ["x.txt"]);
  assert.equal((await g.status(r)).files.find((f) => f.path === "x.txt").x, "A");
  // No HEAD to reset to yet.
  await g.unstage(r, ["x.txt"]);
  assert.equal((await g.status(r)).files.find((f) => f.path === "x.txt").kind, "untracked");
  await g.stage(r, [], true);
  const { sha } = await g.commit(r, "Start");
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal((await g.status(r)).files.length, 0);
  await assert.rejects(g.commit(r, "   "), { status: 400 });

  // Discard: a changed file goes back, a new one goes away.
  writeFileSync(path.join(dir, "x.txt"), "changed\n");
  writeFileSync(path.join(dir, "junk.txt"), "junk\n");
  await g.discard(r, ["x.txt", "junk.txt"]);
  assert.equal(readFileSync(path.join(dir, "x.txt"), "utf8"), "x\n");
  assert.equal(existsSync(path.join(dir, "junk.txt")), false);

  // Amend keeps the message when none is given.
  writeFileSync(path.join(dir, "z.txt"), "z\n");
  await g.stage(r, ["z.txt"]);
  await g.commit(r, "", true);
  const [last] = await g.log(r, {});
  assert.equal(last.subject, "Start");
  assert.equal((await g.commitDetail(r, last.sha)).files.length, 3);
});

test("history and one commit's files, the first one against nothing", async () => {
  const dir = repo();
  const r = await open(dir);
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  sh(dir, "commit", "-qam", "Shorten a\n\nWith a body.");
  const commits = await g.log(r, {});
  assert.deepEqual(commits.map((c) => c.subject), ["Shorten a", "first"]);
  assert.ok(commits[0].refs.some((ref) => ref.includes("main")));
  const detail = await g.commitDetail(r, commits[0].sha);
  assert.equal(detail.message, "Shorten a\n\nWith a body.");
  assert.deepEqual(detail.files.map((f) => [f.path, f.status, f.added, f.removed]), [["a.txt", "M", 0, 2]]);
  const first = await g.commitDetail(r, commits[1].sha);
  assert.deepEqual(first.files.map((f) => f.status), ["A", "A"]);
  assert.match((await g.diff(r, { of: "commit", sha: commits[0].sha, path: "a.txt" })).diff, /^-two$/m);
  await assert.rejects(g.commitDetail(r, "--output=/tmp/x"), { status: 400 });
  assert.deepEqual((await g.log(r, { skip: 1, limit: 1 })).map((c) => c.subject), ["first"]);
});

test("branches: made, switched, pushed with an upstream, fetched and pulled, compared with the base, deleted", async () => {
  const remote = path.join(home, `remote${++n}.git`);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  const dir = repo();
  sh(dir, "remote", "add", "origin", remote);
  sh(dir, "push", "-q", "-u", "origin", "main");
  const r = await open(dir);

  await g.createBranch(r, "feature/x");
  assert.equal((await g.status(r)).branch, "feature/x");
  await assert.rejects(g.createBranch(r, "bad..name"), { status: 400 });
  await assert.rejects(g.createBranch(r, "-f"), { status: 400 });
  writeFileSync(path.join(dir, "feature.txt"), "f\n");
  await g.stage(r, [], true);
  await g.commit(r, "Add feature");

  // Not on the remote yet: published, and followed from then on.
  await g.push(r);
  let s = await g.status(r);
  assert.equal(s.upstream, "origin/feature/x");
  assert.equal(s.ahead, 0);

  const comparison = await g.compare(r);
  assert.equal(comparison.base, "origin/main");
  assert.deepEqual(comparison.commits.map((c) => c.subject), ["Add feature"]);
  assert.deepEqual(comparison.files.map((f) => [f.path, f.status]), [["feature.txt", "A"]]);
  assert.match((await g.diff(r, { of: "range", base: "origin/main", path: "feature.txt" })).diff, /^\+f$/m);

  // Somebody else pushes to main; fetch sees it, pull fast-forwards.
  const other = path.join(home, `other${n}`);
  execFileSync("git", ["clone", "-q", remote, other]);
  writeFileSync(path.join(other, "a.txt"), "theirs\n");
  sh(other, "commit", "-qam", "Theirs");
  sh(other, "push", "-q", "origin", "main");
  await g.switchBranch(r, "main");
  await g.fetch(r);
  s = await g.status(r);
  assert.equal(s.behind, 1);
  await g.pull(r);
  assert.equal(readFileSync(path.join(dir, "a.txt"), "utf8"), "theirs\n");

  // A remote branch checked out gets a local one following it.
  sh(other, "switch", "-qc", "theirs/topic");
  sh(other, "push", "-q", "origin", "theirs/topic");
  await g.fetch(r);
  const list = await g.branches(r);
  assert.ok(list.some((b) => b.remote && b.name === "origin/theirs/topic"));
  assert.ok(!list.some((b) => b.name === "origin/HEAD" || b.name === "origin"));
  await g.switchBranch(r, "origin/theirs/topic", true);
  s = await g.status(r);
  assert.equal(s.branch, "theirs/topic");
  assert.equal(s.upstream, "origin/theirs/topic");

  await g.switchBranch(r, "main");
  await g.deleteBranch(r, "theirs/topic");
  assert.ok(!(await g.branches(r)).some((b) => !b.remote && b.name === "theirs/topic"));
});

test("a merge that stopped on a conflict is shown as one, and can be given up", async () => {
  const dir = repo();
  const r = await open(dir);
  sh(dir, "switch", "-qc", "side");
  writeFileSync(path.join(dir, "a.txt"), "side\n");
  sh(dir, "commit", "-qam", "side");
  sh(dir, "switch", "-q", "main");
  writeFileSync(path.join(dir, "a.txt"), "main\n");
  sh(dir, "commit", "-qam", "main");
  try {
    sh(dir, "merge", "-q", "side");
  } catch {
    // The conflict.
  }
  const s = await g.status(r);
  assert.equal(s.operation, "merge");
  assert.equal(s.files.find((f) => f.path === "a.txt").kind, "conflict");
  await g.abortOperation(r);
  assert.equal((await g.status(r)).operation, null);
});

test("stashes: put away with new files, listed, shown and brought back", async () => {
  const dir = repo();
  const r = await open(dir);
  writeFileSync(path.join(dir, "a.txt"), "wip\n");
  writeFileSync(path.join(dir, "new.txt"), "new\n");
  await g.stashPush(r, "half done");
  assert.equal((await g.status(r)).files.length, 0);
  const [stash] = await g.stashes(r);
  assert.equal(stash.ref, "stash@{0}");
  assert.match(stash.message, /half done/);
  assert.match((await g.diff(r, { of: "stash", stash: "stash@{0}" })).diff, /^\+wip$/m);
  await assert.rejects(g.stashDo(r, "pop", "stash@{0}; rm -rf /", stash.sha), { status: 400 });
  await assert.rejects(g.stashDo(r, "pop", "stash@{0}"), { status: 400 });
  await g.stashDo(r, "pop", "stash@{0}", stash.sha);
  assert.equal(readFileSync(path.join(dir, "new.txt"), "utf8"), "new\n");
});

test("pull requests go through gh: a branch not on GitHub is pushed first, the body goes in on stdin", async () => {
  const remote = path.join(home, `remote${++n}.git`);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  const dir = repo();
  sh(dir, "remote", "add", "origin", remote);
  sh(dir, "push", "-q", "-u", "origin", "main");
  const r = await open(dir);
  const state = await g.ghState(r, true);
  assert.deepEqual({ installed: state.installed, repo: state.repo, defaultBranch: state.defaultBranch }, { installed: true, repo: "me/demo", defaultBranch: "main" });
  assert.equal(await g.pullRequest(r), null, "no pull request for this branch is an answer, not an error");

  await g.createBranch(r, "topic");
  writeFileSync(path.join(dir, "t.txt"), "t\n");
  await g.stage(r, [], true);
  await g.commit(r, "Topic");
  writeFileSync(ghLog, "");
  const { url } = await g.createPull(r, { title: "Add topic", body: "Why:\n- because; $(rm -rf /)", base: "main", draft: true });
  assert.equal(url, "https://github.com/me/demo/pull/7");
  assert.equal((await g.status(r)).upstream, "origin/topic", "pushed before gh was asked");
  const asked = readFileSync(ghLog, "utf8");
  assert.match(asked, /^pr create --title Add topic --body-file - --head topic --base main --draft$/m);
  assert.match(asked, /STDIN:Why:\n- because; \$\(rm -rf \/\)/);
  assert.deepEqual(await g.pulls(r), [{ number: 7, title: "Add a thing", state: "OPEN" }]);
  await assert.rejects(g.pullRequest(r, "7; ls"), { status: 400 });
});

test("a pull request is asked for with whether its branch is in a fork, which its name alone does not say", async () => {
  const remote = path.join(home, `remote${++n}.git`);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  const dir = repo();
  sh(dir, "remote", "add", "origin", remote);
  sh(dir, "push", "-q", "-u", "origin", "main");
  const r = await open(dir);
  await g.ghState(r, true);
  writeFileSync(ghLog, "");
  await g.pullRequest(r, 7);
  const fields = /^pr view 7 --json (.+)$/m.exec(readFileSync(ghLog, "utf8"))?.[1].split(",");
  assert.ok(fields?.includes("isCrossRepository"), "a fork's `main` is not the branch called main here");
  assert.ok(fields?.includes("headRefName"));
});

test("without gh, pull requests say how to get them", async () => {
  const dir = repo();
  const r = await open(dir);
  const saved = process.env.PATH;
  // A PATH with git on it and nothing else.
  const only = path.join(home, `nogh${n}`);
  mkdirSync(only);
  symlinkSync(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), path.join(only, "git"));
  process.env.PATH = only;
  try {
    const state = await g.ghState(r, true);
    assert.equal(state.installed, false);
    assert.match(state.note, /Install the GitHub CLI/);
    await assert.rejects(g.pulls(r), { status: 409 });
  } finally {
    process.env.PATH = saved;
  }
});

test("a folder in no repository is said to be in none, and can be made one", async () => {
  const dir = path.join(home, `plain${++n}`);
  mkdirSync(dir);
  assert.equal(await g.findRepo(dir), null);
  await g.initRepo(dir);
  const r = await g.findRepo(dir);
  assert.equal(r.root, dir);
  assert.equal(r.prefix, "");
  mkdirSync(path.join(dir, "sub"));
  assert.equal((await g.findRepo(path.join(dir, "sub"))).prefix, "sub");
});

test("a message that starts with # is a message: kept whole, not taken for a comment", async () => {
  const dir = repo();
  const r = await open(dir);
  writeFileSync(path.join(dir, "a.txt"), "changed\n");
  await g.stage(r, [], true);
  await g.commit(r, "#42 fix login\n\n#123 is related");
  const [last] = await g.log(r, {});
  assert.equal(last.subject, "#42 fix login");
  assert.equal((await g.commitDetail(r, last.sha)).message, "#42 fix login\n\n#123 is related");
});

test("looking runs no filter the repository names — whatever the driver is called — but leaves git-lfs as it installs itself", async () => {
  const dir = repo();
  const marker = path.join(home, `filtered${n}`);
  const script = path.join(home, `filter${n}.sh`);
  writeFileSync(script, `#!/bin/sh\ntouch ${marker}\ncat\n`);
  chmodSync(script, 0o755);
  writeFileSync(path.join(dir, ".gitattributes"), "*.txt filter=evil\n*.md filter=a=b\n");
  sh(dir, "config", "filter.evil.clean", script);
  sh(dir, "config", "filter.evil.process", script);
  sh(dir, "config", "filter.evil.required", "true");
  // A name with "=" in it: as `-c filter.a=b.clean=` it would have named another key.
  sh(dir, "config", "filter.a=b.clean", script);
  sh(dir, "config", "filter.lfs.clean", "git-lfs clean -- %f");
  sh(dir, "config", "filter.lfs.process", "git-lfs filter-process");
  writeFileSync(path.join(dir, "a.txt"), "changed\n");
  writeFileSync(path.join(dir, "n.md"), "new\n");
  const r = await open(dir);
  const s = await g.status(r);
  assert.ok(s.files.some((f) => f.path === "a.txt"));
  await g.diff(r, { of: "unstaged", path: "a.txt" });
  await g.diff(r, { of: "untracked", path: "n.md" });
  assert.equal(existsSync(marker), false, "the filter ran");
  const keys = (await filterOverrides(dir)).map(([key]) => key);
  assert.ok(keys.includes("filter.evil.process") && keys.includes("filter.a=b.clean"));
  assert.ok(!keys.some((key) => key.startsWith("filter.lfs.")), "git-lfs as installed is left alone");
});

test("a renamed file is staged by its new name, and unstaged by both", async () => {
  const dir = repo();
  const r = await open(dir);
  sh(dir, "mv", "a.txt", "moved.txt");
  writeFileSync(path.join(dir, "moved.txt"), "one\ntwo\nthree\nfour\n");
  let s = await g.status(r);
  const moved = s.files.find((f) => f.path === "moved.txt");
  assert.deepEqual([moved.kind, moved.from, moved.x, moved.y], ["renamed", "a.txt", "R", "M"]);
  await g.stage(r, ["moved.txt"]);
  s = await g.status(r);
  assert.equal(s.files.find((f) => f.path === "moved.txt").y, ".");
  await g.unstage(r, ["moved.txt", "a.txt"]);
  s = await g.status(r);
  // Nothing of it staged any more: not the new file, not the old one's deletion.
  assert.deepEqual(s.files.filter((f) => f.x !== "." && f.x !== "?"), []);
});

test("a signed commit in the history runs nothing: not the gpg.program the repository names", async () => {
  const dir = repo();
  const marker = path.join(home, `gpg${n}`);
  const script = path.join(home, `gpg${n}.sh`);
  writeFileSync(script, `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
  chmodSync(script, 0o755);
  // A commit carrying a signature, made by hand: what signing leaves in it.
  const tree = sh(dir, "rev-parse", "HEAD^{tree}").trim();
  const parent = sh(dir, "rev-parse", "HEAD").trim();
  const raw = `tree ${tree}\nparent ${parent}\nauthor T <t@e> 1700000000 +0000\ncommitter T <t@e> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----\n\nSigned\n`;
  const sha = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: dir, input: raw, encoding: "utf8" }).trim();
  sh(dir, "reset", "-q", "--hard", sha);
  sh(dir, "config", "log.showSignature", "true");
  sh(dir, "config", "gpg.program", script);
  const r = await open(dir);
  const [top] = await g.log(r, {});
  assert.equal(top.subject, "Signed");
  assert.equal((await g.commitDetail(r, sha)).message, "Signed");
  assert.equal(existsSync(marker), false, "gpg.program ran");
});

test("git am stopped half way is shown as am, and given up as am; picks stopped between two as a cherry-pick", async () => {
  const dir = repo();
  const r = await open(dir);
  // A patch that cannot apply.
  const patch = path.join(home, `bad${n}.patch`);
  writeFileSync(patch, "From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001\nFrom: T <t@e>\nSubject: [PATCH] bad\n\n---\n a.txt | 1 +\n\ndiff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n-nothing like this\n+x\n two\n three\n");
  try {
    sh(dir, "am", patch);
  } catch {
    // Stopped.
  }
  assert.equal((await g.status(r)).operation, "am");
  await g.abortOperation(r);
  assert.equal((await g.status(r)).operation, null);

  // Two picks, the first empty-handed: stopped between them, only the sequencer says so.
  sh(dir, "switch", "-qc", "picks");
  writeFileSync(path.join(dir, "p1.txt"), "1\n");
  sh(dir, "add", "p1.txt");
  sh(dir, "commit", "-qm", "p1");
  writeFileSync(path.join(dir, "a.txt"), "clash\n");
  sh(dir, "commit", "-qam", "p2");
  sh(dir, "switch", "-q", "main");
  writeFileSync(path.join(dir, "a.txt"), "ours\n");
  sh(dir, "commit", "-qam", "ours");
  try {
    sh(dir, "cherry-pick", "picks~1", "picks");
  } catch {
    // Stopped on p2's conflict.
  }
  assert.equal((await g.status(r)).operation, "cherry-pick");
  sh(dir, "checkout", "-q", "--theirs", "a.txt");
  sh(dir, "add", "a.txt");
  execFileSync("git", ["-c", "core.editor=true", "commit", "-q", "--no-edit"], { cwd: dir });
  // The conflict is committed; what is left is the sequencer.
  if (existsSync(path.join(dir, ".git", "sequencer"))) assert.equal((await g.status(r)).operation, "cherry-pick");
});

test("a stash is acted on only when it is still the one the page means", async () => {
  const dir = repo();
  const r = await open(dir);
  writeFileSync(path.join(dir, "a.txt"), "first\n");
  await g.stashPush(r, "first");
  const [first] = await g.stashes(r);
  assert.match(first.sha, /^[0-9a-f]{40}$/);
  // Meanwhile: popped, and another pushed — stash@{0} is somebody else's now.
  sh(dir, "stash", "pop", "-q");
  writeFileSync(path.join(dir, "a.txt"), "second\n");
  sh(dir, "stash", "push", "-q", "-m", "second");
  await assert.rejects(g.stashDo(r, "drop", "stash@{0}", first.sha), { status: 409 });
  assert.match((await g.stashes(r))[0].message, /second/);
  const [second] = await g.stashes(r);
  await g.stashDo(r, "drop", second.ref, second.sha);
  assert.deepEqual(await g.stashes(r), []);
});

test("in a fork's clone the pull request names the fork's branch, and is compared with the repository forked from", async () => {
  const dir = forked();
  const r = await open(dir);
  // gh (the stand-in) says the repository is me/demo — upstream here, not origin.
  const state = await g.ghState(r, true);
  assert.equal(state.baseRef, "upstream/main");
  await g.createBranch(r, "topic");
  writeFileSync(path.join(dir, "t.txt"), "t\n");
  await g.stage(r, [], true);
  await g.commit(r, "Topic");
  writeFileSync(ghLog, "");
  await g.createPull(r, { title: "Topic", body: "", base: "main" });
  // Pushed to the fork, and asked for as the fork's.
  assert.equal((await g.status(r)).upstream, "origin/topic");
  assert.match(readFileSync(ghLog, "utf8"), /^pr create --title Topic --body-file - --head forker:topic --base main$/m);
});

test("a branch already on the remote and behind it gets its pull request without a push that would be refused", async () => {
  const dir = forked();
  const r = await open(dir);
  await g.createBranch(r, "behind");
  writeFileSync(path.join(dir, "b.txt"), "b\n");
  await g.stage(r, [], true);
  await g.commit(r, "Mine");
  await g.push(r);
  // Somebody else adds to it.
  const other = path.join(home, `collab${n}`);
  execFileSync("git", ["clone", "-q", "-b", "behind", path.join(home, `forker-demo${n}.git`), other]);
  writeFileSync(path.join(other, "c.txt"), "c\n");
  sh(other, "add", "c.txt");
  sh(other, "commit", "-qm", "Theirs");
  sh(other, "push", "-q");
  await g.fetch(r);
  assert.equal((await g.status(r)).behind, 1);
  writeFileSync(ghLog, "");
  await g.createPull(r, { title: "Behind", body: "" });
  assert.match(readFileSync(ghLog, "utf8"), /^pr create /m);
});

test("a branch made from a remote one follows nothing until pushed, and one that follows a branch of another name is published as itself", async () => {
  const dir = forked();
  const r = await open(dir);
  await g.createBranch(r, "fresh", "origin/main");
  assert.equal((await g.status(r)).upstream, null);
  writeFileSync(path.join(dir, "f.txt"), "f\n");
  await g.stage(r, [], true);
  await g.commit(r, "Fresh");
  await g.push(r);
  assert.equal((await g.status(r)).upstream, "origin/fresh");
  assert.equal(sh(dir, "rev-parse", "origin/main").trim(), sh(dir, "rev-parse", "upstream/main").trim(), "main was not pushed to");

  // Made in the shell, following origin/main: a plain push fails, or goes onto main.
  sh(dir, "switch", "-q", "-c", "shell", "--track", "origin/main");
  writeFileSync(path.join(dir, "s.txt"), "s\n");
  sh(dir, "add", "s.txt");
  sh(dir, "commit", "-qm", "Shell");
  const mainBefore = sh(dir, "rev-parse", "origin/main").trim();
  await g.push(r);
  assert.equal((await g.status(r)).upstream, "origin/shell");
  sh(dir, "fetch", "-q", "origin");
  assert.equal(sh(dir, "rev-parse", "origin/main").trim(), mainBefore);
});

