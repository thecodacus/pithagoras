import type { ServerPortal } from "@pithagoras/extension-api/server";
import {
  folderPath,
  holdForReading,
  listDir,
  makeFolder,
  openFile,
  readBytes,
  readText,
  removeEntry,
  renameEntry,
  resolveInside,
  sweepTemp,
  unsavedAt,
  uploadStream,
  watchFolder,
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
    writeText(base, rel, content, options.expected, options.create === true, { direct: options.direct, likeParent: options.likeParent }),
  rename: (base, rel, name) => renameEntry(base, rel, name),
  unsaved: (base, rel) => unsavedAt(base, rel),
  remove: (base, rel, options = {}) => removeEntry(base, rel, options.discard === true),
  makeFolder: (base, rel, name) => makeFolder(base, rel, name),
  folder: (base, rel, options = {}) => folderPath(base, rel, options),
  hold: (base, rel, options = {}) => holdForReading(base, rel, options),
  sweepTemp: (base, rel, options = {}) => sweepTemp(base, rel, options.olderThanMs, { likeParent: options.likeParent }),
  open: (base, rel, options = {}) => openFile(base, rel, options),
  upload: (base, rel, name, body, options = {}) => uploadStream(base, rel, name, body, options),
  watch: (base, rel, onChange, options = {}) => watchFolder(base, rel, onChange, options),
};
