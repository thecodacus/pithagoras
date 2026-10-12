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

/**
 * What a clip is by its first bytes, or nothing when it is no WebM or MP4: a WebM begins with an EBML header
 * whose document type says `webm`, an MP4 with a `ftyp` box. A QuickTime movie, which has the box too, is
 * left out, as a browser does not play it where it plays an MP4.
 */
export function videoType(head: Buffer): { ext: VideoExt; mimeType: string } | undefined {
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3 && head.includes("webm", 4, "latin1")) return { ext: "webm", mimeType: MIME.webm };
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
