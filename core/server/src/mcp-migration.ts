import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { writeFileAtomic } from "./atomic-write.js";
import { NAME_RE, mcpConfigPath, writeMcpFile, type McpFile } from "./api/mcp.js";
import { getDb, getSetting, knownTools, packageRemoved, putSetting, toolDefaultsOff, setToolDefaultsOff, toolMarks, setToolMarks } from "./db.js";
import { isSwitchedOff, sourceOf } from "./extension-switch.js";
import { piMcp, type PiMcp } from "./pi/mcp-config.js";
import { piAgentDir, readPiSettings, updatePiSettingsNow } from "./pi-settings.js";
import { listProjects } from "./projects.js";
import { workspaceRoot } from "./workspaces.js";

/**
 * Pithagoras ran MCP through `pi-mcp-adapter`, in its own dialect of mcp.json. pi has MCP support of its own now, in the same
 * file with other words, and the portal runs that: `moveFromAdapter` carries the servers over once, as the portal starts,
 * where the adapter's configuration is there, and takes the adapter out of the portal's pi. Nothing here runs after that.
 *
 * What it does, in one pass: the file is put into pi's dialect (the adapter's keys dropped, each server's on/off kept,
 * and no mark, so the server is Auto in Settings → Tools), the names of the adapter's tools that the portal's switches
 * hold are changed to pi's, and the adapter goes from pi's package list. A server whose entry cannot be carried over is
 * left off, and named in the one line the log gets. The file as it was is kept beside it, as `mcp.json.adapter`.
 * A trusted project's own `.pi/mcp.json` in the adapter's dialect is not converted: the log line names those.
 */

/** What the adapter's mcp.json holds that pi's does not, by key: dropped when a server is carried over. */
const ADAPTER_KEYS = ["lifecycle", "idleTimeout", "requestTimeoutMs", "directTools", "debug", "disabled", "toolPrefix", "exposeResources", "includeTools", "excludeTools", "auth", "bearerToken", "bearerTokenEnv", "socket"] as const;

export const ADAPTER_PACKAGE = /(^|[:/])pi-mcp-adapter(@[^/]*)?$/;

/** The adapter parsed its config with strip-json-comments: a file of its own may carry comments, which pi's does not take. */
function stripComments(text: string): string {
  let out = "";
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"') {
      quote = c;
      out += c;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

/** How the adapter's `$env:NAME` and `{env:NAME}` are written in pi's file: `${NAME}` (pi reads `$env` as a variable called `env`). */
export function inPiWords(value: string): string {
  return value.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, "${$1}").replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, "${$1}");
}

