import express, { type Router } from "express";
import { getSession, packageRemoved, sessionSubagentModel, setSessionSubagentModel } from "../db.js";
import {
  SUBAGENT_MAX_PARALLEL,
  UNDERSTORY,
  UNDERSTORY_TOKEN_ENV,
  bundledSubagentDir,
  isModelChoice,
  localPackagePath,
  subagentModelOf,
  subagentState,
  understoryDefaultUrl,
  understoryEntry,
  understoryIn,
  understoryOn,
  understoryTokenOf,
} from "../features.js";
import { ImageGenerationError, imageEditingMultiple, imageEditingReady, imageGenerationReady, imageGenerationState, parseImageGenerationPatch, saveImageGeneration } from "../image-generation.js";
import { VideoGenerationError, parseVideoGenerationPatch, saveVideoGeneration, videoGenerationReady, videoGenerationState } from "../video-generation.js";
import { readPiSettings, updatePiSettings } from "../pi-settings.js";
import { sessions } from "../session-manager.js";
import { followPackages, switchPackage } from "./extensions.js";
import { ADAPTER_SPEC, mcpAdapter, readMcpFile, writeMcpFile } from "./mcp.js";
import * as service from "../extensions/understory-service.js";
import { readModelsJson } from "../providers.js";
import { pi } from "./packages.js";
import { serverTimeZone } from "../time-zone.js";

const adapterEntry = () => mcpAdapter();

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
  const providers = readModelsJson().providers ?? {};
  return Object.entries<Record<string, any>>(providers)
    .filter(([, p]) => p && typeof p.baseUrl === "string" && Array.isArray(p.models))
    .map(([id, p]) => ({ id, models: p.models.filter((m: any) => typeof m?.id === "string").map((m: any) => String(m.id)) }));
}

async function understoryState() {
  const { config, error } = readMcpFile();
  const entry = config.mcpServers?.[UNDERSTORY] as Record<string, unknown> | undefined;
  const url = typeof entry?.url === "string" && entry.url ? entry.url : understoryDefaultUrl();
  const adapter = adapterEntry();
  const [reached, runtime] = await Promise.all([reachable(url), service.status()]);
  return {
    // As the chats see it: on only with the adapter its tools come through.
    enabled: !error && understoryIn(config) && adapter?.enabled === true,
    url,
    tokenSet: Boolean(understoryTokenOf(entry) ?? process.env[UNDERSTORY_TOKEN_ENV]),
    adapterInstalled: adapter?.enabled === true,
    reachable: reached,
    // The Understory the portal runs itself, if it does or can.
    managed: {
      ...runtime,
      url: service.managedUrl(),
      config: shownConfig(),
      // Whether "the chat's" can be offered: not over the portal's own TLS.
      autoPossible: service.portalLlmBase() !== undefined,
      providers: providersForUnderstory(),
      dreaming: service.isDreaming(),
      lastDream: service.lastDream(),
      nextDream: service.nextDreamAt()?.toISOString() ?? null,
      // What "03:00" means: the portal's clock.
      timeZone: serverTimeZone(),
    },
    ...(error ? { configError: error } : {}),
  };
}

/**
 * Understory in the agent's MCP servers, or out of them. The portal's own
 * Understory, where it runs one, is the one written, with its token;
 * otherwise the address given, or the one there before.
 */
