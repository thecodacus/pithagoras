/**
 * Faster speech without a higher voice.
 *
 * Playing samples faster (an AudioBufferSourceNode's playbackRate) raises the
 * pitch with the speed, and at 1.5× a voice sounds like a cartoon. This is
 * WSOLA instead: the output is built from overlapping, windowed pieces of the
 * input, taken further apart than they are laid down, and each piece is
 * nudged to where it lines up best with the one before it so that the
 * waveform stays continuous. The pieces are short (40 ms, whatever the sample
 * rate), which is what keeps a voice's pitch; the nudge is what keeps it from
 * buzzing.
 *
 * It streams: samples go in as they arrive from the speech service and
 * finished output comes out behind them, so a streamed reply starts about as
 * early as it did. `flush` gives what is left at the end.
 */

import { DEFAULT_SAMPLE_RATE, joinSamples } from "./samples";

/**
 * The sizes of the pieces, in samples, for one sample rate: 40 ms a piece, laid down every 20, lined up within 10 either
 * way. Lining up compares samples `compare` apart and tries positions `search` apart (then every one around the best),
 * which keeps the work for a second of speech the same at any rate: 24 kHz is searched as it always was.
 */
function sizes(sampleRate: number) {
  const hop = Math.round(sampleRate * 0.02);
  const search = Math.max(1, Math.round(sampleRate / 24000));
  // Half a frame is what a window is overlapped by, so the frame is two of them.
  return { frame: hop * 2, hop, tolerance: Math.round(sampleRate * 0.01), search, compare: 2 * search };
}

/** A periodic Hann window: two of them half a frame apart add up to exactly one. */
const windows = new Map<number, Float32Array>();
function windowOf(frame: number): Float32Array {
  let w = windows.get(frame);
  if (!w) {
    w = new Float32Array(frame);
    for (let i = 0; i < frame; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame);
    windows.set(frame, w);
  }
  return w;
}

export class TimeStretch {
  private readonly size: ReturnType<typeof sizes>;
  private readonly window: Float32Array;
  /** Input so far, after half a frame of silence (so the first piece does not fade in). */
  private input: Float32Array;
  private length: number;
  /** Real samples taken in, and output given out, for the length the whole comes to. */
  private taken = 0;
  private given = 0;
  /** The next piece to lay down. */
  private frame = 0;
  /** Where the last piece was taken from, in `input`. */
  private previous = 0;
  /** The half-finished half-frame at the end of the output, still to be overlapped. */
  private tail: Float32Array;
  /** The first half-frame of output is the silence put in front: it is not given out. */
  private skip: number;

  /** `rate` times as fast, for samples made at `sampleRate` Hz. */
  constructor(readonly rate: number, sampleRate = DEFAULT_SAMPLE_RATE) {
    if (!(rate > 0)) throw new Error("The rate must be above zero");
    if (!(sampleRate > 0)) throw new Error("The sample rate must be above zero");
    this.size = sizes(sampleRate);
    this.window = windowOf(this.size.frame);
    this.input = new Float32Array(this.size.hop);
    this.length = this.size.hop;
    this.tail = new Float32Array(this.size.hop);
    this.skip = this.size.hop;
  }

  private append(samples: Float32Array) {
    if (this.length + samples.length > this.input.length) {
      const grown = new Float32Array(Math.max(this.input.length * 2, this.length + samples.length));
      grown.set(this.input.subarray(0, this.length));
      this.input = grown;
    }
    this.input.set(samples, this.length);
    this.length += samples.length;
  }

  /** How well a piece taken from `at` goes on from what the last one would have gone on to. */
  private overlap(natural: number, at: number): number {
    let sum = 0;
    for (let i = 0; i < this.size.hop; i += this.size.compare) sum += this.input[natural + i] * this.input[at + i];
    return sum;
  }

