/**
 * Builds fixtures/sample.docx and fixtures/sample.xlsx, committed as binary alongside this script.
 *
 * Run manually (from the extension directory):
 *
 *   env -u NODE_ENV node scripts/make-fixtures.mjs
 *
 * (NODE_ENV=production is set globally in this environment; the .ts import below rides Node's built-in
 * type stripping, so plain `node` works -- no tsx needed. Re-run any time; the output is deterministic.)
 *
 * The parts are hand-written XML strings, but the ZIP bytes themselves come out of THIS extension's own
 * writer (ooxml.writeZip): the fixtures therefore double as round-trip material for our zip reader and
 * the ooxml parsers and editDocx, not just for any zip tool. The docx is deliberately richer than
 * the blank template in store.ts
 * template: multiple paragraphs (one empty), a sentence whose words sit in several w:t runs (the quote
 * "revised after the" spans two of them -- test/fixtures.test.mts edits exactly that), entity-encoded
 * characters (&amp; &lt; &gt; &#8212; &#x20AC;), and word/comments.xml with two comments from different
 * authors. The xlsx carries a sharedStrings part (including a multi-run <si> and an entity) AND inline
 * strings across two sheets, with one sparse cell so the dense-grid fill is exercised too.
 */
import fs from "node:fs";
import path from "node:path";
import { writeZip } from "../src/ooxml.ts";

const HERE = import.meta.dirname;
const OUT = path.join(HERE, "..", "fixtures");

/* ------------------------------------------------------------------ */
/* docx parts                                                          */
/* ------------------------------------------------------------------ */

const DOCX_CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>` +
  `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
  `</Types>`;

const DOCX_ROOT_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
  `</Relationships>`;

const W_NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;

const DOCX_DOC_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>` +
  `</Relationships>`;

/** Five paragraphs: single-run, multi-run (the cross-run quote lives here), EMPTY, entity-laden, and a
 * numeric-entity pair. The quotes below are load-bearing -- fixtures.test.mts asserts them verbatim and
 * edits the cross-run one with ooxml.editDocx. */
const DOCX_DOCUMENT =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document ${W_NS}><w:body>` +
  // p0 -- one run; named entities &amp; and &lt;/&gt;
  `<w:p><w:r><w:t xml:space="preserve">Quarterly &amp; annual report for &lt;Meridian Labs&gt;</w:t></w:r></w:p>` +
  // p1 -- THREE runs; "revised after the" crosses run 2 and run 3 (the fixture's cross-run quote)
  `<w:p>` +
  `<w:r><w:t xml:space="preserve">Revenue figures </w:t></w:r>` +
  `<w:r><w:t>were revised after </w:t></w:r>` +
  `<w:r><w:t>the audit found a discrepancy.</w:t></w:r>` +
  `</w:p>` +
  // p2 -- deliberately empty (parseDocx keeps it as "")
  `<w:p/>` +
  // p3 -- entities again, single run
  `<w:p><w:r><w:t xml:space="preserve">Note: 5 &amp; 7 were checked against the ledger (see &lt;Appendix B&gt;).</w:t></w:r></w:p>` +
  // p4 -- numeric + hex character references (&#8212; = em dash, &#x20AC; = euro sign)
  `<w:p>` +
  `<w:r><w:t>Footnote: </w:t></w:r>` +
  `<w:r><w:t>&#8212; total is &#x20AC;42,300.</w:t></w:r>` +
  `</w:p>` +
  `</w:body></w:document>`;

const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W_NS}></w:styles>`;

/** Two comments, different authors: one dated multi-run (with an entity in its text), one undated single
 * run carrying the @agent mention grammar ping.ts resolves (harmless in a fixture -- no wake fires offline). */
const DOCX_COMMENTS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:comments ${W_NS}>` +
  `<w:comment w:id="10" w:author="Alice Chen" w:date="2026-10-25T10:00:00Z">` +
  `<w:p><w:r><w:t>Please fix </w:t></w:r><w:r><w:t xml:space="preserve">&amp; resend the totals.</w:t></w:r></w:p>` +
  `</w:comment>` +
  `<w:comment w:id="25" w:author="Bob Ortiz">` +
  `<w:p><w:r><w:t>@agent the appendix needs re-stating before we ship.</w:t></w:r></w:p>` +
  `</w:comment>` +
  `</w:comments>`;

