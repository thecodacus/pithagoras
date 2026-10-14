import { parentPort, workerData } from "node:worker_threads";
import { runUpgrade, type UpgradeOptions } from "./db-upgrade-steps.js";

/**
 * The upgrade, off the main thread: SQLite's calls block, and a check or a
 * migration over a large table would otherwise leave the maintenance page
 * unanswered for as long as it ran.
 */
runUpgrade(workerData as UpgradeOptions, (message) => parentPort!.postMessage({ type: "progress", message })).then(
  (backup) => parentPort!.postMessage({ type: "done", backup }),
  (e: Error & { damaged?: boolean }) => parentPort!.postMessage({ type: "failed", error: e.message, damaged: Boolean(e.damaged) })
);
