import { closeSync, fstatSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { FileError, refusalOf } from "./file-error";
import { portal } from "./host";
import type { ExtraValue } from "./image-generation";
import { openThumb, removeThumbs, wantsThumb } from "./image-thumbs";
import { OUTPUT_FORMATS, type OutputFormat } from "./image-settings";
import { ChatGone, chatFolder, folderLabel, folderOf, foundFolder, knownFolders, locateRow, newId, realFolderOf, type MediaOrigin } from "./media-folders";
import { openPicture, readPicture } from "./picture-files";
import { getDb } from "./store";
import { baseDir, isWithinText } from "./within";

/**
 * The pictures of the Media page, in one list: the ones the page made itself
 * and the ones the agent made with generate_image or edit_image.
 *
 * A row in the `images` table names a picture and says what it was made from;
 * the picture is a file, in one of two kinds of place the portal knows. The
 * page's own are in a folder of its own in Media's (`portal.dataDir()`), under a name
 * made here. The agent's are where its tools put them, in the `generated-images`
 * folder of the folder a chat works in, and are listed from the moment they are
 * made: the tools record each one (see recordChatPicture), with what it was
 * asked for. Those that were never recorded — made before this index existed, or
 * while the tool could not say whose they were — are found by looking in exactly those folders (see
 * scanFolders): the folders of the chats, the agents' homes and the projects, and in them
 * only `generated-images`. A file is only ever opened and served through the
 * same checks the Files panel's pictures have — a path inside the folder, no
 * link followed out of it, and what the bytes say it is.
 *
 * What goes from the list when a file does: a picture whose file is gone — the
 * Files panel took it, or somebody did by hand — is dropped the next time the
 * page looks, and so is one that could not be served, such as one whose folder
 * has become a link out of the place it is in. The pictures of a chat stay when
 * the chat goes, as pictures of its folder (see keepChatPictures): the files are in
 * a folder that is not the chat's to take away, and the folder is kept with them
 * for Media to look in.
 */

/** Where the agent's tools put what they make, inside the chat's folder, so that it does not mix with the work. */
export const GENERATED_DIR = "generated-images";

/** Made on the page; made by the agent in a chat; or found in a folder the agent's tools write into, with no chat that could be named for it. */
export type PictureOrigin = MediaOrigin;
/** Made from a description, changed from another picture, put in by the person to be changed, or found with nothing to tell how it was made. */
export type PictureKind = "generated" | "edited" | "uploaded" | "unknown";

/** What a picture was asked for with, as far as it is known. */
export interface PictureParams {
  model?: string;
  size?: string;
  outputFormat?: OutputFormat;
  outputCompression?: number;
  /** The settings that only stable-diffusion.cpp's server reads (see image-settings.ts). */
  negativePrompt?: string;
  seed?: number;
  sampleSteps?: number;
  strength?: number;
  /** The edit, or the new picture made from references, started from noise, with its pictures as references only. */
  fromNoise?: boolean;
  /** Fields an older version of the page sent as they were typed, which is not done any more: kept to show what the picture was made with. */
  extra?: Record<string, ExtraValue>;
  /** An edit's pictures in the order they were given, by their ids here: the first is the one it is `from`. Those that are not in the list are not here either. */
  sources?: string[];
  /** The edit had a mask. The mask itself is not kept. */
  masked?: boolean;
  /**
   * A new picture's references, in the order they were given, by their ids here: it was made from a description and
   * these pictures, and none of them is what it was changed from. Those that are not in the list are not here either.
   */
  references?: string[];
}

/** A picture as the page is told of it. */
export interface GalleryPicture {
  id: string;
  origin: PictureOrigin;
  /** The chat that made it, for the agent's pictures. */
  chat: { id: string; title: string } | null;
  /** The folder it was found in, for a picture of the folder: Home, an agent's name, or the name of the project or folder. */
  folder: { name: string; home: boolean } | null;
  kind: PictureKind;
  prompt: string;
  params: PictureParams;
  /** The picture an edit was made from, when that one is in the list. */
  from: string | null;
  createdAt: number;
  bytes: number;
  /** What a download is called. */
  fileName: string;
  /** The tiles show a small copy of it, which Media makes when it is first asked for (see image-thumbs.ts), instead of the file. */
  thumb: boolean;
}

interface Row {
  id: string;
  origin: PictureOrigin;
  session_id: string | null;
  /** For a picture of a folder: the folder, as the portal knows it. A chat's picture has its chat's. */
  folder: string | null;
  path: string;
  kind: PictureKind;
  prompt: string;
  params: string;
  source_id: string | null;
  bytes: number;
  created_at: number;
  /** For a chat's picture: the real folder of the chat when it was recorded, which it is kept in when the chat goes. */
  chat_folder: string | null;
}

/** Where the page's own pictures are kept. */
export const imagesDir = (): string => path.join(portal().dataDir(), "images");

/** The params a row holds, kept to the fields that are known: what is in the database is the portal's own, but only as far as it is read back. */
function readParams(text: string): PictureParams {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") raw = parsed;
  } catch {
    // Unreadable is as good as nothing said.
  }
  const params: PictureParams = {};
  if (typeof raw.model === "string" && raw.model) params.model = raw.model;
  if (typeof raw.size === "string" && raw.size) params.size = raw.size;
  if (typeof raw.outputFormat === "string" && (OUTPUT_FORMATS as readonly string[]).includes(raw.outputFormat)) params.outputFormat = raw.outputFormat as OutputFormat;
  if (typeof raw.outputCompression === "number" && Number.isFinite(raw.outputCompression)) params.outputCompression = raw.outputCompression;
  if (typeof raw.negativePrompt === "string" && raw.negativePrompt) params.negativePrompt = raw.negativePrompt;
  if (typeof raw.seed === "number" && Number.isSafeInteger(raw.seed)) params.seed = raw.seed;
  if (typeof raw.sampleSteps === "number" && Number.isSafeInteger(raw.sampleSteps)) params.sampleSteps = raw.sampleSteps;
  if (typeof raw.strength === "number" && Number.isFinite(raw.strength)) params.strength = raw.strength;
  if (raw.fromNoise === true) params.fromNoise = true;
  if (raw.extra && typeof raw.extra === "object" && !Array.isArray(raw.extra)) params.extra = raw.extra as Record<string, ExtraValue>;
  if (Array.isArray(raw.sources)) params.sources = raw.sources.filter((s): s is string => typeof s === "string");
  if (raw.masked === true) params.masked = true;
  if (Array.isArray(raw.references)) params.references = raw.references.filter((s): s is string => typeof s === "string");
  return params;
}

