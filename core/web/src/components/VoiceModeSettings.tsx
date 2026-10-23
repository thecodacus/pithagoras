import { Select } from "./Select";
import { useEffect, useMemo, useRef, useState } from "react";
import { LuCheck } from "react-icons/lu";
import { DEFAULT_VAD, api, type AvailableModel, type VoiceConfig, type VoiceModeSave } from "../api";
import { msg, t } from "../i18n";
import { translate } from "../extensions/strings";
import { LoadFailed, Section, SwitchRow, btnCls, inputCls } from "./SettingsUi";
import { serialSaver } from "../serial-saver";

/** The providers as typed: names separated by commas. */
const providerNames = (text: string) => text.split(",").map(name => name.trim()).filter(Boolean);

/**
 * Voice mode, at the end of Settings → Defaults: the extension it listens and speaks through, which is chosen on that
 * extension's own page and can be stopped here, whether spoken conversations are offered and how they go, whatever
 * listens and speaks for them. Each change is saved as it is made.
 */
export function VoiceModeSettings({ onError, onExtensions, onSource }: {
  onError: (message: string) => void;
  /** Opens Settings → Extensions. */
  onExtensions: () => void;
  /** Opens the page of the extension voice mode listens and speaks through, by its package's name. */
  onSource: (name: string) => void;
}) {
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  // The providers and the speaking instructions as typed, and the sliders as moved, until they are left or let go: the
  // answer to another field's save does not overwrite them.
  const [providersText, setProvidersText] = useState<string | null>(null);
  const [instructionsText, setInstructionsText] = useState<string | null>(null);
  const [vadMoved, setVadMoved] = useState<typeof DEFAULT_VAD | null>(null);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(savedTimer.current), []);
  // One save at a time, ending on the last change asked for. Each answer is what is saved now, and voice mode's controls
  // read it again.
  const saver = useMemo(() => serialSaver<VoiceModeSave>(
    async (value) => { setConfig(await api.setVoice(value)); window.dispatchEvent(new Event("voice-config-changed")); },
    () => { setSaved(true); clearTimeout(savedTimer.current); savedTimer.current = setTimeout(() => setSaved(false), 2000); },
  ), []);
  // Nothing of the section can be drawn without it, so the failure is said where the section would be.
  const [readFailed, setReadFailed] = useState<string | null>(null);
  const readConfig = () => api.voice().then(value => { setReadFailed(null); setConfig(value); }, e => setReadFailed((e as Error).message));
  useEffect(() => { void readConfig(); }, []);
  // Every model there is, to name one for spoken turns rather than the chat's.
  const [models, setModels] = useState<AvailableModel[]>([]);
  useEffect(() => { api.allModels().then(r => setModels(r.models)).catch(() => {}); }, []);
  const title = t("Voice mode");
  const hint = t("How spoken conversations go, whatever listens and speaks for them.");
  if (!config) return readFailed ? <Section title={title} hint={hint}><LoadFailed error={readFailed} onRetry={readConfig} /></Section> : null;
  const instructions = config.responseInstructions ?? "";
  const builtIn = config.defaultResponseInstructions ?? "";
  /** Saves the section with `patch` applied, shown at once. */
  const commit = async (patch: Partial<VoiceConfig>) => {
    const next = { ...config, ...patch };
    setConfig(next);
    const text = next.responseInstructions ?? "";
    try {
      // Text that is still the built-in one this page was given is sent as nothing: the portal may have been updated since, and its newer text is then the one to follow.
      await saver.request({ vad: { ...DEFAULT_VAD, ...next.vad }, responseInstructions: text.trim() === builtIn.trim() ? "" : text, skipThinkingProviders: next.skipThinkingProviders, voiceModel: next.voiceModel ?? "", conversation: next.conversation !== false });
    } catch (e) {
      onError((e as Error).message);
      // What was refused is not left on the page as if it were saved.
      void readConfig();
    }
  };
  // Voice mode stops using its source. Only what says where it listens is taken from the answer: the rest is this section's.
  const stopUsing = async () => {
    try {
      const answer = await api.stopVoiceSource();
      setConfig(value => value && { ...value, provider: answer.provider, label: answer.label, ready: answer.ready, speech: answer.speech, voices: answer.voices, enabled: answer.enabled });
      window.dispatchEvent(new Event("voice-config-changed"));
    } catch (e) { onError((e as Error).message); }
  };
  const source = config.label ? translate(config.provider, config.label) : config.provider;
  // The source recognises speech alone: the page can listen (dictation), and replies are not spoken.
  const listening = config.ready && !config.speech;
  // Voice conversations switched off: the page listens for dictation alone, as it does with such a source.
  const conversation = config.conversation !== false;
  const speaking = !listening && conversation;
  const providers = providersText === null ? config.skipThinkingProviders ?? [] : providerNames(providersText);
  const vad = vadMoved ?? { ...DEFAULT_VAD, ...config.vad };
  // A slider is saved as it is let go, by the pointer or a key.
  const letGo = () => {
    if (!vadMoved) return;
    setVadMoved(null);
    void commit({ vad: vadMoved });
  };
  return <Section title={title} hint={hint} action={saved && <span className="pop-in inline-flex items-center gap-1 text-xs text-ok"><LuCheck className="h-3.5 w-3.5" /> {t("Saved")}</span>}>
    <div className="space-y-4">
    <div className="rounded-xl border border-line bg-raised/40 p-3">
      {config.provider ? <>
        <p className="flex flex-wrap items-center gap-2 text-sm text-fg">{t("Listens and speaks through {source}", { source })}
          <span role="status" className={`rounded px-1.5 py-0.5 text-xs ${config.ready && config.speech ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn"}`}>
            {!config.ready ? t("Not running") : config.speech ? t("Running") : t("Recognition only: dictation works, and replies are not spoken.")}
          </span>
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {/* Its page is there while its server half runs; one that is not running may not be installed at all. */}
          {config.label
            ? <button type="button" className={btnCls} onClick={() => onSource(config.provider)}>{t("Open its page")}</button>
            : <button type="button" className={btnCls} onClick={onExtensions}>{t("Open Extensions")}</button>}
          <button type="button" className={btnCls} onClick={() => void stopUsing()}>{t("Stop using")}</button>
        </div>
      </> : <>
        <p className="text-xs text-fg-muted">{t("Nothing listens and speaks for voice mode. An extension that does is installed in Settings → Extensions and chosen on its own page.")}</p>
        <button type="button" className={`mt-3 ${btnCls}`} onClick={onExtensions}>{t("Open Extensions")}</button>
      </>}
    </div>
    {!listening && <SwitchRow title={t("Voice conversations")} on={conversation} onChange={on => void commit({ conversation: on })}
      detail={t("The waveform button beside the message box, and its shortcut, start a spoken conversation. Off leaves dictation, which types what you say and speaks nothing back.")} />}
    {speaking && <div className="block text-xs text-fg-muted">{t("Voice model")}
      <Select aria-label={t("Voice model")} size="sm" className="mt-1.5 w-full" value={config.voiceModel ?? ""} onChange={voiceModel => void commit({ voiceModel })} options={[
        { value: "", label: t("Same as the chat"), hint: t("The model the chat is on") },
        ...(!config.voiceModel || models.some(m => `${m.provider}/${m.id}` === config.voiceModel) ? [] : [{ value: config.voiceModel, label: config.voiceModel }]),
        ...models.map(m => ({ value: `${m.provider}/${m.id}`, label: m.name || m.id, hint: `${m.provider}/${m.id}` })),
      ]} />
      <p className="mt-1.5 text-xs text-fg-faint">{t("The model that answers spoken messages, so a slow chat model does not slow down a conversation. A spoken message that starts a run is answered by it and the chat goes back to its own model afterwards; the model picker of the chat is not changed.")}</p>
    </div>}
    {speaking && <div className="space-y-2">
      <label className="block text-xs text-fg-muted">{t("Reply without thinking first on")}
        <input aria-label={t("Reply without thinking first on")} className={`mt-1.5 ${inputCls}`} value={providersText ?? (config.skipThinkingProviders ?? []).join(", ")}
          onChange={e => setProvidersText(e.target.value)}
          onBlur={() => { if (providersText === null) return; setProvidersText(null); void commit({ skipThinkingProviders: providerNames(providersText) }); }} />
      </label>
      <p className="text-xs text-fg-faint">{t("Providers, by the name the model menu shows, whose first answer to a spoken message skips thinking so it starts speaking sooner. Separate them with commas. It works through the llama.cpp chat template, so only llama.cpp servers and gateways in front of them, such as llama-swap, follow it. Empty keeps thinking on everywhere.")}</p>
      <button type="button" className={btnCls} disabled={providers.join(",") === (config.defaultSkipThinkingProviders ?? []).join(",")}
        onClick={() => { setProvidersText(null); void commit({ skipThinkingProviders: config.defaultSkipThinkingProviders }); }}>{t("Reset to the default list")}</button>
    </div>}
    {speaking && <details className="rounded-xl border border-line p-4">
      <summary className="cursor-pointer text-sm font-medium">{t("Speaking instructions")}<span className="mt-1 block text-xs font-normal text-fg-muted">{t("What the assistant is told about how to reply in voice mode")}</span></summary>
      <div className="mt-4 space-y-3">
        <p className="text-xs text-fg-faint">{t("Sent with every spoken message, after a fixed note on what the [Audio mode] marker means. They apply from the next spoken message. Empty text uses the built-in instructions.")}</p>
        {config.responseInstructionsOff && <p role="status" className="text-xs text-warn">{t("This portal is set to send no speaking instructions (VOICE_RESPONSE_INSTRUCTIONS=false). Your text is kept and is not used.")}</p>}
        <textarea aria-label={t("Speaking instructions")} rows={12} className={inputCls} value={instructionsText ?? instructions}
          onChange={e => setInstructionsText(e.target.value)}
          onBlur={() => { if (instructionsText === null) return; setInstructionsText(null); void commit({ responseInstructions: instructionsText }); }} />
        <button type="button" className={btnCls} disabled={(instructionsText ?? instructions).trim() === builtIn.trim()}
          onClick={() => { setInstructionsText(null); void commit({ responseInstructions: builtIn }); }}>{t("Reset to default")}</button>
      </div>
    </details>}
    <details className="rounded-xl border border-line p-4">
      <summary className="cursor-pointer text-sm font-medium">{t("Speech detection")}<span className="mt-1 block text-xs font-normal text-fg-muted">{t("Turn timing and microphone sensitivity · Silero VAD")}</span></summary>
      <div className="mt-4 space-y-4">
        <p className="text-xs text-fg-faint">{t("Restart voice mode to apply. Shorter silence responds faster but can cut off pauses.")}</p>
        {([
          ['redemptionMs', msg('End-of-turn silence'), 200, 3000, 50, 'ms', msg('How long to wait after speech before sending your turn.')],
          ['positiveSpeechThreshold', msg('Speech-start threshold'), 0.01, 1, 0.01, '', msg('Higher values reject more noise but may miss quiet speech.')],
          ['negativeSpeechThreshold', msg('Speech-end threshold'), 0, 0.99, 0.01, '', msg('Below this confidence, audio counts as silence. Must be lower than the start threshold.')],
          ['minSpeechMs', msg('Minimum speech duration'), 64, 2000, 16, 'ms', msg('Shorter sounds are ignored as accidental triggers.')],
          ['preSpeechPadMs', msg('Audio before speech'), 0, 1000, 20, 'ms', msg('Retain the beginning of words before speech is confirmed.')],
        ] as const).map(([key, label, min, max, step, unit, help]) => <label key={key} className="block text-xs text-fg-muted">
          <span className="flex justify-between gap-3"><span>{t(label)}</span><span className="tabular-nums text-accent">{vad[key]} {unit}</span></span>
          <input type="range" className="mt-2 w-full accent-current" min={min} max={max} step={step} value={vad[key]}
            onChange={e => setVadMoved({ ...vad, [key]: Number(e.target.value) })} onPointerUp={letGo} onKeyUp={letGo} />
          <span className="mt-1 block text-fg-faint">{t(help)}</span>
        </label>)}
        <button type="button" className="rounded-lg border border-line px-3 py-1.5 text-xs" onClick={() => { setVadMoved(null); void commit({ vad: { ...DEFAULT_VAD } }); }}>{t("Reset speech detection")}</button>
      </div>
    </details>
    </div>
  </Section>;
}
