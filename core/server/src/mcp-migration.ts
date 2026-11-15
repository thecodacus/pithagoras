import { commandValues, entryProblem, mcpNamespace, mcpToolName, mcpToolNames } from "./mcp-config.js";

/**
 * The migration from `pi-mcp-adapter` to pi's own MCP support (issue 361, PR 4): what the adapter's files and the
 * portal's stored switches said, as pi's MCP support and the portal's marks say it now.
 *
 * The rule for all of it is that a state that meant "off" or "not reachable" stays off. Where a conversion is not
 * certain the server is switched off and named in the report, never left on; a switched-off name that cannot be carried
 * over is never dropped into "on". This module only decides: it is pure, it reads nothing and writes nothing, and the
 * pieces of the portal that hold the stored names (mcp-migration-run.ts) hand each list through it.
 *
 * What the adapter did is written out here from `pi-mcp-adapter` 2.18.0 (types.ts, metadata-cache.ts): an upgrade step
 * does not change with the code after it, and the adapter's vocabulary is gone from the rest of the portal.
 */

export type Naming = "server" | "short" | "mcp" | "none";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((one) => typeof one === "string");

/** The adapter's tool naming of a server (`toolPrefix`): its own, else the one for every server, else `server`; anything it does not know is `server`. */
export function namingOf(entry: Record<string, unknown>, settings: Record<string, unknown>): Naming {
  const given = entry.toolPrefix ?? settings.toolPrefix;
  return given === "none" || given === "short" || given === "mcp" ? given : "server";
}

/** How the adapter starts the names of a server's tools (getServerPrefix). */
export function adapterPrefix(server: string, naming: Naming): string {
  if (naming === "none") return "";
  if (naming === "short") return server.replace(/-?mcp$/i, "").replace(/-/g, "_") || "mcp";
  if (naming === "mcp") return `mcp__${server.replace(/-/g, "_")}`;
  return server.replace(/-/g, "_");
}

/** The name the adapter registered a tool under (formatToolName): its dots as underscores, after the server's prefix. */
export function adapterToolName(tool: string, server: string, naming: Naming): string {
  const prefix = adapterPrefix(server, naming);
  const plain = tool.replace(/\./g, "_");
  return prefix ? `${prefix}_${plain}` : plain;
}

/** The tool name the adapter made of a resource (resourceNameToToolName): the `read_<name>` it registered. */
export function adapterResourceTool(resource: string): string {
  let result = resource
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "")
    .toLowerCase();
  if (!result || /^\d/.test(result)) result = "resource" + (result ? "_" + result : "");
  return `read_${result}`;
}

/** One tool of the adapter's cache entry for a server. */
export interface CachedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  /** Hidden from the model by the server (an MCP App's own tools). */
  appOnly?: boolean;
}

/** What the adapter's `mcp-cache.json` knew of one server: the tools and resources it offered when it last connected. */
export interface CacheServer {
  tools: CachedTool[];
  resources: string[];
}

/** The adapter's cache file, as far as the migration reads it: servers by name. */
export function parseAdapterCache(raw: unknown): Record<string, CacheServer> {
  const out: Record<string, CacheServer> = {};
  const servers = isRecord(raw) ? raw.servers : undefined;
  if (!isRecord(servers)) return out;
  for (const [name, entry] of Object.entries(servers)) {
    if (!isRecord(entry) || !Array.isArray(entry.tools)) continue;
    const tools: CachedTool[] = [];
    for (const tool of entry.tools) {
      if (!isRecord(tool) || typeof tool.name !== "string" || !tool.name) continue;
      const visibility = tool.uiVisibility;
      tools.push({
        name: tool.name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
        ...(Array.isArray(visibility) && !visibility.includes("model") ? { appOnly: true } : {}),
      });
    }
    const resources = Array.isArray(entry.resources) ? entry.resources.flatMap((one) => (isRecord(one) && typeof one.name === "string" && typeof one.uri === "string" && one.name ? [one.name] : [])) : [];
    out[name] = { tools, resources };
  }
  return out;
}

// --- how the adapter matched `includeTools`, `excludeTools` and `approveTools` (types.ts: matchesToolPattern) ---

const normal = (value: string): string => value.replace(/-/g, "_");

const globPattern = (pattern: string): RegExp => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

/** The names the adapter tried a pattern against for one tool: its own, and the registered name in every naming (getToolNameCandidates). */
function candidates(tool: string, server: string, naming: Naming): Set<string> {
  return new Set([tool, adapterToolName(tool, server, naming), adapterToolName(tool, server, "server"), adapterToolName(tool, server, "short"), adapterToolName(tool, server, "mcp")].map(normal));
}

function matchesPatterns(names: Set<string>, patterns: unknown): boolean {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  for (const pattern of patterns) {
    if (typeof pattern !== "string") continue;
    const p = normal(pattern);
    const glob = p.includes("*") || p.includes("?");
    if (!glob && names.has(p)) return true;
    if (glob && [...names].some((name) => globPattern(p).test(name))) return true;
  }
  return false;
}

/** Whether the adapter registered a tool, given its include and exclude lists (isToolAllowed). */
function allowed(tool: string, server: string, naming: Naming, include: unknown, exclude: unknown): boolean {
  const names = candidates(tool, server, naming);
  const included = !Array.isArray(include) || include.length === 0 || matchesPatterns(names, include);
  return included && !matchesPatterns(names, exclude);
}

