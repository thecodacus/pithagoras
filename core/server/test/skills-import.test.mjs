import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import express from "express";
import { inProcessHome } from "./server-harness.mjs";

/**
 * Taking skills from a git repository, against real repositories that are
 * local: git's `insteadOf` maps github.com to a folder, so nothing here
 * reaches the network. What a repository holds is somebody else's, and these
 * are the things such a repository can try: a name that is a place, a link
 * that leads into the portal's own files, an address that goes up out of the
 * clone, and one that has changed between the look and the import.
 */
const home = inProcessHome("pithagoras-skills-import-");
const agent = process.env.PI_CODING_AGENT_DIR;
const skills = path.join(agent, "skills");
const remote = path.join(home, "remote");
const config = path.join(home, "gitconfig");
// This machine's own git config, credential helpers and askpass are not part of the test.
writeFileSync(config, `[url "file://${remote}/"]\n\tinsteadOf = https://github.com/\n[protocol "file"]\n\tallow = always\n`);
process.env.GIT_CONFIG_GLOBAL = config;
process.env.GIT_CONFIG_NOSYSTEM = "1";
delete process.env.GIT_ASKPASS;
delete process.env.SSH_ASKPASS;

const { importFromGit, parseSpec, previewFromGit, readSource, withoutLogin } = await import("../dist/skills/github.js");
const { skillsRouter } = await import("../dist/api/skills.js");

