import { closeSync, readSync } from "node:fs";
import path from "node:path";
import type { FileOpenOptions } from "@pithagoras/extension-api/server";
import { FileError } from "./file-error";
import { portal } from "./host";

/**
 * What a clip is, by its first bytes, and how one is opened to be shown: the rules the portal has for the clips of
 * a chat, as Media needs them, on `portal.files`.
 *
 * The same rule a picture is held to (see openPicture): whatever is served back to be played inline must really be one
 * of the kinds a browser plays — WebM and MP4 — by what its bytes say and not by its name, so that no page and no script
 * is ever served under the portal's origin from a file the agent wrote.
 *
 * That is a rule about what is played, not about what is kept: whatever an endpoint finishes a clip as is stored and
 * listed, with the kind its bytes say it is (see sniffVideo), and a kind a browser does not play is served to be
 * downloaded, never inline. `portal.files.open` tells only the kinds a browser plays, so the rest is told here.
 */

/** The most a clip may weigh, whether Media takes it from an endpoint or lists and serves it. It is read whole into memory when an endpoint answers with it as base64, which is what the limit is for. */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

/** What a stored clip's file is named with: its kind, as far as its bytes say; `bin` for a file they say nothing of. */
export type VideoExt = "webm" | "mp4" | "mov" | "avi" | "webp" | "gif" | "mkv" | "ogg" | "bin";

/** What a file is, as the page is told: the kind, what it is called to a person, the type it is served as, and whether a browser plays it here. */
export interface VideoFormat {
  id: VideoExt;
  label: string;
  mimeType: string;
  playable: boolean;
}

const FORMATS: Record<Exclude<VideoExt, "mkv">, VideoFormat> = {
  webm: { id: "webm", label: "WebM", mimeType: "video/webm", playable: true },
  mp4: { id: "mp4", label: "MP4", mimeType: "video/mp4", playable: true },
  mov: { id: "mov", label: "QuickTime", mimeType: "video/quicktime", playable: false },
  avi: { id: "avi", label: "AVI", mimeType: "video/x-msvideo", playable: false },
  webp: { id: "webp", label: "WebP", mimeType: "image/webp", playable: false },
  gif: { id: "gif", label: "GIF", mimeType: "image/gif", playable: false },
  ogg: { id: "ogg", label: "Ogg", mimeType: "video/ogg", playable: false },
  bin: { id: "bin", label: "Unknown", mimeType: "application/octet-stream", playable: false },
};

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

/** A document type, as a person is shown it: printable characters and short. */
const shownDocType = (doc: string): string => doc.replace(/[^\x20-\x7e]/g, "?").slice(0, 24);

/** An EBML file that is none of the WebM kinds, shown with the document type it names. */
const ebmlFormat = (doc?: string): VideoFormat => ({ id: "mkv", label: doc ? `EBML (${shownDocType(doc)})` : "EBML", mimeType: "video/x-matroska", playable: false });

/**
 * What a file is by its first bytes, whatever it is called or says it is: a WebM is an EBML file whose document type,
 * read from its header, is `webm` or `matroska` (what stable-diffusion.cpp writes for the clips it makes); an MP4
 * has a `ftyp` box. Those two are what a browser plays here. Every other file is some other kind, or none:
 * an EBML file of another document type, a QuickTime movie (which has the box too), an AVI, a WebP or a GIF, an
 * Ogg file, and the rest, which is unknown and is served as bytes.
 */
export function sniffVideo(head: Buffer): VideoFormat {
  const doc = ebmlDocType(head);
  if (doc !== undefined && WEBM_DOC_TYPES.includes(doc)) return FORMATS.webm;
  if (head.length >= 4 && head.readUInt32BE(0) === EBML) return ebmlFormat(doc);
  if (head.length >= 12 && head.toString("latin1", 4, 8) === "ftyp") return head.toString("latin1", 8, 12) === "qt  " ? FORMATS.mov : FORMATS.mp4;
  if (head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF") {
    const kind = head.toString("latin1", 8, 12);
    if (kind === "AVI ") return FORMATS.avi;
    if (kind === "WEBP") return FORMATS.webp;
  }
  if (head.length >= 4 && head.toString("latin1", 0, 4) === "GIF8") return FORMATS.gif;
  if (head.length >= 4 && head.toString("latin1", 0, 4) === "OggS") return FORMATS.ogg;
  return FORMATS.bin;
}

/**
 * What a file is called for, by its extension, which is how the tool names what it saves (see VideoExt): the best that is
 * known of a clip whose bytes cannot be read. Only ever shown, never served by: whatever is sent is sent for what its
 * bytes say. A name that says nothing is taken for a WebM, as the clips of the list were before their bytes were looked at.
 */
export function formatByName(name: string): VideoFormat {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (ext === "mkv") return ebmlFormat();
  return Object.hasOwn(FORMATS, ext) ? FORMATS[ext as keyof typeof FORMATS] : FORMATS.webm;
}

/**
 * A clip in the folder, opened to be played in the page, not saved. Checked by its bytes and its size, and never
 * through a link out of the folder; with `likeParent`, for a clip an agent names, one the agent could not read itself
 * is refused. The descriptor is the caller's to close.
 */
export function openVideo(base: string, rel: string, options: FileOpenOptions = {}): { fd: number; size: number; name: string; mimeType: string } {
  const { fd, size, name, mimeType } = portal().files.open(base, rel, options);
  try {
    if (size > MAX_VIDEO_BYTES) throw new FileError("too_large", `The video is over ${MAX_VIDEO_BYTES / 1024 / 1024} MB; download it instead`);
    if (!mimeType?.startsWith("video/")) throw new FileError("invalid", "That is not a WebM or MP4 video");
    return { fd, size, name, mimeType };
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

/** What the open file is, by its first bytes. */
function formatAt(fd: number): VideoFormat {
  const head = Buffer.alloc(VIDEO_HEAD);
  const read = readSync(fd, head, 0, head.length, 0);
  return sniffVideo(head.subarray(0, read));
}

/**
 * What a file of any size is by its first bytes: for the list, which tells what a clip is that is over the size a clip
 * may have (see openClip) and so is neither played nor sent. A link out of the folder is not followed here either.
 */
export function formatOf(base: string, rel: string): VideoFormat {
  const { fd } = portal().files.open(base, rel);
  try {
    return formatAt(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * A file of the gallery's, opened to be listed or sent, whatever it is: checked by its size and never through a link out of
 * the folder, and told what it is by its first bytes (see sniffVideo), which says whether it may be played inline or only
 * downloaded. The descriptor is the caller's to close.
 */
export function openClip(base: string, rel: string): { fd: number; size: number; name: string; mimeType: string; format: VideoFormat } {
  const { fd, size, name } = portal().files.open(base, rel);
  try {
    if (size > MAX_VIDEO_BYTES) throw new FileError("too_large", `The video is over ${MAX_VIDEO_BYTES / 1024 / 1024} MB; download it instead`);
    const format = formatAt(fd);
    return { fd, size, name, mimeType: format.mimeType, format };
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}
