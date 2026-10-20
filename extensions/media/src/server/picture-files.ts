import { closeSync, readSync } from "node:fs";
import type { FileOpenOptions } from "@pithagoras/extension-api/server";
import { FileError } from "./file-error";
import { portal } from "./host";

/**
 * What a picture is by its bytes, and how one is opened in a folder to be shown, read or sent: the rules the portal
 * has for the pictures of a chat, on `portal.files`, which says what a file is by its first bytes.
 *
 * Whatever is served back to be drawn inline must really be one of the four kinds a browser draws, PNG, JPEG, GIF or
 * WebP, by what its bytes say and not by its name, so that no page and no script is ever served under the portal's
 * origin from a file the agent wrote.
 */

/** Larger than this, a picture is not shown: it is a download like any other file. The limit the portal shows a picture of a chat up to. */
export const MAX_PICTURE_BYTES = 25 * 1024 * 1024;

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

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** What picture `head` is the start of, by its bytes alone, or undefined for anything else. Twelve bytes are enough. */
export const pictureType = (head: Buffer): string | undefined => KINDS.find((k) => k.is(head))?.mimeType;

/** The file extension a picture is kept under, by its first bytes as pictureType reads them. */
export const pictureExt = (head: Buffer): string | undefined => KINDS.find((k) => k.is(head))?.ext;

/**
 * Base64, or a data: URL holding it, decoded: what every picture that arrives as text goes through, so that they are
 * all held to the same rules. Line breaks and spaces in it are dropped, as wrapped base64 has them. The size is worked
 * out from the length before anything large is decoded: that cost is what the check is for.
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

/** A picture opened by openPicture: the descriptor, which the caller closes, its size, its name and its type. */
export type OpenedPicture = { fd: number; size: number; name: string; mimeType: string };

/**
 * A picture in the folder `base`, opened to be shown in the page, not saved: checked by its size and by its first
 * bytes, and never through a link out of the folder. With `likeParent` (and `chats`), for a picture an agent names,
 * one the agent could not read itself is refused. The descriptor is the caller's to close.
 */
export function openPicture(base: string, rel: string, options: FileOpenOptions = {}): OpenedPicture {
  const { fd, size, name, mimeType } = portal().files.open(base, rel, options);
  try {
    if (size > MAX_PICTURE_BYTES) throw new FileError("too_large", "The picture is over 25 MB; download it instead");
    if (!mimeType?.startsWith("image/")) throw new FileError("invalid", "That is not a PNG, JPEG, GIF or WebP picture");
    return { fd, size, name, mimeType };
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

/** A file opened by openPicture or openVideo, read whole and closed: from the descriptor, as `portal.files.readBytes` reads no more than 1 MB. */
export function readOpened(opened: { fd: number; size: number; name: string; mimeType: string }): { bytes: Buffer; mimeType: string; name: string } {
  try {
    const bytes = Buffer.alloc(opened.size);
    let read = 0;
    while (read < bytes.length) {
      const n = readSync(opened.fd, bytes, read, bytes.length - read, read);
      // Shorter than it was when it was measured.
      if (n === 0) break;
      read += n;
    }
    return { bytes: bytes.subarray(0, read), mimeType: opened.mimeType, name: opened.name };
  } finally {
    closeSync(opened.fd);
  }
}

/** A picture in the folder, read whole, for one that is sent on as it is, to an image endpoint to be changed: opened as openPicture opens it. */
export const readPicture = (base: string, rel: string, options: FileOpenOptions = {}): { bytes: Buffer; mimeType: string; name: string } =>
  readOpened(openPicture(base, rel, options));
