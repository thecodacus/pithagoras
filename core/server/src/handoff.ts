import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./data-dir.js";

/**
 * What the portal leaves for an extension to take up, when something it did itself becomes an extension's: the upgrade
 * that takes it out of the portal leaves what it had (its records, its settings, its files) in a folder of the data
 * folder, under a name for what it was, and the extension that does it now takes that folder into its own when it
 * starts (`portal.handoffs`, see extension-host.ts), reads it, and says it is done. What nobody takes stays as it was
 * left: an extension can be installed long after the upgrade, or never.
 */

/** Where what is left waits to be taken: a folder of the data folder, closed to all but the portal. */
export const handoffRoot = (): string => path.join(path.resolve(DATA_DIR), "handoff");

/** What a hand-off may be called: one part of a path, and never one that begins with a dot, as a step up, a folder still being filled and one being taken do. */
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** `name`, where a hand-off may be called that; a refusal otherwise. */
function named(name: string): string {
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new TypeError(`"${String(name)}" is not a hand-off's name: small letters, digits, dots, dashes and underscores, from a letter or a digit, at most 64`);
  }
  return name;
}

/**
 * `from` put at `to`, where nothing is yet: by a rename, which keeps all of it as it was. Where `to` is on another file
 * system (a folder of the data folder that is mounted on its own) by a copy that keeps the files' times, which is what
 * the copies made of a file are told apart by, put in place by a rename, and `from` removed after. A copy cut off
 * half way is copied over by the next try.
 */
export function moveTo(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    const copy = `${to}.copy`;
    cpSync(from, copy, { recursive: true, preserveTimestamps: true });
    renameSync(copy, to);
    rmSync(from, { recursive: true, force: true });
  }
}

/**
 * The folder `from` put at `to`, where nothing is yet: by one rename where it can be. One that cannot be moved whole (a
 * folder mounted on its own, or one on another file system than `to`), and a link to a folder elsewhere, which a
 * rename would move as a link, stays where it is, a link with the folder it leads to; what is in it is moved, each by
 * `moveTo`, into a folder beside `to` of a fixed name, which is put in place by one rename once all of it is there. A
 * try that stopped half way leaves that folder, and the next goes on filling it, even where `from` could be moved
 * whole by then (it is not mounted any more, say): what was moved before is in it. A `from` that is not there is
 * nothing to move, unless a try moved some of it before: then it is a folder out of reach for now (a link to a disk
 * that is not there yet), and it is refused, for what was moved of it not to be put in place without the rest.
 */
export function moveFolderTo(from: string, to: string): void {
  const filling = path.join(path.dirname(to), `.${path.basename(to)}.partial`);
  if (!existsSync(from)) {
    if (existsSync(filling)) throw Object.assign(new Error(`${from} cannot be reached, and what was moved of it waits in ${filling}`), { code: "ENOENT" });
    return;
  }
  if (!existsSync(filling) && !lstatSync(from).isSymbolicLink()) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EXDEV") throw e;
    }
  }
  mkdirSync(filling, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(from)) {
    // Copied over by a try that stopped as it removed what it had copied: what is left of it goes.
    if (existsSync(path.join(filling, name))) rmSync(path.join(from, name), { recursive: true, force: true });
    else moveTo(path.join(from, name), path.join(filling, name));
  }
  renameSync(filling, to);
}

/**
 * Leaves what `fill` puts in the folder it is given under `name`, whole: it is filled in a folder beside it of a fixed
 * name, which a try that stopped half way (the upgrade it was part of rolled back, or the portal stopped) leaves for the
 * next to go on with, so `fill` leaves what is there and moves what is not; and it is put in place by one rename.
 * "there" when an earlier try left it already: `fill` is not called, as what it would move is in it.
 */
export function leaveHandoff(name: string, fill: (dir: string) => void): "left" | "there" {
  const root = handoffRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const left = path.join(root, name);
  if (existsSync(left)) return "there";
  const filling = path.join(root, `.${name}.partial`);
  mkdirSync(filling, { recursive: true, mode: 0o700 });
  fill(filling);
  renameSync(filling, left);
  return "left";
}

/** Where a hand-off taken into the folder `into` is, until it has been read. */
const takenIn = (into: string, name: string): string => path.join(into, `handoff-${named(name)}`);

/**
 * What was left under `name`, moved into `into` (`<into>/handoff-<name>`), and its path; nothing when nothing was. One
 * taken before is where it was put, until `handoffDone`.
 *
 * It is first moved aside, under a fixed name beside where it was left, and from there into `into`: where `into` is on
 * another file system, it is copied, and removed after, and a start that stopped while it was removed leaves the rest
 * of it there, never where a hand-off is left, so it is not taken a second time. A hand-off left again since, by an
 * upgrade from an older version that the person went back to, is where it was left, and is taken once this one is done.
 */
export function takeHandoff(name: string, into: string): string | undefined {
  const taken = takenIn(into, name);
  const moving = path.join(handoffRoot(), `.${name}.taking`);
  if (existsSync(taken)) {
    rmSync(moving, { recursive: true, force: true });
    return taken;
  }
  if (!existsSync(moving)) {
    const left = path.join(handoffRoot(), name);
    if (!existsSync(left)) return undefined;
    renameSync(left, moving);
  }
  moveTo(moving, taken);
  return taken;
}

/** What `takeHandoff` moved into `into`, removed: it has been read. */
export function handoffDone(name: string, into: string): void {
  rmSync(takenIn(into, name), { recursive: true, force: true });
}
