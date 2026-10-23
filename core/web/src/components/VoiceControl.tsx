import { DEFAULT_VAD } from '../api';
import { local, session } from '../safe-storage';
import { VoiceProfiler, replyMarks } from '../voice-profile';
import { VoiceProfile } from './VoiceProfile';
import type { Activity } from '../transcript';
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { voiceCue, type VoiceCue } from "../voice-cues";
import { createPortal } from "react-dom";
import { VoiceStage, type VoiceLevels } from "./VoiceStage";
import { LuAudioLines, LuLoaderCircle, LuGauge } from "react-icons/lu";
import type { MicVAD } from "@ricky0123/vad-web";
import { api, json, type PortalEvent, type PromptOptions } from "../api";
import { micError } from "../mic-error";
import type { Item } from "../transcript";
import { LiveTranscription } from "../live-transcription";
import { preparePcmSpeech, readPcmStream, playAudioBuffer, bufferOf } from "../pcm-stream";
import { stretchInSteps } from "../time-stretch";
import { joinSamples } from "../samples";
import { asksToRepeat, couldAskToRepeat } from "../voice-commands";
import { isImage, pending, type Attachment } from "../attachments";
import { VOICE_RATES } from "./VoiceSettings";
import { describe, matches, useKeyLabels, useKeybindings } from "../keybindings";
import { HandsFreeVoice, type VoicePhase } from "../hands-free";
import { t } from "../i18n";

/** The waits between the tries at fetching the spoken error line as voice mode starts. */
const ERROR_LINE_WAITS_MS = [1000, 3000];
/** How long an error waits for an error line that is still being fetched. */
const ERROR_LINE_WAIT_MS = 8000;
/** How much of the last reply Repeat keeps: two minutes is about 11 MB of samples. */
const REPEAT_SECONDS = 120;
/** A phrase of the last reply, and the last speed Repeat played it at, so a second Repeat need not work it out again. */
type KeptPhrase = { samples: Float32Array[]; sampleRate: number; stretched?: { rate: number; samples: Promise<Float32Array>; signal: AbortSignal; ready?: boolean } };
const seconds = (phrase: KeptPhrase) => phrase.samples.reduce((n, s) => n + s.length, 0) / phrase.sampleRate;

