import path from "node:path";
import { installFetchWaits } from "./fetch-waits.js";
import { DATA_DIR } from "./data-dir.js";
import { holdDataDir } from "./instance-lock.js";
import { piCli } from "./pi/package.js";
import { installLogCapture } from "./logs.js";
// Records the command line the portal was started with, before `process.argv[1]` is replaced below.
import "./restart.js";

/**
 * The server's entry.
 *
 * The data is held first, before anything that opens the database is loaded:
 * a second server on it would mark the running one's chats interrupted. One
 * that is turned away has loaded nothing else.
 */
// Node's fetch gave up after five quiet minutes whatever anyone asked. The imports above have finished
// loading by the time this line runs, and none of them reach out at load; everything else that does —
// every server life of the process — gets its waits here first.
installFetchWaits();
// What the server prints is kept from here on, for Settings → Logs.
installLogCapture();

let ours: boolean;
try {
  ours = await holdDataDir(DATA_DIR);
} catch (e) {
  console.error(`pithagoras could not hold its data in ${path.resolve(DATA_DIR)}: ${(e as Error).message}`);
  process.exit(1);
}
if (!ours) {
  console.error(`pithagoras is already running on ${path.resolve(DATA_DIR)}. Not starting a second one.`);
  process.exit(1);
}

/*
 * pi runs inside this process, and an extension that starts another pi the way
 * pi's own examples do — this runtime and `process.argv[1]` — started this file
 * again: a second server. In pi, `argv[1]` is pi's command line; here it is made
 * so, whatever the extension passes on. Nothing in the server reads it.
 */
const cli = piCli();
if (cli) process.argv[1] = cli;
else console.error("[portal] pi's command line was not found: an extension that starts pi from process.argv[1] starts the server instead, and is turned away.");

// Upgraded, if it needs to be, before anything opens the database: checked and
// backed up first, with a page up meanwhile. Where it cannot be, this does not
// return, and the page says why.
const { prepareDatabase } = await import("./db-upgrade.js");
await prepareDatabase();

await import("./server.js");
