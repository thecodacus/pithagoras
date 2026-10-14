/**
 * A document's file, read and written safely: only a plain file directly in
 * the documents folder, never through a link, never a second name of a file
 * elsewhere, and written whole or not at all.
 *
 * Every path is the portal's `files.inside` of the folder and a name, and is
 * then checked to be that name in that folder: `inside` follows links, and a
 * link comes back under another path.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fchownSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

/** A document is read whole, so a file bigger than this is not one. */
export const MAX_BYTES = 1024 * 1024;

export const isDocumentName = (name) => typeof name === "string" && name.toLowerCase().endsWith(".md") && !name.startsWith(".") && !/[/\\\0]/.test(name);
/** What the store takes in by itself, found on disk: a name it can also write into a commit's trailers, on one line. */
export const isAdoptable = (name) => isDocumentName(name) && name.length <= 255 && !/[\x00-\x1f\x7f]/.test(name);
/** The temporary files a write leaves behind when it is cut off: `.<name>.<12 hex>.tmp`. */
export const isTempName = (name) => /^\..+\.[0-9a-f]{12}\.tmp$/.test(name);

export class Refused extends Error {}

/** `name` in `dir`, through `inside`: the path, or nothing when it is not exactly that (a link, or no such name). */
function placeOf(inside, dir, name) {
  if (!isDocumentName(name)) return null;
  let file;
  try {
    file = inside(dir, name);
  } catch {
    return null;
  }
  return path.dirname(file) === dir && path.basename(file) === name ? file : null;
}

/**
 * What tells a file's content changed without reading it: a write in place
 * changes its times, one put in place by a rename its inode.
 */
const keyOf = (stat) => `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

/**
 * A document's file, opened to be read: the open descriptor, its stat, and the
 * key that tells it changed; or nothing when it is not a document.
 */
export function openDocument(inside, dir, name) {
  const file = placeOf(inside, dir, name);
  if (!file) return null;
  let fd;
  try {
    // Not waiting at the open: a pipe left under a document's name would hold the portal's only thread until
    // something wrote to it. It is opened at once, and refused below for not being a file.
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  const stat = fstatSync(fd, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(MAX_BYTES)) {
    closeSync(fd);
    return null;
  }
  return { fd, size: Number(stat.size), modified: stat.mtime, key: keyOf(stat) };
}

/** Whether `name` in `dir` is a plain file with one name, whatever its size: what a write can replace. */
export function isPlainFile(inside, dir, name) {
  const file = placeOf(inside, dir, name);
  if (!file) return false;
  try {
    const stat = lstatSync(file);
    return stat.isFile() && stat.nlink === 1;
  } catch {
    return false;
  }
}

export function readOpen(fd, bytes) {
  const buffer = Buffer.alloc(bytes);
  let at = 0;
  while (at < bytes) {
    const got = readSync(fd, buffer, at, bytes - at, at);
    if (got === 0) break;
    at += got;
  }
  return buffer.subarray(0, at);
}

/** A whole document: `{ bytes, modified, key }`, or nothing. */
export function readDocument(inside, dir, name) {
  const opened = openDocument(inside, dir, name);
  if (!opened) return null;
  try {
    return { bytes: readOpen(opened.fd, opened.size), modified: opened.modified, key: opened.key };
  } finally {
    closeSync(opened.fd);
  }
}

/**
 * Puts `bytes` in place of the document `name`, whole: written to a temporary
 * file beside it (made new, never through a link), synced, and renamed over
 * it, so a failure at any point leaves the old text or the new one. The file
 * keeps its mode and its owner: with the sandbox on, the portal writes as
 * root what the agent's user owns and goes on editing.
 *
 * `create`: there must be no file of that name yet, and none is replaced if
 * one comes meanwhile (Refused "exists"). A new file takes the owner of the
 * documents folder, and is writable for its group where the folder is.
 *
 * Refused for a link, a file with a second name (a hard link: writing would
 * reach the other name's file), and anything that is not a plain file.
 * Returns the written file's change key, and when it changed.
 */
export function writeDocument(inside, dir, name, bytes, { create = false } = {}) {
  const file = placeOf(inside, dir, name);
  if (!file) throw new Refused(`${name} is not a document's name in this folder`);
  let mode;
  let owner;
  if (create) {
    const folder = lstatSync(dir);
    mode = 0o644 | (folder.mode & 0o020);
    owner = { uid: folder.uid, gid: folder.gid };
  } else {
    const was = lstatSync(file);
    if (!was.isFile()) throw new Refused(`${name} is not a plain file`);
    if (was.nlink !== 1) throw new Refused(`${name} has another name elsewhere (a hard link)`);
    mode = was.mode & 0o777;
    owner = { uid: was.uid, gid: was.gid };
  }
  const temp = path.join(dir, `.${name.slice(0, 80)}.${randomBytes(6).toString("hex")}.tmp`);
  let fd;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    // The mode is cut by the umask on creation; this is the one it had.
    fchmodSync(fd, mode);
    try {
      fchownSync(fd, owner.uid, owner.gid);
    } catch {
      // Not allowed to give it away (the portal is not root): it stays the portal's.
    }
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, written);
    fsyncSync(fd);
    if (create) {
      // A link fails where the name is taken, where a rename would replace what is there.
      try {
        linkSync(temp, file);
      } catch (e) {
        if (e.code === "EEXIST") throw new Refused("exists");
        throw e;
      }
      unlinkSync(temp);
    } else {
      renameSync(temp, file);
    }
    const stat = fstatSync(fd, { bigint: true });
    closeSync(fd);
    fd = undefined;
    syncDir(dir);
    return { key: keyOf(stat), modified: stat.mtime };
  } catch (e) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
    throw e;
  }
}

/** The rename is only lasting once the folder that holds it is synced. */
function syncDir(dir) {
  let fd;
  try {
    fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
    fsyncSync(fd);
  } catch {
    // Some file systems cannot sync a folder; the rename stands all the same.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
