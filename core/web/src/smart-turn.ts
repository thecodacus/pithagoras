/**
 * Semantic end of turn: whether what was said so far sounds finished.
 *
 * Silero says when there is speech and when there is silence, but not whether
 * a silence ends the turn: "I'd like to book a flight to…" and "What time is
 * it?" are followed by the same quiet. Waiting a fixed second answers every
 * turn a second late and still cuts off a pause that is a little longer.
 * Pipecat's Smart Turn v3 listens to the turn itself (Whisper-Tiny's encoder
 * and a classifier) and gives the probability that it is complete.
 *
 * Here a short pause has the model look at the whole turn so far. Sure enough
 * that it is finished, the turn ends at once; otherwise listening goes on, and
 * the next pause asks again with everything said by then. A long silence ends
 * the turn regardless, as the silence alone did before, so a turn the model
 * never finds finished is still sent.
 *
 * The features are those of the reference implementation, Hugging Face's
 * WhisperFeatureExtractor with 8 s chunks, worked out here so that the model
 * runs in the browser like Silero does (tests/smart-turn.test.mts checks them
 * against it).
 */

const RATE = 16000;
/** The model hears the last 8 s of the turn; a shorter turn has silence in front of it. */
export const WINDOW_SAMPLES = 8 * RATE;
const N_FFT = 400;
const HOP = 160;
const BINS = N_FFT / 2 + 1;
export const MEL_BINS = 80;
export const MEL_FRAMES = WINDOW_SAMPLES / HOP;

/** What the voice settings keep. */
export interface SmartTurnSettings {
  enabled: boolean;
  /** The silence after which the model is asked. */
  checkMs: number;
  /** Whether it is asked again each time the pause grows by `checkMs`, while its last answer was that the turn goes on. */
  recheck: boolean;
  /** How sure it has to be that the turn is over. */
  threshold: number;
  /** The silence that ends a turn whatever the model said. */
  fallbackMs: number;
}

/** The last 8 s of the turn, with silence in front where it is shorter. */
export function turnWindow(frames: Float32Array[]): Float32Array {
  const window = new Float32Array(WINDOW_SAMPLES);
  let end = WINDOW_SAMPLES;
  for (let i = frames.length - 1; i >= 0 && end > 0; i--) {
    const frame = frames[i], take = Math.min(frame.length, end);
    window.set(frame.subarray(frame.length - take), end - take);
    end -= take;
  }
  return window;
}

/** A periodic Hann window, as `window_function(400, "hann")`. */
const HANN = Float64Array.from({ length: N_FFT }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT));

const slaneyMel = (hz: number) => hz >= 1000 ? 15 + Math.log(hz / 1000) * (27 / Math.log(6.4)) : (3 * hz) / 200;
const slaneyHz = (mel: number) => mel >= 15 ? 1000 * Math.exp((Math.log(6.4) / 27) * (mel - 15)) : (200 * mel) / 3;

/**
 * The mel filters, as `mel_filter_bank(201, 80, 0, 8000, 16000, norm="slaney",
 * mel_scale="slaney")`: for each mel bin, its first FFT bin and its weights.
 */
const FILTERS = (() => {
  const centres = Array.from({ length: MEL_BINS + 2 }, (_, i) => slaneyHz((slaneyMel(8000) * i) / (MEL_BINS + 1)));
  return Array.from({ length: MEL_BINS }, (_, m) => {
    const [low, mid, high] = [centres[m], centres[m + 1], centres[m + 2]];
    const all = Array.from({ length: BINS }, (_, k) => {
      const hz = (k * RATE) / N_FFT;
      return Math.max(0, Math.min((hz - low) / (mid - low), (high - hz) / (high - mid))) * (2 / (high - low));
    });
    // A triangle: zero outside one run of bins.
    const first = all.findIndex(w => w > 0), last = BINS - 1 - [...all].reverse().findIndex(w => w > 0);
    return { first, weights: Float64Array.from(all.slice(first, last + 1)) };
  });
})();

/**
 * A 400-point FFT, in place of numpy's `rfft`: Stockham's, in four passes of
 * 4, 4, 5 and 5 points, since 400 is no power of two.
 */
