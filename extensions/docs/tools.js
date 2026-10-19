/**
 * The agent's tools for the documents of the folder its chat works in: list,
 * read, create and edit, and comment on one, reply to a comment, change or delete
 * one of its own comments and resolve a thread.
 * They are registered in each chat's pi by the server
 * half (`chats.extend`), only where pi runs in the portal's process, and they
 * go through the same store as the page does (store.js): the same history,
 * the same revisions, the same lock.
 *
 * What the agent may not do is as much a part of them as what it may:
 *
 *   - it names a document by the id the store gave it, never by a path
 *   - it sees the project's documents and its own chat's, not another chat's
 *   - a write says which revision it was made on, and is refused (nothing is
 *     written) when the document has moved on since: the person's edit is not
 *     overwritten by an agent that read an older text
 *   - an edit is quoted text and its replacement, all of them or none
 *   - it makes a new document, never one in place of another, and cannot
 *     rename or delete a document (that is the person's, on the page), restore
 *     or rewrite the history
 *   - it does not write a secret into a document: the history would keep it
 *   - a comment is the agent's, never the person's, and it answers a comment by
 *     changing only the passage the comment is on, and saying in the thread what
 *     it changed
 *   - it changes and deletes its own comments and replies, and never the person's:
 *     it answers those, or resolves the thread
 *   - it is woken only by the person's `@agent` in a comment (ping.js), with the
 *     thread to answer: that gives it the same tools and no others
 *
 * A refusal is an error the agent reads, which starts with its code:
 * `not_found`, `exists`, `too_large`, `secret`, `revision_mismatch`,
 * `quote_not_found`, `quote_ambiguous`, `edits_overlap`, `thread_not_found`,
 * `thread_resolved`, `thread_orphaned`, `comment_not_found`, `comment_not_yours`,
 * `too_many`, `invalid`, or
 * `refused` for anything else the store will not do (its message says what: the
 * folder is full, `documents` is a link, the store is not ready yet).
 */
import { DocError } from "./errors.js";
import { secretsIn } from "./secret.js";
import { callingChat, DOCUMENTS, isDocumentId, MAX_BODY, MAX_COMMENTS } from "./store.js";
import { MAX_QUOTE } from "./web/anchor.js";

/** The most that one doc_edit changes: more is a rewrite, and a new revision of its own is the clearer way. */
const MAX_EDITS = 50;
/** How much of a document one doc_read returns before it says where to read on. */
const READ_CHARS = 60_000;

/** What the agent is told of a documents folder it may not use. */
const CLOSED = "the documents folder of this project is closed to this chat's agent, so it is not used";

class Refusal extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const text = (content, details) => ({ content: [{ type: "text", text: content }], details });

/** A whole number of at least `min`, or a refusal naming what it was for. */
function whole(value, what, min = 1) {
  if (!Number.isInteger(value) || value < min) throw new Refusal("invalid", `${what} must be a whole number of at least ${min}`);
  return value;
}

/** `text` with its line breaks the CRLF ones of a document written on Windows. */
const crlf = (text) => text.replace(/\r?\n/g, "\r\n");

/**
 * A part of `markdown` of about READ_CHARS, from line `from` (1 is the first),
 * `offset` characters into it: the text, the last line it reaches, how many
 * lines there are, and where the next part starts (nothing at the end). A line
 * longer than a part is cut, so that no part is more than a part.
 */
function excerpt(markdown, from, offset) {
  const lines = markdown.split("\n");
  // A text that ends in a line break has no last line after it.
  const total = markdown.endsWith("\n") ? lines.length - 1 : lines.length;
  if (from > total) throw new Refusal("invalid", `from_line is past the end: the document has ${total} line${total === 1 ? "" : "s"}`);
  const line = lines[from - 1];
  if (offset > line.length) throw new Refusal("invalid", `char_offset is past the end of line ${from}, which has ${line.length} characters`);
  // An offset the agent counted itself may fall between the two halves of a character outside the basic plane.
  if (offset > 0 && /[\uD800-\uDBFF]/.test(line[offset - 1]) && /[\uDC00-\uDFFF]/.test(line[offset] ?? "")) {
    throw new Refusal("invalid", `char_offset ${offset} is inside a character of line ${from}: use ${offset - 1} or ${offset + 1}`);
  }
  const first = line.slice(offset);
  if (first.length > READ_CHARS) {
    let cut = READ_CHARS;
    // Not between the two halves of a character outside the basic plane.
    if (/[\uD800-\uDBFF]/.test(first[cut - 1])) cut--;
    return { text: first.slice(0, cut), last: from, total, next: { line: from, offset: offset + cut } };
  }
  const taken = [first];
  let size = first.length + 1;
  let last = from;
  while (last < total && size + lines[last].length + 1 <= READ_CHARS) {
    taken.push(lines[last]);
    size += lines[last++].length + 1;
  }
  const end = last === total;
  return { text: taken.join("\n") + (end && markdown.endsWith("\n") ? "\n" : ""), last, total, next: end ? null : { line: last + 1, offset: 0 } };
}

