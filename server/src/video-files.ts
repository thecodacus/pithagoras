import { closeSync, readSync } from "node:fs";
import { FileError, openDownload } from "./workspace-files.js";

/**
 * What a clip is, by its first bytes, and how one is opened to be shown.
 *
 * The same rule a picture is held to (see openPicture): whatever is served back
 * to be played inline must really be one of the kinds a browser plays — WebM and
 * MP4 — by what its bytes say and not by its name, so that no page and no script
 * is ever served under this portal's origin from a file the agent wrote.
 */

/** The most a clip may weigh, whether the portal takes it from an endpoint or lists and serves it. It is read whole into memory when an endpoint answers with it as base64, which is what the limit is for. */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

export type VideoExt = "webm" | "mp4";

const MIME: Record<VideoExt, string> = { webm: "video/webm", mp4: "video/mp4" };

/** The first bytes a check of the kind reads. */
export const VIDEO_HEAD = 64;

/** The element ids of the EBML header that matter here: the header itself, and its document type. */
const EBML = 0x1a45dfa3;
const DOC_TYPE = 0x4282;
/** The document types of a file a browser plays as a WebM: the one the format names, and the one stable-diffusion.cpp writes (its WebM is a Matroska file with the WebM codecs, and says so). */
const WEBM_DOC_TYPES = ["webm", "matroska"];

/** A number of EBML at `at`: how many bytes it takes and, as an id keeps its marker bit and a size does not, its value. Nothing where it does not fit in `buf` or is no number (a first byte of zero; a size of all ones is "unknown"). */
function ebmlNumber(buf: Buffer, at: number, isId: boolean): { length: number; value: number } | undefined {
  const first = buf[at];
  if (!first) return undefined;
  const length = Math.clz32(first) - 23;
  if (length > (isId ? 4 : 8) || at + length > buf.length) return undefined;
  const bits = first & (0xff >> length);
  let value = isId ? first : bits;
  let ones = bits === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const byte = buf[at + i];
    value = value * 256 + byte;
    ones = ones && byte === 0xff;
  }
  // A size whose bits are all ones is "unknown", which is not a length that can be walked.
  if (!isId && ones) return undefined;
  return { length, value };
}

/**
 * The document type an EBML file says it is, read from its header as the format has it — an element with the id
 * 0x4282 among the children of the header — and not found by looking for a word in the first bytes: a word of
 * another element, or a type that only begins with it, is not the type. Nothing for a file that does not begin with
 * the EBML id, whose header is cut off before the type, or whose elements do not add up.
 */
export function ebmlDocType(head: Buffer): string | undefined {
  const id = ebmlNumber(head, 0, true);
  if (!id || id.value !== EBML) return undefined;
  const size = ebmlNumber(head, id.length, false);
  if (!size) return undefined;
  let at = id.length + size.length;
  const end = Math.min(head.length, at + size.value);
  while (at < end) {
    const child = ebmlNumber(head, at, true);
    const length = child && ebmlNumber(head, at + child.length, false);
    if (!child || !length) return undefined;
    at += child.length + length.length;
    if (at + length.value > end) return undefined;
    if (child.value === DOC_TYPE) return length.value <= 32 ? head.toString("latin1", at, at + length.value) : undefined;
    at += length.value;
  }
  return undefined;
}

/**
 * What a clip is by its first bytes, or nothing when it is no WebM or MP4: a WebM begins with an EBML header whose
 * document type is `webm` or `matroska` (what stable-diffusion.cpp writes for the clips it makes), an MP4 with a
 * `ftyp` box. An EBML file of another document type is left out, and so is a QuickTime movie, which has the box
 * too, as a browser does not play it where it plays an MP4.
 */
export function videoType(head: Buffer): { ext: VideoExt; mimeType: string } | undefined {
  const doc = ebmlDocType(head);
  if (doc !== undefined && WEBM_DOC_TYPES.includes(doc)) return { ext: "webm", mimeType: MIME.webm };
  if (head.length >= 12 && head.toString("latin1", 4, 8) === "ftyp" && head.toString("latin1", 8, 12) !== "qt  ") return { ext: "mp4", mimeType: MIME.mp4 };
  return undefined;
}

/**
 * A clip in the folder, opened to be played in the page, not saved. Checked by its bytes and its size, and never
 * through a link out of the folder (see openDownload). The descriptor is the caller's to close.
 */
export function openVideo(base: string, rel: unknown): { fd: number; size: number; name: string; mimeType: string } {
  const opened = openDownload(base, rel);
  try {
    if (opened.size > MAX_VIDEO_BYTES) throw new FileError("too_large", `The video is over ${MAX_VIDEO_BYTES / 1024 / 1024} MB; download it instead`);
    const head = Buffer.alloc(VIDEO_HEAD);
    const read = readSync(opened.fd, head, 0, head.length, 0);
    const type = videoType(head.subarray(0, read));
    if (!type) throw new FileError("invalid", "That is not a WebM or MP4 video");
    return { ...opened, mimeType: type.mimeType };
  } catch (e) {
    closeSync(opened.fd);
    throw e;
  }
}
