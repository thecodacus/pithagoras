import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import express, { type Router } from "express";
import { lazyLimits, lazyRefused, mcpMigration, mcpServerStates, resolvedLazy, setMcpApprove, setToolMarks, toolMarks } from "../db.js";
import { fromAdapterEntry } from "../mcp-config.js";
import { sayMarkInFile } from "../mcp-entry.js";
import { isWithinText, realPath } from "../within.js";
import { importServers, mcpServerNames, parseMcpText } from "./mcp.js";

/**
 * What Settings → MCP shows and sets of a server beyond what pi's file says: its mark, the tools that ask first, and the
 * import of a folder's own configuration. The file's own routes are in `mcp.ts`; these are the ones that need the portal's
 * database, which `mcp.ts` is read by and so cannot import.
 */

/** A file of servers is read whole; one that is longer than this is not a configuration. */
const MAX_FILE_BYTES = 1_000_000;
const MAX_APPROVE = 100;
const MAX_PATTERN = 200;

export type StoredMarks = { error: string; code?: string } | { marks: Record<string, "lazy" | "direct"> };

/**
 * Make exactly these the marks (`PUT /api/tools/marks` and the mark of a server). Only what is new is checked, so that a
 * mark kept from before does not stand in the way of an unrelated change. A mark on an MCP server is said in `mcp.json`
 * as well, for pi's own command line and a container's pi, where the portal's threshold and `tool_search` are not.
 */
export function storeMarks(given: Record<string, "lazy" | "direct">): StoredMarks {
  const before = toolMarks();
  const added = Object.fromEntries(Object.entries(given).filter(([entry, mark]) => before[entry] !== mark));
  const refused = lazyRefused(added);
  if (refused.length) return { error: `Cannot be lazy: ${refused.join(", ")}. pi's built-in tools are always offered.`, code: "lazy-refused" };
  const stored = setToolMarks(given);
  const servers = new Set(mcpServerNames());
  for (const [entry, one] of Object.entries(stored)) {
    if (!servers.has(entry) || before[entry] === one) continue;
    try {
      sayMarkInFile(entry, one);
    } catch (e) {
      console.error(`[portal] could not say the mark of ${entry} in mcp.json: ${(e as Error).message}`);
    }
  }
  return { marks: stored };
}

/** The files of a folder that hold servers in a shape that can be read here, and the key the servers are under. */
const FOLDER_FILES: Record<string, string> = {
  [path.join(".pi", "mcp.json")]: "mcpServers",
  ".mcp.json": "mcpServers",
  [path.join(".vscode", "mcp.json")]: "servers",
};