/** Where `quote` is in `text`: its first place, and whether there is a second. Overlapping places count as two. */
function find(text, quote) {
  const first = text.indexOf(quote);
  if (first === -1) return { first, more: false };
  return { first, more: text.indexOf(quote, first + 1) !== -1 };
}

/** The start of `text`, at most `n` characters of it, with a mark where it was cut (not between the two halves of a character). */
export function clip(text, n) {
  if (text.length <= n) return text;
  return `${text.slice(0, /[\uD800-\uDBFF]/.test(text[n - 1]) ? n - 1 : n)} […]`;
}

/** The line of `text` that `at` is on (1 is the first). */
const lineOf = (text, at) => text.slice(0, at).split("\n").length;

/** A comment's time as the agent reads it: to the minute, in UTC. */
const minute = (iso) => iso.slice(0, 16).replace("T", " ");

/** The most open threads, and the most comments of one thread, that doc_read shows in full. */
const MOST_THREADS = 30;
const MOST_SHOWN = 10;
/** How much of a passage doc_read shows. */
const PASSAGE_CHARS = 400;

/**
 * The comment threads of a document as doc_read shows them: each with its id,
 * the passage it is on, where that is and what was said, the person's and the
 * agent's own comments. `text` is the document's text, which the passages are
 * places in. Nothing for a document with none to show.
 */
function describeThreads(threads, text, which) {
  const shown = threads.filter((t) => which === "all" || t.status === "open");
  const resolved = threads.length - threads.filter((t) => t.status === "open").length;
  if (!shown.length) return resolved && which !== "all" ? `\n\n[No open comments. ${resolved} resolved: doc_read with comments=all shows them.]` : "";
  const blocks = shown.slice(0, MOST_THREADS).map((t) => {
    const where = t.orphaned ? "its passage is no longer in the document" : `on line ${lineOf(text, t.start)}`;
    const said = t.comments.slice(-MOST_SHOWN);
    const omitted = t.comments.length - said.length;
    // The agent's own comments carry their ids, for doc_edit_comment and doc_delete_comment; an edited one says so.
    const lines = said.map((c) => `${c.author === "agent" ? "agent" : "person"} (${[`${minute(c.at)} UTC`, c.author === "agent" && `comment ${c.id}`, c.edited && "edited"].filter(Boolean).join(", ")}): ${c.body}`);
    return [`Thread ${t.id} (${t.status}, ${where}${t.toAgent ? ", asks you" : ""})`, `Passage${t.orphaned ? " when it was last in the document" : ""}:`, ...clip(t.quote, PASSAGE_CHARS).split("\n").map((l) => `> ${l}`), ...(omitted ? [`[${omitted} earlier comment${omitted === 1 ? "" : "s"} not shown]`] : []), ...lines].join("\n");
  });
  const open = threads.filter((t) => t.status === "open").length;
  const head = which === "all" ? `Comments: ${threads.length} thread${threads.length === 1 ? "" : "s"}, ${open} open` : `Open comments: ${open}${resolved ? ` (${resolved} resolved, not shown)` : ""}`;
  const more = shown.length > MOST_THREADS ? `\n[${shown.length - MOST_THREADS} more thread${shown.length - MOST_THREADS === 1 ? "" : "s"} not shown]` : "";
  // A thread the person wrote @agent in asks the agent for an answer, in the thread.
  const asking = shown.some((t) => t.toAgent) ? " A thread marked \"asks you\" has @agent in the person's last comment: answer it in the thread." : "";
  return `\n\n${head}. Answer one with doc_reply, or with doc_edit given its thread; close it with doc_resolve.${asking}\n\n${blocks.join("\n\n")}${more}`;
}

/**
 * Registers the tools in a chat's pi. `deps` is what the server half has: the
 * chat's folder (`folder()`, which throws when it is gone), the folder's
 * store (`store(folder, { make })`), whether it has a documents folder yet
 * (`hasDocuments(folder, chat)`, `closed(folder, chat)`: whether it is one this chat's agent may not use, and `unreachable(folder, chat)`: whether the folder
 * itself is one it may not look into), the id the page knows a folder by (`folderId`), a
 * document's title from the start of its text (`titleOf`, `headBytes`), the
 * Markdown a new document called by a title starts with (`headed`) and the
 * portal's log.
 */
