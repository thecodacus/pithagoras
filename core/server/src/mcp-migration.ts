import { existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { NAME_RE, gateOn, ignoredByPi, mcpConfigPath, writeMcpFile, type McpFile } from "./api/mcp.js";
import { getDb, getSetting, knownTools, packageRemoved, parseToolsOff, putSetting, setToolDefaultsOff, toolDefaultsOff } from "./db.js";
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
 * are dropped. A list of switches (portal-wide, a project, agent, routine, mode or chat) that had the adapter's `mcp` tool off
 * had MCP off (or one of its tools off by name): it switches off every server's tools by name now, so that nothing reaches further
 * than it did, and the entry goes; a server the adapter never listed tools of cannot be named there, and comes over switched off.
 * A project's own `.pi/mcp.json` is read by pi as it was by the adapter: the tools the adapter cached of its servers are named in those lists too.
 * A server with something pi has no word for is left as it was, switched off, and named in the one line the log gets; nothing of it
 * is lost, as it stays in the file. A bearer
 * token becomes the Authorization header pi takes: Understory's own entry had one. Not converted: the adapter's variables and
 * the names of its tools in the switches. Those are for the person to set again, which the docs say.
 */

/** Keys of the adapter's that say nothing pi needs: dropped where a server is carried over. */
const DROPPED = ["lifecycle", "idleTimeout", "requestTimeoutMs", "directTools", "debug", "trace", "toolPrefix", "disabled"] as const;

/** Keys of the adapter's that pi has no word for: a server with one of them is left off, named (see ignoredByPi). */
const REFUSED = ["socket", "includeTools", "excludeTools", "exposeResources", "approveTools"] as const;

/** The adapter's bearer token, and the variable that holds one: they become an Authorization header (see bearerHeader). */
const BEARER = ["bearerToken", "bearerTokenEnv"] as const;

export const ADAPTER_PACKAGE = /(^|[:/])pi-mcp-adapter(@[^/]*)?$/;

/** Whether a parsed file is in the adapter's dialect: its keys are in it. */
function inAdapterDialect(old: Record<string, unknown>): boolean {
  if (old.settings !== undefined || old.imports !== undefined) return true;
  const servers = old.mcpServers && typeof old.mcpServers === "object" ? Object.values(old.mcpServers as Record<string, unknown>) : [];
  // `auth` is pi's own key too, as an object (`{ provider }`): the adapter's was a word.
  return servers.some((entry) => entry && typeof entry === "object" && ([...DROPPED, ...REFUSED, ...BEARER].some((key) => key in (entry as object)) || typeof (entry as { auth?: unknown }).auth === "string"));
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

/** The entry as it was, switched off: what a server that cannot be carried over becomes. A gate the adapter had for every server is kept on it, so that it shows on the page and is not lost. */
function leftOff(entry: Record<string, unknown>, gate: unknown): Record<string, unknown> {
  return { ...entry, ...(gateOn(gate) && entry.approveTools === undefined ? { approveTools: true } : {}), enabled: false };
}

/** One server of the adapter's file, in pi's words, or why not: then it is as it was, switched off. `off`: nothing ran under the adapter, so nothing starts now. */
function convertEntry(pi: PiMcp, name: string, entry: Record<string, unknown>, off: boolean, gate: unknown): { entry: Record<string, unknown>; why?: string } {
  const why: string[] = [];
  // The keys that are carried over in another form (a bearer token, an OAuth block, variables) get their own reason below.
  for (const one of ignoredByPi(entry)) if ((REFUSED as readonly string[]).includes(one.key) && one.key !== "approveTools") why.push(one.why);
  // The adapter asked before each call of a tool: pi's MCP support does not, and the tools would run unasked.
  if (entry.approveTools !== undefined ? gateOn(entry.approveTools) : gateOn(gate)) why.push("tools that ask before each call (approveTools), which pi does not do");
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
    // `approveTools` that asks for nothing (`[]`, `false`) is gone with the adapter: one that asks left the server off above.
    const adapters = (DROPPED as readonly string[]).includes(key) || (BEARER as readonly string[]).includes(key) || (key === "oauth" && value === false) || (key === "auth" && typeof value !== "object") || key === "approveTools";
    if (!adapters) out[key] = value;
  }
  if (bearer.header) out.headers = { ...headers, Authorization: bearer.header };
  if (entry.disabled === true || off) out.enabled = false;
  if (!why.length) {
    const checked = pi.validateMcpServerConfig(name, out);
    if (typeof checked === "string") why.push(checked.replace(/^server "[^"]*": /, ""));
  }
  return why.length ? { entry: leftOff(entry, gate), why: why.join("; ") } : { entry: out };
}

/**
 * The adapter's mcp.json, in pi's dialect. Pure: nothing is read or written. `off`: nothing ran under the adapter (it was
 * switched off, or is not in pi's packages while the file is in its dialect), so nothing starts now.
 */
export function carryOver(pi: PiMcp, text: string, off: boolean): Carried | { error: string } {
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
  const carried: string[] = [];
  const left: { name: string; why: string }[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      left.push({ name, why: "it is not a server" });
      continue;
    }
    // pi names tools after a server, and takes letters, digits, `_` and `-` of it: `docs.v2` stays as it is, off, and Settings → MCP says why.
    const done = NAME_RE.test(name)
      ? convertEntry(pi, name, entry as Record<string, unknown>, off, settings.approveTools)
      : { entry: leftOff(entry as Record<string, unknown>, settings.approveTools), why: "pi does not take its name (letters, digits, dash and underscore only)" };
    file.mcpServers[name] = done.entry;
    if (done.why) left.push({ name, why: done.why });
    else carried.push(name);
  }
  // What else the file had that is pi's too (autoEnableCodemode) stays; the adapter's `settings` and `imports` go.
  for (const [key, value] of Object.entries(old)) if (!["mcpServers", "settings", "imports"].includes(key)) file[key] = value;
  const imports = Array.isArray(old.imports) ? old.imports.filter((one): one is string => typeof one === "string") : [];
  return { file, carried, left, imports, changed: !isDeepStrictEqual(parsed, file), dialect: inAdapterDialect(old) };
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
  /** How many lists had the adapter's `mcp` tool off, and now have every server's tools off. */
  lists: number;
  /** The servers the lists could not name a tool of (the adapter never listed one): the move switches them off, so that nothing reaches them where MCP was off. */
  unnamed: string[];
  /** Whether a list still names one of the adapter's own tools, which mean nothing now. */
  tools: boolean;
}

/**
 * The lists of switches, with the adapter's `mcp` tool taken out of them. Where one had it off, it has every tool of every
 * server off now (a group is a list of names, as it is for any group), pi's three resource tools included, so that the move
 * reaches no further than the adapter did; where it had it on, the entry only goes, and nothing is switched on by it.
 * A list that switched one of the adapter's own tools off (`github_delete_repo`) is read the same way as one that had `mcp` off:
 * the name means nothing to pi, which names the tool `mcp__github__delete_repo`, and the adapter kept such a tool off through
 * its proxy as well, so the list switches off every server's tools. `names`: the tools of each server as pi will name them.
 */
function moveSwitches(names: ReadonlyMap<string, string[]>, adapterTools: ReadonlySet<string>): MovedSwitches {
  const held = [...MCP_RESOURCE_TOOLS, ...[...names.values()].flat()];
  const moved: MovedSwitches = { lists: 0, unnamed: [], tools: false };
  const unnamed = [...names].filter(([, tools]) => !tools.length).map(([server]) => server);
  /** The list as it should be, or undefined where it needs no change. `off`: whether this is the list of what is off. */
  const redo = (list: string[], off: boolean): string[] | undefined => {
    const own = list.some((name) => adapterTools.has(name) && !GATEWAY.includes(name));
    const gateway = list.some((name) => GATEWAY.includes(name));
    if (own && !off) moved.tools = true;
    if (!gateway && !(own && off)) return undefined;
    const rest = list.filter((name) => !GATEWAY.includes(name));
    return off ? [...new Set([...rest, ...held])].sort() : rest;
  };
  // What a start before this one did, where it failed after the lists were rewritten: their entries are gone, so only this says which servers cannot be named.
  const before = heldBefore();
  const db = getDb();
  db.transaction(() => {
    const defaults = toolDefaultsOff();
    const next = redo(defaults, true);
    if (next) {
      setToolDefaultsOff(next);
      moved.lists++;
    }
    for (const table of SWITCH_TABLES) {
      const put = db.prepare(`UPDATE ${table} SET tools_off = ?, tools_on = ? WHERE rowid = ?`);
      for (const row of db.prepare(`SELECT rowid AS id, tools_off, tools_on FROM ${table}`).all() as { id: number; tools_off: string; tools_on: string }[]) {
        const off = parseToolsOff(row.tools_off);
        const on = parseToolsOff(row.tools_on);
        const offNow = redo(off, true);
        const onNow = redo(on, false);
        if (!offNow && !onNow) continue;
        put.run((offNow ?? off).join("\n"), (onNow ?? on).join("\n"), row.id);
        if (offNow) moved.lists++;
      }
    }
    if (moved.lists) moved.unnamed = unnamed;
    // In the same transaction as the lists: a start after a failure finds them done, and reads from here what they meant.
    if (moved.lists || moved.tools) putSetting(HELD, JSON.stringify(moved));
  })();
  return moved.lists || moved.tools ? moved : (before ?? moved);
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
  const moved = carryOver(pi, text, adapterOff);
  if ("error" in moved) {
    console.warn(`[portal] MCP: mcp.json cannot be read (${moved.error}), so the adapter's servers are not carried over to pi's own MCP support yet: fix the file in Settings → MCP, and restart.`);
    return;
  }
  // Nothing of the adapter's here (no package, a file that is pi's): nothing to do now or later. A file with the adapter's keys and no adapter is the adapter's all the same.
  if (!adapter && !moved.dialect) {
    putSetting(MOVED, "1");
    return;
  }

  // Before the adapter's cache goes: the tools of the servers it knew, by the names pi gives them. The lists that had the adapter's `mcp` tool off
  // switch them off by name; the move is one step, so a start after a failure finds them done.
  const cache = adapterCache();
  const names = new Map<string, string[]>();
  for (const server of Object.keys(moved.file.mcpServers)) if (NAME_RE.test(server)) names.set(server, namesOf(pi, server, cache.get(server) ?? []));
  // A project's own servers are not the file's to switch off, but where the adapter cached their tools the lists that had MCP off name them too.
  const projects = projectServers();
  for (const server of projects.flatMap((one) => one.servers)) if (NAME_RE.test(server) && !names.has(server) && cache.get(server)?.length) names.set(server, namesOf(pi, server, cache.get(server)!));
  const switches = moveSwitches(names, adapterTools);
  // A server with no tool to name (never connected, lazy and never used, or added after the cache was written) cannot be switched off in the lists that had MCP off,
  // and under the adapter those lists could not reach it: it comes over switched off, and the person switches it on knowingly in Settings → MCP.
  for (const name of switches.unnamed) {
    const entry = moved.file.mcpServers[name];
    if (entry && entry.enabled !== false) {
      entry.enabled = false;
      moved.changed = true;
    }
  }

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

  const left = moved.left.map(({ name, why }) => `${name} (${why})`);
  const apart = [...moved.imports.map((name) => `what the adapter imported from ${name}`), ...sharedFiles()];
  console.log(
    `[portal] MCP: pi's own MCP support runs the servers now. ${moved.carried.length} servers of pi-mcp-adapter's configuration carried over to mcp.json` +
      `${adapter ? ", pi-mcp-adapter taken out of pi's packages" : ""}.` +
      `${left.length ? ` Left off, as they were, because pi cannot take them as they are: ${left.join("; ")}.` : ""}` +
      `${apart.length ? ` Not read by pi, so not there any more: ${apart.join(", ")}.` : ""}` +
      `${switches.lists ? ` ${switches.lists} lists of switches (portal-wide, a project, agent, routine, mode or chat) had the adapter's \`mcp\` tool, or one of its tools, off: they have the tools of every server switched off by name now, and pi's resource tools too.${switches.unnamed.length ? ` The adapter never listed the tools of ${switches.unnamed.join(", ")}, so there is nothing to name for those: they are switched off, whatever they were. Switching one on in Settings → MCP puts its tools on wherever they are not switched off in Settings → Tools, so set the lists where MCP was off as you do.` : ""}` : ""}` +
      `${projects.length ? ` pi reads a project's own .pi/mcp.json as well now: ${projects.map((one) => one.file).join(", ")}. Its servers are on in that project wherever MCP was off, unless the adapter had listed their tools (those are switched off by name in the lists that had MCP off); one with a gate or an exclusion of the adapter's is not connected.` : ""}` +
      `${switches.tools ? " Switches that named the adapter's own tools in a list that had it on do nothing now." : ""}`,
  );
}