export function mcpPortalRouter(): Router {
  const router = express.Router();

  /** Per server: the mark and what it comes to now, what is remembered of its tools, what asks first, whether it is trusted. */
  router.get("/mcp/status", (_req, res) => {
    res.json({ servers: mcpServerStates(), limits: lazyLimits() });
  });

  /** The person's mark on a server: lazy, direct, or auto (the threshold decides). The same marks as Settings → Tools. */
  router.put("/mcp/servers/:name/mark", (req, res) => {
    const name = req.params.name;
    const mark = req.body?.mark;
    if (mark !== "lazy" && mark !== "direct" && mark !== "auto") return res.status(400).json({ error: 'mark must be "lazy", "direct" or "auto"' });
    if (!mcpServerNames().includes(name)) return res.status(404).json({ error: `No server called ${name}` });
    const wanted = { ...toolMarks() };
    if (mark === "auto") delete wanted[name];
    else wanted[name] = mark;
    const done = storeMarks(wanted);
    if ("error" in done) return res.status(400).json(done);
    res.json({ marks: done.marks, resolved: resolvedLazy() });
  });

  /** The tools of a server that ask before each call: patterns of the server's own tool names, `*` for any characters. */
  router.put("/mcp/servers/:name/approve", (req, res) => {
    const name = req.params.name;
    const given = req.body?.approve;
    if (!Array.isArray(given) || !given.every((one) => typeof one === "string")) return res.status(400).json({ error: "approve must be a list of tool names" });
    const patterns = [...new Set((given as string[]).map((one) => one.trim()).filter(Boolean))];
    if (patterns.length > MAX_APPROVE || patterns.some((one) => one.length > MAX_PATTERN || /[\r\n]/.test(one))) {
      return res.status(400).json({ error: `At most ${MAX_APPROVE} patterns of ${MAX_PATTERN} characters, one per line` });
    }
    if (!mcpServerNames().includes(name)) return res.status(404).json({ error: `No server called ${name}` });
    setMcpApprove(name, patterns);
    res.json({ approve: patterns });
  });

  /**
   * Take the servers of a folder's own configuration into the user's: what the move to pi's own MCP support listed in its
   * report as read by the old adapter and not by pi (`.mcp.json`, `.vscode/mcp.json`) or read only in a trusted project
   * (`.pi/mcp.json`). Only a folder and a file the report names, so the page cannot be made to read another. What is
   * imported is **switched off**: a repository's file is somebody else's text, and the command in it runs as the portal's user.
   */
  router.post("/mcp/import-folder", (req, res) => {
    const folder = req.body?.folder;
    const file = typeof req.body?.file === "string" ? path.normalize(req.body.file) : "";
    const project = typeof folder === "string" ? mcpMigration().report?.projects.find((one) => one.folder === folder) : undefined;
    if (!project) return res.status(404).json({ error: "That folder is not in the report" });
    const listed = [...(project.mcpJson ? [path.join(".pi", "mcp.json")] : []), ...project.foreign.map((one) => path.normalize(one))];
    const key = FOLDER_FILES[file];
    if (!key || !listed.includes(file)) return res.status(400).json({ error: "That file is not one the report lists, or cannot be imported" });
    const where = path.join(project.folder, file);
    // A link in a repository that leads out of it is a file of somebody else's.
    const real = realPath(where);
    const home = realPath(project.folder);
    if (!real || !home || !isWithinText(home, real)) return res.status(400).json({ error: "That file is not in the folder, or leads out of it" });
    let text: string;
    try {
      if (!statSync(where).isFile() || statSync(where).size > MAX_FILE_BYTES) return res.status(400).json({ error: "That is not a configuration file" });
      text = readFileSync(where, "utf8");
    } catch (e) {
      return res.status(404).json({ error: `Cannot read ${file}: ${(e as Error).message}` });
    }
    let parsed: unknown;
    try {
      parsed = parseMcpText(text);
    } catch (e) {
      return res.status(400).json({ error: `${file} is not valid JSON: ${(e as Error).message}` });
    }
    const servers = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)[key] : undefined;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return res.status(400).json({ error: `${file} has no "${key}"` });
    const approve = new Map<string, string[]>();
    try {
      const done = importServers(servers as Record<string, unknown>, {
        off: true,
        prepare: (name, entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("Server must be an object");
          // The adapter's own keys (a project's `.pi/mcp.json` written for it) are carried over as portal.mcp.set does, or refused.
          const translated = fromAdapterEntry(entry as Record<string, unknown>, name);
          // pi refuses `auth` in a project's file, so that a repository cannot pick where the sign-in goes: not by way of the user's either.
          if (translated.entry.auth !== undefined) throw new TypeError("It signs in with a provider's credentials (auth), which a folder's file cannot bring; add the server yourself if it is yours");
          if (translated.approve.length) approve.set(name, translated.approve);
          return translated.entry;
        },
      });
      for (const name of done.added) if (approve.has(name)) setMcpApprove(name, approve.get(name));
      res.json({ ok: true, ...done });
    } catch (e) {
      res.status((e as { status?: number }).status ?? 500).json({ error: (e as Error).message });
    }
  });

  return router;
}
