import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic-write.js";
import { NAME_RE, mcpConfigPath, writeMcpFile, type McpFile } from "./api/mcp.js";
import { adapterServerOf, getDb, getSetting, knownTools, packageRemoved, putSetting, toolDefaultsOff, setToolDefaultsOff, toolMarks, setToolMarks } from "./db.js";
import { isSwitchedOff, sourceOf } from "./extension-switch.js";
import { piMcp, type PiMcp } from "./pi/mcp-config.js";
import { readPiSettings, updatePiSettingsNow } from "./pi-settings.js";

/**
 * Pithagoras ran MCP through `pi-mcp-adapter`, in its own dialect of mcp.json. pi has MCP support of its own now, in the same
 * file with other words, and the portal runs that: `moveFromAdapter` carries the servers over once, as the portal starts,
 * where the adapter's configuration is there, and takes the adapter out of the portal's pi. Nothing here runs after that.
 *
 * What it does, in one pass: the file is put into pi's dialect (the adapter's keys dropped, each server's on/off kept,
 * and no mark, so the server is Auto in Settings → Tools), the names of the adapter's tools that the portal's switches
 * hold are changed to pi's, and the adapter goes from pi's package list. A server whose entry cannot be carried over is
 * left off, and named in the one line the log gets. The file as it was is kept beside it, as `mcp.json.adapter`.
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

export interface Carried {
  /** The file in pi's dialect. */
  file: McpFile;
  /** The servers carried over, on or off as they were. */
  carried: string[];
  /** The servers left off, with why: what pi has no word for. */
  left: { name: string; why: string }[];
  /** What the adapter's file imported from other tools' configs, which pi does not. */
  imports: string[];
  /** Whether the file is not what it was: the adapter's keys were in it. */
  changed: boolean;
}

/**
 * One server of the adapter's file, in pi's words. `on`: the adapter was installed and on, which is what made a server's
 * entry a tool at all; where it was not, nothing was running and nothing starts now.
 */
function convertEntry(pi: PiMcp, name: string, entry: Record<string, unknown>, on: boolean): { entry: Record<string, unknown>; why?: string } {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) if (!(ADAPTER_KEYS as readonly string[]).includes(key)) out[key] = value;

  const unsupported: string[] = [];
  if (typeof entry.socket === "string" && entry.socket) unsupported.push("a Unix socket, which pi does not connect");
  if (Array.isArray(entry.includeTools) && entry.includeTools.length) unsupported.push("a list of the only tools it offers");
  if (Array.isArray(entry.excludeTools) && entry.excludeTools.length) unsupported.push("a list of tools it leaves out");
  if (entry.exposeResources === false) unsupported.push("its resources left out");
  if (out.oauth !== undefined) unsupported.push("an OAuth block of the adapter's");

  // How it signed in: a bearer token is a header in pi's file; OAuth is what pi does when the server answers 401.
  const auth = entry.auth;
  if (auth === "bearer") {
    const header =
      typeof entry.bearerToken === "string" && entry.bearerToken
        ? `Bearer ${entry.bearerToken}`
        : typeof entry.bearerTokenEnv === "string" && entry.bearerTokenEnv
          ? `Bearer \${${entry.bearerTokenEnv}}`
          : undefined;
    if (!header) unsupported.push("a bearer token that is neither written in it nor named from the environment");
    else out.headers = { ...(out.headers && typeof out.headers === "object" ? (out.headers as Record<string, unknown>) : {}), Authorization: header };
  } else if (auth !== undefined && auth !== "oauth" && auth !== false) {
    unsupported.push("a way of signing in pi does not have");
  }

  // Off as the adapter had it (`disabled`), and off where the adapter was not on to run it.
  const off = entry.disabled === true || !on;
  if (off) out.enabled = false;

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

/** The adapter's mcp.json, in pi's dialect. Pure: nothing is read or written. */
export function carryOver(pi: PiMcp, text: string, adapterOn: boolean): Carried | { error: string } {
  let parsed: unknown;
  try {
    parsed = text.trim() ? JSON.parse(stripComments(text)) : {};
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "not an object" };
  const old = parsed as Record<string, unknown>;
  const servers = old.mcpServers && typeof old.mcpServers === "object" && !Array.isArray(old.mcpServers) ? (old.mcpServers as Record<string, unknown>) : {};

  const file: McpFile = { mcpServers: {} };
  const carried: string[] = [];
  const left: { name: string; why: string }[] = [];
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
    const done = convertEntry(pi, name, entry as Record<string, unknown>, adapterOn);
    file.mcpServers[name] = done.entry;
    if (done.why) left.push({ name, why: done.why });
    else carried.push(name);
  }
  // What else the file had that is pi's too (autoEnableCodemode) stays; the adapter's `settings` and `imports` go.
  for (const [key, value] of Object.entries(old)) if (!["mcpServers", "settings", "imports"].includes(key)) file[key] = value;
  const imports = Array.isArray(old.imports) ? old.imports.filter((one): one is string => typeof one === "string") : [];
  return { file, carried, left, imports, changed: inAdapterDialect(old) };
}

