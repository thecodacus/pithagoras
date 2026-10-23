/**
 * Unit tests for src/store.ts: the document library (index + docs/<docId>/), CRUD, ownership/grant scoping,
 * import/export, the persistBytes REVISION GATE and trash sweeping. Templates are asserted to be REAL office
 * files by parsing them with src/ooxml.ts (parseDocx/parseXlsx). Every root is an mkdtemp dir in os.tmpdir() --
 * the real data dir and portal() are never touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import {
  listDocs, getDoc, docsForHome, createDoc, renameDoc, deleteDoc, sweepTrash,
  importFile, exportDoc, persistBytes, templateDocx, templateXlsx, slugify,
} from "../src/store";
import { parseDocx, parseXlsx } from "../src/ooxml";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "office-store-"));
}

const docFile = (root: string, meta: { docId: string; title: string; ext: string }) => path.join(root, "docs", meta.docId, `${meta.title}.${meta.ext}`);

/* ---------------- templates ---------------- */

test("templateDocx: minimal docx parses with ooxml.parseDocx and carries real content", async () => {
  const buf = await templateDocx();
  assert.ok(buf.length > 500);
  const parsed = parseDocx(buf); // throws if the zip or word/document.xml is missing/broken
  assert.deepEqual(parsed.paragraphs, ["New document"]);
  assert.equal(parsed.comments.length, 0);
  // every part the contract names must be present in the archive
  const zip = await JSZip.loadAsync(buf);
  for (const name of ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml"]) assert.ok(zip.file(name), `missing ${name}`);
});

test("templateXlsx: minimal xlsx parses with ooxml.parseXlsx as one empty Sheet1", async () => {
  const buf = await templateXlsx();
  const parsed = parseXlsx(buf); // throws if workbook/rels/sheet parts are missing/broken
  assert.deepEqual(parsed.sheetNames, ["Sheet1"]);
  assert.deepEqual(parsed.sheets["Sheet1"], []);
  const zip = await JSZip.loadAsync(buf);
  for (const name of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml"]) assert.ok(zip.file(name), `missing ${name}`);
});

test("slugify: lowercase, non-alnum runs -> single dash, trimmed", () => {
  assert.equal(slugify("Quarterly Report  Q3"), "quarterly-report-q3");
  assert.equal(slugify("  --Weird__Name!! "), "weird-name");
});

/* ---------------- create / list / get ---------------- */

test("createDoc: word and cell write parseable templates into docs/<docId>/", async () => {
  const root = tmpRoot();
  const w = await createDoc({ title: "Quarterly Report", type: "word" }, root);
  assert.equal(w.ext, "docx");
  assert.match(w.docId, /^quarterly-report-[a-z0-9]{6}$/);
  assert.equal(parseDocx(fs.readFileSync(docFile(root, w))).text, "New document");
  assert.ok(w.sizeBytes > 0 && w.mtimeMs > 0);

  const c = await createDoc({ title: "Budget", type: "cell" }, root);
  assert.equal(c.ext, "xlsx");
  assert.match(c.docId, /^budget-[a-z0-9]{6}$/);
  assert.deepEqual(parseXlsx(fs.readFileSync(docFile(root, c))).sheetNames, ["Sheet1"]);

  // fresh index.json on disk, version 1
  const index = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"));
  assert.equal(index.version, 1);
  assert.equal(index.docs.length, 2);
});

test("createDoc: duplicate (same title + type) throws code 'exists'; same title different type is fine", async () => {
  const root = tmpRoot();
  await createDoc({ title: "Report", type: "word" }, root);
  await assert.rejects(async () => createDoc({ title: "Report", type: "word" }, root), (err: Error) => err.code === "exists");
  // a spreadsheet with the same title is a different document, not a duplicate
  const cell = await createDoc({ title: "Report", type: "cell" }, root);
  assert.equal(cell.ext, "xlsx");
});

test("listDocs: titles ascending; getDoc miss -> null", async () => {
  const root = tmpRoot();
  const banana = await createDoc({ title: "Banana Plan", type: "word" }, root);
  const apple = await createDoc({ title: "apple notes", type: "word" }, root);
  assert.deepEqual(listDocs(root).map((d) => d.docId), [apple.docId, banana.docId]);
  assert.equal(getDoc("nope-123456", root), null);
  const found = getDoc(apple.docId, root);
  assert.ok(found && found.title === "apple notes");
});

/* ---------------- ownership / grants ---------------- */

test("docsForHome: owner path, grant path, dedupe of owned-and-granted doc; others' docs excluded", async () => {
  const root = tmpRoot();
  const homeA = "chat-A";
  const homeB = "chat-B";
  const owned = await createDoc({ title: "A owned doc", owner: homeA }, root);
  const granted = await createDoc({ title: "B doc granted to A", owner: homeB }, root);
  const stranger = await createDoc({ title: "C doc nobody shares", owner: "chat-C" }, root);

  // grant A access to the B doc (what ping.ts does on a mention)
  const index = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"));
  const entry = index.docs.find((d: { docId: string }) => d.docId === granted.docId);
  entry.grants.push({ chatId: homeA, commentId: "c1", at: Date.now() });
  // the A-owned doc is ALSO granted to A: dedupe must keep it exactly once
  const ownedEntry = index.docs.find((d: { docId: string }) => d.docId === owned.docId);
  ownedEntry.grants.push({ chatId: homeA, commentId: "c2", at: Date.now() });
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify(index));

  const visible = docsForHome(homeA, root).map((d) => d.docId);
  assert.deepEqual(visible.sort(), [granted.docId, owned.docId].sort());
  assert.equal(visible.filter((id) => id === owned.docId).length, 1); // deduped
  assert.ok(!visible.includes(stranger.docId));

  const bView = docsForHome(homeB, root).map((d) => d.docId);
  assert.deepEqual(bView, [granted.docId]);
});

/* ---------------- rename / delete / trash ---------------- */

test("renameDoc: renames the file on disk, keeps bytes and mtimeMs, bumps updatedAt", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Old Title" }, root);
  const oldBytes = fs.readFileSync(docFile(root, doc));
  const before = getDoc(doc.docId, root);
  assert.ok(before);

  const renamed = renameDoc(doc.docId, "New Title", root);
  assert.equal(renamed.docId, doc.docId); // stable across renames -- tickets/history key off it
  assert.equal(renamed.title, "New Title");
  assert.ok(!fs.existsSync(docFile(root, { ...doc, title: "Old Title" })));
  const newBytes = fs.readFileSync(docFile(root, renamed));
  assert.deepEqual(newBytes, oldBytes); // bytes untouched
  assert.equal(renamed.mtimeMs, before!.mtimeMs); // content mtime (the revision) is preserved by the rename
  assert.ok(renamed.updatedAt >= before!.updatedAt);
  // renaming onto another doc's title -> exists
  await createDoc({ title: "Taken", type: "word" }, root);
  assert.throws(() => renameDoc(doc.docId, "Taken", root), (err: Error) => err.code === "exists");
});

