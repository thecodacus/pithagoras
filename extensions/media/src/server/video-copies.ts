import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { portal, stopSignal } from "./host";
import { MAX_VIDEO_BYTES, openClip } from "./video-files";
import { feed, posterAvailable, tool } from "./video-posters";
import { baseDir } from "./within";

/**
 * A playable copy of a clip a browser cannot play: a WebM that ffmpeg makes of an AVI, an animated WebP or
 * another file, when ffmpeg is there (the same one that makes the posters: see video-posters.ts). Optional, and
 * on request: nothing is converted until someone asks for it. The original is never touched or replaced; the copy
 * is kept in Media's own folder, named for the clip and for the size and time of the file it was made from, so
 * that a file that is written over is never given the copy of the one before.
 *
 * As with a poster, the clip is handed to ffmpeg on its standard input from the descriptor that was checked, and
 * ffmpeg may open nothing else (`-protocol_whitelist pipe`).
 *
 * What a clip declares of itself is not to be trusted: a few megabytes can declare frames of many gigabytes. So the
 * conversion is bounded whatever the clip says: ffmpeg is first asked how large its picture is, and a clip over
 * MAX_SIDE is refused before anything is converted; the copy is scaled down to fit COPY_SIDE (a smaller picture keeps its size); ffmpeg runs with one
 * thread to decode, two to encode and a short look-ahead, under a cap on its memory (where the platform has one) and on the
 * size of any one block it allocates; it stops at the size a clip may have, and at the time COPY_MS.
 */

/** How long ffmpeg may take to say how large a clip's picture is. */
const PROBE_MS = 20_000;
/** How long a conversion may take. */
const COPY_MS = 3 * 60_000;
/** The largest picture, on either side, that a copy is made of. */
const MAX_SIDE = 4096;
/** A copy is scaled down to fit this on either side (never up), which is what bounds what the encoder holds for each frame. */
const COPY_SIDE = 1280;
/** The address space ffmpeg may take, in kilobytes: a clip that asks for more fails in ffmpeg, not in the machine. */
const MEMORY_KB = 4 * 1024 * 1024;
/** The largest single block ffmpeg may allocate, in bytes: one frame of the largest picture a copy is made of is far under it. */
const MAX_BLOCK = 512 * 1024 * 1024;

/** Where the copies are kept, one for each clip. */
export const copiesDir = (): string => path.join(portal().dataDir(), "video-copies");

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

/**
 * What is run: ffmpeg, under a cap on its address space where a shell can set one (not on Windows, and not where the
 * shell cannot: the call is then made without it), and always with the cap on one block of its allocations.
 */
function command(args: string[]): [string, string[]] {
  const all = ["-max_alloc", String(MAX_BLOCK), ...args];
  if (process.platform === "win32") return [tool(), all];
  return ["/bin/sh", ["-c", `ulimit -v ${MEMORY_KB} 2>/dev/null; exec "$0" "$@"`, tool(), ...all]];
}

/** The clip comes in on the standard input, decoded by one thread. */
const FROM_PIPE = ["-protocol_whitelist", "pipe", "-threads", "1", "-i", "pipe:0"];

/** Runs ffmpeg over the open clip with these arguments, and tells how it ended and what it said (the first `keep` characters of it). It is killed when `stopped` is aborted. */
function run(args: string[], fd: number, size: number, ms: number, keep: number, stopped: AbortSignal): Promise<{ code: number | null; signal: NodeJS.Signals | null; said: string }> {
  return new Promise((resolve, reject) => {
    const [file, argv] = command(args);
    const child = spawn(file, argv, { stdio: ["pipe", "ignore", "pipe"] });
    let said = "";
    // Killed as the time is up, and so when Media stops: either way it is answered for once it has gone, and what it
    // wrote is let go of by then (Windows removes no file a process still has open).
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(kill, ms);
    stopped.addEventListener("abort", kill);
    if (stopped.aborted) kill();
    const done = () => {
      clearTimeout(timer);
      stopped.removeEventListener("abort", kill);
    };
    child.stdin.on("error", () => {});
    feed(fd, size, child.stdin).catch(kill);
    child.stderr.on("data", (chunk: Buffer) => {
      if (said.length < keep) said += chunk.toString("utf8");
    });
    child.on("error", (e) => {
      done();
      reject(e);
    });
    child.on("close", (code, signal) => {
      done();
      resolve({ code, signal, said });
    });
  });
}

