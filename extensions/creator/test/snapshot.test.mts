import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { inProcessHome, scratch } from "../../../core/server/test/server-harness.mjs";
import { LIMITS, installed, snapshot, sweepLeftovers, undo } from "../src/server/snapshot.ts";

/**
 * A draft copied into Creator's own folder: walked with the portal's own `files`, as the chat's agent; links left out
 * and named; the caps; a copy with fresh times; a file the agent may not read refusing it; nothing left of a refusal,
 * a swap or a start that was stopped; what a cut-off install left swept as a start begins; the portal answering while
 * a large draft is copied; and a digest that tells drafts apart however their files are cut.
 */
inProcessHome("pithagoras-creator-snapshot-");
const { folderFiles } = await import(new URL("../../../core/server/dist/folder-files.js", import.meta.url).href);

const base = realpathSync(scratch("creator-chat-"));
const data = realpathSync(scratch("creator-data-"));
const made = path.join(data, "made");
const chat = { id: "c1", title: "A chat", workspace: base, status: "idle" as const };
/** What the snapshot is given of the portal: the chat's folder, the portal's own files, Creator's data folder. `open` can be changed. */
const files = { ...folderFiles };
const run = { portal: { extension: "pithagoras-creator", dataDir: () => data, chats: { folder: () => base }, files }, stopped: false } as any;

