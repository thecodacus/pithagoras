import { VoiceLibrary, kokoroVoiceOptions } from './VoiceLibrary';
import { VoiceEngines } from './VoiceEngines';
import { Select } from "./Select";
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_VAD, api, type AvailableModel, type VoiceInstallStatus, type VoiceConfig, type VoiceHardware } from "../api";
import { INPUT_LANGUAGES, CHATTERBOX_LANGUAGES } from "../../../server/src/voice-languages";
import { sameChoice, type VoiceChoice } from "../../../server/src/voice-engines";
import { NUMBER_PACK_LANGUAGES } from "../../../server/src/voice-numbers";
import { DEFAULT_KOKORO_VOICE } from "../../../server/src/kokoro-voices";
import { labelOf, languageName, msg, t } from "../i18n";
import { LoadFailed, btnCls, inputCls } from "./SettingsUi";
import { confirmDialog } from "./ConfirmDialog";
import { useUnsavedDraft } from "./Modal";
import { pollWhileVisible } from "../poll";

/** What the voice service is doing, as its badge says it. */
const INSTALL_STATE: Record<string, string> = {
  unavailable: msg("unavailable"),
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
    <p>{t("The voice container is stopped and removed. The voice settings go back to what they were before voice was installed; speech servers you set up yourself stay as they are.")}</p>
    <label className="flex items-start gap-2 text-fg">
      <input type="checkbox" className="mt-1" checked={on} onChange={e => { setOn(e.target.checked); removeData.current = e.target.checked; }} />
      <span>{t("Also delete the downloaded engines and models")}<span className="mt-1 block text-xs text-fg-muted">{t("Leave it off to keep them, so that installing again is quick. Delete them to free the disk space: the next install downloads and builds them again.")}</span></span>
    </label>
  </div>;
}

/** What the install and the uninstall write into the settings, apart from what is edited on this page. */
const managed = (c: VoiceConfig) => ({ enabled: c.enabled, runtime: c.runtime, whisperUrl: c.whisperUrl, breezeUrl: c.breezeUrl, sttModel: c.sttModel, dictationModel: c.dictationModel, dictationUrl: c.dictationUrl });

