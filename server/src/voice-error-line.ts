import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./data-dir.js";
import { writeFileAtomic } from "./atomic-write.js";

/**
 * The spoken "an error occurred" of voice mode.
 *
 * It is made once, when voice mode starts, and kept as a file: said at error time
 * it would need the speech model at the very moment something has gone wrong, and
 * a model that is down then leaves the user with nothing to hear. The name carries
 * a hash of everything that decides how the line sounds (the text, which is
 * in the interface language, the engine and its address, the voice), so another
 * language, voice or engine finds no file and the next start makes a new one.
 */
const PREFIX = "error-line-";
/** Older lines of other voices or languages are cleared away beyond this many, newest kept. */
const KEPT = 8;

const folder = () => path.resolve(DATA_DIR, "voice");
const fileOf = (key: string) => path.join(folder(), `${PREFIX}${key}.wav`);

/** Names the line by what decides its sound. */
export function errorLineKey(identity: unknown): string {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32);
}

/** The stored WAV of that line, or undefined where there is none. */
export function readErrorLine(key: string): Buffer | undefined {
  try { return readFileSync(fileOf(key)); } catch { return undefined; }
}

/** Marks the line as used, so what is cleared away is what was used longest ago and not what was made first. */
export function touchErrorLine(key: string): void {
  try { const now = new Date(); utimesSync(fileOf(key), now, now); } catch { /* A line that has gone is made again. */ }
}

/** Keeps the line, and clears the oldest of the others beyond a few. */
export function saveErrorLine(key: string, wav: Buffer): void {
  mkdirSync(folder(), { recursive: true });
  writeFileAtomic(fileOf(key), wav);
  try {
    const stale = readdirSync(folder())
      .filter(name => name.startsWith(PREFIX) && name.endsWith(".wav"))
      .map(name => ({ name, at: statSync(path.join(folder(), name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(KEPT);
    for (const { name } of stale) rmSync(path.join(folder(), name), { force: true });
  } catch {
    // Clearing is housekeeping: the line itself is in place.
  }
}
