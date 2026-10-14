import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Pictures sent with a message: checked, kept beside the chat, and read back.
 *
 * pi takes them with the prompt and puts them in its own record of the
 * conversation, but the transcript the portal draws is its own event log, and
 * a picture in there as base64 would make every replay of a chat carry it. So
 * the event names the file and the file is kept here, one folder per chat,
 * which goes when the chat does.
 *
 * What arrives is only trusted as far as its first bytes: the type is taken
 * from them, not from what the browser said, so that nothing that is not a
 * picture is ever stored or served back as one.
 */

/** Per picture, after decoding: what the larger providers take. A phone photo is scaled down in the browser before it gets here. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Per message. */
export const MAX_IMAGES = 8;

export class ImageError extends Error {}

/** A picture as pi takes it. */
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

/** A picture as the event log names it: the file, and what it is. */
export interface StoredImage {
  name: string;
  mimeType: string;
}

/** A picture on its way to pi, and the name it is kept under. */
export interface Attached extends StoredImage {
  data: string;
}

const KINDS: { mimeType: string; ext: string; is: (b: Buffer) => boolean }[] = [
  { mimeType: "image/png", ext: "png", is: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mimeType: "image/jpeg", ext: "jpg", is: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mimeType: "image/gif", ext: "gif", is: (b) => b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a" },
  {
    mimeType: "image/webp",
    ext: "webp",
    is: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  },
];

/** What a stored name looks like: made here, so nothing else is one. */
const NAME = /^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export const mimeOf = (name: string): string | undefined => KINDS.find((k) => name.endsWith(`.${k.ext}`))?.mimeType;

/** What picture `head` is the start of, by its bytes alone, or undefined for anything else. Twelve bytes are enough. */
export const pictureType = (head: Buffer): string | undefined => KINDS.find((k) => k.is(head))?.mimeType;

/** The file extension a picture is kept under, by its first bytes as pictureType reads them. */
export const pictureExt = (head: Buffer): string | undefined => KINDS.find((k) => k.is(head))?.ext;

/**
 * Base64, or a data: URL holding it, decoded: what every picture that arrives as
 * text goes through, so that they are all held to the same rules. Line breaks
 * and spaces in it are dropped, as wrapped base64 has them. `data` is what was
 * decoded, as plain base64. The size is worked out from the length before
 * anything large is decoded: that cost is what the check is for.
 */
export function decodeBase64(given: string, max: number): { bytes: Buffer; data: string } | { error: "invalid" | "large" } {
  const comma = given.startsWith("data:") ? given.indexOf(",") : -1;
  const data = (comma >= 0 ? given.slice(comma + 1) : given).replace(/\s+/g, "");
  if (!data || !BASE64.test(data)) return { error: "invalid" };
  if (Math.floor((data.length * 3) / 4) > max + 3) return { error: "large" };
  const bytes = Buffer.from(data, "base64");
  // The length said at most `max` and three bytes more.
  if (bytes.length > max) return { error: "large" };
  return { bytes, data };
}

/**
 * The pictures in a request body, checked, or an empty list when there are none.
 * `data` may be plain base64 or a data: URL, which is what a browser has to hand.
 */
export function parseImages(raw: unknown): { data: string; mimeType: string; ext: string }[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ImageError("images must be a list");
  if (raw.length > MAX_IMAGES) throw new ImageError(`At most ${MAX_IMAGES} pictures can go with one message`);
  return raw.map((item, i) => {
    const decoded = decodeBase64(typeof item?.data === "string" ? item.data : "", MAX_IMAGE_BYTES);
    if ("error" in decoded) {
      throw new ImageError(decoded.error === "invalid" ? `Picture ${i + 1} is not base64` : `Picture ${i + 1} is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
    }
    const { bytes, data } = decoded;
    const kind = KINDS.find((k) => k.is(bytes));
    if (!kind) throw new ImageError(`Picture ${i + 1} is not a PNG, JPEG, GIF or WebP image`);
    return { data, mimeType: kind.mimeType, ext: kind.ext };
  });
}

const folderOf = (root: string, sessionId: string): string => {
  if (!ID.test(sessionId)) throw new ImageError(`"${sessionId}" is not a session id`);
  return path.join(path.resolve(root), sessionId);
};

/** Keeps checked pictures for a chat and gives each the name it is kept under. */
export function saveImages(root: string, sessionId: string, images: { data: string; mimeType: string; ext: string }[]): Attached[] {
  if (!images.length) return [];
  const dir = folderOf(root, sessionId);
  mkdirSync(dir, { recursive: true });
  return images.map((image) => {
    const name = `${randomUUID()}.${image.ext}`;
    writeFileSync(path.join(dir, name), Buffer.from(image.data, "base64"), { flag: "wx" });
    return { name, mimeType: image.mimeType, data: image.data };
  });
}

/** Where a kept picture is, or undefined for a name that was never one of ours. */
export function imagePath(root: string, sessionId: string, name: string): string | undefined {
  if (!NAME.test(name) || !ID.test(sessionId)) return undefined;
  const file = path.join(folderOf(root, sessionId), name);
  try {
    return lstatSync(file).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pictures kept earlier, read back for sending again — a retried or edited
 * message keeps what it was sent with. One that has gone is left out.
 */
export function loadImages(root: string, sessionId: string, stored: StoredImage[]): Attached[] {
  const out: Attached[] = [];
  for (const image of stored) {
    const file = imagePath(root, sessionId, image.name);
    const mimeType = mimeOf(image.name);
    if (!file || !mimeType) continue;
    out.push({ name: image.name, mimeType, data: readFileSync(file).toString("base64") });
  }
  return out;
}

/** The names in an event's payload, from whatever was recorded. */
export function storedIn(payload: unknown): StoredImage[] {
  const images = (payload as { images?: unknown } | null)?.images;
  if (!Array.isArray(images)) return [];
  return images.filter(
    (i): i is StoredImage => typeof i?.name === "string" && NAME.test(i.name) && typeof i?.mimeType === "string",
  );
}

/** As pi takes them. */
export const forPi = (images: Attached[]): ImageContent[] => images.map(({ data, mimeType }) => ({ type: "image", data, mimeType }));

/** As the event log keeps them: without the bytes. */
export const forLog = (images: Attached[]): StoredImage[] => images.map(({ name, mimeType }) => ({ name, mimeType }));

/** Particular pictures, kept for a message that never made it into the conversation. */
export function dropImages(root: string, sessionId: string, images: StoredImage[]): void {
  for (const image of images) {
    const file = imagePath(root, sessionId, image.name);
    if (file) rmSync(file, { force: true });
  }
}

/** Everything kept for a chat, when the chat goes. */
export function removeImages(root: string, sessionId: string): void {
  rmSync(folderOf(root, sessionId), { recursive: true, force: true });
}
