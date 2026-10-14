import { VoiceAddon } from "./VoiceAddon";
import { MemoryAddon, SubagentAddon } from "./FeatureAddons";
import { useEffect, useId, useState } from "react";
import { LuBot, LuBrain, LuCheck, LuGlobe, LuMic, LuRefreshCw } from "react-icons/lu";
import { api, type BrowserStatus } from "../api";
import { BrowserInstall } from "./BrowserInstall";
import { LoadFailed } from "./SettingsUi";
import { msg, t } from "../i18n";
import { tabKeys } from "../tab-keys";

/** The add-ons, in the order they are listed. */
const addons = [
  { id: 'browser', label: msg('Browser'), Icon: LuGlobe },
  { id: 'voice', label: msg('Voice'), Icon: LuMic },
  { id: 'subagents', label: msg('Subagents'), Icon: LuBot },
  { id: 'memory', label: msg('Memory'), Icon: LuBrain },
] as const;
type Addon = typeof addons[number]['id'];

/**
 * Optional pieces of the portal itself, as opposed to pi's packages.
 *
 * This is where an add-on is found before it exists. Its own page appears in
 * the sidebar once installed, which is the right place to live and the wrong
 * place to be discovered from — nothing was visible until it was already
 * running, so there was nowhere to press install.
 */
export function PortalExtensions({ onError }: { onError: (e: string) => void }) {
  const id = useId();
  const [selected, setSelected] = useState<Addon>('browser');
  const [visited, setVisited] = useState<Addon[]>(['browser']);
  const select = (addon: Addon) => {
    setSelected(addon);
    setVisited(previous => previous.includes(addon) ? previous : [...previous, addon]);
  };
  return <div>
    <p className="mb-4 text-xs text-fg-muted">{t("Install and manage the add-ons for your sessions.")}</p>
    <div role="tablist" aria-label={t("Add-ons")} onKeyDown={tabKeys} className="flex gap-1 rounded-xl border border-line bg-raised/40 p-1">
      {addons.map(({ id: addon, label, Icon }) => <button
        key={addon} id={`${id}-${addon}-tab`} type="button" role="tab"
        aria-selected={selected === addon} aria-controls={`${id}-${addon}-panel`}
        tabIndex={selected === addon ? 0 : -1} onClick={() => select(addon)}
        className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-2 sm:gap-2 sm:px-4 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${selected === addon ? 'bg-accent/12 text-accent shadow-sm ring-1 ring-inset ring-accent/25' : 'text-fg-muted hover:bg-fg/5 hover:text-fg'}`}
      ><Icon className="hidden h-4 w-4 shrink-0 sm:block" />{t(label)}</button>)}
    </div>
    {addons.map(({ id: addon }) => <div key={addon} role="tabpanel" id={`${id}-${addon}-panel`}
      aria-labelledby={`${id}-${addon}-tab`} hidden={selected !== addon}>
      {visited.includes(addon) && (addon === 'browser' ? <BrowserAddon onError={onError} />
        : addon === 'voice' ? <VoiceAddon onError={onError} />
        : addon === 'subagents' ? <SubagentAddon onError={onError} />
        : <MemoryAddon onError={onError} />)}
    </div>)}
  </div>;
}

function BrowserAddon({ onError }: { onError: (e: string) => void }) {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  // Before the first read there is no page to put the error on, so the page says it; a poll that fails later goes to the banner.
  const load = () =>
    api
      .browser()
      .then((s) => {
        setFailed(null);
        setStatus(s);
      })
      .catch((e) => {
        if (status) onError((e as Error).message);
        else setFailed((e as Error).message);
      });

  useEffect(() => {
    load();
  }, []);

  if (!status) {
    if (failed) return <LoadFailed error={failed} onRetry={load} />;
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
      <div className="mt-4 rounded-xl border border-line bg-raised/40 p-3">
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
                    : t("Runs as its own container. Installing downloads a 4.6GB image.")
                  : t("Uses the Chrome on this machine ({binary}).", { binary: i.binary ?? "" })}
              </p>
            )}
          </div>
        </div>

        <div className="mt-1">
          <BrowserInstall status={status} reload={load} onError={onError} lifecycle />
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
