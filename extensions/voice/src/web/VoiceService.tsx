import { useCallback, useEffect, useRef, useState } from "react";
import { sameChoice, type VoiceChoice } from "../engines";
import { VoiceEngines } from "./VoiceEngines";
import { YourVoice } from "./YourVoice";
import { api, type VoiceHardware, type VoiceState } from "./api";
import { pollWhileVisible } from "./poll";
import { msg, portal, t } from "../portal";

/** What the voice service is doing, as its badge says it. */
const INSTALL_STATE: Record<string, string> = {
  unavailable: msg("unavailable"),
  installing: msg("installing"),
  starting: msg("starting"),
  stopped: msg("stopped"),
  failed: msg("failed"),
};

/**
 * What the uninstall asks. The dialog is drawn by the host, away from this page, so the box reports its answer to
 * `removeData`, which the page reads once the dialog is answered. Off: the downloads stay, and a new install is quick.
 */
function UninstallQuestion({ removeData }: { removeData: { current: boolean } }) {
  const [on, setOn] = useState(false);
  return <div className="space-y-3">
    <p>{t("The voice container is stopped and removed. Your voices are kept. Voice mode then has no source until one is chosen.")}</p>
    <label className="flex items-start gap-2 text-fg">
      <input type="checkbox" className="mt-1" checked={on} onChange={e => { setOn(e.target.checked); removeData.current = e.target.checked; }} />
      <span>{t("Also delete the downloaded engines and models")}<span className="mt-1 block text-xs text-fg-muted">{t("Leave it off to keep them, so that installing again is quick. Delete them to free the disk space: the next install downloads and builds them again.")}</span></span>
    </label>
  </div>;
}

/**
 * The voice service's page in Settings: the engines it is built for and the GPU it runs on, installing, starting,
 * stopping and removing it, whether voice mode listens and speaks through it (Use for voice mode, Stop using), its setup
 * log, how it speaks (Your voice, with the voice library), and whether its speech model is let go of once voice mode no
 * longer uses it. Voice mode's other settings are the portal's, in Settings → Defaults → Voice mode.
 */
