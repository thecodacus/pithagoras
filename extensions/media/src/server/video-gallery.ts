import { closeSync, fstatSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { FileError, refusalOf } from "./file-error";
import { portal } from "./host";
import { ChatGone, chatFolder, folderLabel, folderOf, foundFolder, knownFolders, locateRow, newId, realFolderOf, type MediaOrigin } from "./media-folders";
import { getDb } from "./store";
import { VIDEO_HEAD, formatByName, formatOf, openClip, sniffVideo, type VideoExt, type VideoFormat } from "./video-files";
import { copyState, openCopy, removeCopies } from "./video-copies";
import { openPoster, posterAvailable, removePosters } from "./video-posters";
import { baseDir, isWithinText } from "./within";

/**
 * The clips of the Media page, in one list: the ones the page made itself
 * and the ones the agent made with generate_video.
 *
 * It is the picture gallery's twin (image-gallery.ts), with the same rules, and
 * the same code for where a file is and which folders the portal looks in (see
 * media-folders.ts). A row in the `videos` table names a clip and says what it was
 * made from; the clip is a file, in one of two kinds of place the portal knows.
 * The page's own are in a folder of its own in Media's (`portal.dataDir()`), under a name
 * made here. The agent's are where its tool puts them, in the `generated-videos`
 * folder of the folder a chat works in, and are listed from the moment they are
 * made (see recordChatVideo). Those that were never recorded are found by looking in
 * exactly those folders (see scanFolders), and in them only `generated-videos`.
 * A file is only ever opened and served through the checks a clip gets: a path
 * inside the folder, no link followed out of it, and what the bytes say it is. Every
 * file is listed, whatever it is (see sniffVideo): a WebM and an MP4 are played, and the
 * rest is a file that can be downloaded, with a WebM copy to play when ffmpeg is there.
 *
 * What goes from the list when a file does: a clip whose file is gone is dropped the
 * next time the page looks. The clips of a chat stay when the chat goes, as clips of
 * its folder (see keepChatVideos).
 */

/** Where the agent's tool puts what it makes, inside the chat's folder, so that it does not mix with the work. */
export const GENERATED_VIDEOS_DIR = "generated-videos";

const WHAT = "video";

export type VideoOrigin = MediaOrigin;
/** Made from a description, made from a picture as its first frame or its last, or found with nothing to tell how it was made. */
export type VideoKind = "generated" | "animated" | "unknown";

/** What a clip was asked for with, as far as it is known. */
export interface VideoParams {
  model?: string;
  size?: string;
  /** What was asked for. The server may have made fewer: see `madeFrames`. */
  frames?: number;
  fps?: number;
  seed?: number;
  sampleSteps?: number;
  negativePrompt?: string;
  strength?: number;
  /** What the server says it made, when it said: the frames in the clip, and its frame rate. A clip's length is the first over the second. */
  madeFrames?: number;
  madeFps?: number;
  /** The first frame of a clip made from a picture: the picture of the Media page it was taken from, or its path in the chat's folder. */
  firstFrame?: { picture?: string; path?: string };
  /** The last frame, where the clip was asked to end on a picture: named as the first frame is. */
  lastFrame?: { picture?: string; path?: string };
}

/** A clip as the page is told of it. */
export interface GalleryVideo {
  id: string;
  origin: VideoOrigin;
  /** The chat that made it, for the agent's clips. */
  chat: { id: string; title: string } | null;
  /** The folder it was found in, for a clip of the folder: Home, an agent's name, or the name of the project or folder. */
  folder: { name: string; home: boolean } | null;
  kind: VideoKind;
  prompt: string;
  params: VideoParams;
  createdAt: number;
  bytes: number;
  /** What a download is called. */
  fileName: string;
  /** Media can make a poster picture of it (see video-posters.ts), which the tiles show until the clip is played. Only for a clip a browser plays. */
  poster: boolean;
  /** What the file is by its first bytes, and whether a browser plays it here: only a WebM and an MP4 are, and the rest is offered as a download. */
  format: VideoFormat;
  /** For a clip that is not played as it is: a playable WebM copy of it is `ready`, or ffmpeg is there to make one on request (`available`). */
  copy?: "ready" | "available";
  /** Why the file could not be opened when the list was made, when it could not: it is out of reach (its folder, or the file) or over the size a clip may have. Its format is then what is known of it without opening it. */
  unavailable?: "unreachable" | "too_large";
}

interface Row {
  id: string;
  origin: VideoOrigin;
  session_id: string | null;
  /** For a clip of a folder: the folder, as the portal knows it. A chat's clip has its chat's. */
  folder: string | null;
  path: string;
  kind: VideoKind;
  prompt: string;
  params: string;
  bytes: number;
  created_at: number;
  /** For a chat's clip: the real folder of the chat when it was recorded, which it is kept in when the chat goes. */
  chat_folder: string | null;
}

/** Where the page's own clips are kept. */
export const videosDir = (): string => path.join(portal().dataDir(), "videos");

const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/** The params a row holds, kept to the fields that are known: what is in the database is the portal's own, but only as far as it is read back. */
function readParams(text: string): VideoParams {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") raw = parsed;
  } catch {
    // Unreadable is as good as nothing said.
  }
  const params: VideoParams = {};
  if (typeof raw.model === "string" && raw.model) params.model = raw.model;
  if (typeof raw.size === "string" && raw.size) params.size = raw.size;
  if (whole(raw.frames)) params.frames = raw.frames;
  if (whole(raw.fps)) params.fps = raw.fps;
  if (whole(raw.seed)) params.seed = raw.seed;
  if (whole(raw.sampleSteps)) params.sampleSteps = raw.sampleSteps;
  if (typeof raw.negativePrompt === "string" && raw.negativePrompt) params.negativePrompt = raw.negativePrompt;
  if (typeof raw.strength === "number" && Number.isFinite(raw.strength)) params.strength = raw.strength;
  if (whole(raw.madeFrames)) params.madeFrames = raw.madeFrames;
  if (whole(raw.madeFps)) params.madeFps = raw.madeFps;
  const first = readFrame(raw.firstFrame);
  if (first) params.firstFrame = first;
  const last = readFrame(raw.lastFrame);
  if (last) params.lastFrame = last;
  return params;
}

