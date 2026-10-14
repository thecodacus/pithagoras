import { joinSamples } from "./samples";

type Segment = {
  frames: Float32Array[]; revision: number; quiet: number; confirmed: boolean;
  requested: number; lastRequest: number; controller: AbortController;
  pending?: Promise<void>; result?: { revision: number; text: string };
};

/** Speculate during speech, then reuse only a hypothesis covering the last detected speech. */
export class LiveTranscription {
  private preRoll: Float32Array[] = [];
  private current: Segment | null = null;
  private segments = new Set<Segment>();
  private ended = new WeakMap<Float32Array, Segment>();
  constructor(
    private request: (samples: Float32Array, signal: AbortSignal) => Promise<string>,
    private preview: (text: string) => void,
    private speculative = true,
  ) {}
  frame(probability: number, samples: Float32Array) {
    if (!this.speculative) return;
    const frame = samples.slice();
    const segment = this.current;
    if (!segment) {
      this.preRoll.push(frame);
      // Include the onset frame; Silero keeps ten preceding frames at 16 kHz.
      if (this.preRoll.length > 11) this.preRoll.shift();
      return;
    }
    segment.frames.push(frame);
    if (probability >= 0.35) { segment.revision++; segment.quiet = 0; }
    else segment.quiet++;
    if (segment.confirmed && !segment.pending && segment.requested !== segment.revision &&
        (segment.quiet >= 6 || segment.frames.length - segment.lastRequest >= 63)) {
      this.speculate(segment);
    }
  }
  begin() {
    if (!this.speculative) return;
    const segment: Segment = { frames: this.preRoll, revision: 1, quiet: 0, confirmed: false,
      requested: -1, lastRequest: 0, controller: new AbortController() };
    this.preRoll = []; this.current = segment; this.segments.add(segment); this.preview('');
  }
  confirm() { if (this.current) this.current.confirmed = true; }
  private speculate(segment: Segment) {
    const revision = segment.revision;
    segment.requested = revision; segment.lastRequest = segment.frames.length;
    segment.pending = this.request(joinSamples(segment.frames), segment.controller.signal).then(text => {
      if (segment.controller.signal.aborted) return;
      segment.result = { revision, text };
      if (this.current === segment) this.preview(text);
    }).catch(() => {
      // A speculative failure is retried with the authoritative final recording.
    }).finally(() => { segment.pending = undefined; });
  }
  end(samples: Float32Array) {
    if (this.current) this.ended.set(samples, this.current);
    this.current = null; this.preRoll = [];
  }
  async finish(samples: Float32Array, signal: AbortSignal): Promise<string> {
    const segment = this.ended.get(samples);
    this.ended.delete(samples);
    if (!segment) return this.request(samples, signal);
    const cancel = () => segment.controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      await segment.pending;
      signal.throwIfAborted(); segment.controller.signal.throwIfAborted();
      if (segment.result?.revision === segment.revision && segment.result.text.trim()) return segment.result.text;
      return await this.request(samples, AbortSignal.any([signal, segment.controller.signal]));
    } finally {
      signal.removeEventListener('abort', cancel); this.segments.delete(segment);
    }
  }
  discard() {
    if (this.current) { this.current.controller.abort(); this.segments.delete(this.current); }
    this.current = null; this.preRoll = []; this.preview('');
  }
  reset() {
    for (const segment of this.segments) segment.controller.abort();
    this.segments.clear(); this.ended = new WeakMap(); this.discard();
  }
}
