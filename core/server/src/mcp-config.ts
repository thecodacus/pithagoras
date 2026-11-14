import { createHash } from "node:crypto";
import { mcpNamespace } from "./pi/mcp-origin.js";

/**
 * The shape of one server of pi's mcp.json, and the names pi gives its tools.
 *
 * pi 1.1 validates the file when it loads it, but `validateMcpServerConfig` and `createMcpToolName` are not exported from
 * its package (`exports` has only `.`), and `loadConfig`, the seam the portal uses, hands pi entries that must already be
 * valid. So the rules are written here again, and `tests/mcp-config.test.mts` feeds them pi's own examples and runs a real
 * pi against them, so that a pi that moves them fails a test and not a person's server.
 *
 * Pure, and in a module of its own: the routes, the runtime, the migration and the tests read it, and none of them may wait
 * on the database.
 */

/** The names a server may have: letters, digits, `_` and `-`. */
export const SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/;

export type Exposure = "codemode" | "deferred" | "direct" | "hidden";
export const EXPOSURES: readonly Exposure[] = ["codemode", "deferred", "direct", "hidden"];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStringRecord = (value: unknown): boolean => isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");

/** An older name for an exposure, which pi still reads. */
const ALIASES: Record<string, string> = { "codemode-deferred": "codemode" };
const resolved = (value: unknown): unknown => (typeof value === "string" ? (ALIASES[value] ?? value) : value);
const isExposure = (value: unknown): value is Exposure => typeof value === "string" && (EXPOSURES as readonly string[]).includes(value);

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

/** Whether a redirect address can be served by pi's callback server on this machine. */
function isLoopbackRedirect(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "http:" && LOOPBACK.includes(url.hostname) && url.search === "" && url.hash === "";
}

function oauthProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return "oauth must be an object";
  if (value.clientId !== undefined && typeof value.clientId !== "string") return "oauth.clientId must be a string";
  if (value.clientSecret !== undefined && typeof value.clientSecret !== "string") return "oauth.clientSecret must be a string";
  const port = value.callbackPort;
  if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) return "oauth.callbackPort must be a port number";
  if (value.callbackUrl !== undefined) {
    if (typeof value.callbackUrl !== "string" || !isLoopbackRedirect(value.callbackUrl)) {
      return "oauth.callbackUrl must be an http address on localhost, 127.0.0.1 or [::1], without query or fragment";
    }
    const urlPort = new URL(value.callbackUrl).port;
    if (urlPort && port !== undefined && Number(urlPort) !== port) return "oauth.callbackUrl and oauth.callbackPort name different ports";
  }
  if (value.scope !== undefined && typeof value.scope !== "string") return "oauth.scope must be a string";
  if (value.clientName !== undefined && (typeof value.clientName !== "string" || !value.clientName.trim())) return "oauth.clientName must be a non-empty string";
  if (value.clientRegistration !== undefined && value.clientRegistration !== "dcr") {
    if (value.clientRegistration !== "cimd") return 'oauth.clientRegistration must be "dcr" or "cimd"';
    if (value.clientId !== undefined || value.clientName !== undefined) return 'oauth.clientRegistration "cimd" cannot be combined with oauth.clientId or oauth.clientName';
    const callback = typeof value.callbackUrl === "string" ? new URL(value.callbackUrl) : undefined;
    if (callback && (callback.hostname === "[::1]" || callback.pathname !== "/callback")) {
      return 'oauth.clientRegistration "cimd" needs oauth.callbackUrl on localhost or 127.0.0.1 with the path /callback';
    }
  }
  const metadata = value.authServerMetadataUrl;
  if (metadata !== undefined) {
    const url = typeof metadata === "string" && URL.canParse(metadata) ? new URL(metadata) : undefined;
    if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.includes(url.hostname)))) {
      return "oauth.authServerMetadataUrl must be an https address, or http on localhost, 127.0.0.1 or [::1]";
    }
  }
  return undefined;
}

/**
 * Why this is not a server pi would connect, or null where it is: the rules of pi's `validateMcpServerConfig`, which skips
 * an entry that breaks one and says so. `name` is the one it has in the file.
 */
