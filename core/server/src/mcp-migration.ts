import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { NAME_RE, ignoredByPi, mcpConfigPath, writeMcpFile, type McpFile } from "./api/mcp.js";
import { getDb, getSetting, knownTools, packageRemoved, parseToolsOff, putSetting, setMcpApprove, setToolDefaultsOff, toolDefaultsOff } from "./db.js";
import { isSwitchedOff, sourceOf } from "./extension-switch.js";
import { MCP_RESOURCE_TOOLS } from "./pi/mcp-origin.js";
import { piMcp, type PiMcp } from "./pi/mcp-config.js";
import { piAgentDir, readPiSettings, updatePiSettingsNow } from "./pi-settings.js";
import { listProjects } from "./projects.js";
import { workspaceRoot } from "./workspaces.js";

/**
 * Pithagoras ran MCP through `pi-mcp-adapter`, in its own dialect of mcp.json. pi has MCP support of its own now, in the same
 * file with other words, and the portal runs that: `moveFromAdapter` carries the servers over once, as the portal starts,
 * where the adapter's configuration is there, and takes the adapter out of the portal's pi. Nothing here runs after that.
 *
 * The servers keep what they were, on or off, and have no mark, so they are Auto in Settings → Tools. The adapter's own keys
 * are dropped. Its `approveTools` (the tools that asked the person before a call) is not dropped: it becomes the server's `approve`,
 * which the portal keeps beside the file and the guard holds the calls to (`true` is `*`), and the server keeps its on or off. A list of switches (portal-wide, a project, agent, routine, mode or chat) that had the adapter's `mcp` tool off
 * had MCP off: it switches off every server's tools by name now, so that nothing reaches further than it did, and the entry goes; a
 * server the adapter never listed tools of cannot be named there, and comes over switched off. A list that named one of the adapter's
 * own tools (`github_delete_repo`) names it as pi does (`mcp__github__delete_repo`). The file as it was is kept beside it (keepCopy).
 * A project's own `.pi/mcp.json` is read by pi as it was by the adapter: the tools the adapter cached of its servers are named in those lists too.
 * A server with something pi has no word for is left as it was, switched off, and named in the one line the log gets; nothing of it
 * is lost, as it stays in the file. A bearer
 * token becomes the Authorization header pi takes: Understory's own entry had one. Not converted: the adapter's variables, which
 * are for the person to set again, as the docs say.
 */

/** Keys of the adapter's that say nothing pi needs: dropped where a server is carried over. */
const DROPPED = ["lifecycle", "idleTimeout", "requestTimeoutMs", "directTools", "debug", "trace", "toolPrefix", "disabled"] as const;

/** Keys of the adapter's that pi has no word for: a server with one of them is left off, named (see ignoredByPi). Its lists of the tools a
 * server offers or leaves out are pi's `toolExposure` now (see exposureOf). */
const REFUSED = ["socket", "exposeResources"] as const;

/** The adapter's lists of the tools a server offers or leaves out, which become pi's `toolExposure` (see exposureOf). */
const LISTS = ["includeTools", "excludeTools"] as const;

/** The adapter's bearer token, and the variable that holds one: they become an Authorization header (see bearerHeader). */
const BEARER = ["bearerToken", "bearerTokenEnv"] as const;

export const ADAPTER_PACKAGE = /(^|[:/])pi-mcp-adapter(@[^/]*)?$/;

/** Whether a parsed file is in the adapter's dialect: its keys are in it. */
function inAdapterDialect(old: Record<string, unknown>): boolean {
  if (old.settings !== undefined || old.imports !== undefined) return true;
  const servers = old.mcpServers && typeof old.mcpServers === "object" ? Object.values(old.mcpServers as Record<string, unknown>) : [];
  // `auth` is pi's own key too, as an object (`{ provider }`): the adapter's was a word.
  return servers.some((entry) => entry && typeof entry === "object" && ([...DROPPED, ...REFUSED, ...LISTS, ...BEARER, "approveTools"].some((key) => key in (entry as object)) || typeof (entry as { auth?: unknown }).auth === "string"));
}

export interface Carried {
  /** The file in pi's dialect. */
  file: McpFile;
  /** The servers carried over, on or off as they were. */
  carried: string[];
  /** The servers left off, with why: what pi has no word for. They stay in the file as they were. */
  left: { name: string; why: string }[];
  /** What the adapter imported from other tools' configs, which pi does not read. */
  imports: string[];
  /** The patterns of each server's tools whose calls the person is asked about first: the adapter's `approveTools`, in the portal's words (see approvePatternsOf). */
  approve: Record<string, string[]>;
  /** Whether the file is not what it was. */
  changed: boolean;
  /** Whether it has the adapter's keys in it. */
  dialect: boolean;
}

