import express, { type Router } from "express";
import {
  agentTools,
  browserAllowlist,
  browserByDefault,
  browserConfigured,
  browserCursorOn,
  browserExceptions,
  getDb,
  getSession,
  knownTools,
  portalBrowserOn,
  portalBrowserState,
  projectTools,
  routineTools,
  sessionTools,
  setBrowserAllowlist,
  setBrowserCursor,
  setPortalBrowser,
  setAgentTools,
  setProjectTools,
  setRoutineTools,
  setSessionTools,
  setToolDefaultsOff,
  toolDefaultsOff,
} from "../db.js";
import { EXECUTOR_KIND } from "../executor-kind.js";
import { PORTAL_BROWSER_TOOLS, browserTool } from "../tool-policy.js";
import { BROWSER_CDP, browserServers, findConnection, mcpServerNames, readMcpFile, writeMcpFile } from "./mcp.js";
import * as service from "../extensions/browser-service.js";

/**
 * The agent's browser: whether it is up, who may drive it, and where to.
 *
 * The browser itself runs in its own container with its own profile — a human
 * logs into it once and every later run finds itself already signed in. The
 * portal owns none of that; it owns the question of which sessions may reach it.
 */

const CDP = BROWSER_CDP;

/**
 * Pointer tools by screen position, which `--caps vision` adds.
 *
 * A screenshot costs a local model far less to read than the page's text, and
 * it carries no element references. These let the agent act on what it sees
 * there when a search turns up no reference for it.
 */
const VISION_TOOLS = [
  "browser_mouse_click_xy",
  "browser_mouse_move_xy",
  "browser_mouse_drag_xy",
  "browser_mouse_wheel",
];

/**
 * Pinned, not `@latest`.
 *
 * The tool signatures changed underneath a working setup: click and type took
 * `{element, ref}` and now take `{target}`. The agent went on calling the old
 * shape, every interaction failed, and nothing here had changed. A browser the
 * agent depends on is not the place for a silent upgrade.
 */
const MCP_VERSION = "0.0.79";

/**
 * Pin existing connections, enable on-demand snapshots and add vision.
 *
 * The pin only reaches a config the portal writes, and nobody rewrites theirs
 * — an install from before this would go on tracking whatever npm publishes
 * next. Migrate only our package and debugging endpoint. Suppressing automatic
 * snapshots avoids repeating a whole page after every click or keystroke;
 * explicit snapshot and find calls still return their requested content.
 * Vision gives a connection made before it the pointer tools the reading rule
 * falls back to.
 */
export function pinConnection(): void {
  const { config, error } = readMcpFile();
  if (error) return;
  let changed = false;
  for (const entry of Object.values(config.mcpServers)) {
    const args = (entry as { args?: unknown }).args;
    if (!Array.isArray(args) || !args.includes("--cdp-endpoint") || !args.includes(CDP)) continue;
    const at = args.findIndex((a) => typeof a === "string" && a.startsWith("@playwright/mcp@"));
    if (at === -1) continue;
    if (args[at] !== `@playwright/mcp@${MCP_VERSION}`) {
      args[at] = `@playwright/mcp@${MCP_VERSION}`;
      changed = true;
    }
    const mode = args.indexOf("--snapshot-mode");
    if (mode === -1) {
      args.push("--snapshot-mode", "none");
      changed = true;
    } else if (args[mode + 1] !== "none") {
      args[mode + 1] = "none";
      changed = true;
    }
    // Vision joins whatever capabilities the entry already asks for, and its
    // pointer tools join the prompt-listed ones where the portal wrote that list.
    const caps = args.indexOf("--caps");
    const had = caps === -1 ? [] : String(args[caps + 1] ?? "").split(",").filter(Boolean);
    if (!had.includes("vision")) {
      if (caps === -1) args.push("--caps", "vision");
      else args[caps + 1] = [...had, "vision"].join(",");
      const direct = (entry as { directTools?: unknown }).directTools;
      if (Array.isArray(direct)) direct.push(...VISION_TOOLS.filter((t) => !direct.includes(t)));
      changed = true;
    }
  }
  if (changed) {
    writeMcpFile(config);
    console.log(`[portal] configured browser MCP @playwright/mcp@${MCP_VERSION} with on-demand snapshots and vision`);
  }
}

/** The MCP entry this portal wrote for the browser, if there still is one: @playwright/mcp at our debugging port. */
function managedEntry(servers: Record<string, unknown>): string | undefined {
  return Object.entries(servers).find(([, entry]) => {
    const args = (entry as { args?: unknown }).args;
    return Array.isArray(args) && args.includes(CDP) && args.some((a) => typeof a === "string" && a.startsWith("@playwright/mcp@"));
  })?.[0];
}

