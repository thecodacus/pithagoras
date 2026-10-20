import assert from "node:assert/strict";
import fs, { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

/**
 * How what an upgrade leaves for an extension is moved where one rename cannot move it: into a folder of the data
 * folder that is mounted on its own, out of one, or out of a link to a folder elsewhere; and how a try that stopped
 * half way is gone on with. What the system refuses there is made here: renameSync and rmSync are wrapped, and say
 * what a mount point, another file system or a stop would.
 */
const home = inProcessHome("handoff-moves-");
const real = { renameSync: fs.renameSync, rmSync: fs.rmSync };
/** What is refused now, by the paths asked: the error's code, or nothing. */
let refuse = {};
const refused = (code, p) => Object.assign(new Error(`${code}: ${p}`), { code });
fs.renameSync = (from, to) => {
  const code = refuse.rename?.(String(from), String(to));
  if (code) throw refused(code, from);
  return real.renameSync(from, to);
};
fs.rmSync = (p, options) => {
  const code = refuse.rm?.(String(p));
  if (code) throw refused(code, p);
  return real.rmSync(p, options);
};
syncBuiltinESMExports();
const { handoffDone, handoffRoot, moveFolderTo, moveTo, takeHandoff } = await import("../dist/handoff.js");

/** `fn` with `refusals` in force. */
function refusing(refusals, fn) {
  refuse = refusals;
  try {
    return fn();
  } finally {
    refuse = {};
  }
}

const THEN = new Date("2026-10-01T10:00:00Z");
const put = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

test("a folder moved to another file system is copied with its files' times, over a copy cut off before, and removed where it was", () => {
  const from = path.join(home, "across", "from");
  const to = path.join(home, "across", "to");
  put(path.join(from, "inner", "clip.webm"), "the whole clip");
  utimesSync(path.join(from, "inner", "clip.webm"), THEN, THEN);
  // An earlier try was stopped half way through its copy.
  put(path.join(`${to}.copy`, "inner", "clip.webm"), "the who");

  refusing({ rename: (a, b) => (a === from && b === to ? "EXDEV" : undefined) }, () => moveTo(from, to));
  assert.equal(readFileSync(path.join(to, "inner", "clip.webm"), "utf8"), "the whole clip");
  assert.equal(statSync(path.join(to, "inner", "clip.webm")).mtime.toISOString(), THEN.toISOString(), "its time kept: what is made of a file is named by it");
  assert.equal(existsSync(from), false);
  assert.equal(existsSync(`${to}.copy`), false);
});

test("a folder mounted on its own stays where it is, and what is in it is moved, a try that stopped half way gone on with", () => {
  const from = path.join(home, "mounted", "videos");
  const to = path.join(home, "mounted", "handoff", "files", "videos");
  const filling = path.join(path.dirname(to), ".videos.partial");
  for (const name of ["a.webm", "b.webm", "c.webm"]) put(path.join(from, name), `clip ${name}`);
  utimesSync(path.join(from, "b.webm"), THEN, THEN);
  mkdirSync(path.dirname(to), { recursive: true });
  // As a mount point: the folder is not renamed, and what is in it is on another file system. The first try is stopped
  // as it removes b.webm, which it has copied.
  const mounted = (a) => (a === from ? "EBUSY" : path.dirname(a) === from ? "EXDEV" : undefined);
  assert.throws(() => refusing({ rename: mounted, rm: (p) => (p === path.join(from, "b.webm") ? "ESTOPPED" : undefined) }, () => moveFolderTo(from, to)), /ESTOPPED/);
  assert.equal(existsSync(to), false, "not put in place half full");
  assert.equal(readFileSync(path.join(filling, "b.webm"), "utf8"), "clip b.webm");
  assert.equal(existsSync(path.join(from, "b.webm")), true);

  // The next start, by which the folder is not mounted any more: what was moved before is gone on with, not left behind.
  moveFolderTo(from, to);
  assert.deepEqual(readdirSync(to).sort(), ["a.webm", "b.webm", "c.webm"]);
  for (const name of ["a.webm", "b.webm", "c.webm"]) assert.equal(readFileSync(path.join(to, name), "utf8"), `clip ${name}`);
  assert.equal(statSync(path.join(to, "b.webm")).mtime.toISOString(), THEN.toISOString());
  assert.equal(existsSync(filling), false);
  assert.equal(statSync(from).isDirectory(), true, "the mount point is where it was");
  assert.deepEqual(readdirSync(from), [], "and nothing is in it twice");
});

test("a folder that is a link to one elsewhere stays, with the folder it leads to, and what is in that is moved", () => {
  const data = path.join(home, "linked", "data");
  const elsewhere = path.join(home, "linked", "clips");
  put(path.join(elsewhere, "a.webm"), "a clip");
  mkdirSync(data, { recursive: true });
  // Relative: moved as a link, it would lead nowhere.
  symlinkSync(path.join("..", "clips"), path.join(data, "videos"));
  const to = path.join(data, "handoff", "videos");
  mkdirSync(path.dirname(to), { recursive: true });

  moveFolderTo(path.join(data, "videos"), to);
  assert.equal(lstatSync(to).isDirectory(), true, "a folder, not a link");
  assert.equal(readFileSync(path.join(to, "a.webm"), "utf8"), "a clip");
  assert.equal(lstatSync(path.join(data, "videos")).isSymbolicLink(), true);
  assert.deepEqual(readdirSync(elsewhere), []);
});

test("a link to a folder elsewhere that cannot be reached on a retry is refused, and what an earlier try moved of it waits", () => {
  const data = path.join(home, "dangling", "data");
  const elsewhere = path.join(home, "dangling", "clips");
  put(path.join(elsewhere, "a.webm"), "a clip");
  put(path.join(elsewhere, "b.webm"), "b clip");
  mkdirSync(data, { recursive: true });
  symlinkSync(elsewhere, path.join(data, "videos"));
  const to = path.join(data, "handoff", "videos");
  mkdirSync(path.dirname(to), { recursive: true });
  const filling = path.join(path.dirname(to), ".videos.partial");
  // The first try is stopped after it moved one clip.
  assert.throws(() => refusing({ rename: (a) => (a.endsWith("b.webm") ? "ENOSPC" : undefined) }, () => moveFolderTo(path.join(data, "videos"), to)), /ENOSPC/);
  assert.deepEqual(readdirSync(filling), ["a.webm"]);
  // On the next, the folder the link leads to is not there yet (a disk that comes up late).
  fs.renameSync(elsewhere, `${elsewhere}-away`);
  assert.throws(() => moveFolderTo(path.join(data, "videos"), to), /cannot be reached/);
  assert.equal(existsSync(to), false, "not put in place without the rest");
  assert.deepEqual(readdirSync(filling), ["a.webm"]);
  // Back: the rest is moved, and all of it put in place.
  fs.renameSync(`${elsewhere}-away`, elsewhere);
  moveFolderTo(path.join(data, "videos"), to);
  assert.deepEqual(readdirSync(to).sort(), ["a.webm", "b.webm"]);
  // A folder that never was there, with nothing moved of it, is nothing to move.
  moveFolderTo(path.join(data, "nothing"), path.join(data, "handoff", "nothing"));
  assert.equal(existsSync(path.join(data, "handoff", "nothing")), false);
});

test("a hand-off taken into a folder on another file system, by a start stopped as it removed it, is not taken a second time; one left again since waits its turn", () => {
  const into = path.join(home, "extension-data", "notes");
  mkdirSync(into, { recursive: true });
  const root = handoffRoot();
  const leave = (rows) => {
    put(path.join(root, "notes", "rows.json"), rows);
    put(path.join(root, "notes", "files", "a.txt"), "a file");
  };
  leave("[1]");
  const taken = path.join(into, "handoff-notes");
  // Another file system: a rename into it is refused. And the start is stopped as it removes what it copied.
  const across = (a, b) => (b === taken && path.dirname(a) === root ? "EXDEV" : undefined);
  const stopped = (p) => (path.dirname(p) === root ? "ESTOPPED" : undefined);
  assert.throws(() => refusing({ rename: across, rm: stopped }, () => takeHandoff("notes", into)), /ESTOPPED/);
  assert.equal(readFileSync(path.join(taken, "rows.json"), "utf8"), "[1]", "copied whole before it was removed");

  // The next start has it, and what is left of it where it was goes.
  assert.equal(takeHandoff("notes", into), taken);
  assert.deepEqual(readdirSync(root), []);
  handoffDone("notes", into);
  assert.equal(takeHandoff("notes", into), undefined, "taken once");

  // Taken and not done with, when an upgrade from a version the person went back to leaves one again: that one waits.
  leave("[1]");
  assert.equal(takeHandoff("notes", into), taken);
  leave("[1,2]");
  assert.equal(takeHandoff("notes", into), taken);
  assert.equal(readFileSync(path.join(taken, "rows.json"), "utf8"), "[1]");
  assert.equal(readFileSync(path.join(root, "notes", "rows.json"), "utf8"), "[1,2]", "left as it was");
  handoffDone("notes", into);
  assert.equal(takeHandoff("notes", into), taken);
  assert.equal(readFileSync(path.join(taken, "rows.json"), "utf8"), "[1,2]");
  assert.equal(readFileSync(path.join(taken, "files", "a.txt"), "utf8"), "a file");
});
