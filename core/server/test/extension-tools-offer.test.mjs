import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

/**
 * A server half whose tools follow its settings says which it offers now (`portal.tools.offer`): the tools lists show
 * those before any chat has reported them, and leave out the ones remembered from before that are not offered. And it
 * can have the open chats loaded again (`portal.chats.reload`), for them to have the change.
 */
const home = inProcessHome("extension-tools-offer-");
const host = await import("../dist/extension-host.js");
const db = await import("../dist/db.js");
test.after(() => host.stopServerHalves());

let revs = 0;
function half(name, body) {
  const dir = path.join(home, "packages", name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `server-${++revs}.js`);
  writeFileSync(file, `export default async function (portal) {\nglobalThis.portals ??= {};\nglobalThis.portals[portal.extension] = portal;\n${body}\n}\n`);
  return { name, version: "1.0.0", file, rev: `${statSync(file).size.toString(36)}-${revs}` };
}
const names = () => db.shownTools().map((t) => t.name).filter((n) => ["paint", "sketch", "fresh", "plain", "loud"].includes(n)).sort();

test("before the halves have been asked for once, as the portal starts, a server half's remembered tools are listed", () => {
  db.rememberTools([db.remembered({ name: "loud", source: "shouter", inline: true })]);
  assert.equal(host.askedHalves(), undefined);
  assert.deepEqual(names(), ["loud"], "which packages are switched on is not known yet: nothing is judged");
});

test("what a server half offers now is listed, before a chat has reported it, and what it remembers and does not offer is not", async () => {
  globalThis.offering = ["paint"];
  await host.syncServerHalves([
    half("painter", `portal.tools.offer(() => globalThis.offering.map((name) => ({ name, description: "Does " + name + "." })));`),
    // One that says nothing of it: listed as it is remembered, whatever it registers.
    half("plain", ""),
  ]);
  db.rememberTools([
    db.remembered({ name: "paint", source: "painter", inline: true, description: "Paints." }),
    db.remembered({ name: "sketch", source: "painter", inline: true }),
    db.remembered({ name: "plain", source: "plain", inline: true }),
  ]);
  assert.deepEqual(names(), ["paint", "plain"], "sketch is remembered, and not offered now");

  // Set up: what it offers now is listed, though no chat has reported it yet.
  globalThis.offering = ["paint", "fresh"];
  assert.deepEqual(names(), ["fresh", "paint", "plain"]);
  assert.deepEqual(db.shownTools().find((t) => t.name === "fresh"), { name: "fresh", source: "painter", description: "Does fresh.", inline: true });
  // Switched off in its settings: none of it.
  globalThis.offering = [];
  assert.deepEqual(names(), ["plain"]);

  // One that cannot say is listed as it is remembered.
  await host.syncServerHalves([half("painter", `portal.tools.offer(() => { throw new Error("no settings"); });`), half("plain", "")]);
  assert.deepEqual(names(), ["paint", "plain", "sketch"]);
  // Nor is anything taken away for one that is asked for and not running: its start failed.
  await host.syncServerHalves([half("painter", `throw new Error("not today");`), half("plain", "")]);
  assert.equal(host.isServing("painter"), false);
  assert.deepEqual(names(), ["paint", "plain", "sketch"]);
  // One no longer asked for, switched off or uninstalled, registers nothing: none of it is listed.
  await host.syncServerHalves([]);
  assert.deepEqual(names(), []);
});

test("a server half has the open chats loaded again, through the portal's own reload", async () => {
  const asked = [];
  host.setChatBridge({ tell: async () => false, offers: () => undefined, reload: async () => (asked.push("reload"), { reloaded: 2, waiting: 1 }) });
  await host.syncServerHalves([half("painter", "")]);
  assert.deepEqual(await globalThis.portals.painter.chats.reload(), { reloaded: 2, waiting: 1 });
  assert.deepEqual(asked, ["reload"]);
  assert.throws(() => globalThis.portals.painter.tools.offer(["paint"]), /offer takes a function/);
  await host.syncServerHalves([]);
});

test("a chat that has not started can switch on a tool a server half offers that is off by default and that no chat has reported", async () => {
  const { sessions } = await import("../dist/session-manager.js");
  await host.syncServerHalves([half("painter", `portal.tools.offer(() => [{ name: "varnish" }]);`)]);
  assert.equal(db.knownTools().some((t) => t.name === "varnish"), false);
  db.setToolDefaultsOff(["varnish"]);
  db.createSession({ id: "later", title: "later", workspace: home, executor: "host" });
  const state = async () => (await sessions.getTools("later")).tools.find((t) => t.name === "varnish")?.enabled;
  assert.equal(await state(), false);
  await sessions.setTools("later", []);
  assert.equal(await state(), true, "the exception is written, not only answered");
  await host.syncServerHalves([]);
});
