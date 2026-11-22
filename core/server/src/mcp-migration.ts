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

/**
 * Pithagoras ran MCP through `pi-mcp-adapter`, in its own dialect of mcp.json. pi has MCP support of its own now, in the same
 * file with other words, and the portal runs that: `moveFromAdapter` carries the servers over once, as the portal starts,
 * where the adapter's configuration is there, and takes the adapter out of the portal's pi. Nothing here runs after that.
 *
 * The servers keep what they were, on or off, and have no mark, so they are Auto in Settings → Tools. The adapter's own keys
 * are dropped. A list of switches (portal-wide, a project, agent, routine, mode or chat) that had the adapter's `mcp` tool off
 * had MCP off: it switches off every server's tools by name now, so that nothing reaches further than it did, and the entry goes. A server with something pi has no word for is left as it was, switched off, and named in the one line the log
 * gets; nothing of it is lost, as it stays in the file. A bearer
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
  for (const one of ignoredByPi(entry)) if (one.key !== "approveTools") why.push(one.why);
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

export interface MovedSwitches {
  /** How many lists had the adapter's `mcp` tool off, and now have every server's tools off. */
  lists: number;
  /** The servers the lists could not name a tool of: the adapter never listed one, so it is only switched off once a chat has seen it. */
  unnamed: string[];
  /** Whether a list still names one of the adapter's own tools, which mean nothing now. */
  tools: boolean;
}

/**
 * The lists of switches, with the adapter's `mcp` tool taken out of them. Where one had it off, it has every tool of every
 * server off now (a group is a list of names, as it is for any group), pi's three resource tools included, so that the move
 * reaches no further than the adapter did; where it had it on, the entry only goes, and nothing is switched on by it.
 * `names`: the tools of each server as pi will name them.
 */
function moveSwitches(names: ReadonlyMap<string, string[]>, adapterTools: ReadonlySet<string>): MovedSwitches {
  const held = [...MCP_RESOURCE_TOOLS, ...[...names.values()].flat()];
  const moved: MovedSwitches = { lists: 0, unnamed: [], tools: false };
  const unnamed = [...names].filter(([, tools]) => !tools.length).map(([server]) => server);
  /** The list as it should be, or undefined where it names no `mcp`. `off`: whether this is the list of what is off. */
  const redo = (list: string[], off: boolean): string[] | undefined => {
    if (list.some((name) => adapterTools.has(name))) moved.tools = true;
    if (!list.some((name) => GATEWAY.includes(name))) return undefined;
    const rest = list.filter((name) => !GATEWAY.includes(name));
    return off ? [...new Set([...rest, ...held])].sort() : rest;
  };
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
  })();
  if (moved.lists) moved.unnamed = unnamed;
  return moved;
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
  for (const server of Object.keys(moved.file.mcpServers)) if (NAME_RE.test(server)) names.set(server, (cache.get(server) ?? []).map((tool) => pi.createMcpToolName(server, tool)));
  const switches = moveSwitches(names, adapterTools);

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

  const left = moved.left.map(({ name, why }) => `${name} (${why})`);
  const apart = [...moved.imports.map((name) => `what the adapter imported from ${name}`), ...sharedFiles()];
  console.log(
    `[portal] MCP: pi's own MCP support runs the servers now. ${moved.carried.length} servers of pi-mcp-adapter's configuration carried over to mcp.json` +
      `${adapter ? ", pi-mcp-adapter taken out of pi's packages" : ""}.` +
      `${left.length ? ` Left off, as they were, because pi cannot take them as they are: ${left.join("; ")}.` : ""}` +
      `${apart.length ? ` Not read by pi, so not there any more: ${apart.join(", ")}.` : ""}` +
      `${switches.lists ? ` ${switches.lists} lists of switches (portal-wide, a project, agent, routine, mode or chat) had the adapter's \`mcp\` tool off: they have the tools of every server switched off by name now, and pi's resource tools too.${switches.unnamed.length ? ` The adapter never listed the tools of ${switches.unnamed.join(", ")}, so there is nothing to name for those: switch them off in Settings → Tools once a chat has seen them.` : ""}` : ""}` +
      `${switches.tools ? " Switches that named the adapter's own tools do nothing now." : ""}`,
  );
}