/** A first or last frame as a row holds it: the picture or the path it names, as far as they are text. */
function readFrame(value: unknown): NonNullable<VideoParams["firstFrame"]> | undefined {
  const raw = value as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const frame: NonNullable<VideoParams["firstFrame"]> = {};
  if (typeof raw.picture === "string" && raw.picture) frame.picture = raw.picture;
  if (typeof raw.path === "string" && raw.path) frame.path = raw.path;
  return frame.picture || frame.path ? frame : undefined;
}

/** What a download of a clip is called: the file's own name for the agent's, one made from the time for the page's. */
function downloadName(row: Row): string {
  if (row.origin !== "page") return path.basename(row.path);
  const stamp = new Date(row.created_at).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return `video-${stamp}-${row.id.slice(0, 4)}${path.extname(row.path)}`;
}

/** What a clip's file is and what it is when listed: the kind its first bytes say, and the size and time the copy of it is named for. A file that could not be opened says why, with the kind as far as it is known. */
interface Looked {
  format: VideoFormat;
  size?: number;
  modifiedMs?: number;
  unavailable?: GalleryVideo["unavailable"];
}

function look(row: Row, folders: Map<string, string | Error>): Looked {
  // A clip that cannot be opened is not an unknown one: it keeps the kind it has, which its name tells when its bytes cannot be read.
  const unopened = (): Looked => ({ format: formatByName(row.path), unavailable: "unreachable" });
  let at: { base: string; rel: string };
  try {
    at = locate(row, folders);
  } catch {
    return unopened();
  }
  try {
    const opened = openClip(at.base, at.rel);
    try {
      return { format: opened.format, size: opened.size, modifiedMs: fstatSync(opened.fd).mtimeMs };
    } finally {
      closeSync(opened.fd);
    }
  } catch (e) {
    if (refusalOf(e) !== "too_large") return unopened();
  }
  // Over the size a clip may have: it is neither played nor sent, but what it is can still be read from its start.
  try {
    return { format: formatOf(at.base, at.rel), unavailable: "too_large" };
  } catch {
    return unopened();
  }
}

