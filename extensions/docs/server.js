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
 *   GET  /api/x/pithagoras-docs/folders                                          every folder with documents, and its documents; `version` says which list it is
 *   GET  /api/x/pithagoras-docs/folders/events                                   a stream of the changes to that list as they are made (server-sent events)
 *   GET  /api/x/pithagoras-docs/chats/:chat/documents                            the documents of one chat's folder (other chats' own marked), and the folder: for the panel beside it
 *   POST /api/x/pithagoras-docs/folders/:folder/documents                        a new document { title, markdown?, scope?, chat? }
 *   POST /api/x/pithagoras-docs/folders/:folder/documents/upload                 a Markdown file the person uploaded { name, markdown }, kept as it is
 *   GET  /api/x/pithagoras-docs/folders/:folder/documents/:id/download           the document's file, as an attachment
 *   GET  /api/x/pithagoras-docs/folders/:folder/documents/:id                    one document's Markdown, and its revision
 *   PUT  /api/x/pithagoras-docs/folders/:folder/documents/:id                    saves it { markdown, base }: 409 when base is not its revision and its changes meet the later ones
 *   POST /api/x/pithagoras-docs/folders/:folder/documents/:id/rename              gives its file another name { name }, which is a revision of its own (409 for a name that is taken)
 *   DELETE /api/x/pithagoras-docs/folders/:folder/documents/:id                  deletes the document: its file, its comments and its history on the page
 *   GET  /api/x/pithagoras-docs/folders/:folder/documents/:id/events             a stream of its revisions as they are made (server-sent events)
 *   GET  /api/x/pithagoras-docs/folders/:folder/documents/:id/history            its revisions, newest first (?before=, ?limit=)
 *   GET  /api/x/pithagoras-docs/folders/:folder/documents/:id/revisions/:revision  the text of one of them
 *   POST /api/x/pithagoras-docs/folders/:folder/documents/:id/restore            { revision, base? }: that text as a new revision
 *   GET  /api/x/pithagoras-docs/folders/:folder/documents/:id/threads            its comment threads, each with its passage where it is in the text now
 *   POST /api/x/pithagoras-docs/folders/:folder/documents/:id/threads            a new thread { base, quote, prefix?, suffix?, start?, body }: 422 when the passage is not in revision `base`
 *   POST /api/x/pithagoras-docs/folders/:folder/documents/:id/threads/:thread/comments  a reply { body } to an open thread
 *   PUT  /api/x/pithagoras-docs/folders/:folder/documents/:id/threads/:thread/comments/:comment  changes one of the person's comments { body }; with `draft` the last comment while it is the last, not marked as edited (for a client that saves a comment as it is typed)
 *   DELETE /api/x/pithagoras-docs/folders/:folder/documents/:id/threads/:thread/comments/:comment  takes it away (the thread goes with its only comment); ?draft=1 for the one typed away
 *   DELETE /api/x/pithagoras-docs/folders/:folder/documents/:id/threads/:thread  takes away a thread the person started, with its comments, while the agent has not commented in it
 *   POST /api/x/pithagoras-docs/folders/:folder/documents/:id/threads/:thread/seen      the person has read what the agent said in a thread
 *   POST /api/x/pithagoras-docs/folders/:folder/documents/:id/threads/:thread/resolve   resolves a thread, with a last comment if `body` is given
 *   POST /api/x/pithagoras-docs/folders/:folder/documents/:id/threads/:thread/reopen    opens a resolved thread again
 *
 * The page names a folder by an id made from its path, and a document by an
 * id the store gave it, never by a path: a folder is only one that a chat
 * works in, as the portal lists them now.
 *
 * A page with a document open is told of each revision of it as it is made, by
 * the agent, by the page itself, by Files or an editor: the stream's first
 * message is where the document stands, so that a page that was away (a
 * reconnect, or a change between its load and its stream) finds out at once,
 * whatever it missed. A message says which revision, who made it and when; the
 * text (and the name, which a rename is a revision for) is asked for from the
 * document's own route. A document that is deleted is told as `deleted`, once, and
 * the page keeps its text: nothing more is said of it, and a request for it is a 404. A change to the document's
 * comments is told too (`threads`, with when), and the threads are asked for
 * from their own route. While a stream is open the
 * folder is looked at every couple of seconds for what changed outside the
 * store's own writes, which is how the changes of Files and editors get told.
 *
 * The page that lists the folders is told when the list changes, by one stream
 * for all of them, not one for each: a browser keeps few connections to a
 * server, and a folder that has no documents yet is not on the page to have a
 * stream of its own. A message is only the list's `version` (a hash of what the
 * page would show of every folder), and the list is asked for from its own
 * route when that is not the version the page holds. The first message says where
 * the list stands, as a document's does, so that a page that was away finds
 * out at once and one that is up to date asks for nothing. While a stream is
 * open, each folder chats work in is looked at every couple of seconds for what
 * its list would show now (a document made, renamed, deleted or made again, a
 * folder that cannot be read), and at once for what the store itself writes.
 * Like every route it is behind the portal's login, and the portal ends it when
 * the password changes: it says nothing of a folder that its list would not
 * show, and nothing of the folder or its documents but that something changed.
 *
 * A comment of the person's that has `@agent` in it asks the agent (ping.js): the
 * thread is marked as waiting for it, and the agent of the chat the page names
 * (the one the person is in) is woken with the comment, through the portal's own
 * `chats.tell`, to answer it with its tools. The wake is in the background, a few
 * seconds after the comment was last saved: nothing here waits for a chat to start.
 * A comment that is changed asks as a new one would, only while it is the last of an open
 * thread; one that is taken away, or its thread, takes the wake with it.
 */
