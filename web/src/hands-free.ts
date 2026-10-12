import { SpeechPipeline, type PreparedSpeech } from "./speech-pipeline";
import type { Item } from "./transcript";
import { StreamingSpeech } from "./voice";
import { msg, t } from "./i18n";

/** What is said while a reply takes long, in the portal's language: each goes through `t` when it is spoken. */
export const THINKING_PHRASES = [
  msg("Let me think about that for a moment."),
  msg("Give me a moment to think this through."),
  msg("Let me consider that."),
  msg("I’m thinking through your request."),
  msg("Let me take a moment with that."),
];

export const COMPACTION_PHRASES = [
  msg("My context is getting full. Let me quickly compact our conversation before I continue."),
  msg("I need a little room in my context. Let me summarize our conversation, then I'll carry on."),
  msg("Let me do a quick context compaction so I can keep going."),
];
export type VoicePhase = "Listening" | "Hearing you" | "Transcribing" | "Thinking" | "Compacting context" | "Speaking";
export interface VoiceIO {
  sequential?: boolean;
  sentenceChunks?: boolean;
  ttsPrefetch?: boolean;
  statusSpeech?: boolean;
  transcribe: (samples: Float32Array, signal: AbortSignal) => Promise<string>;
  send: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  /** Handles what was said on the page instead of sending it, when it is for the page ("say that again"). */
  command?: (text: string) => boolean;
  /** Whether what has been heard so far could still turn out to be for the page. */
  couldBeCommand?: (partial: string) => boolean;
  /** True when speaking mid-run should add to the run rather than stop it. */
  steering?: () => boolean;
  agentRunning: () => boolean;
  synthesize: (text: string, signal: AbortSignal, kind?:'reply'|'status'|'error') => Promise<PreparedSpeech>;
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
  /**
   * While what is being said is not yet known to be for the agent: the reply
   * it cut off, and what the agent has written since. Spoken after all when
   * it turns out to be a cough, a press taken back, or a page command; dropped
   * only once it goes to the agent.
   */
  private held: string[] | null = null;
  private items: Item[] = [];
  private speech: StreamingSpeech;
  /** Error notices at or before this seq were there before voice mode began. */
  private afterSeq: number;
  private announcedErrors = new Set<string>();
  /**
   * The last turn was refused before it began (no model, no key): replies are
   * off until the next utterance, but the error notice that follows is still
   * the answer to what was said, and is spoken.
   */
  private refused = false;
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
  /** The run going when this utterance began has already been told to stop. */
  private stopped = false;
  private thinkingTimer?: ReturnType<typeof setTimeout>;
  private thinkingAnnounced = false;
  private lastThinkingAt = -Infinity;
  private lastThinkingPhrase = -1;
  private clearThinkingTimer() { clearTimeout(this.thinkingTimer); this.thinkingTimer = undefined; }


