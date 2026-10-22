import type { Router } from "express";
import { portal } from "./host";
import { checkSettings, checkUrl, saveSettings, settings, type ServerVoice } from "./store";

/** The voices in a server's answer to …/audio/voices: names alone, or `{ id, name? }`; nothing where it is neither. */
function listed(answer: unknown): ServerVoice[] | undefined {
  const voices = (answer as { voices?: unknown } | undefined)?.voices;
  if (!Array.isArray(voices)) return undefined;
  const read = voices.map((v) => (typeof v === "string" ? { id: v, name: v } : typeof v?.id === "string" && (v.name === undefined || typeof v.name === "string") ? { id: v.id, name: v.name ?? v.id } : undefined));
  return read.every((v) => v !== undefined) ? read : undefined;
}

/**
 * Voice servers' page in Settings, at /api/x/pithagoras-voice-servers/…, behind the portal's login.
 *
 *   GET  /settings       the addresses, models, language and voices, and whether voice mode listens and speaks through
 *                        these servers now (`chosen`)
 *   PUT  /settings       the same, all of them: what is empty is left out
 *   POST /server-voices  {ttsUrl}: the voices the speech server lists beside that address, which need not be saved yet
 *   PUT  /chosen         {chosen}: voice mode listens and speaks through these servers from now on, or no longer
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
      const answer = await fetch(at, { redirect: "error" });
      if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
      const voices = listed(await answer.json().catch(() => undefined));
      if (!voices) return res.status(400).json({ error: "The server's list of voices is not one this page reads" });
      res.json({ voices });
    } catch (e) {
      res.status(502).json({ error: `Could not read ${at}: ${(e as Error).message}` });
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
