import { spawn, spawnSync } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, read, readdirSync, rmSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { portal, stopSignal } from "./host";
import { keepCopy } from "./image-thumbs";
import { openPicture } from "./picture-files";
import { baseDir } from "./within";

/**
 * The poster pictures of the gallery's clips, which the tiles show until a clip is played: its first frame, small.
 * Media makes them itself, the first time one is asked for, and keeps them in its own folder, as the small
 * copies of pictures are (see image-thumbs.ts).
 *
 * A frame is taken out of a clip by ffmpeg, which has to be there: on the PATH, or where FFMPEG_PATH says. Without
 * it there are no posters, and nothing else changes: the page shows the first frame of a clip as the browser
 * decodes it, which costs a request for the start of each clip. The clip is handed to ffmpeg on its standard
 * input, from the descriptor that was checked, so that what is read is the file that was opened and never one a
 * link was put in the place of; and ffmpeg may open nothing else (`-protocol_whitelist pipe`), so that a clip that
 * names other files cannot make it read them.
 */

/** The longest side of a poster, in pixels: a tile is shown up to about 300 across, and a screen may have twice the pixels. */
export const POSTER_SIDE = 480;
/** How many posters are made at the same time. A folder of clips asks for a screenful at once, and decoding a frame takes memory and a core. */
export const POSTER_JOBS = 2;
/** How long a frame may take to come out of ffmpeg. */
const FRAME_MS = 30_000;
/** What is read of the frame it writes, as a PNG: a frame of 4096 by 4096 is under this. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

type Opened = { fd: number; size: number; name: string; mimeType: string };

/** Where the posters are kept, one for each clip. */
export const postersDir = (): string => path.join(portal().dataDir(), "video-posters");

/** What is run to take a frame out of a clip. */
export const tool = (): string => process.env.FFMPEG_PATH?.trim() || "ffmpeg";

/** Whether ffmpeg runs, asked now and then and not for every clip: a tool that is installed while the portal runs is found within a minute. */
let probed: { at: number; tool: string; ok: boolean } | undefined;
const PROBE_MS = 60_000;
export function posterAvailable(): boolean {
  const now = Date.now();
  const which = tool();
  if (probed && probed.tool === which && now - probed.at < PROBE_MS) return probed.ok;
  const ran = spawnSync(which, ["-version"], { timeout: 5000, stdio: "ignore" });
  probed = { at: now, tool: which, ok: ran.status === 0 };
  return probed.ok;
}
/** For a test that puts ffmpeg in place, or takes it away: it is asked about again, and what it could not make is tried again. */
export const forgetPosterProbe = (): void => {
  probed = undefined;
  failed.clear();
};

/** The poster of this very file: its name has the clip's id, and the size and time of the file it was made from, so a file that was written over is never given the poster of the one before. */
const copyName = (id: string, size: number, modifiedMs: number): string => `${id}-${size.toString(16)}-${Math.floor(modifiedMs).toString(16)}.webp`;

/** The posters of these clips are gone with them, wherever the clips' rows are deleted. */
export function removePosters(ids: string[]): void {
  if (!ids.length) return;
  const gone = new Set(ids);
  let names: string[];
  try {
    names = readdirSync(postersDir());
  } catch {
    return;
  }
  for (const name of names) if (gone.has(name.split("-")[0])) rmSync(path.join(postersDir(), name), { force: true });
}

