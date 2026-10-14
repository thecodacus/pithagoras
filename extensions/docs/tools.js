/**
 * The agent's tools for the documents of the folder its chat works in: list,
 * read, create and edit. They are registered in each chat's pi by the server
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
 *     delete, restore or rewrite the history
 *   - it does not write a secret into a document: the history would keep it
 *
 * A refusal is an error the agent reads, which starts with its code:
 * `not_found`, `exists`, `too_large`, `secret`, `revision_mismatch`,
 * `quote_not_found`, `quote_ambiguous`, `edits_overlap`, `invalid`, or
 * `refused` for anything else the store will not do (its message says what: the
 * folder is full, `documents` is a link, the store is not ready yet).
 */
import { DocError } from "./errors.js";
import { secretsIn } from "./secret.js";
import { DOCUMENTS, isDocumentId } from "./store.js";

/** The most that one doc_edit changes: more is a rewrite, and a new revision of its own is the clearer way. */
const MAX_EDITS = 50;
/** How much of a document one doc_read returns before it says where to read on. */
const READ_CHARS = 60_000;

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
  if (offset > lines[from - 1].length) throw new Refusal("invalid", `char_offset is past the end of line ${from}, which has ${lines[from - 1].length} characters`);
  const first = lines[from - 1].slice(offset);
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

