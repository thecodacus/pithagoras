/**
 * Builds Canvases: its browser half (src/client.tsx) into web/, with its own
 * stylesheet, and its server half (src/server.ts) into server.js. The portal's
 * own `npm run build` runs this, so a checkout and the image build it the same
 * way; what it makes is not kept in git.
 *
 * What it is built with (the icons) is this package's
 * own, installed here first when it is not there yet, or not at the version its
 * lock file names. esbuild is the repository's.
 */
import { buildExtension } from "@pithagoras/extension-api/build";

const HERE = import.meta.dirname;

// Its packages first, if they are not there or not the versions its lock file names (a later commit changed them).
await buildExtension({ dir: HERE, install: true, server: "src/server.ts" });
console.log("pithagoras-canvas: built web/ and server.js");
