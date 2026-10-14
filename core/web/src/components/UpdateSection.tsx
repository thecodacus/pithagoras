import { useEffect, useRef, useState, type ReactNode } from "react";
import { LuCheck, LuCircleDashed, LuCircleX, LuGitBranch, LuLoaderCircle, LuMinus } from "react-icons/lu";
import { api, type UpdateRun } from "../api";
import { commitLabel, failureText, STEP_LABELS, updateNow, updatePortal, useUpdate } from "../update";
import { formatDateTime, msg, t, tp } from "../i18n";
import { ErrorBanner, Section, WarnBanner, primaryCls } from "./SettingsUi";

const STATE_ICON: Record<UpdateRun["steps"][number]["state"], ReactNode> = {
  done: <LuCheck className="text-ok" />,
  running: <LuLoaderCircle className="animate-spin text-accent" />,
  failed: <LuCircleX className="text-danger" />,
  skipped: <LuMinus className="text-fg-faint" />,
  pending: <LuCircleDashed className="text-fg-faint" />,
};
const STATE_WORD: Record<UpdateRun["steps"][number]["state"], string> = {
  done: msg("Done"),
  running: msg("Running"),
  failed: msg("Failed"),
  skipped: msg("Skipped"),
  pending: msg("Waiting"),
};

/**
 * Settings → About → Update: pulls the newest main of the portal's checkout, builds it and restarts the portal.
 * Hidden where the portal is not run from a checkout; in a container it says how to update the image instead.
 */
export function UpdateSection() {
  const { status, lost } = useUpdate();
  const [checking, setChecking] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const looked = useRef(false);

  // The page opening is a look at origin/main, the way the portal's own schedule does it: quietly, whatever comes of it.
  useEffect(() => {
    if (status?.kind !== "git" || looked.current) return;
    looked.current = true;
    api.checkUpdate().then(updateNow, () => {});
  }, [status?.kind]);

  if (!status || status.kind === "none") return null;

  if (status.kind === "container") {
    return (
      <Section title={t("Update")} hint={t("This portal runs in a Docker container, which cannot rebuild itself. It is updated from outside, by building its image again.")}>
        <div className="rounded-xl border border-line bg-raised/40 px-3 py-2.5 text-sm text-fg-muted">
          <p>{t("From a checkout of the repository, on the host:")}</p>
          <pre className="mt-1.5 overflow-x-auto rounded-lg bg-fg/5 px-2.5 py-1.5 font-mono text-xs text-fg"><code>git pull &amp;&amp; docker compose up -d --build</code></pre>
          <p className="mt-1.5 text-xs text-fg-subtle">{t("A stack in Portainer is updated by pulling its image again. The deploying guide has the details.")}</p>
        </div>
      </Section>
    );
  }

  if (status.kind === "dev") {
    return (
      <Section title={t("Update")} hint={t("This portal runs from its source files under a file watcher (npm run dev:server). The watcher restarts it as soon as an update changes the files, halfway through the update, so there is no Update button here.")}>
        <div className="rounded-xl border border-line bg-raised/40 px-3 py-2.5 text-sm text-fg-muted">
          <p>{t("Pull on the host, or run the built portal to update it from here:")}</p>
          <pre className="mt-1.5 overflow-x-auto rounded-lg bg-fg/5 px-2.5 py-1.5 font-mono text-xs text-fg"><code>npm run build &amp;&amp; npm start</code></pre>
        </div>
      </Section>
    );
  }

  const run = status.run;
  const active = run?.state === "running" || run?.state === "restarting";
  const current = status.current;
  return (
    <Section title={t("Update")} hint={t("Pulls the newest main of this portal's checkout, builds it and restarts the portal. Nothing changes until you have confirmed.")}>
      <dl className="overflow-hidden rounded-xl border border-line bg-raised/40">
        <div className="flex items-start gap-3 px-3 py-2.5">
          <span className="mt-0.5 text-fg-faint [&>svg]:h-4 [&>svg]:w-4"><LuGitBranch /></span>
          <div className="min-w-0 flex-1">
            <dt className="text-xs text-fg-subtle">{t("Checked out")}</dt>
            <dd className="truncate text-sm text-fg" title={current ? commitLabel(current) : ""}>
              {status.branch ?? t("no branch")}
              {current && <> · <span className="font-mono text-xs">{current.sha.slice(0, 7)}</span> {current.subject}</>}
            </dd>
            {current?.date && <p className="text-[11px] text-fg-faint">{formatDateTime(current.date)}</p>}
          </div>
        </div>
      </dl>

      {/* While an update runs, the steps below say where it is: its merge has the build pending, which is no failure. */}
      {!active && (
        <p className="mt-3 text-sm text-fg-muted">
          {status.notice
            ? tp(status.notice.count, "{n} new commit on main, update available", "{n} new commits on main, update available")
            : status.rebuild
              ? t("The build is not of the commit that is checked out, most likely because a build failed. Update builds it again.")
              : t("Nothing new on main when it was last looked at.")}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={primaryCls}
          disabled={checking || active}
          onClick={async () => {
            setChecking(true);
            setSaid(null);
            try {
              const out = await updatePortal();
              if (out.kind === "stopped") setSaid(out.text);
            } finally {
              setChecking(false);
            }
          }}
        >
          {t("Update")}
        </button>
        {checking && <span className="text-xs text-fg-subtle">{t("Asking origin for what is new…")}</span>}
      </div>
      {said && <WarnBanner className="mt-3">{said}</WarnBanner>}

      {run && (
        <div className="mt-4">
          <p className="text-xs text-fg-subtle">{t("Updating from {from} to {to}", { from: commitLabel(run.from), to: commitLabel(run.to) })}</p>
          <ol aria-label={t("Update progress")} className="mt-2 space-y-1.5">
            {run.steps.map((s) => (
              <li key={s.id} data-state={s.state} className="flex items-center gap-2 text-sm text-fg">
                <span aria-hidden className="[&>svg]:h-4 [&>svg]:w-4">{STATE_ICON[s.state]}</span>
                <span className={s.state === "pending" || s.state === "skipped" ? "text-fg-subtle" : ""}>{t(STEP_LABELS[s.id])}</span>
                <span className="sr-only">{t(STATE_WORD[s.state])}</span>
              </li>
            ))}
          </ol>
          {run.state === "restarting" && !lost && <p role="status" className="mt-3 text-sm text-fg-muted">{t("The portal is restarting. This page loads again when it is back.")}</p>}
          {lost && <ErrorBanner className="mt-3">{t("The portal has not come back after three minutes. Look at its log on the host.")}</ErrorBanner>}
          {run.failed && (
            <ErrorBanner className="mt-3">
              <span className="block">{failureText(run.failed)}</span>
              <span className="mt-1 block text-xs opacity-80">{run.failed.message}</span>
              {run.failed.output && <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-fg/5 p-2 font-mono text-[11px] leading-snug text-fg-muted">{run.failed.output}</pre>}
            </ErrorBanner>
          )}
        </div>
      )}
    </Section>
  );
}
