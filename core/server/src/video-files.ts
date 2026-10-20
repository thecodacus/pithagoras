import { closeSync, readSync } from "node:fs";
import { type AgentUse, FileError, openFile, readOpened } from "./workspace-files.js";

/**
 * What a clip is, by its first bytes, and how one is opened to be shown.
 *
 * The same rule a picture is held to (see openPicture): whatever is served back
 * to be played inline must really be one of the kinds a browser plays — WebM and
 * MP4 — by what its bytes say and not by its name, so that no page and no script
 * is ever served under this portal's origin from a file the agent wrote.
 *
 * That is a rule about what is played, not about what a call may give: a file its
 * bytes say is another kind (see sniffVideo) is a file to download, never one played inline.
 */

/** The most a clip may weigh to be played in the page, or read whole into memory to be sent on to a channel. */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

/** A clip's kind, as far as its bytes say; `bin` for a file they say nothing of. */
export type VideoExt = "webm" | "mp4" | "mov" | "avi" | "webp" | "gif" | "mkv" | "ogg" | "bin";

/** What a file is: the kind, what it is called to a person, the type it is served as, and whether a browser plays it here. */
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
 * What a clip is by its first bytes, or nothing when a browser does not play it here: only a WebM and an MP4
 * are (see sniffVideo). What shows a clip in the page or in the chat goes by this.
 */
export function videoType(head: Buffer): { ext: VideoExt; mimeType: string } | undefined {
  const format = sniffVideo(head);
  return format.playable ? { ext: format.id, mimeType: format.mimeType } : undefined;
}

/**
 * A clip in the folder, opened to be played in the page, not saved. Checked by its bytes and its size, and never
 * through a link out of the folder (see openDownload); with `likeParent`, for a clip an agent names, one the agent
 * could not read itself is refused (see AgentUse). The descriptor is the caller's to close.
 */
export function openVideo(base: string, rel: unknown, options: AgentUse = {}): { fd: number; size: number; name: string; mimeType: string } {
  const { fd, size, name } = openFile(base, rel, options);
  const opened = { fd, size, name };
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

/** A clip in the folder, read whole, for a channel to send on: opened as one that is played is, `options` as for openVideo. */
export const readVideo = (base: string, rel: unknown, options: AgentUse = {}): { bytes: Buffer; mimeType: string; name: string } =>
  readOpened(openVideo(base, rel, options));
