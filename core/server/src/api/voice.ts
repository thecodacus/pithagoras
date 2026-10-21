import { addVoice, listVoices, readVoice, updateVoice, deleteVoice, VoiceNotFound } from '../voice-presets.js';
import { spokenNumbers } from '../voice-numbers.js';
import { INPUT_LANGUAGES, CHATTERBOX_LANGUAGES } from '../voice-languages.js';
import { DEFAULT_KOKORO_VOICE, KOKORO_SPEEDS, isKokoroVoice } from '../kokoro-voices.js';
import { VoiceLeases } from '../voice-leases.js';
import { DEFAULT_SKIP_THINKING_PROVIDERS, DEFAULT_VOICE_INSTRUCTIONS, voiceInstructions, voiceRulesOn } from '../pi/voice-first.js';
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { createHash } from "node:crypto";
import express, { type Router } from "express";
import { getSession, getSetting, putSetting, setVoiceSpeaks } from "../db.js";
import { agentFor } from "../project-agent.js";
import { setVoiceChooser, voiceProviders, within } from "../extension-host.js";
import { validName } from "../extension-ui.js";
import type { VoiceProvider, VoiceWhere } from "@pithagoras/extension-api/server";
import { errorLineKey, readErrorLine, saveErrorLine, touchErrorLine } from "../voice-error-line.js";

