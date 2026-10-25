import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The subagents' settings, the same for every chat: how a subagent runs against its parent, how many run at once,
 * and the model they run on unless a chat says another. Kept in `settings.json` in the extension's own folder
 * (`portal.dataDir()`), each left out while it is what the tool does without being told: interrupt, one at a time,
 * the chat's own model.
 */

/** How a subagent runs against its parent: the call waits for its answer, or returns at once and the answer comes later. */
export type Mode = "interrupt" | "background";

export interface Settings {
  mode: Mode;
  /** How many run at once, across every chat in the portal: from 1 to MAX_PARALLEL. */
  maxParallel: number;
  /** What they run on unless a chat says: "auto", the model the chat is on, or "provider/model". */
  model: string;
}

/** The most that may run at once: each is a model running. */
export const MAX_PARALLEL = 16;

export const DEFAULTS: Settings = { mode: "interrupt", maxParallel: 1, model: "auto" };

/** "auto", or "provider/model". */
export const isModelChoice = (value: unknown): value is string => typeof value === "string" && (value === "auto" || /^[^/\s]+\/\S+$/.test(value));

/**
 * What is stored, read as the tool reads it: what it cannot read is the default. A limit above the most allowed is
 * the most allowed, as a hand-edited file or an old setting may say.
 */
export function settingsOf(stored: unknown): Settings {
  const kept = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  const n = Number(kept.maxParallel);
  return {
    mode: kept.mode === "background" ? "background" : "interrupt",
    maxParallel: Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_PARALLEL) : 1,
    model: isModelChoice(kept.model) ? kept.model : "auto",
  };
}

/** What a change asks for, checked: each it names, valid, or an Error that says what is wrong. */
export function checkChange(body: unknown): Partial<Settings> {
  const { mode, maxParallel, model } = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (mode !== undefined && mode !== "interrupt" && mode !== "background") throw new Error("mode must be interrupt or background");
  if (maxParallel !== undefined && !(Number.isInteger(maxParallel) && (maxParallel as number) >= 1 && (maxParallel as number) <= MAX_PARALLEL)) {
    throw new Error(`maxParallel must be a whole number from 1 to ${MAX_PARALLEL}`);
  }
  if (model !== undefined && !isModelChoice(model)) throw new Error('model must be "auto" or provider/model');
  return { ...(mode !== undefined ? { mode } : {}), ...(maxParallel !== undefined ? { maxParallel: maxParallel as number } : {}), ...(model !== undefined ? { model } : {}) };
}

let file: string | undefined;
/** As it is in the file: what is left out there is left out here, so a hand-off can tell what the person never said. */
let kept: Record<string, unknown> = {};

/** Reads the settings from `dir`, as the half starts. Nothing there yet is nothing said. */
export function openStore(dir: string): void {
  file = path.join(dir, "settings.json");
  try {
    const read = JSON.parse(readFileSync(file, "utf8"));
    kept = read && typeof read === "object" && !Array.isArray(read) ? read : {};
  } catch {
    kept = {};
  }
}

/** The settings now, as the tool reads them. */
export const settings = (): Settings => settingsOf(kept);

/** What a hand-off gave, and is still what is kept: the file has it beside the settings, under `handedOver`. */
const handedOver = (): Record<string, unknown> => {
  const given = kept.handedOver;
  return given && typeof given === "object" && !Array.isArray(given) ? (given as Record<string, unknown>) : {};
};

/**
 * Which of them the person has said, rather than left at the default or taken from pi's settings (a hand-off gives
 * what the person said there, and a later one, after going back, is newer than that).
 */
export const said = (key: keyof Settings): boolean => kept[key] !== undefined && kept[key] !== handedOver()[key];

/**
 * Saves `next`, each left out where it is the default (writeOwn). `given` is what a hand-off gave with it; of what an
 * earlier one gave, what is still kept as it was given stays marked so.
 */
export function saveSettings(next: Settings, given: Partial<Settings> = {}): void {
  if (!file) throw new Error("The subagent's settings are not open");
  const stored: Record<string, unknown> = {};
  if (next.mode !== DEFAULTS.mode) stored.mode = next.mode;
  if (next.maxParallel !== DEFAULTS.maxParallel) stored.maxParallel = next.maxParallel;
  if (next.model !== DEFAULTS.model) stored.model = next.model;
  const handed = Object.fromEntries(Object.entries({ ...handedOver(), ...given }).filter(([key, value]) => stored[key] === value));
  if (Object.keys(handed).length) stored.handedOver = handed;
  writeOwn(file, stored);
  kept = stored;
}

/**
 * Writes `value` as JSON to `file`, for its owner alone (0600), put in place at once: a reader finds the old file or
 * the new one, and a crash after leaves the new one whole, not empty.
 */
export function writeOwn(file: string, value: unknown): void {
  const fd = openSync(`${file}.tmp`, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(`${file}.tmp`, file);
}

/**
 * Takes `old` (what pi's settings held) as the settings, each where the person has said nothing of their own and it
 * differs from what is kept; the keys it took.
 */
export function takeSettings(old: Settings): (keyof Settings)[] {
  const own = settings();
  const taken = (Object.keys(old) as (keyof Settings)[]).filter((key) => !said(key) && old[key] !== own[key]);
  if (taken.length) {
    const given = Object.fromEntries(taken.map((key) => [key, old[key]]));
    saveSettings({ ...own, ...given }, given);
  }
  return taken;
}
