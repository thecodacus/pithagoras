/**
 * The agent's office tools (plan 5.5): list, create, read, edit and list the comments of the
 * documents this home owns or was granted in the office library (store.ts), docs-extension-style
 * -- named by id, base-revision writes, coded error prefixes ("error:<code> <message>", the exact
 * docs convention with the "error:" prefix the office contract fixes).
 *
 * Ownership scope (plan 2.1): `registerTools` walks every chat through portal.chats.extend; for a
 * chat it resolves the workspace folder (chats.folder(chat.id)), finds it in folders.list() by path
 * and REGISTER ONLY when its kind is "agent" or "project". The tool scope is then docsForHome(home),
 * where `home` is the folder's home chat: the sessions working in that folder (chats.inFolder) are
 * its home chats, deterministically picked as the lowest id -- exactly ping.ts' resolveMention rule,
 * so a doc created here is owned by the same chat a mention wakes it to. Docs outside the scope are
 * invisible to every tool: office_read asks for them and hears the same "no document with that id"
 * as for a nonexistent one (docs convention -- no other chat's documents leak through).
 *
 * Revision model (plan 5.5/5.7): the mtimeMs of the library file IS the revision. office_edit
 * takes baseRevision (= the mtimeMs office_read showed), GATES FIRST (>1 ms drift ->
 * "error:revision_mismatch ..." with the fresh mtime, nothing written), and store.persistBytes re-
 * gates strictly at write time anyway. With coEdit on and an open human editor session (live.ts),
 * the agent does not refuse -- it FORCESAVEs the dirty DS session first via the forcesave hook
 * (T-WIRE registers the real one, the DS status-6 command; default is a no-op that logs), AWAITS
 * it, and RE-GATES, because the forced save itself moved the revision. An open session never blocks;
 * a stale baseRevision always fails.
 *
 * Wakes (plan 5.4 step 4 -- "the drain side"): ping.ts only QUEUES wakes server-side and rings the
 * bell with chats.tell(chatId, {type:"ping"}). The office pi extension registered from THIS factory
 * listens on the UI_RECEIVE bus event ("pithagoras:v1:ui:receive", the core/docs constant) and drains
 * the queue per entry via pi.sendMessage({customType:"office-comment-ping", ...},
 * {deliverAs:"followUp", triggerTurn:true}), docs' hearPings pattern.
 *
 * Injection seams (unit tests must never reach portal()): registerTools(opts) takes the portal bits
 * -- chats.extend registrar, chat->folder lookup, folders list, folder->sessions, store root, audit
 * record fn, log fn. EVERY one defaults LAZY: the real portal() is read only when a default is used
 * (in production). Mutating ops (office_create, office_edit) call record({subject, reason, chatId})
 * after the write; the default seam is a one-line log via portal().log (ping.ts pattern -- T-WIRE may
 * pass a real audit sink). setForcesaveHook installs the forcesave-first hook; null uninstalls it.
 */
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { portal } from "./host";
import { getDoc, docsForHome, createDoc, persistBytes, type DocMeta } from "./store";
import { parseDocx, parseXlsx, editDocx, rewriteZip, type EditOp } from "./ooxml";
import { usersOf, isLocked } from "./live";
import { loadSettings } from "./settings";
import { drainWakeQueue } from "./ping";

/** The UI_RECEIVE bus event chats.tell rings (core server extension-ui.ts and docs/ping.js use the same name). */
const UI_RECEIVE = "pithagoras:v1:ui:receive";

/** An audit line recorded after every mutating op. `subject` is the doc title, `chatId` the acting home chat. T-WIRE may route this to a real audit sink. */
export type OfficeAuditEntry = { subject: string; reason: string; chatId: string };

/** The folders list entries the factory resolves against (the shape of portal.folders.list() minus nothing it needs). */
export type ToolsFolderInfo = { path: string; name: string; kind: "agent" | "project" | "chat"; home?: boolean };

