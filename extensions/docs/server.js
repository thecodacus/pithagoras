/**
 * The Documents extension's server half: loaded once by the portal, for all chats.
 *
 * A document is a Markdown file in the `documents` folder of a folder chats
 * work in, where Files lists it and the agent can read it. Each folder's
 * documents have a store (store.js): their history in a git repository of its
 * own, and a database for what is said about them, kept in the portal's data
 * folder (place.js), where no agent can change it. This half serves them to
 * the page, which has no chat of its own to ask:
 *
 *   GET  /api/x/pithagoras-docs/folders                                          every folder with documents, and its documents
 *   POST /api/x/pithagoras-docs/folders/:folder/documents                        a new document { title, markdown?, scope?, chat? }
 *   GET  /api/x/pithagoras-docs/folders/:folder/documents/:id                    one document's Markdown, and its revision
 *   PUT  /api/x/pithagoras-docs/folders/:folder/documents/:id                    saves it { markdown, base }: 409 when base is not its revision
 *   GET  /api/x/pithagoras-docs/folders/:folder/documents/:id/history            its revisions, newest first (?before=, ?limit=)
 *   GET  /api/x/pithagoras-docs/folders/:folder/documents/:id/revisions/:revision  the text of one of them
 *   POST /api/x/pithagoras-docs/folders/:folder/documents/:id/restore            { revision, base? }: that text as a new revision
 *
 * The page names a folder by an id made from its path, and a document by an
 * id the store gave it, never by a path: a folder is only one that a chat
 * works in, as the portal lists them now.
 */
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import { ensureDependencies } from "./deps.js";
import { LEGACY_STORE, placeStore } from "./place.js";
import { DocError, DOCUMENTS, isDocumentId, Store } from "./store.js";

/** Where a document's title is looked for: its first heading, near its top. */
const HEAD_BYTES = 4096;
/** A save's body: a document's Markdown (1 MB at most) written as JSON, which can take more room than the text. */
const BODY_LIMIT = "8mb";

const idOf = (folder) => createHash("sha256").update(folder).digest("hex").slice(0, 16);

/**
 * Shapes that secrets have: a private key, and the tokens of the services most
 * often pasted. A save that holds one is warned about; history keeps what is
 * saved, so it is better not saved at all.
 */
const SECRET = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abpors]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/;
const SECRET_WARNING = "This document looks like it holds a secret (a private key or a token). Its history keeps every revision: take it out, and see the guide on how to remove it from the history.";

/**
 * How far a line, and a title, is looked at. A title is one line on the page.
 * Every rule below stops at the next mark of its own kind, or walks the text
 * once, so that a document made of unclosed marks is as quick to title as any
 * other: the listing runs on the portal's only thread.
 */
const LINE_CHARS = 1024;
const TITLE_CHARS = 256;

/** The character references a title is likely to hold, and any by its number. */
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", mdash: "—", ndash: "–", hellip: "…", copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»", bull: "•" };
function decode(text) {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]{2,8}));/g, (whole, decimal, hex, name) => {
    if (name) return ENTITIES[name] ?? whole;
    const code = decimal ? Number(decimal) : parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

const isSpace = (c) => c === undefined || c === " " || (c > "~" ? /\s/.test(c) : c < " ");
const isWord = (c) => c !== undefined && (/[A-Za-z0-9_]/.test(c) || (c > "~" && /[\p{L}\p{N}]/u.test(c)));

/**
 * `text` without the pairs of `mark` that make emphasis: one that opens before
 * a non-space, and one that closes after a non-space. `_` and `*` alone also
 * need no letter outside them (snake_case is a word). One pass, left to right,
 * however long the emphasised words are.
 */
function unmark(text, mark) {
  const parts = text.split(mark);
  if (parts.length < 3) return text;
  const single = mark.length === 1;
  const opens = (at) => !isSpace(parts[at][0]) && !(single && isWord(parts[at - 1].at(-1)));
  const closes = (at) => !isSpace(parts[at - 1].at(-1)) && !(single && isWord(parts[at][0]));
  // Boundary `at` lies between parts[at - 1] and parts[at]; a pair's marks are left out.
  const dropped = new Set();
  let open = 0;
  for (let at = 1; at < parts.length; at++) {
    if (open && closes(at)) {
      dropped.add(open).add(at);
      open = 0;
    } else if (opens(at)) open = at;
  }
  let out = parts[0];
  for (let at = 1; at < parts.length; at++) out += (dropped.has(at) ? "" : mark) + parts[at];
  return out;
}

/** A heading's text as the page shows it: what its inline Markdown draws, without the marks. */
function plain(text) {
  let shown = text
    .slice(0, LINE_CHARS)
    .replace(/`+([^`]*?)`+/g, "$1")
    .replace(/<((?:https?|ftp|mailto):[^\s<>]*)>/gi, "$1")
    // A picture first, so that a picture inside a link (a badge) leaves the link to be taken off next.
    .replace(/!\[([^[\]]*)\](?:\([^()]*\)|\[[^[\]]*\])/g, "$1")
    .replace(/\[([^[\]]*)\](?:\([^()]*\)|\[[^[\]]*\])/g, "$1")
    .replace(/\[\^[^[\]]*\]/g, "")
    .replace(/<\/?[A-Za-z][^<>]*>/g, "");
  for (const mark of ["**", "__", "~~", "*", "_"]) shown = unmark(shown, mark);
  shown = shown.replace(/\\([!-/:-@[-`{-~])/g, "$1");
  return decode(shown).replace(/\s+/g, " ").trim().slice(0, TITLE_CHARS).trim();
}