async function switchUnderstory(enabled: boolean, url?: string): Promise<void> {
  const { config, error } = readMcpFile();
  if (error) throw Object.assign(new Error(`Fix mcp.json first: ${error}`), { status: 409 });
  if (enabled) {
    // The adapter is what makes an MCP server into tools; without it the entry does nothing.
    const adapter = adapterEntry();
    if (!adapter) await pi(["install", ADAPTER_SPEC]);
    else if (!adapter.enabled) await switchPackage(adapter.source, true);
    await followPackages();
    // Kept: whatever else somebody put in the entry by hand, except how it signs in, which is said anew.
    const { disabled: _off, auth: _a, bearerToken: _t, bearerTokenEnv: _e, ...had } = (config.mcpServers[UNDERSTORY] ?? {}) as Record<string, unknown>;
    // An address given is the one meant; without one, the portal's own Understory where it runs one.
    config.mcpServers[UNDERSTORY] = url === undefined && (await service.installed())
      ? { ...had, ...understoryEntry(service.managedUrl(), { token: service.token() }) }
      : {
          ...had,
          ...understoryEntry(url ?? (typeof had.url === "string" && had.url ? had.url : understoryDefaultUrl()), {
            ...(process.env[UNDERSTORY_TOKEN_ENV] ? { tokenEnv: UNDERSTORY_TOKEN_ENV } : {}),
          }),
        };
  } else {
    delete config.mcpServers[UNDERSTORY];
  }
  writeMcpFile(config);
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

/**
 * The opt-in features: what is on, and switching each. A switch reloads the
 * idle conversations, as switching a package does, so it is there without a
 * restart; a running one keeps what it had until it is reloaded.
 */
export function featuresRouter(): Router {
  const router = express.Router();

  /**
   * Only whether each is on: for the sidebar and every chat's menus, which
   * need no more. Reads two small files; nothing is asked of Understory or Docker.
   * Images is on when it can make a picture: switched on, and with an address to ask; Videos when it can make a clip.
   */
  router.get("/features/flags", (_req, res) => {
    try {
      res.json({ subagent: { enabled: subagentState().enabled }, understory: { enabled: understoryOn() }, images: { enabled: imageGenerationReady() || imageEditingReady() }, videos: { enabled: videoGenerationReady() } });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** The subagent tool alone: its tab needs nothing of Understory or Docker. */
  router.get("/features/subagent", (_req, res) => {
    try {
      res.json({ subagent: subagentState() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** Image generation alone, as the subagent tool: its tab needs nothing of Understory or Docker. The key is never in it, only whether one is set. */
  router.get("/features/images", (_req, res) => {
    try {
      res.json({ images: imageGenerationState() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** Video generation alone, as the image endpoint: the key is never in it, only whether one is set. */
  router.get("/features/videos", (_req, res) => {
    try {
      res.json({ videos: videoGenerationState() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.get("/features", async (_req, res) => {
    try {
      res.json({ subagent: subagentState(), understory: await understoryState(), images: imageGenerationState() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.put("/features/subagent", async (req, res) => {
    const { enabled, mode, maxParallel, model } = req.body ?? {};
    if (model !== undefined && !isModelChoice(model)) return res.status(400).json({ error: 'model must be "auto" or provider/model' });
    if (enabled !== undefined && typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be true or false" });
    if (mode !== undefined && mode !== "interrupt" && mode !== "background") {
      return res.status(400).json({ error: "mode must be interrupt or background" });
    }
    if (maxParallel !== undefined && !(Number.isInteger(maxParallel) && maxParallel >= 1 && maxParallel <= SUBAGENT_MAX_PARALLEL)) {
      return res.status(400).json({ error: `maxParallel must be a whole number from 1 to ${SUBAGENT_MAX_PARALLEL}` });
    }
    try {
      if (mode || maxParallel !== undefined || model !== undefined) {
        // What the tool does without being told is left unsaid: interrupt, one at a time, the chat's model.
        await updatePiSettings((all) => {
          if (model === "auto") delete all.subagentModel;
          else if (model !== undefined) all.subagentModel = model;
          if (mode === "background") all.subagentMode = "background";
          else if (mode) delete all.subagentMode;
          if (maxParallel === 1) delete all.subagentMaxParallel;
          else if (maxParallel !== undefined) all.subagentMaxParallel = maxParallel;
        });
      }
      const state = subagentState();
      if (enabled === true && !state.enabled) {
        if (state.source) await switchPackage(state.source, true);
        else {
          const bundled = bundledSubagentDir();
          if (!bundled) return res.status(409).json({ error: "The subagent tool is not part of this install" });
          await pi(["install", bundled]);
        }
      }
      if (enabled === false && state.source) {
        // A folder as pi's settings name it is relative to its folder; handed
        // to `pi remove` as it is, pi reads it from where the portal runs.
        const local = !/^(npm|git|https?):/.test(state.source);
        await pi(["remove", local ? localPackagePath(state.source) : state.source]);
        await packageRemoved(state.source);
      }
      // A package installed, removed or switched: its server half follows, where it has one.
      if (enabled !== undefined) await followPackages();
      // The mode changes what the tool tells the model, which it reads when it is loaded.
      const { reloaded, waiting } = await sessions.reloadIdle();
      res.json({ subagent: subagentState(), reloaded, waiting });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /**
   * The image endpoint and whether the agent has a tool for it, and for editing
   * a picture. A tool is there only while it is on and has an address, and a
   * chat decides that when it loads, so a change in either reloads the idle
   * ones. So does one in whether the edit tool takes a list of pictures, which
   * is the shape of its parameters. The rest — address, model, size, key — is
   * read at each call and needs no reload.
   */
  router.put("/features/images", async (req, res) => {
    const patch = parseImageGenerationPatch(req.body);
    if (typeof patch === "string") return res.status(400).json({ error: patch });
    try {
      const before = [imageGenerationReady(), imageEditingReady(), imageEditingMultiple()];
      saveImageGeneration(patch);
      const changed = imageGenerationReady() !== before[0] || imageEditingReady() !== before[1] || imageEditingMultiple() !== before[2];
      const { reloaded, waiting } = changed ? await sessions.reloadIdle() : { reloaded: 0, waiting: 0 };
      res.json({ images: imageGenerationState(), changed, reloaded, waiting });
    } catch (e) {
      res.status(e instanceof ImageGenerationError ? 400 : 500).json({ error: (e as Error).message });
    }
  });

  /**
   * The video endpoint and whether the agent has the tools for it. A tool is there only while it is on and
   * has an address, and a chat decides that when it loads, so a change in that reloads the idle ones. The
   * rest — address, model, size, key, time limit — is read at each call and needs no reload.
   */
  router.put("/features/videos", async (req, res) => {
    const patch = parseVideoGenerationPatch(req.body);
    if (typeof patch === "string") return res.status(400).json({ error: patch });
    try {
      const before = videoGenerationReady();
      saveVideoGeneration(patch);
      const changed = videoGenerationReady() !== before;
      const { reloaded, waiting } = changed ? await sessions.reloadIdle() : { reloaded: 0, waiting: 0 };
      res.json({ videos: videoGenerationState(), changed, reloaded, waiting });
    } catch (e) {
      res.status(e instanceof VideoGenerationError ? 400 : 500).json({ error: (e as Error).message });
    }
  });

  /** What one chat's subagents run on: its own choice, or null for the portal's default. */
  router.get("/sessions/:id/subagent-model", (req, res) => {
    if (!getSession(req.params.id)) return res.status(404).json({ error: "Not found" });
    res.json({ model: sessionSubagentModel(req.params.id), default: subagentModelOf(readPiSettings()) });
  });

  router.put("/sessions/:id/subagent-model", (req, res) => {
    if (!getSession(req.params.id)) return res.status(404).json({ error: "Not found" });
    const model = req.body?.model ?? null;
    if (model !== null && !isModelChoice(model)) return res.status(400).json({ error: 'model must be null, "auto" or provider/model' });
    // Asked when a subagent starts: nothing to reload.
    setSessionSubagentModel(req.params.id, model);
    res.json({ model, default: subagentModelOf(readPiSettings()) });
  });

  router.put("/features/understory", async (req, res) => {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be true or false" });
    const url = req.body?.url === undefined ? undefined : httpUrl(req.body.url);
    if (req.body?.url !== undefined && !url) return res.status(400).json({ error: "The address must be an http or https URL" });
    try {
      await switchUnderstory(enabled, url);
      // Which memory a chat reads is settled when it starts.
      const { reloaded, waiting } = await sessions.reloadIdle();
      res.json({ understory: await understoryState(), reloaded, waiting });
    } catch (e) {
      res.status((e as { status?: number }).status ?? 500).json({ error: (e as Error).message });
    }
  });

  /**
   * The model that keeps the memory and how often it tidies up, for the
   * Understory the portal runs. Understory reads both only when it starts,
   * so a running one is made again with them; its memory stays.
   */
  router.put("/features/understory/config", async (req, res) => {
    const llm = llmFrom(req.body?.llm);
    if (llm === undefined) return res.status(400).json({ error: "Choose the chat's model, a provider and model, or an http(s) address, a model and a format" });
    const dreamInterval = typeof req.body?.dreamInterval === "string" ? req.body.dreamInterval.trim() : "";
    if (!service.validInterval(dreamInterval)) return res.status(400).json({ error: "Tidying up takes an interval like 30m, 6h or 1d, of at least 5 minutes" });
    const dreamAt = typeof req.body?.dreamAt === "string" ? req.body.dreamAt.trim() : "";
    if (!service.validTime(dreamAt)) return res.status(400).json({ error: "Tidying up at a time takes one like 03:00" });
    // What Understory would be started with, worked out first: a choice it
    // could not be started with is refused, not saved.
    try {
      service.spec({ ...service.config(), llm: service.withSavedKey(llm), dreamInterval, dreamAt }, "check");
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
    const before = service.config();
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
        await service.install({ start: wasRunning }).catch((again) => console.error(`[portal] Understory could not be made again: ${(again as Error).message}`));
      }
      res.status((e as { status?: number }).status ?? 500).json({ error: (e as Error).message });
    }
  });

  /** Tidies the memory up now, with Understory's own pass; answers once it is done. */
  router.post("/features/understory/dream", async (_req, res) => {
    try {
      const run = await service.dreamNow();
      // A pass that failed says why, where the page looks for it.
      res.status(run.ok ? 200 : 502).json({ ...(run.ok ? {} : { error: run.said }), run, understory: await understoryState() });
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
    }
  });

  /** Runs Understory here, and makes it the agent's memory. */
  router.post("/features/understory/install", async (_req, res) => {
    try {
      await service.install();
      await switchUnderstory(true);
      const { reloaded, waiting } = await sessions.reloadIdle();
      res.json({ understory: await understoryState(), reloaded, waiting });
    } catch (e) {
      res.status((e as { status?: number }).status ?? 500).json({ error: (e as Error).message });
    }
  });

  for (const action of ["start", "stop"] as const) {
    router.post(`/features/understory/${action}`, async (_req, res) => {
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
  router.delete("/features/understory/install", async (req, res) => {
    try {
      // Removed first: switched off as the memory only once it is gone, so a
      // removal that fails — busy with a pass, Docker refusing — leaves both as they were.
      await (req.query.memory === "forget" ? service.forgetMemory() : service.remove());
      const { config } = readMcpFile();
      const entry = config.mcpServers?.[UNDERSTORY] as { url?: unknown } | undefined;
      if (entry?.url === service.managedUrl()) await switchUnderstory(false);
      const { reloaded, waiting } = await sessions.reloadIdle();
      res.json({ understory: await understoryState(), reloaded, waiting });
    } catch (e) {
      res.status((e as { status?: number }).status ?? 500).json({ error: (e as Error).message });
    }
  });

  return router;
}
