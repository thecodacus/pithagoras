/**
 * Whether the MCP adapter still offers a tool, as its configuration and its
 * cache stand now, and which tools each server offers at all.
 *
 * The portal remembers every tool a chat reported (`tools_seen`), so that a
 * default can be set without a chat being open. The adapter does not register
 * a tool by what the portal remembers: it registers a server's tools directly
 * from its own cache file (`mcp-cache.json`), and only those its configuration
 * still allows. A server switched off, a tool left out by `Only these tools` or
 * `Except these tools`, a tool the server no longer has: each is a tool the portal went on listing,
 * and a chat that had it loaded went on offering, after the configuration had
 * said no. This is where that is read, kept apart from the files so the rule
 * can be tested on its own.
 *
 * An MCP server is a group of tools like any other: switched on or off as a
 * whole, or tool by tool. Whether the adapter registers a server's tools one by
 * one (`directTools`) or reaches them only through its `mcp` tool is how the
 * model is offered them, not whether they are there: `mcpCatalogue` lists every
 * tool of every server from the adapter's cache either way, and a switch holds
 * for both ways in (see switchedOffVia in pi/guard.ts).
 *
 * Only for the `server` prefix the adapter uses by default, which is the one
 * `mcpServerOf` can tell a server's tools by. A server named another way is not
 * judged here, and its tools are left as they are.
 */
import { mcpServerOf } from "./tool-policy.js";

export interface McpConfigLike {
  mcpServers?: Record<string, Record<string, unknown>>;
  settings?: Record<string, unknown>;
}

export interface McpCacheLike {
  servers?: Record<string, { tools?: unknown; resources?: unknown } | undefined>;
}

/**
 * - `offered`: the adapter registers it, from a server it starts with the chat.
 * - `cached`: the adapter registers it from its cache, for a server it starts
 *   only when a tool of it is first used: what is listed is what the server had
 *   when it last ran.
 * - `withdrawn`: the configuration says no to it: its server is switched off,
 *   `Only these tools` or `Except these tools` leave it out, or its server no
 *   longer has it. The adapter's own `mcp` tool does not reach it either.
 */
export type McpOffer = "offered" | "cached" | "withdrawn";

/** Not a tool to list: the configuration said no to it. */
export const unlisted = (offer: McpOffer | undefined): boolean => offer === "withdrawn";

/** The adapter writes a tool's name with its dots as underscores. */
const sanitized = (name: string): string => name.replace(/\./g, "_");
const normalized = (name: string): string => name.replace(/-/g, "_");

/** As the adapter makes a resource's name a tool's (resource-tools.ts). */
function resourceTool(name: string): string {
  let result = name
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "")
    .toLowerCase();
  if (!result || /^\d/.test(result)) result = "resource" + (result ? "_" + result : "");
  return `read_${result}`;
}

function globMatches(pattern: string, candidate: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(candidate);
}

/** As the adapter matches `includeTools` and `excludeTools`: the bare name or the prefixed one, hyphens as underscores. */
function matchesAny(patterns: unknown, candidates: string[]): boolean {
  if (!Array.isArray(patterns)) return false;
  const names = candidates.map(normalized);
  return patterns.some((pattern) => {
    if (typeof pattern !== "string") return false;
    const p = normalized(pattern);
    return p.includes("*") || p.includes("?") ? names.some((name) => globMatches(p, name)) : names.includes(p);
  });
}

/** A tool of a server's cache entry: the name the adapter registers it under (without the prefix), the server's own, and what it says it does. */
interface CachedTool {
  bare: string;
  original: string;
  description?: string;
}

/**
 * The tools a server's cache entry lists, as the adapter would register them,
 * or undefined where there is no entry to go by. The adapter writes an entry
 * only once it has connected, with all the server has; one that lists nothing
 * at all is taken as nothing to go by rather than as a server without tools,
 * which would have every tool of it withdrawn.
 */