// --- the entries ---

/** The tools a `directTools` list names: the server's own, else the adapter-wide one. */
function listedDirect(raw: Record<string, unknown>, settings: Record<string, unknown>): string[] {
  const flag = raw.directTools !== undefined ? raw.directTools : settings.directTools;
  return Array.isArray(flag) ? flag.filter((one): one is string => typeof one === "string") : [];
}

/** The keys of an entry that are the adapter's and that pi's MCP support has no word for (`disabled` is kept apart: it is read as off). */
const ADAPTER_KEYS = ["directTools", "includeTools", "excludeTools", "lifecycle", "idleTimeout", "requestTimeoutMs", "exposeResources", "toolPrefix", "approveTools", "debug", "trace", "socket", "bearerToken", "bearerTokenEnv"] as const;

/**
 * The keys of an entry that make it the adapter's and not pi's: those only the adapter knows, its `auth` (a word, where
 * pi's is an object) and an `oauth` that is `false` or has its keys. Not `disabled`, which every reader takes as off.
 * pi ignores them all, which for `includeTools`, `directTools` and the rest is a server more open than it was written, so the
 * portal does not connect an entry that has one (see chatServers).
 */
export function adapterKeysOf(entry: unknown): string[] {
  if (!isRecord(entry)) return [];
  const found: string[] = ADAPTER_KEYS.filter((key) => key in entry);
  if (typeof entry.auth === "string" || entry.auth === false) found.push("auth");
  const oauth = entry.oauth;
  if (oauth === false || (isRecord(oauth) && ["grantType", "authorizationParams", "redirectUri", "clientUri"].some((key) => key in oauth))) found.push("oauth");
  return found;
}

/**
 * Whether an entry is pi's already: it says one of the keys the adapter does not have, and none of the adapter's. Its `socket`
 * is the one key that stays in a converted entry, which is off and kept for the person to see.
 */
export const isNativeEntry = (entry: unknown): boolean =>
  isRecord(entry) && adapterKeysOf(entry).every((key) => key === "socket") && !("disabled" in entry) && ("exposure" in entry || "toolExposure" in entry || "enabled" in entry);

/** What the old config said of one server's tools, and what became of it, for the report. */
export interface ServerPlan {
  /** The name it has in the file now. */
  name: string;
  /** The name pi's MCP support knows it by: `name` with dots as underscores, and a clash told apart. */
  newName: string;
  /** The entry as it is written to the new file: undefined where the old one was no entry at all. */
  entry?: Record<string, unknown>;
  /** The entry was pi's already. */
  native: boolean;
  /** Why the migration switched it off. Empty where it is on, or off because the file said `disabled`. */
  off: string[];
  /** The mark the server gets: the adapter's default was lazy. */
  mark?: "lazy" | "direct";
  /** pi's names of the tools a `directTools` list named, which get the mark `direct` each: the chats go by the marks, not by the file's `toolExposure`. */
  directTools: string[];
  /** What the entry or the adapter's settings asked to be confirmed, as patterns of the server's own tool names. */
  approve: string[];
  /** What was converted and what was dropped, for the report. */
  notes: string[];
  /** The adapter's cache entry for it, where there is one with tools. */
  cache?: CacheServer;
  /** The adapter's way of naming its tools. */
  naming: Naming;
  /** The tool names the server's cache lists, as the server calls them: what pi names `mcp__<server>__<tool>`. */
  tools: string[];
  /** Another server of the file took the namespace first. */
  clash?: string;
}

/** What the adapter's files said, as the migration reads them. */
export interface AdapterState {
  /** mcp.json's `mcpServers`, as written. */
  servers: Record<string, unknown>;
  /** Its `settings`. */
  settings: Record<string, unknown>;
  /** The keys of the file beside `mcpServers`, `settings` and `imports`: kept. */
  extra: Record<string, unknown>;
  /** Its `imports`: the other hosts' configs it read. */
  imports: unknown;
  cache: Record<string, CacheServer>;
  /** Whether the adapter was installed and on. Otherwise no server of the file was reachable, and none is made so. */
  adapter: "on" | "off" | "absent";
}

/** pi's name for a server whose name has a dot, or any other character it does not take: those are underscores. */
const foldedName = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, "_");

/** The `${NAME}` form of the adapter's `$env:NAME` and `{env:NAME}`, the one pi reads. */
const interpolated = (value: string): string => value.replace(/\$env:(\w+)/g, "${$1}").replace(/\{env:(\w+)\}/g, "${$1}");

/** A record of strings with the adapter's variables as pi writes them; a value that is no string is left for the validation to refuse. */
function mapStrings(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, typeof one === "string" ? interpolated(one) : one]));
}

const exposureOf = (entry: Record<string, unknown>): string | undefined => (typeof entry.exposure === "string" ? entry.exposure : undefined);

/** A server's tools the adapter had in its cache and showed the model, by the server's own names. */
const cachedToolNames = (cache: CacheServer | undefined): string[] => [...new Set((cache?.tools ?? []).filter((tool) => !tool.appOnly).map((tool) => tool.name))];

