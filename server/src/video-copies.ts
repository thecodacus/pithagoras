import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./data-dir.js";
import { MAX_VIDEO_BYTES, openClip } from "./video-files.js";
import { feed, posterAvailable, tool } from "./video-posters.js";
import { baseDir } from "./workspace-files.js";

/**
 * A playable copy of a clip a browser cannot play: a WebM that ffmpeg makes of an AVI, an animated WebP or
 * another file, when ffmpeg is there (the same one that makes the posters: see video-posters.ts). Optional, and
 * on request: nothing is converted until someone asks for it. The original is never touched or replaced; the copy
 * is kept beside the gallery, named for the clip and for the size and time of the file it was made from, so
 * that a file that is written over is never given the copy of the one before.
 *
 * As with a poster, the clip is handed to ffmpeg on its standard input from the descriptor that was checked, and
 * ffmpeg may open nothing else (`-protocol_whitelist pipe`).
 */

/** How long a conversion may take. */
const COPY_MS = 10 * 60_000;

/** Where the copies are kept, one for each clip. */
export const copiesDir = (): string => path.join(path.resolve(DATA_DIR), "video-copies");

/** The copy of this very file: the clip's id, and the size and time of the file it was made from. */
export const copyName = (id: string, size: number, modifiedMs: number): string => `${id}-${size.toString(16)}-${Math.floor(modifiedMs).toString(16)}.webm`;

/** What the page is told of a clip's copy: there is one, or ffmpeg is there to make one; nothing for a clip that plays as it is. */
export function copyState(id: string, size: number, modifiedMs: number, playable: boolean): "ready" | "available" | undefined {
  if (playable) return undefined;
  if (existsSync(path.join(copiesDir(), copyName(id, size, modifiedMs)))) return "ready";
  return posterAvailable() ? "available" : undefined;
}

/** The copies of these clips are gone with them, wherever the clips' rows are deleted. */
export function removeCopies(ids: string[]): void {
  if (!ids.length) return;
  const gone = new Set(ids);
  let names: string[];
  try {
    names = readdirSync(copiesDir());
  } catch {
    return;
  }
  for (const name of names) if (gone.has(name.split("-")[0])) rmSync(path.join(copiesDir(), name), { force: true });
}

/** Made one at a time: a conversion takes a core for as long as the clip is long. */
let busy: Promise<unknown> = Promise.resolve();
/** Asked for twice at once: made once. */
const making = new Map<string, Promise<boolean>>();

type Opened = { fd: number; size: number; name: string; mimeType: string };

/** Runs ffmpeg over the open clip, to the file `to`. */
function convert(fd: number, size: number, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Video only, in VP9, at a quality that is a copy to look at, not an archive.
    const child = spawn(tool(), ["-v", "error", "-protocol_whitelist", "pipe", "-i", "pipe:0", "-an", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "34", "-row-mt", "1", "-f", "webm", "-y", to], { stdio: ["pipe", "ignore", "pipe"] });
    let errors = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), COPY_MS);
    child.stdin.on("error", () => {});
    feed(fd, size, child.stdin).catch(() => child.kill("SIGKILL"));
    child.stderr.on("data", (chunk: Buffer) => {
      if (errors.length < 2000) errors += chunk.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(errors.trim().split("\n").pop() || `ffmpeg ended with ${code ?? signal}`));
    });
  });
}

/**
 * The copy of the clip whose file is open (the caller has checked that the person may read it), opened to be sent as a
 * WebM; made first, when there is none for this version of the file, if `make` says so. Nothing when there is none and
 * none is made, or when ffmpeg is not there or cannot make one of this clip. The descriptor of the clip is closed.
 * `listed` says whether the clip is still in the gallery, which is asked again when a copy is done.
 */
export async function openCopy(whole: Opened, id: string, listed: () => boolean, make: boolean): Promise<Opened | undefined> {
  try {
    const modifiedMs = fstatSync(whole.fd).mtimeMs;
    const name = copyName(id, whole.size, modifiedMs);
    const open = (): Opened | undefined => {
      try {
        const opened = openClip(baseDir(copiesDir()), name);
        if (opened.format.playable) return opened;
        closeSync(opened.fd);
      } catch {
        // None yet, or none that can be sent.
      }
      return undefined;
    };
    const kept = open();
    if (kept || !make || !posterAvailable()) return kept;
    let job = making.get(name);
    if (!job) {
      const run = async (): Promise<boolean> => {
        mkdirSync(copiesDir(), { recursive: true });
        const tmp = path.join(copiesDir(), `${name}.part`);
        try {
          await convert(whole.fd, whole.size, tmp);
          const now = fstatSync(whole.fd);
          // The clip may have been written over, or deleted, while it was converted: that copy is of nothing that is there.
          if (now.size !== whole.size || now.mtimeMs !== modifiedMs || !listed()) return false;
          const made = openClip(baseDir(copiesDir()), `${name}.part`);
          closeSync(made.fd);
          if (!made.format.playable || made.size > MAX_VIDEO_BYTES) return false;
          for (const old of readdirSync(copiesDir())) if (old !== name && old !== `${name}.part` && old.startsWith(`${id}-`)) rmSync(path.join(copiesDir(), old), { force: true });
          renameSync(tmp, path.join(copiesDir(), name));
          return true;
        } catch (e) {
          console.error("[portal] videos: playable copy failed:", (e as Error).message);
          return false;
        } finally {
          rmSync(tmp, { force: true });
        }
      };
      job = (busy = busy.then(run, run) as Promise<boolean>).finally(() => making.delete(name));
      making.set(name, job);
    }
    return (await job) ? open() : undefined;
  } finally {
    closeSync(whole.fd);
  }
}
