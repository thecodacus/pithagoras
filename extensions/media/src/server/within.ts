import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { FileError } from "./file-error";

/**
 * Whether a path is a folder or lies inside it, by its text, and where a folder really is: the helpers the portal
 * has for this, as Media needs them. Paths are POSIX, as everywhere the portal runs.
 */

/** What of `where` is under the folder `dir`: "" for the folder itself, undefined when it is elsewhere. */
function below(dir: string, where: string): string | undefined {
  const base = dir.replace(/\/+$/, "");
  if (where === base) return "";
  return where.startsWith(base + "/") ? where.slice(base.length + 1) : undefined;
}

/** `path.normalize`, but "" stays "". */
const normal = (p: string) => (p === "" ? "" : path.normalize(p));

/**
 * What of `where` is under the folder `dir` — "" for the folder itself — or undefined when it is elsewhere, by the
 * text of the path alone: no look at the disk. Both are normalised first, so `..`, `.` and doubled or trailing
 * separators say what they mean, and a sibling that only shares the start of the name (`/w/site-old`) is not inside.
 */
export const pathBelow = (dir: string, where: string): string | undefined => below(normal(dir), normal(where));

/** `where` is the folder `dir` or inside it, by the text of the path alone. */
export const isWithinText = (dir: string, where: string): boolean => pathBelow(dir, where) !== undefined;

/** `where` is inside the folder `dir` and not the folder itself, by the text of the path alone. */
export const isUnderText = (dir: string, where: string): boolean => !!pathBelow(dir, where);

/**
 * The real folder `dir` stands for, or an error if there is none: canonical once, up front, so that what
 * `portal.files` is given as a `base` is a real path, as it must be.
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
