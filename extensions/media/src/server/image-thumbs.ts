import { closeSync, fstatSync, mkdirSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { portal, stopSignal } from "./host";
import { openPicture } from "./picture-files";
import { baseDir } from "./within";

/**
 * The small copies of the gallery's pictures, which the tiles show instead of the files (a tile
 * is a few hundred pixels across, a picture may be several megabytes). Media makes them
 * itself, the first time one is asked for, and keeps them in its own folder.
 */

/** The longest side of a small copy, in pixels: a tile is shown up to about 300 across, and a screen may have twice the pixels. */
export const THUMB_SIDE = 480;
/** A file not larger than this is sent as it is: a copy would save next to nothing. */
export const THUMB_WORTH_IT = 48 * 1024;
/** How many copies are made at the same time. A folder of large files asks for a screenful at once, and decoding each takes memory and a core. */
export const THUMB_JOBS = 2;

type Opened = ReturnType<typeof openPicture>;

/** Where the small copies are kept, one for each picture. */
export const thumbsDir = (): string => path.join(portal().dataDir(), "image-thumbs");

/**
 * Puts a copy in place whole: written beside its place and renamed into it, so that a copy that is cut off is never
 * one that is sent. Plain files will do: the folder is Media's own, which no agent can write.
 */
export function keepCopy(file: string, data: Buffer): void {
  const part = `${file}.part`;
  writeFileSync(part, data, { mode: 0o644 });
  renameSync(part, file);
}

/**
 * The copy of this very file: its name has the picture's id, and the size and time of the file it
 * was made from, so a file that was written over is never given the copy of the one before.
 */
const copyName = (id: string, size: number, modifiedMs: number): string => `${id}-${size.toString(16)}-${Math.floor(modifiedMs).toString(16)}.webp`;

/** Whether a picture gets a small copy: not a small file, and not a GIF, which would stand still. (The file's own type is what decides when it is asked for.) */
export const wantsThumb = (bytes: number, fileName: string): boolean => bytes > THUMB_WORTH_IT && !/\.gif$/i.test(fileName);

/** The small copies of these pictures are gone with them, wherever the pictures' rows are deleted. */
export function removeThumbs(ids: string[]): void {
  if (!ids.length) return;
  const gone = new Set(ids);
  let names: string[];
  try {
    names = readdirSync(thumbsDir());
  } catch {
    return;
  }
  for (const name of names) if (gone.has(name.split("-")[0])) rmSync(path.join(thumbsDir(), name), { force: true });
}

/** Runs at most `THUMB_JOBS` at once, the others wait their turn. */
let running = 0;
/** The most that have run at once, for the test that says the limit holds. */
let peak = 0;
export const thumbJobsPeak = (): number => peak;
const waiting: (() => void)[] = [];
async function turn<T>(job: () => Promise<T>): Promise<T> {
  if (running >= THUMB_JOBS) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  peak = Math.max(peak, running);
  try {
    return await job();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** Asked for twice at once (a tile and the form of an edit): made once. */
const making = new Map<string, Promise<boolean>>();

/** An animated picture: a copy of the first frame would stand still. APNG is told by its animation chunk, which comes before the image data. */
function animated(bytes: Buffer, pages: number | undefined): boolean {
  if ((pages ?? 1) > 1) return true;
  const control = bytes.indexOf("acTL");
  return control !== -1 && (control < bytes.indexOf("IDAT") || bytes.indexOf("IDAT") === -1);
}

function readWhole(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const n = readSync(fd, bytes, read, size - read, read);
    if (n === 0) break;
    read += n;
  }
  return bytes.subarray(0, read);
}

/**
 * Makes the copy of the open file, unless it is animated or has changed while it was read.
 * WebP, which keeps transparency, so that there is one format for every picture. Whether the
 * copy was kept is the answer; a picture sharp cannot read is none either, and is sent as it is.
 */
function make(fd: number, size: number, modifiedMs: number, id: string, name: string, listed: () => boolean): Promise<boolean> {
  const wip = making.get(name);
  if (wip) return wip;
  const stopped = stopSignal();
  const job = turn(async () => {
    // Media stopped while it waited its turn: not made.
    if (stopped.aborted) return false;
    try {
      const bytes = readWhole(fd, size);
      const now = fstatSync(fd);
      if (bytes.length !== size || now.size !== size || now.mtimeMs !== modifiedMs) return false;
      const image = sharp(bytes, { failOn: "error" });
      if (animated(bytes, (await image.metadata()).pages)) return false;
      // The camera's turn is applied, as the metadata that said it is not kept.
      const copy = await image.rotate().resize({ width: THUMB_SIDE, height: THUMB_SIDE, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
      // The picture may have been deleted while the copy was made, which removed the copies that there were then: this one would stay for good.
      if (!listed()) return false;
      mkdirSync(thumbsDir(), { recursive: true });
      keepCopy(path.join(thumbsDir(), name), copy);
      // The copy of the file before is of no use any more.
      for (const old of readdirSync(thumbsDir())) if (old !== name && old.startsWith(`${id}-`)) rmSync(path.join(thumbsDir(), old), { force: true });
      return true;
    } catch (e) {
      // Media stopped meanwhile, and closed the gallery it asks: no failure of the copy's.
      if (!stopped.aborted) portal().log(`images: small copy failed: ${(e as Error).message}`);
      return false;
    }
  }).finally(() => making.delete(name));
  making.set(name, job);
  return job;
}

/**
 * The small copy of the picture whose file is open (the caller has checked that the person may read
 * it), opened to be sent; made first when there is none for this version of the file. Without one,
 * for a GIF, a small file, an animated picture or one that cannot be decoded, the file itself is
 * what comes back. The descriptor of the file is closed unless it is the one returned. `listed`
 * says whether the picture is still in the gallery, which is asked again when a copy is done.
 */
export async function openThumb(whole: Opened, id: string, listed: () => boolean): Promise<Opened> {
  if (whole.mimeType === "image/gif" || whole.size <= THUMB_WORTH_IT) return whole;
  const modifiedMs = fstatSync(whole.fd).mtimeMs;
  const name = copyName(id, whole.size, modifiedMs);
  const open = (): Opened | undefined => {
    try {
      return openPicture(baseDir(thumbsDir()), name);
    } catch {
      return undefined;
    }
  };
  const kept = open() ?? ((await make(whole.fd, whole.size, modifiedMs, id, name, listed)) ? open() : undefined);
  if (!kept) return whole;
  closeSync(whole.fd);
  return kept;
}
