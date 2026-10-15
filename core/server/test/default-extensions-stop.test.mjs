import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { freePort, serverEnv, startServer, testHome } from "./server-harness.mjs";

/**
 * A portal that stops while it is installing what it starts with (extensions/defaults.json) lets the install finish
 * before it exits: pi is writing its settings, and with the portal gone it would go on writing them alone, into a
 * folder that may be on its way out. pi here is a stand-in that takes two seconds over each install and notes when it
 * starts and ends one.
 */
const home = testHome("default-extensions-stop-");
const bin = path.join(home, "bin");
mkdirSync(bin);
const noted = path.join(home, "pi-installs.txt");
writeFileSync(
  path.join(bin, "pi"),
  `#!/bin/sh
case "$1" in
  list) echo "User packages:" ;;
  install) echo "start $2" >> ${JSON.stringify(noted)}; sleep 2; echo "end $2" >> ${JSON.stringify(noted)} ;;
esac
`,
);
chmodSync(path.join(bin, "pi"), 0o755);

test("a portal stopped while it installs what it starts with exits only once the install has ended", async () => {
  const { child } = await startServer(serverEnv(home, await freePort(), { PATH: `${bin}${path.delimiter}${process.env.PATH}`, PORTAL_DEFAULT_EXTENSIONS: "on" }));
  // An install is going on.
  for (let i = 0; !(existsSync(noted) && readFileSync(noted, "utf8").includes("start")); i++) {
    assert.ok(i < 200, "the portal never began installing what it starts with");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill("SIGTERM");
  await once(child, "exit");
  const lines = readFileSync(noted, "utf8").trim().split("\n");
  const started = lines.filter((line) => line.startsWith("start ")).map((line) => line.slice(6));
  const ended = lines.filter((line) => line.startsWith("end ")).map((line) => line.slice(4));
  assert.deepEqual(ended, started, "every install that began had ended when the portal exited");
});