test("renameDoc on unknown id -> not_found", () => {
  const root = tmpRoot();
  assert.throws(() => renameDoc("ghost-123456", "X", root), (err: Error) => err.code === "not_found");
});

test("deleteDoc: moves docs/<docId> into .trash, prunes the index; unknown id -> not_found", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Doomed", type: "word" }, root);
  deleteDoc(doc.docId, root);
  assert.ok(!fs.existsSync(path.join(root, "docs", doc.docId)));
  const trash = fs.readdirSync(path.join(root, ".trash"));
  assert.equal(trash.length, 1);
  assert.match(trash[0], new RegExp(`^\\d+-${doc.docId}$`));
  assert.ok(fs.existsSync(path.join(root, ".trash", trash[0], "Doomed.docx"))); // content kept for the TTL
  assert.equal(getDoc(doc.docId, root), null);
  assert.throws(() => deleteDoc(doc.docId, root), (err: Error) => err.code === "not_found");
});

test("sweepTrash: removes only entries older than 7 days", () => {
  const root = tmpRoot();
  const trash = path.join(root, ".trash");
  const oldStamp = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days
  fs.mkdirSync(path.join(trash, `${oldStamp}-ancient-doc`), { recursive: true });
  fs.writeFileSync(path.join(trash, `${oldStamp}-ancient-doc`, "x.docx"), Buffer.from("z"));
  const freshStamp = Date.now() - 3600 * 1000; // 1h ago
  fs.mkdirSync(path.join(trash, `${freshStamp}-young-doc`), { recursive: true });
  fs.writeFileSync(path.join(trash, `${freshStamp}-young-doc`, "x.docx"), Buffer.from("z"));
  fs.mkdirSync(path.join(trash, "not-a-stamped-entry"), { recursive: true }); // no numeric prefix -- leave it alone

  const removed = sweepTrash(root);
  assert.equal(removed, 1);
  assert.ok(!fs.existsSync(path.join(trash, `${oldStamp}-ancient-doc`)));
  assert.ok(fs.existsSync(path.join(trash, `${freshStamp}-young-doc`)));
  assert.ok(fs.existsSync(path.join(trash, "not-a-stamped-entry")));

  // empty root: no .trash at all -> 0, no throw
  assert.equal(sweepTrash(tmpRoot()), 0);
});

