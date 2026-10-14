/** Pieces of audio laid end to end, as one new array. */
export function joinSamples(pieces: Float32Array[]): Float32Array {
  const joined = new Float32Array(pieces.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of pieces) { joined.set(p, offset); offset += p.length; }
  return joined;
}
