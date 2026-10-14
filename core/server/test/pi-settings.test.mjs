import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * pi's settings.json holds the packages, the default model and the switches of
 * the install, and pi reads it with a plain JSON.parse. A file the portal
 * cannot read is not one it may start over from: the portal's own key would
 * then be all that is left in it.
 */
const home = inProcessHome("pithagoras-pi-settings-");
const agent = path.join(home, "agent");
const file = path.join(agent, "settings.json");
const { updatePiSettings, writePiSettingsText, inTurnWithSettings, readPiSettings } = await import("../dist/pi-settings.js");
const db = await import("../dist/db.js");

/** What a hand edit leaves: a comma too many. It is not what pi reads, and not a file to write over. */
const BROKEN = '{\n  "packages": ["npm:pi-example"],\n  "defaultProvider": "local",\n}\n';
const GOOD = JSON.stringify({ packages: ["npm:pi-example"], defaultProvider: "local" }, null, 2) + "\n";
const bak = `${file}.bak`;
const reset = (text) => {
  rmSync(bak, { force: true });
  if (text === undefined) rmSync(file, { force: true });
  else writeFileSync(file, text);
};

let base;
before(async () => {
  ({ base } = await startServer(serverEnv(home, await freePort())));
});
const send = (url, method, body) =>
  fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("a file that does not parse is not changed, and says why", async () => {
  reset(BROKEN);
  await assert.rejects(updatePiSettings((all) => { all.compaction = { keepRecentTokens: 5000 }; }), /settings\.json could not be read .*so nothing was changed/);
  assert.equal(readFileSync(file, "utf8"), BROKEN);
  assert.equal(existsSync(bak), false);
});

test("what is JSON but not an object is not changed either", async () => {
  for (const text of ["[]", '"text"', "null", "42"]) {
    reset(text);
    await assert.rejects(updatePiSettings((all) => { all.x = 1; }), /does not hold what pi expects/, text);
    assert.equal(readFileSync(file, "utf8"), text);
  }
});

test("a refused change does not wedge the next one, which works once the file is put right", async () => {
  reset(BROKEN);
  await assert.rejects(updatePiSettings(() => {}));
  writeFileSync(file, GOOD);
  const all = await updatePiSettings((s) => { s.defaultModel = "m"; });
  assert.deepEqual(all, { packages: ["npm:pi-example"], defaultProvider: "local", defaultModel: "m" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), all);
});

test("no file yet, or an empty one, is where a change starts from nothing", async () => {
  reset(undefined);
  assert.deepEqual(await updatePiSettings((s) => { s.a = 1; }), { a: 1 });
  assert.equal(existsSync(bak), false, "there was nothing to keep");
  reset("  \n");
  assert.deepEqual(await updatePiSettings((s) => { s.b = 2; }), { b: 2 });
});

test("a change keeps the rest, and the file as it was is kept beside it", async () => {
  reset(GOOD);
  await updatePiSettings((s) => { s.compaction = { keepRecentTokens: 5000 }; });
  assert.equal(readFileSync(bak, "utf8"), GOOD);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { packages: ["npm:pi-example"], defaultProvider: "local", compaction: { keepRecentTokens: 5000 } });
});

test("a save that changes nothing leaves the copy of the file before it alone", async () => {
  reset(GOOD);
  await updatePiSettings((s) => { s.n = 1; });
  const original = readFileSync(bak, "utf8");
  await updatePiSettings(() => {});
  await updatePiSettings((s) => { s.n = 1; });
  assert.equal(readFileSync(bak, "utf8"), original);
});

test("the raw editor writes what it is given, over a file that does not parse, and keeps that one", async () => {
  reset(BROKEN);
  const text = '{\n    "defaultProvider": "other"\n}\n';
  await writePiSettingsText(text);
  assert.equal(readFileSync(file, "utf8"), text, "as typed, not tidied");
  assert.equal(readFileSync(bak, "utf8"), BROKEN);
});

test("work kept alongside the file runs in turn with the writes, and does not need the file to parse", async () => {
  reset(BROKEN);
  const order = [];
  const refused = updatePiSettings(() => order.push("write"), () => order.push("written")).catch(() => order.push("refused"));
  await inTurnWithSettings(() => order.push("alongside"));
  await refused;
  assert.deepEqual([...order].sort(), ["alongside", "refused"], "the write was refused before it changed anything");
  assert.equal(readFileSync(file, "utf8"), BROKEN);
});

test("an uninstalled package is forgotten even when settings.json cannot be read", async () => {
  reset(BROKEN);
  db.setExtensionStash({ "npm:pi-gone": { source: "npm:pi-gone", skills: [] }, "npm:pi-kept": { source: "npm:pi-kept" } });
  await db.packageRemoved("npm:pi-gone");
  assert.deepEqual(Object.keys(db.extensionStash()), ["npm:pi-kept"]);
  assert.equal(readFileSync(file, "utf8"), BROKEN, "pi has taken it out of the file; the portal leaves the file as it is");
});

test("the extension settings form does not start over from a file that does not parse", async () => {
  reset(BROKEN);
  const res = await send("/api/extensions/settings", "PUT", { key: "exampleKey", value: "v" });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /settings\.json could not be read/);
  assert.equal(readFileSync(file, "utf8"), BROKEN);
});

test("the extension settings form writes one key, clears it when emptied, and keeps the rest", async () => {
  reset(GOOD);
  const set = await send("/api/extensions/settings", "PUT", { key: "exampleKey", value: "v" });
  assert.equal(set.status, 200);
  assert.deepEqual(readPiSettings(), { packages: ["npm:pi-example"], defaultProvider: "local", exampleKey: "v" });
  assert.equal(readFileSync(bak, "utf8"), GOOD);
  await send("/api/extensions/settings", "PUT", { key: "exampleKey", value: "" });
  assert.deepEqual(readPiSettings(), { packages: ["npm:pi-example"], defaultProvider: "local" });
});

test("the compaction slider does not start over from a file that does not parse", async () => {
  reset(BROKEN);
  const res = await send("/api/settings", "PUT", { keepRecentTokens: 8000 });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /settings\.json could not be read/);
  assert.equal(readFileSync(file, "utf8"), BROKEN);
});

test("the raw editor puts a file that does not parse right, refuses what pi could not use, and keeps the old one", async () => {
  reset(BROKEN);
  for (const content of ["[1]", "null", '"text"']) {
    const res = await send("/api/pi-settings", "PUT", { content });
    assert.equal(res.status, 400, content);
    assert.match((await res.json()).error, /must be a JSON object/);
  }
  assert.equal((await send("/api/pi-settings", "PUT", { content: "{" })).status, 400);
  assert.equal(readFileSync(file, "utf8"), BROKEN, "nothing was written");

  const content = '{\n  "defaultProvider": "other"\n}\n';
  const ok = await send("/api/pi-settings", "PUT", { content });
  assert.equal(ok.status, 200);
  assert.equal(readFileSync(file, "utf8"), content);
  assert.equal(readFileSync(bak, "utf8"), BROKEN);
});
