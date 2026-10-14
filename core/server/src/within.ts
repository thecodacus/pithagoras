import { readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { below } from "./paths.js";

/**
 * What of `where` is under the folder `dir` — "" for the folder itself — or
 * undefined when it is elsewhere, by the text of the path alone: no look at the
 * disk. Both are normalised first, so `..`, `.` and doubled or trailing
 * separators say what they mean — `/w/site/../backup` is not in `/w/site` — and
 * a sibling that only shares the start of the name (`/w/site-old`) is not
 * inside. Everything is inside `/`.
 */
export const pathBelow = (dir: string, where: string): string | undefined => below(normal(dir), normal(where));

/** `path.normalize`, but "" stays "" — the web's `below` reads it as "/", and normalize would make it ".". */
const normal = (p: string) => (p === "" ? "" : path.normalize(p));

/** `where` is the folder `dir` or inside it, by the text of the path alone. */
export const isWithinText = (dir: string, where: string): boolean => pathBelow(dir, where) !== undefined;

/** `where` is inside the folder `dir` and not the folder itself, by the text of the path alone. */
export const isUnderText = (dir: string, where: string): boolean => !!pathBelow(dir, where);

/** Where a path really leads, every link followed; null when it cannot be followed, such as a path that is gone. */
export function realPath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Where a path would really lead, with what is not there yet taken into account:
 * the part of it that exists is followed, links included, and the rest is put
 * after it. A file made under a link lands where the link leads, which
 * `realPath` cannot say of a file that is not there. A link that leads nowhere
 * yet is followed too, as writing to it makes what it points at.
 */
export function realPathAhead(p: string): string {
  const rest: string[] = [];
  let at = path.resolve(p);
  for (let hops = 0; ; ) {
    const real = realPath(at);
    if (real !== null) return path.join(real, ...rest.reverse());
    let to: string | undefined;
    try {
      to = readlinkSync(at);
    } catch {
      to = undefined;
    }
    if (to !== undefined && hops++ < 40) {
      at = path.resolve(path.dirname(at), to);
      continue;
    }
    const parent = path.dirname(at);
    if (parent === at) return path.resolve(p);
    rest.push(path.basename(at));
    at = parent;
  }
}

/**
 * A test for whether a place is the folder `dir` or inside it, by the text or
 * by where it really leads, so that a link to a project counts as in the
 * project. `dir` is followed once, the first time the text alone does not
 * answer, however many places the test is put to.
 */
export function insideReal(dir: string): (where: string | null) => boolean {
  let realDir: string | null | undefined;
  return (where) => {
    if (!where) return false;
    if (isWithinText(dir, where)) return true;
    if (realDir === undefined) realDir = realPath(dir);
    if (realDir === null) return false;
    const realWhere = realPath(where);
    return realWhere !== null && isWithinText(realDir, realWhere);
  };
}
