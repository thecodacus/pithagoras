import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "../../../core/server/test/server-harness.mjs";

/**
 * Files' routes (src/server.ts), on what the portal gives every server half for
 * a chat's folder (`portal.files`, extension-host.ts's folderFiles): the
 * portal's own checks, reached the way Files reaches them.
 */

// A home of its own: who commits, and no config of the person running the tests.
const home = inProcessHome("pithagoras-files-routes-");
process.env.HOME = home;
process.env.GIT_CONFIG_GLOBAL = path.join(home, ".gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Tester\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n");

const { default: express } = await import("express");
const { folderFiles } = await import("../../../core/server/dist/extension-host.js");
const { baseDir } = await import("../../../core/server/dist/workspace-files.js");
const { routes } = await import("../src/server.ts");

const work = path.join(home, "work");
const outside = path.join(home, "outside");
mkdirSync(work);
mkdirSync(outside);

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
let n = 0;
/** A clone in the chat's folder, of a repository that has one commit. */
function clone(name: string) {
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
function commitHere(dir: string) {
  writeFileSync(path.join(dir, "a.txt"), "only here\n");
  sh(dir, "commit", "-qam", "only here");
}

/** The routes as the portal mounts a server half's: at /api/x/<package>, no body read unless a route asks. */
async function withApi(fn: (base: string) => Promise<void>, files: typeof folderFiles = folderFiles) {
  const app = express();
  const router = express.Router();
  routes(router, express.json(), files, (id) => {
    if (id !== "del") throw new Error("No such chat");
    return baseDir(work);
  });
  app.use("/api/x/pithagoras-files", router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/x/pithagoras-files/chats/del`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}
const answer = async (r: Response) => ({ status: r.status, ...((await r.json()) as Record<string, unknown>) });
const del = (base: string, p: string, query = "") => fetch(`${base}/file?path=${encodeURIComponent(p)}${query}`, { method: "DELETE" }).then(answer);
const send = (base: string, route: string, method: string, body: unknown) =>
  fetch(base + route, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(answer);

test("a folder is listed, a file read, saved over what it was read as, and refused over what changed since", async () => {
  await withApi(async (base) => {
    mkdirSync(path.join(work, "docs"));
    writeFileSync(path.join(work, "docs", "note.md"), "one\n");
    const listed = await fetch(`${base}/files?path=docs`).then(answer);
    assert.equal(listed.path, "docs");
    assert.deepEqual((listed.entries as { name: string }[]).map((e) => e.name), ["note.md"]);
    const read = (await fetch(`${base}/file?path=docs/note.md`).then(answer)) as { content: string; mtime: number };
    assert.equal(read.content, "one\n");
    const saved = await send(base, "/file?path=docs/note.md", "PUT", { content: "two\n", mtime: read.mtime });
    assert.equal(saved.ok, true);
    assert.equal(readFileSync(path.join(work, "docs", "note.md"), "utf8"), "two\n");
    // The agent wrote it in the meantime: what was on screen does not go over it.
    const stale = await send(base, "/file?path=docs/note.md", "PUT", { content: "three\n", mtime: read.mtime });
    assert.equal(stale.status, 409);
    assert.equal(stale.code, "conflict");
    assert.equal(readFileSync(path.join(work, "docs", "note.md"), "utf8"), "two\n");
    assert.equal((await send(base, "/file?path=docs/note.md", "PUT", {})).status, 400, "no content");
  });
});

test("a read that says what it saw of the file is told that it is unchanged, without the text, and otherwise gets the file", async () => {
  await withApi(async (base) => {
    writeFileSync(path.join(work, "seen.md"), "one\n");
    const read = (await fetch(`${base}/file?path=seen.md`).then(answer)) as { content: string; mtime: number; size: number };
    const again = (query: string) => fetch(`${base}/file?path=seen.md${query}`).then(answer);
    assert.deepEqual(await again(`&since=${read.mtime}&size=${read.size}`), { status: 200, unchanged: true });
    // Another time, or another size, is another file: the text comes.
    assert.equal(((await again(`&since=${read.mtime - 1}&size=${read.size}`)) as { content?: string }).content, "one\n");
    assert.equal(((await again(`&since=${read.mtime}&size=${read.size + 1}`)) as { content?: string }).content, "one\n");
    assert.equal(((await again(`&since=${read.mtime}`)) as { content?: string }).content, "one\n", "no size");
    writeFileSync(path.join(work, "seen.md"), "two!\n");
    const changed = (await again(`&since=${read.mtime}&size=${read.size}`)) as { content?: string; unchanged?: boolean };
    assert.equal(changed.content, "two!\n");
    assert.equal(changed.unchanged, undefined);
    // A file that is not there is still said to be not there.
    assert.equal((await fetch(`${base}/file?path=nope.md&since=1&size=1`).then(answer)).status, 404);
  });
});

test("a look at whether the file changed does not read it, and one that finds it changed does", async () => {
  let reads = 0;
  const counting = { ...folderFiles, read: (...args: Parameters<typeof folderFiles.read>) => (reads++, folderFiles.read(...args)) } as typeof folderFiles;
  await withApi(async (base) => {
    writeFileSync(path.join(work, "light.md"), "one\n");
    const read = (await fetch(`${base}/file?path=light.md`).then(answer)) as { mtime: number; size: number };
    reads = 0;
    assert.deepEqual(await fetch(`${base}/file?path=light.md&since=${read.mtime}&size=${read.size}`).then(answer), { status: 200, unchanged: true });
    assert.equal(reads, 0);
    assert.equal(((await fetch(`${base}/file?path=light.md&since=${read.mtime}&size=${read.size + 1}`).then(answer)) as { content?: string }).content, "one\n");
    assert.equal(reads, 1);
  }, counting);
});

test("nothing outside the chat's folder is reached, through a path or a link the agent left", async () => {
  await withApi(async (base) => {
    writeFileSync(path.join(outside, "secret.txt"), "not yours");
    symlinkSync(outside, path.join(work, "away"));
    assert.equal((await fetch(`${base}/file?path=../outside/secret.txt`).then(answer)).status, 400);
    assert.equal((await fetch(`${base}/file?path=away/secret.txt`).then(answer)).status, 400);
    assert.equal((await send(base, "/file?path=away/secret.txt", "PUT", { content: "changed" })).status, 400);
    assert.equal(readFileSync(path.join(outside, "secret.txt"), "utf8"), "not yours");
    assert.equal((await fetch(`${base}/files?path=away`).then(answer)).status, 400);
  });
});

test("a chat that is not there has no folder", async () => {
  await withApi(async (base) => {
    const res = await fetch(base.replace("/chats/del", "/chats/gone") + "/files?path=");
    assert.equal(res.status, 404);
  });
});

test("a new folder is made once, and a new file never replaces one", async () => {
  await withApi(async (base) => {
    const made = await send(base, "/folder?path=", "POST", { name: "notes" });
    assert.equal(made.path, "notes");
    assert.equal((await send(base, "/folder?path=", "POST", { name: "notes" })).status, 409);
    assert.equal((await send(base, "/folder?path=", "POST", { name: "a/b" })).status, 400);
    writeFileSync(path.join(work, "notes", "keep.md"), "mine");
    assert.equal((await send(base, "/file?path=notes/keep.md", "PUT", { content: "", create: true })).status, 409);
    assert.equal(readFileSync(path.join(work, "notes", "keep.md"), "utf8"), "mine");
    // And one that is not there is made.
    assert.equal((await send(base, "/file?path=notes/new.md", "PUT", { content: "", create: true })).ok, true);
    assert.ok(existsSync(path.join(work, "notes", "new.md")));
  });
});

test("a file and a folder are renamed in place, a file downloaded as it is, and a folder as a .tar.gz", async () => {
  await withApi(async (base) => {
    mkdirSync(path.join(work, "box"));
    writeFileSync(path.join(work, "box", "old.txt"), "kept");
    const renamed = await send(base, "/file?path=box/old.txt", "PATCH", { name: "new.txt" });
    assert.equal(renamed.path, "box/new.txt");
    assert.equal((await send(base, "/file?path=box/new.txt", "PATCH", { name: "a/b" })).status, 400);
    const download = await fetch(`${base}/file?path=box/new.txt&download=1`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition") ?? "", /new\.txt/);
    assert.equal(await download.text(), "kept");
    const archive = await fetch(`${base}/archive?path=box`);
    assert.equal(archive.status, 200);
    assert.equal(archive.headers.get("content-type"), "application/gzip");
    assert.match(archive.headers.get("content-disposition") ?? "", /box\.tar\.gz/);
    assert.ok((await archive.arrayBuffer()).byteLength > 0);
    assert.equal((await fetch(`${base}/archive?path=box/new.txt`).then(answer)).status, 400, "a file is not a folder");
  });
});

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

test("a folder tree, as the panel sends it, cannot reach out of the chat's folder by a folder's name, a path, or a link", async () => {
  const { filesRouter } = await import("../../../core/server/dist/api/files.js");
  const { createSession } = await import("../../../core/server/dist/db.js");
  const tree = path.join(work, "tree-chat");
  mkdirSync(tree);
  const target = path.join(home, "tree-outside");
  mkdirSync(target);
  symlinkSync(target, path.join(tree, "escape"));
  createSession({ id: "tree", title: "tree", workspace: tree, executor: "host" });
  const app = express();
  // As the portal mounts them: an upload is not parsed, and Files' routes are its own.
  app.use((req, res, next) => (req.path.endsWith("/upload") ? next() : express.json()(req, res, next)));
  app.use("/api", filesRouter());
  const router = express.Router();
  routes(router, express.json(), folderFiles, () => baseDir(tree));
  app.use("/api/x/pithagoras-files", router);
  const server = app.listen(0);
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const folder = (dir: string, name: unknown) => send(`${origin}/api/x/pithagoras-files/chats/tree`, `/folder?path=${encodeURIComponent(dir)}`, "POST", { name });
  const upload = (dir: string, name: string) =>
    fetch(`${origin}/api/sessions/tree/upload?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: "x" }).then(answer);
  try {
    // A name that is a way out, as a relative path from the client would make one.
    for (const name of ["..", ".", "../outside", "a/b", "/etc", "a\\b", "a\0b", ""]) assert.equal((await folder("", name)).status, 400, JSON.stringify(name));
    // A place that is a way out.
    for (const dir of ["..", "../tree-outside", "/etc", "escape", "escape/sub", "a/../../x"]) {
      // Refused, or not found: an absolute path is read from the chat's folder, where there is no such place.
      assert.ok([400, 404].includes((await folder(dir, "x")).status), `folder in ${dir}`);
      assert.ok([400, 404].includes((await upload(dir, "x.txt")).status), `upload to ${dir}`);
    }
    for (const name of ["../x.txt", "a/../../x.txt", "/etc/passwd", ".."]) assert.equal((await upload("", name)).status, 400, name);
    assert.equal((await folder("..", "x")).status, 400);
    assert.equal((await folder("escape", "x")).status, 400);
    assert.deepEqual(readdirSync(target), []);
    assert.deepEqual(readdirSync(tree).sort(), ["escape"]);
    // The tree itself: the folder is made, a second of the name is refused with its code (the panel numbers it), and a file goes in.
    assert.deepEqual(await folder("", "proj"), { status: 200, ok: true, path: "proj" });
    assert.deepEqual(await folder("", "proj"), { status: 409, error: 'There is already something called "proj" here', code: "exists" });
    assert.equal((await folder("", "proj (2)")).path, "proj (2)");
    assert.equal((await folder("proj", "src")).path, "proj/src");
    assert.equal((await upload("proj/src", "a.txt")).path, "proj/src/a.txt");
    assert.equal((await upload("proj/src", "a.txt")).path, "proj/src/a (2).txt");
    assert.deepEqual(readdirSync(target), []);
  } finally {
    server.close();
  }
});
