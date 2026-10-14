import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scratch } from "./server-harness.mjs";

/** What an update puts aside and puts back, on real folders. */
const { fileArtifacts } = await import("../dist/update-files.js");

/** An install with a build: node_modules, the server's and the web app's, each with a file that says which it is. */
function install(label = "old") {
  const root = scratch("pithagoras-update-files-");
  for (const [dir, file] of [["node_modules", "dep.txt"], ["core/server/dist", "index.js"], ["core/web/dist", "index.html"]]) {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, dir, file), label);
  }
  return root;
}
const read = (root, rel) => readFileSync(path.join(root, rel), "utf8");
/** What a step makes in the place of what was put aside. */
const make = (root, dir, file, text) => {
  mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, dir, file), text);
};

test("what a failed install leaves is replaced by the node_modules that was there, and the build is not touched", async () => {
  const root = install();
  const files = fileArtifacts(root);
  await files.keepModules();
  assert.equal(existsSync(path.join(root, "node_modules")), false, "put aside: npm ci has the place to itself");
  make(root, "node_modules", "half.txt", "an install that stopped halfway");
  await files.restore();
  assert.deepEqual(readdirSync(path.join(root, "node_modules")), ["dep.txt"]);
  assert.equal(read(root, "node_modules/dep.txt"), "old");
  assert.equal(read(root, "core/server/dist/index.js"), "old");
  assert.deepEqual(readdirSync(root).sort(), ["core", "node_modules"], "nothing is left beside them");
});

test("a build that fails halfway gives back the old server, the old web app and the node_modules they belong to", async () => {
  const root = install();
  const files = fileArtifacts(root);
  await files.keepModules();
  make(root, "node_modules", "dep.txt", "new");
  await files.keepBuild();
  // What tsc writes of a program with a type error, and what vite writes before it stops.
  make(root, "core/server/dist", "index.js", "new, with a type error");
  make(root, "core/web/dist", "partial.js", "half a bundle");
  await files.restore();
  assert.equal(read(root, "node_modules/dep.txt"), "old");
  assert.equal(read(root, "core/server/dist/index.js"), "old");
  assert.equal(read(root, "core/web/dist/index.html"), "old");
  assert.equal(existsSync(path.join(root, "core/web/dist/partial.js")), false);
  assert.equal(existsSync(path.join(root, "node_modules.update-old")), false);
  assert.equal(existsSync(path.join(root, "core/server/dist.update-old")), false);
});

test("a build that has worked keeps the new files and throws the old ones away", async () => {
  const root = install();
  const files = fileArtifacts(root);
  await files.keepModules();
  make(root, "node_modules", "dep.txt", "new");
  await files.keepBuild();
  make(root, "core/server/dist", "index.js", "new");
  make(root, "core/web/dist", "index.html", "new");
  await files.discard();
  assert.equal(read(root, "node_modules/dep.txt"), "new");
  assert.equal(read(root, "core/server/dist/index.js"), "new");
  assert.equal(read(root, "core/web/dist/index.html"), "new");
  for (const rel of ["node_modules", "core/server/dist", "core/web/dist"]) assert.equal(existsSync(path.join(root, rel + ".update-old")), false, rel);
  // Nothing is left to put back, and putting back is not an error.
  await files.restore();
  assert.equal(read(root, "node_modules/dep.txt"), "new");
});

test("what is not there is not put aside, and what an earlier update left aside does not stand in the way", async () => {
  const root = scratch("pithagoras-update-files-");
  const files = fileArtifacts(root);
  await files.keepModules();
  await files.keepBuild();
  await files.restore();
  assert.deepEqual(readdirSync(root), []);

  const cut = install("old");
  // An update that was cut off, before this one: a copy of something older.
  make(cut, "node_modules.update-old", "stale.txt", "from before");
  const later = fileArtifacts(cut);
  await later.keepModules();
  await later.restore();
  assert.deepEqual(readdirSync(path.join(cut, "node_modules")), ["dep.txt"]);
});

