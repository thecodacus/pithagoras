import { useEffect, useState } from "react";
import { api, type RestartStatus } from "../api";
import { restartPortal, restartRefusal, updatingText, waitForPortal, whatRestartBrought, type Brought } from "../restart";
import { useUpdate } from "../update";
import { t } from "../i18n";
import { ErrorBanner, Section, WarnBanner, primaryCls } from "./SettingsUi";

type Phase = "idle" | "asking" | "waiting" | "lost";

/**
 * Settings → About → Restart: ends the portal and has whatever runs it start it again, so that nobody has to log in
 * to the host for a new extension or a setting that needs a fresh start. Where nothing would start it again, the
 * button is off and the section says why.
 */
export function RestartSection() {
  const [status, setStatus] = useState<RestartStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [said, setSaid] = useState<string | null>(null);
  const [brought, setBrought] = useState<Brought | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    api.restartStatus().then((s) => live && setStatus(s), (e: Error) => live && setFailed(e.message));
    void whatRestartBrought().then((b) => live && setBrought(b));
    return () => {
      live = false;
    };
  }, []);

  // The update has moved the files the portal starts from aside: a stop now would leave it without them.
  const { status: update } = useUpdate();
  const updating = update?.run?.state === "running" || update?.run?.state === "restarting";
  const busy = phase !== "idle" || updating;
  return (
    <Section title={t("Restart")} hint={t("Stops the portal and starts it again, for a new extension or a setting that needs a fresh start. Nothing happens until you have confirmed.")}>
      {brought !== undefined && brought !== null && (
        <p role="status" className="mb-3 text-sm text-fg-muted">
          {t("The portal restarted.")}{" "}
          {brought.added.length > 0 && <>{t("Extensions added: {names}", { names: brought.added.join(", ") })} </>}
          {brought.removed.length > 0 && <>{t("Extensions removed: {names}", { names: brought.removed.join(", ") })} </>}
          {brought.known && brought.added.length === 0 && brought.removed.length === 0 && t("The extensions it runs are as before.")}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={primaryCls}
          disabled={busy || !status?.possible}
          onClick={async () => {
            setPhase("asking");
            setSaid(null);
            setBrought(undefined);
            const out = await restartPortal();
            if (out.kind !== "started") {
              setPhase("idle");
              if (out.kind === "stopped") setSaid(out.text);
              return;
            }
            setPhase("waiting");
            // The page is loaded again as soon as the portal answers; only a portal that stays away gets here.
            if ((await waitForPortal(out.boot)) === "lost") setPhase("lost");
          }}
        >
          {t("Restart")}
        </button>
      </div>
      {failed && <ErrorBanner className="mt-3">{failed}</ErrorBanner>}
      {status && !status.possible && !updating && <WarnBanner className="mt-3">{restartRefusal(status)}</WarnBanner>}
      {updating && <WarnBanner className="mt-3">{updatingText()}</WarnBanner>}
      {said && <WarnBanner className="mt-3">{said}</WarnBanner>}
      {phase === "waiting" && <p role="status" className="mt-3 text-sm text-fg-muted">{t("The portal is restarting. This page loads again when it is back.")}</p>}
      {phase === "lost" && <ErrorBanner className="mt-3">{t("The portal has not come back after three minutes. Look at its log on the host.")}</ErrorBanner>}
    </Section>
  );
}
