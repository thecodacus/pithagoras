import express, { type Router } from "express";
import { agentHome } from "../agent-home.js";
import { addExtensionProviders, rereadConfig, thinkingLevelsOf } from "../pi/model-runtime.js";
import { readPiSettings } from "../pi-settings.js";
import {
  APIS, PRESETS, ProbeError, TakenError, checkProviders, configStamp, listProviders, probeModels, removeProvider, saveProvider, savedServer,
  type ProviderKind,
} from "../providers.js";

/**
 * What is installed, as pi's settings list it: a package, or an extension by
 * its path, may bring a provider. Not when the file last changed — every
 * default and extension setting saved rewrites it, and each rebuild runs
 * every extension's code again.
 */
function installedStamp(): string {
  const settings = readPiSettings();
  return JSON.stringify([settings.packages ?? null, settings.extensions ?? null]);
}

/**
 * pi's view of every model, outside any conversation — for the defaults in
 * Settings, which have no session to ask — with the providers installed
 * packages bring, as a session has them. Built once and kept until the files
 * it was built from change: creating it reads pi's whole catalogue.
 */
let runtime: { installed: string; config: string; value: Promise<any> } | undefined;
export function modelRuntime(cwd = agentHome()): Promise<any> {
  const installed = installedStamp();
  const config = configStamp();
  if (runtime?.installed !== installed) {
    // Made anew only when what is installed changes: that loads every
    // extension's code, which is not something to do on every saved key.
    const value = import("@earendil-works/pi-coding-agent").then(async (pi: any) => {
      const rt = await pi.ModelRuntime.create();
      // Without them the models pi offers would be only its own and models.json's.
      await addExtensionProviders(pi, rt, cwd).catch((e) => console.error(`[portal] package providers not loaded: ${(e as Error).message}`));
      return rt;
    });
    runtime = { installed, config, value };
  } else if (runtime.config !== config) {
    // A provider or a key changed: the same runtime reads pi's two files again, as an open chat's does.
    runtime.config = config;
    const kept = runtime;
    kept.value = kept.value.then(async (rt) => {
      // One that fails — a file caught half written — keeps the catalogue as
      // it was, rather than throwing away what was built and running every
      // extension again to build another. Read again when next asked.
      await rereadConfig(rt).catch((e) => {
        console.error(`[portal] pi's model files could not be read again: ${(e as Error).message}`);
        kept.config = "";
      });
      return rt;
    });
  }
  const { value } = runtime;
  value.catch(() => {
    lastFailure = Date.now();
    if (runtime?.value === value) runtime = undefined;
  });
  return value;
}

/** When building pi's catalogue last failed — building, not reading its files again; see modelLevels. */
let lastFailure = 0;
const RETRY_AFTER_MS = 60_000;

/**
 * The effort levels a model offers, without starting a conversation — for a
 * chat that is not running, whose pills otherwise drew the full slider for a
 * model that only switches thinking on and off. Empty when the model is not
 * known, and when pi's catalogue is not ready within `wait`: the page then
 * keeps what it last saw for the model.
 *
 * Only a short wait. The catalogue is kept once built, and re-reading pi's
 * two files is quick; building it runs every extension's code, which after a
 * start or an install takes far longer than a pill should wait. That build is
 * started here and left to finish for the next chat opened. One that failed
 * is not tried again from here for a while: each chat opened would run every
 * extension again, only to fail again.
 */
