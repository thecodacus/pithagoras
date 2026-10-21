import type { VoiceProvider } from "@pithagoras/extension-api/server";
import { CPU_PORT, SPEECH_PORT, endpoints, ttsDevice } from "../engines";
import { portal } from "./host";
import * as service from "./service";
import { putSettings, setting } from "./store";

/**
 * The voice service as voice mode is offered it (`portal.voice.provide`): where it listens and speaks while it runs,
 * and its speech model loaded while voice mode uses it, and let go of after, unless lazy loading is off.
 */

/** Voice mode uses the service now, as it last told it. */
let used = false;
/** The speech model was loaded here, and has not been let go of since. */
let loaded = false;

/** The service's speech model loaded or let go of, in the audio.cpp process it is in: nothing where the service speaks with none. */
async function speechModel(action: "load" | "unload"): Promise<void> {
  const choice = service.lastSeen()?.choice;
  if (!choice || choice.tts === "none") return;
  await service.modelAction(action, choice.tts, ttsDevice(choice) === "cpu" ? CPU_PORT : SPEECH_PORT);
  loaded = action === "load";
}

export const provider: VoiceProvider = {
  label: "Voice service",
  // While the service was last found running, at the addresses of the engines its container was built for.
  where() {
    const seen = service.lastSeen();
    return seen?.state === "running" && seen.choice ? endpoints(seen.choice) : undefined;
  },
  async use(inUse) {
    used = inUse;
    if (inUse) await speechModel("load");
    else if (setting("lazyLoad") !== false) await speechModel("unload");
  },
};

/**
 * A setup that was started from the page and has finished is made voice mode's source, once: what the page's Install
 * did not wait for. Taken up wherever the finished service is first seen, which is the timer or the page asking after it.
 */
export function chooseFinished(now: service.ServiceStatus): void {
  if (now.state !== "running" || !setting("setupPending")) return;
  portal().voice.choose(true);
  putSettings({ setupPending: false });
}

/**
 * What the service needs while nobody looks at its page, as the half starts and every 30 seconds: a running container
 * rejoins the portal's loopback after the portal's own container was made again (`status`), a setup that finished is
 * chosen, and the speech model is kept loaded where lazy loading is off, or let go of where it was kept and voice mode
 * does not use it.
 */
export async function maintain(): Promise<void> {
  const now = await service.status();
  chooseFinished(now);
  if (now.state !== "running") return;
  if (setting("lazyLoad") === false) await speechModel("load");
  else if (loaded && !used) await speechModel("unload");
}
