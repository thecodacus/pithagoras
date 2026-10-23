/**
 * OOXML primitives for pithagoras-office: parse docx/xlsx into text and comments, apply quote-based
 * edits to a document.xml string, and rewrite the zip around changed parts. All functions here are
 * pure over Buffers/strings (no fs, no settings, no network), per the contracts file; store.ts owns
 * disk, tools.ts owns the tool surface.
 *
 * ZIP I/O is a small synchronous reader/writer on node:zlib rather than jszip: the contract gives
 * parseDocx/parseXlsx/rewriteZip synchronous signatures (the ping diff and the office_* tools run
 * them inline), and jszip only exposes async load/generate. The writer keeps entry order and is
 * content-preserving -- every untouched entry re-extracts byte-identical -- but recompresses, so an
 * output zip is NOT compression-byte-identical to its input (accepted deviation from the plan's
 * "byte-for-byte", noted in .office-contracts.md). node builtins only; jszip stays for templates.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

export type Comment = { id: string; author: string; date?: string; text: string };

/** One agent edit: quote a unique passage of the document text and say what replaces it. */
export type EditOp = { quote: string; replacement: string };

function ooxmlError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/* ------------------------------------------------------------------ */
/* minimal sync zip reader/writer (stored + deflate)                   */
/* ------------------------------------------------------------------ */

type ZipEntry = {
  name: string;
  method: number; // 0 stored, 8 deflated
  crc: number;
  csize: number;
  usize: number;
  lfhOffset: number;
  modTime: number;
  modDate: number;
};

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const ZIP64 = 0xffffffff;

/** Entry directory of a zip: central-directory records in file order. Throws {code:"invalid_zip"}. */
function readZip(buf: Buffer): ZipEntry[] {
  if (buf.length < 22) throw ooxmlError("not a zip archive (too small)", "invalid_zip");
  // EOCD lives in the last 22+65535 bytes.
  const from = Math.max(0, buf.length - 22 - 65535);
  let eocd = -1;
  for (let i = buf.length - 22; i >= from; i--) if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  if (eocd < 0) throw ooxmlError("not a zip archive (no end of central directory)", "invalid_zip");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === ZIP64 || cdOffset === ZIP64) throw ooxmlError("zip64 archives are not supported", "invalid_zip");
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) throw ooxmlError("corrupt zip central directory", "invalid_zip");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    if (method === ZIP64 || csize === ZIP64 || usize === ZIP64) throw ooxmlError("zip64 archives are not supported", "invalid_zip");
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lfhOffset = buf.readUInt32LE(p + 42);
    entries.push({
      name: buf.toString("utf8", p + 46, p + 46 + nameLen),
      method,
      crc: buf.readUInt32LE(p + 16),
      csize,
      usize,
      lfhOffset,
      modTime: buf.readUInt16LE(p + 12),
      modDate: buf.readUInt16LE(p + 14),
    });
    p = p + 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Uncompressed payload of one entry (payload length comes from the central directory, so local data descriptors are fine). */