/** `line` with its tabs as the spaces they stand for: to the next multiple of four columns, as CommonMark counts them. */
function untab(line) {
  if (!line.includes("\t")) return line;
  let out = "";
  for (const c of line) out += c === "\t" ? " ".repeat(4 - (out.length % 4)) : c;
  return out;
}

/** How many spaces `line` has from `from` on. */
function leading(line, from = 0) {
  let at = from;
  while (at < line.length && line[at] === " ") at++;
  return at - from;
}

/** A `#` heading's text: what follows the marks, without a closing run of `#`. Walked by hand, not by a backtracking pattern. */
function atxText(rest) {
  let end = rest.length;
  while (end > 0 && rest[end - 1] === " ") end--;
  let hashes = end;
  while (hashes > 0 && rest[hashes - 1] === "#") hashes--;
  if (hashes < end && (hashes === 0 || rest[hashes - 1] === " ")) end = hashes;
  return rest.slice(leading(rest), end);
}

/** Does `line` close the code block `fence` opened: its character, at least as many, and nothing after them. */
function closes(fence, line) {
  let at = leading(line);
  if (at > fence.indent + 3) return false;
  const start = at;
  while (at < line.length && line[at] === fence.char) at++;
  return at - start >= fence.length && !line.slice(at).trim();
}

/**
 * A line without the quotes and list items it stands in: what is in them is
 * a block of its own (a heading, a code block). `column` is where that
 * starts; `quotes` and `items` are how many of each it stands in.
 */
function unwrap(line) {
  let at = Math.min(leading(line), 3);
  let quotes = 0;
  let items = 0;
  for (;;) {
    const c = line[at];
    if (c === ">") {
      at += line[at + 1] === " " ? 2 : 1;
      // What is in a quote may be indented up to three spaces, like what is not.
      at += Math.min(leading(line, at), 3);
      quotes++;
      continue;
    }
    // A list item's marker: a bullet, or up to nine digits and a dot or a bracket; then a space, or the end of the line.
    let end = at;
    if (c === "*" || c === "+" || c === "-") end = at + 1;
    else {
      while (end < line.length && end - at < 9 && line[end] >= "0" && line[end] <= "9") end++;
      end = end > at && (line[end] === "." || line[end] === ")") ? end + 1 : at;
    }
    if (end === at || (end < line.length && line[end] !== " ")) break;
    at = end + Math.min(leading(line, end), 4);
    items++;
  }
  return { content: line.slice(at), column: at, quotes, items, inside: quotes + items > 0 };
}

/**
 * What `line` holds of the paragraph `paragraph` is in, if it goes on in the
 * same place: at the top, in as many quotes, or indented under the same list
 * item. Nothing when it does not.
 */
function within(paragraph, line, unwrapped) {
  if (paragraph.column) {
    if (leading(line) < paragraph.column) return null;
    // A list or a quote inside the item starts a block of its own.
    const rest = line.slice(paragraph.column);
    return unwrap(rest).inside ? null : rest;
  }
  if (paragraph.quotes) return unwrapped.quotes === paragraph.quotes && !unwrapped.items ? unwrapped.content : null;
  return unwrapped.inside ? null : line;
}

/** The block-level HTML tags that start an HTML block even in the middle of a paragraph (CommonMark's sixth kind). */
const BLOCK_TAGS = new Set("address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul".split(" "));

