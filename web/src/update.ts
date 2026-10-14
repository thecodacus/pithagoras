import { useSyncExternalStore } from "react";
import { api, ApiError, type UpdateCheck, type UpdateRun, type UpdateStatus, type UpdateStep } from "./api";
import { confirmDialog } from "./components/ConfirmDialog";
import { local } from "./safe-storage";
import { msg, t, tp } from "./i18n";

/**
 * Updating the portal from Settings → About, and the notice that there is something to update to.
 *
 * What the portal says about its update is kept here once, for both places that show it: the notice at the top of
 * the page, and the section in Settings. It is asked for every few minutes (from the portal's memory, which looks at
 * origin/main on its own schedule), and every second while an update runs, until the portal that comes back is a new
 * one and the page is loaded again.
 */

interface Snapshot {
  status: UpdateStatus | null;
  /** The portal was restarting and has not come back in a long while. */
  lost: boolean;
}

const IDLE_MS = 5 * 60_000;
const RUNNING_MS = 1000;
/** A build and a start take minutes at the most; past this the page stops waiting and says so. */
const LOST_AFTER_MS = 3 * 60_000;

let snap: Snapshot = { status: null, lost: false };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
/** The start of the portal this page was loaded from, and the commit it was running. */
let firstBoot: string | undefined;
let firstSha: string | undefined;
/** An update has gone as far as the restart: whatever answers next with another boot is the new portal. */
let restartingSince = 0;

const emit = () => listeners.forEach((l) => l());
const running = (s: UpdateStatus | null) => s?.run?.state === "running" || s?.run?.state === "restarting";

/** Asks the portal where its update stands, and says nothing of it going wrong: the portal may be restarting. */
export async function refreshUpdate(): Promise<void> {
  try {
    const status = await api.update();
    const wasRestarting = restartingSince > 0;
    if (firstBoot === undefined) {
      firstBoot = status.boot;
      firstSha = status.current?.sha;
    } else if (status.boot !== firstBoot) {
      // The page in front of the person is the old build's: the new one is what is served now. A portal that
      // was restarted by hand is another matter, and nothing in the page has to change for it.
      if (wasRestarting || status.current?.sha !== firstSha) {
        location.reload();
        return;
      }
      firstBoot = status.boot;
    }
    // Asked while it is going down, or after a dropped answer: not restarting unless it says so.
    restartingSince = status.run?.state === "restarting" ? restartingSince || Date.now() : 0;
    snap = { status, lost: false };
  } catch {
    // An update that was running and now cannot be asked about is the portal restarting.
    if (running(snap.status) && !restartingSince) restartingSince = Date.now();
    if (restartingSince && Date.now() - restartingSince > LOST_AFTER_MS && !snap.lost) snap = { ...snap, lost: true };
  }
  emit();
}

function schedule(): void {
  clearTimeout(timer);
  if (!listeners.size) return;
  // Where nothing can be updated, once is enough.
  if (snap.status && snap.status.kind !== "git") return;
  const wait = restartingSince > 0 || running(snap.status) ? RUNNING_MS : snap.status ? IDLE_MS : 30_000;
  timer = setTimeout(async () => {
    await refreshUpdate();
    schedule();
  }, wait);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) void refreshUpdate().then(schedule);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) clearTimeout(timer);
  };
}

/** The update as the portal last said it. */
export const useUpdate = (): Snapshot => useSyncExternalStore(subscribe, () => snap);

/** Looked at once more, and the next look is scheduled by it. */
export async function updateNow(): Promise<void> {
  await refreshUpdate();
  schedule();
}

// --- the notice ---

const SEEN = "pithagoras.update.notice";
const read = (): { dismissed: string[]; told?: string } => {
  try {
    const kept = JSON.parse(local.get(SEEN) ?? "{}") ?? {};
    return { dismissed: Array.isArray(kept.dismissed) ? kept.dismissed : [], told: typeof kept.told === "string" ? kept.told : undefined };
  } catch {
    return { dismissed: [] };
  }
};
const write = (patch: Partial<ReturnType<typeof read>>) => local.set(SEEN, JSON.stringify({ ...read(), ...patch }));

/** The person put this away: the notice of a target commit, or the failure of a run (by when it started). The next one brings it back. */
export const noticeDismissed = (key: string): boolean => read().dismissed.includes(key);
export function dismissNotice(key: string): void {
  write({ dismissed: [...read().dismissed, key].slice(-10) });
  // The snapshot is a new one, or nothing drawn from it would be drawn again.
  snap = { ...snap };
  emit();
}
/** Whether the browser has been told of this target already, and notes that it now has: once for each new commit. */
export function firstTimeTold(sha: string): boolean {
  if (read().told === sha) return false;
  write({ told: sha });
  return true;
}