const RADICES = [4, 4, 5, 5];
const TWIDDLE_RE = Float64Array.from({ length: N_FFT }, (_, k) => Math.cos((-2 * Math.PI * k) / N_FFT));
const TWIDDLE_IM = Float64Array.from({ length: N_FFT }, (_, k) => Math.sin((-2 * Math.PI * k) / N_FFT));
function fft(re: Float64Array, im: Float64Array, re2: Float64Array, im2: Float64Array): [Float64Array, Float64Array] {
  const vr = new Float64Array(5), vi = new Float64Array(5);
  let span = 1;
  for (const radix of RADICES) {
    const groups = N_FFT / radix, step = N_FFT / (span * radix);
    for (let j = 0; j < groups; j++) {
      const k = j % span;
      for (let r = 0; r < radix; r++) {
        const x = re[j + r * groups], y = im[j + r * groups];
        const t = (k * r * step) % N_FFT;
        vr[r] = x * TWIDDLE_RE[t] - y * TWIDDLE_IM[t];
        vi[r] = x * TWIDDLE_IM[t] + y * TWIDDLE_RE[t];
      }
      const out = (j - k) * radix + k;
      for (let q = 0; q < radix; q++) {
        let sr = 0, si = 0;
        for (let r = 0; r < radix; r++) {
          const t = ((q * r) % radix) * (N_FFT / radix);
          sr += vr[r] * TWIDDLE_RE[t] - vi[r] * TWIDDLE_IM[t];
          si += vr[r] * TWIDDLE_IM[t] + vi[r] * TWIDDLE_RE[t];
        }
        re2[out + q * span] = sr; im2[out + q * span] = si;
      }
    }
    [re, re2] = [re2, re]; [im, im2] = [im2, im];
    span *= radix;
  }
  return [re, im];
}

/**
 * The model's input for an 8 s window, laid out as its [1, 80, 800] tensor:
 * the waveform brought to zero mean and unit variance (`do_normalize`), then
 * Whisper's log-mel spectrogram of it.
 */
export function whisperFeatures(window: Float32Array): Float32Array {
  if (window.length !== WINDOW_SAMPLES) throw new Error(`Expected ${WINDOW_SAMPLES} samples, got ${window.length}`);
  let mean = 0;
  for (const v of window) mean += v;
  mean /= window.length;
  let variance = 0;
  for (const v of window) variance += (v - mean) ** 2;
  variance /= window.length;
  // Kept in single precision, as the reference does before the spectrogram.
  const scale = Math.sqrt(variance + 1e-7);
  const normal = Float32Array.from(window, v => (v - mean) / scale);
  // Centred frames: 200 samples reflected in at each end.
  const pad = N_FFT / 2;
  const padded = new Float64Array(WINDOW_SAMPLES + N_FFT);
  padded.set(normal, pad);
  for (let i = 1; i <= pad; i++) {
    padded[pad - i] = normal[i];
    padded[pad + WINDOW_SAMPLES - 1 + i] = normal[WINDOW_SAMPLES - 1 - i];
  }
  const features = new Float32Array(MEL_BINS * MEL_FRAMES);
  const logs = new Float64Array(MEL_BINS * MEL_FRAMES);
  const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT), re2 = new Float64Array(N_FFT), im2 = new Float64Array(N_FFT);
  const power = new Float64Array(BINS);
  let max = -Infinity;
  // Whisper drops the last of the 801 frames.
  for (let t = 0; t < MEL_FRAMES; t++) {
    for (let i = 0; i < N_FFT; i++) { re[i] = padded[t * HOP + i] * HANN[i]; im[i] = 0; }
    const [xr, xi] = fft(re, im, re2, im2);
    for (let k = 0; k < BINS; k++) power[k] = xr[k] * xr[k] + xi[k] * xi[k];
    for (let m = 0; m < MEL_BINS; m++) {
      const { first, weights } = FILTERS[m];
      let sum = 0;
      for (let w = 0; w < weights.length; w++) sum += weights[w] * power[first + w];
      const value = Math.log10(Math.max(sum, 1e-10));
      logs[m * MEL_FRAMES + t] = value;
      if (value > max) max = value;
    }
  }
  for (let i = 0; i < logs.length; i++) features[i] = (Math.max(logs[i], max - 8) + 4) / 4;
  return features;
}

/** What the turn decision drives: the model, and how much silence Silero waits for before it ends a turn. */
export interface TurnEndIo {
  /** The probability that the turn in this window is complete. */
  predict(window: Float32Array): Promise<number>;
  /** Silero's `redemptionMs`, which ends the turn after that much silence. */
  redemption(ms: number): void;
}

/** What it needs of the speech detection settings. */
type Detection = { positiveSpeechThreshold: number; negativeSpeechThreshold: number; preSpeechPadMs: number; redemptionMs: number };

/** A Silero v5 frame: 512 samples at 16 kHz. */
export const FRAME_MS = 32;

/**
 * When a turn ends, for hands-free voice: fed Silero's frames, it keeps the
 * turn's audio as Silero does (from the first frame of speech, with the
 * frames before it), asks the model once a pause is `checkMs` long (and, with
 * `recheck`, again each time it grows by that much), and has Silero end the
 * turn at its next silent frame when the model says it is finished. Silero
 * itself ends it after `fallbackMs` of silence.
 *
 * Until `ready`, and again after `failed`, turns end as they always did,
 * after the speech detection settings' silence.
 */
