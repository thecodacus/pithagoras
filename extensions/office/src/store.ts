/**
 * The office document library: docs/<docId>/<title>.<ext> under the extension's own dataDir plus an
 * index.json ({ version: 1, docs: DocMeta[] }) that is the single source of truth for metadata. Every
 * operation reads the index fresh from disk (no caching -- a human UI tab, the loopback listener and
 * the agent tools all share this process's files) and writes it back atomically (tmp file in the same
 * directory + rename). Document bytes live in the plain filesystem: the portal's 1 MB managed-file cap
 * does not apply here, so >1 MB Office files work natively.
 *
 * Created docs are written INTO this library (docs/<docId>/<title>.<ext>); workspace-scanned docs (see
 * scanWorkspace) point at their file IN PLACE via DocMeta.path -- the scanned file IS the document, and
 * every path-taking operation (persistBytes, renameDoc, deleteDoc, exportDoc, pruneMissingDocs) resolves
 * through docPath(), which prefers that field. A deleted scanned doc moves its REAL file into this
 * library's .trash (7-day sweep); a scanned file already gone out-of-band is pruned, not an error.
 *
 * Every exported function takes a trailing optional `root = dataDir()` so unit tests can pass a tmp
 * dir (per the wave-2 amendments); production callers just omit it. The ONLY async functions are
 * templateDocx/templateXlsx and createDoc, because jszip -- the only zip writer allowed in
 * this package -- generates buffers asynchronously; everything that touches existing files is sync.
 */
import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { jsZip } from "./jszip"; // LAZY by design: the built server must import without its own node_modules yet (deps.js installs them at boot)
import { dataDir } from "./host";
import { parseDocx } from "./ooxml"; // importFile + scanWorkspace baseline the source file's comment ids at import/index time (ping.ts first-save rule)

export type DocMeta = {
  docId: string;
  title: string;
  ext: "docx" | "xlsx";
  createdAt: number;
  updatedAt: number;
  sizeBytes: number;
  mtimeMs: number;
  owner: string | null;
  grants: { chatId: string; commentId: string; at: number }[];
  createdBy?: string;
  /** Set for workspace-scanned docs only (importFile stamps it too, for its copy flow). ping.ts uses it as the first-save rule: a scanned doc's pre-existing comments are baselined without wakes; a created (blank) doc gets no such baseline. */
  imported?: boolean;
  /** Comment ids present in the file at INDEX time (stamped by scanWorkspace). The first-save baseline for scanned docs: any id NOT listed here appeared after indexing and is still processed normally. Absent when the source did not parse as docx. */
  importedBaseline?: string[];
  /** A workspace-scanned doc lives in PLACE: its real, absolute file path (realpathSync'd at index time). ABSENT for library-created docs, whose bytes are docs/<docId>/<title>.<ext> under the library root -- docPath() prefers this field when present. */
  path?: string;
};

type IndexFile = { version: 1; docs: DocMeta[] };

const TRASH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // sweepTrash removes .trash entries older than this
// importFile caps: the sync copy must not commit an unbounded file into the library (and any xlsx/docx in it
// is parsed later against ooxml.ts' 256 MiB / 1 GiB zip envelope). Above MAX_BASELINE_BYTES the docx comment
// baseline is skipped (ping.ts "unparseable source" fallback) instead of reading a huge file inline.
const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
const MAX_BASELINE_BYTES = 32 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* index I/O                                                           */
/* ------------------------------------------------------------------ */

function indexPath(root: string): string {
  return path.join(root, "index.json");
}

function readIndex(root: string): IndexFile {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(indexPath(root), "utf8"));
    if (typeof raw !== "object" || raw === null || !Array.isArray((raw as Record<string, unknown>).docs)) throw new Error("bad shape");
    return raw as IndexFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, docs: [] };
    throw Object.assign(new Error(`corrupt document index at ${indexPath(root)} -- run settleKept to reconcile`), { code: "index_corrupt", cause: err });
  }
}

