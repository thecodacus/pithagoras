/**
 * Builds the document editor (src/editor.js) into one module beside the
 * browser half (web/editor.js), which loads it when a document is first
 * edited. The portal's own `npm run build` runs this, so a checkout and the
 * image build it the same way; the bundle is not kept in git.
 *
 * esbuild is the one the portal's web build already has (it comes with vite),
 * found in the repository's node_modules: nothing is added for it. The editor
 * itself is this package's own (devDependencies), installed here first when
 * it is not there yet.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "web", "editor.js");

const meta = JSON.parse(readFileSync(path.join(HERE, "package.json"), "utf8"));
const wanted = Object.keys({ ...meta.dependencies, ...meta.devDependencies });
if (wanted.some((name) => !existsSync(path.join(HERE, "node_modules", name, "package.json")))) {
  console.log("pithagoras-docs: installing its packages");
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
