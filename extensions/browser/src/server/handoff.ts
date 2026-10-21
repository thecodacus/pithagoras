import { existsSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { portal } from "./host";
import { putSettings, setting, type Settings } from "./store";

/**
 * What the portal kept of the browser when it was part of it, taken up when Browser first starts: the upgrade that
 * made Browser an extension left it in the portal's data folder under the name "browser", and `portal.handoffs.take`
 * gives it to the first extension that asks, moved into its own folder. In it:
 *
 *   handoff.json    what it is: {"format": 1, …}, the format this reads
 *   settings.json   the browser's settings as the portal stored them, each null where it had none: browser_user,
 *                   browser_password (the one the container was made with), browser_port, browser_https_port,
 *                   browser_cursor ("0" was off) and browser_tools ("1" connected, "0" not)
 *   profile/        the local Chrome's profile, where it had one
 *
 * The profile is moved in where Browser has none yet, and beside Browser's own where it has one, and each setting is
 * kept where Browser's own store has none: one said here since, while the hand-off waited, is the person's latest
 * word. Only then is the hand-off done with, so a start that stopped half way takes it up again, harmlessly. What
 * cannot be taken up stays where it is, for the next start: Browser starts without it, and says why in the portal's
 * log.
 *
 * The browser's container and its profile volume are not in it: they are taken over by their names, as the half
 * starts and before Browser acts on them (service.ts).
 */

/** The settings that are text, by the portal's key and the store's. */
const TEXTS = [
  ["browser_user", "user"],
  ["browser_password", "password"],
  ["browser_port", "port"],
  ["browser_https_port", "httpsPort"],
] as const;

/** Takes up what the portal kept of the browser, if it kept anything: what the server half does first, as it starts. */
export function takeHandoff(): void {
  try {
    const dir = portal().handoffs.take("browser");
    if (!dir) return;
    const read = (name: string) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    const { format, made } = read("handoff.json");
    if (format !== 1) throw new Error(`it is in a format this version of Browser does not read (${format})`);
    const handed = path.join(dir, "profile");
    // Where Browser has a profile of its own already, that one stays the browser's, and the one handed over, which may
    // hold logins too, is kept beside it rather than going with the hand-off.
    const into = !existsSync(handed) ? undefined : existsSync(path.join(portal().dataDir(), "profile")) ? `profile-handed-over-${String(made).replace(/:/g, "-")}` : "profile";
    if (into) renameSync(handed, path.join(portal().dataDir(), into));
    const kept: Record<string, unknown> = read("settings.json");
    const said = (key: string) => (typeof kept[key] === "string" ? (kept[key] as string) : undefined);
    const taken: Settings = {};
    for (const [from, to] of TEXTS) {
      const value = said(from);
      if (value !== undefined && setting(to) === undefined) taken[to] = value;
    }
    const cursor = said("browser_cursor");
    if (cursor !== undefined && setting("cursor") === undefined) taken.cursor = cursor !== "0";
    const tools = said("browser_tools");
    if (tools !== undefined && setting("connected") === undefined) taken.connected = tools === "1";
    const settings = Object.keys(taken);
    if (settings.length) putSettings(taken);
    portal().handoffs.done("browser");
    const what = [
      ...(settings.length ? [`the settings ${settings.join(", ")}`] : []),
      ...(into ? [into === "profile" ? "the local Chrome's profile" : `the local Chrome's profile, kept as ${into} beside the one Browser had`] : []),
    ];
    portal().log(`took up what the portal kept of the browser${what.length ? `: ${what.join(" and ")}` : ""}`);
  } catch (e) {
    // Nothing of it is lost: it stays where it is, for the next start to take up.
    portal().log(`could not take up what the portal kept of the browser, which is kept for the next start: ${(e as Error).message}`);
  }
}
