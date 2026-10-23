/**
 * Unit tests for src/ooxml.ts: docx/xlsx parsing, quote-based document editing, zip rewriting,
 * comment diffing. Self-contained -- fixtures are built in-test with jszip (no network, docker, portal).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { parseDocx, parseXlsx, editDocx, rewriteZip, diffComments, type Comment } from "../src/ooxml";

/* ---------------- fixture building (jszip) ---------------- */

const DOCUMENT_XML = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
  `<w:p><w:r><w:t>Hello &amp; welcome to &lt;Office&gt;.</w:t></w:r></w:p>` +
  `<w:p><w:r><w:t>Alp</w:t></w:r><w:r><w:t>ha</w:t></w:r><w:r><w:t xml:space="preserve"> beta</w:t></w:r></w:p>` +
  `<w:p/>` +
  `<w:p><w:r><w:t>Gamma one</w:t></w:r><w:r><w:t xml:space="preserve"> and gamma two</w:t></w:r></w:p>` +
  `</w:body></w:document>`;

const COMMENTS_XML = `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:comment w:id="1" w:author="Alice Adams" w:date="2026-10-25T10:00:00Z"><w:p><w:r><w:t>Fix the</w:t></w:r><w:r><w:t> title.</w:t></w:r></w:p></w:comment>` +
  `<w:comment w:id="2" w:author="Bob Brown"><w:p><w:r><w:t>@agent</w:t></w:r><w:r><w:t> please review</w:t></w:r></w:p></w:comment>` +
  `</w:comments>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

async function buildDocxZip(documentXml = DOCUMENT_XML, commentsXml: string | null = COMMENTS_XML): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", ROOT_RELS);
  zip.file("word/document.xml", documentXml);
  if (commentsXml !== null) zip.file("word/comments.xml", commentsXml);
  return zip.generateAsync({ type: "nodebuffer" });
}

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`;

const SHARED_STRINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4"><si><t>Region</t></si><si><t>North</t></si><si><r><t>So</t></r><r><t>uth &amp; Co.</t></r></si><si><t>Total</t></si></sst>`;

const SALES_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"><v>42</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="inlineStr"><is><t xml:space="preserve"> inline value </t></is></c><c r="C2"><v>7.5</v></c></row></sheetData></worksheet>`;