/**
 * Whether pi would read a value of an env or headers differently from the adapter, which knew `${NAME}`, `$env:NAME` and
 * `{env:NAME}` and left every other `$` and a leading `!!` as text: pi reads `$NAME` and `$$`, `!!x` as a shell command.
 */
function readsDifferently(value: string): boolean {
  return value.startsWith("!!") || value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, "").includes("$");
}

/** The Authorization header for the adapter's bearer token (its own, or the variable that holds it, as pi's `${NAME}`), or why not. */
function bearerHeader(entry: Record<string, unknown>): { header?: string; why?: string } {
  const token = typeof entry.bearerToken === "string" ? entry.bearerToken.trim() : "";
  if (token) return { header: `Bearer ${token}` };
  const env = typeof entry.bearerTokenEnv === "string" ? entry.bearerTokenEnv.trim() : "";
  if (!env) return {};
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(env) ? { header: `Bearer \${${env}}` } : { why: "a bearer token variable whose name pi cannot read" };
}

/** The entry as it was, switched off: what a server that cannot be carried over becomes. Its `approveTools` is not in it: it is the server's `approve` now (see carryOver), and the file does not hold it. */
function leftOff(entry: Record<string, unknown>): Record<string, unknown> {
  const { approveTools: _gate, ...rest } = entry;
  return { ...rest, enabled: false };
}

/** The prefixes the adapter gave a server's tools by `toolPrefix` (`server`, `short`, `mcp`), dashes as underscores: `approveTools` patterns were matched against the tool's name with each. */
function adapterPrefixes(server: string): string[] {
  const long = server.replace(/-/g, "_");
  const short = server.replace(/-?mcp$/i, "").replace(/-/g, "_") || "mcp";
  return [`${long}_`, `${short}_`, `mcp__${long}_`];
}

/**
 * The patterns of a tool's own name that `prefix` + the name matches `pattern` (`*` any characters, `?` one) by: what is left of the
 * pattern once the prefix has been matched against its start, wherever a `*` may take any part of it (`*_delete_*` for `github_` leaves
 * `delete_*` and `*_delete_*`). Without a cached tool to try the pattern on, this is how a pattern that matched only across the prefix is
 * kept, whatever it starts with.
 */
function throughPrefix(pattern: string, prefix: string): string[] {
  const seen = new Map<string, string[]>();
  const walk = (i: number, j: number): string[] => {
    if (j === prefix.length) return i < pattern.length ? [pattern.slice(i)] : [];
    if (i === pattern.length) return [];
    const key = `${i}:${j}`;
    const known = seen.get(key);
    if (known) return known;
    const c = pattern[i];
    const found = c === "*" ? [...walk(i + 1, j), ...walk(i, j + 1)] : c === "?" || c === prefix[j] ? walk(i + 1, j + 1) : [];
    seen.set(key, found);
    return found;
  };
  return [...new Set(walk(0, 0))];
}

/**
 * What the adapter's `approveTools` of a server (its own, or else the setting's for every server) asks about, as the portal's `approve`:
 * `true` is every tool, and a list is its patterns. The adapter matched a pattern against a tool's own name and against the name with the
 * server's prefix (`github_delete_*`, `?` for one character) with dashes and underscores alike, and the portal matches the server's own name
 * only, so a pattern is carried as it is (`?` as `*`, which asks more, not less), with the prefix taken off where it starts with one or a `*` takes it (see throughPrefix), and with
 * each tool the adapter had cached of the server that it matched, by its own name: nothing the adapter asked about is left out because of how
 * the pattern was written.
 */
function approveOf(server: string, gate: unknown, cached: readonly string[]): string[] {
  if (gate === true) return ["*"];
  if (!Array.isArray(gate)) return [];
  return ownPatterns(server, gate, cached);
}

/**
 * A list of the adapter's patterns of a server's tools (`approveTools`, `includeTools`, `excludeTools`), matched against a tool's own name and
 * against the name with the server's prefix, as patterns of the tools' own names: each pattern as it is (`?` as `*`), with the prefix taken off
 * (see throughPrefix), and each tool the adapter had cached of the server that it matched, by its own name.
 */
