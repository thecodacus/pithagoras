/**
 * Builds pithagoras-office: its browser half (src/client.tsx) into web/, with the Tailwind utilities its components use
 * made into its own stylesheet from the portal's preset, and its server half (src/server.ts) into server.js. The
 * portal's own `npm run build` runs this, so a checkout and the image build it the same way; what it makes is not kept
 * in git.
 *
 * What it is built and runs with (react-icons for the browser half, jszip for the OOXML templates on the server
 * side -- which deps.js ALSO installs at boot in the background, as pithagoras-docs does) is this package's own,
 * installed here first when it is not there yet, or not at the version its lock file names (missingDependencies,
 * shared with deps.js). esbuild, tailwindcss and postcss are the repository's.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { buildExtension } from "@pithagoras/extension-api/build";
import { missingDependencies } from "./deps.js";

const HERE = import.meta.dirname;

// Missing, or not the versions the lock names (a later commit changed them): installed as the lock says.
const missing = missingDependencies(HERE, { dev: true });
if (missing.length) {
  console.log(`pithagoras-office: installing its packages (${missing.length})`);
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], { cwd: HERE, stdio: "inherit" });
}

await buildExtension({ dir: HERE, tailwind: true, server: "src/server.ts" });
console.log("pithagoras-office: built web/ and server.js");
