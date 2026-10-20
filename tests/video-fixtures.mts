import { readFileSync } from "node:fs";

// What the tests of what a clip is share: two tiny real clips, and one as stable-diffusion.cpp writes it.

export const WEBM = readFileSync(new URL("./fixtures/clip.webm", import.meta.url));
export const MP4 = readFileSync(new URL("./fixtures/clip.mp4", import.meta.url));
/**
 * The clip as stable-diffusion.cpp writes one: the same file, with the EBML document type `matroska` where it had `webm`
 * (the header is four bytes longer for it). Checked on a real clip from a test server: `1a 45 df a3 … 42 82 88 "matroska"`.
 */
export const MATROSKA = (() => {
  const at = WEBM.indexOf(Buffer.from([0x42, 0x82, 0x84]));
  if (at < 5 || at > 64 || WEBM[4] !== 0x9f) throw new Error("the fixture clip has no header of the shape this makes a matroska one of");
  return Buffer.concat([WEBM.subarray(0, 4), Buffer.from([0x9f + 4]), WEBM.subarray(5, at), Buffer.from([0x42, 0x82, 0x88]), Buffer.from("matroska"), WEBM.subarray(at + 7)]);
})();