export function VoiceAddon({ onError }: { onError: (message: string) => void }) {
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  // The providers as typed, commas and all, while they are edited; the list itself is in the config.
  const [providersText, setProvidersText] = useState<string | null>(null);
  // Something changed on this page that Save has not stored: in no other place, so closing Settings asks first.
  const [edited, setEdited] = useState(false);
  // Settings from the server replace what was typed, which would otherwise show a list other than the one saved.
  const fromServer = (value: VoiceConfig) => { setConfig(value); setProvidersText(null); setEdited(false); };
  const [install, setInstall] = useState<VoiceInstallStatus | null>(null);
  // The install writes its connection settings as the service comes up. Only those are taken over, so that what is being typed here is not replaced; a failed poll makes the state flip to unavailable and back, and would otherwise do it every time.
  useEffect(()=>{if(install?.state==='running')void api.voice().then(value=>{setConfig(current=>current?{...current,...managed(value)}:value);window.dispatchEvent(new Event('voice-config-changed'));}).catch(e=>onError(e.message));},[install?.state]);
  const [actionBusy, setActionBusy] = useState(false);
  // One question at a time, and none for a page that has gone: each asks Docker several things.
  const alive = useRef(true), asking = useRef(false);
  const poll = useCallback(async () => {
    if (asking.current) return;
    asking.current = true;
    try { const state = await api.voiceInstallStatus(); if (alive.current) setInstall(state); } catch (e) { if (alive.current) setInstall({ available: false, state: 'unavailable', busy: false, progress: '', error: (e as Error).message }); } finally { asking.current = false; }
  }, []);
  useEffect(() => { alive.current = true; void poll(); return () => { alive.current = false; }; }, [poll]);
  // Quickly while something is changing, which is what the page is open for; slowly once it is as it will stay, and not at all in a tab nobody looks at, which asks at once when it is looked at again. The state says it: `progress` is the container's log once there is a container, so it is never empty for a service that is up.
  const changing = !install || install.busy || install.state === 'installing' || install.state === 'starting';
  const every = changing ? 2500 : install?.state === 'unavailable' ? 10_000 : 30_000;
  useEffect(() => pollWhileVisible(() => void poll(), every), [poll, every]);
  // The GPU as nvidia-smi reports it, for the engine choice. Where it cannot be read the install reads it, so a failure here is no error.
  const [hardware, setHardware] = useState<VoiceHardware | null>(null);
  useEffect(() => { void api.voiceHardware().then(setHardware).catch(() => {}); }, []);
  // The engines picked here; null leaves the choice to the install, or to what is installed.
  const [picked, setPicked] = useState<VoiceChoice | null>(null);
  // Once the container is built for what was picked, the pick is what is installed.
  useEffect(() => { if (picked && install?.choice && sameChoice(picked, install.choice)) setPicked(null); }, [install?.choice, picked]);
  // The card is chosen on its own and at once: a running service moves to it, any other is on it from its next start.
  const chooseGpu = async (gpu: string) => {
    setActionBusy(true);
    // Saved even where the restart is refused, so what the page shows is read again either way.
    try { await api.setVoiceGpu(gpu); } catch (e) { onError((e as Error).message); }
    try { setHardware(await api.voiceHardware()); setInstall(await api.voiceInstallStatus()); } catch { /* the next poll shows it */ }
    setActionBusy(false);
  };
  const manage=async(action:'install'|'start'|'stop',choice?:VoiceChoice)=>{setActionBusy(true);try{await api.voiceAction(action,choice);setInstall(await api.voiceInstallStatus());}catch(e){onError((e as Error).message);}finally{setActionBusy(false);}};
  const uninstall = async () => {
    const removeData = { current: false };
    if (!await confirmDialog({ title: t("Uninstall voice?"), message: <UninstallQuestion removeData={removeData} />, confirmLabel: t("Uninstall"), danger: true, deletes: true })) return;
    setActionBusy(true);
    // Whatever the answer, the portal may have gone as far as removing the container: what the page shows is read again either way.
    try { await api.uninstallVoice(removeData.current); } catch (e) { onError((e as Error).message); }
    try {
      setInstall(await api.voiceInstallStatus());
      setPicked(null);
      // The portal put the settings back. Taken over here, so that a save does not write the managed ones again; the rest of the page, edits not yet saved among it, stays.
      const back = await api.voice();
      setConfig(current => current && { ...current, ...managed(back) });
      window.dispatchEvent(new Event('voice-config-changed'));
    } catch { /* the next poll shows it */ }
    setActionBusy(false);
  };
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  // The descriptions edited in the voice library and not stored are drafts of its own: it says so itself, where they are typed.
  useUnsavedDraft(edited && !busy);
  // A saved voice's description is stored on its own; this saves the edited ones along with the settings.
  const pendingDescriptions = useRef<(() => Promise<void>) | null>(null);
  // Nothing of the page can be drawn without it, so the failure is said where the page would be.
  const [readFailed, setReadFailed] = useState<string | null>(null);
  const readConfig = () => api.voice().then(value => { setReadFailed(null); setConfig(value); }, e => setReadFailed((e as Error).message));
  useEffect(() => { void readConfig(); }, []);
  // Every model there is, to name one for spoken turns rather than the chat's.
  const [models, setModels] = useState<AvailableModel[]>([]);
  useEffect(() => { api.allModels().then(r => setModels(r.models)).catch(() => {}); }, []);
  if (!config) return readFailed ? <div className="mt-4"><LoadFailed error={readFailed} onRetry={readConfig} /></div> : null;
  const update = (patch: Partial<VoiceConfig>) => { setConfig({ ...config, ...patch }); setSaved(false); setEdited(true); };
  const instructions = config.responseInstructions ?? "";
  const builtIn = config.defaultResponseInstructions ?? "";
  // Text that is still the built-in one this page was given is sent as nothing: the portal may have been updated since, and its newer text is then the one to follow.
  const toSave = () => instructions.trim() === builtIn.trim() ? { ...config, responseInstructions: "" } : config;
  // Another choice than the installed one, picked for a container that exists: it is a rebuild, not a start. While a first install is still pulling the image there is no container, and nothing to rebuild.
  const rebuild = !!picked && !!install?.choice;
  // No speech synthesis: the page can listen (dictation), and replies are not spoken.
  const listening = config.runtime === "none";
  const chatterbox = config.runtime === "chatterbox";
  // Kokoro speaks with voices of its own, not the library's.
  const kokoro = config.runtime === "kokoro";
  const languages = chatterbox ? INPUT_LANGUAGES.filter(([code]) => CHATTERBOX_LANGUAGES.includes(code)) : INPUT_LANGUAGES;
  // Switching runtime must not leave a language the runtime will refuse on save.
  const setRuntime = (runtime: VoiceConfig["runtime"]) => update(runtime === "chatterbox" && !CHATTERBOX_LANGUAGES.includes(config.language ?? "auto")
    ? { runtime, language: "en" } : { runtime });
  return <div className="mt-4 space-y-4">
    <div><p className="text-sm text-fg">{t("Voice")}</p><p className="mt-1 text-xs text-fg-faint">{t("Talk naturally, interrupt anytime, and hear replies in your chosen voice.")}</p></div>
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={config.enabled} onChange={e => update({ enabled: e.target.checked })} />{listening ? t("Enable dictation in sessions") : t("Enable voice controls in sessions")}</label>
    {listening && <p role="status" className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">{t("This installation has no speech synthesis: replies are not spoken and voice mode is off. Dictation, which only listens, works.")}</p>}
    {!listening && <section className="rounded-xl border border-line bg-surface/50 p-4 space-y-4">
      <div><h3 className="text-sm font-medium">{t("Your voice")}</h3><p className="mt-1 text-xs text-fg-muted">{t("Choose how your assistant sounds.")}</p></div>
    {kokoro
      ? <><div className="block text-xs text-fg-muted">{t("Speaking voice")}<Select aria-label={t("Speaking voice")} className="mt-1.5 w-full" value={config.kokoroVoice ?? DEFAULT_KOKORO_VOICE} onChange={kokoroVoice => update({ kokoroVoice })} options={kokoroVoiceOptions()} /></div>
        <p className="text-xs text-fg-faint">{t("Kokoro speaks with its own voices and reads the text in the language of the voice. Your voice library is kept for the other engines.")}</p></>
      : <VoiceLibrary value={config.voice || "design"} onChange={voice=>update({voice})} onError={onError} onPending={save=>{pendingDescriptions.current=save;if(save)setSaved(false);}}/>}
      {!kokoro && (config.voice||"design") === "design" && <label className="block text-xs text-fg-muted">{t("Describe the speaking voice")}<input className={`mt-1.5 ${inputCls}`} value={config.instruction} onChange={e=>update({instruction:e.target.value})}/></label>}
    </section>}
    <section className="rounded-xl border border-line bg-surface/50 p-4 space-y-4">
      <h3 className="text-sm font-medium">{t("Conversation")}</h3>
    <div className="block text-xs text-fg-muted">{t("Input language")}<Select aria-label={t("Input language")} size="sm" className="mt-1.5 w-full" value={config.language || "auto"} onChange={language => update({ language })} options={languages.map(([value, label]) => ({ value, label: value === "auto" ? t("Auto-detect") : languageName(value, label) }))} /></div>
    <p className="text-xs text-fg-faint">{t("Choosing your language improves recognition on short turns.")}</p>
    {!listening && (kokoro
      ? <div className="block text-xs text-fg-muted">{t("Speaking speed")}<Select<number> aria-label={t("Speaking speed")} size="sm" className="mt-1.5 w-full" value={config.speed ?? 1} onChange={speed => update({ speed })} options={[{ value: 0.85, label: t("Slower") }, { value: 1, label: t("Normal") }, { value: 1.15, label: t("Faster") }]} /></div>
      : chatterbox
      ? <div className="block text-xs text-fg-muted">{t("Speech delivery")}<Select<number> aria-label={t("Speech delivery")} size="sm" className="mt-1.5 w-full" value={config.exaggeration ?? 0.5} onChange={exaggeration => update({ exaggeration })} options={[{ value: 0.3, label: t("Calm"), hint: t("Flatter delivery") }, { value: 0.5, label: t("Natural"), hint: t("As recorded") }, { value: 0.8, label: t("Expressive"), hint: t("Stronger emotion") }]} /></div>
      : <div className="block text-xs text-fg-muted">{t("Speech generation")}<Select<number> aria-label={t("Speech generation")} size="sm" className="mt-1.5 w-full" value={config.cfgScale ?? 4} onChange={cfgScale => update({ cfgScale })} options={[{ value: 1, label: t("Fast"), hint: t("Lighter voice guidance") }, { value: 4, label: t("Expressive"), hint: t("Stronger voice guidance") }]} /></div>)}
    {chatterbox && <p className="text-xs text-fg-faint">{t("Chatterbox speaks your input language and clones the selected reference voice; it has no designed voice.")} {NUMBER_PACK_LANGUAGES.includes(config.language ?? "") ? t("Numbers are written out before synthesis so they are spoken correctly.") : t("Numbers stay as digits in this language, which Chatterbox reads unreliably.")}</p>}
    {chatterbox && (config.voice || "design") === "design" && <p role="alert" className="text-xs text-danger">{t("Choose a voice with a recording above: Chatterbox cannot speak with a designed voice.")}</p>}
    {!listening && <div className="block text-xs text-fg-muted">{t("Voice model")}
      <Select aria-label={t("Voice model")} size="sm" className="mt-1.5 w-full" value={config.voiceModel ?? ""} onChange={voiceModel => update({ voiceModel })} options={[
        { value: "", label: t("Same as the chat"), hint: t("The model the chat is on") },
        ...(!config.voiceModel || models.some(m => `${m.provider}/${m.id}` === config.voiceModel) ? [] : [{ value: config.voiceModel, label: config.voiceModel }]),
        ...models.map(m => ({ value: `${m.provider}/${m.id}`, label: m.name || m.id, hint: `${m.provider}/${m.id}` })),
      ]} />
      <p className="mt-1.5 text-xs text-fg-faint">{t("The model that answers spoken messages, so a slow chat model does not slow down a conversation. A spoken message that starts a run is answered by it and the chat goes back to its own model afterwards; the model picker of the chat is not changed.")}</p>
    </div>}
    {!listening && <div className="space-y-2">
      <label className="block text-xs text-fg-muted">{t("Reply without thinking first on")}
        <input aria-label={t("Reply without thinking first on")} className={`mt-1.5 ${inputCls}`} value={providersText ?? (config.skipThinkingProviders ?? []).join(", ")}
          onChange={e => { setProvidersText(e.target.value); update({ skipThinkingProviders: e.target.value.split(",").map(name => name.trim()).filter(Boolean) }); }} />
      </label>
      <p className="text-xs text-fg-faint">{t("Providers, by the name the model menu shows, whose first answer to a spoken message skips thinking so it starts speaking sooner. Separate them with commas. It works through the llama.cpp chat template, so only llama.cpp servers and gateways in front of them, such as llama-swap, follow it. Empty keeps thinking on everywhere.")}</p>
      <button type="button" className={btnCls} disabled={(config.skipThinkingProviders ?? []).join(",") === (config.defaultSkipThinkingProviders ?? []).join(",")}
        onClick={() => { setProvidersText(null); update({ skipThinkingProviders: config.defaultSkipThinkingProviders }); }}>{t("Reset to the default list")}</button>
    </div>}
    </section>
    {!listening && <details className="rounded-xl border border-line p-4">
      <summary className="cursor-pointer text-sm font-medium">{t("Speaking instructions")}<span className="mt-1 block text-xs font-normal text-fg-muted">{t("What the assistant is told about how to reply in voice mode")}</span></summary>
      <div className="mt-4 space-y-3">
        <p className="text-xs text-fg-faint">{t("Sent with every spoken message, after a fixed note on what the [Audio mode] marker means. Save to apply them from the next spoken message. Empty text uses the built-in instructions.")}</p>
        {config.responseInstructionsOff && <p role="status" className="text-xs text-warn">{t("This portal is set to send no speaking instructions (VOICE_RESPONSE_INSTRUCTIONS=false). Your text is kept and is not used.")}</p>}
        <textarea aria-label={t("Speaking instructions")} rows={12} className={inputCls} value={instructions} onChange={e => update({ responseInstructions: e.target.value })} />
        <button type="button" className={btnCls} disabled={instructions.trim() === builtIn.trim()} onClick={() => update({ responseInstructions: builtIn })}>{t("Reset to default")}</button>
      </div>
    </details>}
    <details className="rounded-xl border border-line p-4">
      <summary className="cursor-pointer text-sm font-medium">{t("Speech detection")}<span className="mt-1 block text-xs font-normal text-fg-muted">{t("Turn timing and microphone sensitivity · Silero VAD")}</span></summary>
      <div className="mt-4 space-y-4">
        <p className="text-xs text-fg-faint">{t("Save, then restart voice mode to apply. Shorter silence responds faster but can cut off pauses.")}</p>
        {([
          ['redemptionMs', msg('End-of-turn silence'), 200, 3000, 50, 'ms', msg('How long to wait after speech before sending your turn.')],
          ['positiveSpeechThreshold', msg('Speech-start threshold'), 0.01, 1, 0.01, '', msg('Higher values reject more noise but may miss quiet speech.')],
          ['negativeSpeechThreshold', msg('Speech-end threshold'), 0, 0.99, 0.01, '', msg('Below this confidence, audio counts as silence. Must be lower than the start threshold.')],
          ['minSpeechMs', msg('Minimum speech duration'), 64, 2000, 16, 'ms', msg('Shorter sounds are ignored as accidental triggers.')],
          ['preSpeechPadMs', msg('Audio before speech'), 0, 1000, 20, 'ms', msg('Retain the beginning of words before speech is confirmed.')],
        ] as const).map(([key, label, min, max, step, unit, help]) => <label key={key} className="block text-xs text-fg-muted">
          <span className="flex justify-between gap-3"><span>{t(label)}</span><span className="tabular-nums text-accent">{config.vad?.[key] ?? DEFAULT_VAD[key]} {unit}</span></span>
          <input type="range" className="mt-2 w-full accent-current" min={min} max={max} step={step} value={config.vad?.[key] ?? DEFAULT_VAD[key]} onChange={e => update({ vad: { ...DEFAULT_VAD, ...config.vad, [key]: Number(e.target.value) } })} />
          <span className="mt-1 block text-fg-faint">{t(help)}</span>
        </label>)}
        <button type="button" className="rounded-lg border border-line px-3 py-1.5 text-xs" onClick={() => update({vad: {...DEFAULT_VAD}})}>{t("Reset speech detection")}</button>
      </div>
    </details>
    <details className="group rounded-xl border border-line p-4">
      <summary className="cursor-pointer text-sm font-medium">{t("Voice service")} <span className="ml-2 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-normal text-accent">{install?.state === 'absent' ? t("Not installed") : install?.state === 'running' ? t("Ready") : install?.state ? labelOf(INSTALL_STATE, install.state) : t("Checking…")}</span><span className="mt-1 block text-xs font-normal text-fg-muted">{t("Installation, GPU memory and service controls")}</span></summary>
    <div className="mt-4 space-y-3">
      <p className="text-xs text-fg-faint">{t("Install once on your Docker host. Setup builds and downloads the engines you choose: speech synthesis needs an NVIDIA GPU except Kokoro, which also runs on the CPU, and speech recognition does not. Allow 30 GB of disk space during setup.")}</p>
      {install?.available && <VoiceEngines installed={install.choice} fresh={install.state==='absent'} busy={actionBusy||install.busy} hardware={hardware} picked={picked} onPick={setPicked} onGpu={chooseGpu} />}
      <div className="flex gap-2 flex-wrap">
        {install?.available && rebuild && <button disabled={actionBusy || install.busy} className="rounded-lg bg-accent/12 px-3 py-1.5 text-xs text-accent disabled:opacity-40" onClick={()=>manage('install',picked)}>{t("Rebuild with these engines")}</button>}
        {install?.available && !rebuild && <button disabled={actionBusy || install.busy || ['starting','running'].includes(install.state)} className="rounded-lg bg-accent/12 px-3 py-1.5 text-xs text-accent disabled:opacity-40" onClick={()=>manage(install.state==='absent'?'install':'start',install.state==='absent'?picked??undefined:undefined)}>{install.state==='absent'?t("Install voice"):install.state==='failed'?t("Retry setup"):t("Start voice")}</button>}
        {install?.available && ['starting','running'].includes(install.state) && <button disabled={actionBusy} className="rounded-lg border border-line px-3 py-1.5 text-xs" onClick={()=>manage('stop')}>{t("Stop · release VRAM")}</button>}
        {install?.available && (install.state!=='absent' || install.connected) && <button disabled={actionBusy || install.busy} className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition hover:bg-danger/10 hover:text-danger disabled:opacity-40" onClick={()=>void uninstall()}>{t("Uninstall")}</button>}
        {install?.state==='running' && <button disabled={busy} className="rounded-lg bg-accent/12 px-3 py-1.5 text-xs text-accent" onClick={async()=>{setBusy(true);try{fromServer(await api.connectVoice());window.dispatchEvent(new Event('voice-config-changed'));}catch(e){onError((e as Error).message);}finally{setBusy(false);}}}>{t("Use installed voice")}</button>}
      </div>
      {install?.error && <p role="alert" className="text-xs text-danger">{install.error}</p>}
      {install?.progress && <details open={install.state==='starting'||install.state==='failed'||install.busy}><summary className="text-xs cursor-pointer text-fg-muted">{t("Setup log")}</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px] text-fg-faint" aria-label={t("Voice setup log")}>{install.progress}</pre></details>}
      <p className="text-xs text-fg-faint">{t("Stopping releases GPU memory and keeps your models.")}</p>
    </div>
      <div className="mt-4 border-t border-line pt-4 space-y-2">
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={config.lazyLoad!==false} onChange={e=>update({lazyLoad:e.target.checked})}/>{t("Lazy load · release GPU memory when voice is idle")}</label>
    <p className="text-xs text-fg-faint">{t("Load on connection and release memory after the last session ends. Turn off to keep the speech model ready for faster starts.")}</p>
      </div>
    </details>
    <details className="rounded-xl border border-line p-4">
      <summary className="cursor-pointer text-sm font-medium">{t("Advanced connection")}<span className="mt-1 block text-xs font-normal text-fg-muted">{t("Custom runtime and service addresses")}</span></summary>
      <div className="mt-4 space-y-4">
    <div className="block text-xs text-fg-muted">{t("Speech runtime")}<Select aria-label={t("Speech runtime")} size="sm" className="mt-1.5 w-full" value={config.runtime ?? "breeze"} onChange={v => setRuntime(v as VoiceConfig["runtime"])} options={[{ value: "breeze", label: "Breeze Python" }, { value: "audio-cpp", label: "Breeze audio.cpp", hint: t("Streaming") }, { value: "chatterbox", label: "Chatterbox audio.cpp", hint: t("Multilingual") }, { value: "kokoro", label: "Kokoro audio.cpp", hint: t("Built-in voices") }, { value: "none", label: t("No speech synthesis"), hint: t("Dictation only") }]} /></div>
    {([['whisperUrl', msg('Speech recognition URL')], ...(listening ? [] : [['breezeUrl', msg('Speech synthesis URL')] as const])] as const).map(([key, label]) => <label key={key} className="block text-xs text-fg-muted">{t(label)}<input className={`mt-1.5 ${inputCls}`} value={config[key]} onChange={e => update({ [key]: e.target.value })} /></label>)}
    <label className="block text-xs text-fg-muted">{t("Speech recognition model")}<input className={`mt-1.5 ${inputCls}`} placeholder={t("Whisper.cpp needs none; audio.cpp names its model, e.g. qwen3-asr")} value={config.sttModel ?? ""} onChange={e => update({ sttModel: e.target.value })} /></label>
    <label className="block text-xs text-fg-muted">{t("Dictation model")}<input className={`mt-1.5 ${inputCls}`} placeholder={t("Empty uses the speech recognition model above")} value={config.dictationModel ?? ""} onChange={e => update({ dictationModel: e.target.value })} /><span className="mt-1 block text-xs text-fg-faint">{t("The model the microphone button of the message box transcribes with. Voice mode keeps using the one above, so a conversation can have the quick model and dictation the accurate one.")}</span></label>
    <label className="block text-xs text-fg-muted">{t("Dictation endpoint")}<input className={`mt-1.5 ${inputCls}`} placeholder={t("Empty uses the speech recognition URL above")} value={config.dictationUrl ?? ""} onChange={e => update({ dictationUrl: e.target.value })} /><span className="mt-1 block text-xs text-fg-faint">{t("The address the microphone button of the message box sends its recordings to. Voice mode keeps using the one above, so dictation can run on another service.")}</span></label>
      </div>
    </details>
    <div className="sticky -bottom-4 z-10 -mx-5 !-mb-4 flex justify-end border-t border-line bg-raised px-5 pt-3 pb-7">
    <button disabled={busy} className="rounded-lg bg-accent px-4 py-2 text-xs font-medium text-black disabled:opacity-40" onClick={async () => {
      setBusy(true); try { await pendingDescriptions.current?.(); fromServer(await api.setVoice(toSave())); setSaved(true); window.dispatchEvent(new Event('voice-config-changed')); } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
    }}>{busy ? t("Saving…") : saved ? t("Saved") : t("Save voice settings")}</button>
    </div>
  </div>;
}
