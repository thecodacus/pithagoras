import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

/**
 * Extensions that build on others: one gives what it provides (`portal.provide`), and those that name it in their
 * package.json (`pithagoras.requires`, `pithagoras.optional`) get it (`portal.extensions.use`). The modules here write
 * what happens to them into `globalThis.log`, which the tests read.
 */
const home = inProcessHome("extension-dependencies-");
const host = await import("../dist/extension-host.js");
test.after(() => host.stopServerHalves());

let revs = 0;
/** A package's server half as the portal is told of it, its module written anew: `body` is the default export's own. */
function half(name, body, { version = "1.0.0", requires, optional } = {}) {
  const dir = path.join(home, "packages", name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `server-${++revs}.js`);
  writeFileSync(file, `export default async function (portal) {\nconst log = (globalThis.log ??= []);\nlog.push("${name} start");\n${body}\nreturn () => log.push("${name} stop");\n}\n`);
  return { name, version, file, rev: `${statSync(file).size.toString(36)}-${revs}`, ...(requires ? { requires } : {}), ...(optional ? { optional } : {}) };
}
const log = () => globalThis.log.splice(0);
/** What a provider gives: who asked, and which of its versions answered, so that a stale one is told from a new one. */
const PROVIDES = (mark) => `portal.provide((consumer) => ({ for: consumer.name, from: "${mark}", asked: (globalThis.asked = (globalThis.asked ?? 0) + 1) }));`;
const USES = (dep) => `globalThis.got ??= {}; globalThis.got[portal.extension] = portal.extensions.use("${dep}") ?? null; globalThis.got[portal.extension + " again"] = portal.extensions.use("${dep}") ?? null;`;

test("an extension starts after what it requires, and gets what that gives it, one for each that asks, once", async () => {
  globalThis.got = {};
  globalThis.asked = 0;
  const docker = half("docker", PROVIDES("v1"));
  const browser = half("browser", USES("docker"), { requires: { docker: "^1.0.0" } });
  // Listed with the one that builds on another first: it is still started after it.
  await host.syncServerHalves([browser, docker]);
  assert.deepEqual(log(), ["docker start", "browser start"]);
  assert.deepEqual(globalThis.got.browser, { for: "browser", from: "v1", asked: 1 });
  assert.equal(globalThis.got["browser again"], globalThis.got.browser, "asked again: the same, not made anew");
  assert.equal(host.isServing("browser"), true);
  await host.syncServerHalves([]);
  assert.deepEqual(log(), ["browser stop", "docker stop"], "stopped before what it builds on");
});

test("an extension that names one it does not build on is told so, and does not start", async () => {
  const docker = half("docker", PROVIDES("v1"));
  const rogue = half("rogue", USES("docker"));
  await host.syncServerHalves([docker, rogue]);
  assert.equal(host.isServing("rogue"), false);
  assert.match(host.serverFailure("rogue"), /docker is not one rogue builds on: name it in "requires" or "optional"/);
  await host.syncServerHalves([]);
  log();
});

test("one whose requirement is not there, not in a version it takes, or not a range, does not start, and Settings says why", async () => {
  const cases = [
    [{ docker: "^1.0.0" }, [], /It needs docker \(\^1\.0\.0\), which is not installed, or is switched off/],
    [{ docker: "^2.0.0" }, [half("docker", PROVIDES("v1"))], /It needs docker \^2\.0\.0, and docker 1\.0\.0 is installed/],
    [{ docker: "the latest" }, [half("docker", PROVIDES("v1"))], /It asks for docker at "the latest", which is not a version range/],
  ];
  for (const [requires, others, why] of cases) {
    const browser = half("browser", USES("docker"), { requires });
    await host.syncServerHalves([browser, ...others]);
    assert.equal(host.isServing("browser"), false, JSON.stringify(requires));
    assert.match(host.serverFailure("browser"), why);
  }
  // Installed in a version it takes: it starts, and the reason goes.
  await host.syncServerHalves([half("browser", USES("docker"), { requires: { docker: "^1.0.0" } }), half("docker", PROVIDES("v1"))]);
  assert.equal(host.isServing("browser"), true);
  assert.equal(host.serverFailure("browser"), undefined);
  await host.syncServerHalves([]);
  log();
});

