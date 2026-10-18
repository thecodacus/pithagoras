import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The packages an extension's server half runs on (extension-install.ts), installed by the portal from the lock file before the
 * half is started: not by the extension at run time, which has fifteen seconds to start and an install takes longer.
 */
const home = inProcessHome("extension-install-");
const { missingPackages, installPackages, hasLock } = await import("../dist/extension-install.js");
const host = await import("../dist/extension-host.js");
test.after(() => host.stopServerHalves());

/** `version` of the package at `where` in the package folder `dir`, as npm leaves it there. */
function installed(dir, where, version) {
  mkdirSync(path.join(dir, where), { recursive: true });
  writeFileSync(path.join(dir, where, "package.json"), JSON.stringify({ version }));
}

let n = 0;
/**
 * A package folder that depends on `a` (which brings `d`) and `b` to run and on `c` to be built, as its lock file says, with an npm that
 * runs `npmSays` (a shell script) and records what it was asked.
 */
function packageNeeding(npmSays) {
  const dir = path.join(home, `package-${++n}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `needs-${n}`, dependencies: { a: "^1.0.0", b: "^1.0.0" }, devDependencies: { c: "1.0.0" } }));
  writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({
    name: "needs", lockfileVersion: 3, packages: {
      "": { name: "needs" },
      "node_modules/a": { version: "1.2.0" },
      "node_modules/a/node_modules/d": { version: "2.0.0" },
      "node_modules/b": { version: "1.0.0" },
      "node_modules/c": { version: "1.0.0", dev: true },
      // Only where it fits: left out by npm elsewhere.
      "node_modules/e": { version: "1.0.0", optional: true },
    },
  }));
  const npm = path.join(dir, "fake-npm");
  writeFileSync(npm, `#!/bin/sh\necho "$@" >> "${dir}/asked"\n${npmSays}\n`);
  chmodSync(npm, 0o755);
  return { dir, npm, asked: () => readFileSync(path.join(dir, "asked"), "utf8").trim().split("\n") };
}
/** What a fake npm does for `npm ci --omit=dev`: what the lock names to run, at its versions. */
const INSTALLS = [["node_modules/a", "1.2.0"], ["node_modules/a/node_modules/d", "2.0.0"], ["node_modules/b", "1.0.0"]]
  .map(([where, version]) => `mkdir -p ${where} && echo '{"version":"${version}"}' > ${where}/package.json`).join(" && ");

test("what a package needs to run and has not, or has at another version than its lock names, is found; what only its build needs is not asked for", () => {
  const { dir } = packageNeeding("");
  assert.equal(hasLock(dir), true);
  assert.deepEqual(missingPackages(dir), ["a", "d", "b"]);
  installed(dir, "node_modules/a", "1.2.0");
  installed(dir, "node_modules/a/node_modules/d", "2.0.0");
  assert.deepEqual(missingPackages(dir), ["b"], "the one that is built with is not asked for");
  installed(dir, "node_modules/b", "1.0.0");
  assert.deepEqual(missingPackages(dir), []);
  // A later commit moved `a` on, and `a` brings another `d`: both are found, and an optional package that is there is checked like the rest.
  installed(dir, "node_modules/a", "1.0.0");
  installed(dir, "node_modules/a/node_modules/d", "1.0.0");
  installed(dir, "node_modules/e", "0.1.0");
  assert.deepEqual(missingPackages(dir), ["a", "d", "e"]);
  rmSync(path.join(dir, "package-lock.json"));
  assert.equal(hasLock(dir), false);
  assert.deepEqual(missingPackages(dir), [], "without a lock there is nothing to install from");
});

test("an install is npm ci for what it needs to run, with no install script, and says so when it is done or why it is not", async () => {
  const ok = packageNeeding(INSTALLS);
  assert.equal(await installPackages(ok.dir, { npm: ok.npm }), undefined);
  assert.deepEqual(ok.asked(), ["ci --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline"]);
  assert.deepEqual(missingPackages(ok.dir), []);
  // npm that says it did and did not: what is still missing is said.
  const half = packageNeeding("mkdir -p node_modules/b && echo '{\"version\":\"1.0.0\"}' > node_modules/b/package.json");
  assert.equal(await installPackages(half.dir, { npm: half.npm }), "still missing after npm: a, d");
  // One that fails says what it printed last.
  const bad = packageNeeding('echo "npm error network unreachable" >&2; exit 1');
  assert.equal(await installPackages(bad.dir, { npm: bad.npm }), "npm exited with 1: npm error network unreachable");
  // And one that cannot be started at all, once.
  assert.match(await installPackages(bad.dir, { npm: path.join(bad.dir, "no-such-npm") }), /spawn .*no-such-npm ENOENT$/);
});

let revs = 0;
/** A server half whose package folder is `install`'s: it records that it started in `globalThis.started`. */
function half(name, install) {
  const dir = path.join(home, "halves", name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `server-${++revs}.js`);
  writeFileSync(file, `export default async function () { (globalThis.started ??= []).push("${name}"); }\n`);
  return { name, version: "1.0.0", file, rev: `${statSync(file).size.toString(36)}-${revs}`, install };
}
const until = async (ok, what) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(ok(), what);
};

