import { VoiceLeases } from '../voice-leases.js';
import { DEFAULT_SKIP_THINKING_PROVIDERS, DEFAULT_VOICE_INSTRUCTIONS, voiceInstructions, voiceRulesOn } from '../pi/voice-first.js';
import { once } from "node:events";
import express, { type Router } from "express";
import { getSession, getSetting, putSetting, setVoiceSpeaks } from "../db.js";
import { agentFor } from "../project-agent.js";
import { setVoiceChooser, voiceProviders, within } from "../extension-host.js";
import type { ProvidedVoice, VoiceProvider } from "@pithagoras/extension-api/server";

const DEFAULT_VAD = { positiveSpeechThreshold: 0.65, negativeSpeechThreshold: 0.35, minSpeechMs: 256, preSpeechPadMs: 320, redemptionMs: 1000 };
export interface VoiceConfig {
  /** The extension voice mode listens and speaks through, by its package's name (`voice.choose`); "": none, and voice mode is off. */
  provider: string;
  vad?: typeof DEFAULT_VAD;
  /** How the agent is told to speak in voice mode; "" is the built-in text. */
  responseInstructions?: string;
  /** The providers whose first call of a spoken turn goes without thinking; absent is DEFAULT_SKIP_THINKING_PROVIDERS. */
  skipThinkingProviders?: string[];
  /** The model spoken turns run on, "provider/model"; "" or absent is the chat's own. */
  voiceModel?: string;
  /**
   * Whether voice mode, the spoken conversation, is offered; false leaves dictation, which only listens. Absent is true,
   * as it was before there was a switch.
   */
  conversation?: boolean;
}
/** Long enough for the built-in text several times over; every voice turn carries it. */
export const MAX_RESPONSE_INSTRUCTIONS = 8000;
function config(): VoiceConfig {
  const stored = getSetting("voice");
  return stored ? { provider: "", ...JSON.parse(stored) } : { provider: "" };
}
/** Whether voice conversations are on: see VoiceConfig's `conversation`. */
function conversing(): boolean {
  return config().conversation !== false;
}
/** What voice mode's own routes answer while voice conversations are off. Dictation asks none of them. */
const CONVERSATION_OFF = "Voice conversations are switched off in Settings → Defaults → Voice mode: dictation still works";
/** What the page saves of voice mode: whether a spoken conversation is offered and how it goes, whatever listens and speaks for it. */
export function validateConfig(value: any) {
  const responseInstructions = value?.responseInstructions ?? "";
  if (typeof responseInstructions !== "string" || responseInstructions.length > MAX_RESPONSE_INSTRUCTIONS)
    throw new Error(`Speaking instructions may be at most ${MAX_RESPONSE_INSTRUCTIONS} characters`);
  const skipThinkingProviders = skipThinking(value?.skipThinkingProviders);
  const voiceModel = typeof value?.voiceModel === "string" ? value.voiceModel.trim() : value?.voiceModel ?? "";
  if (typeof voiceModel !== "string" || voiceModel.length > 300 || (voiceModel && !/^[^/\s]+\/\S+$/.test(voiceModel)))
    throw new Error("Name the voice model as provider/model, or leave it empty to use the chat's own");
  const vad = { ...DEFAULT_VAD, ...value?.vad };
  for (const [key, min, max] of [['positiveSpeechThreshold', 0.01, 1], ['negativeSpeechThreshold', 0, 0.99], ['minSpeechMs', 64, 2000], ['preSpeechPadMs', 0, 1000], ['redemptionMs', 200, 3000]] as const) {
    if (typeof vad[key] !== 'number' || !Number.isFinite(vad[key]) || vad[key] < min || vad[key] > max) throw new Error(`Invalid VAD ${key}: expected ${min}–${max}`);
  }
  if (vad.negativeSpeechThreshold >= vad.positiveSpeechThreshold) throw new Error('Speech-end threshold must be lower than speech-start threshold');
  const conversation = value?.conversation ?? true;
  if (typeof conversation !== "boolean") throw new Error("Voice conversations are switched on with true and off with false");
  return { vad, responseInstructions: savedInstructions(responseInstructions), skipThinkingProviders, voiceModel, conversation };
}
/**
 * The providers as saved: names as the model menu shows them, each once. The
 * default list is not saved, so it follows the portal's updates; an empty list
 * is, and switches the first call's thinking back on everywhere.
 */
