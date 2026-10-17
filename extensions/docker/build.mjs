/**
 * Builds Docker: its browser half (src/client.tsx) into web/, and its server half (src/server.ts) into server.js. The
 * portal's own `npm run build` runs this, so a checkout and the image build it the same way; what it makes is not kept
 * in git. It has no packages of its own: Docker is spoken to over its socket with Node's own http.
 */
import { buildExtension } from "@pithagoras/extension-api/build";

const HERE = import.meta.dirname;
await buildExtension({ dir: HERE, server: "src/server.ts" });
console.log("pithagoras-docker: built web/ and server.js");
