/**
 * The Documents extension's server half: loaded once by the portal, for all chats.
 *
 * A document is a Markdown file in the `documents` folder of a folder chats
 * work in, where Files lists it and the agent can read it. This half finds
 * them for the page, which has no chat of its own to ask:
 *
 *   GET /api/x/pithagoras-docs/folders                          every folder with documents, and its documents
 *   GET /api/x/pithagoras-docs/folders/:folder/documents/:name  one document's Markdown
 *
 * The page names a folder by an id made from its path, never by the path: a
 * folder is only one that a chat works in, as the portal lists them now.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import path from "node:path";

const DOCUMENTS = "documents";
/** A document is read whole, so a file bigger than this is not one. */
const MAX_BYTES = 1024 * 1024;
/** The listing is bounded by work, not only by its answer: each document listed is a file opened. */
const MAX_LISTED = 1000;
/** Where a document's title is looked for: its first heading, near its top. */
const HEAD_BYTES = 4096;

const idOf = (folder) => createHash("sha256").update(folder).digest("hex").slice(0, 16);
const isDocumentName = (name) => typeof name === "string" && name.toLowerCase().endsWith(".md") && !name.startsWith(".") && !/[/\\\0]/.test(name);

/** The first heading of a Markdown text, or nothing. A `#` line in a code block is a comment, not a heading. */
function headingOf(text) {
  let fence = null;
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    const heading = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line.replace(/\r$/, ""));
    if (heading) return heading[1].trim();
  }
  return "";
}

export default function (portal) {
  /** The folders chats work in now, by id, with the chats that work in each. */
  function folders() {
    const found = new Map();
    for (const chat of portal.chats.list()) {
      let folder;
      try {
        folder = portal.chats.folder(chat.id);
      } catch {
        // Its folder is gone: there are no documents in it.
        continue;
      }
      const id = idOf(folder);
      if (!found.has(id)) found.set(id, { id, path: folder, chats: [] });
      found.get(id).chats.push({ id: chat.id, title: chat.title });
    }
    return found;
  }

  /** A folder's `documents` folder, checked to be inside it, or nothing when it has none. */
  function documentsDir(folder) {
    try {
      return portal.files.inside(folder, DOCUMENTS);
    } catch {
      return null;
    }
  }

  /**
   * A document's file, opened to be read: only a plain file directly in the
   * documents folder, never a link (followed or swapped in), nor a second name
   * of a file elsewhere (a hard link), nor one too big to be a document.
   * Returns the open descriptor and its stat, or nothing.
   */
  function open(dir, name) {
    if (!isDocumentName(name)) return null;
    let file;
    try {
      file = portal.files.inside(dir, name);
    } catch {
      return null;
    }
    // `inside` follows links: a link to another file in the folder comes back under that file's name.
    if (path.dirname(file) !== dir || path.basename(file) !== name) return null;
    let fd;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return null;
    }
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) {
      closeSync(fd);
      return null;
    }
    return { fd, stat };
  }

  function read(fd, bytes) {
    const buffer = Buffer.alloc(bytes);
    let at = 0;
    while (at < bytes) {
      const got = readSync(fd, buffer, at, bytes - at, at);
      if (got === 0) break;
      at += got;
    }
    return buffer.subarray(0, at).toString("utf8");
  }

  /** The documents in a folder, by title. */
  function documentsIn(folder) {
    const dir = documentsDir(folder);
    if (!dir) return [];
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && isDocumentName(entry.name))
        .map((entry) => entry.name)
        .sort()
        .slice(0, MAX_LISTED);
    } catch {
      return [];
    }
    const documents = [];
    for (const name of names) {
      const opened = open(dir, name);
      if (!opened) continue;
      try {
        const title = headingOf(read(opened.fd, Math.min(HEAD_BYTES, opened.stat.size))) || name.replace(/\.md$/i, "");
        documents.push({ name, title, size: opened.stat.size, modified: opened.stat.mtime.toISOString() });
      } finally {
        closeSync(opened.fd);
      }
    }
    return documents.sort((a, b) => a.title.localeCompare(b.title) || a.name.localeCompare(b.name));
  }

  portal.router.get("/folders", (_req, res) => {
    const list = [];
    for (const folder of folders().values()) {
      const documents = documentsIn(folder.path);
      if (documents.length) list.push({ ...folder, name: path.basename(folder.path) || folder.path, documents });
    }
    list.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    res.json({ folders: list });
  });

  portal.router.get("/folders/:folder/documents/:name", (req, res) => {
    const folder = folders().get(req.params.folder);
    const dir = folder && documentsDir(folder.path);
    const opened = dir && open(dir, req.params.name);
    if (!opened) return res.status(404).json({ error: "There is no such document" });
    try {
      const markdown = read(opened.fd, opened.stat.size);
      res.json({ name: req.params.name, title: headingOf(markdown) || req.params.name.replace(/\.md$/i, ""), markdown, modified: opened.stat.mtime.toISOString() });
    } finally {
      closeSync(opened.fd);
    }
  });
}