/**
 * Where an HTML block that starts on `text` ends, as CommonMark has it: the
 * text that closes it ("" for the next blank line), or nothing when `text`
 * starts no HTML block. `inParagraph`: only some kinds can interrupt one.
 */
function htmlBlock(text, inParagraph) {
  if (text[0] !== "<") return null;
  const raw = /^<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(text);
  if (raw) return `</${raw[1].toLowerCase()}>`;
  if (text.startsWith("<!--")) return "-->";
  if (text.startsWith("<?")) return "?>";
  if (text.startsWith("<![CDATA[")) return "]]>";
  if (/^<![A-Za-z]/.test(text)) return ">";
  const tag = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/.exec(text);
  if (tag && BLOCK_TAGS.has(tag[1].toLowerCase())) return "";
  // Any other tag, alone on its line, starts one too, but not inside a paragraph.
  if (!inParagraph && /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>[ \t]*$/.test(text)) return "";
  return null;
}

/** The characters a line can start a block other than a paragraph with, or underline one with. */
const STARTS_BLOCK = "#>*+-=_`~<|0123456789";

/**
 * The first heading of a Markdown text, as plain text, or nothing: a `#` line,
 * or a paragraph underlined with `=` or `-`, as CommonMark (and so the page)
 * has them, at the top or in a quote or a list item. What is in a code block,
 * an HTML block or a comment is not drawn as a heading, whatever it looks like.
 */