/**
 * Moves an install from the Playwright MCP to the portal's own browser tools,
 * once: the first start after the update, while nobody has said either way.
 *
 * Who may drive the browser is kept as switches on its tools — the default,
 * each project's, each chat's — and those name the MCP's tools. Each is
 * carried to the portal's tools as it stood, so a chat that had the browser
 * still has it and one that did not still does not. Then the MCP entry goes, or
 * the agent would hold two sets of browser tools.
 *
 * Someone who adds a Playwright MCP back by hand keeps it: this never runs again.
 */
export function adoptPortalBrowser(): void {
  if (portalBrowserState() !== "unset") return;
  const { config, error } = readMcpFile();
  if (error) return;
  const name = managedEntry(config.mcpServers);
  if (!name) return;
  const servers = mcpServerNames();
  const browsers = browserServers();
  const old = new Set(
    knownTools()
      .map((t) => t.name)
      .filter((n) => browserTool(n, servers, browsers) && !(PORTAL_BROWSER_TOOLS as readonly string[]).includes(n)),
  );
  const carry = (names: string[]) => (names.some((n) => old.has(n)) ? [...names, ...PORTAL_BROWSER_TOOLS] : names);
  if (old.size) {
    getDb().transaction(() => {
      setToolDefaultsOff(carry(toolDefaultsOff()));
      const chats = getDb()
        .prepare("SELECT id FROM sessions WHERE COALESCE(tools_off, '') != '' OR COALESCE(tools_on, '') != ''")
        .all() as { id: string }[];
      for (const { id } of chats) {
        const tools = sessionTools(id);
        setSessionTools(id, { off: carry(tools.off), on: carry(tools.on) });
      }
      for (const { project } of getDb().prepare("SELECT project FROM project_tools").all() as { project: string }[]) {
        const tools = projectTools(project);
        setProjectTools(project, { off: carry(tools.off), on: carry(tools.on) });
      }
      for (const { agent } of getDb().prepare("SELECT agent FROM agent_tools").all() as { agent: string }[]) {
        const tools = agentTools(agent);
        setAgentTools(agent, { off: carry(tools.off), on: carry(tools.on) });
      }
      for (const { slug } of getDb().prepare("SELECT slug FROM routines").all() as { slug: string }[]) {
        const tools = routineTools(slug);
        if (tools.off.length || tools.on.length) setRoutineTools(slug, { off: carry(tools.off), on: carry(tools.on) });
      }
    })();
  }
  delete config.mcpServers[name];
  // The old server's tools, and the adapter's cache of them, go with it (see writeMcpText): the portal's own are listed by their own names.
  writeMcpFile(config);
  setPortalBrowser(true);
  console.log(`[portal] the browser now uses the portal's own tools; the "${name}" Playwright MCP entry was replaced, with its settings carried over`);
}

/**
 * The HTTPS port, not the HTTP one.
 *
 * KasmVNC refuses to run outside a secure context — it needs clipboard and
 * pointer-lock, which browsers only expose over HTTPS or on localhost. Over
 * plain HTTP from a LAN address it renders one error and nothing else.
 */
const uiPort = () => service.config().httpsPort;

