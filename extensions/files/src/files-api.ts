import { isApiError, portal, t } from "./portal";

/**
 * The portal's routes for a chat's folder, which Files is drawn on: listing,
 * reading, writing, uploading, renaming, deleting and downloading. They are
 * the portal's own and any extension's to use (see the API reference): the
 * portal decides what is inside a chat's folder and reads and writes it
 * safely, whoever draws it.
 */

/** One thing in a chat's folder. "link" leads out of it, or nowhere, and is left alone. */
export interface FileEntry {
  name: string;
  type: "dir" | "file" | "link";
  /** A link, whatever `type` says: one to a folder in this one is a "dir", but deleting it removes only the link. */
  link?: boolean;
  size: number;
  mtime: number;
}

/** A file as Files shows it: its text, or the fact that it has none to show. */
export type FileContent = { binary: true; size: number; mtime: number } | { binary: false; size: number; mtime: number; content: string };

/** What a delete would lose that only the folder has: nothing else has a copy of these. */
export interface Unsaved {
  /** Changes that are not committed. */
  changed: number;
  /** Commits that no remote has. */
  unpushed: number;
  stashes: number;
  /** Not everything could be read, so there may be more than this says. */
  unknown?: true;
}

const at = (sessionId: string, route: string, path: string, more = "") =>
  `/api/sessions/${encodeURIComponent(sessionId)}/${route}?path=${encodeURIComponent(path)}${more}`;

export const api = {
  listFiles: (sessionId: string, dir: string) => portal.api.json<{ path: string; entries: FileEntry[]; truncated: boolean }>(at(sessionId, "files", dir)),
  readFile: (sessionId: string, file: string) => portal.api.json<FileContent>(at(sessionId, "file", file)),
  /** `mtime` is the time the text on screen was read at; the save is refused if the file has changed since. */
  saveFile: (sessionId: string, file: string, content: string, mtime?: number) =>
    portal.api.json<{ ok: true; size: number; mtime: number }>(at(sessionId, "file", file), { method: "PUT", body: JSON.stringify({ content, mtime }) }),
  /** Gives a file or folder another name in the same folder; answers with its new path. */
  renameFile: (sessionId: string, file: string, name: string) =>
    portal.api.json<{ ok: true; path: string }>(at(sessionId, "file", file), { method: "PATCH", body: JSON.stringify({ name }) }),
  /** A new, empty file; refused if something already has the name. */
  createFile: (sessionId: string, file: string) =>
    portal.api.json<{ ok: true; size: number; mtime: number }>(at(sessionId, "file", file), { method: "PUT", body: JSON.stringify({ content: "", create: true }) }),
  createFolder: (sessionId: string, dir: string, name: string) =>
    portal.api.json<{ ok: true; path: string }>(at(sessionId, "folder", dir), { method: "POST", body: JSON.stringify({ name }) }),
  /**
   * A file from this computer into the chat's folder, as it is. A taken name
   * gets a number rather than replacing anything; the answer says what it is called.
   */
  uploadFile: async (sessionId: string, dir: string, file: File): Promise<{ path: string; size: number }> => {
    try {
      return await portal.api.json(at(sessionId, "upload", dir, `&name=${encodeURIComponent(file.name)}`), {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
    } catch (e) {
      // The server's words when it has any; otherwise which file, and why.
      if (isApiError(e) && typeof e.body.error !== "string") throw new portal.api.ApiError(t("Could not upload {name} ({status})", { name: file.name, status: e.status }), e.status, e.body);
      throw e;
    }
  },
  /** What deleting `file` would lose that nothing else has (see Unsaved), null for nothing. */
  fileUnsaved: (sessionId: string, file: string) => portal.api.json<{ unsaved: Unsaved | null }>(at(sessionId, "unsaved", file)),
  /** `discard` says that git work in a folder, which nothing else has, may go with it; without it the server refuses, with code "unsaved-work". */
  deleteFile: (sessionId: string, file: string, discard = false) =>
    portal.api.json<{ ok: true }>(at(sessionId, "file", file, discard ? "&discard=1" : ""), { method: "DELETE" }),
  fileDownloadUrl: (sessionId: string, file: string) => at(sessionId, "file", file, "&download=1"),
  /** The whole folder, or a folder in it. */
  archiveDownloadUrl: (sessionId: string, dir = "") =>
    `/api/sessions/${encodeURIComponent(sessionId)}/archive${dir ? `?path=${encodeURIComponent(dir)}` : ""}`,
  /** A picture in the chat's folder, by its path there. `version` is anything that changes when the file does. */
  pictureUrl: (sessionId: string, path: string, version?: string | number) => at(sessionId, "picture", path, version === undefined ? "" : `&v=${encodeURIComponent(String(version))}`),
};
