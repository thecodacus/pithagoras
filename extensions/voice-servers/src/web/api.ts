import { portal } from "../portal";

/**
 * What the browser half asks of Voice servers' server half: its own routes, under the address the portal gives the
 * package (`portal.api.url`). A request made while the server half is not running is refused as one the server refused
 * is, so that what asked says so where it says the rest.
 */

/** A JSON route of the server half. */
const call = async <T>(path: string, init?: RequestInit): Promise<T> => portal.api.json<T>(portal.api.url(path), init);

/** A voice the speech server speaks with: what it is sent as, and what the person calls it. */
export interface ServerVoice { id: string; name: string }

/**
 * What the speech server is, and how it is reached, with custom voices on (server/requests.ts): one with fixed voices
 * is spoken to as it is while they are off.
 */
export type SpeechServer = "fixed" | "breeze-audiocpp" | "breeze-tts" | "chatterbox-audiocpp" | "chatterbox-tts-server";

/**
 * A voice of the library: designed from a description, or cloned from a recording with the words said in it; `stored`,
 * where a clone was last stored on a speech server that keeps voices, and when.
 */
export interface LibraryVoice { id: string; name: string; kind: "design" | "clone"; instruction: string; transcript: string; stored?: { url: string; at: string } }

/** The settings as they are saved, each left out while it is empty. */
export interface ServerSettings {
  sttUrl?: string;
  sttModel?: string;
  language?: string;
  dictationUrl?: string;
  dictationModel?: string;
  ttsUrl?: string;
  ttsModel?: string;
  voices?: ServerVoice[];
  voice?: string;
}

/** The settings as the server half says them: with custom voices and their form, which have routes of their own. */
export type ShownSettings = ServerSettings & { customVoices?: true; speechServer?: Exclude<SpeechServer, "fixed">; chosen: boolean };

/** A route of the voice library. */
const library = <T>(path: string, method = "GET", body?: unknown): Promise<T> =>
  call<T>(`/voices${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const api = {
  /** The settings, and whether voice mode listens and speaks through these servers now. */
  settings: () => call<ShownSettings>("/settings"),
  save: (settings: ServerSettings) => call<ShownSettings>("/settings", { method: "PUT", body: JSON.stringify(settings) }),
  /** Custom voices on or off, at once; answers the settings, the voice chosen on the page gone where it is no longer offered. */
  setCustomVoices: (on: boolean) => call<ShownSettings>("/custom-voices", { method: "PUT", body: JSON.stringify({ on }) }),
  setSpeechServer: (speechServer: SpeechServer) => call<ShownSettings>("/speech-server", { method: "PUT", body: JSON.stringify({ speechServer }) }),
  voices: () => library<LibraryVoice[]>(""),
  /**
   * A voice added: `audio` is a clone's recording, base64 of a mono 16 kHz WAV (see audio.ts). Where the speech server
   * keeps voices, it is stored there too, and `storeError` says why where it could not be.
   */
  addVoice: (voice: { name: string; kind: "design" | "clone"; instruction: string; transcript?: string; audio?: string }) => library<LibraryVoice & { storeError?: string }>("", "POST", voice),
  /** A clone's recording stored on the speech server now, where it keeps voices. */
  storeVoice: (id: string) => library<LibraryVoice>(`/${id}/store`, "POST"),
  updateVoice: (id: string, patch: { name?: string; instruction?: string }) => library<LibraryVoice>(`/${id}`, "PATCH", patch),
  deleteVoice: (id: string) => library<{ ok: true }>(`/${id}`, "DELETE"),
  /** Where a clone's recording is played from, behind the login. */
  voiceAudio: (id: string) => portal.api.url(`/voices/${id}/audio`),
  /** The voices the speech server at `ttsUrl` lists, read beside it. */
  serverVoices: (ttsUrl: string) => call<{ voices: ServerVoice[] }>("/server-voices", { method: "POST", body: JSON.stringify({ ttsUrl }) }),
  setChosen: (chosen: boolean) => call<{ chosen: boolean }>("/chosen", { method: "PUT", body: JSON.stringify({ chosen }) }),
};
