import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { portal } from "./host";
import { checkSpeech, putSettings, setting, type Settings } from "./store";
import { addVoices, findVoice, keepRecording, VOICE_ID, type Voice } from "./voices";

/**
 * What the portal kept of the voice service when it was part of it, taken up when Voice first starts: the upgrade that
 * made Voice an extension left it in the portal's data folder under the name "voice-service", and
 * `portal.handoffs.take` gives it to the first extension that asks, moved into its own folder. In it:
 *
 *   handoff.json    what it is: {"format": 1, …}, the format this reads
 *   voices.json     the voice library, in the order the portal kept it: {id, name, kind, instruction, transcript, audio},
 *                   `audio` being a clone's recording, "voices/<n>.wav", or null
 *   voices/<n>.wav  each clone's recording, the bytes as the portal kept them
 *   settings.json   the settings as the portal stored them, each null where it had none: the service's own, gpu (the
 *                   GPU chosen on the page, a UUID, or empty), setupPending ("1" for a setup that had not come up yet)
 *                   and lazyLoad (false where the speech model was kept loaded), and how it spoke: voice, instruction,
 *                   cfgScale, exaggeration, kokoroVoice, speed and language
 *
 * Only what Voice lacks is taken: a voice whose id its library has, or a setting its store has, is the person's latest
 * word, said here while the hand-off waited. What cannot be used is left out, and the portal's log names it. The
 * recordings go first, then the library's list, then the settings, so a voice chosen is one the library has; only then
 * is the hand-off done with, so a start that stopped part way takes up the rest next time. What cannot be read stays
 * where it is, for the next start: Voice starts without it, and says why in the portal's log.
 *
 * The voice container and its volume are not in it: they are taken over by their names, as the half starts and before
 * Voice acts on them (service.ts). Which source voice mode listens and speaks through is the portal's, and the upgrade
 * chose the service where voice mode did so before.
 */
export function takeHandoff(): void {
  try {
    const dir = portal().handoffs.take("voice-service");
    if (!dir) return;
    const read = (name: string) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    const { format } = read("handoff.json");
    if (format !== 1) throw new Error(`it is in a format this version of Voice does not read (${format})`);
    const left: string[] = [];

    const voices: Voice[] = [];
    for (const { id, name, kind, instruction, transcript, audio } of read("voices.json")) {
      if (findVoice(id)) continue;
      const clone = kind === "clone";
      if (!VOICE_ID.test(id) || !(clone || kind === "design") || (clone && !(typeof audio === "string" && /^voices\/\d+\.wav$/.test(audio) && existsSync(path.join(dir, audio))))) {
        left.push(`the voice ${name}`);
        continue;
      }
      if (clone) keepRecording(id, readFileSync(path.join(dir, audio)));
      voices.push({ id, name, kind, instruction, transcript });
    }
    if (voices.length) addVoices(voices);

    const kept: Record<string, unknown> = read("settings.json");
    const taken: Settings = {};
    for (const [key, value] of Object.entries(kept)) {
      if (value === null || setting(key as keyof Settings) !== undefined) continue;
      try {
        Object.assign(taken, key in SERVICE ? { [key]: SERVICE[key](value) } : checkSpeech({ [key]: value }));
      } catch {
        left.push(`the setting ${key}`);
      }
    }
    const settings = Object.keys(taken);
    if (settings.length) putSettings(taken);
    portal().handoffs.done("voice-service");

    const said = [settings.length && `the settings ${settings.join(", ")}`, voices.length && `the voices ${voices.map((v) => v.name).join(", ")}`].filter(Boolean);
    portal().log(`took up what the portal kept of the voice service${said.length ? `: ${said.join("; ")}` : ""}${left.length ? `; left out: ${left.join(", ")}` : ""}`);
  } catch (e) {
    // Nothing of it is lost: it stays where it is, for the next start to take up.
    portal().log(`could not take up what the portal kept of the voice service, which is kept for the next start: ${(e as Error).message}`);
  }
}

/**
 * The service's own settings, as the portal stored them, made what Voice keeps, or a throw for one of another type.
 * How it spoke is taken as the page would take it (`checkSpeech`), whatever engine the container is for, as it may be
 * built anew.
 */
const SERVICE: Record<string, (value: unknown) => unknown> = {
  gpu: (value) => typed(value, "string"),
  setupPending: (value) => typed(value, "string") === "1",
  lazyLoad: (value) => typed(value, "boolean"),
};

/** `value`, where it is of `type`. */
function typed(value: unknown, type: "string" | "boolean"): unknown {
  if (typeof value !== type) throw new Error(`not a ${type}`);
  return value;
}
