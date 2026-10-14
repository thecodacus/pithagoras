import { lstatSync, rmSync } from "node:fs";
import path from "node:path";

/** What an id looks like: the letters, digits, `_` and `-` of a nanoid. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Removes what pi wrote for a session: the folder named after it in the
 * session root, with the conversation file inside.
 *
 * Deleting a chat used to take its rows and leave this behind — the whole
 * transcript, tool output included, on disk long after the chat was gone from
 * the app, and adding up with every one deleted.
 *
 * The id is checked to be a plain name and the folder to sit directly in the
 * root, so nothing outside it can be reached through this. A link in that place
 * is removed as the link it is, not followed.
 *
 * Returns whether there was anything to remove.
 */
export function removeSessionFiles(root: string, sessionId: string): boolean {
  if (!ID.test(sessionId)) throw new Error(`"${sessionId}" is not a session id`);
  const dir = path.join(path.resolve(root), sessionId);
  if (path.dirname(dir) !== path.resolve(root)) throw new Error(`"${sessionId}" is not a session id`);
  try {
    lstatSync(dir);
  } catch (e) {
    // Only "not there" means there is nothing to do. A folder that cannot be
    // looked at is a leftover, and the caller is told so.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  rmSync(dir, { recursive: true, force: true });
  return true;
}
