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

test("a package that gives pi no extension reads none of pi's settings, whatever its own code calls settings", async () => {
  const dir = scratch("ext-");
  writeFileSync(path.join(dir, "server.js"), "const { seed, size } = settings; settings.model;");
  writeFileSync(path.join(dir, "package.json"), '{"name":"x","version":"1.0.0","pi":{}}');
  assert.deepEqual(settingKeysOf(dir, true), []);
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(path.join(dir, "package.json"), '{"name":"x","version":"1.0.1","pi":{"extensions":["./server.js"]}}');
  assert.deepEqual(settingKeysOf(dir, true), ["model", "seed", "size"]);
});

test("a name in a string is no setting read: an extension's own page in Settings is registered as \"settings.page\"", () => {
  const dir = scratch("ext-");
  writeFileSync(path.join(dir, "client.js"), `portal.slots.register("settings.page", { id: "own" }); portal.slots.register('settings.page', {}); const s = \`settings.page\`; settings.real;`);
  assert.deepEqual(settingKeysOf(dir, false), ["real"]);
});
