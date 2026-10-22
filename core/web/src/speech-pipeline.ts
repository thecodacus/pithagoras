export type PreparedSpeech = ((signal: AbortSignal) => Promise<void>) & { completed?: Promise<void> };
type Phrase = {text:string;kind:'reply'|'status'|'error'};
type Run = { controller: AbortController; text: Phrase[]; audio: {phrase:Phrase;play:PreparedSpeech}[]; generating?: Phrase; playing?: Phrase };

/** One TTS producer and one audio consumer, running independently in sentence order. */
export class SpeechPipeline {
  private run = this.fresh();
  constructor(
    private synthesize: (text: string, signal: AbortSignal, kind?:'reply'|'status'|'error') => Promise<PreparedSpeech>,
    private changed: () => void,
    private error: (error: unknown) => void,
    private sequential = false,
    private sentenceBySentence = false,
    private prefetch = false,
  ) {}
  private fresh(): Run { return { controller: new AbortController(), text: [], audio: [] }; }
  get busy() { const r = this.run; return !!(r.generating || r.playing || r.text.length || r.audio.length); }
  enqueue(text: string[],kind:'reply'|'status'|'error'='reply') { this.run.text.push(...text.map(text=>({text,kind})));  this.pump(this.run); }
  /** Stops at once, and returns the replies not yet heard to the end — the one cut off included. */
  cancel(): string[] {
    const previous = this.run;
    this.run = this.fresh();
    // A streamed phrase is still generating while it plays: counted once.
    const unheard = [...new Set([previous.playing, ...previous.audio.map(a => a.phrase), previous.generating, ...previous.text])]
      .filter(p => p?.kind === 'reply').map(p => p!.text);
    previous.text = []; previous.audio = []; previous.controller.abort();
    this.changed();
    return unheard;
  }
  private fail(run: Run, error: unknown) {
    if (run !== this.run || run.controller.signal.aborted) return;
    this.cancel(); this.error(error);
  }
  private pump(run: Run) {
    if (run !== this.run || run.controller.signal.aborted) return;
    const signal = run.controller.signal;
    if (!run.playing && run.audio.length && (!this.sequential || this.prefetch || (!run.generating && (this.sentenceBySentence || !run.text.length)))) {
      const { phrase, play } = run.audio.shift()!;
      run.playing = phrase;
      void (async () => {
        try { await play(signal); }
        catch (error) { this.fail(run, error); }
        finally { run.playing = undefined; if (run === this.run) this.pump(run); }
      })();
    }
    if (run !== this.run) return;
    // Keep at most two completed phrases ahead of playback. The speech engine itself has
    // one GPU request slot; overlapping playback needs no additional GPU slot.
    if (!run.generating && (this.sequential && !this.prefetch ? !run.playing : run.audio.length < 2) && run.text.length) {
      const phrase = run.text.shift()!;
      run.generating = phrase;
      void (async () => {
        try {
          const prepared = await this.synthesize(phrase.text, signal,phrase.kind);
          if (this.sequential) await prepared.completed;
          if (run === this.run && !signal.aborted) { run.audio.push({ phrase, play: prepared }); this.pump(run); }
          await prepared.completed;
        } catch (error) { this.fail(run, error); }
        finally { run.generating = undefined; if (run === this.run) this.pump(run); }
      })();
    }
    this.changed();
  }
}
