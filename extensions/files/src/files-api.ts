import { isApiError, portal, t } from "./portal";

/**
 * What Files asks of a chat's folder: its own server half's routes for
 * listing, reading, saving, renaming, deleting and downloading (src/server.ts,
 * on the portal's `portal.files`), and the portal's own for uploading and for
 * pictures, which its message box and its conversation use as well.
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

/** A route of the portal's own for a chat's folder. */
const at = (sessionId: string, route: string, path: string, more = "") =>
  `/api/sessions/${encodeURIComponent(sessionId)}/${route}?path=${encodeURIComponent(path)}${more}`;
/** A route of Files' own server half. */
const own = (sessionId: string, route: string, path: string, more = "") =>
  portal.api.url(`/chats/${encodeURIComponent(sessionId)}/${route}?path=${encodeURIComponent(path)}${more}`);

export const api = {
  listFiles: (sessionId: string, dir: string) => portal.api.json<{ path: string; entries: FileEntry[]; truncated: boolean }>(own(sessionId, "files", dir)),
  readFile: (sessionId: string, file: string) => portal.api.json<FileContent>(own(sessionId, "file", file)),
  /** The file if it is not as `known` says (its time and size when it was read), otherwise only that it is: its text is not sent again. */
  readFileIfChanged: (sessionId: string, file: string, known: { mtime: number; size: number }) =>
    portal.api.json<FileContent | { unchanged: true }>(own(sessionId, "file", file, `&since=${known.mtime}&size=${known.size}`)),
  /** `mtime` is the time the text on screen was read at; the save is refused if the file has changed since. */
  saveFile: (sessionId: string, file: string, content: string, mtime?: number) =>
    portal.api.json<{ ok: true; size: number; mtime: number }>(own(sessionId, "file", file), { method: "PUT", body: JSON.stringify({ content, mtime }) }),
  /** Gives a file or folder another name in the same folder; answers with its new path. */
  renameFile: (sessionId: string, file: string, name: string) =>
    portal.api.json<{ ok: true; path: string }>(own(sessionId, "file", file), { method: "PATCH", body: JSON.stringify({ name }) }),
  /** A new, empty file; refused if something already has the name. */
  createFile: (sessionId: string, file: string) =>
    portal.api.json<{ ok: true; size: number; mtime: number }>(own(sessionId, "file", file), { method: "PUT", body: JSON.stringify({ content: "", create: true }) }),
  createFolder: (sessionId: string, dir: string, name: string) =>
    portal.api.json<{ ok: true; path: string }>(own(sessionId, "folder", dir), { method: "POST", body: JSON.stringify({ name }) }),
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
  fileUnsaved: (sessionId: string, file: string) => portal.api.json<{ unsaved: Unsaved | null }>(own(sessionId, "unsaved", file)),
  /** `discard` says that git work in a folder, which nothing else has, may go with it; without it the server refuses, with code "unsaved-work". */
  deleteFile: (sessionId: string, file: string, discard = false) =>
    portal.api.json<{ ok: true }>(own(sessionId, "file", file, discard ? "&discard=1" : ""), { method: "DELETE" }),
  fileDownloadUrl: (sessionId: string, file: string) => own(sessionId, "file", file, "&download=1"),
  /** The whole folder, or a folder in it. */
  archiveDownloadUrl: (sessionId: string, dir = "") => portal.api.url(`/chats/${encodeURIComponent(sessionId)}/archive${dir ? `?path=${encodeURIComponent(dir)}` : ""}`),
  /** A picture in the chat's folder, by its path there. `version` is anything that changes when the file does. */
  pictureUrl: (sessionId: string, path: string, version?: string | number) => at(sessionId, "picture", path, version === undefined ? "" : `&v=${encodeURIComponent(String(version))}`),
};

/** A file tree another extension gave Files (see src/sources.ts), shown as a root beside the chat's folder. */
export interface SourceInfo {
  id: string;
  label: string;
  /** Whether the file view may save in it; without, it is read-only. */
  writable: boolean;
}

/** A route of one source, at Files' own server half: its paths are its own, never the chat folder's. */
const ofSource = (sessionId: string, source: string, route: string, path: string, more = "") =>
  portal.api.url(`/chats/${encodeURIComponent(sessionId)}/sources/${encodeURIComponent(source)}/${route}?path=${encodeURIComponent(path)}${more}`);

/** The sources there are for this chat, as the person at this page may see them. */
export const listSources = (sessionId: string) => portal.api.json<{ sources: SourceInfo[] }>(portal.api.url(`/chats/${encodeURIComponent(sessionId)}/sources`));

/**
 * What the file view asks of the tree it shows, whichever it is: the chat's folder or one source. Each has its own paths, so a path
 * from one is only ever asked of that one.
 */
export interface Reader {
  list(dir: string): Promise<{ path: string; entries: FileEntry[]; truncated: boolean }>;
  read(file: string): Promise<FileContent>;
  /** A cheap look at whether the file is as it was known: only where the tree can tell without sending it (the chat's folder, by a stat). A source cannot, so the file is not watched. */
  readIfChanged?(file: string, known: { mtime: number; size: number }): Promise<FileContent | { unchanged: true }>;
  save(file: string, content: string, mtime?: number): Promise<{ ok: true; size: number; mtime: number }>;
  downloadUrl(file: string): string;
}

export const folderReader = (sessionId: string): Reader => ({
  list: (dir) => api.listFiles(sessionId, dir),
  read: (file) => api.readFile(sessionId, file),
  readIfChanged: (file, known) => api.readFileIfChanged(sessionId, file, known),
  save: (file, content, mtime) => api.saveFile(sessionId, file, content, mtime),
  downloadUrl: (file) => api.fileDownloadUrl(sessionId, file),
});

export const sourceReader = (sessionId: string, source: string): Reader => ({
  list: (dir) => portal.api.json(ofSource(sessionId, source, "files", dir)),
  read: (file) => portal.api.json(ofSource(sessionId, source, "file", file)),
  save: (file, content, mtime) => portal.api.json(ofSource(sessionId, source, "file", file), { method: "PUT", body: JSON.stringify({ content, mtime }) }),
  downloadUrl: (file) => ofSource(sessionId, source, "file", file, "&download=1"),
});