export function entryProblem(name: string, raw: unknown): string | null {
  if (!SERVER_NAME_RE.test(name)) return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
  if (!isRecord(raw)) return `server "${name}" must be an object`;
  const { type, enabled, timeout, description } = raw;
  const exposure = resolved(raw.exposure);
  const toolExposure = raw.toolExposure;
  const list = EXPOSURES.map((one) => `"${one}"`).join(", ");
  if (exposure !== undefined && !isExposure(exposure)) return `server "${name}": exposure must be one of ${list}`;
  if (toolExposure !== undefined) {
    if (!isRecord(toolExposure)) return `server "${name}": toolExposure must map tool names to exposures`;
    for (const [tool, one] of Object.entries(toolExposure)) {
      if (!isExposure(resolved(one))) return `server "${name}": toolExposure "${tool}" must be one of ${list}`;
    }
  }
  if (enabled !== undefined && typeof enabled !== "boolean") return `server "${name}": enabled must be a boolean`;
  if (description !== undefined && typeof description !== "string") return `server "${name}": description must be a string`;
  if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) return `server "${name}": timeout must be a positive number of seconds`;
  if (type === "sse") return `server "${name}": the legacy SSE transport is not supported; use the streamable HTTP address`;
  if (typeof raw.url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
    if (!URL.canParse(raw.url) || !/^https?:$/.test(new URL(raw.url).protocol)) return `server "${name}": url must be an http or https address`;
    if (raw.headers !== undefined && !isStringRecord(raw.headers)) return `server "${name}": headers must map names to strings`;
    const oauth = oauthProblem(raw.oauth);
    if (oauth) return `server "${name}": ${oauth}`;
    if (raw.auth !== undefined) {
      if (!isRecord(raw.auth) || typeof raw.auth.provider !== "string" || !raw.auth.provider) return `server "${name}": auth.provider must be a provider name`;
      const url = new URL(raw.url);
      if (url.protocol !== "https:" && !LOOPBACK.includes(url.hostname)) return `server "${name}": auth needs an https address, or http on localhost, 127.0.0.1 or [::1]`;
    }
    return null;
  }
  if (typeof raw.command === "string" && (type === undefined || type === "stdio")) {
    if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every((arg) => typeof arg === "string"))) return `server "${name}": args must be a list of strings`;
    if (raw.env !== undefined && !isStringRecord(raw.env)) return `server "${name}": env must map names to strings`;
    if (raw.cwd !== undefined && typeof raw.cwd !== "string") return `server "${name}": cwd must be a string`;
    return null;
  }
  return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
}

/** The entry as pi reads it: exposure names resolved. For what `loadConfig` hands over. */
export function resolvedEntry<T extends Record<string, unknown>>(entry: T): T {
  const out: Record<string, unknown> = { ...entry };
  if (entry.exposure !== undefined) out.exposure = resolved(entry.exposure);
  if (isRecord(entry.toolExposure)) out.toolExposure = Object.fromEntries(Object.entries(entry.toolExposure).map(([tool, one]) => [tool, resolved(one)]));
  return out as T;
}

/**
 * The places in an entry whose value pi runs as a command: a value in `env`, in `headers` or the OAuth client secret that
 * starts with `!` (pi 1.1, docs/mcp.md). Even for an HTTP server. They are code the portal's user runs, as a `command` is,
 * and are named so that the routes and `portal.mcp.set` can say it.
 */
export function commandValues(entry: unknown): string[] {
  if (!isRecord(entry)) return [];
  const found: string[] = [];
  for (const key of ["env", "headers"] as const) {
    const values = entry[key];
    if (!isRecord(values)) continue;
    for (const [name, value] of Object.entries(values)) if (typeof value === "string" && value.startsWith("!")) found.push(`${key}.${name}`);
  }
  const secret = isRecord(entry.oauth) ? entry.oauth.clientSecret : undefined;
  if (typeof secret === "string" && secret.startsWith("!")) found.push("oauth.clientSecret");
  return found;
}

