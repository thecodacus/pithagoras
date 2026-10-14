import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { scratch } from "./server-harness.mjs";

const { insideReal, isUnderText, isWithinText, pathBelow } = await import("../dist/within.js");

test("the folder itself and what is under it are within it, by text", () => {
  assert.equal(isWithinText("/w/site", "/w/site"), true);
  assert.equal(isWithinText("/w/site", "/w/site/src/a.ts"), true);
});

test("a sibling that shares the start of the name is not", () => {
  assert.equal(isWithinText("/w/site", "/w/site-old"), false);
  assert.equal(isWithinText("/w/site", "/w/site-old/a.ts"), false);
  assert.equal(isWithinText("/w/site", "/w"), false);
});

test("a trailing separator and the root folder are handled", () => {
  assert.equal(isWithinText("/w/site/", "/w/site"), true);
  assert.equal(isWithinText("/w/site/", "/w/site/a.ts"), true);
  assert.equal(isWithinText("/", "/etc/passwd"), true);
});

test("under is inside and not the folder itself; below says what is under it", () => {
  assert.equal(isUnderText("/w/site", "/w/site/a"), true);
  assert.equal(isUnderText("/w/site", "/w/site"), false);
  assert.equal(isUnderText("/w/site/", "/w/site"), false);
  assert.equal(pathBelow("/w/site/", "/w/site/docs/../a.md"), "a.md");
  assert.equal(pathBelow("/w/site", "/w/site"), "");
  assert.equal(pathBelow("/w/site", "/w/other"), undefined);
  // "" is "/", as on the web.
  assert.equal(pathBelow("", "/etc"), "etc");
});

test("what is written with .. or doubled separators is judged by where it goes", () => {
  assert.equal(isWithinText("/w/site", "/w/site/../backup"), false);
  assert.equal(isWithinText("/w/site", "/w/site/src/../a.ts"), true);
  assert.equal(isWithinText("/w/site//", "/w/site/a"), true);
  assert.equal(isWithinText("/w//site", "/w/site/a"), true);
});

test("by where it leads, a link into the folder counts as inside, and an empty place does not", (t) => {
  const home = scratch("pithagoras-within-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, "site");
  mkdirSync(path.join(project, "docs"), { recursive: true });
  symlinkSync(path.join(project, "docs"), path.join(home, "shortcut"));
  assert.equal(isWithinText(project, path.join(home, "shortcut")), false);
  assert.equal(insideReal(project)(path.join(home, "shortcut")), true);
  assert.equal(insideReal(project)(path.join(home, "site-old")), false);
  assert.equal(insideReal(project)(null), false);
  // One test for many places answers each the same.
  const inside = insideReal(project);
  assert.deepEqual([path.join(home, "shortcut"), path.join(project, "docs"), home].map(inside), [true, true, false]);
  assert.equal(insideReal(path.join(home, "gone"))(path.join(home, "shortcut")), false);
});
