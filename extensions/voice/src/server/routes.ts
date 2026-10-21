import type { Router } from "express";
import { parseChoice } from "../engines";
import { portal } from "./host";
import { chooseFinished } from "./provider";
import * as service from "./service";
import { putSettings, setting } from "./store";

/**
 * The voice service's page in Settings, at /api/x/pithagoras-voice/…, behind the portal's login.
 *
 *   GET  /state       how the service stands: whether Docker answers, its state, the setup log, the engines it is built
 *                     for, and whether its speech model is let go of once voice mode no longer uses it (`lazyLoad`)
 *   GET  /hardware    the GPUs, and what would fit
 *   PUT  /gpu         {gpu}: the card, by UUID, or "" to leave it to VOICE_GPU and then the card with the most room
 *   POST /install     [a choice of engines]: builds and starts it; voice mode listens and speaks through it once it is up
 *   POST /start, /stop
 *   POST /uninstall   {removeData}: removes the container, and with removeData the downloads; voice mode goes back to
 *                     the person's own addresses where it listened and spoke through it
 *   POST /connect     voice mode listens and speaks through it from now on
 *   PUT  /lazy-load   {on}
 */
export function voiceRoutes(router: Router): void {
  const json = portal().http.json();

  /** Choose the GPU by UUID, or "" to leave it to VOICE_GPU and then the card with the most room. A running voice moves now; a stopped one on its next start. */
  router.put("/gpu", json, async (req, res) => {
    const id = req.body?.gpu;
    if (typeof id !== "string") return res.status(400).json({ error: "gpu must be a GPU UUID, or empty to choose automatically" });
    try {
      // Before anything is saved or stopped: a card that is not there, or that cannot hold the engines installed, leaves the service where it is.
      if (id) await service.checkGpu(id);
      putSettings({ gpu: id });
      const restarting = ["running", "starting"].includes((await service.status()).state);
      if (restarting) {
        // Saved either way: a setup already under way picks the new GPU up on the next start.
        try {
          await service.install();
        } catch (e) {
          return res.status(409).json({ error: `GPU choice saved, but voice could not restart on it now: ${(e as Error).message}. It moves on the next start.` });
        }
      }
      res.json({ selected: id, restarting });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
  router.get("/state", async (_req, res) => {
    try {
      const state = await service.status();
      chooseFinished(state);
      res.json({ ...state, lazyLoad: setting("lazyLoad") !== false });
    } catch (e) {
      res.status(503).json({ error: (e as Error).message });
    }
  });
  router.get("/hardware", async (_req, res) => {
    try {
      res.json(await service.hardware());
    } catch (e) {
      res.status(503).json({ error: (e as Error).message });
    }
  });
  for (const action of ["install", "start", "stop"] as const) {
    router.post(`/${action}`, json, async (req, res) => {
      try {
        // Install takes the engines to build for; without them it keeps what is installed, or picks for the GPU.
        if (action === "install") await service.install(Object.keys(req.body ?? {}).length ? parseChoice(req.body) : undefined);
        else await service[action]();
        putSettings({ setupPending: action !== "stop" });
        res.json({ ok: true });
      } catch (e) {
        res.status(400).json({ error: (e as Error).message });
      }
    });
  }
  // The container goes, and voice mode with it, where it listened and spoke through it. The downloads stay unless `removeData` says they go too.
  router.post("/uninstall", json, async (req, res) => {
    try {
      const removeData = req.body?.removeData ?? false;
      if (typeof removeData !== "boolean") throw new Error("removeData must be true or false");
      // The container being gone is what voice mode follows, whether or not the downloads could be deleted after it.
      let kept: Error | undefined;
      try {
        await service.uninstall(removeData);
      } catch (e) {
        if (!(e instanceof service.DataNotRemoved)) throw e;
        kept = e;
      }
      putSettings({ setupPending: false });
      portal().voice.choose(false);
      if (kept) return res.status(409).json({ error: kept.message });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
  router.post("/connect", async (_req, res) => {
    try {
      if ((await service.status()).state !== "running") throw new Error("Wait for voice setup to finish before connecting");
      portal().voice.choose(true);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
  router.put("/lazy-load", json, (req, res) => {
    const on = req.body?.on;
    if (typeof on !== "boolean") return res.status(400).json({ error: "on must be a boolean" });
    putSettings({ lazyLoad: on });
    res.json({ lazyLoad: on });
  });
}