function ownPatterns(server: string, list: unknown[], cached: readonly string[]): string[] {
  const patterns = list.filter((one): one is string => typeof one === "string" && one.trim() !== "").map((one) => one.trim().replace(/-/g, "_"));
  const regexp = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  const asked = new Set(patterns.map((pattern) => pattern.replace(/\?/g, "*")));
  for (const pattern of patterns) {
    for (const prefix of adapterPrefixes(server)) for (const own of throughPrefix(pattern, prefix)) asked.add(own.replace(/\?/g, "*"));
  }
  for (const tool of cached) {
    const own = tool.replace(/\./g, "_").replace(/-/g, "_");
    const names = [own, ...adapterPrefixes(server).map((prefix) => prefix + own)];
    if (patterns.some((pattern) => names.some((name) => regexp(pattern).test(name)))) asked.add(tool);
  }
  return [...asked];
}

/**
 * The adapter's `includeTools` and `excludeTools` of a server as pi's `toolExposure`, after what the entry has of that already. pi takes an exact
 * name first, else the first pattern in order that matches (getMcpToolExposure), else the server's exposure. So what is left out comes first,
 * hidden, then what is offered, direct, then `*` hidden where there is a list of what is offered: a tool left out stays out, as under the
 * adapter, and one neither list names is offered only where there is no list of what is offered.
 */
function exposureOf(name: string, entry: Record<string, unknown>, cached: readonly string[]): Record<string, string> | undefined {
  const list = (key: (typeof LISTS)[number]) => (Array.isArray(entry[key]) ? ownPatterns(name, entry[key] as unknown[], cached) : []);
  const excluded = list("excludeTools");
  const included = list("includeTools");
  if (!excluded.length && !included.length) return undefined;
  const exact = (pattern: string) => !pattern.includes("*");
  const had = entry.toolExposure && typeof entry.toolExposure === "object" && !Array.isArray(entry.toolExposure) ? (entry.toolExposure as Record<string, string>) : {};
  const out: Record<string, string> = {};
  for (const pattern of excluded.filter((one) => !exact(one))) out[pattern] ??= "hidden";
  for (const pattern of included.filter((one) => !exact(one))) out[pattern] ??= "direct";
  if (included.length) out["*"] ??= "hidden";
  for (const tool of included.filter(exact)) out[tool] = "direct";
  for (const tool of excluded.filter(exact)) out[tool] = "hidden";
  // What the entry said itself goes first: it is pi's own word for the tool.
  return { ...had, ...Object.fromEntries(Object.entries(out).filter(([key]) => !(key in had))) };
}