/**
 * One adapter entry as pi's MCP support reads it. `fail` is how a conversion that is not certain says so: the server is
 * written `enabled: false` and the reason is in the report.
 */
function convertEntry(name: string, raw: Record<string, unknown>, state: AdapterState, plan: ServerPlan, newName: string): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  const { notes } = plan;
  const fail = (reason: string) => void plan.off.push(reason);
  const settings = state.settings;
  const take = new Set<string>();
  const copy = (key: string) => {
    if (key in raw) {
      entry[key] = raw[key];
      take.add(key);
    }
  };
  for (const key of ["type", "command", "args", "cwd", "description", "exposure", "toolExposure", "enabled", "timeout"]) copy(key);
  for (const key of ["env", "headers", "oauth"]) take.add(key);
  take.add("url");
  if (typeof raw.url === "string") entry.url = interpolated(raw.url);
  else if ("url" in raw) entry.url = raw.url;
  if (typeof entry.cwd === "string") entry.cwd = interpolated(entry.cwd);
  const env = mapStrings(raw.env);
  if (env) entry.env = env;
  else if ("env" in raw) entry.env = raw.env;
  let headers = mapStrings(raw.headers);
  if ("headers" in raw && !headers) entry.headers = raw.headers;
  if (JSON.stringify(env ?? {}) !== JSON.stringify(raw.env ?? {}) || JSON.stringify(headers ?? {}) !== JSON.stringify(raw.headers ?? {}) || entry.url !== raw.url) notes.push("$env:NAME and {env:NAME} became ${NAME}");

  // The servers that could not be reached any more, and why: nothing the adapter did for them has a counterpart.
  if (typeof raw.socket === "string") {
    fail("it is reached through an rmcp-mux socket, which pi cannot do (stdio and HTTP only)");
    entry.socket = raw.socket;
  }
  take.add("socket");

  if (raw.disabled === true) {
    entry.enabled = false;
    notes.push("disabled: true became enabled: false");
  }
  take.add("disabled");

  // The adapter asked for an OAuth sign-in by itself; pi does, for an HTTP server without an Authorization header.
  const auth = raw.auth;
  const bearer = auth === "bearer";
  if (isRecord(auth)) entry.auth = auth;
  else if (auth === "oauth") notes.push("auth: oauth dropped: pi signs in by itself, and the sign-in has to be made again");
  else if (auth === false) notes.push("auth: false dropped");
  else if (auth !== undefined && auth !== "bearer") notes.push("auth dropped");
  take.add("auth");
  const tokenText = typeof raw.bearerToken === "string" && raw.bearerToken ? interpolated(raw.bearerToken) : undefined;
  const tokenEnv = typeof raw.bearerTokenEnv === "string" && raw.bearerTokenEnv ? raw.bearerTokenEnv : undefined;
  take.add("bearerToken");
  take.add("bearerTokenEnv");
  if (bearer && typeof raw.url === "string") {
    const value = tokenText ?? (tokenEnv ? `\${${tokenEnv}}` : undefined);
    const header = headers && Object.keys(headers).find((key) => key.toLowerCase() === "authorization");
    if (!value) notes.push("auth: bearer without a token dropped");
    else if (tokenText?.startsWith("!")) fail("its bearer token is a command (it starts with !), which pi runs only as a whole header value; check it and switch the server on");
    else if (header) fail("it has an Authorization header and a bearer token, and which one the adapter sent is not known");
    else {
      headers = { ...(headers ?? {}), Authorization: `Bearer ${value}` };
      notes.push("auth: bearer became an Authorization header");
    }
  } else if (bearer || tokenText || tokenEnv) notes.push("a bearer token on a server without an address dropped");
  if (headers) entry.headers = headers;

  // oauth: the keys pi has, carried; the adapter's `redirectUri` where pi can take it; anything else is not certain.
  const oauth = raw.oauth;
  if (oauth === false) notes.push("oauth: false dropped");
  else if (isRecord(oauth)) {
    const converted: Record<string, unknown> = {};
    for (const [key, one] of Object.entries(oauth)) {
      if (["clientId", "clientSecret", "scope", "clientName", "callbackPort", "callbackUrl", "clientRegistration", "authServerMetadataUrl"].includes(key)) converted[key] = typeof one === "string" ? interpolated(one) : one;
      else if (key === "redirectUri" && typeof one === "string" && URL.canParse(one) && new URL(one).protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(one).hostname)) {
        converted.callbackUrl = one;
        notes.push("oauth.redirectUri became oauth.callbackUrl");
      } else fail(`its oauth block has ${key}, which pi has no word for`);
    }
    entry.oauth = converted;
  }

  // The adapter's request timeout in milliseconds is pi's `timeout` in seconds.
  const ms = typeof raw.requestTimeoutMs === "number" && raw.requestTimeoutMs > 0 ? raw.requestTimeoutMs : typeof settings.requestTimeoutMs === "number" && settings.requestTimeoutMs > 0 && !("requestTimeoutMs" in raw) ? settings.requestTimeoutMs : undefined;
  if (ms !== undefined && entry.timeout === undefined) {
    entry.timeout = Math.max(1, Math.ceil(ms / 1000));
    notes.push("requestTimeoutMs became timeout");
  }
  take.add("requestTimeoutMs");

  // What the adapter had for its processes and its own screens.
  for (const key of ["lifecycle", "idleTimeout", "debug", "trace"]) {
    take.add(key);
    if (!(key in raw)) continue;
    if (key === "lifecycle" && (raw.lifecycle === "keep-alive" || raw.lifecycle === "lazy-keep-alive" || raw.lifecycle === "eager")) notes.push(`lifecycle: ${raw.lifecycle} dropped: it has no counterpart, a server starts when a tool of it is first used and stops after ten minutes without use`);
    else notes.push(`${key} dropped`);
  }

  // Which tools the model is shown: include and exclude, evaluated against what the server offered, written as exact names.
  const tools = cachedToolNames(plan.cache);
  const include = raw.includeTools;
  const exclude = raw.excludeTools;
  take.add("includeTools");
  take.add("excludeTools");
  const filtered = (Array.isArray(include) && include.length > 0) || (Array.isArray(exclude) && exclude.length > 0);
  const resources = plan.cache?.resources ?? [];
  const resourceTools = raw.exposeResources === false ? [] : resources.map(adapterResourceTool);
  take.add("exposeResources");
  if (raw.exposeResources === false) fail("it said exposeResources: false, and pi's resource tools reach every resource of an enabled server");
  else if (filtered && resourceTools.some((tool) => !allowed(tool, name, plan.naming, include, exclude))) {
    fail("includeTools or excludeTools held back some of its resources, and pi's resource tools reach every resource of an enabled server");
  }

  // Exposure: the adapter's default was lazy. directTools: true, or the adapter-wide one, is direct; a list names the tools that are.
  take.add("directTools");
  const directFlag = raw.directTools !== undefined ? raw.directTools : settings.directTools;
  const directList = listedDirect(raw, settings);
  const all = directFlag === true;
  let base = exposureOf(raw);
  if (!base) {
    base = all ? "direct" : "deferred";
    entry.exposure = base;
    plan.mark = all ? "direct" : "lazy";
    notes.push(all ? "directTools became exposure: direct" : directList.length ? "directTools named tools became toolExposure: direct" : "no directTools: lazy, as the adapter's default was");
  } else notes.push("exposure was there already: kept");
  const exposure: Record<string, string> = isRecord(raw.toolExposure) ? { ...(raw.toolExposure as Record<string, string>) } : {};
  if (filtered) {
    if (Object.keys(exposure).length) fail("it has includeTools or excludeTools and a toolExposure of its own, and which of them holds a tool back is not certain");
    else if (!tools.length) fail("it has includeTools or excludeTools and the adapter's cache has no list of its tools to apply them to");
    else if (tools.some((tool) => tool.includes("*"))) fail("a tool of it has a * in its name, which toolExposure cannot say exactly");
    else {
      for (const tool of tools) if (allowed(tool, name, plan.naming, include, exclude)) exposure[tool] ??= directList.includes(tool) ? "direct" : base;
      exposure["*"] ??= "hidden";
      notes.push("includeTools and excludeTools became exact toolExposure entries and * hidden");
    }
  } else for (const tool of directList) exposure[tool] ??= "direct";
  if (Object.keys(exposure).length) entry.toolExposure = exposure;

  // Confirmations: per server, else the adapter-wide setting. Written as patterns of the server's own names, wider where it is not certain.
  take.add("approveTools");
  const approveRaw = raw.approveTools !== undefined ? raw.approveTools : settings.approveTools;
  plan.approve = approvePatterns(approveRaw, name, plan.naming, tools);
  if (approveRaw === true || (Array.isArray(approveRaw) && approveRaw.length)) notes.push("approveTools became a confirmation for each call of the tools it named");

  take.add("toolPrefix");
  if ("toolPrefix" in raw || "toolPrefix" in settings) notes.push(`toolPrefix ${plan.naming} dropped: its tools are named mcp__${newName}__<tool>`);

  // What is left of the entry is carried as it is: pi ignores a key it does not know.
  for (const key of Object.keys(raw)) if (!take.has(key)) entry[key] = raw[key];

  for (const place of commandValues(entry)) fail(`${place} starts with !, which pi runs as a command, and the adapter's file never asked it to`);
  const problem = entryProblem(newName, entry);
  if (problem) fail(`pi would skip it: ${problem.replace(`server "${newName}": `, "").replace(`server "${newName}" `, "")}`);
  return entry;
}

