import { useCallback, useEffect, useRef, useState } from "react";
import type { MicVAD } from "@ricky0123/vad-web";
import { api, DEFAULT_VAD } from "./api";
import { cleanTranscript } from "./dictation";
import { LiveTranscription } from "./live-transcription";
import { samplesWav } from "./voice";

/** Where dictated words go: into the message box to be edited, or straight to the agent. */
export type DictationMode = "review" | "send";
export type DictationPhase = "Listening" | "Hearing you" | "Transcribing";

const MODE_KEY = "dictationMode";
/** A single recording is cut here and listening carries on, as in voice mode. */
const MAX_TURN_MS = 60000;

const readMode = (): DictationMode => {
  try {
    return localStorage.getItem(MODE_KEY) === "send" ? "send" : "review";
  } catch {
    return "review";
  }
};

/** Everything one listening run owns, so stopping it releases exactly that. */
interface Run {
  closed: boolean;
  mic?: MediaStream;
  audio?: AudioContext;
  vad?: MicVAD;
  live?: LiveTranscription;
  maxTurn?: ReturnType<typeof setTimeout>;
}

export interface Dictation {
  /** Voice is set up, so there is something to transcribe with. */
  available: boolean;
  /** The microphone is open, or opening. */
  active: boolean;
  starting: boolean;
  /** Something to show: listening, still finishing what was said, or a failure to report. */
  showing: boolean;
  phase: DictationPhase;
  /** The words so far of what is being said right now. */
  partial: string;
  /** Finished phrases held back until the speaker stops, when sending at once. */
  held: string;
  error: string;
  mode: DictationMode;
  setMode: (mode: DictationMode) => void;
  toggle: () => void;
  stop: () => Promise<void>;
}

/**
 * Speech to text, and nothing more: no spoken reply, no interrupting the agent.
 *
 * Reuses what voice mode listens with — the same in-browser Silero endpointing
 * and the same transcription endpoint — but hands the words to the caller
 * instead of sending them as a spoken turn. `onText` receives phrases to put in
 * the message box; `onSend` receives a whole utterance to send as it stands.
 */