function headingOf(text) {
  let fence = null;
  let html = null;
  // The paragraph the lines so far make, where it is: { lines, quotes, column }.
  let paragraph = null;
  for (const raw of text.replace(/^\uFEFF/, "").split("\n")) {
    const line = untab((raw.endsWith("\r") ? raw.slice(0, -1) : raw).slice(0, LINE_CHARS));
    if (fence) {
      // A code block in a quote or a list item ends with its fence, or with the quote or the item.
      const left = fence.quoted ? !/^ {0,3}>/.test(line) : fence.inside && line.trim() !== "" && leading(line) < fence.indent;
      if (!left) {
        if (closes(fence, line) || closes(fence, unwrap(line).content)) fence = null;
        continue;
      }
      fence = null;
    }
    if (html !== null) {
      if (html === "" ? !line.trim() : line.toLowerCase().includes(html)) html = null;
      continue;
    }
    const indent = leading(line);
    if (indent === line.length) {
      paragraph = null;
      continue;
    }
    // Most lines are plain text at the top: more of the paragraph, or the start of one. Nothing else to ask of them.
    if (indent < 4 && !STARTS_BLOCK.includes(line[indent]) && (!paragraph || (!paragraph.column && !paragraph.quotes))) {
      if (paragraph) paragraph.lines.push(line.trim());
      else paragraph = { lines: [line.trim()], quotes: 0, column: 0 };
      continue;
    }
    const unwrapped = unwrap(line);
    const goesOn = paragraph && within(paragraph, line, unwrapped);
    // Underlined: the paragraph above is the heading.
    if (typeof goesOn === "string" && /^ {0,3}(=+|-+) *$/.test(goesOn)) {
      const title = plain(paragraph.lines.join(" "));
      if (title) return title;
      paragraph = null;
      continue;
    }
    // A rule, and code indented as a block of its own.
    if (("*_-".includes(line[indent]) && /^ {0,3}([*_-])( *\1){2,} *$/.test(line)) || (!paragraph && indent >= 4)) {
      paragraph = null;
      continue;
    }
    const { content, column, inside } = unwrapped;
    const opening = /^(`{3,}|~{3,})/.exec(content);
    // A run of backticks with another backtick after it is code in the line, not a block.
    if (opening && !(opening[1][0] === "`" && content.slice(opening[1].length).includes("`"))) {
      fence = { char: opening[1][0], length: opening[1].length, indent: column, inside, quoted: unwrapped.quotes > 0 };
      paragraph = null;
      continue;
    }
    const atx = /^#{1,6}(?= |$)/.exec(content);
    if (atx) {
      const title = plain(atxText(content.slice(atx[0].length)));
      if (title) return title;
      paragraph = null;
      continue;
    }
    const ends = htmlBlock(content, Boolean(goesOn));
    if (ends !== null) {
      // One that closes on the line it opens on is that line only.
      const after = content.slice(1).toLowerCase();
      if (ends !== "" && after.includes(ends)) html = null;
      else html = ends;
      paragraph = null;
      continue;
    }
    if (goesOn) {
      paragraph.lines.push(goesOn.trim());
    } else if (unwrapped.quotes && unwrapped.items) {
      // A list in a quote, or a quote in a list: not followed further. No heading is taken from a paragraph there.
      paragraph = null;
    } else {
      // A new paragraph: at the top, in a quote, or in a list item, whose later lines are indented to where its text starts.
      paragraph = { lines: [content.trim()], quotes: unwrapped.items ? 0 : unwrapped.quotes, column: unwrapped.items ? column : 0 };
    }
  }
  return "";
}

/** A document's title: its first heading near its top (the first HEAD_BYTES), or else its name. Listed and read alike. */
const titleOf = (bytes, name) => headingOf(bytes.subarray(0, HEAD_BYTES).toString("utf8")) || name.replace(/\.md$/i, "");


export default function (portal, { dependencies = ensureDependencies, faults, gitTimeoutMs } = {}) {
  // What it needs to run comes with the image. A folder without it (a checkout run as it is) has it installed now,
  // in the background: the portal does not wait for an install to start the rest. The store waits for it.
  const ready = dependencies((line) => portal.log(line));
  let Database;

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
   * the project, which is not the documents' to be listed or written.
   */
  function documentsOf(folder) {
    try {
      const dir = portal.files.inside(folder, DOCUMENTS);
      // `inside` follows links: one that was followed comes back under another path.
      return dir === path.join(folder, DOCUMENTS) && lstatSync(dir).isDirectory() ? dir : null;
    } catch {
      return null;
    }
  }

  /** Where the stores are kept: a folder of the portal's own, made when first asked for. */
  let dataFolder;
  const data = () => (dataFolder ??= portal.dataDir());

  /** Whether a folder has a store already, in the data folder or, as an earlier version kept it, in the folder itself (to be moved). */
  function hasStore(id, folder) {
    try {
      if (lstatSync(path.join(data(), id)).isDirectory()) return true;
    } catch {
      // None there: the folder's own is the other place.
    }
    try {
      lstatSync(path.join(folder, LEGACY_STORE));
      return true;
    } catch {
      return false;
    }
  }

  /** Each folder's store, opened once and kept while it is there: by the folder's path. */
  const stores = new Map();
  /** Where each store goes is settled one at a time: it looks at the others (a folder that was moved takes its store along). */
  let placing = Promise.resolve();
  const placed = (work) => (placing = placing.then(work, work));
  /** `make`: a folder without a store yet gets one. Otherwise it has no documents to read: a request names none that is there. */
  async function storeFor(folder, { make = false } = {}) {
    for (;;) {
      const known = stores.get(folder);
      if (!known) break;
      const store = await known.catch(() => null);
      if (store?.stillThere()) return store;
      // Deleted or replaced since, or it could not be opened: opened again.
      if (stores.get(folder) === known) {
        stores.delete(folder);
        store?.close().catch(() => {});
      }
    }
    const id = idOf(folder);
    if (!make && !hasStore(id, folder)) throw new DocError(404, "There is no such document");
    const opening = (async () => {
      if (!Database) {
        if (!(await ready)) throw new DocError(503, "The documents store's packages are not installed yet");
        Database = (await import("better-sqlite3")).default;
      }
      const dir = await placed(() => placeStore({ data: data(), id, folder, documents: documentsOf(folder), inside: portal.files.inside, Database, sandbox: portal.sandbox.on(), faults, log: (line) => portal.log(line) }));
      return Store.open(folder, { dir, inside: portal.files.inside, Database, faults, gitTimeoutMs });
    })();
    stores.set(folder, opening);
    return opening;
  }

  /** The folder a request names by its id, or a 404. */
  function folderOf(req) {
    const folder = folders().get(req.params.folder);
    if (!folder) throw new DocError(404, "There is no such folder");
    return folder;
  }

  /** The document a request names, or a 404 before anything is opened: an id is never a path. */
  function documentOf(req) {
    if (!isDocumentId(req.params.id)) throw new DocError(404, "There is no such document");
    return req.params.id;
  }

  /** A revision named in a request: a whole number from 1 on, or a 400. */
  function revisionOf(value, what) {
    const n = typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : value;
    if (!Number.isInteger(n) || n < 1) throw new DocError(400, `${what} must be a revision number`);
    return n;
  }

  function markdownOf(body) {
    if (typeof body?.markdown !== "string") throw new DocError(400, "markdown must be text");
    return body.markdown;
  }

  const warn = (markdown) => (SECRET.test(markdown) ? { warning: SECRET_WARNING } : {});
  const shown = ({ bytes, ...doc }) => ({ ...doc, title: titleOf(bytes, doc.name), markdown: bytes.toString("utf8") });

  /** A route whose refusals are answered with their status, and whose failures are logged and answered with a 500. */
  const route = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      if (e instanceof DocError) return res.status(e.status).json({ error: e.message, ...e.extra });
      portal.log(`${req.method} ${req.path} failed: ${e?.stack ?? e}`);
      res.status(500).json({ error: "The documents store could not do that" });
    }
  };
  const json = portal.http.json({ limit: BODY_LIMIT });

  portal.router.get("/folders", route(async (_req, res) => {
    const list = [];
    for (const folder of folders().values()) {
      if (!documentsOf(folder.path)) continue;
      let documents;
      try {
        const store = await storeFor(folder.path, { make: true });
        documents = (await store.list(HEAD_BYTES)).map(({ head, ...doc }) => ({ ...doc, title: titleOf(head, doc.name) }));
      } catch (e) {
        // One folder's store that cannot be opened (a link in its place, git missing) leaves the others listed.
        portal.log(`The documents in ${folder.path} could not be listed: ${e?.message ?? e}`);
        continue;
      }
      documents.sort((a, b) => a.title.localeCompare(b.title) || a.name.localeCompare(b.name));
      if (documents.length) list.push({ ...folder, name: path.basename(folder.path) || folder.path, documents });
    }
    list.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    res.json({ folders: list });
  }));

  portal.router.post("/folders/:folder/documents", json, route(async (req, res) => {
    const folder = folderOf(req);
    const body = req.body ?? {};
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 200) throw new DocError(400, "A document needs a title of at most 200 characters");
    const markdown = body.markdown === undefined || body.markdown === "" ? `# ${title}\n` : markdownOf(body);
    const scope = body.scope ?? "project";
    if (scope !== "project" && scope !== "chat") throw new DocError(400, "scope is project or chat");
    // A chat's own document belongs to one of the chats that work in this folder.
    if (scope === "chat" && !folder.chats.some((chat) => chat.id === body.chat)) throw new DocError(400, "A chat's document needs a chat that works in this folder");
    const store = await storeFor(folder.path, { make: true });
    const doc = await store.create({ title, markdown, scope, chat: scope === "chat" ? body.chat : null });
    res.status(201).json({ ...doc, title: titleOf(Buffer.from(markdown, "utf8"), doc.name), ...warn(markdown) });
  }));

  portal.router.get("/folders/:folder/documents/:id", route(async (req, res) => {
    const folder = folderOf(req);
    const id = documentOf(req);
    res.json(shown(await (await storeFor(folder.path)).read(id)));
  }));

  portal.router.put("/folders/:folder/documents/:id", json, route(async (req, res) => {
    const folder = folderOf(req);
    const id = documentOf(req);
    const markdown = markdownOf(req.body);
    const base = revisionOf(req.body.base, "base");
    const doc = await (await storeFor(folder.path)).save(id, { markdown, base });
    res.json({ ...doc, ...warn(markdown) });
  }));

  portal.router.get("/folders/:folder/documents/:id/history", route(async (req, res) => {
    const folder = folderOf(req);
    const id = documentOf(req);
    const before = req.query.before === undefined ? undefined : revisionOf(req.query.before, "before");
    const limit = req.query.limit === undefined ? undefined : Math.min(revisionOf(req.query.limit, "limit"), 500);
    res.json(await (await storeFor(folder.path)).history(id, { before, limit }));
  }));

  portal.router.get("/folders/:folder/documents/:id/revisions/:revision", route(async (req, res) => {
    const folder = folderOf(req);
    const id = documentOf(req);
    const { bytes, ...revision } = await (await storeFor(folder.path)).revision(id, revisionOf(req.params.revision, "revision"));
    res.json({ ...revision, markdown: bytes.toString("utf8") });
  }));

  portal.router.post("/folders/:folder/documents/:id/restore", json, route(async (req, res) => {
    const folder = folderOf(req);
    const id = documentOf(req);
    const revision = revisionOf(req.body?.revision, "revision");
    const base = req.body?.base === undefined ? undefined : revisionOf(req.body.base, "base");
    res.json(await (await storeFor(folder.path)).restore(id, { revision, base }));
  }));

  return async () => {
    const open = [...stores.values()];
    stores.clear();
    for (const pending of open) await pending.then((store) => store.close(), () => {});
  };
}
