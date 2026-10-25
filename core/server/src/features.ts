import path from "node:path";
import { fileURLToPath } from "node:url";
import { piAgentDir } from "./pi-settings.js";

/**
 * Packages as pi's settings list them by their source, and what a chat's subagents may be told to run on. The subagent
 * tool itself is an extension (extensions/subagent), switched in Settings → Extensions like any other, with its own
 * settings.
 */

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

/** "auto", or "provider/model". */
export const isModelChoice = (value: unknown): value is string =>
  typeof value === "string" && (value === "auto" || /^[^/\s]+\/\S+$/.test(value));
