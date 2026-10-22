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

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * What the package in `dir` needs and does not have in its own node_modules as
 * its lock file says: missing, or at another version (a later commit changed
 * the lock, and nothing installed it since). Only what it needs to run, unless
 * `dev`: then also what it is built with. Named as npm names them.
 */
export function missingDependencies(dir = HERE, { dev = false } = {}) {
  const lock = readJson(path.join(dir, "package-lock.json"));
  const wrong = new Set();
  if (lock?.packages) {
    for (const [where, entry] of Object.entries(lock.packages)) {
      if (!where.startsWith("node_modules/") || entry.link || (entry.dev && !dev)) continue;
      const installed = readJson(path.join(dir, where, "package.json"));
      // An optional package is one npm leaves out where it does not fit (another system): only one that is there is checked.
      if (!installed && entry.optional) continue;
      if (installed?.version !== entry.version) wrong.add(where.slice(where.lastIndexOf("node_modules/") + "node_modules/".length));
    }
    return [...wrong];
  }
  // No lock: what the package names, there at all.
  const meta = readJson(path.join(dir, "package.json")) ?? {};
  return Object.keys({ ...meta.dependencies, ...(dev ? meta.devDependencies : {}) }).filter((name) => !existsSync(path.join(dir, "node_modules", name, "package.json")));
}

/**
 * One install at a time per folder, for as long as the portal runs: kept for
 * the process, since this module is read again with each revision of the
 * server half, and an install a revision before started goes on after it.
 */
const installs = (globalThis[Symbol.for("pithagoras-docs/installs")] ??= new Map());

/**
 * Installs what is missing or out of date with npm, as the lock file says, and says so in the
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
    // A process that could not be started says so twice, as an error and as its end: it is told once.
    let settled = false;
    const done = (ok, why) => {
      if (settled) return;
      settled = true;
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