/** What a download of a picture is called: the file's own name for the agent's, one made from the time for the page's. */
function downloadName(row: Row): string {
  if (row.origin !== "page") return path.basename(row.path);
  const stamp = new Date(row.created_at).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return `image-${stamp}-${row.id.slice(0, 4)}${path.extname(row.path)}`;
}

function shown(row: Row): GalleryPicture {
  return {
    id: row.id,
    origin: row.origin,
    chat: row.session_id ? { id: row.session_id, title: portal().chats.get(row.session_id)?.title ?? "" } : null,
    folder: row.origin === "folder" && row.folder ? folderLabel(row.folder) : null,
    kind: row.kind,
    prompt: row.prompt,
    params: readParams(row.params),
    from: row.source_id,
    createdAt: row.created_at,
    bytes: row.bytes,
    fileName: downloadName(row),
    thumb: wantsThumb(row.bytes, downloadName(row)),
  };
}

const rowById = (id: string): Row | undefined => getDb().prepare("SELECT * FROM images WHERE id = ?").get(id) as Row | undefined;

/**
 * A picture of the list by its id. One of a chat that was deleted while Media was not running, which it was not
 * told of, is kept as a picture of its folder first, as the look from the top keeps it (see pruneMissing): what is
 * opened or deleted before that look is the picture of the folder it is in.
 */
function rowOf(id: string): Row | undefined {
  const row = rowById(id);
  if (!row?.session_id || portal().chats.get(row.session_id)) return row;
  keepChatPictures(row.session_id);
  return rowById(id);
}

const WHAT = "picture";
/** Where the page's own pictures are, and where the agent's tools put theirs: how a row's file is found (see media-folders.ts). */
const locate = (row: Row, folders: Map<string, string | Error> = new Map()) => locateRow(row, { own: imagesDir(), generated: GENERATED_DIR, what: WHAT }, folders);

/**
 * Whether a picture's folder is only out of reach for the moment: a folder on a
 * drive that is not mounted, or one that was renamed away. Its pictures are not
 * gone, and what looks at them leaves them in the list. A chat that is gone is
 * another thing. A picture that was found has no chat to lose it with, and is
 * found again when its folder is back, so it is not kept: only what was recorded
 * is, and with it what a kept picture was asked for, which a scan cannot give it
 * back, or the edits that were made of it (see forgetPicturesIn for a folder the
 * portal removed). A folder that is there and has lost the file is a picture that
 * is gone.
 */
