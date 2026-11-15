import { createHash } from "node:crypto";
import path from "node:path";
import express, { type Router } from "express";
import { lazyLimits, lazyRefused, mcpMigration, mcpServerStates, resolvedLazy, setMcpApprove, setToolMarks, toolMarks } from "../db.js";
import { approvePatterns, fromAdapterEntry } from "../mcp-config.js";
import { sayMarkInFile } from "../mcp-entry.js";
import { MAX_CONFIG_BYTES, readRegularText } from "../safe-read.js";
import { isWithinText, realPath } from "../within.js";
import { importServers, mcpServerNames, parseMcpText } from "./mcp.js";

/**
 * What Settings → MCP shows and sets of a server beyond what pi's file says: its mark, the tools that ask first, and the
 * import of a folder's own configuration. The file's own routes are in `mcp.ts`; these are the ones that need the portal's
 * database, which `mcp.ts` is read by and so cannot import.
 */

/**
 * The variables of a server's `env` that decide which program its command runs and what that program loads: the path the
 * command is found by, a start-up option, a library to load first. A repository's file that sets one brings code the person
 * has not seen in the command line the import names.
 */
const RUN_DECIDING_ENV = /^(?:PATH|HOME|SHELL|ENV|BASH_ENV|IFS|CDPATH|CLASSPATH|GOFLAGS|GOPATH|GOROOT|GOPROXY|GOTOOLCHAIN|(?:LD|DYLD|NODE|NPM|PYTHON|PERL|RUBY|JAVA|JDK|GEM|BUNDLE|GIT|XDG|UV|PIP|CARGO|RUSTUP|DENO|BUN)_.*|.*_(?:HOME|PATH|OPTIONS|OPTS|PRELOAD))$/i;

export type StoredMarks = { error: string; code?: string; status: number } | { marks: Record<string, "lazy" | "direct"> };

/**
 * Make exactly these the marks (`PUT /api/tools/marks` and the mark of a server). Only what is new is checked, so that a
 * mark kept from before does not stand in the way of an unrelated change. A mark on an MCP server is said in `mcp.json`
 * as well, for pi's own command line and a container's pi, where the portal's threshold and `tool_search` are not.
 */
export function storeMarks(given: Record<string, "lazy" | "direct">): StoredMarks {
  const before = toolMarks();
  const added = Object.fromEntries(Object.entries(given).filter(([entry, mark]) => before[entry] !== mark));
  const refused = lazyRefused(added);
  if (refused.length) return { error: `Cannot be lazy: ${refused.join(", ")}. pi's built-in tools are always offered.`, code: "lazy-refused", status: 400 };
  // Said in the file before the database keeps it: a mark the database has and the file does not would not be said again,
  // as a second try finds it unchanged.
  const servers = new Set(mcpServerNames());
  for (const [entry, one] of Object.entries(added)) {
    if (!servers.has(entry)) continue;
    try {
      sayMarkInFile(entry, one);
    } catch (e) {
      return { error: `The mark of ${entry} could not be said in mcp.json: ${(e as Error).message}`, code: "mcp-file", status: 500 };
    }
  }
  return { marks: setToolMarks(given) };
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
    if ("error" in done) return res.status(done.status).json({ error: done.error, code: done.code });
    res.json({ marks: done.marks, resolved: resolvedLazy() });
  });

  /** The tools of a server that ask before each call: patterns of the server's own tool names, `*` for any characters. */
  router.put("/mcp/servers/:name/approve", (req, res) => {
    const name = req.params.name;
    const checked = approvePatterns(req.body?.approve);
    if ("error" in checked) return res.status(400).json({ error: checked.error });
    const { patterns } = checked;
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
    // Judged by the open file, as the move did: a FIFO swapped in for it would hold this request for good.
    const text = readRegularText(real, MAX_CONFIG_BYTES);
    if (text === undefined) return res.status(400).json({ error: "That is not a configuration file" });
    // The file the move found, not one that was written since: a colleague's write, or an agent's after it read something untrusted, could have changed what runs.
    if (project.hashes?.[file] !== createHash("sha256").update(text).digest("hex")) {
      return res.status(409).json({ error: `${file} has changed since the move to pi's MCP support: look at it, and add its servers in the form or by pasting them` });
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
          // What the import names of a server is its command line; a `cwd` or an `env` that decides what that runs is not in it, and the switch on the page does not open the form.
          const shown = translated.entry as Record<string, unknown>;
          if (typeof shown.cwd === "string") throw new TypeError("It sets the folder its command runs in (cwd), which decides what it runs; add the server yourself if it is yours");
          const env = shown.env && typeof shown.env === "object" && !Array.isArray(shown.env) ? Object.keys(shown.env) : [];
          const deciding = env.find((key) => RUN_DECIDING_ENV.test(key));
          if (deciding !== undefined) throw new TypeError(`It sets ${deciding}, which decides what its command runs or loads; add the server yourself if it is yours`);
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
