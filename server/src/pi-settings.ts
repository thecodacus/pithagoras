import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * pi's own settings file — the one the CLI writes and extensions read.
 *
 * The portal edits it (Advanced), scans it for extension keys, and reads its
 * `default*` entries as the fallback for new sessions, so the path lives in one
 * place rather than being rebuilt at each call site.
 */
export const piAgentDir = (): string =>
  process.env.PI_CODING_AGENT_DIR?.trim() ||
  path.join(process.env.HOME || "/data/home", ".pi", "agent");

export const piSettingsPath = (): string => path.join(piAgentDir(), "settings.json");

export function readPiSettings(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(piSettingsPath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Missing or malformed: callers fall back to their own defaults.
    return {};
  }
}

/** A string setting from pi's file, or undefined if absent or the wrong type. */
export function piSetting(key: string): string | undefined {
  const value = readPiSettings()[key];
  return typeof value === "string" && value ? value : undefined;
}
