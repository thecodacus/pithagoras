import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The packages an extension's server half runs on, put where it finds them before it is started.
 *
 * pi installs a package by its folder without installing what the package depends on, and the image installs them when it is
 * built. A folder that comes without them (a checkout the portal runs from, a copy made by hand) has them installed here,
 * once, in the background: a server half has fifteen seconds to start, and an install takes longer. Only a package that has
 * a lock file is installed from it, as `npm ci` does, with no install script (a native package brings its binaries with it).
 */

const readJson = (file: string): any => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/**
 * What the package in `dir` needs to run and does not have in its own node_modules as its lock file says: missing, or at
 * another version (a later commit changed the lock, and nothing installed it since). Named as npm names them. An optional
 * package is one npm leaves out where it does not fit (another system): only one that is there is checked.
 */
export function missingPackages(dir: string): string[] {
  const lock = readJson(path.join(dir, "package-lock.json"));
  const wrong = new Set<string>();
  for (const [where, entry] of Object.entries<any>(lock?.packages ?? {})) {
    // What only the build needs (and what is both that and optional) is not installed to run.
    if (!where.startsWith("node_modules/") || entry.link || entry.dev || entry.devOptional) continue;
    const installed = readJson(path.join(dir, where, "package.json"));
    if (!installed && entry.optional) continue;
    if (installed?.version !== entry.version) wrong.add(where.slice(where.lastIndexOf("node_modules/") + "node_modules/".length));
  }
  return [...wrong];
}

/** Whether the package in `dir` is one to install from a lock file. */
export const hasLock = (dir: string): boolean => existsSync(path.join(dir, "package-lock.json"));

/** How long an install may take: a registry that does not answer must not hold the folder for ever. */
const INSTALL_MS = 10 * 60_000;

/**
 * Installs what `missingPackages` finds missing in `dir`, as the lock says: only what it needs to run, from npm's cache when it
 * can, so that a portal with no network works when everything is there. Resolves undefined once everything is there, else why
 * it is not (what npm said last, or why it could not be run).
 */
export function installPackages(dir: string, { npm = process.platform === "win32" ? "npm.cmd" : "npm" }: { npm?: string } = {}): Promise<string | undefined> {
  return new Promise((resolve) => {
    // A process that could not be started says so twice, as an error and as its end: it is told once.
    let settled = false;
    const done = (why?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (why !== undefined) return resolve(why);
      const still = missingPackages(dir);
      resolve(still.length ? `still missing after npm: ${still.join(", ")}` : undefined);
    };
    let said = "";
    const child = spawn(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr!.on("data", (chunk) => (said = (said + chunk).slice(-2000)));
    const timer = setTimeout(() => {
      child.kill();
      done(`npm did not finish in ${INSTALL_MS / 60_000} minutes`);
    }, INSTALL_MS);
    timer.unref();
    child.on("error", (error) => done(error.message));
    child.on("close", (code) => {
      if (code !== 0) return done(`npm exited with ${code}${said.trim() ? `: ${said.trim().split("\n").slice(-3).join(" ")}` : ""}`);
      done();
    });
  });
}