/** The patterns an `approveTools` value asks for, as patterns of the server's own tool names: wider than the adapter's wherever pi's `*` cannot say what it said. */
function approvePatterns(value: unknown, server: string, naming: Naming, tools: string[]): string[] {
  if (value === true) return ["*"];
  if (!isStrings(value) || value.length === 0) return [];
  const found = new Set<string>();
  const prefixes = (["server", "short", "mcp", "none"] as Naming[]).map((mode) => adapterPrefix(server, mode)).filter(Boolean);
  for (const pattern of value) {
    // The pattern as the adapter matched it (the tool's own name, or the one it registered): by the names the cache knows, exactly.
    for (const tool of tools) if (matchesPatterns(candidates(tool, server, naming), [pattern])) found.add(tool);
    // And for the tools it does not know yet, as a pattern: with the adapter's prefix taken off, `?` as `*`, and hyphen and underscore, which the adapter matched alike, as `*`.
    // The prefix as the adapter matched it, hyphen and underscore alike: `gh-mcp_delete_*` is a pattern of `gh_mcp`'s tools.
    const alike = pattern.replace(/-/g, "_");
    const stripped = prefixes.map((prefix) => (alike.startsWith(`${prefix.replace(/-/g, "_")}_`) ? pattern.slice(prefix.length + 1) : undefined)).filter((one): one is string => one !== undefined);
    for (const form of [pattern, ...stripped]) found.add(form.replace(/\?/g, "*").replace(/[-_]/g, "*").replace(/\*+/g, "*"));
  }
  return [...found].filter((one) => one && one !== "").sort();
}

