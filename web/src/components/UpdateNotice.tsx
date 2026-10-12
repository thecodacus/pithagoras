import { useEffect, useState } from "react";
import { LuCircleArrowUp, LuX } from "react-icons/lu";
import { notifyIfAway } from "../notify";
import { dismissNotice, failureText, firstTimeTold, noticeDismissed, STEP_LABELS, updatePortal, useUpdate } from "../update";
import { t, tp } from "../i18n";
import { ghostCls, primarySmCls } from "./SettingsUi";

/**
 * The line at the top of the page that says new commits are on main, with the Update button; and, while an update
 * runs, how far it has got. Nothing is drawn where the portal cannot update itself (a container's, one that is not a
 * checkout), or when there is nothing new, or when the person put this target away: the next one brings it back.
 *
 * The browser is told as well, once for each new target and only when notifications are on and nobody is looking
 * (see notify.ts); the notification opens the update in Settings.
 */
export function UpdateNotice({ onDetails }: { onDetails: () => void }) {
  const { status, lost } = useUpdate();
  const [said, setSaid] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const notice = status?.kind === "git" ? status.notice : null;
  const sha = notice?.target.sha;

  useEffect(() => {
    if (!notice || !sha || !firstTimeTold(sha)) return;
    notifyIfAway(t("Update available"), tp(notice.count, "{n} new commit on main, update available", "{n} new commits on main, update available"), `update-${sha}`, onDetails);
    // Once for each target: a count that grows is not another notice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sha]);

  if (status?.kind !== "git") return null;
  const run = status.run;

  if ((run || lost) && !(run?.state === "failed" && noticeDismissed(run.startedAt))) {
    const step = run?.steps.find((s) => s.state === "running" || s.state === "failed");
    return (
      <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-accent/10 px-4 py-2 text-sm text-fg">
        <LuCircleArrowUp aria-hidden className="h-4 w-4 shrink-0 text-accent" />
        <span className="min-w-0 flex-1">
          {lost
            ? t("The portal has not come back after three minutes. Look at its log on the host.")
            : run?.state === "failed" && run.failed
              ? failureText(run.failed)
              : run?.state === "restarting"
                ? t("The portal is restarting. This page loads again when it is back.")
                : t("Updating the portal: {step}", { step: step ? t(STEP_LABELS[step.id]) : "" })}
        </span>
        <button type="button" onClick={onDetails} className={ghostCls}>{t("Details")}</button>
        {/* A failure stays until the next update, which may be long: it can be put away. */}
        {run?.state === "failed" && <DismissButton onClick={() => dismissNotice(run.startedAt)} />}
      </div>
    );
  }

  if (!notice || noticeDismissed(notice.target.sha)) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-accent/10 px-4 py-2 text-sm text-fg">
      <LuCircleArrowUp aria-hidden className="h-4 w-4 shrink-0 text-accent" />
      <span className="min-w-0 flex-1">
        {tp(notice.count, "{n} new commit on main, update available", "{n} new commits on main, update available")}
        {said && <span className="ml-2 text-warn">{said}</span>}
      </span>
      <button
        type="button"
        disabled={asking}
        className={primarySmCls}
        onClick={async () => {
          setAsking(true);
          setSaid(null);
          try {
            const out = await updatePortal();
            if (out.kind === "stopped") setSaid(out.text);
          } finally {
            setAsking(false);
          }
        }}
      >
        {t("Update")}
      </button>
      <button type="button" onClick={onDetails} className={ghostCls}>{t("Details")}</button>
      <DismissButton onClick={() => dismissNotice(notice.target.sha)} />
    </div>
  );
}

function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={t("Dismiss")} title={t("Dismiss")} className="shrink-0 rounded p-1 text-fg-muted hover:bg-fg/5 hover:text-fg">
      <LuX aria-hidden className="h-4 w-4" />
    </button>
  );
}
