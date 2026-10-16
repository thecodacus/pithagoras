import { closeSync } from "node:fs";
import path from "node:path";
import { FILES_KEY, fileOutputs, type FileKind, type ShownFile } from "./file-outputs.js";
import { openVideo } from "./video-files.js";
import { pathBelow } from "./within.js";
import { baseDir, openDownload, openPicture } from "./workspace-files.js";

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
 * What a file in the folder is, as the portal serves it: a picture when the picture route would draw it, a clip when
 * the video route would play it, and a file to download when it is a plain file in the folder at all. Nothing for
 * one that is not there, is a folder, or leads out of the folder through a link.
 */
function kindOf(base: string, rel: string): FileKind | undefined {
  const tries: [FileKind, (base: string, rel: string) => { fd: number }][] = [["picture", openPicture], ["video", openVideo], ["file", openDownload]];
  for (const [kind, open] of tries) {
    try {
      closeSync(open(base, rel).fd);
      return kind;
    } catch {
      // Not this kind: the next is looked at.
    }
  }
  return undefined;
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