/** What a stored name came to. */
export type Verdict =
  /** Not an MCP tool's name (or already pi's): as it is. */
  | { kind: "keep" }
  | { kind: "map"; to: string; server: string }
  /** The adapter's `mcp`, `mcp_script` or the gateway `tools`: it stands for tools, and is expanded where it is stored. */
  | { kind: "wrapper"; wrapper: "mcp" | "tools" }
  /** A name of the server's resources (`read_<name>`): pi's resource tools reach every server's, and none of them is this name. */
  | { kind: "resource"; servers: string[] }
  /** It looks like a tool of these servers' and cannot be told which tool: no cache lists it, or two tools have it. */
  | { kind: "unknown"; servers: string[]; why: string };

/** The adapter's wrapper tools, by the name they were stored under. */
const MCP_WRAPPERS = ["mcp", "mcp_script", "mcpScript"];
const GATEWAY = "tools";

/** A name the migration leaves alone because it is the portal's or pi's own tool, however its start looks. */
export interface Known {
  /** Tools the portal has seen that the adapter did not bring: their names mean what they say. */
  normal: ReadonlySet<string>;
}

/** The two-sided view of the old and the new world: every server the adapter knew, by its old name, and what its tools are called. */
export class Names {
  private readonly byAdapter = new Map<string, { server: string; tool?: string; native?: string; resource: boolean }[]>();
  private readonly nativeOf = new Map<string, Map<string, string>>();
  private readonly nativeNames = new Set<string>();
  private readonly prefixed: { server: string; prefix: string }[] = [];
  /** The servers whose tools the adapter named with no prefix at all (`toolPrefix: "none"`): any name may be one of theirs. */
  private readonly bare: string[] = [];
  /** Native names more than one tool of any server would get: carried over for none. */
  private readonly shared = new Set<string>();

  constructor(
    servers: readonly { name: string; newName: string; naming: Naming; cache?: CacheServer; exposeResources: boolean }[],
    private readonly known: Known,
  ) {
    const made = new Map<string, number>();
    for (const server of servers) {
      const tools = cachedToolNames(server.cache);
      const natives = mcpToolNames(server.newName, tools);
      this.nativeOf.set(server.name, natives);
      for (const native of natives.values()) made.set(native, (made.get(native) ?? 0) + 1);
    }
    for (const [native, count] of made) if (count > 1) this.shared.add(native);
    for (const server of servers) {
      const natives = this.nativeOf.get(server.name)!;
      for (const [tool, native] of natives) {
        this.add(adapterToolName(tool, server.name, server.naming), { server: server.name, tool, native, resource: false });
        this.nativeNames.add(native);
      }
      if (server.exposeResources) for (const resource of server.cache?.resources ?? []) this.add(adapterToolName(adapterResourceTool(resource), server.name, server.naming), { server: server.name, resource: true });
      // A name that starts as the server's tools do, whichever tool it is the end of: in the naming it had, and in the default one.
      for (const prefix of new Set([adapterPrefix(server.name, server.naming), adapterPrefix(server.name, "server")])) if (prefix) this.prefixed.push({ server: server.name, prefix });
      if (server.naming === "none") this.bare.push(server.name);
    }
  }

  private add(name: string, target: { server: string; tool?: string; native?: string; resource: boolean }): void {
    const list = this.byAdapter.get(name) ?? [];
    if (!list.some((one) => one.server === target.server && one.tool === target.tool && one.resource === target.resource)) list.push(target);
    this.byAdapter.set(name, list);
  }

  /** The names pi gives the tools of all the servers the cache lists. */
  all(): string[] {
    return [...this.nativeNames].sort();
  }

  /** Every name the adapter registered a tool of a server under that has a server's name in it, for scanning texts that still use them. */
  oldNames(): string[] {
    return [...this.byAdapter.keys()].filter((name) => name.includes("_") && name.length >= 8);
  }

  /** The native names of a server's tools, by the server's name in the old file. */
  of(server: string): string[] {
    return [...(this.nativeOf.get(server)?.values() ?? [])];
  }

  /** The native name of one tool of a server, where it has one that no other tool shares. */
  nativeName(server: string, tool: string): string | undefined {
    const native = this.nativeOf.get(server)?.get(tool);
    return native && !this.shared.has(native) ? native : undefined;
  }