function readEntryData(buf: Buffer, e: ZipEntry): Buffer {
  if (e.lfhOffset + 30 > buf.length || buf.readUInt32LE(e.lfhOffset) !== LFH_SIG) throw ooxmlError(`corrupt zip local header for ${e.name}`, "invalid_zip");
  const nameLen = buf.readUInt16LE(e.lfhOffset + 26);
  const extraLen = buf.readUInt16LE(e.lfhOffset + 28);
  const start = e.lfhOffset + 30 + nameLen + extraLen;
  if (start + e.csize > buf.length) throw ooxmlError(`truncated zip payload for ${e.name}`, "invalid_zip");
  const raw = buf.subarray(start, start + e.csize);
  let out: Buffer;
  if (e.method === 0) out = raw;
  else if (e.method === 8) { try { out = inflateRawSync(raw); } catch { throw ooxmlError(`bad deflate data for ${e.name}`, "invalid_zip"); } }
  else throw ooxmlError(`unsupported zip compression method ${e.method} for ${e.name}`, "invalid_zip");
  if (out.length !== e.usize) throw ooxmlError(`size mismatch for ${e.name}`, "invalid_zip");
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Fresh zip from named entries (order kept). Deflate for non-empty data, stored otherwise.
 * Exported so scripts/make-fixtures.mjs can build the committed fixtures THROUGH this writer -- the
 * fixtures then double as round-trip material for our own reader/writer pair. */
export function writeZip(entries: { name: string; data: Buffer; time?: { time: number; date: number } }[]): Buffer {
  const now = dosDateTime(new Date());
  const chunks: Buffer[] = [];
  const cd: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const time = entry.time ?? now;
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const deflate = data.length > 0;
    const payload = deflate ? deflateRawSync(data, { level: 6 }) : Buffer.alloc(0);
    const crc = crc32(data);
    // Local file header. UTF-8 names get the flag bit set; no extra field, no data descriptor.
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(LFH_SIG, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(/[^\x00-\x7f]/.test(entry.name) ? 0x800 : 0, 6);
    lfh.writeUInt16LE(deflate ? 8 : 0, 8);
    lfh.writeUInt16LE(time.time, 10);
    lfh.writeUInt16LE(time.date, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28);
    chunks.push(lfh, name, payload);
    const rec = Buffer.alloc(46);
    rec.writeUInt32LE(CD_SIG, 0);
    rec.writeUInt16LE(20, 4); // version made by
    rec.writeUInt16LE(20, 6); // version needed
    rec.writeUInt16LE(lfh.readUInt16LE(6), 8);
    rec.writeUInt16LE(deflate ? 8 : 0, 10);
    rec.writeUInt16LE(time.time, 12);
    rec.writeUInt16LE(time.date, 14);
    rec.writeUInt32LE(crc, 16);
    rec.writeUInt32LE(payload.length, 20);
    rec.writeUInt32LE(data.length, 24);
    rec.writeUInt16LE(name.length, 28);
    rec.writeUInt16LE(0, 30); // extra
    rec.writeUInt16LE(0, 32); // comment
    rec.writeUInt16LE(0, 34); // disk number
    rec.writeUInt16LE(0, 36); // internal attrs
    rec.writeUInt32LE(0, 38); // external attrs
    rec.writeUInt32LE(offset, 42);
    cd.push(rec, name);
    offset += lfh.length + name.length + payload.length;
  }
  const cdBuf = Buffer.concat(cd);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

/** All file parts of a zip as uncompressed bytes; duplicate names: last one wins (jszip behavior). */
function readZipParts(buf: Buffer): Record<string, Buffer> {
  const parts: Record<string, Buffer> = {};
  for (const entry of readZip(buf)) parts[entry.name] = readEntryData(buf, entry);
  return parts;
}

/* ------------------------------------------------------------------ */
/* small targeted XML helpers (no full DOM -- only the tags these       */
/* functions own)                                                      */
/* ------------------------------------------------------------------ */

function decodeEntities(s: string): string {
  return s.replace(/&#x([0-9a-fA-F]+);|&#([0-9]+);|&([a-zA-Z][a-zA-Z0-9]*);/g, (match, hex, dec, name) => {
    if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16));
    if (dec !== undefined) return String.fromCodePoint(parseInt(dec, 10));
    switch (name) { case "amp": return "&"; case "lt": return "<"; case "gt": return ">"; case "quot": return '"'; case "apos": return "'"; }
    return match; // unknown named entity: keep as-is rather than drop text
  });
}

/** Escape a string for use as w:t / t element content. */
function escapeXmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Attribute name="value" pairs of a tag (double-quoted, OOXML style); keys keep their local part (w:id -> id). */
function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_][\w.:-]*)="([^"]*)"/g)) attrs[m[1].slice(m[1].lastIndexOf(":") + 1)] = decodeEntities(m[2]);
  return attrs;
}

type Span = { tagStart: number; tagEnd: number; text: string }; // absolute offsets in the XML string

/** Every w:t of one paragraph-content string as decoded-text spans (ordered, so their concatenation is the paragraph text). */
function wtSpans(content: string, base: number): Span[] {
  const spans: Span[] = [];
  for (const m of content.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) {
    if (m.index === undefined) continue;
    spans.push({ tagStart: base + m.index, tagEnd: base + m.index + m[0].length, text: decodeEntities(m[1]) });
  }
  return spans;
}

type Para = { contentStart: number; contentEnd: number }; // paragraph-content offsets in the XML string (self-closing w:p: equal)

/** Every top-level w:p of a document.xml body in order. Nested paragraphs (text boxes, w:txbxContent) are out of scope
 *  by contract ("w:p > w:r > w:t"); such content would be read as the outer paragraph's trailing run and editing it is unsupported. */
