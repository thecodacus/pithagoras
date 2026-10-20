import { useEffect, useRef, useState } from "react";
import {
  LuCircleAlert,
  LuExternalLink,
  LuGlobe,
  LuMaximize,
  LuMonitor,
  LuRefreshCw,
  LuShieldCheck,
} from "react-icons/lu";
import { BrowserInstall } from "./BrowserInstall";
import { api, type BrowserState } from "./api";
import { publish } from "./state";
import { pollWhileVisible } from "./poll";
import { Link, msg, portal, t, tx } from "../portal";

/** What kind of conversation allowed or refused the browser, as the portal names it. */
const SESSION_KIND: Record<string, string> = {
  task: msg("task"),
  agent: msg("agent"),
  routine: msg("routine"),
  heartbeat: msg("heartbeat"),
};

/** Settings → Guard, where the sites every tool may reach are listed. */
const GUARD = "/settings/guard";

/**
 * The agent's browser.
 *
 * A real one, in its own container, with a profile that stays signed in. You
 * log into it once by hand through the link here; every run after that finds
 * the accounts already there, and no password ever reaches the model.
 */
export function BrowserPage() {
  portal.locale.use();
  const { ui } = portal;
  const [status, setStatus] = useState<BrowserState | null>(null);
  // What a button was refused, kept until the next press; and what the poll could not read, which is only true
  // until the next poll that can. Two messages, so that a poll that works does not take back one nobody read yet.
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const frameWrap = useRef<HTMLDivElement>(null);

  const load = () =>
    api
      .state()
      .then((s) => {
        setStatus(s);
        setLoadError(null);
        publish(s);
      })
      .catch((e) => setLoadError((e as Error).message));

  useEffect(() => {
    load();
    return pollWhileVisible(load, 8000);
  }, []);

  if (!status) {
    return (
      <div className="h-full overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-3xl">
          {loadError ? (
            <ui.LoadFailed error={loadError} onRetry={load} />
          ) : (
            <p className="flex items-center gap-2 text-sm text-fg-subtle">
              <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> {t("Loading…")}
            </p>
          )}
        </div>
      </div>
    );
  }

  // Built here rather than server-side: the portal does not reliably know what
  // hostname you reached it on, and the browser you are reading this in does.
  // A frame is only a secure context if every ancestor is one, so over plain
  // HTTP the client refuses to start whichever route it is reached by.
  const embeddable = window.isSecureContext;

  // Through the portal when that is secure — one certificate, one password, and
  // the frame inherits the context. Otherwise straight at the browser's own
  // HTTPS port, which is a secure context on its own — if that port is open to
  // other machines, which it is not unless someone chose it. Pointing the
  // fallback at the proxy would have offered a link to the same dead end.
  const proxyUrl = api.uiUrl();
  const guardLink = (
    <Link to={GUARD} className="text-accent hover:underline">
      {t("Settings → Guard")}
    </Link>
  );
  const uiUrl = embeddable
    ? proxyUrl
    : status.uiExposed
      ? `https://${window.location.hostname}:${status.uiPort}/`
      : null;

  return (
    <div className="h-full overflow-y-auto px-4 py-6">
      <div className="mx-auto w-full max-w-3xl">
        {(error || loadError) && (
          <ui.ErrorBanner className="mb-4" onClose={error ? () => setError(null) : undefined}>
            {error || loadError}
          </ui.ErrorBanner>
        )}

        <InstallPanel status={status} reload={load} onError={(message) => setError(message || null)} />

        <ui.PageHeader
          icon={<LuGlobe />}
          title={t("Browser")}
          className="mb-5"
          description={
            <>
              {t("A real browser with a profile that stays logged in. Sign into it once here; every run after that finds the accounts already there, and no password reaches the model.")}
            </>
          }
        >
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs ${
                status.running ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn"
              }`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              {status.running ? (status.version ?? t("running")) : t("not running")}
            </span>
            {embeddable && (
              <button
                onClick={() => setShown((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent/12 px-3 py-1.5 text-xs text-accent ring-1 ring-inset ring-accent/25 transition hover:bg-accent/20"
              >
                <LuMonitor className="h-3.5 w-3.5" /> {shown ? t("Hide browser") : t("Open browser")}
              </button>
            )}
            {status.install.container === "running" && (
              <button
                onClick={() => act(() => api.stop())}
                className="inline-flex items-center gap-1.5 rounded-lg bg-fg/5 px-3 py-1.5 text-xs text-fg-muted transition hover:bg-fg/10"
              >
                {t("Stop")}
              </button>
            )}
            {uiUrl && (
              <a
                href={uiUrl}
                target="_blank"
                rel="noreferrer"
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition ${
                  embeddable
                    ? "bg-fg/5 text-fg-muted hover:bg-fg/10"
                    : "bg-accent/12 text-accent ring-1 ring-inset ring-accent/25 hover:bg-accent/20"
                }`}
              >
                <LuExternalLink className="h-3.5 w-3.5" />
                {embeddable ? t("New tab") : t("Open browser")}
              </a>
            )}
          </div>
        </ui.PageHeader>

        {/* Two failures that each look fine on their own: a browser nobody can
            drive, and tools pointing at a browser that is gone. */}
        {status.running && !status.connected && (
          <div className="mb-5 flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/10 p-3 text-xs text-fg-muted">
            <LuCircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
            <span className="flex-1">
              {t("The browser is running but the agent has no way to reach it. Connecting gives the agent the browser tools, which read only what is on screen and answer each action with what it changed.")}
            </span>
            <button
              onClick={() => act(() => api.connect())}
              className="shrink-0 rounded-lg bg-accent/12 px-2.5 py-1 text-[11px] text-accent ring-1 ring-inset ring-accent/25 transition hover:bg-accent/20"
            >
              {t("Connect the agent")}
            </button>
          </div>
        )}

        {!status.running && status.connected && (
          <div className="mb-5 flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/10 p-3 text-xs text-fg-muted">
            <LuCircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
            <span className="flex-1">
              {t("The agent still holds the browser tools for a browser that is not running. They will fail when it reaches for one.")}
            </span>
            <button
              onClick={() => act(() => api.disconnect())}
              className="shrink-0 rounded-lg bg-fg/5 px-2.5 py-1 text-[11px] text-fg-muted transition hover:bg-fg/10"
            >
              {t("Disconnect")}
            </button>
          </div>
        )}

        {status.uiOutdated && (
          <div className="mb-5 flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/10 p-3 text-xs text-fg-muted">
            <LuCircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
            <span>
              {t("This browser was installed before its own port was kept to this machine, so it still answers on every network interface. Remove it and install it again to close that; the profile and its logins stay.")}
            </span>
          </div>
        )}

        {status.unprotected && (
          <div className="mb-5 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-fg-muted">
            <LuCircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            <span>
              <strong className="text-danger">{t("This browser has no password.")}</strong>{" "}
              {status.install.mode === "external"
                ? t("Anyone who can reach it drives a browser signed into the agent's accounts. Give it a password where it is run.")
                : t("Anyone who can reach it drives a browser signed into the agent's accounts. Remove it and install it again with a password; the profile and its logins stay.")}
            </span>
          </div>
        )}

        {!embeddable && (
          <div className="mb-5 flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/10 p-3 text-xs text-fg-muted">
            <LuCircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
            <span>
              {t("The portal is on plain HTTP, so the browser cannot be embedded — a frame only counts as secure when every page above it does.")}{" "}
              {uiUrl
                ? tx("{open} still works: it goes straight to the browser's own HTTPS port, which is secure on its own. Give the portal a certificate and it embeds here instead.", { open: <strong>{t("Open browser")}</strong> })
                : tx("The browser's own port answers this machine only, so there is no link to it from here. Give the portal a certificate and it embeds here; {name} opens the port to other machines.", { name: <span className="font-mono">BROWSER_BIND</span> })}
            </span>
          </div>
        )}

        {shown && embeddable && (
          <section className="mb-6">
            <div
                ref={frameWrap}
                // The height lives on the wrapper so fullscreen can override
                // it. On the iframe it stayed at 32rem and left the bottom of
                // the screen black.
                className="browser-power relative h-[32rem] overflow-hidden rounded-xl border border-line bg-black [&:fullscreen]:h-screen [&:fullscreen]:rounded-none [&:fullscreen]:border-0"
              >
                <iframe
                  src={proxyUrl}
                  title={t("The agent's browser")}
                  className="h-full w-full border-0"
                  // The VNC client wants the keyboard and the clipboard.
                  allow="clipboard-read; clipboard-write; fullscreen"
                />
                <button
                  onClick={() => frameWrap.current?.requestFullscreen?.()}
                  className="absolute right-2 top-2 rounded-lg bg-canvas/80 px-2 py-1 text-[11px] text-fg-muted backdrop-blur transition hover:text-fg"
                >
                  <LuMaximize className="mr-1 inline h-3 w-3" /> {t("Fullscreen")}
                </button>
              </div>
          </section>
        )}

        <section className="mb-6">
          <ui.SwitchRow
            title={t("Show the agent's cursor")}
            detail={t("Before each click, typed text or choice, an arrow glides to the element and says what it is about to do, so you can follow along. Off, the actions do not wait for it.")}
            on={status.cursor}
            onChange={(on) => act(() => api.setCursor(on))}
          />
        </section>

        {status.pages.length > 0 && (
          <section className="mb-6">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              {t("Open now")}
            </h3>
            <ul className="space-y-1">
              {status.pages.map((p, i) => (
                <li
                  key={i}
                  className="rounded-xl border border-line bg-raised/40 px-3 py-2"
                >
                  <p className="truncate text-sm text-fg">{p.title || t("Untitled")}</p>
                  <p className="truncate font-mono text-[11px] text-fg-faint">{p.url}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* The list is the guard's, for every tool that says where it goes: it is edited in Settings → Guard, and only said here. */}
        <section className="mb-6">
          <div className="mb-1.5 flex items-center gap-2">
            <LuShieldCheck className="h-3.5 w-3.5 text-fg-faint" />
            <h3 className="text-sm font-medium text-fg">{t("Where it may go")}</h3>
          </div>
          <p className="text-[11px] text-fg-faint">{tx("The sites the browser may reach are the list in {place}, which holds for every tool that says where it goes. An empty list means any site.", { place: guardLink })}</p>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-medium text-fg">{t("Who may drive it")}</h3>
          {/* The default first, because with the browser switched like any
              other package that is the answer for almost every conversation.
              Listing them all would be a list of every chat ever opened. */}
          <p className="mb-2 rounded-xl border border-line bg-raised/40 px-3 py-2 text-xs text-fg-muted">
            {status.byDefault ? (
              <>
                {tx("Every conversation, unless its own tools say otherwise. Switch the browser's tools off in {place} to change that everywhere, or in one chat from the blocks icon beside the composer.", { place: <span className="text-fg">{t("Settings → Tools")}</span> })}
              </>
            ) : (
              <>
                {tx("No conversation, unless its own tools say otherwise. Switch the browser's tools on in {place} to change that everywhere, or in one chat from the blocks icon beside the composer.", { place: <span className="text-fg">{t("Settings → Tools")}</span> })}
              </>
            )}
          </p>
          {status.chats.length === 0 && status.routines.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line px-3 py-5 text-center text-xs text-fg-faint">
              {t("Nothing has said otherwise. A routine gets it on its own page.")}
            </p>
          ) : (
            <ul className="space-y-1">
              {status.chats.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => portal.navigate(`/s/${s.id}`)}
                    className="flex w-full items-center gap-2 rounded-xl border border-line bg-raised/40 px-3 py-2 text-left transition hover:bg-fg/5"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm text-fg">{s.title}</span>
                    <span className="shrink-0 text-[11px] text-fg-faint">
                      {s.allowed ? t("on") : t("off")}
                    </span>
                    <span className="shrink-0 text-[11px] text-fg-faint">{Object.hasOwn(SESSION_KIND, s.kind) ? t(SESSION_KIND[s.kind]) : s.kind}</span>
                  </button>
                </li>
              ))}
              {status.routines.map((r) => (
                <li
                  key={r.slug}
                  className="flex items-center gap-2 rounded-xl border border-line bg-raised/40 px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">{r.name}</span>
                  <span className="shrink-0 text-[11px] text-fg-faint">
                    {r.allowed ? t("on") : t("off")}
                  </span>
                  <span className="shrink-0 text-[11px] text-fg-faint">{t("routine")}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Only for a browser that is supposed to be up: one that was stopped, never installed, or is the machine's own Chrome is not broken. */}
        {!status.running && status.install.mode === "docker" && status.install.container === "running" && (
          <p className="mt-4 flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/10 p-3 text-xs text-fg-muted">
            <LuCircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
            <span>{t("The browser's container is running, but the browser in it is not answering. Stop it and start it again; what it wrote is in Settings → Docker.")}</span>
          </p>
        )}
        {!status.running && status.install.mode === "external" && (
          <p className="mt-4 flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/10 p-3 text-xs text-fg-muted">
            <LuCircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
            <span>{t("The browser is not answering. It is run outside the portal, and is started where it is run.")}</span>
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Getting a browser in the first place.
 *
 * Two ways, and which one you get is not a preference: a container where the
 * portal can reach Docker, the machine's own Chrome where it cannot. Both end
 * at the same place — a profile that stays signed in — so the difference is
 * only stated where it changes what you do.
 */
function InstallPanel({
  status,
  reload,
  onError,
}: {
  status: BrowserState;
  reload: () => Promise<unknown>;
  onError: (message: string) => void;
}) {
  const i = status.install;

  if (i.container === "running") return null;

  if (!i.available) {
    return (
      <div className="mb-5 rounded-xl border border-line bg-raised/40 p-3 text-xs text-fg-muted">
        {t("No browser can run here. The portal cannot reach Docker, and there is no Chrome or Chromium on the machine — install one, or give the portal the Docker socket and it will run a browser in a container.")}
      </div>
    );
  }

  const dockerMode = i.mode === "docker";

  return (
    <div className="mb-5 rounded-xl border border-accent/30 bg-accent/5 p-3">
      <p className="text-sm text-fg">
        {i.container === "stopped" ? t("The browser is installed but stopped") : t("No browser yet")}
      </p>
      <p className="mt-1 text-[11px] text-fg-faint">
        {dockerMode
          ? t("It runs as its own container — nothing is added to the portal, and removing it leaves only the profile.")
          : `${t("Using the Chrome already on this machine ({binary}).", { binary: i.binary ?? "" })}${
              i.headless ? ` ${t("No display here, so it runs headless — some sign-in pages refuse that.")}` : ""
            }`}
      </p>

      <BrowserInstall status={status} reload={reload} onError={onError} />
    </div>
  );
}