/** Injection seams for registerTools. Every field is optional and LAZY -- defaults read portal() only when actually used, so unit tests pass plain values and never reach the real portal. */
export type ToolsDeps = {
  /** The chats.extend registrar. Default: (factory) => portal().chats.extend(factory). */
  extend?: (factory: (pi: unknown, chat: { id: string }) => void) => void;
  /** A chat's workspace folder path (throws when the chat or its folder is gone). Default: (id) => portal().chats.folder(id). */
  chatFolder?: (chatId: string) => string;
  /** The folders the agents work in. Default: () => portal().folders.list(). */
  folders?: () => ToolsFolderInfo[];
  /** The sessions working in a folder path (home-chat resolution, plan 2.1). Default: (p) => portal().chats.inFolder(p). */
  inFolder?: (folderPath: string) => { id: string }[];
  /** Store/state root override. Default: lazy portal().dataDir(). */
  root?: string;
  /** The audit sink for mutating ops. Default: a one-line log via the log seam (ping.ts pattern). */
  record?: (entry: OfficeAuditEntry) => void;
  /** Log line. Default: lazy portal().log. */
  log?: (line: string) => void;
};

let cfg: ToolsDeps = {};
/** The forcesave-first hook (plan 5.7): T-WIRE registers the real one (the DS status-6 command for a dirty session). Until then -- or after setForcesaveHook(null) -- an edit with an open session logs and goes on without a forced save. */
let forcesaveHook: ((docId: string) => Promise<void>) | null = null;

/** Install the forcesave-first hook, or pass null to go back to the no-op (logged) default. */
export function setForcesaveHook(fn: ((docId: string) => Promise<void>) | null): void {
  forcesaveHook = fn ?? null;
}

/** Test seam: drop the module-level seams and the forcesave hook. */
export function __resetToolsForTests(): void {
  cfg = {};
  forcesaveHook = null;
}

/* ------------------------------------------------------------------ */
/* lazy defaults (portal() only when actually used)                     */
/* ------------------------------------------------------------------ */

function rootDir(): string {
  return cfg.root ?? portal().dataDir();
}
function chatFolder(chatId: string): string {
  return (cfg.chatFolder ?? ((id: string) => portal().chats.folder(id)))(chatId);
}
function folders(): ToolsFolderInfo[] {
  return (cfg.folders ?? (() => portal().folders.list()))();
}
function inChats(folderPath: string): { id: string }[] {
  return (cfg.inFolder ?? ((p: string) => portal().chats.inFolder(p)))(folderPath);
}
function logLine(line: string): void {
  (cfg.log ?? ((l: string) => portal().log(l)))(line);
}
function record(entry: OfficeAuditEntry): void {
  // Lazy default is a one-line log (T-WIRE may pass a real audit sink later via registerTools({record})).
  (cfg.record ?? ((e: OfficeAuditEntry) => logLine(`office audit: ${e.subject}: ${e.reason} (chat ${e.chatId})`)))(entry);
}

/* ------------------------------------------------------------------ */
/* registration                                                         */
/* ------------------------------------------------------------------ */

/**
 * server.ts calls ONCE at boot. Later calls (unit tests) update the seams and register again through
 * whatever registrar is configured -- production registers exactly once, tests each get their own fake
 * `extend`, so no once-guard here (unlike wirePing's onPersisted hook, which truly can only attach once).
 */
export function registerTools(opts?: ToolsDeps): void {
  if (opts) cfg = { ...cfg, ...opts };
  const registrar = cfg.extend ?? ((factory: (pi: unknown, chat: { id: string }) => void) => portal().chats.extend(factory));
  registrar((pi, chat) => installForChat(pi, chat));
}

/** The chats.extend factory body (contract): resolve the chat's folder via chats.folder -> folders.list() by path -> kind; RETURN UNLESS "agent" or "project"; then register the tools on that chat's pi. */
function installForChat(pi: unknown, chat: { id: string }): void {
  let folderPath: string;
  try {
    folderPath = chatFolder(chat.id);
  } catch (e) {
    logLine(`office tools: no workspace folder for chat ${chat.id} (${(e as Error)?.message ?? e}) -- no office_* tools`);
    return; // gone chat or folder: nothing to register into
  }
  const folder = folders().find((f) => f.path === folderPath);
  if (!folder || (folder.kind !== "agent" && folder.kind !== "project")) return; // not an agent/project home: contract says return, no tools
  const home = homeChatFor(folder, chat.id);
  installTools(pi, home);
  hearOfficePings(pi, chat.id); // plan 5.4 step 4: the same factory owns the drain side of the wake queue
}

/** The folder's home chat id (plan 2.1 -- meta.owner "is" the creating agent/project's home chat): the sessions working in the folder are its home chats, lowest id stands for them all (ping.ts' resolveMention rule). `fallback` covers a folder with no listed sessions -- the calling chat itself is in it by construction. */
function homeChatFor(folder: ToolsFolderInfo, fallback: string): string {
  const chats = [...inChats(folder.path)].sort((a, b) => a.id.localeCompare(b.id));
  return chats.length ? chats[0]!.id : fallback;
}

