import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import express, { type Router } from "express";
import { writeFileAtomic } from "../atomic-write.js";
import { isSwitchedOff, sourceOf } from "../extension-switch.js";
import { piAgentDir, piSettingsPath, readPiSettings } from "../pi-settings.js";
import { BROWSER_MCP } from "../tool-policy.js";

/**
 * MCP servers, as configured for `pi-mcp-adapter`.
 *
 * The adapter reads several files in precedence order; the portal edits the
 * pi-global one at `<agentDir>/mcp.json`, because every session here shares an
 * agent home and a project-local `.mcp.json` would only reach one workspace.
 *
 * The shape is the adapter's, not ours — entries are stored as given rather
 * than filtered through a whitelist, so a field a newer adapter understands
 * survives a round trip through this API.
 */
export const mcpConfigPath = (): string => path.join(piAgentDir(), "mcp.json");

const ADAPTER = "pi-mcp-adapter";

/**
 * Pinned, not whatever npm has today.
 *
 * 3.0 stopped reading `<agentDir>/mcp.json` — the file this portal writes — in
 * favour of `mcp-adapter.json`, and from 2.21.1 the adapter wants pi-ai 0.84 or
 * later where the portal runs 0.82. An unpinned install picked up 3.3 and the
 * agent saw no servers at all. 2.18.0 is the release the portal runs with.
 */
export const ADAPTER_SPEC = `npm:${ADAPTER}@2.18.0`;

export const NAME_RE = /^[A-Za-z0-9][\w.-]*$/;

export interface McpFile {
  mcpServers: Record<string, Record<string, unknown>>;
  settings?: Record<string, unknown>;
  imports?: string[];
  [key: string]: unknown;
}

/**
 * The adapter parses its config with strip-json-comments, so a hand-written
 * file may carry comments and still be valid to it. Refusing to read one would
 * make the panel wrong about a working setup.
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
 * The configuration as it last could be read: the file now, or, while it
 * cannot be parsed, what it was before. What the servers offer is judged by
 * this (db.ts mcpView), and so is which servers a write took out: a typo in
 * the file must neither withdraw a tool nor hand back one that was withdrawn,
 * nor make the write that fixes it forget the servers it leaves out.
 * Undefined where the file has not been readable since the portal started.
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
    const config: McpFile =
      parsed && typeof parsed === "object" ? (parsed as McpFile) : { mcpServers: {} };
    if (!config.mcpServers || typeof config.mcpServers !== "object") config.mcpServers = {};
    return { config, raw };
  } catch (e) {
    // Hand it back unparsed rather than silently starting from scratch — the
    // raw editor is how a broken file gets fixed, and overwriting it would
    // destroy the servers someone already configured.
    return { config: { mcpServers: {} }, raw, error: (e as Error).message };
  }
}

/**
 * The names of the servers configured, which is what tells an MCP tool apart
 * from any other: the adapter registers them all as one package and names each
 * tool `<server>_<tool>`.
 */
export function mcpServerNames(): string[] {
  try {
    return Object.keys(readMcpFile().config.mcpServers ?? {});
  } catch {
    return [];
  }
}

/**
 * The adapter's own file of what each server offered, `servers.<name>`, which
 * it reads to list tools before a server has been started. A server that is
 * removed from the configuration leaves its entry there, and its tools with it.
 */
export const mcpCachePath = (): string => path.join(piAgentDir(), "mcp-cache.json");

/** The adapter's cache as it is on disk, or null where it is not there or cannot be read. */
export function readMcpCache(): { servers?: Record<string, { tools?: unknown; resources?: unknown } | undefined> } | null {
  try {
    const cache = JSON.parse(readFileSync(mcpCachePath(), "utf8"));
    const servers = cache?.servers;
    return servers && typeof servers === "object" && !Array.isArray(servers) ? cache : null;
  } catch {
    return null;
  }
}

/**
 * Take the named servers out of the adapter's cache. A cache that is not there
 * or cannot be read is left alone: it is the adapter's file, it rebuilds it,
 * and a removal that is done must not fail over it.
 */
