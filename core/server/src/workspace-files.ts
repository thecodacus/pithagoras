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
  writeSync,
} from "node:fs";
import { rm } from "node:fs/promises";
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
  let names;
  try {
    names = readdirSync(target, { withFileTypes: true });
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
    const full = path.join(target, dirent.name);
    try {
      let st = lstatSync(full);
      let type: FileEntry["type"] = st.isDirectory() ? "dir" : "file";
      const link = st.isSymbolicLink();
      if (link) {
        // Shown as what it leads to, but only if that is inside the folder.
        // A link that leads out, or nowhere, is listed and left alone.
        type = "link";
        const real = realpathSync(full);
        if (isWithinText(base, real)) {
          st = statSync(real);
          type = st.isDirectory() ? "dir" : "file";
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

/** Node does not export it. A descriptor that only names a folder (no read, no sync), for which the right to search the folders above it is enough. */
const O_PATH = 0o10000000;

/**
 * How a folder is opened to be walked through: with O_PATH where the kernel has it, so that a folder the portal may
 * search but not read (mode 0311, say) can be walked through as it could before. What tells that the flag is the one it
 * is taken for is that such a descriptor cannot be synced (EBADF).
 */
const WALK_FOLDER = (() => {
  if (process.platform !== "linux") return OPEN_FOLDER;
  let fd: number | undefined;
  try {
    fd = openSync("/", O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fsyncSync(fd);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EBADF") return O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return OPEN_FOLDER;
})();

/** A folder opened without following a link in its last place. */
function openFolder(where: string, flags = OPEN_FOLDER): number {
  try {
    return openSync(where, flags);
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
  /** The folder, for `fstat` and for naming it: it may be an O_PATH descriptor, which cannot be read, synced or given away. */
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
  let fd = openFolder(base, WALK_FOLDER);
  try {
    // The part of the path above `base` is not walked, so it is checked on what was opened: a folder up there swapped for a
    // link since `base` was made canonical leads this open somewhere else, and the descriptor says where.
    if (realpathSync.native(named(fd)) !== path.resolve(base)) throw new FileError("invalid", "That path leads outside the folder");
    for (const part of below.split(path.sep).filter(Boolean)) {
      const next = openFolder(`${named(fd)}/${part}`, WALK_FOLDER);
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
  let fd: number | undefined;
  try {
    // The held descriptor may be an O_PATH one, which cannot be synced: the folder is opened for reading again through it
    // (the folder it names, not a lookup of its name).
    fd = openSync(held.here, constants.O_RDONLY | constants.O_DIRECTORY);
    fsyncSync(fd);
  } catch {
    // Some file systems cannot sync a folder, and a folder the portal may search but not read cannot be opened to be
    // synced; the rename stands all the same.
  } finally {
    if (fd !== undefined) closeSync(fd);
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
  if (code && ["ENOSPC", "EDQUOT", "EIO", "EROFS", "EACCES", "EPERM", "EFBIG", "ENOTEMPTY", "EBUSY"].includes(code)) {
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

/**
 * Removes a file, or a folder and all that is in it. A link is removed as the
 * link it is, and what it points at stays. The folder itself is not removable
 * from here: that is the chat's place, not something in it.
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
  try {
    // Not rmSync: a folder with many files is seconds on the thread that serves every chat.
    // A file that has gone since it was looked for is what was asked for.
    await rm(target, { recursive: true, force: true });
  } catch (e) {
    throw ioFailure(e, "It could not be deleted", "Nothing more was changed.");
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
 */
export function renameEntry(base: string, rel: unknown, newName: unknown): string {
  const name = checkName(newName);
  const from = entryPlace(base, rel, "renamed");
  const parent = path.dirname(from);
  const to = path.join(parent, name);
  if (to === from) return path.relative(base, to);
  if (lexists(to)) throw new FileError("exists", `There is already something called "${name}" here`);
  try {
    renameSync(from, to);
  } catch (e) {
    throw ioFailure(e, "It could not be renamed", "It keeps its name.");
  }
  return path.relative(base, to);
}

/**
 * The place `rel` names for removeFile and renameFile: `entryPlace`, and with `direct` only a name in `base` itself
 * (see OpenOptions.direct), as it was spelled.
 */
function filePlace(base: string, rel: unknown, direct: boolean | undefined, verb: "removed" | "renamed"): string {
  const target = entryPlace(base, rel, verb);
  if (direct && (path.dirname(target) !== base || path.basename(target) !== String(rel))) {
    throw new FileError("invalid", "That is not a file directly in the folder");
  }
  return target;
}

/**
 * `name` in the held folder, looked at without following a link in its last place: what is there if it is a plain file,
 * else a refusal (`invalid`: a link, a folder, a pipe, or with `alone` a file with a second name; `missing`).
 * Read from the descriptor of the folder, so that it is a name in that folder and no other, and by `lstat`, which opens
 * nothing: a pipe is not waited at, and a file the portal may not read can still be taken away.
 */
function plainIn(held: Held, name: string, alone: boolean | undefined): BigIntStats {
  let st: BigIntStats | undefined;
  try {
    st = lstatSync(held.at(name), { bigint: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw ioFailure(e, "The file could not be looked at", "Nothing was changed.");
  }
  if (!st) throw new FileError("missing", "There is no such file");
  if (!st.isFile()) throw new FileError("invalid", "That is a link, a folder or not a plain file");
  if (alone && st.nlink !== 1n) throw new FileError("invalid", "That file has another name elsewhere (a hard link)");
  return st;
}

/**
 * Takes away one plain file: not a folder, and not a link, which is refused, not removed as a link. It does what
 * removeEntry cannot for a name that an agent can change as it runs, and so it is the one for the portal as root.
 *
 * The folder is held (see holdFolder) and the name is taken from it by `unlink`, so the file goes from the folder that was
 * checked, whatever its path leads to by then. A look at the name comes first, for the refusal that says what is
 * wrong; what is swapped in after it is still safe, because `unlink` never follows a link (a link put there is what goes,
 * and what it leads to stays) and never removes a folder (it says `EISDIR`, and nothing is lost, where a recursive remove
 * by path would take the folder and all in it). The name an agent swaps another file of the folder onto between the look and
 * the `unlink` is the one that goes: all of them are the folder's own, which the agent can remove as well.
 *
 * `direct`: `rel` is a name in `base` itself (see OpenOptions.direct); `alone`: a file with a second name is refused.
 * Refusals: `missing`, `invalid`, and `failed` for the system's own reasons.
 */
export function removeFile(base: string, rel: unknown, options: OpenOptions = {}): void {
  const target = filePlace(base, rel, options.direct, "removed");
  const held = holdFolder(base, path.dirname(target));
  try {
    const name = path.basename(target);
    plainIn(held, name, options.alone);
    try {
      unlinkSync(held.at(name));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new FileError("missing", "There is no such file");
      // A folder took the name since it was looked at: it is left as it is. (POSIX says EPERM for it where Linux says EISDIR.)
      if (code === "EISDIR" || (code === "EPERM" && lstatSync(held.at(name), { throwIfNoEntry: false })?.isDirectory())) {
        throw new FileError("invalid", "That is a link, a folder or not a plain file");
      }
      throw ioFailure(e, "It could not be deleted", "Nothing was changed.");
    }
    syncFolder(held);
  } finally {
    held.close();
  }
}

/**
 * Gives one plain file another name in the folder it is in, never over something that is there, and refuses a link and a
 * folder (as removeFile does). Returns the new path, from `base`. `direct` and `alone` as for removeFile.
 *
 * Done in the held folder (see holdFolder) by a hard link and the removal of the old name, not by `rename`: a rename puts
 * the file over whatever is at the new name, and an agent that writes in the folder can make a file of that name between the
 * look and the call, which would be gone. `link` fails with `EEXIST` for it, in the system call itself, so nothing
 * that is at the new name is ever replaced. It does not follow a link at the old name either (a link put there since is
 * made a second name of the link, not of what it leads to), and refuses a folder (`EPERM`). The new name is then
 * looked at: if it is not the file that was looked at (the old name was swapped in between) it is taken away again and
 * nothing is renamed (`conflict`). Only then is the old name removed, so a crash between the two leaves one file with two names, never
 * none. The file itself is not touched: its owner, mode and content stay, and its change key does not (its inode is the same, its
 * times are not).
 *
 * Where hard links cannot be made (a file system without them, or `protected_hardlinks` for a file that is not the
 * portal's own) it is a `rename` after a look at the new name, which is the best there is, and leaves the gap above
 * for a file that is made at the name in between, as uploadTarget does.
 */
export function renameFile(base: string, rel: unknown, newName: unknown, options: OpenOptions = {}): string {
  const name = checkName(newName);
  const from = filePlace(base, rel, options.direct, "renamed");
  const parent = path.dirname(from);
  const held = holdFolder(base, parent);
  try {
    const old = path.basename(from);
    const seen = plainIn(held, old, options.alone);
    if (name !== old) {
      linkOver(held, old, name, seen);
      syncFolder(held);
    }
  } finally {
    held.close();
  }
  return path.relative(base, path.join(parent, name));
}

/** A name this call made in the held folder, taken away again: by `unlink`, which removes the name and never what it leads to. */
function dropName(place: string): void {
  try {
    unlinkSync(place);
  } catch {
    // Gone already, or not ours to remove: what is left is a second name of a file, and nothing is lost.
  }
}

/** `from` in the held folder given the name `to` (see renameFile); `seen` is what `from` was when it was looked at. */
function linkOver(held: Held, from: string, to: string, seen: BigIntStats): void {
  const source = held.at(from);
  const target = held.at(to);
  const taken = () => new FileError("exists", `There is already something called "${to}" here`);
  // The same file by its number, and a plain file still: a file system gives the number of a file that was just removed to the next one
  // that is made (ext4 does), so a folder swapped onto the name can have it.
  const same = (st: BigIntStats | undefined) => st !== undefined && st.isFile() && st.dev === seen.dev && st.ino === seen.ino;
  try {
    linkSync(source, target);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw taken();
    if (code === "ENOENT") throw new FileError("missing", "There is no such file");
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw ioFailure(e, "It could not be renamed", "It keeps its name.");
    // A folder is `EPERM` too: the name was a plain file when it was looked at, and is another thing now.
    if (!same(lstatSync(source, { bigint: true, throwIfNoEntry: false }))) throw new FileError("conflict", "The file changed while it was renamed");
    // No hard links here: the best that is left is to look and rename.
    if (lexists(target)) throw taken();
    try {
      renameSync(source, target);
    } catch (e) {
      throw ioFailure(e, "It could not be renamed", "It keeps its name.");
    }
    return;
  }
  // The new name is the file that was looked at, or it is taken away again: it is the name this call has just made.
  const made = lstatSync(target, { bigint: true, throwIfNoEntry: false });
  if (!same(made)) {
    if (made && !made.isDirectory()) dropName(target);
    throw new FileError("conflict", "The file changed while it was renamed");
  }
  try {
    unlinkSync(source);
  } catch (e) {
    // Gone meanwhile (the agent removed it): the new name is the file, which is what was asked.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    // The old name cannot be taken away: the file has both names now, and the new one is not kept.
    dropName(target);
    throw ioFailure(e, "It could not be renamed", "It keeps its name.");
  }
}

/** The checked path of a folder, for archiving it. With `direct`, a folder that is a name in `base` itself (see OpenOptions.direct). */
export function folderPath(base: string, rel: unknown, options: { direct?: boolean } = {}): string {
  const dir = placeOf(base, rel, options.direct);
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (!st) throw new FileError("missing", "There is no such folder");
  if (!st.isDirectory()) throw new FileError("invalid", "That is not a folder");
  return dir;
}

/**
 * Whether `fd`, a folder opened by the name just made, is plainly the one that was made: empty, and on the parent's file
 * system. Not who it belongs to: some file systems (NFS with root_squash, CIFS or vfat mounted with a uid, FUSE) give a
 * new folder an owner that is not the one who made it, and a folder moved in from another parent needs the agent to
 * be allowed to write in it, so the owner says nothing the emptiness does not.
 *
 * Node cannot make a folder and open it in one call, so the name is looked up twice, and in between an agent that writes in
 * the parent can remove the new (empty) folder and move another one of the parent onto the name. What the portal does next
 * (give it away, give it a mode) must not reach that one. It is told by the folder's own descriptor: the new folder is made
 * closed to everyone but the portal, so nothing can have been put in it, while a folder moved there holds what it held
 * and is turned away. An empty one that is moved there is relabelled, which gives the agent nothing: it could have removed
 * it and made one of its own. A folder of another file system (a mount) is turned away too, for its root is not the agent's
 * to remove.
 */
function isFresh(fd: number, where: string, parent: { dev: number }): boolean {
  try {
    const st = fstatSync(fd);
    if (st.dev !== parent.dev) return false;
    return readdirSync(where).length === 0;
  } catch {
    return false;
  }
}

/**
 * Makes a folder inside `dir`. Like a new file, it never takes the place of
 * something already there. It has the mode, owner and group of the folder it
 * is made in, so that the agent can write in it as it can there (see madeIn).
 * It is made in the folder as it is held (see holdFolder), not in the place
 * its path leads to by the time of the call, and given away only once it is
 * known to be the one just made (see isFresh). Returns its path, from the chat's folder.
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
      // Closed to everyone but the portal until it has its own mode, whatever that is.
      mkdirSync(target, { mode: 0o700 });
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
        // Not the folder just made: something else took the name since, and is left as it is.
        if (!isFresh(fd, held.pinned ? `/proc/self/fd/${fd}` : target, folder)) throw taken();
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