function cachedTools(entry: { tools?: unknown; resources?: unknown } | undefined, definition: Record<string, unknown>): Map<string, CachedTool> | undefined {
  if (!entry || !Array.isArray(entry.tools)) return undefined;
  const out = new Map<string, CachedTool>();
  const add = (bare: string, original: string, description: unknown) =>
    out.set(bare, { bare, original, ...(typeof description === "string" && description.trim() ? { description: description.trim().slice(0, 300) } : {}) });
  for (const tool of entry.tools) {
    const t = tool as { name?: unknown; description?: unknown } | null;
    if (typeof t?.name === "string") add(sanitized(t.name), t.name, t.description);
  }
  if (definition.exposeResources !== false && Array.isArray(entry.resources)) {
    for (const resource of entry.resources) {
      const r = resource as { name?: unknown; description?: unknown } | null;
      if (typeof r?.name === "string") add(resourceTool(r.name), r.name, r.description);
    }
  }
  return out.size ? out : undefined;
}

const prefixOf = (definition: Record<string, unknown>, settings: Record<string, unknown>): unknown =>
  definition.toolPrefix ?? settings.toolPrefix ?? "server";

/**
 * What the adapter does with a tool of this name, or undefined for a name no
 * configured server claims. The caller says which names are the adapter's: a
 * server's name is also the start of other tools' (`web` and `web_search`).
 */
export function mcpOffer(config: McpConfigLike, cache: McpCacheLike | null): (name: string) => McpOffer | undefined {
  const servers = config.mcpServers ?? {};
  const settings = config.settings ?? {};
  const names = Object.keys(servers);
  // Each server's entry walked once, not once per tool asked about.
  const tools = new Map<string, Map<string, CachedTool> | undefined>();
  const toolsOf = (server: string, definition: Record<string, unknown>) => {
    if (!tools.has(server)) tools.set(server, cachedTools(cache?.servers?.[server], definition));
    return tools.get(server);
  };
  return (name) => {
    const server = mcpServerOf(name, names);
    if (server === undefined) return undefined;
    const definition = servers[server] ?? {};
    if (prefixOf(definition, settings) !== "server") return undefined;
    const bare = name.slice(server.replace(/-/g, "_").length + 1);

    if (definition.disabled === true) return "withdrawn";

    // The cache is what the adapter registers from. A server it has an entry
    // for and which no longer lists the tool does not have it any more; one it
    // has none for is not judged on that.
    const listed = toolsOf(server, definition);
    const tool = listed?.get(bare);
    if (listed && !tool) return "withdrawn";

    // As the adapter matches them: the server's own name for the tool (dots and
    // all), the one it registers, and the prefixed one.
    const candidates = [...new Set([tool?.original ?? bare, bare, name])];
    if (Array.isArray(definition.includeTools) && definition.includeTools.length && !matchesAny(definition.includeTools, candidates)) {
      return "withdrawn";
    }
    if (matchesAny(definition.excludeTools, candidates)) return "withdrawn";

    const lifecycle = definition.lifecycle ?? "lazy";
    return listed && (lifecycle === "lazy" || lifecycle === "lazy-keep-alive") ? "cached" : "offered";
  };
}

/**
 * Every tool of every server the configuration has on, as the adapter's cache
 * lists them, with the name the adapter gives it (`<server>_<tool>`): what the
 * tool lists show of a server, whether the model is offered its tools one by
 * one or through `mcp`. Less what the configuration says no to. A server that
 * has never run has nothing in the cache, and nothing to list until it has.
 */
export function mcpCatalogue(config: McpConfigLike, cache: McpCacheLike | null): { name: string; server: string; description?: string; offer: McpOffer }[] {
  const servers = config.mcpServers ?? {};
  const settings = config.settings ?? {};
  const names = Object.keys(servers);
  const offer = mcpOffer(config, cache);
  const out: { name: string; server: string; description?: string; offer: McpOffer }[] = [];
  for (const [server, definition] of Object.entries(servers)) {
    if (prefixOf(definition ?? {}, settings) !== "server") continue;
    const prefix = server.replace(/-/g, "_");
    for (const { bare, description } of cachedTools(cache?.servers?.[server], definition ?? {})?.values() ?? []) {
      const name = `${prefix}_${bare}`;
      // Claimed by a server with a longer name, whose tool it would be taken for.
      if (mcpServerOf(name, names) !== server) continue;
      const state = offer(name);
      if (state === undefined || state === "withdrawn") continue;
      out.push({ name, server, ...(description ? { description } : {}), offer: state });
    }
  }
  return out;
}
