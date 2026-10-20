import type { Request, Response, Router } from "express";
import { browserVersion, cdpUrl } from "./cdp";
import { portal } from "./host";
import { proxyUi } from "./proxy";
import * as service from "./service";
import { connected, putSettings, setting } from "./store";
import { offeredTools } from "./tools";

/**
 * The agent's browser: whether it is up, who may drive it, and the browser's own UI, at
 * /api/x/pithagoras-browser/…, behind the portal's login.
 *
 *   GET    /state                     whether it runs, its tabs, how it is installed, and who may drive it
 *   POST   /install                   pulls, makes and starts it, and connects the agent's chats to it
 *   DELETE /install[?profile=forget]  removes it (and with `forget`, its logins), and disconnects them
 *   POST   /start, /stop
 *   PUT    /config                    {user?, password?, port?, httpsPort?}, for the container Install makes next
 *   GET    /suggest-password
 *   POST   /connect, DELETE /connect  the agent's chats have its tools, or not
 *   PUT    /cursor                    {on}: whether the tools glide a cursor to what they act on
 *   *      /ui/…                      the browser's own UI (proxy.ts); its streams are upgrades under the same
 *
 * The browser itself runs in its own container with its own profile — a human
 * logs into it once and every later run finds itself already signed in. The
 * portal owns none of that; it owns the question of which sessions may reach it.
 */

/**
 * Wires the agent to the browser, or unwires it: the chats that are idle are loaded again, with the tools or without
 * them, and the others as they next are.
 */
async function connect(on: boolean): Promise<void> {
  putSettings({ connected: on });
  await portal().chats.reload();
}

export function browserRoutes(router: Router): void {
  const json = portal().http.json();

  router.get("/state", async (_req, res) => {
    const version = await browserVersion();
    let pages: { title: string; url: string }[] = [];
    if (version) {
      try {
        const l = await fetch(`${cdpUrl()}/json/list`, { signal: AbortSignal.timeout(4000) });
        pages = ((await l.json()) as { type: string; title: string; url: string }[])
          .filter((t) => t.type === "page")
          .map((t) => ({ title: t.title, url: t.url }));
      } catch {
        // Not running is a normal state rather than an error: the browser is
        // optional, and the portal works without it.
      }
    }

    // The conversations that disagree with the default, not every one that may
    // drive it: the browser is on unless switched off, so "all of them" is the
    // answer almost always and it tells nobody anything. And the routines whose
    // own switches give their runs another answer than one that sets nothing.
    const { byDefault, chats, routines } = portal().tools.exceptions(offeredTools().map(({ name }) => name));

    const ui = await service.uiState();
    const cfg = service.config();
    res.json({
      running: Boolean(version),
      // An unauthenticated browser holding live logins is the worst outcome
      // here, and nothing else would tell you: the UI simply opens.
      unprotected: Boolean(version) && !cfg.password,
      version,
      pages,
      // The HTTPS port, not the HTTP one: KasmVNC refuses to run outside a secure context — it needs clipboard and
      // pointer-lock, which browsers only expose over HTTPS or on localhost.
      uiPort: cfg.httpsPort,
      // Whether that port answers other machines (the page links to it only then), and whether the container
      // is one that made it so before this could be chosen.
      uiExposed: ui.exposed,
      uiOutdated: ui.outdated,
      // Whether the tools glide a cursor to what they act on, for whoever watches.
      cursor: setting("cursor") !== false,
      // Whether the agent's chats have its tools: a browser nobody can drive, and tools pointed at a browser that is
      // gone, each look fine alone.
      connected: connected(),
      // The container itself, which the portal installs rather than compose.
      install: await service.status(),
      config: { user: cfg.user, hasPassword: Boolean(cfg.password) },
      // Whether a conversation that has never said anything about it has it,
      // and the ones that said otherwise.
      byDefault,
      // They are the ones that differ from the default, so this is the other answer: not worked out again for each.
      chats: chats.map((chat) => ({ ...chat, allowed: !byDefault })),
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
  router.post("/connect", async (_req, res) => {
    await connect(true);
    res.json({ connected: true });
  });

  router.delete("/connect", async (_req, res) => {
    await connect(false);
    res.json({ connected: false });
  });

  /**
   * Installing, and the lifecycle after it.
   *
   * The agent is wired to the browser once it is there, here and not by whichever
   * page asked: the Browser page and its Settings page each decided that for
   * themselves, and a browser installed from the one was left unreachable for the agent.
   */
  router.post("/install", async (_req, res) => {
    // Answered before it starts, so that a second click does not even queue behind the first.
    if (service.installInFlight()) return res.status(409).json({ error: service.ALREADY_INSTALLING });
    try {
      await service.install();
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
    await connect(true);
    res.json({ ok: true });
  });

  const lifecycle = (fn: () => Promise<void>) => async (_req: Request, res: Response) => {
    try {
      await fn();
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  };
  router.post("/start", lifecycle(() => service.start()));
  router.post("/stop", lifecycle(() => service.stop()));

  /** Removes the container. `?profile=forget` also drops the logins. */
  router.delete("/install", async (req, res) => {
    try {
      if (req.query.profile === "forget") await service.forgetProfile();
      else await service.remove();
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
    // Unwired once it is gone: tools for a browser that does not exist are the worse of the two.
    await connect(false);
    res.json({ ok: true });
  });

  router.put("/config", json, (req, res) => {
    const { user, password, port, httpsPort } = req.body ?? {};
    const saved = service.saveConfig({ user, password, port, httpsPort });
    res.json({ user: saved.user, hasPassword: Boolean(saved.password) });
  });

  router.get("/suggest-password", (_req, res) => {
    res.json({ password: service.suggestPassword() });
  });

  /** Whether the browser tools show their cursor. It applies from the next action. */
  router.put("/cursor", json, (req, res) => {
    const on = req.body?.on;
    if (typeof on !== "boolean") return res.status(400).json({ error: "on must be a boolean" });
    putSettings({ cursor: on });
    res.json({ cursor: on });
  });

  router.use("/ui", proxyUi);
}
