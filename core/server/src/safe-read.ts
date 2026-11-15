import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { isWithinText, realPath } from "./within.js";

/** A file of servers is read whole; one that is longer than this is not a configuration. */
export const MAX_CONFIG_BYTES = 1_000_000;

/**
 * The text of a file in a folder that somebody else may write in (a repository, a chat's workspace), or undefined where it
 * is not a regular file, is longer than `max` bytes, or cannot be read. It is opened without waiting and judged by what is
 * open: a FIFO named like the file would block a plain read until somebody writes to it, a link to `/dev/zero` would be
 * read until memory runs out, and a path checked before it is read can be another file by then.
 */
export function readRegularText(where: string, max: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(where, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > max) return undefined;
    // One byte more than the limit, to tell a file that grew while it was read.
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const got = readSync(fd, buffer, length, buffer.length - length, null);
      if (got === 0) break;
      length += got;
    }
    return length > info.size || length > max ? undefined : buffer.toString("utf8", 0, length);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** `readRegularText` of a file of a folder, where the file really is in the folder: a link that leads out of it is a file of somebody else's. */
export function readFileIn(folder: string, file: string, max: number): string | undefined {
  const real = realPath(path.join(folder, file));
  const home = realPath(folder);
  if (!real || !home || !isWithinText(home, real)) return undefined;
  return readRegularText(real, max);
}