export function documentTools(pi, chat, deps) {
  /** The chat's folder, or a refusal: it is where the documents are. */
  function folderOf() {
    try {
      return deps.folder();
    } catch {
      throw new Refusal("not_found", "This chat's folder is gone");
    }
  }

  /**
   * The folder's store, but not for a chat whose agent may not look into the folder: it is refused before the store (and what the portal, as root, would look
   * at in the folder to find or move one) is touched, with the same words whatever is in the folder.
   */
  async function storeOf(folder, options) {
    if (deps.unreachable(folder, chat.id)) throw new Refusal("closed", CLOSED);
    return deps.store(folder, options);
  }

  /** What a chat sees of a folder's documents: the project's, and the chat's own. */
  const sees = (doc) => doc.scope === "project" || doc.chat === chat.id;

  /** A refusal as the agent reads it, a store's as a refusal of that code, and anything else as a failure that is logged. */
  function failed(e) {
    if (e instanceof Refusal) return e;
    if (e instanceof DocError) {
      // A failure of the store's own (git, the database) is for the log and the person, who is told on the Documents page what is wrong and
      // how to mend it: the agent is told only that, not where the store is or what to delete in it, which it could do with its own commands.
      if (e.status === 500 || e.operator) {
        deps.log(`A document tool failed in chat ${chat.id}: ${e.message}`);
        return new Refusal("refused", "the documents store of this folder cannot be used just now. Tell the person: the Documents page says what is wrong and how to mend it. Do not try to repair it yourself");
      }
      // The comments' refusals say what they are: a thread that is not there, a quote that is not in the text, a comment too long.
      // (A document that is not there says `deleted` to the page, which tells it from the portal's own 404; to the agent it is `not_found` as it was.)
      if (e.extra?.code && e.extra.code !== "revision_mismatch" && e.extra.code !== "deleted") return new Refusal(e.extra.code, e.message);
      if (e.status === 404) return new Refusal("not_found", e.message);
      if (e.status === 413) return new Refusal("too_large", "a document can be at most 1 MB");
      if (e.extra?.exists !== undefined) return new Refusal("exists", e.message);
      if (e.extra?.revision !== undefined) return new Refusal("revision_mismatch", `${e.message}. Nothing was written. Read the document again with doc_read, then redo the change.`);
      return new Refusal("refused", e.message);
    }
    deps.log(`A document tool failed in chat ${chat.id}: ${e?.stack ?? e}`);
    return new Error("The documents store could not do that");
  }

  /**
   * The tool's work, with what it throws made into what the agent reads. It is done as this chat's: what the store does for it, the agent of this
   * chat must be able to use the folder for (`callingChat`), whatever chats the folder's own list has.
   */
  const guarded = (work) => async (_callId, params) => {
    try {
      return await callingChat.run(chat.id, () => work(params ?? {}));
    } catch (e) {
      throw failed(e);
    }
  };

  /** A document the chat sees, by its id, with the store it is in: or `not_found`. */
  async function documentOf(id) {
    if (!isDocumentId(id)) throw new Refusal("not_found", "There is no document with that id. Ids come from doc_list and doc_create");
    const store = await storeOf(folderOf());
    const doc = await store.read(id);
    if (!sees(doc)) throw new Refusal("not_found", "There is no document with that id. Ids come from doc_list and doc_create");
    return { store, doc };
  }

  const pathOf = (name) => `${DOCUMENTS}/${name}`;
  const kind = (doc) => (doc.scope === "chat" ? "this chat's" : "project");
  /** What the card and the next call need of a document: where it is and where it stands. */
  const about = (action, doc, title) => ({ action, folder: deps.folderId(folderOf()), id: doc.id, name: doc.name, path: pathOf(doc.name), title, revision: doc.revision, scope: doc.scope });

  pi.registerTool({
    name: "doc_list",
    label: "List documents",
    description: "List the shared documents of this project that you and the person work on together: each one's id, title, file, revision, whether it is the project's or this chat's own, and how many comments on it are open. A document is a Markdown file in the project's documents folder, shown to the person on the Documents page.",
    promptSnippet: "List the shared documents (Markdown, shown to the person on the Documents page)",
    parameters: {
      type: "object",
      properties: { scope: { type: "string", enum: ["chat", "project", "all"], description: "chat: only this chat's own documents. project: the documents of the whole project. all (the default): both." } },
    },
    execute: guarded(async ({ scope = "all" }) => {
      if (!["chat", "project", "all"].includes(scope)) throw new Refusal("invalid", "scope is chat, project or all");
      const folder = folderOf();
      const there = deps.hasDocuments(folder, chat.id);
      // A documents folder this chat's agent may not use is said, not taken for none: "No documents yet" would be untrue, and would send the agent to doc_create.
      if (!there && deps.closed(folder, chat.id)) throw new Refusal("closed", CLOSED);
      const listed = there ? await (await storeOf(folder, { make: true })).list(deps.headBytes) : [];
      const documents = listed
        .filter((doc) => sees(doc) && (scope === "all" || doc.scope === scope))
        .map(({ head, ...doc }) => ({ ...doc, path: pathOf(doc.name), title: deps.titleOf(head, doc.name) }))
        .sort((a, b) => a.title.localeCompare(b.title) || a.name.localeCompare(b.name));
      if (!documents.length) return text("No documents yet. Make one with doc_create.", { action: "list", documents: [] });
      const lines = documents.map((doc) => `- ${doc.id}  "${doc.title}"  ${doc.path}  revision ${doc.revision}  ${kind(doc)}  changed ${doc.modified}${doc.openThreads ? `  ${doc.openThreads} open comment${doc.openThreads === 1 ? "" : "s"}${doc.askingThreads ? ` (${doc.askingThreads} ask${doc.askingThreads === 1 ? "s" : ""} you)` : ""}` : ""}`);
      return text(`${documents.length} document${documents.length === 1 ? "" : "s"}:\n${lines.join("\n")}`, { action: "list", documents: documents.map(({ id, title, path, revision, scope, openThreads, askingThreads }) => ({ id, title, path, revision, scope, openThreads, askingThreads })) });
    }),
  });

  pi.registerTool({
    name: "doc_read",
    label: "Read a document",
    description: `Read a shared document by its id: its Markdown and its revision, and after the text the comment threads on it that are open, each with its id, the passage it is on and what was said. Read a document before you edit it: doc_edit needs the revision you read. revision reads an earlier revision of it, from its history. A long document is returned in parts of about ${READ_CHARS.toLocaleString("en-US")} characters: the end of one says where to read on (from_line, and char_offset inside a line that is longer than a part); the comments come with the first part.`,
    promptSnippet: "Read a shared document by id: its Markdown, revision and open comments",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document's id, from doc_list or doc_create (not its file name)." },
        revision: { type: "integer", description: "An earlier revision to read instead of the current one." },
        from_line: { type: "integer", description: "The line to start at, to read on in a long document (1 is the first)." },
        char_offset: { type: "integer", description: "With from_line: how many characters into that line to start, to read on in a line that is longer than a part (0 is its start)." },
        comments: { type: "string", enum: ["open", "all", "none"], description: "Which comment threads to show after the text: open (the default), all (resolved ones too) or none." },
      },
      required: ["id"],
    },
    execute: guarded(async ({ id, revision, from_line: from = 1, char_offset: offset = 0, comments: which = "open" }) => {
      whole(from, "from_line");
      whole(offset, "char_offset", 0);
      if (!["open", "all", "none"].includes(which)) throw new Refusal("invalid", "comments is open, all or none");
      const { store, doc } = await documentOf(id);
      let bytes = doc.bytes;
      let at = doc.revision;
      if (revision !== undefined && whole(revision, "revision") !== doc.revision) {
        const earlier = await store.revision(doc.id, revision);
        bytes = earlier.bytes;
        at = earlier.revision;
      }
      const markdown = bytes.toString("utf8");
      const title = deps.titleOf(bytes, doc.name);
      let shown = markdown;
      let more = "";
      if (from > 1 || offset > 0 || markdown.length > READ_CHARS) {
        const part = excerpt(markdown, from, offset);
        shown = part.text;
        const where = `Lines ${from}-${part.last} of ${part.total}`;
        if (!part.next) more = `\n[${where}: the end.]`;
        else if (part.next.offset) more = `\n[${where}, the last one only in part. Read on with from_line=${part.next.line}, char_offset=${part.next.offset}.]`;
        else more = `\n[${where}. Read on with from_line=${part.next.line}.]`;
      }
      const where = at === doc.revision ? `revision ${at}` : `revision ${at} (an earlier one; it is at ${doc.revision} now)`;
      // The comments are about the text as it is now, and come once, with the first part.
      let comments = "";
      if (which !== "none" && at === doc.revision && from === 1 && offset === 0) {
        const listed = await store.threads(doc.id);
        // The text the passages are in is the one the store followed them to: if the document moved meanwhile, they are not shown against this one.
        if (listed.revision === doc.revision) comments = describeThreads(listed.threads, markdown, which);
      }
      // Where the text ends, where the comments follow it: right after its last character, so that the blank lines it
      // ends with (or a last line with no line break) are seen as they are, and not as the space before the comments.
      const end = comments && !more ? "[End of the document.]" : "";
      return text(`"${title}" (id ${doc.id}, ${pathOf(doc.name)}, ${where}, ${kind(doc)} document)\n\n${shown}${more}${end}${comments}`, { ...about("read", doc, title), revision: at, current: doc.revision });
    }),
  });

  pi.registerTool({
    name: "doc_create",
    label: "Create a document",
    description: "Make a new shared document, a Markdown file in the project's documents folder that the person sees on the Documents page and can edit with you. It is made at revision 1 and never replaces a document: a title whose file name is taken is refused (read or edit that document, or choose another title). A document is called by its first heading: Markdown without one starts with the title as its heading, Markdown with one is called by it. Changing that heading later changes what it is called, never its file name. Does not accept secrets.",
    promptSnippet: "Make a new shared document: a title and its Markdown",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "The document's title (at most 200 characters). Its file name is made from it, and it is the first heading unless the Markdown has one." },
        markdown: { type: "string", description: "Its Markdown (at most 1 MB). Left out, the document is its title as a heading." },
        scope: { type: "string", enum: ["project", "chat"], description: "project (the default): every chat in this project sees it. chat: only this chat." },
      },
      required: ["title"],
    },
    execute: guarded(async ({ title, markdown, scope = "project" }) => {
      title = typeof title === "string" ? title.trim() : "";
      if (!title || title.length > 200) throw new Refusal("invalid", "A document needs a title of at most 200 characters");
      if (markdown !== undefined && typeof markdown !== "string") throw new Refusal("invalid", "markdown must be text");
      if (scope !== "project" && scope !== "chat") throw new Refusal("invalid", "scope is project or chat");
      markdown = deps.headed(markdown ?? "", title);
      if (secretsIn(markdown).length) throw new Refusal("secret", "The text looks like it holds a secret (a private key or a token). A document keeps every revision: leave it out");
      const store = await storeOf(folderOf(), { make: true });
      const doc = await store.create({ title, markdown, scope, chat: scope === "chat" ? chat.id : null, author: "agent", exclusive: true });
      const shown = deps.titleOf(Buffer.from(markdown, "utf8"), doc.name);
      return text(`Created "${shown}" (id ${doc.id}, ${pathOf(doc.name)}, revision ${doc.revision}, ${kind(doc)} document).`, about("create", doc, shown));
    }),
  });

  pi.registerTool({
    name: "doc_edit",
    label: "Edit a document",
    description: `Change a shared document by replacing quoted text, as doc_read shows it. Each quote must appear exactly once in the document (take enough of the text around it to be sure), and quotes may not overlap; they are all found in the document as it is now. All edits are made or none. expected_revision is the revision you read: if the person (or anything else) changed the document since, nothing is written and you read it again first. Up to ${MAX_EDITS} edits at a time. A replacement may be empty, to remove the quote. Does not accept secrets. To answer a comment by changing the document, give its thread and a reply: the quotes are then looked for only in the passage the comment is on (each must appear once there), nothing else in the document is changed, and the reply is added to the thread, so say in it what you changed.`,
    promptSnippet: "Edit a shared document: quoted text and its replacement, on the revision you read",
    promptGuidelines: [
      "Edit a shared document only with doc_edit, on the revision you read: the person may be editing it too, and a write outside the tool is not checked against their changes.",
      "To answer a comment on a shared document by changing it, use doc_edit with the comment's thread and a reply that says what you changed. Change only the passage the comment is on; if the answer needs a change elsewhere, say so in a reply and let the person decide.",
    ],
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document's id, from doc_list or doc_create." },
        expected_revision: { type: "integer", description: "The revision you read (or the one your last edit returned)." },
        edits: {
          type: "array",
          minItems: 1,
          maxItems: MAX_EDITS,
          items: {
            type: "object",
            properties: {
              quote: { type: "string", description: "Text to replace, exactly as it is in the document, once (with thread: once in the comment's passage)." },
              replacement: { type: "string", description: "What takes its place: Markdown, or empty to remove the quote (whole lines removed take their line breaks with them)." },
            },
            required: ["quote", "replacement"],
          },
        },
        thread: { type: "string", description: "The id of the comment thread this change answers, from doc_read. The edits are then made only inside its passage, and reply is required." },
        reply: { type: "string", description: `With thread: what you changed, for the person to read in the thread (at most ${MAX_BODY} bytes). Markdown.` },
      },
      required: ["id", "expected_revision", "edits"],
    },
    execute: guarded(async ({ id, expected_revision: expected, edits, thread: threadId, reply }) => {
      whole(expected, "expected_revision");
      if (!Array.isArray(edits) || !edits.length || edits.length > MAX_EDITS) throw new Refusal("invalid", `edits is a list of 1 to ${MAX_EDITS} edits`);
      edits.forEach((edit, i) => {
        if (typeof edit?.quote !== "string" || !edit.quote || typeof edit.replacement !== "string") throw new Refusal("invalid", `edit ${i + 1} needs a quote (not empty) and a replacement (text, or empty)`);
      });
      if (threadId !== undefined && typeof threadId !== "string") throw new Refusal("invalid", "thread is a thread's id, from doc_read");
      if (threadId === undefined && reply !== undefined) throw new Refusal("invalid", "reply goes with thread: it is added to that thread");
      if (threadId !== undefined && (typeof reply !== "string" || !reply.trim())) throw new Refusal("invalid", "an edit that answers a comment needs a reply saying what was changed");
      const { store, doc } = await documentOf(id);
      const current = doc.bytes.toString("utf8");
      const title = deps.titleOf(doc.bytes, doc.name);
      if (doc.revision !== expected) {
        throw new Refusal("revision_mismatch", `"${title}" is at revision ${doc.revision}, not ${expected}: it changed since you read it. Nothing was written. Read it again with doc_read, then redo the change.`);
      }
      // With a thread, the part of the document the quotes are looked for in is the comment's passage. Checked before anything is written.
      let scope = { from: 0, to: current.length };
      let thread = null;
      if (threadId !== undefined) {
        store.bodyOf(reply);
        thread = await threadOf(store, doc, current, threadId, { open: true, placed: true });
        if (thread.orphaned) throw new Refusal("thread_orphaned", "the passage this comment was on is no longer in the document, so there is no passage to change. Reply with doc_reply, or edit without thread.");
        if (thread.comments.length >= MAX_COMMENTS) throw new Refusal("too_many", `the thread has ${MAX_COMMENTS} comments, which is the most`);
        scope = { from: thread.start, to: thread.end };
      }
      const haystack = current.slice(scope.from, scope.to);
      // A document written on Windows has CRLF line breaks, which a quote read back as text rarely carries, and
      // what is written into it is to have them too: a document with both keeps the ones most of it has.
      const crlfs = (current.match(/\r\n/g) ?? []).length;
      const dos = crlfs > (current.match(/\n/g) ?? []).length - crlfs;
      // All quotes are looked for in the text as it is, none in the result of another.
      const found = edits.map((edit, i) => {
        let { quote, replacement } = edit;
        let place = find(haystack, quote);
        if (place.first === -1 && crlfs && quote.includes("\n")) {
          place = find(haystack, crlf(quote));
          if (place.first !== -1) quote = crlf(quote);
        }
        // A quote that starts with the line feed of a CRLF break has the carriage return in front of it: it is replaced with it,
        // or it would be left with nothing after it, or in front of the replacement's own line break.
        let at = place.first === -1 ? -1 : scope.from + place.first;
        if (at > 0 && quote.startsWith("\n") && current[at - 1] === "\r") {
          at--;
          quote = `\r${quote}`;
        }
        if (dos || quote.includes("\r\n")) replacement = crlf(replacement);
        const which = edits.length > 1 ? `edit ${i + 1}: ` : "";
        const within = thread ? ` in the passage of thread ${thread.id}` : "";
        if (place.first === -1) throw new Refusal("quote_not_found", `${which}the quote is not in "${title}" at revision ${doc.revision}${within}. Quote it exactly as doc_read shows it, with its Markdown marks. Nothing was written.`);
        if (place.more) throw new Refusal("quote_ambiguous", `${which}the quote appears more than once in "${title}"${within}. Take more of the text around it, so that it appears once. Nothing was written.`);
        return { at, end: at + quote.length, replacement, n: i + 1 };
      });
      found.sort((a, b) => a.at - b.at);
      for (let i = 1; i < found.length; i++) {
        if (found[i].at < found[i - 1].end) throw new Refusal("edits_overlap", `edits ${found[i - 1].n} and ${found[i].n} change text that overlaps. Join them into one edit. Nothing was written.`);
      }
      // A quote of whole lines (a line, a paragraph) taken out leaves the line breaks on both sides of it, and so
      // more blank lines than either side had. They are made as many as the larger side had, or, at the start or
      // the end of the document, as it had there: a line removed leaves no gap. Only the line breaks between this
      // edit and the next are looked at. With a thread they are counted as the document has them, and only those
      // in its passage are taken out: a passage that starts or ends at a line break has the rest outside it.
      const eol = dos ? "\r\n" : "\n";
      const breaks = (run) => (run.match(/\n/g) ?? []).length;
      let out = "";
      let from = 0;
      found.forEach((edit, i) => {
        out += current.slice(from, edit.at) + edit.replacement;
        from = edit.end;
        const quote = current.slice(edit.at, edit.end);
        if (edit.replacement || !/[^\r\n]/.test(quote)) return;
        const left = /[\r\n]*$/.exec(current.slice(found[i - 1]?.end ?? 0, edit.at))[0];
        const right = /^[\r\n]*/.exec(current.slice(edit.end, found[i + 1]?.at ?? current.length))[0];
        const sides = [breaks(left) + breaks(/^[\r\n]*/.exec(quote)[0]), breaks(/[\r\n]*$/.exec(quote)[0]) + breaks(right)];
        const keep = edit.at === left.length ? sides[0] : edit.end + right.length === current.length ? sides[1] : Math.max(...sides);
        const ownLeft = left.slice(Math.max(0, scope.from - (edit.at - left.length)));
        const ownRight = right.slice(0, Math.max(0, scope.to - edit.end));
        const cut = Math.min(breaks(left) + breaks(right) - keep, breaks(ownLeft) + breaks(ownRight));
        if (cut <= 0) return;
        out = out.slice(0, out.length - ownLeft.length) + eol.repeat(breaks(ownLeft) + breaks(ownRight) - cut);
        from = edit.end + ownRight.length;
      });
      out += current.slice(from);
      // What is written, not each replacement alone: a token can be made of the document's text and a replacement. One the
      // document holds already stays (the person was warned of it, and may keep it); a new one, or a changed one, is not let in.
      const had = secretsIn(current);
      const now = secretsIn(out);
      if (now.length > had.length || now.some((secret) => !had.includes(secret))) {
        throw new Refusal("secret", "the text would hold a secret (a private key or a token). A document keeps every revision: leave it out. Nothing was written.");
      }
      // Written on the revision that was read: if the person saved in the meantime, the store refuses it and nothing is written.
      const saved = await store.save(doc.id, { markdown: out, base: doc.revision, author: "agent" });
      const shown = deps.titleOf(Buffer.from(out, "utf8"), doc.name);
      const n = found.length;
      const details = { ...about("edit", saved, shown), from: doc.revision, edits: n, changed: saved.changed };
      let said = saved.changed ? `Edited "${shown}" (${pathOf(doc.name)}): ${n} edit${n === 1 ? "" : "s"} made, now at revision ${saved.revision}.` : `No change: the replacements gave the same text. "${shown}" stays at revision ${saved.revision}.`;
      if (thread) {
        details.thread = thread.id;
        // The passage is the words that stand there now: it is known, and not left to be worked out from the two texts.
        if (saved.changed) await store.place(doc.id, thread.id, { revision: saved.revision, start: scope.from, end: scope.to + out.length - current.length }).catch(() => false);
        // The change is made: a reply that cannot be added is said, and the agent adds it with doc_reply.
        try {
          await store.reply(doc.id, thread.id, { body: reply, author: "agent" });
          said += ` Your reply is in thread ${thread.id}.`;
          details.replied = true;
        } catch (e) {
          const why = failed(e).message;
          deps.log(`A reply to a comment thread of a document could not be added in chat ${chat.id}: ${why}`);
          said += ` The reply could not be added to thread ${thread.id} (${why}): add it with doc_reply.`;
        }
      }
      return text(said, details);
    }),
  });

  /**
   * A thread of the document `doc` (whose text is `current`), by its id: or a refusal. `open`: it must be open. `placed`: its
   * passage must be a place in `current` (the document has not moved on since it was read), which a change to the passage needs.
   */
  async function threadOf(store, doc, current, id, { open = false, placed = false } = {}) {
    if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id)) throw new Refusal("thread_not_found", "There is no comment thread with that id. Ids come from doc_read");
    const listed = await store.threads(doc.id);
    const thread = listed.threads.find((t) => t.id === id);
    if (!thread) throw new Refusal("thread_not_found", "There is no comment thread with that id on this document. Ids come from doc_read");
    if (open && thread.status !== "open") throw new Refusal("thread_resolved", "The thread is resolved: the person opens it again to go on with it");
    // The passages are places in the text the store followed them to; if the document moved on since it was read, they are not places in it.
    if (placed && (listed.revision !== doc.revision || (!thread.orphaned && current.slice(thread.start, thread.end) !== thread.quote))) {
      throw new Refusal("revision_mismatch", `"${deps.titleOf(doc.bytes, doc.name)}" changed since you read it (it is at revision ${listed.revision}, not ${doc.revision}). Nothing was written. Read it again with doc_read, then redo the change.`);
    }
    return thread;
  }

  /** The comment text of a tool call, or a refusal: the store holds it to its size. */
  const commentOf = (value, what = "comment") => {
    if (typeof value !== "string" || !value.trim()) throw new Refusal("invalid", `${what} is the text of the comment (not empty)`);
    return value;
  };

  pi.registerTool({
    name: "doc_comment",
    label: "Comment on a document",
    description: `Start a comment thread on a passage of a shared document, for the person to read on the Documents page: a question, a note on why you wrote it that way, or something to look at. quote is the passage, exactly as doc_read shows it and once in the document; the comment is anchored to it and stays with it when the text around it changes. The comment is Markdown, at most ${MAX_BODY} bytes. It does not change the document. The person's comments on a document are read with doc_read.`,
    promptSnippet: "Comment on a passage of a shared document: a quote from it and the comment",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document's id, from doc_list or doc_create." },
        quote: { type: "string", description: `The passage to comment on, exactly as it is in the document, once (at most ${MAX_QUOTE} characters).` },
        comment: { type: "string", description: "What you want to say." },
      },
      required: ["id", "quote", "comment"],
    },
    execute: guarded(async ({ id, quote, comment }) => {
      if (typeof quote !== "string" || !quote.trim()) throw new Refusal("invalid", "quote is the passage to comment on (not empty)");
      if (quote.length > MAX_QUOTE) throw new Refusal("too_large", `quote can be at most ${MAX_QUOTE} characters: comment on less of the text`);
      commentOf(comment);
      const { store, doc } = await documentOf(id);
      const current = doc.bytes.toString("utf8");
      const title = deps.titleOf(doc.bytes, doc.name);
      const crlfs = /\r\n/.test(current);
      let place = find(current, quote);
      let exact = quote;
      if (place.first === -1 && crlfs && quote.includes("\n")) {
        place = find(current, crlf(quote));
        if (place.first !== -1) exact = crlf(quote);
      }
      if (place.first === -1) throw new Refusal("quote_not_found", `the quote is not in "${title}" at revision ${doc.revision}. Quote it exactly as doc_read shows it, with its Markdown marks. Nothing was written.`);
      if (place.more) throw new Refusal("quote_ambiguous", `the quote appears more than once in "${title}". Take more of the text around it, so that it appears once. Nothing was written.`);
      const made = await store.addThread(doc.id, { base: doc.revision, quote: exact, start: place.first, body: comment, author: "agent" });
      return text(`Commented on "${clip(made.quote, 80)}" in "${title}" (${pathOf(doc.name)}), thread ${made.id}. The person sees it on the Documents page.`, { ...about("comment", doc, title), thread: made.id });
    }),
  });

  pi.registerTool({
    name: "doc_reply",
    label: "Reply to a comment",
    description: `Add a comment to an open comment thread of a shared document, from doc_read: an answer, a question back, or a note on what you did. If you did something about the comment, say what, so that the person can see it without comparing revisions. The reply is Markdown, at most ${MAX_BODY} bytes. It does not change the document and does not resolve the thread.`,
    promptSnippet: "Reply to a comment thread of a shared document, saying what was done",
    promptGuidelines: [
      "A reply to a comment says what was done about it (what you changed and where, or why you left the text as it is), not only that you read it.",
      "A comment on a shared document that has @agent in it is addressed to you: answer it in its thread (doc_reply, or doc_edit with the thread), not only in the chat.",
    ],
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document's id." },
        thread: { type: "string", description: "The thread's id, from doc_read." },
        comment: { type: "string", description: "The reply." },
      },
      required: ["id", "thread", "comment"],
    },
    execute: guarded(async ({ id, thread: threadId, comment }) => {
      commentOf(comment);
      const { store, doc } = await documentOf(id);
      const title = deps.titleOf(doc.bytes, doc.name);
      const made = await store.reply(doc.id, typeof threadId === "string" ? threadId : "", { body: comment, author: "agent" });
      return text(`Replied in thread ${made.id} on "${title}" (${made.comments.length} comment${made.comments.length === 1 ? "" : "s"} in it).`, { ...about("reply", doc, title), thread: made.id });
    }),
  });

  pi.registerTool({
    name: "doc_edit_comment",
    label: "Edit a comment",
    description: `Change the text of one of your own comments or replies in a comment thread of a shared document: comment_id is the id doc_read shows on it. It is shown to the person as edited. Use it to correct what you said, not to answer: a thread that asks you (@agent) is answered with doc_reply. The person's comments are not yours to change. The new text is Markdown, at most ${MAX_BODY} bytes.`,
    promptSnippet: "Change one of your own comments in a shared document's thread",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document's id." },
        thread: { type: "string", description: "The thread's id, from doc_read." },
        comment_id: { type: "string", description: "The id of your comment, as doc_read shows it." },
        comment: { type: "string", description: "The new text of the comment." },
      },
      required: ["id", "thread", "comment_id", "comment"],
    },
    execute: guarded(async ({ id, thread: threadId, comment_id: commentId, comment }) => {
      commentOf(comment);
      const { store, doc } = await documentOf(id);
      const title = deps.titleOf(doc.bytes, doc.name);
      const { thread: made } = await store.edit(doc.id, threadId, commentId, { body: comment, author: "agent" });
      return text(`Changed your comment in thread ${made.id} on "${title}".${made.toAgent ? " The thread still asks you: answer it with doc_reply." : ""}`, { ...about("edit_comment", doc, title), thread: made.id, comment: commentId });
    }),
  });

  pi.registerTool({
    name: "doc_delete_comment",
    label: "Delete a comment",
    description: "Delete one of your own comments or replies from a comment thread of a shared document: comment_id is the id doc_read shows on it. If it was the only comment of the thread, the thread goes with it. The person's comments are not yours to delete: to deal with one, answer it with doc_reply or close the thread with doc_resolve.",
    promptSnippet: "Delete one of your own comments from a shared document's thread",
    promptGuidelines: ["Change or delete only your own comments in a shared document's threads. A comment of the person's is theirs: answer it with doc_reply, or close the thread with doc_resolve, and do not try to remove it."],
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document's id." },
        thread: { type: "string", description: "The thread's id, from doc_read." },
        comment_id: { type: "string", description: "The id of your comment, as doc_read shows it." },
      },
      required: ["id", "thread", "comment_id"],
    },
    execute: guarded(async ({ id, thread: threadId, comment_id: commentId }) => {
      const { store, doc } = await documentOf(id);
      const title = deps.titleOf(doc.bytes, doc.name);
      const gone = await store.remove(doc.id, threadId, commentId, { author: "agent" });
      const left = gone.thread?.comments.length;
      const said = gone.removed === "thread" ? `Deleted your comment from "${title}". It was the only one in its thread, so the thread went with it.` : `Deleted your comment from thread ${gone.thread.id} on "${title}" (${left} comment${left === 1 ? "" : "s"} left in it).${gone.thread.toAgent ? " The thread still asks you: answer it with doc_reply." : ""}`;
      return text(said, { ...about("delete_comment", doc, title), thread: threadId, comment: commentId, removed: gone.removed });
    }),
  });

  pi.registerTool({
    name: "doc_resolve",
    label: "Resolve a comment",
    description: `Resolve a comment thread of a shared document, from doc_read: it is closed, shown as resolved to the person, and they can open it again. Resolve a thread when what it asked for is done or it is answered for good, and say in comment what was done (Markdown, at most ${MAX_BODY} bytes). Leave a thread open when the person still has to weigh in. Resolving a thread the person asked you in (@agent) is an answer like a reply: they are told that you answered.`,
    promptSnippet: "Resolve a comment thread of a shared document, saying what was done",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document's id." },
        thread: { type: "string", description: "The thread's id, from doc_read." },
        comment: { type: "string", description: "A last comment saying what was done." },
      },
      required: ["id", "thread"],
    },
    execute: guarded(async ({ id, thread: threadId, comment }) => {
      if (comment !== undefined) commentOf(comment);
      const { store, doc } = await documentOf(id);
      const title = deps.titleOf(doc.bytes, doc.name);
      const wasOpen = (await threadOf(store, doc, "", threadId)).status === "open";
      const made = await store.settle(doc.id, threadId, { status: "resolved", body: comment, author: "agent" });
      return text(wasOpen ? `Resolved thread ${made.id} on "${title}".` : `Thread ${made.id} on "${title}" was resolved already; nothing changed.`, { ...about("resolve", doc, title), thread: made.id, changed: wasOpen });
    }),
  });
}