/** One server of the adapter's file, in pi's words, or why not: then it is as it was, switched off. `off`: nothing ran under the adapter, so nothing starts now. */
function convertEntry(pi: PiMcp, name: string, entry: Record<string, unknown>, off: boolean, cached: readonly string[] = []): { entry: Record<string, unknown>; why?: string } {
  const why: string[] = [];
  // The keys that are carried over in another form (a bearer token, an OAuth block, variables) get their own reason below.
  for (const one of ignoredByPi(entry)) if ((REFUSED as readonly string[]).includes(one.key)) why.push(one.why);
  // The adapter fell back to the old SSE transport where streamable HTTP failed; pi speaks streamable HTTP only, and cannot tell an SSE-only address from the other kind, except by its look.
  if (typeof entry.url === "string" && /\/sse\/?([?#].*)?$/i.test(entry.url.replace(/^[a-z]+:\/\/[^/]*/i, ""))) why.push("a URL that looks like the old SSE transport, which pi does not connect (it needs the server's streamable HTTP address)");
  if (entry.oauth !== undefined && entry.oauth !== false) why.push("an OAuth block of the adapter's");
  if (typeof entry.auth === "string" && entry.auth !== "oauth" && entry.auth !== "bearer") why.push(`the sign-in "${entry.auth}", which pi does not have`);
  const bearer = bearerHeader(entry);
  if (bearer.why) why.push(bearer.why);
  const headers = entry.headers && typeof entry.headers === "object" && !Array.isArray(entry.headers) ? (entry.headers as Record<string, unknown>) : {};
  if (bearer.header && Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) why.push("a bearer token and an Authorization header both");
  // The adapter's own spellings of a variable, and variables where pi reads none (url, folder, arguments): pi would pass them on as written.
  if (/\$env:|\{env:/.test(JSON.stringify(entry))) why.push("variables as `$env:NAME` or `{env:NAME}`, which pi reads as `${NAME}`");
  const where = (value: unknown): boolean => typeof value === "string" && value.includes("${");
  if (where(entry.url) || where(entry.cwd) || (Array.isArray(entry.args) && entry.args.some(where))) why.push("variables in its url, folder or arguments, which pi does not read there");
  // A `$` or a leading `!!` in a value of env or headers (a password) is text to the adapter and something else to pi.
  const values = [...Object.values((entry.env && typeof entry.env === "object" ? entry.env : {}) as Record<string, unknown>), ...Object.values(headers), ...(bearer.header ? [bearer.header] : [])];
  if (values.some((value) => typeof value === "string" && readsDifferently(value))) why.push("a value in env or headers with a `$` or a leading `!!`, which pi reads differently (write `$$` for a `$`)");

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    // `oauth: false` and `auth: "oauth"` are the adapter's own words: pi signs in by itself where the server asks. `auth: { provider }` is pi's.
    // `approveTools` is the server's `approve` now, kept by the portal and not in the file (see carryOver).
    const adapters = (DROPPED as readonly string[]).includes(key) || (BEARER as readonly string[]).includes(key) || (LISTS as readonly string[]).includes(key) || (key === "oauth" && value === false) || (key === "auth" && typeof value !== "object") || key === "approveTools";
    if (!adapters) out[key] = value;
  }
  if (bearer.header) out.headers = { ...headers, Authorization: bearer.header };
  const exposure = exposureOf(name, entry, cached);
  if (exposure) out.toolExposure = exposure;
  if (entry.disabled === true || off) out.enabled = false;
  if (!why.length) {
    const checked = pi.validateMcpServerConfig(name, out);
    if (typeof checked === "string") why.push(checked.replace(/^server "[^"]*": /, ""));
  }
  return why.length ? { entry: leftOff(entry), why: why.join("; ") } : { entry: out };
}

/**
 * The adapter's mcp.json, in pi's dialect. Pure: nothing is read or written. `off`: nothing ran under the adapter (it was
 * switched off, or is not in pi's packages while the file is in its dialect), so nothing starts now. `cache`: the tools the adapter had cached
 * of each server, by their own names, which the patterns of its `approveTools` are carried over with (see approveOf).
 */
export function carryOver(pi: PiMcp, text: string, off: boolean, cache: ReadonlyMap<string, string[]> = new Map()): Carried | { error: string } {
  let parsed: unknown;
  try {
    parsed = text.trim() ? JSON.parse(text) : {};
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "not an object" };
  const old = parsed as Record<string, unknown>;
  const servers = old.mcpServers && typeof old.mcpServers === "object" && !Array.isArray(old.mcpServers) ? (old.mcpServers as Record<string, unknown>) : {};
  const settings = old.settings && typeof old.settings === "object" ? (old.settings as Record<string, unknown>) : {};

  const file: McpFile = { mcpServers: {} };
  // As pairs, then objects: a server named `__proto__` is a key like any other only where it is defined, not assigned.
  const converted: [string, Record<string, unknown>][] = [];
  const carried: string[] = [];
  const left: { name: string; why: string }[] = [];
  const approved: [string, string[]][] = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      left.push({ name, why: "it is not a server" });
      continue;
    }
    // pi names tools after a server, and takes letters, digits, `_` and `-` of it: `docs.v2` stays as it is, off, and Settings → MCP says why.
    const done = NAME_RE.test(name)
      ? convertEntry(pi, name, entry as Record<string, unknown>, off, cache.get(name) ?? [])
      : { entry: leftOff(entry as Record<string, unknown>), why: "pi does not take its name (letters, digits, dash and underscore only)" };
    converted.push([name, done.entry]);
    // The server keeps what it was, on or off, and what it asked about stays asked: by the server's own `approveTools`, else the setting's.
    // A server pi does not take by its name has no tools to gate while it is off; its patterns are kept for its name all the same, so a rename
    // in Settings → MCP (which moves them) carries the gate to the name pi takes.
    const own = (entry as Record<string, unknown>).approveTools;
    const patterns = approveOf(name, own !== undefined ? own : settings.approveTools, cache.get(name) ?? []);
    if (patterns.length) approved.push([name, patterns]);
    if (done.why) left.push({ name, why: done.why });
    else carried.push(name);
  }
  file.mcpServers = Object.fromEntries(converted);
  // What else the file had that is pi's too (autoEnableCodemode) stays; the adapter's `settings` and `imports` go.
  for (const [key, value] of Object.entries(old)) if (!["mcpServers", "settings", "imports"].includes(key)) file[key] = value;
  const imports = Array.isArray(old.imports) ? old.imports.filter((one): one is string => typeof one === "string") : [];
  const approve = Object.fromEntries(approved);
  return { file, carried, left, imports, approve, changed: !isDeepStrictEqual(parsed, file), dialect: inAdapterDialect(old) };
}

/** The adapter's own tool, which a list of switches may name: a list that switched it off meant "no MCP here". */
const GATEWAY = ["mcp", "mcp_script", "mcpScript"];

/** The tables of switches that hold a list off and a list on for each row (the portal-wide default is a setting, and is handled beside them). */
const SWITCH_TABLES = ["sessions", "project_tools", "agent_tools", "routines", "chat_modes"] as const;

/** The tools the adapter had cached for each server, by the names the servers gave them: it wrote this file once it had connected. */
function adapterCache(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  try {
    const cache = JSON.parse(readFileSync(path.join(piAgentDir(), "mcp-cache.json"), "utf8")) as { servers?: Record<string, { tools?: unknown }> };
    for (const [server, entry] of Object.entries(cache.servers ?? {})) {
      if (Array.isArray(entry?.tools)) out.set(server, entry.tools.flatMap((tool: { name?: unknown }) => (typeof tool?.name === "string" ? [tool.name] : [])));
    }
  } catch {
    /* no file, or not one: the servers have no tools to name */
  }
  return out;
}

/** A server's tools as pi names them: where two sanitize to one name, every one of them gets pi's hash suffix (see assignName in pi's mcp extension). */
function namesOf(pi: PiMcp, server: string, tools: string[]): string[] {
  const unique = [...new Set(tools)];
  const plain = unique.map((tool) => pi.createMcpToolName(server, tool));
  return unique.map((tool) => pi.createMcpToolName(server, tool, (candidate) => plain.indexOf(candidate) !== plain.lastIndexOf(candidate)));
}

/**
 * The servers of the projects' own `.pi/mcp.json` (the adapter read them as well, and pi reads them now in a trusted project):
 * the projects of the workspace folder and the folders the chats work in.
 */
function projectServers(): { file: string; servers: string[] }[] {
  const folders = new Set<string>();
  try {
    for (const project of listProjects(workspaceRoot())) folders.add(project.path);
  } catch {
    /* no workspace folder yet */
  }
  try {
    for (const row of getDb().prepare("SELECT DISTINCT workspace FROM sessions WHERE workspace IS NOT NULL").all() as { workspace: string }[]) folders.add(row.workspace);
  } catch {
    /* as above */
  }
  const found: { file: string; servers: string[] }[] = [];
  for (const folder of [...folders].sort()) {
    const file = path.join(folder, ".pi", "mcp.json");
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: unknown };
      const servers = parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers) ? Object.keys(parsed.mcpServers) : [];
      if (servers.length) found.push({ file, servers });
    } catch {
      /* none, or not readable: not ours to say anything of */
    }
  }
  return found;
}