export function useDictation({
  sessionId,
  disabled,
  onText,
  onSend,
}: {
  sessionId: string;
  disabled: boolean;
  onText: (text: string) => void;
  onSend: (text: string) => void;
}): Dictation {
  const [available, setAvailable] = useState(false);
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [hearing, setHearing] = useState(false);
  const [pending, setPending] = useState(0);
  const [partial, setPartial] = useState("");
  const [held, setHeld] = useState("");
  const [error, setError] = useState("");
  const [mode, setModeState] = useState<DictationMode>(readMode);

  const latest = useRef({ sessionId, onText, onSend, mode, disabled });
  latest.current = { sessionId, onText, onSend, mode, disabled };
  const vadSettings = useRef(DEFAULT_VAD);
  const run = useRef<Run | null>(null);
  // Transcriptions run one after another so phrases land in the order spoken.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const cancel = useRef(new AbortController());
  const hearingNow = useRef(false);
  const pendingNow = useRef(0);
  const buffer = useRef<string[]>([]);

  const setHearingNow = (value: boolean) => {
    hearingNow.current = value;
    setHearing(value);
  };
  const setPendingNow = (delta: number) => {
    pendingNow.current += delta;
    setPending(pendingNow.current);
  };
  const setBuffer = (parts: string[]) => {
    buffer.current = parts;
    setHeld(parts.join(" "));
  };

  /** Sending at once waits for a pause: half a thought is not a message. */
  const settle = () => {
    if (hearingNow.current || pendingNow.current) return;
    setPartial("");
    if (!buffer.current.length) return;
    const text = buffer.current.join(" ");
    setBuffer([]);
    if (latest.current.mode === "send") latest.current.onSend(text);
    else latest.current.onText(text);
  };

  const deliver = (text: string) => {
    if (latest.current.mode === "send") setBuffer([...buffer.current, text]);
    else latest.current.onText(text);
  };

  const transcribe = (r: Run, samples: Float32Array) => {
    const signal = cancel.current.signal;
    setPendingNow(1);
    queue.current = queue.current.then(async () => {
      try {
        const text = cleanTranscript(await r.live!.finish(samples, signal));
        if (text && !signal.aborted) deliver(text);
      } catch (e) {
        if (!signal.aborted) setError((e as Error).message || "Transcription failed");
      } finally {
        setPendingNow(-1);
        if (!signal.aborted) settle();
      }
    });
  };

  const teardown = (r: Run) => {
    clearTimeout(r.maxTurn);
    const detector = r.vad;
    r.vad = undefined;
    void detector?.destroy().catch(() => {});
    r.mic?.getTracks().forEach((track) => track.stop());
    r.mic = undefined;
    const audio = r.audio;
    r.audio = undefined;
    if (audio && audio.state !== "closed") void audio.close();
  };

  /**
   * Close the microphone, but let what was already said finish: a sentence cut
   * off by pressing stop still arrives, and so does anything being transcribed.
   */
  const stop = useCallback(async () => {
    const r = run.current;
    if (!r) return;
    run.current = null;
    setActive(false);
    setStarting(false);
    clearTimeout(r.maxTurn);
    if (r.vad) {
      // Pausing hands a sentence in progress to onSpeechEnd before it closes.
      try {
        await r.vad.pause();
      } catch {
        // Already stopped; there is nothing left to hand over.
      }
    }
    r.closed = true;
    queue.current = queue.current.then(() => r.live?.reset());
    teardown(r);
    setHearingNow(false);
    settle();
  }, []);

  const start = async () => {
    if (run.current) return;
    const r: Run = { closed: false };
    run.current = r;
    setStarting(true);
    setError("");
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
        throw new Error("Microphone access requires HTTPS or localhost.");
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      r.mic = mic;
      if (r.closed) return teardown(r);
      const audio = new AudioContext();
      r.audio = audio;
      await audio.resume();
      if (r.closed) return teardown(r);
      const { MicVAD } = await import("@ricky0123/vad-web");
      if (r.closed) return teardown(r);

      const live = new LiveTranscription(
        async (samples, signal) => {
          const response = await fetch(`/api/sessions/${latest.current.sessionId}/voice/transcribe`, {
            method: "POST",
            headers: { "Content-Type": "audio/wav" },
            body: samplesWav(samples),
            signal,
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result.error || "Transcription failed");
          return String(result.text ?? "");
        },
        (text) => {
          if (!r.closed) setPartial(text);
        },
      );
      r.live = live;

      const vad = await MicVAD.new({
        model: "v5",
        audioContext: audio,
        startOnLoad: false,
        baseAssetPath: "/voice-assets/",
        onnxWASMBasePath: "/voice-assets/",
        ortConfig: (ort) => {
          ort.env.wasm.numThreads = 1;
        },
        getStream: async () => mic,
        pauseStream: async () => {},
        resumeStream: async () => mic,
        ...vadSettings.current,
        submitUserSpeechOnPause: true,
        onSpeechStart: () => {
          if (!r.closed) live.begin();
        },
        onVADMisfire: () => {
          if (r.closed) return;
          live.discard();
          setHearingNow(false);
          settle();
        },
        onFrameProcessed: (probabilities, frame) => {
          if (!r.closed) live.frame(probabilities.isSpeech, frame);
        },
        onSpeechRealStart: () => {
          if (r.closed) return;
          setError("");
          live.confirm();
          setHearingNow(true);
          clearTimeout(r.maxTurn);
          r.maxTurn = setTimeout(async () => {
            // Bound the recording; the same stream carries on into the next one.
            const active = r.vad;
            if (r.closed || !active) return;
            try {
              await active.pause();
              if (!r.closed) await active.start();
            } catch (e) {
              if (!r.closed) setError((e as Error).message);
            }
          }, MAX_TURN_MS);
        },
        onSpeechEnd: (samples) => {
          clearTimeout(r.maxTurn);
          if (r.closed) return;
          live.end(samples);
          transcribe(r, samples);
          setHearingNow(false);
        },
      });
      r.vad = vad;
      if (r.closed) return teardown(r);
      for (const track of mic.getTracks()) {
        track.onended = () => {
          if (r.closed || run.current !== r) return;
          setError("Microphone disconnected. Reconnect it and turn dictation on again.");
          void stop();
        };
      }
      await vad.start();
      if (r.closed) return;
      setStarting(false);
      setActive(true);
    } catch (e) {
      if (run.current === r) {
        run.current = null;
        setStarting(false);
        setActive(false);
        setError((e as Error).message);
      }
      r.closed = true;
      teardown(r);
    }
  };

  const toggle = () => {
    if (latest.current.disabled) return;
    if (run.current) void stop();
    else void start();
  };

  const setMode = (next: DictationMode) => {
    setModeState(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // A remembered choice is a convenience.
    }
    // Switching to editing with words held back: they belong in the box now.
    if (next === "review") settle();
  };

  useEffect(() => {
    let mounted = true;
    const load = () =>
      api
        .voice()
        .then((config) => {
          if (!mounted) return;
          vadSettings.current = { ...DEFAULT_VAD, ...config.vad };
          setAvailable(config.enabled);
          if (!config.enabled) void stop();
        })
        .catch(() => {
          if (!mounted) return;
          setAvailable(false);
          void stop();
        });
    void load();
    window.addEventListener("voice-config-changed", load);
    return () => {
      mounted = false;
      window.removeEventListener("voice-config-changed", load);
    };
  }, [stop]);

  // Leaving the session drops everything in flight: words heard here must not
  // arrive in another conversation.
  useEffect(() => {
    cancel.current = new AbortController();
    return () => {
      cancel.current.abort();
      setBuffer([]);
      setPartial("");
      void stop();
    };
  }, [sessionId, stop]);

  const phase: DictationPhase = hearing ? "Hearing you" : pending ? "Transcribing" : "Listening";
  const showing = active || starting || pending > 0 || held !== "" || error !== "";
  return { available, active, starting, showing, phase, partial, held, error, mode, setMode, toggle, stop };
}
