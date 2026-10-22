import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Voice's settings, in `settings.json` in its own folder (`portal.dataDir()`), for its owner alone (0600). Each is left
 * out until it is said, and then what is said elsewhere (the environment, a default) answers for it.
 */
export interface Settings {
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
  /** Its own choice of voice for Breeze and Chatterbox: "design", or a voice of the library; "design" unless set. */
  voice?: string;
  /** How the designed voice sounds, 1–1000 characters; DEFAULT_INSTRUCTION unless set. */
  instruction?: string;
  /** Breeze's voice guidance: 1, fast, or 4, expressive; 4 unless set. */
  cfgScale?: number;
  /** Chatterbox's expressiveness, 0–2; 0.5 unless set. */
  exaggeration?: number;
  /** Its own choice of voice for Kokoro, one of KOKORO_VOICES; DEFAULT_KOKORO_VOICE unless set. */
  kokoroVoice?: string;
  /** Kokoro's speed, one of KOKORO_SPEEDS; 1 unless set. */
  speed?: number;
  /** The language spoken to it, a code of INPUT_LANGUAGES; "auto", which detects it, unless set. */
  language?: string;
}

/** How the designed voice sounds where nothing else is said. */
export const DEFAULT_INSTRUCTION = "A warm, clear English voice with a calm, conversational delivery.";

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

/** Keeps `patch` beside what was said before, the whole file put in place at once. */
export function putSettings(patch: Settings): void {
  if (!file) throw new Error("Voice's settings have not been read");
  kept = { ...kept, ...patch };
  writeFileSync(`${file}.tmp`, JSON.stringify(kept, null, 2), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
