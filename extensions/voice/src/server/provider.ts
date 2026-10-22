import type { ProvidedVoice, VoiceProvider } from "@pithagoras/extension-api/server";
import { CPU_PORT, SPEECH_PORT, ttsDevice, type TtsChoice } from "../engines";
import { KOKORO_VOICES } from "../kokoro-voices";
import { portal } from "./host";
import * as service from "./service";
import * as speech from "./speech";
import { putSettings, setting } from "./store";
import { listVoices } from "./voices";

/**
 * The voice service as voice mode is offered it (`portal.voice.provide`): what it offers while it runs, recognition and
 * speech through the engines of its container (speech.ts), and its speech model loaded while voice mode uses it, and let
 * go of after, unless lazy loading is off.
 */

/** Voice mode uses the service now, as it last told it. */
let used = false;
/** The speech model was loaded here, and has not been let go of since. */
let loaded = false;

/** The speech model of the engines voice mode is offered, loaded or let go of, in the audio.cpp process it is in: nothing where they speak with none. */
async function speechModel(action: "load" | "unload"): Promise<void> {
  const choice = service.serving();
  if (!choice || choice.tts === "none") return;
  await service.modelAction(action, choice.tts, ttsDevice(choice) === "cpu" ? CPU_PORT : SPEECH_PORT);
  loaded = action === "load";
}

/**
 * The voices an agent's voice is chosen from, for the speech engine the container was built for: Breeze's designed
 * voice and the library, the library's clones for Chatterbox, which speaks only with a recording, and Kokoro's own.
 * A voice of the library goes by the name the person gave it.
 */
function voicesFor(tts: TtsChoice): ProvidedVoice[] {
  const library = listVoices();
  if (tts === "breeze") return [{ id: "design", name: "Designed voice", builtIn: true }, ...library.map(({ id, name }) => ({ id, name }))];
  if (tts === "chatterbox") return library.filter((voice) => voice.kind === "clone").map(({ id, name }) => ({ id, name }));
  if (tts === "kokoro") return KOKORO_VOICES.map((v) => ({ id: v.id, name: `${v.name} (${v.locale})`, builtIn: true }));
  return [];
}

/** What it offers: the engines its container was built for, while they serve (`service.serving`), and nothing otherwise. */
export function state() {
  const choice = service.serving();
  return choice && { speaks: choice.tts !== "none", voices: voicesFor(choice.tts) };
}

/**
 * What voice mode is offered, anew for each start of the half: voice mode tells one started anew that it is in use again.
 * A half that stopped while voice mode used it was not told when that ended, so what it was told is not taken over.
 */
export function provider(): VoiceProvider {
  used = false;
  loaded = false;
  return {
    label: "Voice service",
    state,
    transcribe: (wav, { signal }) => speech.transcribe(wav, signal),
    speak: (text, { voice, signal }) => speech.speak(text, voice, signal),
    async use(inUse) {
      used = inUse;
      // Voice mode does not hold what failed to load, and is never told it no longer uses it: the half does not load it either.
      if (inUse)
        await speechModel("load").catch((e) => {
          used = false;
          throw e;
        });
      else if (setting("lazyLoad") !== false) await speechModel("unload");
    },
  };
}

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
 * chosen, and the speech model is kept loaded while voice mode uses it, as the engines let go of a model after 90
 * seconds without use, and where lazy loading is off; or let go of where it was kept and is not used.
 */
export async function maintain(): Promise<void> {
  const now = await service.status();
  chooseFinished(now);
  if (now.state !== "running") return;
  if (used || setting("lazyLoad") === false) await speechModel("load");
  else if (loaded) await speechModel("unload");
}
