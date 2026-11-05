/** The sample rates voice mode plays, in Hz: what a speech server may answer at. */
export const MIN_SAMPLE_RATE = 8000;
export const MAX_SAMPLE_RATE = 192000;
/** The rate of speech that does not say its own: raw audio from a source that names none. */
export const DEFAULT_SAMPLE_RATE = 24000;

/** WAVE_FORMAT_* codes of the fmt chunk. */
const FORMAT_PCM = 1, FORMAT_FLOAT = 3, FORMAT_EXTENSIBLE = 0xfffe;

/** Mono 16-bit little-endian samples and the rate they are played at. */
export interface Audio { rate: number; pcm: Buffer }

/** Whether a rate is one voice mode plays: whole hertz from 8 to 192 kHz. */
export const playableRate = (rate: number) => Number.isInteger(rate) && rate >= MIN_SAMPLE_RATE && rate <= MAX_SAMPLE_RATE;

/** What a fmt chunk says, as words for an error: "stereo 24-bit integer audio at 44100 Hz". */
function described(tag: number, channels: number, bits: number, rate: number): string {
  const kind = tag === FORMAT_PCM ? "integer" : tag === FORMAT_FLOAT ? "float" : `format ${tag}`;
  const layout = channels === 1 ? "mono" : channels === 2 ? "stereo" : `${channels}-channel`;
  return `${layout} ${bits}-bit ${kind} audio at ${rate} Hz`;
}

/** One sample of a frame as a float in [-1, 1], from the bytes at `at`. */
type Reader = (wav: Buffer, at: number) => number;
const int16: Reader = (wav, at) => wav.readInt16LE(at) / 32768;
const float32: Reader = (wav, at) => wav.readFloatLE(at);

/**
 * The samples of a RIFF/WAVE buffer as mono 16-bit little-endian PCM, with the rate the header gives. `label` is what
 * answered with it. Read: 16-bit integer and 32-bit float samples, mono or stereo (mixed to mono), also as
 * WAVE_FORMAT_EXTENSIBLE, at 8 to 192 kHz. Anything else is refused, with what it was in the message.
 */
export function wavAudio(wav: Buffer, label: string): Audio {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE")
    throw new Error(`${label} returned invalid WAV audio`);
  let format: { tag: number; channels: number; bits: number; rate: number; frame: number } | undefined;
  for (let at = 12; at + 8 <= wav.length;) {
    const id = wav.toString("ascii", at, at + 4), size = wav.readUInt32LE(at + 4), body = at + 8;
    if (id === "fmt ") {
      if (size < 16 || body + size > wav.length) throw new Error(`${label} returned a WAV file with a broken fmt chunk`);
      let tag = wav.readUInt16LE(body);
      const channels = wav.readUInt16LE(body + 2), rate = wav.readUInt32LE(body + 4), frame = wav.readUInt16LE(body + 12), bits = wav.readUInt16LE(body + 14);
      // The extensible form keeps the format in the first two bytes of its sub-format GUID.
      if (tag === FORMAT_EXTENSIBLE) {
        if (size < 40) throw new Error(`${label} returned a WAV file with a broken fmt chunk`);
        tag = wav.readUInt16LE(body + 24);
      }
      const got = described(tag, channels, bits, rate);
      const readable = (tag === FORMAT_PCM && bits === 16) || (tag === FORMAT_FLOAT && bits === 32);
      if (!readable || channels < 1 || channels > 2)
        throw new Error(`Expected mono or stereo 16-bit integer or 32-bit float audio from ${label}, got ${got}`);
      if (!playableRate(rate)) throw new Error(`Expected audio from ${MIN_SAMPLE_RATE} to ${MAX_SAMPLE_RATE} Hz from ${label}, got ${got}`);
      // A frame is one sample of each channel, and its size is what the data is cut into.
      if (frame !== channels * bits / 8) throw new Error(`${label} returned a WAV file whose fmt chunk does not agree with itself (${got}, ${frame} bytes a frame)`);
      format = { tag, channels, bits, rate, frame };
    }
    if (id === "data") {
      // Samples are only meaningful once the fmt chunk has described them.
      if (!format) throw new Error(`${label} returned a WAV file whose samples come before its fmt chunk`);
      // A writer that does not know the length up front leaves a placeholder
      // size behind. The response is fully buffered, so its end is the truth.
      const end = size && body + size <= wav.length ? body + size : wav.length;
      const data = wav.subarray(body, end);
      if (!data.length || data.length % format.frame) throw new Error(`${label} returned invalid PCM audio`);
      return { rate: format.rate, pcm: mono(data, format) };
    }
    at = body + size + (size % 2);
  }
  throw new Error(`${label} returned no audio data`);
}

/** `data`, frames of `format`, as mono 16-bit little-endian samples: the same bytes where they already are. */
function mono(data: Buffer, format: { tag: number; channels: number; bits: number; frame: number }): Buffer {
  if (format.tag === FORMAT_PCM && format.channels === 1) return data;
  const read = format.tag === FORMAT_FLOAT ? float32 : int16;
  const step = format.frame / format.channels, frames = data.length / format.frame;
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < format.channels; c++) sum += read(data, i * format.frame + c * step);
    const value = sum / format.channels;
    // A float outside [-1, 1] clips, and one that is not a number is silence.
    const clipped = Number.isNaN(value) ? 0 : Math.max(-1, Math.min(1, value));
    out.writeInt16LE(Math.round(clipped < 0 ? clipped * 32768 : clipped * 32767), i * 2);
  }
  return out;
}
