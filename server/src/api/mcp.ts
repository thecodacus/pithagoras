import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import express, { type Router } from "express";
import { piAgentDir } from "../pi-settings.js";

const run = promisify(execFile);

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
const NAME_RE = /^[A-Za-z0-9][\w.-]*$/;

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

function writeMcpFile(config: McpFile): void {
  const file = mcpConfigPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/** Is the adapter installed? Without it, none of this configuration does anything. */
async function adapterInstalled(): Promise<boolean> {
  try {
    const { stdout } = await run("pi", ["list"], { timeout: 60_000 });
    return stdout.includes(ADAPTER);
  } catch {
    return false;
  }
}

/** stdio, http and socket are mutually exclusive in the adapter. */
function transportOf(entry: Record<string, unknown>): "stdio" | "http" | "socket" | "unknown" {
  if (typeof entry.command === "string" && entry.command) return "stdio";
  if (typeof entry.url === "string" && entry.url) return "http";
  if (typeof entry.socket === "string" && entry.socket) return "socket";
  return "unknown";
}

function validateEntry(entry: unknown): string | null {
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
        adapterInstalled: await adapterInstalled(),
        adapterSpec: `npm:${ADAPTER}`,
        servers,
        settings: config.settings ?? {},
        raw,
        parseError: error ?? null,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** Create or replace one server. `from` renames an existing entry. */
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
    if (from && from !== name) delete config.mcpServers[from];
    config.mcpServers[name] = req.body.entry;
    try {
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
      config.mcpServers[name] = entry as Record<string, unknown>;
      added.push(name);
    }
    if (!added.length && !skipped.length) {
      return res.status(400).json({ error: "No servers found in that JSON" });
    }
    try {
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
      JSON.parse(stripComments(content));
    } catch (e) {
      return res.status(400).json({ error: `Not valid JSON: ${(e as Error).message}` });
    }
    try {
      const file = mcpConfigPath();
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content.endsWith("\n") ? content : content + "\n", "utf8");
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}