/**
 * Registers the tools in a chat's pi. `deps` is what the server half has: the
 * chat's folder (`folder()`, which throws when it is gone), the folder's
 * store (`store(folder, { make })`), whether it has a documents folder yet
 * (`hasDocuments`), the id the page knows a folder by (`folderId`), a
 * document's title from the start of its text (`titleOf`, `headBytes`) and the
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

  /** What a chat sees of a folder's documents: the project's, and the chat's own. */
  const sees = (doc) => doc.scope === "project" || doc.chat === chat.id;

  /** A refusal as the agent reads it, a store's as a refusal of that code, and anything else as a failure that is logged. */
  function failed(e) {
    if (e instanceof Refusal) return e;
    if (e instanceof DocError) {
      if (e.status === 404) return new Refusal("not_found", e.message);
      if (e.status === 413) return new Refusal("too_large", "a document can be at most 1 MB");
      if (e.extra?.exists !== undefined) return new Refusal("exists", e.message);
      if (e.extra?.revision !== undefined) return new Refusal("revision_mismatch", `${e.message}. Nothing was written. Read the document again with doc_read, then redo the change.`);
      return new Refusal("refused", e.message);
    }
    deps.log(`A document tool failed in chat ${chat.id}: ${e?.stack ?? e}`);
    return new Error("The documents store could not do that");
  }

  /** The tool's work, with what it throws made into what the agent reads. */
  const guarded = (work) => async (_callId, params) => {
    try {
      return await work(params ?? {});
    } catch (e) {
      throw failed(e);
    }
  };

  /** A document the chat sees, by its id, with the store it is in: or `not_found`. */
  async function documentOf(id) {
    if (!isDocumentId(id)) throw new Refusal("not_found", "There is no document with that id. Ids come from doc_list and doc_create");
    const store = await deps.store(folderOf());
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
    description: "List the shared documents of this project that you and the person work on together: each one's id, title, file, revision and whether it is the project's or this chat's own. A document is a Markdown file in the project's documents folder, shown to the person on the Documents page.",
    promptSnippet: "List the shared documents (Markdown, shown to the person on the Documents page)",
    parameters: {
      type: "object",
      properties: { scope: { type: "string", enum: ["chat", "project", "all"], description: "chat: only this chat's own documents. project: the documents of the whole project. all (the default): both." } },
    },
    execute: guarded(async ({ scope = "all" }) => {
      if (!["chat", "project", "all"].includes(scope)) throw new Refusal("invalid", "scope is chat, project or all");
      const folder = folderOf();
      const listed = deps.hasDocuments(folder) ? await (await deps.store(folder, { make: true })).list(deps.headBytes) : [];
      const documents = listed
        .filter((doc) => sees(doc) && (scope === "all" || doc.scope === scope))
        .map(({ head, ...doc }) => ({ ...doc, path: pathOf(doc.name), title: deps.titleOf(head, doc.name) }))
        .sort((a, b) => a.title.localeCompare(b.title) || a.name.localeCompare(b.name));
      if (!documents.length) return text("No documents yet. Make one with doc_create.", { action: "list", documents: [] });
      const lines = documents.map((doc) => `- ${doc.id}  "${doc.title}"  ${doc.path}  revision ${doc.revision}  ${kind(doc)}  changed ${doc.modified}`);
      return text(`${documents.length} document${documents.length === 1 ? "" : "s"}:\n${lines.join("\n")}`, { action: "list", documents: documents.map(({ id, title, path, revision, scope }) => ({ id, title, path, revision, scope })) });
    }),
  });

  pi.registerTool({
    name: "doc_read",
    label: "Read a document",
    description: `Read a shared document by its id: its Markdown and its revision. Read a document before you edit it: doc_edit needs the revision you read. revision reads an earlier revision of it, from its history. A long document is returned in parts of about ${READ_CHARS / 1000} KB: the end of one says where to read on (from_line, and char_offset inside a line that is longer than a part).`,
    promptSnippet: "Read a shared document by id: its Markdown and revision",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document's id, from doc_list or doc_create (not its file name)." },
        revision: { type: "integer", description: "An earlier revision to read instead of the current one." },
        from_line: { type: "integer", description: "The line to start at, to read on in a long document (1 is the first)." },
        char_offset: { type: "integer", description: "With from_line: how many characters into that line to start, to read on in a line that is longer than a part (0 is its start)." },
      },
      required: ["id"],
    },
    execute: guarded(async ({ id, revision, from_line: from = 1, char_offset: offset = 0 }) => {
      whole(from, "from_line");
      whole(offset, "char_offset", 0);
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
      const which = at === doc.revision ? `revision ${at}` : `revision ${at} (an earlier one; it is at ${doc.revision} now)`;
      return text(`"${title}" (id ${doc.id}, ${pathOf(doc.name)}, ${which}, ${kind(doc)} document)\n\n${shown}${more}`, { ...about("read", doc, title), revision: at, current: doc.revision });
    }),
  });

  pi.registerTool({
    name: "doc_create",
    label: "Create a document",
    description: "Make a new shared document, a Markdown file in the project's documents folder that the person sees on the Documents page and can edit with you. It is made at revision 1 and never replaces a document: a title whose file name is taken is refused (read or edit that document, or choose another title). Does not accept secrets.",
    promptSnippet: "Make a new shared document: a title and its Markdown",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "The document's title (at most 200 characters). Its file name is made from it." },
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
      markdown = markdown === undefined || markdown === "" ? `# ${title}\n` : markdown;
      if (secretsIn(markdown).length) throw new Refusal("secret", "The text looks like it holds a secret (a private key or a token). A document keeps every revision: leave it out");
      const store = await deps.store(folderOf(), { make: true });
      const doc = await store.create({ title, markdown, scope, chat: scope === "chat" ? chat.id : null, author: "agent", exclusive: true });
      const shown = deps.titleOf(Buffer.from(markdown, "utf8"), doc.name);
      return text(`Created "${shown}" (id ${doc.id}, ${pathOf(doc.name)}, revision ${doc.revision}, ${kind(doc)} document).`, about("create", doc, shown));
    }),
  });

  pi.registerTool({
    name: "doc_edit",
    label: "Edit a document",
    description: `Change a shared document by replacing quoted text, as doc_read shows it. Each quote must appear exactly once in the document (take enough of the text around it to be sure), and quotes may not overlap; they are all found in the document as it is now. All edits are made or none. expected_revision is the revision you read: if the person (or anything else) changed the document since, nothing is written and you read it again first. Up to ${MAX_EDITS} edits at a time. A replacement may be empty, to remove the quote. Does not accept secrets.`,
    promptSnippet: "Edit a shared document: quoted text and its replacement, on the revision you read",
    promptGuidelines: ["Edit a shared document only with doc_edit, on the revision you read: the person may be editing it too, and a write outside the tool is not checked against their changes."],
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
              quote: { type: "string", description: "Text to replace, exactly as it is in the document, once." },
              replacement: { type: "string", description: "What takes its place: Markdown, or empty to remove the quote." },
            },
            required: ["quote", "replacement"],
          },
        },
      },
      required: ["id", "expected_revision", "edits"],
    },
    execute: guarded(async ({ id, expected_revision: expected, edits }) => {
      whole(expected, "expected_revision");
      if (!Array.isArray(edits) || !edits.length || edits.length > MAX_EDITS) throw new Refusal("invalid", `edits is a list of 1 to ${MAX_EDITS} edits`);
      edits.forEach((edit, i) => {
        if (typeof edit?.quote !== "string" || !edit.quote || typeof edit.replacement !== "string") throw new Refusal("invalid", `edit ${i + 1} needs a quote (not empty) and a replacement (text, or empty)`);
      });
      const { store, doc } = await documentOf(id);
      const current = doc.bytes.toString("utf8");
      const title = deps.titleOf(doc.bytes, doc.name);
      if (doc.revision !== expected) {
        throw new Refusal("revision_mismatch", `"${title}" is at revision ${doc.revision}, not ${expected}: it changed since you read it. Nothing was written. Read it again with doc_read, then redo the change.`);
      }
      // A document written on Windows has CRLF line breaks, which a quote read back as text rarely carries, and
      // what is written into it is to have them too: a document with both keeps the ones most of it has.
      const crlfs = (current.match(/\r\n/g) ?? []).length;
      const dos = crlfs > (current.match(/\n/g) ?? []).length - crlfs;
      // All quotes are looked for in the text as it is, none in the result of another.
      const found = edits.map((edit, i) => {
        let { quote, replacement } = edit;
        let place = find(current, quote);
        if (place.first === -1 && crlfs && quote.includes("\n")) {
          place = find(current, crlf(quote));
          if (place.first !== -1) quote = crlf(quote);
        }
        if (dos || quote.includes("\r\n")) replacement = crlf(replacement);
        const which = edits.length > 1 ? `edit ${i + 1}: ` : "";
        if (place.first === -1) throw new Refusal("quote_not_found", `${which}the quote is not in "${title}" at revision ${doc.revision}. Quote it exactly as doc_read shows it, with its Markdown marks. Nothing was written.`);
        if (place.more) throw new Refusal("quote_ambiguous", `${which}the quote appears more than once in "${title}". Take more of the text around it, so that it appears once. Nothing was written.`);
        return { at: place.first, end: place.first + quote.length, replacement, n: i + 1 };
      });
      found.sort((a, b) => a.at - b.at);
      for (let i = 1; i < found.length; i++) {
        if (found[i].at < found[i - 1].end) throw new Refusal("edits_overlap", `edits ${found[i - 1].n} and ${found[i].n} change text that overlaps. Join them into one edit. Nothing was written.`);
      }
      let out = "";
      let from = 0;
      for (const edit of found) {
        out += current.slice(from, edit.at) + edit.replacement;
        from = edit.end;
      }
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
      if (!saved.changed) return text(`No change: the replacements gave the same text. "${shown}" stays at revision ${saved.revision}.`, details);
      return text(`Edited "${shown}" (${pathOf(doc.name)}): ${n} edit${n === 1 ? "" : "s"} made, now at revision ${saved.revision}.`, details);
    }),
  });
}