export async function modelLevels(provider: string | undefined, id: string | undefined, wait = 150): Promise<string[]> {
  if (!provider || !id) return [];
  // Only while there is none: one built since, for Settings, is used at once.
  if (!runtime && Date.now() - lastFailure < RETRY_AFTER_MS) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), wait); });
  try {
    const rt = await Promise.race([modelRuntime(), late]);
    const model = rt?.getModel?.(provider, id);
    return model ? thinkingLevelsOf(model) : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** pi's names for its hosted services, and which of them it finds a key for outside its files. */
async function services(): Promise<{ names: Record<string, string>; envKeyed: Record<string, string>; hosted: { id: string; name: string }[] }> {
  try {
    const rt = await modelRuntime();
    const names: Record<string, string> = {};
    const envKeyed: Record<string, string> = {};
    const hosted: { id: string; name: string }[] = [];
    for (const p of rt.getProviders() as { id: string; name?: string }[]) {
      names[p.id] = p.name ?? p.id;
      hosted.push({ id: p.id, name: p.name ?? p.id });
      const status = rt.getProviderAuthStatus?.(p.id);
      if (status?.configured && status.source === "environment") envKeyed[p.id] = "environment";
    }
    hosted.sort((a, b) => a.name.localeCompare(b.name));
    return { names, envKeyed, hosted };
  } catch {
    return { names: {}, envKeyed: {}, hosted: [] };
  }
}

const KINDS = new Set(PRESETS.map((p) => p.kind));

const droppedComments = (backup: string) =>
  `models.json had comments, which saving here does not keep. It is kept as it was in ${backup}, beside it.`;

export function providersRouter(): Router {
  const router = express.Router();

  router.get("/providers", async (_req, res) => {
    const { names, envKeyed, hosted } = await services();
    res.json({ presets: PRESETS, apis: APIS, providers: listProviders(names, envKeyed), hosted });
  });

  /** Whether each server answers now: for the dot beside it. */
  router.get("/providers/status", async (_req, res) => {
    res.json({ status: await checkProviders() });
  });

  /** Asks a server for its models, before or after it is saved. */
  router.post("/providers/probe", async (req, res) => {
    const { kind, baseUrl, apiKey, id } = req.body ?? {};
    if (!KINDS.has(kind) || typeof baseUrl !== "string" || !baseUrl.trim()) return res.status(400).json({ error: "An address to ask is needed." });
    try {
      const found = await probeModels(kind as ProviderKind, baseUrl, typeof apiKey === "string" ? apiKey : undefined, typeof id === "string" ? savedServer(id) : undefined);
      res.json(found);
    } catch (e) {
      res.status(e instanceof ProbeError ? 502 : 400).json({ error: (e as Error).message });
    }
  });

  router.put("/providers/:id", async (req, res) => {
    const body = req.body ?? {};
    if (!KINDS.has(body.kind)) return res.status(400).json({ error: "Which kind of provider this is was not said." });
    try {
      const { backup } = await saveProvider(req.params.id, {
        kind: body.kind,
        adding: body.adding === true,
        baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
        api: typeof body.api === "string" ? body.api : undefined,
        apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
        models: Array.isArray(body.models) ? body.models.filter((m: any) => m && typeof m.id === "string") : undefined,
      });
      res.json({ ok: true, ...(backup ? { note: droppedComments(backup) } : {}) });
    } catch (e) {
      res.status(e instanceof TakenError ? 409 : 400).json({ error: (e as Error).message });
    }
  });

  router.delete("/providers/:id", async (req, res) => {
    try {
      const { found, backup } = await removeProvider(req.params.id);
      if (!found) return res.status(404).json({ error: "Nothing is set up under that name." });
      res.json({ ok: true, ...(backup ? { note: droppedComments(backup) } : {}) });
    } catch (e) {
      // Said to the page as the rest are, not as Express's own page.
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** Every model pi can use now — the ones with a key — for the defaults. */
  router.get("/models", async (_req, res) => {
    try {
      const rt = await modelRuntime();
      const available = (await rt.getAvailable()) as any[];
      const names: Record<string, string> = {};
      for (const p of rt.getProviders() as { id: string; name?: string }[]) names[p.id] = p.name ?? p.id;
      res.json({
        models: available.map((m) => ({
          provider: m.provider, id: m.id, name: m.name ?? m.id, contextWindow: m.contextWindow,
          input: Array.isArray(m.input) ? m.input : undefined, reasoning: m.reasoning === true,
        })),
        providers: names,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}