  verdict(name: string): Verdict {
    if (MCP_WRAPPERS.includes(name)) return { kind: "wrapper", wrapper: "mcp" };
    if (name === GATEWAY) return { kind: "wrapper", wrapper: "tools" };
    if (this.nativeNames.has(name)) return { kind: "keep" };
    const found = this.byAdapter.get(name);
    const normal = this.known.normal.has(name);
    if (found && !normal) {
      const servers = [...new Set(found.map((one) => one.server))];
      if (found.length === 1) {
        const one = found[0];
        if (one.resource) return { kind: "resource", servers };
        const native = this.nativeName(one.server, one.tool!);
        if (native) return { kind: "map", to: native, server: one.server };
        return { kind: "unknown", servers, why: "another tool is named the same by pi" };
      }
      return { kind: "unknown", servers, why: "the adapter's name is the name of tools of more than one server" };
    }
    if (found && normal) return { kind: "unknown", servers: [...new Set(found.map((one) => one.server))], why: "a tool of another package has the same name" };
    if (normal) return { kind: "keep" };
    // Before pi's own `mcp__` names: the adapter's `toolPrefix: "mcp"` named tools `mcp__<server>_<tool>`.
    const claimed = [...new Set(this.prefixed.filter((one) => name.startsWith(`${one.prefix}_`)).map((one) => one.server))];
    if (claimed.length) return { kind: "unknown", servers: claimed, why: "no cache of the adapter lists a tool of that name" };
    if (name.startsWith("mcp__")) return { kind: "keep" };
    if (this.bare.length) return { kind: "unknown", servers: [...this.bare], why: "no cache of the adapter lists a tool of that name, and the adapter named these servers' tools with no prefix" };
    return { kind: "keep" };
  }
}

/** One place the migration did something about, for the report. */
export interface Item {
  where: string;
  name: string;
  why: string;
}

/** What the person is told after the migration. */
export interface Report {
  v: 1;
  /** `pending`: the file could not be read, and nothing was changed; the next start tries again. */
  status: "done" | "pending";
  at: string;
  adapter: { was: AdapterState["adapter"]; removed: boolean; spec?: string; note?: string };
  /** `written`: a hash of the mcp.json this run wrote, which tells a run that stopped after writing it from a file the person put back. */
  file: { state: "converted" | "none" | "unreadable"; copy?: string; note?: string; written?: string };
  servers: { name: string; renamedTo?: string; state: "on" | "off" | "native"; why: string[]; notes: string[] }[];
  /** Names carried over, and where each kind of place held them. */
  names: { converted: number };
  /** What stood for tools and was expanded: `mcp` and `tools` switched off in a place, by the number of names it became. */
  expanded: { where: string; wrapper: string; count: number }[];
  /** What could not be carried over, and what happened to it. */
  unconverted: Item[];
  /** Servers whose trust did not follow: its rename was not certain. */
  untrusted: string[];
  /** Stored texts that still name the old tools: scanned, not changed. */
  texts: { where: string; names: string[] }[];
  /** Folders that bring their own MCP configuration or the adapter. */
  projects: { folder: string; adapterSettings: boolean; mcpJson: boolean; foreign: string[] }[];
  /** What the old file said beside its servers, which has no counterpart. */
  gone: string[];
  notes: string[];
}

export interface Options {
  state: AdapterState;
  known: Known;
  /** The names of the tools that were lazy-only: reached by the gateway `tools`, not by the model's list. */
  lazyOnly: readonly string[];
}

/** How many of each kind of item a report keeps in full: a portal with thousands of chats has a line for the rest. */
const REPORT_ITEMS = 200;

export class McpMigration {
  readonly servers: ServerPlan[] = [];
  private readonly names: Names;
  private readonly blocked = new Map<string, Set<string>>();
  private readonly renames = new Map<string, string>();
  private readonly expanded: Report["expanded"] = [];
  private readonly unconverted: Item[] = [];
  private more = 0;
  private converted = 0;
  private readonly lazyOnly: readonly string[];
  private readonly state: AdapterState;

