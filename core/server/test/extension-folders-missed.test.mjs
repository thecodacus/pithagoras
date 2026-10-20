import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

/**
 * A server half that was not running when the portal deleted a folder (switched off, removed, or failing to start) is
 * told of it when it next starts, once; a package that starts for the first time is told of none deleted before. In
 * the portal's process, as in extension-host.test.mjs: the host is asked to run the halves, and told of each folder
 * deleted, as the portal does (extension-folders.test.mjs has the portal tell it).
 */
const home = inProcessHome("extension-folders-missed-");
const host = await import("../dist/extension-host.js");
const { getSetting } = await import("../dist/db.js");

/** What each package's server half was told, by its name. */
const heard = (globalThis.heard = {});
let revs = 0;
/** A package's server half, written anew, that keeps in `heard` each folder it is told of; one that `fails` does not start. */
function half(name, { fails = false } = {}) {
  const file = path.join(home, "packages", `${name}.js`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `export default function (portal) {
  portal.folders.on("removed", (folder) => (globalThis.heard[${JSON.stringify(name)}] ??= []).push(folder));
  ${fails ? 'throw new Error("it cannot start");' : ""}
}
`,
  );
  return { name, version: "1.0.0", file, rev: `${name}-${++revs}` };
}

test("a server half that was not running when a folder was deleted is told of it when it starts again, once", async () => {
  await host.syncServerHalves([half("watcher")]);
  host.folderRemoved("/work/one");
  assert.deepEqual(heard.watcher, ["/work/one"], "told as it goes");

  // Switched off.
  await host.syncServerHalves([]);
  host.folderRemoved("/work/two");
  host.folderRemoved("/work/three");
  assert.deepEqual(heard.watcher, ["/work/one"]);
  await host.syncServerHalves([half("watcher")]);
  assert.deepEqual(heard.watcher, ["/work/one", "/work/two", "/work/three"], "in the order they went");
  // Started anew (updated, say): nothing it has been told is told again.
  await host.syncServerHalves([half("watcher")]);
  assert.deepEqual(heard.watcher, ["/work/one", "/work/two", "/work/three"]);

  // Failing to start.
  await host.syncServerHalves([half("watcher", { fails: true })]);
  assert.equal(host.isServing("watcher"), false);
  host.folderRemoved("/work/four");
  await host.syncServerHalves([half("watcher")]);
  assert.deepEqual(heard.watcher, ["/work/one", "/work/two", "/work/three", "/work/four"]);
  await host.syncServerHalves([]);
});

test("a package that starts for the first time is told of no folder deleted before, and of each after", async () => {
  host.folderRemoved("/work/before");
  await host.syncServerHalves([half("newcomer")]);
  assert.equal(heard.newcomer, undefined, "what it keeps is of no folder of then");
  host.folderRemoved("/work/after");
  assert.deepEqual(heard.newcomer, ["/work/after"]);
  // Removed, and installed again: what went meanwhile.
  await host.syncServerHalves([]);
  host.folderRemoved("/work/meanwhile");
  await host.syncServerHalves([half("newcomer")]);
  assert.deepEqual(heard.newcomer, ["/work/after", "/work/meanwhile"]);

  // One whose first start fails has been seen: what goes before it does start is told.
  await host.syncServerHalves([half("late", { fails: true })]);
  host.folderRemoved("/work/while-it-failed");
  await host.syncServerHalves([half("late")]);
  assert.deepEqual(heard.late, ["/work/while-it-failed"]);
  await host.syncServerHalves([]);
});

test("a package the portal told from the start, as an upgrade tells the one that takes up what it left, is told on its first start of each folder deleted since", async () => {
  const { putSetting } = await import("../dist/db.js");
  putSetting("folders_told", JSON.stringify({ ...JSON.parse(getSetting("folders_told") ?? "{}"), taker: 0 }));
  host.folderRemoved("/work/before-it-came");
  await host.syncServerHalves([half("taker")]);
  assert.ok(heard.taker.includes("/work/before-it-came"));
  await host.syncServerHalves([]);
});

test("the folders deleted are kept, for the halves not running, the latest few hundred", async () => {
  await host.syncServerHalves([half("away")]);
  await host.syncServerHalves([]);
  for (let i = 0; i < 310; i++) host.folderRemoved(`/work/many/${i}`);
  assert.equal(JSON.parse(getSetting("folders_removed")).length, 300);
  await host.syncServerHalves([half("away")]);
  assert.equal(heard.away.length, 300);
  assert.equal(heard.away[0], "/work/many/10", "the oldest went");
  assert.equal(heard.away.at(-1), "/work/many/309");
  await host.syncServerHalves([]);
});
