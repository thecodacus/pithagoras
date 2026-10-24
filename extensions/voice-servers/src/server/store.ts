import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { offered } from "./requests";

/** A voice the speech server speaks with: what it is sent as (`id`), and what the person calls it. */
export interface ServerVoice {
  id: string;
  name: string;
}

/**
 * Voice servers' settings, in `settings.json` in its own folder (`portal.dataDir()`), for its owner alone (0600). Each
 * is left out while it is empty.
 */
export interface Settings {
  /** Speech recognition: OpenAI's …/v1/audio/transcriptions, or whisper.cpp's …/inference. */
  sttUrl?: string;
  /** Sent as `model` with each recording. */
  sttModel?: string;
  /** The language spoken, an ISO 639-1 code sent as `language`; left out, the server detects it. */
  language?: string;
  /** Dictation's own address; left out, `sttUrl`. */
  dictationUrl?: string;
  /** Dictation's own model; left out, `sttModel`. */
  dictationModel?: string;
  /** Speech synthesis: OpenAI's …/v1/audio/speech; left out, it recognises speech alone. */
  ttsUrl?: string;
  /** Sent as `model` with each phrase. */
  ttsModel?: string;
  /** What an agent's voice is chosen from: typed in, or read from the server. */
  voices?: ServerVoice[];
  /**
   * Its own choice: what it speaks with where an agent has none. One of the voices offered (see requests.ts): one of
   * `voices`, or, with custom voices on and Breeze or Chatterbox, a voice of the library that engine speaks with.
   */
  voice?: string;
  /** Custom voices: the voice library (voices.ts), for Breeze and Chatterbox. Left out while they are off, as they start. */
  customVoices?: true;
  /**
   * What the speech server is, and how it is reached, while custom voices are on (see requests.ts); left out, a server
   * with fixed voices, such as Kokoro, spoken to as OpenAI's API is. Kept while custom voices are off, for when they are
   * on again.
   */
  speechServer?: Exclude<SpeechServer, "fixed">;
}

/** What the speech server can be: one with fixed voices, spoken to as it is while custom voices are off, first. */
export const SPEECH_SERVERS = ["fixed", "breeze-audiocpp", "breeze-tts", "chatterbox-audiocpp", "chatterbox-tts-server"] as const;
export type SpeechServer = (typeof SPEECH_SERVERS)[number];

let file: string | undefined;
let kept: Settings = {};

/** Reads the settings from `dir`, as the half starts. Nothing there yet is no setting said. */
export function openStore(dir: string): void {
  file = path.join(dir, "settings.json");
  try {
    kept = JSON.parse(readFileSync(file, "utf8")) ?? {};
  } catch {
    kept = {};
  }
}

export const settings = (): Settings => kept;

/**
 * `data` as `target`, for its owner alone (0600), put in place at once: a reader finds the old file or the new one. It is
 * on disk before it is put in place, so a crash after leaves the new file and not an empty one: the take-up of the
 * hand-off removes the only other copy once the settings are saved.
 */
export function writePrivately(target: string, data: string | Buffer): void {
  const fd = openSync(`${target}.tmp`, "w", 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(`${target}.tmp`, target);
}

/** Keeps `next` as the settings, the whole file put in place at once. */
export function saveSettings(next: Settings): void {
  if (!file) throw new Error("Voice servers' settings have not been read");
  writePrivately(file, JSON.stringify(next, null, 2));
  kept = next;
}

/** A field as it was sent; empty where it was not. */
function said(label: string, given: unknown): string {
  if (given === undefined) return "";
  if (typeof given !== "string") throw new Error(`${label} must be text`);
  return given;
}

/** An address as it was sent, without the spaces around it: http or https, with no credentials and no fragment; or empty. */
export function checkUrl(label: string, given: unknown): string {
  const url = said(label, given).trim();
  const parsed = url && URL.canParse(url) ? new URL(url) : undefined;
  if (url && (!parsed || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash))
    throw new Error(`${label} must be an HTTP URL without credentials or a fragment`);
  return url;
}

function checkModel(label: string, given: unknown): string {
  const model = said(label, given).trim();
  if (!/^[\w.:-]{0,100}$/.test(model)) throw new Error(`${label} may only contain letters, digits, dot, colon, dash or underscore, at most 100 of them`);
  return model;
}

/**
 * `next` held to what the speech server needs, where custom voices are on: Chatterbox in audio.cpp is told the language
 * it speaks, as it has no detection mode, so the input language has to be set; Chatterbox-TTS-Server refuses a request
 * that names no model. Throws with what is wrong.
 */
export function checkCustom(next: Settings): void {
  if (!next.customVoices) return;
  if (next.speechServer === "chatterbox-audiocpp" && !next.language) throw new Error("Chatterbox speaks the input language it is told, and has no detection: set an input language");
  if (next.speechServer === "chatterbox-tts-server" && !next.ttsModel) throw new Error("Chatterbox-TTS-Server needs a speech synthesis model in each request: any name, such as chatterbox");
}

/**
 * The settings in `value`, as the page sends them, checked: each address, each model, the language, the voices and the
 * voice chosen of them, with the custom voices as they are (`customVoices` and `speechServer` have routes of their own,
 * and are kept). Throws with what is wrong. What is empty is left out.
 */
export function checkSettings(value: Record<string, unknown> | undefined): Settings {
  const language = said("The input language", value?.language).trim();
  if (!/^([a-z]{2,3})?$/.test(language)) throw new Error("The input language is a code of two or three small letters, such as en, or empty for the server to detect it");
  const voices = value?.voices ?? [];
  if (!Array.isArray(voices) || voices.length > 500) throw new Error("The voices are a list of at most 500");
  const listed = voices.map((voice): ServerVoice => {
    const { id, name } = voice ?? {};
    if (typeof id !== "string" || !id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) throw new Error("A voice's id is 1–200 characters, with no control characters");
    return { id, name: said("A voice's name", name) || id };
  });
  const voice = said("The voice", value?.voice);
  const { customVoices, speechServer } = kept;
  if (voice && !offered({ voices: listed, customVoices, speechServer }).some((v) => v.id === voice)) throw new Error("Choose one of the voices listed, or none");
  const next: Settings = {
    sttUrl: checkUrl("The speech recognition URL", value?.sttUrl),
    sttModel: checkModel("The speech recognition model", value?.sttModel),
    language,
    dictationUrl: checkUrl("The dictation endpoint", value?.dictationUrl),
    dictationModel: checkModel("The dictation model", value?.dictationModel),
    ttsUrl: checkUrl("The speech synthesis URL", value?.ttsUrl),
    ttsModel: checkModel("The speech synthesis model", value?.ttsModel),
    voices: listed,
    voice,
  };
  const checked: Settings = { ...(Object.fromEntries(Object.entries(next).filter(([, v]) => v.length)) as Settings), ...(customVoices ? { customVoices } : {}), ...(speechServer ? { speechServer } : {}) };
  checkCustom(checked);
  return checked;
}
