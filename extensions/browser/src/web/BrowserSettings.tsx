import { useEffect, useState } from "react";
import { LuCheck, LuGlobe, LuRefreshCw } from "react-icons/lu";
import { BrowserInstall } from "./BrowserInstall";
import { api, type BrowserState } from "./api";
import { publish } from "./state";
import { portal, t } from "../portal";

/**
 * Browser's page in Settings: getting the browser, and starting, stopping and
 * removing it, which is where it is found before it exists. Its own page, in
 * the sidebar once there is something to show, is where it is watched and
 * where who may drive it is said.
 */
export function BrowserSettings() {
  portal.locale.use();
  const { ui } = portal;
  const [status, setStatus] = useState<BrowserState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Before the first read there is no page to put the error on, so the page says it; a read that fails later goes to the banner.
  const load = () =>
    api
      .state()
      .then((s) => {
        setFailed(null);
        setStatus(s);
        publish(s);
      })
      .catch((e) => {
        if (status) setError((e as Error).message);
        else setFailed((e as Error).message);
      });

  useEffect(() => {
    load();
  }, []);

  if (!status) {
    if (failed) return <ui.LoadFailed error={failed} onRetry={load} />;
    return (
      <p className="flex items-center gap-2 text-sm text-fg-subtle">
        <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> {t("Loading…")}
      </p>
    );
  }

  const i = status.install;
  const installed = i.container === "running" || i.container === "stopped";
  const dockerMode = i.mode === "docker";

  return (
    <>
      {error && (
        <ui.ErrorBanner className="mb-4" onClose={() => setError(null)}>
          {error}
        </ui.ErrorBanner>
      )}
      <div className="rounded-xl border border-line bg-raised/40 p-3">
        <div className="flex items-start gap-2.5">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
            <LuGlobe className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="text-sm text-fg">{t("Browser")}</p>
              {installed && (
                <span className="inline-flex items-center gap-1 text-[11px] text-ok">
                  <LuCheck className="h-3 w-3" />
                  {i.container === "running" ? t("running") : t("installed")}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[11px] text-fg-faint">
              {t("A real browser with a profile that stays logged in. Sign into it once; the agent drives the same one afterwards and never handles a password.")}
            </p>

            {!i.available && (
              <p className="mt-2 text-[11px] text-warn">
                {t("Not possible here — the portal cannot reach Docker and there is no Chrome on the machine.")}
              </p>
            )}

            {i.available && !installed && (
              <p className="mt-2 text-[11px] text-fg-faint">
                {dockerMode
                  ? i.image
                    ? t("Runs as its own container. The image is already downloaded.")
                    : t("Runs as its own container. Installing downloads its image, a few GB.")
                  : t("Uses the Chrome on this machine ({binary}).", { binary: i.binary ?? "" })}
              </p>
            )}
          </div>
        </div>

        <div className="mt-1">
          <BrowserInstall status={status} reload={load} onError={(message) => setError(message || null)} lifecycle />
        </div>
        {installed && (
          <p className="mt-2 text-[11px] text-fg-faint">
            {t("Removing keeps the profile, so its logins are still there if you install it again.")}
          </p>
        )}
      </div>
    </>
  );
}
