/**
 * How many pixels wide and high a picture is, read from its header: the portal
 * has no image library, and the check of an edit's limit (see image-editing.ts)
 * needs nothing more than these two numbers. Only the types the portal takes
 * (PNG, JPEG, GIF, WebP) are read, and only as far as the header goes; a picture
 * whose header is cut short or odd has no size here, which is `undefined`.
 */

export interface PictureSize {
  width: number;
  height: number;
}

/** JPEG start-of-frame markers: C0 to CF, except the table (C4), the extension (C8) and the arithmetic table (CC) markers. */
const isFrame = (marker: number): boolean => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function jpegSize(b: Buffer): PictureSize | undefined {
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return undefined;
    // Any number of 0xFF may pad a marker.
    while (b[at + 1] === 0xff) at++;
    // A file cut off inside the padding has no marker left to read.
    if (at + 4 > b.length) return undefined;
    const marker = b[at + 1];
    // Markers that stand alone have no length: the start of an image, a restart, a bare 0x01.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (isFrame(marker)) return at + 9 <= b.length ? { height: b.readUInt16BE(at + 5), width: b.readUInt16BE(at + 7) } : undefined;
    // Past the scan nothing more is a header.
    if (marker === 0xda || marker === 0xd9) return undefined;
    at += 2 + b.readUInt16BE(at + 2);
  }
  return undefined;
}

function webpSize(b: Buffer): PictureSize | undefined {
  if (b.length < 30) return undefined;
  const kind = b.subarray(12, 16).toString("latin1");
  if (kind === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (kind === "VP8L") return { width: 1 + (b[21] | ((b[22] & 0x3f) << 8)), height: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)) };
  if (kind === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  return undefined;
}

/** The size of a PNG, JPEG, GIF or WebP from its bytes, or undefined when they are none of these or the header is not whole. */
export function pictureSize(b: Buffer): PictureSize | undefined {
  let size: PictureSize | undefined;
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) size = { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  else if (b.length >= 10 && b.subarray(0, 3).toString("latin1") === "GIF") size = { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  else if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) size = jpegSize(b);
  else if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") size = webpSize(b);
  return size && size.width > 0 && size.height > 0 ? size : undefined;
}