const DEFAULT_VAD = { positiveSpeechThreshold: 0.65, negativeSpeechThreshold: 0.35, minSpeechMs: 256, preSpeechPadMs: 320, redemptionMs: 1000 };
export interface VoiceConfig {
  vad?: typeof DEFAULT_VAD;
  enabled: boolean;
  whisperUrl: string;
  breezeUrl: string;
  instruction: string;
  voice: string;
  language: string;
  cfgScale: number;
  // `none`: speech recognition only. There is nothing to speak with, so no replies are spoken.
  runtime?: "breeze" | "audio-cpp" | "chatterbox" | "kokoro" | "none";
  // Sent as the OpenAI transcription "model" field. audio.cpp requires it and
  // names the loaded model; Whisper.cpp ignores unknown fields, so an empty
  // value keeps the existing Whisper contract byte for byte.
  sttModel?: string;
  // The model the chat's dictation is transcribed with, where it is not the one voice mode uses (a bigger, slower one is fine
  // for a message typed by voice, while a conversation wants the quick one). Empty means the same as `sttModel`.
  dictationModel?: string;
  /** Where dictation sends its recordings; empty means whisperUrl. */
  dictationUrl?: string;
  // Chatterbox emotion exaggeration; its own scale, unrelated to Breeze's CFG.
  exaggeration?: number;
  // Kokoro speaks with one of its own voices, kept apart from `voice` so that
  // switching runtimes keeps the library voice the others speak with.
  kokoroVoice?: string;
  // Kokoro's speed multiplier.
  speed?: number;
  // How the agent is told to speak in voice mode. Empty means the built-in text.
  responseInstructions?: string;
  // The providers whose first call of a spoken turn goes without thinking. Absent means DEFAULT_SKIP_THINKING_PROVIDERS.
  skipThinkingProviders?: string[];
  // The model spoken turns run on, "provider/model". Empty or absent means the chat's own.
  voiceModel?: string;
  // The extension voice mode listens and speaks through, by its package's name (`voice.provide`). Empty or absent: the addresses above.
  provider?: string;
}
/** Long enough for the built-in text several times over; every voice turn carries it. */
export const MAX_RESPONSE_INSTRUCTIONS = 8000;
// The addresses of a portal with nothing set up: services of the Compose overlay.
const DEFAULT_WHISPER_URL = "http://127.0.0.1:8178/inference";
const DEFAULT_BREEZE_URL = "http://127.0.0.1:7860/v1/audio/speech";
function config(): VoiceConfig {
  const stored = getSetting("voice");
  return stored ? { voice: "design", language: "auto", cfgScale: 4, ...JSON.parse(stored) } : {
    voice: "design", language: "auto", cfgScale: 4,
    enabled: false, whisperUrl: DEFAULT_WHISPER_URL,
    breezeUrl: DEFAULT_BREEZE_URL,
    instruction: "A warm, clear English voice with a calm, conversational delivery.",
  };
}
export function validateConfig(value: any): VoiceConfig {
  if (typeof value?.enabled !== "boolean") throw new Error("enabled must be a boolean");
  const runtime = value.runtime ?? "breeze";
  if (!["breeze", "audio-cpp", "chatterbox", "kokoro", "none"].includes(runtime)) throw new Error("Choose a supported speech runtime");
  const checkUrl = (key: string, given: string) => {
    const url = new URL(given);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
      throw new Error(`${key} must be an HTTP URL without credentials or a fragment`);
  };
  for (const key of ["whisperUrl", "breezeUrl"]) {
    if (typeof value[key] !== "string") throw new Error(`${key} is required`);
    // With no speech synthesis there is no address to speak to.
    if (key === "breezeUrl" && runtime === "none" && !value[key].trim()) continue;
    checkUrl(key, value[key]);
  }
  // Dictation may recognise at an address of its own; empty means the one of voice mode.
  const dictationUrl = value.dictationUrl ?? "";
  if (typeof dictationUrl !== "string") throw new Error("dictationUrl must be a string");
  if (dictationUrl.trim()) checkUrl("dictationUrl", dictationUrl);
  if (typeof value.instruction !== "string" || !value.instruction.trim() || value.instruction.length > 1000)
    throw new Error("Provide a voice description of 1–1000 characters");
  const voice = value.voice ?? "design";
  if (typeof voice !== "string") throw new Error("Choose a speaking voice");
  const preset = voice === "design" ? undefined : readVoice(voice);
  const language = value.language ?? "auto";
  if (!INPUT_LANGUAGES.some(([code]) => code === language))
    throw new Error("Choose a supported input language");
  const cfgScale = value.cfgScale ?? 4;
  if (![1, 4].includes(cfgScale)) throw new Error("Choose fast or expressive speech generation");
  const modelId = (given: unknown) => {
    const model = typeof given === "string" ? given.trim() : given ?? "";
    if (typeof model !== "string" || model.length > 100 || (model && !/^[\w.:-]+$/.test(model)))
      throw new Error("A speech recognition model id may only contain letters, digits, dot, colon, dash or underscore");
    return model;
  };
  const sttModel = modelId(value.sttModel);
  const dictationModel = modelId(value.dictationModel);
  const exaggeration = value.exaggeration ?? 0.5;
  if (typeof exaggeration !== "number" || !Number.isFinite(exaggeration) || exaggeration < 0 || exaggeration > 2)
    throw new Error("Expressiveness must be between 0 and 2");
  const kokoroVoice = value.kokoroVoice ?? DEFAULT_KOKORO_VOICE;
  if (!isKokoroVoice(kokoroVoice)) throw new Error("Choose one of Kokoro's voices");
  const speed = value.speed ?? 1;
  if (!(KOKORO_SPEEDS as readonly number[]).includes(speed)) throw new Error("Choose a supported speaking speed");
  const responseInstructions = value.responseInstructions ?? "";
  if (typeof responseInstructions !== "string" || responseInstructions.length > MAX_RESPONSE_INSTRUCTIONS)
    throw new Error(`Speaking instructions may be at most ${MAX_RESPONSE_INSTRUCTIONS} characters`);
  const skipThinkingProviders = skipThinking(value.skipThinkingProviders);
  const voiceModel = typeof value.voiceModel === "string" ? value.voiceModel.trim() : value.voiceModel ?? "";
  if (typeof voiceModel !== "string" || voiceModel.length > 300 || (voiceModel && !/^[^/\s]+\/\S+$/.test(voiceModel)))
    throw new Error("Name the voice model as provider/model, or leave it empty to use the chat's own");
  // Any extension's name: one that is not running now stays chosen, and voice mode says so.
  const provider = value.provider ?? "";
  if (provider !== "" && !validName(provider)) throw new Error("provider must be an extension's package name, or empty for your own addresses");
  // Chatterbox's rules are for what voice mode speaks with: the extension chosen, while it says where, else the runtime saved here.
  const source = provider ? voiceProviders().get(provider) : undefined;
  const where = source && whereOf(provider, source);
  if ((where ? where.speak?.runtime : runtime) === "chatterbox") {
    // Chatterbox is told a language or it refuses; it has no detection mode,
    // and the language also decides how numbers are written out for synthesis.
    if (language === "auto") throw new Error("Chatterbox needs an input language: auto-detect selects no voice");
    if (!CHATTERBOX_LANGUAGES.includes(language)) throw new Error(`Chatterbox speaks: ${CHATTERBOX_LANGUAGES.join(", ")}`);
    // Refuse a voice it cannot speak with here, rather than on every phrase.
    if (voice === "design" || (preset && !preset.audio))
      throw new Error("Chatterbox speaks with a reference clone: choose a voice with a recording");
  }
  const vad = { ...DEFAULT_VAD, ...value.vad };
  for (const [key, min, max] of [['positiveSpeechThreshold', 0.01, 1], ['negativeSpeechThreshold', 0, 0.99], ['minSpeechMs', 64, 2000], ['preSpeechPadMs', 0, 1000], ['redemptionMs', 200, 3000]] as const) {
    if (typeof vad[key] !== 'number' || !Number.isFinite(vad[key]) || vad[key] < min || vad[key] > max) throw new Error(`Invalid VAD ${key}: expected ${min}–${max}`);
  }
  if (vad.negativeSpeechThreshold >= vad.positiveSpeechThreshold) throw new Error('Speech-end threshold must be lower than speech-start threshold');
  return { vad, provider, runtime, voice, language, cfgScale, sttModel, dictationModel, dictationUrl: dictationUrl.trim(), exaggeration, kokoroVoice, speed, responseInstructions: savedInstructions(responseInstructions), skipThinkingProviders, voiceModel, enabled: value.enabled, whisperUrl: value.whisperUrl.trim(), breezeUrl: value.breezeUrl.trim(), instruction: value.instruction.trim() };
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
/** The samples of a RIFF/WAVE buffer, checked to be what the player expects. */
export function wavPcm(wav: Buffer, runtime = "Chatterbox"): Buffer {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE")
    throw new Error(`${runtime} returned invalid WAV audio`);
  let format = false;
  for (let at = 12; at + 8 <= wav.length;) {
    const id = wav.toString("ascii", at, at + 4), size = wav.readUInt32LE(at + 4);
    if (id === "fmt ") {
      if (size < 16 || at + 24 > wav.length || wav.readUInt16LE(at + 8) !== 1 || wav.readUInt16LE(at + 10) !== 1 || wav.readUInt32LE(at + 12) !== 24000 || wav.readUInt16LE(at + 22) !== 16)
        throw new Error(`Expected mono 24 kHz 16-bit audio from ${runtime}`);
      format = true;
    }
    if (id === "data") {
      // Samples are only meaningful once the fmt chunk has described them.
      if (!format) throw new Error(`Expected mono 24 kHz 16-bit audio from ${runtime}`);
      // A writer that does not know the length up front leaves a placeholder
      // size behind. The response is fully buffered, so its end is the truth.
      const end = size && at + 8 + size <= wav.length ? at + 8 + size : wav.length;
      const pcm = wav.subarray(at + 8, end);
      if (!pcm.length || pcm.length % 2) throw new Error(`${runtime} returned invalid PCM audio`);
      return pcm;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${runtime} returned no audio data`);
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
/** Voice mode listens and speaks through an extension that is not running, or cannot be used now: said, rather than other addresses used. */
class SourceAbsent extends Error {
  constructor() { super("Voice mode listens and speaks through an extension that is not running: install or start it, or choose your own addresses in Settings → Add-ons → Voice"); }
}
const SPEECH_RUNTIMES = ["audio-cpp", "kokoro", "chatterbox", "breeze"];
/**
 * Where a provider listens and speaks now; nothing where it cannot say, which is its own failure, as is an answer that is
 * not one: no address to listen at, or one to speak at without a runtime voice mode speaks.
 */
function whereOf(name: string, provider: VoiceProvider): VoiceWhere | undefined {
  try {
    const where = provider.where();
    if (!where) return undefined;
    const { listen, speak } = where;
    if (typeof listen?.url !== "string" || (listen.model !== undefined && typeof listen.model !== "string") || (speak !== undefined && (typeof speak?.url !== "string" || !SPEECH_RUNTIMES.includes(speak.runtime))))
      throw new TypeError(`where answered ${JSON.stringify(where)}: { listen: { url, model? }, speak?: { url, runtime } }, or nothing, is an answer`);
    return where;
  } catch (e) {
    console.error(`[extension ${name}] saying where voice mode listens and speaks failed:`, e);
    return undefined;
  }
}
/**
 * The settings voice mode works with now: the person's own, or, with an extension chosen as its source, where that one listens
 * and speaks in place of their addresses, recognition model and runtime. Dictation is then the extension's as well: a dictation
 * address of the person's own is taken before this is asked (see transcribe). Throws SourceAbsent where the extension does not answer.
 */
function inUse(own = config()): VoiceConfig {
  if (!own.provider) return own;
  const provider = voiceProviders().get(own.provider);
  const where = provider && whereOf(own.provider, provider);
  if (!where) throw new SourceAbsent();
  return { ...own, whisperUrl: where.listen.url, sttModel: where.listen.model ?? "", dictationUrl: "", dictationModel: "", runtime: where.speak?.runtime ?? "none", breezeUrl: where.speak?.url ?? "" };
}
/** What `settings` gives, or the 503 where voice mode's source is an extension that is not running: undefined then, with the answer sent. */
function usable(res: express.Response, settings: () => VoiceConfig): VoiceConfig | undefined {
  try {
    return settings();
  } catch (e) {
    if (!(e instanceof SourceAbsent)) throw e;
    res.status(503).json({ error: e.message });
    return undefined;
  }
}
/**
 * How long an extension may take over hearing that voice mode is used or not: as long as a speech model in a container
 * may take to load. The leases wait for it, every voice session's.
 */
export const providerUse = { limitMs: 120_000 };
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
 * What a session's lease loads. An extension that is the source is told voice mode is in use: once, and again where the
 * source changed to another, or the same was started anew; the one it changed from is told it is not.
 */
async function load() {
  const name = config().provider;
  const before = told;
  if (!name) {
    // Back at the person's own addresses while voice mode is in use: the extension it was is used no longer.
    told = undefined;
    if (before) await letGo(before.name);
    return;
  }
  const provider = voiceProviders().get(name);
  if (!provider || !whereOf(name, provider)) throw new SourceAbsent();
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
/**
 * An extension makes itself voice mode's source, and voice mode on (`voice.choose(true)`), or gives the source back to the
 * person's own addresses where it is the source now (false). Nothing else of the settings changes, but the input language
 * where the extension speaks with Chatterbox, which is told one and has no detection mode.
 */
function chooseProvider(name: string, chosen: boolean) {
  const current = config();
  if (!chosen) {
    if (current.provider === name) saveVoice({ ...current, provider: "" });
    return;
  }
  const provider = voiceProviders().get(name);
  const chatterbox = !!provider && whereOf(name, provider)?.speak?.runtime === "chatterbox" && !CHATTERBOX_LANGUAGES.includes(current.language);
  saveVoice({ ...current, ...(chatterbox ? { language: "en" } : {}), enabled: true, provider: name });
}
setVoiceChooser(chooseProvider);
// Whether voice mode can speak now, for the rule that is then in every conversation: switched on, and speaking where it listens and speaks.
setVoiceSpeaks(() => {
  try {
    const saved = config();
    return saved.enabled === true && inUse(saved).runtime !== "none";
  } catch {
    // Its extension is not running, or the settings cannot be read: nothing speaks.
    return false;
  }
});
/**
 * The settings as the page gets them, from every route that answers with them: what is saved, with the extensions it can
 * listen and speak through, and what the portal is set to.
 */
function shown() {
  const saved = config();
  // Each extension that offers voice mode a place to listen and speak: `ready` while it can be used now, with how it speaks then (`none`: recognition alone).
  const providers = [...voiceProviders()].map(([name, provider]) => {
    const where = whereOf(name, provider);
    return { name, label: provider.label, ready: !!where, ...(where ? { runtime: where.speak?.runtime ?? "none" } : {}) };
  });
  // Whether replies are spoken, through what is used now: an extension chosen that is not running is not known not to, and voice mode then says why it cannot start.
  let speech = true;
  try { speech = inUse(saved).runtime !== "none"; } catch { /* SourceAbsent */ }
  return {...withInstructions(saved),provider:saved.provider ?? "",providers,speech,comparison:process.env.VOICE_COMPARISON === "true",statusSpeech:process.env.VOICE_STATUS_SPEECH !== "false",ttsPrefetch:process.env.VOICE_TTS_PREFETCH === "true",sentenceChunks:process.env.VOICE_SENTENCE_CHUNKS === "true",pipelineMode:process.env.VOICE_PIPELINE_MODE === "sequential" ? "sequential" : "parallel"};
}
/**
 * The settings a chat speaks with: the voice of the agent the chat is with, where it has one of its own (the agent a project is
 * linked to for a chat in it, else the first agent's, as its avatar is). An agent's voice is one of Kokoro's or one from the
 * library, and is used by the runtime it belongs to.
 */
function speechSettings(sessionId: string): VoiceConfig {
  const own = agentFor(getSession(sessionId)?.workspace).voice;
  const saved = inUse();
  return { ...saved, ...(own && saved.runtime === "kokoro" && isKokoroVoice(own) ? { kokoroVoice: own } : own && !isKokoroVoice(own) ? { voice: own } : {}) };
}
/** What the speech engine is asked, and `identity`: everything in it that decides how the phrase sounds. */
interface SpeechRequest { json?: Record<string, unknown>; form?: FormData; identity: unknown }
async function speechRequest(settings: VoiceConfig, text: string): Promise<SpeechRequest> {
  // Resolve the voice once: a reference clip is up to a megabyte, and only
  // the runtime that is about to be called should pay to carry it.
  let instruction = settings.instruction;
  let reference: { audio: Buffer; transcript: string; filename: string } | undefined;
  // Kokoro speaks with a voice of its own and reads no library voice.
  if (settings.runtime !== "kokoro" && settings.voice !== "design") {
    const preset = readVoice(settings.voice);
    instruction = preset.instruction;
    if (preset.audio) reference = { audio: preset.audio, transcript: preset.transcript, filename: "reference.wav" };
  }
  // Chatterbox clones a speaker; it has no designed or built-in voice.
  // validateConfig refuses this combination on save; a config written before
  // that check, or an extension that speaks with Chatterbox chosen, still reaches here.
  if (settings.runtime === "chatterbox" && !reference)
    throw new Error("Chatterbox speaks with a reference clone: choose a voice with a recording");
  let json: Record<string, unknown> | undefined;
  if (settings.runtime === "kokoro") {
    // Kokoro has no streaming mode in audio.cpp either, and is fast enough that a phrase is ready
    // soon after it is asked for. The voice names the language, so none is sent.
    json = { model: "kokoro", input: text, voice: settings.kokoroVoice ?? DEFAULT_KOKORO_VOICE, speed: settings.speed ?? 1, response_format: "wav", options: { seed: "42" } };
  } else if (settings.runtime === "chatterbox") {
    // Chatterbox has no streaming mode in audio.cpp: one phrase, one WAV.
    // The browser buffers each phrase before playing it either way.
    json = { model: "chatterbox", input: spokenNumbers(text, settings.language), language: settings.language,
      response_format: "wav", options: { exaggeration: String(settings.exaggeration ?? 0.5), seed: "42" },
      voice_ref: { type: "base64", data: reference!.audio.toString("base64") } };
  } else if (settings.runtime === "audio-cpp") {
    json = { model: "breeze", input: text, stream: true, stream_format: "audio", response_format: "pcm", options: { instruction, guidance_scale: String(settings.cfgScale), seed: "42", stream_frames_per_event: "8", stream_lookahead_margin: "4" } };
    if (reference) { json.voice_ref = { type: "base64", data: reference.audio.toString("base64") }; json.reference_text = reference.transcript; }
  }
  if (json) return { json, identity: { url: settings.breezeUrl, runtime: settings.runtime, json } };
  const form = new FormData();
  form.set("text", text); form.set("instruction", instruction); form.set("cfg_scale", String(settings.cfgScale));
  if (reference) {
    form.set("ref_audio", new Blob([new Uint8Array(reference.audio)], { type: "audio/wav" }), reference.filename);
    form.set("ref_text", reference.transcript);
  }
  return { form, identity: { url: settings.breezeUrl, runtime: settings.runtime, text, instruction, cfgScale: settings.cfgScale, reference: reference && { transcript: reference.transcript, audio: createHash("sha256").update(reference.audio).digest("hex") } } };
}
/** Asks the engine, and keeps one request pending where it is busy, with the time that took. */
async function postSpeech(settings: VoiceConfig, request: SpeechRequest, signal: AbortSignal): Promise<{ upstream: Response; busyMs: number }> {
  let busyMs = 0;
  let upstream: Response;
  // Cancellation may leave Breeze finishing its current GPU operation.
  // Keep one browser request pending instead of exposing normal contention.
  do {
    const attemptStarted = performance.now();
    upstream = await fetch(settings.breezeUrl, { method: "POST", body: request.json ? JSON.stringify(request.json) : request.form!, headers: request.json ? { "Content-Type": "application/json" } : undefined, redirect: "error", signal });
    if (upstream.status !== 409) break;
    await upstream.body?.cancel();
    await delay(750, undefined, { signal });
    busyMs += performance.now() - attemptStarted;
  } while (true);
  return { upstream, busyMs };
}
/** Refuses what Breeze answered with when it is not 24 kHz PCM, before any of it is passed on or kept. */
function checkBreezePcm(upstream: Response, settings: VoiceConfig) {
  const type = upstream.headers.get("content-type");
  if (!type?.startsWith("audio/pcm") && !(settings.runtime === "audio-cpp" && type?.startsWith("application/octet-stream"))) throw new Error("Expected PCM audio from the Breeze API");
  const rate = upstream.headers.get("x-sample-rate");
  if (rate && rate !== "24000") throw new Error(`Unsupported Breeze sample rate: ${rate}`);
}
/** One whole phrase as a WAV, for what is kept rather than streamed. */
async function speechWav(settings: VoiceConfig, request: SpeechRequest, signal: AbortSignal): Promise<Buffer> {
  const { upstream } = await postSpeech(settings, request, signal);
  const runtimeName = settings.runtime === "chatterbox" ? "Chatterbox" : settings.runtime === "kokoro" ? "Kokoro" : "Breeze";
  if (!upstream.ok) throw new Error(`${runtimeName} returned HTTP ${upstream.status}`);
  if (settings.runtime === "chatterbox" || settings.runtime === "kokoro") {
    if (!/^audio\/(wav|x-wav|wave|vnd\.wave)\b/.test(upstream.headers.get("content-type") ?? "")) throw new Error(`Expected WAV audio from the ${runtimeName} API`);
    const wav = Buffer.from(await upstream.arrayBuffer());
    wavPcm(wav, runtimeName);
    return wav;
  }
  checkBreezePcm(upstream, settings);
  return pcmWav(Buffer.from(await upstream.arrayBuffer()));
}
/** The line of a stored phrase: a short one, as the engine is asked for it at every start. */
function lineText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error("The line must contain 1–200 characters");
  return value;
}
const makingLines = new Map<string, Promise<boolean>>();
/**
 * The waits between the tries at making the error line within one start: the speech model is often just coming up when voice
 * mode begins. A line still missing after the last try is made again at the next start (nothing is stored for it), not at error time.
 */
export const errorLineRetry = { waitsMs: [1000, 3000] };
/** How long an error waits for a line that is still being made. */
export const errorLineWaitMs = 8000;
/** The stored line, where there is one that a player can read: a half-written or damaged file counts as none. */
function storedErrorLine(key: string): Buffer | undefined {
  const wav = readErrorLine(key);
  if (!wav) return undefined;
  try { wavPcm(wav, "The stored error line"); } catch { return undefined; }
  // Used, so it is among the last to be cleared away.
  touchErrorLine(key);
  return wav;
}
async function makeErrorLine(settings: VoiceConfig, request: SpeechRequest, key: string): Promise<void> {
  const tries = errorLineRetry.waitsMs.length + 1;
  for (let attempt = 1; ; attempt++) {
    try {
      saveErrorLine(key, await speechWav(settings, request, AbortSignal.timeout(120000)));
      return;
    } catch (e) {
      const last = attempt >= tries;
      console.warn(`[voice] the spoken error line could not be made (try ${attempt} of ${tries}): ${(e as Error).message}${last ? "; it is tried again when voice mode next starts" : ""}`);
      if (last) throw e;
      await delay(errorLineRetry.waitsMs[attempt - 1]);
    }
  }
}
export function voiceRouter(): Router {
  const router = express.Router();
  router.get('/voice/presets',(_req,res)=>res.json(listVoices()));
  router.post('/voice/presets',(req,res)=>{try{res.json(addVoice(req.body));}catch(e){res.status(400).json({error:(e as Error).message});}});
  router.patch('/voice/presets/:id',(req,res)=>{try{res.json(updateVoice(String(req.params.id),req.body));}catch(e){res.status(e instanceof VoiceNotFound?404:400).json({error:(e as Error).message});}});
  router.get('/voice/presets/:id/audio',(req,res)=>{try{const row=readVoice(String(req.params.id));if(!row.audio)return res.sendStatus(404);res.set({'Content-Type':'audio/wav','Cache-Control':'no-store'}).send(row.audio);}catch{res.sendStatus(404);}});
  router.delete('/voice/presets/:id',(req,res)=>{try{deleteVoice(String(req.params.id));res.json({ok:true});}catch(e){res.status(404).json({error:(e as Error).message});}});
  router.get("/voice", (_req, res) => res.json(shown()));
  router.put("/voice", (req, res) => {
    try {
      saveVoice(validateConfig(req.body));
      res.json(shown());
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  router.use("/sessions/:id/voice", (req, res, next) => {
    if (!config().enabled) return res.status(409).json({ error: "Enable Voice in Settings → Add-ons first" });
    if (!getSession(req.params.id)) return res.status(404).json({ error: "Session not found" });
    next();
  });
  // Every voice session holds a lease while it is on, whatever voice mode listens and speaks through: see load and unload.
  router.post('/sessions/:id/voice/connection', async (req,res)=>{
    const {client,active}=req.body??{};
    if(typeof client!=='string'||client.length>100||!client||typeof active!=='boolean')return res.status(400).json({error:'A client ID and active flag are required'});
    try {
      const key=String(req.params.id)+':'+client;
      if(active)await leases.acquire(key);else await leases.release(key);
      res.json({ok:true});
    } catch(e){res.status(503).json({error:(e as Error).message});}
  });
  router.post("/sessions/:id/voice/transcribe", express.raw({ type: "audio/wav", limit: "12mb" }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length < 44 || req.body.toString("ascii", 0, 4) !== "RIFF")
      return res.status(400).json({ error: "A WAV recording is required" });
    const own = config();
    const dictation = req.query.purpose === "dictation";
    // A dictation address the person set is used for dictation with the model named for it, whatever voice mode listens through.
    const settings = usable(res, () => (dictation && own.dictationUrl ? own : inUse(own)));
    if (!settings) return;
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(req.body)], { type: "audio/wav" }), "recording.wav");
    form.set("response_format", "json");
    form.set("language", settings.language);
    // OpenAI-compatible recognition services (audio.cpp, Qwen3-ASR) name the
    // loaded model here; Whisper.cpp has one model and ignores the field.
    // The chat's dictation may name a model and an address of its own; voice mode and "auto" use the general one.
    const model = dictation && settings.dictationModel ? settings.dictationModel : settings.sttModel;
    if (model) form.set("model", model);
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    try {
      const sttStarted=performance.now();
      const upstream = await fetch(dictation && settings.dictationUrl ? settings.dictationUrl : settings.whisperUrl, { method: "POST", body: form, redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]) });
      if (!upstream.ok) throw new Error(`Whisper returned HTTP ${upstream.status}`);
      const result = await upstream.json() as { text?: unknown };
      if (typeof result.text !== "string") throw new Error("Whisper returned no transcript");
      res.set("Server-Timing", `whisper_upstream;dur=${(performance.now()-sttStarted).toFixed(1)}`);
      res.json({ text: result.text.trim() });
    } catch (e) { if (!res.destroyed) res.status(502).json({ error: (e as Error).message }); }
  });
  router.post("/sessions/:id/voice/speech", async (req, res) => {
    const speechStarted=performance.now();
    const settings = usable(res, () => speechSettings(req.params.id));
    if (!settings) return;
    // Recognition alone has nothing to speak with: say so, rather than send the text to an address that is not there.
    if (settings.runtime === "none") return res.status(409).json({ error: "Speech synthesis is not installed: replies are not spoken" });
    let busyMs=0;
    const text = req.body?.text;
    if (typeof text !== "string" || !text.trim() || text.length > 600)
      return res.status(400).json({ error: "Speech text must contain 1–600 characters" });
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    try {
      const request = await speechRequest(settings, text);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);
      const { upstream, busyMs: busy } = await postSpeech(settings, request, signal);
      busyMs = busy;
      const runtimeName = settings.runtime === "chatterbox" ? "Chatterbox" : settings.runtime === "kokoro" ? "Kokoro" : "Breeze";
      if (!upstream.ok) throw new Error(`${runtimeName} returned HTTP ${upstream.status}`);
      if (settings.runtime === "chatterbox" || settings.runtime === "kokoro") {
        if (!/^audio\/(wav|x-wav|wave|vnd\.wave)\b/.test(upstream.headers.get("content-type") ?? "")) throw new Error(`Expected WAV audio from the ${runtimeName} API`);
        const wav = Buffer.from(await upstream.arrayBuffer());
        // Validate before either branch, so a malformed WAV is never passed on.
        const pcm = wavPcm(wav, runtimeName);
        res.set("Server-Timing", `tts_headers;dur=${(performance.now()-speechStarted).toFixed(1)}, tts_busy;dur=${busyMs.toFixed(1)}`);
        if (req.get("accept") !== "audio/pcm") return res.set({ "Content-Type": "audio/wav", "Cache-Control": "no-store" }).send(wav);
        return res.set({ "Content-Type": "audio/pcm", "X-Sample-Rate": "24000", "X-Sample-Format": "s16le", "Cache-Control": "no-store" }).send(pcm);
      }
      checkBreezePcm(upstream, settings);
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
  /**
   * Makes the spoken error line of voice mode, once: when it is there for this voice and engine nothing is asked of the engine.
   * The page calls it as voice mode starts; at error time only the stored file is read.
   */
  router.post("/sessions/:id/voice/error-line", async (req, res) => {
    const settings = usable(res, () => speechSettings(req.params.id));
    if (!settings) return;
    if (settings.runtime === "none") return res.status(409).json({ error: "Speech synthesis is not installed: replies are not spoken" });
    let text: string;
    try { text = lineText(req.body?.text); } catch (e) { return res.status(400).json({ error: (e as Error).message }); }
    try {
      const request = await speechRequest(settings, text);
      const key = errorLineKey(request.identity);
      if (storedErrorLine(key)) return res.json({ ready: true, generated: false });
      // Two pages starting together ask the engine once.
      let making = makingLines.get(key);
      if (!making) {
        making = makeErrorLine(settings, request, key).then(() => true).finally(() => makingLines.delete(key));
        makingLines.set(key, making);
      }
      await making;
      res.json({ ready: true, generated: true });
    } catch (e) { res.status(502).json({ error: (e as Error).message }); }
  });
  /** The stored line for the voice the chat speaks with now: 404 where there is none, which is then said in writing only. */
  router.get("/sessions/:id/voice/error-line", async (req, res) => {
    const settings = usable(res, () => speechSettings(req.params.id));
    if (!settings) return;
    try {
      const text = lineText(req.query.text);
      const key = errorLineKey((await speechRequest(settings, text)).identity);
      // The line may still be on its way from the start of voice mode (the engine warming up, or on a later try): wait for it,
      // for about as long as the tries take, rather than say it was never made.
      const making = makingLines.get(key);
      if (making) {
        // The wait ends with the line: its timer is not left running out the rest of the time.
        const waited = new AbortController();
        await Promise.race([making.catch(() => {}), delay(errorLineWaitMs, undefined, { signal: waited.signal }).catch(() => {})]);
        waited.abort();
      }
      const wav = storedErrorLine(key);
      if (!wav) return res.status(404).json({ error: "The spoken error line has not been made for this voice yet" });
      res.set({ "Content-Type": "audio/wav", "Cache-Control": "no-store" }).send(wav);
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  return router;
}
