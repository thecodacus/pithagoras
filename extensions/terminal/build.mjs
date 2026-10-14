/**
 * Builds the terminal's browser half (src/client.tsx) into web/: client.js,
 * client.css, and the shell as a chunk of its own, fetched only when a Shell
 * tab is first opened. The portal's own `npm run build` runs this, so a
 * checkout and the image build it the same way; the output is not kept in git.
 *
 * What it is built with (the terminal emulator, the icons) is this package's
 * own (devDependencies), installed here first when it is not there yet, or not
 * at the version its lock file names. esbuild is the repository's.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildExtension } from "@pithagoras/extension-api/build";

const HERE = import.meta.dirname;

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

// Missing, or not the versions the lock names (a later commit changed them): installed as the lock says.
const lock = readJson(path.join(HERE, "package-lock.json"));
const missing = Object.entries(lock?.packages ?? {}).filter(
  ([where, entry]) => where.startsWith("node_modules/") && !entry.link && readJson(path.join(HERE, where, "package.json"))?.version !== entry.version && !entry.optional,
);
if (missing.length) {
  console.log(`pithagoras-terminal: installing its packages (${missing.length})`);
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], { cwd: HERE, stdio: "inherit" });
}

await buildExtension({ dir: HERE });
console.log("pithagoras-terminal: built web/");
