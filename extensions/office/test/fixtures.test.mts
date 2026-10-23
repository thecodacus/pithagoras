/**
 * Cross-check of the zip reader/writer against NON-TRIVIAL committed files (plan 7 "docx fixture
 * round-trip", contract tests W5): parse fixtures/sample.docx and fixtures/sample.xlsx with
 * ooxml.parseDocx/parseXlsx and assert the exact structure, then edit a quote that SPANS two w:t runs
 * in the docx through ooxml.editDocx + rewriteZip and re-parse the output.
 *
 * The fixtures are binary files committed in this extension's fixtures/ directory; they were generated
 * by scripts/make-fixtures.mjs (hand-written OOXML parts zipped through OUR OWN ooxml.writeZip, so these
 * tests read back material our own writer produced -- if the reader and writer disagree, that shows here).
 * Re-generate with: env -u NODE_ENV node scripts/make-fixtures.mjs  (deterministic output).
 * jszip is used below ONLY to pull a part's raw bytes out for editDocx input -- parsing and editing go
 * through ooxml exclusively, exactly as the runtime paths do.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { parseDocx, parseXlsx, editDocx, rewriteZip } from "../src/ooxml";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const DOCX = fs.readFileSync(`${FIXTURES}sample.docx`);
const XLSX = fs.readFileSync(`${FIXTURES}sample.xlsx`);

/** word/document.xml of the docx fixture, pulled with jszip only (the ooxml path has no part-reader export). */
async function documentXml(): Promise<string> {
  const zip = await JSZip.loadAsync(DOCX);
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("fixture docx lost its word/document.xml -- regenerate with scripts/make-fixtures.mjs");
  return (await file.async("string")) as string;
}

/* ---------------- sample.docx ---------------- */

test("sample.docx: five paragraphs in order (the third empty), cross-run text joined exactly, entities decoded", () => {
  const d = parseDocx(DOCX);
  assert.deepEqual(d.paragraphs, [
    // p0: single run; &amp; and &lt;/&gt; decoded to raw characters
    "Quarterly & annual report for <Meridian Labs>",
    // p1: THREE w:t runs joined into one sentence (the cross-run join this fixture exists to prove)
    "Revenue figures were revised after the audit found a discrepancy.",
    // p2: the deliberately empty paragraph, kept on purpose
    "",
    // p3: more named entities
    "Note: 5 & 7 were checked against the ledger (see <Appendix B>).",
    // p4: numeric (&#8212;) and hex (&#x20AC;) character references decoded via fromCodePoint
    "Footnote: \u2014 total is \u20AC42,300.",
  ]);
  // `text` is the paragraphs joined with "\n" (parseDocx contract) -- exactly one newline where p2 sits empty
  assert.equal(d.text, d.paragraphs.join("\n"));
  assert.ok(d.text.includes("discrepancy.\n\nNote:"), "the empty paragraph contributes a blank line to text");
});

test("sample.docx: comments.xml parses two comments from different authors with ids, dates and joined run text", () => {
  const d = parseDocx(DOCX);
  assert.equal(d.comments.length, 2, "exactly the two comments the fixture carries");
  assert.deepEqual(d.comments[0], {
    id: "10",
    author: "Alice Chen",
    date: "2026-10-25T10:00:00Z",
    text: "Please fix & resend the totals.", // two runs joined, &amp; decoded
  });
  assert.equal(d.comments[1].id, "25");
  assert.equal(d.comments[1].author, "Bob Ortiz", "second comment has a DIFFERENT author");
  assert.equal(d.comments[1].date, undefined, "the fixture's second comment carries no w:date attribute");
  assert.equal(d.comments[1].text, "@agent the appendix needs re-stating before we ship."); // single run, mention grammar intact
});

test("sample.docx: editDocx replaces a quote that SPANS two runs; the rewritten zip still parses and keeps every other part", async () => {
  const xml = await documentXml();
  // "revised after the" starts inside run 2 ("were revised after ") and ends inside run 3
  // ("the audit found a discrepancy.") -- a classic Word run-split that naive substring edits corrupt.
  const edited = editDocx(xml, [
    { quote: "revised after the", replacement: "walked back before any" },
    // a second op on the RESULT (ops are sequential per contract): single-run target in paragraph 0
    { quote: "Quarterly & annual report", replacement: "Quarterly and annual report" },
  ]);

  const out = rewriteZip(DOCX, { "word/document.xml": edited });
  const after = parseDocx(out); // round-trip through our own reader
  assert.deepEqual(after.paragraphs, [
    "Quarterly and annual report for <Meridian Labs>",
    "Revenue figures were walked back before any audit found a discrepancy.",
    "",
    "Note: 5 & 7 were checked against the ledger (see <Appendix B>).",
    "Footnote: \u2014 total is \u20AC42,300.",
  ]);
  // untouched parts survive byte-for-byte in CONTENT (rewriteZip contract), comments included
  assert.deepEqual(after.comments, parseDocx(DOCX).comments);

  const beforeParts = await JSZip.loadAsync(DOCX);
  const afterParts = await JSZip.loadAsync(out);
  assert.deepEqual(Object.keys(afterParts.files).sort(), Object.keys(beforeParts.files).sort(), "no part added or dropped");
  for (const name of Object.keys(beforeParts.files)) {
    if (name === "word/document.xml") continue; // the edited part legitimately changed
    const a = await beforeParts.file(name)!.async("nodebuffer");
    const b = await afterParts.file(name)!.async("nodebuffer");
    assert.ok(Buffer.compare(a, b) === 0, `untouched part ${name} re-extracts byte-identical`);
  }

  // and a quote spanning runs that does not exist in the fixture is refused with ooxml's code
  assert.throws(() => editDocx(xml, [{ quote: "revised after THAT", replacement: "" }]), (e: unknown) => {
    const err = e as Error & { code?: string };
    return err.code === "quote_not_found";
  });
});

/* ---------------- sample.xlsx ---------------- */

test("sample.xlsx: two sheets by name; shared strings (incl. a multi-run <si> with an entity) + inline strings + sparse fill", () => {
  const x = parseXlsx(XLSX);
  assert.deepEqual(x.sheetNames, ["Inventory", "Notes"]); // workbook order

  // Sheet Inventory: t="s" lookups, plain numbers kept as stored text, an inline string with its padding,
  // and a sparse hole (row 3 has A/B/D, no C) filled dense to the farthest used cell.
  assert.deepEqual(x.sheets["Inventory"], [
    ["Product", "ACME & Sons Ltd", "12", ""], // B1: shared string with decoded &amp;
    ["", "", "", ""], // row 2 absent entirely -> all-empty line in the dense grid
    [" on order ", "Grand total (\u00A3)", "", "99"], // A3 inlineStr keeps its spaces; B3 = a TWO-RUN shared string joined, &#163; decoded
  ]);

  // Sheet Notes: one shared-string cell, a decimal kept as stored text, an inline string with double padding.
  assert.deepEqual(x.sheets["Notes"], [
    ["Notes sheet", "1.5"],
    ["  see tab 1  ", ""],
  ]);
});

test("sample.xlsx: the same bytes still load in jszip -- both zippers agree on the part list (reader sanity)", async () => {
  const zip = await JSZip.loadAsync(XLSX);
  for (const name of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/sharedStrings.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]) {
    assert.ok(zip.file(name), `fixture xlsx carries ${name}`);
  }
});
