import { t } from "./i18n";
import { joinSamples } from "./samples";
import { TimeStretch } from "./time-stretch";

/**
 * How a phrase is played: `rate` makes it faster without raising the voice
 * (see time-stretch.ts), and `record` is given the phrase's samples as they
 * were spoken, before any of that, so a reply can be played again later at
 * whatever speed is chosen then.
 */
export interface SpeechOptions { rate?: number; record?: (samples: Float32Array) => void }

const samplesOf = (bytes: Uint8Array, count: number) => {
  const samples = new Float32Array(count), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return samples;
};

/**
 * Turns the bytes of a PCM stream into samples as they arrive. A 16-bit sample
 * cut in two between chunks is held back until its other half comes; `cut` says
 * whether the stream ended in the middle of one.
 */
function pcmDecoder() {
  let carry: number | undefined;
  return {
    /** The samples this chunk completes, or none when it holds less than one. */
    push(chunk: Uint8Array): Float32Array | undefined {
      const bytes = new Uint8Array(chunk.length + (carry === undefined ? 0 : 1));
      if (carry !== undefined) bytes[0] = carry;
      bytes.set(chunk, carry === undefined ? 0 : 1);
      carry = bytes.length % 2 ? bytes[bytes.length - 1] : undefined;
      const count = Math.floor(bytes.length / 2);
      return count ? samplesOf(bytes, count) : undefined;
    },
    get cut() { return carry !== undefined; },
  };
}

/** Whatever engine made the audio: nothing here knows which one it was. */
const incompleteAudio = () => new Error(t("The voice service returned incomplete audio"));

/** A buffer holding `samples`, or none for none: a zero-length AudioBuffer is an error. */
export function bufferOf(audio: BaseAudioContext, samples: Float32Array, sampleRate = 24000): AudioBuffer | undefined {
  if (!samples.length) return undefined;
  const buffer = audio.createBuffer(1, samples.length, sampleRate);
  buffer.getChannelData(0).set(samples);
  return buffer;
}

/** Buffer one spoken phrase so slower-than-realtime synthesis cannot interrupt words. */
export async function readPcmStream(
  body: ReadableStream<Uint8Array>, audio: AudioContext, signal: AbortSignal, options: SpeechOptions = {},
): Promise<AudioBuffer> {
  signal.throwIfAborted();
  const reader = body.getReader();
  // The stretch is worked on each chunk as it arrives, so the whole buffer
  // does not have to wait for one long stretch pass over everything.
  const stretcher = new TimeStretch(options.rate ?? 1);
  const chunks: Uint8Array[] = [];
  const stretched: Float32Array[] = [];
  const decoder = pcmDecoder();
  let length = 0;
  const cancelRead = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancelRead, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      chunks.push(value); length += value.length;
      const samples = decoder.push(value);
      if (samples) stretched.push(stretcher.push(samples));
    }
  } finally {
    signal.removeEventListener('abort', cancelRead);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
  if (!length || decoder.cut) throw incompleteAudio();
  stretched.push(stretcher.flush());
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  options.record?.(samplesOf(bytes, length / 2));
  const buffer = bufferOf(audio, joinSamples(stretched));
  if (!buffer) throw incompleteAudio();
  signal.throwIfAborted();
  return buffer;
}

export async function playAudioBuffer(buffer: AudioBuffer, audio: AudioContext, destination: AudioNode, signal: AbortSignal, onStarted: (scheduledAt?:number) => void): Promise<void> {
  signal.throwIfAborted();
  const source = audio.createBufferSource(); source.buffer = buffer; source.connect(destination);
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', cancel); source.disconnect(); resolve(); };
    const cancel = () => { source.onended = null; source.stop(); signal.removeEventListener('abort', cancel); source.disconnect(); reject(signal.reason); };
    source.onended = finish;
    signal.addEventListener('abort', cancel, { once: true });
    source.start(); onStarted(audio.currentTime);
    if (signal.aborted) cancel();
  });
}

/** Start from a small PCM cushion while the producer continues generating. */
export async function preparePcmSpeech(body: ReadableStream<Uint8Array>, audio: AudioContext, signal: AbortSignal, options: SpeechOptions = {}) {
  const reader = body.getReader();
  const stretcher = new TimeStretch(options.rate ?? 1);
  let spoken = 0;
  const pending: AudioBuffer[] = [];
  const sources = new Set<AudioBufferSourceNode>();
  const decoder = pcmDecoder();
  let destination: AudioNode | undefined, nextTime = 0, finished = false;
  let buffered = 0, started = false;
  let ready!: () => void, rejectReady!: (error: unknown) => void;
  const initial = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
  let finishPlay!: () => void, failPlay!: (error: unknown) => void;
  let onStarted: (scheduledAt?:number)=>void = () => {};
  const pump = () => {
    if (!destination || signal.aborted) return;
    for (const buffer of pending.splice(0)) {
      const source = audio.createBufferSource(); source.buffer = buffer; source.connect(destination);
      sources.add(source);
      source.onended = () => { sources.delete(source); source.disconnect(); if (finished && !sources.size) finishPlay(); };
      nextTime = Math.max(nextTime, audio.currentTime + 0.04);
      const scheduledAt=nextTime; source.start(nextTime); nextTime += buffer.duration;
      if (!started) { started = true; onStarted(scheduledAt); }
    }
    if (finished && !sources.size) finishPlay();
  };
  const cancel = () => {
    void reader.cancel().catch(() => {});
    for (const source of sources) { source.onended = null; source.stop(); source.disconnect(); }
    sources.clear(); rejectReady(signal.reason); failPlay?.(signal.reason);
  };
  signal.addEventListener('abort', cancel, { once: true });
  const completed = (async () => {
    try {
      signal.throwIfAborted();
      while (true) {
        const { done, value } = await reader.read(); signal.throwIfAborted();
        if (done) break;
        const samples = decoder.push(value);
        if (!samples) continue;
        spoken += samples.length; options.record?.(samples);
        const buffer = bufferOf(audio, stretcher.push(samples));
        if (!buffer) continue;
        pending.push(buffer); buffered += buffer.duration;
        if (buffered >= 0.65) ready();
        pump();
      }
      if (!spoken || decoder.cut) throw incompleteAudio();
      const rest = bufferOf(audio, stretcher.flush());
      if (rest) { pending.push(rest); buffered += rest.duration; }
      finished = true; ready(); pump();
    } catch (error) { rejectReady(error); failPlay?.(error); throw error; }
    finally { reader.releaseLock(); }
  })();
  // The pipeline observes completion after this function has returned.
  void completed.catch(() => {});
  try { await initial; } catch (error) { signal.removeEventListener('abort', cancel); throw error; }
  return { completed, play: async (output: AudioNode, notify: (scheduledAt?:number) => void) => {
    signal.throwIfAborted();
    try {
      await new Promise<void>((resolve, reject) => { finishPlay = resolve; failPlay = reject; destination = output; onStarted = notify; pump(); });
    } finally { signal.removeEventListener('abort', cancel); }
  } };
}
