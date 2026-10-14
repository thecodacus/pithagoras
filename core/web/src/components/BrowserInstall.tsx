import { useEffect, useRef, useState } from "react";
import { LuRefreshCw, LuTrash2 } from "react-icons/lu";
import { api, type BrowserStatus } from "../api";
import { t } from "../i18n";

/**
 * Getting the agent's browser, and starting, stopping and removing it: what the
 * Browser page and Settings → Add-ons both offer. It was written twice and the
 * copies drifted: only one guarded a second click (a second 4.6 GB download),
 * only one showed the download or what went wrong with it.
 *
 * Whether the agent is wired to the browser is the portal's to decide when it is
 * installed or removed, so nothing here does it.
 *
 * `lifecycle` also offers Stop and Remove for a browser that is running.
 */
export function BrowserInstall({
  status,
  reload,
  onError,
  lifecycle,
}: {
  status: BrowserStatus;
  reload: () => Promise<unknown>;
  /** An empty message takes back the last one: what was said of an action that went before is not said of this one. */
  onError: (message: string) => void;
  lifecycle?: boolean;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const i = status.install;
  const installed = i.container === "running" || i.container === "stopped";
  // A pull takes minutes, and may have been started from the other page or by another tab: it is followed all the same.
  const working = busy || i.pulling.active;
  const latest = useRef(reload);
  latest.current = reload;
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void latest.current(), 2000);
    return () => clearInterval(timer);
  }, [working]);

  if (!i.available) return null;
  const dockerMode = i.mode === "docker";
  const needsPassword = dockerMode && !status.config.hasPassword && !installed;

  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    onError("");
    try {
      await fn();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      await Promise.resolve(reload()).catch(() => {});
      setBusy(false);
    }
  };
  const stopped = i.container === "stopped";
  const btn = "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition disabled:opacity-40";
  const quiet = `${btn} bg-fg/5 text-fg-muted hover:bg-fg/10`;

  return (
    <>
      {needsPassword && (
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("a password for its web UI")}
            aria-label={t("a password for its web UI")}
            className="min-w-[12rem] flex-1 rounded-lg border border-line bg-raised/60 px-2 py-1.5 text-xs outline-none focus:border-accent/60"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              onError("");
              api.suggestBrowserPassword().then((r) => setPassword(r.password), (e) => onError((e as Error).message));
            }}
            className="rounded-lg bg-fg/5 px-2.5 py-1.5 text-[11px] text-fg-muted transition hover:bg-fg/10 disabled:opacity-40"
          >
            {t("Suggest one")}
          </button>
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        {!installed && (
          <button
            type="button"
            disabled={working || (needsPassword && !password.trim())}
            onClick={() =>
              act(async () => {
                if (password.trim()) await api.setBrowserConfig({ password: password.trim() });
                await api.installBrowser();
              })
            }
            className={`${btn} bg-accent/12 text-accent ring-1 ring-inset ring-accent/25 hover:bg-accent/20`}
          >
            {working && <LuRefreshCw aria-hidden className="h-3.5 w-3.5 animate-spin" />}
            {i.image || !dockerMode ? t("Install") : t("Install (downloads 4.6GB)")}
          </button>
        )}
        {stopped && (
          <button type="button" disabled={working} onClick={() => act(() => api.startBrowser())} className={`${btn} bg-accent/12 text-accent ring-1 ring-inset ring-accent/25 hover:bg-accent/20`}>
            {t("Start it")}
          </button>
        )}
        {i.container === "running" && lifecycle && (
          <button type="button" disabled={working} onClick={() => act(() => api.stopBrowser())} className={quiet}>
            {t("Stop")}
          </button>
        )}
        {installed && (lifecycle || stopped) && (
          <button type="button" disabled={working} onClick={() => act(() => api.removeBrowser(false))} className={`${quiet} hover:bg-danger/10 hover:text-danger`}>
            <LuTrash2 aria-hidden className="h-3.5 w-3.5" /> {t("Remove")}
          </button>
        )}
      </div>

      {i.pulling.active && <p className="mt-2 font-mono text-[11px] text-fg-faint">{i.pulling.line}</p>}
      {i.pulling.error && (
        <p role="alert" className="mt-2 text-[11px] text-danger">
          {i.pulling.error}
        </p>
      )}
    </>
  );
}