test("a node_modules that is a link is put aside and put back as the link, and what it points to is not touched", async () => {
  const root = scratch("pithagoras-update-files-");
  const target = scratch("pithagoras-update-files-target-");
  writeFileSync(path.join(target, "dep.txt"), "shared");
  symlinkSync(target, path.join(root, "node_modules"));
  const files = fileArtifacts(root);
  await files.keepModules();
  make(root, "node_modules", "new.txt", "from npm ci");
  await files.restore();
  assert.equal(readFileSync(path.join(root, "node_modules", "dep.txt"), "utf8"), "shared");
  assert.deepEqual(readdirSync(target), ["dep.txt"]);
  await files.keepModules();
  await files.discard();
  assert.deepEqual(readdirSync(target), ["dep.txt"], "thrown away: the link, not the folder it leads to");
});

test("what the build was made from is written in the server's build, and goes with it", async () => {
  const root = install();
  const files = fileArtifacts(root);
  assert.equal(await files.builtFrom(), undefined, "nothing written down yet");
  await files.markBuilt("aaa111");
  assert.equal(await files.builtFrom(), "aaa111");
  // Already written: the first word stands where it is asked to be kept.
  await files.markBuilt("bbb222", true);
  assert.equal(await files.builtFrom(), "aaa111");
  await files.markBuilt("bbb222");
  assert.equal(await files.builtFrom(), "bbb222");

  // Put aside with the build, and back with it: a failed build leaves the commit the old one was made from.
  await files.keepBuild();
  assert.equal(await files.builtFrom(), undefined);
  make(root, "core/server/dist", "index.js", "new");
  await files.restore();
  assert.equal(await files.builtFrom(), "bbb222");
  // A new instance, as after a restart, reads the same.
  assert.equal(await fileArtifacts(root).builtFrom(), "bbb222");
});

test("a portal with no build has nothing to write down", async () => {
  const root = scratch("pithagoras-update-files-");
  const files = fileArtifacts(root);
  await files.markBuilt("aaa111");
  assert.equal(await files.builtFrom(), undefined);
  assert.deepEqual(readdirSync(root), []);
});

/** What a build on the host does to the build's own files: writes them again, a little later. */
const buildByHand = (root, rel = "core/server/dist/index.js") => {
  writeFileSync(path.join(root, rel), "built by hand");
  const later = new Date(Date.now() + 5000);
  utimesSync(path.join(root, rel), later, later);
};

test("a record is no longer true once the build has been made again outside the update", async () => {
  const root = install();
  const files = fileArtifacts(root);
  await files.markBuilt("aaa111");
  assert.equal(await files.builtFrom(), "aaa111");
  // `git pull && npm ci && npm run build` on the host: tsc writes the server again and never removes the record.
  buildByHand(root);
  assert.equal(existsSync(path.join(root, "core/server/dist/.built-from")), true, "the record is still there");
  assert.equal(await files.builtFrom(), undefined, "and is of a build that is not in place any more");

  // The web app alone is built again: the same.
  const web = install();
  const webFiles = fileArtifacts(web);
  await webFiles.markBuilt("aaa111");
  buildByHand(web, "core/web/dist/index.html");
  assert.equal(await webFiles.builtFrom(), undefined);
});

test("an update that finds a record that is not true any more writes its own, and keeps one that is", async () => {
  const root = install();
  const files = fileArtifacts(root);
  await files.markBuilt("old000");
  buildByHand(root);
  await files.markBuilt("new111", true);
  assert.equal(await files.builtFrom(), "new111", "what the build in place is of is the commit that is checked out");
  await files.markBuilt("other22", true);
  assert.equal(await files.builtFrom(), "new111", "a record that is true stays");
});

test("what put aside with a build comes back with its record true", async () => {
  const root = install();
  const files = fileArtifacts(root);
  await files.markBuilt("aaa111");
  await files.keepModules();
  await files.keepBuild();
  make(root, "core/server/dist", "index.js", "the new build");
  await files.restore();
  assert.equal(await files.builtFrom(), "aaa111", "the files are as they were, their times too");
});

test("a record of the first form, the commit alone, says nothing", async () => {
  const root = install();
  writeFileSync(path.join(root, "core/server/dist/.built-from"), "aaa111\n");
  assert.equal(await fileArtifacts(root).builtFrom(), undefined);
});
