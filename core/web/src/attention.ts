import type { SessionStatus } from "./api";
import { t } from "./i18n";

export const APP_NAME = "Pithagoras";

/**
 * What the browser tab says, for someone who is looking at another one.
 *
 * A run can take minutes and the tab strip is all that is seen of it meanwhile:
 * a title that never changes gives no way to tell "still working" from
 * "finished" from "waiting for me" without switching to look.
 */
export function tabTitle(
  session: { title: string; status: SessionStatus } | null,
  waiting: boolean,
): string {
  if (!session) return APP_NAME;
  const name = session.title.trim() || t("New chat");
  if (waiting) return `❓ ${t("{name} · asks you", { name })}`;
  if (session.status === "running") return `● ${t("{name} · working", { name })}`;
  return `${name} · ${APP_NAME}`;
}

/**
 * The chats that stopped working since `before` was taken: they were running,
 * and now are idle or failed. A chat not seen before is not one — when the page
 * opens, everything already running would otherwise announce itself as news —
 * and neither is one an outage left `interrupted`, which nobody finished.
 */
export function finishedRuns<S extends { id: string; status: SessionStatus }>(
  before: ReadonlyMap<string, SessionStatus>,
  now: readonly S[],
): S[] {
  return now.filter(
    (s) => before.get(s.id) === "running" && (s.status === "idle" || s.status === "error"),
  );
}