function shown(row: Row, looked: Looked): GalleryVideo {
  const copy = looked.size !== undefined && looked.modifiedMs !== undefined ? copyState(row.id, looked.size, looked.modifiedMs, looked.format.playable) : undefined;
  return {
    id: row.id,
    origin: row.origin,
    chat: row.session_id ? { id: row.session_id, title: portal().chats.get(row.session_id)?.title ?? "" } : null,
    folder: row.origin === "folder" && row.folder ? folderLabel(row.folder) : null,
    kind: row.kind,
    prompt: row.prompt,
    params: readParams(row.params),
    createdAt: row.created_at,
    bytes: row.bytes,
    fileName: downloadName(row),
    poster: looked.format.playable && !looked.unavailable && posterAvailable(),
    format: looked.format,
    ...(copy ? { copy } : {}),
    ...(looked.unavailable ? { unavailable: looked.unavailable } : {}),
  };
}

/** Rows as the page is told of them, each with what its file is: a few bytes are read of each. */
function shownAll(rows: Row[]): GalleryVideo[] {
  const folders = new Map<string, string | Error>();
  return rows.map((row) => shown(row, look(row, folders)));
}

const rowById = (id: string): Row | undefined => getDb().prepare("SELECT * FROM videos WHERE id = ?").get(id) as Row | undefined;

/** A clip of the list by its id: one of a chat that Media was not told is gone is kept as its folder's first, as rowOf of the pictures has it. */
function rowOf(id: string): Row | undefined {
  const row = rowById(id);
  if (!row?.session_id || portal().chats.get(row.session_id)) return row;
  keepChatVideos(row.session_id);
  return rowById(id);
}

/** Where a clip's file is, as a folder the portal knows and a path inside it; the reason it is not anywhere that can be served otherwise. */
const locate = (row: Row, folders: Map<string, string | Error> = new Map()) => locateRow(row, { own: videosDir(), generated: GENERATED_VIDEOS_DIR, what: WHAT }, folders);

/**
 * Whether a clip's folder is only out of reach for the moment: a folder on a drive that is not mounted. Its clips
 * are not gone, and what looks at them leaves them in the list. A chat that is gone is another thing. A clip that
 * was found has no chat to lose it with and is found again when its folder is back, so it is not kept: only what
 * was recorded is, and with it what a kept clip was asked for, which a scan cannot give it back.
 */
function unreachable(row: Row, e: unknown): boolean {
  if (refusalOf(e) !== "missing" || e instanceof ChatGone) return false;
  if (row.origin === "chat") return true;
  return row.origin === "folder" && (row.prompt !== "" || row.params !== "{}");
}

/** Whether a clip is still to be shown: its file is there as a plain file, or its folder is out of reach and it may be. */
function isThere(row: Row, folders: Map<string, string | Error>): boolean {
  let at: { base: string; rel: string };
  try {
    at = locate(row, folders);
  } catch (e) {
    return unreachable(row, e);
  }
  try {
    // The folder part goes the way serving goes: a link in it that leads out of the folder is a clip that cannot be served, and is not there. The file itself is looked at as it is, so that a link is none.
    const dirKey = `\0in\0${at.base}\0${path.dirname(at.rel)}`;
    let dir = folders.get(dirKey);
    if (dir === undefined) {
      try {
        dir = portal().files.inside(at.base, path.dirname(at.rel));
      } catch (e) {
        if (!refusalOf(e)) throw e;
        dir = e as Error;
      }
      folders.set(dirKey, dir);
    }
    if (typeof dir !== "string") return false;
    return lstatSync(path.join(dir, path.basename(at.rel))).isFile();
  } catch {
    return false;
  }
}