/** Whether a value has the adapter's variables in it, which pi does not read in this place (its url, its folder, its arguments). */
const interpolated = (value: unknown): boolean => typeof value === "string" && /\$\{|\$env:|\{env:/.test(value);

/** A map of strings with its values in pi's words; anything else as it is. */
function valuesInPiWords(map: unknown): unknown {
  if (!map || typeof map !== "object" || Array.isArray(map)) return map;
  return Object.fromEntries(Object.entries(map).map(([key, value]) => [key, typeof value === "string" ? inPiWords(value) : value]));
}

export type AdapterState = "on" | "off" | "none";

export interface Carried {
  /** The file in pi's dialect. */
  file: McpFile;
  /** The servers carried over, on or off as they were. */
  carried: string[];
  /** The servers left off, with why: what pi has no word for. */
  left: { name: string; why: string }[];
  /** What the adapter's file imported from other tools' configs, which pi does not. */
  imports: string[];
  /** How the adapter named each carried server's tools (`toolPrefix`), by server. */
  naming: Map<string, string>;
  /** Whether the file is not what it was: the adapter's keys were in it, or it is not what pi reads as it stands. */
  changed: boolean;
}

/**
 * One server of the adapter's file, in pi's words. `off`: nothing ran under the adapter (it was switched off, or the file
 * was never one of a running adapter's), so nothing starts now.
 */
function convertEntry(pi: PiMcp, name: string, entry: Record<string, unknown>, off: boolean): { entry: Record<string, unknown>; why?: string } {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) if (!(ADAPTER_KEYS as readonly string[]).includes(key)) out[key] = value;
  // The variables of the adapter's own spelling, in the places pi reads them.
  if (out.env !== undefined) out.env = valuesInPiWords(out.env);
  if (out.headers !== undefined) out.headers = valuesInPiWords(out.headers);

  const unsupported: string[] = [];
  if (typeof entry.socket === "string" && entry.socket) unsupported.push("a Unix socket, which pi does not connect");
  if (Array.isArray(entry.includeTools) && entry.includeTools.length) unsupported.push("a list of the only tools it offers");
  if (Array.isArray(entry.excludeTools) && entry.excludeTools.length) unsupported.push("a list of tools it leaves out");
  if (entry.exposeResources === false) unsupported.push("its resources left out");
  if (out.oauth !== undefined) unsupported.push("an OAuth block of the adapter's");
  // pi reads variables in env and headers only: elsewhere the adapter's would be passed on as they are written.
  if (interpolated(entry.url) || interpolated(entry.cwd) || (Array.isArray(entry.args) && entry.args.some(interpolated))) unsupported.push("variables in its url, folder or arguments, which pi does not read there");

  // How it signed in: a bearer token is a header in pi's file; OAuth is what pi does when the server answers 401.
  const auth = entry.auth;
  if (auth === "bearer") {
    const header =
      typeof entry.bearerToken === "string" && entry.bearerToken
        ? `Bearer ${inPiWords(entry.bearerToken)}`
        : typeof entry.bearerTokenEnv === "string" && entry.bearerTokenEnv
          ? `Bearer \${${entry.bearerTokenEnv}}`
          : undefined;
    if (!header) unsupported.push("a bearer token that is neither written in it nor named from the environment");
    else out.headers = { ...(out.headers && typeof out.headers === "object" ? (out.headers as Record<string, unknown>) : {}), Authorization: header };
  } else if (auth !== undefined && auth !== "oauth" && auth !== false) {
    unsupported.push("a way of signing in pi does not have");
  }

  // Off as the adapter had it (`disabled`), and off where nothing ran.
  if (entry.disabled === true || off) out.enabled = false;

  if (!unsupported.length) {
    const checked = pi.validateMcpServerConfig(name, out);
    if (typeof checked === "string") unsupported.push(checked.replace(/^server "[^"]*": /, ""));
  }
  if (!unsupported.length) return { entry: out };
  return { entry: { ...out, enabled: false }, why: unsupported.join("; ") };
}

/** Whether a parsed file is in the adapter's dialect: its keys are in it. */
export function inAdapterDialect(parsed: unknown): boolean {
  const file = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  if (file.settings !== undefined || file.imports !== undefined) return true;
  const servers = file.mcpServers && typeof file.mcpServers === "object" ? Object.values(file.mcpServers as Record<string, unknown>) : [];
  return servers.some((entry) => entry && typeof entry === "object" && ADAPTER_KEYS.some((key) => key in (entry as object)) );
}

/** The adapter's mcp.json parsed as it parsed it: with comments. */
function parseAdapterFile(text: string): unknown {
  return text.trim() ? JSON.parse(stripComments(text)) : {};
}

/**
 * The adapter's mcp.json, in pi's dialect. Pure: nothing is read or written. `adapter`: it was installed and on (what made
 * a server's entry a tool at all), installed and switched off, or not in pi's packages. Where nothing ran, nothing starts now;
 * a plain file with no adapter in sight is the person's, and kept as it is.
 */
export function carryOver(pi: PiMcp, text: string, adapter: AdapterState): Carried | { error: string } {
  let parsed: unknown;
  try {
    parsed = parseAdapterFile(text);
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "not an object" };
  const old = parsed as Record<string, unknown>;
  const servers = old.mcpServers && typeof old.mcpServers === "object" && !Array.isArray(old.mcpServers) ? (old.mcpServers as Record<string, unknown>) : {};
  const dialect = inAdapterDialect(old);
  const off = adapter === "off" || (adapter === "none" && dialect);
  const settings = old.settings && typeof old.settings === "object" ? (old.settings as Record<string, unknown>) : {};

  const file: McpFile = { mcpServers: {} };
  const carried: string[] = [];
  const left: { name: string; why: string }[] = [];
  const naming = new Map<string, string>();
  for (const [name, entry] of Object.entries(servers)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      left.push({ name, why: "it is not a server" });
      continue;
    }
    if (!NAME_RE.test(name)) {
      // pi names tools after a server, and takes letters, digits, `_` and `-` of it: `docs.v2` cannot be kept as it is.
      left.push({ name, why: "pi does not take its name (letters, digits, dash and underscore only)" });
      continue;
    }
    const done = convertEntry(pi, name, entry as Record<string, unknown>, off);
    file.mcpServers[name] = done.entry;
    const prefix = (entry as Record<string, unknown>).toolPrefix ?? settings.toolPrefix;
    naming.set(name, typeof prefix === "string" ? prefix : "server");
    if (done.why) left.push({ name, why: done.why });
    else carried.push(name);
  }
  // What else the file had that is pi's too (autoEnableCodemode) stays; the adapter's `settings` and `imports` go.
  for (const [key, value] of Object.entries(old)) if (!["mcpServers", "settings", "imports"].includes(key)) file[key] = value;
  const imports = Array.isArray(old.imports) ? old.imports.filter((one): one is string => typeof one === "string") : [];
  // With no adapter in sight a plain file is left to its owner, comments and all; otherwise the file is written
  // whenever it is not what pi would read as it stands: the adapter's keys, servers now off, a comment.
  let strict: unknown;
  try {
    strict = JSON.parse(text);
  } catch {
    strict = undefined;
  }
  const changed = dialect || (adapter !== "none" && (strict === undefined || !isDeepStrictEqual(strict, file)));
  return { file, carried, left, imports, naming, changed };
}

/** What the adapter put before a tool's name (its `toolPrefix`): `server` is the server's name, `short` leaves out a closing `mcp`, `mcp` puts `mcp__` before it, `none` nothing. */
export function adapterPrefix(server: string, naming: string): string {
  const own = server.replace(/-/g, "_");
  if (naming === "none") return "";
  if (naming === "short") return server.replace(/-?mcp$/i, "").replace(/-/g, "_") || "mcp";
  if (naming === "mcp") return `mcp__${own}`;
  return own;
}

/** The adapter's own tool, which stood for every server's tools behind it. */
const GATEWAY = ["mcp", "mcp_script", "mcpScript"];

/** A tool name as it was written for the adapter: the tool's own dots as underscores. */
const sanitized = (name: string): string => name.replace(/\./g, "_");

/** A list of names as the database stores it. */
const parseList = (text: string | null | undefined): string[] => (text ?? "").split("\n").map((name) => name.trim()).filter(Boolean);

const SWITCH_TABLES = ["sessions", "project_tools", "agent_tools", "routines", "chat_modes"] as const;
const keyOf = (table: (typeof SWITCH_TABLES)[number]) => (table === "project_tools" ? "project" : table === "agent_tools" ? "agent" : table === "routines" ? "slug" : "id");

/** Every list of tool names the portal's switches keep, as written: the defaults', and each chat's, project's, agent's, routine's and mode's off and on. */
function switchLists(): { off: string[][]; on: string[][] } {
  const db = getDb();
  const lists = { off: [toolDefaultsOff()], on: [] as string[][] };
  for (const table of SWITCH_TABLES) {
    for (const row of db.prepare(`SELECT tools_off, tools_on FROM ${table}`).all() as { tools_off: string; tools_on: string }[]) {
      lists.off.push(parseList(row.tools_off));
      lists.on.push(parseList(row.tools_on));
    }
  }
  return lists;
}

/** Every name the switches and the marks on single tools hold. */
function switchedNames(): string[] {
  const lists = switchLists();
  return [...lists.off.flat(), ...lists.on.flat(), ...Object.keys(toolMarks()).filter((entry) => entry.startsWith("<tool>")).map((entry) => entry.slice(6))];
}

/** The tools the adapter had cached for each server, by the names the servers gave them: it wrote this file once it had connected. */
function adapterCache(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  try {
    const cache = JSON.parse(readFileSync(path.join(piAgentDir(), "mcp-cache.json"), "utf8")) as { servers?: Record<string, { tools?: unknown }> };
    for (const [server, entry] of Object.entries(cache.servers ?? {})) {
      if (Array.isArray(entry?.tools)) out.set(server, entry.tools.flatMap((tool: { name?: unknown }) => (typeof tool?.name === "string" ? [tool.name] : [])));
    }
  } catch {
    /* no file, or not one: what the portal remembers is all there is */
  }
  return out;
}

/** The adapter's tool names and pi's for them. */
export interface Names {
  /** The adapter's name of a tool, and pi's. */
  map: Map<string, string>;
  /** Names told by a server's prefix alone: another tool could have had it, so the switch keeps its old name too. */
  guessed: Set<string>;
  /** Each configured server's tools, by pi's names. */
  byServer: Map<string, Set<string>>;
}

/**
 * The names of the adapter's tools, and pi's for them (`mcp__<server>__<tool>`). By what the portal knows: the tools it
 * remembers a chat had registered; what the adapter had cached of each server (the only record of tools reached through its
 * `mcp` tool, which is how the adapter offered them unless `directTools` said otherwise); and any name in the switches that
 * a server's prefix claims, in the naming the server had. `naming`: each configured server's `toolPrefix`.
 */
export function toolNames(pi: PiMcp, naming: Map<string, string>, cache: Map<string, string[]>, switched: string[]): Names {
  const names: Names = { map: new Map(), guessed: new Set(), byServer: new Map() };
  const add = (server: string, old: string, tool: string, guess: boolean) => {
    const next = pi.createMcpToolName(server, tool);
    if (!names.map.has(old)) {
      names.map.set(old, next);
      if (guess) names.guessed.add(old);
    }
    names.byServer.set(server, (names.byServer.get(server) ?? new Set()).add(next));
  };
  const prefixes = [...naming].map(([server, how]) => ({ server, prefix: adapterPrefix(server, how) }));
  // The server whose prefix starts a name, the longest prefix first: `browser` must not claim `browser_staging`'s tools.
  const claim = (name: string): { server: string; tool: string } | undefined => {
    let best: { server: string; prefix: string } | undefined;
    for (const one of prefixes) if (one.prefix && name.startsWith(`${one.prefix}_`) && name.length > one.prefix.length + 1 && (!best || one.prefix.length > best.prefix.length)) best = one;
    return best ? { server: best.server, tool: name.slice(best.prefix.length + 1) } : undefined;
  };
  for (const [server, tools] of cache) {
    const how = naming.get(server);
    if (how === undefined) continue;
    const prefix = adapterPrefix(server, how);
    for (const tool of tools) add(server, prefix ? `${prefix}_${sanitized(tool)}` : sanitized(tool), tool, false);
  }
  const other = new Set<string>();
  for (const tool of knownTools()) {
    const ofAdapter = typeof tool.package === "string" ? ADAPTER_PACKAGE.test(tool.package) : tool.source === "pi-mcp-adapter";
    if (!ofAdapter) other.add(tool.name);
    else if (!GATEWAY.includes(tool.name)) {
      const claimed = claim(tool.name);
      if (claimed) add(claimed.server, tool.name, claimed.tool, false);
    }
  }
  for (const name of switched) {
    if (names.map.has(name) || other.has(name) || GATEWAY.includes(name)) continue;
    const claimed = claim(name);
    if (claimed) add(claimed.server, name, claimed.tool, true);
  }
  return names;
}

/**
 * The switches that name the adapter's tools, changed to pi's names: a tool that was off stays off. The adapter's own `mcp`
 * tool (and its script tool) stood for every server's tools behind it: a list that has it off has all of them off now. Where it
 * was an exception ON (against defaults that had it off), it turned on the proxy and nothing else, and the tools off by
 * themselves stayed off: so it turns on the tools that were not off by themselves, and no more. `before`: the defaults and each
 * list as they were.
 */
function renameSwitches(names: Names): number {
  const db = getDb();
  const all = [...new Set([...names.byServer.values()].flatMap((tools) => [...tools]))];
  const defaultsOff = toolDefaultsOff();
  const defaultsHadGateway = defaultsOff.some((name) => GATEWAY.includes(name));
  const swap = (name: string): string[] => (names.guessed.has(name) ? [name, names.map.get(name)!] : [names.map.get(name)!]);
  const rename = (text: string | null | undefined, side: "off" | "on", sameOff: string[]): string | undefined => {
    const list = parseList(text);
    if (!list.some((name) => names.map.has(name) || GATEWAY.includes(name))) return undefined;
    const next = list.flatMap((name) => {
      if (names.map.has(name)) return swap(name);
      if (!GATEWAY.includes(name)) return [name];
      if (side === "off") return [name, ...all];
      if (!defaultsHadGateway) return [name];
      const own = new Set([...defaultsOff, ...sameOff]);
      return [name, ...[...names.map].filter(([old]) => !own.has(old)).map(([, next]) => next)];
    });
    return [...new Set(next)].sort().join("\n");
  };
  let changed = 0;
  for (const table of SWITCH_TABLES) {
    const key = keyOf(table);
    const rows = db.prepare(`SELECT ${key} AS k, tools_off, tools_on FROM ${table}`).all() as { k: string; tools_off: string; tools_on: string }[];
    for (const row of rows) {
      const off = rename(row.tools_off, "off", []);
      const on = rename(row.tools_on, "on", parseList(row.tools_off));
      if (off === undefined && on === undefined) continue;
      db.prepare(`UPDATE ${table} SET tools_off = ?, tools_on = ? WHERE ${key} = ?`).run(off ?? row.tools_off, on ?? row.tools_on, row.k);
      changed++;
    }
  }
  const defaults = rename(defaultsOff.join("\n"), "off", []);
  if (defaults !== undefined) {
    setToolDefaultsOff(parseList(defaults));
    changed++;
  }
  // A mark on one of the tools by name goes with it.
  const marks = toolMarks();
  const moved: ReturnType<typeof toolMarks> = {};
  for (const [entry, mark] of Object.entries(marks)) {
    const tool = entry.startsWith("<tool>") ? entry.slice(6) : undefined;
    if (tool !== undefined && names.map.has(tool)) {
      for (const next of swap(tool)) moved[next === tool ? entry : `<tool>${next}`] = mark;
    } else moved[entry] = mark;
  }
  if (!isDeepStrictEqual(moved, marks)) {
    setToolMarks(moved);
    changed++;
  }
  return changed;
}

/** Whether any list of switches has the adapter's own tool off: the portal then has to tell each server's tools. */
const hadGatewayOff = (): boolean => switchLists().off.some((list) => list.some((name) => GATEWAY.includes(name)));

/**
 * The project files in the adapter's dialect: a trusted project's `.pi/mcp.json` was read by the adapter too, and pi drops
 * what it cannot read of one (an `auth: "bearer"` entry among it). They are named, not converted.
 */
function projectFilesInAdapterDialect(): string[] {
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
  const found: string[] = [];
  for (const folder of folders) {
    const file = path.join(folder, ".pi", "mcp.json");
    try {
      if (existsSync(file) && inAdapterDialect(parseAdapterFile(readFileSync(file, "utf8")))) found.push(file);
    } catch {
      /* not readable: not ours to say anything of */
    }
  }
  return found.sort();
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
  const moved = carryOver(pi, text, adapter === undefined ? "none" : isSwitchedOff(adapter) ? "off" : "on");
  if ("error" in moved) {
    console.warn(`[portal] MCP: mcp.json cannot be read (${moved.error}), so the adapter's servers are not carried over to pi's own MCP support yet: fix the file in Settings → MCP, and restart.`);
    return;
  }
  // Nothing of the adapter's here: nothing to do now or later.
  if (!adapter && !moved.changed) {
    putSetting(MOVED, "1");
    return;
  }

  // Before the file changes and the cache goes: the tool names of the adapter, as the portal and the adapter kept them.
  const names = toolNames(pi, moved.naming, adapterCache(), switchedNames());
  // Where a list of switches had the adapter's own tool off and a server's tools are not known, that server's tools cannot be
  // put off by name: the server stays off, and is named, rather than starting where the person had MCP off.
  if (hadGatewayOff()) {
    for (const [name, entry] of Object.entries(moved.file.mcpServers)) {
      if (entry.enabled === false || names.byServer.has(name)) continue;
      entry.enabled = false;
      moved.carried = moved.carried.filter((one) => one !== name);
      moved.left.push({ name, why: "the tools of it are not known, and a list of switches had the adapter's own tool off, which stood for all of them" });
      moved.changed = true;
    }
  }
  const backup = `${file}.adapter`;
  if (moved.changed && !existsSync(backup)) writeFileAtomic(backup, text, 0o600);
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
  const renamed = renameSwitches(names);
  // What the portal kept to tell the adapter's tools of a removed server from another's: nothing reads it now. Nor the adapter's own
  // files of what each server offered and of how `npx` resolved a package, which pi's MCP support does not use.
  for (const key of ["mcp_removed", "mcp_configured"]) putSetting(key, "");
  for (const leftover of ["mcp-cache.json", "mcp-npx-cache.json"]) rmSync(path.join(piAgentDir(), leftover), { force: true });
  putSetting(MOVED, "1");

  const left = moved.left.map(({ name, why }) => `${name} (${why})`);
  const projects = projectFilesInAdapterDialect();
  console.log(
    `[portal] MCP: pi's own MCP support runs the servers now. ${moved.carried.length} servers of pi-mcp-adapter's configuration carried over to mcp.json` +
      `${moved.changed ? ` (the file as it was: ${backup})` : ""}${adapter ? ", pi-mcp-adapter taken out of pi's packages" : ""}` +
      `${renamed ? `, the names of its tools in ${renamed} lists of switches changed to pi's` : ""}.` +
      `${left.length ? ` Left off, which pi cannot take as they were (those with a name or a shape pi does not take are only in the copy): ${left.join("; ")}.` : ""}` +
      `${moved.imports.length ? ` Not carried over: what the adapter imported from ${moved.imports.join(", ")}.` : ""}` +
      `${projects.length ? ` Not converted, and to be changed by hand where pi drops what it cannot read of them: the projects' own files in the adapter's dialect: ${projects.join(", ")}.` : ""}`,
  );
}