import { createHash } from "node:crypto";
import { lstatSync, watch } from "node:fs";
import path from "node:path";
import { ensureDependencies } from "./deps.js";
import { explained } from "./errors.js";
import { forChats } from "./files.js";
import { LEGACY_STORE, placeStore } from "./place.js";
import { hearPings, wakeMessage } from "./ping.js";
import { SECRET, SECRET_WARNING } from "./secret.js";
import { frontMatterEnd } from "./src/frame.js";
import { callingChat, DocError, DOCUMENTS, isDocumentId, Store } from "./store.js";
import { documentTools } from "./tools.js";
import { asksAgent } from "./web/mention.js";

/** Where a document's title is looked for: its first heading, near its top. */
const HEAD_BYTES = 4096;
/** A save's body: a document's Markdown (1 MB at most) written as JSON, which can take more room than the text. */
const BODY_LIMIT = "8mb";

const idOf = (folder) => createHash("sha256").update(folder).digest("hex").slice(0, 16);

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
 * an HTML block or a comment is not drawn as a heading, whatever it looks like,
 * and neither is a YAML front matter block at the top, which the editor keeps
 * apart (src/frame.js): its closing `---` would underline its keys.
 */
function headingOf(text) {
  let fence = null;
  let html = null;
  // The paragraph the lines so far make, where it is: { lines, quotes, column }.
  let paragraph = null;
  const body = text.replace(/^\uFEFF/, "");
  for (const raw of body.slice(frontMatterEnd(body, 0)).split("\n")) {
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

/**
 * The Markdown a new document called `title` starts with. What it is called is
 * its first heading, so Markdown with none near its top is given `# title`
 * there, after a front matter block. Markdown with a heading of its own keeps
 * it as it is, and is called by it.
 */
function headed(markdown, title) {
  if (headingOf(Buffer.from(markdown, "utf8").subarray(0, HEAD_BYTES).toString("utf8"))) return markdown;
  const at = frontMatterEnd(markdown, markdown.startsWith("\uFEFF") ? 1 : 0);
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const head = markdown.slice(0, at);
  // Blank lines before the text are the heading's blank line now.
  const rest = markdown.slice(at).replace(/^(?:[ \t]*\r?\n)+/, "");
  // A front matter block that ends the Markdown with no line break is given one: glued to its closing marks, the heading would keep it from closing.
  const glued = at > 0 && !/[\n\uFEFF]$/.test(head);
  return `${head}${glued ? eol + eol : ""}# ${title.replace(/\s+/g, " ")}${eol}${rest.trim() ? eol + rest : ""}`;
}


/** How often an open stream is sent a comment line, so that nothing between the portal and the page (a proxy) takes it for idle. */
const PING_MS = 25_000;
/** How often a folder with an open stream is looked at for changes outside the store's own writes. */
const POLL_MS = 2_000;
/**
 * How long a comment that asks the agent has to be left alone before the agent is woken: a moment to take it back or change it,
 * and for a client that saves a comment as it is typed, the words written, not the words typed so far.
 */
const WAKE_MS = 3_000;
/**
 * How long a chat has to take the wake once it has begun: starting a chat's pi takes a while, and one that never starts would leave the
 * thread saying the agent was asked for good, with nothing that asks again.
 */
const WAKE_LIMIT_MS = 120_000;

export default function (portal, { dependencies = ensureDependencies, faults, gitTimeoutMs, pingMs = PING_MS, pollMs = POLL_MS, wakeMs = WAKE_MS, wakeLimitMs = WAKE_LIMIT_MS } = {}) {
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
   * The sessions that work in a folder now (their ids): the agents of all of them must be able to use what the portal reads or writes there for them
   * (`likeParent` of `files.*`), which takes no agent from the folder's path. Of every kind, not the tasks alone: the tools are in a routine run's, an
   * Agent-page conversation's and a heartbeat's pi as in a task's. And `caller`, the session an agent's call is made for, which is always one of them,
   * whatever its own folder leads to now.
   */
  function chatsIn(folder, caller = callingChat.getStore()) {
    const ids = new Set(portal.chats.inFolder(folder).map((chat) => chat.id));
    if (caller) ids.add(caller);
    return [...ids];
  }

  /**
   * A folder's `documents` folder, or nothing when it has none. Only a folder
   * of that name itself: a link called `documents` leads to another folder of
   * the project, which is not the documents' to be listed or written. And not one
   * the sandbox closed to the agents of its chats (`likeParent`), or one that is
   * reached through such a folder: the agent can rename such a folder to this name,
   * and the portal would list and watch it as root. `chats` are the ids of those
   * sessions, or looked up.
   */
  function documentsOf(folder, chats = chatsIn(folder)) {
    try {
      return portal.files.folder(folder, DOCUMENTS, { direct: true, likeParent: true, chats });
    } catch {
      return null;
    }
  }

  /**
   * Whether `folder` itself is one the agents of `chats` may not look into: the walk to it, and the folder, as they would have it. Asked before anything in the
   * folder is looked at as the portal (root), so that what is there (a store of an earlier version, say) is not told to an agent that cannot see it.
   */
  function unreachableTo(folder, chats) {
    try {
      portal.files.folder(folder, "", { likeParent: true, chats });
      return false;
    } catch (e) {
      return e?.code === "invalid";
    }
  }

  /**
   * Whether the agents of `chats` are refused the documents folder of `folder`: it is a folder that is there and not theirs to use, or the folder it is in is not
   * theirs to look into (then it is not told which: it is the same answer whatever is there).
   */
  function closedTo(folder, chats) {
    if (unreachableTo(folder, chats)) return true;
    try {
      return lstatSync(path.join(folder, DOCUMENTS)).isDirectory() && documentsOf(folder, chats) === null;
    } catch {
      return false;
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

  /**
   * The streams that are open, and who they are for: by folder (its path), the
   * streams of each document, and a look at the folder that goes on for as long
   * as one is open. A revision made in a folder is told to the streams of its
   * document, in the order it was made.
   */
  const watching = new Map();
  const live = {
    publish(folder, change) {
      for (const send of [...(watching.get(folder)?.documents.get(change.id) ?? [])]) send(change);
      // The list shows each document's revision, size, time and open comments: a page that lists the folders is told at once.
      if (lists.sends.size) void look(idOf(folder));
    },
    /** `send` is given each revision of document `id` in `folder`. Returns what stops it. */
    watch(folder, id, send) {
      let entry = watching.get(folder);
      if (!entry) {
        entry = { documents: new Map(), count: 0, timer: null, busy: false, failure: null };
        watching.set(folder, entry);
      }
      const sends = entry.documents.get(id) ?? entry.documents.set(id, new Set()).get(id);
      sends.add(send);
      entry.count++;
      if (!entry.timer && pollMs > 0) {
        const watched = entry;
        // One look at a time: a slow one is not stacked on.
        watched.timer = setInterval(async () => {
          if (watched.busy || stopped) return;
          watched.busy = true;
          try {
            await (await storeFor(folder)).refresh();
            watched.failure = null;
          } catch (e) {
            // Said once for as long as it is the same.
            const said = e?.message ?? String(e);
            if (said !== watched.failure) portal.log(`The documents in ${folder} could not be looked at for changes: ${said}`);
            watched.failure = said;
          } finally {
            watched.busy = false;
          }
        }, pollMs);
        watched.timer.unref?.();
      }
      return () => {
        if (!sends.delete(send)) return;
        if (!sends.size) entry.documents.delete(id);
        if (--entry.count > 0) return;
        clearInterval(entry.timer);
        if (watching.get(folder) === entry) watching.delete(folder);
      };
    },
  };
  /** The responses of the streams that are open, ended when the extension stops. */
  const streams = new Set();
  let stopped = false;

  /**
   * The streams of the list of folders, and what is known of the list. `seen`: what each folder's listing was when it was last looked at (a
   * string for each folder that has anything to list), which is what a change is found against; it is made when the first stream opens and
   * dropped with the last, so that nothing is looked at while no page listens. `sends`: told the list's version when it changed.
   */
  const lists = { sends: new Set(), seen: null, based: null, timer: null, running: null, all: false, due: new Set(), watchers: new Map() };

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
    if (!make && !hasStore(id, folder)) throw new DocError(404, "There is no such document", { code: "deleted" });
    const opening = (async () => {
      if (!Database) {
        if (!(await ready)) throw new DocError(503, "The documents store's packages are not installed yet");
        Database = (await import("better-sqlite3")).default;
      }
      const dir = await placed(() => placeStore({ data: data(), id, folder, documents: documentsOf(folder), files: forChats(portal.files, chatsIn(folder)), Database, sandbox: portal.sandbox.on(), faults, log: (line) => portal.log(line) }));
      return Store.open(folder, { dir, files: portal.files, chats: () => chatsIn(folder), Database, faults, gitTimeoutMs, onRevision: (change) => live.publish(folder, change), onThreads: (change) => live.publish(folder, { ...change, threads: true }) });
    })();
    stores.set(folder, opening);
    return opening;
  }

  /**
   * What the agents of chats are to be told because the person asked them in a comment, by chat, until the chat's pi has taken
   * it (`hearPings`): the server half keeps it, so that only a comment the person wrote can be said to the agent.
   */
  const waking = new Map();
  const takeWaking = (chat) => {
    const entries = waking.get(chat) ?? [];
    waking.delete(chat);
    return entries;
  };

  // The agent's tools, in each chat's pi, where pi runs in the portal's process: they share the store the routes use. So does
  // what hears the bell that wakes the chat (ping.js).
  if (portal.executor === "host") {
    portal.chats.extend((pi, chat) => {
      documentTools(pi, chat, {
        folder: () => portal.chats.folder(chat.id),
        store: storeFor,
        hasDocuments: (folder, caller) => documentsOf(folder, chatsIn(folder, caller)) !== null,
        closed: (folder, caller) => closedTo(folder, chatsIn(folder, caller)),
        unreachable: (folder, caller) => unreachableTo(folder, chatsIn(folder, caller)),
        folderId: idOf,
        titleOf,
        headed,
        headBytes: HEAD_BYTES,
        log: (line) => portal.log(line),
      });
      hearPings(pi, { extension: portal.extension, take: () => takeWaking(chat.id) });
    });
  }

  /** The folder a request names by its id, or a 404. */
  function folderOf(req) {
    const folder = folders().get(req.params.folder);
    if (!folder) throw new DocError(404, "There is no such folder, or no chat works in it any more");
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

  /**
   * The wakes that wait for a comment to be left alone, by folder and comment (`{ timer, running }`: `running` once the wake has begun,
   * which is when it is past changing), until the agent has been woken or it has not been reachable: a ping that is neither taken
   * nor waiting was not delivered, and `reasons` says why where it is known.
   */
  const wakes = new Map();
  const reasons = new Map();
  // By the comment, not by the ping's number: a ping that is taken away (its comment typed away) gives its number to the next.
  const wakeKey = (folder, comment) => `${idOf(folder.path)}/${comment}`;
  const unwake = (folder, comment) => {
    clearTimeout(wakes.get(wakeKey(folder, comment))?.timer);
    wakes.delete(wakeKey(folder, comment));
    reasons.delete(wakeKey(folder, comment));
  };

  /** A thread as the page gets it: how the last ask of the agent stands (`state`: taken by a chat, waiting to be, or not delivered), and in which chat. */
  function withChat(folder, thread) {
    if (!thread.ping) return thread;
    const key = wakeKey(folder, thread.ping.comment);
    const state = thread.ping.sent ? "sent" : wakes.has(key) ? "pending" : "failed";
    const title = folder.chats.find((chat) => chat.id === thread.ping.chat)?.title ?? null;
    return { ...thread, ping: { ...thread.ping, title, state, ...(state === "failed" && reasons.has(key) ? { error: reasons.get(key) } : {}) } };
  }

  /**
   * The chat whose agent is asked about a comment on a document: the one the page says the person is in, if it works in the
   * folder (the page opens one for the folder when they are in none). A chat's own document can be read by that chat only, so
   * its comments are asked of that chat, wherever the person is.
   */
  function chatToAsk(folder, doc, requested) {
    const readers = folder.chats.filter((chat) => doc.scope === "project" || chat.id === doc.chat);
    return doc.scope === "chat" ? (readers[0] ?? null) : (readers.find((chat) => chat.id === requested) ?? null);
  }

  /** The folder's pages are told that the comments of a document changed. */
  const toldThreads = (folder, id) => live.publish(folder.path, { id, threads: true, at: new Date().toISOString() });

  /**
   * Wakes the agent of `chat` with the comment `comment`, which the ping `ping` of a thread was made for, as it stands now: through the bell of the
   * chat's pi extension, which starts the chat's pi if it was let go. The wake is not waited for by anyone: the page is told by the
   * thread, which says whether the chat took it. `mine` is the wake's own entry in `wakes`: it is only ever taken out by the wake
   * it belongs to (or by `unwake`), and a comment that is changed while the wake is on its way is not woken for again.
   */
  async function wake(folder, store, id, thread, ping, comment, chat, mine) {
    const key = wakeKey(folder, comment);
    const done = () => {
      if (wakes.get(key) === mine) wakes.delete(key);
    };
    try {
      const doc = await store.read(id);
      const now = (await store.threads(id)).threads.find((t) => t.id === thread);
      const last = now?.comments.at(-1);
      // Not asked any more, a chat has taken it already, or the agent has answered (or the thread was closed) while the comment was left alone.
      if (!now || now.status !== "open" || now.ping?.id !== ping || now.ping.comment !== comment || now.ping.sent || last?.id !== comment || last.author !== "user" || !asksAgent(last.body)) return done();
      const entry = { text: wakeMessage({ title: titleOf(doc.bytes, doc.name), name: doc.name, id, thread, comment: last.body }), details: { folder: idOf(folder.path), id, thread }, state: "waiting" };
      waking.set(chat, [...(waking.get(chat) ?? []), entry]);
      let why;
      let late;
      try {
        // Starts the chat's pi if it was let go, and rings the bell its pi extension answers by taking what is queued for it.
        const rang = await Promise.race([portal.chats.tell(chat, { type: "ping" }), new Promise((resolve) => (late = setTimeout(resolve, wakeLimitMs, "late")))]);
        if (rang === "late") why = "This chat did not start in time";
        else if (!rang) why = "This chat's agent does not run in the portal's own process";
      } catch (e) {
        why = e?.message ?? String(e);
      } finally {
        clearTimeout(late);
      }
      // What the bell did not hand over is not left for whatever rings it next.
      waking.set(chat, (waking.get(chat) ?? []).filter((queued) => queued !== entry));
      if (!why && entry.state === "failed") why = entry.error;
      else if (!why && entry.state !== "sent") why = "This chat's agent did not take it";
      if (why) throw new Error(why);
      // Only the ping of this comment is taken: one that has its number now (this comment was typed away and another written) is not.
      await store.reached(id, thread, ping, comment);
      done();
    } catch (e) {
      portal.log(`The agent in a chat of ${folder.path} could not be asked in a comment: ${e?.message ?? e}`);
      // A wake that was dropped meanwhile (the comment was typed away) has nothing to say.
      if (wakes.get(key) !== mine) return;
      reasons.set(key, e instanceof DocError ? e.message : (e?.message ?? String(e)));
      done();
      toldThreads(folder, id);
    }
  }

  /**
   * The person's comment in `thread` was made or changed: `thread` is as it is now, and its last comment is theirs. If it asks the
   * agent, a wake is due once it has been left alone for a while (and again, later, for each change to it until then; not once the
   * wake has begun: what is changed then is in the thread, and wakes nobody again); if it does not (any more), a wake that was due
   * is dropped. Returns the thread.
   */
  async function asked(folder, store, id, thread, requested) {
    const last = thread.comments.at(-1);
    try {
      if (!asksAgent(last.body)) {
        const gone = await store.unping(id, thread.id, last.id);
        if (gone.ping !== undefined) unwake(folder, gone.comment);
        return gone.thread;
      }
      // The agent is being woken with this comment: a change to it now is in the thread, and no second wake is made for it (nor
      // is the chat it was asked in changed, which the ping below would do).
      if (wakes.get(wakeKey(folder, last.id))?.running && thread.ping?.comment === last.id) return thread;
      // Not read: a document whose file is gone is asked about all the same, and the thread says the agent could not read it.
      const doc = await store.ownerOf(id);
      const chat = chatToAsk(folder, doc, requested);
      const made = await store.ping(id, thread.id, { chat: chat?.id ?? null });
      if (made.sent) return made.thread;
      const key = wakeKey(folder, last.id);
      clearTimeout(wakes.get(key)?.timer);
      reasons.delete(key);
      if (!chat) {
        // No chat to ask: not delivered, and said so.
        wakes.delete(key);
        reasons.set(key, doc.scope === "chat" ? "No chat that can read this document works in its folder any more" : "The chat to ask is not one that works in this folder");
        toldThreads(folder, id);
        return made.thread;
      }
      const mine = { timer: null, running: false };
      mine.timer = setTimeout(() => {
        mine.running = true;
        void wake(folder, store, id, thread.id, made.ping, last.id, chat.id, mine);
      }, wakeMs);
      mine.timer.unref?.();
      wakes.set(key, mine);
      return made.thread;
    } catch (e) {
      // The comment is made all the same: a failure to ask is the thread's to say, and the agent finds the comment when it reads.
      if (!(e instanceof DocError)) portal.log(`Asking the agent in a comment on ${folder.path} failed: ${e?.stack ?? e}`);
      return thread;
    }
  }

  const warn = (markdown) => (SECRET.test(markdown) ? { warning: SECRET_WARNING, warningCode: "secret" } : {});
  const shown = ({ bytes, ...doc }) => ({ ...doc, title: titleOf(bytes, doc.name), markdown: bytes.toString("utf8") });

  /** A route whose refusals are answered with their status, and whose failures are logged and answered with a 500. */
  const route = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      if (e instanceof DocError) {
        // A refusal the person caused is theirs to read; one of the store's own (git, the database) is also for the log.
        if (e.status === 500 || e.operator) portal.log(`${req.method} ${req.path} failed: ${e.message}`);
        return res.status(e.status).json({ error: e.message, ...e.extra });
      }
      portal.log(`${req.method} ${req.path} failed: ${e?.stack ?? e}`);
      res.status(500).json({ error: "The documents store could not do that" });
    }
  };
  const json = portal.http.json({ limit: BODY_LIMIT });
  /** A comment and the passage it is on are small: nothing like a document's text. */
  const small = portal.http.json({ limit: "64kb" });

  /**
   * What the page lists of one folder: `listed` (the folder, with its documents and their titles) or `problem` (why its documents cannot be
   * opened), and neither for a folder that has none. `say` is told what could not be listed. Without `titles` the documents come without
   * them, which saves reading the start of each: a title is made of the text, and a change of the text is a new revision, which a look
   * for what changed sees all the same.
   */
  async function described(folder, { say, titles = true }) {
    const dir = documentsOf(folder.path);
    if (!dir) return {};
    const name = path.basename(folder.path) || folder.path;
    let documents;
    try {
      const store = await storeFor(folder.path, { make: true });
      documents = (await store.list(titles ? HEAD_BYTES : 0)).map(({ head, ...doc }) => (titles ? { ...doc, title: titleOf(head, doc.name) } : doc));
    } catch (e) {
      // One folder's store that cannot be opened (a link in its place, git missing) leaves the others listed, and is said on the page:
      // a folder that is silently left out reads as one with no documents.
      say(`The documents in ${folder.path} could not be listed: ${e?.message ?? e}`);
      const known = explained(e);
      return { problem: { id: folder.id, name, path: folder.path, error: known instanceof DocError ? known.message : "The documents store could not be opened: the portal's log says why" } };
    }
    if (titles) documents.sort((a, b) => a.title.localeCompare(b.title) || a.name.localeCompare(b.name));
    return documents.length ? { listed: { ...folder, name, documents } } : {};
  }

  /**
   * What a folder's list shows, as a string, or nothing where it shows nothing: what two looks at it are compared by. Without the titles
   * and in the order of the names, so that a look that did not make them (`described`) and the page's own list come to the same.
   */
  const signatureOf = ({ listed, problem }) =>
    listed || problem ? JSON.stringify([listed?.documents.map((doc) => ({ ...doc, title: undefined })).sort((a, b) => (a.name < b.name ? -1 : 1)), problem?.error]) : null;

  /** The version of the list: a hash of what every folder shows (their signatures, by folder). The same for the same list, whoever looks and when. */
  const versionOf = (signatures) => createHash("sha256").update(JSON.stringify([...signatures].sort(([a], [b]) => (a < b ? -1 : 1)))).digest("hex").slice(0, 16);

  /**
   * What was last said of a folder that could not be listed, by folder, until it is listed or says something else: the look at the list
   * and the request for it say the same failure once, not at every look and every change of any folder that makes a page ask again.
   */
  const failed = new Map();
  const saying = (folder) => (line) => {
    if (failed.get(folder.id) !== line) portal.log(line);
    failed.set(folder.id, line);
  };

  /** A folder as the page lists it (`described`), and that it could be listed is remembered. */
  async function listing(folder, options) {
    const found = await described(folder, { say: saying(folder), ...options });
    if (!found.problem) failed.delete(folder.id);
    return found;
  }

  /** A folder's signature, as the look at the list takes it. */
  const signed = async (folder) => signatureOf(await listing(folder, { titles: false }));

  /** The signatures of every folder that has something to list, by folder. */
  async function seeing() {
    const seen = new Map();
    for (const folder of folders().values()) {
      // Nothing is opened once the extension has stopped: its stores are closed.
      if (stopped) break;
      const signature = await signed(folder);
      if (signature !== null) seen.set(folder.id, signature);
    }
    return seen;
  }

  /**
   * Where the list stands when the first stream opens, made once for the streams that open while it is made. It is asked before the page
   * asks for the list, so that what changes after is told, and what changed before is in the list the page gets.
   */
  function baseline() {
    if (lists.based) return lists.based;
    // Only if the stream it was for is still there when it is made: the streams were all let go meanwhile otherwise, and nothing is kept.
    const based = seeing().then(
      (seen) => {
        if (lists.based === based) lists.seen = seen;
        return seen;
      },
      (e) => {
        if (lists.based === based) lists.based = null;
        throw e;
      },
    );
    return (lists.based = based);
  }

  /** The folders `ids` (all of them, with none) are looked at again, and the streams are told the new version if what any of them shows is not what it was. */
  async function visit(ids) {
    const seen = lists.seen;
    const found = folders();
    let changed = false;
    for (const id of ids ?? new Set([...found.keys(), ...seen.keys()])) {
      if (stopped) return;
      const folder = found.get(id);
      const now = folder ? await signed(folder) : null;
      // The last stream was let go while it was looked at, and another may have opened since: this is not its list.
      if (lists.seen !== seen) return;
      if ((seen.get(id) ?? null) === now) continue;
      if (now === null) seen.delete(id);
      else seen.set(id, now);
      changed = true;
    }
    if (!changed) return;
    const version = versionOf(seen);
    for (const send of [...lists.sends]) send(version);
  }

  /**
   * Asks for a look at the folder `id` (every folder, with none): one at a time, so that a look that is on its way takes in what is asked
   * meanwhile, and a burst of writes is a look or two. Never fails: what goes wrong is logged.
   */
  function look(id) {
    if (id === undefined) lists.all = true;
    else lists.due.add(id);
    return (lists.running ??= (async () => {
      try {
        await lists.based;
        while (lists.seen && (lists.all || lists.due.size) && !stopped) {
          const ids = lists.all ? undefined : [...lists.due];
          lists.all = false;
          lists.due.clear();
          await visit(ids);
        }
      } catch (e) {
        portal.log(`The list of documents could not be looked at for changes: ${e?.stack ?? e}`);
      } finally {
        lists.running = null;
      }
    })());
  }

  /** Which folder `dir` is (the file system's own numbers for it), or null where it is not there: a folder made again is another one. */
  function identity(dir) {
    try {
      const { dev, ino } = lstatSync(dir);
      return `${dev}:${ino}`;
    } catch {
      return null;
    }
  }

  /** Stops watching the documents folder of folder `id`. */
  function unwatchDir(id) {
    const watched = lists.watchers.get(id);
    if (!watched) return;
    clearTimeout(watched.timer);
    watched.watcher.close();
    lists.watchers.delete(id);
  }

  /**
   * The documents folders of the folders chats work in, watched while a page lists them: a file put there (an upload in Files, an
   * editor, a copy) is looked at a moment after, not at the next look of every couple of seconds. What cannot be watched is left to
   * those looks, which also find a documents folder that was made since.
   */
  function watchDirs() {
    const found = folders();
    // A watch follows the folder it was set on, not its name: one removed and made again is watched no more and is watched anew.
    for (const [id, watched] of lists.watchers) if (!found.has(id) || documentsOf(found.get(id).path) !== watched.dir || identity(watched.dir) !== watched.identity) unwatchDir(id);
    for (const [id, folder] of found) {
      if (lists.watchers.has(id)) continue;
      const dir = documentsOf(folder.path);
      if (!dir) continue;
      try {
        const watched = { dir, identity: identity(dir), watcher: null, timer: null };
        // A burst of events (a write through a temporary file, a copy of many) is one look.
        watched.watcher = watch(dir, { persistent: false }, (type, name) => {
          // The folder itself was removed or made again: this watch is dead (it follows the folder that is gone), and the folder is
          // watched anew without waiting for the next look. The event that names the folder is the sure sign: a folder made again may
          // get the number of the one removed (ext4 does), so its identity says nothing then, and tells only of a move.
          if ((type === "rename" && name === path.basename(dir)) || identity(dir) !== watched.identity) {
            if (lists.watchers.get(id) !== watched) return;
            unwatchDir(id);
            watchDirs();
            void look(id);
            return;
          }
          clearTimeout(watched.timer);
          watched.timer = setTimeout(() => void look(id), 100);
          watched.timer.unref?.();
        });
        watched.watcher.on("error", () => unwatchDir(id));
        lists.watchers.set(id, watched);
      } catch {
        // Not to be watched here (too many watches, a file system that has none): the looks find what changes.
      }
    }
  }

  /** `send` is given the list's version whenever it changes. Returns what stops it. */
  function watchList(send) {
    lists.sends.add(send);
    // The folders are looked at every so often: a document that is made, renamed or deleted outside the store tells it nothing.
    if (!lists.timer && pollMs > 0) {
      watchDirs();
      lists.timer = setInterval(() => {
        watchDirs();
        void look();
      }, pollMs);
      lists.timer.unref?.();
    }
    return () => {
      if (!lists.sends.delete(send) || lists.sends.size) return;
      clearInterval(lists.timer);
      for (const id of [...lists.watchers.keys()]) unwatchDir(id);
      Object.assign(lists, { timer: null, seen: null, based: null, all: false });
      lists.due.clear();
      failed.clear();
    };
  }

  portal.router.get("/folders", route(async (_req, res) => {
    const list = [];
    const problems = [];
    const signatures = new Map();
    for (const folder of folders().values()) {
      const found = await listing(folder);
      if (found.listed) list.push(found.listed);
      if (found.problem) problems.push(found.problem);
      const signature = signatureOf(found);
      if (signature !== null) signatures.set(folder.id, signature);
    }
    list.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    problems.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    res.json({ folders: list, ...(problems.length ? { problems } : {}), version: versionOf(signatures) });
  }));

  /**
   * The documents of a chat's folder, for the panel beside it, and the folder they are in (its id, to open one or make one): all of
   * them, the other chats' own documents too, which are marked as such. The panel keeps it current with
   * the list's stream (/folders/events), and asks again when that says the list changed.
   */
  portal.router.get("/chats/:chat/documents", route(async (req, res) => {
    const chat = String(req.params.chat);
    let where;
    try {
      where = portal.chats.folder(chat);
    } catch {
      throw new DocError(404, "This chat is not there, or its folder is gone");
    }
    const folder = { id: idOf(where), path: where };
    const found = await listing(folder);
    if (found.problem) throw new DocError(503, found.problem.error);
    // Every document of the folder, as on the Documents page: a folder such as the agent's home is many chats', and the person sees
    // the documents of each in any of them. One that is another chat's own says which chat (`chatTitle`): its agent does not see it here.
    const titles = new Map(portal.chats.list().map((c) => [c.id, c.title]));
    const documents = (found.listed?.documents ?? []).map((doc) => (doc.scope === "chat" && doc.chat !== chat ? { ...doc, otherChat: true, chatTitle: titles.get(doc.chat) ?? null } : doc));
    res.json({ folder: { id: folder.id, name: path.basename(where) || where, path: where }, documents });
  }));

  portal.router.get("/folders/events", route(async (req, res) => {
    if (stopped) throw new DocError(503, "The documents extension is stopping");
    let closed = false;
    let send = () => {};
    let ping;
    // Listened to before it is asked where the list stands: a change made in between is told, and what came before is in the list the page asks for.
    const unwatch = watchList((version) => send(version));
    res.on("close", () => {
      closed = true;
      clearInterval(ping);
      streams.delete(res);
      unwatch();
    });
    await baseline();
    if (stopped) throw new DocError(503, "The documents extension is stopping");
    if (closed) return;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 2000\n\n");
    send = (version) => res.write(`event: documents\ndata: ${JSON.stringify({ version })}\n\n`);
    // Where the list stands, as the first message: a page that was away finds out whether it missed anything, whatever it was.
    send(versionOf(lists.seen));
    ping = setInterval(() => res.write(": ping\n\n"), pingMs);
    ping.unref?.();
    streams.add(res);
  }));

  portal.router.post("/folders/:folder/documents", json, route(async (req, res) => {
    const folder = folderOf(req);
    const body = req.body ?? {};
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 200) throw new DocError(400, "A document needs a title of at most 200 characters");
    const markdown = headed(body.markdown === undefined ? "" : markdownOf(body), title);
    const scope = body.scope ?? "project";
    if (scope !== "project" && scope !== "chat") throw new DocError(400, "scope is project or chat");
    // A chat's own document belongs to one of the chats that work in this folder.
    if (scope === "chat" && !folder.chats.some((chat) => chat.id === body.chat)) throw new DocError(400, "A chat's document needs a chat that works in this folder");
    const store = await storeFor(folder.path, { make: true });
    const doc = await store.create({ title, markdown, scope, chat: scope === "chat" ? body.chat : null });
    res.status(201).json({ ...doc, title: titleOf(Buffer.from(markdown, "utf8"), doc.name), ...warn(markdown) });
  }));

  /**
   * A Markdown file the person uploaded, as a document of the folder: its text as it is (no heading is added), under its own name,
   * or with a number where that is taken. `name` is the file's name, `.md` or `.markdown`.
   */
  portal.router.post("/folders/:folder/documents/upload", json, route(async (req, res) => {
    const folder = folderOf(req);
    const body = req.body ?? {};
    const markdown = markdownOf(body);
    const given = typeof body.name === "string" ? body.name.trim() : "";
    if (!/\.(md|markdown)$/i.test(given) || given.length > 255) throw new DocError(400, "Only Markdown files (.md) can be uploaded as documents");
    const base = given.replace(/\.(md|markdown)$/i, "");
    const store = await storeFor(folder.path, { make: true });
    const doc = await store.create({ title: base, name: base, markdown });
    res.status(201).json({ ...doc, title: titleOf(Buffer.from(markdown, "utf8"), doc.name), ...warn(markdown) });
  }));

  /** A document's file as it is, to be saved by the browser. */
  portal.router.get("/folders/:folder/documents/:id/download", route(async (req, res) => {
    const folder = folderOf(req);
    const id = documentOf(req);
    const doc = await (await storeFor(folder.path)).read(id);
    const ascii = doc.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.name)}`);
    res.setHeader("Cache-Control", "no-store");
    res.end(doc.bytes);
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
    // A text that started from an earlier revision is put together with what was saved since, where their changes do not meet.
    const doc = await (await storeFor(folder.path)).save(id, { markdown, base, merge: true });
    res.json({ ...doc, ...warn(markdown) });
  }));

  portal.router.post("/folders/:folder/documents/:id/rename", small, route(async (req, res) => {
    const folder = folderOf(req);
    const id = documentOf(req);
    res.json(await (await storeFor(folder.path)).rename(id, { name: req.body?.name }));
  }));

  portal.router.delete("/folders/:folder/documents/:id", route(async (req, res) => {
    const folder = folderOf(req);
    const id = documentOf(req);
    const { comments } = await (await storeFor(folder.path)).delete(id);
    // A comment that was waiting to ask the agent has nothing to ask about any more.
    for (const comment of comments) unwake(folder, comment);
    res.json({ deleted: true });
  }));

  portal.router.get("/folders/:folder/documents/:id/events", route(async (req, res) => {
    const folder = folderOf(req);
    const id = documentOf(req);
    // The page's end of it: told by the response, which closes when the connection does.
    let closed = false;
    res.on("close", () => (closed = true));
    const store = await storeFor(folder.path);
    // Listened to before it is asked where the document stands: a revision made in between is not missed.
    const queued = [];
    let send = (change) => queued.push(change);
    const unwatch = live.watch(folder.path, id, (change) => send(change));
    let now;
    try {
      now = await store.current(id);
    } catch (e) {
      unwatch();
      throw e;
    }
    if (stopped) {
      unwatch();
      throw new DocError(503, "The documents extension is stopping");
    }
    if (closed) return unwatch();
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    // A page that lost the stream asks again after this long, with its last id: the first message tells it where things stand, so it is not needed.
    res.write("retry: 2000\n\n");
    const write = ({ revision, author, at, threads, deleted }) =>
      // A change to the comments is no revision: it has no id, which a reconnecting page would take for the last one it saw. Nor is a deletion.
      res.write(
        deleted
          ? `event: deleted\ndata: ${JSON.stringify({ at })}\n\n`
          : threads
            ? `event: threads\ndata: ${JSON.stringify({ at })}\n\n`
            : `id: ${revision}\nevent: revision\ndata: ${JSON.stringify({ revision, author, at })}\n\n`,
      );
    write(now);
    for (const change of queued) if (change.threads || change.deleted || change.revision > now.revision) write(change);
    send = write;
    const ping = setInterval(() => res.write(": ping\n\n"), pingMs);
    ping.unref?.();
    streams.add(res);
    res.on("close", () => {
      clearInterval(ping);
      streams.delete(res);
      unwatch();
    });
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

  portal.router.get("/folders/:folder/documents/:id/threads", route(async (req, res) => {
    const folder = folderOf(req);
    const id = documentOf(req);
    const { scope, chat, ...listed } = await (await storeFor(folder.path)).threads(id);
    // Where a comment that asks the agent can go: the chats that can read the document, and the folder a new chat is opened in.
    const chats = folder.chats.filter((c) => scope === "project" || c.id === chat);
    res.json({ ...listed, threads: listed.threads.map((thread) => withChat(folder, thread)), ask: { chats, own: scope === "chat", workspace: folder.path } });
  }));

  portal.router.post("/folders/:folder/documents/:id/threads", small, route(async (req, res) => {
    const folder = folderOf(req);
    const id = documentOf(req);
    const body = req.body ?? {};
    const base = revisionOf(body.base, "base");
    const start = Number.isInteger(body.start) && body.start >= 0 ? body.start : null;
    // The author is the person: the agent has its own tools, and a request cannot say it is someone else.
    const store = await storeFor(folder.path);
    const thread = await store.addThread(id, { base, quote: body.quote, prefix: body.prefix ?? "", suffix: body.suffix ?? "", start, body: body.body, author: "user" });
    res.status(201).json(withChat(folder, await asked(folder, store, id, thread, body.chat)));
  }));

  portal.router.post("/folders/:folder/documents/:id/threads/:thread/comments", small, route(async (req, res) => {
    const folder = folderOf(req);
    const id = documentOf(req);
    const store = await storeFor(folder.path);
    const thread = await store.reply(id, req.params.thread, { body: req.body?.body, author: "user" });
    res.status(201).json(withChat(folder, await asked(folder, store, id, thread, req.body?.chat)));
  }));

  // The page makes a comment when it is sent (above). A client that saves one as it is typed changes it with `draft` while it is the last of
  // its thread, and takes it away with `?draft=1` when it is typed away. The person changes or takes away any of their comments, in an open
  // thread or a resolved one.
  portal.router.put("/folders/:folder/documents/:id/threads/:thread/comments/:comment", small, route(async (req, res) => {
    const folder = folderOf(req);
    const id = documentOf(req);
    const store = await storeFor(folder.path);
    const { thread, changed } = await store.edit(id, req.params.thread, req.params.comment, { body: req.body?.body, author: "user", draft: req.body?.draft === true });
    // The same words change nothing, and ask nobody: a save that is no change does not wake the agent, or ask again for an ask that failed.
    if (!changed) return res.json(withChat(folder, thread));
    // As a new comment asks: the last comment of a thread that is open. Any other has nothing to ask, but loses an ask that was not taken.
    if (thread.status === "open" && thread.comments.at(-1)?.id === req.params.comment) return res.json(withChat(folder, await asked(folder, store, id, thread, req.body?.chat)));
    if (asksAgent(thread.comments.find((c) => c.id === req.params.comment)?.body)) return res.json(withChat(folder, thread));
    const gone = await store.unping(id, thread.id, req.params.comment);
    if (gone.ping !== undefined) unwake(folder, gone.comment);
    res.json(withChat(folder, gone.thread));
  }));

  portal.router.delete("/folders/:folder/documents/:id/threads/:thread/comments/:comment", route(async (req, res) => {
    const folder = folderOf(req);
    const id = documentOf(req);
    const { removed, thread } = await (await storeFor(folder.path)).remove(id, req.params.thread, req.params.comment, { author: "user", draft: req.query.draft === "1" });
    unwake(folder, req.params.comment);
    res.json({ removed, thread: thread ? withChat(folder, thread) : null });
  }));

  portal.router.delete("/folders/:folder/documents/:id/threads/:thread", route(async (req, res) => {
    const folder = folderOf(req);
    const id = documentOf(req);
    const { removed, comments } = await (await storeFor(folder.path)).removeThread(id, req.params.thread);
    for (const comment of comments) unwake(folder, comment);
    res.json({ removed });
  }));

  portal.router.post("/folders/:folder/documents/:id/threads/:thread/seen", route(async (req, res) => {
    const folder = folderOf(req);
    const id = documentOf(req);
    res.json(withChat(folder, await (await storeFor(folder.path)).seen(id, req.params.thread)));
  }));

  portal.router.post("/folders/:folder/documents/:id/threads/:thread/resolve", small, route(async (req, res) => {
    const folder = folderOf(req);
    const id = documentOf(req);
    res.json(withChat(folder, await (await storeFor(folder.path)).settle(id, req.params.thread, { status: "resolved", body: req.body?.body, author: "user" })));
  }));

  portal.router.post("/folders/:folder/documents/:id/threads/:thread/reopen", small, route(async (req, res) => {
    const folder = folderOf(req);
    const id = documentOf(req);
    res.json(withChat(folder, await (await storeFor(folder.path)).settle(id, req.params.thread, { status: "open", author: "user" })));
  }));

  return async () => {
    stopped = true;
    for (const queued of wakes.values()) clearTimeout(queued.timer);
    wakes.clear();
    for (const entry of watching.values()) clearInterval(entry.timer);
    clearInterval(lists.timer);
    for (const id of [...lists.watchers.keys()]) unwatchDir(id);
    for (const res of [...streams]) res.end();
    const open = [...stores.values()];
    stores.clear();
    for (const pending of open) await pending.then((store) => store.close(), () => {});
  };
}
