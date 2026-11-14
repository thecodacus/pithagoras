import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import express, { type Router } from "express";
import { writeFileAtomic } from "../atomic-write.js";
import { SERVER_NAME_RE, clashes, commandValues, entryProblem, mcpNamespace, withExposure } from "../mcp-config.js";
import { adapterKeysOf } from "../mcp-migration.js";
import { piAgentDir } from "../pi-settings.js";
import { BROWSER_MCP } from "../tool-policy.js";

/**
 * MCP servers, as pi's own MCP support reads them.
 *
 * pi reads `<agent dir>/mcp.json` (the file this portal edits: every session here shares one agent home) and, in a
 * trusted project, `<project>/.pi/mcp.json`. The shape is pi's (`docs/mcp.md`): `command` or `url`, `env`, `headers`,
 * `enabled`, `exposure`, `toolExposure` and the rest. What is the portal's own (whether the person trusts a server's
 * output, which tools need a confirmation, whether the server is lazy) is kept in its database by the server's name, and
 * not in the file, so that the file is valid for pi alone: the pi CLI and the container executor read it too.
 *
 * Entries are stored as given rather than filtered through a whitelist, so a field a newer pi understands survives a
 * round trip through this API.
 */
export const mcpConfigPath = (): string => path.join(piAgentDir(), "mcp.json");

export interface McpFile {
  mcpServers: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * The file may carry comments (the portal has always accepted them, and refusing to read one would make the panel wrong
 * about a setup that works for it). pi itself reads plain JSON.
 */
function stripComments(text: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[++i] ?? "";
      } else if (c === quote) {
        inString = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

let lastReadable: McpFile | undefined;

/**
 * The configuration as it last could be read: the file now, or, while it cannot be parsed, what it was before. Which
 * servers a write took out is judged by this: a typo in the file must not make the write that fixes it forget the servers
 * it leaves out. Undefined where the file has not been readable since the portal started.
 */
export function readableMcpConfig(): McpFile | undefined {
  const { config, error } = readMcpFile();
  if (!error) lastReadable = config;
  return lastReadable;
}

export function readMcpFile(): { config: McpFile; raw: string; error?: string } {
  const file = mcpConfigPath();
  if (!existsSync(file)) return { config: { mcpServers: {} }, raw: "" };
  const raw = readFileSync(file, "utf8");
  try {
    const parsed = JSON.parse(stripComments(raw));
    const config: McpFile = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as McpFile) : { mcpServers: {} };
    if (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) config.mcpServers = {};
    return { config, raw };
  } catch (e) {
    // Hand it back unparsed rather than silently starting from scratch — the raw editor is how a broken file gets fixed,
    // and overwriting it would destroy the servers someone already configured.
    return { config: { mcpServers: {} }, raw, error: (e as Error).message };
  }
}

/** The names of the servers configured in the user's file. */
export function mcpServerNames(): string[] {
  try {
    return Object.keys(readMcpFile().config.mcpServers ?? {});
  } catch {
    return [];
  }
}

/** The servers of a configuration that attach to a browser that is already running, whatever they are called. */
function connectedIn(config: McpFile): string[] {
  const names: string[] = [];
  for (const [name, entry] of Object.entries(config.mcpServers ?? {})) {
    // An entry that is not an object (`"old": null`) is no server that attaches to anything.
    const args = entry && typeof entry === "object" ? (entry as { args?: unknown }).args : undefined;
    if (Array.isArray(args) && args.includes("--cdp-endpoint")) names.push(name);
  }
  return names;
}

/**
 * Which servers are the agent's browser.
 *
 * Found by what they connect to, not by a name: `--cdp-endpoint` is what makes a Playwright server a browser the agent is
 * signed into, at whatever address, rather than a throwaway Chromium, and an entry written by hand or by an older portal
 * may be called anything. One called `browser` counts too — it is the name the portal wrote, and has always looked for.
 */
export function browserServers(): string[] {
  return serversAndBrowsers().browsers;
}

/** The servers configured and which of them are the browser, from one read of the file: what a pass over many conversations asks once. */
export function serversAndBrowsers(): { servers: string[]; browsers: string[] } {
  const config = readMcpFile().config;
  const servers = Object.keys(config.mcpServers ?? {});
  const browsers = new Set(connectedIn(config));
  if (servers.includes(BROWSER_MCP)) browsers.add(BROWSER_MCP);
  return { servers, browsers: [...browsers] };
}

/**
 * The file holds the keys and tokens of the MCP servers, so it is for its owner alone, and put in place whole: one cut
 * off by a full disk would take every MCP server with it.
 */
export function writeMcpText(text: string): void {
  const file = mcpConfigPath();
  const before = Object.keys(readableMcpConfig()?.mcpServers ?? {});
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, text.endsWith("\n") ? text : text + "\n", 0o600);
  mcpWritten(before);
}

