/**
 * The portal's server was in server/ before it moved to core/server. What was
 * started from there (a service running `node server/dist/index.js`, the
 * restart after an update, `node server/dist/reset-password.js` in a
 * container) keeps working: each of those files is written here as one that
 * loads the same file in its new place. `npm run build` runs this after the
 * server is built.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const old = path.join(root, "server", "dist");
mkdirSync(old, { recursive: true });
// What is in it is ES modules, as the server's own files are.
writeFileSync(path.join(old, "package.json"), JSON.stringify({ type: "module" }) + "\n");
for (const entry of ["index.js", "reset-password.js", "sso-only-off.js"]) {
  writeFileSync(
    path.join(old, entry),
    `// The server moved to core/server: this loads ${entry} from there (scripts/old-entries.mjs).\nimport "../../core/server/dist/${entry}";\n`,
  );
}
console.log(`[${new Date().toISOString().slice(11, 19)}] the old start files in server/dist load core/server/dist`);