export function dropMcpCache(names: string[]): void {
  const file = mcpCachePath();
  try {
    const cache = JSON.parse(readFileSync(file, "utf8"));
    const servers = cache?.servers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return;
    const present = names.filter((name) => Object.prototype.hasOwnProperty.call(servers, name));
    if (!present.length) return;
    for (const name of present) delete servers[name];
    writeFileAtomic(file, JSON.stringify(cache, null, 2) + "\n");
  } catch {
    // Missing, unparsable or not writable.
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
 * Found by what they connect to, not by a name: `--cdp-endpoint` is what makes
 * a Playwright server a browser the agent is signed into, at whatever address,
 * rather than a throwaway Chromium, and an entry written by hand or by an older
 * portal may be called anything. One called `browser` counts too — it is the
 * name the portal wrote, and has always looked for.
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
 * The file holds the keys and tokens of the MCP servers, so it is for its
 * owner alone, and put in place whole: one cut off by a full disk would take
 * every MCP server with it.
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
 * Tell the listeners (onMcpWritten) that the file was written, with the
 * servers it had before: by writeMcpText, after its write, and for an edit
 * made outside the portal that adds or takes out a server, once it is noticed
 * (db.ts noticeMcpEdits), with the servers the portal last saw in the file.
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
 * Told after every write of the file, whoever wrote it — a route of the panel,
 * a feature switched off, the browser moved over, or an edit made outside the
 * portal that adds or takes out a server, once it is noticed — with the
 * servers it had before: what the configuration offers decides which tools a
 * running chat may still use (see mcp-offer.ts), and a chat that has to be
 * restarted to notice a server switched off is a switch that looks broken.
 * Returns the way to stop listening.
 */
export function onMcpWritten(listener: (before: string[]) => void): () => void {
  writtenListeners.add(listener);
  return () => writtenListeners.delete(listener);
}

export function writeMcpFile(config: McpFile): void {
  writeMcpText(JSON.stringify(config, null, 2));
}

/**
 * pi-mcp-adapter as pi's settings list it, if they do: without it, none of this
 * configuration does anything, and no MCP server is a tool. Read from the
 * settings, not by asking `pi list`: that starts pi, which takes a second or
 * more, and this is asked each time the panel opens or something in it changes.
 */
export function mcpAdapter(packages: unknown = readPiSettings().packages): { source: string; enabled: boolean } | undefined {
  for (const entry of Array.isArray(packages) ? packages : []) {
    const source = sourceOf(entry);
    if (source && /(^|[:/])pi-mcp-adapter(@[^/]*)?$/.test(source)) return { source, enabled: !isSwitchedOff(entry) };
  }
  return undefined;
}

/** What `mcpServer` answers from: the servers and the adapter as the files were when last read. */
let lastRead: { stamp: string; servers?: McpFile["mcpServers"]; adapter: boolean } | undefined;

/** When mcp.json and pi's settings last changed: read again only when they did. */
function filesStamp(): string {
  return [mcpConfigPath(), piSettingsPath()]
    .map((f) => {
      try {
        const st = statSync(f);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return "-";
      }
    })
    .join("|");
}

/**
 * The server of that name, and whether the chats have its tools now (`on`):
 * there, not switched off, and pi-mcp-adapter, which its tools come through,
 * installed and on. Asked each time a chat starts, and read from the files
 * whenever they changed, so mcp.json is the one place it is said: switching
 * the server or the adapter off in Settings is heard too. Nothing where there
 * is no such server, or the file cannot be read.
 */
export function mcpServer(name: string): { entry: Record<string, unknown>; on: boolean } | undefined {
  const stamp = filesStamp();
  if (lastRead?.stamp !== stamp) {
    let servers: McpFile["mcpServers"] | undefined;
    let adapter = false;
    try {
      const { config, error } = readMcpFile();
      if (!error) servers = config.mcpServers;
      adapter = mcpAdapter()?.enabled === true;
    } catch {
      // Not readable: no server is there.
    }
    lastRead = { stamp, servers, adapter };
  }
  const { servers, adapter } = lastRead;
  const entry = servers && Object.prototype.hasOwnProperty.call(servers, name) ? servers[name] : undefined;
  if (!entry || typeof entry !== "object") return undefined;
  // A copy: what the next caller is told is the file's, not what this one made of it.
  return { entry: structuredClone(entry), on: entry.disabled !== true && adapter };
}

/** stdio, http and socket are mutually exclusive in the adapter. */
function transportOf(entry: Record<string, unknown>): "stdio" | "http" | "socket" | "unknown" {
  if (typeof entry.command === "string" && entry.command) return "stdio";
  if (typeof entry.url === "string" && entry.url) return "http";
  if (typeof entry.socket === "string" && entry.socket) return "socket";
  return "unknown";
}

export function validateEntry(entry: unknown): string | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "Server must be an object";
  const e = entry as Record<string, unknown>;
  const transports = ["command", "url", "socket"].filter(
    (k) => typeof e[k] === "string" && (e[k] as string).trim(),
  );
  if (transports.length === 0) return "Needs a command, a url or a socket path";
  if (transports.length > 1) return `Only one of command, url or socket — got ${transports.join(", ")}`;
  if (e.args !== undefined && !Array.isArray(e.args)) return "args must be a list";
  return null;
}

export function mcpRouter(): Router {
  const router = express.Router();

  router.get("/mcp", async (_req, res) => {
    try {
      const { config, raw, error } = readMcpFile();
      const servers = Object.entries(config.mcpServers).map(([name, entry]) => ({
        name,
        entry,
        transport: transportOf(entry as Record<string, unknown>),
        disabled: (entry as Record<string, unknown>).disabled === true,
      }));
      res.json({
        path: mcpConfigPath(),
        exists: existsSync(mcpConfigPath()),
        adapterInstalled: mcpAdapter() !== undefined,
        adapterSpec: ADAPTER_SPEC,
        servers,
        settings: config.settings ?? {},
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
    if (!NAME_RE.test(name)) {
      return res.status(400).json({ error: "Name must be letters, digits, dot, dash or underscore" });
    }
    const problem = validateEntry(req.body?.entry);
    if (problem) return res.status(400).json({ error: problem });

    const { config, error } = readMcpFile();
    if (error) return res.status(409).json({ error: `Fix the file first: ${error}` });
    // An entry of that name already there is somebody's setup — environment, headers, an oauth block the form does not show — and a new or renamed server would replace it unseen.
    if (name !== from && Object.prototype.hasOwnProperty.call(config.mcpServers, name)) {
      return res.status(409).json({ error: `A server called ${name} already exists`, code: "exists" });
    }
    // A rename removes the old name, and its tools are not the new one's (see writeMcpText).
    if (from && from !== name) delete config.mcpServers[from];
    config.mcpServers[name] = req.body.entry;
    try {
      writeMcpFile(config);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /**
   * Register a server's tools one by one (`directTools`), or leave them to the adapter's `mcp` tool. The same
   * setting the form has as "Register tools directly", for the Tools page, where leaving them to `mcp` is
   * what the page calls lazy: only that setting is changed, the rest of the entry is as it was. A server
   * that is not lazy gets `true`; one that is lazy loses the key, or has it `false` where the adapter-wide
   * setting would register them. Read when a chat starts, as the rest of the file.
   */
  router.put("/mcp/servers/:name/direct", (req, res) => {
    const name = req.params.name;
    if (typeof req.body?.direct !== "boolean") return res.status(400).json({ error: "direct must be true or false" });
    const { config, error } = readMcpFile();
    if (error) return res.status(409).json({ error: `Fix the file first: ${error}` });
    const entry = Object.prototype.hasOwnProperty.call(config.mcpServers, name) ? config.mcpServers[name] : undefined;
    if (!entry || typeof entry !== "object") return res.status(404).json({ error: `No server called ${name}` });
    if (req.body.direct) entry.directTools = true;
    else if (config.settings?.directTools) entry.directTools = false;
    else delete entry.directTools;
    try {
      writeMcpFile(config);
      res.json({ ok: true, direct: req.body.direct });
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

  /** Adapter-wide settings — the `settings` object beside `mcpServers`. */
  router.put("/mcp/settings", (req, res) => {
    const settings = req.body?.settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      return res.status(400).json({ error: "settings must be an object" });
    }
    const { config, error } = readMcpFile();
    if (error) return res.status(409).json({ error: `Fix the file first: ${error}` });
    if (Object.keys(settings).length === 0) delete config.settings;
    else config.settings = settings;
    try {
      writeMcpFile(config);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /**
   * Merge a pasted config. Every MCP server's README hands out the same blob,
   * so accepting it directly beats retyping it into a form field by field.
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
    for (const [name, entry] of Object.entries(incoming)) {
      if (name === "settings" || name === "imports") continue;
      if (!NAME_RE.test(name)) {
        skipped.push({ name, reason: "Unusable name" });
        continue;
      }
      const problem = validateEntry(entry);
      if (problem) {
        skipped.push({ name, reason: problem });
        continue;
      }
      // As the form's save refuses it: what is there is somebody's setup, and a pasted README snippet would replace it unseen.
      if (Object.prototype.hasOwnProperty.call(config.mcpServers, name)) {
        skipped.push({ name, reason: `A server called ${name} already exists` });
        continue;
      }
      config.mcpServers[name] = entry as Record<string, unknown>;
      added.push(name);
    }
    if (!added.length && !skipped.length) {
      return res.status(400).json({ error: "No servers found in that JSON" });
    }
    try {
      if (added.length) {
        writeMcpFile(config);
      }
      res.json({ ok: true, added, skipped });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** The escape hatch: the file itself, for anything the forms do not cover. */
  router.put("/mcp/raw", (req, res) => {
    const content = req.body?.content;
    if (typeof content !== "string") return res.status(400).json({ error: "content required" });
    try {
      JSON.parse(stripComments(content));
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
