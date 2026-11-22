import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import express, { type Router } from "express";
import { writeFileAtomic } from "../atomic-write.js";
import { piMcp } from "../pi/mcp-config.js";
import { mcpNamespace } from "../pi/mcp-origin.js";
import { piAgentDir } from "../pi-settings.js";
import { BROWSER_MCP } from "../tool-policy.js";

/**
 * MCP servers, as pi reads them: `mcp.json` in pi's agent folder, in the `mcpServers` shape the other MCP clients share.
 *
 * pi connects the servers and registers their tools itself; this is only the file, and the page that edits it. The
 * portal edits the user-level file, because every session here shares an agent home and a project's own `.pi/mcp.json`
 * would reach one workspace only. Entries are stored as given rather than put through a whitelist, so a key a newer pi
 * understands survives a round trip through this API; whether an entry is one pi accepts is pi's own check
 * (`validateMcpServerConfig`, see pi/mcp-config.ts).
 */
export const mcpConfigPath = (): string => path.join(piAgentDir(), "mcp.json");

/** pi's rule for a server's name: letters, digits, `_` and `-`. */
export const NAME_RE = /^[A-Za-z0-9_-]+$/;

export interface McpFile {
  mcpServers: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/** The file as it is, parsed as pi parses it (plain JSON: pi skips every server of a file with a comment in it), or its raw text and what is wrong with it. */
export function readMcpFile(): { config: McpFile; raw: string; error?: string } {
  const file = mcpConfigPath();
  if (!existsSync(file)) return { config: { mcpServers: {} }, raw: "" };
  const raw = readFileSync(file, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { config: { mcpServers: {} }, raw, error: 'expected an object with an "mcpServers" object' };
    if (parsed.mcpServers !== undefined && (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers))) {
      return { config: { mcpServers: {} }, raw, error: 'expected an object with an "mcpServers" object' };
    }
    return { config: { ...parsed, mcpServers: parsed.mcpServers ?? {} } as McpFile, raw };
  } catch (e) {
    // Handed back unparsed rather than as no servers: the raw editor is how a broken file gets fixed, and writing over it
    // would destroy the servers somebody already configured.
    return { config: { mcpServers: {} }, raw, error: (e as Error).message };
  }
}

/** The names of the servers configured; none where the file cannot be read, as for pi. */
export function mcpServerNames(): string[] {
  try {
    return Object.keys(readMcpFile().config.mcpServers);
  } catch {
    return [];
  }
}

/** Whether pi connects an entry: not `enabled: false`, and not hidden. */
const isOn = (entry: unknown): boolean => {
  const e = entry && typeof entry === "object" ? (entry as { enabled?: unknown; exposure?: unknown }) : undefined;
  return !!e && e.enabled !== false && e.exposure !== "hidden";
};

