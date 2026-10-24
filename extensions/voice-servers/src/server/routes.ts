import type { Response, Router } from "express";
import { portal } from "./host";
import { offered, serverOf } from "./requests";
import { storeOnServer, uploadUrl } from "./server-store";
import { checkCustom, checkSettings, checkUrl, saveSettings, settings, SPEECH_SERVERS, type ServerVoice, type Settings } from "./store";
import { addVoice, deleteVoice, findVoice, listVoices, updateVoice, voiceAudio, VoiceNotFound } from "./voices";

/** The voices in a server's answer to …/audio/voices: names alone, or `{ id, name? }`; nothing where it is neither. */
function listed(answer: unknown): ServerVoice[] | undefined {
  const voices = (answer as { voices?: unknown } | undefined)?.voices;
  if (!Array.isArray(voices)) return undefined;
  const read = voices.map((v) => {
    if (typeof v === "string") return { id: v, name: v };
    if (typeof v?.id === "string" && (v.name === undefined || typeof v.name === "string")) return { id: v.id, name: v.name || v.id };
    return undefined;
  });
  return read.every((v) => v !== undefined) ? read : undefined;
}

/**
 * Voice servers' page in Settings, at /api/x/pithagoras-voice-servers/…, behind the portal's login.
 *
 *   GET  /settings       the addresses, models, language and voices, and whether voice mode listens and speaks through
 *                        these servers now (`chosen`)
 *   PUT  /settings       the same, all of them: what is empty is left out
 *   POST /server-voices  {ttsUrl}: the voices the speech server lists beside that address, which need not be saved yet,
 *                        as it answers within 10 seconds
 *   PUT  /chosen         {chosen}: voice mode listens and speaks through these servers from now on, or no longer
 *   PUT  /custom-voices  {on}: custom voices on or off; off, the library stays, and is not offered
 *   PUT  /speech-server  {speechServer}: what the speech server is, and how it is reached (requests.ts)
 *   GET, POST /voices    the voice library, and a voice added to it, stored on the speech server where it keeps voices
 *   PATCH  /voices/:id         {name?, instruction?}: what the voice is called, and what it is told to sound like
 *   GET    /voices/:id/audio   a clone's recording
 *   POST   /voices/:id/store   a clone's recording stored on the speech server now, where it keeps voices
 *   DELETE /voices/:id
 */
export function routes(router: Router): void {
  const json = portal().http.json();
  const shown = () => ({ ...settings(), chosen: portal().voice.chosen() });

  router.get("/settings", (_req, res) => res.json(shown()));
  router.put("/settings", json, (req, res) => {
    try {
      saveSettings(checkSettings(req.body));
      res.json(shown());
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
  router.post("/server-voices", json, async (req, res) => {
    let at: string;
    try {
      const ttsUrl = checkUrl("The speech synthesis URL", req.body?.ttsUrl);
      at = ttsUrl.replace(/\/audio\/speech$/, "/audio/voices");
      if (at === ttsUrl) throw new Error("The voices are read from …/audio/voices beside an address that ends in /audio/speech");
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
    try {
      // Not the portal's 30-minute wait: a server that takes the connection and does not answer keeps the page busy.
      const answer = await fetch(at, { redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
      const voices = listed(await answer.json().catch(() => undefined));
      if (!voices) return res.status(400).json({ error: "The server's list of voices is not one this page reads" });
      res.json({ voices });
    } catch (e) {
      res.status(502).json({ error: `Could not read ${at}: ${(e as Error).message}` });
    }
  });
  /**
   * Custom voices, and what the speech server is, changed on their own, at once, as the page's switch and menus do. A
   * voice chosen on the page that the change no longer offers is chosen no longer, as where a voice is taken out of the
   * list.
   */
  const putCustom = (res: Response, patch: Settings) => {
    const { customVoices, speechServer, voice, ...rest } = { ...settings(), ...patch };
    const next: Settings = { ...rest, ...(customVoices ? { customVoices } : {}), ...(speechServer ? { speechServer } : {}) };
    if (voice && offered(next).some((v) => v.id === voice)) next.voice = voice;
    try {
      checkCustom(next);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
    saveSettings(next);
    res.json(shown());
  };
  router.put("/custom-voices", json, (req, res) => {
    const on = req.body?.on;
    if (typeof on !== "boolean") return res.status(400).json({ error: "on must be true or false" });
    putCustom(res, { customVoices: on || undefined });
  });
  router.put("/speech-server", json, (req, res) => {
    const server = req.body?.speechServer;
    if (!SPEECH_SERVERS.includes(server)) return res.status(400).json({ error: `speechServer is one of ${SPEECH_SERVERS.join(", ")}` });
    putCustom(res, { speechServer: server === "fixed" ? undefined : server });
  });
  /** Not the portal's 30-minute wait: a server that takes the connection and does not answer keeps the page busy. */
  const STORE_MS = 30_000;
  router.get("/voices", (_req, res) => res.json(listVoices()));
  // A clone's recording comes as base64 in the JSON: about 1.3 MB for 30 seconds. Where the speech server keeps voices,
  // a clone is stored there too; where that fails, the voice is kept, and the answer says why (`storeError`).
  router.post("/voices", portal().http.json({ limit: "2mb" }), async (req, res) => {
    let voice;
    try {
      voice = addVoice(req.body);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
    const s = settings();
    if (voice.kind !== "clone" || serverOf(s) !== "chatterbox-tts-server") return res.json(voice);
    try {
      res.json(await storeOnServer(voice, s.ttsUrl, AbortSignal.timeout(STORE_MS)));
    } catch (e) {
      res.json({ ...voice, storeError: (e as Error).message });
    }
  });
  router.post("/voices/:id/store", async (req, res) => {
    const voice = findVoice(String(req.params.id));
    if (!voice) return res.status(404).json({ error: "Voice not found" });
    const s = settings();
    if (serverOf(s) !== "chatterbox-tts-server") return res.status(400).json({ error: "The speech server keeps no voices of its own: each phrase carries what it needs" });
    if (voice.kind !== "clone") return res.status(400).json({ error: "Only a clone has a recording to store on the speech server" });
    try {
      uploadUrl(s.ttsUrl);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
    try {
      res.json(await storeOnServer(voice, s.ttsUrl, AbortSignal.timeout(STORE_MS)));
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
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
  router.put("/chosen", json, (req, res) => {
    const chosen = req.body?.chosen;
    if (typeof chosen !== "boolean") return res.status(400).json({ error: "chosen must be true or false" });
    // Voice mode would have nothing to listen through.
    if (chosen && !settings().sttUrl) return res.status(400).json({ error: "Set a speech recognition address first" });
    portal().voice.choose(chosen);
    res.json({ chosen });
  });
}
