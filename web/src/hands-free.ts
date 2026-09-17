import { SpeechPipeline, type PreparedSpeech } from "./speech-pipeline";
import type { Item } from "./transcript";
import { StreamingSpeech } from "./voice";
import { pick } from "./voice-fillers";
import type { FillerKind, VoiceNotices } from "./api";

/** Until the portal's notices in the voice language arrive. */
export const ENGLISH_NOTICES: VoiceNotices = {
  think: ["Let me think about that for a moment.", "Give me a moment to think this through.", "Let me consider that.", "I’m thinking through your request.", "Let me take a moment with that."],
  compacting: ["My context is getting full. Let me quickly compact our conversation before I continue.", "I need a little room in my context. Let me summarize our conversation, then I'll carry on.", "Let me do a quick context compaction so I can keep going."],
  compactionWait: "I'm still compacting our conversation. Please wait a moment; I'll let you know when I'm ready.",
  compactionDone: "Context compaction is done. I'm ready to continue.",
  compactionStopped: "Context compaction stopped before it finished.",
};
/** An acknowledgement follows the request this quickly, unless the reply is already there. */
export const ACK_DELAY_MS = 300;
/** Acknowledging every quick exchange sounds scripted. */
export const ACK_COOLDOWN_MS = 15000;
/** A tool running this long gets a word on what is still going on. */
export const TOOL_SLOW_MS = 6000;
/** After a tool this long, a word bridges the wait for the agent to read its result. */
export const TOOL_DONE_MIN_MS = 4000;
/** Silence this long with the agent at work gets a "still on it"; later gaps grow to the cap. */
export const STILL_MS = 15000;
export const STILL_MAX_MS = 45000;
export type VoicePhase = "Listening" | "Hearing you" | "Transcribing" | "Thinking" | "Compacting context" | "Speaking";
export interface VoiceIO {
  sequential?: boolean;
  sentenceChunks?: boolean;
  ttsPrefetch?: boolean;
  statusSpeech?: boolean;
  /** Spoken status notices in the voice language, once known. */
  notices?: () => VoiceNotices | undefined;
  transcribe: (samples: Float32Array, signal: AbortSignal) => Promise<string>;
  send: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  agentRunning: () => boolean;
  synthesize: (text: string, signal: AbortSignal, kind?:'reply'|'status') => Promise<PreparedSpeech>;
  /** Plays a pre-rendered filler and resolves when it ends; undefined when none of that kind is ready. */
  filler?: (kind: FillerKind, signal: AbortSignal) => Promise<void> | undefined;
  trace?: (name:string)=>void;
  phase: (phase: VoicePhase) => void;
  error: (message: string) => void;
}