function unreachable(row: Row, e: unknown): boolean {
  if (refusalOf(e) !== "missing" || e instanceof ChatGone) return false;
  if (row.origin === "chat") return true;
  return row.origin === "folder" && (row.prompt !== "" || row.params !== "{}" || row.source_id !== null || !!getDb().prepare("SELECT 1 FROM images WHERE source_id = ? LIMIT 1").get(row.id));
}

/** Whether a picture is still to be shown: its file is there as a plain file, or its folder is out of reach and it may be. */
function isThere(row: Row, folders: Map<string, string | Error>): boolean {
  let at: { base: string; rel: string };
  try {
    at = locate(row, folders);
  } catch (e) {
    return unreachable(row, e);
  }
  try {
    // The folder part goes the way serving goes: a link in it that leads out of the folder is a picture that cannot be served, and is not there. The file itself is looked at as it is, so that a link is none.
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
    .prepare("INSERT OR IGNORE INTO images (id, origin, session_id, folder, path, kind, prompt, params, source_id, bytes, created_at, chat_folder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.origin, row.session_id, row.folder, row.path, row.kind, row.prompt, row.params, row.source_id, row.bytes, row.created_at, row.chat_folder);

/** Puts a picture the page made, or was given, in the page's own folder and in the list. */
export function addPagePicture(picture: { bytes: Buffer; ext: string; kind: PictureKind; prompt: string; params: PictureParams; sourceId?: string }): GalleryPicture {
  const id = newId();
  mkdirSync(imagesDir(), { recursive: true });
  // Written the way every file the portal makes is: beside its place first, never over anything, and only inside the folder.
  const rel = portal().files.create(baseDir(imagesDir()), "", `${id}.${picture.ext}`, picture.bytes);
  const row: Row = {
    id,
    origin: "page",
    session_id: null,
    folder: null,
    path: rel,
    kind: picture.kind,
    prompt: picture.prompt,
    params: JSON.stringify(picture.params),
    source_id: picture.sourceId ?? null,
    bytes: picture.bytes.length,
    created_at: Date.now(),
    chat_folder: null,
  };
  insert(row);
  return shown(row);
}

/**
 * Lists a picture the agent has just made in a chat, with what it was asked
 * for. The picture is already where the chat's folder has it; this only says
 * so, with the chat's folder as it is now, which the picture is kept in when the
 * chat goes. `from` are the pictures an edit was made from, and `references` those
 * a new picture was made with, as paths in the chat's folder: those the list knows
 * are linked, the others are not. A reference is not what the picture was changed
 * from, so it is no `source_id`.
 */
export function recordChatPicture(picture: { sessionId: string; path: string; kind: "generated" | "edited"; prompt: string; params: PictureParams; from?: string[]; references?: string[]; bytes: number }): void {
  // A picture that was made is made: that it could not be listed is not the tool's failure, and the agent has nothing to do about it.
  try {
    // Chats share a folder — every chat of a project, every one in Home — so a path names a file for all of them: the rows of the chats whose folder is this one, this chat's first. A picture that was found in this folder before it was recorded (the page looked in between) is the same file, and goes last.
    const mine = folderOf(picture.sessionId);
    const rowsOf = (file: string) => [
      ...(getDb().prepare("SELECT id, session_id FROM images WHERE origin = 'chat' AND path = ? ORDER BY (session_id = ?) DESC, created_at DESC").all(file, picture.sessionId) as { id: string; session_id: string }[])
        .filter((row) => row.session_id === picture.sessionId || (mine !== undefined && folderOf(row.session_id) === mine))
        .map((row) => row.id),
      ...(mine === undefined
        ? []
        : (getDb().prepare("SELECT id, folder FROM images WHERE origin = 'folder' AND path = ?").all(file) as { id: string; folder: string }[])
            // By where the folder really is: a row from before a link was put above it names it by the old path.
            .filter((row) => realFolderOf(row.folder) === mine)
            .map((row) => row.id)),
    ];
    const known = (file: string) => rowsOf(file)[0];
    // A file name that comes back — an edit is named after its original — is a new picture: its file was taken away by something that did not tell the list, and the old rows are not this file's.
    const before = rowsOf(picture.path);
    const ids = (paths: string[] = []) => paths.map(known).filter((id): id is string => !!id && !before.includes(id));
    const sources = ids(picture.from);
    const references = ids(picture.references);
    const first = picture.from?.[0] !== undefined ? known(picture.from[0]) : undefined;
    getDb().transaction(() => {
      if (before.length) forget(before);
      insert({
        id: newId(),
        origin: "chat",
        session_id: picture.sessionId,
        folder: null,
        path: picture.path,
        kind: picture.kind,
        prompt: picture.prompt,
        params: JSON.stringify({ ...picture.params, ...(sources.length ? { sources } : {}), ...(references.length ? { references } : {}) }),
        // The first of them, as the picture the edit is named after: only when that very one is in the list.
        source_id: first && !before.includes(first) ? first : null,
        bytes: picture.bytes,
        created_at: Date.now(),
        chat_folder: mine ?? null,
      });
    })();
  } catch (e) {
    portal().log(`images: could not list the picture in the gallery: ${(e as Error).message}`);
  }
}

/**
 * Drops what the list names that is not there to show: a file that is gone, a
 * chat that is, a path that leads out. Looked at when the list is looked at from
 * the top, which is a stat for each picture and little more. A picture that was
 * found is kept under the folder as it really is: when a link is put above its
 * folder, such as a workspace root moved to another disk, the old name and the
 * new one are the same folder, and its pictures are not listed twice.
 *
 * The pictures of a chat that was deleted while Media was not running, which it
 * was not told of, are kept as pictures of its folder first, as those of a chat
 * deleted now are (see keepChatPictures).
 */
export function pruneMissing(): number {
  const folders = new Map<string, string | Error>();
  const d = getDb();
  for (const { session_id } of d.prepare("SELECT DISTINCT session_id FROM images WHERE session_id IS NOT NULL").all() as { session_id: string }[]) {
    if (!portal().chats.get(session_id)) keepChatPictures(session_id);
  }
  const rows = d.prepare("SELECT * FROM images").all() as Row[];
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
      // Taken from the list when the same file is already a picture of that folder.
      if (real !== row.folder && !d.prepare("UPDATE OR IGNORE images SET folder = ? WHERE id = ?").run(real, row.id).changes) gone.push(row.id);
    }
  }
  if (gone.length) forget(gone);
  return gone.length;
}

/** The most files of one folder that are looked through: a folder with more is not one the tools have been filling. */
const MAX_LOOKED_AT = 5_000;

/** What a file that is no picture looked like when it was looked at, so that it is not opened again until it changes. Kept to no more than this, and started again beyond it. */
const refused = new Map<string, string>();
const MAX_REFUSED = 10_000;

/** What a file is, by its name: the tools name what they make by the time, and an edit after its original. */
function kindByName(name: string): PictureKind {
  if (/-edited(?: \(\d+\))?\.[^.]+$/.test(name)) return "edited";
  if (/^image-\d{8}-\d{6}-[0-9a-f]{6}(?: \(\d+\))?\.[^.]+$/.test(name)) return "generated";
  return "unknown";
}

/**
 * Whether the file `name` of the `generated-images` folder of `real` is a picture
 * to list, and then its size and time. It is opened as serving one opens it, so
 * that nothing is listed that could not be shown. A file that is no picture is
 * not opened again until it changes. One that went since the folder was read, or
 * cannot be read, is no picture for now.
 */
function pictureAt(real: string, name: string): { size: number; mtimeMs: number } | undefined {
  const rel = `${GENERATED_DIR}/${name}`;
  const file = path.join(real, rel);
  try {
    const { size, mtimeMs } = lstatSync(file);
    const stamp = `${size}:${mtimeMs}`;
    if (refused.get(file) === stamp) return undefined;
    try {
      const opened = openPicture(real, rel);
      try {
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
 * Lists the pictures that lie in the folders the tools write into and were never
 * recorded: those made before the gallery kept an index, or while the tool could
 * not say whose they were. Only the folder
 * `generated-images` of the folders the portal knows (see knownFolders) is
 * looked in, and in it only plain files: no link is followed, and what is
 * listed is what its bytes show to be a PNG, JPEG, GIF or WebP not over the size
 * a picture may have, the check that serving one makes again. A file that is
 * listed already, as a chat's picture or as found before, is not opened, and
 * neither is one that was found not to be a picture, until it changes: a pass
 * over hundreds of pictures is a read of the folders' names. What is found is a
 * picture of its folder, with the kind its name tells, as which chat made it
 * cannot be: chats share a folder, and the one that did may be gone. Returns
 * how many were added.
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
    for (const row of d.prepare("SELECT origin, session_id, folder, path FROM images WHERE origin != 'page'").all() as Pick<Row, "origin" | "session_id" | "folder" | "path">[]) {
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
    for (const real of knownFolders("images")) {
      let names: string[];
      try {
        const dir = path.join(real, GENERATED_DIR);
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
        const rel = `${GENERATED_DIR}/${name}`;
        if (listedFiles().has(key(real, rel))) continue;
        const found = pictureAt(real, name);
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
          source_id: null,
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

/** Takes pictures from the list, and what pointed at them from the edits made of them. The files are not touched. */
function forget(ids: string[]): void {
  const d = getDb();
  // Each statement once for all the pictures: what was made of a picture is found by its index, not by a pass over the gallery.
  const remove = d.prepare("DELETE FROM images WHERE id = ?");
  const unlink = d.prepare("UPDATE images SET source_id = NULL WHERE source_id = ?");
  d.transaction(() => {
    for (const id of ids) {
      remove.run(id);
      unlink.run(id);
    }
  })();
  removeThumbs(ids);
}

/**
 * Takes the pictures of a folder that was removed from the list: those of every
 * chat that worked in it, routine runs included, which are kept when a project
 * is deleted, and those that were found in it, or kept from a chat that is gone.
 * A folder that is gone for good cannot be told from a drive that is not
 * mounted, which keeps its pictures, so the portal says it when it is the one
 * that removed the folder (`portal.folders.on("removed")`), by where it really
 * was: the folders the rows keep are real paths as well. The files went with the folder.
 */
export function forgetPicturesIn(dir: string): number {
  const rows = getDb().prepare("SELECT id, folder, chat_folder FROM images WHERE folder IS NOT NULL OR chat_folder IS NOT NULL").all() as Pick<Row, "id" | "folder" | "chat_folder">[];
  const gone = rows.filter((row) => [row.folder, row.chat_folder].some((folder) => folder !== null && isWithinText(dir, folder))).map((row) => row.id);
  if (gone.length) forget(gone);
  return gone.length;
}

/**
 * Keeps the pictures of a chat that was deleted as pictures of its folder, with
 * what they were asked for: the files stay in the chat's folder, which is not the
 * chat's to take away. The folder is the one the chat had when each was recorded,
 * as the chat cannot be asked for it once it is gone, where it really is now. Those
 * that cannot be kept (no folder was known, it cannot be reached, or the same file
 * is a picture of that folder already) go, and what was made of them no longer
 * names them.
 */
export function keepChatPictures(sessionId: string): void {
  const d = getDb();
  for (const { chat_folder } of d.prepare("SELECT DISTINCT chat_folder FROM images WHERE session_id = ? AND chat_folder IS NOT NULL").all(sessionId) as { chat_folder: string }[]) {
    // A folder that cannot be reached is not one to keep pictures of: there is nothing to find them in.
    const real = realFolderOf(chat_folder);
    if (real) d.prepare("UPDATE OR IGNORE images SET origin = 'folder', folder = ?, chat_folder = NULL, session_id = NULL WHERE session_id = ? AND chat_folder = ?").run(real, sessionId, chat_folder);
  }
  const left = (d.prepare("SELECT id FROM images WHERE session_id = ?").all(sessionId) as { id: string }[]).map((row) => row.id);
  if (left.length) forget(left);
}

export interface ListQuery {
  origin?: PictureOrigin;
  kind?: PictureKind;
  /** The `next` of the page before. */
  before?: string;
  limit?: number;
  /**
   * A page that asks again for the top of a list it has, as on a timer: the look
   * through the files is not made again within LOOK_AGAIN_MS of the last one.
   * What the tools save is listed when it is saved, so only a file put there
   * some other way waits for it; opening the page and its Refresh button look at once.
   */
  again?: boolean;
}

export const DEFAULT_PAGE = 48;
export const MAX_PAGE = 100;

/** How long a page that asks again is told what the last look found: the look is a stat for each picture and a read of every folder. */
export const LOOK_AGAIN_MS = 60_000;
let lastLook = 0;

/** A page of the list, newest first, the next one's start, and what there is in all. */
export function listPictures(query: ListQuery = {}): { pictures: GalleryPicture[]; next: string | null; total: number; pageBytes: number } {
  // The whole list is looked at when it is looked at from the top, not once for every page of it. What is gone goes first, then what has come that nobody listed.
  if (!query.before && !(query.again && Date.now() - lastLook < LOOK_AGAIN_MS)) {
    lastLook = Date.now();
    pruneMissing();
    try {
      scanFolders();
    } catch (e) {
      // A gallery that cannot look in the folders is still a gallery.
      portal().log(`images: could not look through the folders for pictures: ${(e as Error).message}`);
    }
  }
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (query.origin) {
    where.push("images.origin = ?");
    args.push(query.origin);
  }
  if (query.kind) {
    where.push("images.kind = ?");
    args.push(query.kind);
  }
  const d = getDb();
  const counted = d.prepare(`SELECT COUNT(*) AS n FROM images${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`).get(...args) as { n: number };
  const pageBytes = (d.prepare("SELECT COALESCE(SUM(bytes), 0) AS n FROM images WHERE origin = 'page'").get() as { n: number }).n;
  const cursor = /^(\d+):([0-9a-f]+)$/.exec(query.before ?? "");
  if (cursor) {
    where.push("(images.created_at < ? OR (images.created_at = ? AND images.id < ?))");
    args.push(Number(cursor[1]), Number(cursor[1]), cursor[2]);
  }
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(query.limit ?? DEFAULT_PAGE)));
  const rows = d
    .prepare(`SELECT * FROM images${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY images.created_at DESC, images.id DESC LIMIT ?`)
    .all(...args, limit + 1) as Row[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    pictures: page.map(shown),
    next: rows.length > limit && last ? `${last.created_at}:${last.id}` : null,
    total: counted.n,
    pageBytes,
  };
}

/** Some pictures by their ids, as far as they are in the list: what an edit's original is, to be reached from it. */
export function picturesById(ids: string[]): GalleryPicture[] {
  return ids.map(rowOf).filter((row): row is Row => !!row).map(shown);
}

/**
 * A picture opened to be sent: the descriptor, its size and its type, from
 * the same check a picture in the Files panel gets. A file that is gone, or
 * that has become something that is no picture, is not served, and is taken
 * from the list.
 */
export function openListed(id: string): { fd: number; size: number; name: string; mimeType: string; origin: PictureOrigin } {
  const row = rowOf(id);
  if (!row) throw new FileError("missing", "There is no such picture");
  let at: { base: string; rel: string };
  try {
    at = locate(row);
  } catch (e) {
    // Out of reach is not gone: the picture is shown again when its folder is back.
    if (refusalOf(e) === "missing" && !unreachable(row, e)) forget([id]);
    throw e;
  }
  try {
    return { ...openPicture(at.base, at.rel), origin: row.origin };
  } catch (e) {
    if (refusalOf(e) === "missing") forget([id]);
    throw e;
  }
}

/**
 * The small copy of a picture, opened to be sent the way the picture is: made now when there is
 * none for the file as it is. A picture that gets no copy (a small file, a GIF) is sent whole.
 * Whoever may open the picture may have its copy, and nobody else: it is opened as the picture is.
 */
export async function openListedThumb(id: string): Promise<ReturnType<typeof openListed>> {
  const whole = openListed(id);
  return { ...(await openThumb(whole, id, () => !!rowOf(id))), origin: whole.origin };
}

/** The bytes of a picture, for an edit that starts from it; same checks as serving one. */
export function readListed(id: string): { bytes: Buffer; picture: GalleryPicture } {
  const row = rowOf(id);
  if (!row) throw new FileError("missing", "There is no such picture");
  const { base, rel } = locate(row);
  return { bytes: readPicture(base, rel).bytes, picture: shown(row) };
}

/**
 * Takes a picture away: its file, and its place in the list. A picture in a
 * chat's folder is that chat's file, so this is only ever asked for on
 * purpose, by the person (see the page's confirmation). A file that is gone
 * already is as good as deleted. A folder that cannot be reached is not: the
 * file may well be in it, so this says so and leaves the picture in the list.
 */
export async function deletePicture(id: string): Promise<void> {
  if (!rowById(id)) throw new FileError("missing", "There is no such picture");
  const row = rowOf(id);
  // Its chat went while Media was not told, with no folder to keep it in: it went from the list, and nothing is left of it to delete.
  if (!row) return;
  const missing = (e: unknown) => refusalOf(e) === "missing";
  let at: { base: string; rel: string } | undefined;
  try {
    at = locate(row);
  } catch (e) {
    // Its chat is gone: nothing is left of it to delete. Out of reach is something else, for a picture that was found as for a chat's: its folder cannot be reached, and the file may be in it.
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