export interface MovedSwitches {
  /** How many lists had the adapter's `mcp` tool off (or one of its tools no server here has), and now have every server's tools off. */
  lists: number;
  /** How many lists named single tools of the adapter's, and name them as pi does now. */
  named: number;
  /** The servers the lists could not name a tool of (the adapter never listed one): the move switches them off, so that nothing reaches them where MCP was off. */
  unnamed: string[];
  /** Whether a list that had it on still names one of the adapter's own tools that no server here has, which means nothing now. */
  tools: boolean;
}

/**
 * pi's names of one of the adapter's own tools (`github_delete_repo`): the adapter named a server's tool with the server's prefix
 * (see adapterPrefixes), or with none, and with dots as underscores. A tool the adapter had cached is found by that name; else the
 * name is read as a prefix and the tool's own name after it, for each server whose prefix it starts with (a name that two servers'
 * prefixes fit is the tool of both, so that nothing stays on that was off). None where no server's prefix fits.
 */
function placeOf(pi: PiMcp, name: string, known: ReadonlyMap<string, ReadonlyMap<string, string>>): string[] {
  const cached: string[] = [];
  const read: string[] = [];
  for (const [server, tools] of known) {
    const own = (tool: string) => tool.replace(/\./g, "_");
    for (const [tool, piName] of tools) if (own(tool) === name) cached.push(piName);
    for (const prefix of adapterPrefixes(server)) {
      if (!name.startsWith(prefix) || name.length === prefix.length) continue;
      const rest = name.slice(prefix.length);
      read.push(pi.createMcpToolName(server, rest));
      for (const [tool, piName] of tools) if (own(tool) === rest) cached.push(piName);
    }
  }
  return [...new Set(cached.length ? cached : read)];
}