function findParagraphs(xml: string): Para[] {
  const paras: Para[] = [];
  for (const m of xml.matchAll(/<w:p(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    if (m.index === undefined) continue;
    const content = m[1];
    paras.push(content === undefined ? { contentStart: 0, contentEnd: 0 } : { contentStart: m.index + m[0].indexOf(">") + 1, contentEnd: m.index + m[0].length - "</w:p>".length });
  }
  return paras;
}

/** Decoded text of one w:p's content (empty string when the paragraph has no runs -- empty paragraphs are kept on purpose). */
function paragraphText(content: string): string {
  let out = "";
  for (const m of content.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) out += decodeEntities(m[1]);
  return out;
}

/* ------------------------------------------------------------------ */
/* docx                                                                */
/* ------------------------------------------------------------------ */

/**
 * Extract a docx: paragraph texts (one entry per w:p, in order, empty paragraphs kept as "") joined with
 * "\n" into `text`, plus the word/comments.xml comments. Missing word/document.xml throws {code:"missing_part"};
 * a missing comments part is simply no comments. Runs are read as plain text: w:tab/w:br and other run children
 * contribute nothing (simplification per contract).
 */
export function parseDocx(buf: Buffer): { text: string; paragraphs: string[]; comments: Comment[] } {
  const parts = readZipParts(buf);
  const document = parts["word/document.xml"];
  if (!document) throw ooxmlError("docx has no word/document.xml", "missing_part");
  const xml = document.toString("utf8");
  const paragraphs: string[] = [];
  for (const para of findParagraphs(xml)) {
    const content = para.contentStart === 0 && para.contentEnd === 0 ? "" : xml.slice(para.contentStart, para.contentEnd);
    paragraphs.push(paragraphText(content));
  }
  let comments: Comment[] = [];
  if (parts["word/comments.xml"]) comments = parseComments(parts["word/comments.xml"].toString("utf8"));
  return { text: paragraphs.join("\n"), paragraphs, comments };
}

/** The w:comment elements of a comments.xml; each comment's text is its w:p/w:r/w:t runs joined in order. */
function parseComments(xml: string): Comment[] {
  const comments: Comment[] = [];
  for (const m of xml.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    if (m.index === undefined) continue;
    const attrs = parseAttributes(m[1]);
    let text = "";
    for (const t of m[2].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) text += decodeEntities(t[1]);
    const comment: Comment = { id: attrs["id"] ?? "", author: attrs["author"] ?? "", text };
    if (attrs["date"] !== undefined) comment.date = attrs["date"];
    comments.push(comment);
  }
  return comments;
}

/**
 * Apply quote-based edits to a document.xml string, in order -- op n+1 quotes the document as op n left it.
 * A quote must occur exactly once (distinct occurrences) in the concatenated paragraph text -- the same text
 * parseDocx would extract (exact substring, case-sensitive). The replacement lands where the quote sat: the
 * first affected w:t keeps the run's leftover prefix plus the new text (plain runs), fully covered w:t elements
 * are dropped, and a partially covered final w:t keeps its suffix. Surrounding XML is untouched; rewritten
 * w:t tags get xml:space="preserve" when their content has leading or trailing spaces so Word does not strip them.
 * Throws {code:"quote_not_found"} (also for an empty quote) and {code:"quote_ambiguous"}.
 */
export function editDocx(documentXml: string, ops: EditOp[]): string {
  let xml = documentXml;
  for (const op of ops) xml = applyEdit(xml, op);
  return xml;
}

function applyEdit(xml: string, op: EditOp): string {
  const paras = findParagraphs(xml);
  const spanLists = paras.map((p) => wtSpans(p.contentStart === 0 && p.contentEnd === 0 ? "" : xml.slice(p.contentStart, p.contentEnd), p.contentStart));
  // The virtual text: each paragraph's runs in order, paragraphs joined with "\n" (matching parseDocx). Map every
  // w:t span back to its offsets in that text.
  const paraRanges: { start: number; length: number }[] = [];
  let cursor = 0;
  paras.forEach((_, i) => {
    const length = spanLists[i].reduce((n, s) => n + s.text.length, 0);
    paraRanges.push({ start: cursor, length });
    cursor += length + (i < paras.length - 1 ? 1 : 0); // the joining "\n" has no XML behind it
  });
  const virtual = paras.map((_, i) => spanLists[i].map((s) => s.text).join("")).join("\n");

  if (op.quote === "") throw ooxmlError("quote must not be empty", "quote_not_found");
  const at = virtual.indexOf(op.quote);
  if (at === -1) throw ooxmlError("quote_not_found: the quoted passage is not in the document", "quote_not_found");
  if (virtual.indexOf(op.quote, at + 1) !== -1) throw ooxmlError("quote_ambiguous: the quoted passage occurs more than once", "quote_ambiguous");

  const qEnd = at + op.quote.length;
  // Tag-level edits in the xml string: for each w:t span the quote touches, rewrite its content.
  const edits: { start: number; end: number; text: string }[] = [];
  let firstDone = false;
  paras.forEach((para, i) => {
    if (para.contentStart === para.contentEnd) return;
    const pLo = Math.max(at, paraRanges[i].start);
    const pHi = Math.min(qEnd, paraRanges[i].start + paraRanges[i].length);
    if (pLo >= pHi) return; // this paragraph is outside the quote
    let spanOffset = paraRanges[i].start; // where this span's text starts in the virtual string
    for (const span of spanLists[i]) {
      const spanStart = spanOffset;
      const spanEnd = spanOffset + span.text.length;
      const lo = Math.max(pLo, spanStart);
      const hi = Math.min(pHi, spanEnd);
      spanOffset = spanEnd;
      if (lo >= hi) continue; // span untouched by this quote
      const prefix = span.text.slice(0, lo - spanStart); // of the first touched span, what stays before the quote
      const suffix = span.text.slice(hi - spanStart); // of a last touched span, what stays after the quote (empty when it ends exactly at the span's end)
      let writeContent: string;
      if (!firstDone) { writeContent = prefix + op.replacement + suffix; firstDone = true; } // the replacement lands in the first touched span, its leftover text around it stays
      else writeContent = suffix; // earlier spans already consumed everything up to `hi`; a later touched span keeps only its tail
      if (writeContent === "") edits.push({ start: span.tagStart, end: span.tagEnd, text: "" }); // fully covered: drop the w:t element
      else {
        const preserve = /^[ \t\r\n]|[ \t\r\n]$/.test(writeContent);
        edits.push({ start: span.tagStart, end: span.tagEnd, text: `<w:t${preserve ? ' xml:space="preserve"' : ""}>${escapeXmlText(writeContent)}</w:t>` });
      }
    }
  });
  for (const edit of edits.sort((a, b) => b.start - a.start)) xml = xml.slice(0, edit.start) + edit.text + xml.slice(edit.end);
  return xml;
}

/* ------------------------------------------------------------------ */
/* xlsx                                                                */
/* ------------------------------------------------------------------ */

/** Resolve a workbook rels Target against xl/: absolute ("/xl/...") or relative ("worksheets/sheet1.xml"). */
function resolveTarget(target: string): string {
  const pieces = target.startsWith("/") ? target.slice(1).split("/") : ["xl", ...target.split("/")];
  const parts: string[] = [];
  for (const piece of pieces) if (!piece || piece === ".") continue; else if (piece === "..") parts.pop(); else parts.push(piece);
  return parts.join("/");
}

function columnOf(ref: string): number { // "AB12" -> 27 (zero-based), -1 when the ref has no letters
  let col = 0;
  for (const ch of ref) { if (ch >= "A" && ch <= "Z") col = col * 26 + (ch.charCodeAt(0) - 64); else break; }
  return col === 0 ? -1 : col - 1;
}

/**
 * Extract an xlsx: sheet names in workbook order, and per sheet a dense grid of cell strings -- sparse cells
 * are filled to the farthest used row/column with "" (plan simplicity note: grids, not sparse maps). Values:
 * sharedStrings lookups (t="s"), inline strings (t="inlineStr"), and stored text as-is for numbers/formulas/
 * booleans ("keep stored text"). Cells without an r= reference are skipped. A missing workbook or referenced
 * sheet part throws {code:"missing_part"}.
 */
export function parseXlsx(buf: Buffer): { sheetNames: string[]; sheets: Record<string, string[][]> } {
  const parts = readZipParts(buf);
  const workbook = parts["xl/workbook.xml"];
  if (!workbook) throw ooxmlError("xlsx has no xl/workbook.xml", "missing_part");
  const relsXml = parts["xl/_rels/workbook.xml.rels"]?.toString("utf8") ?? "";
  const targets: Record<string, string> = {};
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    if (m.index === undefined) continue;
    const attrs = parseAttributes(m[1]);
    if (attrs["Id"] && attrs["Target"] && attrs["TargetMode"] !== "External") targets[attrs["Id"]] = attrs["Target"];
  }
  let sharedStrings: string[] = [];
  if (parts["xl/sharedStrings.xml"]) {
    for (const m of parts["xl/sharedStrings.xml"].toString("utf8").matchAll(/<si(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
      const content = m[1] ?? "";
      let text = "";
      for (const t of content.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) text += decodeEntities(t[1]);
      sharedStrings.push(text);
    }
  }
  const sheetNames: string[] = [];
  const sheets: Record<string, string[][]> = {};
  for (const m of workbook.toString("utf8").matchAll(/<sheet\b([^>]*)\/?>/g)) {
    if (m.index === undefined) continue;
    const attrs = parseAttributes(m[1]);
    const name = attrs["name"] ?? "";
    sheetNames.push(name);
    sheets[name] = [];
    const target = attrs["id"] !== undefined ? targets[attrs["id"]] : undefined;
    if (target === undefined) continue; // unresolvable sheet: listed by name, no grid
    const sheetPart = parts[resolveTarget(target)];
    if (!sheetPart) throw ooxmlError(`xlsx is missing the worksheet part ${resolveTarget(target)} for sheet "${name}"`, "missing_part");
    sheets[name] = parseSheet(sheetPart.toString("utf8"), sharedStrings);
  }
  return { sheetNames, sheets };
}

function parseSheet(xml: string, sharedStrings: string[]): string[][] {
  const sheetData = xml.match(/<sheetData(?:\s[^>]*)?>([\s\S]*?)<\/sheetData>/);
  if (!sheetData) return [];
  let maxRow = 0;
  let maxCol = 0;
  const cells: Record<string, string> = {}; // "row,col" -> cell text
  for (const m of sheetData[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    if (m.index === undefined) continue;
    const attrs = parseAttributes(m[1]);
    if (!attrs["r"]) continue; // no reference: position unknown, skip (kept simple per plan)
    const row = Number.parseInt(attrs["r"].replace(/^[A-Z]+/, ""), 10);
    const col = columnOf(attrs["r"]);
    if (col < 0 || !Number.isFinite(row) || row < 1) continue;
    let value = "";
    const inner = m[2] ?? "";
    if (attrs["t"] === "inlineStr") {
      for (const t of inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) value += decodeEntities(t[1]);
    } else {
      const v = inner.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
      if (v) value = attrs["t"] === "s" ? (sharedStrings[Number.parseInt(v[1], 10)] ?? "") : decodeEntities(v[1]); // numbers/formulas/booleans: stored text as-is
    }
    cells[`${row},${col}`] = value;
    if (row > maxRow) maxRow = row;
    if (col >= maxCol) maxCol = col + 1;
  }
  const grid: string[][] = [];
  for (let r = 0; r < maxRow; r++) {
    const line: string[] = [];
    for (let c = 0; c < maxCol; c++) line.push(cells[`${r + 1},${c}`] ?? "");
    grid.push(line);
  }
  return grid;
}

/* ------------------------------------------------------------------ */
/* zip rewriting + comment diffing                                     */
/* ------------------------------------------------------------------ */

function asBuffer(value: string | Buffer): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

/**
 * Rewrite a zip with named parts replaced or added. Accepted deviation (noted in the contracts file): the
 * output is CONTENT-preserving -- every untouched entry re-extracts byte-identical to its original uncompressed
 * bytes, entry order is kept where this writer allows (replacements stay put, new parts are appended) -- but the
 * zip as a whole is NOT compression-byte-identical to the input: unchanged deflate entries are recompressed and
 * rewritten with fresh timestamps for added parts. Throws {code:"invalid_zip"} on unreadable archives.
 */
export function rewriteZip(buf: Buffer, changes: Record<string, string | Buffer>): Buffer {
  const entries = readZip(buf);
  const applied = new Set<string>();
  const out: { name: string; data: Buffer; time?: { time: number; date: number } }[] = [];
  for (const entry of entries) {
    let data = readEntryData(buf, entry);
    if (entry.name in changes) { data = asBuffer(changes[entry.name]); applied.add(entry.name); }
    out.push({ name: entry.name, data, time: { time: entry.modTime, date: entry.modDate } });
  }
  for (const [name, value] of Object.entries(changes)) if (!applied.has(name)) out.push({ name, data: asBuffer(value) });
  return writeZip(out);
}

/**
 * Comments that `next` has which `prev` does not, by id -- an id only in `next` is added. The same id with
 * changed text or author is an UPDATE and deliberately NOT reported as added (the wake diff wants new threads,
 * not reworded ones). Order of `next` is kept.
 */
export function diffComments(prev: Comment[], next: Comment[]): { added: Comment[] } {
  const known = new Set(prev.map((c) => c.id));
  return { added: next.filter((c) => !known.has(c.id)) };
}