export class TurnEnd {
  private frames: Float32Array[] = [];
  private speaking = false;
  /** Frames since the pause began; 0 while speaking. */
  private quiet = 0;
  /** Counts pauses and turns, so that an answer about one that is over is dropped. */
  private pause = 0;
  private ending = false;
  /** The pause an answer is still awaited for: one question at a time. */
  private asking = -1;
  private on = false;
  private readonly preRoll: number;

  constructor(private detection: Detection, private settings: SmartTurnSettings, private io: TurnEndIo) {
    this.preRoll = Math.floor(detection.preSpeechPadMs / FRAME_MS);
  }

  /** The model is loaded: from now on it ends turns, and the fallback is the longest silence waited for. */
  ready() {
    this.on = true;
    this.io.redemption(this.settings.fallbackMs);
  }

  /** The model could not be loaded or run: back to the plain silence rule. */
  failed() {
    this.on = false;
    this.ending = false;
    this.pause++;
    this.io.redemption(this.detection.redemptionMs);
  }

  frame(probability: number, samples: Float32Array) {
    this.frames.push(samples.slice());
    // The model hears no more than the last 8 s.
    if (this.frames.length * samples.length > WINDOW_SAMPLES + samples.length) this.frames.shift();
    if (!this.speaking) {
      if (probability < this.detection.positiveSpeechThreshold) {
        if (this.frames.length > this.preRoll) this.frames.shift();
        return;
      }
      this.speaking = true;
    }
    if (probability >= this.detection.positiveSpeechThreshold) {
      if (this.quiet) this.pause++;
      this.quiet = 0;
      // Speech again before Silero ended the turn: it is not over after all.
      if (this.ending) { this.ending = false; this.io.redemption(this.settings.fallbackMs); }
      return;
    }
    if (!this.quiet && probability >= this.detection.negativeSpeechThreshold) return;
    this.quiet++;
    // Due when the pause reaches `checkMs`, and with `recheck` each further `checkMs`: the frame that crosses one.
    const due = Math.floor((this.quiet * FRAME_MS) / this.settings.checkMs);
    const crossed = due >= 1 && due > Math.floor(((this.quiet - 1) * FRAME_MS) / this.settings.checkMs) && (due === 1 || this.settings.recheck);
    if (this.on && crossed && !this.ending && this.asking !== this.pause) this.check();
  }

  /** Silero ended the turn, or dropped it as too short, or was reset: the next one starts afresh. */
  ended() {
    this.frames = [];
    this.speaking = false;
    this.quiet = 0;
    this.pause++;
    if (this.ending) { this.ending = false; this.io.redemption(this.settings.fallbackMs); }
  }

  private check() {
    const pause = this.pause;
    this.asking = pause;
    this.io.predict(turnWindow(this.frames)).then(probability => {
      if (this.asking === pause) this.asking = -1;
      if (pause !== this.pause || !this.on || probability < this.settings.threshold) return;
      this.ending = true;
      // Nothing to wait for: the next silent frame ends it.
      this.io.redemption(0);
    }, () => { if (this.asking === pause) this.asking = -1; if (this.on) this.failed(); });
  }
}

/** The model, loaded in a worker of its own (smart-turn-worker.ts). */
export class SmartTurnWorker {
  /** Settles once the model is loaded, or could not be. */
  readonly ready: Promise<void>;
  private worker = new Worker(new URL("./smart-turn-worker.ts", import.meta.url), { type: "module" });
  private waiting = new Map<number, { resolve: (probability: number) => void; reject: (error: Error) => void }>();
  private next = 0;

  constructor() {
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = ({ data }) => {
        if (data.ready) return resolve();
        if (data.failed) return reject(new Error(data.failed));
        const call = this.waiting.get(data.id);
        this.waiting.delete(data.id);
        if (data.error) call?.reject(new Error(data.error)); else call?.resolve(data.probability);
      };
      this.worker.onerror = event => {
        const error = new Error(event.message || "Smart Turn could not start");
        reject(error);
        for (const call of this.waiting.values()) call.reject(error);
        this.waiting.clear();
      };
    });
    // Whoever waits for it handles a failure; this keeps one that comes first from being reported as unhandled.
    this.ready.catch(() => {});
  }

  predict(window: Float32Array): Promise<number> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ id, window }, [window.buffer]);
    });
  }

  close() {
    this.worker.terminate();
    for (const call of this.waiting.values()) call.reject(new Error("Smart Turn was closed"));
    this.waiting.clear();
  }
}