test("when what it builds on is started anew, so is it, after it, and with what the new one gives", async () => {
  globalThis.got = {};
  const browser = half("browser", USES("docker"), { requires: { docker: "^1.0.0" } });
  // One that builds on the one that builds: started anew with them.
  const shots = half("shots", USES("browser"), { requires: { browser: "*" } });
  await host.syncServerHalves([shots, browser, half("docker", PROVIDES("v1"))]);
  assert.deepEqual(log(), ["docker start", "browser start", "shots start"]);
  await host.syncServerHalves([shots, browser, half("docker", PROVIDES("v2"))]);
  assert.deepEqual(log(), ["shots stop", "browser stop", "docker stop", "docker start", "browser start", "shots start"]);
  assert.equal(globalThis.got.browser.from, "v2", "not what the one that is gone gave");
  // What does not build on what changed is left as it is.
  const other = half("other", "");
  await host.syncServerHalves([shots, browser, half("docker", PROVIDES("v2")), other]);
  log();
  await host.syncServerHalves([shots, browser, half("docker", PROVIDES("v3")), other]);
  assert.ok(!log().some((line) => line.startsWith("other")));
  await host.syncServerHalves([]);
  log();
});

test("an optional one: started without it, given nothing, and started again as it comes and goes", async () => {
  globalThis.got = {};
  const browser = half("browser", USES("docker"), { optional: { docker: "^1.0.0" } });
  await host.syncServerHalves([browser]);
  assert.deepEqual(log(), ["browser start"]);
  assert.equal(globalThis.got.browser, null, "nothing while it is not there");
  const docker = half("docker", PROVIDES("v1"));
  await host.syncServerHalves([browser, docker]);
  // It goes on until the provider is there, and starts again with it.
  assert.deepEqual(log(), ["docker start", "browser stop", "browser start"]);
  assert.equal(globalThis.got.browser.from, "v1");
  await host.syncServerHalves([browser]);
  assert.deepEqual(log(), ["browser stop", "docker stop", "browser start"]);
  assert.equal(globalThis.got.browser, null);
  // There in a version it does not take: as if it were not.
  await host.syncServerHalves([browser, half("docker", PROVIDES("v9"), { version: "2.0.0" })]);
  assert.equal(globalThis.got.browser, null);
  assert.equal(host.isServing("browser"), true);
  await host.syncServerHalves([]);
  log();
});

test("one whose provider fails to start waits and says why; an optional one goes on without it; a circle starts none of them", async () => {
  globalThis.got = {};
  const broken = half("docker", `throw new Error("no socket");`);
  const needs = half("browser", USES("docker"), { requires: { docker: "^1.0.0" } });
  const likes = half("shots", USES("docker"), { optional: { docker: "^1.0.0" } });
  await host.syncServerHalves([broken, needs, likes]);
  assert.match(host.serverFailure("docker"), /no socket/);
  assert.equal(host.isServing("browser"), false);
  assert.match(host.serverFailure("browser"), /It needs docker, whose server half could not start/);
  assert.equal(host.isServing("shots"), true);
  assert.equal(globalThis.got.shots, null);

  const a = half("a", "", { requires: { b: "*" } });
  const b = half("b", "", { requires: { a: "*" } });
  await host.syncServerHalves([a, b]);
  assert.equal(host.isServing("a") || host.isServing("b"), false);
  assert.match(host.serverFailure("a"), /It builds on itself, through a → b → a/);
  assert.match(host.serverFailure("b"), /It builds on itself/);
  await host.syncServerHalves([]);
  log();
});

test("an optional provider that failed to start and starts later, as it was, brings what builds on it up again with it; one that keeps failing does not", async () => {
  globalThis.got = {};
  globalThis.dockerUp = false;
  const docker = half("docker", `if (!globalThis.dockerUp) throw new Error("not yet");\n${PROVIDES("v1")}`);
  const browser = half("browser", USES("docker"), { optional: { docker: "^1.0.0" } });
  await host.syncServerHalves([docker, browser]);
  assert.deepEqual(log(), ["docker start", "browser start"]);
  assert.equal(globalThis.got.browser, null);
  // Asked again with the same halves, while it still fails: what builds on it is left as it is.
  await host.syncServerHalves([docker, browser]);
  assert.deepEqual(log(), ["docker start"]);
  // The same file, starting now.
  globalThis.dockerUp = true;
  await host.syncServerHalves([docker, browser]);
  assert.deepEqual(log(), ["docker start", "browser stop", "browser start"]);
  assert.equal(globalThis.got.browser.from, "v1");
  await host.syncServerHalves([]);
  log();
});