let drafts = 0;
/** A draft in the chat's folder: `extensions/<folder>`, with a package.json named `name` and `more` files. */
function draft(name: string, more: Record<string, string | Buffer> = {}): string {
  const rel = `extensions/d${++drafts}`;
  const dir = path.join(base, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", pi: {} }));
  for (const [file, text] of Object.entries(more)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return rel;
}
/** What is in `made/` besides the copies themselves. */
const leftovers = () => (existsSync(made) ? readdirSync(made).filter((name) => name.startsWith(".")) : []);

test("a draft is copied whole, links left out and named, with the copy's own fresh times", async () => {
  const rel = draft("whole", { "server.js": "export default () => {};\n", "web/client.js": "export default () => {};\n", "node_modules/dep/index.js": "module.exports = 1;\n" });
  const dir = path.join(base, rel);
  symlinkSync("../dep/index.js", path.join(dir, "node_modules", "dep", "bin.js"));
  mkdirSync(path.join(dir, "node_modules", ".bin"));
  symlinkSync("../dep/index.js", path.join(dir, "node_modules", ".bin", "dep"));
  symlinkSync("/etc/hosts", path.join(dir, "hosts"));
  const past = new Date("2020-01-01T00:00:00Z");
  utimesSync(path.join(dir, "server.js"), past, past);

  const copy = await snapshot(run, chat, rel);
  assert.equal(copy.name, "whole");
  assert.equal(copy.version, "1.0.0");
  assert.equal(copy.folder, path.join(made, "whole"));
  assert.equal(copy.files, 4);
  assert.deepEqual(copy.left.sort(), ["hosts", "node_modules/.bin/dep", "node_modules/dep/bin.js"]);
  assert.equal(readFileSync(path.join(copy.folder, "server.js"), "utf8"), "export default () => {};\n");
  assert.equal(existsSync(path.join(copy.folder, "hosts")), false);
  assert.ok(statSync(path.join(copy.folder, "server.js")).mtimeMs > past.getTime() + 1000, "a time of its own, so the half's revision is new");
  assert.equal(statSync(path.join(copy.folder, "server.js")).mode & 0o777, 0o600);
  assert.equal(statSync(copy.folder).mode & 0o777, 0o700);
  assert.match(copy.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(leftovers(), []);

  // Copied again: the copy is replaced at its path, the one before kept aside until it is installed, and then gone.
  writeFileSync(path.join(dir, "server.js"), "export default () => 2;\n");
  const again = await snapshot(run, chat, rel);
  assert.equal(again.folder, copy.folder);
  assert.notEqual(again.digest, copy.digest);
  assert.equal(readFileSync(path.join(copy.folder, "server.js"), "utf8"), "export default () => 2;\n");
  assert.match(path.basename(again.old!), /^\.old-whole-[0-9a-f]{8}$/);
  assert.equal(readFileSync(path.join(again.old!, "server.js"), "utf8"), "export default () => {};\n");
  assert.deepEqual(leftovers(), [path.basename(again.old!)]);
  installed(again);
  assert.deepEqual(leftovers(), []);
});

test("a copy that was not installed is undone: the one before it is put back, or a first one removed", async () => {
  const rel = draft("undone", { "server.js": "export default () => 1;\n" });
  const first = await snapshot(run, chat, rel);
  assert.equal(first.old, undefined);
  installed(first);
  writeFileSync(path.join(base, rel, "server.js"), "export default () => 2;\n");
  undo(await snapshot(run, chat, rel));
  assert.equal(readFileSync(path.join(first.folder, "server.js"), "utf8"), "export default () => 1;\n", "the copy before it is back");
  assert.deepEqual(leftovers(), []);
  const lone = await snapshot(run, chat, draft("lone"));
  undo(lone);
  assert.equal(existsSync(lone.folder), false);
  assert.deepEqual(leftovers(), []);
});

test("a path out of the chat's folder is refused: `..`, an absolute path, a link that leads out", async () => {
  const outside = scratch("creator-outside-");
  writeFileSync(path.join(outside, "package.json"), JSON.stringify({ name: "outside", pi: {} }));
  symlinkSync(outside, path.join(base, "out"));
  for (const [rel, refused] of [
    ["../x", /leads outside the folder/],
    [outside, /^path is a folder of this chat's folder, written relative to it/],
    ["", /^path is a folder of this chat's folder, written relative to it/],
    ["out", /leads outside the folder/],
  ] as const) {
    await assert.rejects(snapshot(run, chat, rel), { message: refused }, rel);
  }
  assert.equal(existsSync(path.join(made, "outside")), false);
  assert.deepEqual(leftovers(), []);
});

test("the caps refuse a draft, each saying what was over: its size, its files, its depth, a folder of more than 2,000 entries", async () => {
  const kept = { ...LIMITS };
  try {
    LIMITS.bytes = 1000;
    await assert.rejects(snapshot(run, chat, draft("big", { "a.bin": Buffer.alloc(600), "b.bin": Buffer.alloc(600) })), { message: /^It is over what is copied of an extension \(more than [\d.]+ MB\): leave out what it does not need$/ });
    LIMITS.bytes = kept.bytes;
    LIMITS.files = 3;
    await assert.rejects(snapshot(run, chat, draft("many", { a: "", b: "", c: "" })), { message: "It is over what is copied of an extension (more than 3 files): leave out what it does not need" });
    LIMITS.files = kept.files;
  } finally {
    Object.assign(LIMITS, kept);
  }
  const deep = Array.from({ length: LIMITS.depth + 1 }, (_, i) => `f${i}`).join("/");
  await assert.rejects(snapshot(run, chat, draft("deep", { [`${deep}/x.js`]: "" })), { message: /^It is over what is copied of an extension \(more than 32 folders deep, at f0\/f1\// });
  const wide = draft("wide");
  for (let i = 0; i < 2001; i++) writeFileSync(path.join(base, wide, `f${i}`), "");
  await assert.rejects(snapshot(run, chat, wide), { message: `It is over what is copied of an extension (more than 2,000 entries in ${wide}): leave out what it does not need` });
  assert.deepEqual(readdirSync(made).filter((name) => ["big", "many", "deep", "wide"].includes(name)), []);
  assert.deepEqual(leftovers(), []);
});

test("a file the chat's agent may not read refuses the copy, and names it", async () => {
  const rel = draft("closed", { "secret/key.txt": "k" });
  files.open = (folder: string, at: string, options: unknown) => {
    if (at.endsWith("key.txt")) throw Object.assign(new Error("That file is closed to the agent"), { code: "invalid" });
    return folderFiles.open(folder, at, options);
  };
  try {
    await assert.rejects(snapshot(run, chat, rel), { message: "secret/key.txt could not be read as this chat's agent: That file is closed to the agent" });
  } finally {
    files.open = folderFiles.open;
  }
  assert.equal(existsSync(path.join(made, "closed")), false);
  assert.deepEqual(leftovers(), []);
});

test("a copy that fails its check leaves nothing, and the copy before it as it was", async () => {
  const rel = draft("checked", { "server.js": "export default () => 1;\n" });
  const first = await snapshot(run, chat, rel);
  writeFileSync(path.join(base, rel, "package.json"), JSON.stringify({ name: "checked", pi: { extensions: ["./x.ts"] } }));
  await assert.rejects(snapshot(run, chat, rel), { message: /^A pi half \(pi\.extensions\)/ });
  assert.equal(JSON.parse(readFileSync(path.join(first.folder, "package.json"), "utf8")).version, "1.0.0");
  assert.deepEqual(leftovers(), []);
});

test("a snapshot that finds its start stopped at a yield gives up, removes what it made, and leaves made/ as it was", async () => {
  const rel = draft("stopping", { "server.js": "export default () => 1;\n" });
  const before = await snapshot(run, chat, rel);
  for (let i = 0; i < 50; i++) writeFileSync(path.join(base, rel, `f${i}.js`), "");
  writeFileSync(path.join(base, rel, "server.js"), "export default () => 2;\n");
  const going = snapshot(run, chat, rel);
  await new Promise((resolve) => setImmediate(resolve));
  run.stopped = true;
  try {
    await assert.rejects(going, { message: "Creator mode was stopped while it copied the extension: nothing was installed" });
  } finally {
    run.stopped = false;
  }
  assert.equal(readFileSync(path.join(before.folder, "server.js"), "utf8"), "export default () => 1;\n");
  assert.equal(existsSync(path.join(before.folder, "f0.js")), false);
  assert.deepEqual(leftovers(), []);
});

test("what a cut-off install left is swept as a start begins: a copy put aside with none in its place is put back, the rest removed", () => {
  mkdirSync(path.join(made, ".old-lost-0123abcd"), { recursive: true });
  writeFileSync(path.join(made, ".old-lost-0123abcd", "package.json"), "{}");
  mkdirSync(path.join(made, "kept"), { recursive: true });
  mkdirSync(path.join(made, ".old-kept-89abcdef"));
  mkdirSync(path.join(made, ".incoming-00ff00ff"));
  writeFileSync(path.join(made, ".incoming-00ff00ff", "half.js"), "");
  sweepLeftovers(run);
  assert.equal(readFileSync(path.join(made, "lost", "package.json"), "utf8"), "{}");
  assert.equal(existsSync(path.join(made, "kept")), true);
  assert.deepEqual(leftovers(), []);
});

test("the portal answers while a draft of 5,000 files is copied", async () => {
  const rel = draft("large");
  for (let folder = 0; folder < 5; folder++) {
    mkdirSync(path.join(base, rel, `d${folder}`));
    for (let i = 0; i < 1000; i++) writeFileSync(path.join(base, rel, `d${folder}`, `f${i}.js`), `// ${i}\n`);
  }
  const server = createServer((_req, res) => res.end("here"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    let copied = false;
    const going = snapshot(run, chat, rel).then((copy) => ((copied = true), copy));
    const answer = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)).text();
    assert.equal(answer, "here");
    assert.equal(copied, false, "answered while the copy was still being made");
    assert.equal((await going).files, 5001);
  } finally {
    server.close();
  }
});

test("the digest tells two drafts apart whose paths and bytes run together the same way, cut otherwise", async () => {
  const one = await snapshot(run, chat, draft("cut", { a: "x", b: "y" }));
  const other = await snapshot(run, chat, draft("cut", { a: "xb\0y" }));
  assert.notEqual(one.digest, other.digest);
  // And the same files make the same digest.
  const again = await snapshot(run, chat, draft("cut", { a: "xb\0y" }));
  assert.equal(again.digest, other.digest);
});
