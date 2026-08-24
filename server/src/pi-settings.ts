import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * How compaction is tuned, from pi's own file rather than the portal's.
 *
 * `keepRecentTokens` is the floor a compaction cannot go below: the most
 * recent stretch of conversation is kept verbatim and only what is older gets
 * summarised. pi's default of 20000 is most of a 64k window, which is why a
 * compacted session can still read as a third full.
 */
export interface CompactionSettings {
  enabled: boolean;
  keepRecentTokens: number;
}

/** pi's own defaults, repeated here so the UI can show what it is inheriting. */
export const COMPACTION_DEFAULTS: CompactionSettings = {
  enabled: true,
  keepRecentTokens: 20_000,
};

export function readCompactionSettings(): CompactionSettings {
  const stored = readPiSettings().compaction;
  const c = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  return {
    enabled: c.enabled !== false,
    keepRecentTokens:
      typeof c.keepRecentTokens === "number" && c.keepRecentTokens > 0
        ? c.keepRecentTokens
        : COMPACTION_DEFAULTS.keepRecentTokens,
  };
}

/**
 * Merged into whatever else is in the file. pi writes here too, and the portal
 * has no business dropping a key it does not know about.
 */
export function writeCompactionSettings(patch: Partial<CompactionSettings>): CompactionSettings {
  const all = readPiSettings();
  const current = all.compaction && typeof all.compaction === "object" ? all.compaction : {};
  all.compaction = { ...current, ...patch };
  mkdirSync(path.dirname(piSettingsPath()), { recursive: true });
  writeFileSync(piSettingsPath(), JSON.stringify(all, null, 2) + "\n", "utf8");
  return readCompactionSettings();
}