/** The names of the adapter's tools the portal remembers, and pi's for them: `<server>_<tool>` and `mcp__<server>__<tool>`. */
function toolNames(pi: PiMcp, servers: string[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const tool of knownTools()) {
    const ofAdapter = typeof tool.package === "string" ? ADAPTER_PACKAGE.test(tool.package) : tool.source === "pi-mcp-adapter";
    if (!ofAdapter || ["mcp", "mcp_script", "mcpScript"].includes(tool.name)) continue;
    const server = adapterServerOf(tool.name, servers);
    if (server === undefined) continue;
    names.set(tool.name, pi.createMcpToolName(server, tool.name.slice(server.replace(/-/g, "_").length + 1)));
  }
  return names;
}

/** A list of names as the database stores it. */
const parseList = (text: string | null | undefined): string[] => (text ?? "").split("\n").map((name) => name.trim()).filter(Boolean);

/**
 * The switches that name the adapter's tools, changed to pi's names: a tool that was off stays off. The adapter's own `mcp`
 * tool (and its script tool) stood for every server's tools behind it, so a list that has it off now has all of them off.
 * Tools the portal never saw are not named by a switch it can change, and keep what they have.
 */
function renameSwitches(names: Map<string, string>): number {
  const db = getDb();
  const gateway = ["mcp", "mcp_script", "mcpScript"];
  const all = [...names.values()];
  const rename = (text: string | null | undefined): string | undefined => {
    const list = parseList(text);
    if (!list.some((name) => names.has(name) || gateway.includes(name))) return undefined;
    const next = list.flatMap((name) => (names.has(name) ? [names.get(name)!] : gateway.includes(name) ? [name, ...all] : [name]));
    return [...new Set(next)].sort().join("\n");
  };
  let changed = 0;
  for (const table of ["sessions", "project_tools", "agent_tools", "routines", "chat_modes"]) {
    const key = table === "sessions" ? "id" : table === "project_tools" ? "project" : table === "agent_tools" ? "agent" : table === "routines" ? "slug" : "id";
    const rows = db.prepare(`SELECT ${key} AS k, tools_off, tools_on FROM ${table}`).all() as { k: string; tools_off: string; tools_on: string }[];
    for (const row of rows) {
      const off = rename(row.tools_off);
      const on = rename(row.tools_on);
      if (off === undefined && on === undefined) continue;
      db.prepare(`UPDATE ${table} SET tools_off = ?, tools_on = ? WHERE ${key} = ?`).run(off ?? row.tools_off, on ?? row.tools_on, row.k);
      changed++;
    }
  }
  const defaults = rename(toolDefaultsOff().join("\n"));
  if (defaults !== undefined) {
    setToolDefaultsOff(parseList(defaults));
    changed++;
  }
  // A mark on one of the tools by name goes with it.
  const marks = toolMarks();
  const moved = Object.fromEntries(Object.entries(marks).map(([entry, mark]) => [entry.startsWith("<tool>") && names.has(entry.slice(6)) ? `<tool>${names.get(entry.slice(6))}` : entry, mark]));
  if (JSON.stringify(moved) !== JSON.stringify(marks)) {
    setToolMarks(moved);
    changed++;
  }
  return changed;
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
  const moved = carryOver(pi, text, adapter !== undefined && !isSwitchedOff(adapter));
  if ("error" in moved) {
    console.warn(`[portal] MCP: mcp.json cannot be read (${moved.error}), so the adapter's servers are not carried over to pi's own MCP support yet: fix the file in Settings → MCP, and restart.`);
    return;
  }
  // Nothing of the adapter's here: nothing to do now or later.
  if (!adapter && !moved.changed) {
    putSetting(MOVED, "1");
    return;
  }

  // Before the file changes: the tool names the portal remembers, which the adapter gave, and the servers as they were named.
  const names = toolNames(pi, Object.keys(moved.file.mcpServers));
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
  // What the portal kept to tell the adapter's tools of a removed server from another's: nothing reads it now.
  for (const key of ["mcp_removed", "mcp_configured"]) putSetting(key, "");
  putSetting(MOVED, "1");

  const left = moved.left.map(({ name, why }) => `${name} (${why})`);
  console.log(
    `[portal] MCP: pi's own MCP support runs the servers now. ${moved.carried.length} servers of pi-mcp-adapter's configuration carried over to mcp.json` +
      `${moved.changed ? ` (the file as it was: ${backup})` : ""}${adapter ? ", pi-mcp-adapter taken out of pi's packages" : ""}` +
      `${renamed ? `, the names of its tools in ${renamed} lists of switches changed to pi's` : ""}.` +
      `${left.length ? ` Left off, which pi cannot take as they were (those with a name or a shape pi does not take are only in the copy): ${left.join("; ")}.` : ""}` +
      `${moved.imports.length ? ` Not carried over: what the adapter imported from ${moved.imports.join(", ")}.` : ""}`,
  );
}
