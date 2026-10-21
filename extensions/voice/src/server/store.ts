import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Voice's settings, in `settings.json` in its own folder (`portal.dataDir()`), for its owner alone (0600). Each is left
 * out until it is said, and then what is said elsewhere (the environment, a default) answers for it.
 */
export interface Settings {
  /**
   * The GPU chosen on the page, by UUID; empty leaves it to `VOICE_GPU` and then to the card with the most room. A UUID
   * rather than an index, because the index order is the driver's and a UUID names the same card after a reboot or a
   * card added beside it.
   */
  gpu?: string;
  /** A setup was started from the page and has not come up yet: once it has, the service is made voice mode's source. */
  setupPending?: boolean;
  /** Whether the speech model is let go of once voice mode no longer uses it: on unless set false. */
  lazyLoad?: boolean;
}

let file: string | undefined;
let kept: Settings = {};

/** Reads the settings from `dir`, as the half starts. Nothing there yet is no setting said. */
export function openStore(dir: string): void {
  file = path.join(dir, "settings.json");
  try {
    kept = JSON.parse(readFileSync(file, "utf8")) ?? {};
  } catch {
    kept = {};
  }
}

export const setting = <K extends keyof Settings>(key: K): Settings[K] => kept[key];

/** Keeps `patch` beside what was said before, the whole file put in place at once. */
export function putSettings(patch: Settings): void {
  if (!file) throw new Error("Voice's settings have not been read");
  kept = { ...kept, ...patch };
  writeFileSync(`${file}.tmp`, JSON.stringify(kept, null, 2), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