test("a half whose packages are not there waits for them, says so in Settings, and is started once they are, while the others start at once", async () => {
  const { dir, npm } = packageNeeding(`sleep 0.3; ${INSTALLS}`);
  host.setNpm(npm);
  globalThis.started = [];
  const waits = half("waits", dir);
  const free = half("free");
  const builds = { ...half("builds"), requires: { waits: "^1.0.0" } };
  const t0 = Date.now();
  await host.syncServerHalves([builds, waits, free]);
  assert.ok(Date.now() - t0 < 250, "the sync does not wait for the install");
  assert.deepEqual(globalThis.started, ["free"]);
  assert.equal(host.serverFailure("waits"), "Its packages are being installed");
  assert.match(host.serverFailure("builds"), /It needs waits, which cannot start: Its packages are being installed/);
  // Installed: it starts, and what builds on it after it.
  await until(() => host.isServing("builds"), "the half to start once its packages are installed");
  assert.deepEqual(globalThis.started, ["free", "waits", "builds"]);
  assert.equal(host.serverFailure("waits"), undefined);
  // Everything there: no second install for a sync that follows.
  await host.syncServerHalves([builds, waits, free]);
  assert.equal(readFileSync(path.join(dir, "asked"), "utf8").trim().split("\n").length, 1);
  await host.syncServerHalves([]);
  host.setNpm(undefined);
});

test("an install that fails is said in Settings and not tried again by itself; the next change of what is installed tries again", async () => {
  const { dir, npm, asked } = packageNeeding('echo "npm error network unreachable" >&2; exit 1');
  host.setNpm(npm);
  globalThis.started = [];
  const waits = half("fails", dir);
  await host.syncServerHalves([waits]);
  await until(() => /could not be installed/.test(host.serverFailure("fails") ?? ""), "the failure to be said");
  assert.equal(host.serverFailure("fails"), "Its packages could not be installed: npm exited with 1: npm error network unreachable");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(asked().length, 1, "not again by itself");
  assert.deepEqual(globalThis.started, []);
  // Something else was installed or switched: it is tried again, and this time npm works.
  writeFileSync(npm, `#!/bin/sh\necho "$@" >> "${dir}/asked"\n${INSTALLS}\n`);
  await host.syncServerHalves([waits]);
  await until(() => host.isServing("fails"), "the half to start once the install works");
  assert.equal(asked().length, 2);
  assert.deepEqual(globalThis.started, ["fails"]);
  await host.syncServerHalves([]);
  host.setNpm(undefined);
});

test("a half that is stopped while its packages are installed is not started by the install that ends after", async () => {
  const { dir, npm } = packageNeeding(`sleep 0.3; ${INSTALLS}`);
  host.setNpm(npm);
  globalThis.started = [];
  await host.syncServerHalves([half("late", dir)]);
  await host.syncServerHalves([]);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(globalThis.started, []);
  assert.equal(host.isServing("late"), false);
  host.setNpm(undefined);
});
