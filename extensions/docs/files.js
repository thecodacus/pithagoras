/**
 * A document's file, read and written safely: only a plain file directly in
 * the documents folder, never through a link, never a second name of a file
 * elsewhere, and written whole or not at all.
 *
 * The opening, the checks and the atomic write are the portal's own
 * (`portal.files`): what is here is Documents' idea of a document, which is
 * not about safety: the names it takes, and what a refusal of the portal means
 * for a write.
 */
import { lstatSync } from "node:fs";
import path from "node:path";

/** A document is read whole, so a file bigger than this is not one. */
export const MAX_BYTES = 1024 * 1024;

export const isDocumentName = (name) => typeof name === "string" && name.toLowerCase().endsWith(".md") && !name.startsWith(".") && !/[/\\\0]/.test(name);
/** What the store takes in by itself, found on disk: a name it can also write into a commit's trailers, on one line. */
export const isAdoptable = (name) => isDocumentName(name) && name.length <= 255 && !/[\x00-\x1f\x7f]/.test(name);

/**
 * Something in the way of a write. `taken`: the name is another file's (a link, a folder, a second name), not a document's. `gone`: there is no such file.
 * `moved`: the folder is not the one that was asked for (see `expect` of removeDocument).
 */
export class Refused extends Error {
  constructor(message, { taken = false, gone = false, moved = false } = {}) {
    super(message);
    this.taken = taken;
    this.gone = gone;
    this.moved = moved;
  }
}

/**
 * `portal.files`, told whose chats work in the folder: a call that asks for `likeParent` says which chats' agents must be able to use what it reads or
 * changes there, as the portal does not take the agent from the folder's path (which a link can lead into another agent's home). `chats` is the list
 * of their ids, or a function that gives it as each call is made.
 */
export function forChats(files, chats) {
  const optionsAt = { folder: 2, identity: 2, list: 2, read: 2, readBytes: 2, open: 2, sweepTemp: 2, removeFile: 2, write: 3, renameFile: 3, makeFolder: 3 };
  const bound = { ...files };
  for (const [name, at] of Object.entries(optionsAt)) {
    bound[name] = (...args) => {
      const options = args[at];
      if (options?.likeParent && options.chats === undefined) args[at] = { ...options, chats: typeof chats === "function" ? chats() : chats };
      return files[name](...args);
    };
  }
  return bound;
}

/**
 * A file that is a document's: directly in the folder, through no link, with the one name, in a folder that is the agent's to have (the portal
 * reads and writes it as root: a folder the sandbox closed to the agent, renamed to `documents`, is none), and a file the agent could read.
 */
const AS_DOCUMENT = { direct: true, alone: true, likeParent: true };

/**
 * A document's file as `files.readBytes` reads it, or nothing when it is not a
 * document (no such name, a link, a second name, bigger than 1 MB, not a plain
 * file, not to be read). `head`: only that many bytes from its start.
 */
function readFile(files, dir, name, head) {
  if (!isDocumentName(name)) return null;
  try {
    const read = files.readBytes(dir, name, { ...AS_DOCUMENT, ...(head === undefined ? {} : { head }) });
    return { bytes: read.bytes, size: read.size, modified: new Date(read.mtime), key: read.change };
  } catch {
    return null;
  }
}

/** A whole document: `{ bytes, size, modified, key }`, or nothing. `key` tells that the file changed (see `files.readBytes`'s `change`). */
export const readDocument = (files, dir, name) => readFile(files, dir, name);

/** How a document's file stands, with the start of its text (`head`, at most `headBytes` of it): `{ head, size, modified, key }`, or nothing. */
export function lookAtDocument(files, dir, name, headBytes = 0) {
  const read = readFile(files, dir, name, headBytes);
  return read && { head: read.bytes, size: read.size, modified: read.modified, key: read.key };
}

/** Whether `name` in `dir` is a plain file with one name, whatever its size: what a write can replace. */
export function isPlainFile(dir, name) {
  if (!isDocumentName(name)) return false;
  try {
    // Not followed: a link is not a plain file.
    const stat = lstatSync(path.join(dir, name));
    return stat.isFile() && stat.nlink === 1;
  } catch {
    return false;
  }
}

