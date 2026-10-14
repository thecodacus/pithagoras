import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { bundledPath } from "./bundled.js";
import { isSwitchedOff, sourceOf } from "./extension-switch.js";
import { realPath } from "./within.js";
import { piAgentDir, piSettingsPath, readPiSettings } from "./pi-settings.js";
import { mcpAdapter, mcpConfigPath, readMcpFile, type McpFile } from "./api/mcp.js";

/**
 * Optional capabilities the portal ships and leaves off: a subagent tool, and
 * Understory as the agent's memory.
 *
 * Each is a reference implementation behind a seam the portal already has —
 * the subagent protocol, an MCP server — so switching one on is only writing
 * it into pi's own configuration, and a third-party equivalent can take its
 * place without the portal knowing the difference.
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

/** A package pi lists by its folder, as a full path: relative to pi's own folder, `~` for home. */
export function localPackagePath(source: string, agentDir = piAgentDir()): string {
  return path.resolve(agentDir, source.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
}

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
    if (!source || /^(npm|git|https?):/.test(source)) continue;
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

// --- Understory ---

/** The MCP server the portal writes for Understory; its tools arrive as `understory_memory_*`. */
export const UNDERSTORY = "understory";
export const UNDERSTORY_TOKEN_ENV = "MEMORY_UNDERSTORY_AUTH_TOKEN";

export const understoryDefaultUrl = (): string =>
  process.env.MEMORY_UNDERSTORY_URL?.trim() || "http://localhost:3800/mcp";

/**
 * The entry for mcp.json. Its tools directly in the agent's list rather than
 * behind the adapter's proxy: memory the agent has to go looking for first is
 * memory it does not use. A token from the environment stays there, named
 * rather than copied into the file; the one the portal made for its own
 * Understory is written in, beside the keys pi keeps in the same folder.
 */
export function understoryEntry(url: string, auth: { tokenEnv?: string; token?: string } = {}): Record<string, unknown> {
  return {
    url,
    lifecycle: "lazy",
    directTools: true,
    ...(auth.token ? { auth: "bearer", bearerToken: auth.token } : auth.tokenEnv ? { auth: "bearer", bearerTokenEnv: auth.tokenEnv } : {}),
  };
}

/** The token an entry calls Understory with: written in it (the portal's own Understory), or named from the environment. */
export function understoryTokenOf(entry: Record<string, unknown> | undefined): string | undefined {
  if (typeof entry?.bearerToken === "string" && entry.bearerToken) return entry.bearerToken;
  if (typeof entry?.bearerTokenEnv === "string") return process.env[entry.bearerTokenEnv] || undefined;
  return undefined;
}

/** Whether a config has Understory as the agent's memory: there, and not switched off. */
export function understoryIn(config: McpFile): boolean {
  const entry = config.mcpServers?.[UNDERSTORY];
  return !!entry && typeof entry === "object" && entry.disabled !== true;
}

/** The answer of `understoryOn` for the files as they were last read. */
let known: { stamp: string; on: boolean } | undefined;

/** When the two files it is read from last changed: asked each time a prompt is built, read only when they did. */
function filesStamp(): string {
  return [mcpConfigPath(), piSettingsPath()]
    .map((f) => {
      try {
        const st = statSync(f);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return "-";
      }
    })
    .join("|");
}

/**
 * Whether Understory is the agent's memory now. Asked each time a chat starts
 * and read from mcp.json whenever that file or pi's settings have changed, so
 * the file is the one place it is said, and switching the server off in
 * Settings → MCP brings MEMORY.md back too; so does switching off
 * pi-mcp-adapter, which its tools come through.
 */
export function understoryOn(): boolean {
  const stamp = filesStamp();
  if (known?.stamp === stamp) return known.on;
  let on = false;
  try {
    const { config, error } = readMcpFile();
    // Its tools are there only through the adapter: without it, MEMORY.md
    // would be taken away and nothing given in its place.
    on = !error && understoryIn(config) && mcpAdapter()?.enabled === true;
  } catch {
    on = false;
  }
  known = { stamp, on };
  return on;
}

/** Said to the agent in place of MEMORY.md, while Understory holds its memory. */
export const UNDERSTORY_RULE =
  "Your long-term memory is Understory, reached through the understory_memory_* tools, not a MEMORY.md file. " +
  "Before relying on what you think you know about the person, their work or earlier decisions, look it up with understory_memory_query. " +
  "When you learn something worth having next week — a decision and why, a preference you were corrected on, how something is set up — record it with understory_memory_add, or understory_memory_update where it is already there.";
