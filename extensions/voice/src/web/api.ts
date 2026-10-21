import type { Host, VoiceChoice } from "../engines";
import { portal } from "../portal";

/**
 * What the browser half asks of Voice's server half: its own routes, under the address the portal gives the package
 * (`portal.api.url`). A request made while the server half is not running is refused as one the server refused is, so
 * that what asked says so where it says the rest.
 */

/** A JSON route of the server half. */
const call = async <T>(path: string, init?: RequestInit): Promise<T> => portal.api.json<T>(portal.api.url(path), init);

/** How the voice service stands, and whether its speech model is let go of once voice mode no longer uses it. */
export interface VoiceState { available: boolean; state: string; busy: boolean; progress: string; error: string; choice?: VoiceChoice; lazyLoad?: boolean }
/** The GPUs the voice container can use, as nvidia-smi reports them, and the combination that fits the one it would take. */
export interface VoiceHardware { gpus: { index: number; uuid?: string; name: string; totalMiB: number | null; freeMiB: number | null }[]; source: string; error: string; /** False while nothing could be asked yet, so that no GPU is not yet the same as none. */ checked: boolean; /** The check found there is no GPU: what is suggested is speech recognition alone, on the CPU. */ cpuOnly: boolean; /** Cards the host lists that Docker cannot hand to a container: for voice there are none. */ unusable?: string[]; /** What recognition on the CPU has to run on. */ host: Host; selected: number | null; /** The UUID of the GPU chosen on the page, empty where none is, or the one chosen is no longer there. */ chosen: string; reserveMiB: number; suggestion: VoiceChoice; }

export const api = {
  state: () => call<VoiceState>("/state"),
  // `choice` is for install: the engines to build for. Without it an install keeps what is installed, or picks for the GPU.
  act: (action: "install" | "start" | "stop", choice?: VoiceChoice) => call<{ ok: boolean }>(`/${action}`, { method: "POST", ...(choice ? { body: JSON.stringify(choice) } : {}) }),
  hardware: () => call<VoiceHardware>("/hardware"),
  setGpu: (gpu: string) => call<{ selected: string; restarting: boolean }>("/gpu", { method: "PUT", body: JSON.stringify({ gpu }) }),
  /** Removes the voice container, and voice mode goes back to the person's own addresses; `removeData` deletes the downloaded engines and models too. */
  uninstall: (removeData: boolean) => call<{ ok: boolean }>("/uninstall", { method: "POST", body: JSON.stringify({ removeData }) }),
  connect: () => call<{ ok: boolean }>("/connect", { method: "POST" }),
  setLazyLoad: (on: boolean) => call<{ lazyLoad: boolean }>("/lazy-load", { method: "PUT", body: JSON.stringify({ on }) }),
};