export function browserRouter(): Router {
  const router = express.Router();

  router.get("/browser", async (_req, res) => {
    let version: string | null = null;
    let pages: { title: string; url: string }[] = [];
    try {
      const v = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(4000) });
      version = ((await v.json()) as { Browser?: string }).Browser ?? null;
      const l = await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(4000) });
      pages = ((await l.json()) as { type: string; title: string; url: string }[])
        .filter((t) => t.type === "page")
        .map((t) => ({ title: t.title, url: t.url }));
    } catch {
      // Not running is a normal state rather than an error: the sidecar is
      // optional, and the portal works without it.
    }

    // The conversations that disagree with the default, not every one that
    // may drive it: the browser is on unless switched off, so "all of them"
    // is the answer almost always and it tells nobody anything.
    const sessions = browserExceptions();
    const byDefault = browserByDefault();
    const routines = getDb()
      .prepare("SELECT slug, name FROM routines WHERE browser = 1")
      .all() as { slug: string; name: string }[];

    res.json({
      running: Boolean(version),
      // An unauthenticated browser holding live logins is the worst outcome
      // here, and nothing else would tell you: the UI simply opens.
      unprotected: Boolean(version) && !service.config().password,
      version,
      pages,
      uiPort: uiPort(),
      allowlist: browserAllowlist().join("\n"),
      // Whether the tools glide a cursor to what they act on, for whoever watches.
      cursor: browserCursorOn(),
      // Two separate things that each look fine alone: a browser nobody can
      // drive, and tools pointed at a browser that is gone.
      connectedAs: portalBrowserOn() ? "built-in" : findConnection(),
      // The container itself, which the portal installs rather than compose.
      install: await service.status(),
      config: { user: service.config().user, hasPassword: Boolean(service.config().password) },
      // Whether a conversation that has never said anything about it has it,
      // and the ones that said otherwise.
      byDefault,
      configured: browserConfigured(),
      sessions: sessions.map((s) => ({
        id: s.id,
        title: s.title,
        kind: s.kind,
        // They are the ones that differ from the default, so this is the other answer: not worked out again for each.
        allowed: !byDefault,
      })),
      routines,
    });
  });

  /**
   * Wire the agent to the browser, or unwire it.
   *
   * Separate from starting the container on purpose — they are separate
   * machines to the portal — but not separate enough to leave to memory, which
   * is how the agent ended up holding tools for a browser that had been
   * removed.
   */
  router.post("/browser/connect", (_req, res) => {
    // The portal's own tools; a Playwright MCP somebody attached by hand stays theirs.
    setPortalBrowser(true);
    res.json({ connectedAs: "built-in" });
  });

  router.delete("/browser/connect", (_req, res) => {
    setPortalBrowser(false);
    res.json({ connectedAs: findConnection() });
  });

  /**
   * Installing, and the lifecycle after it.
   *
   * The agent is wired to the browser once it is there, here and not by whichever
   * page asked: the Browser page and Settings → Add-ons each decided that for
   * themselves, and a browser installed from the one was left unreachable for the agent.
   */
  router.post("/browser/install", async (_req, res) => {
    // Answered before it starts, so that a second click does not even queue behind the first.
    if (service.installInFlight()) return res.status(409).json({ error: service.ALREADY_INSTALLING });
    try {
      await service.install();
      setPortalBrowser(true);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  const lifecycle = (fn: () => Promise<void>) => async (_req: express.Request, res: express.Response) => {
    try {
      await fn();
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  };
  router.post("/browser/start", lifecycle(() => service.start()));
  router.post("/browser/stop", lifecycle(() => service.stop()));

  /** Removes the container. `?profile=forget` also drops the logins. */
  router.delete("/browser/install", async (req, res) => {
    try {
      if (req.query.profile === "forget") await service.forgetProfile();
      else await service.remove();
      // Unwired once it is gone: tools for a browser that does not exist are the worse of the two.
      setPortalBrowser(false);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.put("/browser/config", (req, res) => {
    const { user, password, port, httpsPort } = req.body ?? {};
    const saved = service.saveConfig({ user, password, port, httpsPort });
    res.json({ user: saved.user, hasPassword: Boolean(saved.password) });
  });

  router.get("/browser/suggest-password", (_req, res) => {
    res.json({ password: service.suggestPassword() });
  });

  /** Whether the browser tools show their cursor. It applies from the next action. */
  router.put("/browser/cursor", (req, res) => {
    const on = req.body?.on;
    if (typeof on !== "boolean") return res.status(400).json({ error: "on must be a boolean" });
    setBrowserCursor(on);
    res.json({ cursor: browserCursorOn() });
  });

  /** Domains the browser may be pointed at. Empty means no restriction. */
  router.put("/browser/allowlist", (req, res) => {
    const domains = req.body?.domains;
    if (typeof domains !== "string") return res.status(400).json({ error: "domains required" });
    setBrowserAllowlist(domains);
    res.json({ allowlist: browserAllowlist().join("\n") });
  });

  /**
   * Grant the browser to one conversation, where the tool switches cannot.
   *
   * With EXECUTOR=container pi is reached over RPC and never reports what it
   * registered, so the portal has no tool list to switch and browserAllowed()
   * falls back to this column. On a host deployment the tools list is the
   * answer and this would be a second one, so it is refused there rather than
   * quietly writing a column nothing reads.
   */
  router.put("/sessions/:id/browser", (req, res) => {
    if (EXECUTOR_KIND !== "container") {
      return res.status(400).json({
        error:
          "The browser is switched with its tools — open the tools list beside the composer, or Settings → Tools for every conversation",
      });
    }
    const on = Boolean(req.body?.enabled);
    if (!getSession(req.params.id)) return res.status(404).json({ error: "Not found" });
    getDb().prepare("UPDATE sessions SET browser = ? WHERE id = ?").run(on ? 1 : 0, req.params.id);
    res.json({ enabled: on });
  });

  return router;
}
