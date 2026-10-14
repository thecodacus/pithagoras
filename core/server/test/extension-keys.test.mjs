import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome, scratch } from "./server-harness.mjs";

const home = inProcessHome("portal-");
const { settingKeysOf } = await import("../dist/api/extensions.js");

test("an extension worked on in a folder of its own shows a setting as soon as its code reads one", async () => {
  const dir = scratch("ext-");
  writeFileSync(path.join(dir, "index.ts"), "export default (pi, settings) => settings.first;");
  assert.deepEqual(settingKeysOf(dir, false), ["first"]);
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(path.join(dir, "index.ts"), "export default (pi, settings) => settings.first ?? settings.second;");
  assert.deepEqual(settingKeysOf(dir, false), ["first", "second"]);
});

test("one installed from npm is scanned again only when it is installed again", async () => {
  const dir = scratch("ext-");
  writeFileSync(path.join(dir, "package.json"), '{"name":"x","version":"1.0.0"}');
  writeFileSync(path.join(dir, "index.js"), "settings.first");
  assert.deepEqual(settingKeysOf(dir, true), ["first"]);
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(path.join(dir, "index.js"), "settings.first; settings.second");
  assert.deepEqual(settingKeysOf(dir, true), ["first"], "kept: its package.json did not change");
  writeFileSync(path.join(dir, "package.json"), '{"name":"x","version":"1.0.1"}');
  assert.deepEqual(settingKeysOf(dir, true), ["first", "second"]);
});