const writtenListeners = new Set<(before: string[]) => void>();

/**
 * Tell the listeners (onMcpWritten) that the file was written, with the servers it had before: by writeMcpText, after its
 * write, and for an edit made outside the portal that adds or takes out a server, once it is noticed (db.ts
 * noticeMcpEdits), with the servers the portal last saw in the file.
 */
export function mcpWritten(before: string[]): void {
  for (const listener of [...writtenListeners]) {
    try {
      listener(before);
    } catch (e) {
      console.error(`[portal] could not take in the MCP configuration that was written: ${(e as Error).message}`);
    }
  }
}

/**
 * Told after every write of the file, whoever wrote it — a route of the panel, a feature switched off, or an edit made
 * outside the portal that adds or takes out a server, once it is noticed — with the servers it had before. pi reads the
 * file when a chat starts or is loaded again, so a running chat has to be loaded again to notice a server added, changed
 * or taken out. Returns the way to stop listening.
 */
export function onMcpWritten(listener: (before: string[]) => void): () => void {
  writtenListeners.add(listener);
  return () => writtenListeners.delete(listener);
}

export function writeMcpFile(config: McpFile): void {
  writeMcpText(JSON.stringify(config, null, 2));
}

/** What `mcpServer` answers from: the servers as the file was when last read. */
let lastRead: { stamp: string; servers?: McpFile["mcpServers"] } | undefined;

/** When mcp.json last changed: read again only when it did. */
function fileStamp(): string {
  try {
    const st = statSync(mcpConfigPath());
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-";
  }
}

/** Whether a server is switched on in its entry: `enabled` is pi's key; `disabled` is how the adapter said it, and still means off. */
export const entryEnabled = (entry: Record<string, unknown>): boolean => entry.enabled !== false && entry.disabled !== true;

/**
 * The server of that name, and whether the chats have its tools now (`on`): it is there and not switched off. Asked each
 * time a chat starts, and read from the file whenever it changed, so mcp.json is the one place it is said. Nothing where
 * there is no such server, or the file cannot be read.
 */
export function mcpServer(name: string): { entry: Record<string, unknown>; on: boolean } | undefined {
  const stamp = fileStamp();
  if (lastRead?.stamp !== stamp) {
    let servers: McpFile["mcpServers"] | undefined;
    try {
      const { config, error } = readMcpFile();
      if (!error) servers = config.mcpServers;
    } catch {
      // Not readable: no server is there.
    }
    lastRead = { stamp, servers };
  }
  const { servers } = lastRead;
  const entry = servers && Object.prototype.hasOwnProperty.call(servers, name) ? servers[name] : undefined;
  if (!entry || typeof entry !== "object") return undefined;
  // A copy: what the next caller is told is the file's, not what this one made of it.
  return { entry: structuredClone(entry), on: entryEnabled(entry) };
}

/** stdio and http are mutually exclusive in pi. */
function transportOf(entry: Record<string, unknown>): "stdio" | "http" | "unknown" {
  if (typeof entry.command === "string" && entry.command) return "stdio";
  if (typeof entry.url === "string" && entry.url) return "http";
  return "unknown";
}

/**
 * Why this entry cannot be written under this name, or null: what pi would skip it for, and a name that pi would take for
 * another server's (it folds `-` and `_`, and refuses the second).
 */
export function validateEntry(name: string, entry: unknown, others: Iterable<string> = []): string | null {
  const problem = entryProblem(name, entry);
  if (problem) return problem;
  // pi takes a blank one as a command to run or an address to open, and fails on it at every start: not worth writing.
  const e = entry as Record<string, unknown>;
  if ((typeof e.command === "string" && !e.command.trim()) || (typeof e.url === "string" && !e.url.trim())) return `server "${name}" needs a command or an address that is not blank`;
  const clash = [...others].find((other) => other !== name && mcpNamespace(other) === mcpNamespace(name));
  return clash ? `"${name}" would be taken for "${clash}": pi puts - and _ together, and takes one of the two` : null;
}

/** An entry that is an override of a server defined elsewhere, as pi's project files have them. */
const isOverride = (entry: Record<string, unknown>): boolean => entry.command === undefined && entry.url === undefined && entry.type === undefined;
const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];

