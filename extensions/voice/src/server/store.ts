import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TtsChoice } from "../engines";
import { DEFAULT_KOKORO_VOICE, isKokoroVoice, KOKORO_SPEEDS } from "../kokoro-voices";
import { CHATTERBOX_LANGUAGES, INPUT_LANGUAGES } from "../languages";
import { findVoice } from "./voices";

/**
 * Voice's settings, in `settings.json` in its own folder (`portal.dataDir()`), for its owner alone (0600). Each is left
 * out until it is said, and then what is said elsewhere (the environment, a default) answers for it.
 */
export interface Settings extends Partial<Speech> {
  /**
   * The GPU chosen on the page, by UUID; empty leaves it to `VOICE_GPU` and then to the card with the most room. A UUID
   * rather than an index, because the index order is the driver's and a UUID names the same card after a reboot or a
   * card added beside it.
   */
  gpu?: string;
  /** A setup was started from the page and has not come up yet: once it has, the service is made voice mode's source. */
  setupPending?: boolean;
  /** Whether the speech model is let go of once voice mode no longer uses it: on unless set false. */
  lazyLoad?: boolean;
}

/** How it speaks, as set on the page (Your voice), each as it is where nothing is said. */
const SPEECH = {
  /** Its own choice of voice for Breeze and Chatterbox: "design", or a voice of the library. */
  voice: "design",
  /** How the designed voice sounds, 1–1000 characters. */
  instruction: "A warm, clear English voice with a calm, conversational delivery.",
  /** Breeze's voice guidance: 1, fast, or 4, expressive. */
  cfgScale: 4,
  /** Chatterbox's expressiveness, 0–2. */
  exaggeration: 0.5,
  /** Its own choice of voice for Kokoro, one of KOKORO_VOICES. */
  kokoroVoice: DEFAULT_KOKORO_VOICE,
  /** Kokoro's speed, one of KOKORO_SPEEDS. */
  speed: 1,
  /** The language spoken to it, a code of INPUT_LANGUAGES; "auto" detects it. */
  language: "auto",
};
export type Speech = typeof SPEECH;
const SPEECH_KEYS = Object.keys(SPEECH) as (keyof Speech)[];

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

export const setting = <K extends keyof Settings>(key: K): Settings[K] => kept[key];

/**
 * `data` as `target`, for Voice's owner alone (0600), put in place at once: a reader finds the old file or the new one.
 * It is on disk before it is put in place, so a crash after leaves the new file and not an empty one: the take-up of
 * the hand-off removes the only other copy once its files are written.
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

/** Keeps `patch` beside what was said before, the whole file put in place at once: what could not be written is not said. */
export function putSettings(patch: Settings): void {
  if (!file) throw new Error("Voice's settings have not been read");
  const next = { ...kept, ...patch };
  writePrivately(file, JSON.stringify(next, null, 2));
  kept = next;
}

/** How it speaks now: each setting as said on the page, else as it is where nothing is said. */
export const speech = (): Speech => Object.fromEntries(SPEECH_KEYS.map((key) => [key, kept[key] ?? SPEECH[key]])) as Speech;

/** Each speech setting's check: the value to keep, or a throw that says what is wrong with it. */
const CHECKS: { [K in keyof Speech]: (value: unknown) => Speech[K] } = {
  voice: (value) => {
    if (typeof value !== "string") throw new Error("Choose a speaking voice");
    if (value !== "design" && !findVoice(value)) throw new Error("Voice not found");
    return value;
  },
  instruction: (value) => {
    if (typeof value !== "string" || !value.trim() || value.length > 1000) throw new Error("Provide a voice description of 1–1000 characters");
    return value.trim();
  },
  language: (value) => {
    if (!INPUT_LANGUAGES.some(([code]) => code === value)) throw new Error("Choose a supported input language");
    return value as string;
  },
  cfgScale: (value) => {
    if (value !== 1 && value !== 4) throw new Error("Choose fast or expressive speech generation");
    return value;
  },
  exaggeration: (value) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2) throw new Error("Expressiveness must be between 0 and 2");
    return value;
  },
  kokoroVoice: (value) => {
    if (!isKokoroVoice(value)) throw new Error("Choose one of Kokoro's voices");
    return value;
  },
  speed: (value) => {
    if (!(KOKORO_SPEEDS as readonly unknown[]).includes(value)) throw new Error("Choose a supported speaking speed");
    return value as number;
  },
};

/**
 * The speech settings in `value` that are said there, checked, or a throw with what is wrong. `engine` is the speech
 * engine of the container: Chatterbox is told a language or it refuses, as it has no detection mode, and it speaks only
 * with a reference clone, so the settings as they would be are held to that.
 */
export function checkSpeech(value: Record<string, unknown>, engine?: TtsChoice): Partial<Speech> {
  const checked: Partial<Record<keyof Speech, unknown>> = {};
  for (const key of SPEECH_KEYS) if (value[key] !== undefined) checked[key] = CHECKS[key](value[key]);
  if (engine === "chatterbox") {
    const { language, voice } = { ...speech(), ...checked } as Speech;
    if (language === "auto") throw new Error("Chatterbox needs an input language: auto-detect selects no voice");
    if (!CHATTERBOX_LANGUAGES.includes(language)) throw new Error(`Chatterbox speaks: ${CHATTERBOX_LANGUAGES.join(", ")}`);
    // Refused here rather than on every phrase.
    if (findVoice(voice)?.kind !== "clone") throw new Error("Chatterbox speaks with a reference clone: choose a voice with a recording");
  }
  return checked as Partial<Speech>;
}
