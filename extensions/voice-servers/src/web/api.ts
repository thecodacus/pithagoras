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

export const api = {
  /** The settings, and whether voice mode listens and speaks through these servers now. */
  settings: () => call<ServerSettings & { chosen: boolean }>("/settings"),
  save: (settings: ServerSettings) => call<ServerSettings & { chosen: boolean }>("/settings", { method: "PUT", body: JSON.stringify(settings) }),
  /** The voices the speech server at `ttsUrl` lists, read beside it. */
  serverVoices: (ttsUrl: string) => call<{ voices: ServerVoice[] }>("/server-voices", { method: "POST", body: JSON.stringify({ ttsUrl }) }),
  setChosen: (chosen: boolean) => call<{ chosen: boolean }>("/chosen", { method: "PUT", body: JSON.stringify({ chosen }) }),
};