/** The largest picture of a video stream in what ffmpeg says when it opens a clip (`Stream #0:0: Video: …, 1280x720, …`); nothing when it names none. */
function pictureIn(said: string): { width: number; height: number } | undefined {
  let largest: { width: number; height: number } | undefined;
  for (const line of said.split("\n")) {
    if (!/Stream #\d+:\d+.*: Video: /.test(line)) continue;
    const found = /(?<=[ ,])(\d{2,6})x(\d{2,6})(?=[ ,[]|$)/.exec(line);
    if (!found) continue;
    const picture = { width: Number(found[1]), height: Number(found[2]) };
    if (!largest || picture.width * picture.height > largest.width * largest.height) largest = picture;
  }
  return largest;
}

/** Runs ffmpeg over the open clip, to the file `to`, until `stopped` is aborted. */
async function convert(fd: number, size: number, to: string, stopped: AbortSignal): Promise<void> {
  // Asked first how large the picture is, as ffmpeg reads it: before anything is converted a clip that declares more than a copy is made of is refused.
  const looked = await run(["-hide_banner", "-v", "info", ...FROM_PIPE], fd, size, PROBE_MS, 64 * 1024, stopped);
  const picture = pictureIn(looked.said);
  if (!picture) {
    // What ffmpeg says last of a look with nothing to make is that there is nothing to make: its word before that is the clip's.
    const why = looked.said.split("\n").filter((line) => line.trim() && !line.startsWith("At least one output file")).pop();
    throw new Error(why?.trim() || (looked.signal ? `ffmpeg ended with ${looked.signal}` : "ffmpeg found no picture in it"));
  }
  if (picture.width > MAX_SIDE || picture.height > MAX_SIDE) throw new Error(`the picture is ${picture.width} by ${picture.height}, and a copy is made of one up to ${MAX_SIDE} by ${MAX_SIDE}`);
  // A box of COPY_SIDE that is no larger than the picture, so that a small picture keeps its size: `decrease` alone would fill the box.
  const fit = `scale=w='min(${COPY_SIDE},iw)':h='min(${COPY_SIDE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p`;
  // Video only, in VP9, at a quality that is a copy to look at, not an archive. The output stops at one byte over the size a clip may have, which is then refused.
  const done = await run(["-v", "error", ...FROM_PIPE, "-an", "-vf", fit, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "34", "-row-mt", "1", "-threads", "2", "-lag-in-frames", "5", "-fs", String(MAX_VIDEO_BYTES + 1), "-f", "webm", "-y", to], fd, size, COPY_MS, 2000, stopped);
  if (done.code !== 0) throw new Error(done.said.trim().split("\n").pop() || `ffmpeg ended with ${done.code ?? done.signal}`);
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
      const stopped = stopSignal();
      const run = async (): Promise<boolean> => {
        // Media stopped while it waited its turn: not made.
        if (stopped.aborted) return false;
        mkdirSync(copiesDir(), { recursive: true });
        const tmp = path.join(copiesDir(), `${name}.part`);
        try {
          await convert(whole.fd, whole.size, tmp, stopped);
          const now = fstatSync(whole.fd);
          // The clip may have been written over, or deleted, while it was converted: that copy is of nothing that is there.
          if (now.size !== whole.size || now.mtimeMs !== modifiedMs || !listed()) return false;
          // Opened as a clip is, which refuses one over the size a clip may have: a conversion that was stopped at the limit is no copy.
          const made = openClip(baseDir(copiesDir()), `${name}.part`);
          closeSync(made.fd);
          if (!made.format.playable) return false;
          for (const old of readdirSync(copiesDir())) if (old !== name && old !== `${name}.part` && old.startsWith(`${id}-`)) rmSync(path.join(copiesDir(), old), { force: true });
          renameSync(tmp, path.join(copiesDir(), name));
          return true;
        } catch (e) {
          // Media stopped meanwhile, which killed ffmpeg: no failure of the clip's.
          if (!stopped.aborted) portal().log(`videos: playable copy failed: ${(e as Error).message}`);
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
