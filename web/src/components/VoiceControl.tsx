import { DEFAULT_VAD } from '../api';
import { VoiceProfiler } from '../voice-profile';
import { VoiceProfile } from './VoiceProfile';
import { activity } from '../transcript';
import { useCallback, useEffect, useRef, useState } from "react";
import { voiceCue, type VoiceCue } from "../voice-cues";
import { createPortal } from "react-dom";
import { VoiceStage, type VoiceLevels } from "./VoiceStage";
import { LuMic, LuLoaderCircle, LuGauge } from "react-icons/lu";
import type { MicVAD } from "@ricky0123/vad-web";
import { api, type PortalEvent } from "../api";
import type { Item } from "../transcript";
import { LiveTranscription } from "../live-transcription";
import { preparePcmSpeech, readPcmStream, playAudioBuffer } from "../pcm-stream";
import { samplesWav } from "../voice";
import { HandsFreeVoice, type VoicePhase } from "../hands-free";
import { FillerSounds } from "../voice-fillers";
import { WorkSounds } from "../work-sounds";
import { slowFiller, toolKind, type ToolKind } from "../tool-kind";

export function VoiceControl({ canvasOpen, onCanvasMinimize, onCanvasToggle, sessionId, items, running, onSend, onAbort, stageTarget, onModeChange, title, browserAvailable, browserActivity, terminalActivity, toolEvents }: {
  sessionId: string;
  canvasOpen: boolean; onCanvasMinimize: () => void; onCanvasToggle: () => void;
  stageTarget: HTMLElement | null;
  onModeChange: (active: boolean) => void;
  title: string;
  browserAvailable: boolean; browserActivity: number; terminalActivity: number; toolEvents: PortalEvent[];
  items: Item[];
  running: boolean;
  onSend: (text: string, options?: { voice?: boolean }) => Promise<void>;
  onAbort: () => Promise<void>;
}) {
  const [profileOpen,setProfileOpen]=useState(false);
  const profiling=useRef(false);profiling.current=profileOpen;
  const [,refreshProfile]=useState(0);
  const profiler=useRef<VoiceProfiler>();
  if(!profiler.current)profiler.current=new VoiceProfiler(()=>refreshProfile(n=>n+1));
  const eventSeq=useRef(0);eventSeq.current=toolEvents.reduce((n,e)=>Math.max(n,e.seq),0);
  const profileSeq=useRef(Infinity);
  const profileLiveSeen=useRef(new WeakSet<object>());
  const profileMark=(name:string)=>{if(profiling.current)profiler.current!.mark(name);};
  useEffect(()=>{
    if(!profiling.current)return;
    for(const event of toolEvents){
      if(event.seq < 0) { if(profileLiveSeen.current.has(event))continue; profileLiveSeen.current.add(event); }
      else { if(event.seq<=profileSeq.current)continue; profileSeq.current=event.seq; }
      const inner=event.payload?.assistantMessageEvent;
      if(event.type==='message_update'&&inner?.delta&&['text_delta','thinking_delta','toolcall_delta'].includes(inner.type))profileMark('first_model_token');
      if(event.type==='message_update'&&inner?.delta&&inner?.type==='text_delta')profileMark('first_text');
      if(event.type==='message_update'&&inner?.type==='thinking_delta')profileMark('first_thinking_token');
      if(event.type==='portal_prefill')profiler.current!.mark('prefill_progress',{total:event.payload?.total??0,processed:event.payload?.processed??0,cache:event.payload?.cache??0,timeMs:event.payload?.timeMs??0});
      if(['portal_prompt','compaction_start','compaction_end','tool_execution_start','tool_execution_end','agent_end'].includes(event.type))profileMark(event.type);
    }
  },[toolEvents]);
  const [sounds, setSounds] = useState(() => localStorage.getItem('voiceSounds') !== 'off');
  const soundsEnabled = useRef(sounds); soundsEnabled.current = sounds;
  const soundContext = useRef<AudioContext | null>(null);
  const cue = useCallback((kind: VoiceCue) => { if (soundsEnabled.current && soundContext.current) voiceCue(soundContext.current, kind); }, []);
  const toggleSounds = () => setSounds(value => { localStorage.setItem('voiceSounds', value ? 'off' : 'on'); return !value; });
  const [available, setAvailable] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [starting, setStarting] = useState(false);
  const [phase, setPhase] = useState<VoicePhase>("Listening");
  const phaseRef = useRef(phase); phaseRef.current = phase;
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [transcript, setTranscript] = useState("");
  const transcription = useRef<LiveTranscription | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const mutedRef = useRef(false);
  const muteBusy = useRef(false);
  const startButton = useRef<HTMLButtonElement>(null);
  const levels = useRef<VoiceLevels>({ input: 0, output: 0 });
  const compactionEvent = [...toolEvents].reverse().find(event => event.type === 'compaction_start' || event.type === 'compaction_end');
  const compacting = running && compactionEvent?.type === 'compaction_start';
  const latest = useRef({ items, running, onSend, onAbort, compacting, toolEvents });
  latest.current = { items, running, onSend, onAbort, compacting, toolEvents };
  const epoch = useRef(0);
  const mounted = useRef(false);
  const voice = useRef<HandsFreeVoice | null>(null);
  const vad = useRef<MicVAD | null>(null);
  const vadSettings = useRef(DEFAULT_VAD);
  const sequential = useRef(false);
  const statusSpeech = useRef(true);
  const work = useRef<WorkSounds | null>(null);
  const toolSeq = useRef(Infinity);
  const toolLiveSeen = useRef(new WeakSet<object>());
  const runningTools = useRef(new Map<string, { kind: ToolKind; at: number }>());
  const finishedTools = useRef(new Set<string>());
  /** Tool calls that overlap count as one stretch of work: when it began and whether any call failed. */
  const toolBatch = useRef<{ at: number; failed: boolean } | null>(null);
  const [comparison, setComparison] = useState(false);
  const sentenceChunks = useRef(false);
  const ttsPrefetch = useRef(false);
  const [prefetchMode, setPrefetchMode] = useState(false);
  const [sentenceMode, setSentenceMode] = useState(false);
  const [sequentialMode, setSequentialMode] = useState(false);
  const context = useRef<AudioContext | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const managed = useRef(false);
  const connection = useRef<string | null>(null);
  const heartbeat = useRef<ReturnType<typeof setInterval>>();
  const connectVoice = async(client:string,active:boolean)=>{
    const response=await fetch(`/api/sessions/${sessionId}/voice/connection`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client,active}),keepalive:!active});
    if(!response.ok)throw new Error((await response.json()).error||'Could not connect voice service');
  };
  const maxTurn = useRef<ReturnType<typeof setTimeout>>();
  const fillerLoading = useRef<AbortController | null>(null);

  const stop = () => {
    profiler.current?.close('stopped');
    epoch.current++;
    clearInterval(heartbeat.current);
    const lease=connection.current;connection.current=null;
    if(lease)void connectVoice(lease,false).catch(()=>{});
    const sound = soundContext.current; soundContext.current = null;
    if (sound) { if (soundsEnabled.current && mounted.current) voiceCue(sound, 'end'); setTimeout(() => { if (sound.state !== 'closed') void sound.close(); }, 180); }
    mutedRef.current = false;
    levels.current = { input: 0, output: 0 };
    clearTimeout(maxTurn.current);
    fillerLoading.current?.abort(); fillerLoading.current = null;
    work.current?.stop(); work.current = null;
    runningTools.current.clear(); finishedTools.current.clear(); toolBatch.current = null;
    voice.current?.stop(); voice.current = null;
    transcription.current?.reset(); transcription.current = null;
    const detector = vad.current; vad.current = null;
    void detector?.destroy().catch(() => {});
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = null;
    const audio = context.current; context.current = null;
    if (audio && audio.state !== "closed") void audio.close();
    if (mounted.current) { setEnabled(false); setStarting(false); setMuted(false); setSpeaking(false); setTranscript(""); }
  };
  useEffect(() => {
    mounted.current = true;
    const load = () => api.voice().then(config => {
      if (!mounted.current) return;
      managed.current=config.managed===true;
      statusSpeech.current = config.statusSpeech !== false;
      setComparison(config.comparison === true);
      sequential.current = config.pipelineMode === "sequential";
      setSequentialMode(sequential.current);
      sentenceChunks.current = config.sentenceChunks === true;
      setSentenceMode(sentenceChunks.current);
      ttsPrefetch.current = config.ttsPrefetch === true;
      setPrefetchMode(ttsPrefetch.current);
      vadSettings.current = { ...DEFAULT_VAD, ...config.vad };
      setAvailable(config.enabled);
      if (!config.enabled) stop();
    }).catch(() => { if (mounted.current) { setAvailable(false); stop(); } });
    void load();
    window.addEventListener("voice-config-changed", load);
    return () => { mounted.current = false; window.removeEventListener("voice-config-changed", load); stop(); };
  }, []);
  useEffect(() => {
    voice.current?.setCompacting(compacting, compactionEvent?.type === 'compaction_end' && !compactionEvent.payload?.aborted && !compactionEvent.payload?.errorMessage);
    voice.current?.observe(items);
    if (compacting) transcription.current?.discard();
  }, [items, running, compacting, compactionEvent]);
  const updateTyping = () => work.current?.setTyping(soundsEnabled.current && phaseRef.current === "Thinking"
    && [...runningTools.current.values()].some(tool => tool.kind === "command" || tool.kind === "edit"));
  useEffect(() => {
    for (const event of toolEvents) {
      if (event.seq < 0) { if (toolLiveSeen.current.has(event)) continue; toolLiveSeen.current.add(event); }
      else { if (event.seq <= toolSeq.current) continue; toolSeq.current = event.seq; }
      const controller = voice.current;
      if (!controller) continue;
      // A live event is later replayed from storage; the call ID keeps it from counting twice.
      const id = String(event.payload?.toolCallId ?? event.seq);
      if (event.type === "tool_execution_start" && !runningTools.current.has(id) && !finishedTools.current.has(id)) {
        const kind = toolKind(event.payload);
        runningTools.current.set(id, { kind, at: performance.now() });
        toolBatch.current ??= { at: performance.now(), failed: false };
        controller.toolStart(slowFiller(event.payload));
        if (soundsEnabled.current && phaseRef.current === "Thinking" && (kind === "read" || kind === "search" || kind === "browser")) work.current?.page();
      } else if (event.type === "tool_execution_end" && runningTools.current.has(id)) {
        const tool = runningTools.current.get(id)!;
        runningTools.current.delete(id); finishedTools.current.add(id);
        if (event.payload?.isError && toolBatch.current) toolBatch.current.failed = true;
        if (!runningTools.current.size && toolBatch.current) {
          controller.toolEnd(toolBatch.current.failed, performance.now() - toolBatch.current.at);
          toolBatch.current = null;
        }
        // Only a tool the listener waited on earns a completion tone.
        if (performance.now() - tool.at >= 1500 && phaseRef.current === "Thinking") cue(event.payload?.isError ? "failed" : "done");
      } else if (event.type === "agent_end" && runningTools.current.size) {
        // An aborted turn ends its tools without results; nothing to react to.
        runningTools.current.clear(); toolBatch.current = null; controller.toolEnd(false, 0);
      }
    }
    updateTyping();
  }, [toolEvents]);
  useEffect(updateTyping, [phase, sounds, enabled]);
  useEffect(() => {
    onModeChange(enabled || starting);
    return () => onModeChange(false);
  }, [enabled, starting, onModeChange]);

  const toggleMute = async () => {
    const detector = vad.current;
    if (!detector || muteBusy.current) return;
    const version = epoch.current;
    const next = !mutedRef.current;
    muteBusy.current = true;
    mutedRef.current = next;
    setMuted(next); cue(next ? "mute" : "unmute");
    clearTimeout(maxTurn.current);
    levels.current.input = 0;
    voice.current?.setMuted(next);
    if (next) {transcription.current?.reset();profiler.current?.close('muted');}
    try {
      if (next) {
        stream.current?.getTracks().forEach(track => { track.enabled = false; });
        detector.setOptions({ submitUserSpeechOnPause: false });
        await detector.pause();
      } else {
        detector.setOptions({ submitUserSpeechOnPause: true });
        stream.current?.getTracks().forEach(track => { track.enabled = true; });
        await detector.start();
      }
    } catch (e) {
      if (epoch.current === version) { setError((e as Error).message); stop(); }
    } finally { muteBusy.current = false; }
  };
  const endMode = () => {
    stop();
    requestAnimationFrame(() => startButton.current?.focus({ preventScroll: true }));
  };

  const synthesize = async (text: string, signal: AbortSignal, audio: AudioContext, kind:'reply'|'status'='reply') => {
    const trace=profiling.current?profiler.current!.current:undefined;
    const mark=(name:string,detail?:Record<string,number|string|boolean>,at?:number)=>{if(trace)profiler.current!.mark(kind+'_'+name,detail,trace,at);};
    mark('tts_request');
    // The previous cancelled request may still be releasing Breeze's GPU lock.
    let response: Response;
    const deadline = Date.now() + 15000;
    do {
      signal.throwIfAborted();
      response = await fetch(`/api/sessions/${sessionId}/voice/speech`, {
        method: "POST", headers: { "Content-Type": "application/json", "Accept": "audio/pcm" },
        body: JSON.stringify({ text }), signal,
      });
      if (response.ok) break;
      mark('tts_retry',{http:response.status});
      const failure = await response.json().catch(() => ({}));
      // Older portal processes wrap Breeze's busy response in HTTP 502. This
      // also permits updating the UI without restarting an active session.
      const busy = response.status === 409 && failure.error === "Breeze is finishing another request"
        || response.status === 502 && /^Breeze returned HTTP 409/.test(failure.error || "");
      if (!busy || Date.now() >= deadline) throw new Error(failure.error || "Speech generation failed");
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, 500);
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      });
    } while (true);
    if (!response.ok) throw new Error((await response.json()).error || "Speech generation failed");
    mark('tts_headers',{serverTiming:response.headers.get('server-timing')??''});
    let body=response.body;
    if(body&&trace){let first=true;body=body.pipeThrough(new TransformStream<Uint8Array<ArrayBuffer>,Uint8Array<ArrayBuffer>>({transform(chunk,controller){if(first&&chunk.length){first=false;mark('first_bytes');}controller.enqueue(chunk);}}));}
    let buffer: AudioBuffer | undefined;
    let stream: Awaited<ReturnType<typeof preparePcmSpeech>> | undefined;
    if (response.headers.get("content-type")?.startsWith("audio/pcm")) {
      if (response.headers.get("x-sample-rate") !== "24000" || !body) throw new Error("Unsupported speech stream");
      if (!sequential.current && response.headers.get("x-voice-streaming") === "true") stream = await preparePcmSpeech(body!, audio, signal);
      else buffer = await readPcmStream(body!, audio, signal);
    } else {
      const bytes = await new Response(body).arrayBuffer(); signal.throwIfAborted();
      buffer = await audio.decodeAudioData(bytes); signal.throwIfAborted();
    }
    mark('audio_ready');
    const play = async (playbackSignal: AbortSignal) => {
      playbackSignal.throwIfAborted();
      const analyser = audio.createAnalyser(); analyser.fftSize = 256;
      analyser.connect(audio.destination);
      const samples = new Float32Array(analyser.fftSize);
      let animation = 0;
      const meter = () => {
        analyser.getFloatTimeDomainData(samples);
        levels.current.output = Math.min(1, Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) * 5);
        animation = requestAnimationFrame(meter);
      };
      try {
        const started = (scheduledAt=audio.currentTime) => {
          mark('playback_scheduled');
          const outputMs=(audio.baseLatency+(audio.outputLatency||0))*1000;
          mark('playback_estimate',{outputLatencyMs:outputMs},performance.now()+Math.max(0,scheduledAt-audio.currentTime)*1000+outputMs);
          setSpeaking(true); meter();
        };
        if (stream) await stream.play(analyser, started);
        else await playAudioBuffer(buffer!, audio, analyser, playbackSignal, started);
      } finally {
        analyser.disconnect(); cancelAnimationFrame(animation); levels.current.output = 0;
        if (mounted.current) setSpeaking(false);
      }
    };
    return Object.assign(play, { completed: stream?.completed });
  };
  const start = async () => {
    if (voice.current || starting) { stop(); return; }
    const version = ++epoch.current;
    const current = () => mounted.current && epoch.current === version;
    setStarting(true); setError(""); setMuted(false); mutedRef.current = false;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
        throw new Error("Microphone access requires HTTPS or localhost.");
      const sound = new AudioContext(); soundContext.current = sound;
      work.current = new WorkSounds(sound);
      // Tool calls from before voice started are history, not work to voice.
      toolSeq.current = eventSeq.current;
      latest.current.toolEvents.forEach(event => { if (event.seq < 0) toolLiveSeen.current.add(event); });
      await sound.resume();
      if (!current()) return;
      const audio = new AudioContext(); context.current = audio;
      await audio.resume();
      if (!current()) return;
      const mic = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      } });
      if (!current()) { mic.getTracks().forEach(track => track.stop()); return; }
      stream.current = mic;
      if(managed.current){
        const lease=crypto.randomUUID();connection.current=lease;
        await connectVoice(lease,true);
        if(!current())return;
        heartbeat.current=setInterval(()=>{void connectVoice(lease,true).catch(e=>{if(current()){setError(e.message);stop();}});},25000);
      }
      const detectorModule = await import("@ricky0123/vad-web");
      if (!current()) return;
      const live = new LiveTranscription(async (samples, signal) => {
        const trace=profiling.current?profiler.current!.current:undefined;
        const started=performance.now();if(trace)profiler.current!.mark('stt_request',{audioMs:samples.length/16},trace);
        const response = await fetch(`/api/sessions/${sessionId}/voice/transcribe`, {
          method: "POST", headers: { "Content-Type": "audio/wav" }, body: samplesWav(samples), signal,
        });
        const result = await response.json();
        if(trace)profiler.current!.mark('stt_result',{requestMs:performance.now()-started,serverTiming:response.headers.get('server-timing')??'',ok:response.ok},trace);
        if (!response.ok) throw new Error(result.error || "Transcription failed");
        return result.text;
      }, text => { if (current()) setTranscript(text); }, !sequential.current);
      transcription.current = live;
      const fillers = new FillerSounds(audio);
      const controller = new HandsFreeVoice({
        statusSpeech: statusSpeech.current,
        notices: () => fillers.notices,
        sequential: sequential.current,
        sentenceChunks: sentenceChunks.current,
        ttsPrefetch: ttsPrefetch.current,
        transcribe: async (samples, signal) => {const result=await live.finish(samples, signal);profileMark('transcript_ready');return result;},
        send: text => {profileSeq.current=eventSeq.current;profileMark('send'); cue("sent"); return latest.current.onSend(text, { voice: true }); },
        abort: () => latest.current.onAbort(),
        agentRunning: () => latest.current.running,
        synthesize: (text, signal,kind) => synthesize(text, signal, audio,kind),
        filler: (kind, signal) => fillers.play(kind, signal),
        trace: profileMark,
        phase: value => { if (current()) setPhase(value); },
        error: message => { if (current()) {setError(message);profiler.current?.close('error');} },
      }, latest.current.items);
      voice.current = controller;
      controller.setCompacting(latest.current.compacting);
      const detector = await detectorModule.MicVAD.new({
        model: "v5", audioContext: audio, startOnLoad: false,
        baseAssetPath: "/voice-assets/", onnxWASMBasePath: "/voice-assets/",
        ortConfig: ort => { ort.env.wasm.numThreads = 1; },
        getStream: async () => mic,
        pauseStream: async () => {},
        resumeStream: async () => mic,
        ...vadSettings.current,
        submitUserSpeechOnPause: true,
        onSpeechStart: () => { if (current() && !mutedRef.current && !latest.current.compacting) {if(profiling.current)profiler.current!.begin();live.begin();} },
        onVADMisfire: () => { if (current()) {live.discard();if(profiling.current)profiler.current!.close('vad_misfire');} },
        onFrameProcessed: (probabilities, frame) => {
          if(current()&&!mutedRef.current&&profiling.current&&probabilities.isSpeech>=0.35)profiler.current!.lastSpeech();
          if (current() && !mutedRef.current && !latest.current.compacting) live.frame(probabilities.isSpeech, frame);
          if (current() && !mutedRef.current) levels.current.input = Math.min(1, Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / frame.length) * 7);
        },
        onSpeechRealStart: () => {
          if (!current() || mutedRef.current) return;
          setError(""); if (latest.current.compacting) live.discard(); else live.confirm(); controller.speechStart();
          clearTimeout(maxTurn.current);
          maxTurn.current = setTimeout(async () => {
            if (!current() || !vad.current) return;
            // Bound recording size; keep the same mic stream while submitting
            // the segment and automatically listening for the continuation.
            const active = vad.current;
            try { await active.pause(); if (current()) await active.start(); }
            catch (e) { if (current()) { setError((e as Error).message); stop(); } }
          }, 60000);
        },
        onSpeechEnd: samples => {
          clearTimeout(maxTurn.current);
          if (current() && !mutedRef.current) { if (!latest.current.compacting) {profileMark('endpoint');live.end(samples);} controller.speechEnd(samples); }
        },
      });
      if (!current()) { await detector.destroy(); return; }
      vad.current = detector;
      for (const track of mic.getTracks()) track.onended = () => {
        if (current()) { setError("Microphone disconnected. Reconnect it and turn the mic on again."); stop(); }
      };
      await detector.start();
      if (!current()) return;
      setEnabled(true); setStarting(false); cue("start");
      if (statusSpeech.current && !sequential.current) {
        // The portal renders clips when voice is set up; this only downloads them.
        const loading = new AbortController(); fillerLoading.current = loading;
        void fillers.load(navigator.languages?.length ? navigator.languages : [navigator.language], loading.signal);
      }
    } catch (e) {
      if (current()) { setError((e as Error).message); stop(); }
    }
  };

  if (!available) return null;
  return <>
    {profileOpen&&createPortal(<VoiceProfile profiler={profiler.current!} onClose={()=>{setProfileOpen(false);profiler.current!.close('disabled');}}/>,document.body)}

    {(starting || enabled) && stageTarget && createPortal(
      <VoiceStage workPhase={running ? activity(toolEvents) : null} canvasOpen={canvasOpen} onCanvasMinimize={onCanvasMinimize} onCanvasToggle={onCanvasToggle} title={sequentialMode ? `${title} · ${sentenceMode ? (prefetchMode ? "Sentence pipeline · buffered audio" : "Sentence chunks · buffered audio") : "Sequential baseline"}` : comparison ? `${title} · Streaming pipeline` : title} phase={phase} starting={starting} muted={muted} speaking={speaking}
        browserAvailable={browserAvailable} browserActivity={browserActivity} terminalActivity={terminalActivity} toolEvents={toolEvents} sounds={sounds} onSounds={toggleSounds} onCue={cue}
        levels={levels} transcript={transcript} error={error} onMute={toggleMute} onEnd={endMode} />, stageTarget,
    )}
    <div className="relative flex items-center gap-1">
      <button type="button" className="prompt-action" aria-label="Profile voice latency" title="Profile voice latency" aria-pressed={profileOpen} onClick={()=>{setProfileOpen(v=>!v);if(profileOpen)profiler.current!.close('disabled');}}><LuGauge/></button>
      {error && !enabled && !starting && <p role="alert" className="absolute bottom-full right-0 mb-3 w-64 rounded-xl border border-line bg-surface p-3 text-xs text-danger shadow-pop">{error}</p>}
      <button ref={startButton} type="button" onClick={start} aria-label="Turn on hands-free voice" title="Start voice conversation" className="prompt-action">
        {starting ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuMic aria-hidden />}
      </button>
    </div>
  </>;
}
