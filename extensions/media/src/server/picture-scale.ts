import sharp, { type Metadata } from "sharp";
import { pictureType } from "./picture-files";
import { pictureSize, type PictureSize } from "./picture-size";

/**
 * Making a picture fit what an edit takes: scaled down to the maximum size and
 * re-encoded smaller when it weighs too much, so that the edit goes ahead with
 * a picture the endpoint accepts instead of being refused (see image-editing.ts,
 * which decides what has to fit and what to say about it).
 *
 * The aspect ratio is kept and nothing is cut, and a picture is never scaled up.
 * A picture that fits is not passed through here at all: it is sent byte for byte.
 */

/** Why a picture could not be made to fit: the message is the whole sentence after the subject, for the person or the agent to read. */
export class CannotFit extends Error {}

/** The side below which a picture is no longer a picture to edit: scaling stops there and the picture is refused. */
const SMALLEST_SIDE = 16;

// A server that scales one picture now and then gains nothing from libvips keeping decoded images and files around.
sharp.cache(false);

export interface Scaled {
  bytes: Buffer;
  /** What it is now, and what it was. */
  size: PictureSize;
}

/** What the header says of a picture, as the pixels will be seen: a picture the camera held on its side is turned by its EXIF mark when scaled, so the box applies to what the person sees. */
async function seen(bytes: Buffer): Promise<{ size: PictureSize; alpha: boolean; type: string }> {
  const type = pictureType(bytes.subarray(0, 12));
  const header = pictureSize(bytes);
  if (!type || !header) throw new CannotFit("its size cannot be read");
  let meta: Metadata;
  try {
    meta = await sharp(bytes).metadata();
  } catch (e) {
    throw new CannotFit(`it cannot be read as a picture (${(e as Error).message})`);
  }
  const turned = (meta.orientation ?? 1) >= 5;
  return { size: turned ? { width: header.height, height: header.width } : header, alpha: Boolean(meta.hasAlpha), type };
}

/** The largest size that keeps the ratio and fits the box in the way up that suits the picture best, or the size it has when it fits. */
export function sizeWithin(size: PictureSize, maxWidth: number, maxHeight: number): PictureSize {
  const upright = Math.min(maxWidth / size.width, maxHeight / size.height);
  const sideways = Math.min(maxHeight / size.width, maxWidth / size.height);
  const factor = Math.min(1, Math.max(upright, sideways));
  if (factor === 1) return size;
  return { width: Math.max(1, Math.floor(size.width * factor)), height: Math.max(1, Math.floor(size.height * factor)) };
}

/** Whether the size is within the box, either way up. */
export function fitsBox(size: PictureSize, maxWidth: number, maxHeight: number): boolean {
  return (size.width <= maxWidth && size.height <= maxHeight) || (size.width <= maxHeight && size.height <= maxWidth);
}

/**
 * Encodes `bytes` at `size`. A mask is smoothed by nothing (`nearest`), so that its edges stay edges and not grey,
 * and kept lossless; a picture keeps its kind where it can: a JPEG, a WebP or a GIF stays one, and a PNG too until
 * it has to be lighter, when it becomes a WebP if it has transparency to keep and a JPEG if it has not.
 */
async function encode(bytes: Buffer, size: PictureSize, kind: { type: string; alpha: boolean; mask: boolean; lighter: boolean }, quality: number): Promise<Buffer> {
  const { type, alpha, mask, lighter } = kind;
  let image = sharp(bytes, { animated: type === "image/gif" })
    .rotate()
    .resize({ width: size.width, height: size.height, fit: "fill", kernel: mask ? "nearest" : "lanczos3" });
  if (!mask) image = image.toColourspace("srgb");
  if (mask || (type === "image/png" && !lighter)) return image.png().toBuffer();
  if (type === "image/gif") return image.gif().toBuffer();
  if (type === "image/webp" || (type === "image/png" && alpha)) return image.webp({ quality }).toBuffer();
  // A JPEG, or a PNG with nothing to see through: no transparency to lose.
  return image.jpeg({ quality }).toBuffer();
}

async function run<T>(what: Promise<T>): Promise<T> {
  try {
    return await what;
  } catch (e) {
    throw e instanceof CannotFit ? e : new CannotFit(`it could not be scaled (${(e as Error).message})`);
  }
}

/**
 * The picture at `size`, in the kind it has. With `mask` the nearest pixel is taken, so that a mask stays a mask,
 * and it stays a PNG.
 */
export function scaleTo(bytes: Buffer, size: PictureSize, mask = false): Promise<Scaled> {
  return run(
    (async () => {
      const now = await seen(bytes);
      return { bytes: await encode(bytes, size, { type: now.type, alpha: now.alpha, mask, lighter: false }, 92), size };
    })(),
  );
}

/** The picture scaled down to the largest size within the box that keeps its ratio (see `sizeWithin`), as it is seen: turned by its EXIF mark. */
export function scaleToBox(bytes: Buffer, maxWidth: number, maxHeight: number, mask = false): Promise<Scaled> {
  return run(
    (async () => {
      const now = await seen(bytes);
      const size = sizeWithin(now.size, maxWidth, maxHeight);
      return { bytes: await encode(bytes, size, { type: now.type, alpha: now.alpha, mask, lighter: false }, 92), size };
    })(),
  );
}

/**
 * The picture lighter than `budget` bytes: the same size at lower quality first, then smaller and smaller, and the
 * kind changed where it has to be (see `encode`). Refused when it is still too heavy at the smallest it may be.
 */
export function fitBytes(bytes: Buffer, budget: number, mask = false): Promise<Scaled> {
  return run(
    (async () => {
      const now = await seen(bytes);
      const kind = { type: now.type, alpha: now.alpha, mask, lighter: true };
      // A GIF and a mask have no quality to give up; the others try three before they give up pixels.
      const lossy = !mask && now.type !== "image/gif";
      // The shrink starts from what the last lossy try weighed: the original can be a PNG many times heavier than the JPEG or WebP it becomes.
      let weight = bytes.length;
      for (const quality of lossy ? [85, 70, 55] : []) {
        const out = await encode(bytes, now.size, kind, quality);
        if (out.length <= budget) return { bytes: out, size: now.size };
        weight = out.length;
      }
      let factor = 1;
      for (let attempt = 0; attempt < 8; attempt++) {
        // The weight follows the pixels about as the square of the side does; a little under, so that the next try is likely to be the last.
        factor *= Math.min(0.9, Math.max(0.3, Math.sqrt(budget / weight) * 0.9));
        const size = { width: Math.max(1, Math.floor(now.size.width * factor)), height: Math.max(1, Math.floor(now.size.height * factor)) };
        if (Math.min(size.width, size.height) < SMALLEST_SIDE) break;
        const out = await encode(bytes, size, kind, 60);
        if (out.length <= budget) return { bytes: out, size };
        weight = out.length;
      }
      throw new CannotFit("it stays too heavy even when it is scaled down and compressed as far as it can be");
    })(),
  );
}
