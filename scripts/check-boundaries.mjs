/**
 * Keeps the portal's core and the extensions in this repository apart, so that
 * an extension that comes with the portal is an extension like any other:
 *
 *   - core (core/web/src, core/server/src) imports nothing from the extensions/ folder;
 *   - an extension imports nothing of core: not core/, by a path or
 *     by their package names.
 *
 * Both may import packages/extension-api, which is the contract between them,
 * and any package from npm. Tests are not checked, core's nor an extension's
 * own (extensions/<name>/test): a test may reach into both.
 *
 * Run by `npm test` and in CI. `node scripts/check-boundaries.mjs [repo]`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP = new Set(["node_modules", "dist", ".git", "chunks", "assets"]);
/** What a file names as something it loads: static and dynamic imports, re-exports, require. */
const SPECIFIERS = [
  /\b(?:import|export)\s+(?:type\s+)?[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/g,
  /\bimport\s*(['"])([^'"]+)\1/g,
  /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
];
const CORE_PACKAGES = /^@pithagoras\/(?:web|server)(?:\/|$)/;

function* sources(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(full);
    else if (SOURCE.test(entry.name) && !entry.name.endsWith(".d.ts")) yield full;
  }
}

/** Each thing `file` loads, with the line it is on. */
function specifiersOf(file) {
  const text = readFileSync(file, "utf8");
  const found = [];
  for (const pattern of SPECIFIERS) {
    for (const match of text.matchAll(pattern)) found.push({ spec: match[2], line: text.slice(0, match.index).split("\n").length });
  }
  return found;
}

const within = (target, dir) => target === dir || target.startsWith(dir + path.sep);

/** Every import that crosses between core and the extensions, in the repository at `root`. */
export function findCrossings(root) {
  const core = [path.join(root, "core", "web", "src"), path.join(root, "core", "server", "src")];
  const coreFolder = path.join(root, "core");
  const extensions = path.join(root, "extensions");
  const crossings = [];
  const say = (file, line, spec, why) => crossings.push(`${path.relative(root, file)}:${line} imports "${spec}": ${why}`);

  for (const base of core) {
    for (const file of sources(base)) {
      for (const { spec, line } of specifiersOf(file)) {
        if (!spec.startsWith(".") && !path.isAbsolute(spec)) continue;
        const target = path.resolve(path.dirname(file), spec);
        if (within(target, extensions)) say(file, line, spec, "core imports nothing from extensions/");
      }
    }
  }
  if (existsSync(extensions) && statSync(extensions).isDirectory()) {
    const isTest = (file) => path.relative(extensions, file).split(path.sep)[1] === "test";
    for (const file of sources(extensions)) {
      if (isTest(file)) continue;
      for (const { spec, line } of specifiersOf(file)) {
        if (CORE_PACKAGES.test(spec)) {
          say(file, line, spec, "an extension imports nothing of core");
          continue;
        }
        if (!spec.startsWith(".") && !path.isAbsolute(spec)) continue;
        const target = path.resolve(path.dirname(file), spec);
        if (within(target, coreFolder)) say(file, line, spec, "an extension imports nothing of core");
      }
    }
  }
  return crossings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".."));
  const crossings = findCrossings(root);
  if (crossings.length) {
    console.error(`Core and the extensions import each other in ${crossings.length} place${crossings.length === 1 ? "" : "s"}:\n  ${crossings.join("\n  ")}`);
    console.error("Between them is packages/extension-api: what an extension needs of the portal, it gets through the portal it is given.");
    process.exit(1);
  }
  console.log("Core and the extensions are apart.");
}