/** Coordinates microphone turns independently of React renders and network timing. */
export class HandsFreeVoice {
  private alive = true;
  private hearing = false;
  private muted = false;
  private inputGeneration = 0;
  private acceptingReplies = true;
  private items: Item[] = [];
  private speech: StreamingSpeech;
  private recordings: Float32Array[] = [];
  private text: string[] = [];
  private processing = false;
  private output: string[] = [];
  private pipeline: SpeechPipeline;
  private thinkingPipeline: SpeechPipeline;
  private compacting = false;
  private compactionSpeech = false;
  private lastCompactionWaitAt = -Infinity;
  private transcription = new AbortController();
  private operations: Promise<void> = Promise.resolve();
  private sending = false;
  private thinkingTimer?: ReturnType<typeof setTimeout>;
  private thinkingAnnounced = false;
  private lastThinkingAt = -Infinity;
  private lastThinkingPhrase?: string;
  private fillerPlayback?: AbortController;
  private stillTimer?: ReturnType<typeof setTimeout>;
  private ackTimer?: ReturnType<typeof setTimeout>;
  private toolTimer?: ReturnType<typeof setTimeout>;
  private stillCount = 0;
  private failuresThisTurn = 0;
  private lastAckAt = -Infinity;
  private lastDoneAt = -Infinity;
  /** Last time anything was heard: a reply, a notice or a filler. */
  private lastSoundAt = -Infinity;
  private get phrases() { return this.io.notices?.() ?? ENGLISH_NOTICES; }
  private clearThinkingTimer() { clearTimeout(this.thinkingTimer); this.thinkingTimer = undefined; }
  private clearFillers() {
    for (const timer of [this.stillTimer, this.ackTimer, this.toolTimer]) clearTimeout(timer);
    this.stillTimer = this.ackTimer = this.toolTimer = undefined;
    this.fillerPlayback?.abort(); this.fillerPlayback = undefined;
  }
  /** Starts a filler if one of this kind is ready and nothing else is being said. */
  private startFiller(kind: FillerKind) {
    if (!this.io.filler || this.fillerPlayback || !this.fillerAllowed()) return false;
    const playback = new AbortController();
    const playing = this.io.filler(kind, playback.signal);
    if (!playing) return false;
    this.fillerPlayback = playback;
    this.lastSoundAt = Date.now();
    this.io.trace?.('filler');
    void playing.catch(() => {}).finally(() => {
      if (this.fillerPlayback !== playback) return;
      this.fillerPlayback = undefined; this.lastSoundAt = Date.now();
      // A reply that arrived meanwhile waited for the filler to finish.
      this.state(); void this.play();
    });
    return true;
  }
  private fillerAllowed() {
    return !!this.io.filler && this.io.statusSpeech !== false && !this.io.sequential && this.alive && !this.compacting && !this.hearing
      && this.acceptingReplies && !this.output.length && !this.pipeline.busy && !this.thinkingPipeline.busy && (this.io.agentRunning() || this.sending);
  }
  /** Acknowledge a substantial request right away: a question gets "let me see", anything else "okay". */
  private acknowledge(text: string) {
    clearTimeout(this.ackTimer); this.ackTimer = undefined;
    const trimmed = text.trim();
    // Scripts without spaces count characters; "thanks" or "yes" needs no acknowledgement.
    const substantial = /\s/.test(trimmed) ? trimmed.split(/\s+/).length > 2 : /[^\x00-\x7f]/.test(trimmed) && [...trimmed].length >= 6;
    if (!this.io.filler || !substantial || Date.now() - this.lastAckAt < ACK_COOLDOWN_MS) return;
    const kind: FillerKind = /[?？؟]["'”»)\]]*$/.test(trimmed) ? 'ackQuestion' : 'ackRequest';
    this.ackTimer = setTimeout(() => {
      this.ackTimer = undefined;
      if (!this.startFiller(kind)) return;
      this.lastAckAt = Date.now();
      // The acknowledgement already tells the listener the request landed.
      this.thinkingAnnounced = true; this.clearThinkingTimer();
    }, ACK_DELAY_MS);
  }
  private scheduleStill() {
    if (!this.fillerAllowed()) { clearTimeout(this.stillTimer); this.stillTimer = undefined; return; }
    if (this.stillTimer || this.fillerPlayback) return;
    const quiet = Math.min(STILL_MAX_MS, STILL_MS * (1 + this.stillCount));
    this.stillTimer = setTimeout(() => {
      this.stillTimer = undefined;
      if (Date.now() - this.lastSoundAt < quiet) { this.scheduleStill(); return; }
      if (this.startFiller('still')) this.stillCount++;
      else this.lastSoundAt = Date.now();
    }, Math.max(250, quiet - (Date.now() - this.lastSoundAt)));
  }
  /** A tool call started; if it runs long, say what is still going on. */
  toolStart(slow: FillerKind) {
    if (!this.alive) return;
    clearTimeout(this.toolTimer);
    this.toolTimer = setTimeout(() => {
      this.toolTimer = undefined;
      if (Date.now() - this.lastSoundAt >= 3000) this.startFiller(slow);
    }, TOOL_SLOW_MS);
  }
  /** All running tool calls ended: react to a failure, or bridge the wait after a long one. */
  toolEnd(failed: boolean, durationMs: number) {
    if (!this.alive) return;
    clearTimeout(this.toolTimer); this.toolTimer = undefined;
    if (failed ? this.failuresThisTurn >= 2 : durationMs < TOOL_DONE_MIN_MS || Date.now() - this.lastDoneAt < 20000) return;
    this.toolTimer = setTimeout(() => {
      this.toolTimer = undefined;
      if (!failed && Date.now() - this.lastSoundAt < 1000) return;
      if (!this.startFiller(failed ? 'toolFailed' : 'toolDone')) return;
      if (failed) this.failuresThisTurn++; else this.lastDoneAt = Date.now();
    }, failed ? 800 : 1200);
  }

  constructor(private io: VoiceIO, initial: Item[]) {
    const afterSeq = initial.reduce((n, item) => Math.max(n, Number(item.id.slice(1)) || 0), 0);
    this.pipeline = new SpeechPipeline(io.synthesize, () => this.state(), error => this.report(error), io.sequential, io.sentenceChunks, io.ttsPrefetch);
    this.thinkingPipeline = new SpeechPipeline(io.synthesize, () => this.state(), error => this.report(error));
    this.speech = new StreamingSpeech(afterSeq);
    this.items = initial;
    this.ignoreCurrent();
    io.phase("Listening");
  }
  private ignoreCurrent() {
    this.speech.ignore(this.items);
  }
  private report(error: unknown) {
    if (this.alive) this.io.error(error instanceof Error ? error.message : String(error));
  }
  private state() {
    if (!this.alive) return;
    const phase = this.hearing ? "Hearing you" : this.compacting ? "Compacting context" : this.processing && !this.sending ? "Transcribing" : this.pipeline.busy || this.thinkingPipeline.busy ? "Speaking" : this.io.agentRunning() || this.sending ? "Thinking" : "Listening";
    this.io.phase(phase);
    if (phase === "Speaking") this.lastSoundAt = Date.now();
    this.scheduleStill();
    if (this.io.statusSpeech === false || this.io.sequential || phase !== "Thinking" || !this.acceptingReplies || this.output.length) this.clearThinkingTimer();
    else if (!this.thinkingAnnounced && !this.thinkingTimer && Date.now() - this.lastThinkingAt >= 20000) {
      this.thinkingTimer = setTimeout(() => {
        this.thinkingTimer = undefined;
        if (!this.alive || this.compacting || this.hearing || !this.acceptingReplies || this.pipeline.busy || this.fillerPlayback || this.thinkingAnnounced || this.output.length || !(this.io.agentRunning() || this.sending)) return;
        this.thinkingAnnounced = true; this.lastThinkingAt = Date.now();
        this.lastThinkingPhrase = pick(this.phrases.think, this.lastThinkingPhrase);
        this.thinkingPipeline.enqueue([this.lastThinkingPhrase],'status');
      }, 1800);
    }
  }
  setCompacting(active: boolean, completed = true) {
    if (!this.alive || active === this.compacting) return;
    this.compacting = active;
    this.clearThinkingTimer();
    if (active) this.clearFillers();
    if (this.io.statusSpeech === false || this.io.sequential) { this.state(); return; }
    if (active) {
      this.lastCompactionWaitAt = -Infinity;
      this.thinkingPipeline.cancel();
      if (!this.hearing && this.acceptingReplies) this.pipeline.enqueue([pick(this.phrases.compacting)],'status');
    } else this.pipeline.enqueue([completed ? this.phrases.compactionDone : this.phrases.compactionStopped],'status');
    this.state();
  }
  observe(items: Item[]) {
    this.items = items;
    if (!this.alive) return;
    if (!this.acceptingReplies) this.ignoreCurrent();
    else if (!this.io.sequential || this.io.sentenceChunks || !this.io.agentRunning()) this.output.push(...this.speech.observe(items));
    this.state();
    void this.play();
  }
  /** Called after a sustained speech detection, not a single noise frame. */
  speechStart() {
    if (!this.alive || this.muted) return;
    if (this.compacting) {
      this.compactionSpeech = true;
      if (this.io.statusSpeech !== false && !this.io.sequential && Date.now() - this.lastCompactionWaitAt >= 8000) {
        this.lastCompactionWaitAt = Date.now();
        this.pipeline.enqueue([this.phrases.compactionWait],'status');
      }
      return;
    }
    this.clearThinkingTimer();
    this.clearFillers();
    this.hearing = true;
    this.acceptingReplies = false;
    this.ignoreCurrent();
    this.output = [];
    this.pipeline.cancel();
    this.thinkingPipeline.cancel();
    // Serialize abort behind an in-flight send so it cannot miss that new run.
    if (this.io.agentRunning() || this.sending) {
      this.operations = this.operations.then(async () => { if (this.alive) await this.io.abort(); });
      void this.operations.catch(error => this.report(error));
    }
    this.state();
  }
  speechEnd(samples: Float32Array) {
    if (!this.alive || this.muted) return;
    if (this.compacting || this.compactionSpeech) { this.compactionSpeech = false; return; }
    this.hearing = false;
    this.recordings.push(samples);
    void this.process();
  }
  private async process() {
    if (this.processing || !this.alive) return;
    const generation = this.inputGeneration;
    const valid = () => this.alive && this.inputGeneration === generation;
    this.processing = true;
    this.state();
    try {
      while (this.recordings.length && valid()) {
        const text = await this.io.transcribe(this.recordings.shift()!, this.transcription.signal);
        if (!valid()) return;
        if (text.trim()) this.text.push(text.trim());
      }
      // If speech resumes during transcription, retain the text and combine it
      // with the next segment instead of sending half a thought or losing it.
      if (this.hearing || !this.text.length) return;
      const text = this.text.join(" ");
      const send = this.operations.then(async () => {
        if (!valid() || this.hearing || this.recordings.length) return;
        this.ignoreCurrent();
        this.acceptingReplies = true;
        this.sending = true;
        this.thinkingAnnounced = false;
        this.stillCount = 0; this.failuresThisTurn = 0;
        this.lastSoundAt = Date.now();
        this.acknowledge(text);
        this.state();
        try {
          await this.io.send(text);
          if (valid()) this.text = [];
        } catch (error) {
          this.acceptingReplies = false;
          throw new Error(`Could not send “${text}”: ${error instanceof Error ? error.message : error}`);
        } finally { this.sending = false; }
      });
      this.operations = send;
      await send;
    } catch (error) {
      if (valid()) this.report(error);
      // A failed command is reported, but must not poison subsequent turns.
      this.operations = Promise.resolve();
    } finally {
      this.processing = false;
      this.state();
      if (this.alive && this.recordings.length) void this.process();
      else void this.play();
    }
  }
  private play() {
    if (this.fillerPlayback) return;
    if (!this.alive || this.hearing || !this.acceptingReplies || !this.output.length || (this.io.sequential && !this.io.sentenceChunks && this.io.agentRunning())) return;
    const text = this.output; this.output = [];
    this.thinkingPipeline.cancel();
    this.io.trace?.('reply_chunk');
    this.pipeline.enqueue(text);
  }
  /** Mute is input-only: keep the agent and its spoken output running. */
  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted) {
      this.inputGeneration++;
      this.hearing = false;
      this.recordings = [];
      this.text = [];
      this.transcription.abort();
      this.transcription = new AbortController();
      this.acceptingReplies = true;
    }
    this.state();
    void this.play();
  }
  stop() {
    this.alive = false;
    this.clearThinkingTimer();
    this.clearFillers();
    this.pipeline.cancel();
    this.thinkingPipeline.cancel();
    this.transcription.abort();
    this.output = [];
    this.recordings = [];
    this.text = [];
  }
}