const insert = (row: Row) =>
  getDb()
    .prepare("INSERT OR IGNORE INTO videos (id, origin, session_id, folder, path, kind, prompt, params, bytes, created_at, chat_folder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.origin, row.session_id, row.folder, row.path, row.kind, row.prompt, row.params, row.bytes, row.created_at, row.chat_folder);

/** Puts a clip the page made in the page's own folder and in the list. */
export function addPageVideo(video: { bytes: Buffer; ext: VideoExt; kind: VideoKind; prompt: string; params: VideoParams }): GalleryVideo {
  const id = newId();
  mkdirSync(videosDir(), { recursive: true });
  // Written the way every file the portal makes is: beside its place first, never over anything, and only inside the folder.
  const rel = portal().files.create(baseDir(videosDir()), "", `${id}.${video.ext}`, video.bytes);
  const row: Row = {
    id,
    origin: "page",
    session_id: null,
    folder: null,
    path: rel,
    kind: video.kind,
    prompt: video.prompt,
    params: JSON.stringify(video.params),
    bytes: video.bytes.length,
    created_at: Date.now(),
    chat_folder: null,
  };
  insert(row);
  const format = sniffVideo(video.bytes.subarray(0, VIDEO_HEAD));
  return shown(row, { format, size: video.bytes.length, modifiedMs: Date.now() });
}

/**
 * Lists a clip the agent has just made in a chat, with what it was asked for. The clip is already where the
 * chat's folder has it; this only says so, with the chat's folder as it is now, which the clip is kept in when the
 * chat goes. A name that comes back is a new clip: its file was taken away by something that did not tell the
 * list, and the old rows are not this file's.
 */
export function recordChatVideo(video: { sessionId: string; path: string; kind: VideoKind; prompt: string; params: VideoParams; bytes: number }): void {
  // A clip that was made is made: that it could not be listed is not the tool's failure, and the agent has nothing to do about it.
  try {
    // Chats share a folder — every chat of a project, every one in Home — so a path names a file for all of them: the rows of the chats whose folder is this one. A clip that was found in this folder before it was recorded (the page looked in between) is the same file.
    const mine = folderOf(video.sessionId);
    const before = [
      ...(getDb().prepare("SELECT id, session_id FROM videos WHERE origin = 'chat' AND path = ?").all(video.path) as { id: string; session_id: string }[])
        .filter((row) => row.session_id === video.sessionId || (mine !== undefined && folderOf(row.session_id) === mine))
        .map((row) => row.id),
      ...(mine === undefined
        ? []
        : (getDb().prepare("SELECT id, folder FROM videos WHERE origin = 'folder' AND path = ?").all(video.path) as { id: string; folder: string }[])
            // By where the folder really is: a row from before a link was put above it names it by the old path.
            .filter((row) => realFolderOf(row.folder) === mine)
            .map((row) => row.id)),
    ];
    getDb().transaction(() => {
      if (before.length) forget(before);
      insert({
        id: newId(),
        origin: "chat",
        session_id: video.sessionId,
        folder: null,
        path: video.path,
        kind: video.kind,
        prompt: video.prompt,
        params: JSON.stringify(video.params),
        bytes: video.bytes,
        created_at: Date.now(),
        chat_folder: mine ?? null,
      });
    })();
  } catch (e) {
    portal().log(`videos: could not list the video in the gallery: ${(e as Error).message}`);
  }
}

/**
 * Drops what the list names that is not there to show: a file that is gone, a chat that is, a path that leads out.
 * Looked at when the list is looked at from the top, which is a stat for each clip and little more. A clip that
 * was found is kept under the folder as it really is, so that it is not listed twice when a link is put above it.
 * The clips of a chat that was deleted while Media was not running are kept as clips of its folder first, as those
 * of a chat deleted now are (see keepChatVideos).
 */
export function pruneMissing(): number {
  const folders = new Map<string, string | Error>();
  const d = getDb();
  for (const { session_id } of d.prepare("SELECT DISTINCT session_id FROM videos WHERE session_id IS NOT NULL").all() as { session_id: string }[]) {
    if (!portal().chats.get(session_id)) keepChatVideos(session_id);
  }
  const rows = d.prepare("SELECT * FROM videos").all() as Row[];
  const gone: string[] = [];
  for (const row of rows) {
    if (!isThere(row, folders)) {
      gone.push(row.id);
    } else if (row.origin === "folder" && row.folder) {
      let real: string;
      try {
        real = foundFolder(row.folder, folders, WHAT);
      } catch (e) {
        // Kept for a folder that is out of reach for the moment: there is no real place to put it under.
        if (refusalOf(e)) continue;
        throw e;
      }
      // Taken from the list when the same file is already a clip of that folder.
      if (real !== row.folder && !d.prepare("UPDATE OR IGNORE videos SET folder = ? WHERE id = ?").run(real, row.id).changes) gone.push(row.id);
    }
  }
  if (gone.length) forget(gone);
  return gone.length;
}

/** The most files of one folder that are looked through: a folder with more is not one the tool has been filling. */
const MAX_LOOKED_AT = 5_000;

/** What a file that is no clip looked like when it was looked at, so that it is not opened again until it changes. Kept to no more than this, and started again beyond it. */
const refused = new Map<string, string>();
const MAX_REFUSED = 10_000;

/** What a file is, by its name: the tool names what it makes by the time. */
function kindByName(name: string): VideoKind {
  return /^video-\d{8}-\d{6}-[0-9a-f]{6}(?: \(\d+\))?\.[^.]+$/.test(name) ? "generated" : "unknown";
}

/** Whether the tool would have given this name to a clip nobody could tell the kind of: it names such a clip `.bin` and no other way. */
const namedForUnknown = (name: string): boolean => kindByName(name) === "generated" && name.endsWith(".bin");

/**
 * Whether the file `name` of the `generated-videos` folder of `real` is a clip to list, and then its size and
 * time. It is opened as serving one opens it. What its first bytes say is some kind of clip is listed, played or
 * downloaded as what it is; a file they say nothing of is listed only when it is named as the tool names a clip
 * nobody could tell the kind of (`video-<time>-<id>.bin`: it is then one the endpoint sent), and not otherwise: the
 * folder may hold other things. A file that is not listed is not opened again until it changes.
 */
function clipAt(real: string, name: string): { size: number; mtimeMs: number } | undefined {
  const rel = `${GENERATED_VIDEOS_DIR}/${name}`;
  const file = path.join(real, rel);
  try {
    const { size, mtimeMs } = lstatSync(file);
    const stamp = `${size}:${mtimeMs}`;
    if (refused.get(file) === stamp) return undefined;
    try {
      const opened = openClip(real, rel);
      try {
        if (opened.format.id === "bin" && !namedForUnknown(name)) {
          refused.set(file, stamp);
          return undefined;
        }
        return { size: opened.size, mtimeMs: fstatSync(opened.fd).mtimeMs };
      } finally {
        closeSync(opened.fd);
      }
    } catch (e) {
      const refusal = refusalOf(e);
      if (refusal && refusal !== "missing") refused.set(file, stamp);
      return undefined;
    }
  } catch {
    return undefined;
  }
}

/**
 * Lists the clips that lie in the folders the tool writes into and were never recorded, as scanFolders of the
 * pictures does: only `generated-videos` of the folders the portal knows (see knownFolders) is looked in, only
 * plain files, and what is listed is what its bytes show to be some kind of clip (see clipAt), not over the size a
 * clip may have. A file that is listed already, or was found not to be a clip, is not opened again until it changes.
 * What is found is a clip of its folder, as which chat made it cannot be told. Returns how many were added.
 */
export function scanFolders(): number {
  const d = getDb();
  const folders = new Map<string, string | Error>();
  const key = (folder: string, rel: string) => `${folder}\0${rel}`;
  // What the gallery has as a file of these folders, by where the file really is; worked out the first time a folder has something to look at.
  let listed: Set<string> | undefined;
  const listedFiles = (): Set<string> => {
    if (listed) return listed;
    listed = new Set();
    for (const row of d.prepare("SELECT origin, session_id, folder, path FROM videos WHERE origin != 'page'").all() as Pick<Row, "origin" | "session_id" | "folder" | "path">[]) {
      try {
        const folder = row.origin === "folder" ? (row.folder ? foundFolder(row.folder, folders, WHAT) : null) : row.session_id ? chatFolder(row.session_id, folders, WHAT) : null;
        if (folder) listed.add(key(folder, row.path));
      } catch (e) {
        if (!refusalOf(e)) throw e;
      }
    }
    return listed;
  };
  return d.transaction(() => {
    let added = 0;
    for (const real of knownFolders("videos")) {
      let names: string[];
      try {
        const dir = path.join(real, GENERATED_VIDEOS_DIR);
        // lstat, so that a link of that name is not followed into a folder it leads to.
        if (!lstatSync(dir).isDirectory()) continue;
        names = readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
          .slice(0, MAX_LOOKED_AT)
          .map((entry) => entry.name);
      } catch {
        // No such folder yet, or it cannot be read: not a failure.
        continue;
      }
      for (const name of names) {
        const rel = `${GENERATED_VIDEOS_DIR}/${name}`;
        if (listedFiles().has(key(real, rel))) continue;
        const found = clipAt(real, name);
        if (!found) continue;
        const row: Row = {
          id: newId(),
          origin: "folder",
          session_id: null,
          folder: real,
          path: rel,
          kind: kindByName(name),
          prompt: "",
          params: "{}",
          bytes: found.size,
          created_at: Math.min(Date.now(), Math.round(found.mtimeMs)),
          chat_folder: null,
        };
        if (insert(row).changes) added++;
        listedFiles().add(key(real, rel));
      }
    }
    if (refused.size > MAX_REFUSED) refused.clear();
    return added;
  })();
}

/** Takes clips from the list, and their posters. The files are not touched. */
function forget(ids: string[]): void {
  const d = getDb();
  const remove = d.prepare("DELETE FROM videos WHERE id = ?");
  d.transaction(() => {
    for (const id of ids) remove.run(id);
  })();
  removePosters(ids);
  removeCopies(ids);
}

/**
 * Takes the clips of a folder that was removed from the list: those of every chat that worked in it, routine runs
 * included, and those that were found in it, or kept from a chat that is gone. A folder that is gone for good
 * cannot be told from a drive that is not mounted, which keeps its clips, so the portal says it when it is the
 * one that removed the folder, by where it really was, as forgetPicturesIn has it. The files went with the folder.
 */
export function forgetVideosIn(dir: string): number {
  const rows = getDb().prepare("SELECT id, folder, chat_folder FROM videos WHERE folder IS NOT NULL OR chat_folder IS NOT NULL").all() as Pick<Row, "id" | "folder" | "chat_folder">[];
  const gone = rows.filter((row) => [row.folder, row.chat_folder].some((folder) => folder !== null && isWithinText(dir, folder))).map((row) => row.id);
  if (gone.length) forget(gone);
  return gone.length;
}

/**
 * Keeps the clips of a chat that was deleted as clips of its folder, as keepChatPictures does the pictures: the
 * folder is the one the chat had when each was recorded, where it really is now. Those that cannot be kept go, with
 * their posters and copies.
 */
export function keepChatVideos(sessionId: string): void {
  const d = getDb();
  for (const { chat_folder } of d.prepare("SELECT DISTINCT chat_folder FROM videos WHERE session_id = ? AND chat_folder IS NOT NULL").all(sessionId) as { chat_folder: string }[]) {
    // A folder that cannot be reached is not one to keep clips of: there is nothing to find them in.
    const real = realFolderOf(chat_folder);
    if (real) d.prepare("UPDATE OR IGNORE videos SET origin = 'folder', folder = ?, chat_folder = NULL, session_id = NULL WHERE session_id = ? AND chat_folder = ?").run(real, sessionId, chat_folder);
  }
  const left = (d.prepare("SELECT id FROM videos WHERE session_id = ?").all(sessionId) as { id: string }[]).map((row) => row.id);
  if (left.length) forget(left);
}

export interface ListQuery {
  origin?: VideoOrigin;
  kind?: VideoKind;
  /** The `next` of the page before. */
  before?: string;
  limit?: number;
  /** A page that asks again for the top of a list it has, as on a timer: the look through the files is not made again within LOOK_AGAIN_MS of the last one. */
  again?: boolean;
}

export const DEFAULT_PAGE = 24;
export const MAX_PAGE = 100;

/** How long a page that asks again is told what the last look found: the look is a stat for each clip and a read of every folder. */
export const LOOK_AGAIN_MS = 60_000;
let lastLook = 0;

/** What the page's own clips take of the disk. */
export const pageVideoBytes = (): number => (getDb().prepare("SELECT COALESCE(SUM(bytes), 0) AS n FROM videos WHERE origin = 'page'").get() as { n: number }).n;

/** A page of the list, newest first, the next one's start, and what there is in all. */
export function listVideos(query: ListQuery = {}): { videos: GalleryVideo[]; next: string | null; total: number; pageBytes: number } {
  // The whole list is looked at when it is looked at from the top, not once for every page of it. What is gone goes first, then what has come that nobody listed.
  if (!query.before && !(query.again && Date.now() - lastLook < LOOK_AGAIN_MS)) {
    lastLook = Date.now();
    pruneMissing();
    try {
      scanFolders();
    } catch (e) {
      // A gallery that cannot look in the folders is still a gallery.
      portal().log(`videos: could not look through the folders for videos: ${(e as Error).message}`);
    }
  }
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (query.origin) {
    where.push("videos.origin = ?");
    args.push(query.origin);
  }
  if (query.kind) {
    where.push("videos.kind = ?");
    args.push(query.kind);
  }
  const d = getDb();
  const counted = d.prepare(`SELECT COUNT(*) AS n FROM videos${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`).get(...args) as { n: number };
  const cursor = /^(\d+):([0-9a-f]+)$/.exec(query.before ?? "");
  if (cursor) {
    where.push("(videos.created_at < ? OR (videos.created_at = ? AND videos.id < ?))");
    args.push(Number(cursor[1]), Number(cursor[1]), cursor[2]);
  }
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(query.limit ?? DEFAULT_PAGE)));
  const rows = d
    .prepare(`SELECT * FROM videos${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY videos.created_at DESC, videos.id DESC LIMIT ?`)
    .all(...args, limit + 1) as Row[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    videos: shownAll(page),
    next: rows.length > limit && last ? `${last.created_at}:${last.id}` : null,
    total: counted.n,
    pageBytes: pageVideoBytes(),
  };
}