/* ------------------------------------------------------------------ */
/* xlsx parts                                                          */
/* ------------------------------------------------------------------ */

const XLSX_CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
  `</Types>`;

const XLSX_ROOT_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

const XLSX_WORKBOOK =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
  `<sheets><sheet name="Inventory" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets>` +
  `</workbook>`;

const XLSX_WORKBOOK_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>` +
  `</Relationships>`;

/** Four shared strings: a plain one, an entity one (&amp;), a MULTI-RUN <si> with a numeric reference
 * (&#163; = pound sign -- run joining has to work here exactly like in docx runs), and a label. */
const XLSX_SHARED_STRINGS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="5" uniqueCount="4">` +
  `<si><t>Product</t></si>` +
  `<si><t>ACME &amp; Sons Ltd</t></si>` +
  `<si><r><t xml:space="preserve">Grand </t></r><r><t>total (&#163;)</t></r></si>` +
  `<si><t>Notes sheet</t></si>` +
  `</sst>`;

/** Sheet "Inventory": shared-string cells, a plain number, an INLINE string (with leading/trailing spaces
 * to exercise xml:space), and a sparse hole -- row 3 has A, B and D but no C, so the grid must fill dense. */
const XLSX_SHEET1 =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
  `<row r="1">` +
  `<c r="A1" t="s"><v>0</v></c>` +
  `<c r="B1" t="s"><v>1</v></c>` +
  `<c r="C1"><v>12</v></c>` +
  `</row>` +
  `<row r="3">` +
  `<c r="A3" t="inlineStr"><is><t xml:space="preserve"> on order </t></is></c>` +
  `<c r="B3" t="s"><v>2</v></c>` +
  `<c r="D3"><v>99</v></c>` +
  `</row>` +
  `</sheetData></worksheet>`;

/** Sheet "Notes": a shared string, a decimal number kept as stored text, and an inline string with padding. */
const XLSX_SHEET2 =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
  `<row r="1">` +
  `<c r="A1" t="s"><v>3</v></c>` +
  `<c r="B1"><v>1.5</v></c>` +
  `</row>` +
  `<row r="2">` +
  `<c r="A2" t="inlineStr"><is><t xml:space="preserve">  see tab 1  </t></is></c>` +
  `</row>` +
  `</sheetData></worksheet>`;

/* ------------------------------------------------------------------ */
/* write                                                               */
/* ------------------------------------------------------------------ */

function buildDocx() {
  return writeZip([
    { name: "[Content_Types].xml", data: Buffer.from(DOCX_CONTENT_TYPES, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(DOCX_ROOT_RELS, "utf8") },
    { name: "word/document.xml", data: Buffer.from(DOCX_DOCUMENT, "utf8") },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(DOCX_DOC_RELS, "utf8") },
    { name: "word/styles.xml", data: Buffer.from(DOCX_STYLES, "utf8") },
    { name: "word/comments.xml", data: Buffer.from(DOCX_COMMENTS, "utf8") },
  ]);
}

function buildXlsx() {
  return writeZip([
    { name: "[Content_Types].xml", data: Buffer.from(XLSX_CONTENT_TYPES, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(XLSX_ROOT_RELS, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(XLSX_WORKBOOK, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(XLSX_WORKBOOK_RELS, "utf8") },
    { name: "xl/sharedStrings.xml", data: Buffer.from(XLSX_SHARED_STRINGS, "utf8") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(XLSX_SHEET1, "utf8") },
    { name: "xl/worksheets/sheet2.xml", data: Buffer.from(XLSX_SHEET2, "utf8") },
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
const docx = buildDocx();
const xlsx = buildXlsx();
fs.writeFileSync(path.join(OUT, "sample.docx"), docx);
fs.writeFileSync(path.join(OUT, "sample.xlsx"), xlsx);
console.log(`fixtures/sample.docx  ${docx.length} bytes (6 parts: document + comments + styles + rels)`);
console.log(`fixtures/sample.xlsx  ${xlsx.length} bytes (7 parts: 2 sheets + sharedStrings + rels)`);
