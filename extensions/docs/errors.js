import { GitError } from "./git.js";

/** A request the store refuses: its HTTP status, what to say, and what else the answer carries. */
export class DocError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** The first line of what git or the database said, cut to what a person can read. */
const brief = (text) => String(text).split("\n")[0].slice(0, 300);

/**
 * What a failure of the disk, of git or of the database is to whoever reads it: a refusal that says what is wrong, for the ones
 * the person who runs the portal can do something about (a folder it may not write in, a full disk, git that is not there, a
 * damaged store). Any other failure is returned as it is: it is the portal's log's to say, and the person is told it failed.
 * `dir` is the store's folder, which a damaged store is mended in.
 *
 * What names the store's folder or a way to mend it is for the person alone (`operator`): the agent runs commands in the same
 * portal, and is not told to delete files in the store (tools.js tells it to ask the person).
 */
export function explained(e, dir = null) {
  if (e instanceof DocError) return e;
  const noRoom = new DocError(507, "There is no room left on the disk for this document");
  const readOnly = new DocError(403, "The documents folder, or the portal's data folder, is on a read-only file system");
  const forThePerson = (status, message) => Object.assign(new DocError(status, message), { operator: true });
  const denied = forThePerson(403, `The portal is not allowed to use the documents store${dir ? ` in ${dir}` : ""} (permission denied)`);
  // The store's own files are named through its open folder (/proc/self/fd/…) or by its path; anything else is in the documents folder.
  const inStore = typeof e?.path === "string" && (e.path.startsWith("/proc/self/fd/") || (dir !== null && e.path.startsWith(dir)));
  // A refusal of `portal.files` for the system's reasons (a write of a document) carries the system's code as `errno`.
  const code = e?.code === "failed" && typeof e.errno === "string" ? e.errno : e?.code;
  if (code === "EACCES" || code === "EPERM") return inStore ? denied : new DocError(403, "The portal is not allowed to change files in this folder's documents folder (permission denied)");
  if (code === "EROFS") return readOnly;
  if (code === "ENOSPC" || code === "EDQUOT") return noRoom;
  if (e instanceof GitError) {
    if (e.spawn === "ENOENT") return forThePerson(500, "git could not be found on the portal's PATH: the history of the documents is kept with it");
    // git is a child process: what the disk said reaches it as words, not as an error code.
    if (/No space left on device|Disk quota exceeded/i.test(e.message)) return noRoom;
    if (/Read-only file system/i.test(e.message)) return readOnly;
    // Its own words, not the system's, for an object it may not write: `insufficient permission for adding an object to repository database`.
    if (/Permission denied|insufficient permission/i.test(e.message)) return denied;
    return forThePerson(500, `The history of the documents could not be used: ${brief(e.message)}${dir ? ` (the store is ${dir}: if the history there is damaged, remove its git folder to start it again; the documents and their comments stay)` : ""}`);
  }
  if (typeof e?.code === "string" && e.code.startsWith("SQLITE_")) {
    if (e.code.startsWith("SQLITE_FULL")) return noRoom;
    // SQLite opens a database it may not write read-only, and then says so on the first write: the file is as likely not the portal's to write
    // as its file system is read-only. (A file moved or deleted under an open connection says READONLY_DBMOVED too: that is not this.)
    if (e.code.startsWith("SQLITE_READONLY") && e.code !== "SQLITE_READONLY_DBMOVED") {
      return forThePerson(403, `The documents database cannot be written: the portal may not write the docs.sqlite files${dir ? ` in ${dir}` : ""}, or their file system is read-only (${brief(e.message)})`);
    }
    if (e.code.startsWith("SQLITE_PERM")) return denied;
    if (["SQLITE_NOTADB", "SQLITE_CORRUPT"].includes(e.code)) return forThePerson(500, `The database of the documents is damaged: ${brief(e.message)}${dir ? ` (remove the docs.sqlite files in ${dir} to build it again from the history; the comments are lost)` : ""}`);
    return forThePerson(500, `The database of the documents could not be used: ${brief(e.message)}${dir ? ` (the store is ${dir})` : ""}`);
  }
  return e;
}
