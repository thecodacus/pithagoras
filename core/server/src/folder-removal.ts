import { randomBytes } from "node:crypto";
import { readdirSync, renameSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

/**
 * Taking a whole folder away without holding the server up.
 *
 * `rmSync` on a project or an agent's home runs on the thread that serves every
 * chat: with a `node_modules` in it, or on a network share, that is seconds in
 * which no stream moves. So the folder is renamed to a name of its own beside
 * where it was, which is instant and puts it out of every listing at once, and
 * removed from there without waiting for it.
 */
const PREFIX = ".deleting-";
/** Only a name removeFolderLater made: the folder it sweeps holds the user's own, and `.deleting-later` may be one of them. */
const PUT_ASIDE = /^\.deleting-[0-9a-f]{12}$/;

export function removeFolderLater(dir: string): void {
  const away = path.join(path.dirname(dir), `${PREFIX}${randomBytes(6).toString("hex")}`);
  try {
    renameSync(dir, away);
  } catch {
    // A mount point, or a rename the system refuses: it is removed where it is, as it was before.
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  void rm(away, { recursive: true, force: true }).catch((e) => console.error(`[portal] could not finish removing ${away}: ${(e as Error).message}`));
}

/**
 * Finishes what a stop in the middle left: folders put aside by removeFolderLater
 * whose removal did not get to the end. Called at startup for the folders that hold them.
 */
export function sweepRemoved(parent: string): void {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (!PUT_ASIDE.test(name)) continue;
    void rm(path.join(parent, name), { recursive: true, force: true }).catch(() => {});
  }
}
