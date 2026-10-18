import { randomBytes } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  watch as watchPath,
  write as writeAsync,
  writeSync,
} from "node:fs";
import { lstat, open as openHandle, readdir, rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { holdsWork, unsavedIn, unsavedRefusal, type Unsaved } from "./git.js";
import { pictureType } from "./prompt-images.js";
import { isWithinText, pathBelow } from "./within.js";

/**
 * Looking at, changing and taking away the files in a chat's folder, from the browser.
 *
 * The folder is one the agent already works in with full access, so this gives
 * the browser the same view and nothing more. What it must not do is let a
 * name that arrives in a URL reach past that folder, and the agent can leave
 * links in it that point anywhere. So a path is checked twice: as text, and
 * again where it really leads once every link along it is followed. And a file
 * is opened without following a link in its last place, which closes the gap
 * between the check and the open.
 *
 * The listing, reading and resolving here were first written for the workspace
 * file browser in PR 2, keyed by workspace name; this is the same, keyed by
 * folder, so that a chat in Home — outside the workspace root — has files too.
 */

/** Above this a file is offered as a download only: it is neither shown nor sent back whole. */
export const MAX_EDIT_BYTES = 1024 * 1024;
/** A folder with more than this is cut off, and says so. */
export const MAX_ENTRIES = 2_000;

export type FileErrorCode = "invalid" | "missing" | "conflict" | "exists" | "too_large" | "failed" | "unsaved";

export class FileError extends Error {
  /** With "failed": the system's own code for it (ENOSPC, EACCES, EROFS…), for a caller that says more than the sentence does. */
  readonly errno?: string;

  constructor(
    readonly code: FileErrorCode,
    message: string,
    /** With "unsaved": what the delete would lose. */
    readonly unsaved?: Unsaved,
    /** With "failed": the error the system gave. */
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    const errno = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (typeof errno === "string") this.errno = errno;
  }
}

export interface FileEntry {
  name: string;
  /** "link" is a link that could not be followed to something inside the folder. */
  type: "dir" | "file" | "link";
  /**
   * The entry is a link, whatever `type` says. A link that leads to a folder inside
   * this one is listed as a "dir", but taking it away removes the link, not the folder.
   */
  link?: boolean;
  size: number;
  mtime: number;
}

const lexists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * The real folder `dir` stands for, or an error if there is none.
 *
 * Canonical once, up front, so that every check after it compares real paths
 * with real paths.
 */
export function baseDir(dir: string): string {
  try {
    const real = realpathSync(dir);
    if (!statSync(real).isDirectory()) throw new Error("not a directory");
    return real;
  } catch {
    throw new FileError("missing", "This chat's folder does not exist");
  }
}

/** `p` with every link in the part of it that exists followed; the rest stays as written. */
function realThroughExisting(p: string): string {
  let current = p;
  const tail: string[] = [];
  // lstat, not exists: a link that points nowhere still exists, and stopping at
  // it is what lets realpath below refuse it. Walking past it would treat its
  // name as a plain missing folder, and a write would then follow the link.
  while (!lexists(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new FileError("missing", "There is no such place");
    tail.unshift(path.basename(current));
    current = parent;
  }
  let real: string;
  try {
    real = realpathSync(current);
  } catch {
    throw new FileError("invalid", "That path leads outside the folder");
  }
  return tail.length ? path.join(real, ...tail) : real;
}

/**
 * The absolute path for `rel` inside `base` (which is already canonical).
 *
 * Refuses `..`, an absolute path and anything that a link leads out of the
 * folder by. What is returned is the checked, canonical path — use it, not the
 * text that came in.
 */
export function resolveInside(base: string, rel: unknown): string {
  const text = String(rel ?? "");
  if (text.includes("\0")) throw new FileError("invalid", "That is not a valid path");
  const resolved = path.resolve(base, text.replace(/^[/\\]+/, ""));
  if (!isWithinText(base, resolved)) throw new FileError("invalid", "That path leads outside the folder");
  const real = realThroughExisting(resolved);
  if (!isWithinText(base, real)) throw new FileError("invalid", "That path leads outside the folder");
  return real;
}

/** What is directly in a folder: folders first, then files, each by name. */
export function listDir(base: string, rel: unknown): { path: string; entries: FileEntry[]; truncated: boolean } {
  const target = resolveInside(base, rel);
  // Held for the whole listing: what is listed is this folder, whatever the path leads to by the time each entry is looked at.
  let held: Held;
  try {
    held = holdFolder(base, target);
  } catch (e) {
    if (e instanceof FileError && e.code === "missing") throw new FileError("missing", "There is no such folder");
    throw e;
  }
  try {
    return listHeld(base, target, held);
  } finally {
    held.close();
  }
}

function listHeld(base: string, target: string, held: Held): { path: string; entries: FileEntry[]; truncated: boolean } {
  let names;
  try {
    names = readdirSync(held.here, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOTDIR") throw new FileError("invalid", "That is not a folder");
    throw new FileError("missing", "There is no such folder");
  }
  // The cap bounds the work, not only the answer: every entry that is looked at
  // is a syscall (two more for a link), on the thread that also serves every
  // other request. So a big folder is cut down first, on what the listing
  // already says — folders before files, then by name — and only what is kept is
  // looked at. That is also the order the answer is in, so nothing is lost by it.
  let candidates = names.filter((d) => d.name !== ".git");
  const total = candidates.length;
  if (total > MAX_ENTRIES) {
    const kind = (d: (typeof candidates)[number]) => (d.isDirectory() ? 0 : 1);
    candidates = candidates
      .sort((a, b) => kind(a) - kind(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(0, MAX_ENTRIES);
  }
  const entries: FileEntry[] = [];
  for (const dirent of candidates) {
    const full = held.at(dirent.name);
    try {
      let st = lstatSync(full);
      let type: FileEntry["type"] = st.isDirectory() ? "dir" : "file";
      const link = st.isSymbolicLink();
      if (link) {
        // Shown as what it leads to, but only if that is inside the folder.
        // A link that leads out, or nowhere, is listed and left alone.
        type = "link";
        const real = realpathSync(full);
        // Looked at by the path that was checked, and the path checked again after: a folder on the way swapped for a link to somewhere
        // outside in between would otherwise tell the size and time of something that is not in the folder.
        if (isWithinText(base, real)) {
          const followed = statSync(real);
          if (realpathSync(real) === real) {
            st = followed;
            type = st.isDirectory() ? "dir" : "file";
          }
        }
      }
      entries.push({ name: dirent.name, type, ...(link ? { link } : {}), size: st.size, mtime: st.mtimeMs });
    } catch {
      // Gone since it was listed, or a link to nowhere.
      entries.push({ name: dirent.name, type: "link", link: true, size: 0, mtime: 0 });
    }
  }
  entries.sort((a, b) => {
    const rank = (t: FileEntry["type"]) => (t === "dir" ? 0 : 1);
    return rank(a.type) - rank(b.type) || a.name.localeCompare(b.name);
  });
  return { path: path.relative(base, target), entries, truncated: total > MAX_ENTRIES };
}

/** What is said when a save would put older text over newer, or over a file that is gone. */
export const CHANGED = "The file changed after you opened it";

/**
 * Opens a plain file without following a link in its last place, or waiting on one.
 * A pipe left there would otherwise hold the server; a device is not a file.
 */
function openPlain(file: string, flags: number): number {
  let fd: number;
  try {
    fd = openSync(file, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new FileError("missing", "There is no such file");
    // Only where a file is being made and something is there by now.
    if (code === "EEXIST") throw new FileError("conflict", CHANGED);
    if (code === "ELOOP" || code === "ENXIO" || code === "EISDIR") {
      throw new FileError("invalid", "That is a link, a folder or not a plain file");
    }
    throw e;
  }
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    throw new FileError("invalid", "That is not a plain file");
  }
  return fd;
}

/** Whether a descriptor can be named as a path (`/proc/self/fd/<n>`), which is what stands in for `openat` here: Linux. */
const HAS_FD_PATHS = existsSync("/proc/self/fd");
const namesDescriptors = () => process.platform === "linux" && HAS_FD_PATHS;

const OPEN_FOLDER = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** A folder opened without following a link in its last place. */
function openFolder(where: string): number {
  try {
    return openSync(where, OPEN_FOLDER);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new FileError("missing", "There is no such file or folder");
    // A link is ENOTDIR here too: O_DIRECTORY is looked at before O_NOFOLLOW.
    if (code === "ELOOP" || code === "ENOTDIR") {
      if (lstatSync(where, { throwIfNoEntry: false })?.isSymbolicLink()) throw new FileError("invalid", "That path leads outside the folder");
      throw new FileError("invalid", "That is not a folder");
    }
    throw ioFailure(e, "The folder could not be opened", "Nothing was changed.");
  }
}

/**
 * A folder inside the chat's folder, held open: what is made, read or removed in
 * it is named through `at`, so that it happens in this folder.
 */
interface Held {
  readonly fd: number;
  /** The folder itself, as a path for the calls that take one. */
  readonly here: string;
  /**
   * Whether `at` goes through the descriptor, so that no change of a folder on the way to it can send
   * a call elsewhere: Linux. Where it is not, the names are the checked path's, as they were before.
   */
  readonly pinned: boolean;
  /** `name` in the folder: one name, no place. */
  at(name: string): string;
  close(): void;
}

/**
 * Holds the folder `dir`, a checked path (`resolveInside`'s) inside `base`.
 *
 * A check of a path and a call on it are two steps, and between them the agent
 * can put a link where a folder on the way was: the call then goes where the link
 * leads, and the portal, which may be root, makes a file or a folder there. So the
 * folder is walked down from `base` one part at a time, each opened relative to
 * the one before it (`/proc/self/fd/<n>/<part>`) and never through a link, and
 * what is done in the folder is done through the descriptor of the last one.
 * What this guarantees on Linux: the descriptor is a folder inside `base`,
 * whatever is done to the path from now on. A checked path has no link on it, so a
 * link found on the way is one put there after the check, and is refused. The
 * walk starts at `base` itself, whose real path is checked on the descriptor, so a
 * folder above it that was swapped is found as well.
 *
 * Where descriptors cannot be named (macOS has no /proc) the folder is opened
 * by its path and calls go by the path, which leaves the gap this closes; there the portal
 * does not give anything it makes away (see handOver), so the worst that is left is a
 * file the portal owns in the wrong place, as it was before.
 */
function holdFolder(base: string, dir: string): Held {
  const below = pathBelow(base, dir);
  if (below === undefined) throw new FileError("invalid", "That path leads outside the folder");
  if (!namesDescriptors()) {
    const fd = openFolder(dir);
    let open = true;
    return {
      fd,
      here: dir,
      pinned: false,
      at: (name) => path.join(dir, name),
      close: () => {
        if (open) closeSync(fd);
        open = false;
      },
    };
  }
  const named = (descriptor: number) => `/proc/self/fd/${descriptor}`;
  let fd = openFolder(base);
  try {
    // The part of the path above `base` is not walked, so it is checked on what was opened: a folder up there swapped for a
    // link since `base` was made canonical leads this open somewhere else, and the descriptor says where.
    if (realpathSync.native(named(fd)) !== path.resolve(base)) throw new FileError("invalid", "That path leads outside the folder");
    for (const part of below.split(path.sep).filter(Boolean)) {
      const next = openFolder(`${named(fd)}/${part}`);
      closeSync(fd);
      fd = next;
    }
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  const held = fd;
  let open = true;
  return {
    fd: held,
    here: named(held),
    pinned: true,
    at: (name) => `${named(held)}/${name}`,
    close: () => {
      if (open) closeSync(held);
      open = false;
    },
  };
}

/**
 * A plain file opened in the folder it is in, held and not followed (see holdFolder). `file` is a checked path.
 * What is returned is the file's descriptor, which is what every later step goes through.
 */
function openIn(base: string, file: string, flags: number): number {
  if (file === base) throw new FileError("invalid", "That is not a plain file");
  let held: Held;
  try {
    held = holdFolder(base, path.dirname(file));
  } catch (e) {
    if (e instanceof FileError && e.code === "missing") throw new FileError("missing", "There is no such file");
    throw e;
  }
  try {
    return openPlain(held.at(path.basename(file)), flags);
  } finally {
    held.close();
  }
}

/** Null bytes early in a file are the cheap, reliable sign that it is not text. */
const looksBinary = (head: Buffer) => head.includes(0);

export type FileContent = { binary: true; size: number; mtime: number } | { binary: false; size: number; mtime: number; content: string };

/** A file's text, or the fact that it is not text or too large to show. */
export function readText(base: string, rel: unknown): FileContent {
  const fd = openIn(base, resolveInside(base, rel), constants.O_RDONLY);
  try {
    const st = fstatSync(fd);
    if (st.size > MAX_EDIT_BYTES) return { binary: true, size: st.size, mtime: st.mtimeMs };
    const buffer = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = readSync(fd, buffer, read, st.size - read, read);
      if (n === 0) break;
      read += n;
    }
    const data = buffer.subarray(0, read);
    if (looksBinary(data.subarray(0, 8000))) return { binary: true, size: st.size, mtime: st.mtimeMs };
    return { binary: false, size: st.size, mtime: st.mtimeMs, content: data.toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

/** What opens a file for reading, beyond the checks every path gets. */
export interface OpenOptions {
  /**
   * `rel` is a name in `base` itself, reached through no link: refused (`invalid`) when `resolveInside` led it
   * elsewhere, even to another file inside the folder. For a file that is only to be what its name says.
   */
  direct?: boolean;
  /** A file with a second name (a hard link, which may be outside the folder) is refused (`invalid`). */
  alone?: boolean;
}

/**
 * What tells that a file's content changed without reading it: its identity
 * (inode), size and times. A write in place changes the times, a file put in
 * place by a rename its inode.
 */
const changeOf = (st: BigIntStats) => `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
/** The modification time in ms, with its fraction, worked out as Node does for `Stats.mtimeMs`, so that the two agree to the last digit. */
const mtimeOf = (st: BigIntStats) => Number(st.mtimeNs / 1_000_000_000n) * 1000 + Number(st.mtimeNs % 1_000_000_000n) / 1e6;

/** The checked path of `rel`, and with `direct` only if it is that name in `base` and nothing a link led to. */
function placeOf(base: string, rel: unknown, direct: boolean | undefined): string {
  const file = resolveInside(base, rel);
  if (direct && (path.dirname(file) !== base || path.basename(file) !== String(rel))) {
    throw new FileError("invalid", "That is not a file directly in the folder");
  }
  return file;
}

/**
 * A plain file opened for reading or sending: the descriptor, its size, its
 * name, and when it was changed last (`mtime`, and `change`, which differs
 * whenever the file was written, or put in place by a rename).
 *
 * What is read or sent comes from the descriptor that was opened here, without
 * following a link, so nothing can be swapped in between the check and the
 * send. Handing the path on to be opened again is what that would allow, and it
 * would also treat a name that starts with a dot as one to refuse. The caller
 * owns the descriptor.
 */
export function openFile(
  base: string,
  rel: unknown,
  options: OpenOptions = {},
): { fd: number; size: number; name: string; mtime: number; change: string } {
  const file = placeOf(base, rel, options.direct);
  const fd = openIn(base, file, constants.O_RDONLY);
  try {
    const st = fstatSync(fd, { bigint: true });
    if (options.alone && st.nlink !== 1n) throw new FileError("invalid", "That file has another name elsewhere (a hard link)");
    return { fd, size: Number(st.size), name: path.basename(file), mtime: mtimeOf(st), change: changeOf(st) };
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

/** A plain file opened for sending as a download: the descriptor, its size and its name. The caller owns the descriptor. */
export function openDownload(base: string, rel: unknown): { fd: number; size: number; name: string } {
  const { fd, size, name } = openFile(base, rel);
  return { fd, size, name };
}

/**
 * A file's bytes, as they are: no text is made of them, and a file with null
 * bytes is not set aside as binary. At most 1 MB (`too_large`), as `readText`
 * has it. With `head`, only that many bytes from the start are read (none, for
 * a caller that wants only `change`), and `size` is still the whole file's.
 */
export function readBytes(
  base: string,
  rel: unknown,
  options: OpenOptions & { head?: number } = {},
): { bytes: Buffer; size: number; mtime: number; change: string } {
  const { fd, size, mtime, change } = openFile(base, rel, options);
  try {
    if (size > MAX_EDIT_BYTES) throw new FileError("too_large", `Files over ${MAX_EDIT_BYTES / 1024 / 1024} MB are not read here`);
    const want = Math.min(size, Math.max(0, Math.floor(options.head ?? size)));
    const buffer = Buffer.alloc(want);
    let read = 0;
    while (read < want) {
      const n = readSync(fd, buffer, read, want - read, read);
      // Shorter than it was when it was measured.
      if (n === 0) break;
      read += n;
    }
    return { bytes: buffer.subarray(0, read), size, mtime, change };
  } finally {
    closeSync(fd);
  }
}

/** The rename of a save is only lasting once the folder that holds it is synced. */
function syncFolder(held: Held): void {
  try {
    fsyncSync(held.fd);
  } catch {
    // Some file systems cannot sync a folder; the rename stands all the same.
  }
}

/** Larger than this, a picture is not shown: it is a download like any other file. */
export const MAX_PICTURE_BYTES = 25 * 1024 * 1024;

/**
 * A picture in the folder, opened to be shown in the page, not saved.
 *
 * Its type comes from its first bytes, as a picture sent with a message does
 * (see prompt-images.ts), not from its name: whatever is served back to be
 * drawn inline must really be one of the four kinds a browser draws and
 * nothing else, so that no page and no script is ever served under this
 * portal's origin from a file the agent wrote.
 */
export function openPicture(base: string, rel: unknown): { fd: number; size: number; name: string; mimeType: string } {
  const opened = openDownload(base, rel);
  try {
    if (opened.size > MAX_PICTURE_BYTES) throw new FileError("too_large", "The picture is over 25 MB; download it instead");
    const head = Buffer.alloc(12);
    readSync(opened.fd, head, 0, head.length, 0);
    const mimeType = pictureType(head);
    if (!mimeType) throw new FileError("invalid", "That is not a PNG, JPEG, GIF or WebP picture");
    return { ...opened, mimeType };
  } catch (e) {
    closeSync(opened.fd);
    throw e;
  }
}

/**
 * A picture in the folder, read whole, for one that is sent on as it is, to an
 * image endpoint to be changed. Opened as a picture shown is: checked by its
 * bytes and its size, and never through a link out of the folder.
 */
export function readPicture(base: string, rel: unknown): { bytes: Buffer; mimeType: string; name: string } {
  return readOpened(openPicture(base, rel));
}

/** A file opened by openPicture or openVideo, read whole and closed. */
export function readOpened(opened: { fd: number; size: number; name: string; mimeType: string }): { bytes: Buffer; mimeType: string; name: string } {
  try {
    const bytes = Buffer.alloc(opened.size);
    let read = 0;
    while (read < bytes.length) {
      const n = readSync(opened.fd, bytes, read, bytes.length - read, read);
      // Shorter than it was when it was measured.
      if (n === 0) break;
      read += n;
    }
    return { bytes: bytes.subarray(0, read), mimeType: opened.mimeType, name: opened.name };
  } finally {
    closeSync(opened.fd);
  }
}

/**
 * What a failed change is called to the person, by what the system said.
 * Anything not known here is left as it is, and becomes a plain 500 with a log line.
 */
function ioFailure(e: unknown, what: string, after: string): unknown {
  const code = (e as NodeJS.ErrnoException)?.code;
  // Gone since it was looked at, or the folder it was to go in is not there.
  if (code === "ENOENT") return new FileError("missing", "There is no such file or folder");
  if (code === "ENOTDIR") return new FileError("invalid", "That is not a folder");
  if (code && ["ENOSPC", "EDQUOT", "EIO", "EROFS", "EACCES", "EPERM", "EFBIG", "ENOTEMPTY", "EBUSY", "EMFILE", "ENFILE"].includes(code)) {
    return new FileError("failed", `${what} (${code}). ${after}`, undefined, e);
  }
  return e;
}

/** A save that did not happen: the file is as it was. */
const writeFailure = (e: unknown) => ioFailure(e, "The file could not be saved", "It was left as it was.");

/** What a save can be told beyond the text and the time the person saw. */
export interface WriteOptions {
  /** `rel` is a name in `base` itself, reached through no link (see OpenOptions.direct). */
  direct?: boolean;
}

/** Who a file or folder belongs to. */
interface Owner {
  uid: number;
  gid: number;
}

/**
 * What a file that is made in the held folder is given: the mode of the folder
 * (a file: 0644, and writable for the folder's group where the folder is) and
 * its owner and group, read from the folder's descriptor. With the sandbox on
 * the portal writes as root in a folder the agent's user works in, and what the
 * portal makes has to be something the agent goes on editing; where the portal
 * is not allowed to give a file away it stays the portal's, as it always was.
 */
function madeIn(held: Held): { mode: number; owner: Owner } {
  const folder = fstatSync(held.fd);
  return { mode: 0o644 | (folder.mode & 0o020), owner: { uid: folder.uid, gid: folder.gid } };
}

/**
 * Gives the file or folder behind `fd`, which was just made in the held folder,
 * to `owner`, and then its mode.
 *
 * Only through the held folder on Linux (`pinned`): it is known to be inside the
 * chat's folder, so that what is given away is the agent's own place. Where it is
 * not known, nothing is given: a swapped folder would otherwise have the portal, as
 * root, make a file for the agent anywhere.
 *
 * Group-write is the folder's group's. A file that stays in another group (the
 * portal may not give it away, as it is not root, and is not in the folder's
 * group) does not get it: the portal's own group is not the one the folder
 * lets write.
 */
function handOver(fd: number, owner: Owner, mode: number, held: Held): void {
  if (held.pinned) {
    try {
      fchownSync(fd, owner.uid, owner.gid);
    } catch {
      // Not allowed to give it away. The group may still be the folder's, if the portal belongs to it.
      try {
        fchownSync(fd, -1, owner.gid);
      } catch {
        // It stays in the portal's group.
      }
    }
  }
  // After the owner: giving a file away takes setuid and setgid off it, and they are not carried over in any case.
  if (fstatSync(fd).gid !== owner.gid) mode &= ~0o2020;
  fchmodSync(fd, mode);
}

/**
 * Saves a file's text, or its bytes.
 *
 * `expected` is the modification time the editor was showing. If the file has
 * changed since — the agent writes here too — the save is refused instead of
 * putting the older text over the newer, and the person chooses what to keep.
 *
 * The text is written to a file beside it and put in place by a rename, not
 * written into the file itself. Cutting a file off and then failing to fill it
 * (a full disk, an I/O error) leaves an empty file where the work was, and a
 * file whose time has moved, so the next save is refused as a conflict. Done this
 * way a failed save leaves the file exactly as it was. The rename also replaces
 * whatever is at the name and does not follow it, so a link put there after the
 * check is replaced, not written through. The folder is synced after it, so the
 * rename lasts through a crash.
 *
 * The answer is the written file's own (read from the descriptor it was
 * written through), with its `change`: see openFile.
 */
export function writeText(
  base: string,
  rel: unknown,
  content: string | Uint8Array,
  expected?: number,
  /** Only make it: a file already there is not replaced. What "New file" means. */
  createOnly = false,
  options: WriteOptions = {},
): { size: number; mtime: number; change: string } {
  const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  if (data.length > MAX_EDIT_BYTES) {
    throw new FileError("too_large", `Files over ${MAX_EDIT_BYTES / 1024 / 1024} MB are not edited here`);
  }
  const target = placeOf(base, rel, options.direct);
  if (target === base) throw new FileError("invalid", "That is the folder, not a file");
  const name = path.basename(target);
  // The folder is held for all of it: the file is looked at, written and put in place in this folder and no other,
  // whatever happens to the path meanwhile (see holdFolder).
  let held: Held;
  try {
    held = holdFolder(base, path.dirname(target));
  } catch (e) {
    // A folder that is gone is a file that is gone: what the person was shown is out of date.
    if (e instanceof FileError && e.code === "missing" && expected !== undefined) throw new FileError("conflict", CHANGED);
    throw e;
  }
  try {
    // Looked at before anything is written, and without O_CREAT: a file that is
    // there is checked as it is, so an emptied one is compared like any other. One
    // that is not there was either never made (no `expected`, so make it) or has
    // been taken away since it was opened, and putting it back with old text is
    // not what a save means.
    let mode = 0o644;
    let owner: Owner;
    let existed = true;
    try {
      // Only to look at: what is written goes to a file beside it, so the file itself
      // need not be writable (a read-only one is replaced, and keeps its mode).
      const fd = openPlain(held.at(name), constants.O_RDONLY);
      try {
        const st = fstatSync(fd);
        if (createOnly) throw new FileError("exists", `There is already something called "${name}" here`);
        if (st.nlink > 1) throw new FileError("invalid", "That file is shared with another, so it is left alone");
        if (expected !== undefined && Math.abs(st.mtimeMs - expected) > 1) throw new FileError("conflict", CHANGED);
        // Not setuid or setgid: a file the portal writes does not carry them over (see handOver).
        mode = st.mode & 0o1777;
        owner = { uid: st.uid, gid: st.gid };
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      if (!(e instanceof FileError) || e.code !== "missing") throw writeFailure(e);
      if (expected !== undefined) throw new FileError("conflict", CHANGED);
      existed = false;
      try {
        ({ mode, owner } = madeIn(held));
      } catch (e) {
        throw writeFailure(e);
      }
    }

    const tempName = `.${tempStem(name)}.${randomBytes(6).toString("hex")}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(held.at(tempName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
      // What the file had: the mode is cut by the umask on creation, and the owner is not ours if the portal runs as another user.
      handOver(fd, owner, mode, held);
      let written = 0;
      while (written < data.length) written += writeSync(fd, data, written, data.length - written, written);
      fsyncSync(fd);
      if (existed) {
        renameSync(held.at(tempName), held.at(name));
      } else {
        // A file that is made is not put over one that has appeared since: a link
        // fails where a rename would replace. Where links are not possible, rename.
        try {
          linkSync(held.at(tempName), held.at(name));
          unlinkSync(held.at(tempName));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new FileError("conflict", CHANGED);
          renameSync(held.at(tempName), held.at(name));
        }
      }
      // After the rename or link, which both change the file's times.
      const after = fstatSync(fd, { bigint: true });
      closeSync(fd);
      fd = undefined;
      syncFolder(held);
      return { size: Number(after.size), mtime: mtimeOf(after), change: changeOf(after) };
    } catch (e) {
      if (fd !== undefined) closeSync(fd);
      rmSync(held.at(tempName), { force: true });
      throw writeFailure(e);
    }
  } finally {
    held.close();
  }
}

/**
 * The place `rel` names, for taking it away or giving it another name: its
 * folder followed and checked, its last name not, so that a link there is what
 * is changed, not what it leads to. The folder itself is not something in it.
 * One check for both, because what one lets through the other must not.
 */
function entryPlace(base: string, rel: unknown, verb: "removed" | "renamed"): string {
  const text = String(rel ?? "");
  if (text.includes("\0")) throw new FileError("invalid", "That is not a valid path");
  const lexical = path.resolve(base, text.replace(/^[/\\]+/, ""));
  const under = pathBelow(base, lexical);
  if (under === undefined) throw new FileError("invalid", "That path leads outside the folder");
  if (under === "") throw new FileError("invalid", `The folder itself is not ${verb} from here`);
  const parent = resolveInside(base, path.relative(base, path.dirname(lexical)));
  const target = path.join(parent, path.basename(lexical));
  if (!lexists(target)) throw new FileError("missing", "There is no such file or folder");
  return target;
}

/**
 * What deleting `rel` would lose that nothing else has — see unsavedIn — or
 * null when nothing git holds goes with it. Asked before the question, so that
 * it can say so.
 */
export async function unsavedAt(base: string, rel: unknown): Promise<Unsaved | null> {
  return unsavedIn(base, entryPlace(base, rel, "removed"));
}

/** How deep a folder may be that is taken away: each level is a descriptor held open until it is empty. */
const MAX_REMOVE_DEPTH = 512;
/** Files taken away at once in a folder; the folders in it one at a time, so that the descriptors held are no more than its depth. */
const UNLINKS_AT_ONCE = 32;

/**
 * `name` in the folder `parent` taken away: a file, link or pipe by its own name (never what a link leads to), a folder
 * after what is in it. `parent` is the path of a held folder (`/proc/self/fd/<n>`), so that nothing done to a path
 * leads this elsewhere; each folder below it is opened without following a link and emptied through its own
 * descriptor, which is why this is not `rm`: its walk finds a folder by its path and may follow one that was swapped
 * for a link in the time between, and the portal, which may be root, would empty whatever that leads to.
 */
async function removeBelow(parent: string, name: string, depth = 0): Promise<void> {
  const place = `${parent}/${name}`;
  let stat;
  try {
    stat = await lstat(place);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (!stat.isDirectory()) return void (await unlinkQuietly(place));
  if (depth >= MAX_REMOVE_DEPTH) throw new FileError("failed", "It is nested too deeply to be deleted here. Nothing more was changed.");
  const folder = await openHandle(place, OPEN_FOLDER);
  try {
    const here = `/proc/self/fd/${folder.fd}`;
    // What the agent writes meanwhile may keep a folder from being empty: it is emptied again, a few times.
    for (let round = 0; ; round++) {
      const entries = await readdir(here, { withFileTypes: true });
      const files = entries.filter((entry) => !entry.isDirectory());
      for (let i = 0; i < files.length; i += UNLINKS_AT_ONCE) {
        await Promise.all(files.slice(i, i + UNLINKS_AT_ONCE).map((entry) => unlinkQuietly(`${here}/${entry.name}`)));
      }
      for (const entry of entries) if (entry.isDirectory()) await removeBelow(here, entry.name, depth + 1);
      try {
        await rmdir(place);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return;
        if (code !== "ENOTEMPTY" || round >= 4) throw e;
      }
    }
  } finally {
    await folder.close();
  }
}

/** A file, link or pipe taken away by its name; one that is gone is what was asked for. */
async function unlinkQuietly(place: string): Promise<void> {
  try {
    await unlink(place);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/**
 * Removes a file, or a folder and all that is in it. A link is removed as the
 * link it is, and what it points at stays. The folder itself is not removable
 * from here: that is the chat's place, not something in it.
 *
 * The folder the entry is in is held (see holdFolder) and everything below it
 * is walked through descriptors, never by a path that could be sent elsewhere
 * (see removeBelow). Where descriptors cannot be named (no /proc) it is `rm`
 * by the checked path, as it was.
 *
 * A folder that holds git work nothing else has — a clone with commits no
 * remote has, changes not committed, stashes — or a repository's .git is
 * refused, with what it holds, unless `discard` says that is meant.
 */
export async function removeEntry(base: string, rel: unknown, discard = false): Promise<void> {
  const target = entryPlace(base, rel, "removed");
  if (!discard) {
    const unsaved = await unsavedIn(base, target);
    if (unsaved && holdsWork(unsaved)) throw new FileError("unsaved", unsavedRefusal(unsaved).error, unsaved);
  }
  const held = holdFolder(base, path.dirname(target));
  try {
    // Not rmSync: a folder with many files is seconds on the thread that serves every chat.
    // A file that has gone since it was looked for is what was asked for.
    if (held.pinned) await removeBelow(held.here, path.basename(target));
    else await rm(held.at(path.basename(target)), { recursive: true, force: true });
  } catch (e) {
    if (e instanceof FileError) throw e;
    const code = (e as NodeJS.ErrnoException)?.code;
    // A folder in the tree was swapped for a link, or for a file, while it was walked: nothing was followed, and the rest is left.
    if (code === "ELOOP" || code === "ENOTDIR" || code === "EISDIR") {
      throw new FileError("failed", "It could not be deleted (something in it was replaced while it was being deleted). Nothing more was changed.", undefined, e);
    }
    throw ioFailure(e, "It could not be deleted", "Nothing more was changed.");
  } finally {
    held.close();
  }
}

/** A name for one entry: no place in it, and not one of the two that mean a place. */
function checkName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) throw new FileError("invalid", "A name is required");
  const clean = name.trim();
  if (clean === "." || clean === ".." || /[/\\\0]/.test(clean)) throw new FileError("invalid", "A name cannot contain / or \\, or be . or ..");
  if (Buffer.byteLength(clean, "utf8") > 255) throw new FileError("invalid", "That name is too long");
  return clean;
}

/**
 * Gives a file or a folder another name, in the folder it is in. It is a new
 * name, not a new place, and it never replaces something that is already there.
 * A link is renamed as the link it is. Returns the new path, from the folder.
 *
 * Both names are in the folder as it is held (see holdFolder): as root, a rename
 * by path in a folder that was swapped for a link would move a file there.
 */
export function renameEntry(base: string, rel: unknown, newName: unknown): string {
  const name = checkName(newName);
  const from = entryPlace(base, rel, "renamed");
  const parent = path.dirname(from);
  const to = path.join(parent, name);
  if (to === from) return path.relative(base, to);
  const held = holdFolder(base, parent);
  try {
    if (lexists(held.at(name))) throw new FileError("exists", `There is already something called "${name}" here`);
    try {
      renameSync(held.at(path.basename(from)), held.at(name));
    } catch (e) {
      throw ioFailure(e, "It could not be renamed", "It keeps its name.");
    }
  } finally {
    held.close();
  }
  return path.relative(base, to);
}

/**
 * The checked path of a folder, for what reads the whole of it. With `direct`, a folder that is a name in `base` itself (see
 * OpenOptions.direct). It is a folder inside `base` when this answers, and a path is only a path: what must read exactly this folder,
 * whatever is done to its place after, holds it.
 *
 * The folder it is in is held and the folder looked at in it, so that a link put on the way since the check is refused, not
 * followed. The folder itself is looked at, not opened: whether it may be read is for whoever reads it to find out.
 */
export function folderPath(base: string, rel: unknown, options: { direct?: boolean } = {}): string {
  const dir = placeOf(base, rel, options.direct);
  let st;
  if (dir === base) {
    st = lstatSync(dir, { throwIfNoEntry: false });
  } else {
    const held = holdFolder(base, path.dirname(dir));
    try {
      st = lstatSync(held.at(path.basename(dir)), { throwIfNoEntry: false });
    } finally {
      held.close();
    }
  }
  if (!st) throw new FileError("missing", "There is no such folder");
  if (!st.isDirectory()) throw new FileError("invalid", "That is not a folder");
  return dir;
}

/** A folder held open for what must read exactly it, whatever is done to its path after: see holdForReading. */
export interface HeldFolder {
  /** Where this process names it: through the open descriptor where the system has them, else the checked path. */
  path: string;
  /** The open descriptor (Linux), to be given to a child process in its `stdio`; none where the system cannot name descriptors. */
  fd?: number;
  /** The folder's own name, for a file made of it; empty for the chat's folder. */
  name: string;
  /** Where a child process that was given `fd` as its stdio number `n` names it. */
  inChild(n: number): string;
  close(): void;
}

/**
 * The folder `rel` held open, for what reads the whole of it, such as an archive: a path is only a path, and the
 * child process that is started with the checked one reads whatever a link put there since leads to, as root in a
 * folder the agent writes in. Held, it is the folder that was checked (see holdFolder). The caller closes it.
 */
export function holdForReading(base: string, rel: unknown, options: { direct?: boolean } = {}): HeldFolder {
  const dir = folderPath(base, rel, options);
  const held = holdFolder(base, dir);
  return {
    path: held.here,
    ...(held.pinned ? { fd: held.fd } : {}),
    name: dir === base ? "" : path.basename(dir),
    inChild: (n) => (held.pinned ? `/proc/self/fd/${n}` : dir),
    close: () => held.close(),
  };
}

/**
 * Makes a folder inside `dir`. Like a new file, it never takes the place of
 * something already there. It has the mode, owner and group of the folder it
 * is made in, so that the agent can write in it as it can there (see madeIn).
 * It is made in the folder as it is held (see holdFolder), not in the place
 * its path leads to by the time of the call. Returns its path, from the chat's folder.
 */
export function makeFolder(base: string, dirRel: unknown, name: unknown): string {
  const clean = checkName(name);
  const parent = folderPath(base, dirRel);
  const held = holdFolder(base, parent);
  const taken = () => new FileError("exists", `There is already something called "${clean}" here`);
  try {
    const target = held.at(clean);
    if (lexists(target)) throw taken();
    try {
      // The mode and owner are the held folder's own, from its descriptor.
      const folder = fstatSync(held.fd);
      const mode = folder.mode & 0o7777;
      mkdirSync(target, { mode });
      // Given its mode and owner through the folder that is opened, never by its path: a link put where it was, by an agent
      // that writes in the folder, would have what it leads to changed, and the portal may be root.
      let fd: number | undefined;
      try {
        fd = openSync(target, OPEN_FOLDER);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ELOOP" || (e as NodeJS.ErrnoException).code === "ENOTDIR") throw taken();
        throw e;
      }
      try {
        handOver(fd, { uid: folder.uid, gid: folder.gid }, mode, held);
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      if (e instanceof FileError) throw e;
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw taken();
      throw ioFailure(e, "The folder could not be made", "Nothing was changed.");
    }
  } finally {
    held.close();
  }
  return path.relative(base, path.join(parent, clean));
}

/** The start of a name that fits in `max` bytes, cut between letters, not inside one. */
export function fitBytes(name: string, max: number): string {
  let start = "";
  for (const ch of name) {
    if (Buffer.byteLength(start + ch) > max) break;
    start += ch;
  }
  return start;
}

/**
 * The start of a name, for a temporary file beside it: at most 100 bytes, so
 * the dot and suffix around it stay inside the 255 bytes a name may have.
 */
function tempStem(name: string): string {
  return fitBytes(name, 100);
}

/** The temporary file a save writes beside its file until it is put in place: `.<name>.<12 hex>.tmp`. */
const SAVE_TEMP = /^\..+\.[0-9a-f]{12}\.tmp$/;
/** How old a temporary file of a save must be to be taken for one that was cut off. Far more than a save takes. */
export const TEMP_GRACE_MS = 60_000;

/**
 * Removes the temporary files that saves in the folder `rel` left behind when
 * they were cut off (the portal stopped, the disk was full), and returns their
 * names. A save in the folder that is under way writes such a file too, in the
 * time between making it and putting it in place; so only one older than
 * `olderThanMs` (a minute) is taken for a leftover, and nothing of a save by
 * Files or another half is removed under it. A link of that name is removed as
 * the link it is.
 */
export function sweepTemp(base: string, rel: unknown, olderThanMs = TEMP_GRACE_MS): string[] {
  const dir = resolveInside(base, rel);
  let held: Held;
  try {
    held = holdFolder(base, dir);
  } catch (e) {
    // Not there, not a folder, or no longer what the check saw: nothing is swept.
    if (e instanceof FileError) return [];
    throw e;
  }
  try {
    let names: string[];
    try {
      names = readdirSync(held.here);
    } catch {
      return [];
    }
    const removed: string[] = [];
    const now = Date.now();
    for (const name of names) {
      if (!SAVE_TEMP.test(name)) continue;
      const file = held.at(name);
      try {
        const st = lstatSync(file);
        if (!st.isFile() && !st.isSymbolicLink()) continue;
        if (now - st.mtimeMs < olderThanMs) continue;
        unlinkSync(file);
        removed.push(name);
      } catch {
        // Gone since it was listed, or not ours to remove: left.
      }
    }
    return removed;
  } finally {
    held.close();
  }
}

/**
 * "report.pdf", then "report (2).pdf", "report (3).pdf"… A name near the
 * 255-byte limit loses the end of its stem to make room for the number.
 */
export function numbered(name: string, n: number): string {
  if (n < 2) return name;
  const dot = name.lastIndexOf(".");
  const tail = dot > 0 ? ` (${n})${name.slice(dot)}` : ` (${n})`;
  const room = 255 - Buffer.byteLength(tail);
  // An extension too long to leave room for any of the stem is kept as part of it.
  if (dot > 0 && room >= 4) return fitBytes(name.slice(0, dot), room) + tail;
  if (dot > 0) return fitBytes(name, 255 - Buffer.byteLength(` (${n})`)) + ` (${n})`;
  return fitBytes(name, room) + tail;
}

/**
 * Where an uploaded file goes: a temporary file beside its place, and the call
 * that puts it there once all of it has arrived.
 *
 * An upload never replaces anything. A name that is taken becomes
 * "name (2).ext", as a download folder does, because the person dropping a
 * file wants it in, not a question. The name is settled only when the file is
 * complete, and put in place by a link, which fails rather than replaces if
 * something took the name in the meantime; then the next number is tried. The
 * folder is synced after it, so the file lasts through a crash.
 */
export function uploadTarget(
  base: string,
  dirRel: unknown,
  name: unknown,
): { fd: number; finish: () => string; abandon: () => void } {
  const clean = checkName(name);
  const parent = folderPath(base, dirRel);
  // Held until the upload is finished or given up: the temporary file and the place it is put in are this folder, whatever
  // happens to the path while the file comes in.
  const held = holdFolder(base, parent);
  const tempName = `.${tempStem(clean)}.${randomBytes(6).toString("hex")}.upload`;
  const temp = held.at(tempName);
  let fd: number | undefined;
  try {
    const { mode, owner } = madeIn(held);
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    // The mode is cut by the umask on creation; this is the one it is to have.
    handOver(fd, owner, mode, held);
  } catch (e) {
    if (fd !== undefined) {
      closeSync(fd);
      rmSync(temp, { force: true });
    }
    held.close();
    throw ioFailure(e, "The file could not be uploaded", "Nothing was changed.");
  }
  const abandon = () => {
    rmSync(temp, { force: true });
    held.close();
  };
  const finish = () => {
    try {
      for (let n = 1; n < 1000; n++) {
        const numberedName = numbered(clean, n);
        const target = held.at(numberedName);
        try {
          linkSync(temp, target);
          unlinkSync(temp);
          syncFolder(held);
          return path.relative(base, path.join(parent, numberedName));
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EEXIST") continue;
          // Where links are not possible: a rename, after looking, is the best there is.
          if (code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
            if (lexists(target)) continue;
            renameSync(temp, target);
            syncFolder(held);
            return path.relative(base, path.join(parent, numberedName));
          }
          rmSync(temp, { force: true });
          throw ioFailure(e, "The file could not be uploaded", "Nothing was changed.");
        }
      }
      rmSync(temp, { force: true });
      throw new FileError("exists", `Too many files called "${clean}" here`);
    } finally {
      held.close();
    }
  };
  return { fd, finish, abandon };
}

/**
 * Keeps `data` as a new file called `name` in the folder `dirRel`, for what
 * the portal makes itself, such as a picture the agent had generated. Put in
 * place as an upload is: written beside its place first, never over something
 * that is there (a taken name gets a number), and into no place outside the
 * folder. Returns its path, from the chat's folder.
 */
export function saveNewFile(base: string, dirRel: unknown, name: string, data: Buffer): string {
  const target = uploadTarget(base, dirRel, name);
  try {
    let written = 0;
    while (written < data.length) written += writeSync(target.fd, data, written, data.length - written, written);
    fsyncSync(target.fd);
  } catch (e) {
    closeSync(target.fd);
    target.abandon();
    throw ioFailure(e, "The file could not be saved", "Nothing was changed.");
  }
  closeSync(target.fd);
  return target.finish();
}

/** An upload larger than this is cut off: the portal's disk is everyone's. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
/** What a failed upload says when the sender went away or its connection broke: the file is not kept. */
export const UPLOAD_INTERRUPTED = "The upload was interrupted";

/** All of `data` written to `fd`, without holding the thread that serves every chat. */
function writeAll(fd: number, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    let at = 0;
    const next = () => {
      if (at >= data.length) return resolve();
      writeAsync(fd, data, at, data.length - at, null, (error, written) => {
        if (error) return reject(error);
        at += written;
        next();
      });
    };
    next();
  });
}

/**
 * A file that arrives as a stream, put in the folder `dirRel` under `name`: written to disk as it comes, so a big
 * file is never held in memory, and put in place only once all of it has, the way an upload is (see uploadTarget):
 * a taken name gets a number and nothing is replaced. Resolves with its path from the chat's folder and its size.
 *
 * Over `maxBytes` (by default 2 GB) is refused (`too_large`) when it is crossed; a sender that goes away, or a
 * connection that breaks, is `failed` (UPLOAD_INTERRUPTED). Nothing is left behind by a file that did not arrive whole.
 * The stream is not destroyed here: whoever has it decides what is done to it, so that an answer can still be sent.
 */
export async function uploadStream(
  base: string,
  dirRel: unknown,
  name: unknown,
  body: AsyncIterable<Uint8Array>,
  options: { maxBytes?: number } = {},
): Promise<{ path: string; size: number }> {
  const max = options.maxBytes ?? MAX_UPLOAD_BYTES;
  const target = uploadTarget(base, dirRel, name);
  let size = 0;
  let closed = false;
  const close = () => {
    if (!closed) closeSync(target.fd);
    closed = true;
  };
  try {
    // Not `for await`: leaving that loop early closes the stream it reads, and a request closed is a connection without
    // an answer. The caller says what is done to it.
    const chunks = body[Symbol.asyncIterator]();
    for (;;) {
      const next = await chunks.next();
      if (next.done) break;
      size += next.value.length;
      if (size > max) throw new FileError("too_large", `Files over ${max / 1024 / 1024 / 1024} GB are not uploaded here`);
      await writeAll(target.fd, next.value);
    }
    fsyncSync(target.fd);
    close();
  } catch (e) {
    close();
    target.abandon();
    if (e instanceof FileError) throw e;
    // A full disk and the like are the system's; anything else came from the sender's side.
    const mapped = ioFailure(e, "The file could not be written", "Nothing was changed.");
    if (mapped instanceof FileError) throw mapped;
    throw new FileError("failed", UPLOAD_INTERRUPTED, undefined, e);
  }
  return { path: target.finish(), size };
}

/** What `watchFolder` tells: something in the folder may have changed, or the folder itself is gone (removed, renamed or replaced). */
export interface FolderChange {
  gone?: true;
}

/** A watch on a folder, ended by `close`. */
export interface FolderWatch {
  /** Whether the folder at its place is still the one that is watched. */
  current(): boolean;
  close(): void;
}

/**
 * Tells `onChange` when something in the folder `rel` may have changed (a file made, written, renamed or removed, in
 * it), after the burst of changes is over (`debounceMs`, by default 100), and says no more than that: what changed is
 * to be looked at through `portal.files`, which has the checks. A watch reads nothing and changes nothing, but it
 * should watch the folder that was meant: the folder is held and the watch is set on it, so that a link put in
 * its place does not lead the watch elsewhere, and what is watched is the folder as it was, not what its place leads to
 * later. When that folder is removed, renamed or replaced the watch ends by itself, after `onChange({ gone: true })`: ask
 * again for the folder that is there now. A system that cannot watch (too many watches, a file system that has
 * none) is `failed`, with its code; look at the folder every so often instead.
 */
export function watchFolder(
  base: string,
  rel: unknown,
  onChange: (change: FolderChange) => void,
  options: { direct?: boolean; debounceMs?: number } = {},
): FolderWatch {
  const dir = folderPath(base, rel, options);
  const held = holdFolder(base, dir);
  const identityOf = (stat: BigIntStats | undefined) => (stat ? `${stat.dev}:${stat.ino}` : undefined);
  let identity: string | undefined;
  let watcher: ReturnType<typeof watchPath>;
  try {
    identity = identityOf(fstatSync(held.fd, { bigint: true }));
    // On the descriptor where there is one: the watch is on the folder that is held, whatever the path leads to by now.
    watcher = watchPath(held.here, { persistent: false });
  } catch (e) {
    throw ioFailure(e, "The folder could not be watched", "Nothing is watched.");
  } finally {
    held.close();
  }
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const current = () => !ended && identityOf(lstatSync(dir, { bigint: true, throwIfNoEntry: false })) === identity;
  const tell = (change: FolderChange) => {
    try {
      onChange(change);
    } catch (e) {
      console.error("[portal] a folder watch's handler failed:", e);
    }
  };
  const close = () => {
    ended = true;
    clearTimeout(timer);
    watcher.close();
  };
  const gone = () => {
    if (ended) return;
    close();
    tell({ gone: true });
  };
  watcher.on("change", () => {
    if (ended) return;
    // The folder itself was removed, renamed or put back as another: this watch follows the one that is gone.
    if (!current()) return gone();
    clearTimeout(timer);
    timer = setTimeout(() => !ended && tell({}), options.debounceMs ?? 100);
    timer.unref?.();
  });
  watcher.on("error", gone);
  return { current, close };
}