const app = express();
app.use(express.json());
app.use("/api", skillsRouter());
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
after(() => { server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${server.address().port}`;
const send = (url, method, body) =>
  fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z" } }).trim();

/** What a SKILL.md looks like, with or without a name of its own. */
const skillMd = (name, description = "Use it when the tests say so") => `---\n${name === undefined ? "" : `name: ${name}\n`}description: ${JSON.stringify(description)}\n---\n\n# Steps\n`;

/** Files of a repository by path: text, or `{ link }` for a link. Written over what is there, and committed. */
function commit(dir, files, message = "change") {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    rmSync(file, { force: true });
    if (typeof content === "object") symlinkSync(content.link, file);
    else writeFileSync(file, content);
  }
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

/** A repository served as github.com/<slug>. */
function repo(slug, files) {
  const dir = path.join(remote, `${slug}.git`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  // What GitHub allows: a partial clone, and fetching a commit that is no longer a branch's head.
  git(dir, "config", "uploadpack.allowFilter", "true");
  git(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
  commit(dir, files, "first");
  return dir;
}

let n = 0;
/** The skills folder as a fresh one, with what a user already has in it. */
function fresh(have = {}) {
  rmSync(agent, { recursive: true, force: true });
  mkdirSync(skills, { recursive: true });
  for (const [rel, content] of Object.entries(have)) {
    mkdirSync(path.dirname(path.join(agent, rel)), { recursive: true });
    writeFileSync(path.join(agent, rel), content);
  }
  return `u${n++}`;
}

/** Everything under `dir`, as paths and what a file holds, to see that nothing changed. */
function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = entry.isSymbolicLink() ? `-> ${readFileSync(full, "latin1")}` : readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

test("an address is taken apart as it was pasted", () => {
  const table = [
    ["user/repo", { url: "https://github.com/user/repo.git", ref: undefined, subpath: undefined }],
    ["user/repo#dev", { url: "https://github.com/user/repo.git", ref: "dev", subpath: undefined }],
    ["user/repo/skills/pdf", { url: "https://github.com/user/repo.git", ref: undefined, subpath: "skills/pdf" }],
    ["user/repo/skills/pdf#v2", { url: "https://github.com/user/repo.git", ref: "v2", subpath: "skills/pdf" }],
    ["https://example.test/team/skills", { url: "https://example.test/team/skills.git", ref: undefined }],
    ["https://example.test/team/skills.git#dev", { url: "https://example.test/team/skills.git", ref: "dev" }],
    ["git@example.test:team/skills.git", { url: "git@example.test:team/skills.git", ref: undefined }],
    ["ssh://git@example.test/team/skills", { url: "ssh://git@example.test/team/skills.git", ref: undefined }],
    ["https://github.com/u/r/tree/main", { url: "https://github.com/u/r.git", ref: "main", subpath: undefined, tree: undefined }],
    ["https://github.com/u/r/tree/main/skills/pdf", { url: "https://github.com/u/r.git", ref: "main", subpath: "skills/pdf", tree: "main/skills/pdf" }],
  ];
  for (const [input, want] of table) assert.deepEqual(parseSpec(input), want, input);
});

test("an address that goes up out of the repository, or into git's own files, is refused before anything is cloned", () => {
  for (const input of [
    "https://github.com/u/r/tree/main/../../../../home/me/projects",
    "https://github.com/u/r/tree/main/skills/../../..",
    "u/r/../../etc",
    "u/r/skills/..",
    "u/r/.git/hooks",
    "u/r/a\\..\\b",
  ]) assert.throws(() => parseSpec(input), /does not name a folder inside the repository/, input);
  assert.throws(() => parseSpec("just words"), /Cannot tell/);
});

test("an address with a login in it is refused, and an ssh user is not a login", () => {
  for (const input of ["https://oauth2:token@github.com/o/r", "https://token@github.com/o/r", "http://u:p@example.test/o/r", "ssh://git:secret@example.test/o/r"]) {
    assert.throws(() => parseSpec(input), /Leave the login out of the address/, input);
  }
  assert.doesNotThrow(() => parseSpec("ssh://git@example.test/o/r"));
  assert.doesNotThrow(() => parseSpec("git@example.test:o/r"));
  assert.equal(withoutLogin("see https://oauth2:tok@github.com/o/r.git and ssh://git:pw@h/x and git@h:o/r"), "see https://github.com/o/r.git and ssh://git@h/x and git@h:o/r");
});

test("a skill whose name is a place is not installed, and nothing outside the skills folder is touched", async () => {
  const user = fresh({ "auth.json": '{"key":"secret"}', "escaped/keep.txt": "keep", "settings.json": "{}" });
  repo(`${user}/bad`, {
    "up/SKILL.md": skillMd(".."),
    "out/SKILL.md": skillMd("../escaped"),
    "deep/SKILL.md": skillMd("a/b"),
    "back/SKILL.md": skillMd("a\\b"),
    "dot/SKILL.md": skillMd(".hidden"),
    "fine/SKILL.md": skillMd("fine"),
  });
  const before = tree(agent);

  const looked = await previewFromGit(`${user}/bad`, skills);
  assert.deepEqual(looked.found.map((f) => f.name), ["fine"]);
  assert.deepEqual(looked.skipped.map((s) => s.reason), Array(5).fill("unusable name"));

  // As the page sends it: everything listed, and overwrite on.
  const result = await importFromGit(`${user}/bad`, skills, { overwrite: true, only: ["fine"] });
  assert.deepEqual(result.imported, ["fine"]);
  const all = await importFromGit(`${user}/bad`, skills, { overwrite: true });
  assert.deepEqual(all.imported, ["fine"]);
  assert.equal(all.skipped.filter((s) => s.reason === "unusable name").length, 5);

  const after = tree(agent);
  for (const [file, content] of Object.entries(before)) assert.equal(after[file], content, `${file} is as it was`);
  assert.deepEqual(Object.keys(after).filter((f) => !(f in before)).sort(), ["skills/fine/.source.json", "skills/fine/SKILL.md"]);
});

test("a repository's own .source.json, a link that leads into the portal's files, is not written through", async () => {
  const user = fresh();
  const victim = path.join(home, "victim");
  writeFileSync(victim, "the portal's database");
  repo(`${user}/linked`, {
    "pdf/SKILL.md": skillMd("pdf"),
    "pdf/.source.json": { link: victim },
    "pdf/notes": { link: victim },
  });
  const result = await importFromGit(`${user}/linked`, skills, { overwrite: true });
  assert.deepEqual(result.imported, ["pdf"]);
  assert.equal(readFileSync(victim, "utf8"), "the portal's database", "the file the link led to is as it was");
  assert.equal(lstatSync(path.join(skills, "pdf", ".source.json")).isFile(), true);
  assert.equal(readSource(path.join(skills, "pdf"))?.spec, `${user}/linked`);
  // Checked out as the small file holding where the link led, which is all it is here.
  assert.equal(lstatSync(path.join(skills, "pdf", "notes")).isSymbolicLink(), false, "no link comes along");
  assert.equal(readFileSync(path.join(skills, "pdf", "notes"), "utf8"), victim);
});

test("a link to a skill the user has is not a skill of the repository, and the user's is not deleted by it", async () => {
  const user = fresh({ "skills/foo/SKILL.md": skillMd("foo", "mine, and edited") });
  repo(`${user}/trap`, {
    "foo": { link: path.join(skills, "foo") },
    "real/SKILL.md": skillMd("real"),
  });
  const looked = await previewFromGit(`${user}/trap`, skills);
  assert.deepEqual(looked.found.map((f) => f.name), ["real"]);
  const result = await importFromGit(`${user}/trap`, skills, { overwrite: true });
  assert.deepEqual(result.imported, ["real"]);
  assert.match(readFileSync(path.join(skills, "foo", "SKILL.md"), "utf8"), /mine, and edited/);
});

test("a SKILL.md that is a link to a device is looked at at once, and not read", async () => {
  const user = fresh();
  repo(`${user}/zero`, { "x/SKILL.md": { link: "/dev/zero" }, "ok/SKILL.md": skillMd("ok") });
  const looked = await previewFromGit(`${user}/zero`, skills);
  assert.ok(looked.found.some((f) => f.name === "ok"));
});

test("a skill at the top of the repository with no name of its own is named for the repository", async () => {
  const user = fresh();
  repo(`${user}/solo`, { "SKILL.md": skillMd(undefined, "A whole repository that is one skill"), "README.md": "readme" });
  const looked = await previewFromGit(`${user}/solo`, skills);
  assert.deepEqual(looked.found.map((f) => f.name), ["solo"]);
  const result = await importFromGit(`${user}/solo`, skills, { only: ["solo"] });
  assert.deepEqual(result.imported, ["solo"]);
  assert.equal(existsSync(path.join(skills, "solo", "SKILL.md")), true);
  assert.equal(existsSync(path.join(skills, "solo", "README.md")), true);
  assert.equal(existsSync(path.join(skills, "solo", ".git")), false, "the repository's own git files do not come along");
});

test("a repository's .github and .gitignore come along with a skill, and its .git does not", async () => {
  const user = fresh();
  repo(`${user}/dots`, { "SKILL.md": skillMd("dots"), ".github/ci.yml": "ci", ".gitignore": "x" });
  await importFromGit(`${user}/dots`, skills, {});
  assert.equal(existsSync(path.join(skills, "dots", ".github", "ci.yml")), true);
  assert.equal(existsSync(path.join(skills, "dots", ".gitignore")), true);
  assert.equal(existsSync(path.join(skills, "dots", ".git")), false);
});

test("a name asked for that the repository does not have is said, not dropped", async () => {
  const user = fresh();
  repo(`${user}/some`, { "pdf/SKILL.md": skillMd("pdf") });
  const result = await importFromGit(`${user}/some`, skills, { only: ["pdf", "gone"], overwrite: true });
  assert.deepEqual(result.imported, ["pdf"]);
  assert.deepEqual(result.skipped, [{ name: "gone", reason: "not in the repository any more" }]);
});

test("two skills of one repository with the same name are not installed over one another", async () => {
  const user = fresh();
  repo(`${user}/twins`, { "a/SKILL.md": skillMd("same"), "b/SKILL.md": skillMd("same") });
  const looked = await previewFromGit(`${user}/twins`, skills);
  assert.deepEqual(looked.found.map((f) => f.name), ["same"]);
  assert.equal(looked.skipped.length, 1);
});

test("the address of a folder on a branch with a slash in its name is taken apart where the branch ends", async () => {
  const user = fresh();
  const dir = repo(`${user}/branches`, { "README.md": "main has no skills" });
  git(dir, "checkout", "-q", "-b", "release/2.0");
  const head = commit(dir, { "skills/pdf/SKILL.md": skillMd("pdf") }, "on the branch");
  git(dir, "checkout", "-q", "main");
  const looked = await previewFromGit(`https://github.com/${user}/branches/tree/release/2.0/skills/pdf`, skills);
  assert.deepEqual(looked.found.map((f) => f.name), ["pdf"]);
  assert.equal(looked.sha, head);
});

test("a folder on a plain branch still is the branch and the folder", async () => {
  const user = fresh();
  repo(`${user}/plain`, { "skills/pdf/SKILL.md": skillMd("pdf"), "other/SKILL.md": skillMd("other") });
  const looked = await previewFromGit(`https://github.com/${user}/plain/tree/main/skills/pdf`, skills);
  assert.deepEqual(looked.found.map((f) => f.name), ["pdf"]);
});

test("a repository that asks for a login fails at once, saying it is private, instead of waiting on a prompt", async () => {
  fresh();
  const asking = createServer((req, res) => {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="repo"' });
    res.end();
  });
  asking.listen(0, "127.0.0.1");
  await once(asking, "listening");
  try {
    const started = Date.now();
    await assert.rejects(previewFromGit(`http://127.0.0.1:${asking.address().port}/team/private`, skills), /Not found, or private: this server has no login for it/);
    assert.ok(Date.now() - started < 30_000);
  } finally {
    asking.closeAllConnections();
    asking.close();
  }
});

test("what is installed is what was looked at, also when the branch has moved on", async () => {
  const user = fresh();
  const dir = repo(`${user}/moving`, { "pdf/SKILL.md": skillMd("pdf", "version one") });
  const looked = await previewFromGit(`${user}/moving`, skills);
  commit(dir, { "pdf/SKILL.md": skillMd("pdf", "version two") }, "moved on");

  const result = await importFromGit(`${user}/moving`, skills, { overwrite: true, sha: looked.sha });
  assert.deepEqual(result.imported, ["pdf"]);
  assert.match(readFileSync(path.join(skills, "pdf", "SKILL.md"), "utf8"), /version one/);

  // Without one, it is the head, as an update is.
  await importFromGit(`${user}/moving`, skills, { overwrite: true });
  assert.match(readFileSync(path.join(skills, "pdf", "SKILL.md"), "utf8"), /version two/);
});

test("a commit that is not there any more is said, and nothing is installed", async () => {
  const user = fresh();
  repo(`${user}/gone`, { "pdf/SKILL.md": skillMd("pdf") });
  await assert.rejects(importFromGit(`${user}/gone`, skills, { sha: "0".repeat(40) }), /changed since you looked at it/);
  assert.equal(existsSync(path.join(skills, "pdf")), false);
});

test("a folder is fetched on its own, and links are not checked out, as the clone is made", async () => {
  const user = fresh();
  repo(`${user}/mono`, { "skills/pdf/SKILL.md": skillMd("pdf"), "big/blob.bin": "x".repeat(1000) });
  // A git that says how it was called, in front of the real one.
  const log = path.join(home, "git-calls");
  const shim = path.join(home, "shim");
  mkdirSync(shim, { recursive: true });
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(path.join(shim, "git"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim}${path.delimiter}${savedPath}`;
  try {
    const looked = await previewFromGit(`${user}/mono/skills/pdf`, skills);
    assert.deepEqual(looked.found.map((f) => f.name), ["pdf"]);
    await previewFromGit(`${user}/mono`, skills);
  } finally {
    process.env.PATH = savedPath;
  }
  const calls = readFileSync(log, "utf8").split("\n").filter((l) => /\bclone\b/.test(l));
  assert.equal(calls.length, 2);
  assert.match(calls[0], /core\.symlinks=false/);
  assert.match(calls[0], /--filter=blob:none/);
  assert.match(calls[0], /--sparse/);
  assert.match(calls[1], /core\.symlinks=false/);
  assert.doesNotMatch(calls[1], /--sparse/, "the whole repository is wanted, so the whole of it is written");
  assert.match(readFileSync(log, "utf8"), /sparse-checkout set -- skills\/pdf/);
});

test("a skill that cannot be put in place leaves the installed one as it was, and says so", { skip: process.getuid?.() === 0 && "root is not held to a folder's permissions" }, async () => {
  const user = fresh({ "skills/pdf/SKILL.md": skillMd("pdf", "mine"), "skills/pdf/extra.txt": "kept" });
  repo(`${user}/blocked`, { "pdf/SKILL.md": skillMd("pdf", "theirs") });
  chmodSync(skills, 0o555);
  try {
    const result = await importFromGit(`${user}/blocked`, skills, { overwrite: true });
    assert.deepEqual(result.imported, []);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].name, "pdf");
    assert.match(result.skipped[0].reason, /EACCES|permission/i);
  } finally {
    chmodSync(skills, 0o755);
  }
  assert.match(readFileSync(path.join(skills, "pdf", "SKILL.md"), "utf8"), /mine/);
  assert.equal(readFileSync(path.join(skills, "pdf", "extra.txt"), "utf8"), "kept");
});

test("a copy made on the way is not left behind, and is not a skill to pi", async () => {
  const user = fresh({ "skills/pdf/SKILL.md": skillMd("pdf", "mine") });
  repo(`${user}/tidy`, { "pdf/SKILL.md": skillMd("pdf", "theirs") });
  await importFromGit(`${user}/tidy`, skills, { overwrite: true });
  assert.deepEqual(readdirSync(skills), ["pdf"]);
  assert.match(readFileSync(path.join(skills, "pdf", "SKILL.md"), "utf8"), /theirs/);
});

test("the origin is kept without a login, and one an older import kept is shown and written again without", async () => {
  const user = fresh();
  repo(`${user}/old`, { "old/SKILL.md": skillMd("old") });
  mkdirSync(path.join(skills, "old"), { recursive: true });
  writeFileSync(path.join(skills, "old", "SKILL.md"), skillMd("old"));
  writeFileSync(
    path.join(skills, "old", ".source.json"),
    JSON.stringify({ spec: `https://oauth2:ghp_token@github.com/${user}/old`, url: `https://oauth2:ghp_token@github.com/${user}/old.git`, importedAt: "2026-01-01T00:00:00Z" }),
  );

  assert.equal(readSource(path.join(skills, "old")).spec, `https://github.com/${user}/old`);
  assert.equal(readSource(path.join(skills, "old")).url, `https://github.com/${user}/old.git`);
  const listed = await (await fetch(`${base}/api/skills`)).json();
  assert.equal(listed.skills.find((s) => s.name === "old").source.spec, `https://github.com/${user}/old`);
  assert.doesNotMatch(JSON.stringify(listed), /ghp_token/);

  const updated = await send("/api/skills/old/update", "POST");
  assert.equal(updated.status, 200);
  assert.doesNotMatch(readFileSync(path.join(skills, "old", ".source.json"), "utf8"), /ghp_token|oauth2/);
});

test("a source file that is a link is not read", () => {
  fresh();
  mkdirSync(path.join(skills, "linked"), { recursive: true });
  symlinkSync("/dev/zero", path.join(skills, "linked", ".source.json"));
  assert.equal(readSource(path.join(skills, "linked")), null);
});

test("the routes: a look says which commit it saw, an import takes it, and what cannot be asked is refused", async () => {
  const user = fresh();
  repo(`${user}/routes`, { "pdf/SKILL.md": skillMd("pdf") });

  const look = await send("/api/skills/preview-import", "POST", { spec: `${user}/routes` });
  assert.equal(look.status, 200);
  const seen = await look.json();
  assert.match(seen.sha, /^[0-9a-f]{40}$/);
  assert.deepEqual(seen.found.map((f) => f.name), ["pdf"]);

  const bad = await send("/api/skills/import", "POST", { spec: `${user}/routes`, sha: "main", only: ["pdf"], overwrite: true });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /sha must be a commit id/);

  const refused = await send("/api/skills/preview-import", "POST", { spec: "https://github.com/u/r/tree/main/../../../../home/me/projects" });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /does not name a folder inside the repository/);

  const login = await send("/api/skills/import", "POST", { spec: "https://oauth2:tok@github.com/o/r", only: [], overwrite: true });
  assert.equal(login.status, 400);
  assert.match((await login.json()).error, /Leave the login out/);

  const done = await send("/api/skills/import", "POST", { spec: `${user}/routes`, sha: seen.sha, only: ["pdf"], overwrite: true });
  assert.equal(done.status, 200);
  assert.deepEqual((await done.json()).imported, ["pdf"]);
});

test("an update that finds nothing says so, and one that finds the skill changes it", async () => {
  const user = fresh();
  const dir = repo(`${user}/upstream`, { "pdf/SKILL.md": skillMd("pdf", "version one") });
  await importFromGit(`${user}/upstream`, skills, { overwrite: true });

  commit(dir, { "pdf/SKILL.md": skillMd("pdf", "version two") });
  const updated = await send("/api/skills/pdf/update", "POST");
  assert.equal(updated.status, 200);
  assert.match(readFileSync(path.join(skills, "pdf", "SKILL.md"), "utf8"), /version two/);

  // Upstream renames it: what this copy came from is no longer there.
  commit(dir, { "pdf/SKILL.md": skillMd("pdf-renamed") });
  const gone = await send("/api/skills/pdf/update", "POST");
  assert.equal(gone.status, 404);
  assert.match((await gone.json()).error, /not in the repository any more/);
  assert.match(readFileSync(path.join(skills, "pdf", "SKILL.md"), "utf8"), /version two/);
});