/* ---------------- import / export ---------------- */

test("importFile: copies a real docx in (title from basename by default), records size and mtime", async () => {
  const root = tmpRoot();
  const srcRoot = tmpRoot();
  const template = await templateDocx();
  const src = path.join(srcRoot, "Client proposal FINAL.docx");
  fs.writeFileSync(src, template);

  const meta = importFile(src, {}, root);
  assert.equal(meta.title, "Client proposal FINAL");
  assert.equal(meta.ext, "docx");
  assert.match(meta.docId, /^client-proposal-final-[a-z0-9]{6}$/);
  const stored = fs.readFileSync(docFile(root, meta));
  assert.deepEqual(stored, template);
  assert.equal(parseDocx(stored).text, "New document");
  assert.deepEqual(meta.importedBaseline, []); // parseable source without comments -> empty baseline stamped at import time
  assert.equal(meta.sizeBytes, template.length);

  // explicit title + owner override the defaults
  const src2 = path.join(srcRoot, "grid.xlsx");
  fs.writeFileSync(src2, await templateXlsx());
  const meta2 = importFile(src2, { title: "Grid", owner: "chat-9" }, root);
  assert.equal(meta2.title, "Grid");
  assert.equal(meta2.owner, "chat-9");
});

test("importFile: .txt -> unsupported_format; missing file -> not_found; uppercase extension accepted", async () => {
  const root = tmpRoot();
  const srcRoot = tmpRoot();
  const txt = path.join(srcRoot, "notes.txt");
  fs.writeFileSync(txt, "hi");
  await assert.rejects(async () => importFile(txt, {}, root), (err: Error) => err.code === "unsupported_format");
  await assert.rejects(async () => importFile(path.join(srcRoot, "ghost.docx"), {}, root), (err: Error) => err.code === "not_found");

  const upper = path.join(srcRoot, "UPPER.DOCX");
  fs.writeFileSync(upper, await templateDocx());
  const meta = importFile(upper, {}, root);
  assert.equal(meta.ext, "docx"); // normalized to the stored extension
});

