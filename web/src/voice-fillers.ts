import { api, type FillerKind, type VoiceNotices } from "./api";
import { pcmBuffer } from "./pcm-stream";

/** Quiet enough to sit under the conversation rather than read as a reply. */
const FILLER_GAIN = 0.8;
/** How often to look for clips the portal is still rendering, and for how long. */
const POLL_MS = 15000, POLL_ATTEMPTS = 40;

/** Drop the leading and trailing silence TTS pads short phrases with. */
export function trimSilence(samples: Float32Array<ArrayBuffer>, sampleRate: number, threshold = 0.01, padMs = 40): Float32Array<ArrayBuffer> {
  let start = 0, end = samples.length;
  while (start < end && Math.abs(samples[start]) < threshold) start++;
  while (end > start && Math.abs(samples[end - 1]) < threshold) end--;
  if (start >= end) return new Float32Array(0);
  const pad = Math.round(sampleRate * padMs / 1000);
  return samples.slice(Math.max(0, start - pad), Math.min(samples.length, end + pad));
}

export const pick = <T,>(values: readonly T[], avoid?: T) => {
  const candidates = values.length > 1 ? values.filter(v => v !== avoid) : values;
  return candidates[Math.floor(Math.random() * candidates.length)];
};

/**
 * Decoded clips by version and text hash, kept for the page's lifetime so a
 * voice restart needs no request. AudioBuffers are not bound to a context.
 */
const decoded = new Map<string, AudioBuffer>();

/**
 * Filler clips the portal rendered ahead of time in the session's voice and
 * language. Loading them never renders speech, so voice starts without waiting.
 */
export class FillerSounds {
  private clips = new Map<FillerKind, AudioBuffer[]>();
  private last = new Map<FillerKind, AudioBuffer>();
  notices?: VoiceNotices;
  constructor(private audio: AudioContext) {}
  /** Downloads every ready clip, then checks back while the portal renders the rest. */
  async load(languages: readonly string[], signal: AbortSignal) {
    const loaded = new Set<string>();
    for (let attempt = 0; attempt < POLL_ATTEMPTS && !signal.aborted; attempt++) {
      try {
        const list = await api.voiceClips(languages, signal);
        this.notices = list.notices;
        await Promise.all(list.clips.filter(clip => clip.ready && !loaded.has(clip.hash)).map(async clip => {
          const key = `${list.version}/${clip.hash}`;
          let buffer = decoded.get(key);
          if (!buffer) {
            const response = await fetch(`/api/voice/clips/${key}`, { signal });
            if (!response.ok) return;
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (!bytes.length || bytes.length % 2) return;
            const raw = pcmBuffer(bytes, this.audio);
            const samples = trimSilence(raw.getChannelData(0), raw.sampleRate);
            if (!samples.length) return;
            buffer = this.audio.createBuffer(1, samples.length, raw.sampleRate);
            buffer.copyToChannel(samples, 0);
            decoded.set(key, buffer);
          }
          loaded.add(clip.hash);
          this.clips.set(clip.kind, [...this.clips.get(clip.kind) ?? [], buffer]);
        }));
        if (list.clips.every(clip => loaded.has(clip.hash))) return;
      } catch { if (signal.aborted) return; }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
  }
  /** Play a filler of this kind other than the previous one; undefined when none is ready. */
  play(kind: FillerKind, signal: AbortSignal): Promise<void> | undefined {
    const list = this.clips.get(kind);
    if (!list?.length || signal.aborted || this.audio.state !== "running") return;
    const clip = pick(list, this.last.get(kind));
    this.last.set(kind, clip);
    const source = this.audio.createBufferSource(), gain = this.audio.createGain();
    source.buffer = clip; gain.gain.value = FILLER_GAIN;
    source.connect(gain); gain.connect(this.audio.destination);
    return new Promise<void>(resolve => {
      const finish = () => { signal.removeEventListener("abort", cancel); source.disconnect(); gain.disconnect(); resolve(); };
      // Fade instead of clicking when barge-in cuts a filler short.
      const cancel = () => { gain.gain.setTargetAtTime(0, this.audio.currentTime, 0.015); source.stop(this.audio.currentTime + 0.06); };
      source.onended = finish;
      signal.addEventListener("abort", cancel, { once: true });
      source.start();
    });
  }
}
