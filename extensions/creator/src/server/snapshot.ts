import { createHash, randomBytes } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, readdirSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Chat } from "@pithagoras/extension-api/server";
import { check } from "./check";
import { madeDir, type Run } from "./made";

/** At most this much is copied of a draft: 64 MB in all, `node_modules` included; 10,000 files; 32 folders deep. */
export const LIMITS = { bytes: 64 * 1024 * 1024, files: 10_000, depth: 32 };

/** A draft copied into Creator's folder, at `made/<name>`: what is installed, and what was left out. */
export interface Copy {
  name: string;
  version?: string;
  /** The copy: `<dataDir>/made/<name>`. */
  folder: string;
  /** sha256 of the copy, hex: see `digestOf`. */
  digest: string;
  files: number;
  bytes: number;
  /** The links in the draft, by their paths in it: left out, not followed. */
  left: string[];
  /**
   * The copy this one took the place of, put aside (`made/.old-<name>-<hex>`) until the install is done: removed once it
   * is (`installed`), put back where it was if it is not (`undo`).
   */
  old?: string;
}

/** Lets the portal's other work in: the files API is synchronous, and a whole draft read in one go would stall every chat and route. */
const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * sha256 over each file's path, a NUL, its size in bytes as decimal text, a NUL and its bytes, in the order of the
 * paths. With the size, the bytes of one file and the path of the next cannot be read across their boundary.
 */
export function digestOf(files: { rel: string; bytes: Buffer }[]): string {
  const hash = createHash("sha256");
  for (const { rel, bytes } of [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    hash.update(rel).update("\0").update(String(bytes.length)).update("\0").update(bytes);
  }
  return hash.digest("hex");
}

/**
 * Copies the draft `draft`, a folder in the chat's own, into Creator's folder, checks the copy, and puts it in place
 * at `made/<name>`. Read as the chat's agent: with the sandbox on, what that agent may not read refuses the copy,
 * named (leaving it out would install a package that is not the draft), and a link is left out, never followed. Each
 * file is new, so its time is: the halves get a new revision, and are loaded again. Gives up once its start was
 * stopped, before anything is put in place; and on a refusal, nothing is left of it.
 */
export async function snapshot(run: Run, chat: Chat, draft: string): Promise<Copy> {
  const { portal } = run;
  if (typeof draft !== "string" || draft === "" || path.isAbsolute(draft)) throw new Error("path is a folder of this chat's folder, written relative to it: extensions/<name>");
  const base = portal.chats.folder(chat.id);
  // Refuses `..` and a link that leads out.
  const top = path.relative(base, portal.files.inside(base, draft));
  const asAgent = { likeParent: true, chats: [chat.id] };
  const made = madeDir(run);
  mkdirSync(made, { recursive: true, mode: 0o700 });
  const incoming = path.join(made, `.incoming-${randomBytes(4).toString("hex")}`);
  mkdirSync(incoming, { mode: 0o700 });
  const going = async () => {
    await yieldNow();
    if (run.stopped) throw new Error("Creator mode was stopped while it copied the extension: nothing was installed");
  };
  try {
    const files: { rel: string; bytes: Buffer }[] = [];
    const left: string[] = [];
    let bytes = 0;
    const over = (what: string) => new Error(`It is over what is copied of an extension (${what}): leave out what it does not need`);
    const walk = async (rel: string, depth: number): Promise<void> => {
      const shown = rel === top ? draft : path.relative(top, rel);
      let listing;
      try {
        listing = portal.files.list(base, rel, asAgent);
      } catch (e) {
        throw new Error(`${shown} could not be read as this chat's agent: ${(e as Error).message}`);
      }
      if (listing.truncated) throw over(`more than 2,000 entries in ${shown}`);
      await going();
      for (const entry of listing.entries) {
        const at = path.join(rel, entry.name);
        const inCopy = path.relative(top, at);
        if (entry.link || entry.type === "link") {
          left.push(inCopy);
          continue;
        }
        if (entry.type === "dir") {
          if (depth + 1 > LIMITS.depth) throw over(`more than ${LIMITS.depth} folders deep, at ${inCopy}`);
          mkdirSync(path.join(incoming, inCopy), { mode: 0o700 });
          await walk(at, depth + 1);
          continue;
        }
        if (files.length + 1 > LIMITS.files) throw over(`more than ${LIMITS.files.toLocaleString("en")} files`);
        let opened;
        try {
          opened = portal.files.open(base, at, asAgent);
        } catch (e) {
          throw new Error(`${inCopy} could not be read as this chat's agent: ${(e as Error).message}`);
        }
        let data: Buffer;
        try {
          if (bytes + opened.size > LIMITS.bytes) throw over(`more than ${LIMITS.bytes / 1024 / 1024} MB`);
          data = Buffer.alloc(opened.size);
          let read = 0;
          while (read < data.length) {
            const n = readSync(opened.fd, data, read, data.length - read, read);
            if (n === 0) break;
            read += n;
          }
          data = data.subarray(0, read);
        } finally {
          closeSync(opened.fd);
        }
        bytes += data.length;
        writeFileSync(path.join(incoming, inCopy), data, { mode: 0o600, flag: "wx" });
        files.push({ rel: inCopy.split(path.sep).join("/"), bytes: data });
        await going();
      }
    };
    await walk(top, 0);
    const { name, version } = check(incoming);
    const digest = digestOf(files);
    // In place with nothing awaited between: no `halves()` or `pi list` of the portal finds `made/<name>` missing. The
    // copy before it is kept aside until the install is done.
    const folder = path.join(made, name);
    const old = path.join(made, `.old-${name}-${randomBytes(4).toString("hex")}`);
    let replaced = true;
    try {
      renameSync(folder, old);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      replaced = false;
    }
    renameSync(incoming, folder);
    return { name, ...(version ? { version } : {}), folder, digest, files: files.length, bytes, left, ...(replaced ? { old } : {}) };
  } catch (e) {
    rmSync(incoming, { recursive: true, force: true });
    throw e;
  }
}

/** The copy is installed: the one it took the place of goes. */
export function installed(copy: Copy): void {
  if (copy.old) rmSync(copy.old, { recursive: true, force: true });
}

/**
 * The copy was not installed: the one it took the place of is put back where it was, with nothing awaited between,
 * so that pi lists what was installed, and recorded, last; a copy that took no place is removed.
 */
export function undo(copy: Copy): void {
  if (!copy.old) return rmSync(copy.folder, { recursive: true, force: true });
  const aside = path.join(path.dirname(copy.folder), `.incoming-${randomBytes(4).toString("hex")}`);
  renameSync(copy.folder, aside);
  renameSync(copy.old, copy.folder);
  rmSync(aside, { recursive: true, force: true });
}

/**
 * What an install that was cut off left in `made/`, put right as the server half starts, before it installs anything:
 * a copy the process ended between the two renames of its swap is put back where pi still lists it, and every other
 * copy put aside, and every copy being made, is removed. One being made by the start before is not removed under it:
 * that start was stopped before this one started, and gives up at its next yield.
 */
export function sweepLeftovers(run: Run): void {
  const made = madeDir(run);
  let entries: string[];
  try {
    entries = readdirSync(made);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  for (const entry of entries) {
    const old = /^\.old-(.+)-[0-9a-f]{8}$/.exec(entry);
    if (old && !lstatSync(path.join(made, old[1]), { throwIfNoEntry: false })) renameSync(path.join(made, entry), path.join(made, old[1]));
    else if (old || entry.startsWith(".incoming-")) rmSync(path.join(made, entry), { recursive: true, force: true });
  }
}
