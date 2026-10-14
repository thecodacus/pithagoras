import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome, scratch } from "./server-harness.mjs";

// What a test's home keeps from reaching: the repository that its temp folder may lie in.

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("a push from a test's chat folder cannot reach the repository that the temp folder lies in", () => {
  // A developer whose TMPDIR is inside a work tree: a repository with a remote of its own.
  const outer = scratch("pithagoras-ceiling-");
  const remote = path.join(outer, "remote.git");
  const repo = path.join(outer, "repo");
  mkdirSync(repo);
  git(outer, "init", "--bare", "-b", "main", remote);
  git(repo, "init", "-b", "main");
  writeFileSync(path.join(repo, "work"), "one");
  git(repo, "add", "work");
  git(repo, "commit", "-m", "one");
  git(repo, "remote", "add", "origin", remote);
  mkdirSync(path.join(repo, "tmp"));
  process.env.TMPDIR = path.join(repo, "tmp");

  inProcessHome("pithagoras-inside-");
  const chat = path.join(process.env.WORKSPACE_ROOT, "chat-1");
  mkdirSync(chat);
  // As pi's bash tool runs it: in the chat folder, with this process's environment.
  assert.throws(() => git(chat, "push", "origin", "main"), (e) => e.status === 128, "fatal: no repository here");
  assert.throws(() => git(remote, "rev-parse", "--verify", "main"), "nothing arrived at the remote");
});

test("a commit in a test's home does not read the git config of the person running the tests", () => {
  // A developer who signs their commits, with a program that cannot sign now (a key that is not plugged in).
  const theirs = path.join(scratch("pithagoras-theirs-"), "gitconfig");
  writeFileSync(theirs, "[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /bin/false\n");
  process.env.GIT_CONFIG_GLOBAL = theirs;
  inProcessHome("pithagoras-signing-");
  const repo = path.join(process.env.WORKSPACE_ROOT, "signed");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  writeFileSync(path.join(repo, "work"), "one");
  git(repo, "add", "work");
  // Fails with "failed to sign the data" where their config is read.
  git(repo, "commit", "-m", "one");
  assert.equal(git(repo, "log", "--format=%s").trim(), "one");
});