function writeIndex(root: string, index: IndexFile): void {
  const dest = indexPath(root);
  const tmp = path.join(root, `.${path.basename(dest)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
  fs.renameSync(tmp, dest);
}

function docPath(doc: DocMeta, root: string): string {
  // A scanned doc's bytes are the workspace file itself; only library-created docs live under docs/<docId>/.
  return doc.path ?? path.join(root, "docs", doc.docId, `${doc.title}.${doc.ext}`);
}

function notFound(message = "no such document"): Error {
  return Object.assign(new Error(message), { code: "not_found" });
}

/* ------------------------------------------------------------------ */
/* identity + templates                                                */
/* ------------------------------------------------------------------ */

/** Title -> slug: lowercase, every run of non-alphanumeric characters collapses to one "-", leading/trailing "-" trimmed.
 * A slug is not unique by itself (titles collide) -- createDoc appends a random suffix below. */
export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Six-character random suffix from crypto.randomInt over the lowercase ASCII alphanumerics "abcdefghijklmnopqrstuvwxyz0123456789" --
 * 36 symbols, so the chance that two freshly minted suffixes collide is ~1/36^6 (≈ 4.6e-10); createDoc still
 * re-checks generated ids against the index and regenerates on the off chance of a hit. */
function randomSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

const DOCX_CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
  `</Types>`;

const DOCX_ROOT_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
  `</Relationships>`;

const W_NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;

// word/_rels/document.xml.rels is beyond the contract's four-part list but standard in every real docx and keeps
// Word/OnlyOffice happy (the styles part is referenced from it, not dangling) -- noted as an addition in the report.
const DOCX_DOC_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
  `</Relationships>`;

const DOCX_DOCUMENT =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document ${W_NS}><w:body><w:p><w:r><w:t xml:space="preserve">New document</w:t></w:r></w:p></w:body></w:document>`;

const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W_NS}></w:styles>`;

/** A minimal valid docx (jszip, DEFLATE): [Content_Types].xml, _rels/.rels, word/document.xml (one paragraph
 * saying "New document"), word/styles.xml -- plus word/_rels/document.xml.rels so the styles part is properly
 * referenced. Opens cleanly in Word/OnlyOffice and parses with ooxml.parseDocx. jszip only writes buffers
 * asynchronously, which is why this (and createDoc) are async. */
export async function templateDocx(): Promise<Buffer> {
  const zip = new (await jsZip())();
  zip.file("[Content_Types].xml", DOCX_CONTENT_TYPES);
  zip.file("_rels/.rels", DOCX_ROOT_RELS);
  zip.file("word/document.xml", DOCX_DOCUMENT);
  zip.file("word/_rels/document.xml.rels", DOCX_DOC_RELS);
  zip.file("word/styles.xml", DOCX_STYLES);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

const XLSX_CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `</Types>`;

const XLSX_ROOT_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

const XLSX_WORKBOOK =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
  `<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>` +
  `</workbook>`;

const XLSX_WORKBOOK_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
  `</Relationships>`;

const XLSX_SHEET1 =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`;

/** A minimal valid xlsx (jszip, DEFLATE): [Content_Types].xml, _rels/.rels, xl/workbook.xml, xl/_rels/workbook.xml.rels
 * and an empty xl/worksheets/sheet1.xml named "Sheet1". Opens cleanly in Excel/OnlyOffice and parses with
 * ooxml.parseXlsx (one sheet, zero rows). Async for the same jszip reason as templateDocx. */
export async function templateXlsx(): Promise<Buffer> {
  const zip = new (await jsZip())();
  zip.file("[Content_Types].xml", XLSX_CONTENT_TYPES);
  zip.file("_rels/.rels", XLSX_ROOT_RELS);
  zip.file("xl/workbook.xml", XLSX_WORKBOOK);
  zip.file("xl/_rels/workbook.xml.rels", XLSX_WORKBOOK_RELS);
  zip.file("xl/worksheets/sheet1.xml", XLSX_SHEET1);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/* ------------------------------------------------------------------ */
/* library operations                                                  */
/* ------------------------------------------------------------------ */

/** All documents, titles ascending (localeCompare). */
export function listDocs(root = dataDir()): DocMeta[] {
  return [...readIndex(root).docs].sort((a, b) => a.title.localeCompare(b.title));
}

/** One document by id, or null. */
export function getDoc(docId: string, root?: string): DocMeta | null {
  const rootDir = root ?? dataDir();
  return readIndex(rootDir).docs.find((d) => d.docId === docId) ?? null;
}

/** The documents a home chat may see in its panel/tools: ones it OWNS or holds a mention-GRANT for (plan 2.1),
 * deduped by docId (a doc owned and granted to the same home appears once). */
/** The ONE index writer for mention grants (ping.ts used to read-modify-write index.json on its own): fresh
 * read, dedupe by (chatId, commentId) -- a re-sent comment never adds a second row -- atomic tmp+rename through
 * the store's writeIndex. Sync like everything here and no logging (module contract). Returns "added",
 * "duplicate" (already granted: nothing written), or null when the doc is not in the index any more.
 * A corrupt index throws the usual {code:"index_corrupt"} -- a bad file, not a vanished doc. */
export function addGrant(docId: string, chatId: string, commentId: string, at: number, root = dataDir()): "added" | "duplicate" | null {
  const index = readIndex(root);
  const doc = index.docs.find((d) => d.docId === docId);
  if (!doc) return null;
  const grants = (doc.grants ??= []);
  if (grants.some((g) => g.chatId === chatId && g.commentId === commentId)) return "duplicate";
  grants.push({ chatId, commentId, at });
  writeIndex(root, index);
  return "added";
}

export function docsForHome(homeChatId: string, root = dataDir()): DocMeta[] {
  const seen = new Set<string>();
  const out: DocMeta[] = [];
  for (const doc of readIndex(root).docs) {
    if (seen.has(doc.docId)) continue;
    if (doc.owner === homeChatId || doc.grants.some((g) => g.chatId === homeChatId)) {
      seen.add(doc.docId);
      out.push(doc);
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

function freshDocId(existing: DocMeta[], title: string): string {
  const slug = slugify(title);
  let docId = `${slug ? slug + "-" : ""}${randomSuffix()}`; // titles of pure punctuation still get a clean id
  while (existing.some((d) => d.docId === docId)) docId = `${slug ? slug + "-" : ""}${randomSuffix()}`;
  return docId;
}

/** Titles become FILE NAMES (docs/<docId>/<title>.<ext>): reject anything empty, over 200 chars, or carrying a
 * path separator / C0 control character -- "../../etc/passwd.docx" would otherwise escape the library. */
function assertSafeTitle(title: string): void {
  if (title === "" || title.length > 200) {
    throw Object.assign(new Error(`a document title must be 1-200 characters: ${JSON.stringify(title.slice(0, 80))}`), { code: "invalid_title" });
  }
  for (const ch of title) {
    const code = ch.codePointAt(0) as number;
    if (ch === "/" || ch === "\\" || code < 0x20) throw Object.assign(new Error(`the document title may not contain path separators or control characters: ${JSON.stringify(title.slice(0, 80))}`), { code: "invalid_title" });
  }
}

function storeDoc(doc: DocMeta, bytes: Buffer, rootDir: string): DocMeta { // sync on purpose: the create/import paths must not await between readIndex and writeIndex
  const dir = path.join(rootDir, "docs", doc.docId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${doc.title}.${doc.ext}`);
  fs.writeFileSync(file, bytes);
  const st = fs.statSync(file);
  doc.sizeBytes = st.size;
  doc.mtimeMs = st.mtimeMs;
  return doc;
}

/** Create a document from the blank template of its type. docId = slug(title) + "-" + 6 random chars (see
 * randomSuffix for the alphabet). Duplicate -- an existing entry with the SAME docId or the SAME title AND same
 * type (case-sensitive) -- throws Error{code:"exists"} before anything touches disk. The owner is the creating
 * home chat (agent tools pass it) or null for human-created docs; createdBy records who actually did it. */
export async function createDoc(input: { title: string; type: "word" | "cell"; owner?: string | null; createdBy?: string }, root = dataDir()): Promise<DocMeta> {
  const rootDir = root ?? dataDir();
  assertSafeTitle(input.title); // titles are file names
  const ext: DocMeta["ext"] = input.type === "word" ? "docx" : "xlsx";
  const bytes = ext === "docx" ? await templateDocx() : await templateXlsx(); // BEFORE the index round-trip: no await may sit between readIndex and writeIndex, or a concurrent create would have its write clobbered
  const index = readIndex(rootDir);
  if (index.docs.some((d) => d.title === input.title && d.ext === ext)) throw Object.assign(new Error(`a document titled "${input.title}" already exists`), { code: "exists" });
  const now = Date.now();
  const doc: DocMeta = {
    docId: freshDocId(index.docs, input.title),
    title: input.title,
    ext,
    createdAt: now,
    updatedAt: now,
    sizeBytes: 0,
    mtimeMs: 0,
    owner: input.owner ?? null,
    grants: [],
  };
  if (input.createdBy !== undefined) doc.createdBy = input.createdBy;
  storeDoc(doc, bytes, rootDir);
  index.docs.push(doc);
  writeIndex(rootDir, index);
  return { ...doc };
}

/** Retitle a document and rename its file on disk (docs/<docId>/<newTitle>.<ext>). The docId is stable across the
 * whole lifetime of the doc (tickets, history paths, state files key off it), and rename preserves the content's
 * mtimeMs -- that IS the revision tools gate on, so a retitle is never a new revision. updatedAt bumps. A title
 * already held by ANOTHER document throws {code:"exists"} (the plan does not specify retitle collisions; an
 * exists refusal is the safe reading). */
export function renameDoc(docId: string, newTitle: string, root = dataDir()): DocMeta {
  const rootDir = root ?? dataDir();
  assertSafeTitle(newTitle);
  const index = readIndex(rootDir);
  const doc = index.docs.find((d) => d.docId === docId);
  if (!doc) throw notFound(`no document with id ${docId}`);
  if (newTitle !== doc.title && index.docs.some((d) => d.docId !== docId && d.title === newTitle)) {
    throw Object.assign(new Error(`a document titled "${newTitle}" already exists`), { code: "exists" });
  }
  // One rule for both kinds: rename inside the file's OWN directory. For a library doc that is docs/<docId>/;
  // for a scanned doc it renames the real workspace file next to where it already is (same parent, new name).
  const from = docPath(doc, rootDir);
  const to = path.join(path.dirname(from), `${newTitle}.${doc.ext}`);
  fs.renameSync(from, to);
  if (doc.path) doc.path = to;
  doc.title = newTitle;
  doc.updatedAt = Date.now();
  writeIndex(rootDir, index);
  return { ...doc };
}

/** Delete a document: its docs/<docId> folder is moved to .trash/<Date.now()>-<docId> (a hard delete would not be
 * undoable) and the index entry removed. A scanned doc's REAL FILE (not a library folder) is what moves -- deleting
 * one moves the workspace file into this library's trash, exactly as reversible as everything else here. A scanned
 * file already gone from its workspace (deleted out-of-band since the last scan) is NOT an error: only the index
 * entry drops, which is what pruneMissingDocs would have done at the next settleKept anyway. sweepTrash (server boot /
 * settleKept) reclaims trash older than 7 days. Throws {code:"not_found"} for an unknown id. */
export function deleteDoc(docId: string, root = dataDir()): void {
  const rootDir = root ?? dataDir();
  const index = readIndex(rootDir);
  const doc = index.docs.find((d) => d.docId === docId);
  if (!doc) throw notFound(`no document with id ${docId}`);
  const from = doc.path ? doc.path : path.join(rootDir, "docs", doc.docId);
  fs.mkdirSync(trashDir(rootDir), { recursive: true });
  try {
    fs.renameSync(from, path.join(trashDir(rootDir), `${Date.now()}-${docId}`)); // the real file (scanned) or the folder (library)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // the file left its workspace on its own: nothing to move, the index drop below IS the deletion
  }
  writeIndex(rootDir, { version: 1, docs: index.docs.filter((d) => d.docId !== docId) });
}

/** The library's trash dir, made if missing -- one place that names it. */
function trashDir(rootDir: string): string {
  return path.join(rootDir, ".trash");
}

/** Reclaim .trash entries whose name timestamp (the "<ms>-<name>" prefix written by deleteDoc) is older than 7 days.
 * Returns how many were removed. Server boot (settleKept) and the lookAfter path call this. */
export function sweepTrash(root = dataDir()): number {
  const rootDir = root ?? dataDir();
  const trash = trashDir(rootDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(trash);
  } catch {
    return 0; // no .trash yet
  }
  const now = Date.now();
  let removed = 0;
  for (const name of entries) {
    const dash = name.indexOf("-");
    if (dash < 1) continue; // not a deleteDoc entry -- leave it alone
    const stamp = Number(name.slice(0, dash));
    if (!Number.isFinite(stamp)) continue;
    if (now - stamp > TRASH_TTL_MS) {
      fs.rmSync(path.join(trash, name), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

/** The settleKept half of index-vs-disk reconciliation (server.ts calls it at boot and on the interval): drop the
 * index entries whose library file is gone from disk -- someone deleted a docs/<docId>/ dir out-of-band, or its bytes
 * were lost. The index is the source of truth in BOTH directions: a docs/<id>/ dir with NO index entry is NOT added
 * (an orphan sweep is not v1). Returns the dropped docIds; writes nothing when nothing is missing. */
export function pruneMissingDocs(root = dataDir()): string[] {
  const rootDir = root ?? dataDir();
  const index = readIndex(rootDir);
  const kept: DocMeta[] = [];
  const dropped: string[] = [];
  for (const doc of index.docs) {
    try {
      fs.accessSync(docPath(doc, rootDir));
      kept.push(doc);
    } catch {
      dropped.push(doc.docId);
    }
  }
  if (dropped.length) writeIndex(rootDir, { version: 1, docs: kept });
  return dropped;
}

/** ONE file of a scan, resolved to its index entry: throws {code:"unsupported_format"} for anything that is not a
 * regular .docx/.xlsx and {code:"too_large"} above the 512 MiB cap; returns null when the basename (without its
 * extension) cannot become a document title -- such a file is skipped, not indexed. The single place where a
 * scanned file becomes a DocMeta, so the stamping rules of the former importFile live in exactly one spot. */
function indexOne(real: string, rootDir: string): DocMeta | null {
  const base = path.basename(real);
  const dot = base.lastIndexOf(".");
  if (dot < 1) throw Object.assign(new Error(`${base} has no extension`), { code: "unsupported_format" });
  const extRaw = base.slice(dot + 1).toLowerCase();
  if (extRaw !== "docx" && extRaw !== "xlsx") throw Object.assign(new Error(`${base}: only .docx and .xlsx files are indexed`), { code: "unsupported_format" });
  let st: fs.Stats;
  try {
    st = fs.statSync(real);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw notFound(`no such file ${real}`);
    throw err;
  }
  if (!st.isFile()) throw Object.assign(new Error(`${real} is not a regular file`), { code: "unsupported_format" });
  // The cap importFile had, now on INDEXING: an uncapped source would also blow the ooxml reader's 1 GiB zip
  // envelope at parse time -- above it the file stays out of the library and its mtime-gated flow.
  if (st.size > MAX_IMPORT_BYTES) throw Object.assign(new Error(`${real} is ${st.size} bytes: files above ${MAX_IMPORT_BYTES / (1024 * 1024)} MiB are not indexed`), { code: "too_large" });
  const title = base.slice(0, dot);
  try {
    assertSafeTitle(title); // a file name that cannot be a document title is skipped, not indexed
  } catch {
    return null;
  }
  // Baseline AT INDEX TIME (the importFile rule, carried over): record which comment ids this file carries NOW, so
  // pre-existing @mentions do not fire wakes at index time and the first save baselines exactly this history. Only
  // for files up to MAX_BASELINE_BYTES -- above it the field stays undefined and ping.ts applies its documented
  // "unparseable source" fallback; a docx that does not parse leaves it undefined too.
  let importedBaseline: string[] | undefined;
  if (extRaw === "docx" && st.size <= MAX_BASELINE_BYTES) {
    try {
      importedBaseline = parseDocx(fs.readFileSync(real)).comments.map((c) => c.id);
    } catch {
      // does not parse as docx: baseline unknown, ping.ts' fallback applies
    }
  }
  const now = Date.now();
  const index = readIndex(rootDir);
  if (index.docs.some((d) => d.path === real || (d.title === title && d.ext === extRaw))) {
    throw Object.assign(new Error(`a document titled "${title}" (${extRaw}) is already in the library`), { code: "exists" });
  }
  const doc: DocMeta = {
    docId: `${slugify(title)}-${randomSuffix()}`,
    title,
    ext: extRaw,
    createdAt: now,
    updatedAt: now,
    sizeBytes: st.size,
    mtimeMs: st.mtimeMs, // the file's OWN mtime IS its revision from day one -- the mtime-gated flow edits it in place
    owner: null, // a human doc: no home owns it -- it shows in the global library, exactly like a human-made created doc
    grants: [],
    imported: true, // ping.ts first-save rule for the stamped baseline above
    path: real, // IN PLACE: the scanned file IS the document; nothing is copied into the library
  };
  if (importedBaseline !== undefined) doc.importedBaseline = importedBaseline;
  index.docs.push(doc);
  writeIndex(rootDir, index);
  return { ...doc };
}

/** Synchronous workspace scan: every *.docx/*.xlsx (case-insensitive) under `roots`, indexed IN PLACE.
 *
 * roots are the portal's agent folders (portal().folders.list(): every agent home, every project, every chat's
 * working folder). The walk is bounded and deliberately dumb -- no git, no content sniffing: it never enters the
 * library's own data dir (indexing a copy of itself would re-index its own docs forever), never hidden dirs
 * (dot-prefixed: .git, editor scratch), and never node_modules. A file is identified by its REALPATH, so two roots
 * reaching the same file through a symlink or bind mount produce ONE entry. Already-indexed files get their
 * mtimeMs/sizeBytes REFRESHED from disk (a rescan after something wrote the file straight to disk keeps the list
 * honest) and count as `updated` only when something actually changed; new files go through indexOne -- in place,
 * owner null, with the importedBaseline stamp so pre-existing @mentions do not fire wakes at index time. A file
 * that cannot be indexed (oversized, unsafe title, already titled, unreadable) is skipped: one bad file must
 * never fail the whole sweep.
 *
 * Returns { added, updated }. */
export function scanWorkspace(roots: string[], root = dataDir()): { added: number; updated: number } {
  const rootDir = root ?? dataDir();
  let self: string;
  try {
    self = fs.realpathSync(rootDir);
  } catch {
    self = path.resolve(rootDir);
  }
  const seenDirs = new Set<string>(); // per-walk guard: a dir is walked at most once (also breaks symlink loops)
  const found: string[] = []; // candidate files, in walk order

  const isSkippedName = (name: string): boolean => name.startsWith(".") || name === "node_modules";
  const walk = (dir: string): void => {
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return; // gone mid-walk or unreadable -- the rest of the tree still counts
    }
    if (real === self || seenDirs.has(real)) return; // our own library dir is never walked, and neither is any dir twice
    seenDirs.add(real);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!isSkippedName(entry.name)) walk(at); // hidden dirs and node_modules are never walked
        continue;
      }
      if (entry.isFile() && /\.(docx|xlsx)$/i.test(entry.name)) found.push(at);
    }
  };
  for (const r of roots) walk(r);

  // What is ALREADY indexed, by its real path: refreshes target these; everything else in `found` is a candidate add.
  const byReal = new Map<string, DocMeta>();
  const initial = readIndex(rootDir);
  for (const doc of initial.docs) if (doc.path) byReal.set(doc.path, doc);
  let added = 0;
  let updated = 0;
  for (const file of found) {
    let real: string;
    try {
      real = fs.realpathSync(file); // symlinks collapse into one identity; a broken link is skipped
    } catch {
      continue;
    }
    const known = byReal.get(real);
    if (known) {
      let st: fs.Stats;
      try {
        st = fs.statSync(real);
      } catch {
        continue; // vanished since the index was read: pruneMissingDocs settles it at the next settleKept
      }
      if (st.mtimeMs !== known.mtimeMs || st.size !== known.sizeBytes) {
        known.mtimeMs = st.mtimeMs;
        known.sizeBytes = st.size;
        known.updatedAt = Date.now();
        updated++;
      }
      continue; // refresh-and-continue: a rescan never re-indexes what it already has
    }
    try {
      const doc = indexOne(real, rootDir); // its own atomic read-modify-write -- one entry per file
      if (doc) {
        byReal.set(real, doc);
        added++;
      }
    } catch (err) {
      const ce = err as { code?: string };
      if (ce.code === "unsupported_format" || ce.code === "too_large" || ce.code === "exists") continue; // expected skips
      throw err; // a real failure (index corrupt, disk full) IS a rescan failure
    }
  }
  if (updated > 0) {
    const index = readIndex(rootDir); // fresh: add-writes may have landed since `initial`
    let wrote = false;
    for (const [realPath, doc] of byReal) {
      const entry = index.docs.find((d) => d.path === realPath);
      if (!entry || (doc.mtimeMs === entry.mtimeMs && doc.sizeBytes === entry.sizeBytes)) continue;
      entry.mtimeMs = doc.mtimeMs;
      entry.sizeBytes = doc.sizeBytes;
      entry.updatedAt = doc.updatedAt;
      wrote = true;
    }
    if (wrote) writeIndex(rootDir, index);
  }
  return { added, updated };
}

/** Import an existing .docx/.xlsx from an absolute path into the library (copy, never move -- the source stays). SUPERSEDED for the UI flow by scanWorkspace (in-place indexing); retained because ping.test exercises its copy-into-library shape.
 * The extension comes from the basename (case-insensitive) and anything else throws {code:"unsupported_format"};
 * a missing/unreadable source throws {code:"not_found"}; a file above 512 MiB throws {code:"too_large"} before
 * anything is copied. title defaults to the basename without its extension; owner is set by the caller (an
 * agent/project context passes its home chat, human imports stay ownerless). For docx sources up to 32 MiB the
 * comment ids are baselined into importedBaseline at import time; above that the field stays undefined and
 * ping.ts applies its "unparseable source" first-save fallback. */
export function importFile(absPath: string, meta: { title?: string; owner?: string | null }, root = dataDir()): DocMeta {
  const rootDir = root ?? dataDir();
  const base = path.basename(absPath);
  const dot = base.lastIndexOf(".");
  if (dot < 1) throw Object.assign(new Error(`${base} has no extension`), { code: "unsupported_format" });
  const extRaw = base.slice(dot + 1).toLowerCase();
  if (extRaw !== "docx" && extRaw !== "xlsx") throw Object.assign(new Error(`${base}: only .docx and .xlsx files can be imported`), { code: "unsupported_format" });
  let st: fs.Stats;
  try {
    st = fs.statSync(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw notFound(`no such file ${absPath}`);
    throw err;
  }
  if (!st.isFile()) throw Object.assign(new Error(`${absPath} is not a regular file`), { code: "unsupported_format" });
  // Hard size cap (N2): importFile copies synchronously into the library and parses xlsx/docx later -- an uncapped
  // source would also blow the ooxml reader's 1 GiB zip envelope. 512 MiB is far above any real Office file.
  if (st.size > MAX_IMPORT_BYTES) throw Object.assign(new Error(`${absPath} is ${st.size} bytes: imports are capped at ${MAX_IMPORT_BYTES / (1024 * 1024)} MiB`), { code: "too_large" });
  const title = meta.title ?? base.slice(0, dot);
  assertSafeTitle(title); // the imported file lands in the library as <title>.<ext> -- same rules as created titles
  // Baseline AT IMPORT TIME (review 4364810146): record which comment ids this file carries NOW, so a mention added to it
  // before its first save is still NEW at first save and can wake; only the history that came in WITH the file baselines.
  // scanWorkspace stamps the same baseline IN PLACE via indexOne -- keep the two stampings in step.
  // Only for files up to MAX_BASELINE_BYTES: reading a multi-hundred-MiB docx inline just to stamp a baseline is not worth
  // the sync stall -- above the cap leave it undefined so ping.ts applies its documented "unparseable source" fallback
  // (baseline everything the first save holds) and first-save wake semantics are preserved.
  let importedBaseline: string[] | undefined;
  if (extRaw === "docx" && st.size <= MAX_BASELINE_BYTES) {
    try {
      importedBaseline = parseDocx(fs.readFileSync(absPath)).comments.map((c) => c.id);
    } catch {
      // source does not parse as docx: leave the baseline unknown -- ping.ts then falls back to baselining whatever the first save holds
    }
  }
  const index = readIndex(rootDir);
  const now = Date.now();
  const doc: DocMeta = {
    docId: `${slugify(title)}-${randomSuffix()}`, // fresh id -- imports are copies; the index's exists rule (title+type) is NOT re-checked for imports, so a same-titled import coexists
    title,
    ext: extRaw,
    createdAt: now,
    updatedAt: now,
    sizeBytes: st.size,
    mtimeMs: 0,
    owner: meta.owner ?? null,
    grants: [],
    imported: true, // ping.ts first-save rule: the import-time baseline below is what gets baselined, never woken
    importedBaseline,
  };
  const dir = path.join(rootDir, "docs", doc.docId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${title}.${extRaw}`);
  fs.copyFileSync(absPath, file);
  const dst = fs.statSync(file);
  doc.sizeBytes = dst.size;
  doc.mtimeMs = dst.mtimeMs;
  index.docs.push(doc);
  writeIndex(rootDir, index);
  return { ...doc };
}

/** Copy a document OUT of the library to destAbsDir (created if missing) as <title>.<ext>; returns the absolute
 * path written. Throws {code:"not_found"} for an unknown id. */
export function exportDoc(docId: string, destAbsDir: string, root = dataDir()): string {
  const rootDir = root ?? dataDir();
  const doc = getDoc(docId, rootDir);
  if (!doc) throw notFound(`no document with id ${docId}`);
  fs.mkdirSync(destAbsDir, { recursive: true });
  const dest = path.join(destAbsDir, `${doc.title}.${doc.ext}`);
  fs.copyFileSync(docPath(doc, rootDir), dest);
  return path.resolve(dest);
}

/** Persist saved document bytes (the callback's status-2/6 path) under the REVISION GATE -- the whole point of
 * mtime-as-revision: stat the library file FIRST and if its mtimeMs differs from doc.mtimeMs (tolerance none;
 * the caller passes the meta it last saw), refuse with Error{code:"revision_mismatch", currentMtimeMs} so a stale
 * DS session can never clobber an agent edit (or vice versa). On success: temp file in the same directory + rename
 * over the original (the existing bytes are never deleted mid-write), re-stat for the new mtimeMs/sizeBytes, update
 * the index entry (mtimeMs, sizeBytes, updatedAt) and return { mtimeMs } -- the caller answers DS and registers the
 * history revision under that number. Sync on purpose: no zip is involved here, only a byte copy. */
export function persistBytes(doc: DocMeta, bytes: Buffer, root = dataDir()): { mtimeMs: number } {
  const rootDir = root ?? dataDir();
  const file = docPath(doc, rootDir);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    throw notFound(`no library file for ${doc.docId}`);
  }
  if (st.mtimeMs !== doc.mtimeMs) {
    throw Object.assign(new Error("revision_mismatch: the document changed since this session opened it"), { code: "revision_mismatch", currentMtimeMs: st.mtimeMs });
  }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
  const after = fs.statSync(file);
  const index = readIndex(rootDir);
  const entry = index.docs.find((d) => d.docId === doc.docId);
  if (!entry) throw notFound(`no document with id ${doc.docId}`);
  entry.mtimeMs = after.mtimeMs;
  entry.sizeBytes = after.size;
  entry.updatedAt = Date.now();
  writeIndex(rootDir, index);
  return { mtimeMs: after.mtimeMs };
}