export function VoiceControl({ sessionId, folder, items, running, work, onSend, onAbort, stageTarget, onModeChange, title, toolEvents }: {
  sessionId: string;
  /** The folder the chat works in: a tool card names a file by its path there, and the windows are told of it. */
  folder: string;
  stageTarget: HTMLElement | null;
  onModeChange: (active: boolean) => void;
  title: string;
  toolEvents: PortalEvent[];
  items: Item[];
  running: boolean;
  /** What the agent is doing now (the chat works it out once, from the same events), or null when it is not running. */
  work: Activity | null;
  onSend: (text: string, options?: PromptOptions) => Promise<void>;
  onAbort: () => Promise<void>;
}) {
  const [profileOpen,setProfileOpen]=useState(false);
  const profiling=useRef(false);profiling.current=profileOpen;
  const [,refreshProfile]=useState(0);
  const profiler=useRef<VoiceProfiler>();
  if(!profiler.current)profiler.current=new VoiceProfiler(()=>refreshProfile(n=>n+1));
  // Read again only when there are new events: this component is drawn with every key typed in the chat's box.
  const newestSeq=useMemo(()=>toolEvents.reduce((n,e)=>Math.max(n,e.seq),0),[toolEvents]);
  const eventSeq=useRef(0);eventSeq.current=newestSeq;
  const profileSeq=useRef(Infinity);
  const profileLiveSeen=useRef(new WeakSet<object>());
  const profileMark=(name:string)=>{if(profiling.current)profiler.current!.mark(name);};
  useEffect(()=>{
    if(!profiling.current)return;
    for(const event of toolEvents){
      if(event.seq < 0) { if(profileLiveSeen.current.has(event))continue; profileLiveSeen.current.add(event); }
      else { if(event.seq<=profileSeq.current)continue; profileSeq.current=event.seq; }
      for(const name of replyMarks(event))profileMark(name);
      if(event.type==='portal_prefill')profiler.current!.mark('prefill_progress',{total:event.payload?.total??0,processed:event.payload?.processed??0,cache:event.payload?.cache??0,timeMs:event.payload?.timeMs??0});
      if(['portal_prompt','compaction_start','compaction_end','tool_execution_start','tool_execution_end','agent_end'].includes(event.type))profileMark(event.type);
    }
  },[toolEvents]);
  // Pictures waiting to go with the next thing said: the same ones as in the
  // chat's message box, so they are there before voice mode and after it.
  const [attachments, setAttachments] = useState<Attachment[]>(() => pending.get(sessionId));
  useEffect(() => pending.subscribe(id => { if (id === sessionId) setAttachments(pending.get(id)); }), [sessionId]);
  const addPictures = async (files: File[]) => {
    const pictures = files.filter(file => isImage(file.type));
    const problems = pictures.length < files.length ? [t("Only PNG, JPEG, GIF and WebP pictures can be sent in voice mode. Put other files in the chat's folder.")] : [];
    problems.push(...await pending.add(sessionId, pictures));
    if (problems.length && mounted.current) setError(problems.join(" "));
  };
  // What talking mid-run does, how fast replies are spoken, and push-to-talk:
  // read by the controller and the speech at the moment they matter.
  const [steer, setSteer] = useState(() => local.get('voiceSteer') === 'on');
  const steering = useRef(steer); steering.current = steer;
  const [rate, setRate] = useState(() => { const saved = Number(local.get('voiceRate')); return VOICE_RATES.includes(saved) ? saved : 1; });
  const speed = useRef(rate); speed.current = rate;
  const [ptt, setPtt] = useState(() => local.get('voicePtt') === 'on');
  const pushToTalk = useRef(ptt); pushToTalk.current = ptt;
  const [holding, setHolding] = useState(false);
  /** A push-to-talk press: what was heard, how much of it while still held, and the most speech-like frame. */
  const held = useRef<{ frames: Float32Array[]; releasing: boolean; heldFrames: number; speech: number; started: boolean; timer?: ReturnType<typeof setTimeout> } | null>(null);
  const holdLimit = useRef<ReturnType<typeof setTimeout>>();
  // The last reply as it was spoken, phrase by phrase, for Repeat. Samples as
  // they came from the speech service, before the speed was applied. Only the
  // last REPEAT_SECONDS of it: a long run that talks before every step would
  // otherwise keep all of that audio.
  const replyAudio = useRef<KeptPhrase[]>([]);
  const [canRepeat, setCanRepeat] = useState(false);
  const replay = useRef<AbortController | null>(null);
  const [sounds, setSounds] = useState(() => local.get('voiceSounds') !== 'off');
  const soundsEnabled = useRef(sounds); soundsEnabled.current = sounds;
  const soundContext = useRef<AudioContext | null>(null);
  const cue = useCallback((kind: VoiceCue) => { if (soundsEnabled.current && soundContext.current) voiceCue(soundContext.current, kind); }, []);
  const toggleSounds = () => setSounds(value => { local.set('voiceSounds', value ? 'off' : 'on'); return !value; });
  const [available, setAvailable] = useState(false);
  // After a reload voice mode comes back, but audio may not start until the
  // page has been touched: the stage is shown and waits for that.
  const [waitingForTap, setWaitingForTap] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [starting, setStarting] = useState(false);
  const [phase, setPhase] = useState<VoicePhase>("Listening");
  const [error, setError] = useState("");
  // A notice that did not end voice mode (the spoken error line missing, say): once voice mode is over it fades by itself. Failures that ended it stay until dismissed or the next start.
  const [fadingError, setFadingError] = useState("");
  // Where the controller began, once it has: the stage opens the conversation on errors after it, and the controller says the same ones.
  const [errorsAfter, setErrorsAfter] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [transcript, setTranscript] = useState("");
  const transcription = useRef<LiveTranscription | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const mutedRef = useRef(false);
  const muteBusy = useRef(false);
  const startButton = useRef<HTMLButtonElement>(null);
  const levels = useRef<VoiceLevels>({ input: 0, output: 0 });
  const compactionEvent = useMemo(() => {
    for (let i = toolEvents.length - 1; i >= 0; i--) if (toolEvents[i].type === 'compaction_start' || toolEvents[i].type === 'compaction_end') return toolEvents[i];
  }, [toolEvents]);
  const compacting = running && compactionEvent?.type === 'compaction_start';
  const latest = useRef({ items, running, onSend, onAbort, compacting });
  latest.current = { items, running, onSend, onAbort, compacting };
  const epoch = useRef(0);
  const mounted = useRef(false);
  const restoring = useRef(false);
  // Read once, as the chat opens: whether voice mode was on in this tab before a reload.
  const resume = useRef<boolean | null>(null);
  if (resume.current === null) resume.current = session.get('voiceActive') === sessionId;
  // Held while voice mode is on in this tab. A duplicated tab gets a copy of
  // session storage, so the flag alone would start a second voice session on
  // the same chat; the lock is how it finds this one still going.
  const lockName = `voice:${sessionId}`;
  const releaseLock = useRef<(() => void) | undefined>();
  /**
   * Takes that lock for as long as voice mode is on here. False only when
   * voice mode is being brought back and another tab has it: the tab this one
   * was duplicated from. Turned on by hand, it goes on either way.
   */
  const claim = async (version: number, resuming: boolean): Promise<boolean> => {
    if (!navigator.locks) return true;
    for (let attempt = 0; ; attempt++) {
      const got = await new Promise<boolean>(resolve => {
        navigator.locks.request(lockName, { ifAvailable: true }, lock => {
          resolve(!!lock);
          if (!lock || epoch.current !== version) return;
          return new Promise<void>(release => { releaseLock.current = release; });
        }).catch(() => resolve(true));
      });
      if (got || !resuming) return true;
      if (attempt >= 3 || epoch.current !== version) return false;
      // The page before the reload may take a moment to let go of it.
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  };
  const voice = useRef<HandsFreeVoice | null>(null);
  const vad = useRef<MicVAD | null>(null);
  const vadSettings = useRef(DEFAULT_VAD);
  const sequential = useRef(false);
  const statusSpeech = useRef(true);
  const [comparison, setComparison] = useState(false);
  const sentenceChunks = useRef(false);
  const ttsPrefetch = useRef(false);
  const [prefetchMode, setPrefetchMode] = useState(false);
  const [sentenceMode, setSentenceMode] = useState(false);
  const [sequentialMode, setSequentialMode] = useState(false);
  const context = useRef<AudioContext | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const connection = useRef<string | null>(null);
  const heartbeat = useRef<ReturnType<typeof setInterval>>();
  // The lease's updates go one after another, in the order they were made: a heartbeat still on its way when voice mode
  // stops would otherwise reach the server after the release, and take the lease again.
  const connectionUpdates = useRef<Promise<unknown>>(Promise.resolve());
  const connectVoice = (client:string,active:boolean)=>{
    const update = connectionUpdates.current.then(()=>json(`/api/sessions/${sessionId}/voice/connection`,{method:'POST',body:JSON.stringify({client,active}),keepalive:!active}));
    connectionUpdates.current = update.catch(()=>{});
    return update;
  };
  const maxTurn = useRef<ReturnType<typeof setTimeout>>();
  // The spoken error line, asked for as voice mode started, in the chat's own voice: its audio once it is there, or nothing.
  const errorLine = useRef<{ ready: Promise<ArrayBuffer | undefined> } | null>(null);

  useEffect(() => {
    if (!error || error !== fadingError || enabled || starting) return;
    const timer = setTimeout(() => setError(""), 5000);
    return () => clearTimeout(timer);
  }, [error, fadingError, enabled, starting]);

  const stop = () => {
    profiler.current?.close('stopped');
    // Ended, or left for another chat: a reload after this does not bring it back.
    if (session.get('voiceActive') === sessionId) session.remove('voiceActive');
    releaseLock.current?.(); releaseLock.current = undefined;
    epoch.current++;
    clearInterval(heartbeat.current);
    const lease=connection.current;connection.current=null;
    if(lease)void connectVoice(lease,false).catch(()=>{});
    const sound = soundContext.current; soundContext.current = null;
    if (sound) { if (soundsEnabled.current && mounted.current) voiceCue(sound, 'end'); setTimeout(() => { if (sound.state !== 'closed') void sound.close(); }, 180); }
    mutedRef.current = false;
    levels.current = { input: 0, output: 0 };
    clearTimeout(maxTurn.current);
    clearTimeout(holdLimit.current); clearTimeout(held.current?.timer); held.current = null;
    replay.current?.abort(); replay.current = null;
    errorLine.current = null;
    voice.current?.stop(); voice.current = null; setErrorsAfter(null);
    transcription.current?.reset(); transcription.current = null;
    const detector = vad.current; vad.current = null;
    void detector?.destroy().catch(() => {});
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = null;
    const audio = context.current; context.current = null;
    if (audio && audio.state !== "closed") void audio.close();
    if (mounted.current) { setEnabled(false); setStarting(false); setMuted(false); setSpeaking(false); setTranscript(""); setHolding(false); setWaitingForTap(false); }
  };
  useEffect(() => {
    mounted.current = true;
    const load = () => api.voice().then(config => {
      if (!mounted.current) return;
      statusSpeech.current = config.statusSpeech !== false;
      setComparison(config.comparison === true);
      sequential.current = config.pipelineMode === "sequential";
      setSequentialMode(sequential.current);
      sentenceChunks.current = config.sentenceChunks === true;
      setSentenceMode(sentenceChunks.current);
      ttsPrefetch.current = config.ttsPrefetch === true;
      setPrefetchMode(ttsPrefetch.current);
      vadSettings.current = { ...DEFAULT_VAD, ...config.vad };
      // Voice mode speaks its replies: without speech synthesis, or with voice conversations switched off in Settings, there
      // is nothing for it to do. Dictation, which only listens, stays.
      const usable = config.enabled && config.speech !== false && config.conversation !== false;
      setAvailable(usable);
      // Ended here, voice mode that was on in this tab before a reload is not brought back later either: this runs again
      // each time Settings is closed, and once voice mode can be used again it would start, microphone and all, with no click.
      if (!usable) { resume.current = false; stop(); }
      // Voice mode was on in this tab when the page was reloaded: carry on.
      else if (resume.current && !voice.current && !restoring.current) { restoring.current = true; void start(true); }
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
  /** Push-to-talk pressed or let go. A press too short to hold a word is not sent. */
  const hold = (down: boolean) => {
    const controller = voice.current, live = transcription.current;
    if (!pushToTalk.current || !controller || !live || !vad.current) return;
    if (down) {
      let press = held.current;
      if (press && !press.releasing) return;
      replay.current?.abort();
      setHolding(true); setError("");
      if (press) {
        // Pressed again before the last press was sent: the same utterance goes on.
        clearTimeout(press.timer); press.releasing = false;
      } else {
        press = held.current = { frames: [], releasing: false, heldFrames: 0, speech: 0, started: false };
        stream.current?.getTracks().forEach(track => { track.enabled = true; });
        if (profiling.current) profiler.current!.begin();
        if (!latest.current.compacting) { live.begin(); live.confirm(); }
      }
      // Only a press held long enough to be words interrupts what is being said.
      const current = press;
      if (!current.started) current.timer = setTimeout(() => {
        if (held.current !== current || current.releasing) return;
        current.started = true; controller.speechStart();
      }, 250);
      // As long as a turn may be: the same bound as hands-free listening.
      clearTimeout(holdLimit.current);
      holdLimit.current = setTimeout(() => hold(false), 60000);
      return;
    }
    const press = held.current;
    if (!press || press.releasing) return;
    press.releasing = true; clearTimeout(holdLimit.current); clearTimeout(press.timer);
    setHolding(false);
    // The last syllable is still on its way through the detector.
    press.timer = setTimeout(() => {
      if (held.current !== press) return;
      held.current = null;
      if (pushToTalk.current) stream.current?.getTracks().forEach(track => { track.enabled = false; });
      levels.current.input = 0;
      const samples = joinSamples(press.frames);
      // Held for under a quarter of a second, or nothing in it the detector took
      // for speech: a tap or a cough, not something to send.
      const heldFor = press.frames.slice(0, press.heldFrames).reduce((n, f) => n + f.length, 0);
      if (!press.started || heldFor < 4000 || press.speech < 0.5 || latest.current.compacting) { live.discard(); controller.speechCancel(); return; }
      profileMark('endpoint'); live.end(samples); controller.speechEnd(samples);
    }, 250);
  };
  const choosePtt = async (on: boolean) => {
    local.set('voicePtt', on ? 'on' : 'off');
    setPtt(on); pushToTalk.current = on;
    if (!on && held.current) { clearTimeout(held.current.timer); held.current = null; setHolding(false); voice.current?.speechCancel(); transcription.current?.discard(); }
    // Anything said hands-free so far is dropped: its end is no longer listened for.
    if (on && !held.current) { clearTimeout(maxTurn.current); voice.current?.speechCancel(); transcription.current?.discard(); }
    if (!vad.current) return;
    // Push-to-talk has no mute of its own; it starts from an open detector.
    if (on && mutedRef.current) await toggleMute();
    stream.current?.getTracks().forEach(track => { track.enabled = !on && !mutedRef.current; });
  };
  const endMode = () => {
    stop();
    requestAnimationFrame(() => startButton.current?.focus({ preventScroll: true }));
  };

  /** Plays one prepared phrase through the orb's meter. Shared by replies and Repeat. */
  const playThrough = async (audio: AudioContext, signal: AbortSignal, start: (analyser: AnalyserNode, started: (scheduledAt?: number) => void) => Promise<void>, onStarted?: (scheduledAt: number) => void) => {
    signal.throwIfAborted();
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
      await start(analyser, (scheduledAt = audio.currentTime) => { onStarted?.(scheduledAt); setSpeaking(true); meter(); });
    } finally {
      analyser.disconnect(); cancelAnimationFrame(animation); levels.current.output = 0;
      if (mounted.current) setSpeaking(false);
    }
  };
  /** The last reply again, at the speed chosen now. False when there is none to play. */
  const repeatReply = (): boolean => {
    const audio = context.current;
    const phrases = replyAudio.current.filter(p => p.samples.length);
    if (!audio || !phrases.length) return false;
    replay.current?.abort();
    const controller = new AbortController(); replay.current = controller;
    const rate = speed.current;
    const prepare = (phrase: KeptPhrase) => {
      const kept = phrase.stretched;
      // One cut short by an earlier Repeat is worked out again.
      if (kept?.rate === rate && (kept.ready || !kept.signal.aborted)) return kept.samples;
      const stretched: NonNullable<KeptPhrase["stretched"]> = { rate, signal: controller.signal, samples: stretchInSteps(joinSamples(phrase.samples), rate, controller.signal) };
      stretched.samples.then(() => { stretched.ready = true; }, () => {});
      phrase.stretched = stretched;
      return stretched.samples;
    };
    void (async () => {
      // Each phrase is made faster while the one before it plays.
      let next = prepare(phrases[0]);
      for (let i = 0; i < phrases.length; i++) {
        const samples = await next;
        if (i + 1 < phrases.length) next = prepare(phrases[i + 1]);
        const buffer = bufferOf(audio, samples, phrases[i].sampleRate);
        if (!buffer) continue;
        await playThrough(audio, controller.signal, (analyser, started) => playAudioBuffer(buffer, audio, analyser, controller.signal, started));
      }
    })().catch(() => {}).finally(() => { if (replay.current === controller) replay.current = null; });
    return true;
  };
  /**
   * Asks for the spoken error line as voice mode starts, and keeps its audio. Tried again while voice mode is still on,
   * as the speech model is often just coming up then.
   */
  const prepareErrorLine = (version: number) => {
    const current = () => mounted.current && epoch.current === version;
    const fetchLine = async (): Promise<ArrayBuffer | undefined> => {
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await fetch(`/api/sessions/${sessionId}/voice/speech`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: t("An error occurred.") }),
          });
          if (response.ok && response.headers.get("content-type")?.startsWith("audio/pcm")) return await response.arrayBuffer();
        } catch {}
        if (attempt >= ERROR_LINE_WAITS_MS.length || !current()) return undefined;
        await new Promise(resolve => setTimeout(resolve, ERROR_LINE_WAITS_MS[attempt]));
        if (!current()) return undefined;
      }
    };
    errorLine.current = { ready: fetchLine() };
  };
  const synthesize = async (text: string, signal: AbortSignal, audio: AudioContext, kind:'reply'|'status'|'error'='reply') => {
    const trace=profiling.current?profiler.current!.current:undefined;
    const mark=(name:string,detail?:Record<string,number|string|boolean>,at?:number)=>{if(trace)profiler.current!.mark(kind+'_'+name,detail,trace,at);};
    mark('tts_request');
    let response: Response;
    if (kind === 'error') {
      // Played from the line fetched as voice mode began: the speech model is not asked at the moment something has gone wrong.
      // It may still be on its way, as the speech model is often just coming up when voice mode begins.
      const line = errorLine.current;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bytes = line && await Promise.race([line.ready, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ERROR_LINE_WAIT_MS); })]);
      clearTimeout(timer);
      signal.throwIfAborted();
      if (!bytes) throw new Error(t("The spoken error line is not available, so the error is shown in writing only. The speech model was not ready when voice mode started."));
      response = new Response(bytes.slice(0), { headers: { "content-type": "audio/pcm", "x-sample-rate": "24000" } });
    } else {
      response = await fetch(`/api/sessions/${sessionId}/voice/speech`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }), signal,
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({}));
        throw new Error(failure.error || t("Speech generation failed"));
      }
    }
    mark('tts_headers',{serverTiming:response.headers.get('server-timing')??''});
    let body=response.body;
    if(body&&trace){let first=true;body=body.pipeThrough(new TransformStream<Uint8Array<ArrayBuffer>,Uint8Array<ArrayBuffer>>({transform(chunk,controller){if(first&&chunk.length){first=false;mark('first_bytes');}controller.enqueue(chunk);}}));}
    let buffer: AudioBuffer | undefined;
    let stream: Awaited<ReturnType<typeof preparePcmSpeech>> | undefined;
    // Kept for Repeat once it is played; a phrase prepared and then cancelled was never heard.
    const phrase = { samples: [] as Float32Array[], sampleRate: 24000 };
    const options = { rate: speed.current, ...(kind === 'reply' ? { record: (samples: Float32Array) => { phrase.samples.push(samples); } } : {}) };
    if (!response.headers.get("content-type")?.startsWith("audio/pcm") || response.headers.get("x-sample-rate") !== "24000" || !body) throw new Error(t("Unsupported speech stream"));
    // Played as it arrives, unless the pipeline speaks one phrase after another.
    if (!sequential.current) stream = await preparePcmSpeech(body, audio, signal, options);
    else buffer = await readPcmStream(body, audio, signal, options);
    mark('audio_ready');
    const play = async (playbackSignal: AbortSignal) => {
      playbackSignal.throwIfAborted();
      // A new reply takes over from one being repeated.
      replay.current?.abort(); replay.current = null;
      if (kind === 'reply') {
        const kept = replyAudio.current;
        kept.push(phrase);
        let total = kept.reduce((n, p) => n + seconds(p), 0);
        while (kept.length > 1 && total > REPEAT_SECONDS) total -= seconds(kept.shift()!);
        setCanRepeat(true);
      }
      await playThrough(audio, playbackSignal, (analyser, started) => stream ? stream.play(analyser, started) : playAudioBuffer(buffer!, audio, analyser, playbackSignal, started), scheduledAt => {
        mark('playback_scheduled');
        const outputMs=(audio.baseLatency+(audio.outputLatency||0))*1000;
        mark('playback_estimate',{outputLatencyMs:outputMs},performance.now()+Math.max(0,scheduledAt-audio.currentTime)*1000+outputMs);
      });
    };
    return Object.assign(play, { completed: stream?.completed });
  };
  const start = async (resuming = false) => {
    if (voice.current || starting) { stop(); return; }
    const version = ++epoch.current;
    const current = () => mounted.current && epoch.current === version;
    setStarting(true); setError(""); setMuted(false); mutedRef.current = false;
    // From the moment it is turned on: a reload while it connects brings it back too.
    session.set('voiceActive', sessionId);
    // Alongside the rest of starting, which it ends if another tab has voice mode on.
    void claim(version, resuming).then(ok => { if (!ok && epoch.current === version) stop(); });
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
        throw new Error(t("Microphone access requires HTTPS or localhost."));
      const sound = new AudioContext(); soundContext.current = sound;
      // Started by a click, audio is allowed and only slow to start — a
      // Bluetooth headset can take a while — so it gets longer to do it.
      await Promise.race([sound.resume(), new Promise(resolve => setTimeout(resolve, resuming ? 300 : 2000))]);
      if (!current()) return;
      if (sound.state !== "running") {
        // Started without a click — after a reload — so the browser holds audio
        // back until the page is touched. Not every event counts: a touch lets
        // audio start when the finger is lifted, not when it lands, and Escape
        // never does. So each one tries, and the wait is over once one has and
        // audio is running. The click that started it already counts.
        setWaitingForTap(true);
        await new Promise<void>(resolve => {
          const events = ["pointerdown", "pointerup", "touchend", "click", "keydown", "keyup"] as const;
          let touched = !resuming;
          const done = () => {
            if (current() && !(touched && sound.state === "running")) return;
            for (const name of events) window.removeEventListener(name, attempt, true);
            sound.removeEventListener("statechange", done);
            clearInterval(check);
            resolve();
          };
          const attempt = () => { touched = true; void sound.resume().then(done, () => {}); };
          for (const name of events) window.addEventListener(name, attempt, true);
          sound.addEventListener("statechange", done);
          // Ended or left while waiting: stop listening.
          const check = setInterval(done, 1000);
        });
        if (mounted.current && current()) setWaitingForTap(false);
        if (!current()) return;
      }
      const audio = new AudioContext(); context.current = audio;
      await audio.resume();
      if (!current()) return;
      const mic = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      } });
      if (!current()) { mic.getTracks().forEach(track => track.stop()); return; }
      stream.current = mic;
      // The session's lease, before anything listens: what voice mode listens and speaks through gets ready for it (a model loaded), and says here when it cannot.
      const lease=crypto.randomUUID();connection.current=lease;
      await connectVoice(lease,true);
      if(!current())return;
      heartbeat.current=setInterval(()=>{void connectVoice(lease,true).catch(e=>{if(current()){setError(e.message);stop();}});},25000);
      // The spoken error line is fetched now, while the speech model is at hand, and kept: at error time it is only played. Not
      // waited for, and no failure here is shown: if it is missing then, that is said with the error.
      prepareErrorLine(version);
      const detectorModule = await import("@ricky0123/vad-web");
      if (!current()) return;
      const live = new LiveTranscription(async (samples, signal) => {
        const trace=profiling.current?profiler.current!.current:undefined;
        const started=performance.now();if(trace)profiler.current!.mark('stt_request',{audioMs:samples.length/16},trace);
        let result: { text: string; serverTiming: string };
        try {
          result = await api.transcribe(sessionId, samples, signal);
        } catch (e) {
          if(trace)profiler.current!.mark('stt_result',{requestMs:performance.now()-started,serverTiming:'',ok:false},trace);
          throw e;
        }
        if(trace)profiler.current!.mark('stt_result',{requestMs:performance.now()-started,serverTiming:result.serverTiming,ok:true},trace);
        return result.text;
      }, text => { if (current()) { setTranscript(text); voice.current?.heard(text); } }, !sequential.current);
      transcription.current = live;
      const controller = new HandsFreeVoice({
        statusSpeech: statusSpeech.current,
        sequential: sequential.current,
        sentenceChunks: sentenceChunks.current,
        ttsPrefetch: ttsPrefetch.current,
        transcribe: async (samples, signal) => {const result=await live.finish(samples, signal);profileMark('transcript_ready');return result;},
        send: async text => {
          profileSeq.current=eventSeq.current;profileMark('send'); cue("sent");
          // The pictures waiting now go with it, and only they leave the tray:
          // at once, as from the message box, and back if it does not get there.
          const images = pending.get(sessionId);
          if (images.length) pending.set(sessionId, []);
          const steer = steering.current && latest.current.running;
          // What is said next answers this, so Repeat is for that — from now, as
          // its first words may be spoken before the send returns.
          const before = replyAudio.current;
          replyAudio.current = []; setCanRepeat(false);
          try {
            await latest.current.onSend(text, { voice: true, ...(images.length ? { images } : {}), ...(steer ? { steer: true } : {}) });
          } catch (e) {
            if (images.length) pending.set(sessionId, [...images, ...pending.get(sessionId)]);
            if (!replyAudio.current.length) { replyAudio.current = before; setCanRepeat(before.length > 0); }
            throw e;
          }
        },
        abort: () => latest.current.onAbort(),
        command: text => asksToRepeat(text) && repeatReply(),
        couldBeCommand: couldAskToRepeat,
        steering: () => steering.current,
        agentRunning: () => latest.current.running,
        synthesize: (text, signal,kind) => synthesize(text, signal, audio,kind),
        trace: profileMark,
        phase: value => { if (current()) setPhase(value); },
        error: message => { if (current()) {setError(message);setFadingError(message);profiler.current?.close('error');} },
      }, latest.current.items);
      voice.current = controller;
      setErrorsAfter(controller.startedAfter);
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
        onSpeechStart: () => { if (current() && !pushToTalk.current && !mutedRef.current && !latest.current.compacting) {if(profiling.current)profiler.current!.begin();live.begin();} },
        onVADMisfire: () => { if (current() && !pushToTalk.current) {live.discard();if(profiling.current)profiler.current!.close('vad_misfire');} },
        onFrameProcessed: (probabilities, frame) => {
          if (pushToTalk.current) {
            // Only what is said while the button or Space is held counts.
            const press = held.current;
            if (!current() || !press) { levels.current.input = 0; return; }
            press.frames.push(frame.slice());
            if (!press.releasing) press.heldFrames = press.frames.length;
            press.speech = Math.max(press.speech, probabilities.isSpeech);
            if (!latest.current.compacting) live.frame(probabilities.isSpeech, frame);
            levels.current.input = Math.min(1, Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / frame.length) * 7);
            return;
          }
          if(current()&&!mutedRef.current&&profiling.current&&probabilities.isSpeech>=0.35)profiler.current!.lastSpeech();
          if (current() && !mutedRef.current && !latest.current.compacting) live.frame(probabilities.isSpeech, frame);
          if (current() && !mutedRef.current) levels.current.input = Math.min(1, Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / frame.length) * 7);
        },
        onSpeechRealStart: () => {
          if (!current() || mutedRef.current) return;
          // Talking over a repeated reply stops it, as it does a new one.
          replay.current?.abort();
          if (pushToTalk.current) return;
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
          if (pushToTalk.current) return;
          clearTimeout(maxTurn.current);
          if (current() && !mutedRef.current) { if (!latest.current.compacting) {profileMark('endpoint');live.end(samples);} controller.speechEnd(samples); }
        },
      });
      if (!current()) { await detector.destroy(); return; }
      vad.current = detector;
      for (const track of mic.getTracks()) track.onended = () => {
        if (current()) { setError(t("Microphone disconnected. Reconnect it and turn the mic on again.")); stop(); }
      };
      await detector.start();
      if (!current()) return;
      // With push-to-talk the microphone is open only while held.
      if (pushToTalk.current) mic.getTracks().forEach(track => { track.enabled = false; });
      setEnabled(true); setStarting(false); cue("start");
    } catch (e) {
      if (current()) { setError(micError(e)); stop(); }
    }
  };

  // Start and end voice mode from the keyboard, from the chat as well: the one
  // voice shortcut that works with the message box focused, as it has a modifier.
  const bindings = useKeybindings(), layout = useKeyLabels();
  const toggleKey = useRef({ binding: bindings["voice.toggle"], on: false, start, end: endMode });
  toggleKey.current = { binding: bindings["voice.toggle"], on: enabled || starting, start, end: endMode };
  useEffect(() => {
    if (!available) return;
    const down = (e: KeyboardEvent) => {
      const { binding, on, start, end } = toggleKey.current;
      if (e.defaultPrevented || e.repeat || !matches(binding, e) || document.querySelector('[aria-modal="true"]')) return;
      const b = binding!;
      if (!(b.ctrl || b.alt || b.meta) && (e.target as Element | null)?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
      e.preventDefault(); e.stopPropagation();
      if (on) end(); else void start();
    };
    window.addEventListener("keydown", down, true);
    return () => window.removeEventListener("keydown", down, true);
  }, [available]);

  if (!available) return null;
  return <>
    {profileOpen&&createPortal(<VoiceProfile profiler={profiler.current!} onClose={()=>{setProfileOpen(false);profiler.current!.close('disabled');}}/>,document.body)}

    {(starting || enabled) && stageTarget && createPortal(
      <VoiceStage sessionId={sessionId} folder={folder} workPhase={work} title={sequentialMode ? `${title} · ${sentenceMode ? (prefetchMode ? t("Sentence pipeline · buffered audio") : t("Sentence chunks · buffered audio")) : t("Sequential baseline")}` : comparison ? `${title} · ${t("Streaming pipeline")}` : title} phase={phase} starting={starting} muted={muted} speaking={speaking}
        toolEvents={toolEvents} sounds={sounds} onSounds={toggleSounds} onCue={cue}
        levels={levels} transcript={transcript} error={error} onMute={toggleMute} onEnd={endMode} waitingForTap={waitingForTap}
        items={items} errorsAfter={errorsAfter} running={running} onStop={() => { void latest.current.onAbort().catch(e => setError((e as Error).message)); }}
        attachments={attachments} onAddPictures={files => { void addPictures(files); }} onRemovePicture={id => pending.set(sessionId, pending.get(sessionId).filter(a => a.id !== id))}
        canRepeat={canRepeat} onRepeat={() => { repeatReply(); }}
        rate={rate} onRate={value => { local.set('voiceRate', String(value)); setRate(value); }}
        steer={steer} onSteer={value => { local.set('voiceSteer', value ? 'on' : 'off'); setSteer(value); }}
        ptt={ptt} onPtt={value => { void choosePtt(value); }} holding={holding} onHold={hold} />, stageTarget,
    )}
    <div className="relative flex items-center gap-1">
      <button type="button" className="prompt-action" aria-label={t("Profile voice latency")} title={t("Profile voice latency")} aria-pressed={profileOpen} onClick={()=>{setProfileOpen(v=>!v);if(profileOpen)profiler.current!.close('disabled');}}><LuGauge/></button>
      {error && !enabled && !starting && <p role="alert" onClick={() => setError("")} className="absolute bottom-full right-0 mb-3 w-64 cursor-pointer rounded-xl border border-line bg-surface p-3 text-xs text-danger shadow-pop">{error}</p>}
      <button ref={startButton} type="button" onClick={() => { void start(); }} aria-label={t("Turn on hands-free voice")} title={bindings["voice.toggle"] ? t("Start voice conversation ({keys})", { keys: describe(bindings["voice.toggle"], layout) }) : t("Start voice conversation")} className="prompt-action">
        {starting ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuAudioLines aria-hidden />}
      </button>
    </div>
  </>;
}
