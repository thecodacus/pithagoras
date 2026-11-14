import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { DATA_DIR } from "./data-dir.js";

/**
 * What each MCP server offered when it last ran: the name pi gave each tool, the server's own name for it, its
 * description and parameters.
 *
 * pi has no metadata cache: a tool of a server that has not connected does not exist until it has. The portal needs the
 * tools before that, for three things: the lists of Settings → Tools for servers that have not run, the threshold's count
 * before anything has connected, and the `tool_search` of a chat, which finds a tool of a server that is not running and
 * connects it when the tool is called (see pi/mcp-runtime.ts). It is the portal's own file in its data folder, not pi's,
 * and not the adapter's `mcp-cache.json` (which the migration reads once, for the names).
 *
 * An entry is for the configuration it was read from (`hash`, see configHash): one whose server's configuration has
 * changed since is still what is known of it, and is read again at the next connect.
 */

export interface CachedTool {
  /** The name pi gave it: `mcp__<server>__<tool>`. */
  name: string;
  /** What the server calls it. */
  original: string;
  description: string;
  parameters: unknown;
  /** What its declaration costs the model's list, in tokens (`ceil(chars / 4)`, the measure of the tool texts test). */
  tokens: number;
  /** pi's hints (`readOnlyHint` and the like), where the server gave them. */
  annotations?: Record<string, boolean>;
}

export interface CachedServer {
  /** configHash of the entry it was read from. */
  hash: string;
  /** When it was read, in milliseconds. */
  at: number;
  tools: CachedTool[];
}

interface CacheFile {
  v: 1;
  servers: Record<string, CachedServer>;
}

export const mcpToolCachePath = (): string => path.resolve(DATA_DIR, "mcp-tools.json");

/** The keys of an entry that decide what a server offers: how it is reached, not how the chats see it. */
const DEFINING = ["type", "command", "args", "cwd", "env", "url", "headers", "oauth", "auth"] as const;

/** A hash of what defines the server in an entry, so a cache entry can tell the configuration it was read from. */
export function configHash(entry: unknown): string {
  const source = (entry ?? {}) as Record<string, unknown>;
  const defined = Object.fromEntries(DEFINING.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
  return createHash("sha256").update(JSON.stringify(defined, Object.keys(defined).sort())).digest("hex").slice(0, 16);
}

/** What a tool's declaration costs the model's list, as the tool texts test measures it. */
export const declarationTokens = (name: string, description: string, parameters: unknown): number =>
  Math.ceil(`${name}${description}${JSON.stringify(parameters ?? {})}`.length / 4);

let read: { stamp: string; file: CacheFile } | undefined;

function stampOf(file: string): string {
  try {
    const s = statSync(file);
    return `${s.ino}:${s.mtimeMs}:${s.size}`;
  } catch {
    return "-";
  }
}

function parse(raw: unknown): CacheFile {
  const out: CacheFile = { v: 1, servers: {} };
  const servers = (raw as { servers?: unknown } | null)?.servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return out;
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    const entry = value as Partial<CachedServer> | null;
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.tools)) continue;
    const tools: CachedTool[] = [];
    for (const tool of entry.tools as Partial<CachedTool>[]) {
      if (!tool || typeof tool.name !== "string" || typeof tool.original !== "string") continue;
      const description = typeof tool.description === "string" ? tool.description : "";
      tools.push({
        name: tool.name,
        original: tool.original,
        description,
        parameters: tool.parameters ?? { type: "object", properties: {} },
        tokens: typeof tool.tokens === "number" ? tool.tokens : declarationTokens(tool.name, description, tool.parameters),
        ...(tool.annotations && typeof tool.annotations === "object" ? { annotations: tool.annotations } : {}),
      });
    }
    out.servers[name] = { hash: typeof entry.hash === "string" ? entry.hash : "", at: typeof entry.at === "number" ? entry.at : 0, tools };
  }
  return out;
}

function load(): CacheFile {
  const file = mcpToolCachePath();
  const stamp = stampOf(file);
  if (read?.stamp === stamp) return read.file;
  let parsed: CacheFile = { v: 1, servers: {} };
  if (stamp !== "-") {
    try {
      parsed = parse(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      // A file that cannot be read is no cache: it is made again at the next connect.
    }
  }
  read = { stamp, file: parsed };
  return parsed;
}

function save(next: CacheFile): void {
  const file = mcpToolCachePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(next) + "\n", 0o600);
  read = { stamp: stampOf(file), file: next };
}

/** What is known of a server's tools, or undefined where it has never connected. */
export function cachedServer(server: string): CachedServer | undefined {
  const servers = load().servers;
  return Object.hasOwn(servers, server) ? servers[server] : undefined;
}

/** Every server with something cached, by name. */
export function cachedServers(): Record<string, CachedServer> {
  return load().servers;
}

/** Keep what a server offered, as it has just connected. Written only when it differs from what is kept. */
export function rememberServerTools(server: string, hash: string, tools: CachedTool[]): void {
  const now = load();
  const was = now.servers[server];
  const same = was && was.hash === hash && JSON.stringify(was.tools) === JSON.stringify(tools);
  if (same) return;
  save({ v: 1, servers: { ...now.servers, [server]: { hash, at: Date.now(), tools } } });
}

/** Take servers out of the cache, as they leave the configuration. */
export function dropCachedServers(names: readonly string[]): void {
  const now = load();
  const present = names.filter((name) => Object.hasOwn(now.servers, name));
  if (!present.length || !existsSync(mcpToolCachePath())) return;
  const servers = { ...now.servers };
  for (const name of present) delete servers[name];
  save({ v: 1, servers });
}
