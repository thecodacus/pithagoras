import { closeSync, readSync } from "node:fs";
import path from "node:path";
import { FILES_KEY, fileOutputs, type FileKind, type ShownFile } from "./file-outputs.js";
import { pictureType } from "./prompt-images.js";
import { MAX_VIDEO_BYTES, VIDEO_HEAD, videoType } from "./video-files.js";
import { pathBelow } from "./within.js";
import { MAX_PICTURE_BYTES, baseDir, openDownload } from "./workspace-files.js";

/**
 * What the files a call gave are, by their bytes: see file-outputs.ts. Looked
 * at once, when the call ends, and kept on the end of the call, so the page,
 * voice mode, a channel and the extensions' server halves all go by the same.
 */

/**
 * Where `given` is in the chat's folder `folder`, relative to it: a path the agent gives is relative to it or
 * absolute, and an absolute one may reach the folder through a link, as the folder is named to it. Nothing for a
 * path outside it, or the folder itself.
 */
export function inFolder(folder: string, base: string, given: string): string | undefined {
  return pathBelow(base, path.resolve(base, given)) || pathBelow(path.resolve(folder), path.resolve(folder, given)) || undefined;
}

/**
 * What a file in the folder is, as the portal serves it, from one look at its first bytes: a picture when the picture
 * route would draw it (see openPicture), a clip when the video route would play it (see openVideo), and a file to
 * download when it is a plain file in the folder at all. Nothing for one that is not there, is a folder, or leads out
 * of the folder through a link.
 */
function kindOf(base: string, rel: string): FileKind | undefined {
  let opened: { fd: number; size: number };
  try {
    opened = openDownload(base, rel);
  } catch {
    return undefined;
  }
  try {
    const type = mediaTypeAt(opened.fd);
    if (opened.size <= MAX_PICTURE_BYTES && type?.startsWith("image/")) return "picture";
    if (opened.size <= MAX_VIDEO_BYTES && type?.startsWith("video/")) return "video";
    return "file";
  } finally {
    closeSync(opened.fd);
  }
}

/**
 * What an open file is by its first bytes, where it is a picture (PNG, JPEG, GIF, WebP) or a clip a browser plays
 * (WebM, MP4): its type. Nothing for any other file, whatever it is called.
 */
export function mediaTypeAt(fd: number): string | undefined {
  const head = Buffer.alloc(VIDEO_HEAD);
  const bytes = head.subarray(0, readSync(fd, head, 0, head.length, 0));
  return pictureType(bytes) ?? videoType(bytes)?.mimeType;
}

/** The files a call's answer names, as they are in the chat's folder `folder` now. */
export function filesFound(folder: string, details: unknown): ShownFile[] {
  const outputs = fileOutputs(details);
  if (!outputs.length) return [];
  let base: string;
  try {
    base = baseDir(folder);
  } catch {
    return [];
  }
  return outputs.flatMap(({ path: given, title, from }): ShownFile[] => {
    const rel = inFolder(folder, base, given);
    const kind = rel && kindOf(base, rel);
    if (!rel || !kind) return [];
    const origins = from?.map((p) => inFolder(folder, base, p)).filter((p): p is string => !!p);
    return [{ path: rel, kind, ...(title ? { title } : {}), ...(origins?.length ? { from: origins } : {}) }];
  });
}

/**
 * The end of a call as it is kept and passed on: with what its files are (FILES_KEY), when it succeeded and its
 * answer names files in the folder. Any other event is as it was.
 */
export function withFiles(event: any, folder: string): any {
  if (event?.type !== "tool_execution_end" || event.isError) return event;
  const files = filesFound(folder, event.result?.details);
  return files.length ? { ...event, [FILES_KEY]: files } : event;
}