/** Some clips by their ids, as far as they are in the list. */
export function videosById(ids: string[]): GalleryVideo[] {
  return shownAll(ids.map(rowOf).filter((row): row is Row => !!row));
}

/**
 * A clip opened to be sent: the descriptor, its size and the type its bytes say, from the same checks a clip in a
 * chat gets. Whether it is played or only downloaded is for the caller, by its format. A file that is gone is not
 * served, and is taken from the list.
 */
export function openListedVideo(id: string): { fd: number; size: number; name: string; mimeType: string; format: VideoFormat; origin: VideoOrigin; fileName: string } {
  const row = rowOf(id);
  if (!row) throw new FileError("missing", "There is no such video");
  let at: { base: string; rel: string };
  try {
    at = locate(row);
  } catch (e) {
    // Out of reach is not gone: the clip is shown again when its folder is back.
    if (refusalOf(e) === "missing" && !unreachable(row, e)) forget([id]);
    throw e;
  }
  try {
    return { ...openClip(at.base, at.rel), origin: row.origin, fileName: downloadName(row) };
  } catch (e) {
    if (refusalOf(e) === "missing") forget([id]);
    throw e;
  }
}

/**
 * The poster picture of a clip, opened to be sent the way a picture is, made now when there is none for the file as
 * it is. Whoever may open the clip may have its poster, and nobody else: it is opened as the clip is. Nothing when
 * the portal cannot make one (see video-posters.ts); the page then shows the clip's first frame itself.
 */
