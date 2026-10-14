import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

/**
 * Installing a package twice at once: two `pi install` or two `npm install` into
 * the same folder collide (ENOTEMPTY, a settings file written by both). Here the
 * commands are stand-ins that log when they start and end, and take a moment.
 */
const home = inProcessHome("package-installs-");
const bin = path.join(home, "bin");
const log = path.join(home, "log");
mkdirSync(bin);
writeFileSync(log, "");
// Fails when its argument is "bad", so that the one after a failure is seen to run.
for (const command of ["pi", "npm"]) {
  const file = path.join(bin, command);
  writeFileSync(file, `#!/bin/bash\necho "start ${command} $*" >> "${log}"\nsleep 0.15\necho "end ${command} $*" >> "${log}"\nfor a in "$@"; do [ "$a" = bad ] && { echo boom >&2; exit 1; }; done\nexit 0\n`);
  chmodSync(file, 0o755);
}
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
const { pi } = await import("../dist/api/packages.js");
const { installChannelPackage } = await import("../dist/channels/loader.js");
const lines = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
const clear = () => writeFileSync(log, "");

test("two installs at once run one after the other, in the order they came", async () => {
  clear();
  await Promise.all([pi(["install", "npm:a"]), pi(["install", "npm:b"]), pi(["remove", "npm:a"])]);
  assert.deepEqual(lines(), [
    "start pi install npm:a", "end pi install npm:a",
    "start pi install npm:b", "end pi install npm:b",
    "start pi remove npm:a", "end pi remove npm:a",
  ]);
});

test("one that failed does not stop the next, and reading the list does not wait for an install", async () => {
  clear();
  const failed = pi(["install", "bad"]);
  const next = pi(["update", "--all"]);
  const list = pi(["list"]);
  await assert.rejects(failed, /boom/);
  await next;
  await list;
  const seen = lines();
  assert.ok(seen.indexOf("end pi install bad") < seen.indexOf("start pi update --all"), seen.join("\n"));
  assert.ok(seen.indexOf("start pi list") < seen.indexOf("end pi install bad"), "the list is read at once");
});

test("channel packages are installed one at a time as well", async () => {
  clear();
  await Promise.all([installChannelPackage("user/one"), installChannelPackage("user/two")]);
  const seen = lines().map((l) => l.replace(/ --omit=dev --no-audit --no-fund/, ""));
  assert.deepEqual(seen, ["start npm install user/one", "end npm install user/one", "start npm install user/two", "end npm install user/two"]);
});
