import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The file of a conversation a chat recorded, where it is now.
 *
 * The record is an absolute path, and the data folder is not always where it
 * was: a source run moved into Docker, a folder copied somewhere else. The file
 * is then still in the chat's own session folder, under its own name. Without
 * this, pi started a new, empty conversation under a transcript that looks
 * complete, and — the path being set — went on doing it at every launch.
 */
export function findSessionFile(recorded: string | undefined, sessionDir: string): string | undefined {
  if (!recorded) return undefined;
  if (existsSync(recorded)) return recorded;
  const moved = path.join(sessionDir, path.basename(recorded));
  return existsSync(moved) ? moved : undefined;
}