/**
 * Puts `bytes` in place of the document `name`, whole (`files.write`): written
 * to a temporary file beside it, synced, and renamed over it, so a failure at
 * any point leaves the old text or the new one. The file keeps its mode and
 * its owner: with the sandbox on, the portal writes as root what the agent's
 * user owns and goes on editing.
 *
 * `create`: there must be no file of that name yet, and none is replaced if
 * one comes meanwhile (Refused "exists"). A new file takes the owner of the
 * documents folder, and is writable for its group where the folder is (that
 * is how `files.write` makes a file).
 *
 * Refused for a link, a file with a second name (a hard link: writing would
 * reach the other name's file), and anything that is not a plain file.
 * Returns the written file's change key, and when it changed.
 */
export function writeDocument(files, dir, name, bytes, { create = false } = {}) {
  if (!isDocumentName(name)) throw new Refused(`${name} is not a document's name in this folder`, { taken: true });
  try {
    const written = files.write(dir, name, bytes, { create, direct: true, likeParent: true });
    return { key: written.change, modified: new Date(written.mtime) };
  } catch (e) {
    switch (e?.code) {
      // Where a file is made, anything in the way of its name (a file, a folder, a link, a second name) makes the name taken.
      case "exists":
      case "conflict":
      case "invalid":
        throw new Refused(create ? "exists" : e.message, { taken: create });
      case "missing":
        throw new Refused(e.message);
      // `failed` carries the system's code, which errors.js words for the person (a full disk, a folder it may not write in).
      default:
        throw e;
    }
  }
}

/**
 * Takes away the document `name`, as it is: a plain file, with no second name (`shared`: a file that has one, which a rename that was cut off
 * leaves), and nothing else. Done by the portal's `files.removeFile`, in the documents folder as it is held, so that what an agent does to the
 * folder or the name meanwhile is not followed, and no folder is taken for a file. True when it was removed, false when it was gone already
 * (that is what was asked for). Refused (`taken`: the name is something else now) for a link, a folder or a file with a second name.
 *
 * `expect` (`{ dev, ino }`): the folder it is to act in, which the portal checks on the folder it holds, so that a folder moved onto
 * the documents folder's place since is not acted in (`moved`).
 */
export function removeDocument(files, dir, name, { shared = false, expect } = {}) {
  if (!isDocumentName(name)) throw new Refused(`${name} is not a document's name in this folder`, { taken: true });
  try {
    files.removeFile(dir, name, { direct: true, alone: !shared, likeParent: true, ...(expect ? { expect } : {}) });
    return true;
  } catch (e) {
    if (e?.code === "missing") return false;
    if (e?.code === "invalid") throw new Refused(e.message, { taken: true });
    if (e?.code === "conflict") throw new Refused(e.message, { moved: true });
    throw e;
  }
}

/**
 * Gives the document file `from` the name `to`, in the folder it is in, never over something that is there (`files.renameFile`: a second name is
 * made first, which the system refuses for a taken name, then the old one is removed). Refused: `taken` for a name that something has (a file, a
 * folder, a link, a file made there meanwhile); not `taken` for a `from` that is no plain document file now, or gone. `expect` as for removeDocument.
 */
export function renameDocument(files, dir, from, to, { expect } = {}) {
  if (!isDocumentName(from) || !isAdoptable(to)) throw new Refused(`${isAdoptable(to) ? from : to} is not a document's name in this folder`);
  try {
    files.renameFile(dir, from, to, { ...AS_DOCUMENT, ...(expect ? { expect } : {}) });
  } catch (e) {
    switch (e?.code) {
      case "exists":
        throw new Refused(e.message, { taken: true });
      case "missing":
        throw new Refused(e.message, { gone: true });
      case "invalid":
      case "conflict":
        throw new Refused(e.message);
      default:
        throw e;
    }
  }
}