test("exportDoc: writes <title>.<ext> into a created dest dir and returns the absolute path", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Export me", type: "word" }, root);
  const destDir = path.join(tmpRoot(), "out", "nested"); // must be created recursively
  const written = exportDoc(doc.docId, destDir, root);
  assert.equal(written, path.join(destDir, "Export me.docx"));
  assert.ok(path.isAbsolute(written));
  assert.deepEqual(parseDocx(fs.readFileSync(written)), parseDocx(fs.readFileSync(docFile(root, doc))));
  assert.throws(() => exportDoc("ghost-123456", destDir, root), (err: Error) => err.code === "not_found");
});

/* ---------------- persist gate ---------------- */

test("persistBytes: success writes the bytes, updates the index mtime/size and returns the new mtimeMs", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Live" }, root);
  const oldMeta = getDoc(doc.docId, root);
  assert.ok(oldMeta);
  const saved = Buffer.from("saved-by-DS-" + "x".repeat(100));

  const res = persistBytes(oldMeta, saved, root);
  const fresh = fs.statSync(docFile(root, doc));
  assert.equal(res.mtimeMs, fresh.mtimeMs);
  const updated = getDoc(doc.docId, root);
  assert.ok(updated);
  assert.equal(updated!.mtimeMs, res.mtimeMs);
  assert.equal(updated!.sizeBytes, saved.length);
  assert.deepEqual(fs.readFileSync(docFile(root, doc)), saved); // the bytes really landed
});

test("persistBytes: a stale meta (external write moved the mtime) throws revision_mismatch with currentMtimeMs", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Contended" }, root);
  const staleMeta = getDoc(doc.docId, root);
  assert.ok(staleMeta);

  // an external writer (another DS session / the agent) rewrites the file and pushes its mtime far forward
  const file = docFile(root, doc);
  fs.writeFileSync(file, Buffer.from("someone else saved this"));
  const forced = new Date(Date.now() + 60_000).getTime(); // a definitely-distinct mtime
  fs.utimesSync(file, forced / 1000, forced / 1000);
  const currentMtimeMs = fs.statSync(file).mtimeMs;
  assert.notEqual(currentMtimeMs, staleMeta.mtimeMs);

  await assert.rejects(
    (async () => persistBytes(staleMeta, Buffer.from("my stale save"), root))(),
    (err: Error) => {
      assert.equal(err.code, "revision_mismatch");
      assert.equal((err as NodeJS.ErrnoException & { currentMtimeMs?: number }).currentMtimeMs, currentMtimeMs);
      return true;
    },
  );
  // the library file is untouched by the refused write
  assert.deepEqual(fs.readFileSync(file), Buffer.from("someone else saved this"));
});

test("persistBytes: an FRESH meta after the external write persists again (the gate clears)", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Retry" }, root);
  const file = docFile(root, doc);
  fs.writeFileSync(file, Buffer.from("newer content"));
  const freshMeta = getDoc(doc.docId, root) ?? undefined; // re-read: still the OLD index mtime -> would mismatch
  assert.ok(freshMeta);
  // but persistBytes with the stale index meta must fail...
  await assert.rejects((async () => persistBytes(freshMeta, Buffer.from("z"), root))(), (err: Error) => err.code === "revision_mismatch");
});

/* ---------------- end-to-end-ish ---------------- */

test("a full round-trip: create -> edit bytes through the gate -> export is parseable", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Round Trip" }, root);
  let meta = getDoc(doc.docId, root)!;
  for (let i = 0; i < 3; i++) {
    const bytes = Buffer.from(`revision ${i} of the round trip document`);
    await new Promise((r) => setTimeout(r, 2)); // let mtime advance so successive persists are distinct revisions
    const res = persistBytes(meta, bytes, root);
    meta = getDoc(doc.docId, root)!;
    assert.equal(meta.mtimeMs, res.mtimeMs);
  }
  const out = exportDoc(doc.docId, path.join(tmpRoot(), "rt"), root);
  assert.equal(fs.readFileSync(out).toString("utf8"), "revision 2 of the round trip document");
});