  constructor(options: Options) {
    this.state = options.state;
    this.lazyOnly = options.lazyOnly;
    const { state } = options;
    // The namespaces of the entries that are pi's already, first: they keep their names, so a folded name of the adapter's
    // that meets one is the one renamed, wherever it stands in the file. And every namespace the file has, which a `_N` name must not take either.
    const taken = new Map<string, string>();
    for (const [name, raw] of Object.entries(state.servers)) if (isNativeEntry(raw) && !taken.has(mcpNamespace(name))) taken.set(mcpNamespace(name), name);
    const inFile = new Set(Object.keys(state.servers).flatMap((name) => [mcpNamespace(name), mcpNamespace(foldedName(name))]));
    const used = new Set<string>();
    const known: { name: string; newName: string; naming: Naming; cache?: CacheServer; exposeResources: boolean }[] = [];
    for (const [name, raw] of Object.entries(state.servers)) {
      const entry = isRecord(raw) ? raw : {};
      const naming = namingOf(entry, state.settings);
      // The adapter keyed its cache by the name a server had; a file converted once has the renamed one.
      const cacheKey = Object.hasOwn(state.cache, name) ? name : Object.keys(state.cache).find((key) => foldedName(key) === name && !Object.hasOwn(state.servers, key));
      if (cacheKey !== undefined) used.add(cacheKey);
      const found = cacheKey === undefined ? undefined : state.cache[cacheKey];
      const cache = found?.tools.length ? found : undefined;
      // An entry that is pi's already is left under the name it has: what pi takes or refuses of it is pi's to say. It still holds its namespace.
      const native = isNativeEntry(raw);
      let newName = native ? name : foldedName(name);
      let clash: string | undefined;
      const space = mcpNamespace(newName);
      const holder = taken.get(space);
      if (!native && holder !== undefined && holder !== name) {
        clash = holder;
        for (let n = 2; ; n++) {
          const next = `${newName}_${n}`;
          if (!taken.has(mcpNamespace(next)) && !inFile.has(mcpNamespace(next))) {
            newName = next;
            break;
          }
        }
      }
      if (!taken.has(mcpNamespace(newName))) taken.set(mcpNamespace(newName), name);
      const plan: ServerPlan = { name, newName, native: false, off: [], approve: [], notes: [], naming, tools: cachedToolNames(cache), directTools: [], ...(cache ? { cache } : {}), ...(clash ? { clash } : {}) };
      if (newName !== name) {
        this.renames.set(name, newName);
        plan.notes.push(clash ? `renamed to ${newName}: pi takes - and _ for the same, and ${clash} has the name` : `renamed to ${newName}: pi's server names have no dots`);
      }
      if (clash) plan.off.push(`pi would take it for ${clash}, which has the name first; it was renamed ${newName} and is off until you choose which one stays`);
      this.servers.push(plan);
      known.push({ name, newName, naming, ...(cache ? { cache } : {}), exposeResources: !(isRecord(raw) && raw.exposeResources === false) });
    }
    // A server only the adapter's cache knows (removed from the file, imported from another host's config): its names are still told, under the name it had.
    for (const [name, cache] of Object.entries(state.cache)) {
      if (Object.hasOwn(state.servers, name) || used.has(name) || !cache.tools.length) continue;
      known.push({ name, newName: foldedName(name), naming: namingOf({}, state.settings), cache, exposeResources: true });
    }
    this.names = new Names(known, options.known);
    for (const plan of this.servers) {
      const raw = state.servers[plan.name];
      if (!isRecord(raw)) {
        plan.off.push("it is not an object");
        plan.notes.push("not an entry: left out of the file");
        continue;
      }
      // The portal reached no server but through the adapter, whatever keys its entry has: with the adapter off or absent, none was reachable.
      const unreachable = state.adapter === "off" ? "the adapter was switched off, and with it every server of the file" : state.adapter === "absent" ? "the adapter was not installed, so none of the servers was reachable" : undefined;
      if (isNativeEntry(raw)) {
        plan.native = true;
        plan.entry = { ...raw };
        if (unreachable) plan.off.push(unreachable);
        // The adapter ran no `!` value: pi would run it at the first start, as the portal's user.
        for (const place of commandValues(plan.entry)) plan.off.push(`${place} starts with !, which pi runs as a command, and the adapter never ran it`);
        const problem = entryProblem(plan.newName, plan.entry);
        if (problem) plan.off.push(`pi would skip it: ${problem}`);
        continue;
      }
      if (unreachable) plan.off.push(unreachable);
      plan.entry = convertEntry(plan.name, raw, state, plan, plan.newName);
      // The tools a `directTools` list named stay in the model's list: by their own mark, as the chats go by the marks.
      const exposure = isRecord(plan.entry.toolExposure) ? plan.entry.toolExposure : {};
      if (plan.mark !== "direct") {
        for (const tool of listedDirect(raw, state.settings)) {
          if (exposure[tool] !== "direct") continue;
          const native = this.names.nativeName(plan.name, tool) ?? (plan.tools.includes(tool) ? undefined : mcpToolName(plan.newName, tool));
          if (native) plan.directTools.push(native);
        }
      }
    }
  }

  /** The servers and what they are called in the file now, by their old names: only those that changed. */
  renamed(): ReadonlyMap<string, string> {
    return this.renames;
  }

  /** The plan of a server, by its name in the old file. */
  server(name: string): ServerPlan | undefined {
    return this.servers.find((one) => one.name === name);
  }

  /** The name a set of tools (a server) goes by now. */
  setName(name: string): string {
    return this.renames.get(name) ?? name;
  }

  /** The native names of every tool of every server the cache lists. */
  allTools(): string[] {
    return this.names.all();
  }

  /** The native names of one server's tools, by the name of the server in the old file. */
  toolsOf(server: string): string[] {
    return this.names.of(server);
  }

  /** What a stored tool name came to. */
  verdict(name: string): Verdict {
    return this.names.verdict(name);
  }

  /** The names the adapter gave tools that texts may still use. */
  oldNames(): string[] {
    return this.names.oldNames();
  }

  /** The name pi gives one tool of a server (by the server's name in the old file and the tool's own), where it is the only tool that has it. */
  nativeName(server: string, tool: string): string | undefined {
    return this.names.nativeName(server, tool);
  }

  /** Switch a server off, and say why: for a stored name or mark that could not be carried over, and for every server a wrapper's switch could not reach. */
  block(server: string, why: string): void {
    const reasons = this.blocked.get(server) ?? new Set<string>();
    if (reasons.size < 20) reasons.add(why);
    this.blocked.set(server, reasons);
  }

  private report(item: Item): void {
    if (this.unconverted.length < REPORT_ITEMS) this.unconverted.push(item);
    else this.more++;
  }

