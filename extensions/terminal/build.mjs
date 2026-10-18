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
import { buildExtension } from "@pithagoras/extension-api/build";

const HERE = import.meta.dirname;

// Its packages first, if they are not there or not the versions its lock file names (a later commit changed them).
await buildExtension({ dir: HERE, install: true });
console.log("pithagoras-terminal: built web/");