/** One server a chat reads: where it came from decides what the guard may take for granted of it. */
export interface ChatServer {
  name: string;
  entry: Record<string, unknown>;
  /** The portal's own file, or the project's `.pi/mcp.json`. */
  from: "user" | "project";
}

/**
 * The servers a chat reads, as pi's own `loadMcpConfig` would: the user's file, and in a trusted project its
 * `.pi/mcp.json`, which pi reads only then. Not other tools' configs (`.mcp.json`, `.vscode/mcp.json`, `opencode.json`):
 * pi reads none of them. A project's entry with no `command`, `url` or `type` overrides `enabled`, `exposure` and
 * `toolExposure` of the user's server of that name and keeps the rest of it, credentials included; a project's `auth` is
 * refused; and a project's entry that is a whole server cannot take a name that is the user's, or one pi would fold into
 * it: a server of the portal's file is defined there and nowhere else, whatever a repository says (the guard attributes a
 * tool to a server by name, and trusts the ones the person named).
 */
export function chatServers(cwd: string, projectTrusted: boolean): { servers: ChatServer[]; errors: string[] } {
  const errors: string[] = [];
  const servers = new Map<string, ChatServer>();
  const user = readableMcpConfig()?.mcpServers ?? {};
  for (const [name, entry] of Object.entries(user)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    // pi ignores the adapter's keys, and a server that was held back by them (`includeTools`, `directTools`) would come in whole: it is not connected.
    const old = adapterKeysOf(entry);
    // One that is off connects nothing, whatever it says.
    if (old.length && entryEnabled(entry as Record<string, unknown>)) {
      errors.push(`mcp.json: server "${name}" is written for the old MCP adapter (${old.join(", ")}) and is not connected until it is changed to pi's keys; Settings → MCP shows how`);
      continue;
    }
    servers.set(name, { name, entry: { ...entry }, from: "user" });
  }
  if (projectTrusted) {
    const file = path.join(cwd, ".pi", "mcp.json");
    let parsed: unknown;
    try {
      if (existsSync(file)) parsed = JSON.parse(stripComments(readFileSync(file, "utf8")));
    } catch (e) {
      errors.push(`${file}: ${(e as Error).message}`);
    }
    const projectServers = (parsed as { mcpServers?: unknown } | undefined)?.mcpServers;
    if (projectServers && typeof projectServers === "object" && !Array.isArray(projectServers)) {
      for (const [name, value] of Object.entries(projectServers as Record<string, unknown>)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          errors.push(`${file}: server "${name}" must be an object`);
          continue;
        }
        const entry = value as Record<string, unknown>;
        if (isOverride(entry)) {
          const base = servers.get(name);
          const extra = Object.keys(entry).filter((key) => !OVERRIDE_KEYS.includes(key));
          if (!base) errors.push(`${file}: server "${name}" needs "command" or "url", or a server of the user's to override`);
          else if (extra.length) errors.push(`${file}: server "${name}": an override can only set ${OVERRIDE_KEYS.join(", ")}`);
          else servers.set(name, { ...base, entry: { ...base.entry, ...entry } });
          continue;
        }
        const clash = [...servers.keys()].find((other) => mcpNamespace(other) === mcpNamespace(name));
        if (clash) {
          errors.push(`${file}: server "${name}" is the user's "${clash}", which the project cannot define again`);
          continue;
        }
        if ("auth" in entry) {
          errors.push(`${file}: server "${name}": auth is only allowed in the user's mcp.json`);
          continue;
        }
        const old = adapterKeysOf(entry);
        if (old.length) {
          errors.push(`${file}: server "${name}" is written for the old MCP adapter (${old.join(", ")}) and is not connected until it is changed to pi's keys`);
          continue;
        }
        servers.set(name, { name, entry: { ...entry }, from: "project" });
      }
    }
  }
  return { servers: [...servers.values()], errors };
}

