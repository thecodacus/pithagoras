import { VoiceLibrary, kokoroVoiceOptions } from './VoiceLibrary';
import { Select } from "./Select";
import { useEffect, useRef, useState } from "react";
import { DEFAULT_VAD, api, speakingRuntime, type AvailableModel, type VoiceConfig } from "../api";
import { INPUT_LANGUAGES, CHATTERBOX_LANGUAGES } from "../../../server/src/voice-languages";
import { NUMBER_PACK_LANGUAGES } from "../../../server/src/voice-numbers";
import { DEFAULT_KOKORO_VOICE } from "../../../server/src/kokoro-voices";
import { languageName, msg, t } from "../i18n";
import { LoadFailed, btnCls, inputCls } from "./SettingsUi";
import { useUnsavedDraft } from "./Modal";

export function VoiceAddon({ onError }: { onError: (message: string) => void }) {
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  // The providers as typed, commas and all, while they are edited; the list itself is in the config.
  const [providersText, setProvidersText] = useState<string | null>(null);
  // Something changed on this page that Save has not stored: in no other place, so closing Settings asks first.
  const [edited, setEdited] = useState(false);
  // Settings from the server replace what was typed, which would otherwise show a list other than the one saved.
  const fromServer = (value: VoiceConfig) => { setConfig(value); setProvidersText(null); setEdited(false); };
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
  // How voice mode speaks: through the extension chosen, or at the person's own addresses.
  const speaking = speakingRuntime(config);
  // No speech synthesis: the page can listen (dictation), and replies are not spoken.
  const listening = speaking === "none";
  const chatterbox = speaking === "chatterbox";
  // Kokoro speaks with voices of its own, not the library's.
  const kokoro = speaking === "kokoro";
  const languages = chatterbox ? INPUT_LANGUAGES.filter(([code]) => CHATTERBOX_LANGUAGES.includes(code)) : INPUT_LANGUAGES;
  // Switching to what speaks with Chatterbox must not leave a language it will refuse.
  const spokenBy = (runtime: VoiceConfig["runtime"], patch: Partial<VoiceConfig>) => update(runtime === "chatterbox" && !CHATTERBOX_LANGUAGES.includes(config.language ?? "auto")
    ? { ...patch, language: "en" } : patch);
  const setRuntime = (runtime: VoiceConfig["runtime"]) => spokenBy(runtime, { runtime });
  // Where voice mode listens and speaks: the person's own addresses, or an extension that offers it. One chosen that is not running is still shown, as chosen.
  const providers = config.providers ?? [];
  const sources = [
    ...providers.map(p => ({ value: p.name, label: p.label, hint: p.ready ? undefined : t("Not running") })),
    ...(config.provider && !providers.some(p => p.name === config.provider) ? [{ value: config.provider, label: config.provider, hint: t("Not running") }] : []),
  ];
  const setProvider = (provider: string) => spokenBy(provider ? providers.find(p => p.name === provider)?.runtime : config.runtime, { provider });
  return <div className="mt-4 space-y-4">
    <div><p className="text-sm text-fg">{t("Voice")}</p><p className="mt-1 text-xs text-fg-faint">{t("Talk naturally, interrupt anytime, and hear replies in your chosen voice.")}</p></div>
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={config.enabled} onChange={e => update({ enabled: e.target.checked })} />{listening ? t("Enable dictation in sessions") : t("Enable voice controls in sessions")}</label>
    {sources.length > 0 && <div className="block text-xs text-fg-muted">{t("Listen and speak through")}<Select aria-label={t("Listen and speak through")} size="sm" className="mt-1.5 w-full" value={config.provider ?? ""} onChange={setProvider} options={[{ value: "", label: t("Your own addresses"), hint: t("Advanced connection") }, ...sources]} />
      {config.provider && !providers.some(p => p.name === config.provider && p.ready) && <p role="status" className="mt-1.5 text-xs text-warn">{t("Not running: voice mode cannot listen or speak through it until it is started. Meanwhile you can choose your own addresses.")}</p>}</div>}
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
    <details className="rounded-xl border border-line p-4">
      <summary className="cursor-pointer text-sm font-medium">{t("Advanced connection")}<span className="mt-1 block text-xs font-normal text-fg-muted">{t("Custom runtime and service addresses")}</span></summary>
      <div className="mt-4 space-y-4">
    {config.provider && <p className="text-xs text-fg-faint">{t("These are your own addresses: voice mode uses them when it listens and speaks through your own addresses. A dictation endpoint set here is used for dictation either way.")}</p>}
    <div className="block text-xs text-fg-muted">{t("Speech runtime")}<Select aria-label={t("Speech runtime")} size="sm" className="mt-1.5 w-full" value={config.runtime ?? "breeze"} onChange={v => setRuntime(v as VoiceConfig["runtime"])} options={[{ value: "breeze", label: "Breeze Python" }, { value: "audio-cpp", label: "Breeze audio.cpp", hint: t("Streaming") }, { value: "chatterbox", label: "Chatterbox audio.cpp", hint: t("Multilingual") }, { value: "kokoro", label: "Kokoro audio.cpp", hint: t("Built-in voices") }, { value: "none", label: t("No speech synthesis"), hint: t("Dictation only") }]} /></div>
    {([['whisperUrl', msg('Speech recognition URL')], ...(config.runtime === "none" ? [] : [['breezeUrl', msg('Speech synthesis URL')] as const])] as const).map(([key, label]) => <label key={key} className="block text-xs text-fg-muted">{t(label)}<input className={`mt-1.5 ${inputCls}`} value={config[key]} onChange={e => update({ [key]: e.target.value })} /></label>)}
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
