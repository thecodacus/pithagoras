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
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import path from "node:path";
import { ensureDependencies } from "./deps.js";

const DOCUMENTS = "documents";
/** A document is read whole, so a file bigger than this is not one. */
const MAX_BYTES = 1024 * 1024;
/** The listing is bounded by work, not only by its answer: each document listed is a file opened. */
const MAX_LISTED = 1000;
/** Where a document's title is looked for: its first heading, near its top. */
const HEAD_BYTES = 4096;

const idOf = (folder) => createHash("sha256").update(folder).digest("hex").slice(0, 16);
const isDocumentName = (name) => typeof name === "string" && name.toLowerCase().endsWith(".md") && !name.startsWith(".") && !/[/\\\0]/.test(name);

/** A heading's text as the page shows it: what its inline Markdown draws, without the marks. */
function plain(text) {
  return text
    .replace(/`+([^`]*?)`+/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)(.+?)(?<=\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w_])_(?=\S)(.+?)(?<=\S)_(?!\w)/g, "$1$2")
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The first heading of a Markdown text, as plain text, or nothing: a `#` line,
 * or a paragraph underlined with `=` or `-`, as CommonMark (and so the page)
 * has them. A line in a code block is code, whatever it looks like.
 */
function headingOf(text) {
  let fence = null;
  let paragraph = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (fence) {
      // A closing fence is the opening's character, at least as many, and nothing after them.
      if (fence.test(line)) fence = null;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) {
      fence = new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}[ \\t]*$`);
      paragraph = [];
      continue;
    }
    const atx = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) {
      const title = plain(atx[1] ?? "");
      if (title) return title;
      paragraph = [];
      continue;
    }
    // Underlined: the paragraph above is the heading.
    if (paragraph.length && /^ {0,3}(=+|-+)[ \t]*$/.test(line)) {
      const title = plain(paragraph.join(" "));
      if (title) return title;
    }
    // What cannot be underlined into a heading: a blank line, a quote, a list item, a rule, a table, and code or HTML that starts a block.
    const block = !paragraph.length && (/^ {4}/.test(line) || /^ {0,3}</.test(line));
    if (block || !line.trim() || /^ {0,3}(>|[*+-](\s|$)|\d{1,9}[.)](\s|$)|\|)/.test(line) || /^ {0,3}([*_-])([ \t]*\1){2,}[ \t]*$/.test(line)) {
      paragraph = [];
      continue;
    }
    paragraph.push(line.trim());
  }
  return "";
}

/** A document's title: its first heading near its top (the first HEAD_BYTES), or else its name. Listed and read alike. */
const titleOf = (bytes, name) => headingOf(bytes.subarray(0, HEAD_BYTES).toString("utf8")) || name.replace(/\.md$/i, "");

export default function (portal, { dependencies = ensureDependencies } = {}) {
  // What it needs to run comes with the image. A folder without it (a checkout run as it is) has it installed now,
  // in the background: the portal does not wait for an install to start the rest.
  dependencies((line) => portal.log(line));

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

  /**
   * A folder's `documents` folder, or nothing when it has none. Only a folder
   * of that name itself: a link called `documents` leads to another folder of
   * the project, which is not the documents' to be listed (or, later, written).
   */
  function documentsDir(folder) {
    try {
      const dir = portal.files.inside(folder, DOCUMENTS);
      // `inside` follows links: one that was followed comes back under another path.
      if (dir !== path.join(folder, DOCUMENTS)) return null;
      return lstatSync(dir).isDirectory() ? dir : null;
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
      // Not waiting at the open: a pipe left under a document's name would hold the portal's only thread until
      // something wrote to it. It is opened at once, and refused below for not being a file.
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
    return buffer.subarray(0, at);
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
        const title = titleOf(read(opened.fd, Math.min(HEAD_BYTES, opened.stat.size)), name);
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
      const bytes = read(opened.fd, opened.stat.size);
      res.json({ name: req.params.name, title: titleOf(bytes, req.params.name), markdown: bytes.toString("utf8"), modified: opened.stat.mtime.toISOString() });
    } finally {
      closeSync(opened.fd);
    }
  });
}
