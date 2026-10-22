import { t } from "../portal";

/**
 * A recording made ready for the voice library: what the portal's own page has for its microphone, which an
 * extension does not import (scripts/check-boundaries.mjs), here as the library uses it.
 */

/** Mono 16 kHz samples as a 16-bit WAV, the form the library keeps a clone's recording in. */
export function samplesWav(samples: Float32Array): Blob {
  const data = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(data);
  const str = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  str(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, "data"); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767), true));
  return new Blob([data], { type: "audio/wav" });
}

/** A blob's bytes as base64, the part of its data URL after the comma; a failed read is the browser's own error. */
export const blobBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/** Why a file could not be read as audio: the browser's own words for one it cannot decode say nothing of what to do. */
export function decodeError(e: unknown): string {
  const name = (e as { name?: string } | null)?.name;
  if (name === "EncodingError" || name === "NotSupportedError") return t("That file could not be read as audio. Choose a WAV or MP3 recording.");
  return (e as Error).message;
}