/** The servers of the file that connect: not switched off (`enabled: false`) and not hidden. Undefined where the file cannot be read. */
export function connectingServers(): Set<string> | undefined {
  try {
    const { config, error } = readMcpFile();
    if (error) return undefined;
    return new Set(Object.entries(config.mcpServers).filter(([, entry]) => isOn(entry)).map(([name]) => name));
  } catch {
    return undefined;
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

/** Who wrote the file: the page in Settings (its chats are reloaded to read it) or an extension, which says when it reloads them itself. */
export type McpWriter = "settings" | "extension";

/**
 * The file holds the keys and tokens of the MCP servers, so it is for its
 * owner alone, and put in place whole: one cut off by a full disk would take
 * every MCP server with it.
 */
export function writeMcpText(text: string, by: McpWriter = "settings"): void {
  const file = mcpConfigPath();
  const before = Object.keys(readMcpFile().config.mcpServers);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, text.endsWith("\n") ? text : text + "\n", 0o600);
  mcpWritten(before, by);
}

export function writeMcpFile(config: McpFile, by: McpWriter = "settings"): void {
  writeMcpText(JSON.stringify(config, null, 2), by);
}

const writtenListeners = new Set<(before: string[], by: McpWriter) => void>();

/** Tell the listeners (onMcpWritten) that the file was written, with the servers it had before. */
function mcpWritten(before: string[], by: McpWriter): void {
  for (const listener of [...writtenListeners]) {
    try {
      listener(before, by);
    } catch (e) {
      console.error(`[portal] could not take in the MCP configuration that was written: ${(e as Error).message}`);
    }
  }
}

/**
 * Told after every write of the file, with the servers it had before and who wrote it: a server that is gone takes its
 * tools out of what the portal remembers (db.ts), and the chats that are running read the file again (server.ts).
 * Returns the way to stop listening.
 */
export function onMcpWritten(listener: (before: string[], by: McpWriter) => void): () => void {
  writtenListeners.add(listener);
  return () => writtenListeners.delete(listener);
}

/** The server of that name, as the file has it, and whether pi connects it (`on`: not switched off, not hidden). Nothing where there is none or the file cannot be read. */
export function mcpServer(name: string): { entry: Record<string, unknown>; on: boolean } | undefined {
  try {
    const { config, error } = readMcpFile();
    if (error) return undefined;
    const entry = Object.prototype.hasOwnProperty.call(config.mcpServers, name) ? config.mcpServers[name] : undefined;
    if (!entry || typeof entry !== "object") return undefined;
    // A copy: what the caller is told is the file's, not what it makes of it.
    return { entry: structuredClone(entry), on: isOn(entry) };
  } catch {
    return undefined;
  }
}

/** What an entry connects with, as pi's file gives it: a command, or a URL. */
function transportOf(entry: Record<string, unknown>): "stdio" | "http" | "unknown" {
  if (typeof entry.command === "string" && entry.command) return "stdio";
  if (typeof entry.url === "string" && entry.url) return "http";
  return "unknown";
}

/**
 * What is wrong with an entry, as pi says it, or null: pi's own check. A server pi does not accept is skipped by it, and the
 * others connect all the same, so a refusal here is the page telling it before pi does.
 */
export async function problemWith(name: string, entry: unknown): Promise<string | null> {
  if (!NAME_RE.test(name)) return "A server's name is letters, digits, underscore or dash";
  const checked = (await piMcp()).validateMcpServerConfig(name, entry);
  return typeof checked === "string" ? checked : null;
}

/**
 * What is wrong with an entry that is about to be written by a form, an import or a feature: pi's check, and one thing more.
 * `auth: { provider }` makes pi send the portal's key for that model provider to the server's URL as its bearer token; a pasted
 * README snippet or a feature must not do that unseen, so it is only in the file by hand (the raw editor).
 */
export async function problemForWrite(name: string, entry: unknown): Promise<string | null> {
  const auth = entry && typeof entry === "object" ? (entry as { auth?: unknown }).auth : undefined;
  if (auth && typeof auth === "object" && (auth as { provider?: unknown }).provider !== undefined) {
    return "auth.provider would send the portal's key for a model provider to this server: write it in the file by hand (the raw editor) if that is meant";
  }
  return problemWith(name, entry);
}

/** The server another name would be, for pi: names that differ only in `-` and `_` share a namespace, and pi connects one of them. */
function sameNamespace(config: McpFile, name: string, except?: string): string | undefined {
  return Object.keys(config.mcpServers).find((other) => other !== name && other !== except && mcpNamespace(other) === mcpNamespace(name));
}

export function mcpRouter(): Router {
  const router = express.Router();

  router.get("/mcp", async (_req, res) => {
    try {
      const { config, raw, error } = readMcpFile();
      const servers = await Promise.all(
        Object.entries(config.mcpServers).map(async ([name, entry]) => ({
          name,
          entry,
          transport: transportOf(entry as Record<string, unknown>),
          enabled: (entry as Record<string, unknown>).enabled !== false,
          problem: await problemWith(name, entry),
        })),
      );
      res.json({
        path: mcpConfigPath(),
        exists: existsSync(mcpConfigPath()),
        servers,
        raw,
        parseError: error ?? null,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** Create or change one server. `from` renames an existing entry; a name that is taken by another is refused. */
  router.put("/mcp/servers/:name", async (req, res) => {
    const name = req.params.name;
    const from = typeof req.body?.from === "string" ? req.body.from : null;
    try {
      const problem = await problemForWrite(name, req.body?.entry);
      if (problem) return res.status(400).json({ error: problem });

      const { config, error } = readMcpFile();
      if (error) return res.status(409).json({ error: `Fix the file first: ${error}` });
      // An entry of that name already there is somebody's setup — environment, headers, an OAuth block the form does not show — and a new or renamed server would replace it unseen.
      if (name !== from && Object.prototype.hasOwnProperty.call(config.mcpServers, name)) {
        return res.status(409).json({ error: `A server called ${name} already exists`, code: "exists" });
      }
      const clash = sameNamespace(config, name, from ?? undefined);
      if (clash) return res.status(409).json({ error: `${clash} already has the tools' prefix ${mcpNamespace(name)}: pi connects only one of two names that differ by a dash and an underscore`, code: "exists" });
      // A rename removes the old name, and its tools are not the new one's.
      if (from && from !== name) delete config.mcpServers[from];
      config.mcpServers[name] = req.body.entry;
      writeMcpFile(config);
      res.json({ ok: true });
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
   * Merge a pasted config. Every MCP server's README hands out the same blob,
   * so accepting it directly beats retyping it into a form field by field.
   */
  router.post("/mcp/import", async (req, res) => {
    const text = req.body?.text;
    if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "Nothing to import" });

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return res.status(400).json({ error: `Not valid JSON: ${(e as Error).message}` });
    }
    if (!parsed || typeof parsed !== "object") return res.status(400).json({ error: "Expected a JSON object" });

    // Either the whole file, or just the servers map, or a single entry.
    const obj = parsed as Record<string, unknown>;
    const incoming = (obj.mcpServers && typeof obj.mcpServers === "object" ? obj.mcpServers : obj) as Record<string, unknown>;

    const { config, error } = readMcpFile();
    if (error) return res.status(409).json({ error: `Fix the file first: ${error}` });

    try {
      const added: string[] = [];
      const skipped: { name: string; reason: string }[] = [];
      for (const [name, entry] of Object.entries(incoming)) {
        if (name === "autoEnableCodemode") continue;
        const problem = await problemForWrite(name, entry);
        if (problem) {
          skipped.push({ name, reason: problem });
          continue;
        }
        // As the form's save refuses it: what is there is somebody's setup, and a pasted README snippet would replace it unseen.
        if (Object.prototype.hasOwnProperty.call(config.mcpServers, name)) {
          skipped.push({ name, reason: `A server called ${name} already exists` });
          continue;
        }
        const clash = sameNamespace(config, name);
        if (clash) {
          skipped.push({ name, reason: `${clash} already has the tools' prefix ${mcpNamespace(name)}` });
          continue;
        }
        config.mcpServers[name] = entry as Record<string, unknown>;
        added.push(name);
      }
      if (!added.length && !skipped.length) {
        return res.status(400).json({ error: "No servers found in that JSON" });
      }
      if (added.length) writeMcpFile(config);
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
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return res.status(400).json({ error: 'Expected an object with an "mcpServers" object' });
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
