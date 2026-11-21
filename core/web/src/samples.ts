/** The rate speech is made at where nothing says another: voice mode played 24 kHz alone before it was told its rate. */
export const DEFAULT_SAMPLE_RATE = 24000;

/** Pieces of audio laid end to end, as one new array. */
export function joinSamples(pieces: Float32Array[]): Float32Array {
  const joined = new Float32Array(pieces.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of pieces) { joined.set(p, offset); offset += p.length; }
  return joined;
}