// sparse on purpose: A1 and B5 only -- the grid must be filled dense to 5 rows x 2 columns
const NOTES_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="5"><c r="B5" t="inlineStr"><is><t>far cell</t></is></c></row></sheetData></worksheet>`;

async function buildXlsxZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", ROOT_RELS);
  zip.file("xl/workbook.xml", WORKBOOK_XML);
  zip.file("xl/_rels/workbook.xml.rels", WORKBOOK_RELS);
  zip.file("xl/sharedStrings.xml", SHARED_STRINGS);
  zip.file("xl/worksheets/sheet1.xml", SALES_SHEET);
  zip.file("xl/worksheets/sheet2.xml", NOTES_SHEET);
  return zip.generateAsync({ type: "nodebuffer" });
}

/** Uncompressed bytes of every file entry, keyed by name (jszip on both sides makes comparisons independent of our writer). */
async function entryBytes(buf: Buffer): Promise<Record<string, Buffer>> {
  const zip = await JSZip.loadAsync(buf);
  const out: Record<string, Buffer> = {};
  for (const [name, file] of Object.entries(zip.files)) if (!file.dir) out[name] = Buffer.from(await file.async("nodebuffer"));
  return out;
}

/** Run fn, require it to throw, and return the thrown error (this node's assert.throws does not return it). */
function thrown(fn: () => unknown): Error & { code?: string } {
  try { fn(); } catch (err) { if (err instanceof Error) return err as Error & { code?: string }; throw err; }
  throw new assert.AssertionError({ message: "expected the call to throw" });
}

/* ---------------- parseDocx ---------------- */

test("parseDocx extracts paragraphs, joined text and comments with entity decoding", async () => {
  const doc = parseDocx(await buildDocxZip());
  assert.deepEqual(doc.paragraphs, [
    "Hello & welcome to <Office>.",
    "Alpha beta",
    "", // the empty paragraph is kept, on purpose
    "Gamma one and gamma two",
  ]);
  assert.equal(doc.text, doc.paragraphs.join("\n"));
  assert.deepEqual(doc.comments, [
    { id: "1", author: "Alice Adams", date: "2026-10-25T10:00:00Z", text: "Fix the title." },
    { id: "2", author: "Bob Brown", text: "@agent please review" }, // no w:date attribute -> no date field
  ]);
});

test("parseDocx treats a missing comments part as no comments, and rejects non-docx zips", async () => {
  const doc = parseDocx(await buildDocxZip(DOCUMENT_XML, null));
  assert.deepEqual(doc.comments, []);
  const plainZip = await new JSZip().file("readme.txt", "no document here").generateAsync({ type: "nodebuffer" });
  assert.equal(thrown(() => parseDocx(plainZip)).code, "missing_part");
});

/* ---------------- parseXlsx ---------------- */

test("parseXlsx resolves shared strings and inlineStr across both sheets, dense grid", async () => {
  const book = parseXlsx(await buildXlsxZip());
  assert.deepEqual(book.sheetNames, ["Sales", "Notes"]);
  assert.deepEqual(book.sheets["Sales"], [
    ["Region", "North", "42"], // shared string, shared string, numeric kept as stored text
    ["South & Co.", " inline value ", "7.5"], // rich-text si (two runs) + inlineStr with padding kept
  ]);
  assert.deepEqual(book.sheets["Notes"], [
    ["1", ""],
    ["", ""],
    ["", ""],
    ["", ""],
    ["", "far cell"], // sparse cells filled dense to the farthest used row/column
  ]);
});

/* ---------------- editDocx ---------------- */

/** editDocx works on the XML string; wrap its result into a docx and reparse it. */
async function reparsed(documentXml: string, commentsXml: string | null = null) {
  return parseDocx(await buildDocxZip(documentXml, commentsXml));
}

test("editDocx replaces a quote inside a single run and keeps entities round-tripping", async () => {
  const doc = await reparsed(editDocx(DOCUMENT_XML, [{ quote: "Gamma one", replacement: "Delta & nine" }]));
  assert.deepEqual(doc.paragraphs[3], "Delta & nine and gamma two"); // the & in the replacement is escaped in XML, decoded on reparse
});

test("editDocx spans multiple runs at w:t boundaries", async () => {
  // "Alpha beta" lives in runs ["Alp","ha"," beta"]; "lpha be" starts inside run 2 and ends inside run 3.
  const doc = await reparsed(editDocx(DOCUMENT_XML, [{ quote: "lpha be", replacement: "middle" }]));
  assert.deepEqual(doc.paragraphs[1], "Amiddleta"); // "A" + "middle" + "ta"
});

test("editDocx applies ops sequentially -- op two quotes op one's output", async () => {
  const doc = await reparsed(editDocx(DOCUMENT_XML, [
    { quote: "Gamma one", replacement: "Delta nine" },
    { quote: "Delta nine", replacement: "Final answer" }, // sees the first edit
  ]));
  assert.deepEqual(doc.paragraphs[3], "Final answer and gamma two");
  // and a stale op that quotes the pre-edit text fails with quote_not_found:
  const err = thrown(() => editDocx(DOCUMENT_XML, [
    { quote: "Gamma one", replacement: "Delta nine" },
    { quote: "Gamma one", replacement: "x" },
  ]));
  assert.equal(err.code, "quote_not_found");
});

test("editDocx throws quote_not_found and quote_ambiguous", () => {
  const missing = thrown(() => editDocx(DOCUMENT_XML, [{ quote: "not in the document", replacement: "x" }]));
  assert.equal(missing.code, "quote_not_found");
  // a quote appearing in two paragraphs must be refused
  const duplicated = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    `<w:p><w:r><w:t>alpha</w:t></w:r></w:p><w:p><w:r><w:t>beta alpha omega</w:t></w:r></w:p></w:body></w:document>`;
  const ambiguous = thrown(() => editDocx(duplicated, [{ quote: "alpha", replacement: "x" }]));
  assert.equal(ambiguous.code, "quote_ambiguous");
});

/* ---------------- rewriteZip ---------------- */

test("rewriteZip with no changes round-trips: parse-equal and every entry content-identical", async () => {
  const original = await buildDocxZip();
  const rewritten = rewriteZip(original, {});
  assert.deepEqual(parseDocx(rewritten), parseDocx(original));
  const before = await entryBytes(original);
  const after = await entryBytes(rewritten);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  for (const name of Object.keys(before)) assert.ok(Buffer.compare(before[name], after[name]) === 0, `entry ${name} content changed`);
});

test("rewriteZip replaces word/document.xml in place and reflects it on reparse", async () => {
  const original = await buildDocxZip();
  const edited = editDocx(DOCUMENT_XML, [{ quote: "Gamma one", replacement: "Delta nine" }]);
  const rewritten = rewriteZip(original, { "word/document.xml": edited });
  assert.equal(parseDocx(rewritten).paragraphs[3], "Delta nine and gamma two");
  assert.deepEqual(parseDocx(rewritten).comments, parseDocx(original).comments);
  const before = await entryBytes(original);
  const after = await entryBytes(rewritten);
  for (const name of Object.keys(before)) {
    if (name === "word/document.xml") continue;
    assert.ok(Buffer.compare(before[name], after[name]) === 0, `entry ${name} content changed`);
  }
});

test("rewriteZip appends a new part and leaves the rest untouched", async () => {
  const original = await buildDocxZip();
  const rewritten = rewriteZip(original, { "word/media/hello.txt": Buffer.from("a binary \u0000\u0001 part", "latin1") });
  const after = await entryBytes(rewritten);
  const before = await entryBytes(original);
  assert.equal(after["word/media/hello.txt"].toString("latin1"), "a binary \u0000\u0001 part");
  for (const name of Object.keys(before)) assert.ok(Buffer.compare(before[name], after[name]) === 0, `entry ${name} content changed`);
});

/* ---------------- diffComments ---------------- */

test("diffComments reports only ids that are new", () => {
  const prev: Comment[] = [{ id: "1", author: "A", text: "old" }];
  const next: Comment[] = [
    { id: "1", author: "A", text: "changed wording" }, // same id, changed text: update, NOT added
    { id: "2", author: "B", text: "brand new" }, // added
  ];
  assert.deepEqual(diffComments(prev, next).added, [{ id: "2", author: "B", text: "brand new" }]);
  assert.deepEqual(diffComments(next, prev).added, []);
  assert.deepEqual(diffComments([], []).added, []);
});
