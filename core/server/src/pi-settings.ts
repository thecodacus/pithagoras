import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";

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

/** A project's own pi settings, in `.pi` in its folder; empty when it has none. */
export function readProjectPiSettings(folder: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path.join(folder, ".pi", "settings.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
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
 * The file as a change starts from it: none yet is empty, but one that is there
 * and cannot be read stops the change. Taken as empty, the save would write back
 * only what it adds, and every package, default and switch in the file would be
 * gone (providers.ts does the same for models.json and auth.json).
 */
function readForChange(): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(piSettingsPath(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`settings.json could not be read (${(e as Error).message}), so nothing was changed. Put it right by hand, then save again.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("settings.json does not hold what pi expects, so nothing was changed.");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Put `text` in place of the file, whole: a temp file and a rename, which is
 * atomic on the same filesystem — a reader arriving mid-write sees the old file
 * whole rather than half of the new one. What it replaces is kept beside it as
 * settings.json.bak, so a save that was not what was meant can be taken back.
 */
function replaceFile(text: string): void {
  const file = piSettingsPath();
  mkdirSync(path.dirname(file), { recursive: true });
  let before: string | undefined;
  try {
    before = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  // A save that changes nothing leaves the copy of the file before it alone.
  if (before === text) return;
  if (before !== undefined) writeFileAtomic(`${file}.bak`, before, 0o600);
  writeFileAtomic(file, text);
}

/** The portal's own writes to the file, one after the other: the last of them. */
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * `work` once the writes before it are done, and before the next. For what is
 * kept alongside the file, which neither reads nor changes it.
 */
export function inTurnWithSettings<T>(work: () => T): Promise<T> {
  const next = writeChain.then(work);
  // Kept unbroken by a failure, or one bad write would wedge every later one.
  writeChain = next.catch(() => {});
  return next;
}

/**
 * Change pi's settings file without losing what else is in it.
 *
 * Read-modify-write on a file pi also owns, so two precautions. The write goes
 * through a rename, so a reader never sees half of it. And the portal's own
 * writes are serialised, so a slider released at the same moment as a Save
 * cannot interleave and drop one of the two changes.
 *
 * What this cannot do is coordinate with pi itself: pi has no setter for most
 * of these fields, so the portal writes the file directly, and a pi write
 * landing between the read and the rename would still be lost. That window is
 * milliseconds wide and pi only writes on a deliberate action, so it is a
 * smaller risk than the alternative of reaching into its internals.
 *
 * `written` runs once the file is in place, still in turn with other writes:
 * for what is kept elsewhere alongside it, which must not change when the
 * file did not.
 *
 * A file that is there but cannot be read is not changed: this throws, saying so.
 */
export function updatePiSettings(
  mutate: (settings: Record<string, unknown>) => void,
  written?: () => void,
): Promise<Record<string, unknown>> {
  return inTurnWithSettings(() => {
    const all = readForChange();
    mutate(all);
    replaceFile(JSON.stringify(all, null, 2) + "\n");
    written?.();
    return all;
  });
}

/**
 * The raw editor's save: whatever the user wrote, as long as it is an object
 * pi can read, in turn with the other writes. It does not start from the file,
 * so it is also how one that cannot be read is put right.
 */
export function writePiSettingsText(text: string): Promise<void> {
  return inTurnWithSettings(() => replaceFile(text));
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
