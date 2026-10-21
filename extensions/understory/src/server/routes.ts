import type { Router } from "express";
import { UNDERSTORY, UNDERSTORY_TOKEN_ENV, understoryDefaultUrl, understoryEntry, understoryTokenOf } from "./entry";
import { portal } from "./host";
import { modelServer } from "./llm";
import * as service from "./service";

/**
 * Understory's page in Settings, at /api/x/pithagoras-understory/…, behind the portal's login: whether it is the
 * agent's memory, and the Understory the portal runs. A change answers the state after it (`understory`), and, where
 * it wrote the agent's MCP entry, how many idle chats have it now and how many busy ones from their next step.
 *
 *   GET    /state              whether Understory is the agent's memory, where, and the Understory the portal runs
 *   PUT    /use                {enabled, url?}: Understory as the agent's memory, or not
 *   PUT    /config             {llm, dreamInterval?, dreamAt?}: the model that keeps the memory, and when it tidies up
 *   POST   /dream              tidies the memory up now
 *   POST   /install            runs Understory here, and makes it the agent's memory
 *   DELETE /install            stops running it here; `?memory=forget` forgets the memory too
 *   POST   /start, /stop
 */

/** Whether anything answers at the server's address: its web UI lives at the root. */
async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(new URL(url).origin, { signal: AbortSignal.timeout(2500) });
    return true;
  } catch {
    return false;
  }
}

/** What the page is told of the saved settings: never the key itself. */
function shownConfig() {
  const { llm, dreamInterval, dreamAt } = service.config();
  if (llm?.source !== "custom") return { llm, dreamInterval, dreamAt };
  const { apiKey, ...rest } = llm;
  return { llm: { ...rest, hasKey: Boolean(apiKey) }, dreamInterval, dreamAt };
}

/** Providers set up here that have an address Understory can be pointed at, with their models. */
function providersForUnderstory() {
  return portal()
    .models.list()
    .filter((p) => p.baseUrl !== undefined)
    .map(({ provider, models }) => ({ id: provider, models }));
}

/** The time zone the portal's clock runs in, which "03:00" is read on: UTC where the runtime cannot say ("Etc/Unknown"). */
function serverTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone === "Etc/Unknown" ? "UTC" : zone;
}

async function understoryState() {
  const server = portal().mcp.get(UNDERSTORY);
  const url = typeof server?.entry.url === "string" && server.entry.url ? server.entry.url : understoryDefaultUrl();
  const [reached, runtime] = await Promise.all([reachable(url), service.status()]);
  return {
    // As the chats see it: on only with the adapter its tools come through.
    enabled: server?.on === true,
    url,
    tokenSet: Boolean(understoryTokenOf(server?.entry) ?? process.env[UNDERSTORY_TOKEN_ENV]),
    reachable: reached,
    // The Understory the portal runs itself, if it does or can.
    managed: {
      ...runtime,
      url: service.managedUrl(),
      config: shownConfig(),
      // Whether "the chat's" can be offered: the model server listens.
      autoPossible: modelServer().listening,
      providers: providersForUnderstory(),
      dreaming: service.isDreaming(),
      lastDream: service.lastDream(),
      nextDream: service.nextDreamAt()?.toISOString() ?? null,
      // What "03:00" means: the portal's clock.
      timeZone: serverTimeZone(),
    },
  };
}

/**
 * Understory in the agent's MCP servers, or out of them. The Understory the
 * portal runs, where it runs one, is the one written, with its token;
 * otherwise the address given, or the one there before. Switched on, its
 * words are counted as the person's own (Settings → Guard): it is the agent's
 * own notes, and the person switched it on.
 */
async function switchUnderstory(enabled: boolean, url?: string): Promise<{ reloaded: number; waiting: number }> {
  const { mcp } = portal();
  if (!enabled) return mcp.set(UNDERSTORY, undefined);
  // Kept: whatever else somebody put in the entry by hand, except how it signs in, which is said anew.
  const { disabled: _off, auth: _a, bearerToken: _t, bearerTokenEnv: _e, ...had } = mcp.get(UNDERSTORY)?.entry ?? {};
  // An address given is the one meant; without one, the portal's own Understory where it runs one.
  return mcp.set(
    UNDERSTORY,
    url === undefined && (await service.installed())
      ? { ...had, ...understoryEntry(service.managedUrl(), { token: await service.heldToken() }) }
      : {
          ...had,
          ...understoryEntry(url ?? (typeof had.url === "string" && had.url ? had.url : understoryDefaultUrl()), {
            ...(process.env[UNDERSTORY_TOKEN_ENV] ? { tokenEnv: UNDERSTORY_TOKEN_ENV } : {}),
          }),
        },
    { trusted: true },
  );
}

/** The model a request names, checked; undefined when it names none that can be used. */
function llmFrom(body: any): service.LlmChoice | undefined {
  if (body?.source === "auto") return { source: "auto" };
  const model = typeof body?.model === "string" ? body.model.trim() : "";
  if (!model) return undefined;
  if (body.source === "provider") {
    const known = providersForUnderstory().some((p) => p.id === body.provider);
    return known ? { source: "provider", provider: body.provider, model } : undefined;
  }
  if (body.source === "custom") {
    const baseUrl = httpUrl(body.baseUrl);
    const format = body.format === "anthropic" ? "anthropic" : body.format === "openai" ? "openai" : undefined;
    if (!baseUrl || !format) return undefined;
    if (body.apiKey !== undefined && typeof body.apiKey !== "string") return undefined;
    return { source: "custom", baseUrl, model, format, ...(body.apiKey !== undefined ? { apiKey: body.apiKey.trim() } : {}) };
  }
  return undefined;
}

const httpUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

/** The status a failure is answered with: its own where it has one HTTP has (Docker's is 0 where Docker was not reached), else `otherwise`. */
export function statusOf(e: unknown, otherwise = 500): number {
  const status = (e as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 600 ? status : otherwise;
}

export function understoryRoutes(router: Router): void {
  const json = portal().http.json({ limit: "2mb" });

  router.get("/state", async (_req, res) => {
    try {
      res.json(await understoryState());
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.put("/use", json, async (req, res) => {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be true or false" });
    const url = req.body?.url === undefined ? undefined : httpUrl(req.body.url);
    if (req.body?.url !== undefined && !url) return res.status(400).json({ error: "The address must be an http or https URL" });
    try {
      // Which memory a chat reads is settled when it starts: the idle chats are loaded again with it.
      const { reloaded, waiting } = await switchUnderstory(enabled, url);
      res.json({ understory: await understoryState(), reloaded, waiting });
    } catch (e) {
      res.status(statusOf(e)).json({ error: (e as Error).message });
    }
  });

  /**
   * The model that keeps the memory and how often it tidies up, for the
   * Understory the portal runs. Understory reads both only when it starts,
   * so a running one is made again with them; its memory stays.
   */
  router.put("/config", json, async (req, res) => {
    const llm = llmFrom(req.body?.llm);
    if (llm === undefined) return res.status(400).json({ error: "Choose the chat's model, a provider and model, or an http(s) address, a model and a format" });
    const dreamInterval = typeof req.body?.dreamInterval === "string" ? req.body.dreamInterval.trim() : "";
    if (!service.validInterval(dreamInterval)) return res.status(400).json({ error: "Tidying up takes an interval like 30m, 6h or 1d, of at least 5 minutes" });
    const dreamAt = typeof req.body?.dreamAt === "string" ? req.body.dreamAt.trim() : "";
    if (!service.validTime(dreamAt)) return res.status(400).json({ error: "Tidying up at a time takes one like 03:00" });
    // What Understory would be started with, worked out first: a choice it
    // could not be started with is refused, not saved.
    try {
      await service.spec({ ...service.config(), llm: service.withSavedKey(llm), dreamInterval, dreamAt }, "check");
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
    const before = service.savedConfig();
    const wasInstalled = await service.installed();
    // Made anew as it was: one stopped stays stopped, and runs no pass meanwhile.
    const wasRunning = wasInstalled && (await service.status()).container === "running";
    try {
      service.saveConfig({ llm, dreamInterval, dreamAt });
      if (wasInstalled) await service.install({ start: wasRunning });
      res.json({ understory: await understoryState() });
    } catch (e) {
      service.restoreConfig(before);
      // Made anew is removed first: one that could not be made with the new
      // settings is made again with the old, rather than left gone.
      if (wasInstalled && !(await service.installed().catch(() => true))) {
        await service.install({ start: wasRunning }).catch((again) => portal().log(`Understory could not be made again: ${(again as Error).message}`));
      }
      res.status(statusOf(e)).json({ error: (e as Error).message });
    }
  });

  /** Tidies the memory up now, with Understory's own pass; answers once it is done. */
  router.post("/dream", async (_req, res) => {
    try {
      const run = await service.dreamNow();
      // A pass that failed says why, where the page looks for it.
      res.status(run.ok ? 200 : 502).json({ ...(run.ok ? {} : { error: run.said }), run, understory: await understoryState() });
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
    }
  });

  /** Runs Understory here, and makes it the agent's memory. */
  router.post("/install", async (_req, res) => {
    try {
      await service.install();
      const { reloaded, waiting } = await switchUnderstory(true);
      res.json({ understory: await understoryState(), reloaded, waiting });
    } catch (e) {
      res.status(statusOf(e)).json({ error: (e as Error).message });
    }
  });

  for (const action of ["start", "stop"] as const) {
    router.post(`/${action}`, async (_req, res) => {
      try {
        await service[action]();
        res.json({ understory: await understoryState() });
      } catch (e) {
        res.status(500).json({ error: (e as Error).message });
      }
    });
  }

  /**
   * Stops running it here. The memory stays in its volume unless
   * `?memory=forget`. An agent pointed at it is pointed at nothing now, so
   * Understory is switched off as its memory, and MEMORY.md comes back.
   */
  router.delete("/install", async (req, res) => {
    try {
      // Removed first: switched off as the memory only once it is gone, so a
      // removal that fails — busy with a pass, Docker refusing — leaves both as they were.
      await (req.query.memory === "forget" ? service.forgetMemory() : service.remove());
      const switched = portal().mcp.get(UNDERSTORY)?.entry.url === service.managedUrl() ? await switchUnderstory(false) : {};
      res.json({ understory: await understoryState(), ...switched });
    } catch (e) {
      res.status(statusOf(e)).json({ error: (e as Error).message });
    }
  });
}
