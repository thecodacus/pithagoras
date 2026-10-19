import { closeSync } from "node:fs";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import { mediaTypeAt } from "./output-files.js";
import {
  folderIdentity,
  folderPath,
  listDir,
  makeFolder,
  openFile,
  readBytes,
  readText,
  removeEntry,
  removeFile,
  renameEntry,
  renameFile,
  resolveInside,
  saveNewFile,
  sweepTemp,
  unsavedAt,
  writeText,
} from "./workspace-files.js";

/**
 * `portal.files`: a chat's folder read and changed by the portal's own code
 * (workspace-files.ts), for every server half. The agent writes in that
 * folder, links included, and a server half runs in the portal's process with
 * the portal's rights: see "A chat's folder" in the guide.
 *
 * Its own file so that what tests an extension's server half can be given the
 * real one without loading the rest of the portal.
 */
export const folderFiles: ServerPortal["files"] = {
  inside: (base, rel) => resolveInside(base, rel),
  list: (base, rel, options = {}) => listDir(base, rel, options),
  read: (base, rel, options = {}) => readText(base, rel, options),
  readBytes: (base, rel, options = {}) => readBytes(base, rel, options),
  write: (base, rel, content, options = {}) =>
    writeText(base, rel, content, options.expected, options.create === true, { direct: options.direct, likeParent: options.likeParent, chats: options.chats }),
  rename: (base, rel, name) => renameEntry(base, rel, name),
  unsaved: (base, rel) => unsavedAt(base, rel),
  remove: (base, rel, options = {}) => removeEntry(base, rel, options.discard === true),
  removeFile: (base, rel, options = {}) => removeFile(base, rel, options),
  renameFile: (base, rel, name, options = {}) => renameFile(base, rel, name, options),
  makeFolder: (base, rel, name, options = {}) => makeFolder(base, rel, name, options),
  folder: (base, rel, options = {}) => folderPath(base, rel, options),
  identity: (base, rel, options = {}) => folderIdentity(base, rel, options),
  sweepTemp: (base, rel, options = {}) => sweepTemp(base, rel, options.olderThanMs, { likeParent: options.likeParent, chats: options.chats }),
  // What it is by its bytes, for the half to decide what it takes.
  open: (base, rel, options = {}) => {
    const opened = openFile(base, rel, options);
    try {
      const mimeType = mediaTypeAt(opened.fd);
      return mimeType ? { ...opened, mimeType } : opened;
    } catch (e) {
      closeSync(opened.fd);
      throw e;
    }
  },
  create: (base, rel, name, data) => saveNewFile(base, rel, name, data),
};
