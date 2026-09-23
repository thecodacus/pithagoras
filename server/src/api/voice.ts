import { addVoice, listVoices, readVoice, deleteVoice } from '../voice-presets.js';
import { spokenNumbers } from '../voice-numbers.js';
import { INPUT_LANGUAGES, CHATTERBOX_LANGUAGES } from '../voice-languages.js';
import { VoiceLeases } from '../extensions/voice-leases.js';
import * as voiceService from '../extensions/voice-service.js';
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
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
  runtime?: "breeze" | "audio-cpp" | "chatterbox";
  // Sent as the OpenAI transcription "model" field. audio.cpp requires it and
  // names the loaded model; Whisper.cpp ignores unknown fields, so an empty
  // value keeps the existing Whisper contract byte for byte.
  sttModel?: string;
  // Chatterbox emotion exaggeration; its own scale, unrelated to Breeze's CFG.
  exaggeration?: number;
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
  const preset = ["design", "aria"].includes(voice) ? undefined : readVoice(voice);
  const language = value.language ?? "auto";
  if (!INPUT_LANGUAGES.some(([code]) => code === language))
    throw new Error("Choose a supported input language");
  const cfgScale = value.cfgScale ?? 4;
  if (![1, 4].includes(cfgScale)) throw new Error("Choose fast or expressive speech generation");
  const runtime = value.runtime ?? "breeze";
  if (!["breeze", "audio-cpp", "chatterbox"].includes(runtime)) throw new Error("Choose a supported speech runtime");
  const sttModel = typeof value.sttModel === "string" ? value.sttModel.trim() : value.sttModel ?? "";
  if (typeof sttModel !== "string" || sttModel.length > 100 || (sttModel && !/^[\w.:-]+$/.test(sttModel)))
    throw new Error("A speech recognition model id may only contain letters, digits, dot, colon, dash or underscore");
  const exaggeration = value.exaggeration ?? 0.5;
  if (typeof exaggeration !== "number" || !Number.isFinite(exaggeration) || exaggeration < 0 || exaggeration > 2)
    throw new Error("Expressiveness must be between 0 and 2");
  if (runtime === "chatterbox") {
    // Chatterbox is told a language or it refuses; it has no detection mode,
    // and the language also decides how numbers are written out for synthesis.
    if (language === "auto") throw new Error("Chatterbox needs an input language: auto-detect selects no voice");
    if (!CHATTERBOX_LANGUAGES.includes(language)) throw new Error(`Chatterbox speaks: ${CHATTERBOX_LANGUAGES.join(", ")}`);
    // Refuse a voice it cannot speak with here, rather than on every phrase.
    if (voice === "design" || (preset && !preset.audio))
      throw new Error("Chatterbox speaks with a reference clone: choose Aria or a voice with a recording");
  }
  const vad = { ...DEFAULT_VAD, ...value.vad };
  for (const [key, min, max] of [['positiveSpeechThreshold', 0.01, 1], ['negativeSpeechThreshold', 0, 0.99], ['minSpeechMs', 64, 2000], ['preSpeechPadMs', 0, 1000], ['redemptionMs', 200, 3000]] as const) {
    if (typeof vad[key] !== 'number' || !Number.isFinite(vad[key]) || vad[key] < min || vad[key] > max) throw new Error(`Invalid VAD ${key}: expected ${min}–${max}`);
  }
  if (vad.negativeSpeechThreshold >= vad.positiveSpeechThreshold) throw new Error('Speech-end threshold must be lower than speech-start threshold');
  return { vad, lazyLoad: value.lazyLoad !== false, runtime, voice, language, cfgScale, sttModel, exaggeration, enabled: value.enabled, whisperUrl: value.whisperUrl.trim(), breezeUrl: value.breezeUrl.trim(), instruction: value.instruction.trim() };
}
/** The samples of a RIFF/WAVE buffer, checked to be what the player expects. */
export function wavPcm(wav: Buffer): Buffer {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("Chatterbox returned invalid WAV audio");
  let format = false;
  for (let at = 12; at + 8 <= wav.length;) {
    const id = wav.toString("ascii", at, at + 4), size = wav.readUInt32LE(at + 4);
    if (id === "fmt ") {
      if (size < 16 || at + 24 > wav.length || wav.readUInt16LE(at + 8) !== 1 || wav.readUInt16LE(at + 10) !== 1 || wav.readUInt32LE(at + 12) !== 24000 || wav.readUInt16LE(at + 22) !== 16)
        throw new Error("Expected mono 24 kHz 16-bit audio from Chatterbox");
      format = true;
    }
    if (id === "data") {
      // Samples are only meaningful once the fmt chunk has described them.
      if (!format) throw new Error("Expected mono 24 kHz 16-bit audio from Chatterbox");
      // A writer that does not know the length up front leaves a placeholder
      // size behind. The response is fully buffered, so its end is the truth.
      const end = size && at + 8 + size <= wav.length ? at + 8 + size : wav.length;
      const pcm = wav.subarray(at + 8, end);
      if (!pcm.length || pcm.length % 2) throw new Error("Chatterbox returned invalid PCM audio");
      return pcm;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("Chatterbox returned no audio data");
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

/** Point the saved config at the managed Breeze and Whisper pair. */
export function connectManagedVoice() {
  // Whisper.cpp serves one model and is sent no model field: an id left over
  // from another runtime would reach it in the multipart body.
  const saved = { ...config(), enabled: true, runtime: 'audio-cpp', sttModel: '', whisperUrl: voiceService.whisperUrl, breezeUrl: voiceService.breezeUrl };
  getDb().prepare("INSERT INTO settings (key, value) VALUES ('voice', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(saved));
  return {...saved, managed:true};
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
      res.json(saved);
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
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
    const settings = config();
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(req.body)], { type: "audio/wav" }), "recording.wav");
    form.set("response_format", "json");
    form.set("language", settings.language);
    // OpenAI-compatible recognition services (audio.cpp, Qwen3-ASR) name the
    // loaded model here; Whisper.cpp has one model and ignores the field.
    if (settings.sttModel) form.set("model", settings.sttModel);
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    try {
      const sttStarted=performance.now();
      const upstream = await fetch(settings.whisperUrl, { method: "POST", body: form, redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]) });
      if (!upstream.ok) throw new Error(`Whisper returned HTTP ${upstream.status}`);
      const result = await upstream.json() as { text?: unknown };
      if (typeof result.text !== "string") throw new Error("Whisper returned no transcript");
      res.set("Server-Timing", `whisper_upstream;dur=${(performance.now()-sttStarted).toFixed(1)}`);
      res.json({ text: result.text.trim() });
    } catch (e) { if (!res.destroyed) res.status(502).json({ error: (e as Error).message }); }
  });
  router.post("/sessions/:id/voice/speech", async (req, res) => {
    const speechStarted=performance.now();
    let busyMs=0;
    const text = req.body?.text;
    if (typeof text !== "string" || !text.trim() || text.length > 600)
      return res.status(400).json({ error: "Speech text must contain 1–600 characters" });
    const settings = config();
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    try {
      // Resolve the voice once: a reference clip is up to a megabyte, and only
      // the runtime that is about to be called should pay to carry it.
      let instruction = settings.instruction;
      let reference: { audio: Buffer; transcript: string; filename: string } | undefined;
      if (!['design','aria'].includes(settings.voice)) {
        const preset = readVoice(settings.voice);
        instruction = preset.instruction;
        if (preset.audio) reference = { audio: preset.audio, transcript: preset.transcript, filename: "reference.wav" };
      }
      if (settings.voice === "aria") {
        const directory = path.join(process.env.DATA_DIR || "./data", "voices");
        const [audio, transcript] = await Promise.all([
          readFile(path.join(directory, "aria.wav")),
          readFile(path.join(directory, "aria.txt"), "utf8"),
        ]).catch(() => { throw new Error("Install the Aria reference audio and transcript in the portal voices directory"); });
        if (!audio.length || !transcript.trim()) throw new Error("Aria reference audio and transcript must not be empty");
        reference = { audio, transcript: transcript.trim(), filename: "aria.wav" };
      }
      // Chatterbox clones a speaker; it has no designed or built-in voice.
      // validateConfig refuses this combination on save; a config written before
      // that check, or by the managed connect, still reaches here.
      if (settings.runtime === "chatterbox" && !reference)
        throw new Error("Chatterbox speaks with a reference clone: choose Aria or a voice with a recording");
      let form: FormData | undefined;
      let json: Record<string, unknown> | undefined;
      if (settings.runtime === "chatterbox") {
        // Chatterbox has no streaming mode in audio.cpp: one phrase, one WAV.
        // The browser buffers each phrase before playing it either way.
        json = { model: "chatterbox", input: spokenNumbers(text, settings.language), language: settings.language,
          response_format: "wav", options: { exaggeration: String(settings.exaggeration ?? 0.5), seed: "42" },
          voice_ref: { type: "base64", data: reference!.audio.toString("base64") } };
      } else if (settings.runtime === "audio-cpp") {
        json = { model: "breeze", input: text, stream: true, stream_format: "audio", response_format: "pcm", options: { instruction, guidance_scale: String(settings.cfgScale), seed: "42", stream_frames_per_event: "8", stream_lookahead_margin: "4" } };
        if (reference) { json.voice_ref = { type: "base64", data: reference.audio.toString("base64") }; json.reference_text = reference.transcript; }
      } else {
        form = new FormData();
        form.set("text", text); form.set("instruction", instruction); form.set("cfg_scale", String(settings.cfgScale));
        if (reference) {
          form.set("ref_audio", new Blob([new Uint8Array(reference.audio)], { type: "audio/wav" }), reference.filename);
          form.set("ref_text", reference.transcript);
        }
      }
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);
      let upstream: Response;
      // Cancellation may leave Breeze finishing its current GPU operation.
      // Keep one browser request pending instead of exposing normal contention.
      do {
        const attemptStarted=performance.now();
        upstream = await fetch(settings.breezeUrl, { method: "POST", body: json ? JSON.stringify(json) : form!, headers: json ? { "Content-Type": "application/json" } : undefined, redirect: "error", signal });
        if (upstream.status !== 409) break;
        await upstream.body?.cancel();
        await delay(750, undefined, { signal });
        busyMs+=performance.now()-attemptStarted;
      } while (true);
      const runtimeName = settings.runtime === "chatterbox" ? "Chatterbox" : "Breeze";
      if (!upstream.ok) throw new Error(`${runtimeName} returned HTTP ${upstream.status}`);
      if (settings.runtime === "chatterbox") {
        if (!/^audio\/(wav|x-wav|wave|vnd\.wave)\b/.test(upstream.headers.get("content-type") ?? "")) throw new Error("Expected WAV audio from the Chatterbox API");
        const wav = Buffer.from(await upstream.arrayBuffer());
        // Validate before either branch, so a malformed WAV is never passed on.
        const pcm = wavPcm(wav);
        res.set("Server-Timing", `tts_headers;dur=${(performance.now()-speechStarted).toFixed(1)}, tts_busy;dur=${busyMs.toFixed(1)}`);
        if (req.get("accept") !== "audio/pcm") return res.set({ "Content-Type": "audio/wav", "Cache-Control": "no-store" }).send(wav);
        return res.set({ "Content-Type": "audio/pcm", "X-Sample-Rate": "24000", "X-Sample-Format": "s16le", "Cache-Control": "no-store" }).send(pcm);
      }
      if (!upstream.headers.get("content-type")?.startsWith("audio/pcm") && !(settings.runtime === "audio-cpp" && upstream.headers.get("content-type")?.startsWith("application/octet-stream"))) throw new Error("Expected PCM audio from the Breeze API");
      const rate = upstream.headers.get("x-sample-rate");
      if (rate && rate !== "24000") throw new Error(`Unsupported Breeze sample rate: ${rate}`);
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
    }
  });
  return router;
}