// --- the update ---

export const STEP_LABELS: Record<UpdateStep, string> = {
  fetch: msg("Fetching origin/main"),
  merge: msg("Moving the checkout to it"),
  install: msg("Installing dependencies"),
  build: msg("Building"),
  restart: msg("Restarting the portal"),
};

/**
 * What a failed update says first. The old files are said to be as they were only where they are: not after the
 * restart, which comes when the new build has replaced them, and not where putting them back failed.
 */
export function failureText(failed: NonNullable<UpdateRun["failed"]>): string {
  if (failed.step === "restart") return t("The new version is built, but the portal could not restart itself. Restart it on the host.");
  const step = t(STEP_LABELS[failed.step]);
  if (!failed.oldFilesBack) return t("The update stopped at “{step}”, and the old files could not be put back. Look at the install on the host.", { step });
  return t("The update stopped at “{step}”. The portal is still running its old build, with its files as they were.", { step });
}

export const commitLabel = (c: { sha: string; subject: string }): string => `${c.sha.slice(0, 7)} ${c.subject}`.trim();

/** What stands in the way, in the words of the page; the program's own message follows where it has one worth reading. */
export function problemText(p: NonNullable<UpdateCheck["problem"]>, changed: number): string {
  switch (p.code) {
    case "dirty":
      return tp(changed, "The checkout has {n} file with local changes. Commit or discard it on the host first.", "The checkout has {n} files with local changes. Commit or discard them on the host first.");
    case "detached":
      return t("The checkout is not on a branch. Check out a branch on the host first.");
    case "diverged":
      return t("The checkout has commits that origin/main does not have, and origin/main has new ones, so it cannot move straight to it. Rebase or merge on the host first.");
    case "restart":
      return t("The portal runs as a systemd service that is not set to start again after it ends, so it would not come back after the update. Set Restart=on-failure (or Restart=always) in its unit, then update again.");
    default:
      return `${t("origin/main could not be fetched.")} ${p.message.replace(/^Could not fetch origin\/main: /, "")}`.trim();
  }
}

/** A refusal when the update was asked to start, in the page's words. */
const refusal = (e: ApiError): string => {
  switch (e.body.code) {
    case "busy":
      return t("An update is already running.");
    case "moved":
      return t("origin/main has moved on since it was looked at. Try again.");
    case "current":
      return t("The portal is up to date.");
    case "invalid":
      return e.message;
    case "restarting":
      return t("The portal is already restarting.");
    case "unavailable":
      return t("This portal does not run from a git checkout, so it cannot update itself.");
    default:
      return e.message;
  }
};

export type UpdateOutcome =
  | { kind: "started" }
  | { kind: "cancelled" }
  /** Said in the page's words, and not as an error that something broke. */
  | { kind: "stopped"; text: string };

/**
 * The Update button: asks the remote what is new, says what would happen and what stands in the way, asks, and
 * starts. Nothing is changed before the question is answered yes.
 */
export async function updatePortal(): Promise<UpdateOutcome> {
  let check: UpdateCheck;
  try {
    check = await api.checkUpdate();
  } catch (e) {
    return { kind: "stopped", text: e instanceof ApiError && e.body.code ? refusal(e) : (e as Error).message };
  }
  if (check.problem) return { kind: "stopped", text: problemText(check.problem, check.changed) };
  const rebuild = check.rebuild;
  if (!check.target || (check.behind === 0 && !rebuild)) return { kind: "stopped", text: t("The portal is up to date.") };

  const parts = [
    rebuild && check.behind === 0
      ? t("The build is not of the commit that is checked out, most likely because a build failed. This builds it again: {commit}.", { commit: commitLabel(check.current) })
      : tp(check.behind, "{n} new commit on main:", "{n} new commits on main:") + `\n${commitLabel(check.current)}\n→ ${commitLabel(check.target)}`,
    t("The portal downloads and builds the new version and restarts. It is away for a minute or two, and this page loads again when it is back."),
  ];
  if (check.running > 0) {
    parts.push(
      tp(
        check.running,
        "{n} chat or routine is running. The restart stops it; it can be carried on afterwards by sending a message.",
        "{n} chats or routines are running. The restart stops them; they can be carried on afterwards by sending a message.",
      ),
    );
  }
  if (!(await confirmDialog({ title: t("Update the portal?"), message: parts.join("\n\n"), confirmLabel: t("Update and restart") }))) return { kind: "cancelled" };

  try {
    await api.startUpdate(check.target.sha);
  } catch (e) {
    return { kind: "stopped", text: e instanceof ApiError ? refusal(e) : (e as Error).message };
  }
  await updateNow();
  return { kind: "started" };
}