export function VoiceService() {
  portal.locale.use();
  const { ui } = portal;
  const [failure, setFailure] = useState<string | null>(null);
  const [install, setInstall] = useState<VoiceState | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  // One question at a time, and none for a page that has gone: each asks Docker several things.
  const alive = useRef(true), asking = useRef(false);
  const poll = useCallback(async () => {
    if (asking.current) return;
    asking.current = true;
    try { const state = await api.state(); if (alive.current) setInstall(state); } catch (e) { if (alive.current) setInstall({ available: false, state: 'unavailable', busy: false, progress: '', error: (e as Error).message }); } finally { asking.current = false; }
  }, []);
  useEffect(() => { alive.current = true; void poll(); return () => { alive.current = false; }; }, [poll]);
  // Quickly while something is changing, which is what the page is open for; slowly once it is as it will stay, and not at all in a tab nobody looks at, which asks at once when it is looked at again. The state says it: `progress` is the container's log once there is a container, so it is never empty for a service that is up.
  const changing = !install || install.busy || install.state === 'installing' || install.state === 'starting';
  const every = changing ? 2500 : install?.state === 'unavailable' ? 10_000 : 30_000;
  useEffect(() => pollWhileVisible(() => void poll(), every), [poll, every]);
  // The GPU as nvidia-smi reports it, for the engine choice. Where it cannot be read the install reads it, so a failure here is no error.
  const [hardware, setHardware] = useState<VoiceHardware | null>(null);
  useEffect(() => { void api.hardware().then(setHardware).catch(() => {}); }, []);
  // The engines picked here; null leaves the choice to the install, or to what is installed.
  const [picked, setPicked] = useState<VoiceChoice | null>(null);
  // Once the container is built for what was picked, the pick is what is installed.
  useEffect(() => { if (picked && install?.choice && sameChoice(picked, install.choice)) setPicked(null); }, [install?.choice, picked]);
  // The card is chosen on its own and at once: a running service moves to it, any other is on it from its next start.
  const chooseGpu = async (gpu: string) => {
    setActionBusy(true);
    // Saved even where the restart is refused, so what the page shows is read again either way.
    try { await api.setGpu(gpu); } catch (e) { setFailure((e as Error).message); }
    try { setHardware(await api.hardware()); setInstall(await api.state()); } catch { /* the next poll shows it */ }
    setActionBusy(false);
  };
  const manage = async (action: 'install' | 'start' | 'stop', choice?: VoiceChoice) => { setActionBusy(true); try { await api.act(action, choice); setInstall(await api.state()); } catch (e) { setFailure((e as Error).message); } finally { setActionBusy(false); } };
  const uninstall = async () => {
    const removeData = { current: false };
    if (!await ui.confirm({ title: t("Uninstall voice?"), message: <UninstallQuestion removeData={removeData} />, confirmLabel: t("Uninstall"), danger: true, deletes: true })) return;
    setActionBusy(true);
    // Whatever the answer, the service may have gone as far as removing the container, and with it voice mode's source: what the page shows is read again either way.
    try { await api.uninstall(removeData.current); } catch (e) { setFailure((e as Error).message); }
    try { setInstall(await api.state()); setPicked(null); } catch { /* the next poll shows it */ }
    setActionBusy(false);
  };
  // Use for voice mode, and Stop using: what the server half answers is whether it is voice mode's source now.
  const [choosing, setChoosing] = useState(false);
  const choose = async (use: boolean) => { setChoosing(true); try { const { chosen } = await api.setChosen(use); setInstall(current => current && { ...current, chosen }); } catch (e) { setFailure((e as Error).message); } finally { setChoosing(false); } };
  const setLazyLoad = async (on: boolean) => {
    setInstall(current => current && { ...current, lazyLoad: on });
    try { await api.setLazyLoad(on); } catch (e) { setFailure((e as Error).message); void poll(); }
  };
  // Another choice than the installed one, picked for a container that exists: it is a rebuild, not a start. While a first install is still pulling the image there is no container, and nothing to rebuild.
  const rebuild = !!picked && !!install?.choice;
  return <div className="space-y-3">
    {failure && <ui.ErrorBanner onClose={() => setFailure(null)}>{failure}</ui.ErrorBanner>}
    {/* The page's head, drawn by Settings, has the service's name and mark already. */}
    <div className="flex items-start gap-2">
      <p className="min-w-0 flex-1 text-xs text-fg-faint">{t("Install once on your Docker host. Setup builds and downloads the engines you choose: speech synthesis needs an NVIDIA GPU except Kokoro, which also runs on the CPU, and speech recognition does not. Allow 30 GB of disk space during setup.")}</p>
      <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">{install?.state === 'absent' ? t("Not installed") : install?.state === 'running' ? t("Ready") : install?.state ? t(INSTALL_STATE[install.state] ?? install.state) : t("Checking…")}</span>
    </div>
    <p className="text-xs text-fg-faint">{t("Voice mode's other settings, such as speech detection and speaking instructions, are in Settings → Defaults → Voice mode.")}</p>
    {install?.available && <VoiceEngines installed={install.choice} fresh={install.state==='absent'} busy={actionBusy||install.busy} hardware={hardware} picked={picked} onPick={setPicked} onGpu={chooseGpu} />}
    <div className="flex gap-2 flex-wrap">
      {install?.available && rebuild && <button disabled={actionBusy || install.busy} className="rounded-lg bg-accent/12 px-3 py-1.5 text-xs text-accent disabled:opacity-40" onClick={()=>manage('install',picked)}>{t("Rebuild with these engines")}</button>}
      {install?.available && !rebuild && <button disabled={actionBusy || install.busy || ['starting','running'].includes(install.state)} className="rounded-lg bg-accent/12 px-3 py-1.5 text-xs text-accent disabled:opacity-40" onClick={()=>manage(install.state==='absent'?'install':'start',install.state==='absent'?picked??undefined:undefined)}>{install.state==='absent'?t("Install voice"):install.state==='failed'?t("Retry setup"):t("Start voice")}</button>}
      {/* Stop, for a service that is up, and for a failed one Docker is starting again: a stop ends its tries. */}
      {install?.available && (['starting','running'].includes(install.state) || (install.state === 'failed' && install.retrying)) && <button disabled={actionBusy} className="rounded-lg border border-line px-3 py-1.5 text-xs" onClick={()=>manage('stop')}>{t("Stop · release VRAM")}</button>}
      {install?.available && install.state!=='absent' && <button disabled={actionBusy || install.busy} className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition hover:bg-danger/10 hover:text-danger disabled:opacity-40" onClick={()=>void uninstall()}>{t("Uninstall")}</button>}
      {install?.state==='running' && !install.chosen && <button disabled={choosing} className="rounded-lg bg-accent/12 px-3 py-1.5 text-xs text-accent" onClick={()=>void choose(true)}>{t("Use for voice mode")}</button>}
      {install?.chosen && <button disabled={choosing} className="rounded-lg border border-line px-3 py-1.5 text-xs" onClick={()=>void choose(false)}>{t("Stop using")}</button>}
    </div>
    {install?.chosen && <p role="status" className="text-xs text-fg-faint">{t("In use for voice mode")}</p>}
    {install?.error && <p role="alert" className="text-xs text-danger">{install.error}</p>}
    {install?.progress && <details open={install.state==='starting'||install.state==='failed'||install.busy}><summary className="text-xs cursor-pointer text-fg-muted">{t("Setup log")}</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px] text-fg-faint" aria-label={t("Voice setup log")}>{install.progress}</pre></details>}
    <p className="text-xs text-fg-faint">{t("Stopping releases GPU memory and keeps your models.")}</p>
    {install?.choice && <YourVoice engine={install.choice.tts} onError={setFailure} />}
    <div className="mt-4 border-t border-line pt-4 space-y-2">
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" disabled={!install} checked={install?.lazyLoad!==false} onChange={e=>void setLazyLoad(e.target.checked)}/>{t("Lazy load · release GPU memory when voice is idle")}</label>
      <p className="text-xs text-fg-faint">{t("Load on connection and release memory after the last session ends. Turn off to keep the speech model ready for faster starts.")}</p>
    </div>
  </div>;
}
