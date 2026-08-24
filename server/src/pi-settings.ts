import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
 * Change pi's settings file without losing what else is in it.
 *
 * Read-modify-write on a file pi also owns, so two precautions. The write is a
 * temp file and a rename, which is atomic on the same filesystem — a reader
 * arriving mid-write sees the old file whole rather than half of the new one.
 * And the portal's own writes are serialised, so a slider released at the same
 * moment as a Save cannot interleave and drop one of the two changes.
 *
 * What this cannot do is coordinate with pi itself: pi has no setter for most
 * of these fields, so the portal writes the file directly, and a pi write
 * landing between the read and the rename would still be lost. That window is
 * milliseconds wide and pi only writes on a deliberate action, so it is a
 * smaller risk than the alternative of reaching into its internals.
 */
let writeChain: Promise<unknown> = Promise.resolve();

export function updatePiSettings(
  mutate: (settings: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const next = writeChain.then(() => {
    const all = readPiSettings();
    mutate(all);
    const file = piSettingsPath();
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(all, null, 2) + "\n", "utf8");
    renameSync(temp, file);
    return all;
  });
  // Kept unbroken by a failure, or one bad write would wedge every later one.
  writeChain = next.catch(() => {});
  return next;
}

/** Merged, never replaced: the portal has no business dropping a key it does not know. */
export async function writeCompactionSettings(
  patch: Partial<CompactionSettings>,
): Promise<CompactionSettings> {
  await updatePiSettings((all) => {
    const current = all.compaction && typeof all.compaction === "object" ? all.compaction : {};
    all.compaction = { ...current, ...patch };
  });
  return readCompactionSettings();
}
