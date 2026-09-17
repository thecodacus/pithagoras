import { addVoice, listVoices, readVoice, deleteVoice } from '../voice-presets.js';
import { VoiceLeases } from '../extensions/voice-leases.js';
import * as voiceService from '../extensions/voice-service.js';
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { VoiceClips } from "../voice-clips.js";
import { phraseLanguage } from "../voice-phrases.js";
import path from "node:path";
import express, { type Router } from "express";
import { getDb, getStoredSettings } from "../db.js";

const DEFAULT_VAD = { positiveSpeechThreshold: 0.65, negativeSpeechThreshold: 0.35, minSpeechMs: 256, preSpeechPadMs: 320, redemptionMs: 1000 };
export interface VoiceConfig {
  vad?: typeof DEFAULT_VAD;
  enabled: boolean;
  lazyLoad?: boolean;
  whisperUrl: string;
  breezeUrl: string;
  instruction: string;
  voice: string;
  language: string;
  cfgScale: number;
  runtime?: "breeze" | "audio-cpp";
}
function config(): VoiceConfig {
  const stored = getStoredSettings() as Record<string, string>;
  return stored.voice ? { voice: "design", language: "auto", cfgScale: 4, ...JSON.parse(stored.voice) } : {
    voice: "design", language: "auto", cfgScale: 4,
    enabled: false, whisperUrl: "http://127.0.0.1:8178/inference",
    breezeUrl: "http://127.0.0.1:7860/v1/audio/speech",
    instruction: "A warm, clear English voice with a calm, conversational delivery.",
  };
}
export function validateConfig(value: any): VoiceConfig {
  if (typeof value?.enabled !== "boolean") throw new Error("enabled must be a boolean");
  for (const key of ["whisperUrl", "breezeUrl"]) {
    if (typeof value[key] !== "string") throw new Error(`${key} is required`);
    const url = new URL(value[key]);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
      throw new Error(`${key} must be an HTTP URL without credentials or a fragment`);
  }
  if (typeof value.instruction !== "string" || !value.instruction.trim() || value.instruction.length > 1000)
    throw new Error("Provide a voice description of 1–1000 characters");
  const voice = value.voice ?? "design";
  if (typeof voice !== "string") throw new Error("Choose a speaking voice");
  if (!["design", "aria"].includes(voice)) readVoice(voice);
  const language = value.language ?? "auto";
  if (!["auto", "en", "hi", "bn", "ta", "te", "mr", "gu", "kn", "ml", "ur", "zh", "ja", "ko", "es", "fr", "de", "it", "pt", "ar", "ru"].includes(language))
    throw new Error("Choose a supported input language");
  const cfgScale = value.cfgScale ?? 4;
  if (![1, 4].includes(cfgScale)) throw new Error("Choose fast or expressive speech generation");
  const runtime = value.runtime ?? "breeze";
  if (!["breeze", "audio-cpp"].includes(runtime)) throw new Error("Choose a supported speech runtime");
  const vad = { ...DEFAULT_VAD, ...value.vad };
  for (const [key, min, max] of [['positiveSpeechThreshold', 0.01, 1], ['negativeSpeechThreshold', 0, 0.99], ['minSpeechMs', 64, 2000], ['preSpeechPadMs', 0, 1000], ['redemptionMs', 200, 3000]] as const) {
    if (typeof vad[key] !== 'number' || !Number.isFinite(vad[key]) || vad[key] < min || vad[key] > max) throw new Error(`Invalid VAD ${key}: expected ${min}–${max}`);
  }
  if (vad.negativeSpeechThreshold >= vad.positiveSpeechThreshold) throw new Error('Speech-end threshold must be lower than speech-start threshold');
  return { vad, lazyLoad: value.lazyLoad !== false, runtime, voice, language, cfgScale, enabled: value.enabled, whisperUrl: value.whisperUrl.trim(), breezeUrl: value.breezeUrl.trim(), instruction: value.instruction.trim() };
}
export function pcmWav(pcm: Buffer): Buffer {
  if (!pcm.length || pcm.length % 2) throw new Error("Breeze returned invalid PCM audio");
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
const managedVoice = () => config().runtime === 'audio-cpp' && config().breezeUrl === voiceService.breezeUrl;
const leases = new VoiceLeases(()=>voiceService.modelAction('load'),()=>voiceService.modelAction('unload'));
async function maintainManagedVoice() {
  // Also reconciles running legacy containers after portal updates, without
  // requiring the settings modal to be opened. Stopped add-ons stay stopped.
  const state = await voiceService.status();
  if ((getStoredSettings() as Record<string,string>).voice_setup_pending === '1' && state.state === 'running') {
    connectManagedVoice();
    getDb().prepare("DELETE FROM settings WHERE key='voice_setup_pending'").run();
  }
  if (managedVoice()) await leases.sweep(config().lazyLoad !== false);
}
const maintain = () => { void maintainManagedVoice().catch(e => console.error('[voice] maintenance:', (e as Error).message)); };
const leaseTimer = setInterval(maintain, 30000);
leaseTimer.unref();
// Wait until module initialization finishes before accessing configuration.
setImmediate(maintain);

/** Everything that changes how speech sounds, so rendered clips follow the voice. */
function voiceVersion() {
  const { vad, enabled, lazyLoad, whisperUrl, ...speech } = config() as VoiceConfig & Record<string, unknown>;
  delete speech.sttModel;
  const hash = createHash("sha256").update(JSON.stringify(speech));
  try {
    if (speech.voice === "aria") {
      const directory = path.join(process.env.DATA_DIR || "./data", "voices");
      hash.update(readFileSync(path.join(directory, "aria.wav"))).update(readFileSync(path.join(directory, "aria.txt")));
    } else if (speech.voice !== "design") {
      const preset = readVoice(speech.voice);
      hash.update(preset.instruction).update(preset.transcript);
      if (preset.audio) hash.update(preset.audio);
    }
  } catch { /* A missing voice fails at render time; the version only has to differ. */ }
  return hash.digest("hex").slice(0, 32);
}
const clips = new VoiceClips({
  root: path.join(process.env.DATA_DIR || "./data", "voice-clips"),
  version: voiceVersion,
  enabled: () => config().enabled && process.env.VOICE_STATUS_SPEECH !== "false" && process.env.VOICE_PIPELINE_MODE !== "sequential",
  render: (text, signal) => speechPcm(text, AbortSignal.any([signal, AbortSignal.timeout(120000)])),
  hold: async () => {
    if (!managedVoice()) return async () => {};
    // A lease like a voice tab's, renewed so a long batch outlives its expiry.
    const key = "voice-clips";
    await leases.acquire(key);
    const renew = setInterval(() => { void leases.acquire(key).catch(() => {}); }, 25000);
    return async () => { clearInterval(renew); await leases.release(key, config().lazyLoad !== false); };
  },
  log: message => console.log(`[voice] ${message}`),
});
/** Render clips as soon as voice is set up, for the saved language and those clients asked for. */
async function warmClips() {
  const language = config().language;
  const languages = new Set([...(language && language !== "auto" ? [language] : []), ...await clips.known()]);
  await clips.warm(...languages);
}
const warm = () => { void warmClips().catch(e => console.error("[voice] filler clips:", (e as Error).message)); };
setImmediate(warm);

function connectManagedVoice() {
  const saved = { ...config(), enabled: true, runtime: 'audio-cpp', whisperUrl: voiceService.whisperUrl, breezeUrl: voiceService.breezeUrl };
  getDb().prepare("INSERT INTO settings (key, value) VALUES ('voice', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(saved));
  warm();
  return {...saved, managed:true};
}
/**
 * One speech request to the configured runtime, retried while it is busy. The
 * response is validated as 24 kHz PCM but not yet read.
 */
async function upstreamSpeech(text: string, signal: AbortSignal) {
  let busyMs = 0;
  const settings = config();
  const form = new FormData();
  form.set("text", text); form.set("instruction", settings.instruction); form.set("cfg_scale", String(settings.cfgScale));
  const native: Record<string, unknown> = { model: "breeze", input: text, stream: true, stream_format: "audio", response_format: "pcm", options: { instruction: settings.instruction, guidance_scale: String(settings.cfgScale), seed: "42", stream_frames_per_event: "8", stream_lookahead_margin: "4" } };
  if (!['design','aria'].includes(settings.voice)) {
    const preset=readVoice(settings.voice);
    form.set('instruction',preset.instruction);
    (native.options as Record<string,string>).instruction=preset.instruction;
    if(preset.audio){
      form.set('ref_audio',new Blob([new Uint8Array(preset.audio)],{type:'audio/wav'}),'reference.wav');form.set('ref_text',preset.transcript);
      native.voice_ref={type:'base64',data:preset.audio.toString('base64')};native.reference_text=preset.transcript;
    }
  }
  if (settings.voice === "aria") {
    const directory = path.join(process.env.DATA_DIR || "./data", "voices");
    const [audio, transcript] = await Promise.all([
      readFile(path.join(directory, "aria.wav")),
      readFile(path.join(directory, "aria.txt"), "utf8"),
    ]).catch(() => { throw new Error("Install the Aria reference audio and transcript in the portal voices directory"); });
    if (!audio.length || !transcript.trim()) throw new Error("Aria reference audio and transcript must not be empty");
    form.set("ref_audio", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "aria.wav");
    form.set("ref_text", transcript.trim());
    native.voice_ref = { type: "base64", data: audio.toString("base64") };
    native.reference_text = transcript.trim();
  }
  let upstream: Response;
  // Cancellation may leave Breeze finishing its current GPU operation.
  // Keep one browser request pending instead of exposing normal contention.
  do {
    const attemptStarted=performance.now();
    upstream = await fetch(settings.breezeUrl, { method: "POST", body: settings.runtime === "audio-cpp" ? JSON.stringify(native) : form, headers: settings.runtime === "audio-cpp" ? { "Content-Type": "application/json" } : undefined, redirect: "error", signal });
    if (upstream.status !== 409) break;
    await upstream.body?.cancel();
    await delay(750, undefined, { signal });
    busyMs+=performance.now()-attemptStarted;
  } while (true);
  if (!upstream.ok) throw new Error(`Breeze returned HTTP ${upstream.status}`);
  if (!upstream.headers.get("content-type")?.startsWith("audio/pcm") && !(settings.runtime === "audio-cpp" && upstream.headers.get("content-type")?.startsWith("application/octet-stream"))) throw new Error("Expected PCM audio from the Breeze API");
  const rate = upstream.headers.get("x-sample-rate");
  if (rate && rate !== "24000") throw new Error(`Unsupported Breeze sample rate: ${rate}`);
  return { upstream, settings, busyMs };
}
/** A whole phrase as 24 kHz s16le PCM, for clips rendered ahead of time. */
async function speechPcm(text: string, signal: AbortSignal) {
  const pcm = Buffer.from(await (await upstreamSpeech(text, signal)).upstream.arrayBuffer());
  if (!pcm.length || pcm.length % 2) throw new Error("Breeze returned invalid PCM audio");
  return pcm;
}
export function voiceRouter(): Router {
  const router = express.Router();
  router.get('/voice/presets',(_req,res)=>res.json(listVoices()));
  router.post('/voice/presets',(req,res)=>{try{res.json(addVoice(req.body));}catch(e){res.status(400).json({error:(e as Error).message});}});
  router.get('/voice/presets/:id/audio',(req,res)=>{try{const row=readVoice(String(req.params.id));if(!row.audio)return res.sendStatus(404);res.set({'Content-Type':'audio/wav','Cache-Control':'no-store'}).send(row.audio);}catch{res.sendStatus(404);}});
  router.delete('/voice/presets/:id',(req,res)=>{try{deleteVoice(String(req.params.id));res.json({ok:true});}catch(e){res.status(404).json({error:(e as Error).message});}});
  router.get('/voice/install', async (_req, res) => {
    try {
      const state = await voiceService.status();
      if (state.state === 'running' && (getStoredSettings() as Record<string,string>).voice_setup_pending === '1') {
        connectManagedVoice();
        getDb().prepare("DELETE FROM settings WHERE key = 'voice_setup_pending'").run();
      }
      res.json(state);
    } catch (e) { res.status(503).json({ error: (e as Error).message }); }
  });
  for (const action of ['install', 'start', 'stop'] as const) router.post(`/voice/${action}`, async (_req, res) => {
    try {
      await voiceService[action]();
      if (action !== 'stop') getDb().prepare("INSERT INTO settings (key,value) VALUES ('voice_setup_pending','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
      else getDb().prepare("DELETE FROM settings WHERE key = 'voice_setup_pending'").run();
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  router.post('/voice/connect', async (_req, res) => {
    try {
      if ((await voiceService.status()).state !== 'running') throw new Error('Wait for voice setup to finish before connecting');
      res.json(connectManagedVoice());
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  router.get("/voice", (_req, res) => res.json({...config(),managed:managedVoice(),comparison:process.env.VOICE_COMPARISON === "true",statusSpeech:process.env.VOICE_STATUS_SPEECH !== "false",ttsPrefetch:process.env.VOICE_TTS_PREFETCH === "true",sentenceChunks:process.env.VOICE_SENTENCE_CHUNKS === "true",pipelineMode:process.env.VOICE_PIPELINE_MODE === "sequential" ? "sequential" : "parallel"}));
  router.put("/voice", (req, res) => {
    try {
      const saved = validateConfig(req.body);
      getDb().prepare("INSERT INTO settings (key, value) VALUES ('voice', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(saved));
      warm();
      res.json(saved);
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  router.get("/voice/clips", async (req, res) => {
    if (!config().enabled) return res.status(409).json({ error: "Enable Voice in Settings → Add-ons first" });
    const requested = String(req.query.languages ?? "").split(",").filter(tag => /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(tag)).slice(0, 8);
    const language = phraseLanguage(config().language, requested);
    try {
      const list = await clips.list(language);
      if (list.clips.some(clip => !clip.ready)) { await clips.remember(language); void clips.warm(language).catch(() => {}); }
      res.json(list);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });
  router.get("/voice/clips/:version/:hash", async (req, res) => {
    const pcm = await clips.read(req.params.version, req.params.hash);
    if (!pcm) return res.sendStatus(404);
    // The URL names the voice and text, so the content can never change.
    res.set({ "Content-Type": "audio/pcm", "X-Sample-Rate": "24000", "X-Sample-Format": "s16le", "Cache-Control": "private, max-age=31536000, immutable" }).send(pcm);
  });
  router.use("/sessions/:id/voice", (req, res, next) => {
    if (!config().enabled) return res.status(409).json({ error: "Enable Voice in Settings → Add-ons first" });
    if (!getDb().prepare("SELECT id FROM sessions WHERE id = ?").get(req.params.id))
      return res.status(404).json({ error: "Session not found" });
    next();
  });
  router.post('/sessions/:id/voice/connection', async (req,res)=>{
    const {client,active}=req.body??{};
    if(typeof client!=='string'||client.length>100||!client||typeof active!=='boolean')return res.status(400).json({error:'A client ID and active flag are required'});
    if(!managedVoice())return res.json({managed:false});
    try {
      const key=String(req.params.id)+':'+client;
      if(active)await leases.acquire(key);else await leases.release(key,config().lazyLoad!==false);
      res.json({managed:true});
    } catch(e){res.status(503).json({error:(e as Error).message});}
  });
  router.post("/sessions/:id/voice/transcribe", express.raw({ type: "audio/wav", limit: "12mb" }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length < 44 || req.body.toString("ascii", 0, 4) !== "RIFF")
      return res.status(400).json({ error: "A WAV recording is required" });
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(req.body)], { type: "audio/wav" }), "recording.wav");
    form.set("response_format", "json");
    form.set("language", config().language);
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    const live = clips.liveRequest();
    try {
      const sttStarted=performance.now();
      const upstream = await fetch(config().whisperUrl, { method: "POST", body: form, redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]) });
      if (!upstream.ok) throw new Error(`Whisper returned HTTP ${upstream.status}`);
      const result = await upstream.json() as { text?: unknown };
      if (typeof result.text !== "string") throw new Error("Whisper returned no transcript");
      res.set("Server-Timing", `whisper_upstream;dur=${(performance.now()-sttStarted).toFixed(1)}`);
      res.json({ text: result.text.trim() });
    } catch (e) { if (!res.destroyed) res.status(502).json({ error: (e as Error).message }); }
    finally { live(); }
  });
  router.post("/sessions/:id/voice/speech", async (req, res) => {
    const speechStarted=performance.now();
    const text = req.body?.text;
    if (typeof text !== "string" || !text.trim() || text.length > 600)
      return res.status(400).json({ error: "Speech text must contain 1–600 characters" });
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    const live = clips.liveRequest();
    try {
      const { upstream, settings, busyMs } = await upstreamSpeech(text, AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]));
      if (req.get("accept") === "audio/pcm") {
        if (!upstream.body) throw new Error("Breeze returned no audio stream");
        res.set({ "Content-Type": "audio/pcm", "X-Sample-Rate": "24000", "X-Sample-Format": "s16le", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
        if (settings.runtime === "audio-cpp") res.set("X-Voice-Streaming", "true");
        res.set("Server-Timing", `tts_headers;dur=${(performance.now()-speechStarted).toFixed(1)}, tts_busy;dur=${busyMs.toFixed(1)}`);
        res.flushHeaders();
        const reader = upstream.body.getReader();
        let bytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.length;
            if (!res.write(value)) await once(res, "drain", { signal: controller.signal });
          }
          if (!bytes || bytes % 2) throw new Error("Breeze returned invalid PCM audio");
          res.end();
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        return;
      }
      const wav = pcmWav(Buffer.from(await upstream.arrayBuffer()));
      res.set({ "Content-Type": "audio/wav", "Cache-Control": "no-store" }).send(wav);
    } catch (e) {
      if (!res.destroyed) {
        if (res.headersSent) res.destroy(e as Error);
        else res.status(502).json({ error: (e as Error).message });
      }
    } finally { live(); }
  });
  return router;
}
