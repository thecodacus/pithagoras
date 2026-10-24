import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { saveSettings, settings, writePrivately } from "./store";

/**
 * The voice library: the voices the person added, with custom voices on, which the speech server is sent as the page
 * says it takes them (requests.ts). In Voice servers' own folder (`portal.dataDir()`), for its owner alone: `voices.json`,
 * the list, sorted by name, and `voices/<id>.wav`, the recording of each clone (the folder 0700, the files 0600). The
 * list is read as the half starts, and kept in memory. A voice is what the voice service's library keeps of one, and is
 * checked as it checks one (extensions/voice/src/server/voices.ts): one extension does not load the other.
 *
 * A file name is only ever made of an id in the list, and an id is only put in the list when it is a word of letters,
 * digits, `_` and `-` (`VOICE_ID`).
 */

/**
 * A voice of the library: designed from a description, or cloned from a recording with the words said in it. `stored`
 * says where a clone's recording was last stored on a speech server that keeps it (server-store.ts), and when.
 */
export interface Voice { id: string; name: string; kind: "design" | "clone"; instruction: string; transcript: string; stored?: { url: string; at: string } }

/** What an id in the list is: what may be a file name. */
export const VOICE_ID = /^[\w-]{1,100}$/;

/** A voice id that names no voice of the library: a 404 for the routes, not a value refused. */
export class VoiceNotFound extends Error {
  constructor() {
    super("Voice not found");
  }
}

let dir: string | undefined;
let library: Voice[] = [];

/** Reads the list from `folder`, as the half starts. Nothing there yet is a library with no voice. */
export function openLibrary(folder: string): void {
  dir = folder;
  try {
    library = JSON.parse(readFileSync(path.join(folder, "voices.json"), "utf8"));
  } catch {
    library = [];
  }
}

const folder = () => {
  if (!dir) throw new Error("Voice servers' library has not been read");
  return dir;
};

export const listVoices = (): readonly Voice[] => library;
export const findVoice = (id: string): Voice | undefined => library.find((voice) => voice.id === id);

/** The recording of a clone of the library. */
export function voiceAudio(id: string): Buffer {
  if (findVoice(id)?.kind !== "clone") throw new VoiceNotFound();
  return readFileSync(path.join(folder(), "voices", `${id}.wav`));
}

/** The list as it is now, sorted by name, written in place at once. */
function writeLibrary(voices: Voice[]): void {
  const sorted = [...voices].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  writePrivately(path.join(folder(), "voices.json"), JSON.stringify(sorted, null, 2));
  library = sorted;
}

function cleanName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 100) throw new Error("Enter a voice name of 1–100 characters");
  return name;
}

function cleanInstruction(value: unknown): string {
  const instruction = typeof value === "string" ? value.trim() : "";
  if (!instruction || instruction.length > 1000) throw new Error("Describe the voice in 1–1000 characters");
  return instruction;
}

/**
 * A voice the person added on the page: one designed from a description, or a clone with its recording (base64 of a
 * mono 16 kHz 16-bit WAV of 1–30 seconds, as the page makes it of the file chosen) and the words said in it.
 */
export function addVoice(value: any): Voice {
  const name = cleanName(value?.name);
  const transcript = typeof value?.transcript === "string" ? value.transcript.trim() : "";
  if (!["design", "clone"].includes(value.kind)) throw new Error("Choose a designed voice or reference clone");
  const instruction = cleanInstruction(value.instruction);
  // A designed voice has no recording, so no words said in one.
  const voice: Voice = { id: `voice-${randomUUID()}`, name, kind: value.kind, instruction, transcript: value.kind === "clone" ? transcript : "" };
  if (value.kind === "clone") {
    if (!transcript || transcript.length > 4000) throw new Error("Enter the exact words spoken in the reference (up to 4,000 characters)");
    if (typeof value.audio !== "string" || value.audio.length > 1300000) throw new Error("Upload a reference recording of 1–30 seconds");
    const audio = Buffer.from(value.audio, "base64");
    // Mono 16 kHz 16-bit PCM of 1–30 seconds, its data the rest of the file.
    if (audio.length < 32044 || audio.length > 960044 || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 16) !== "WAVEfmt " || audio.readUInt32LE(16) !== 16 || audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1 || audio.readUInt32LE(24) !== 16000 || audio.readUInt16LE(34) !== 16 || audio.toString("ascii", 36, 40) !== "data" || audio.readUInt32LE(40) !== audio.length - 44 || audio.length % 2)
      throw new Error("Invalid reference WAV; upload a 1–30 second audio clip using Settings");
    mkdirSync(path.join(folder(), "voices"), { recursive: true, mode: 0o700 });
    writePrivately(path.join(folder(), "voices", `${voice.id}.wav`), audio);
  }
  writeLibrary([...library, voice]);
  return voice;
}

/**
 * Renames a voice, or changes what it is told to sound like, or both: the recording and its words stay as they are.
 * Nothing is derived from either, so the next phrase already speaks with the new description.
 */
export function updateVoice(id: string, value: any): Voice {
  if (value?.name === undefined && value?.instruction === undefined) throw new Error("Give the voice a new name or description");
  const name = value.name === undefined ? undefined : cleanName(value.name);
  const instruction = value.instruction === undefined ? undefined : cleanInstruction(value.instruction);
  const found = findVoice(id);
  if (!found) throw new VoiceNotFound();
  const voice = { ...found, ...(name === undefined ? {} : { name }), ...(instruction === undefined ? {} : { instruction }) };
  writeLibrary(library.map((v) => (v.id === id ? voice : v)));
  return voice;
}

/** Says a clone's recording is stored on the speech server at `url` now. */
export function markStored(id: string, url: string): Voice {
  const found = findVoice(id);
  if (!found) throw new VoiceNotFound();
  const voice = { ...found, stored: { url, at: new Date().toISOString() } };
  writeLibrary(library.map((v) => (v.id === id ? voice : v)));
  return voice;
}

/**
 * Deletes a voice and its recording. Where it was the page's own choice, the server's own voice is chosen in its place.
 * An agent that speaks with it is left as it is: it speaks with the page's choice.
 */
export function deleteVoice(id: string): void {
  if (!findVoice(id)) throw new VoiceNotFound();
  writeLibrary(library.filter((voice) => voice.id !== id));
  rmSync(path.join(folder(), "voices", `${id}.wav`), { force: true });
  const { voice, ...rest } = settings();
  if (voice === id) saveSettings(rest);
}