export async function openListedPoster(id: string): Promise<(Awaited<ReturnType<typeof openPoster>> & { origin: VideoOrigin }) | undefined> {
  const whole = openListedVideo(id);
  // A clip a browser does not play has no poster: it is shown as what it is.
  if (!whole.format.playable) {
    closeSync(whole.fd);
    return undefined;
  }
  const poster = await openPoster(whole, id, () => !!rowOf(id));
  return poster ? { ...poster, origin: whole.origin } : undefined;
}

/**
 * Takes a clip away: its file, and its place in the list. A clip in a chat's folder is that chat's file, so this is
 * only ever asked for on purpose, by the person. A file that is gone already is as good as deleted. A folder that
 * cannot be reached is not: the file may well be in it, so this says so and leaves the clip in the list.
 */
export async function deleteVideo(id: string): Promise<void> {
  if (!rowById(id)) throw new FileError("missing", "There is no such video");
  const row = rowOf(id);
  // Its chat went while Media was not told, with no folder to keep it in: it went from the list, and nothing is left of it to delete.
  if (!row) return;
  const missing = (e: unknown) => refusalOf(e) === "missing";
  let at: { base: string; rel: string } | undefined;
  try {
    at = locate(row);
  } catch (e) {
    // Its chat is gone: nothing is left of it to delete. Out of reach is something else.
    if (!missing(e) || (row.origin !== "page" && !(e instanceof ChatGone))) throw e;
  }
  try {
    if (at) await portal().files.remove(at.base, at.rel);
  } catch (e) {
    // ChatGone since: what was asked for.
    if (!missing(e)) throw e;
  }
  forget([id]);
}

/**
 * The WebM copy of a clip a browser does not play, opened to be played; made first, when `make` says so and ffmpeg is
 * there, and kept (see video-copies.ts). Nothing when there is none: the clip plays as it is, or there is no ffmpeg, or it
 * could not make one of this clip. The original is not touched.
 */
export async function openListedCopy(id: string, make: boolean): Promise<(Awaited<ReturnType<typeof openCopy>> & { origin: VideoOrigin }) | undefined> {
  const whole = openListedVideo(id);
  if (whole.format.playable) {
    closeSync(whole.fd);
    return undefined;
  }
  const copy = await openCopy(whole, id, () => !!rowOf(id), make);
  return copy ? { ...copy, origin: whole.origin } : undefined;
}