  /**
   * A list of tool names stored in a place (`off`, `on`: what a layer says of tools), carried over. `off` is a switch: a name
   * that cannot be mapped is never dropped into on, so each server it might be a tool of is switched off. `on` is an
   * exception to a default, and the default is off or on for the name that remains, so a name it cannot carry is dropped.
   */
  list(where: string, kind: "off" | "on", names: readonly string[]): string[] {
    const out = new Set<string>();
    for (const name of names) {
      const verdict = this.names.verdict(name);
      switch (verdict.kind) {
        case "keep":
          out.add(name);
          break;
        case "map":
          out.add(verdict.to);
          this.converted++;
          break;
        case "wrapper": {
          out.add(name);
          const expanded = verdict.wrapper === "mcp" ? this.names.all() : [...this.lazyOnly];
          for (const one of expanded) out.add(one);
          if (this.expanded.length < REPORT_ITEMS) this.expanded.push({ where, wrapper: name, count: expanded.length });
          // Tools of a server the adapter's cache does not list are not among those, and are reachable: that server is not.
          if (verdict.wrapper === "mcp" && kind === "off") for (const plan of this.servers) if (!plan.tools.length) this.block(plan.name, `"${name}" was switched off in ${where}, which cannot be carried to the tools of a server that has not run`);
          break;
        }
        case "resource":
          out.add(name);
          for (const server of verdict.servers) {
            if (kind === "off") this.block(server, `${name}, one of its resources' tools, was switched off in ${where}`);
          }
          this.report({ where, name, why: kind === "off" ? "a resource's tool has no counterpart: its server is switched off" : "a resource's tool has no counterpart" });
          break;
        case "unknown":
          out.add(name);
          if (kind === "off") for (const server of verdict.servers) this.block(server, `${name}, switched off in ${where}, could not be carried over: ${verdict.why}`);
          this.report({ where, name, why: kind === "off" ? `not carried over (${verdict.why}): ${verdict.servers.join(", ")} switched off` : `not carried over (${verdict.why}), left as it was` });
          break;
      }
    }
    return [...out];
  }

  /** A list that names tools and sets together (a mode's or an agent's tools kept in the list, the marks): servers follow their renames, tools their names. */
  entries(where: string, names: readonly string[]): string[] {
    const out = new Set<string>();
    for (const name of names) {
      if (name.startsWith("<tool>")) {
        const bare = name.slice("<tool>".length);
        const verdict = this.names.verdict(bare);
        if (verdict.kind === "map") out.add(`<tool>${verdict.to}`);
        else if (verdict.kind === "keep" || verdict.kind === "wrapper") out.add(name);
        else this.report({ where, name: bare, why: "a mark on an MCP tool could not be carried over" });
      } else out.add(this.setName(name));
    }
    return [...out];
  }

  /** A trusted server list: those whose name changed follow it, unless it was not certain which server it was. */
  trusted(names: readonly string[]): { names: string[]; untrusted: string[] } {
    const out: string[] = [];
    const untrusted: string[] = [];
    for (const name of names) {
      const plan = this.server(name);
      if (plan?.clash) untrusted.push(name);
      else out.push(this.setName(name));
    }
    return { names: out, untrusted };
  }

  /** The report's line for a name that was dropped: for the places the runner handles itself (rules, tools seen). */
  note(item: Item): void {
    this.report(item);
  }

  /** A name converted outside `list`: counted. */
  counted(n = 1): void {
    this.converted += n;
  }

  /** The new file, and the report so far. A server is written off where the migration or a stored name made it so. */
  finish(): { mcpServers: Record<string, unknown>; extra: Record<string, unknown>; servers: Report["servers"]; expanded: Report["expanded"]; unconverted: Item[]; names: Report["names"]; gone: string[] } {
    const mcpServers: Record<string, unknown> = {};
    const servers: Report["servers"] = [];
    for (const plan of this.servers) {
      const why = [...plan.off, ...[...(this.blocked.get(plan.name) ?? [])]];
      if (plan.entry) {
        const entry = { ...plan.entry };
        if (why.length) entry.enabled = false;
        mcpServers[plan.newName] = entry;
      }
      const wasOff = isRecord(this.state.servers[plan.name]) && (this.state.servers[plan.name] as Record<string, unknown>).disabled === true;
      servers.push({ name: plan.name, ...(plan.newName !== plan.name ? { renamedTo: plan.newName } : {}), state: why.length || wasOff ? "off" : plan.native ? "native" : "on", why, notes: plan.notes });
    }
    const gone: string[] = [];
    if (Object.keys(this.state.settings).length) gone.push(`settings: ${Object.keys(this.state.settings).join(", ")}`);
    if (Array.isArray(this.state.imports) && this.state.imports.length) gone.push(`imports: ${this.state.imports.filter((one): one is string => typeof one === "string").join(", ")}; servers of those hosts' own configs are not read any more`);
    return {
      mcpServers,
      extra: this.state.extra,
      servers,
      expanded: this.expanded,
      unconverted: this.more ? [...this.unconverted, { where: "more", name: `${this.more} more`, why: "not listed" }] : this.unconverted,
      names: { converted: this.converted },
      gone,
    };
  }
}