/**
 * The lists of switches, with the adapter's `mcp` tool taken out of them. Where one had it off, it has every tool of every
 * server off now (a group is a list of names, as it is for any group), pi's three resource tools included, so that the move
 * reaches no further than the adapter did; where it had it on, the entry only goes, and nothing is switched on by it.
 * A list that named one of the adapter's own tools (`github_delete_repo`, which the adapter kept off through its proxy as well)
 * names it as pi does now (`mcp__github__delete_repo`, see placeOf), off or on as it was. One that no server here has a name for
 * is read, in a list of what is off, as `mcp` off: the list switches off every server's tools. `known`: the tools the adapter had
 * cached of each server, by their own names, with pi's names of them.
 */
function moveSwitches(pi: PiMcp, known: ReadonlyMap<string, ReadonlyMap<string, string>>, adapterTools: ReadonlySet<string>): MovedSwitches {
  const held = [...MCP_RESOURCE_TOOLS, ...[...known.values()].flatMap((tools) => [...tools.values()])];
  const moved: MovedSwitches = { lists: 0, named: 0, unnamed: [], tools: false };
  const unnamed = [...known].filter(([, tools]) => !tools.size).map(([server]) => server);
  /**
   * The list as it should be, or undefined where it needs no change. `off`: whether this is the list of what is off. `whole`: the list
   * has every server's tools off now. `named`: it names tools of the adapter's as pi does.
   */
  const redo = (list: string[], off: boolean): { list: string[]; whole: boolean; named: boolean } | undefined => {
    const gateway = list.some((name) => GATEWAY.includes(name));
    const own = new Map(list.filter((name) => adapterTools.has(name) && !GATEWAY.includes(name)).map((name) => [name, placeOf(pi, name, known)]));
    if (!gateway && !own.size) return undefined;
    const lost = [...own].some(([, names]) => !names.length);
    if (lost && !off) moved.tools = true;
    // A name pi has for it takes the adapter's place; one it has none for stays, and means nothing now.
    const rest = list.filter((name) => !GATEWAY.includes(name) && !own.get(name)?.length);
    const placed = [...own.values()].flat();
    const whole = off && (gateway || lost);
    const next = [...new Set([...rest, ...placed, ...(whole ? held : [])])];
    return { list: off ? next.sort() : next, whole, named: placed.length > 0 };
  };
  const count = (...lists: ({ whole: boolean; named: boolean } | undefined)[]) => {
    if (lists.some((one) => one?.whole)) moved.lists++;
    else if (lists.some((one) => one?.named)) moved.named++;
  };
  // What a start before this one did, where it failed after the lists were rewritten: their entries are gone, so only this says which servers cannot be named.
  const before = heldBefore();
  const db = getDb();
  db.transaction(() => {
    const defaults = toolDefaultsOff();
    const next = redo(defaults, true);
    if (next) {
      setToolDefaultsOff(next.list);
      count(next);
    }
    for (const table of SWITCH_TABLES) {
      const put = db.prepare(`UPDATE ${table} SET tools_off = ?, tools_on = ? WHERE rowid = ?`);
      for (const row of db.prepare(`SELECT rowid AS id, tools_off, tools_on FROM ${table}`).all() as { id: number; tools_off: string; tools_on: string }[]) {
        const off = parseToolsOff(row.tools_off);
        const on = parseToolsOff(row.tools_on);
        const offNow = redo(off, true);
        const onNow = redo(on, false);
        if (!offNow && !onNow) continue;
        put.run((offNow?.list ?? off).join("\n"), (onNow?.list ?? on).join("\n"), row.id);
        count(offNow, onNow);
      }
    }
    if (moved.lists) moved.unnamed = unnamed;
    // In the same transaction as the lists: a start after a failure finds them done, and reads from here what they meant.
    if (moved.lists || moved.named || moved.tools) putSetting(HELD, JSON.stringify(moved));
  })();
  return moved.lists || moved.named || moved.tools ? moved : (before ?? moved);
}

/** The setting that keeps what the lists were rewritten for until the move is done (see moveSwitches). */
const HELD = "mcp_adapter_held";

function heldBefore(): MovedSwitches | undefined {
  try {
    return getSetting(HELD) ? (JSON.parse(getSetting(HELD)!) as MovedSwitches) : undefined;
  } catch {
    return undefined;
  }
}