/* ------------------------------------------------------------------ */
/* refusals + tool plumbing (docs/tools.js idiom)                        */
/* ------------------------------------------------------------------ */

/** A refusal the agent reads: it starts with its code, "error:<code> <message>" (the office contract's fix of docs' `<code>: <message>`). */
class Refusal extends Error {
  constructor(public readonly code: string, message: string) {
    super(`error:${code} ${message}`);
  }
}

/** What a tool may throw out to the agent: refusals as-is, coded store/ooxml errors by their code (zip/part damage -> `corrupt`, revision_mismatch with the FRESH mtime in the message), anything else logged and generic. */
function failed(e: unknown): unknown {
  if (e instanceof Refusal) return e;
  const err = e as (Error & { code?: string; currentMtimeMs?: number }) | null;
  if (err && typeof err.message === "string" && typeof err.code === "string") {
    if (err.code === "revision_mismatch") {
      // The gate refused: tell the agent where the document really is so it can re-read and redo.
      return new Refusal("revision_mismatch", `${err.message} Current revision: ${err.currentMtimeMs ?? "unknown"} -- office_read again, then redo the edit with that mtimeMs as baseRevision. Nothing was written.`);
    }
    const code = err.code === "invalid_zip" || err.code === "missing_part" ? "corrupt" : err.code;
    return new Refusal(code, err.message);
  }
  logLine(`an office tool failed: ${err?.stack ?? e}`);
  return new Refusal("failed", String(e));
}

/** `text` with a details side-channel, exactly docs' shape. */
const text = (content: string, details?: unknown) => ({ content: [{ type: "text", text: content }], ...(details !== undefined ? { details } : {}) });

/** The library file of a doc (docs/<docId>/<title>.<ext>), or a not_found refusal. */
function readBytes(doc: DocMeta, root = rootDir()): Buffer {
  const p = path.join(root, "docs", doc.docId, `${doc.title}.${doc.ext}`);
  let buf: Buffer;
  try {
    buf = fs.readFileSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Refusal("not_found", `the library file of "${doc.title}" is missing from disk`);
    throw e;
  }
  return buf;
}

/** The most editing humans, and whether the doc is locked right now, as one readable line ("" when nobody). */
const lockLine = (doc: DocMeta) => {
  const users = usersOf(doc.docId);
  if (!users.length && !isLocked(doc.docId)) return "";
  const who = users.map((u) => u.name || u.id).join(", ");
  return `\n${users.length ? `${users.length} person${users.length === 1 ? "" : "s"} editing now (${who}).` : ""}${isLocked(doc.docId) && !users.length ? "\nThe document is currently locked by the editor." : ""}`;
};

/* ------------------------------------------------------------------ */
/* per-chat tools                                                       */
/* ------------------------------------------------------------------ */

