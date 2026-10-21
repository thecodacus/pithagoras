import { readFileSync } from "node:fs";
import path from "node:path";
import { portal } from "./host";
import { putSettings, setting, type Settings } from "./store";

/**
 * What the portal kept of the voice service when it was part of it, taken up when Voice first starts: the upgrade that
 * made Voice an extension left it in the portal's data folder under the name "voice", and `portal.handoffs.take` gives
 * it to the first extension that asks, moved into its own folder. In it:
 *
 *   handoff.json    what it is: {"format": 1, …}, the format this reads
 *   settings.json   the service's settings as the portal stored them, each null where it had none: gpu (the GPU chosen
 *                   on the page, a UUID, or empty), setupPending ("1" for a setup that had not come up yet) and lazyLoad
 *                   (false where the speech model was kept loaded)
 *
 * Each setting is kept where Voice's own store has none: one said here since, while the hand-off waited, is the
 * person's latest word. Only then is the hand-off done with, so a start that stopped half way takes it up again,
 * harmlessly. What cannot be taken up stays where it is, for the next start: Voice starts without it, and says why in
 * the portal's log.
 *
 * The voice container and its volume are not in it: they are taken over by their names, as the half starts and before
 * Voice acts on them (service.ts). Where voice mode listened and spoke through the service, the upgrade made Voice its
 * source.
 */
export function takeHandoff(): void {
  try {
    const dir = portal().handoffs.take("voice");
    if (!dir) return;
    const read = (name: string) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    const { format } = read("handoff.json");
    if (format !== 1) throw new Error(`it is in a format this version of Voice does not read (${format})`);
    const kept: Record<string, unknown> = read("settings.json");
    const taken: Settings = {};
    if (typeof kept.gpu === "string" && setting("gpu") === undefined) taken.gpu = kept.gpu;
    if (typeof kept.setupPending === "string" && setting("setupPending") === undefined) taken.setupPending = kept.setupPending === "1";
    if (typeof kept.lazyLoad === "boolean" && setting("lazyLoad") === undefined) taken.lazyLoad = kept.lazyLoad;
    const settings = Object.keys(taken);
    if (settings.length) putSettings(taken);
    portal().handoffs.done("voice");
    portal().log(`took up what the portal kept of the voice service${settings.length ? `: the settings ${settings.join(", ")}` : ""}`);
  } catch (e) {
    // Nothing of it is lost: it stays where it is, for the next start to take up.
    portal().log(`could not take up what the portal kept of the voice service, which is kept for the next start: ${(e as Error).message}`);
  }
}
