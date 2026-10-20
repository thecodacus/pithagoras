import { test } from "node:test";
import assert from "node:assert/strict";

const { pictureSize } = await import("../src/server/picture-size.ts");

/** Headers as the encoders write them, with as little else as the reader looks at. */
const be = (n: number, bytes = 4) => Buffer.from(Array.from({ length: bytes }, (_, i) => (n >>> (8 * (bytes - 1 - i))) & 0xff));
const le = (n: number, bytes: number) => Buffer.from(Array.from({ length: bytes }, (_, i) => (n >>> (8 * i)) & 0xff));
const png = (w: number, h: number) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), be(13), Buffer.from("IHDR"), be(w), be(h), Buffer.alloc(16)]);
const gif = (w: number, h: number) => Buffer.concat([Buffer.from("GIF89a"), le(w, 2), le(h, 2), Buffer.alloc(16)]);
/** With a comment segment before the frame, so that the segments are walked and not only the first one read. */
const jpeg = (w: number, h: number) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xfe]), be(6, 2), Buffer.from("abcd"),
    Buffer.from([0xff, 0xc2]), be(11, 2), Buffer.from([8]), be(h, 2), be(w, 2), Buffer.from([1, 1, 0x11, 0]),
    Buffer.from([0xff, 0xda, 0, 2]),
  ]);
const riff = (chunk: string, body: Buffer) => Buffer.concat([Buffer.from("RIFF"), le(body.length + 12, 4), Buffer.from("WEBP"), Buffer.from(chunk), le(body.length, 4), body]);
const webpLossy = (w: number, h: number) => riff("VP8 ", Buffer.concat([Buffer.from([0x10, 0, 0]), Buffer.from([0x9d, 0x01, 0x2a]), le(w, 2), le(h, 2), Buffer.alloc(8)]));
const webpLossless = (w: number, h: number) => {
  const bits = (w - 1) | ((h - 1) << 14);
  return riff("VP8L", Buffer.concat([Buffer.from([0x2f]), le(bits, 4), Buffer.alloc(8)]));
};
const webpExtended = (w: number, h: number) => riff("VP8X", Buffer.concat([Buffer.alloc(4), le(w - 1, 3), le(h - 1, 3), Buffer.alloc(8)]));

test("the size of each kind of picture is read from its header", () => {
  assert.deepEqual(pictureSize(png(2048, 1024)), { width: 2048, height: 1024 });
  assert.deepEqual(pictureSize(gif(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(pictureSize(jpeg(4000, 3000)), { width: 4000, height: 3000 });
  assert.deepEqual(pictureSize(webpLossy(1280, 720)), { width: 1280, height: 720 });
  assert.deepEqual(pictureSize(webpLossless(1280, 720)), { width: 1280, height: 720 });
  assert.deepEqual(pictureSize(webpExtended(16384, 9)), { width: 16384, height: 9 });
  assert.deepEqual(pictureSize(webpLossless(1, 16384)), { width: 1, height: 16384 });
});

test("what has no header to read has no size", () => {
  assert.equal(pictureSize(Buffer.alloc(0)), undefined);
  assert.equal(pictureSize(Buffer.from("<svg/>")), undefined);
  assert.equal(pictureSize(png(10, 10).subarray(0, 20)), undefined, "cut short");
  assert.equal(pictureSize(png(0, 10)), undefined, "zero is no size");
  assert.equal(pictureSize(jpeg(10, 10).subarray(0, 12)), undefined);
  assert.equal(pictureSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xda, 0, 2])), undefined, "a scan before any frame");
  assert.equal(pictureSize(Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xff, 0xe0])), undefined, "cut off inside the padding of a marker");
  assert.equal(pictureSize(webpLossy(10, 10).subarray(0, 24)), undefined);
  assert.equal(pictureSize(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPXXXX"), Buffer.alloc(20)])), undefined);
});
