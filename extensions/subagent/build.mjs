/**
 * Builds the subagent extension: its browser half (src/client.tsx) into web/, with the Tailwind utilities its page
 * uses made into its own stylesheet from the portal's preset, and its server half (src/server.ts), with the tool's pi
 * half in it, into server.js. The portal's own `npm run build` runs this, so a checkout and the image build it the same
 * way; what it makes is not kept in git.
 *
 * It has no packages of its own: esbuild, tailwindcss and postcss are the repository's.
 */
import { buildExtension } from "@pithagoras/extension-api/build";

await buildExtension({ dir: import.meta.dirname, tailwind: true, server: "src/server.ts" });
console.log("pithagoras-subagent: built web/ and server.js");
