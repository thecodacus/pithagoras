import { readFileSync } from "node:fs";
import path from "node:path";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import subagentTool from "./pi";
import { checkChange, MAX_PARALLEL, openStore, saveSettings, settings, settingsOf, takeSettings, type Settings } from "./settings";

/**
 * The subagent extension's server half: the `subagent` tool in every chat's pi (`portal.chats.extend`, pi.ts), with
 * the settings it keeps in its own folder (settings.ts), and the routes of its page in Settings, at
 * /api/x/pithagoras-subagent/….
 *
 * In the portal's own process, never in one of its own: the tool speaks the subagent protocol on the chat's event bus
 * (`pi.events`), which a pi given to a half in a process of its own does not have.
 *
 * What pi's settings held for the tool before it was an extension is taken up first (takeHandoff).
 */
export default function subagent(portal: ServerPortal) {
  openStore(portal.dataDir());
  takeHandoff(portal);
  portal.chats.extend((pi) => subagentTool(pi, settings));
  routes(portal);
}

/**
 * The settings as the tool kept them in pi's settings.json, before it was an extension: the upgrade to schema 12 left
 * them in the portal's data folder under the name "subagent", and `portal.handoffs.take` gives them to the first
 * extension that asks, moved into its own folder. In it:
 *
 *   handoff.json    what it is: {"format": 1, …}, the format this reads
 *   settings.json   subagentMode, subagentMaxParallel and subagentModel as pi's settings had them, each null where they
 *                   had none
 *
 * Each is read as the tool read it, and taken where this extension has none of its own: one said on its page since,
 * while the hand-off waited, is the person's latest word. One that an earlier hand-off gave and nobody has changed
 * since is not: the person went back to pi's settings meanwhile, and what they hold now is newer. Only then is the
 * hand-off done with, so a start that stopped half way takes it up again, harmlessly. What cannot be taken up stays
 * where it is, for the next start: the extension starts with what it has, and says why in the portal's log.
 */
export function takeHandoff(portal: Pick<ServerPortal, "handoffs" | "log">): void {
  try {
    const dir = portal.handoffs.take("subagent");
    if (!dir) return;
    const read = (name: string) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    const { format } = read("handoff.json");
    if (format !== 1) throw new Error(`they are in a format this version does not read (${format})`);
    const kept = read("settings.json") ?? {};
    const old = settingsOf({ mode: kept.subagentMode, maxParallel: kept.subagentMaxParallel, model: kept.subagentModel });
    const taken = takeSettings(old);
    portal.handoffs.done("subagent");
    portal.log(`took up the subagent settings pi's settings held${taken.length ? `: ${taken.join(", ")}` : ""}`);
  } catch (e) {
    // Nothing of it is lost: it stays where it is, for the next start to take up.
    portal.log(`could not take up the subagent settings pi's settings held, which are kept for the next start: ${(e as Error).message}`);
  }
}

/**
 * The page in Settings, behind the portal's login:
 *
 *   GET /settings   {mode, maxParallel, maxParallelLimit, model}
 *   PUT /settings   {mode?, maxParallel?, model?}: each it names; the open chats are loaded again, as the mode and the
 *                   limit are in what the tool tells the model, and the answer says how many were (`reloaded`) and how
 *                   many have it from their next step (`waiting`)
 *
 * The portal's old address for them, /api/features/subagent, sends here. `enabled` there was the switch, which is
 * Settings → Extensions' now: `true` asks for nothing this does not have already, as it answers; `false` is refused.
 */
function routes(portal: ServerPortal): void {
  const json = portal.http.json();
  // The most there may be, for the page to count up to: said here, not repeated there.
  const shown = () => ({ ...settings(), maxParallelLimit: MAX_PARALLEL });
  portal.router.get("/settings", (_req, res) => res.json(shown()));
  portal.router.put("/settings", json, async (req, res) => {
    let change: Partial<Settings>;
    try {
      if (req.body?.enabled !== undefined && req.body.enabled !== true) {
        throw new Error("The subagent tool is switched off in Settings → Extensions (PUT /api/extensions/enabled)");
      }
      change = checkChange(req.body);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
    try {
      saveSettings({ ...settings(), ...change });
      // The mode and the limit are in the tool's description, which a chat reads as its pi is loaded.
      const { reloaded, waiting } = await portal.chats.reload();
      res.json({ ...shown(), reloaded, waiting });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
}
