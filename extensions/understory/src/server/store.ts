import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Understory's settings, in `settings.json` in its own folder (`portal.dataDir()`), for its owner alone (0600): it holds
 * the tokens, and a key of the person's where Understory has a model of its own. Each is left out until it is said.
 */
export interface Settings {
  /** The model that keeps the memory and when it tidies up, as saved (service.ts reads it, `config`). */
  config?: unknown;
  /** The token Understory's container is made with, and that the agent's MCP entry and the Memory page call it with. */
  token?: string;
  /** The key Understory calls the model server with, in "the chat's" mode (llm.ts). */
  llmToken?: string;
  /** What the last pass the portal started came to (`DreamRun` in service.ts). */
  lastDream?: unknown;
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
  if (!file) throw new Error("Understory's settings have not been read");
  kept = { ...kept, ...patch };
  writeFileSync(`${file}.tmp`, JSON.stringify(kept, null, 2), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
