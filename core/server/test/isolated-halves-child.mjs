import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Server halves in a process of their own, as the portal runs them, where what is looked at is the end of the portal's
 * own process, or an error that reaches it: run by isolated-halves.test.mjs, one scenario a process, with the test's
 * home in its environment. It prints what it found as `RESULT <json>` and ends; one where the error is the process's
 * own ends as Node ends a process.
 */
const { installLogCapture } = await import("../dist/logs.js");
installLogCapture();
const host = await import("../dist/extension-host.js");
const { default: express } = await import("express");
host.catchExtensionCrashes();
host.setLimits(10_000, 1_000);

let revs = 0;
/** A file in the folder of a server half's. */
function file(name, rel, text) {
  const dir = path.join(process.env.DATA_DIR, "halves", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, rel), text);
  return path.join(dir, rel);
}
function half(name, body) {
  const at = file(name, "server.js", `export default async function (portal) {\n${body}\n}\n`);
  return { name, version: "1.0.0", file: at, rev: `r${++revs}`, isolated: true };
}

async function until(done, what) {
  for (const end = Date.now() + 10_000; !done(); await new Promise((resolve) => setTimeout(resolve, 10))) {
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`);
  }
}

const scenarios = {
  /** A pi extension kept in the folder of a half that runs apart, loaded here as a chat's pi loads it, whose timer throws. */
  async piHalf() {
    const piFile = file("with-pi", "pi.js", `setTimeout(() => { throw new Error("its pi extension's own bug"); }, 100);\n`);
    await host.syncServerHalves([half("with-pi", `portal.log("up");`)]);
    await import(pathToFileURL(piFile).href);
    await until(() => !host.isServing("with-pi"), "it crashed");
    await host.serversSettled();
    const { running, crash } = host.serverHalfStatus("with-pi");
    return { running, crash: crash?.error };
  },

  /** A rejection of the portal's own, from no half's code, whose message names a half's folder, as an ENOENT of a copy would. */
  async notWhose() {
    const named = half("named", `portal.log("up");`);
    await host.syncServerHalves([named]);
    setTimeout(() => void Promise.reject(Object.assign(new Error(`ENOENT: no such file or directory, open '${named.file}'`), { code: "ENOENT" })), 50);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return { survived: true };
  },

  /** The portal's process ends, with no stop of its halves: each half's process goes, and what it started. */
  async portalEnds() {
    const app = express().use("/api/x", host.extensionRoutes);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    await host.syncServerHalves([
      half("starter", `
        const { spawn } = await import("node:child_process");
        const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
        portal.router.get("/pids", (req, res) => res.json({ child: process.pid, sleeper: sleeper.pid }));
      `),
    ]);
    const pids = await (await fetch(`http://127.0.0.1:${server.address().port}/api/x/starter/pids`)).json();
    console.log(`RESULT ${JSON.stringify(pids)}`);
    process.exit(0);
  },
};

const result = await scenarios[process.argv[2]]();
await host.stopServerHalves();
console.log(`RESULT ${JSON.stringify(result)}`);
process.exit(0);