function skipThinking(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50 || value.some((name) => typeof name !== "string"))
    throw new Error("Name at most 50 providers");
  const names = [...new Set((value as string[]).map((name) => name.trim()).filter(Boolean))];
  const bad = names.find((name) => name.length > 100 || !/^[\w.:@-]+$/.test(name));
  if (bad) throw new Error(`"${bad}" is not a provider name: use letters, digits, dot, colon, @, dash or underscore`);
  const same = names.length === DEFAULT_SKIP_THINKING_PROVIDERS.length && names.every((name) => DEFAULT_SKIP_THINKING_PROVIDERS.includes(name));
  return same ? undefined : names;
}
/** Text equal to the built-in instructions is not saved, so they follow the portal's updates. */
function savedInstructions(text: string): string {
  const trimmed = text.trim();
  return trimmed === DEFAULT_VOICE_INSTRUCTIONS ? "" : trimmed;
}
/**
 * The settings as the page gets them: the speaking instructions in use, whether
 * saved or built in, and the built-in ones to go back to. `off` says the portal
 * sends none at all (VOICE_RESPONSE_INSTRUCTIONS=false), saved or not.
 */
function withInstructions<T extends { responseInstructions?: string; skipThinkingProviders?: string[] }>(value: T) {
  return { ...value, responseInstructions: voiceInstructions(value.responseInstructions), defaultResponseInstructions: DEFAULT_VOICE_INSTRUCTIONS, responseInstructionsOff: !voiceRulesOn(),
    skipThinkingProviders: value.skipThinkingProviders ?? [...DEFAULT_SKIP_THINKING_PROVIDERS], defaultSkipThinkingProviders: [...DEFAULT_SKIP_THINKING_PROVIDERS] };
}
/** The samples of a RIFF/WAVE buffer, checked to be what the player expects. `label` is what answered with it. */
export function wavPcm(wav: Buffer, label: string): Buffer {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE")
    throw new Error(`${label} returned invalid WAV audio`);
  let format = false;
  for (let at = 12; at + 8 <= wav.length;) {
    const id = wav.toString("ascii", at, at + 4), size = wav.readUInt32LE(at + 4);
    if (id === "fmt ") {
      if (size < 16 || at + 24 > wav.length || wav.readUInt16LE(at + 8) !== 1 || wav.readUInt16LE(at + 10) !== 1 || wav.readUInt32LE(at + 12) !== 24000 || wav.readUInt16LE(at + 22) !== 16)
        throw new Error(`Expected mono 24 kHz 16-bit audio from ${label}`);
      format = true;
    }
    if (id === "data") {
      // Samples are only meaningful once the fmt chunk has described them.
      if (!format) throw new Error(`Expected mono 24 kHz 16-bit audio from ${label}`);
      // A writer that does not know the length up front leaves a placeholder
      // size behind. The response is fully buffered, so its end is the truth.
      const end = size && at + 8 + size <= wav.length ? at + 8 + size : wav.length;
      const pcm = wav.subarray(at + 8, end);
      if (!pcm.length || pcm.length % 2) throw new Error(`${label} returned invalid PCM audio`);
      return pcm;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${label} returned no audio data`);
}
/** Voice mode listens and speaks through an extension that is not running, or offers nothing now: said, rather than anything else used. */
class SourceAbsent extends Error {
  constructor(name: string) {
    super(`Voice mode listens and speaks through ${name}, which is not running: install or start it in Settings → Extensions, or stop using it in Settings → Defaults → Voice mode`);
  }
}
/** What a provider offers now; nothing where it cannot say, which is its own failure, as is an answer that is not one. */
function stateOf(name: string, provider: VoiceProvider): { speaks: boolean; voices: ProvidedVoice[] } | undefined {
  try {
    const state = provider.state();
    if (state === undefined) return undefined;
    const voice = (v: ProvidedVoice) => typeof v?.id === "string" && v.id !== "" && typeof v.name === "string" && (v.builtIn === undefined || typeof v.builtIn === "boolean");
    if (typeof state?.speaks !== "boolean" || !Array.isArray(state.voices) || !state.voices.every(voice))
      throw new TypeError(`state answered ${JSON.stringify(state)}: { speaks, voices: [{ id, name, builtIn? }] }, or nothing, is an answer`);
    return state;
  } catch (e) {
    console.error(`[extension ${name}] saying what it offers voice mode failed:`, e);
    return undefined;
  }
}
/** Voice mode's source now: its name, the provider and what it offers. Throws SourceAbsent where it is not running or offers nothing. */
function sourceOf() {
  const name = config().provider;
  const provider = voiceProviders().get(name);
  const state = provider && stateOf(name, provider);
  if (!provider || !state) throw new SourceAbsent(name);
  return { name, provider, state };
}
/** The source, or the 503 where it is not running: undefined then, with the answer sent. */
function usable(res: express.Response) {
  try {
    return sourceOf();
  } catch (e) {
    if (!(e instanceof SourceAbsent)) throw e;
    res.status(503).json({ error: e.message });
    return undefined;
  }
}
/** The voices voice mode's source offers now, for an agent's voice to be one of; undefined where there is none, or it is not running. */
export function sourceVoices(): ProvidedVoice[] | undefined {
  try {
    return sourceOf().state.voices;
  } catch (e) {
    if (e instanceof SourceAbsent) return undefined;
    throw e;
  }
}
/**
 * How long an extension may take over hearing that voice mode is used or not: as long as a speech model in a container
 * may take to load. The leases wait for it, every voice session's.
 */
export const providerUse = { limitMs: 120_000 };
/** How long a provider may take over one recording heard or one phrase spoken. */
export const providerCall = { limitMs: 120_000 };
const tell = (provider: VoiceProvider, inUse: boolean) =>
  within(providerUse.limitMs, Promise.resolve().then(() => provider.use?.(inUse)), inUse ? "getting ready for voice mode" : "hearing that voice mode is no longer used");
/** The provider voice mode last told it is in use, by its package's name, until it is told it is not. */
let told: { name: string; provider: VoiceProvider } | undefined;
/**
 * Voice mode is no longer used through the extension of that name: told to it as it runs now, which may have been started
 * anew since it was told it was, while what it got ready (a model loaded in a container of its own) is still there.
 */
async function letGo(name: string) {
  const provider = voiceProviders().get(name);
  if (!provider) return;
  try {
    await tell(provider, false);
  } catch (e) {
    console.error(`[extension ${name}] hearing voice mode is no longer used failed:`, e);
  }
}
/**
 * What a session's lease loads: the source is told voice mode is in use, once, and again where the source changed or was
 * started anew; the one it changed from is told it is not.
 */
async function load() {
  const name = config().provider;
  const before = told;
  const provider = voiceProviders().get(name);
  if (!provider || !stateOf(name, provider)) throw new SourceAbsent(name);
  if (before?.provider === provider) return;
  await tell(provider, true);
  told = { name, provider };
  if (before && before.name !== name) await letGo(before.name);
}
/** What the end of the last lease unloads: the provider that was told voice mode is in use is told it is not. */
async function unload() {
  const was = told;
  told = undefined;
  if (was) await letGo(was.name);
}
const leases = new VoiceLeases(load, unload);
// The leases of sessions that were left run out, whatever voice mode listens and speaks through.
const leaseTimer = setInterval(() => void leases.sweep().catch(e => console.error('[voice] leases:', (e as Error).message)), 30000);
leaseTimer.unref();
function saveVoice(value: VoiceConfig) {
  putSetting("voice", JSON.stringify(value));
}
/** An extension makes itself voice mode's source (`voice.choose(true)`), or stops being it where it is now (false). Nothing else of the settings changes. */
function chooseProvider(name: string, chosen: boolean) {
  const current = config();
  if (chosen) saveVoice({ ...current, provider: name });
  else if (current.provider === name) saveVoice({ ...current, provider: "" });
}
setVoiceChooser({ choose: chooseProvider, chosen: () => config().provider });
// Whether voice mode can speak now, for the rule that is then in every conversation: voice conversations are on, it has a
// source, and that speaks now.
setVoiceSpeaks(() => {
  try {
    return conversing() && sourceOf().state.speaks;
  } catch {
    // No source, one that is not running, or settings that cannot be read: nothing speaks.
    return false;
  }
});
/**
 * The settings as the page gets them, from every route that answers with them: what is saved, with voice mode's source as
 * it is now, and what the portal is set to.
 */
function shown() {
  const { provider, vad, responseInstructions, skipThinkingProviders, voiceModel, conversation } = config();
  const source = voiceProviders().get(provider);
  const state = source && stateOf(provider, source);
  return {
    ...withInstructions({ vad, responseInstructions, skipThinkingProviders, voiceModel }),
    provider,
    // Its label while its server half runs.
    ...(source ? { label: source.label } : {}),
    ready: !!state,
    // A source chosen that is not running is not known not to speak: voice mode then says why it cannot start.
    speech: state ? state.speaks : true,
    voices: state ? state.voices : [],
    enabled: provider !== "",
    // Off: the page offers dictation, and not voice mode.
    conversation: conversation !== false,
    comparison: process.env.VOICE_COMPARISON === "true",
    statusSpeech: process.env.VOICE_STATUS_SPEECH !== "false",
    ttsPrefetch: process.env.VOICE_TTS_PREFETCH === "true",
    sentenceChunks: process.env.VOICE_SENTENCE_CHUNKS === "true",
    pipelineMode: process.env.VOICE_PIPELINE_MODE === "sequential" ? "sequential" : "parallel",
  };
}
export function voiceRouter(): Router {
  const router = express.Router();
  router.get("/voice", (_req, res) => res.json(shown()));
  // The source is chosen on a provider's own page, and is kept as it is here: as are any settings a save does not name.
  router.put("/voice", (req, res) => {
    try {
      saveVoice({ ...config(), ...validateConfig(req.body) });
      res.json(shown());
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  // Stop using: voice mode has no source until one is chosen on its own page again.
  router.delete("/voice/provider", (_req, res) => {
    saveVoice({ ...config(), provider: "" });
    res.json(shown());
  });
  router.use("/sessions/:id/voice", (req, res, next) => {
    if (!config().provider) return res.status(409).json({ error: "Voice mode has no source: choose one on the page of an extension that provides it, in Settings → Extensions" });
    if (!getSession(req.params.id)) return res.status(404).json({ error: "Session not found" });
    next();
  });
  // Every voice session holds a lease while it is on: see load and unload.
  router.post('/sessions/:id/voice/connection', async (req,res)=>{
    const {client,active}=req.body??{};
    if(typeof client!=='string'||client.length>100||!client||typeof active!=='boolean')return res.status(400).json({error:'A client ID and active flag are required'});
    // A lease is how voice mode starts and stays on, so none is given while voice conversations are off. One given back
    // still is, so that the source hears at once that voice mode is no longer used.
    if(active&&!conversing())return res.status(409).json({error:CONVERSATION_OFF});
    try {
      const key=String(req.params.id)+':'+client;
      if(active)await leases.acquire(key);else await leases.release(key);
      res.json({ok:true});
    } catch(e){res.status(503).json({error:(e as Error).message});}
  });
  router.post("/sessions/:id/voice/transcribe", express.raw({ type: "audio/wav", limit: "12mb" }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length < 44 || req.body.toString("ascii", 0, 4) !== "RIFF")
      return res.status(400).json({ error: "A WAV recording is required" });
    const source = usable(res);
    if (!source) return;
    const purpose = req.query.purpose === "dictation" ? "dictation" : "voice";
    const closed = new AbortController();
    res.on("close", () => closed.abort());
    try {
      const started = performance.now();
      const signal = AbortSignal.any([closed.signal, AbortSignal.timeout(providerCall.limitMs)]);
      // Not waited on for longer than the signal gives it, should it not listen to the signal.
      const text = await within(providerCall.limitMs, source.provider.transcribe(req.body, { purpose, signal }), "recognising speech");
      if (typeof text !== "string") throw new Error(`${source.provider.label} gave no transcript`);
      res.set("Server-Timing", `stt;dur=${(performance.now() - started).toFixed(1)}`);
      res.json({ text: text.trim() });
    } catch (e) { if (!res.destroyed) res.status(502).json({ error: (e as Error).message }); }
  });
  router.post("/sessions/:id/voice/speech", async (req, res) => {
    const started = performance.now();
    // Replies are spoken in voice mode alone.
    if (!conversing()) return res.status(409).json({ error: CONVERSATION_OFF });
    const source = usable(res);
    if (!source) return;
    if (!source.state.speaks) return res.status(409).json({ error: "Voice mode's source recognises speech alone: replies are not spoken" });
    const text = req.body?.text;
    if (typeof text !== "string" || !text.trim() || text.length > 600)
      return res.status(400).json({ error: "Speech text must contain 1–600 characters" });
    const { label } = source.provider;
    // The voice of the agent the chat is with (the agent a project is linked to for a chat in it, else the first agent's), or the source's own choice.
    const voice = agentFor(getSession(req.params.id)?.workspace).voice || undefined;
    const closed = new AbortController();
    res.on("close", () => closed.abort());
    let answer: Response | undefined;
    try {
      const signal = AbortSignal.any([closed.signal, AbortSignal.timeout(providerCall.limitMs)]);
      const given = await within(providerCall.limitMs, source.provider.speak(text, { voice, signal }), "speaking");
      if (!(given instanceof Response)) throw new Error(`${label} gave no audio`);
      answer = given;
      if (!answer.ok) throw new Error(`${label} answered HTTP ${answer.status}`);
      const type = answer.headers.get("content-type") ?? "";
      const headers = { "Content-Type": "audio/pcm", "X-Sample-Rate": "24000", "X-Sample-Format": "s16le", "Cache-Control": "no-store", "X-Accel-Buffering": "no" };
      // A WAV is read whole and checked, and its samples sent on.
      if (/^audio\/(wav|x-wav|wave|vnd\.wave)\b/.test(type)) {
        const pcm = wavPcm(Buffer.from(await answer.arrayBuffer()), label);
        return res.set({ ...headers, "Server-Timing": `tts_headers;dur=${(performance.now() - started).toFixed(1)}` }).send(pcm);
      }
      if (!/^audio\/pcm\b/.test(type)) throw new Error(`${label} answered ${type || "no type"}: voice mode plays audio/pcm or audio/wav`);
      // PCM is passed on as it comes, checked before anything of it is sent.
      const rate = answer.headers.get("x-sample-rate");
      if (rate !== null && rate !== "24000") throw new Error(`${label} answered audio at ${rate} Hz: voice mode plays 24 kHz`);
      if (!answer.body) throw new Error(`${label} gave no audio`);
      res.set({ ...headers, "Server-Timing": `tts_headers;dur=${(performance.now() - started).toFixed(1)}` });
      res.flushHeaders();
      const reader = answer.body.getReader();
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (!res.write(value)) await once(res, "drain", { signal: closed.signal });
        }
        if (!bytes || bytes % 2) throw new Error(`${label} gave invalid PCM audio`);
        res.end();
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch (e) {
      // What the provider answered is let go of: an engine behind it would otherwise go on making it until the signal ends.
      await answer?.body?.cancel().catch(() => {});
      if (!res.destroyed) {
        if (res.headersSent) res.destroy(e as Error);
        else res.status(502).json({ error: (e as Error).message });
      }
    }
  });
  return router;
}