  constructor(private io: VoiceIO, initial: Item[]) {
    const afterSeq = this.afterSeq = initial.reduce((n, item) => Math.max(n, Number(item.id.slice(1)) || 0), 0);
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
    if (this.io.statusSpeech === false || this.io.sequential || phase !== "Thinking" || !this.acceptingReplies || this.output.length) this.clearThinkingTimer();
    else if (!this.thinkingAnnounced && !this.thinkingTimer && Date.now() - this.lastThinkingAt >= 20000) {
      this.thinkingTimer = setTimeout(() => {
        this.thinkingTimer = undefined;
        if (!this.alive || this.compacting || this.hearing || !this.acceptingReplies || this.pipeline.busy || this.output.length || !(this.io.agentRunning() || this.sending)) return;
        this.thinkingAnnounced = true; this.lastThinkingAt = Date.now();
        const candidates = THINKING_PHRASES.map((_, i) => i).filter(i => i !== this.lastThinkingPhrase);
        this.lastThinkingPhrase = candidates[Math.floor(Math.random() * candidates.length)];
        this.thinkingPipeline.enqueue([t(THINKING_PHRASES[this.lastThinkingPhrase])],'status');
      }, 1800);
    }
  }
  setCompacting(active: boolean, completed = true) {
    if (!this.alive || active === this.compacting) return;
    this.compacting = active;
    this.clearThinkingTimer();
    if (this.io.statusSpeech === false || this.io.sequential) { this.state(); return; }
    if (active) {
      this.lastCompactionWaitAt = -Infinity;
      this.thinkingPipeline.cancel();
      if (!this.hearing && this.acceptingReplies) this.pipeline.enqueue([t(COMPACTION_PHRASES[Math.floor(Math.random() * COMPACTION_PHRASES.length)])],'status');
    } else this.pipeline.enqueue([completed ? t("Context compaction is done. I'm ready to continue.") : t("Context compaction stopped before it finished.")],'status');
    this.state();
  }
  observe(items: Item[]) {
    this.items = items;
    if (!this.alive) return;
    this.announceErrors(items);
    if (!this.acceptingReplies) { if (this.held) this.held.push(...this.speech.observe(items)); else this.ignoreCurrent(); }
    else if (!this.io.sequential || this.io.sentenceChunks || !this.io.agentRunning()) this.output.push(...this.speech.observe(items));
    this.state();
    void this.play();
  }
  /**
   * A failure is written into the chat as an error notice and nothing else, so
   * with the chat put away voice mode would stay silent. One short line says
   * it happened, however many errors came; the notice itself is in the
   * conversation window, which the stage opens.
   */
  private announceErrors(items: Item[]) {
    let fresh = false;
    for (const item of items) {
      if (item.kind !== "notice" || item.tone !== "error" || Number(item.id.slice(1)) <= this.afterSeq || this.announcedErrors.has(item.id)) continue;
      this.announcedErrors.add(item.id);
      fresh = true;
    }
    if (!fresh || (!this.acceptingReplies && !this.refused)) return;
    this.thinkingPipeline.cancel();
    this.pipeline.enqueue([t("An error occurred.")], 'error');
  }
  /** Where voice mode began: error notices after this seq are new, and the stage opens the conversation on them. */
  get startedAfter() { return this.afterSeq; }
  /** Called after a sustained speech detection, not a single noise frame. */
  speechStart() {
    if (!this.alive || this.muted) return;
    if (this.compacting) {
      this.compactionSpeech = true;
      if (this.io.statusSpeech !== false && !this.io.sequential && Date.now() - this.lastCompactionWaitAt >= 8000) {
        this.lastCompactionWaitAt = Date.now();
        this.pipeline.enqueue([t("I'm still compacting our conversation. Please wait a moment; I'll let you know when I'm ready.")],'status');
      }
      return;
    }
    this.clearThinkingTimer();
    this.hearing = true;
    this.acceptingReplies = false;
    this.refused = false;
    this.held = [...(this.held ?? []), ...this.pipeline.cancel(), ...this.output];
    this.output = [];
    this.thinkingPipeline.cancel();
    // The run is stopped only once what was said turns out to be for the agent:
    // not a tap, not noise, not a command the page handles. See heard().
    this.state();
  }
  /**
   * What has been made out so far of what is being said. Once it is plainly
   * for the agent, a run it would stop is stopped now, not when the speaker is
   * done: "stop, don't touch that file" must not wait for the end of the sentence.
   */
  heard(partial: string) {
    if (!this.alive || this.muted || !this.hearing || this.stopped || this.compacting) return;
    if (!partial.trim() || this.io.couldBeCommand?.(partial) || this.io.steering?.() || !(this.io.agentRunning() || this.sending)) return;
    this.stopped = true;
    const generation = this.inputGeneration;
    // Serialized like the stop in process(), and a failed one is tried again there before anything is sent.
    this.operations = this.operations.then(async () => { if (this.alive && this.inputGeneration === generation) await this.io.abort(); })
      .catch(error => { this.stopped = false; this.report(error); });
  }
  /** Speech that began and is not going to be sent after all: a push-to-talk press too short to be words. */
  speechCancel() {
    if (!this.alive) return;
    // A press during compaction is over; the next thing said is heard again.
    this.compactionSpeech = false;
    if (!this.hearing) return;
    this.hearing = false;
    this.stopped = false;
    this.resumeReplies();
    this.state();
    void this.play();
  }
  /** What was said is not going to the agent: the reply it held back is spoken after all. */
  private resumeReplies() {
    if (this.held) this.output = [...this.held, ...this.output];
    this.held = null;
    this.acceptingReplies = true;
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
      if (this.hearing) return;
      if (!this.text.length) {
        // Nothing in it but noise: the run was not stopped, so what it says next is spoken.
        if (valid() && !this.recordings.length) { this.stopped = false; this.resumeReplies(); }
        return;
      }
      const text = this.text.join(" ");
      if (this.io.command?.(text)) {
        // For the page ("say that again") and handled there, not sent to the
        // agent. The interruption cut its reply off, so what was left unsaid is
        // spoken after all instead of dropped.
        this.text = [];
        this.stopped = false;
        this.resumeReplies();
        this.ignoreCurrent();
        return;
      }
      // Serialize abort behind an in-flight send so it cannot miss that new run.
      // When steering, the run goes on and what is said is added to it. When it
      // was already stopped while this was being said, that is not done twice —
      // but whether it was is only known once that stop has settled.
      const busy = (this.io.agentRunning() || this.sending) && !this.io.steering?.();
      const send = this.operations.then(async () => {
        if (!valid() || this.hearing || this.recordings.length) return;
        if (busy && !this.stopped) {
          await this.io.abort();
          if (!valid() || this.hearing || this.recordings.length) return;
        }
        this.held = null;
        this.ignoreCurrent();
        this.acceptingReplies = true;
        this.refused = false;
        this.sending = true;
        this.thinkingAnnounced = false;
        this.state();
        try {
          await this.io.send(text);
          if (valid()) { this.text = []; this.stopped = false; }
        } catch (error) {
          this.acceptingReplies = false;
          this.refused = true;
          throw new Error(t("Could not send “{text}”: {error}", { text, error: error instanceof Error ? error.message : String(error) }));
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
      this.stopped = false;
      this.transcription.abort();
      this.transcription = new AbortController();
      this.resumeReplies();
    }
    this.state();
    void this.play();
  }
  stop() {
    this.alive = false;
    this.clearThinkingTimer();
    this.pipeline.cancel();
    this.thinkingPipeline.cancel();
    this.transcription.abort();
    this.output = [];
    this.held = null;
    this.recordings = [];
    this.text = [];
  }
}