/** The regular expression for a tool pattern, as pi writes them in `toolExposure`: `*` is any characters, nothing else is special. */
export function toolPattern(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

/** Whether a tool name is one of these entries, each an exact name or a pattern. */
export function matchesTool(entries: readonly string[], name: string): boolean {
  return entries.some((entry) => (entry.includes("*") ? toolPattern(entry).test(name) : entry === name));
}

/** What a server's tool is exposed as: its own `toolExposure` entry (an exact name before a pattern), else the server's. pi's `getMcpToolExposure`. */
export function toolExposureOf(entry: { exposure?: unknown; toolExposure?: unknown }, tool: string): Exposure {
  const overrides = isRecord(entry.toolExposure) ? entry.toolExposure : {};
  const exact = overrides[tool];
  if (exact !== undefined) return resolved(exact) as Exposure;
  for (const [pattern, one] of Object.entries(overrides)) if (pattern.includes("*") && toolPattern(pattern).test(tool)) return resolved(one) as Exposure;
  return (resolved(entry.exposure) as Exposure | undefined) ?? "codemode";
}

/** Provider tool names are limited to 64 characters. */
const MAX_NAME = 64;

/**
 * The name pi gives one tool of a server: `mcp__<server>__<tool>` with every character outside `[A-Za-z0-9_]` as `_`, cut
 * to 64 characters with a hash of server and tool when it is longer, or when `taken` says another tool has the name.
 * pi's `createMcpToolName`.
 */
export function mcpToolName(server: string, tool: string, taken: (name: string) => boolean = () => false): string {
  const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
  if (name.length <= MAX_NAME && !taken(name)) return name;
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
  return `${name.slice(0, MAX_NAME - hash.length - 1)}_${hash}`;
}

/**
 * The names pi gives all the tools a server offers, by the server's own name for each. Like pi's registration, every tool
 * whose name comes out the same as another's gets the hash suffix, so which one keeps the plain name does not depend on the
 * order of the list. A name that another server's tool already holds is a collision this does not see: the names of the
 * tools of one server are what it knows. Where it matters (what is real) is the registry, which the runtime reads after a
 * connect.
 */
export function mcpToolNames(server: string, tools: readonly string[], elsewhere: (name: string) => boolean = () => false): Map<string, string> {
  const unique = [...new Set(tools)];
  const plain = unique.map((tool) => mcpToolName(server, tool));
  const names = new Map<string, string>();
  for (const tool of unique) {
    names.set(tool, mcpToolName(server, tool, (candidate) => elsewhere(candidate) || plain.indexOf(candidate) !== plain.lastIndexOf(candidate)));
  }
  return names;
}

/** The namespace of a server in the form pi has it: hyphens as underscores. Two servers with the same one cannot both connect. */
export { mcpNamespace };

/** The configured names that fold to the same namespace as another: which pi refuses, the second one. */
export function clashes(names: readonly string[]): [string, string][] {
  const seen = new Map<string, string>();
  const out: [string, string][] = [];
  for (const name of names) {
    const space = mcpNamespace(name);
    const first = seen.get(space);
    if (first !== undefined && first !== name) out.push([first, name]);
    else seen.set(space, name);
  }
  return out;
}

/**
 * An entry written in the adapter's vocabulary (`pi-mcp-adapter`'s `mcp.json`), as pi reads it. For the one release in
 * which `portal.mcp.set` still takes the old keys from an extension that has not moved: translated, and what was done is
 * said. The migration of the file itself (issue 361, PR 4) is stricter, since it has the adapter's cache of each server's
 * tools to evaluate `includeTools` against; this has none, and a pattern it cannot carry over exactly is refused rather
 * than turned into one that exposes more than was meant.
 */
export interface Translated {
  entry: Record<string, unknown>;
  /** The tools that ask for a confirmation: the adapter's `approveTools`, as tool-name patterns. The portal keeps them (see `approve` of `portal.mcp.set`). */
  approve: string[];
  /** What was changed, for the log. */
  notes: string[];
}

const ADAPTER_DROPPED = ["lifecycle", "idleTimeout", "debug", "scriptMode", "toolPrefix", "exposeResources", "autoAuth"] as const;

export function fromAdapterEntry(raw: Record<string, unknown>): Translated {
  const entry: Record<string, unknown> = { ...raw };
  const notes: string[] = [];
  const approve: string[] = [];
  const take = (key: string) => {
    const value = entry[key];
    delete entry[key];
    return value;
  };
  if (typeof entry.socket === "string") throw new TypeError("A socket (rmcp-mux) cannot be carried over: pi connects over stdio or HTTP");
  take("socket");
  for (const key of ADAPTER_DROPPED) if (key in entry) notes.push(`${key} dropped`), take(key);
  if (take("disabled") === true) {
    entry.enabled = false;
    notes.push("disabled became enabled: false");
  }
  // directTools: true is a server whose tools are declared; a list names the tools that are, the rest are found.
  const direct = take("directTools");
  if (direct === true) {
    if (entry.exposure === undefined) entry.exposure = "direct";
    notes.push("directTools became exposure: direct");
  } else if (Array.isArray(direct) && direct.length) {
    const names = direct.filter((name): name is string => typeof name === "string");
    if (names.length !== direct.length) throw new TypeError("directTools must name tools");
    if (entry.exposure === undefined) entry.exposure = "deferred";
    entry.toolExposure = { ...names.reduce<Record<string, string>>((all, name) => ({ ...all, [name]: "direct" }), {}), ...(isRecord(entry.toolExposure) ? entry.toolExposure : {}) };
    notes.push("directTools named tools became toolExposure: direct");
  }
  const include = take("includeTools");
  const exclude = take("excludeTools");
  const list = (value: unknown, key: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((one) => typeof one === "string")) throw new TypeError(`${key} must be a list of tool names`);
    if (value.some((one) => one.includes("?"))) throw new TypeError(`${key} has a pattern with ? that toolExposure cannot say; name the tools, or use *`);
    return value as string[];
  };
  const out = list(exclude, "excludeTools");
  const inn = list(include, "includeTools");
  if (out.length || inn.length) {
    const base = (typeof entry.exposure === "string" ? (resolved(entry.exposure) as string) : "codemode") as Exposure;
    const mine: Record<string, string> = {};
    // Excluded first, as an exact name wins over a pattern and among patterns the first does: what is excluded stays hidden.
    for (const one of out) mine[one] = "hidden";
    if (inn.length) {
      // A name that an exclusion already covers stays hidden: an exact entry would win over the exclusion's pattern.
      for (const one of inn) if (one.includes("*") || !matchesTool(out, one)) mine[one] = base === "hidden" ? "codemode" : base;
      mine["*"] = "hidden";
    }
    entry.toolExposure = { ...mine, ...(isRecord(entry.toolExposure) ? entry.toolExposure : {}) };
    notes.push("includeTools and excludeTools became toolExposure");
  }
  const approveTools = take("approveTools");
  if (approveTools !== undefined) {
    if (!Array.isArray(approveTools) || !approveTools.every((one) => typeof one === "string")) throw new TypeError("approveTools must be a list of tool names");
    approve.push(...(approveTools as string[]));
    notes.push("approveTools became approve");
  }
  const auth = take("auth");
  const token = take("bearerToken");
  const tokenEnv = take("bearerTokenEnv");
  if (auth === "bearer") {
    const value = typeof token === "string" && token ? token : typeof tokenEnv === "string" && tokenEnv ? `\${${tokenEnv}}` : undefined;
    if (value && typeof entry.url === "string") {
      entry.headers = { ...(isRecord(entry.headers) ? entry.headers : {}), Authorization: `Bearer ${value}` };
      notes.push("auth: bearer became an Authorization header");
    }
  } else if (isRecord(auth)) {
    // pi's own `auth: { provider }` is not the adapter's: kept.
    entry.auth = auth;
  } else if (auth !== undefined && auth !== "oauth") {
    notes.push(`auth ${JSON.stringify(auth)} dropped`);
  }
  return { entry, approve, notes };
}
