/**
 * The jszip loader: NO module of this package imports jszip statically. The built server.js is imported by the
 * portal BEFORE the extension's own node_modules are guaranteed to exist (a hand-copied folder has none), and
 * deps.ensureDependencies -- wired into the server entry at boot -- installs them in the BACKGROUND, exactly as
 * pithagoras-docs does for better-sqlite3. So the first template/import call here AWAITs the armed install promise
 * and only then imports jszip; the synchronous parts of the store never touch it. A load that fails is not cached:
 * the next call retries after a later boot re-arms or the install settles.
 */
import type JSZip from "jszip";

/** The loaded package's shape: the constructor AND its statics (JSZip.loadAsync). */
export type JSZipStatic = typeof JSZip;

let install: Promise<boolean> | null = null;
let load: Promise<JSZipStatic> | null = null;

/** Arm this loader with the boot-time install (the server entry wires deps.ensureDependencies through here).
 * The first jsZip() call waits on it before importing. */
export function armJsZipInstall(promise: Promise<boolean>): void {
  install = promise;
}

/** jszip, at most one load per boot. `typeof` note: the default import of an `export =` module is the package
 * itself, so a bare `new` and `.loadAsync` both work on the result. */
export function jsZip(): Promise<JSZipStatic> {
  if (!load) {
    load = (async () => {
      try {
        if (install) await install; // whatever it resolved to -- the import below surfaces a real failure with its own message
        return (await import("jszip")).default;
      } catch (err) {
        load = null; // not cached: a later call retries once the background install has had its chance
        throw err;
      }
    })();
  }
  return load;
}
