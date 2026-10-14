import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fchownSync, fsyncSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import path from "node:path";

/**
 * Put `data` in place of the file, whole.
 *
 * It is written to a file beside it and put in place by a rename, never into
 * the file itself. Writing into it cuts it off first, so a full disk, an I/O
 * error or a crash in between leaves an empty or half-written file where
 * the work was; done this way the file is the old one or the new one, and a
 * failure leaves the old one exactly as it was. The rename also replaces
 * whatever is at the name instead of following it, so a link put there is
 * replaced, not written through.
 *
 * `mode` is the permission the file gets; without it the file keeps the one it
 * had, or 0644 for a new one. It is set on the open file, not through the
 * umask, and the file is made with it, so a file for secrets is never readable
 * for a moment. A file that was there keeps its owner too, where that is allowed.
 */
export function writeFileAtomic(file: string, data: string | Uint8Array, mode?: number): void {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let keep = mode;
  let owner: { uid: number; gid: number } | undefined;
  try {
    const was = statSync(file);
    keep ??= was.mode & 0o7777;
    owner = { uid: was.uid, gid: was.gid };
  } catch {
    // Not there yet.
  }
  keep ??= 0o644;
  const temp = path.join(path.dirname(file), `.${path.basename(file).slice(0, 80)}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, keep);
    // The mode is cut by the umask on creation; this is what was asked for.
    fchmodSync(fd, keep);
    if (owner) {
      try {
        fchownSync(fd, owner.uid, owner.gid);
      } catch {
        // Not allowed to give it away; it stays ours.
      }
    }
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, written);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
  } catch (e) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
    throw e;
  }
}