function installTools(pi: unknown, home: string): void {
  const p = pi as any; // portal's extend factory hands a pi that carries registerTool (host mode) or not; docs' own tools use it untyped too.

  /** A doc in THIS home's scope by id -- owner === home OR granted to home (docsForHome); anything else is `not_found` with the SAME words as a nonexistent id, so another home's docs do not leak into view. */
  function visibleDoc(id: unknown): DocMeta {
    if (typeof id !== "string" || !id) throw new Refusal("not_found", "There is no document with that id. Ids come from office_list and office_create");
    const doc = docsForHome(home, rootDir()).find((d) => d.docId === id);
    if (!doc) throw new Refusal("not_found", "There is no document with that id. Ids come from office_list and office_create (a document of another agent/project is invisible to you until it mentions you in a comment)");
    return doc;
  }

  const guarded = (work: (params: Record<string, unknown>) => Promise<unknown> | unknown) => async (_callId: unknown, params: Record<string, unknown>) => {
    try {
      return await work(params ?? {});
    } catch (e) {
      throw failed(e);
    }
  };

  p.registerTool({
    name: "office_list",
    label: "List office documents",
    description: "List the office documents of your library: every Word (.docx) and spreadsheet (.xlsx) document you own or were granted (by being mentioned in one of its comments). Each line has the id, title, format, owner, how many grants it holds, its current revision (mtimeMs -- pass that back as baseRevision to office_edit) and whether a human is editing it right now.",
    promptSnippet: "List the office documents you own or were granted",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: guarded(() => {
      const docs = docsForHome(home, rootDir());
      if (!docs.length) return text("No documents in your office library yet. Make one with office_create.", { action: "list", home, documents: [] });
      const lines = docs.map((doc) => {
        const users = usersOf(doc.docId);
        return `- ${doc.docId}  "${doc.title}"  ${doc.ext}  owner ${doc.owner ?? "(ownerless)"}  ${doc.grants.length} grant${doc.grants.length === 1 ? "" : "s"}  revision ${doc.mtimeMs}${users.length ? `  ${users.length} editing now` : ""}`;
      });
      return text(`${docs.length} document${docs.length === 1 ? "" : "s"}:\n${lines.join("\n")}`, {
        action: "list",
        home,
        documents: docs.map((doc) => ({ id: doc.docId, title: doc.title, ext: doc.ext, owner: doc.owner, grants: doc.grants.length, sizeBytes: doc.sizeBytes, mtimeMs: doc.mtimeMs, locked: isLocked(doc.docId) || usersOf(doc.docId).length > 0 })),
      });
    }),
  });

  p.registerTool({
    name: "office_create",
    label: "Create an office document",
    description: "Make a new blank office document in the shared library: type \"word\" (a .docx) or \"cell\" (an .xlsx sheet), both starting from a minimal template you edit with office_edit or open in the editor. It is owned by you, so every chat of your home sees it; other agents get access only when it mentions them in a comment. A title+type pair already taken is refused.",
    promptSnippet: "Create a blank Word or spreadsheet document",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "The document's title (not empty)." },
        type: { type: "string", enum: ["word", "cell"], description: "\"word\" makes a .docx, \"cell\" an .xlsx spreadsheet." },
      },
      required: ["title", "type"],
    },
    execute: guarded(async ({ title, type }) => {
      const t = typeof title === "string" ? title.trim() : "";
      if (!t) throw new Refusal("invalid", "A document needs a title");
      if (type !== "word" && type !== "cell") throw new Refusal("unsupported_format", `type is \"word\" or \"cell\" (got ${typeof type === "string" ? `"${type}"` : String(type)})`);
      const doc = await createDoc({ title: t, type, owner: home, createdBy: "agent" }, rootDir()); // throws {code:"exists"} on a duplicate title+type
      record({ subject: doc.title, reason: `office_create: new ${doc.ext} document ${doc.docId}, owner ${home}`, chatId: home });
      return text(`Created "${doc.title}" (id ${doc.docId}, ${doc.ext}, revision ${doc.mtimeMs}). Edit it with office_edit, which needs that revision as baseRevision.`, { action: "create", id: doc.docId, title: doc.title, ext: doc.ext, mtimeMs: doc.mtimeMs, owner: doc.owner });
    }),
  });

  p.registerTool({
    name: "office_read",
    label: "Read an office document",
    description: "Read a document of your library by its id: the extracted text (paragraph-delimited for Word; a per-sheet grid of cell values for spreadsheets) plus, for Word, its comments (id, author, date, text). The revision line shows mtimeMs -- hand it to office_edit as baseRevision. It also says whether a human is editing right now.",
    promptSnippet: "Read the text and comments of an office document by id",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document's id, from office_list or office_create." },
      },
      required: ["id"],
    },
    execute: guarded(async ({ id }) => {
      const doc = visibleDoc(id);
      const buf = readBytes(doc);
      const lock = lockLine(doc);
      if (doc.ext === "xlsx") {
        // Plan 5.5: office_read returns a grid of cell values for xlsx; its COMMENTS are not in v1 (xl/commentsN.xml + VML, M4).
        const parsed = parseXlsx(buf); // throws {code:"invalid_zip"} -> corrupt
        const sheets = parsed.sheetNames.map((name) => {
          const rows = parsed.sheets[name] ?? [];
          return `Sheet "${name}" (${rows.length} row${rows.length === 1 ? "" : "s"}):\n${rows.map((r) => "| " + r.join(" | ") + " |").join("\n")}`;
        }).join("\n\n");
        const said = `"${doc.title}" (id ${doc.docId}, xlsx, revision ${doc.mtimeMs})${lock}\n\n${sheets || "(empty workbook)"}\n\nNo comments: spreadsheet comments are not read in v1 (they arrive later).`;
        return text(said, { action: "read", id: doc.docId, ext: doc.ext, mtimeMs: doc.mtimeMs, sheets: parsed.sheetNames });
      }
      const parsed = parseDocx(buf); // throws {code:"invalid_zip"|"missing_part"} -> corrupt
      let comments = "";
      if (parsed.comments.length) {
        const lines = parsed.comments.map((c) => `- ${c.id}  ${c.author}${c.date ? `  ${c.date}` : ""}: ${c.text.replace(/\n/g, " ")}`);
        comments = `\n\nComments (${parsed.comments.length}):\n${lines.join("\n")}`;
      }
      return text(`"${doc.title}" (id ${doc.docId}, docx, revision ${doc.mtimeMs})${lock}\n\n${parsed.text}${comments}`, { action: "read", id: doc.docId, ext: doc.ext, mtimeMs: doc.mtimeMs, comments: parsed.comments });
    }),
  });

  p.registerTool({
    name: "office_edit",
    label: "Edit an office document",
    description: `Change a Word document of your library by replacing quoted text, as office_read shows it. Each op is {quote, replacement}: the quote must appear in the extracted text (empty replacement removes it), ops apply one after another. baseRevision is the mtimeMs you read (or that your last edit returned): if the document moved on since, NOTHING is written and you are told the fresh revision -- re-read and redo. If a human has the editor open, their dirty session is force-saved first and the gate re-checked; you never overwrite an unread save. Spreadsheets cannot be edited in v1 (a later milestone). All ops are made or none.`,
    promptSnippet: "Edit a Word document: quoted replacements on the revision you read",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document's id, from office_list or office_create." },
        ops: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              quote: { type: "string", description: "Text to replace, exactly as office_read shows it (may not be empty)." },
              replacement: { type: "string", description: "What takes its place; empty removes the quote." },
            },
            required: ["quote", "replacement"],
          },
        },
        baseRevision: { type: "number", description: "The revision (mtimeMs) you read or last edited at." },
      },
      required: ["id", "ops", "baseRevision"],
    },
    execute: guarded(async ({ id, ops, baseRevision }) => {
      const doc = visibleDoc(id);
      if (doc.ext !== "docx") throw new Refusal("unsupported_format", `"${doc.title}" is an .xlsx spreadsheet: editing spreadsheets is not in v1 (a later milestone) -- read it with office_read`);
      if (!Array.isArray(ops) || ops.length === 0) throw new Refusal("invalid", "ops is a non-empty list of {quote, replacement}");
      ops.forEach((op, i) => {
        if (typeof op?.quote !== "string" || !op.quote || typeof op.replacement !== "string") throw new Refusal("invalid", `op ${i + 1} needs a quote (not empty) and a replacement (text, or empty to remove)`);
      });
      const base = Number(baseRevision);
      if (baseRevision === undefined || baseRevision === null || !Number.isFinite(base)) throw new Refusal("invalid", "baseRevision is the mtimeMs revision office_list/office_read showed you");

      // GATE FIRST (contract): the meta as it stands now vs what the agent read; >1 ms drift means a save
      // moved since -- refuse with the FRESH mtime in the message, and write nothing. store.persistBytes
      // re-gates strictly at write time too, so this is belt and not only braces.
      let meta = getDoc(doc.docId, rootDir());
      if (!meta) throw new Refusal("not_found", `"${doc.title}" vanished from the library between list and edit`);
      const stale = (fresh: DocMeta) =>
        new Refusal("revision_mismatch", `"${fresh.title}" is at revision ${fresh.mtimeMs}, not ${base}: it changed since you read it. Nothing was written. Read it again with office_read, then redo the edit with baseRevision ${fresh.mtimeMs}.`);
      if (Math.abs(meta.mtimeMs - base) > 1) throw stale(meta);

      // Plan 5.7 (co-editing default ON): an open human session is NOT a refusal -- forcesave-first ordering.
      // The hook (T-WIRE: the DS status-6 command for this doc's dirty session) is AWAITED, and because it
      // itself saves the file the gate is re-checked on the FRESH meta before anything below is written.
      if (loadSettings(rootDir()).coEdit && usersOf(doc.docId).length > 0) {
        if (forcesaveHook) await forcesaveHook(doc.docId);
        else logLine(`office edit of ${doc.docId}: an editor session is open and coEdit is on, but no forcesave hook is registered yet -- continuing without a forced save`);
        meta = getDoc(doc.docId, rootDir());
        if (!meta) throw new Refusal("not_found", `"${doc.title}" vanished from the library between list and edit`);
        if (Math.abs(meta.mtimeMs - base) > 1) throw stale(meta);
      }

      // word/document.xml out of the archive; damage is `corrupt`, quote problems pass through ooxml's codes.
      const buf = readBytes(doc);
      let documentXml: string;
      try {
        const zip = await JSZip.loadAsync(buf);
        const part = zip.file("word/document.xml");
        if (!part) throw new Refusal("corrupt", `"${doc.title}" has no word/document.xml: it is not a Word document`);
        documentXml = (await part.async("string")) ?? "";
      } catch (e) {
        if (e instanceof Refusal) throw e;
        throw new Refusal("corrupt", `"${doc.title}" could not be opened as a zip archive: ${e instanceof Error ? e.message : String(e)}`);
      }

      const editedXml = editDocx(documentXml, ops as EditOp[]); // throws {code:"quote_not_found"|"quote_ambiguous"} -- surfaced unchanged by failed()
      const out = rewriteZip(buf, { "word/document.xml": editedXml }); // {code:"invalid_zip"} -> corrupt
      const saved = persistBytes(meta, out, rootDir()); // the strict final gate + index update; revision_mismatch carries currentMtimeMs
      record({ subject: doc.title, reason: `office_edit: ${ops.length} op(s) applied, revision ${meta.mtimeMs} -> ${saved.mtimeMs}`, chatId: home });
      const n = ops.length;
      return text(`Edited "${doc.title}" (${n} op${n === 1 ? "" : "s"} made): now at revision ${saved.mtimeMs}. Pass that as baseRevision for the next edit.`, { action: "edit", id: doc.docId, from: meta.mtimeMs, to: saved.mtimeMs, ops: n });
    }),
  });

  p.registerTool({
    name: "office_comments",
    label: "List document comments and grants",
    description: "Read-only: the comments of a Word document (id, author, date, text) plus its grants -- which other agent/project homes hold access to it by mention. Spreadsheets have no comment reading in v1.",
    promptSnippet: "List the comments and grants of an office document",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document's id, from office_list or office_create." },
      },
      required: ["id"],
    },
    execute: guarded(async ({ id }) => {
      const doc = visibleDoc(id);
      if (doc.ext === "xlsx") throw new Refusal("unsupported_format", `"${doc.title}" is an .xlsx spreadsheet: its comments live in a different part layout and are not read in v1 (they arrive in M4)`);
      const parsed = parseDocx(readBytes(doc)); // corrupt mapping via failed()
      const commentLines = parsed.comments.length ? parsed.comments.map((c) => `- ${c.id}  ${c.author}${c.date ? `  ${c.date}` : ""}: ${c.text.replace(/\n/g, " ")}`).join("\n") : "(none)";
      const grantLines = doc.grants.length ? doc.grants.map((g) => `- ${g.chatId}  via comment ${g.commentId}  at ${new Date(g.at).toISOString()}`).join("\n") : "(none -- only the owner can see this document)";
      return text(`"${doc.title}" (id ${doc.docId})\n\nComments (${parsed.comments.length}):\n${commentLines}\n\nGrants:\n${grantLines}`, { action: "comments", id: doc.docId, comments: parsed.comments, grants: doc.grants });
    }),
  });
}

