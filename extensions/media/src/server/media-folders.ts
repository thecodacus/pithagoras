import { randomBytes } from "node:crypto";
import { FileError, refusalOf } from "./file-error";
import { portal } from "./host";
import { getDb } from "./store";
import { baseDir, isUnderText } from "./within";

/**
 * Where the gallery lists of generated media look for files, shared by the pictures
 * (image-gallery.ts) and the clips (video-gallery.ts): which folders the portal knows,
 * which of them a file may be served from, and how a row's file is found in one.
 *
 * Both galleries keep their rows in a table of the same shape for this: `origin`
 * (the page's own folder, a chat's, or one a file was found in), `session_id`, `folder`
 * and `path`. What differs is only the name of the table and of the folder the tools
 * write into, which the callers say.
 */

/** Made on the page; made by the agent in a chat; or found in a folder the agent's tools write into, with no chat that could be named for it. */
export type MediaOrigin = "page" | "chat" | "folder";

/** The part of a gallery row that says where its file is. */
export interface MediaRow {
  origin: MediaOrigin;
  session_id: string | null;
  /** For a file of a folder: the folder, as the portal knows it. A chat's file has its chat's. */
  folder: string | null;
  path: string;
}

export const newId = (): string => randomBytes(6).toString("hex");

/** The chat of a file is not there any more. */
export class ChatGone extends FileError {
  constructor(what: string) {
    super("missing", `The chat that made this ${what} is gone`);
  }
}

/** What a folder is called to the person, as the page shows it: Home, an agent's name, or the place of a project or folder. */
export function folderLabel(folder: string): { name: string; home: boolean } {
  const { name, home } = portal().folders.label(folder);
  return { name, home: home === true };
}

/**
 * The folder of a chat, real; the reason it is not there otherwise. What a pass
 * over many files has worked out is kept in `folders`, failures too, so that
 * a chat with a hundred files is asked about once.
 */
export function chatFolder(sessionId: string, folders: Map<string, string | Error>, what: string): string {
  let found = folders.get(sessionId);
  if (found === undefined) {
    try {
      if (!portal().chats.get(sessionId)) throw new ChatGone(what);
      found = portal().chats.folder(sessionId);
    } catch (e) {
      if (!refusalOf(e)) throw e;
      found = e as Error;
    }
    folders.set(sessionId, found);
  }
  if (typeof found !== "string") throw found;
  return found;
}

/** The real folder a chat's files are in, or nothing when it cannot be told: the chat is gone, or its folder cannot be reached. */
export function folderOf(sessionId: string): string | undefined {
  try {
    return portal().chats.folder(sessionId);
  } catch {
    return undefined;
  }
}

/** The real folder a file that was found is in, the same for all of a pass; the reason it cannot be used otherwise. */
export function foundFolder(folder: string, folders: Map<string, string | Error>, what: string): string {
  const key = `\0${folder}`;
  let found = folders.get(key);
  if (found === undefined) {
    try {
      try {
        found = baseDir(folder);
      } catch {
        throw new FileError("missing", `The folder this ${what} is in does not exist`);
      }
      if (!portal().folders.allowed(found)) throw new FileError("invalid", `That is not a folder the portal looks for ${what}s in`);
    } catch (e) {
      if (!refusalOf(e)) throw e;
      found = e as Error;
    }
    folders.set(key, found);
  }
  if (typeof found !== "string") throw found;
  return found;
}

/** The real folder a found file's folder is now, or nothing when it cannot be told. */
export function realFolderOf(folder: string): string | undefined {
  try {
    return baseDir(folder);
  } catch {
    return undefined;
  }
}

/**
 * Where a row's file is, as a folder the portal knows and a path inside it; the reason it is not anywhere that can be served otherwise.
 * `own` is the folder of the page's own files, and `generated` the folder inside a chat's folder that the agent's tools write into.
 */
export function locateRow(row: MediaRow, where: { own: string; generated: string; what: string }, folders: Map<string, string | Error> = new Map()): { base: string; rel: string } {
  const { what } = where;
  if (row.origin === "page") return { base: baseDir(where.own), rel: row.path };
  // Only what the agent's tools write: inside the folder of generated files, by where the path really goes and not by how it begins, wherever the index may have come from.
  if (!isUnderText(where.generated, row.path)) throw new FileError("invalid", `That is not a ${what} the agent made`);
  if (row.origin === "folder") {
    if (!row.folder) throw new FileError("invalid", `That is not a ${what} the agent made`);
    return { base: foundFolder(row.folder, folders, what), rel: row.path };
  }
  if (!row.session_id) throw new FileError("invalid", `That is not a ${what} the agent made`);
  return { base: chatFolder(row.session_id, folders, what), rel: row.path };
}

/**
 * The real folders the tools may have written into, each once: the folders the
 * agents work in (`portal.folders.list`: the agents' homes, the projects, the
 * folders chats work in), and those that files were found in before (`table` is
 * the gallery's). A folder that cannot be reached, or is not an agent's home or
 * inside the workspace root, is not one of them.
 */
export function knownFolders(table: "images" | "videos"): string[] {
  const found = new Set(portal().folders.list().map((folder) => folder.path));
  for (const row of getDb().prepare(`SELECT DISTINCT folder AS dir FROM ${table} WHERE folder IS NOT NULL`).all() as { dir: string }[]) {
    try {
      const real = baseDir(row.dir);
      if (portal().folders.allowed(real)) found.add(real);
    } catch {
      // Not there, or out of reach: nothing to look at.
    }
  }
  return [...found];
}
