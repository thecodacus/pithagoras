import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scratch } from "./server-harness.mjs";

const home = realpathSync(scratch("pithagoras-bundled-"));
const started = process.cwd();
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { bundledPath } = await import("../dist/bundled.js");

after(() => {
  process.chdir(started);
});

test("a folder the repository ships is found beside the server's folder, wherever the portal was started", () => {
  process.chdir(home);
  assert.equal(bundledPath("skills"), path.join(repo, "skills"));
  assert.equal(bundledPath("channels"), path.join(repo, "channels"));
  assert.equal(bundledPath("extensions/subagent", "package.json"), path.join(repo, "extensions", "subagent"));
});

test("a folder of the same name where the portal was started does not take the place of the shipped one", () => {
  const work = path.join(home, "decoy");
  mkdirSync(path.join(work, "skills"), { recursive: true });
  process.chdir(work);
  assert.equal(bundledPath("skills"), path.join(repo, "skills"));
});

test("a name nothing holds is undefined, not a path that is not there", () => {
  process.chdir(home);
  assert.equal(bundledPath("no-such-folder-here"), undefined);
});

test("a folder is found from where the portal was started, or from the folder above it", () => {
  const work = path.join(home, "start", "inner");
  mkdirSync(path.join(work, "here-folder"), { recursive: true });
  mkdirSync(path.join(home, "start", "above-folder"), { recursive: true });
  process.chdir(work);
  assert.equal(bundledPath("here-folder"), path.join(work, "here-folder"));
  assert.equal(bundledPath("above-folder"), path.join(home, "start", "above-folder"));
});

test("the marker has to be in the folder: another folder of that name is not the one", () => {
  const work = path.join(home, "marked");
  mkdirSync(path.join(work, "thing"), { recursive: true });
  process.chdir(work);
  assert.equal(bundledPath("thing", "package.json"), undefined);
  // Without a marker the name alone is enough.
  assert.equal(bundledPath("thing"), path.join(work, "thing"));
  writeFileSync(path.join(work, "thing", "package.json"), "{}");
  assert.equal(bundledPath("thing", "package.json"), path.join(work, "thing"));
});