export function mcpRouter(): Router {
  const router = express.Router();

  router.get("/mcp", async (_req, res) => {
    try {
      const { config, raw, error } = readMcpFile();
      const names = Object.keys(config.mcpServers);
      const servers = Object.entries(config.mcpServers).map(([name, entry]) => ({
        name,
        entry,
        transport: transportOf(entry as Record<string, unknown>),
        disabled: !entryEnabled((entry ?? {}) as Record<string, unknown>),
        // What pi would skip it for, which the page shows beside the server.
        problem: validateEntry(name, entry, names),
        commands: commandValues(entry),
      }));
      res.json({
        path: mcpConfigPath(),
        exists: existsSync(mcpConfigPath()),
        servers,
        clashes: clashes(names),
        raw,
        parseError: error ?? null,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** Create or change one server. `from` renames an existing entry; a name that is taken by another is refused. */
  router.put("/mcp/servers/:name", (req, res) => {
    const name = req.params.name;
    const from = typeof req.body?.from === "string" ? req.body.from : null;
    if (!SERVER_NAME_RE.test(name)) {
      return res.status(400).json({ error: "Name must be letters, digits, dash or underscore" });
    }
    const { config, error } = readMcpFile();
    if (error) return res.status(409).json({ error: `Fix the file first: ${error}` });
    const others = Object.keys(config.mcpServers).filter((other) => other !== from);
    const problem = validateEntry(name, req.body?.entry, others);
    if (problem) return res.status(400).json({ error: problem });
    // An entry of that name already there is somebody's setup — environment, headers, an oauth block the form does not show — and a new or renamed server would replace it unseen.
    if (name !== from && Object.prototype.hasOwnProperty.call(config.mcpServers, name)) {
      return res.status(409).json({ error: `A server called ${name} already exists`, code: "exists" });
    }
    // A rename removes the old name, and its tools are not the new one's (see writeMcpText).
    if (from && from !== name) delete config.mcpServers[from];
    config.mcpServers[name] = withExposure(req.body.entry);
    try {
      writeMcpFile(config);
      res.json({ ok: true, commands: commandValues(req.body.entry) });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.delete("/mcp/servers/:name", (req, res) => {
    const { config, error } = readMcpFile();
    if (error) return res.status(409).json({ error: `Fix the file first: ${error}` });
    delete config.mcpServers[req.params.name];
    try {
      writeMcpFile(config);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /**
   * Merge a pasted config. Every MCP server's README hands out the same blob, so accepting it directly beats retyping it
   * into a form field by field.
   */
  router.post("/mcp/import", (req, res) => {
    const text = req.body?.text;
    if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "Nothing to import" });

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripComments(text));
    } catch (e) {
      return res.status(400).json({ error: `Not valid JSON: ${(e as Error).message}` });
    }
    if (!parsed || typeof parsed !== "object") return res.status(400).json({ error: "Expected a JSON object" });

    // Either the whole file, or just the servers map, or a single entry.
    const obj = parsed as Record<string, unknown>;
    const incoming = (
      obj.mcpServers && typeof obj.mcpServers === "object" ? obj.mcpServers : obj
    ) as Record<string, unknown>;

    const { config, error } = readMcpFile();
    if (error) return res.status(409).json({ error: `Fix the file first: ${error}` });

    const added: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    const commands: Record<string, string[]> = {};
    for (const [name, entry] of Object.entries(incoming)) {
      if (name === "settings" || name === "imports" || name === "autoEnableCodemode") continue;
      if (!SERVER_NAME_RE.test(name)) {
        skipped.push({ name, reason: "Unusable name" });
        continue;
      }
      const problem = validateEntry(name, entry, Object.keys(config.mcpServers));
      if (problem) {
        skipped.push({ name, reason: problem });
        continue;
      }
      // As the form's save refuses it: what is there is somebody's setup, and a pasted README snippet would replace it unseen.
      if (Object.prototype.hasOwnProperty.call(config.mcpServers, name)) {
        skipped.push({ name, reason: `A server called ${name} already exists` });
        continue;
      }
      config.mcpServers[name] = withExposure(entry as Record<string, unknown>);
      added.push(name);
      const run = commandValues(entry);
      if (run.length) commands[name] = run;
    }
    if (!added.length && !skipped.length) {
      return res.status(400).json({ error: "No servers found in that JSON" });
    }
    try {
      if (added.length) {
        writeMcpFile(config);
      }
      res.json({ ok: true, added, skipped, commands });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** The escape hatch: the file itself, for anything the forms do not cover. */
  router.put("/mcp/raw", (req, res) => {
    const content = req.body?.content;
    if (typeof content !== "string") return res.status(400).json({ error: "content required" });
    // Unlike the portal, which has always read a file with comments in it, pi reads this one with a plain JSON.parse: a comment
    // saved here would make its own command line and a container's pi skip every server.
    try {
      JSON.parse(content);
    } catch (e) {
      return res.status(400).json({ error: `Not valid JSON: ${(e as Error).message}` });
    }
    try {
      writeMcpText(content);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}
