import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundledPath } from "./bundled.js";
import { isSwitchedOff, sourceOf } from "./extension-switch.js";
import { realPath } from "./within.js";
import { piAgentDir, readPiSettings } from "./pi-settings.js";

/**
 * An optional capability the portal ships and leaves off: a subagent tool.
 *
 * It is a reference implementation behind a seam the portal already has — the
 * subagent protocol — so switching it on is only writing it into pi's own
 * configuration, and a third-party equivalent can take its place without the
 * portal knowing the difference.
 */

// --- the subagent tool ---

/** The package name of the bundled subagent tool, which also finds a copy installed from elsewhere. */
export const SUBAGENT_PACKAGE = "pithagoras-subagent";

export type SubagentMode = "interrupt" | "background";

/** The subagent tool shipped with the portal: the folder that holds its package. */
export function bundledSubagentDir(): string | undefined {
  return bundledPath("extensions/subagent", "package.json");
}

const real = (p: string) => realPath(p) ?? path.resolve(p);

function packageName(dir: string): string | undefined {
  try {
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name;
  } catch {
    return undefined;
  }
}

/** Whether pi takes a package source for a folder: the ones it knows by a prefix are not (the prefixes of its isLocalPath). */
export const isLocalSource = (source: string): boolean => !/^(npm|git|github|https?|ssh|builtin):/.test(source.trim());

/** A package pi lists by its folder, as a full path: relative to pi's own folder, `~` for home, a `file://` address as that path. */
export function localPackagePath(source: string, agentDir = piAgentDir()): string {
  const home = process.env.HOME ?? "~";
  const text = source.trim();
  if (/^file:\/\//.test(text)) {
    try {
      return path.resolve(fileURLToPath(text));
    } catch {
      // An address pi cannot read either: it stays a plain path.
    }
  }
  return path.resolve(agentDir, text === "~" ? home : text.replace(/^~(?=\/)/, home));
}

/**
 * A package source as `pi remove` takes it back. pi writes a folder into its
 * settings relative to its own folder, but reads the one it is given relative
 * to where it runs (1.1.0, DefaultPackageManager), so the entry as it stands
 * there matches only from a folder just as deep. A full path matches always.
 */
export const piPackageArg = (source: string, agentDir = piAgentDir()): string =>
  isLocalSource(source) ? localPackagePath(source, agentDir) : source;

/**
 * Where pi's packages list has the subagent tool: the bundled folder, or any
 * folder holding a package of that name — one installed by hand from a clone
 * is the same tool. A local path in that list is relative to the settings
 * file's folder, as pi reads it.
 */
export function findSubagent(
  packages: unknown[],
  agentDir: string,
  bundled: string | undefined,
  nameOf: (dir: string) => string | undefined = packageName,
): { source: string; enabled: boolean } | undefined {
  for (const entry of packages) {
    const source = sourceOf(entry);
    if (!source || !isLocalSource(source)) continue;
    const dir = localPackagePath(source, agentDir);
    if ((bundled && real(dir) === real(bundled)) || nameOf(dir) === SUBAGENT_PACKAGE) {
      return { source, enabled: !isSwitchedOff(entry) };
    }
  }
  return undefined;
}

/** The mode pi's settings hold, as the tool reads it: interrupt unless they say background. */
export const subagentModeOf = (settings: Record<string, unknown>): SubagentMode =>
  settings.subagentMode === "background" ? "background" : "interrupt";

export const SUBAGENT_MAX_PARALLEL = 16;

/** How many subagents may run at once, as the tool reads it: 1 unless the settings say more. */
export function subagentLimitOf(settings: Record<string, unknown>): number {
  const n = Number(settings.subagentMaxParallel);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, SUBAGENT_MAX_PARALLEL) : 1;
}

/** What subagents run on unless a chat says: "auto", the model the chat is on, or "provider/model". */
export const subagentModelOf = (settings: Record<string, unknown>): string =>
  isModelChoice(settings.subagentModel) ? (settings.subagentModel as string) : "auto";

/** "auto", or "provider/model". */
export const isModelChoice = (value: unknown): value is string =>
  typeof value === "string" && (value === "auto" || /^[^/\s]+\/\S+$/.test(value));

export function subagentState() {
  const settings = readPiSettings();
  const bundled = bundledSubagentDir();
  const found = findSubagent(Array.isArray(settings.packages) ? settings.packages : [], piAgentDir(), bundled);
  return {
    available: bundled !== undefined,
    installed: found !== undefined,
    enabled: found?.enabled === true,
    source: found?.source ?? null,
    mode: subagentModeOf(settings),
    maxParallel: subagentLimitOf(settings),
    // The most there may be, for the page to count up to: said here, not repeated there.
    maxParallelLimit: SUBAGENT_MAX_PARALLEL,
    model: subagentModelOf(settings),
  };
}