/** The files the adapter also read servers from, which pi does not: shared ones of other tools. */
function sharedFiles(): string[] {
  const home = os.homedir();
  return [path.join(home, ".config", "mcp", "mcp.json"), path.join(home, ".agents", "mcp.json")].filter((file) => existsSync(file));
}

/**
 * The file as it was before the move, kept beside it: `mcp.json.adapter`, or `mcp.json.adapter-2` and on where that is taken (a copy
 * of an earlier start, or of a move tried before, is not written over). Undefined where none can be written, which the log says: then
 * nothing is moved, and the move is tried again on a start after.
 */
function keepCopy(file: string, text: string): string | undefined {
  let why = "";
  for (let n = 1; n < 100; n++) {
    const copy = `${file}.adapter${n > 1 ? `-${n}` : ""}`;
    try {
      // The file may hold tokens: the copy is the person's alone, as the file is.
      writeFileSync(copy, text, { mode: 0o600, flag: "wx" });
      return copy;
    } catch (e) {
      why = (e as Error).message;
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") break;
    }
  }
  console.warn(`[portal] MCP: no copy of mcp.json could be kept beside it (${why}), so the adapter's servers are not carried over to pi's own MCP support yet.`);
  return undefined;
}

/** The setting that says the move was made, or that there was none to make: it is made once. */
const MOVED = "mcp_adapter_moved";

/**
 * Carry the adapter's servers over into pi's mcp.json, once, and take the adapter out of the portal's pi. Run as the
 * portal starts, before anything reads the file or starts a chat. A file that cannot be read is not touched and the
 * adapter is not removed: it is the person's to fix, and the move is made on a start after.
 */
