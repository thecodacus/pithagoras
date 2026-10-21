import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Browser's settings, in `settings.json` in its own folder (`portal.dataDir()`), for its owner alone (0600): the
 * password in it is the one the browser's container was made with, and the one its UI is opened with. Each is left out
 * until it is said, and then what is said elsewhere (the environment, a default) answers for it.
 */
export interface Settings {
  user?: string;
  password?: string;
  port?: string;
  httpsPort?: string;
  /** Whether the tools glide a cursor to what they act on: on unless set false. */
  cursor?: boolean;
  /** Whether the agent's chats have the browser's tools. */
  connected?: boolean;
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

/** Whether the agent's chats have the browser's tools: not until somebody connects them, or installs the browser. */
export const connected = (): boolean => setting("connected") === true;

/** Keeps `patch` beside what was said before, the whole file put in place at once. */
export function putSettings(patch: Settings): void {
  if (!file) throw new Error("Browser's settings have not been read");
  kept = { ...kept, ...patch };
  writeFileSync(`${file}.tmp`, JSON.stringify(kept, null, 2), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