  /** Where the next piece lines up best with what the last one would have gone on to. */
  private align(ideal: number, limit: number): number {
    if (this.frame === 0) return 0;
    const { hop, tolerance, search } = this.size;
    const natural = this.previous + hop;
    const from = Math.max(0, ideal - tolerance), to = Math.min(limit, ideal + tolerance);
    const bestOf = (first: number, last: number, step: number, fallback: number) => {
      let best = fallback, score = -Infinity;
      for (let at = first; at <= last; at += step) {
        const sum = this.overlap(natural, at);
        if (sum > score) { score = sum; best = at; }
      }
      return best;
    };
    // Coarse over the whole range, then every position a step either way of the best.
    const coarse = bestOf(from, to, search, ideal);
    return search === 1 ? coarse : bestOf(Math.max(from, coarse - search + 1), Math.min(to, coarse + search - 1), 1, coarse);
  }

  /** Lay down every piece the input so far is enough for. */
  private run(end: boolean): Float32Array {
    const out: Float32Array[] = [];
    const { frame, hop, tolerance } = this.size;
    while (true) {
      const ideal = Math.round(this.frame * hop * this.rate);
      // Past the end of what there is to read, with the silence at the end counted.
      if (end ? ideal >= this.length : ideal + tolerance + frame > this.length || this.previous + hop + frame > this.length) break;
      const at = this.align(ideal, Math.max(0, Math.min(this.length - frame, ideal + tolerance)));
      const piece = new Float32Array(frame);
      for (let i = 0; i < frame; i++) piece[i] = (this.input[at + i] ?? 0) * this.window[i];
      const done = new Float32Array(hop);
      for (let i = 0; i < hop; i++) done[i] = this.tail[i] + piece[i];
      this.tail = piece.slice(hop);
      this.previous = at;
      this.frame++;
      out.push(done);
    }
    let result = joinSamples(out);
    if (this.skip) {
      const cut = Math.min(this.skip, result.length);
      this.skip -= cut; result = result.subarray(cut);
    }
    const total = result.length;
    if (end) {
      // As long as the input made faster, not a piece's worth longer.
      const wanted = Math.max(0, Math.round(this.taken / this.rate) - this.given);
      result = result.subarray(0, Math.min(total, wanted));
    }
    this.given += result.length;
    return result;
  }

  push(samples: Float32Array): Float32Array {
    if (this.rate === 1) { this.given += samples.length; return samples; }
    this.taken += samples.length;
    this.append(samples);
    return this.run(false);
  }

  flush(): Float32Array {
    if (this.rate === 1) return new Float32Array(0);
    // Silence after the end, so the last pieces have something to overlap with.
    this.append(new Float32Array(this.size.frame + this.size.tolerance + this.size.hop));
    return this.run(true);
  }
}

/** One whole recording made at `sampleRate` Hz, made `rate` times as fast. */
export function stretch(samples: Float32Array, rate: number, sampleRate = DEFAULT_SAMPLE_RATE): Float32Array {
  if (rate === 1) return samples;
  const s = new TimeStretch(rate, sampleRate);
  return joinSamples([s.push(samples), s.flush()]);
}

/** Half a second of samples: a few milliseconds of work at a time. */
const stepOf = (sampleRate: number) => Math.round(sampleRate / 2);

/**
 * `stretch` a little at a time, letting the page carry on in between: a
 * whole reply in one go holds up the orb and the microphone for a moment.
 */
export async function stretchInSteps(samples: Float32Array, rate: number, signal: AbortSignal, sampleRate = DEFAULT_SAMPLE_RATE): Promise<Float32Array> {
  if (rate === 1) return samples;
  const s = new TimeStretch(rate, sampleRate), out: Float32Array[] = [], STEP = stepOf(sampleRate);
  for (let at = 0; at < samples.length; at += STEP) {
    out.push(s.push(samples.subarray(at, at + STEP)));
    await new Promise(resolve => setTimeout(resolve, 0));
    signal.throwIfAborted();
  }
  out.push(s.flush());
  return joinSamples(out);
}
