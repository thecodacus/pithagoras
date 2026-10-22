import { readFileSync } from "node:fs";
import path from "node:path";
import { portal } from "./host";
import { saveSettings, settings, type Settings } from "./store";

/**
 * The person's own addresses for voice mode, as the portal kept them before voice mode's sources were extensions, taken
 * up when Voice servers first starts: the upgrade left them in the portal's data folder under the name
 * "voice-addresses", and `portal.handoffs.take` gives them to the first extension that asks, moved into its own folder.
 * In it:
 *
 *   handoff.json    what it is: {"format": 1, …}, the format this reads
 *   settings.json   the addresses and what went with them, as the portal stored them, each null where it had none:
 *                   whisperUrl, sttModel, breezeUrl, runtime (what spoke at breezeUrl), dictationUrl, dictationModel,
 *                   language and kokoroVoice
 *
 * Each is taken where Voice servers has none, and only where it is said: one said here since, while the hand-off
 * waited, is the person's latest word. Speech is taken only where Kokoro spoke at the address, through audio.cpp,
 * which takes OpenAI's body and answers 24 kHz WAV; what else spoke there spoke in a way this extension does not, and
 * the log says so. Only then is the hand-off done with, so a start that stopped half way takes it up again, harmlessly.
 * What cannot be taken up stays where it is, for the next start: Voice servers starts without it, and says why in the
 * portal's log.
 */
export function takeHandoff(): void {
  try {
    const dir = portal().handoffs.take("voice-addresses");
    if (!dir) return;
    const read = (name: string) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    const { format } = read("handoff.json");
    if (format !== 1) throw new Error(`it is in a format this version of Voice servers does not read (${format})`);
    const kept: Record<string, unknown> = read("settings.json");
    const own = settings();
    const taken: Settings = {};
    // Null, or empty, where the portal kept nothing of the person's own.
    const given = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
    const take = <K extends keyof Settings>(key: K, value: Settings[K]) => {
      if (value !== undefined && own[key] === undefined) taken[key] = value;
    };
    take("sttUrl", given(kept.whisperUrl));
    take("sttModel", given(kept.sttModel));
    take("dictationUrl", given(kept.dictationUrl));
    take("dictationModel", given(kept.dictationModel));
    // "auto" was the portal's word for the server detecting it, which is no language here.
    if (kept.language !== "auto") take("language", given(kept.language));
    const speech = given(kept.breezeUrl);
    if (kept.runtime === "kokoro") {
      const voice = given(kept.kokoroVoice);
      take("ttsUrl", speech);
      take("ttsModel", "kokoro");
      take("voices", voice ? [{ id: voice, name: voice }] : undefined);
      take("voice", voice);
    } else if (speech && kept.runtime !== "none") {
      portal().log(`speech at ${speech} spoke ${kept.runtime}, which Voice servers does not speak: it listens there and does not speak; the Voice service extension speaks Breeze and Chatterbox`);
    }
    const names = Object.keys(taken);
    if (names.length) saveSettings({ ...own, ...taken });
    portal().handoffs.done("voice-addresses");
    portal().log(`took up the addresses the portal kept for voice mode${names.length ? `: the settings ${names.join(", ")}` : ""}`);
  } catch (e) {
    // Nothing of it is lost: it stays where it is, for the next start to take up.
    portal().log(`could not take up the addresses the portal kept for voice mode, which are kept for the next start: ${(e as Error).message}`);
  }
}
