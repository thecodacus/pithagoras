import type { Host, VoiceChoice } from "../engines";
import { portal } from "../portal";
import type { Speech } from "../server/store";

/**
 * What the browser half asks of Voice's server half: its own routes, under the address the portal gives the package
 * (`portal.api.url`). A request made while the server half is not running is refused as one the server refused is, so
 * that what asked says so where it says the rest. The voice library's routes are VoiceLibrary.tsx's.
 */

/** A JSON route of the server half. */
const call = async <T>(path: string, init?: RequestInit): Promise<T> => portal.api.json<T>(portal.api.url(path), init);

/** How the voice service stands, whether its speech model is let go of once voice mode no longer uses it, and whether it is voice mode's source. */
export interface VoiceState { available: boolean; state: string; busy: boolean; progress: string; error: string; choice?: VoiceChoice; lazyLoad?: boolean; chosen?: boolean; /** Docker is starting it again after it failed, which a stop ends. */ retrying?: boolean }
/** The GPUs the voice container can use, as nvidia-smi reports them, and the combination that fits the one it would take. */
export interface VoiceHardware { gpus: { index: number; uuid?: string; name: string; totalMiB: number | null; freeMiB: number | null }[]; source: string; error: string; /** False while nothing could be asked yet, so that no GPU is not yet the same as none. */ checked: boolean; /** The check found there is no GPU: what is suggested is speech recognition alone, on the CPU. */ cpuOnly: boolean; /** Cards the host lists that Docker cannot hand to a container: for voice there are none. */ unusable?: string[]; /** What recognition on the CPU has to run on. */ host: Host; selected: number | null; /** The UUID of the GPU chosen on the page, empty where none is, or the one chosen is no longer there. */ chosen: string; reserveMiB: number; suggestion: VoiceChoice; }

export const api = {
  state: () => call<VoiceState>("/state"),
  // `choice` is for install: the engines to build for. Without it an install keeps what is installed, or picks for the GPU.
  act: (action: "install" | "start" | "stop", choice?: VoiceChoice) => call<{ ok: boolean }>(`/${action}`, { method: "POST", ...(choice ? { body: JSON.stringify(choice) } : {}) }),
  hardware: () => call<VoiceHardware>("/hardware"),
  setGpu: (gpu: string) => call<{ selected: string; restarting: boolean }>("/gpu", { method: "PUT", body: JSON.stringify({ gpu }) }),
  /** Removes the voice container, and voice mode has no source after where it listened and spoke through it; `removeData` deletes the downloaded engines and models too. */
  uninstall: (removeData: boolean) => call<{ ok: boolean }>("/uninstall", { method: "POST", body: JSON.stringify({ removeData }) }),
  /** Use for voice mode (true), or Stop using (false): answers whether it is voice mode's source now. */
  setChosen: (chosen: boolean) => call<{ chosen: boolean }>("/chosen", { method: "PUT", body: JSON.stringify({ chosen }) }),
  setLazyLoad: (on: boolean) => call<{ lazyLoad: boolean }>("/lazy-load", { method: "PUT", body: JSON.stringify({ on }) }),
  /** How it speaks (Your voice): its own choice of voice, the designed voice, each engine's settings, and the language spoken to it. */
  speech: () => call<Speech>("/speech"),
  setSpeech: (speech: Speech) => call<Speech>("/speech", { method: "PUT", body: JSON.stringify(speech) }),
};