/** Runs at most `POSTER_JOBS` at once, the others wait their turn. */
let running = 0;
/** The most that have run at once, for the test that says the limit holds. */
let peak = 0;
export const posterJobsPeak = (): number => peak;
const waiting: (() => void)[] = [];
async function turn<T>(job: () => Promise<T>): Promise<T> {
  if (running >= POSTER_JOBS) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  peak = Math.max(peak, running);
  try {
    return await job();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/**
 * The posters that ffmpeg could not make, by their name (the clip's id, and the size and time of the file): a clip it
 * cannot read from a pipe — an MP4 with its index at the end — is not tried again for every tile that asks, which would stream
 * the whole file through ffmpeg each time. Only a failure that is the clip's is kept (see NoFrame): ffmpeg that is gone for a
 * moment, a frame that took too long on a loaded machine, a disk that is full or a picture that could not be made are tried
 * again by the next request. A file that is written over has another name and is tried once more. Kept to no more than this,
 * and started again beyond it; a restart tries them again.
 */
const failed = new Set<string>();

/** ffmpeg ran to its end and made no frame of this clip: what is remembered of a failure, and nothing else is. */
class NoFrame extends Error {}
const MAX_FAILED = 10_000;

/** Asked for twice at once (two tiles of one clip): made once. */
const making = new Map<string, Promise<boolean>>();

const readAt = promisify(read);

/**
 * The open file, from its start, into ffmpeg's standard input. Read through the descriptor, a piece at a time, and
 * not given to a stream that would close it: the descriptor is the caller's. It stops when ffmpeg does, which
 * does not read the rest once it has its frame.
 */
export async function feed(fd: number, size: number, into: NodeJS.WritableStream & { destroyed?: boolean }): Promise<void> {
  const chunk = Buffer.alloc(64 * 1024);
  for (let at = 0; at < size && !into.destroyed; ) {
    // A file that cannot be read is the clip's failure, and ends the call.
    const { bytesRead } = await readAt(fd, chunk, 0, Math.min(chunk.length, size - at), at);
    if (bytesRead === 0) break;
    at += bytesRead;
    try {
      // A copy: the buffer is read into again before a write that waits has been made.
      if (!into.write(Buffer.from(chunk.subarray(0, bytesRead)))) await Promise.race([once(into, "drain"), once(into, "close")]);
    } catch {
      // ffmpeg has what it needs and has gone: what it answers with is what counts, not what is left unwritten.
      return;
    }
  }
  into.end();
}

/** The first frame of the open clip, as a PNG, from ffmpeg, which is killed when `stopped` is aborted. */
function firstFrame(fd: number, size: number, stopped: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool(), ["-v", "error", "-protocol_whitelist", "pipe", "-i", "pipe:0", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let total = 0;
    let errors = "";
    // Killed as the time is up, and so when Media stops: either way it is answered for once it has gone.
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(kill, FRAME_MS);
    stopped.addEventListener("abort", kill);
    if (stopped.aborted) kill();
    const done = () => {
      clearTimeout(timer);
      stopped.removeEventListener("abort", kill);
    };
    // ffmpeg stops reading once it has its frame: what it leaves unread is not an error.
    child.stdin.on("error", () => {});
    feed(fd, size, child.stdin).catch(kill);
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_FRAME_BYTES) kill();
      else out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errors.length < 2000) errors += chunk.toString("utf8");
    });
    child.on("error", (e) => {
      done();
      reject(e);
    });
    child.on("close", (code, signal) => {
      done();
      if (code === 0 && total > 0 && total <= MAX_FRAME_BYTES) return resolve(Buffer.concat(out));
      const why = errors.trim().split("\n").pop() || `ffmpeg ended with ${code ?? signal}`;
      // Ended by itself, with no frame: the clip's. Ended by a signal (the time, the size of a frame, a file that could not be read) it may be any other.
      reject(code !== null ? new NoFrame(why) : new Error(why));
    });
  });
}

/** Makes the poster of the open clip, unless it has changed while it was read. Whether the poster was kept is the answer. */
function make(fd: number, size: number, modifiedMs: number, id: string, name: string, listed: () => boolean): Promise<boolean> {
  const wip = making.get(name);
  if (wip) return wip;
  const stopped = stopSignal();
  const job = turn(async () => {
    // Media stopped while it waited its turn: not made.
    if (stopped.aborted) return false;
    try {
      const frame = await firstFrame(fd, size, stopped);
      const now = fstatSync(fd);
      if (now.size !== size || now.mtimeMs !== modifiedMs) return false;
      const copy = await sharp(frame, { failOn: "error" }).resize({ width: POSTER_SIDE, height: POSTER_SIDE, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
      // The clip may have been deleted while the poster was made, which removed the posters that there were then: this one would stay for good.
      if (!listed()) return false;
      mkdirSync(postersDir(), { recursive: true });
      keepCopy(path.join(postersDir(), name), copy);
      // The poster of the file before is of no use any more.
      for (const old of readdirSync(postersDir())) if (old !== name && old.startsWith(`${id}-`)) rmSync(path.join(postersDir(), old), { force: true });
      return true;
    } catch (e) {
      // Media stopped meanwhile, which killed ffmpeg: no failure of the clip's.
      if (stopped.aborted) return false;
      portal().log(`videos: poster failed: ${(e as Error).message}`);
      if (e instanceof NoFrame) {
        if (failed.size >= MAX_FAILED) failed.clear();
        failed.add(name);
      }
      return false;
    }
  }).finally(() => making.delete(name));
  making.set(name, job);
  return job;
}

/**
 * The poster of the clip whose file is open (the caller has checked that the person may read it), opened to be sent
 * as a picture; made first when there is none for this version of the file. Nothing when there is no ffmpeg, or it
 * cannot make a frame of this clip. The descriptor of the clip is closed. `listed` says whether the clip is still in
 * the gallery, which is asked again when a poster is done.
 */
export async function openPoster(whole: Opened, id: string, listed: () => boolean): Promise<Opened | undefined> {
  try {
    if (!posterAvailable()) return undefined;
    const modifiedMs = fstatSync(whole.fd).mtimeMs;
    const name = copyName(id, whole.size, modifiedMs);
    const open = (): Opened | undefined => {
      try {
        return openPicture(baseDir(postersDir()), name);
      } catch {
        return undefined;
      }
    };
    const kept = open();
    if (kept || failed.has(name)) return kept;
    return (await make(whole.fd, whole.size, modifiedMs, id, name, listed)) ? open() : undefined;
  } finally {
    closeSync(whole.fd);
  }
}
