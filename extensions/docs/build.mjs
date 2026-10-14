/**
 * Builds the document editor (src/editor.js) into one module beside the
 * browser half (web/editor.js), which loads it when a document is first
 * edited. The portal's own `npm run build` runs this, so a checkout and the
 * image build it the same way; the bundle is not kept in git.
 *
 * esbuild is the one the repository's own packages already bring,
 * found in the repository's node_modules: nothing is added for it. The editor
 * itself is this package's own (devDependencies), installed here first when
 * it is not there yet, or not at the version its lock file names.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { missingDependencies } from "./deps.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "web", "editor.js");

// Missing, or not the versions the lock names (a later commit changed them): installed as the lock says.
const missing = missingDependencies(HERE, { dev: true });
if (missing.length) {
  console.log(`pithagoras-docs: installing its packages (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""})`);
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], { cwd: HERE, stdio: "inherit" });
}

const { build } = await import("esbuild");
await build({
  entryPoints: [path.join(HERE, "src", "editor.js")],
  outfile: OUT,
  bundle: true,
  format: "esm",
  minify: true,
  target: "es2022",
  legalComments: "eof",
  logLevel: "warning",
});
console.log(`pithagoras-docs: built ${path.relative(process.cwd(), OUT)}`);
