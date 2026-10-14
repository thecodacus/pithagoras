import { api, ApiError, type RestartStatus } from "./api";
import { confirmDialog } from "./components/ConfirmDialog";
import { local } from "./safe-storage";
import { t, tp } from "./i18n";

/**
 * Restarting the portal from Settings → About: asks first, says what it will do, and waits for the portal to answer
 * again before the page is loaded anew. The update does the same for its own restart (update.ts); this is the restart
 * alone, for a new extension or a setting that needs a fresh start.
 */

const KEPT = "pithagoras.restart";
const POLL_MS = 1000;
/** A start takes seconds to a minute; past this the page stops waiting and says so. */
const LOST_AFTER_MS = 3 * 60_000;

/** What the portal said it cannot do, in the page's words; the portal's own text where the page has none. */
export const restartRefusal = (s: Extract<RestartStatus, { possible: false }>): string =>
  s.code === "update"
    ? updatingText()
    : s.code === "unsupervised"
    ? t("Nothing would start this portal again here: it was not started by systemd or in a container. Start it again on the host, or run it under systemd (Restart=on-failure) or Docker. PORTAL_UPDATE_RESTART=self lets the portal start its own copy.")
    : s.reason;

/** Why a restart waits while an update runs. */
export const updatingText = (): string => t("An update is running. Restarting now would cut it off and could leave the portal without its files. Wait until it has finished.");

export type RestartOutcome =
  | { kind: "cancelled" }
  /** Said in the page's words, and not as an error that something broke. */
  | { kind: "stopped"; text: string };

/**
 * The Restart button: looks whether the portal would come back, asks, and ends it. Nothing is stopped before the
 * question is answered yes. `boot` is the start that was asked to end.
 */
export async function restartPortal(): Promise<RestartOutcome | { kind: "started"; boot: string }> {
  let status: RestartStatus;
  try {
    status = await api.restartStatus();
  } catch (e) {
    return { kind: "stopped", text: (e as Error).message };
  }
  if (!status.possible) return { kind: "stopped", text: restartRefusal(status) };

  const parts = [t("The portal stops and starts again. It is away for a few seconds to a minute, open chats reconnect on their own, and this page loads again when the portal is back.")];
  if (status.running > 0) {
    parts.push(
      tp(
        status.running,
        "{n} chat or routine is running. The restart stops it; it can be carried on afterwards by sending a message.",
        "{n} chats or routines are running. The restart stops them; they can be carried on afterwards by sending a message.",
      ),
    );
  }
  // Logins are signed with a secret that is new at each start unless PORTAL_SECRET is set.
  if (!status.keepsLogins) parts.push(t("The portal's logins end with a restart, because no PORTAL_SECRET is set. You will have to sign in again."));
  if (!(await confirmDialog({ title: t("Restart the portal?"), message: parts.join("\n\n"), confirmLabel: t("Restart the portal") }))) return { kind: "cancelled" };

  try {
    const { boot } = await api.restartPortal();
    // What this start of the portal runs, to say what the next one brought: not what is installed, which an install changes at once.
    if (status.loaded) local.set(KEPT, JSON.stringify({ loaded: status.loaded, at: Date.now() }));
    return { kind: "started", boot };
  } catch (e) {
    return { kind: "stopped", text: e instanceof ApiError && e.status === 409 && e.body.code === "busy" ? t("The portal is already restarting.") : (e as Error).message };
  }
}

/**
 * Waits until the portal answers with another start than `boot`, and loads the page again. The old portal still
 * answers for a moment after it was asked, with the start that is ending; a portal that is away does not answer, or
 * answers from a proxy in front of it with an error. Resolves `lost` when it does not come back in time.
 */
export async function waitForPortal(boot: string, { every = POLL_MS, giveUpMs = LOST_AFTER_MS, reload = () => location.reload() } = {}): Promise<"back" | "lost"> {
  const until = Date.now() + giveUpMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, every));
    try {
      const health = await api.health();
      if (health.boot !== boot) {
        reload();
        return "back";
      }
    } catch {
      // Not there yet.
    }
  }
  return "lost";
}

export interface Brought {
  /** Whether the extensions of the new start were known; if not, only the restart is told. */
  known: boolean;
  added: string[];
  removed: string[];
}
let brought: Promise<Brought | null> | undefined;
/** A restart that is older than this was not the one that loaded this page. */
const FRESH_MS = 10 * 60_000;

/**
 * What the restart brought, for the page that loads after it: read once and forgotten in storage, and the same answer
 * for every ask of this page (a component drawn twice must not find it gone the second time). Nothing where the page
 * was not loaded by a restart.
 */
export function whatRestartBrought(): Promise<Brought | null> {
  return (brought ??= (async () => {
    let before: string[] | undefined;
    try {
      const kept = JSON.parse(local.get(KEPT) ?? "null");
      if (Array.isArray(kept?.loaded) && typeof kept.at === "number" && Date.now() - kept.at < FRESH_MS) before = kept.loaded;
    } catch {
      before = undefined;
    }
    local.remove(KEPT);
    if (!before) return null;
    let now: string[] | null = null;
    try {
      now = (await api.restartStatus()).loaded;
    } catch {
      // Told only that it restarted.
    }
    if (!now) return { known: false, added: [], removed: [] };
    return { known: true, added: now.filter((n) => !before!.includes(n)), removed: before.filter((n) => !now!.includes(n)) };
  })());
}
