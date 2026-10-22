import type { Router } from "express";
import { parseChoice } from "../engines";
import { portal } from "./host";
import { chooseFinished } from "./provider";
import * as service from "./service";
import { checkSpeech, putSettings, setting, speech } from "./store";
import { addVoice, deleteVoice, listVoices, updateVoice, voiceAudio, VoiceNotFound } from "./voices";

/**
 * The voice service's page in Settings, at /api/x/pithagoras-voice/…, behind the portal's login.
 *
 *   GET  /state       how the service stands: whether Docker answers, its state, the setup log, the engines it is built
 *                     for, whether its speech model is let go of once voice mode no longer uses it (`lazyLoad`), and
 *                     whether it is voice mode's source (`chosen`)
 *   GET  /hardware    the GPUs, and what would fit
 *   PUT  /gpu         {gpu}: the card, by UUID, or "" to leave it to VOICE_GPU and then the card with the most room
 *   POST /install     [a choice of engines]: builds and starts it; voice mode listens and speaks through it once it is up
 *   POST /start, /stop
 *   POST /uninstall   {removeData}: removes the container, and with removeData the downloads; voice mode has no source
 *                     after, where it listened and spoke through it
 *   PUT  /chosen      {chosen}: voice mode listens and speaks through it from now on, or no longer does
 *   PUT  /lazy-load   {on}
 *   GET, PUT /speech  how it speaks: its own choice of voice, the designed voice, the engines' settings, the language
 *   GET, POST /voices the voice library, and a voice added to it
 *   PATCH  /voices/:id         {instruction}: what the voice is told to sound like
 *   GET    /voices/:id/audio   a clone's recording
 *   DELETE /voices/:id
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
      res.json({ ...state, lazyLoad: setting("lazyLoad") !== false, chosen: portal().voice.chosen() });
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
  // The container goes, and voice mode has no source after, where it listened and spoke through it. The downloads stay unless `removeData` says they go too.
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
  // Use for voice mode, and Stop using: only a service that runs is made the source.
  router.put("/chosen", json, async (req, res) => {
    const chosen = req.body?.chosen;
    if (typeof chosen !== "boolean") return res.status(400).json({ error: "chosen must be a boolean" });
    try {
      if (chosen && (await service.status()).state !== "running") throw new Error("Wait for voice setup to finish before using it for voice mode");
      portal().voice.choose(chosen);
      res.json({ chosen: portal().voice.chosen() });
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
  router.get("/speech", (_req, res) => res.json(speech()));
  // Held to what the engine of the container takes, where there is a container.
  router.put("/speech", json, async (req, res) => {
    try {
      putSettings(checkSpeech(req.body ?? {}, (await service.status()).choice?.tts));
      res.json(speech());
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
  router.get("/voices", (_req, res) => res.json(listVoices()));
  // A clone's recording comes as base64 in the JSON: about 1.3 MB for 30 seconds.
  router.post("/voices", portal().http.json({ limit: "2mb" }), (req, res) => {
    try {
      res.json(addVoice(req.body));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
  router.patch("/voices/:id", json, (req, res) => {
    try {
      res.json(updateVoice(String(req.params.id), req.body));
    } catch (e) {
      res.status(e instanceof VoiceNotFound ? 404 : 400).json({ error: (e as Error).message });
    }
  });
  router.get("/voices/:id/audio", (req, res) => {
    try {
      const wav = voiceAudio(String(req.params.id));
      res.set({ "Content-Type": "audio/wav", "Cache-Control": "no-store" }).send(wav);
    } catch {
      res.sendStatus(404);
    }
  });
  router.delete("/voices/:id", (req, res) => {
    try {
      deleteVoice(String(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });
}
