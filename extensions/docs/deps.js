/**
 * The extension's own dependencies, there before its server half needs them.
 *
 * pi installs a package by its path without installing what the package
 * depends on, and the image installs them when it is built. A folder that
 * comes without them (a checkout the portal runs from, a copy made by hand)
 * has them installed here, once, when the portal starts: in the background,
 * since a server half has a few seconds to start and an install takes longer.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** What the package in `dir` depends on to run and does not have in its own node_modules. */
export function missingDependencies(dir = HERE) {
  const meta = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  return Object.keys(meta.dependencies ?? {}).filter((name) => !existsSync(path.join(dir, "node_modules", name, "package.json")));
}

/**
 * One install at a time per folder, and one for as long as the portal runs:
 * this module is read once, while the server half is started again with each
 * switch of the package.
 */
const installs = new Map();

/**
 * Installs what is missing with npm, as the lock file says, and says so in the
 * portal's log. Resolves true once everything is there, false when the install
 * failed (and a later start tries again).
 */
export function ensureDependencies(log, { dir = HERE, npm = process.platform === "win32" ? "npm.cmd" : "npm" } = {}) {
  const missing = missingDependencies(dir);
  if (!missing.length) return Promise.resolve(true);
  if (installs.has(dir)) return installs.get(dir);
  log(`Installing its dependencies (${missing.join(", ")}) with npm`);
  const started = Date.now();
  const install = new Promise((resolve) => {
    // Only what it needs to run, and without install scripts: better-sqlite3 brings its binaries with it.
    const child = spawn(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
    let said = "";
    child.stderr.on("data", (chunk) => (said = (said + chunk).slice(-2000)));
    const done = (ok, why) => {
      installs.delete(dir);
      if (ok) log(`Installed its dependencies in ${Math.round((Date.now() - started) / 1000)} s`);
      else log(`Could not install its dependencies: ${why}`);
      resolve(ok);
    };
    child.on("error", (error) => done(false, error.message));
    child.on("close", (code) => {
      if (code !== 0) return done(false, `npm exited with ${code}${said.trim() ? `: ${said.trim().split("\n").slice(-3).join(" ")}` : ""}`);
      const still = missingDependencies(dir);
      done(!still.length, `still missing after npm: ${still.join(", ")}`);
    });
  });
  installs.set(dir, install);
  return install;
}