/**
 * The drain side of plan 5.4 step 4 (docs' hearPings): on the UI_RECEIVE bell with data.type "ping"
 * -- which ping.ts rings per woken home via chats.tell(chatId, {type:"ping"}) -- take this chat's queued
 * wake entries off ping.ts' server-side queue and hand each to pi: shown to the person, delivered as a
 * follow-up that triggers a turn, carrying {docId, commentId} in details. A reloaded pi keeps the bus:
 * the handler of the one that went is removed on session shutdown (docs does exactly this).
 */
function hearOfficePings(pi: unknown, chatId: string): void {
  const p = pi as any;
  if (typeof p?.events?.on !== "function") return; // no event bus in this pi build: the tools still work, wakes just wait for a drain by another means
  const off = p.events.on(UI_RECEIVE, (message: { data?: unknown }) => {
    if ((message as { data?: { type?: string } })?.data?.type !== "ping") return; // ours is data.type "ping" (ping.ts sets it)
    for (const entry of drainWakeQueue(chatId)) {
      try {
        p.sendMessage({ customType: "office-comment-ping", content: entry.text, display: true, details: entry.details }, { deliverAs: "followUp", triggerTurn: true });
      } catch (e) {
        logLine(`could not deliver a queued office wake to chat ${chatId}: ${(e as Error)?.message ?? e}`);
      }
    }
  });
  p.on?.("session_shutdown", () => off?.());
}
