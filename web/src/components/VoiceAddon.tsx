import { VoiceLibrary } from './VoiceLibrary';
import { useEffect, useState } from "react";
import { DEFAULT_VAD, api, type VoiceInstallStatus, type VoiceConfig } from "../api";
import { INPUT_LANGUAGES, CHATTERBOX_LANGUAGES } from "../../../server/src/voice-languages";
import { NUMBER_PACK_LANGUAGES } from "../../../server/src/voice-numbers";

export function VoiceAddon({ onError }: { onError: (message: string) => void }) {
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  const [install, setInstall] = useState<VoiceInstallStatus | null>(null);
  useEffect(()=>{if(install?.state==='running')void api.voice().then(value=>{setConfig(value);window.dispatchEvent(new Event('voice-config-changed'));}).catch(e=>onError(e.message));},[install?.state]);
  const [actionBusy, setActionBusy] = useState(false);
  useEffect(() => {
    let disposed=false, timer: ReturnType<typeof setTimeout>;
    const poll=async()=>{try { const state=await api.voiceInstallStatus(); if(!disposed)setInstall(state); } catch(e) { if(!disposed)setInstall({available:false,state:'unavailable',busy:false,progress:'',error:(e as Error).message}); } finally { if(!disposed)timer=setTimeout(poll,2500); }};
    void poll(); return ()=>{disposed=true;clearTimeout(timer);};
  },[]);
  const manage=async(action:'install'|'start'|'stop')=>{setActionBusy(true);try{await api.voiceAction(action);setInstall(await api.voiceInstallStatus());}catch(e){onError((e as Error).message);}finally{setActionBusy(false);}};
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => { api.voice().then(setConfig).catch(e => onError(e.message)); }, []);
  if (!config) return null;
  const update = (patch: Partial<VoiceConfig>) => { setConfig({ ...config, ...patch }); setSaved(false); };
  const chatterbox = config.runtime === "chatterbox";
  const languages = chatterbox ? INPUT_LANGUAGES.filter(([code]) => CHATTERBOX_LANGUAGES.includes(code)) : INPUT_LANGUAGES;
  // Switching runtime must not leave a language the runtime will refuse on save.
  const setRuntime = (runtime: VoiceConfig["runtime"]) => update(runtime === "chatterbox" && !CHATTERBOX_LANGUAGES.includes(config.language ?? "auto")
    ? { runtime, language: "en" } : { runtime });
  return <div className="mt-4 space-y-4">
    <div><p className="text-sm text-fg">Voice</p><p className="mt-1 text-xs text-fg-faint">Talk naturally, interrupt anytime, and hear replies in your chosen voice.</p></div>
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={config.enabled} onChange={e => update({ enabled: e.target.checked })} />Enable voice controls in sessions</label>
    <section className="rounded-xl border border-line bg-surface/50 p-4 space-y-4">
      <div><h3 className="text-sm font-medium">Your voice</h3><p className="mt-1 text-xs text-fg-muted">Choose how your assistant sounds.</p></div>
    <VoiceLibrary value={config.voice || "design"} onChange={voice=>update({voice})} onError={onError}/>
      {["design","aria"].includes(config.voice||"design") && <label className="block text-xs text-fg-muted">Describe the speaking voice<input className="mt-1.5 w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs" value={config.instruction} onChange={e=>update({instruction:e.target.value})}/></label>}
    </section>
    <section className="rounded-xl border border-line bg-surface/50 p-4 space-y-4">
      <h3 className="text-sm font-medium">Conversation</h3>
    <label className="block text-xs text-fg-muted">Input language<select className="mt-1.5 w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs" value={config.language || "auto"} onChange={e => update({ language: e.target.value })}>{languages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <p className="text-xs text-fg-faint">Choosing your language improves recognition on short turns.</p>
    {chatterbox
      ? <label className="block text-xs text-fg-muted">Speech delivery<select className="mt-1.5 w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs" value={config.exaggeration ?? 0.5} onChange={e => update({ exaggeration: Number(e.target.value) })}><option value={0.3}>Calm · flatter delivery</option><option value={0.5}>Natural · as recorded</option><option value={0.8}>Expressive · stronger emotion</option></select></label>
      : <label className="block text-xs text-fg-muted">Speech generation<select className="mt-1.5 w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs" value={config.cfgScale ?? 4} onChange={e => update({ cfgScale: Number(e.target.value) })}><option value={1}>Fast · lighter voice guidance</option><option value={4}>Expressive · stronger voice guidance</option></select></label>}
    {chatterbox && <p className="text-xs text-fg-faint">Chatterbox speaks your input language and clones the selected reference voice; it has no designed voice.{NUMBER_PACK_LANGUAGES.includes(config.language ?? "") ? " Numbers are written out before synthesis so they are spoken correctly." : " Numbers stay as digits in this language, which Chatterbox reads unreliably."}</p>}
    {chatterbox && (config.voice || "design") === "design" && <p role="alert" className="text-xs text-red-400">Choose Aria or a voice with a recording above: Chatterbox cannot speak with a designed voice.</p>}
    </section>
    <details className="rounded-xl border border-line p-4">
      <summary className="cursor-pointer text-sm font-medium">Speech detection<span className="mt-1 block text-xs font-normal text-fg-muted">Turn timing and microphone sensitivity · Silero VAD</span></summary>
      <div className="mt-4 space-y-4">
        <p className="text-xs text-fg-faint">Save, then restart voice mode to apply. Shorter silence responds faster but can cut off pauses.</p>
        {([
          ['redemptionMs', 'End-of-turn silence', 200, 3000, 50, 'ms', 'How long to wait after speech before sending your turn.'],
          ['positiveSpeechThreshold', 'Speech-start threshold', 0.01, 1, 0.01, '', 'Higher values reject more noise but may miss quiet speech.'],
          ['negativeSpeechThreshold', 'Speech-end threshold', 0, 0.99, 0.01, '', 'Below this confidence, audio counts as silence. Must be lower than the start threshold.'],
          ['minSpeechMs', 'Minimum speech duration', 64, 2000, 16, 'ms', 'Shorter sounds are ignored as accidental triggers.'],
          ['preSpeechPadMs', 'Audio before speech', 0, 1000, 20, 'ms', 'Retain the beginning of words before speech is confirmed.'],
        ] as const).map(([key, label, min, max, step, unit, help]) => <label key={key} className="block text-xs text-fg-muted">
          <span className="flex justify-between gap-3"><span>{label}</span><span className="tabular-nums text-accent">{config.vad?.[key] ?? DEFAULT_VAD[key]} {unit}</span></span>
          <input type="range" className="mt-2 w-full accent-current" min={min} max={max} step={step} value={config.vad?.[key] ?? DEFAULT_VAD[key]} onChange={e => update({ vad: { ...DEFAULT_VAD, ...config.vad, [key]: Number(e.target.value) } })} />
          <span className="mt-1 block text-fg-faint">{help}</span>
        </label>)}
        <button type="button" className="rounded-lg border border-line px-3 py-1.5 text-xs" onClick={() => update({vad: {...DEFAULT_VAD}})}>Reset speech detection</button>
      </div>
    </details>
    <details className="group rounded-xl border border-line p-4">
      <summary className="cursor-pointer text-sm font-medium">Voice service <span className="ml-2 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-normal text-accent">{install?.state === 'absent' ? 'Not installed' : install?.state === 'running' ? 'Ready' : install?.state ?? 'Checking…'}</span><span className="mt-1 block text-xs font-normal text-fg-muted">Installation, GPU memory and service controls</span></summary>
    <div className="mt-4 space-y-3">
      <p className="text-xs text-fg-faint">Install once on your NVIDIA Docker host. Setup downloads and quantizes Breeze, and installs Whisper. Allow 30 GB of disk space during setup.</p>
      <div className="flex gap-2 flex-wrap">
        {install?.available && <button disabled={actionBusy || install.busy || ['starting','running'].includes(install.state)} className="rounded-lg bg-accent/12 px-3 py-1.5 text-xs text-accent disabled:opacity-40" onClick={()=>manage(install.state==='absent'?'install':'start')}>{install.state==='absent'?'Install voice':install.state==='failed'?'Retry setup':'Start voice'}</button>}
        {install?.available && ['starting','running'].includes(install.state) && <button disabled={actionBusy} className="rounded-lg border border-line px-3 py-1.5 text-xs" onClick={()=>manage('stop')}>Stop · release VRAM</button>}
        {install?.state==='running' && <button disabled={busy} className="rounded-lg bg-accent/12 px-3 py-1.5 text-xs text-accent" onClick={async()=>{setBusy(true);try{setConfig(await api.connectVoice());window.dispatchEvent(new Event('voice-config-changed'));}catch(e){onError((e as Error).message);}finally{setBusy(false);}}}>Use installed voice</button>}
      </div>
      {install?.error && <p role="alert" className="text-xs text-red-400">{install.error}</p>}
      {install?.progress && <details open={install.state==='starting'||install.state==='failed'||install.busy}><summary className="text-xs cursor-pointer text-fg-muted">Setup log</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px] text-fg-faint" aria-label="Voice setup log">{install.progress}</pre></details>}
      <p className="text-xs text-fg-faint">Stopping releases GPU memory and keeps your models.</p>
    </div>
      <div className="mt-4 border-t border-line pt-4 space-y-2">
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={config.lazyLoad!==false} onChange={e=>update({lazyLoad:e.target.checked})}/>Lazy load · release GPU memory when voice is idle</label>
    <p className="text-xs text-fg-faint">Load on connection and release memory after the last session ends. Turn off to keep Breeze ready for faster starts.</p>
      </div>
    </details>
    <details className="rounded-xl border border-line p-4">
      <summary className="cursor-pointer text-sm font-medium">Advanced connection<span className="mt-1 block text-xs font-normal text-fg-muted">Custom runtime and service addresses</span></summary>
      <div className="mt-4 space-y-4">
    <label className="block text-xs text-fg-muted">Speech runtime<select className="mt-1.5 w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs" value={config.runtime ?? "breeze"} onChange={e => setRuntime(e.target.value as VoiceConfig["runtime"])}><option value="breeze">Breeze Python</option><option value="audio-cpp">Breeze audio.cpp · streaming</option><option value="chatterbox">Chatterbox audio.cpp · multilingual</option></select></label>
    {([['whisperUrl', 'Speech recognition URL'], ['breezeUrl', 'Speech synthesis URL']] as const).map(([key, label]) => <label key={key} className="block text-xs text-fg-muted">{label}<input className="mt-1.5 w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs" value={config[key]} onChange={e => update({ [key]: e.target.value })} /></label>)}
    <label className="block text-xs text-fg-muted">Speech recognition model<input className="mt-1.5 w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs" placeholder="Whisper.cpp needs none; audio.cpp names its model, e.g. qwen3-asr" value={config.sttModel ?? ""} onChange={e => update({ sttModel: e.target.value })} /></label>
      </div>
    </details>
    <div className="sticky -bottom-4 z-10 -mx-5 !-mb-4 flex justify-end border-t border-line bg-raised px-5 pt-3 pb-7">
    <button disabled={busy} className="rounded-lg bg-accent px-4 py-2 text-xs font-medium text-black disabled:opacity-40" onClick={async () => {
      setBusy(true); try { setConfig(await api.setVoice(config)); setSaved(true); window.dispatchEvent(new Event('voice-config-changed')); } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
    }}>{busy ? 'Saving…' : saved ? 'Saved' : 'Save voice settings'}</button>
    </div>
  </div>;
}
