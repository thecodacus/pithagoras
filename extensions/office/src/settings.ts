/**
 * pithagoras-office settings: dataDir()/settings.json, merged over defaults field by field.
 *
 * Pure over a root directory -- no portal calls happen here except through the `root` default
 * (dataDir()), and no logging: a missing or corrupt file yields the defaults SILENTLY. The server
 * logs at its call site if it cares; keeping this module side-effect free also lets unit tests pass
 * plain tmp dirs without reaching portal().
 */
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./host";

export type OfficeSettings = { enabled: boolean; imageTag: string };

/** Pinned image tag -- never :latest (the settings page warns about it). */
export const DEFAULT_SETTINGS: OfficeSettings = { enabled: false, imageTag: "onlyoffice/documentserver:10.0" };

const FILE = "settings.json";

function field<K extends keyof OfficeSettings>(raw: Record<string, unknown>, key: K): OfficeSettings[K] {
  const value = raw[key];
  return value !== undefined && typeof value === typeof DEFAULT_SETTINGS[key] ? (value as OfficeSettings[K]) : DEFAULT_SETTINGS[key];
}

/** Read root/settings.json and merge it over DEFAULTS field by field; unknown fields are ignored -- LEGACY files
 * written before the co-editing switch existed still carry a "coEdit" key, which is loaded without crashing and
 * simply never surfaced. Missing file, unreadable file, or anything that is not a JSON object -> DEFAULT_SETTINGS
 * (returned silently -- no logging in this module). */
export function loadSettings(root = dataDir()): OfficeSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(root, FILE), "utf8"));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...DEFAULT_SETTINGS };
  const obj = raw as Record<string, unknown>;
  return { enabled: field(obj, "enabled"), imageTag: field(obj, "imageTag") };
}

/** Load, apply a patch of any subset of fields (ignoring absent/undefined ones), persist the whole object atomically
 * (tmp file in the same directory + rename) and return the stored result. */
export function saveSettings(patch: Partial<OfficeSettings>, root = dataDir()): OfficeSettings {
  const merged: OfficeSettings = { ...loadSettings(root) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || !(key in DEFAULT_SETTINGS)) continue; // unknown keys are ignored
    (merged as Record<string, unknown>)[key] = value;
  }
  writeAtomic(path.join(root, FILE), Buffer.from(JSON.stringify(merged, null, 2) + "\n", "utf8"));
  return { ...merged };
}

function writeAtomic(dest: string, bytes: Buffer): void {
  const dir = path.dirname(dest);
  const tmp = path.join(dir, `.${path.basename(dest)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, dest);
}