export async function moveFromAdapter(): Promise<void> {
  if (getSetting(MOVED)) return;
  const packages = Array.isArray(readPiSettings().packages) ? (readPiSettings().packages as unknown[]) : [];
  const adapter = packages.find((entry) => ADAPTER_PACKAGE.test(sourceOf(entry) ?? ""));
  const file = mcpConfigPath();
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const pi = await piMcp();
  // Before the adapter's tools are forgotten: which names the switches have for them.
  const adapterTools = new Set(knownTools().filter((tool) => (typeof tool.package === "string" ? ADAPTER_PACKAGE.test(tool.package) : tool.source === "pi-mcp-adapter")).map((tool) => tool.name));
  const adapterOff = adapter === undefined || isSwitchedOff(adapter);
  // Before the adapter's cache goes: the tools of the servers it knew, by their own names, which the switches and the patterns of `approveTools` are carried over with.
  const cache = adapterCache();
  const moved = carryOver(pi, text, adapterOff, cache);
  if ("error" in moved) {
    console.warn(`[portal] MCP: mcp.json cannot be read (${moved.error}), so the adapter's servers are not carried over to pi's own MCP support yet: fix the file in Settings → MCP, and restart.`);
    return;
  }
  // Nothing of the adapter's here (no package, a file that is pi's). Before this, the portal's pi read the file only through
  // the adapter, so its servers ran nowhere: they come over switched off, and the person switches on what they want in
  // Settings → MCP. A file with the adapter's keys and no adapter is the adapter's all the same.
  if (!adapter && !moved.dialect) {
    // carryOver, with no adapter, gave every server `enabled: false`: written where the file had one on.
    const before = (text.trim() ? JSON.parse(text) : {}).mcpServers ?? {};
    const woken = Object.keys(moved.file.mcpServers).filter((name) => before[name]?.enabled !== false);
    const copy = woken.length ? keepCopy(file, text) : undefined;
    if (woken.length && !copy) return;
    for (const name of woken) moved.file.mcpServers[name].enabled = false;
    if (woken.length) writeMcpFile(moved.file, "extension");
    putSetting(MOVED, "1");
    if (woken.length) {
      console.log(
        `[portal] MCP: pi's own MCP support reads mcp.json now. Nothing read it before (pi-mcp-adapter was not installed), so its servers stay as they were, off: ${woken.join(", ")}. Switch on the ones you want in Settings → MCP. The file as it was is kept as ${copy}.`,
      );
    }
    return;
  }
  // The tools of the servers the adapter knew, by their own names and the names pi gives them. The lists of switches name them
  // (see moveSwitches); the move is one step, so a start after a failure finds them done.
  const known = new Map<string, Map<string, string>>();
  const know = (server: string, tools: string[]) => {
    const own = [...new Set(tools)];
    const piNames = namesOf(pi, server, own);
    known.set(server, new Map(own.map((tool, i) => [tool, piNames[i]])));
  };
  for (const server of Object.keys(moved.file.mcpServers)) if (NAME_RE.test(server)) know(server, cache.get(server) ?? []);
  // A project's own servers are not the file's to switch off, but where the adapter cached their tools the lists that had MCP off name them too.
  const projects = projectServers();
  for (const server of projects.flatMap((one) => one.servers)) if (NAME_RE.test(server) && !known.has(server) && cache.get(server)?.length) know(server, cache.get(server)!);
  const switches = moveSwitches(pi, known, adapterTools);
  // A server with no tool to name (never connected, lazy and never used, or added after the cache was written) cannot be switched off in the lists that had MCP off,
  // and under the adapter those lists could not reach it: it comes over switched off, and the person switches it on knowingly in Settings → MCP.
  for (const name of switches.unnamed) {
    const entry = moved.file.mcpServers[name];
    if (entry && entry.enabled !== false) {
      entry.enabled = false;
      moved.changed = true;
    }
  }
  // Before the file is written and the adapter goes: what the move drops of the file is the person's to look up. Where no copy can be
  // written the move waits for a start after, as after any failure from here on (the lists are done, and moveSwitches says what they meant).
  const copy = moved.changed ? keepCopy(file, text) : undefined;
  if (moved.changed && !copy) return;

  // What the adapter asked about before a call is still asked, by the servers' `approve` (kept by the portal), in place before the servers can run.
  for (const [server, patterns] of Object.entries(moved.approve)) setMcpApprove(server, patterns);

  // The adapter goes first, before the file is in pi's dialect: a chat that started in between would have the adapter read
  // `enabled: false` as nothing, and start a server that is off.
  if (adapter) {
    const source = sourceOf(adapter)!;
    updatePiSettingsNow((settings) => {
      settings.packages = (Array.isArray(settings.packages) ? settings.packages : []).filter((entry) => sourceOf(entry) !== source);
    });
    await packageRemoved(source);
  }
  if (moved.changed) writeMcpFile(moved.file, "extension");
  // What the adapter kept beside the file, which pi's MCP support does not use.
  for (const leftover of ["mcp-cache.json", "mcp-npx-cache.json"]) rmSync(path.join(piAgentDir(), leftover), { force: true });
  putSetting(MOVED, "1");
  putSetting(HELD, "");

  const asking = Object.keys(moved.approve);
  const left = moved.left.map(({ name, why }) => `${name} (${why})`);
  const apart = [...moved.imports.map((name) => `what the adapter imported from ${name}`), ...sharedFiles()];
  console.log(
    `[portal] MCP: pi's own MCP support runs the servers now. ${moved.carried.length} servers of pi-mcp-adapter's configuration carried over to mcp.json` +
      `${adapter ? ", pi-mcp-adapter taken out of pi's packages" : ""}.` +
      `${left.length ? ` Left off, as they were, because pi cannot take them as they are: ${left.join("; ")}.` : ""}` +
      `${asking.length ? ` What the adapter asked about before a call (approveTools) is still asked, by each server's \`approve\`: ${asking.join(", ")}.` : ""}` +
      `${apart.length ? ` Not read by pi, so not there any more: ${apart.join(", ")}.` : ""}` +
      `${copy ? ` The file as it was is kept as ${copy}.` : ""}` +
      `${switches.named ? ` ${switches.named} lists of switches (portal-wide, a project, agent, routine, mode or chat) named single tools of the adapter's: they name them as pi does now (mcp__<server>__<tool>), off or on as they were.` : ""}` +
      `${switches.lists ? ` ${switches.lists} lists of switches had the adapter's \`mcp\` tool off, or one of its tools that no server here has: they have the tools of every server switched off by name now, and pi's resource tools too.${switches.unnamed.length ? ` The adapter never listed the tools of ${switches.unnamed.join(", ")}, so there is nothing to name for those: they are switched off, whatever they were. Switching one on in Settings → MCP puts its tools on wherever they are not switched off in Settings → Tools, so set the lists where MCP was off as you do.` : ""}` : ""}` +
      `${projects.length ? ` pi reads a project's own .pi/mcp.json as well now: ${projects.map((one) => one.file).join(", ")}. Its servers are on in that project wherever MCP was off, unless the adapter had listed their tools (those are switched off by name in the lists that had MCP off); one with a gate or an exclusion of the adapter's is not connected.` : ""}` +
      `${switches.tools ? " Switches that named a tool of the adapter's that no server here has, in a list that had it on, do nothing now." : ""}`,
  );
}
